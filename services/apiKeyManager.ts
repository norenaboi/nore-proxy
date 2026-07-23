import { createRequire } from "module";
const Database: any = createRequire(import.meta.url)("better-sqlite3");
import path from "path";
import Config from "../config/index.js";
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

class APIKeyManager {
  db: any;
  stmtInsert: any;
  stmtDeleteAll: any;
  stmtIncrementUsage: any;
  keys: Record<string, ApiKeyData>;

  constructor(dbFile = "api_keys.db") {
    const dbPath =
      process.env.NORE_PROXY_API_KEY_DB_PATH || path.join(Config.LOG_DIR, dbFile);
    this.db = new Database(dbPath);

    this.db.exec(`
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

    // Migration: Add rpm column if it doesn't exist
    this.migrateSchema();

    this.stmtInsert = this.db.prepare(`
      INSERT INTO api_keys (api_key, name, active, usage_today, rpd, rpm, max_context_size, last_reset_date)
      VALUES (@api_key, @name, @active, @usage_today, @rpd, @rpm, @max_context_size, @last_reset_date)
    `);
    this.stmtDeleteAll = this.db.prepare("DELETE FROM api_keys");
    this.stmtIncrementUsage = this.db.prepare("UPDATE api_keys SET usage_today = usage_today + 1 WHERE api_key = ?");

    this.keys = {};
    this.loadKeys();
  }

  migrateSchema(): void {
    try {
      const tableInfo: Array<{ name: string }> = this.db.prepare("PRAGMA table_info(api_keys)").all();
      const columns = tableInfo.map((col) => col.name);

      if (!columns.includes("rpm")) {
        console.log("Migrating database: adding rpm column...");
        this.db.exec(`ALTER TABLE api_keys ADD COLUMN rpm INTEGER`);
        this.db.exec(
          `UPDATE api_keys SET rpm = ${settingsManager.get("rpmDefault")} WHERE rpm IS NULL`,
        );
        console.log("Database migration (rpm) completed successfully.");
      }

      if (!columns.includes("max_context_size")) {
        console.log("Migrating database: adding max_context_size column...");
        this.db.exec(
          `ALTER TABLE api_keys ADD COLUMN max_context_size INTEGER`,
        );
        this.db.exec(
          `UPDATE api_keys SET max_context_size = ${settingsManager.get("maxContextSizeDefault")} WHERE max_context_size IS NULL`,
        );
        console.log(
          "Database migration (max_context_size) completed successfully.",
        );
      }
    } catch (error) {
      console.error("Error during schema migration:", error);
    }
  }

  loadKeys(): void {
    try {
      const rows = this.db.prepare("SELECT * FROM api_keys").all();

      this.keys = {};

      for (const row of rows) {
        this.keys[row.api_key] = {
          name: row.name,
          active: Boolean(row.active),
          usage_today: row.usage_today,
          rpd: row.rpd,
          rpm: row.rpm,
          max_context_size: row.max_context_size,
          last_reset_date: row.last_reset_date,
        };
      }
    } catch (error) {
      console.error("Error loading keys from DB:", error);
      this.keys = {};
    }
  }

  saveKeys(): void {
    const saveTransaction = this.db.transaction(() => {
      this.stmtDeleteAll.run();

      for (const [apiKey, data] of Object.entries(this.keys)) {
        this.stmtInsert.run({
          api_key: apiKey,
          name: data.name,
          active: data.active ? 1 : 0,
          usage_today: data.usage_today,
          rpd: data.rpd,
          rpm: data.rpm,
          max_context_size: data.max_context_size,
          last_reset_date: data.last_reset_date,
        });
      }
    });

    saveTransaction();
  }

  getKeys() {
    return Object.keys(this.keys).map((key) => ({
      api_key: key,
      name: this.keys[key].name || "Unnamed",
      active: this.keys[key].active || false,
      usage_today: this.keys[key].usage_today ?? "NaN",
      rpd: this.keys[key].rpd ?? "NaN",
      rpm: this.keys[key].rpm ?? "NaN",
      max_context_size: this.keys[key].max_context_size ?? 0,
    }));
  }

  validateKey(apiKey: string): true {
    if (!this.keys[apiKey]) {
      const error = new Error("Invalid API Key");
      (error as any).statusCode = 401;
      throw error;
    }
    return true;
  }

  checkForGeneration(apiKey: string, rateLimiter: { checkRateLimit(apiKey: string, limit: number): void }, contextTokens = 0) {
    if (!this.keys[apiKey]) {
      const error = new Error("Invalid API Key");
      (error as any).statusCode = 401;
      throw error;
    }

    const keyData = this.keys[apiKey];

    // Check if key is active
    if (!keyData.active) {
      const error = new Error(
        "Your API Key is deactivated. Please contact the admin for reactivation.",
      );
      (error as any).statusCode = 403;
      throw error;
    }

    // Check RPD limit
    const rpdLimit = keyData.rpd || settingsManager.get("rpdDefault");
    if (parseInt(String(keyData.usage_today)) >= parseInt(String(rpdLimit))) {
      const error = new Error(
        `You exceeded your requests per day limit (${rpdLimit}). Please wait until it resets at midnight.`,
      );
      (error as any).statusCode = 429;
      throw error;
    }

    // Check rate limit (RPM) - use key-specific RPM or default
    const rpmLimit = keyData.rpm || settingsManager.get("rpmDefault");
    rateLimiter.checkRateLimit(apiKey, rpmLimit);

    // Check context size limit (0 means unlimited)
    const maxContextSize =
      keyData.max_context_size ?? settingsManager.get("maxContextSizeDefault");
    if (maxContextSize > 0 && contextTokens > maxContextSize) {
      const error = new Error(
        `Your request context (${contextTokens} tokens) exceeds the maximum allowed context size of ${maxContextSize} tokens for your API key.`,
      );
      (error as any).statusCode = 413;
      throw error;
    }

    // Increment usage
    this.rateLimitIncrement(apiKey);

    return true;
  }

  rateLimitIncrement(apiKey: string): true {
    if (!this.keys[apiKey]) {
      const error = new Error("Invalid API Key");
      (error as any).statusCode = 401;
      throw error;
    }

    this.keys[apiKey].usage_today = (this.keys[apiKey].usage_today || 0) + 1;
    this.stmtIncrementUsage.run(apiKey);
    return true;
  }

  resetDaily(): void {
    const currentDate = new Date().toISOString().split("T")[0];

    for (const apiKey of Object.keys(this.keys)) {
      const keyData = this.keys[apiKey];

      if (keyData.last_reset_date !== currentDate) {
        keyData.usage_today = 0;
        keyData.last_reset_date = currentDate;
      }
    }
    this.saveKeys();
  }

  addKey(
    apiKey: string,
    name: string,
    rpd = settingsManager.get("rpdDefault"),
    rpm = settingsManager.get("rpmDefault"),
    max_context_size = settingsManager.get("maxContextSizeDefault"),
    usage_today = 0,
  ) {
    this.keys[apiKey] = {
      name,
      active: true,
      rpd,
      rpm,
      max_context_size,
      usage_today: usage_today,
      last_reset_date: new Date().toISOString().split("T")[0],
    };
    this.saveKeys();
  }

  removeKey(apiKey: string): boolean {
    if (this.keys[apiKey]) {
      delete this.keys[apiKey];
      this.saveKeys();
      return true;
    }
    return false;
  }

  updateKey(apiKey: string, name: string, rpd: number, rpm: number, max_context_size: number, active: boolean): void {
    if (this.keys[apiKey]) {
      this.keys[apiKey].name = name;
      this.keys[apiKey].rpd = rpd;
      this.keys[apiKey].rpm = rpm;
      this.keys[apiKey].max_context_size = max_context_size;
      this.keys[apiKey].active = active;
      this.saveKeys();
    } else {
      const error = new Error(`This API key does not exist: ${apiKey}`);
      (error as any).statusCode = 404;
      throw error;
    }
  }

  getKeyName(apiKey: string): string {
    try {
      this.validateKey(apiKey);
      return this.keys[apiKey].name;
    } catch {
      return "Unknown";
    }
  }

  getUsageStats(apiKey: string, aggregate: any = null) {
    const keyData = this.keys[apiKey];
    let stats = aggregate;
    if (!stats) {
      const mask = maskKey(apiKey);
      const maskMatches = Object.keys(this.keys).filter((key) => maskKey(key) === mask);
      const identity = {
        apiKey: getApiKeyId(apiKey),
        ...(maskMatches.length === 1 ? { legacyMask: mask } : {}),
      };
      const allTime = logManager.getRequestAggregates(identity);
      const daily = logManager.getRequestAggregates({
        ...identity,
        from: Date.now() / 1000 - 86400,
      });
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
