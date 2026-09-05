import assert from "node:assert/strict";
import test from "node:test";

import {
  EmbeddingInputError,
  embeddingInputCount,
  embeddingInputToTexts,
  geminiEmbeddings,
  getEmbeddingAdapter,
  openaiEmbeddings,
} from "../utils/adapters/embeddings.js";
import { getEmbeddingsUrl, supportsEmbeddings } from "../utils/endpointPolicies.js";

test("embeddings URLs follow each format's own surface", () => {
  assert.equal(
    getEmbeddingsUrl("https://api.example", "openai", "text-embedding-3-small"),
    "https://api.example/v1/embeddings",
  );
  // DashScope compatible-mode and OpenRouter are reached this way: the base URL
  // carries the provider's prefix and the proxy only appends /v1/embeddings.
  assert.equal(
    getEmbeddingsUrl("https://dashscope.aliyuncs.com/compatible-mode", "openai", "text-embedding-v3"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
  );
  // An endpoint that already carries its own version path opts out of the suffix.
  assert.equal(
    getEmbeddingsUrl("https://api.example/openai/v1", "openai", "m", false),
    "https://api.example/openai/v1/embeddings",
  );
  assert.equal(
    getEmbeddingsUrl("https://generativelanguage.googleapis.com", "gemini", "text-embedding-004"),
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents",
  );
  // The Responses and Codex formats differ only in how completions are shaped.
  assert.equal(
    getEmbeddingsUrl("https://api.example", "openai-responses", "m"),
    "https://api.example/v1/embeddings",
  );
});

test("anthropic has no embeddings surface and is refused rather than guessed at", () => {
  assert.equal(supportsEmbeddings("anthropic"), false);
  assert.equal(getEmbeddingsUrl("https://api.anthropic.com", "anthropic", "m"), null);
  assert.equal(getEmbeddingAdapter("anthropic"), null);
  // Unlike getAdapter(), this must not silently fall back to the OpenAI shape.
  assert.equal(getEmbeddingAdapter("nonsense-format"), null);
  assert.equal(getEmbeddingAdapter(undefined), openaiEmbeddings);
});

test("the OpenAI embedding adapter forwards provider-specific params untouched", () => {
  const body = openaiEmbeddings.transformEmbeddingRequest(
    {
      model: "client-facing-name",
      input: ["alpha", "beta"],
      dimensions: 512,
      encoding_format: "float",
      // Params only some providers know. Passing them through unchanged is what
      // makes an arbitrary OpenAI-compatible embeddings provider work.
      input_type: "query",
      truncate: "END",
      user: "abc",
      stream: true,
      cache_depth: 2,
      unset: null,
    },
    "text-embedding-v3",
  );

  assert.deepEqual(body, {
    model: "text-embedding-v3",
    input: ["alpha", "beta"],
    dimensions: 512,
    encoding_format: "float",
    input_type: "query",
    truncate: "END",
    user: "abc",
  });
});

test("the OpenAI embedding adapter normalizes usage across providers", () => {
  const withBoth = openaiEmbeddings.parseEmbeddingResponse(
    { object: "list", data: [{ embedding: [0.1] }], usage: { prompt_tokens: 7, total_tokens: 7 } },
    { modelName: "shown-to-client" },
  );
  assert.equal(withBoth.embeddingCount, 1);
  assert.deepEqual(withBoth.usage, { prompt_tokens: 7, total_tokens: 7 });

  // DashScope reports total_tokens only; the input side must still be billed.
  const totalOnly = openaiEmbeddings.parseEmbeddingResponse(
    { data: [{ embedding: [] }, { embedding: [] }], usage: { total_tokens: 12 } },
    { modelName: "m" },
  );
  assert.deepEqual(totalOnly.usage, { prompt_tokens: 12, total_tokens: 12 });

  const noUsage = openaiEmbeddings.parseEmbeddingResponse({ data: [] }, { modelName: "m" });
  assert.deepEqual(noUsage.usage, { prompt_tokens: 0, total_tokens: 0 });
  assert.equal(noUsage.embeddingCount, 0);
});

test("the gemini embedding adapter builds batchEmbedContents and normalizes back", () => {
  const body = geminiEmbeddings.transformEmbeddingRequest(
    { input: ["one", "two"], dimensions: 256, input_type: "document" },
    "text-embedding-004",
  );
  assert.deepEqual(body, {
    requests: [
      {
        model: "models/text-embedding-004",
        content: { parts: [{ text: "one" }] },
        outputDimensionality: 256,
        taskType: "RETRIEVAL_DOCUMENT",
      },
      {
        model: "models/text-embedding-004",
        content: { parts: [{ text: "two" }] },
        outputDimensionality: 256,
        taskType: "RETRIEVAL_DOCUMENT",
      },
    ],
  });

  const parsed = geminiEmbeddings.parseEmbeddingResponse(
    { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3] }] },
    { modelName: "proxy-facing-name" },
  );
  assert.deepEqual(parsed.response, {
    object: "list",
    data: [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [0.3] },
    ],
    model: "proxy-facing-name",
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
  assert.equal(parsed.embeddingCount, 2);
});

