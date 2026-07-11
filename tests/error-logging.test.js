import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const testRoot = mkdtempSync(path.join(tmpdir(), "nore-proxy-error-logs-"));
process.env.NORE_PROXY_LOG_DB_PATH = path.join(testRoot, "singleton.db");

const { LogManager } = await import("../services/logManager.js");
const { sanitizeHeadersForLogging } = await import(
  "../utils/errorLogging.js"
);

const managers = [];

function createManager(filename = `${crypto.randomUUID()}.db`) {
  assert.equal(
    typeof LogManager,
    "function",
    "services/logManager.js must export LogManager for isolated database tests",
  );

  const manager = new LogManager(path.join(testRoot, filename));
  managers.push(manager);
  return manager;
}

function sampleError(overrides = {}) {
  return {
    timestamp: "2026-07-11T12:00:00.000Z",
    requestId: "req-123",
    model: "friendly-model",
    upstreamModel: "provider-model-v2",
    endpointKey: "v2",
    endpointName: "Primary Anthropic",
    apiFormat: "anthropic",
    statusCode: 502,
    errorType: "AxiosError",
    errorCode: "ERR_BAD_RESPONSE",
    errorMessage: "Upstream request failed",
    requestParams: {
      model: "provider-model-v2",
      messages: [{ role: "user", content: "test request" }],
      stream: false,
    },
    requestHeaders: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    upstreamUrl: "https://provider.example/v1/messages",
    responseBody: {
      error: { type: "overloaded_error", message: "Please retry" },
    },
    stackTrace: "AxiosError: Upstream request failed\n    at test.js:1:1",
    ...overrides,
  };
}

function closeManager(manager) {
  if (manager?.close) manager.close();
}

after(() => {
  for (const manager of managers) closeManager(manager);
  rmSync(testRoot, { recursive: true, force: true });
});

test("fresh databases use the structured error schema and indexes", () => {
  const manager = createManager("fresh.db");
  const columns = manager.db
    .prepare("PRAGMA table_info(error_logs)")
    .all()
    .map((column) => column.name);

  assert.deepEqual(columns, [
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
  ]);

  const indexes = manager.db
    .prepare("PRAGMA index_list(error_logs)")
    .all()
    .map((index) => index.name);

  assert.ok(indexes.includes("idx_error_logs_timestamp"));
  assert.ok(indexes.includes("idx_error_logs_model"));
  assert.ok(indexes.includes("idx_error_logs_endpoint_name"));
  assert.ok(indexes.includes("idx_error_logs_status_code"));
});

test("legacy JSON error rows are migrated without data loss", () => {
  const dbPath = path.join(testRoot, "legacy.db");
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      data TEXT
    )
  `);
  legacyDb
    .prepare("INSERT INTO error_logs (timestamp, data) VALUES (?, ?)")
    .run(
      "2026-07-10T10:30:00.000Z",
      JSON.stringify({
        request_id: "legacy-request",
        error_type: "LegacyError",
        error_message: "Preserve me",
      }),
    );
  legacyDb.close();

  const manager = createManager("legacy.db");
  const migrated = manager.getErrorLogById(1);

  assert.equal(migrated.timestamp, "2026-07-10T10:30:00.000Z");
  assert.equal(migrated.requestId, "legacy-request");
  assert.equal(migrated.errorType, "LegacyError");
  assert.equal(migrated.errorMessage, "Preserve me");
  assert.equal(migrated.model, null);
  assert.equal(migrated.requestParams, null);
});

test("structured errors round-trip JSON fields and support detail lookup", () => {
  const manager = createManager("round-trip.db");
  const id = manager.writeErrorLog(sampleError());
  const error = manager.getErrorLogById(id);

  assert.equal(error.id, id);
  assert.equal(error.requestId, "req-123");
  assert.equal(error.model, "friendly-model");
  assert.equal(error.upstreamModel, "provider-model-v2");
  assert.equal(error.endpointKey, "v2");
  assert.equal(error.endpointName, "Primary Anthropic");
  assert.equal(error.apiFormat, "anthropic");
  assert.equal(error.statusCode, 502);
  assert.equal(error.errorCode, "ERR_BAD_RESPONSE");
  assert.deepEqual(error.requestParams, sampleError().requestParams);
  assert.deepEqual(error.requestHeaders, sampleError().requestHeaders);
  assert.deepEqual(error.responseBody, sampleError().responseBody);
  assert.equal(error.stackTrace, sampleError().stackTrace);
});

test("error listing supports newest-first pagination, filters, counts, and filter values", () => {
  const manager = createManager("queries.db");
  manager.writeErrorLog(
    sampleError({
      timestamp: "2026-07-11T10:00:00.000Z",
      requestId: "req-a",
      model: "model-a",
      endpointName: "Endpoint A",
      statusCode: 429,
    }),
  );
  manager.writeErrorLog(
    sampleError({
      timestamp: "2026-07-11T11:00:00.000Z",
      requestId: "req-b",
      model: "model-b",
      endpointName: "Endpoint B",
      statusCode: 500,
    }),
  );
  manager.writeErrorLog(
    sampleError({
      timestamp: "2026-07-11T12:00:00.000Z",
      requestId: "req-c",
      model: "model-a",
      endpointName: "Endpoint A",
      statusCode: 500,
    }),
  );

  assert.deepEqual(
    manager.getErrorLogs({ limit: 2, offset: 0 }).map((entry) => entry.requestId),
    ["req-c", "req-b"],
  );
  assert.deepEqual(
    manager.getErrorLogs({ limit: 2, offset: 2 }).map((entry) => entry.requestId),
    ["req-a"],
  );
  assert.deepEqual(
    manager
      .getErrorLogs({ model: "model-a", endpoint: "Endpoint A", statusCode: 500 })
      .map((entry) => entry.requestId),
    ["req-c"],
  );
  assert.equal(manager.getErrorLogCount({ model: "model-a" }), 2);
  assert.equal(manager.getErrorLogCount({ statusCode: 500 }), 2);
  assert.deepEqual(manager.getErrorLogFilters(), {
    models: ["model-a", "model-b"],
    endpoints: ["Endpoint A", "Endpoint B"],
    statuses: [429, 500],
  });

  assert.equal(manager.clearErrorLogs(), 3);
  assert.equal(manager.getErrorLogCount(), 0);
});

test("header sanitization is case-insensitive, immutable, and preserves diagnostic headers", () => {
  assert.equal(
    typeof sanitizeHeadersForLogging,
    "function",
    "utils/errorLogging.js must export sanitizeHeadersForLogging",
  );

  const headers = {
    Authorization: "Bearer top-secret",
    "X-API-Key": "secret-key",
    "api-key": "secret-key-2",
    "Proxy-Authorization": "Basic hidden",
    Cookie: "session=hidden",
    "Set-Cookie": "session=hidden; Secure",
    "X-Provider-Token": "hidden-token",
    "X-Custom-Secret": "hidden-custom-secret",
    "Content-Type": "application/json",
    "Anthropic-Version": "2023-06-01",
    "X-Request-ID": "upstream-request-123",
  };

  const sanitized = sanitizeHeadersForLogging(headers);

  assert.deepEqual(sanitized, {
    "Content-Type": "application/json",
    "Anthropic-Version": "2023-06-01",
    "X-Request-ID": "upstream-request-123",
  });
  assert.equal(headers.Authorization, "Bearer top-secret");
});
