import "./isolated-config.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MASTER_KEY ??= "test-only-master-key-value";
delete process.env.DATABASE_URL;
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-log-stats-test-"));
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

const { LogManager } = await import("../services/logManager.js");
let counter = 0;
async function createManager() {
  const manager = new LogManager(path.join(scratchDir, `stats-${counter++}.db`));
  await manager.initialize();
  return manager;
}

const sqliteAvailable = await (async () => {
  try { const manager = await createManager(); manager.close(); return true; }
  catch (error) { console.warn(`Skipping admin stats tests: SQLite unavailable (${String(error).split("\n")[0]})`); return false; }
})();

function requestEnd(endpointName, model, overrides = {}) {
  return {
    type: "request_end", timestamp: Date.now() / 1000, request_id: `stats-${counter++}`,
    endpoint_name: endpointName, model, status: "success", duration: 1,
    input_tokens: 10, output_tokens: 5, cache_write_tokens: 2, cache_read_tokens: 3,
    ...overrides,
  };
}

test("admin stats group endpoints and models and invalidate on request-end writes", { skip: !sqliteAvailable }, async (t) => {
  const manager = await createManager(); t.after(() => manager.close());
  manager.writeRequestLog(requestEnd("Primary", "model-a", { billing: { costs: { total: 1.25 } } }));
  manager.writeRequestLog(requestEnd("Primary", "model-b", { input_tokens: 4, output_tokens: 6, cache_write_tokens: 0, cache_read_tokens: 0 }));
  manager.writeRequestLog(requestEnd("Backup", "model-a", { status: "failed", input_tokens: 99, output_tokens: 99 }));

  const first = await manager.getAdminStats();
  const cached = await manager.getAdminStats();
  assert.strictEqual(cached, first);
  assert.deepEqual(first.models.map((row) => row.name), ["model-a", "model-b"]);
  assert.equal(first.models[0].requests, 2);
  assert.equal(first.models[0].success_count, 1);
  assert.equal(first.models[0].errors, 1);
  assert.equal(first.models[0].total_tokens, 20);
  assert.equal(first.models[0].cost, 1.25);
  assert.deepEqual(first.endpoints.map((row) => row.name), ["Primary", "Backup"]);
  assert.deepEqual(first.endpoints[0].models.map((row) => row.name), ["model-a", "model-b"]);

  manager.writeRequestLog({ type: "request_start", model: "ignored" });
  assert.strictEqual(await manager.getAdminStats(), first);
  manager.writeRequestLog(requestEnd("Backup", "model-c", { input_tokens: 30, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 }));
  const refreshed = await manager.getAdminStats();
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.models.find((row) => row.name === "model-c").total_tokens, 30);
});

test("admin stats normalize missing names and refresh after historical mutations", { skip: !sqliteAvailable }, async (t) => {
  const manager = await createManager(); t.after(() => manager.close());
  manager.writeRequestLog(requestEnd(undefined, undefined));
  manager.writeRequestLog(requestEnd("Primary", "source"));
  const initial = await manager.getAdminStats();
  assert.ok(initial.models.some((row) => row.name === "Unknown"));
  assert.ok(initial.endpoints.some((row) => row.name === "Unknown"));

  manager.manageModelUsage("rename", "source", "renamed");
  const renamed = await manager.getAdminStats();
  assert.ok(renamed.models.some((row) => row.name === "renamed"));
  assert.ok(!renamed.models.some((row) => row.name === "source"));

  manager.manageModelUsage("delete", "renamed");
  const deleted = await manager.getAdminStats();
  assert.ok(!deleted.models.some((row) => row.name === "renamed"));
});

test("retention prunes details but preserves historical daily rollups", { skip: !sqliteAvailable }, async (t) => {
  const manager = await createManager(); t.after(() => manager.close());
  const oldTimestamp = Date.now() / 1000 - 10 * 86400;
  const recentTimestamp = Date.now() / 1000 - 3600;
  manager.writeRequestLog(requestEnd("Primary", "old-model", { timestamp: oldTimestamp }));
  manager.writeRequestLog(requestEnd("Primary", "recent-model", { timestamp: recentTimestamp }));

  const before = manager.db.prepare("SELECT COALESCE(SUM(requests), 0) AS count FROM request_daily_rollups").get().count;
  const result = manager.pruneOldRequests(Date.now() / 1000 - 5 * 86400);
  assert.equal(result.requests, 1);
  assert.equal(manager.db.prepare("SELECT COUNT(*) AS count FROM request_logs WHERE type = 'request_end'").get().count, 1);
  assert.equal(manager.db.prepare("SELECT COALESCE(SUM(requests), 0) AS count FROM request_daily_rollups").get().count, before);

  manager.ensureRequestLogSchema();
  assert.equal(manager.db.prepare("SELECT COALESCE(SUM(requests), 0) AS count FROM request_daily_rollups").get().count, before);
});

test("admin stats aggregation index exists", { skip: !sqliteAvailable }, async (t) => {
  const manager = await createManager(); t.after(() => manager.close());
  const indexes = manager.db.prepare("PRAGMA index_list(request_logs)").all().map((row) => row.name);
  assert.ok(indexes.includes("idx_request_end_endpoint_model"));
});
