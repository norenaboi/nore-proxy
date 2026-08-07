/**
 * Per-endpoint upstream key health and usage tracking.
 * Raw tokens are never persisted; rows are keyed by SHA-256(endpointKey:token).
 */
import crypto from "node:crypto";
import Config from "../config/index.js";
import { DatabaseFacade } from "./database.js";
import settingsManager from "./settingsManager.js";

export const ACTIONABLE_CODES = new Set([400, 401, 402, 403, 404, 429]);
export const INVALID_CODES = new Set([401, 403, 404]);
export const TIMEOUT_CODE = 429;

interface KeyStateRow {
  status: string;
  disabled_until: number | null;
  masked_key: string | null;
  last_status_code: number | null;
  last_error_at: number | null;
  total_requests: number;
  failed_requests: number;
  token_hash: string;
}

interface KeyStateView {
  maskedKey: string | null;
  status: string;
  lastStatusCode: number | null;
  disabledUntil: number | null;
}

function maskKey(token: string): string {
  return token.length > 8 ? `${token.slice(0, 5)}...${token.slice(-3)}` : "****";
}

class KeyStateManager {
  private readonly dbFile: string;
  private _db: DatabaseFacade | undefined;
  private initialized: Promise<void> | null = null;

  constructor(dbFile = "key_states.db") {
    this.dbFile = dbFile;
  }

  private get db(): DatabaseFacade {
    if (!this._db) throw new Error("Key state manager has not been initialized");
    return this._db;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;

    const database = new DatabaseFacade(this.dbFile);
    this._db = database;
    this.initialized = (async () => {
      try {
        await this.db.exec(`
          CREATE TABLE IF NOT EXISTS key_states (
            endpoint_key TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            masked_key TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            disabled_until BIGINT,
            last_status_code INTEGER,
            last_error_at BIGINT,
            total_requests BIGINT NOT NULL DEFAULT 0,
            failed_requests BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (endpoint_key, token_hash)
          );
          CREATE TABLE IF NOT EXISTS key_code_counts (
            endpoint_key TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            count BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (endpoint_key, token_hash, status_code)
          );
        `);
      } catch (error) {
        if (this._db === database) this._db = undefined;
        this.initialized = null;
        await database.close();
        throw error;
      }
    })();
    return this.initialized;
  }

  hashToken(endpointKey: string, token: string): string {
    return crypto.createHash("sha256").update(`${endpointKey}:${token}`).digest("hex");
  }

  private async ensureRow(db: DatabaseFacade, endpointKey: string, tokenHash: string, token: string): Promise<void> {
    await db.run(`
      INSERT INTO key_states (endpoint_key, token_hash, masked_key, status)
      VALUES (?, ?, ?, 'active')
      ON CONFLICT(endpoint_key, token_hash) DO UPDATE SET masked_key = excluded.masked_key
    `, [endpointKey, tokenHash, maskKey(token)]);
  }

