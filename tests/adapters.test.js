import assert from "node:assert/strict";
import test from "node:test";

import * as anthropic from "../utils/adapters/anthropic.js";
import * as codex from "../utils/adapters/openai-codex.js";
import * as gemini from "../utils/adapters/gemini.js";
import * as openai from "../utils/adapters/openai.js";
import * as responses from "../utils/adapters/openai-responses.js";
import {
  ImageInputError,
  geminiInteractions,
  getImageAdapter,
  openaiImages,
  openaiImagesGenerations,
} from "../utils/adapters/images.js";
import { ADAPTERS, getAdapter, getExtraHeaders } from "../utils/adapters/index.js";

const request = {
  messages: [
    { role: "system", content: "Be concise" },
    { role: "user", content: "Hello" },
  ],
  max_tokens: 128,
  temperature: 0.4,
};

test("the chat registry holds the text formats only", () => {
  // Image and embedding formats are dispatched by utils/adapters/images.ts and
  // utils/adapters/embeddings.ts under their own contracts, and their models
  // answer on their own client routes.
  assert.deepEqual(Object.keys(ADAPTERS).sort(), [
    "anthropic", "gemini", "openai", "openai-codex", "openai-responses",
  ]);
  assert.equal(getAdapter("anthropic"), ADAPTERS.anthropic);
  assert.equal(getAdapter(), ADAPTERS.openai);
  assert.deepEqual(getExtraHeaders("anthropic"), { "anthropic-version": "2023-06-01" });
});

test("the image registry holds the image formats only", () => {
  assert.equal(getImageAdapter("openai-images"), openaiImages);
  assert.equal(getImageAdapter("openai-images-generations"), openaiImagesGenerations);
  assert.equal(getImageAdapter("gemini-interactions"), geminiInteractions);
  // The generations format reuses the OpenAI Images adapter; only the URL differs.
  assert.equal(openaiImagesGenerations.transformImageRequest, openaiImages.transformImageRequest);
  assert.equal(openaiImagesGenerations.parseImageResponse, openaiImages.parseImageResponse);
  // Former name of openai-images, still present in older endpoints.json files.
  assert.equal(getImageAdapter("openrouter-images"), openaiImages);
  // Unlike getAdapter(), this must not fall back. An absent format is not an
  // image format.
  for (const format of ["openai", "anthropic", "gemini", "openai-embeddings", undefined]) {
    assert.equal(getImageAdapter(format), null, String(format));
  }
});

test("the OpenAI images adapter forwards provider-specific params untouched", () => {
  const body = openaiImages.transformImageRequest(
    {
      model: "client-facing-name",
      prompt: "a red panda astronaut",
      size: "2K",
      // Params only some providers know. Passing them through unchanged is what
      // makes an arbitrary OpenAI-compatible images provider work.
      aspect_ratio: "16:9",
      output_compression: 80,
      input_references: [{ type: "image_url", image_url: { url: "https://cdn.example/ref.png" } }],
      stream: true,
      cache_depth: 2,
      unset: null,
    },
    "bytedance-seed/seedream-4.5",
  );

  assert.deepEqual(body, {
    model: "bytedance-seed/seedream-4.5",
    prompt: "a red panda astronaut",
    size: "2K",
    aspect_ratio: "16:9",
    output_compression: 80,
    input_references: [{ type: "image_url", image_url: { url: "https://cdn.example/ref.png" } }],
  });

  assert.throws(
    () => openaiImages.transformImageRequest({ prompt: "  " }, "m"),
    (error) => error instanceof ImageInputError && error.statusCode === 400,
  );
});

