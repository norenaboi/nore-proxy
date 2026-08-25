import crypto from "node:crypto";
import { DatabaseFacade } from "./database.js";
import logManager from "./logManager.js";
import settingsManager from "./settingsManager.js";
import { maskKey } from "../utils/helpers.js";
import { getApiKeyId } from "../utils/keyIdentity.js";

interface ApiKeyData {
  name: string;
  active: boolean;
  usage_today: number;
  rpd: number;
  rpm: number;
  max_context_size: number;
  last_reset_date: string;
}

type ApiKeyRow = ApiKeyData & {
  key_hash: string;
  api_key_masked: string;
  api_key_id: string;
  active: number | boolean;
};

type LegacyApiKeyRow = ApiKeyData & { api_key: string; active: number | boolean };

function dateToday(): string {
  return new Date().toISOString().split("T")[0];
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function storedIdentity(apiKey: string) {
  const apiKeyId = getApiKeyId(apiKey);
  if (!apiKeyId) throw new Error("API key identity secret is unavailable");
  return {
    keyHash: hashApiKey(apiKey),
    apiKeyMasked: maskKey(apiKey),
    apiKeyId,
  };
}

function keyError(message: string, statusCode: number): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = statusCode;
  return error;
}

/** Async API-key persistence service shared by SQLite and PostgreSQL. */
export class APIKeyManager {
  private _db: DatabaseFacade | undefined;
  private initialized: Promise<void> | null = null;

  private get db(): DatabaseFacade {
    if (!this._db) throw new Error("API key manager has not been initialized");
    return this._db;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;

    const database = new DatabaseFacade("api_keys.db");
    this._db = database;
    this.initialized = (async () => {
      try {
        await this.db.exec(`
          CREATE TABLE IF NOT EXISTS api_keys (
            key_hash TEXT PRIMARY KEY,
            api_key_masked TEXT NOT NULL,
            api_key_id TEXT NOT NULL,
            name TEXT,
            active INTEGER,
            usage_today INTEGER,
            rpd INTEGER,
            rpm INTEGER,
            max_context_size INTEGER,
            last_reset_date TEXT
          )
        `);
        await this.migrateSchema();
        await this.db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_identity ON api_keys(api_key_id)");
      } catch (error) {
        if (this._db === database) this._db = undefined;
        this.initialized = null;
        await database.close();
        throw error;
      }
    })();
    return this.initialized;
  }

  async close(): Promise<void> {
    const database = this._db;
    this._db = undefined;
    this.initialized = null;
    await database?.close();
  }

