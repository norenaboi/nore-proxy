import "./isolated-config.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Match the isolation conventions used by the other suites: a throwaway master
// key, SQLite forced (no live PostgreSQL), and a small deterministic hot-bucket
// cap plus a fixed base granularity so the service's behaviour is predictable.
// These env vars are read once, at module load, by services/uptime/service.ts.
process.env.MASTER_KEY ??= "test-only-master-key-value";
delete process.env.DATABASE_URL;
process.env.UPTIME_MAX_HOT_BUCKETS = "100"; // clampInt floor is 100; sets an exact, testable cap
process.env.UPTIME_BUCKET_SECONDS = "300";  // pin the base bucket to 5 minutes

const { bucketStart } = await import("../services/uptime/types.js");
const { foldSummaries, UptimeService } = await import("../services/uptime/service.js");
const { publicResponse } = await import("../routes/uptime.js");
const { UptimeStore } = await import("../services/uptime/store.js");
const { uptimeStatus, UPTIME_STATUS_THRESHOLDS } = await import("../shared/contracts/uptime.js");

const BASE_BUCKET = 300;
let counter = 0;

function emptyCounters() {
  return {
    requestCount: 0, successCount: 0, totalLatencyMs: 0,
    ttftSumMs: 0, ttftCount: 0, outputTokens: 0, generationMs: 0,
  };
}
function row(model, bucketTs, counters = {}, endpoint = "") {
  return { model, endpoint, bucketTs, counters: { ...emptyCounters(), ...counters } };
}
function cloneRow(r) {
  return { model: r.model, endpoint: r.endpoint, bucketTs: r.bucketTs, counters: { ...r.counters } };
}
function addInto(target, source) {
  for (const key of Object.keys(target)) target[key] += Number(source[key]) || 0;
}
function round2(value) {
  return Math.round(value * 100) / 100;
}

// A duck-typed stand-in for UptimeStore. It mirrors the real store's
// increment-on-conflict semantics but keeps everything in memory, so the
// service's isolation logic can be exercised without any filesystem access.
function fakeStore() {
  const map = new Map();
  const store = {
    ready: true,
    failPersistTimes: 0,
    async initialize() {},
    async persist(batch) {
      if (store.failPersistTimes > 0) {
        store.failPersistTimes -= 1;
        throw new Error("persist failed");
      }
      for (const r of batch) {
        const key = `${r.model}\u0000${r.endpoint}\u0000${r.bucketTs}`;
        const existing = map.get(key);
        if (existing) addInto(existing.counters, r.counters);
        else map.set(key, cloneRow(r));
      }
    },
    async read(startTs, endTs) {
      return [...map.values()]
        .filter((r) => r.bucketTs >= startTs && r.bucketTs <= endTs)
        .sort((a, b) => a.bucketTs - b.bucketTs)
        .map(cloneRow);
    },
    async deleteBefore() {
      return 0;
    },
    async close() {},
    size() {
      return map.size;
    },
  };
  return store;
}

test("bucketStart floors timestamps to the start of their bucket", () => {
  assert.equal(bucketStart(3600, 3600), 3600);
  assert.equal(bucketStart(3661, 3600), 3600);
  assert.equal(bucketStart(7199, 3600), 3600);
  assert.equal(bucketStart(7200, 3600), 7200);
  assert.equal(bucketStart(305, 300), 300);
  assert.equal(bucketStart(123.9, 300), 0); // sub-second floored, then to bucket
  // A non-positive bucket size falls back to one hour rather than dividing by zero.
  assert.equal(bucketStart(3661, 0), 3600);
});

test("foldSummaries derives success, latency, ttft, tps, and series", () => {
  const rows = [
    row("m", 0, { requestCount: 10, successCount: 9, totalLatencyMs: 2000, ttftSumMs: 500, ttftCount: 10, outputTokens: 100, generationMs: 2000 }),
    row("m", BASE_BUCKET, { requestCount: 10, successCount: 8, totalLatencyMs: 3000, ttftSumMs: 700, ttftCount: 10, outputTokens: 300, generationMs: 3000 }),
  ];
  const summaries = foldSummaries(rows, BASE_BUCKET);
  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.equal(summary.model_name, "m");
  assert.equal(summary.request_count, 20);
  assert.equal(summary.success_count, 17);
  assert.equal(summary.failure_count, 3);
  assert.equal(summary.success_rate, 85); // 17 / 20 * 100
  assert.equal(summary.avg_latency_ms, 250); // 5000 / 20
  assert.equal(summary.avg_ttft_ms, 60); // 1200 / 20
  assert.equal(summary.avg_tps, round2(400 / (5000 / 1000))); // 400 tokens over 5s = 80
  assert.deepEqual(summary.series.map((b) => b.ts), [0, BASE_BUCKET]);
  assert.equal(summary.series[0].success_rate, 90); // 9 / 10
  assert.equal(summary.series[1].success_rate, 80); // 8 / 10
  assert.deepEqual(summary.recent_success_rates, [90, 80]);
});

