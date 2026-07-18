import path from "path";
import Database from "better-sqlite3";
import Config from "../config/index.js";
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
    masked_api_key TEXT
  )
`;

const CREATE_MIGRATION_TABLE = CREATE_ERROR_LOG_TABLE.replace(
  /CREATE TABLE error_logs/,
  "CREATE TABLE error_logs_migration",
);

function serializeJson(value) {
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

function parseJson(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeJsonForStorage(value) {
  return serializeJson(parseJson(value));
}

function normalizeTimestamp(value) {
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

function truncateText(text, maxLen) {
  if (text == null) return null;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…[truncated]";
}

function maskStoredApiKey(value) {
  if (!value || typeof value !== "string") return "Unknown";
  if (/^.{5}\.\.\..{3}$/s.test(value) || value === "****") return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 5)}...${value.slice(-3)}`;
}

function toEpochSeconds(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric >= 10_000_000_000 ? numeric / 1000 : numeric;
  }
  const milliseconds = Date.parse(String(value));
  return Number.isNaN(milliseconds) ? null : milliseconds / 1000;
}

function nonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizeRequestRow(row) {
  const parsed = parseJson(row.data);
  const data = parsed && typeof parsed === "object" ? parsed : {};
  const rawStatus = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const status = rawStatus === "success" || rawStatus === "failed" ? rawStatus : "unknown";
  const apiKeyId = typeof data.api_key_id === "string" && data.api_key_id ? data.api_key_id : null;

  return {
    id: row.id,
    timestamp: toEpochSeconds(data.timestamp ?? row.timestamp),
    requestId: data.request_id ?? null,
    name: data.key_name ?? "Unknown",
    apiKey: maskStoredApiKey(data.api_key),
    apiKeyId,
    legacyKey: !apiKeyId,
    model:
      (typeof data.model === "string" && data.model.trim()) ||
      (typeof row.model === "string" && row.model.trim()) ||
      "Unknown",
    status,
    inputTokens: nonNegativeNumber(data.input_tokens),
    outputTokens: nonNegativeNumber(data.output_tokens),
    cacheWriteTokens: nonNegativeNumber(data.cache_write_tokens),
    cacheReadTokens: nonNegativeNumber(data.cache_read_tokens),
    tokenAccountingVersion: data.token_accounting_version ?? null,
    duration: nonNegativeNumber(data.duration),
  };
}

function mapErrorRow(row) {
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
  };
}

function firstPresent(row, legacyData, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
    if (legacyData[key] !== undefined && legacyData[key] !== null) {
      return legacyData[key];
    }
  }
  return null;
}

export class LogManager {
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

