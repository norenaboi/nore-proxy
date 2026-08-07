import assert from "node:assert/strict";
import test from "node:test";

import Config from "../config/index.js";

const KEYS = ["k0", "k1", "k2", "k3"];

test("rotated order is a full permutation starting at the offset", () => {
  assert.deepEqual(Config.orderTokensFrom(KEYS, 0), ["k0", "k1", "k2", "k3"]);
  assert.deepEqual(Config.orderTokensFrom(KEYS, 2), ["k2", "k3", "k0", "k1"]);
  assert.deepEqual(Config.orderTokensFrom(KEYS, 3), ["k3", "k0", "k1", "k2"]);

  for (let offset = 0; offset < KEYS.length; offset++) {
    const ordered = Config.orderTokensFrom(KEYS, offset);
    assert.equal(ordered.length, KEYS.length);
    assert.deepEqual([...ordered].sort(), [...KEYS].sort());
  }
});

test("out-of-range, negative, and non-finite offsets normalize into the list", () => {
  assert.deepEqual(Config.orderTokensFrom(KEYS, 4), Config.orderTokensFrom(KEYS, 0));
  assert.deepEqual(Config.orderTokensFrom(KEYS, 9), Config.orderTokensFrom(KEYS, 1));
  assert.deepEqual(Config.orderTokensFrom(KEYS, -1), Config.orderTokensFrom(KEYS, 3));
  assert.deepEqual(Config.orderTokensFrom(KEYS, Number.NaN), Config.orderTokensFrom(KEYS, 0));
  assert.deepEqual(Config.orderTokensFrom([], 2), []);
  assert.deepEqual(Config.orderTokensFrom(["only"], 5), ["only"]);
});

test("one offset held across hops walks distinct keys in rotated order", () => {
  // Mirrors how getEndpointForConcreteModel selects: rotate the full key list by
  // the request's offset, then take the first key that has not been tried yet.
  const offset = 2;
  const tried = new Set();
  const visited = [];

  for (let hop = 0; hop < KEYS.length; hop++) {
    const next = Config.orderTokensFrom(KEYS, offset).find((key) => !tried.has(key));
    assert.ok(next, "a usable key should remain");
    tried.add(next);
    visited.push(next);
  }

  assert.deepEqual(visited, ["k2", "k3", "k0", "k1"]);
  assert.equal(new Set(visited).size, KEYS.length);
});

test("sidelined keys are skipped without disturbing the sequence", () => {
  const usable = new Set(["k1", "k3"]);
  const ordered = Config.orderTokensFrom(KEYS, 2).filter((key) => usable.has(key));
  assert.deepEqual(ordered, ["k3", "k1"]);
});

test("random offset stays in range and degenerates to zero for short lists", () => {
  assert.equal(Config.randomRotationOffset(0), 0);
  assert.equal(Config.randomRotationOffset(1), 0);
  assert.equal(Config.randomRotationOffset(Number.NaN), 0);

  for (let draw = 0; draw < 200; draw++) {
    const offset = Config.randomRotationOffset(KEYS.length);
    assert.ok(Number.isInteger(offset));
    assert.ok(offset >= 0 && offset < KEYS.length, `offset ${offset} out of range`);
  }
});

test("consecutive requests do not all start on the same key", () => {
  // The point of the random start: a key failing with a non-actionable code
  // (a 500 never sidelines it) must not absorb every following request.
  const seen = new Set();
  for (let draw = 0; draw < 500; draw++) {
    seen.add(Config.orderTokensFrom(KEYS, Config.randomRotationOffset(KEYS.length))[0]);
  }
  assert.equal(seen.size, KEYS.length, `expected every key to start at least once, saw ${[...seen]}`);
});
