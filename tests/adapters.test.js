import assert from "node:assert/strict";
import test from "node:test";

import * as anthropic from "../utils/adapters/anthropic.js";
import * as codex from "../utils/adapters/openai-codex.js";
import * as gemini from "../utils/adapters/gemini.js";
import * as openai from "../utils/adapters/openai.js";
import * as responses from "../utils/adapters/openai-responses.js";
import { ADAPTERS, getAdapter, getExtraHeaders } from "../utils/adapters/index.js";

const request = {
  messages: [
    { role: "system", content: "Be concise" },
    { role: "user", content: "Hello" },
  ],
  max_tokens: 128,
  temperature: 0.4,
};

test("adapter registry exposes every supported upstream format", () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), [
    "anthropic", "gemini", "openai", "openai-codex", "openai-responses",
  ]);
  assert.equal(getAdapter("anthropic"), ADAPTERS.anthropic);
  assert.equal(getAdapter(), ADAPTERS.openai);
  assert.deepEqual(getExtraHeaders("anthropic"), { "anthropic-version": "2023-06-01" });
});

test("request adapters preserve core messages and protocol requirements", () => {
  assert.deepEqual(openai.transformRequest(request, "gpt-upstream"), {
    model: "gpt-upstream",
    stream: false,
    messages: request.messages,
    max_tokens: 128,
    temperature: 0.4,
  });

  const anthropicBody = anthropic.transformRequest(request, "claude-upstream");
  assert.equal(anthropicBody.system, "Be concise");
  assert.deepEqual(anthropicBody.messages, [{ role: "user", content: "Hello" }]);

  const geminiBody = gemini.transformRequest(request, "gemini-upstream");
  assert.deepEqual(geminiBody.systemInstruction, { parts: [{ text: "Be concise" }] });
  assert.deepEqual(geminiBody.contents, [{ role: "user", parts: [{ text: "Hello" }] }]);

  const responsesBody = responses.transformRequest(request, "responses-upstream");
  assert.equal(responsesBody.instructions, "Be concise");
  assert.equal(responsesBody.store, false);
  assert.equal(responsesBody.max_output_tokens, 128);
});

test("Codex requests and headers share a request identifier", () => {
  const context = { requestId: "request-123", isStreaming: true };
  const body = codex.transformStreamRequest(request, "codex-model", context);
  const headers = codex.getExtraHeaders(context);

  assert.equal(body.prompt_cache_key, "request-123");
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(headers["session-id"], "request-123");
  assert.equal(headers.Accept, "text/event-stream");
});

test("response adapters preserve text, reasoning, tools, and usage", () => {
  const anthropicResult = anthropic.parseResponseData({
    id: "msg-1",
    model: "claude",
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "tool-1", name: "lookup", input: { id: 1 } },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  assert.equal(anthropicResult.content, "answer");
  assert.equal(anthropicResult.response.choices[0].message.reasoning_content, "reason");
  assert.equal(anthropicResult.response.choices[0].finish_reason, "tool_calls");

  const geminiChunk = gemini.parseStreamChunk({
    candidates: [{ content: { parts: [{ thought: true, text: "think" }, { text: "done" }] }, finishReason: "STOP" }],
  });
  assert.equal(geminiChunk.deltaReasoning, "think");
  assert.equal(geminiChunk.deltaContent, "done");
  assert.equal(geminiChunk.finishReason, "stop");
});

test("stream adapters treat valid-JSON non-objects as empty events", () => {
  // An upstream can emit `data: null` (or a bare scalar) as keepalive or
  // framing noise. It parses successfully, so it reaches the adapters and must
  // yield no chunk rather than dereferencing a null.
  const ctx = { requestId: "r", modelName: "model", streamId: "chatcmpl-r", streamCreated: 1 };
  for (const payload of [null, 0, "", "ping", true]) {
    for (const adapter of [openai, anthropic, gemini, responses, codex]) {
      assert.equal(adapter.buildStreamChunk(payload, ctx), null);
      assert.equal(adapter.parseStreamChunk(payload, ctx), null);
    }
  }
});