test("foldSummaries re-buckets up to a coarser interval and orders by volume", () => {
  const rows = [
    row("low", 0, { requestCount: 2, successCount: 2 }),
    row("high", 0, { requestCount: 5, successCount: 5 }),
    row("high", BASE_BUCKET, { requestCount: 5, successCount: 4 }),
  ];
  // Fold the two 5-minute "high" buckets into a single hour bucket.
  const summaries = foldSummaries(rows, 3600);
  assert.deepEqual(summaries.map((s) => s.model_name), ["high", "low"]);
  const high = summaries[0];
  assert.equal(high.request_count, 10);
  assert.equal(high.series.length, 1);
  assert.equal(high.series[0].ts, 0);
});

test("uptimeStatus bands a success rate at inclusive thresholds", () => {
  // Pinned deliberately: loosening a band changes what the public status page
  // calls healthy, so it should be a visible edit rather than a silent one.
  assert.deepEqual({ ...UPTIME_STATUS_THRESHOLDS }, { operational: 90, minor: 80, degraded: 70 });
  const { operational, minor, degraded } = UPTIME_STATUS_THRESHOLDS;
  // Each floor belongs to its own band; anything under the lowest is major.
  assert.equal(uptimeStatus(100, 1), "operational");
  assert.equal(uptimeStatus(operational, 1), "operational");
  assert.equal(uptimeStatus(operational - 0.1, 1), "minor");
  assert.equal(uptimeStatus(minor, 1), "minor");
  assert.equal(uptimeStatus(minor - 0.1, 1), "degraded");
  assert.equal(uptimeStatus(degraded, 1), "degraded");
  assert.equal(uptimeStatus(degraded - 0.1, 1), "major");
  assert.equal(uptimeStatus(0, 1), "major");
  // Without samples there is no verdict to give, whatever the rate claims.
  assert.equal(uptimeStatus(100, 0), "unknown");
  assert.equal(uptimeStatus(Number.NaN, 5), "unknown");
});

test("public status projection exposes uptime and latency without traffic metrics", () => {
  const payload = {
    window_hours: 24,
    bucket_seconds: 3600,
    generated_at: 7200,
    available: true,
    models: [{
      model_name: "public-model",
      request_count: 10,
      success_count: 9,
      failure_count: 1,
      success_rate: 90,
      avg_latency_ms: 250,
      avg_ttft_ms: 50,
      avg_tps: 80,
      recent_success_rates: [100, 90],
      series: [{ ts: 3600, request_count: 10, success_count: 9, success_rate: 90, avg_latency_ms: 250 }],
    }],
  };
  const projected = publicResponse(payload, ["public-model"]);
  // Time to first token is a responsiveness figure, published for the same
  // reason as avg_latency_ms; traffic volume and throughput stay private.
  assert.deepEqual(projected.models, [{
    model_name: "public-model",
    success_rate: 90,
    avg_latency_ms: 250,
    avg_ttft_ms: 50,
    // 90% sits exactly on the operational floor, which is inclusive.
    status: "operational",
    series: [{ ts: 3600, success_rate: 90, avg_latency_ms: 250, status: "operational" }],
  }]);
  const serialized = JSON.stringify(projected);
  for (const privateField of ["request_count", "success_count", "failure_count", "avg_tps", "recent_success_rates"]) {
    assert.equal(serialized.includes(privateField), false, `${privateField} must not reach the public response`);
  }
});