test("the OpenAI images adapter reads every usage spelling and tolerates none", () => {
  const body = openaiImages.transformImageRequest(
    { model: "client-facing-name", prompt: "a lighthouse at dusk", n: 2, size: "1024x1024", quality: "high", stream: false },
    "gpt-image-1",
  );
  assert.deepEqual(body, { model: "gpt-image-1", prompt: "a lighthouse at dusk", n: 2, size: "1024x1024", quality: "high" });

  // gpt-image-* usage: input_tokens/output_tokens.
  const withUsage = openaiImages.parseImageResponse(
    {
      created: 1748372400,
      data: [{ b64_json: "AAAA" }, { b64_json: "BBBB" }],
      usage: { input_tokens: 12, output_tokens: 1056, total_tokens: 1068, input_tokens_details: { text_tokens: 12, image_tokens: 0 } },
    },
    { modelName: "client-facing-name" },
  );
  assert.equal(withUsage.imageCount, 2);
  assert.deepEqual(withUsage.usage, { prompt_tokens: 12, completion_tokens: 1056, total_tokens: 1068 });
  assert.equal(withUsage.response.model, "client-facing-name");
  assert.equal(withUsage.response.data.length, 2);

  // DALL·E: no usage block.
  const noUsage = openaiImages.parseImageResponse(
    { created: 1748372400, data: [{ url: "https://cdn.example/out.png", revised_prompt: "..." }] },
    { modelName: "client-facing-name" },
  );
  assert.equal(noUsage.imageCount, 1);
  assert.deepEqual(noUsage.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("the OpenAI images adapter passes an OpenRouter answer through under the proxy's name", () => {
  const parsed = openaiImages.parseImageResponse(
    {
      created: 1748372400,
      model: "upstream-only-name",
      data: [{ b64_json: "QUJD", media_type: "image/webp" }],
      usage: { prompt_tokens: 3, completion_tokens: 4175, total_tokens: 4178, cost: 0.04 },
    },
    { modelName: "shown-to-client" },
  );

  assert.equal(parsed.response.model, "shown-to-client");
  assert.deepEqual(parsed.response.data, [{ b64_json: "QUJD", media_type: "image/webp" }]);
  assert.equal(parsed.imageCount, 1);
  assert.deepEqual(parsed.usage, { prompt_tokens: 3, completion_tokens: 4175, total_tokens: 4178 });

  const noUsage = openaiImages.parseImageResponse({ data: [] }, { modelName: "m" });
  assert.deepEqual(noUsage.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(noUsage.imageCount, 0);
});

test("the Gemini Interactions adapter translates to and from the Images shape", () => {
  const body = geminiInteractions.transformImageRequest(
    {
      prompt: "a nano banana dish",
      input_references: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,Wg==" } },
        { type: "image_url", image_url: { url: "https://cdn.example/ref.png" } },
      ],
    },
    "gemini-3.1-flash-image",
  );

  assert.deepEqual(body, {
    model: "gemini-3.1-flash-image",
    input: [
      { type: "text", text: "a nano banana dish" },
      { type: "image", mime_type: "image/jpeg", data: "Wg==" },
      { type: "image", uri: "https://cdn.example/ref.png" },
    ],
  });

  const parsed = geminiInteractions.parseImageResponse(
    {
      id: "v1_abc",
      object: "interaction",
      status: "completed",
      steps: [
        { type: "function_call", name: "ignored", arguments: {} },
        {
          type: "model_output",
          content: [
            { type: "text", text: "Here it is." },
            { type: "image", data: "Wg==", mime_type: "image/jpeg" },
          ],
        },
      ],
      usage: { total_input_tokens: 7, total_output_tokens: 20, total_thought_tokens: 22, total_tokens: 49 },
    },
    { modelName: "shown-to-client" },
  );

  assert.equal(parsed.response.model, "shown-to-client");
  assert.deepEqual(parsed.response.data, [
    { b64_json: "Wg==", media_type: "image/jpeg", revised_prompt: "Here it is." },
  ]);
  assert.equal(parsed.imageCount, 1);
  // Thought tokens land in completion_tokens; total_tokens is the reported one.
  assert.equal(parsed.usage.prompt_tokens, 7);
  assert.equal(parsed.usage.completion_tokens, 42);
  assert.equal(parsed.usage.total_tokens, 49);
});

test("a failed interaction throws rather than answering with an empty image list", () => {
  assert.throws(
    () => geminiInteractions.parseImageResponse(
      { status: "failed", errors: [{ code: "SAFETY", message: "blocked" }], steps: [] },
      { modelName: "m" },
    ),
    (error) => error.name === "InteractionFailedError" && error.statusCode === 502 && error.code === "SAFETY",
  );
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

test("image input and generated image output are normalized both ways", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const visionRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  // Inbound: each provider gets the image in its own wire shape.
  assert.deepEqual(gemini.transformRequest(visionRequest, "gemini-upstream").contents, [
    {
      role: "user",
      parts: [{ text: "what is this" }, { inline_data: { mime_type: "image/png", data: "AAAA" } }],
    },
  ]);
  assert.deepEqual(anthropic.transformRequest(visionRequest, "claude-upstream").messages[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  });
  assert.deepEqual(responses.transformRequest(visionRequest, "responses-upstream").input[0].content[1], {
    type: "input_image",
    image_url: dataUrl,
  });

  // Outbound: a Gemini inline_data part becomes an OpenAI images entry.
  const generated = gemini.parseResponseData({
    candidates: [{
      content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      finishReason: "STOP",
    }],
  });
  assert.equal(generated.content, "here");
  assert.deepEqual(generated.response.choices[0].message.images, [
    { type: "image_url", image_url: { url: dataUrl } },
  ]);

  const ctx = { requestId: "r", modelName: "model", streamId: "chatcmpl-r", streamCreated: 1 };
  const chunk = gemini.buildStreamChunk(
    { candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/webp", data: "BBBB" } }] } }] },
    ctx,
  );
  assert.deepEqual(chunk.choices[0].delta.images, [
    { type: "image_url", image_url: { url: "data:image/webp;base64,BBBB" } },
  ]);

  // A non-image inline part must not be forwarded as an image.
  assert.equal(
    gemini.parseStreamChunk(
      { candidates: [{ content: { parts: [{ inline_data: { mime_type: "audio/mp3", data: "CCCC" } }] } }] },
      ctx,
    ).images,
    null,
  );

  // The OpenAI passthrough carries images and tolerates array content.
  assert.deepEqual(
    openai.parseStreamChunk({ choices: [{ delta: { images: [{ type: "image_url", image_url: { url: dataUrl } }] } }] }, ctx)
      .images,
    [{ type: "image_url", image_url: { url: dataUrl } }],
  );
  assert.equal(
    openai.parseResponseData({ choices: [{ message: { content: [{ type: "text", text: "part" }] } }] }).content,
    "part",
  );
});

test("stream adapters treat valid-JSON non-objects as empty events", () => {  // An upstream can emit `data: null` (or a bare scalar) as keepalive or
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
