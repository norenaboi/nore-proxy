import path from "path";
import { createRequire } from "module";
const Database: any = createRequire(import.meta.url)("better-sqlite3");
import Config from "../config/index.js";
import { calculateCost } from "../utils/logging.js";
import fs from "fs";

const ERROR_LOG_COLUMNS = [
  "id",
  "timestamp",
  "request_id",
  "model",
  "upstream_model",
  "endpoint_key",
  "endpoint_name",
  "api_format",
  "status_code",
  "error_type",
  "error_code",
  "error_message",
  "request_params",
  "request_headers",
  "upstream_url",
  "response_body",
  "stack_trace",
  "masked_api_key",
  "auto_model",
  "target_model",
  "routing_attempts",
];

const CREATE_ERROR_LOG_TABLE = `
  CREATE TABLE error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    request_id TEXT,
    model TEXT,
    upstream_model TEXT,
    endpoint_key TEXT,
    endpoint_name TEXT,
    api_format TEXT,
    status_code INTEGER,
    error_type TEXT,
    error_code TEXT,
    error_message TEXT,
    request_params TEXT,
    request_headers TEXT,
    upstream_url TEXT,
    response_body TEXT,
    stack_trace TEXT,
    masked_api_key TEXT,
    auto_model TEXT,
    target_model TEXT,
    routing_attempts TEXT
  )
`;

const CREATE_MIGRATION_TABLE = CREATE_ERROR_LOG_TABLE.replace(
  /CREATE TABLE error_logs/,
  "CREATE TABLE error_logs_migration",
);

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
}

function parseJson(value: unknown): any {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeJsonForStorage(value: unknown): string | null {
  return serializeJson(parseJson(value));
}

const MAX_ROUTING_ATTEMPTS_BYTES = 8192;

function serializeRoutingAttempts(value: unknown): string | null {
  const parsed = parseJson(value);
  const serialized = serializeJson(parsed);
  if (serialized === null || Buffer.byteLength(serialized, "utf8") <= MAX_ROUTING_ATTEMPTS_BYTES) {
    return serialized;
  }

  if (!Array.isArray(parsed)) return JSON.stringify({ truncated: true });

  const retained = [];
  for (const attempt of parsed) {
    const candidate = [...retained, attempt, { truncated: true }];
    const candidateJson = serializeJson(candidate);
    if (Buffer.byteLength(candidateJson ?? "", "utf8") > MAX_ROUTING_ATTEMPTS_BYTES) break;
    retained.push(attempt);
  }
  return serializeJson([...retained, { truncated: true }]);
}

function normalizeTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return new Date().toISOString();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return String(value);
}

function truncateText(text: string | null | undefined, maxLen: number): string | null {
  if (text == null) return null;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…[truncated]";
}