test("public status projection publishes only the catalog it was given", () => {
  const payload = {
    window_hours: 24,
    bucket_seconds: 3600,
    generated_at: 7200,
    available: true,
    models: [{
      model_name: "hidden-auto",
      request_count: 10,
      success_count: 10,
      failure_count: 0,
      success_rate: 100,
      avg_latency_ms: 250,
      avg_ttft_ms: 50,
      avg_tps: 80,
      recent_success_rates: [100],
      series: [{ ts: 3600, request_count: 10, success_count: 10, success_rate: 100, avg_latency_ms: 250 }],
    }],
  };
  // Uptime is keyed by the requested model, so a hidden model accumulates history
  // of its own. Traffic must not put it on the page the catalog leaves it off.
  const projected = publicResponse(payload, ["listed-model"]);
  assert.deepEqual(projected.models.map((model) => model.model_name), ["listed-model"]);
  assert.equal(JSON.stringify(projected).includes("hidden-auto"), false, "an unpublished model must not leak");
  // A published model with no samples still renders, as an unknown placeholder.
  assert.equal(projected.models[0].status, "unknown");
  assert.equal(projected.models[0].avg_ttft_ms, 0);
  assert.deepEqual(projected.models[0].series, []);
});

test("query degrades to an unavailable but well-formed payload when init fails", async () => {
  const store = fakeStore();
  store.initialize = async () => {
    throw new Error("schema boom");
  };
  const service = new UptimeService(store);
  await service.initialize(); // must not reject
  const response = await service.query({ hours: 24, bucketSeconds: 3600 });
  assert.equal(response.available, false);
  assert.deepEqual(response.models, []);
  assert.equal(response.window_hours, 24);
  const status = service.status();
  assert.equal(status.degraded, true);
  assert.equal(status.available, false);
  // Recording after a failed init is a silent no-op, not an error.
  assert.doesNotThrow(() => service.record({ model: "x", success: true, latencyMs: 1 }));
  await service.shutdown();
});

test("records outcomes, flushes closed buckets, and reports uptime", async () => {
  const store = fakeStore();
  const service = new UptimeService(store);
  await service.initialize();
  // Place samples in a bucket that is already closed relative to wall-clock now.
  const past = bucketStart(Date.now() / 1000, BASE_BUCKET) - 3 * BASE_BUCKET;
  for (let i = 0; i < 10; i++) {
    service.record({ model: "gpt", success: i < 9, latencyMs: 100, outputTokens: 5, nowSeconds: past + 1 });
  }
  await service.flush();
  assert.equal(store.size(), 1);
  const response = await service.query({ hours: 24, bucketSeconds: 3600 });
  assert.equal(response.available, true);
  const model = response.models.find((m) => m.model_name === "gpt");
  assert.ok(model, "gpt should be present");
  assert.equal(model.request_count, 10);
  assert.equal(model.success_count, 9);
  assert.equal(model.failure_count, 1);
  assert.equal(model.success_rate, 90);
  await service.shutdown();
});

test("a streaming sample separates first-token latency from generation", async () => {
  const store = fakeStore();
  const service = new UptimeService(store);
  await service.initialize();
  const past = bucketStart(Date.now() / 1000, BASE_BUCKET) - 2 * BASE_BUCKET;
  // Two identical streams: 200ms waiting for the first token, then 800ms of output.
  for (let i = 0; i < 2; i++) {
    service.record({
      model: "streamer",
      success: true,
      latencyMs: 1000,
      ttftMs: 200,
      generationMs: 800,
      outputTokens: 40,
      nowSeconds: past,
    });
  }
  await service.flush();
  const [model] = (await service.query({ hours: 24, bucketSeconds: 3600 })).models;
  assert.equal(model.avg_latency_ms, 1000, "whole-request latency is still recorded");
  assert.equal(model.avg_ttft_ms, 200, "the status page figure excludes generation time");
  assert.equal(model.avg_tps, 50, "80 tokens over 1.6s of generation, not 2s of request time");
  await service.shutdown();
});

test("a sample with no first-token instant leaves ttft unmeasured", async () => {
  const store = fakeStore();
  const service = new UptimeService(store);
  await service.initialize();
  const past = bucketStart(Date.now() / 1000, BASE_BUCKET) - 2 * BASE_BUCKET;
  // A non-streaming request has no first token distinct from its response, so it
  // reports latency only and throughput falls back to the full duration.
  service.record({
    model: "blocking",
    success: true,
    latencyMs: 500,
    ttftMs: null,
    generationMs: null,
    outputTokens: 50,
    nowSeconds: past,
  });
  await service.flush();
  const [model] = (await service.query({ hours: 24, bucketSeconds: 3600 })).models;
  assert.equal(model.avg_latency_ms, 500);
  assert.equal(model.avg_ttft_ms, 0);
  assert.equal(model.avg_tps, 100);
  await service.shutdown();
});