  private async isRowUsable(row: KeyStateRow | undefined, endpointKey: string, tokenHash: string): Promise<boolean> {
    if (!row || row.status === "active") return true;
    if (row.status === "timeout" && row.disabled_until != null && Number(row.disabled_until) <= Date.now()) {
      await this.db.run("UPDATE key_states SET status = 'active', disabled_until = NULL WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
      return true;
    }
    return false;
  }

  async getUsableTokens(endpointKey: string, tokens: string[], { excludeHashes = new Set<string>() }: { excludeHashes?: Set<string> } = {}): Promise<Array<{ token: string; tokenHash: string }>> {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    const rows = await this.db.all<KeyStateRow>("SELECT * FROM key_states WHERE endpoint_key = ?", [endpointKey]);
    const byHash = new Map(rows.map((row) => [row.token_hash, row]));
    const usable: Array<{ token: string; tokenHash: string }> = [];
    for (const token of tokens) {
      const tokenHash = this.hashToken(endpointKey, token);
      if (!excludeHashes.has(tokenHash) && await this.isRowUsable(byHash.get(tokenHash), endpointKey, tokenHash)) {
        usable.push({ token, tokenHash });
      }
    }
    return usable;
  }

  async recordSuccess(endpointKey: string, token: string): Promise<void> {
    const tokenHash = this.hashToken(endpointKey, token);
    await this.db.transaction(async (db) => {
      await this.ensureRow(db, endpointKey, tokenHash, token);
      await db.run("UPDATE key_states SET total_requests = total_requests + 1 WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
    });
  }

  async recordFailure(endpointKey: string, token: string, statusCode: unknown, { sideline = true }: { sideline?: boolean } = {}): Promise<{ tokenHash: string }> {
    const tokenHash = this.hashToken(endpointKey, token);
    const now = Date.now();
    const code = Number(statusCode);
    await this.db.transaction(async (db) => {
      await this.ensureRow(db, endpointKey, tokenHash, token);
      await db.run(`UPDATE key_states SET total_requests = total_requests + 1, failed_requests = failed_requests + 1, last_status_code = ?, last_error_at = ? WHERE endpoint_key = ? AND token_hash = ?`, [Number.isFinite(code) ? code : null, now, endpointKey, tokenHash]);
      if (Number.isFinite(code)) {
        await db.run(`INSERT INTO key_code_counts (endpoint_key, token_hash, status_code, count) VALUES (?, ?, ?, 1) ON CONFLICT(endpoint_key, token_hash, status_code) DO UPDATE SET count = key_code_counts.count + 1`, [endpointKey, tokenHash, code]);
      }
      if (!sideline) return;
      if (INVALID_CODES.has(code)) {
        await db.run("UPDATE key_states SET status = 'invalid', disabled_until = NULL WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
      } else if (code === TIMEOUT_CODE) {
        const hours = Number(settingsManager.get("keyTimeoutHours")) || 24;
        await db.run("UPDATE key_states SET status = 'timeout', disabled_until = ? WHERE endpoint_key = ? AND token_hash = ?", [now + hours * 60 * 60 * 1000, endpointKey, tokenHash]);
      }
    });
    return { tokenHash };
  }

  async disableKey(endpointKey: string, token: string): Promise<{ tokenHash: string }> {
    const tokenHash = this.hashToken(endpointKey, token);
    await this.db.transaction(async (db) => {
      await this.ensureRow(db, endpointKey, tokenHash, token);
      await db.run("UPDATE key_states SET status = 'disabled', disabled_until = NULL WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
    });
    return { tokenHash };
  }

  async resetKey(endpointKey: string, { tokenHash = null, all = false }: { tokenHash?: string | null; all?: boolean } = {}): Promise<number> {
    if (all) return (await this.db.run("UPDATE key_states SET status = 'active', disabled_until = NULL WHERE endpoint_key = ?", [endpointKey])).changes;
    if (!tokenHash) return 0;
    return (await this.db.run("UPDATE key_states SET status = 'active', disabled_until = NULL WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash])).changes;
  }

  async resetStats(endpointKey: string, { tokenHash = null, all = false }: { tokenHash?: string | null; all?: boolean } = {}): Promise<void> {
    await this.db.transaction(async (db) => {
      if (all) {
        await db.run("UPDATE key_states SET total_requests = 0, failed_requests = 0, last_status_code = NULL, last_error_at = NULL WHERE endpoint_key = ?", [endpointKey]);
        await db.run("DELETE FROM key_code_counts WHERE endpoint_key = ?", [endpointKey]);
      } else if (tokenHash) {
        await db.run("UPDATE key_states SET total_requests = 0, failed_requests = 0, last_status_code = NULL, last_error_at = NULL WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
        await db.run("DELETE FROM key_code_counts WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
      }
    });
  }

  async getStatesForEndpoint(endpointKey: string, tokens: string[]): Promise<Array<KeyStateView & Record<string, unknown>>> {
    const safeTokens = Array.isArray(tokens) ? tokens : [];
    const [rows, codeRows] = await Promise.all([
      this.db.all<KeyStateRow>("SELECT * FROM key_states WHERE endpoint_key = ?", [endpointKey]),
      this.db.all<{ token_hash: string; status_code: number; count: number }>("SELECT token_hash, status_code, count FROM key_code_counts WHERE endpoint_key = ?", [endpointKey]),
    ]);
    const byHash = new Map(rows.map((row) => [row.token_hash, row]));
    const codesByHash = new Map<string, Record<number, number>>();
    for (const row of codeRows) codesByHash.set(row.token_hash, { ...(codesByHash.get(row.token_hash) || {}), [row.status_code]: Number(row.count) });
    const now = Date.now();
    return Promise.all(safeTokens.map(async (token, index) => {
      const tokenHash = this.hashToken(endpointKey, token);
      const row = byHash.get(tokenHash);
      let status = row?.status || "active";
      let disabledUntil = row?.disabled_until == null ? null : Number(row.disabled_until);
      if (status === "timeout" && disabledUntil != null && disabledUntil <= now) {
        await this.db.run("UPDATE key_states SET status = 'active', disabled_until = NULL WHERE endpoint_key = ? AND token_hash = ?", [endpointKey, tokenHash]);
        status = "active";
        disabledUntil = null;
      }
      return { index, tokenHash, maskedKey: row?.masked_key || maskKey(token), status, disabledUntil, lastStatusCode: row?.last_status_code ?? null, lastErrorAt: row?.last_error_at ?? null, totalRequests: Number(row?.total_requests ?? 0), failedRequests: Number(row?.failed_requests ?? 0), codeCounts: codesByHash.get(tokenHash) || {} };
    }));
  }

  private reasonUnavailable(state: KeyStateView): string | null {
    const masked = state.maskedKey || "key";
    if (state.status === "invalid") return `${masked}: invalid${state.lastStatusCode ? ` (last ${state.lastStatusCode})` : ""}`;
    if (state.status === "disabled") return `${masked}: disabled by operator`;
    if (state.status !== "timeout") return null;
    const remainingMs = (state.disabledUntil || 0) - Date.now();
    if (remainingMs > 0) {
      const hours = remainingMs / 3_600_000;
      return `${masked}: rate-limited (${state.lastStatusCode ?? 429}, recovers in ${hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.max(1, Math.round(remainingMs / 60000))}m`})`;
    }
    return `${masked}: rate-limited (${state.lastStatusCode ?? 429})`;
  }

  async describeExhaustion(endpointKey: string): Promise<{ message: string; details: string[] }> {
    const message = "No token left in the chamber.";
    const tokens = Array.isArray(Config.ENDPOINTS[endpointKey]?.tokens) ? Config.ENDPOINTS[endpointKey].tokens : [];
    if (!tokens.length) return { message, details: ["endpoint has no keys configured"] };
    const states = await this.getStatesForEndpoint(endpointKey, tokens);
    const details = states.map((state) => this.reasonUnavailable(state)).filter((detail): detail is string => detail !== null);
    return { message, details: details.length ? details : states.map((state) => `${state.maskedKey || "key"}: attempted, no key succeeded`) };
  }

  async buildExhaustionError(endpointKey?: string): Promise<Error> {
    const { message, details } = endpointKey ? await this.describeExhaustion(endpointKey) : { message: "No token left in the chamber.", details: [] as string[] };
    const error = new Error(message);
    error.name = "TokenExhaustedError";
    (error as any).statusCode = 404;
    if (details.length) (error as any).responseBody = { keyStates: details };
    return error;
  }

  async close(): Promise<void> {
    const database = this._db;
    this._db = undefined;
    this.initialized = null;
    await database?.close();
  }
}

export default new KeyStateManager();
