import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  buildUpstreamErrorContext,
  readUpstreamErrorBody,
  sanitizeUpstreamUrl,
} from "../utils/upstreamErrors.js";

const endpointInfo = {
  endpointKey: "v4",
  endpointName: "Fallback Gemini",
  actualModel: "gemini-2.5-pro",
  apiFormat: "gemini",
};

test("buildUpstreamErrorContext captures routing and Axios failure details", () => {
  const error = new Error("Request failed with status code 503");
  error.code = "ERR_BAD_RESPONSE";
  error.response = {
    status: 503,
    data: { error: { message: "Provider overloaded" } },
  };

  const context = buildUpstreamErrorContext({
    modelName: "gemini-friendly",
    endpointInfo,
    requestHeaders: { "Content-Type": "application/json" },
    upstreamUrl:
      "https://provider.example/v1beta/models/gemini-2.5-pro:generateContent?key=top-secret&alt=sse",
    error,
  });

  // requestParams is no longer captured in the upstream error context
  // (the outbound payload is no longer persisted to error_logs).
  assert.deepEqual(context, {
    model: "gemini-friendly",
    upstreamModel: "gemini-2.5-pro",
    endpointKey: "v4",
    endpointName: "Fallback Gemini",
    apiFormat: "gemini",
    maskedApiKey: null,
    statusCode: 503,
    errorCode: "ERR_BAD_RESPONSE",
    requestHeaders: { "Content-Type": "application/json" },
    upstreamUrl:
      "https://provider.example/v1beta/models/gemini-2.5-pro:generateContent?alt=sse",
    responseBody: { error: { message: "Provider overloaded" } },
  });
});

test("explicit status and collected response data override generic error fields", () => {
  const error = new Error("Bad gateway");
  error.statusCode = 500;
  error.response = { status: 500, data: "unread stream" };

  const context = buildUpstreamErrorContext({
    modelName: "model-a",
    endpointInfo,
    error,
    statusCode: 502,
    responseBody: { error: "collected body" },
  });

  assert.equal(context.statusCode, 502);
  assert.deepEqual(context.responseBody, { error: "collected body" });
});

test("readUpstreamErrorBody collects and parses streaming JSON", async () => {
  const stream = Readable.from([
    Buffer.from('{"error":{"message":'),
    Buffer.from('"stream failed"}}'),
  ]);

  assert.deepEqual(await readUpstreamErrorBody(stream), {
    error: { message: "stream failed" },
  });
});

test("readUpstreamErrorBody preserves plain text and existing objects", async () => {
  assert.equal(await readUpstreamErrorBody("plain provider error"), "plain provider error");
  assert.deepEqual(await readUpstreamErrorBody({ error: "already parsed" }), {
    error: "already parsed",
  });
});

test("sanitizeUpstreamUrl removes credential-like query parameters case-insensitively", () => {
  assert.equal(
    sanitizeUpstreamUrl(
      "https://provider.example/path?API_KEY=one&access_token=two&alt=sse&region=us",
    ),
    "https://provider.example/path?alt=sse&region=us",
  );
});
