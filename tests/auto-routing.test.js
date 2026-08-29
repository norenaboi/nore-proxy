import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyUpstreamFailure,
  createRoutingState,
  getTargetSequence,
  markStreamOutputStarted,
  nextTarget,
  pruneAutoTargetReferences,
  resetAutoRoutingCounters,
  resolveAutoTargets,
  validateModelDefinition,
} from "../utils/autoRouting.js";

const registry = {
  direct: { routingType: "concrete" },
  first: { routingType: "concrete" },
  second: { routingType: "concrete" },
  third: { routingType: "concrete" },
  automatic: {
    routingType: "auto",
    targets: ["first", "second", "third"],
    targetSelection: "roundrobin",
    maxTargetAttempts: 2,
  },
};

test("model validation accepts supported concrete and automatic definitions", () => {
  assert.equal(validateModelDefinition("display", { backend: "", version: "v1" }, {
    endpoints: { v1: {} },
  }).valid, true);
  assert.equal(validateModelDefinition("automatic", {
    type: "auto",
    targets: [],
    targetSelection: "sticky",
  }).valid, true);

  const invalid = validateModelDefinition("automatic", {
    type: "auto",
    targets: ["automatic", "automatic"],
    targetSelection: "random",
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes("Auto model targets must be unique"));
  assert.ok(invalid.errors.includes("Auto model cannot target itself"));
});

test("automatic target selection rotates and respects attempt ceilings", () => {
  resetAutoRoutingCounters();
  assert.deepEqual(getTargetSequence("direct", registry), ["direct"]);
  assert.deepEqual(getTargetSequence("automatic", registry), ["first", "second"]);
  assert.deepEqual(getTargetSequence("automatic", registry), ["second", "third"]);

  resetAutoRoutingCounters();
  const state = createRoutingState({ requestId: "req-1", requestedModel: "automatic", registry });
  assert.equal(nextTarget(state), "first");
  assert.equal(nextTarget(state), "second");
  assert.equal(nextTarget(state), null);
});

test("dead targets are skipped without consuming failover attempts", () => {
  resetAutoRoutingCounters();
  // "gone" was deleted, "off" is disabled so it never reached the registry, and
  // "nested" is another auto model — none can be routed to.
  const decayed = {
    ...registry,
    nested: { routingType: "auto", targets: ["first"] },
    automatic: {
      routingType: "auto",
      targets: ["gone", "off", "nested", "first", "second"],
      targetSelection: "sticky",
      maxTargetAttempts: 2,
    },
  };
  const resolved = resolveAutoTargets(decayed.automatic.targets, decayed);
  assert.deepEqual(resolved.targets, ["first", "second"]);
  assert.deepEqual(resolved.dropped, ["gone", "off", "nested"]);

  // Without pruning, the two-attempt ceiling would be spent on "gone" and "off"
  // and the healthy targets behind them would never be tried.
  assert.deepEqual(getTargetSequence("automatic", decayed), ["first", "second"]);

  const allDead = { automatic: { routingType: "auto", targets: ["gone"], targetSelection: "sticky" } };
  assert.deepEqual(getTargetSequence("automatic", allDead), []);

  // Round-robin advances over live targets only, so a dead name cannot stall it.
  resetAutoRoutingCounters();
  const rotating = { ...decayed, automatic: { ...decayed.automatic, targetSelection: "roundrobin" } };
  assert.deepEqual(getTargetSequence("automatic", rotating), ["first", "second"]);
  assert.deepEqual(getTargetSequence("automatic", rotating), ["second", "first"]);
});

test("deleting a concrete model prunes it from auto target lists", () => {
  const models = {
    keep: { version: "v1" },
    solo: { type: "auto", targets: ["doomed"] },
    mixed: { type: "auto", targets: ["doomed", "keep"] },
    untouched: { type: "auto", targets: ["keep"] },
  };
  const affected = pruneAutoTargetReferences(models, ["doomed"]);
  assert.deepEqual(affected, [
    { name: "solo", remainingTargets: 0 },
    { name: "mixed", remainingTargets: 1 },
  ]);
  assert.deepEqual(models.solo.targets, []);
  assert.deepEqual(models.mixed.targets, ["keep"]);
  assert.deepEqual(models.untouched.targets, ["keep"]);
  assert.deepEqual(pruneAutoTargetReferences(models, []), []);
});

test("submitted auto targets must exist unless already stored", () => {
  const context = {
    models: { real: { version: "v1" }, other: { type: "auto", targets: [] } },
    requireExistingTargets: true,
  };
  const rejected = validateModelDefinition("router", { type: "auto", targets: ["real", "typo", "other"] }, context);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.includes("Auto model target 'typo' is not an existing concrete model"));
  assert.ok(rejected.errors.includes("Auto model target 'other' is not an existing concrete model"));

  // An unrelated edit to a model that already carried a stale target still saves.
  const grandfathered = validateModelDefinition(
    "router",
    { type: "auto", targets: ["real", "typo"] },
    { ...context, grandfatheredTargets: ["typo"] },
  );
  assert.equal(grandfathered.valid, true);

  // The registry loader stays permissive so one stale name cannot take an auto
  // model offline.
  assert.equal(
    validateModelDefinition("router", { type: "auto", targets: ["typo"] }, { models: context.models }).valid,
    true,
  );
});

test("failure classification preserves retry and streaming boundaries", () => {
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 429 }), {
    reason: "http_429", retrySame: false, retryKey: true, fallbackTarget: true,
  });
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 400 }), {
    reason: "http_400", retrySame: false, retryKey: false, fallbackTarget: false,
  });
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 503 }), {
    reason: "http_5xx", retrySame: true, retryKey: false, fallbackTarget: true,
  });
  assert.deepEqual(classifyUpstreamFailure({ error: { code: "ETIMEDOUT" } }), {
    reason: "timeout", retrySame: true, retryKey: false, fallbackTarget: true,
  });

  const state = createRoutingState({ requestId: "req-2", requestedModel: "direct", registry });
  markStreamOutputStarted(state);
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 503, streamOutputStarted: state.streamOutputStarted }), {
    reason: "output_started", retrySame: false, retryKey: false, fallbackTarget: false,
  });
});