test("query merges still-open in-memory buckets with persisted history", async () => {
  const store = fakeStore();
  const service = new UptimeService(store);
  await service.initialize();
  // One closed bucket (will be flushed) plus one still-open bucket (stays hot).
  const closed = bucketStart(Date.now() / 1000, BASE_BUCKET) - 2 * BASE_BUCKET;
  const open = bucketStart(Date.now() / 1000, BASE_BUCKET);
  service.record({ model: "claude", success: true, latencyMs: 50, nowSeconds: closed });
  service.record({ model: "claude", success: true, latencyMs: 50, nowSeconds: open });
  await service.flush(); // persists only the closed bucket; the open one remains hot
  assert.equal(store.size(), 1);
  assert.equal(service.status().hotBuckets, 1);
  const response = await service.query({ hours: 24, bucketSeconds: 3600 });
  const model = response.models.find((m) => m.model_name === "claude");
  assert.equal(model.request_count, 2); // persisted + hot combined
  await service.shutdown();
});

test("a failed flush returns counters to the hot map so nothing is lost", async () => {
  const store = fakeStore();
  const service = new UptimeService(store);
  await service.initialize();
  store.failPersistTimes = 1; // first flush attempt throws
  const past = bucketStart(Date.now() / 1000, BASE_BUCKET) - BASE_BUCKET;
  for (let i = 0; i < 4; i++) {
    service.record({ model: "restore-me", success: true, latencyMs: 25, nowSeconds: past });
  }
  await service.flush();
  assert.equal(store.size(), 0, "nothing persisted after the failure");
  assert.equal(service.status().hotBuckets, 1, "counters were folded back into the hot map");
  await service.flush(); // retry now succeeds
  assert.equal(store.size(), 1);
  const response = await service.query({ hours: 24, bucketSeconds: 3600 });
  const model = response.models.find((m) => m.model_name === "restore-me");
  assert.equal(model.request_count, 4, "no samples lost across the failed flush");
  await service.shutdown();
});

test("the hot-bucket cap bounds memory and counts dropped samples", async () => {
  const store = fakeStore();
  const service = new UptimeService(store);
  await service.initialize();
  const base = bucketStart(Date.now() / 1000, BASE_BUCKET);
  // 105 distinct model keys in one bucket against a cap of 100 → 5 dropped.
  for (let i = 0; i < 105; i++) {
    service.record({ model: `model-${i}`, success: true, latencyMs: 10, nowSeconds: base });
  }
  const status = service.status();
  assert.equal(status.hotBuckets, 100);
  assert.equal(status.droppedSamples, 5);
  await service.shutdown();
});

// ---------------------------------------------------------------------------
// One end-to-end check against the real SQLite-backed store, to verify the
// ported increment-on-conflict upsert and the windowed read actually run.
// ---------------------------------------------------------------------------
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-uptime-test-"));
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

async function createStore() {
  // The store opens "uptime.db"; UPTIME_DB_PATH redirects that to an isolated
  // temp file so the check never touches the repository's logs directory.
  process.env.UPTIME_DB_PATH = path.join(scratchDir, `uptime-${counter++}.db`);
  const store = new UptimeStore();
  await store.initialize();
  return store;
}

const sqliteAvailable = await (async () => {
  try {
    const store = await createStore();
    await store.close();
    return true;
  } catch (error) {
    console.warn(`Skipping uptime store tests: SQLite unavailable (${String(error).split("\n")[0]})`);
    return false;
  }
})();

test("UptimeStore increments counters on conflict and reads a window back", { skip: !sqliteAvailable }, async (t) => {
  const store = await createStore();
  t.after(() => store.close());
  const bucketTs = 3600;
  await store.persist([row("m", bucketTs, { requestCount: 3, successCount: 3, totalLatencyMs: 300 })]);
  // Same (model, endpoint, bucket) key must add to the existing row, not replace it.
  await store.persist([row("m", bucketTs, { requestCount: 2, successCount: 1, totalLatencyMs: 200 })]);
  const rows = await store.read(0, bucketTs + 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].counters.requestCount, 5);
  assert.equal(rows[0].counters.successCount, 4);
  assert.equal(rows[0].counters.totalLatencyMs, 500);

  // Distinct endpoints on the same model stay as separate rows.
  await store.persist([row("m", bucketTs, { requestCount: 1, successCount: 1 }, "secondary")]);
  assert.equal((await store.read(0, bucketTs + 1)).length, 2);

  // Retention removes everything before the cutoff.
  await store.deleteBefore(bucketTs + 1);
  assert.equal((await store.read(0, bucketTs + 1)).length, 0);
});
