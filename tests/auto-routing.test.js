import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyUpstreamFailure,
  createRoutingState,
  getTargetSequence,
  markStreamOutputStarted,
  nextTarget,
  resetAutoRoutingCounters,
  validateModelDefinition,
} from "../utils/autoRouting.js";

const registry = {
  direct: { routingType: "concrete" },
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

test("failure classification preserves retry and streaming boundaries", () => {
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 429 }), {
    reason: "http_429", retryKey: true, fallbackTarget: true,
  });
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 400 }), {
    reason: "http_400", retryKey: false, fallbackTarget: false,
  });
  assert.deepEqual(classifyUpstreamFailure({ error: { code: "ETIMEDOUT" } }), {
    reason: "timeout", retryKey: false, fallbackTarget: true,
  });

  const state = createRoutingState({ requestId: "req-2", requestedModel: "direct", registry });
  markStreamOutputStarted(state);
  assert.deepEqual(classifyUpstreamFailure({ statusCode: 503, streamOutputStarted: state.streamOutputStarted }), {
    reason: "output_started", retryKey: false, fallbackTarget: false,
  });
});
