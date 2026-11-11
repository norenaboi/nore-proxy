import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicErrorEnvelope,
  anthropicErrorType,
  applyRetryAfter,
  clientErrorBody,
  openAIErrorBody,
  protocolForPath,
  resetStreamHeaders,
} from "../utils/clientErrors.js";

test("protocolForPath resolves the Anthropic protocol only for /v1/messages", () => {
  assert.equal(protocolForPath("/v1/messages"), "anthropic");
  assert.equal(protocolForPath("/v1/messages/"), "anthropic");
  assert.equal(protocolForPath("/v1/chat/completions"), "openai");
  assert.equal(protocolForPath("/v1/embeddings"), "openai");
  assert.equal(protocolForPath("/admin/keys"), "openai");
  assert.equal(protocolForPath(undefined), "openai");
});

test("anthropicErrorType maps status codes to Anthropic error types", () => {
  assert.equal(anthropicErrorType(400), "invalid_request_error");
  assert.equal(anthropicErrorType(401), "authentication_error");
  assert.equal(anthropicErrorType(403), "permission_error");
  assert.equal(anthropicErrorType(404), "not_found_error");
  assert.equal(anthropicErrorType(413), "request_too_large");
  assert.equal(anthropicErrorType(429), "rate_limit_error");
  assert.equal(anthropicErrorType(529), "overloaded_error");
  assert.equal(anthropicErrorType(500), "api_error");
  assert.equal(anthropicErrorType(null), "api_error");
});

test("anthropicErrorEnvelope forwards upstream Anthropic error bodies and adds the proxy code", () => {
  const error = {
    message: "wrapper message",
    code: "rate_limit_error",
    responseBody: { type: "error", error: { type: "rate_limit_error", message: "upstream message" } },
  };
  assert.deepEqual(anthropicErrorEnvelope(error, 429), {
    type: "error",
    error: { type: "rate_limit_error", message: "upstream message", code: "rate_limit_error" },
  });
});

test("anthropicErrorEnvelope wraps unknown errors with the mapped type and a message", () => {
  assert.deepEqual(anthropicErrorEnvelope({ message: "boom" }, 500), {
    type: "error",
    error: { type: "api_error", message: "boom" },
  });
  assert.deepEqual(anthropicErrorEnvelope(null, 500), {
    type: "error",
    error: { type: "api_error", message: "Internal server error" },
  });
});

test("clientErrorBody picks the envelope matching the client protocol", () => {
  assert.deepEqual(clientErrorBody({ message: "nope" }, 404, "openai"), {
    error: { message: "nope" },
  });
  assert.deepEqual(clientErrorBody({ message: "nope", code: "x" }, 429, "anthropic"), {
    type: "error",
    error: { type: "rate_limit_error", message: "nope", code: "x" },
  });
  assert.deepEqual(openAIErrorBody(null), { error: { message: "Internal server error" } });
});

function fakeRes() {
  const headers = new Map();
  return {
    set: (k, v) => headers.set(k, String(v)),
    setHeader: (k, v) => headers.set(k, v),
    removeHeader: (k) => headers.delete(k),
    get: (k) => headers.get(k),
    headers,
  };
}

test("resetStreamHeaders replaces pre-set SSE framing with JSON content type", () => {
  const res = fakeRes();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  resetStreamHeaders(res);
  assert.equal(res.get("Content-Type"), "application/json");
  assert.equal(res.get("Cache-Control"), undefined);
  assert.equal(res.get("Connection"), undefined);
  assert.equal(res.get("X-Accel-Buffering"), undefined);
});

test("applyRetryAfter sets the header only for positive integer delays", () => {
  const res = fakeRes();
  applyRetryAfter(res, { retryAfterSeconds: 30 });
  assert.equal(res.get("Retry-After"), "30");
  applyRetryAfter(res, { retryAfterSeconds: 0 });
  applyRetryAfter(res, { retryAfterSeconds: -1 });
  applyRetryAfter(res, { retryAfterSeconds: 1.5 });
  applyRetryAfter(res, {});
  applyRetryAfter(res, null);
  assert.equal(res.get("Retry-After"), "30");
});