  private async columnNames(table = "api_keys"): Promise<string[]> {
    return this.db.kind === "sqlite"
      ? (await this.db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name)
      : (await this.db.all<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
          [table],
        )).map((column) => column.column_name);
  }

  private async migrateSchema(): Promise<void> {
    let columns = await this.columnNames();

    if (columns.includes("api_key") && !columns.includes("key_hash")) {
      await this.migratePlaintextKeys();
      columns = await this.columnNames();
    }
    if (!columns.includes("rpm")) {
      await this.db.exec("ALTER TABLE api_keys ADD COLUMN rpm INTEGER");
      await this.db.run("UPDATE api_keys SET rpm = ? WHERE rpm IS NULL", [settingsManager.get("rpmDefault")]);
    }
    if (!columns.includes("max_context_size")) {
      await this.db.exec("ALTER TABLE api_keys ADD COLUMN max_context_size INTEGER");
      await this.db.run(
        "UPDATE api_keys SET max_context_size = ? WHERE max_context_size IS NULL",
        [settingsManager.get("maxContextSizeDefault")],
      );
    }
  }

  private async migratePlaintextKeys(): Promise<void> {
    await this.db.transaction(async (db) => {
      const rows = await db.all<LegacyApiKeyRow>("SELECT * FROM api_keys");
      await db.exec("DROP TABLE IF EXISTS api_keys_hashed");
      await db.exec(`CREATE TABLE api_keys_hashed (
        key_hash TEXT PRIMARY KEY,
        api_key_masked TEXT NOT NULL,
        api_key_id TEXT NOT NULL,
        name TEXT,
        active INTEGER,
        usage_today INTEGER,
        rpd INTEGER,
        rpm INTEGER,
        max_context_size INTEGER,
        last_reset_date TEXT
      )`);
      for (const row of rows) {
        const identity = storedIdentity(row.api_key);
        await db.run(
          `INSERT INTO api_keys_hashed (
            key_hash, api_key_masked, api_key_id, name, active, usage_today,
            rpd, rpm, max_context_size, last_reset_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            identity.keyHash,
            identity.apiKeyMasked,
            identity.apiKeyId,
            row.name,
            row.active,
            row.usage_today,
            row.rpd,
            row.rpm ?? settingsManager.get("rpmDefault"),
            row.max_context_size ?? settingsManager.get("maxContextSizeDefault"),
            row.last_reset_date,
          ],
        );
      }
      await db.exec("DROP TABLE api_keys");
      await db.exec("ALTER TABLE api_keys_hashed RENAME TO api_keys");
    });
    if (this.db.kind === "sqlite") {
      this.db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      await this.db.exec("VACUUM");
    } else {
      await this.db.exec("VACUUM api_keys");
    }
  }

  private rowToKey(row: ApiKeyRow): ApiKeyData {
    return {
      name: row.name,
      active: Boolean(row.active),
      usage_today: Number(row.usage_today),
      rpd: Number(row.rpd),
      rpm: Number(row.rpm),
      max_context_size: Number(row.max_context_size),
      last_reset_date: row.last_reset_date,
    };
  }

  async getKeyMap(): Promise<Record<string, ApiKeyData>> {
    const rows = await this.db.all<ApiKeyRow>("SELECT * FROM api_keys");
    return Object.fromEntries(rows.map((row) => [row.key_hash, this.rowToKey(row)]));
  }

  async loadKeys(): Promise<Record<string, ApiKeyData>> {
    return this.getKeyMap();
  }

  private async getRowByHash(keyHash: string): Promise<ApiKeyRow | undefined> {
    return this.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE key_hash = ?", [keyHash]);
  }

  async getStoredKey(keyHash: string) {
    const row = await this.getRowByHash(keyHash);
    if (!row) return null;
    return {
      id: row.api_key_id,
      mask: row.api_key_masked,
      ...this.rowToKey(row),
    };
  }

  async getKeys() {
    const rows = await this.db.all<ApiKeyRow>("SELECT * FROM api_keys");
    return rows.map((row) => ({
      id: row.api_key_id,
      api_key: row.api_key_masked,
      name: row.name || "Unnamed",
      active: Boolean(row.active),
      usage_today: Number(row.usage_today),
      rpd: Number(row.rpd),
      rpm: Number(row.rpm),
      max_context_size: Number(row.max_context_size),
    }));
  }

  /** Resolves an admin-facing opaque identity to the non-secret lookup hash. */
  async resolveKeyId(keyId: unknown): Promise<string | null> {
    if (typeof keyId !== "string" || !keyId) return null;
    const row = await this.db.get<{ key_hash: string }>(
      "SELECT key_hash FROM api_keys WHERE api_key_id = ?",
      [keyId],
    );
    return row?.key_hash ?? null;
  }

  async validateKey(apiKey: string): Promise<true> {
    const row = await this.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE key_hash = ?", [hashApiKey(apiKey)]);
    if (!row) throw keyError("Invalid API Key", 401);
    return true;
  }

  async checkForGeneration(
    apiKey: string,
    rateLimiter: { checkRateLimit(apiKey: string, limit: number): void },
    contextTokens = 0,
  ): Promise<true> {
    const keyHash = hashApiKey(apiKey);
    return this.db.transaction(async (db) => {
      const lock = db.kind === "postgres" ? " FOR UPDATE" : "";
      const row = await db.get<ApiKeyRow>(`SELECT * FROM api_keys WHERE key_hash = ?${lock}`, [keyHash]);
      if (!row) throw keyError("Invalid API Key", 401);
      const keyData = this.rowToKey(row);
      if (!keyData.active) {
        throw keyError("Your API Key is deactivated. Please contact the admin for reactivation.", 403);
      }
      const rpdLimit = keyData.rpd || settingsManager.get("rpdDefault");
      if (keyData.usage_today >= Number(rpdLimit)) {
        throw keyError(
          `You exceeded your requests per day limit (${rpdLimit}). Please wait until it resets at midnight.`,
          429,
        );
      }
      const rpmLimit = keyData.rpm || settingsManager.get("rpmDefault");
      rateLimiter.checkRateLimit(apiKey, rpmLimit);
      const maxContextSize = keyData.max_context_size ?? settingsManager.get("maxContextSizeDefault");
      if (maxContextSize > 0 && contextTokens > maxContextSize) {
        throw keyError(
          `Your request context (${contextTokens} tokens) exceeds the maximum allowed context size of ${maxContextSize} tokens for your API key.`,
          413,
        );
      }
      const result = await db.run("UPDATE api_keys SET usage_today = usage_today + 1 WHERE key_hash = ?", [keyHash]);
      if (result.changes !== 1) throw keyError("Invalid API Key", 401);
      return true as const;
    });
  }

  async rateLimitIncrement(apiKey: string): Promise<true> {
    const result = await this.db.run(
      "UPDATE api_keys SET usage_today = usage_today + 1 WHERE key_hash = ?",
      [hashApiKey(apiKey)],
    );
    if (result.changes !== 1) throw keyError("Invalid API Key", 401);
    return true;
  }

  async resetDaily(): Promise<void> {
    const currentDate = dateToday();
    await this.db.run(
      "UPDATE api_keys SET usage_today = 0, last_reset_date = ? WHERE last_reset_date <> ? OR last_reset_date IS NULL",
      [currentDate, currentDate],
    );
  }

  async addKey(
    apiKey: string,
    name: string,
    rpd = settingsManager.get("rpdDefault"),
    rpm = settingsManager.get("rpmDefault"),
    max_context_size = settingsManager.get("maxContextSizeDefault"),
    usage_today = 0,
  ): Promise<void> {
    const identity = storedIdentity(apiKey);
    await this.db.run(
      `INSERT INTO api_keys (
        key_hash, api_key_masked, api_key_id, name, active, usage_today,
        rpd, rpm, max_context_size, last_reset_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.keyHash,
        identity.apiKeyMasked,
        identity.apiKeyId,
        name,
        1,
        usage_today,
        rpd,
        rpm,
        max_context_size,
        dateToday(),
      ],
    );
  }

  async removeKey(keyHash: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM api_keys WHERE key_hash = ?", [keyHash])).changes > 0;
  }

  async updateKey(keyHash: string, name: string, rpd: number, rpm: number, max_context_size: number, active: boolean): Promise<void> {
    const result = await this.db.run(
      "UPDATE api_keys SET name = ?, rpd = ?, rpm = ?, max_context_size = ?, active = ? WHERE key_hash = ?",
      [name, rpd, rpm, max_context_size, active ? 1 : 0, keyHash],
    );
    if (result.changes !== 1) throw keyError("This API key does not exist", 404);
  }

  async getKeyName(apiKeyOrHash: string, stored = false): Promise<string> {
    const keyHash = stored ? apiKeyOrHash : hashApiKey(apiKeyOrHash);
    const row = await this.db.get<{ name: string }>("SELECT name FROM api_keys WHERE key_hash = ?", [keyHash]);
    return row?.name || "Unknown";
  }

  async getUsageStats(apiKeyOrHash: string, aggregate: any = null, stored = false) {
    const row = stored
      ? await this.getRowByHash(apiKeyOrHash)
      : await this.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE key_hash = ?", [hashApiKey(apiKeyOrHash)]);
    const keyData = row ? this.rowToKey(row) : undefined;
    let stats = aggregate;
    if (!stats) {
      const mask = stored ? row?.api_key_masked : maskKey(apiKeyOrHash);
      const keyId = stored ? row?.api_key_id : getApiKeyId(apiKeyOrHash);
      const maskMatches = mask
        ? await this.db.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM api_keys WHERE api_key_masked = ?",
            [mask],
          )
        : undefined;
      const identity = {
        apiKey: keyId,
        ...(mask && Number(maskMatches?.count) === 1 ? { legacyMask: mask } : {}),
      };
      const allTime = await logManager.getRequestAggregates(identity);
      const daily = await logManager.getRequestAggregates({ ...identity, from: Date.now() / 1000 - 86400 });
      stats = {
        ...allTime,
        dailyInputTokens: daily.inputTokens,
        dailyOutputTokens: daily.outputTokens,
        dailyCacheWriteTokens: daily.cacheWriteTokens,
        dailyCacheReadTokens: daily.cacheReadTokens,
      };
    }
    return {
      name: keyData?.name || "", daily_requests: keyData?.usage_today || 0,
      total_requests: stats.total || 0, total_input_tokens: stats.inputTokens || 0, total_output_tokens: stats.outputTokens || 0,
      total_cache_write_tokens: stats.cacheWriteTokens || 0, total_cache_read_tokens: stats.cacheReadTokens || 0,
      daily_input_tokens: stats.dailyInputTokens || 0, daily_output_tokens: stats.dailyOutputTokens || 0,
      daily_cache_write_tokens: stats.dailyCacheWriteTokens || 0, daily_cache_read_tokens: stats.dailyCacheReadTokens || 0,
      rate_limit: keyData?.rpd || 0, rate_limit_rpm: keyData?.rpm || 0,
      max_context_size: keyData?.max_context_size ?? 0, active: keyData?.active || false,
    };
  }
}

const apiKeyManager = new APIKeyManager();
export default apiKeyManager;
