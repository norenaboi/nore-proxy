import "./isolated-config.js";
import assert from "node:assert/strict";
import test from "node:test";

import { testUpstreamModel } from "../utils/modelTest.js";

const baseInput = {
  url: "https://api.example",
  token: "secret-token",
  backend: "test-model",
  customHeaders: { "X-Custom": "value", Authorization: "unsafe", "Content-Type": "text/plain" },
  apiFormat: "openai",
  appendApiSuffix: true,
};

async function captureRequest(input, response = { status: 200 }) {
  let request;
  const result = await testUpstreamModel(input, async (config) => {
    request = config;
    return response;
  });
  return { request, result };
}

test("OpenAI model tests use a minimal silent request and authoritative headers", async () => {
  const { request, result } = await captureRequest(baseInput);

  assert.equal(request.url, "https://api.example/v1/chat/completions");
  assert.equal(request.timeout, 15000);
  assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["X-Custom"], "value");
  assert.deepEqual(request.data, {
    model: "test-model",
    messages: [{ role: "user", content: "ping" }],
    stream: false,
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.latency_ms, "number");
});

test("Anthropic model tests retain the required token limit", async () => {
  const { request } = await captureRequest({ ...baseInput, apiFormat: "anthropic" });

  assert.equal(request.url, "https://api.example/v1/messages");
  assert.deepEqual(request.data, {
    model: "test-model",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
  assert.equal("temperature" in request.data, false);
  assert.equal("top_p" in request.data, false);
});

test("Gemini model tests use the query credential and provider body", async () => {
  const { request } = await captureRequest({
    ...baseInput,
    token: "key with spaces",
    apiFormat: "gemini",
  });

  assert.equal(request.url, "https://api.example/v1beta/models/test-model:generateContent?key=key%20with%20spaces");
  assert.equal(request.headers.Authorization, "unsafe");
  assert.equal(request.headers.Authorization.startsWith("Bearer "), false);
  assert.deepEqual(request.data, { contents: [{ parts: [{ text: "ping" }] }] });
});

test("Responses model tests disable storage and streaming", async () => {
  const { request } = await captureRequest({ ...baseInput, apiFormat: "openai-responses" });

  assert.equal(request.url, "https://api.example/v1/responses");
  assert.deepEqual(request.data, {
    model: "test-model",
    input: "ping",
    store: false,
    stream: false,
  });
});

test("Codex model tests use one request identifier for body and headers", async () => {
  const { request } = await captureRequest({ ...baseInput, apiFormat: "openai-codex" });

  assert.equal(request.url, "https://api.example/v1/responses");
  assert.equal(request.data.store, false);
  assert.equal(request.data.stream, false);
  assert.deepEqual(request.data.include, ["reasoning.encrypted_content"]);
  assert.match(request.data.prompt_cache_key, /^models-test-/);
  assert.equal(request.headers["x-client-request-id"], request.data.prompt_cache_key);
  assert.equal(request.headers["session-id"], request.data.prompt_cache_key);
  assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.equal(request.headers["Content-Type"], "application/json");
});

test("upstream failures return elapsed latency and redact credentials", async () => {
  const result = await testUpstreamModel(baseInput, async () => {
    throw {
      response: {
        status: 401,
        data: { error: { message: "credential secret-token rejected" } },
      },
    };
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 401: credential [redacted] rejected");
  assert.equal(typeof result.latency_ms, "number");
  assert.equal(result.error.includes("secret-token"), false);
});

test("non-200 requester responses become failed test results", async () => {
  const { result } = await captureRequest(baseInput, { status: 204 });

  assert.deepEqual(result, {
    ok: false,
    error: "Upstream returned HTTP 204",
    latency_ms: result.latency_ms,
  });
});

test("model tests send the endpoint's body-param policy", async () => {
  // The ping must match the wire body a real request would send, or a test
  // passes against a body the endpoint never actually uses.
  const { request } = await captureRequest({
    ...baseInput,
    bodyParams: { add: { reasoning_effort: "high", stop: ["END"] }, strip: ["messages"] },
  });

  assert.deepEqual(request.data, {
    model: "test-model",
    stream: false,
    reasoning_effort: "high",
    stop: ["END"],
  });
});

test("the pinged surface follows the endpoint's format, not the model", async () => {
  // An embeddings endpoint is pinged at /v1/embeddings. No model-supplied
  // modality is consulted; a model carries none.
  const { request, result } = await captureRequest({ ...baseInput, apiFormat: "openai-embeddings" });

  assert.equal(request.url, "https://api.example/v1/embeddings");
  assert.deepEqual(request.data, { model: "test-model", input: "ping" });
  assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.equal(result.ok, true);
});

test("embedding model tests translate the ping for Gemini", async () => {
  const { request } = await captureRequest({ ...baseInput, apiFormat: "gemini-embeddings" });

  assert.equal(
    request.url,
    "https://api.example/v1beta/models/test-model:embedContent?key=secret-token",
  );
  assert.deepEqual(request.data, { content: { parts: [{ text: "ping" }] } });
  // Gemini embeddings authenticate by query parameter, so no Bearer header is
  // added and the endpoint's custom header is left as configured.
  assert.equal(request.headers.Authorization.startsWith("Bearer "), false);
});

test("OpenAI Images Generations tests ping /v1/images/generations", async () => {
  const { request, result } = await captureRequest({ ...baseInput, apiFormat: "openai-images-generations" });

  assert.equal(request.url, "https://api.example/v1/images/generations");
  assert.deepEqual(request.data, { model: "test-model", prompt: "ping" });
  assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.equal(result.ok, true);
});

test("OpenAI Images tests ping /v1/images with the adapter's own body", async () => {
  const { request, result } = await captureRequest({ ...baseInput, apiFormat: "openai-images" });

  assert.equal(request.url, "https://api.example/v1/images");
  assert.deepEqual(request.data, { model: "test-model", prompt: "ping" });
  assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.equal(result.ok, true);
});

test("Gemini Interactions tests authenticate by header, not query string", async () => {
  const { request } = await captureRequest({ ...baseInput, apiFormat: "gemini-interactions" });

  // Unlike generateContent, this surface carries the key in a header, leaving
  // the credential out of the URL.
  assert.equal(request.url, "https://api.example/v1beta/interactions");
  assert.equal(request.headers["x-goog-api-key"], "secret-token");
  assert.deepEqual(request.data, {
    model: "test-model",
    input: [{ type: "text", text: "ping" }],
  });
});
