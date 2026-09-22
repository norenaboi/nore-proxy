import assert from "node:assert/strict";
import test from "node:test";
import { buildImageRequest, generateImageBatch, imageCountOf } from "../frontend/src/lib/playground/images.ts";
import { transformImageRequest } from "../utils/adapters/gemini-interactions.ts";
import { imageModelFormat } from "../utils/imageModelFormat.ts";

const allSettings = { aspectRatio: "16:9", imageSize: "2K", size: "1536x1024", quality: "high" };

test("requests include only controls belonging to the selected endpoint format", () => {
  for (const format of ["openai-images", "openai-images-generations"]) {
    assert.deepEqual(buildImageRequest("m", "p", allSettings, format), {
      model: "m", prompt: "p", size: "1536x1024", quality: "high",
    });
  }
  assert.deepEqual(buildImageRequest("m", "p", allSettings, "gemini-interactions"), {
    model: "m", prompt: "p", aspect_ratio: "16:9", image_size: "2K",
  });
  assert.deepEqual(buildImageRequest("m", "p", allSettings), { model: "m", prompt: "p" });
});

test("the requested image count is clamped to the picker's 1-4 range", () => {
  assert.equal(imageCountOf(undefined), 1);
  assert.equal(imageCountOf({ aspectRatio: "", imageSize: "" }), 1);
  assert.equal(imageCountOf({ aspectRatio: "", imageSize: "", count: "" }), 1);
  assert.equal(imageCountOf({ aspectRatio: "", imageSize: "", count: "3" }), 3);
  assert.equal(imageCountOf({ aspectRatio: "", imageSize: "", count: "0" }), 1);
  assert.equal(imageCountOf({ aspectRatio: "", imageSize: "", count: "9" }), 4);
  assert.equal(imageCountOf({ aspectRatio: "", imageSize: "", count: "junk" }), 1);
});

test("the count rides as `n` on OpenAI-shaped requests and never on Interactions", () => {
  const settings = { ...allSettings, count: "3" };
  for (const format of ["openai-images", "openai-images-generations"]) {
    assert.equal(buildImageRequest("m", "p", settings, format).n, 3);
  }
  // A single image needs no explicit count.
  assert.equal(buildImageRequest("m", "p", { ...allSettings, count: "1" }, "openai-images").n, undefined);
  // Interactions returns one image per request; its batch is the client fan-out.
  assert.deepEqual(buildImageRequest("m", "p", settings, "gemini-interactions"), {
    model: "m", prompt: "p", aspect_ratio: "16:9", image_size: "2K",
  });
  assert.deepEqual(buildImageRequest("m", "p", settings), { model: "m", prompt: "p" });
});

test("image requests include ordered valid reference images", () => {
  const references = [
    { id: "a", type: "image", name: "a.png", mimeType: "image/png", value: "data:image/png;base64,AAA" },
    { id: "t", type: "text", name: "notes.txt", mimeType: "text/plain", value: "ignore" },
    { id: "empty", type: "image", name: "empty.png", mimeType: "image/png", value: "" },
    { id: "b", type: "image", name: "b.jpg", mimeType: "image/jpeg", value: "data:image/jpeg;base64,BBB" },
  ];
  const request = buildImageRequest("m", "p", { ...allSettings, count: "3" }, "openai-images", references);
  assert.equal(request.n, 3);
  assert.deepEqual(request.input_references, [
    { type: "image_url", image_url: { url: references[0].value } },
    { type: "image_url", image_url: { url: references[3].value } },
  ]);
  assert.equal(buildImageRequest("m", "p", allSettings, "gemini-interactions").input_references, undefined);
});

test("Gemini batches publish each image before slower siblings settle", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const resolvers = [];
  globalThis.fetch = () => new Promise((resolve) => resolvers.push(resolve));
  const published = [];
  const batch = generateImageBatch(
    "key", "m", "p", new AbortController().signal,
    { aspectRatio: "", imageSize: "", count: "2" },
    "gemini-interactions",
    { onImages: (images) => published.push(images[0].dataUrl) },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolvers[1](new Response(JSON.stringify({ data: [{ b64_json: "BBB" }] }), { status: 200 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(published.length, 1);
  resolvers[0](new Response(JSON.stringify({ data: [{ b64_json: "AAA" }] }), { status: 200 }));
  const result = await batch;
  assert.equal(result.failed, 0);
  assert.equal(published.length, 2);
});

test("an explicit retry count controls OpenAI n", () => {
  const request = buildImageRequest("m", "p", { ...allSettings, count: "4" }, "openai-images", [], 2);
  assert.equal(request.n, 2);
});

test("image format comes from endpoint configuration and compatible automatic targets", () => {
  const concrete = (version) => ({ modality: "image", routingType: "concrete", version });
  const registry = { a: concrete("v1"), b: concrete("v2"), c: concrete("v3") };
  const endpoints = {
    v1: { apiFormat: "openrouter-images" },
    v2: { apiFormat: "openai-images-generations" },
    v3: { apiFormat: "gemini-interactions" },
  };
  const auto = (targets) => ({ modality: "image", routingType: "auto", targets });
  assert.equal(imageModelFormat(registry.a, registry, endpoints), "openai-images");
  assert.equal(imageModelFormat(registry.c, registry, endpoints), "gemini-interactions");
  assert.equal(imageModelFormat(auto(["missing", "a", "b"]), registry, endpoints), "openai-images");
  assert.equal(imageModelFormat(auto(["a", "c"]), registry, endpoints), undefined);
  assert.equal(imageModelFormat(auto([]), registry, endpoints), undefined);
  assert.equal(imageModelFormat({ ...registry.a, modality: "text" }, registry, endpoints), undefined);
});

test("default image settings leave the request and interaction format unset", () => {
  const request = buildImageRequest("image-model", "A landscape", { aspectRatio: "", imageSize: "" });
  assert.deepEqual(request, { model: "image-model", prompt: "A landscape" });
  assert.deepEqual(transformImageRequest(request, "upstream"), {
    model: "upstream", input: [{ type: "text", text: "A landscape" }],
  });
});

test("playground image settings reach the Interactions response format", () => {
  const request = buildImageRequest("image-model", "A landscape", { aspectRatio: "16:9", imageSize: "2K" }, "gemini-interactions");
  assert.deepEqual(transformImageRequest(request, "upstream"), {
    model: "upstream", input: [{ type: "text", text: "A landscape" }],
    response_format: { type: "image", aspect_ratio: "16:9", image_size: "2K" },
  });
});

test("either image control can be set independently", () => {
  for (const settings of [{ aspectRatio: "1:1", imageSize: "" }, { aspectRatio: "", imageSize: "4K" }]) {
    const request = buildImageRequest("image-model", "A landscape", settings, "gemini-interactions");
    const format = transformImageRequest(request, "upstream").response_format;
    assert.equal(format.type, "image");
    assert.equal(format.aspect_ratio, settings.aspectRatio || undefined);
    assert.equal(format.image_size, settings.imageSize || undefined);
  }
});
