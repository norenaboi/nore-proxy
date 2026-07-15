/**
 * KeyStateManager — per-endpoint API key health + usage tracking.
 *
 * Tracks each upstream key's status (active / invalid / timeout), request and
 * failure counts, and per-status-code failure counts. Backed by its own SQLite
 * file (logs/key_states.db) following the apiKeyManager pattern: prepared
 * statements + cheap per-request UPDATEs, never a full table rewrite.
 *
 * SECURITY: raw tokens are never persisted or exposed. Keys are identified by
 * an opaque token_hash = sha256(endpointKey + ':' + token). A masked form of
 * the key (via the shared maskKey()) is stored so the admin UI can show which
 * key is which and cross-link to the error logs, without ever revealing the
 * secret.
 *
 * Only four HTTP status codes are actionable (they change a key's status):
 *   400 / 401 / 402 → invalid (stays until a manual re-enable)
 *   429             → timeout for keyTimeoutHours (auto-recovers on read)
 * Any other failure is counted only if recordFailure is called for it; chat.js
 * calls recordFailure exclusively for the four actionable codes.
 */

import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import Config from "../config/index.js";
import settingsManager from "./settingsManager.js";
import { maskKey } from "../utils/helpers.js";

// Status codes that change a key's status. Everything else is left alone.
export const ACTIONABLE_CODES = new Set([400, 401, 402, 429]);
export const INVALID_CODES = new Set([400, 401, 402]);
export const TIMEOUT_CODE = 429;

