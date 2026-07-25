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

type ApiKeyRow = ApiKeyData & { api_key: string; active: number | boolean };

function dateToday(): string {
  return new Date().toISOString().split("T")[0];
}

function keyError(message: string, statusCode: number): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = statusCode;
  return error;
}

/** Async API-key persistence service shared by SQLite and PostgreSQL. */
class APIKeyManager {
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
            api_key TEXT PRIMARY KEY,
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

  private async migrateSchema(): Promise<void> {
    const columns = this.db.kind === "sqlite"
      ? (await this.db.all<{ name: string }>("PRAGMA table_info(api_keys)")).map((column) => column.name)
      : (await this.db.all<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
          ["api_keys"],
        )).map((column) => column.column_name);

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
    return Object.fromEntries(rows.map((row) => [row.api_key, this.rowToKey(row)]));
  }

  async loadKeys(): Promise<Record<string, ApiKeyData>> {
    return this.getKeyMap();
  }

  async getKeys() {
    const keys = await this.getKeyMap();
    return Object.entries(keys).map(([api_key, data]) => ({
      api_key,
      name: data.name || "Unnamed",
      active: data.active,
      usage_today: data.usage_today,
      rpd: data.rpd,
      rpm: data.rpm,
      max_context_size: data.max_context_size,
    }));
  }

  async validateKey(apiKey: string): Promise<true> {
    const row = await this.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE api_key = ?", [apiKey]);
    if (!row) throw keyError("Invalid API Key", 401);
    return true;
  }

  async checkForGeneration(
    apiKey: string,
    rateLimiter: { checkRateLimit(apiKey: string, limit: number): void },
    contextTokens = 0,
  ): Promise<true> {
    return this.db.transaction(async (db) => {
      const lock = db.kind === "postgres" ? " FOR UPDATE" : "";
      const row = await db.get<ApiKeyRow>(`SELECT * FROM api_keys WHERE api_key = ?${lock}`, [apiKey]);
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
      const result = await db.run("UPDATE api_keys SET usage_today = usage_today + 1 WHERE api_key = ?", [apiKey]);
      if (result.changes !== 1) throw keyError("Invalid API Key", 401);
      return true as const;
    });
  }

  async rateLimitIncrement(apiKey: string): Promise<true> {
    const result = await this.db.run("UPDATE api_keys SET usage_today = usage_today + 1 WHERE api_key = ?", [apiKey]);
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
    await this.db.run(
      "INSERT INTO api_keys (api_key, name, active, usage_today, rpd, rpm, max_context_size, last_reset_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [apiKey, name, 1, usage_today, rpd, rpm, max_context_size, dateToday()],
    );
  }

  async removeKey(apiKey: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM api_keys WHERE api_key = ?", [apiKey])).changes > 0;
  }

  async updateKey(apiKey: string, name: string, rpd: number, rpm: number, max_context_size: number, active: boolean): Promise<void> {
    const result = await this.db.run(
      "UPDATE api_keys SET name = ?, rpd = ?, rpm = ?, max_context_size = ?, active = ? WHERE api_key = ?",
      [name, rpd, rpm, max_context_size, active ? 1 : 0, apiKey],
    );
    if (result.changes !== 1) throw keyError(`This API key does not exist: ${apiKey}`, 404);
  }

  async getKeyName(apiKey: string): Promise<string> {
    const row = await this.db.get<{ name: string }>("SELECT name FROM api_keys WHERE api_key = ?", [apiKey]);
    return row?.name || "Unknown";
  }

  async getUsageStats(apiKey: string, aggregate: any = null) {
    const row = await this.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE api_key = ?", [apiKey]);
    const keyData = row ? this.rowToKey(row) : undefined;
    let stats = aggregate;
    if (!stats) {
      const keys = await this.getKeyMap();
      const mask = maskKey(apiKey);
      const maskMatches = Object.keys(keys).filter((key) => maskKey(key) === mask);
      const identity = { apiKey: getApiKeyId(apiKey), ...(maskMatches.length === 1 ? { legacyMask: mask } : {}) };
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
