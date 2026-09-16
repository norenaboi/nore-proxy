import assert from "node:assert/strict";
import test from "node:test";
import { buildImageRequest } from "../frontend/src/lib/playground/images.ts";
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
