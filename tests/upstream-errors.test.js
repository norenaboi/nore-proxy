import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  buildUpstreamErrorContext,
  getUpstreamErrorMessage,
  readUpstreamErrorBody,
  sanitizeUpstreamUrl,
} from "../utils/upstreamErrors.js";

test("upstream URLs remove credential-like query parameters", () => {
  assert.equal(
    sanitizeUpstreamUrl("https://provider.example/path?API_KEY=one&access_token=two&alt=sse"),
    "https://provider.example/path?alt=sse",
  );
});

test("streaming upstream error bodies are bounded and parsed", async () => {
  const json = Readable.from([Buffer.from('{"error":'), Buffer.from('{"message":"failed"}}')]);
  assert.deepEqual(await readUpstreamErrorBody(json), { error: { message: "failed" } });

  const oversized = Readable.from([Buffer.from("abcdefgh")]);
  assert.deepEqual(await readUpstreamErrorBody(oversized, 4), {
    truncated: true,
    capturedBytes: 4,
    body: "abcd",
  });
});

test("error context keeps routing details while masking secrets", () => {
  const context = buildUpstreamErrorContext({
    modelName: "friendly-model",
    endpointInfo: {
      endpointKey: "v1",
      endpointName: "Primary",
      actualModel: "provider-model",
      apiFormat: "openai",
      token: "top-secret-token",
    },
    upstreamUrl: "https://provider.example/v1/chat?key=hidden&region=us",
    statusCode: 503,
    responseBody: { error: { message: "overloaded" } },
  });

  assert.equal(context.maskedApiKey, "top-s...ken");
  assert.equal(context.upstreamUrl, "https://provider.example/v1/chat?region=us");
  assert.equal(context.statusCode, 503);
  assert.equal(getUpstreamErrorMessage(context.responseBody), "overloaded");
});