test("gemini task types accept both its own enum and the OpenAI-compatible spelling", () => {
  const query = geminiEmbeddings.transformEmbeddingRequest({ input: "q", input_type: "query" }, "m");
  assert.equal(query.requests[0].taskType, "RETRIEVAL_QUERY");

  const native = geminiEmbeddings.transformEmbeddingRequest(
    { input: "q", task_type: "SEMANTIC_SIMILARITY" },
    "m",
  );
  assert.equal(native.requests[0].taskType, "SEMANTIC_SIMILARITY");

  const none = geminiEmbeddings.transformEmbeddingRequest({ input: "q" }, "m");
  assert.equal("taskType" in none.requests[0], false);
  assert.equal("outputDimensionality" in none.requests[0], false);
});

test("token-id input is accepted by OpenAI-format upstreams and refused by gemini", () => {
  // The OpenAI path forwards `input` verbatim, so token ids reach the upstream.
  const passthrough = openaiEmbeddings.transformEmbeddingRequest({ input: [[1, 2], [3]] }, "m");
  assert.deepEqual(passthrough.input, [[1, 2], [3]]);

  // Gemini content cannot express token ids, so this fails as a client error
  // rather than as an opaque upstream rejection.
  assert.throws(
    () => geminiEmbeddings.transformEmbeddingRequest({ input: [[1, 2]] }, "m"),
    (error) => error instanceof EmbeddingInputError && error.statusCode === 400,
  );
  assert.throws(() => geminiEmbeddings.transformEmbeddingRequest({ input: [] }, "m"), EmbeddingInputError);
  assert.throws(() => geminiEmbeddings.transformEmbeddingRequest({}, "m"), EmbeddingInputError);
});

test("embedding input helpers count and coerce the OpenAI input union", () => {
  assert.deepEqual(embeddingInputToTexts("solo"), ["solo"]);
  assert.deepEqual(embeddingInputToTexts(["a", "b"]), ["a", "b"]);
  assert.deepEqual(embeddingInputToTexts([]), []);

  assert.equal(embeddingInputCount("solo"), 1);
  assert.equal(embeddingInputCount(["a", "b", "c"]), 3);
  assert.equal(embeddingInputCount(undefined), 0);
  assert.equal(embeddingInputCount({}), 0);
});

test("an endpoint that cannot serve embeddings falls through to the next target", async () => {
  const { classifyUpstreamFailure } = await import("../utils/autoRouting.js");

  const unsupported = classifyUpstreamFailure({
    statusCode: 502,
    error: { code: "endpoint_protocol_unsupported" },
  });
  // Neither the key nor the moment is at fault, so no retry and no key hop —
  // but another automatic target may well be able to serve the request.
  assert.deepEqual(unsupported, {
    reason: "endpoint_unsupported",
    retrySame: false,
    retryKey: false,
    fallbackTarget: true,
  });

  // A malformed client input fails identically on every target, so it stays
  // terminal and must not walk the whole target list.
  const clientError = classifyUpstreamFailure({ statusCode: 400, error: new EmbeddingInputError("bad") });
  assert.equal(clientError.retrySame, false);
  assert.equal(clientError.retryKey, false);
  assert.equal(clientError.fallbackTarget, false);
});
