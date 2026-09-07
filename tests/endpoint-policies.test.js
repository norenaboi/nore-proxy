import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBodyParamPolicy,
  applyGenerationPolicy,
  applyQueryKeyAuth,
  getFullUrl,
  getImagesUrl,
  getModelsUrl,
  normalizeEndpointUrl,
  supportsImages,
  upstreamAuthHeaders,
  usesQueryKeyAuth,
} from "../utils/endpointPolicies.js";

test("endpoint URLs use the correct protocol paths", () => {
  assert.equal(normalizeEndpointUrl("https://api.example/v1/"), "https://api.example");
  assert.equal(getModelsUrl("https://api.example/", "openai"), "https://api.example/v1/models");
  assert.equal(getModelsUrl("https://api.example/custom/", "gemini", false), "https://api.example/custom/models");
  assert.equal(getFullUrl("https://api.example", "anthropic", "model"), "https://api.example/v1/messages");
  assert.equal(getFullUrl("https://api.example", "openai-responses", "model"), "https://api.example/v1/responses");
  assert.equal(getFullUrl("https://api.example", "gemini", "gemini-pro", true), "https://api.example/v1beta/models/gemini-pro:streamGenerateContent");
});

test("only the image formats serve images, each on its own surface", () => {
  assert.equal(supportsImages("openrouter-images"), true);
  assert.equal(supportsImages("gemini-interactions"), true);
  assert.equal(
    getImagesUrl("https://openrouter.ai/api", "openrouter-images", "m"),
    "https://openrouter.ai/api/v1/images",
  );
  assert.equal(
    getImagesUrl("https://generativelanguage.googleapis.com", "gemini-interactions", "m"),
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  // An endpoint that already carries its own version path opts out of the suffix.
  assert.equal(
    getImagesUrl("https://openrouter.ai/api/v1", "openrouter-images", "m", false),
    "https://openrouter.ai/api/v1/images",
  );

  for (const format of ["openai", "anthropic", "gemini", "openai-embeddings"]) {
    assert.equal(supportsImages(format), false, format);
    assert.equal(getImagesUrl("https://api.example", format, "m"), null, format);
  }

  // Image models never reach getFullUrl: they are not served by a chat route,
  // so an image format there falls through to the OpenAI default rather than
  // naming an images path.
  assert.equal(
    getFullUrl("https://api.example", "openrouter-images", "m"),
    "https://api.example/v1/chat/completions",
  );

  // Every Google surface lists models under /v1beta, whatever its category.
  assert.equal(getModelsUrl("https://api.example", "gemini-interactions"), "https://api.example/v1beta/models");
  assert.equal(getModelsUrl("https://api.example", "gemini-embeddings"), "https://api.example/v1beta/models");
  assert.equal(getModelsUrl("https://api.example", "openrouter-images"), "https://api.example/v1/models");
});

test("credentials go where each provider expects them", () => {
  // Bearer is the default. Anthropic and Interactions each take their own
  // header; only the two query-key formats touch the URL.
  assert.deepEqual(upstreamAuthHeaders("openai", "k"), { Authorization: "Bearer k" });
  assert.deepEqual(upstreamAuthHeaders("openai-embeddings", "k"), { Authorization: "Bearer k" });
  assert.deepEqual(upstreamAuthHeaders("openrouter-images", "k"), { Authorization: "Bearer k" });
  assert.deepEqual(upstreamAuthHeaders("anthropic", "k"), { "x-api-key": "k" });
  assert.deepEqual(upstreamAuthHeaders("gemini-interactions", "k"), { "x-goog-api-key": "k" });
  assert.deepEqual(upstreamAuthHeaders("gemini", "k"), {});
  assert.deepEqual(upstreamAuthHeaders("gemini-embeddings", "k"), {});
  // A key-less endpoint must not send an empty credential header.
  assert.deepEqual(upstreamAuthHeaders("openai", null), {});

  assert.equal(usesQueryKeyAuth("gemini"), true);
  assert.equal(usesQueryKeyAuth("gemini-embeddings"), true);
  assert.equal(usesQueryKeyAuth("gemini-interactions"), false);

  assert.equal(applyQueryKeyAuth("https://api.example/x", "gemini", "k"), "https://api.example/x?key=k");
  assert.equal(applyQueryKeyAuth("https://api.example/x", "gemini", "k", "alt=sse&"), "https://api.example/x?alt=sse&key=k");
  // Header-authenticated formats leave the credential out of the URL, and so
  // out of the log line recording it.
  assert.equal(applyQueryKeyAuth("https://api.example/x", "gemini-interactions", "k"), "https://api.example/x");
  assert.equal(applyQueryKeyAuth("https://api.example/x", "openai", "k", "alt=sse&"), "https://api.example/x");
});

test("generation policy removes disabled values and overrides enabled values", () => {
  const request = { temperature: 0.9, top_p: 0.8, max_tokens: 100, messages: [] };
  const result = applyGenerationPolicy(request, {
    temperature: { enabled: true, value: 0.2 },
    top_p: { enabled: false, value: 0.4 },
    max_tokens: { enabled: true, value: 512 },
  });

  assert.equal(result, request);
  assert.deepEqual(result, { temperature: 0.2, max_tokens: 512, messages: [] });
});

test("body param policy strips before adding and keeps JSON values intact", () => {
  const request = { model: "m", stream: true, frequency_penalty: 0.5, temperature: 0.7 };
  const result = applyBodyParamPolicy(request, {
    add: { reasoning_effort: "high", stop: ["\n\n", "END"], safety: { threshold: "BLOCK_NONE" }, temperature: 0.1 },
    strip: ["frequency_penalty", "temperature"],
  });

  assert.equal(result, request);
  assert.deepEqual(result, {
    model: "m",
    stream: true,
    reasoning_effort: "high",
    stop: ["\n\n", "END"],
    safety: { threshold: "BLOCK_NONE" },
    // Listed in both lists: the strip runs first, so the added value wins.
    temperature: 0.1,
  });
});

test("body param policy refuses the params the proxy owns", () => {
  // A hand-edited endpoints.json could name these even though the admin API
  // rejects them, so the runtime declines rather than letting an endpoint
  // redirect its own routing target or change response framing.
  const request = { model: "resolved-model", stream: true, messages: [] };
  applyBodyParamPolicy(request, {
    add: { model: "other-model", stream: false, __proto__: { polluted: true } },
    strip: ["model", "stream"],
  });

  assert.deepEqual(request, { model: "resolved-model", stream: true, messages: [] });
  assert.equal({}.polluted, undefined);
});

test("body param policy leaves the body alone when absent or malformed", () => {
  const request = { model: "m", messages: [] };
  const snapshot = { ...request };

  for (const policy of [null, undefined, {}, "nope", 7, [], { add: null, strip: null }]) {
    assert.deepEqual(applyBodyParamPolicy(request, policy), snapshot);
  }

  assert.equal(applyBodyParamPolicy(null, { add: { a: 1 }, strip: [] }), null);
});