class KeyStateManager {
  constructor(dbFile = "key_states.db") {
    const dbPath =
      process.env.NORE_PROXY_KEY_STATE_DB_PATH ||
      path.join(Config.LOG_DIR, dbFile);

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS key_states (
        endpoint_key TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        masked_key TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        disabled_until INTEGER,
        last_status_code INTEGER,
        last_error_at INTEGER,
        total_requests INTEGER NOT NULL DEFAULT 0,
        failed_requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (endpoint_key, token_hash)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS key_code_counts (
        endpoint_key TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (endpoint_key, token_hash, status_code)
      )
    `);

    this._prepareStatements();
  }

  _prepareStatements() {
    this.stmtGetRow = this.db.prepare(
      "SELECT * FROM key_states WHERE endpoint_key = ? AND token_hash = ?",
    );
    this.stmtGetEndpointRows = this.db.prepare(
      "SELECT * FROM key_states WHERE endpoint_key = ?",
    );
    this.stmtEnsureRow = this.db.prepare(`
      INSERT INTO key_states (endpoint_key, token_hash, masked_key, status)
      VALUES (@endpoint_key, @token_hash, @masked_key, 'active')
      ON CONFLICT(endpoint_key, token_hash) DO UPDATE SET
        masked_key = excluded.masked_key
    `);
    this.stmtBumpTotal = this.db.prepare(`
      UPDATE key_states SET total_requests = total_requests + 1
      WHERE endpoint_key = ? AND token_hash = ?
    `);
    this.stmtBumpFailed = this.db.prepare(`
      UPDATE key_states
      SET total_requests = total_requests + 1,
          failed_requests = failed_requests + 1,
          last_status_code = @status_code,
          last_error_at = @now
      WHERE endpoint_key = @endpoint_key AND token_hash = @token_hash
    `);
    this.stmtSetStatus = this.db.prepare(`
      UPDATE key_states
      SET status = @status, disabled_until = @disabled_until
      WHERE endpoint_key = @endpoint_key AND token_hash = @token_hash
    `);
    this.stmtBumpCode = this.db.prepare(`
      INSERT INTO key_code_counts (endpoint_key, token_hash, status_code, count)
      VALUES (@endpoint_key, @token_hash, @status_code, 1)
      ON CONFLICT(endpoint_key, token_hash, status_code) DO UPDATE SET
        count = count + 1
    `);
    this.stmtCodesForEndpoint = this.db.prepare(
      "SELECT token_hash, status_code, count FROM key_code_counts WHERE endpoint_key = ?",
    );
    this.stmtResetKey = this.db.prepare(`
      UPDATE key_states SET status = 'active', disabled_until = NULL
      WHERE endpoint_key = @endpoint_key AND token_hash = @token_hash
    `);
    this.stmtResetEndpoint = this.db.prepare(`
      UPDATE key_states SET status = 'active', disabled_until = NULL
      WHERE endpoint_key = @endpoint_key
    `);
    this.stmtResetStatsKey = this.db.prepare(`
      UPDATE key_states SET total_requests = 0, failed_requests = 0,
        last_status_code = NULL, last_error_at = NULL
      WHERE endpoint_key = @endpoint_key AND token_hash = @token_hash
    `);
    this.stmtResetStatsEndpoint = this.db.prepare(`
      UPDATE key_states SET total_requests = 0, failed_requests = 0,
        last_status_code = NULL, last_error_at = NULL
      WHERE endpoint_key = @endpoint_key
    `);
    this.stmtDeleteCodesKey = this.db.prepare(
      "DELETE FROM key_code_counts WHERE endpoint_key = @endpoint_key AND token_hash = @token_hash",
    );
    this.stmtDeleteCodesEndpoint = this.db.prepare(
      "DELETE FROM key_code_counts WHERE endpoint_key = @endpoint_key",
    );
    this.stmtRecover = this.db.prepare(`
      UPDATE key_states SET status = 'active', disabled_until = NULL
      WHERE endpoint_key = @endpoint_key AND token_hash = @token_hash
    `);
  }

  /**
   * Opaque, stable id for a key within an endpoint. The raw token never leaves
   * this function.
   */
  hashToken(endpointKey, token) {
    return crypto
      .createHash("sha256")
      .update(`${endpointKey}:${token}`)
      .digest("hex");
  }

  _now() {
    return Date.now();
  }

  _ensureRow(endpointKey, tokenHash, token) {
    this.stmtEnsureRow.run({
      endpoint_key: endpointKey,
      token_hash: tokenHash,
      masked_key: maskKey(token),
    });
  }

  /**
   * A row is usable if it is active, or a timeout whose disabled_until has
   * passed (in which case we lazily flip it back to active). Invalid keys are
   * never usable until a manual reset. Rows that don't exist yet are usable.
   */
  _isRowUsable(row, endpointKey, tokenHash) {
    if (!row) return true;
    if (row.status === "active") return true;
    if (row.status === "timeout") {
      if (row.disabled_until != null && row.disabled_until <= this._now()) {
        // Cooldown elapsed — auto-recover.
        this.stmtRecover.run({
          endpoint_key: endpointKey,
          token_hash: tokenHash,
        });
        return true;
      }
      return false;
    }
    // invalid or disabled — never usable until a manual re-enable
    return false;
  }

  /**
   * Returns the usable tokens for an endpoint, in the original token order,
   * excluding any token_hash in excludeHashes. Each entry is { token, tokenHash }.
   * The caller applies the rotation policy (sticky vs round-robin).
   */
  getUsableTokens(endpointKey, tokens, { excludeHashes = new Set() } = {}) {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];

    const rows = this.stmtGetEndpointRows.all(endpointKey);
    const byHash = new Map(rows.map((r) => [r.token_hash, r]));

    const usable = [];
    for (const token of tokens) {
      const tokenHash = this.hashToken(endpointKey, token);
      if (excludeHashes.has(tokenHash)) continue;
      const row = byHash.get(tokenHash);
      if (this._isRowUsable(row, endpointKey, tokenHash)) {
        usable.push({ token, tokenHash });
      }
    }
    return usable;
  }

  recordSuccess(endpointKey, token) {
    const tokenHash = this.hashToken(endpointKey, token);
    this._ensureRow(endpointKey, tokenHash, token);
    this.stmtBumpTotal.run(endpointKey, tokenHash);
  }

  /**
   * Records a failure and applies the status transition for actionable codes.
   * Non-actionable codes should not reach here (chat.js only calls this for
   * 400/401/402/429), but if one does we count it without changing status.
   *
   * `sideline` (default true) controls whether the key is benched on an
   * actionable code. When an endpoint has key health turned off, the caller
   * passes sideline=false: the failure is still counted (so the admin UI shows
   * the error), but the key stays usable — the request has already hopped to
   * the next key on its own. Suited to RPM/TPM endpoints whose limits clear
   * quickly, where an hour-long timeout would needlessly bench a good key.
   */
  recordFailure(endpointKey, token, statusCode, { sideline = true } = {}) {
    const tokenHash = this.hashToken(endpointKey, token);
    const now = this._now();
    this._ensureRow(endpointKey, tokenHash, token);

    const code = Number(statusCode);
    this.stmtBumpFailed.run({
      endpoint_key: endpointKey,
      token_hash: tokenHash,
      status_code: Number.isFinite(code) ? code : null,
      now,
    });
    if (Number.isFinite(code)) {
      this.stmtBumpCode.run({
        endpoint_key: endpointKey,
        token_hash: tokenHash,
        status_code: code,
      });
    }

    // Key health off: count the failure but never bench the key.
    if (!sideline) {
      return { tokenHash };
    }

    if (INVALID_CODES.has(code)) {
      this.stmtSetStatus.run({
        endpoint_key: endpointKey,
        token_hash: tokenHash,
        status: "invalid",
        disabled_until: null,
      });
    } else if (code === TIMEOUT_CODE) {
      const hours = Number(settingsManager.get("keyTimeoutHours")) || 24;
      this.stmtSetStatus.run({
        endpoint_key: endpointKey,
        token_hash: tokenHash,
        status: "timeout",
        disabled_until: now + hours * 60 * 60 * 1000,
      });
    }

    return { tokenHash };
  }

  /**
   * Manually disable a key. Sets status → 'disabled', which is never usable
   * until a manual re-enable (resetKey). Distinct from 'invalid' so the UI can
   * tell an operator-disabled key from one auto-disabled by a 400/401/402.
   * Takes the raw token (server-side only) so the state row can be created with
   * its masked form if the key has never been used. Returns { tokenHash }.
   */
  disableKey(endpointKey, token) {
    const tokenHash = this.hashToken(endpointKey, token);
    this._ensureRow(endpointKey, tokenHash, token);
    this.stmtSetStatus.run({
      endpoint_key: endpointKey,
      token_hash: tokenHash,
      status: "disabled",
      disabled_until: null,
    });
    return { tokenHash };
  }

  /**
   * Re-enable a key (or all keys of an endpoint): clears invalid/timeout/disabled → active.
   */
  resetKey(endpointKey, { tokenHash = null, all = false } = {}) {
    if (all) {
      return this.stmtResetEndpoint.run({ endpoint_key: endpointKey }).changes;
    }
    if (!tokenHash) return 0;
    return this.stmtResetKey.run({
      endpoint_key: endpointKey,
      token_hash: tokenHash,
    }).changes;
  }

  /**
   * Zero the counters (and per-code counts) for a key or a whole endpoint.
   */
  resetStats(endpointKey, { tokenHash = null, all = false } = {}) {
    const tx = this.db.transaction(() => {
      if (all) {
        this.stmtResetStatsEndpoint.run({ endpoint_key: endpointKey });
        this.stmtDeleteCodesEndpoint.run({ endpoint_key: endpointKey });
      } else if (tokenHash) {
        this.stmtResetStatsKey.run({
          endpoint_key: endpointKey,
          token_hash: tokenHash,
        });
        this.stmtDeleteCodesKey.run({
          endpoint_key: endpointKey,
          token_hash: tokenHash,
        });
      }
    });
    tx();
  }

  /**
   * Joins the endpoint's current tokens with their stored state for the admin
   * modal. Returns masked/hashed data only — never the raw token. Applies lazy
   * timeout recovery so the reported status is accurate.
   */
  getStatesForEndpoint(endpointKey, tokens) {
    const safeTokens = Array.isArray(tokens) ? tokens : [];

    const rows = this.stmtGetEndpointRows.all(endpointKey);
    const byHash = new Map(rows.map((r) => [r.token_hash, r]));

    const codeRows = this.stmtCodesForEndpoint.all(endpointKey);
    const codesByHash = new Map();
    for (const c of codeRows) {
      if (!codesByHash.has(c.token_hash)) codesByHash.set(c.token_hash, {});
      codesByHash.get(c.token_hash)[c.status_code] = c.count;
    }

    const now = this._now();
    return safeTokens.map((token, index) => {
      const tokenHash = this.hashToken(endpointKey, token);
      const row = byHash.get(tokenHash);

      let status = row?.status || "active";
      let disabledUntil = row?.disabled_until ?? null;
      // Reflect lazy recovery in the reported status.
      if (status === "timeout" && disabledUntil != null && disabledUntil <= now) {
        this.stmtRecover.run({ endpoint_key: endpointKey, token_hash: tokenHash });
        status = "active";
        disabledUntil = null;
      }

      const codeCounts = codesByHash.get(tokenHash) || {};

      return {
        index,
        tokenHash,
        maskedKey: row?.masked_key || maskKey(token),
        status,
        disabledUntil,
        lastStatusCode: row?.last_status_code ?? null,
        lastErrorAt: row?.last_error_at ?? null,
        totalRequests: row?.total_requests ?? 0,
        failedRequests: row?.failed_requests ?? 0,
        codeCounts,
      };
    });
  }

  /**
   * Human-readable reason a single key is unavailable, for error messages.
   * Returns null when the key IS usable (so the caller only describes the
   * benched ones). Reads raw token state internally — never returned.
   *
   * Examples:
   *   "sk-…ab12: invalid (last 401)"
   *   "sk-…ab12: rate-limited (429, recovers in 2.3h)"
   *   "sk-…ab12: disabled by operator"
   */
  _reasonUnavailable(state) {
    const masked = state.maskedKey || "key";
    switch (state.status) {
      case "invalid": {
        const code = state.lastStatusCode;
        return `${masked}: invalid${code ? ` (last ${code})` : ""}`;
      }
      case "timeout": {
        const code = state.lastStatusCode ?? 429;
        if (state.disabledUntil) {
          const remainingMs = state.disabledUntil - this._now();
          if (remainingMs > 0) {
            const hours = remainingMs / (60 * 60 * 1000);
            const when =
              hours >= 1
                ? `${hours.toFixed(1)}h`
                : `${Math.max(1, Math.round(remainingMs / 60000))}m`;
            return `${masked}: rate-limited (${code}, recovers in ${when})`;
          }
        }
        return `${masked}: rate-limited (${code})`;
      }
      case "disabled":
        return `${masked}: disabled by operator`;
      default:
        return null; // active / usable
    }
  }

  /**
   * Builds a breakdown of why no usable key remains for an endpoint, so the
   * admin errors page can surface the *real* cause instead of the bare "no
   * token left" string. Reads tokens from Config directly so callers only need
   * the endpointKey. Returns { message, details }:
   *   - message: the generic, client-safe string ("No token left in the chamber.")
   *     — no key material, no health state. This is what gets sent to the API
   *     client and shown in the request log.
   *   - details: a per-key array ("sk-…ab: invalid (last 401)", etc.) — masked
   *     keys only, never raw. This is persisted to the admin error log via
   *     responseBody and NEVER sent to the client.
   *
   * Falls back to empty details when the endpoint has no keys configured or
   * when state can't be read (keeps callers safe in odd states).
   */
  describeExhaustion(endpointKey) {
    const GENERIC = "No token left in the chamber.";
    const endpoint = Config.ENDPOINTS[endpointKey];
    const tokens = Array.isArray(endpoint?.tokens) ? endpoint.tokens : [];

    if (tokens.length === 0) {
      return { message: GENERIC, details: ["endpoint has no keys configured"] };
    }

    const states = this.getStatesForEndpoint(endpointKey, tokens);
    const details = states
      .map((s) => this._reasonUnavailable(s))
      .filter(Boolean);

    if (details.length === 0) {
      // No key reported unavailable — tried every key this request and each
      // was benched mid-hop. Surface that honestly, still admin-only.
      return {
        message: GENERIC,
        details: states.map(
          (s) => `${s.maskedKey || "key"}: attempted, no key succeeded`,
        ),
      };
    }

    return { message: GENERIC, details };
  }

  /**
   * Builds the TokenExhaustedError thrown when an endpoint has no usable key.
   *
   * SECURITY split:
   *   - error.message   = generic "No token left in the chamber."  → safe to
   *     send to the API client (sendStreamError / sendAnthropicStreamError put
   *     error.message on the wire). Reveals nothing about upstream keys.
   *   - error.responseBody = { keyStates: [...] } → the per-key breakdown
   *     (masked keys + why each is unavailable). The catch blocks persist this
   *     to the admin error_logs table via persistUpstreamError, and it is
   *     rendered only in the authenticated admin errors page. It is never sent
   *     to the client.
   *
   * endpointKey optional for safety; without it, the breakdown is empty.
   */
  buildExhaustionError(endpointKey) {
    const { message, details } = endpointKey
      ? this.describeExhaustion(endpointKey)
      : { message: "No token left in the chamber.", details: [] };

    const error = new Error(message);
    error.name = "TokenExhaustedError";
    error.statusCode = 404;
    if (details.length) {
      error.responseBody = { keyStates: details };
    }
    return error;
  }

  close() {
    if (this.db?.open) this.db.close();
  }
}

const keyStateManager = new KeyStateManager();
export default keyStateManager;