function maskStoredApiKey(value: unknown): string {
  if (!value || typeof value !== "string") return "Unknown";
  if (/^.{5}\.\.\..{3}$/s.test(value) || value === "****") return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 5)}...${value.slice(-3)}`;
}

function toEpochSeconds(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric >= 10_000_000_000 ? numeric / 1000 : numeric;
  }
  const milliseconds = Date.parse(String(value));
  return Number.isNaN(milliseconds) ? null : milliseconds / 1000;
}

function nonNegativeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

const RECORDED_COST_BITS = {
  input: 1,
  output: 2,
  cacheWrite: 4,
  cacheRead: 8,
  total: 16,
};

function recordedCostMask(costs: any): number {
  if (!costs || typeof costs !== "object") return 0;
  return (Number.isFinite(costs.input) ? RECORDED_COST_BITS.input : 0)
    | (Number.isFinite(costs.output) ? RECORDED_COST_BITS.output : 0)
    | (Number.isFinite(costs.cache_write) ? RECORDED_COST_BITS.cacheWrite : 0)
    | (Number.isFinite(costs.cache_read) ? RECORDED_COST_BITS.cacheRead : 0)
    | (Number.isFinite(costs.total) ? RECORDED_COST_BITS.total : 0);
}

function normalizeRequestRow(row: any) {
  const parsed = parseJson(row.data);
  const data = parsed && typeof parsed === "object" ? parsed : {};
  const rawStatus = typeof (row.status ?? data.status) === "string"
    ? String(row.status ?? data.status).toLowerCase()
    : "";
  const status = rawStatus === "success" || rawStatus === "failed" ? rawStatus : "unknown";
  const apiKeyId = row.api_key_id ?? (typeof data.api_key_id === "string" && data.api_key_id ? data.api_key_id : null);
  const billingCosts = data.billing?.costs;
  const recordedMask = row.recorded_cost_mask ?? recordedCostMask(billingCosts);
  const recordedTotal = row.recorded_cost_total ?? billingCosts?.total;
  const hasRecordedCosts = recordedMask !== 0;

  return {
    id: row.id,
    timestamp: toEpochSeconds(row.occurred_at ?? data.timestamp ?? row.timestamp),
    requestId: row.request_id ?? data.request_id ?? null,
    name: row.key_name ?? data.key_name ?? "Unknown",
    apiKey: row.api_key_masked ?? maskStoredApiKey(data.api_key),
    apiKeyId,
    legacyKey: !apiKeyId,
    model: (typeof row.request_model === "string" && row.request_model.trim()) ||
      (typeof data.model === "string" && data.model.trim()) ||
      (typeof row.model === "string" && row.model.trim()) || "Unknown",
    status,
    inputTokens: nonNegativeNumber(row.input_tokens ?? data.input_tokens),
    outputTokens: nonNegativeNumber(row.output_tokens ?? data.output_tokens),
    cacheWriteTokens: nonNegativeNumber(row.cache_write_tokens ?? data.cache_write_tokens),
    cacheReadTokens: nonNegativeNumber(row.cache_read_tokens ?? data.cache_read_tokens),
    tokenAccountingVersion: row.token_accounting_version ?? data.token_accounting_version ?? null,
    duration: nonNegativeNumber(row.duration ?? data.duration),
    endpointKey: row.endpoint_key ?? data.endpoint_key ?? null,
    endpointName: row.endpoint_name ?? data.endpoint_name ?? null,
    recordedCost: recordedMask & RECORDED_COST_BITS.total
      ? nonNegativeNumber(recordedTotal)
      : null,
    recordedCostMask: recordedMask,
    recordedCosts: hasRecordedCosts ? {
      input: recordedMask & RECORDED_COST_BITS.input
        ? nonNegativeNumber(row.recorded_cost_input ?? billingCosts?.input)
        : null,
      output: recordedMask & RECORDED_COST_BITS.output
        ? nonNegativeNumber(row.recorded_cost_output ?? billingCosts?.output)
        : null,
      cacheWrite: recordedMask & RECORDED_COST_BITS.cacheWrite
        ? nonNegativeNumber(row.recorded_cost_cache_write ?? billingCosts?.cache_write)
        : null,
      cacheRead: recordedMask & RECORDED_COST_BITS.cacheRead
        ? nonNegativeNumber(row.recorded_cost_cache_read ?? billingCosts?.cache_read)
        : null,
      total: recordedMask & RECORDED_COST_BITS.total
        ? nonNegativeNumber(recordedTotal)
        : null,
    } : null,
  };
}

function normalizeRequestDetail(row: any) {
  if (!row) return null;
  const summary = normalizeRequestRow(row);
  const parsed = parseJson(row.data);
  const data = parsed && typeof parsed === "object" ? parsed : {};
  const context =
    data.request_context && typeof data.request_context === "object"
      ? data.request_context
      : {};
  const billing =
    data.billing && typeof data.billing === "object" ? data.billing : null;

  return {
    ...summary,
    request: {
      clientIp: context.client_ip ?? null,
      protocol: context.protocol ?? null,
      method: context.method ?? null,
      path: context.path ?? null,
      streaming: context.streaming ?? null,
      params: context.params ?? null,
    },
    routing: {
      requestedModel: data.requested_model ?? summary.model,
      autoModel: data.auto_model ?? null,
      targetModel: data.target_model ?? null,
      upstreamModel: data.upstream_model ?? null,
      endpointKey: data.endpoint_key ?? null,
      endpointName: data.endpoint_name ?? null,
      apiFormat: data.api_format ?? null,
      upstreamUrl: data.upstream_url ?? null,
      maskedUpstreamKey: data.masked_upstream_key ?? null,
      attemptCount: nonNegativeNumber(data.routing_attempt_count),
      attempts: Array.isArray(data.routing_attempts)
        ? data.routing_attempts
        : null,
    },
    outcome: {
      upstreamStatus: data.upstream_status ?? null,
      proxyStatus: data.proxy_status ?? null,
      error: data.error ?? null,
    },
    billing,
  };
}

function mapErrorRow(row: any) {
  if (!row) return null;

  return {
    id: row.id,
    timestamp: row.timestamp,
    requestId: row.request_id ?? null,
    model: row.model ?? null,
    upstreamModel: row.upstream_model ?? null,
    endpointKey: row.endpoint_key ?? null,
    endpointName: row.endpoint_name ?? null,
    apiFormat: row.api_format ?? null,
    statusCode: row.status_code ?? null,
    errorType: row.error_type ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    requestParams: parseJson(row.request_params),
    requestHeaders: parseJson(row.request_headers),
    upstreamUrl: row.upstream_url ?? null,
    responseBody: parseJson(row.response_body),
    stackTrace: row.stack_trace ?? null,
    maskedApiKey: row.masked_api_key ?? null,
    autoModel: row.auto_model ?? null,
    targetModel: row.target_model ?? null,
    routingAttempts: parseJson(row.routing_attempts),
  };
}

function firstPresent(row: Record<string, any>, legacyData: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
    if (legacyData[key] !== undefined && legacyData[key] !== null) {
      return legacyData[key];
    }
  }
  return null;
}

export class LogManager {
  [key: string]: any;
  constructor(
    dbPath =
      process.env.NORE_PROXY_LOG_DB_PATH ||
      path.join(Config.LOG_DIR, "logs.db"),
  ) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        type TEXT,
        model TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_type ON request_logs(type);
      CREATE INDEX IF NOT EXISTS idx_request_model ON request_logs(model);
      CREATE INDEX IF NOT EXISTS idx_request_type_id
        ON request_logs(type, id DESC);
    `);

    this.ensureRequestLogSchema();
    this.ensureErrorLogSchema();
    this.createErrorLogIndexes();
  }

  ensureRequestLogSchema() {
    // The JSON blob remains the source-of-record for backwards compatibility;
    // these projections make the hot read paths indexable without discarding it.
    const columns = [
      "projection_version", "occurred_at", "request_id", "request_model", "status", "api_key_id",
      "key_name", "api_key_masked", "legacy_key", "input_tokens", "output_tokens",
      "cache_write_tokens", "cache_read_tokens", "token_accounting_version",
      "duration", "endpoint_key", "endpoint_name", "recorded_cost_input",
      "recorded_cost_output", "recorded_cost_cache_write", "recorded_cost_cache_read",
      "recorded_cost_total", "recorded_cost_mask",
    ];
    const existing = new Set(this.db.prepare("PRAGMA table_info(request_logs)").all().map((column: { name: string }) => column.name));
    const definitions = {
      projection_version: "INTEGER NOT NULL DEFAULT 0", occurred_at: "REAL", request_id: "TEXT", request_model: "TEXT", status: "TEXT",
      api_key_id: "TEXT", key_name: "TEXT", api_key_masked: "TEXT", legacy_key: "INTEGER NOT NULL DEFAULT 0", input_tokens: "INTEGER",
      output_tokens: "INTEGER", cache_write_tokens: "INTEGER", cache_read_tokens: "INTEGER",
      token_accounting_version: "TEXT", duration: "REAL", endpoint_key: "TEXT",
      endpoint_name: "TEXT", recorded_cost_input: "REAL", recorded_cost_output: "REAL",
      recorded_cost_cache_write: "REAL", recorded_cost_cache_read: "REAL", recorded_cost_total: "REAL",
      recorded_cost_mask: "INTEGER NOT NULL DEFAULT 0",
    };
    let migrated = false;
    const migrate = this.db.transaction(() => {
      for (const column of columns) {
        if (!existing.has(column)) {
          this.db.exec(`ALTER TABLE request_logs ADD COLUMN ${column} ${definitions[column as keyof typeof definitions]}`);
          migrated = true;
        }
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS request_daily_rollups (
          day TEXT NOT NULL, api_key_id TEXT NOT NULL DEFAULT '', api_key_masked TEXT NOT NULL DEFAULT '',
          legacy_key INTEGER NOT NULL DEFAULT 0, request_model TEXT NOT NULL DEFAULT '',
          token_accounting_version TEXT NOT NULL DEFAULT '', recorded_cost_mask INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          successful INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          duration_total REAL NOT NULL DEFAULT 0, duration_count INTEGER NOT NULL DEFAULT 0,
          recorded_cost_input REAL NOT NULL DEFAULT 0, recorded_cost_output REAL NOT NULL DEFAULT 0,
          recorded_cost_cache_write REAL NOT NULL DEFAULT 0, recorded_cost_cache_read REAL NOT NULL DEFAULT 0,
          recorded_cost_total REAL NOT NULL DEFAULT 0, recorded_cost_count INTEGER NOT NULL DEFAULT 0,
          success_input_tokens INTEGER NOT NULL DEFAULT 0, success_output_tokens INTEGER NOT NULL DEFAULT 0,
          success_cache_write_tokens INTEGER NOT NULL DEFAULT 0, success_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          unrecorded_success_input_tokens INTEGER NOT NULL DEFAULT 0, unrecorded_success_output_tokens INTEGER NOT NULL DEFAULT 0,
          unrecorded_success_cache_write_tokens INTEGER NOT NULL DEFAULT 0, unrecorded_success_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          costs_success_only INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (day, api_key_id, api_key_masked, legacy_key, request_model, token_accounting_version, recorded_cost_mask)
        );
        CREATE INDEX IF NOT EXISTS idx_request_end_occurred ON request_logs(type, occurred_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_request_end_model_time ON request_logs(type, request_model, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_request_end_key_time ON request_logs(type, api_key_id, api_key_masked, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_request_end_status_time ON request_logs(type, status, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_request_daily_rollups_day ON request_daily_rollups(day);
        CREATE INDEX IF NOT EXISTS idx_request_daily_rollups_key ON request_daily_rollups(api_key_id, api_key_masked, day);
        CREATE INDEX IF NOT EXISTS idx_request_daily_rollups_model ON request_daily_rollups(request_model, token_accounting_version, day);
      `);
    });
    migrate();
    const rollupColumns = new Set(this.db.prepare("PRAGMA table_info(request_daily_rollups)").all().map((column: { name: string }) => column.name));
    const rollupVersionCurrent = rollupColumns.has("legacy_key") && rollupColumns.has("failed") && rollupColumns.has("token_accounting_version") && rollupColumns.has("unrecorded_success_input_tokens") && rollupColumns.has("costs_success_only") && rollupColumns.has("recorded_cost_mask");
    if (!rollupVersionCurrent) this.db.exec("DROP TABLE IF EXISTS request_daily_rollups");
    // Re-create the current rollup schema after replacing an earlier compact schema.
    if (!rollupVersionCurrent) this.db.exec(`CREATE TABLE request_daily_rollups (
      day TEXT NOT NULL, api_key_id TEXT NOT NULL DEFAULT '', api_key_masked TEXT NOT NULL DEFAULT '', legacy_key INTEGER NOT NULL DEFAULT 0,
      request_model TEXT NOT NULL DEFAULT '', token_accounting_version TEXT NOT NULL DEFAULT '', recorded_cost_mask INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      successful INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, duration_total REAL NOT NULL DEFAULT 0,
      duration_count INTEGER NOT NULL DEFAULT 0, recorded_cost_input REAL NOT NULL DEFAULT 0, recorded_cost_output REAL NOT NULL DEFAULT 0,
      recorded_cost_cache_write REAL NOT NULL DEFAULT 0, recorded_cost_cache_read REAL NOT NULL DEFAULT 0, recorded_cost_total REAL NOT NULL DEFAULT 0,
      recorded_cost_count INTEGER NOT NULL DEFAULT 0, success_input_tokens INTEGER NOT NULL DEFAULT 0,
      success_output_tokens INTEGER NOT NULL DEFAULT 0, success_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      success_cache_read_tokens INTEGER NOT NULL DEFAULT 0, unrecorded_success_input_tokens INTEGER NOT NULL DEFAULT 0,
      unrecorded_success_output_tokens INTEGER NOT NULL DEFAULT 0, unrecorded_success_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      unrecorded_success_cache_read_tokens INTEGER NOT NULL DEFAULT 0, costs_success_only INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (day, api_key_id, api_key_masked, legacy_key, request_model, token_accounting_version, recorded_cost_mask)
    )`);
    const backfilled = this.backfillRequestProjections();
    const projectedCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM request_logs WHERE type = 'request_end' AND projection_version >= 2 AND occurred_at IS NOT NULL",
    ).get().count;
    const rollupCount = this.db.prepare(
      "SELECT COALESCE(SUM(requests), 0) AS count FROM request_daily_rollups",
    ).get().count;
    if (migrated || backfilled || !rollupVersionCurrent || projectedCount !== rollupCount) {
      this.rebuildRequestRollups();
    }
  }

  requestProjectionValues(logEntry: any, row: any = {}) {
    const normalized = normalizeRequestRow({ ...row, data: serializeJson(logEntry), model: row.model ?? logEntry.model });
    return {
      projection_version: 2,
      occurred_at: normalized.timestamp,
      request_id: normalized.requestId,
      request_model: normalized.model === "Unknown" ? null : normalized.model,
      status: normalized.status === "unknown" ? null : normalized.status,
      api_key_id: normalized.apiKeyId,
      key_name: normalized.name === "Unknown" ? null : normalized.name,
      api_key_masked: normalized.apiKey === "Unknown" ? null : normalized.apiKey,
      legacy_key: normalized.legacyKey ? 1 : 0,
      input_tokens: normalized.inputTokens, output_tokens: normalized.outputTokens,
      cache_write_tokens: normalized.cacheWriteTokens, cache_read_tokens: normalized.cacheReadTokens,
      token_accounting_version: normalized.tokenAccountingVersion, duration: normalized.duration,
      endpoint_key: normalized.endpointKey, endpoint_name: normalized.endpointName,
      recorded_cost_input: normalized.recordedCosts?.input ?? null,
      recorded_cost_output: normalized.recordedCosts?.output ?? null,
      recorded_cost_cache_write: normalized.recordedCosts?.cacheWrite ?? null,
      recorded_cost_cache_read: normalized.recordedCosts?.cacheRead ?? null,
      recorded_cost_total: normalized.recordedCosts?.total ?? null,
      recorded_cost_mask: normalized.recordedCostMask,
    };
  }

  backfillRequestProjections() {
    // projection_version marks malformed rows complete too, so a bad timestamp cannot loop forever.
    const select = this.db.prepare(`SELECT id, timestamp, model, data FROM request_logs
      WHERE type = 'request_end' AND projection_version < 2 ORDER BY id LIMIT 500`);
    const update = this.db.prepare(`UPDATE request_logs SET
      projection_version=@projection_version, occurred_at=@occurred_at, request_id=@request_id, request_model=@request_model, status=@status,
      api_key_id=@api_key_id, key_name=@key_name, api_key_masked=@api_key_masked, legacy_key=@legacy_key,
      input_tokens=@input_tokens, output_tokens=@output_tokens, cache_write_tokens=@cache_write_tokens,
      cache_read_tokens=@cache_read_tokens, token_accounting_version=@token_accounting_version, duration=@duration,
      endpoint_key=@endpoint_key, endpoint_name=@endpoint_name, recorded_cost_input=@recorded_cost_input,
      recorded_cost_output=@recorded_cost_output, recorded_cost_cache_write=@recorded_cost_cache_write,
      recorded_cost_cache_read=@recorded_cost_cache_read, recorded_cost_total=@recorded_cost_total,
      recorded_cost_mask=@recorded_cost_mask WHERE id=@id`);
    const runBatch = this.db.transaction((rows: any[]) => rows.forEach((row: any) =>
      update.run({ id: row.id, ...this.requestProjectionValues(parseJson(row.data) || {}, row) }),
    ));
    let rows;
    let updated = 0;
    do {
      rows = select.all();
      if (rows.length) { runBatch(rows); updated += rows.length; }
    } while (rows.length === 500);
    return updated;
  }

  rebuildRequestRollups() {
    const rebuild = this.db.transaction(() => {
      this.db.exec("DELETE FROM request_daily_rollups");
      this.db.exec(`INSERT INTO request_daily_rollups (
          day, api_key_id, api_key_masked, legacy_key, request_model,
          token_accounting_version, recorded_cost_mask, requests, successful, failed,
          input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
          duration_total, duration_count, recorded_cost_input,
          recorded_cost_output, recorded_cost_cache_write,
          recorded_cost_cache_read, recorded_cost_total, recorded_cost_count,
          success_input_tokens, success_output_tokens,
          success_cache_write_tokens, success_cache_read_tokens,
          unrecorded_success_input_tokens, unrecorded_success_output_tokens,
          unrecorded_success_cache_write_tokens,
          unrecorded_success_cache_read_tokens
        )
        SELECT date(occurred_at, 'unixepoch'), COALESCE(api_key_id, ''), COALESCE(api_key_masked, ''), legacy_key,
          COALESCE(request_model, ''), COALESCE(token_accounting_version, ''), recorded_cost_mask, COUNT(*),
          SUM(status = 'success'), SUM(status = 'failed'), SUM(input_tokens), SUM(output_tokens), SUM(cache_write_tokens), SUM(cache_read_tokens),
          SUM(duration), SUM(duration > 0), SUM(CASE WHEN status = 'success' THEN COALESCE(recorded_cost_input, 0) ELSE 0 END), SUM(CASE WHEN status = 'success' THEN COALESCE(recorded_cost_output, 0) ELSE 0 END),
          SUM(CASE WHEN status = 'success' THEN COALESCE(recorded_cost_cache_write, 0) ELSE 0 END), SUM(CASE WHEN status = 'success' THEN COALESCE(recorded_cost_cache_read, 0) ELSE 0 END),
          SUM(CASE WHEN status = 'success' THEN COALESCE(recorded_cost_total, 0) ELSE 0 END), SUM(status = 'success' AND recorded_cost_total IS NOT NULL),
          SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END), SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END),
          SUM(CASE WHEN status = 'success' THEN cache_write_tokens ELSE 0 END), SUM(CASE WHEN status = 'success' THEN cache_read_tokens ELSE 0 END),
          SUM(CASE WHEN status = 'success' AND (recorded_cost_mask & 16) = 0 THEN input_tokens ELSE 0 END), SUM(CASE WHEN status = 'success' AND (recorded_cost_mask & 16) = 0 THEN output_tokens ELSE 0 END),
          SUM(CASE WHEN status = 'success' AND (recorded_cost_mask & 16) = 0 THEN cache_write_tokens ELSE 0 END), SUM(CASE WHEN status = 'success' AND (recorded_cost_mask & 16) = 0 THEN cache_read_tokens ELSE 0 END)
        FROM request_logs WHERE type = 'request_end' AND occurred_at IS NOT NULL AND projection_version >= 2
        GROUP BY date(occurred_at, 'unixepoch'), COALESCE(api_key_id, ''), COALESCE(api_key_masked, ''), legacy_key,
          COALESCE(request_model, ''), COALESCE(token_accounting_version, ''), recorded_cost_mask`);
    });
    rebuild();
  }

  updateDailyRollup(projection: any) {
    if (projection.occurred_at === null) return;
    const day = new Date(projection.occurred_at * 1000).toISOString().slice(0, 10);
    this.db.prepare(`INSERT INTO request_daily_rollups VALUES (
      @day, @apiKeyId, @apiKeyMasked, @legacyKey, @model, @accountingVersion, @recordedCostMask, 1, @successful, @failed,
      @input, @output, @cacheWrite, @cacheRead, @duration, @durationCount,
      @costInput, @costOutput, @costCacheWrite, @costCacheRead, @costTotal, @costCount,
      @successInput, @successOutput, @successCacheWrite, @successCacheRead,
      @unrecordedInput, @unrecordedOutput, @unrecordedCacheWrite, @unrecordedCacheRead, 1)
      ON CONFLICT(day, api_key_id, api_key_masked, legacy_key, request_model, token_accounting_version, recorded_cost_mask) DO UPDATE SET
      requests=requests+1, successful=successful+excluded.successful, failed=failed+excluded.failed,
      input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
      cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      duration_total=duration_total+excluded.duration_total, duration_count=duration_count+excluded.duration_count,
      recorded_cost_input=recorded_cost_input+excluded.recorded_cost_input, recorded_cost_output=recorded_cost_output+excluded.recorded_cost_output,
      recorded_cost_cache_write=recorded_cost_cache_write+excluded.recorded_cost_cache_write,
      recorded_cost_cache_read=recorded_cost_cache_read+excluded.recorded_cost_cache_read,
      recorded_cost_total=recorded_cost_total+excluded.recorded_cost_total, recorded_cost_count=recorded_cost_count+excluded.recorded_cost_count,
      success_input_tokens=success_input_tokens+excluded.success_input_tokens, success_output_tokens=success_output_tokens+excluded.success_output_tokens,
      success_cache_write_tokens=success_cache_write_tokens+excluded.success_cache_write_tokens, success_cache_read_tokens=success_cache_read_tokens+excluded.success_cache_read_tokens,
      unrecorded_success_input_tokens=unrecorded_success_input_tokens+excluded.unrecorded_success_input_tokens, unrecorded_success_output_tokens=unrecorded_success_output_tokens+excluded.unrecorded_success_output_tokens,
      unrecorded_success_cache_write_tokens=unrecorded_success_cache_write_tokens+excluded.unrecorded_success_cache_write_tokens, unrecorded_success_cache_read_tokens=unrecorded_success_cache_read_tokens+excluded.unrecorded_success_cache_read_tokens`).run({
      day, apiKeyId: projection.api_key_id ?? '', apiKeyMasked: projection.api_key_masked ?? '', legacyKey: projection.legacy_key,
      model: projection.request_model ?? '', accountingVersion: projection.token_accounting_version ?? '',
      recordedCostMask: projection.recorded_cost_mask, successful: projection.status === 'success' ? 1 : 0,
      failed: projection.status === 'failed' ? 1 : 0, input: projection.input_tokens, output: projection.output_tokens,
      cacheWrite: projection.cache_write_tokens, cacheRead: projection.cache_read_tokens, duration: projection.duration, durationCount: projection.duration > 0 ? 1 : 0,
      costInput: projection.status === 'success' ? projection.recorded_cost_input ?? 0 : 0, costOutput: projection.status === 'success' ? projection.recorded_cost_output ?? 0 : 0,
      costCacheWrite: projection.status === 'success' ? projection.recorded_cost_cache_write ?? 0 : 0, costCacheRead: projection.status === 'success' ? projection.recorded_cost_cache_read ?? 0 : 0,
      costTotal: projection.status === 'success' ? projection.recorded_cost_total ?? 0 : 0, costCount: projection.status === 'success' && projection.recorded_cost_total !== null ? 1 : 0,
      successInput: projection.status === 'success' ? projection.input_tokens : 0, successOutput: projection.status === 'success' ? projection.output_tokens : 0,
      successCacheWrite: projection.status === 'success' ? projection.cache_write_tokens : 0, successCacheRead: projection.status === 'success' ? projection.cache_read_tokens : 0,
      unrecordedInput: projection.status === 'success' && projection.recorded_cost_total === null ? projection.input_tokens : 0,
      unrecordedOutput: projection.status === 'success' && projection.recorded_cost_total === null ? projection.output_tokens : 0,
      unrecordedCacheWrite: projection.status === 'success' && projection.recorded_cost_total === null ? projection.cache_write_tokens : 0,
      unrecordedCacheRead: projection.status === 'success' && projection.recorded_cost_total === null ? projection.cache_read_tokens : 0,
    });
  }

  formatAggregate(row: any) {
    return { total: Number(row.total) || 0, successful: Number(row.successful) || 0, failed: Number(row.failed) || 0,
      inputTokens: Number(row.inputTokens) || 0, outputTokens: Number(row.outputTokens) || 0,
      cacheWriteTokens: Number(row.cacheWriteTokens) || 0, cacheReadTokens: Number(row.cacheReadTokens) || 0,
      avgDuration: Number(row.durationCount) ? Number(row.durationTotal) / Number(row.durationCount) : 0,
      recordedCosts: { input: Number(row.recordedCostInput) || 0, output: Number(row.recordedCostOutput) || 0,
        cacheWrite: Number(row.recordedCostCacheWrite) || 0, cacheRead: Number(row.recordedCostCacheRead) || 0,
        total: Number(row.recordedCostTotal) || 0, count: Number(row.recordedCostCount) || 0 } };
  }

  aggregateRequests(filters: any = {}) {
    const fullDay = filters.from == null && filters.to == null && !filters.cursor && !filters.status && !filters.endpoint;
    const source = fullDay ? "request_daily_rollups" : "request_logs";
    const clauses = fullDay ? ["1=1"] : ["type = 'request_end'", "projection_version >= 2"];
    const params = { apiKey: filters.apiKey ?? null, legacyMask: filters.legacyMask ?? filters.apiKeyMask ?? "", model: filters.model ?? null, status: filters.status ?? null, from: filters.from ?? null, to: filters.to ?? null };
    if (filters.apiKey) clauses.push("(api_key_id = @apiKey OR (legacy_key = 1 AND api_key_masked = @legacyMask))");
    if (filters.model) clauses.push("request_model = @model");
    if (!fullDay && filters.status) clauses.push("status = @status");
    if (!fullDay && filters.from != null) clauses.push("occurred_at >= @from");
    if (!fullDay && filters.to != null) clauses.push("occurred_at <= @to");
    const total = fullDay ? "SUM(requests)" : "COUNT(*)";
    const success = fullDay ? "SUM(successful)" : "SUM(status = 'success')";
    const failed = fullDay ? "SUM(failed)" : "SUM(status = 'failed')";
    const duration = fullDay ? "duration_total" : "duration";
    const durationCount = fullDay ? "duration_count" : "duration > 0";
    const costCount = fullDay ? "recorded_cost_count" : "recorded_cost_total IS NOT NULL";
    const row = this.db.prepare(`SELECT ${total} AS total, ${success} AS successful, ${failed} AS failed,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cache_write_tokens) AS cacheWriteTokens, SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(${duration}) AS durationTotal, SUM(${durationCount}) AS durationCount, SUM(recorded_cost_input) AS recordedCostInput,
      SUM(recorded_cost_output) AS recordedCostOutput, SUM(recorded_cost_cache_write) AS recordedCostCacheWrite,
      SUM(recorded_cost_cache_read) AS recordedCostCacheRead, SUM(recorded_cost_total) AS recordedCostTotal, SUM(${costCount}) AS recordedCostCount
      FROM ${source} WHERE ${clauses.join(" AND ")}`).get(params);
    return this.formatAggregate(row);
  }

  getRequestAggregates(filters: any = {}) { return this.aggregateRequests(filters); }
  getRequestRangeAggregates(ranges: any[] = []) { return ranges.map((range) => ({ ...range, ...this.aggregateRequests(range) })); }
  getBulkApiKeyAggregates(filters: any = {}) {
    return this.getAggregateRows(filters, "key");
  }
  getBulkModelAggregates(filters: any = {}) {
    return this.getAggregateRows(filters, "model");
  }
  getBulkDashboardAggregates(ranges: any[] = []) {
    return ranges.map((range) => ({
      ...range,
      total: this.getAggregateRows(range),
      keys: this.getAggregateRows(range, "key"),
    }));
  }

  getAggregateRows(filters: any = {}, groupBy: "key" | "model" | null = null) {
    // Rollups are exact for unbounded history. Any bounded/status-filtered range
    // reads projections so its inclusive timestamp bounds remain exact.
    const useRollups = filters.from == null && filters.to == null && !filters.status && !filters.endpoint;
    const source = useRollups ? "request_daily_rollups" : "request_logs";
    const clauses = useRollups ? ["1=1"] : ["type = 'request_end'", "projection_version >= 2"];
    const params = {
      from: filters.from ?? null, to: filters.to ?? null, model: filters.model ?? null,
      apiKey: filters.apiKey ?? null, legacyMask: filters.legacyMask ?? filters.apiKeyMask ?? "",
      status: filters.status ?? null, endpoint: filters.endpoint ?? null,
    };
    if (filters.model) clauses.push("request_model = @model");
    if (filters.apiKey) clauses.push("(api_key_id = @apiKey OR (legacy_key = 1 AND api_key_masked = @legacyMask))");
    if (!useRollups && filters.status) clauses.push("status = @status");
    if (!useRollups && filters.endpoint) clauses.push("endpoint_name = @endpoint");
    if (!useRollups && filters.from != null) clauses.push("occurred_at >= @from");
    if (!useRollups && filters.to != null) clauses.push("occurred_at <= @to");

    const total = useRollups ? "SUM(requests)" : "COUNT(*)";
    const successful = useRollups ? "SUM(successful)" : "SUM(status = 'success')";
    const failed = useRollups ? "SUM(failed)" : "SUM(status = 'failed')";
    const successInput = useRollups ? "SUM(success_input_tokens)" : "SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END)";
    const successOutput = useRollups ? "SUM(success_output_tokens)" : "SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END)";
    const successCacheWrite = useRollups ? "SUM(success_cache_write_tokens)" : "SUM(CASE WHEN status = 'success' THEN cache_write_tokens ELSE 0 END)";
    const successCacheRead = useRollups ? "SUM(success_cache_read_tokens)" : "SUM(CASE WHEN status = 'success' THEN cache_read_tokens ELSE 0 END)";
    const fallbackInput = useRollups ? "SUM(unrecorded_success_input_tokens)" : "SUM(CASE WHEN status = 'success' AND recorded_cost_total IS NULL THEN input_tokens ELSE 0 END)";
    const fallbackOutput = useRollups ? "SUM(unrecorded_success_output_tokens)" : "SUM(CASE WHEN status = 'success' AND recorded_cost_total IS NULL THEN output_tokens ELSE 0 END)";
    const fallbackCacheWrite = useRollups ? "SUM(unrecorded_success_cache_write_tokens)" : "SUM(CASE WHEN status = 'success' AND recorded_cost_total IS NULL THEN cache_write_tokens ELSE 0 END)";
    const fallbackCacheRead = useRollups ? "SUM(unrecorded_success_cache_read_tokens)" : "SUM(CASE WHEN status = 'success' AND recorded_cost_total IS NULL THEN cache_read_tokens ELSE 0 END)";
    const recordedCount = useRollups ? "SUM(recorded_cost_count)" : "SUM(status = 'success' AND recorded_cost_total IS NOT NULL)";
    const keyFields = groupBy === "key" ? "api_key_id AS apiKeyId, api_key_masked AS apiKeyMask, legacy_key AS legacyKey," : "";
    const groupFields = groupBy === "key"
      ? "api_key_id, api_key_masked, legacy_key, request_model, token_accounting_version, recorded_cost_mask"
      : "request_model, token_accounting_version, recorded_cost_mask";
    const rows = this.db.prepare(`SELECT ${keyFields} request_model AS model, token_accounting_version AS tokenAccountingVersion,
      recorded_cost_mask AS recordedCostMask,
      ${total} AS total, ${successful} AS successful, ${failed} AS failed,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cache_write_tokens) AS cacheWriteTokens, SUM(cache_read_tokens) AS cacheReadTokens,
      ${successInput} AS successInputTokens, ${successOutput} AS successOutputTokens,
      ${successCacheWrite} AS successCacheWriteTokens, ${successCacheRead} AS successCacheReadTokens,
      ${fallbackInput} AS fallbackInputTokens, ${fallbackOutput} AS fallbackOutputTokens,
      ${fallbackCacheWrite} AS fallbackCacheWriteTokens, ${fallbackCacheRead} AS fallbackCacheReadTokens,
      ${useRollups ? 'SUM(recorded_cost_input)' : "SUM(CASE WHEN status = 'success' THEN recorded_cost_input ELSE 0 END)"} AS recordedCostInput,
      ${useRollups ? 'SUM(recorded_cost_output)' : "SUM(CASE WHEN status = 'success' THEN recorded_cost_output ELSE 0 END)"} AS recordedCostOutput,
      ${useRollups ? 'SUM(recorded_cost_cache_write)' : "SUM(CASE WHEN status = 'success' THEN recorded_cost_cache_write ELSE 0 END)"} AS recordedCostCacheWrite,
      ${useRollups ? 'SUM(recorded_cost_cache_read)' : "SUM(CASE WHEN status = 'success' THEN recorded_cost_cache_read ELSE 0 END)"} AS recordedCostCacheRead,
      ${useRollups ? 'SUM(recorded_cost_total)' : "SUM(CASE WHEN status = 'success' THEN recorded_cost_total ELSE 0 END)"} AS recordedCostTotal, ${recordedCount} AS recordedCostCount
      FROM ${source} WHERE ${clauses.join(" AND ")} GROUP BY ${groupFields}`).all(params);
    return rows.map((row: any) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      ["apiKeyId", "apiKeyMask"].includes(key)
        ? value || null
        : ["model", "tokenAccountingVersion"].includes(key)
          ? value
          : Number(value) || 0,
    ])));
  }
  getCostForGroups(groups: any[]) {
    return groups.reduce((costs, group) => {
      const mask = group.recordedCostMask || 0;
      const calculated = calculateCost(
        group.model || "Unknown",
        group.successInputTokens,
        group.successOutputTokens,
        group.successCacheWriteTokens,
        group.successCacheReadTokens,
        group.tokenAccountingVersion || null,
      );
      costs.input += mask & RECORDED_COST_BITS.input
        ? group.recordedCostInput
        : calculated.inputCost;
      costs.output += mask & RECORDED_COST_BITS.output
        ? group.recordedCostOutput
        : calculated.outputCost;
      costs.cacheWrite += mask & RECORDED_COST_BITS.cacheWrite
        ? group.recordedCostCacheWrite
        : calculated.cacheWriteCost;
      costs.cacheRead += mask & RECORDED_COST_BITS.cacheRead
        ? group.recordedCostCacheRead
        : calculated.cacheReadCost;
      costs.total += mask & RECORDED_COST_BITS.total
        ? group.recordedCostTotal
        : calculated.totalCost;
      return costs;
    }, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });
  }
  getApiKeyAggregates(filters: any = {}) { return this.getBulkApiKeyAggregates(filters); }
  getModelAggregates(filters: any = {}) { return this.getBulkModelAggregates(filters); }

  getCostBreakdown(filters: any = {}) {
    const fullDay = filters.from == null && filters.to == null;
    const source = fullDay ? "request_daily_rollups" : "request_logs";
    const clauses = fullDay ? ["1=1"] : ["type = 'request_end'", "projection_version >= 2", "status = 'success'"];
    const params = { from: filters.from ?? null, to: filters.to ?? null };
    if (!fullDay && filters.from != null) clauses.push("occurred_at >= @from");
    if (!fullDay && filters.to != null) clauses.push("occurred_at <= @to");
    const input = fullDay ? "SUM(success_input_tokens)" : "SUM(input_tokens)";
    const output = fullDay ? "SUM(success_output_tokens)" : "SUM(output_tokens)";
    const cacheWrite = fullDay ? "SUM(success_cache_write_tokens)" : "SUM(cache_write_tokens)";
    const cacheRead = fullDay ? "SUM(success_cache_read_tokens)" : "SUM(cache_read_tokens)";
    return this.db.prepare(`SELECT request_model AS model, token_accounting_version AS tokenAccountingVersion, ${input} AS inputTokens, ${output} AS outputTokens, ${cacheWrite} AS cacheWriteTokens, ${cacheRead} AS cacheReadTokens FROM ${source} WHERE ${clauses.join(" AND ")} GROUP BY request_model, token_accounting_version`).all(params).map((row: any) => ({ model: row.model || "Unknown", tokenAccountingVersion: row.tokenAccountingVersion || null, inputTokens: Number(row.inputTokens) || 0, outputTokens: Number(row.outputTokens) || 0, cacheWriteTokens: Number(row.cacheWriteTokens) || 0, cacheReadTokens: Number(row.cacheReadTokens) || 0 }));
  }

  getRecentRequests(limit = 50, filters: any = {}) { return this.getRequestHistory({ ...filters, limit: Math.min(Math.max(Number(limit) || 50, 1), 200) }); }

  ensureErrorLogSchema() {
    const tableExists = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'error_logs'",
      )
      .get();

    if (!tableExists) {
      this.db.exec(CREATE_ERROR_LOG_TABLE);
      return;
    }

    const existingColumns = this.db
      .prepare("PRAGMA table_info(error_logs)")
      .all()
      .map((column: { name: string }) => column.name);
    const isStructured = ERROR_LOG_COLUMNS.every((column) =>
      existingColumns.includes(column),
    );

    if (!isStructured) this.migrateErrorLogs();
  }

  migrateErrorLogs() {
    const legacyRows = this.db.prepare("SELECT * FROM error_logs ORDER BY id").all();

    const migrate = this.db.transaction(() => {
      this.db.exec("DROP TABLE IF EXISTS error_logs_migration");
      this.db.exec(CREATE_MIGRATION_TABLE);

      const insert = this.db.prepare(`
        INSERT INTO error_logs_migration (
          id, timestamp, request_id, model, upstream_model,
          endpoint_key, endpoint_name, api_format, status_code,
          error_type, error_code, error_message, request_params,
          request_headers, upstream_url, response_body, stack_trace,
          masked_api_key, auto_model, target_model, routing_attempts
        ) VALUES (
          @id, @timestamp, @requestId, @model, @upstreamModel,
          @endpointKey, @endpointName, @apiFormat, @statusCode,
          @errorType, @errorCode, @errorMessage, @requestParams,
          @requestHeaders, @upstreamUrl, @responseBody, @stackTrace,
          @maskedApiKey, @autoModel, @targetModel, @routingAttempts
        )
      `);

      for (const row of legacyRows) {
        const parsedLegacy = parseJson(row.data);
        const legacyData =
          parsedLegacy && typeof parsedLegacy === "object" ? parsedLegacy : {};
        const statusValue = firstPresent(
          row,
          legacyData,
          "status_code",
          "statusCode",
        );
        const numericStatus =
          statusValue === undefined || statusValue === null || statusValue === ""
            ? NaN
            : Number(statusValue);

        insert.run({
          id: row.id ?? null,
          timestamp: normalizeTimestamp(
            firstPresent(row, legacyData, "timestamp"),
          ),
          requestId: firstPresent(
            row,
            legacyData,
            "request_id",
            "requestId",
          ),
          model: firstPresent(row, legacyData, "model"),
          upstreamModel: firstPresent(
            row,
            legacyData,
            "upstream_model",
            "upstreamModel",
            "actual_model",
            "actualModel",
          ),
          endpointKey: firstPresent(
            row,
            legacyData,
            "endpoint_key",
            "endpointKey",
          ),
          endpointName: firstPresent(
            row,
            legacyData,
            "endpoint_name",
            "endpointName",
            "endpoint",
          ),
          apiFormat: firstPresent(
            row,
            legacyData,
            "api_format",
            "apiFormat",
          ),
          statusCode: Number.isInteger(numericStatus) ? numericStatus : null,
          errorType: firstPresent(
            row,
            legacyData,
            "error_type",
            "errorType",
          ),
          errorCode: firstPresent(
            row,
            legacyData,
            "error_code",
            "errorCode",
          ),
          errorMessage:
            firstPresent(
              row,
              legacyData,
              "error_message",
              "errorMessage",
            ) || (typeof parsedLegacy === "string" ? parsedLegacy : null),
          requestParams: normalizeJsonForStorage(
            firstPresent(
              row,
              legacyData,
              "request_params",
              "requestParams",
              "request_body",
              "requestBody",
            ),
          ),
          requestHeaders: normalizeJsonForStorage(
            firstPresent(
              row,
              legacyData,
              "request_headers",
              "requestHeaders",
            ),
          ),
          upstreamUrl: firstPresent(
            row,
            legacyData,
            "upstream_url",
            "upstreamUrl",
          ),
          responseBody: normalizeJsonForStorage(
            firstPresent(
              row,
              legacyData,
              "response_body",
              "responseBody",
            ),
          ),
          stackTrace: firstPresent(
            row,
            legacyData,
            "stack_trace",
            "stackTrace",
          ),
          maskedApiKey: firstPresent(
            row,
            legacyData,
            "masked_api_key",
            "maskedApiKey",
          ),
          autoModel: firstPresent(
            row,
            legacyData,
            "auto_model",
            "autoModel",
          ),
          targetModel: firstPresent(
            row,
            legacyData,
            "target_model",
            "targetModel",
          ),
          routingAttempts: serializeRoutingAttempts(
            firstPresent(
              row,
              legacyData,
              "routing_attempts",
              "routingAttempts",
            ),
          ),
        });
      }

      this.db.exec(`
        DROP TABLE error_logs;
        ALTER TABLE error_logs_migration RENAME TO error_logs;
      `);
    });

    migrate();
  }

  createErrorLogIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp
        ON error_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_error_logs_model
        ON error_logs(model);
      CREATE INDEX IF NOT EXISTS idx_error_logs_endpoint_name
        ON error_logs(endpoint_name);
      CREATE INDEX IF NOT EXISTS idx_error_logs_status_code
        ON error_logs(status_code);
    `);
  }

  writeRequestLog(logEntry: any) {
    const write = this.db.transaction(() => {
      const timestamp = logEntry.timestamp || new Date().toISOString();
      const projection = logEntry.type === "request_end"
        ? this.requestProjectionValues({ ...logEntry, timestamp })
        : null;
      const result = this.db.prepare(`INSERT INTO request_logs (
        timestamp, type, model, data, projection_version, occurred_at, request_id, request_model, status,
        api_key_id, key_name, api_key_masked, legacy_key, input_tokens, output_tokens, cache_write_tokens,
        cache_read_tokens, token_accounting_version, duration, endpoint_key, endpoint_name,
        recorded_cost_input, recorded_cost_output, recorded_cost_cache_write, recorded_cost_cache_read,
        recorded_cost_total, recorded_cost_mask
      ) VALUES (
        @timestamp, @type, @model, @data, @projection_version, @occurred_at, @request_id, @request_model, @status,
        @api_key_id, @key_name, @api_key_masked, @legacy_key, @input_tokens, @output_tokens, @cache_write_tokens,
        @cache_read_tokens, @token_accounting_version, @duration, @endpoint_key, @endpoint_name,
        @recorded_cost_input, @recorded_cost_output, @recorded_cost_cache_write, @recorded_cost_cache_read,
        @recorded_cost_total, @recorded_cost_mask
      )`).run({
        timestamp, type: logEntry.type, model: logEntry.model ?? null, data: serializeJson(logEntry),
        ...(projection ?? { projection_version: 0, occurred_at: null, request_id: null, request_model: null, status: null, api_key_id: null, key_name: null, api_key_masked: null, legacy_key: 0, input_tokens: null, output_tokens: null, cache_write_tokens: null, cache_read_tokens: null, token_accounting_version: null, duration: null, endpoint_key: null, endpoint_name: null, recorded_cost_input: null, recorded_cost_output: null, recorded_cost_cache_write: null, recorded_cost_cache_read: null, recorded_cost_total: null, recorded_cost_mask: 0 }),
      });
      if (projection) this.updateDailyRollup(projection);
      return Number(result.lastInsertRowid);
    });
    return write();
  }

  writeErrorLog(logEntry: any) {
    const statusValue = logEntry.statusCode ?? logEntry.status_code;
    const numericStatus =
      statusValue === undefined || statusValue === null || statusValue === ""
        ? NaN
        : Number(statusValue);
    const stmt = this.db.prepare(`
      INSERT INTO error_logs (
        timestamp, request_id, model, upstream_model,
        endpoint_key, endpoint_name, api_format, status_code,
        error_type, error_code, error_message,
        request_headers, upstream_url, response_body, stack_trace,
        masked_api_key, auto_model, target_model, routing_attempts
      ) VALUES (
        @timestamp, @requestId, @model, @upstreamModel,
        @endpointKey, @endpointName, @apiFormat, @statusCode,
        @errorType, @errorCode, @errorMessage,
        @requestHeaders, @upstreamUrl, @responseBody, @stackTrace,
        @maskedApiKey, @autoModel, @targetModel, @routingAttempts
      )
    `);

    const serializedHeaders = serializeJson(
      logEntry.requestHeaders ?? logEntry.request_headers,
    );
    const serializedBody = serializeJson(
      logEntry.responseBody ?? logEntry.response_body,
    );
    const serializedAttempts = serializeRoutingAttempts(
      logEntry.routingAttempts ?? logEntry.routing_attempts,
    );
    const rawStackTrace = logEntry.stackTrace ?? logEntry.stack_trace ?? null;

    const result = stmt.run({
      timestamp: normalizeTimestamp(logEntry.timestamp),
      requestId: logEntry.requestId ?? logEntry.request_id ?? null,
      model: logEntry.model ?? null,
      upstreamModel:
        logEntry.upstreamModel ?? logEntry.upstream_model ?? null,
      endpointKey: logEntry.endpointKey ?? logEntry.endpoint_key ?? null,
      endpointName:
        logEntry.endpointName ?? logEntry.endpoint_name ?? null,
      apiFormat: logEntry.apiFormat ?? logEntry.api_format ?? null,
      statusCode: Number.isInteger(numericStatus) ? numericStatus : null,
      errorType: logEntry.errorType ?? logEntry.error_type ?? null,
      errorCode: logEntry.errorCode ?? logEntry.error_code ?? null,
      errorMessage: logEntry.errorMessage ?? logEntry.error_message ?? null,
      requestHeaders: truncateText(serializedHeaders, 8192),
      upstreamUrl: logEntry.upstreamUrl ?? logEntry.upstream_url ?? null,
      responseBody: truncateText(serializedBody, 8192),
      stackTrace: truncateText(rawStackTrace, 4096),
      maskedApiKey: logEntry.maskedApiKey ?? logEntry.masked_api_key ?? null,
      autoModel: logEntry.autoModel ?? logEntry.auto_model ?? null,
      targetModel: logEntry.targetModel ?? logEntry.target_model ?? null,
      routingAttempts: serializedAttempts,
    });

    return Number(result.lastInsertRowid);
  }

  readRequestLogs(limit = 100, offset = 0, model: string | null = null) {
    const query = model
      ? "SELECT data FROM request_logs WHERE type = ? AND model = ? ORDER BY id DESC LIMIT ? OFFSET ?"
      : "SELECT data FROM request_logs WHERE type = ? ORDER BY id DESC LIMIT ? OFFSET ?";

    const params = model
      ? ["request_end", model, limit, offset]
      : ["request_end", limit, offset];

    const rows = this.db.prepare(query).all(...params);
    return rows.map((row: { data: string }) => JSON.parse(row.data));
  }

  getRequestTotals() {
    const totals = this.aggregateRequests();
    return { total: totals.total, successful: totals.successful };
  }

  buildRequestWhere(filters: any = {}) {
    const clauses = ["type = 'request_end'", "projection_version >= 2"];
    const params: Record<string, unknown> = {};
    if (filters.cursor) { clauses.push("id < @cursor"); params.cursor = filters.cursor; }
    if (filters.model) { clauses.push("request_model = @model"); params.model = filters.model; }
    if (filters.apiKey) {
      clauses.push("(api_key_id = @apiKey OR (legacy_key = 1 AND api_key_masked = @legacyMask))");
      params.apiKey = filters.apiKey;
      params.legacyMask = filters.legacyMask ?? filters.apiKeyMask ?? "";
    }
    if (filters.status) { clauses.push("status = @status"); params.status = filters.status; }
    if (filters.endpoint) { clauses.push("endpoint_name = @endpoint"); params.endpoint = filters.endpoint; }
    if (filters.from !== undefined && filters.from !== null) { clauses.push("occurred_at >= @from"); params.from = filters.from; }
    if (filters.to !== undefined && filters.to !== null) { clauses.push("occurred_at <= @to"); params.to = filters.to; }
    return { clause: clauses.join(" AND "), params };
  }

  getRequestHistory(filters: any = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 50);
    const { clause, params } = this.buildRequestWhere(filters);
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, model, data, occurred_at, request_id, request_model, status,
          api_key_id, key_name, api_key_masked, input_tokens, output_tokens, cache_write_tokens,
          cache_read_tokens, token_accounting_version, duration, endpoint_key, endpoint_name,
          recorded_cost_input, recorded_cost_output, recorded_cost_cache_write, recorded_cost_cache_read, recorded_cost_total
         FROM request_logs
         WHERE ${clause}
         ORDER BY id DESC
         LIMIT @queryLimit`,
      )
      .all({ ...params, queryLimit: limit + 1 });
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const requests = visibleRows.map(normalizeRequestRow);

    return {
      requests,
      hasMore,
      nextCursor:
        hasMore && requests.length ? requests[requests.length - 1].id : null,
    };
  }

  getRequestHistoryById(id: unknown) {
    const row = this.db
      .prepare(
        `SELECT id, timestamp, model, data, occurred_at, request_id, request_model, status,
          api_key_id, key_name, api_key_masked, input_tokens, output_tokens, cache_write_tokens,
          cache_read_tokens, token_accounting_version, duration, endpoint_key, endpoint_name,
          recorded_cost_input, recorded_cost_output, recorded_cost_cache_write, recorded_cost_cache_read, recorded_cost_total
         FROM request_logs
         WHERE id = ? AND type = 'request_end'`,
      )
      .get(id);
    return normalizeRequestDetail(row);
  }

  getLatestErrorForRequestId(requestId: string | null | undefined) {
    if (!requestId) return null;
    const row = this.db
      .prepare(
        `SELECT id, timestamp, status_code, error_type, error_code, error_message
         FROM error_logs
         WHERE request_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(requestId);
    if (!row) return null;
    return {
      id: row.id,
      timestamp: row.timestamp,
      statusCode: row.status_code ?? null,
      errorType: row.error_type ?? null,
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
    };
  }

  getDashboardRequestLogs() {
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, model, data, occurred_at, request_id, request_model, status,
          api_key_id, key_name, api_key_masked, input_tokens, output_tokens, cache_write_tokens,
          cache_read_tokens, token_accounting_version, duration, endpoint_key, endpoint_name,
          recorded_cost_input, recorded_cost_output, recorded_cost_cache_write, recorded_cost_cache_read, recorded_cost_total
         FROM request_logs
         WHERE type = 'request_end'
         ORDER BY id DESC`,
      )
      .all();
    return rows.map(normalizeRequestRow);
  }

  getRequestHistoryFilters() {
    const models = this.db.prepare(`SELECT DISTINCT request_model AS value FROM request_logs
      WHERE type = 'request_end' AND projection_version >= 2 AND request_model IS NOT NULL AND request_model != '' ORDER BY value`).all().map((row: { value: unknown }) => row.value);
    const apiKeys = this.db.prepare(`SELECT api_key_id, api_key_masked, key_name FROM request_logs
      WHERE type = 'request_end' AND projection_version >= 2 AND api_key_id IS NOT NULL
      GROUP BY api_key_id, api_key_masked, key_name ORDER BY key_name, api_key_masked`).all().map((row: any) => ({
        value: row.api_key_id,
        label: row.key_name ? `${row.key_name} · ${row.api_key_masked}` : row.api_key_masked,
      }));
    return { models, apiKeys, statuses: ["success", "failed"] };
  }

  renameModel(oldName: string, newName: string) {
    const rename = this.db.transaction(() => {
      const requestData = this.db
        .prepare(`
          UPDATE request_logs
          SET data = json_set(
            data,
            '$.model', CASE WHEN json_extract(data, '$.model') = @oldName
              THEN @newName ELSE json_extract(data, '$.model') END,
            '$.requested_model', CASE WHEN json_extract(data, '$.requested_model') = @oldName
              THEN @newName ELSE json_extract(data, '$.requested_model') END,
            '$.auto_model', CASE WHEN json_extract(data, '$.auto_model') = @oldName
              THEN @newName ELSE json_extract(data, '$.auto_model') END,
            '$.target_model', CASE WHEN json_extract(data, '$.target_model') = @oldName
              THEN @newName ELSE json_extract(data, '$.target_model') END
          )
          WHERE model = @oldName
             OR json_extract(data, '$.model') = @oldName
             OR json_extract(data, '$.requested_model') = @oldName
             OR json_extract(data, '$.auto_model') = @oldName
             OR json_extract(data, '$.target_model') = @oldName
        `)
        .run({ oldName, newName });
      const requestLogs = this.db
        .prepare("UPDATE request_logs SET model = ?, request_model = CASE WHEN request_model = ? THEN ? ELSE request_model END WHERE model = ? OR request_model = ?")
        .run(newName, oldName, newName, oldName, oldName);
      // Rebuild avoids primary-key collisions when both model names already have a day/key rollup.
      this.rebuildRequestRollups();
      const rollups = { changes: 1 };
      const errorLogs = this.db
        .prepare(`
          UPDATE error_logs
          SET model = CASE WHEN model = @oldName THEN @newName ELSE model END,
              auto_model = CASE WHEN auto_model = @oldName THEN @newName ELSE auto_model END,
              target_model = CASE WHEN target_model = @oldName THEN @newName ELSE target_model END
          WHERE model = @oldName
             OR auto_model = @oldName
             OR target_model = @oldName
        `)
        .run({ oldName, newName });

      return {
        requestLogs: requestLogs.changes,
        requestData: requestData.changes,
        rollups: rollups.changes,
        errorLogs: errorLogs.changes,
      };
    });

    return rename();
  }

  buildErrorWhere(filters: any = {}) {
    const clauses = [];
    const params: Record<string, unknown> = {};

    if (filters.model) {
      clauses.push("model = @model");
      params.model = filters.model;
    }
    if (filters.endpoint) {
      clauses.push("endpoint_name = @endpoint");
      params.endpoint = filters.endpoint;
    }
    // Filter by upstream key: matched against the stored masked form
    // (maskKey(token)), never a raw secret.
    if (filters.key) {
      clauses.push("masked_api_key = @key");
      params.key = filters.key;
    }
    if (
      filters.statusCode !== undefined &&
      filters.statusCode !== null &&
      filters.statusCode !== ""
    ) {
      const statusCode = Number(filters.statusCode);
      if (Number.isInteger(statusCode)) {
        clauses.push("status_code = @statusCode");
        params.statusCode = statusCode;
      }
    }

    return {
      clause: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  getErrorLogs(filters: any = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    const { clause, params } = this.buildErrorWhere(filters);
    const rows = this.db
      .prepare(
        `SELECT
          id, timestamp, request_id, model, upstream_model,
          endpoint_key, endpoint_name, api_format, status_code,
          error_type, error_code, error_message,
          auto_model, target_model, routing_attempts
        FROM error_logs${clause}
        ORDER BY timestamp DESC, id DESC
        LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset });

    return rows.map(mapErrorRow);
  }

  getErrorLogCount(filters: any = {}) {
    const { clause, params } = this.buildErrorWhere(filters);
    return this.db
      .prepare(`SELECT COUNT(*) AS count FROM error_logs${clause}`)
      .get(params).count;
  }

  getErrorLogFilters() {
    const readValues = (column: string) =>
      this.db
        .prepare(
          `SELECT DISTINCT ${column} AS value
           FROM error_logs
           WHERE ${column} IS NOT NULL AND ${column} != ''
           ORDER BY ${column}`,
        )
        .all()
        .map((row: { value: unknown }) => row.value);

    return {
      models: readValues("model"),
      endpoints: readValues("endpoint_name"),
      statuses: readValues("status_code"),
      keys: readValues("masked_api_key"),
    };
  }

  getErrorLogById(id: unknown) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 1) return null;

    const row = this.db
      .prepare("SELECT * FROM error_logs WHERE id = ?")
      .get(numericId);
    return mapErrorRow(row);
  }

  clearErrorLogs() {
    return this.db.prepare("DELETE FROM error_logs").run().changes;
  }

  readErrorLogs(limit = 50) {
    return this.getErrorLogs({ limit });
  }

  close() {
    if (this.db?.open) this.db.close();
  }
}

const logManager = new LogManager();
export default logManager;
