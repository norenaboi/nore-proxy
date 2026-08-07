import assert from "node:assert/strict";
import test from "node:test";

import { classifyUpstreamFailure } from "../utils/autoRouting.js";
import {
  MAX_RETAINED_OUTPUT_BYTES,
  MAX_RETAINED_TOOL_BYTES,
  MAX_SSE_CARRY_BYTES,
  UpstreamStreamLimitError,
  createBoundedText,
  createToolByteBudget,
  guardCarryBuffer,
} from "../utils/streamLimits.js";

test("carry buffers are allowed up to the limit and rejected past it", () => {
  // The realistic case: a large but complete frame must not be refused.
  assert.doesNotThrow(() => guardCarryBuffer("x".repeat(MAX_SSE_CARRY_BYTES)));
  assert.doesNotThrow(() => guardCarryBuffer(""));

  assert.throws(
    () => guardCarryBuffer("x".repeat(MAX_SSE_CARRY_BYTES + 1)),
    (error) => {
      assert.ok(error instanceof UpstreamStreamLimitError);
      assert.equal(error.kind, "sse_carry");
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "upstream_stream_sse_carry_limit");
      // The offending buffer must not ride along into error storage.
      assert.ok(!error.message.includes("xxxx"));
      return true;
    },
  );
});

test("carry limits are measured in bytes, not characters", () => {
  // A multibyte payload reaches the byte limit at half the character count.
  const multibyte = "é".repeat(8);
  assert.throws(() => guardCarryBuffer(multibyte, 8), UpstreamStreamLimitError);
  assert.doesNotThrow(() => guardCarryBuffer(multibyte, 16));
});

test("bounded text retains a prefix while tracking full length", () => {
  const bounded = createBoundedText(10);
  bounded.append("abcde");
  bounded.append("fghij");
  assert.equal(bounded.text, "abcdefghij");
  assert.equal(bounded.totalLength, 10);
  assert.equal(bounded.truncated, false);

  // Past the budget, retention stops but accounting continues — token
  // estimation for a long response must not shrink to the retained prefix.
  bounded.append("klmno");
  assert.equal(bounded.text, "abcdefghij");
  assert.equal(bounded.totalLength, 15);
  assert.equal(bounded.truncated, true);

  bounded.append("pqrst");
  assert.equal(bounded.text, "abcdefghij");
  assert.equal(bounded.totalLength, 20);
});

test("bounded text ignores empty appends and splits on a character boundary", () => {
  const bounded = createBoundedText(20);
  bounded.append("");
  bounded.append(null);
  bounded.append(undefined);
  assert.equal(bounded.text, "");
  assert.equal(bounded.totalLength, 0);
  assert.equal(bounded.truncated, false);

  // A chunk straddling the budget is truncated without emitting a broken
  // multibyte sequence in the retained text.
  const partial = createBoundedText(5);
  partial.append("ééé");
  assert.equal(partial.truncated, true);
  assert.equal(partial.totalLength, 3);
  assert.equal(partial.text, "éé");
  assert.ok(!partial.text.includes("�"));
});

test("tool argument budgets fail rather than truncate", () => {
  // Tool arguments must be retained whole to emit valid tool events, so
  // exceeding the budget is terminal instead of silently lossy.
  const budget = createToolByteBudget(10);
  budget.add("12345");
  budget.add("67890");
  assert.throws(
    () => budget.add("1"),
    (error) => {
      assert.ok(error instanceof UpstreamStreamLimitError);
      assert.equal(error.kind, "tool_arguments");
      assert.equal(error.code, "upstream_stream_tool_arguments_limit");
      return true;
    },
  );

  budget.reset();
  assert.doesNotThrow(() => budget.add("12345"));
  budget.add(null);
  budget.add("");
});

test("a delimiter-free upstream is refused before memory grows unbounded", () => {
  // Stand in for an upstream that streams forever without a newline: the
  // guard must fire within one chunk of the limit, not at the process ceiling.
  const chunk = "x".repeat(64 * 1024);
  const maxChunks = Math.ceil(MAX_SSE_CARRY_BYTES / chunk.length) + 2;
  let buffer = "";
  let thrown = null;
  for (let i = 0; i < maxChunks && !thrown; i++) {
    buffer += chunk;
    try { guardCarryBuffer(buffer); } catch (error) { thrown = error; }
  }

  assert.ok(thrown instanceof UpstreamStreamLimitError);
  assert.equal(thrown.kind, "sse_carry");
  assert.ok(Buffer.byteLength(buffer, "utf8") <= MAX_SSE_CARRY_BYTES + chunk.length);
});

test("limits leave headroom for the largest legitimate payloads", () => {
  // openai-responses and openai-codex end a stream with a single
  // response.completed event carrying the entire output, so one record can
  // approach the model's output ceiling. Roughly size a 128k-token output at
  // 4 bytes per token, then double it for JSON escaping and reasoning text.
  const largestRealisticRecord = 128_000 * 4 * 2;
  assert.ok(
    MAX_SSE_CARRY_BYTES > largestRealisticRecord,
    "carry cap must exceed a full terminal response event",
  );

  // The tool budget is cumulative across every call in a turn and failing it
  // aborts the request, so it needs the same headroom.
  assert.ok(MAX_RETAINED_TOOL_BYTES >= MAX_SSE_CARRY_BYTES);

  // Retained output is only a logging cap and never fails a request, so it is
  // deliberately the tightest of the three.
  assert.ok(MAX_RETAINED_OUTPUT_BYTES < MAX_SSE_CARRY_BYTES);

  // All three still bound one in-flight request to single-digit megabytes.
  const perRequestCeiling =
    MAX_SSE_CARRY_BYTES + MAX_RETAINED_OUTPUT_BYTES + MAX_RETAINED_TOOL_BYTES;
  assert.ok(perRequestCeiling <= 32 * 1024 * 1024);
});

test("a limit breach after client output neither retries nor falls back", () => {
  // Before any bytes reach the client, a 502-class failure may move to another
  // key or target; afterwards the stream is committed and must not.
  const before = classifyUpstreamFailure({
    statusCode: new UpstreamStreamLimitError("sse_carry", 1).statusCode,
    streamOutputStarted: false,
  });
  assert.equal(before.fallbackTarget, true);

  const after = classifyUpstreamFailure({
    statusCode: new UpstreamStreamLimitError("sse_carry", 1).statusCode,
    streamOutputStarted: true,
  });
  assert.deepEqual(after, {
    reason: "output_started",
    retryKey: false,
    fallbackTarget: false,
  });
});