    this.ensureErrorLogSchema();
    this.createErrorLogIndexes();
  }

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
      .map((column) => column.name);
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
          masked_api_key
        ) VALUES (
          @id, @timestamp, @requestId, @model, @upstreamModel,
          @endpointKey, @endpointName, @apiFormat, @statusCode,
          @errorType, @errorCode, @errorMessage, @requestParams,
          @requestHeaders, @upstreamUrl, @responseBody, @stackTrace,
          @maskedApiKey
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
        const numericStatus = Number(statusValue);

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
          maskedApiKey: null,
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

  writeRequestLog(logEntry) {
    const stmt = this.db.prepare(
      "INSERT INTO request_logs (timestamp, type, model, data) VALUES (?, ?, ?, ?)",
    );
    stmt.run(
      logEntry.timestamp || new Date().toISOString(),
      logEntry.type,
      logEntry.model,
      JSON.stringify(logEntry),
    );
  }

  writeErrorLog(logEntry) {
    const statusValue = logEntry.statusCode ?? logEntry.status_code;
    const numericStatus = Number(statusValue);
    const stmt = this.db.prepare(`
      INSERT INTO error_logs (
        timestamp, request_id, model, upstream_model,
        endpoint_key, endpoint_name, api_format, status_code,
        error_type, error_code, error_message,
        request_headers, upstream_url, response_body, stack_trace,
        masked_api_key
      ) VALUES (
        @timestamp, @requestId, @model, @upstreamModel,
        @endpointKey, @endpointName, @apiFormat, @statusCode,
        @errorType, @errorCode, @errorMessage,
        @requestHeaders, @upstreamUrl, @responseBody, @stackTrace,
        @maskedApiKey
      )
    `);

    const serializedHeaders = serializeJson(
      logEntry.requestHeaders ?? logEntry.request_headers,
    );
    const serializedBody = serializeJson(
      logEntry.responseBody ?? logEntry.response_body,
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
    });

    return Number(result.lastInsertRowid);
  }

  readRequestLogs(limit = 100, offset = 0, model = null) {
    const query = model
      ? "SELECT data FROM request_logs WHERE type = ? AND model = ? ORDER BY id DESC LIMIT ? OFFSET ?"
      : "SELECT data FROM request_logs WHERE type = ? ORDER BY id DESC LIMIT ? OFFSET ?";

    const params = model
      ? ["request_end", model, limit, offset]
      : ["request_end", limit, offset];

    const rows = this.db.prepare(query).all(...params);
    return rows.map((row) => JSON.parse(row.data));
  }

  getRequestTotals() {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN LOWER(json_extract(data, '$.status')) = 'success' THEN 1 ELSE 0 END) AS successful
        FROM request_logs
        WHERE type = 'request_end'`,
      )
      .get();

    return {
      total: Number(row.total) || 0,
      successful: Number(row.successful) || 0,
    };
  }

  buildRequestWhere(filters = {}) {
    const clauses = ["type = 'request_end'"];
    const params = {};

    if (filters.cursor) {
      clauses.push("id < @cursor");
      params.cursor = filters.cursor;
    }
    if (filters.model) {
      clauses.push("COALESCE(NULLIF(json_extract(data, '$.model'), ''), model) = @model");
      params.model = filters.model;
    }
    if (filters.apiKey) {
      clauses.push("json_extract(data, '$.api_key_id') = @apiKey");
      params.apiKey = filters.apiKey;
    }
    if (filters.status) {
      clauses.push("LOWER(json_extract(data, '$.status')) = @status");
      params.status = filters.status;
    }
    const timestampSql = `CASE
      WHEN json_type(data, '$.timestamp') IN ('integer', 'real')
        THEN CASE
          WHEN CAST(json_extract(data, '$.timestamp') AS REAL) >= 10000000000
            THEN CAST(json_extract(data, '$.timestamp') AS REAL) / 1000
          ELSE CAST(json_extract(data, '$.timestamp') AS REAL)
        END
      ELSE (julianday(COALESCE(json_extract(data, '$.timestamp'), timestamp)) - 2440587.5) * 86400
    END`;
    if (filters.from !== undefined && filters.from !== null) {
      clauses.push(`${timestampSql} >= @from`);
      params.from = filters.from;
    }
    if (filters.to !== undefined && filters.to !== null) {
      clauses.push(`${timestampSql} <= @to`);
      params.to = filters.to;
    }

    return { clause: clauses.join(" AND "), params };
  }

  getRequestHistory(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 50);
    const { clause, params } = this.buildRequestWhere(filters);
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, model, data
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

  getDashboardRequestLogs() {
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, model, data
         FROM request_logs
         WHERE type = 'request_end'
         ORDER BY id DESC`,
      )
      .all();
    return rows.map(normalizeRequestRow);
  }

  getRequestHistoryFilters() {
    const rows = this.db
      .prepare(
        `SELECT model, data
         FROM request_logs
         WHERE type = 'request_end'
         ORDER BY id DESC`,
      )
      .all();
    const models = new Set();
    const keys = new Map();

    for (const row of rows) {
      const request = normalizeRequestRow(row);
      if (request.model !== "Unknown") models.add(request.model);
      if (request.apiKeyId && !keys.has(request.apiKeyId)) {
        keys.set(request.apiKeyId, {
          value: request.apiKeyId,
          label:
            request.name !== "Unknown"
              ? `${request.name} · ${request.apiKey}`
              : request.apiKey,
        });
      }
    }

    return {
      models: [...models].sort(),
      apiKeys: [...keys.values()].sort((a, b) => a.label.localeCompare(b.label)),
      statuses: ["success", "failed"],
    };
  }

  renameModel(oldName, newName) {
    const rename = this.db.transaction(() => {
      const requestData = this.db
        .prepare(
          "UPDATE request_logs SET data = json_set(data, '$.model', ?) WHERE model = ?",
        )
        .run(newName, oldName);
      const requestLogs = this.db
        .prepare("UPDATE request_logs SET model = ? WHERE model = ?")
        .run(newName, oldName);
      const errorLogs = this.db
        .prepare("UPDATE error_logs SET model = ? WHERE model = ?")
        .run(newName, oldName);

      return {
        requestLogs: requestLogs.changes,
        requestData: requestData.changes,
        errorLogs: errorLogs.changes,
      };
    });

    return rename();
  }

  buildErrorWhere(filters = {}) {
    const clauses = [];
    const params = {};

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

  getErrorLogs(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    const { clause, params } = this.buildErrorWhere(filters);
    const rows = this.db
      .prepare(
        `SELECT
          id, timestamp, request_id, model, upstream_model,
          endpoint_key, endpoint_name, api_format, status_code,
          error_type, error_code, error_message
        FROM error_logs${clause}
        ORDER BY timestamp DESC, id DESC
        LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset });

    return rows.map(mapErrorRow);
  }

  getErrorLogCount(filters = {}) {
    const { clause, params } = this.buildErrorWhere(filters);
    return this.db
      .prepare(`SELECT COUNT(*) AS count FROM error_logs${clause}`)
      .get(params).count;
  }

  getErrorLogFilters() {
    const readValues = (column) =>
      this.db
        .prepare(
          `SELECT DISTINCT ${column} AS value
           FROM error_logs
           WHERE ${column} IS NOT NULL AND ${column} != ''
           ORDER BY ${column}`,
        )
        .all()
        .map((row) => row.value);

    return {
      models: readValues("model"),
      endpoints: readValues("endpoint_name"),
      statuses: readValues("status_code"),
      keys: readValues("masked_api_key"),
    };
  }

  getErrorLogById(id) {
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
