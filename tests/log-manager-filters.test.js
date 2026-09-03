import "./isolated-config.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MASTER_KEY ??= "test-only-master-key-value";
// Isolated on-disk persistence in a temp directory. Each test uses its own
// file so writes never bleed between cases. Never point these at deployed
// databases or mounted production data.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-log-filter-test-"));
delete process.env.DATABASE_URL;

test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

const { LogManager } = await import("../services/logManager.js");

let dbCounter = 0;
async function createManager() {
  const manager = new LogManager(path.join(scratchDir, `logs-${dbCounter++}.db`));
  await manager.initialize();
  return manager;
}

// The better-sqlite3 native binding does not build on every Node release, so
// skip rather than report a storage failure as a filter-behavior failure.
const sqliteAvailable = await (async () => {
  try {
    const probe = await createManager();
    await probe.close();
    return true;
  } catch (error) {
    console.warn(
      `Skipping request log filter tests: SQLite unavailable (${String(error).split("\n")[0]})`,
    );
    return false;
  }
})();

function requestEnd(endpointName, overrides = {}) {
  return {
    type: "request_end",
    timestamp: Date.now() / 1000,
    request_id: `req-${(dbCounter++).toString(16)}-${Math.random().toString(16).slice(2)}`,
    model: "model-test",
    status: "success",
    duration: 1,
    input_tokens: 1,
    output_tokens: 1,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    ...(endpointName === undefined ? {} : { endpoint_name: endpointName }),
    ...overrides,
  };
}

test(
  "getRequestHistoryFilters returns sorted, distinct, non-empty endpoint names",
  { skip: !sqliteAvailable },
  async (t) => {
    const manager = await createManager();
    t.after(() => manager.close());

    // Unsorted and duplicated endpoint names across request_end rows.
    manager.writeRequestLog(requestEnd("Zephyr"));
    manager.writeRequestLog(requestEnd("Aurora"));
    manager.writeRequestLog(requestEnd("Aurora"));
    manager.writeRequestLog(requestEnd("Mistral"));
    // Blank and absent endpoint names must be excluded from the filter list.
    manager.writeRequestLog(requestEnd(""));
    manager.writeRequestLog(requestEnd(null));
    manager.writeRequestLog(requestEnd(undefined));
    // A non-request_end row must never contribute a filter value.
    manager.writeRequestLog({ type: "request_start", endpoint_name: "ShouldNotAppear" });

    const filters = manager.getRequestHistoryFilters();
    assert.deepEqual(filters.endpoints, ["Aurora", "Mistral", "Zephyr"]);
    // The pre-existing filter facets remain intact alongside the new endpoint list.
    assert.deepEqual(filters.statuses, ["success", "failed"]);
    assert.ok(Array.isArray(filters.models));
    assert.ok(Array.isArray(filters.apiKeys));
  },
);

test(
  "getRequestHistory filters persisted rows by endpoint name",
  { skip: !sqliteAvailable },
  async (t) => {
    const manager = await createManager();
    t.after(() => manager.close());

    manager.writeRequestLog(requestEnd("Aurora", { model: "model-a" }));
    manager.writeRequestLog(requestEnd("Mistral", { model: "model-b" }));
    manager.writeRequestLog(requestEnd("Aurora", { model: "model-c" }));

    const matching = manager.getRequestHistory({ endpoint: "Aurora" });
    assert.equal(matching.requests.length, 2);
    assert.ok(matching.requests.every((r) => r.endpointName === "Aurora"));

    const none = manager.getRequestHistory({ endpoint: "Missing" });
    assert.equal(none.requests.length, 0);
  },
);
