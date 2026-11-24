import "./isolated-config.js";
import assert from "node:assert/strict";
import test from "node:test";

import { repairTruncatedJson } from "../utils/jsonRepair.js";

test("repair closes truncated object literals", () => {
  // The realistic timeout cut: arguments split by the streaming token died
  // after the opening brace.
  assert.equal(repairTruncatedJson('{"path":"/tmp'), '{"path":"/tmp"}');
  assert.equal(repairTruncatedJson('{"a":1,"b":[1,2'), '{"a":1,"b":[1,2]}');
});

test("repair of already-complete JSON returns it unchanged", () => {
  const complete = '{"path":"/tmp"}';
  assert.equal(repairTruncatedJson(complete), complete);
  assert.equal(repairTruncatedJson(""), null);
});

test("repair closes a dangling string value", () => {
  const repaired = repairTruncatedJson('{"command":"rm -rf /tmp/x');
  assert.equal(repaired, '{"command":"rm -rf /tmp/x"}');
  assert.deepEqual(JSON.parse(repaired), { command: "rm -rf /tmp/x" });
});

test("repair completes a cut property name with a null value", () => {
  assert.deepEqual(JSON.parse(repairTruncatedJson('{"comma')), { comma: null });
  assert.deepEqual(JSON.parse(repairTruncatedJson('{"a":1,"b')), { a: 1, b: null });
});

test("repair is refused when no simple suffix closes the prefix", () => {
  // A dangling key separator cannot be repaired by appending closers alone.
  assert.equal(repairTruncatedJson('{"a":'), null);
  assert.equal(repairTruncatedJson('{"a": '), null);
  // Keys must be strings for the {null:...} repair; malformed quotes fail.
  assert.equal(repairTruncatedJson('{a: 1'), null);
});

test("repair respects escaped quotes inside strings", () => {
  // The escaped quote must not end the string; repair closes at the true end.
  const repaired = repairTruncatedJson('{"content":"she said \\"hi\\" to ');
  assert.deepEqual(JSON.parse(repaired), { content: 'she said "hi" to ' });
});
