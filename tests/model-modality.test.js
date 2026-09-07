import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Isolated configuration only: this exercises the models.json load path, so it
// must never read the deployed file. MASTER_KEY is required by config
// validation and is a throwaway value with no deployment meaning.
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nore-modality-"));
process.env.MASTER_KEY = "test-only-master-key";
process.env.ENDPOINTS_PATH = path.join(fixtureDirectory, "endpoints.json");
process.env.MODELS_PATH = path.join(fixtureDirectory, "models.json");
process.env.SETTINGS_PATH = path.join(fixtureDirectory, "settings.json");

fs.writeFileSync(
  process.env.ENDPOINTS_PATH,
  JSON.stringify({
    v1: { name: "Chat", url: "https://api.example.com", tokens: ["token-one"], apiFormat: "openai" },
    v2: { name: "Pictures", url: "https://openrouter.ai/api", tokens: ["token-two"], apiFormat: "openrouter-images" },
    v3: { name: "Vectors", url: "https://api.example.com", tokens: ["token-three"], apiFormat: "openai-embeddings" },
    // Written before the format was recorded at all.
    v4: { name: "Legacy", url: "https://api.example.com", tokens: ["token-four"] },
  }),
);
fs.writeFileSync(
  process.env.MODELS_PATH,
  JSON.stringify({
    models: {
      "chats": { backend: "chats", version: "v1" },
      "makes-pictures": { backend: "makes-pictures", version: "v2" },
      "embed-small": { backend: "embed-small", version: "v3" },
      "legacy-endpoint-model": { backend: "legacy", version: "v4" },
      // A stored modality left by an older write must not override the
      // endpoint: this model sits on a text endpoint and is a text model.
      "stale-embedding": { backend: "stale", version: "v1", modality: "embedding" },
      "auto-embed": { type: "auto", targets: ["embed-small"] },
      "auto-chat": { type: "auto", targets: ["chats", "makes-pictures"] },
    },
  }),
);
fs.writeFileSync(process.env.SETTINGS_PATH, JSON.stringify({}));

const { default: Config } = await import("../config/index.js");
// MODEL_REGISTRY is a reassigned `let` export: destructuring it here would
// snapshot the empty registry from before loadModelsFromFile() ran, so the
// namespace is held and read through on each access instead.
const helpers = await import("../utils/helpers.js");
const { loadModelsFromFile } = helpers;
const { normalizeModality, isEmbeddingModality, MODEL_MODALITIES } = await import(
  "../shared/contracts/models.js"
);
const { apiFormatCategory, API_FORMATS } = await import("../shared/contracts/apiFormats.js");
const { deriveModelModalities } = await import("../utils/modelModality.js");

test("modality normalization keeps a pre-modality models.json behaving as text", () => {
  assert.deepEqual([...MODEL_MODALITIES], ["text", "image", "embedding"]);
  assert.equal(normalizeModality(undefined), "text");
  assert.equal(normalizeModality(null), "text");
  assert.equal(normalizeModality(""), "text");
  assert.equal(normalizeModality("audio"), "text");
  assert.equal(normalizeModality("TEXT"), "text");
  assert.equal(normalizeModality("image"), "image");
  // "vision" is the former name of "image" and must not degrade to text.
  assert.equal(normalizeModality("vision"), "image");
  assert.equal(normalizeModality("embedding"), "embedding");

  assert.equal(isEmbeddingModality("embedding"), true);
  assert.equal(isEmbeddingModality("image"), false);
  assert.equal(isEmbeddingModality(undefined), false);
});

test("every API format declares a category, and unknown formats read as text", () => {
  // The category is the modality, so the two unions must stay one-to-one.
  for (const format of API_FORMATS) {
    assert.ok(MODEL_MODALITIES.includes(format.category), `${format.value} → ${format.category}`);
  }
  assert.deepEqual(
    API_FORMATS.filter((format) => format.category === "image").map((format) => format.value),
    ["openrouter-images", "gemini-interactions"],
  );
  assert.deepEqual(
    API_FORMATS.filter((format) => format.category === "embedding").map((format) => format.value),
    ["openai-embeddings", "gemini-embeddings"],
  );

  // A hand-edited endpoints.json can hold anything; it must degrade, not break.
  assert.equal(apiFormatCategory(undefined), "text");
  assert.equal(apiFormatCategory("nonsense"), "text");
});

test("the model registry takes each model's modality from its endpoint", () => {
  Config.loadEndpoints();
  loadModelsFromFile();

  assert.equal(helpers.MODEL_REGISTRY["chats"].modality, "text");
  assert.equal(helpers.MODEL_REGISTRY["chats"].type, "chat");

  // Each category names the client route that serves it.
  assert.equal(helpers.MODEL_REGISTRY["makes-pictures"].modality, "image");
  assert.equal(helpers.MODEL_REGISTRY["makes-pictures"].type, "image");

  assert.equal(helpers.MODEL_REGISTRY["embed-small"].modality, "embedding");
  assert.equal(helpers.MODEL_REGISTRY["embed-small"].type, "embedding");

  // An endpoint written before apiFormat existed defaults to the OpenAI chat
  // format, so its models stay text models exactly as they were.
  assert.equal(helpers.MODEL_REGISTRY["legacy-endpoint-model"].modality, "text");

  // The endpoint wins over a modality left in the file by an older write.
  assert.equal(helpers.MODEL_REGISTRY["stale-embedding"].modality, "text");
  assert.equal(helpers.MODEL_REGISTRY["stale-embedding"].type, "chat");
});

test("an automatic model inherits the modality of its targets", () => {
  Config.loadEndpoints();
  loadModelsFromFile();

  assert.equal(helpers.MODEL_REGISTRY["auto-embed"].routingType, "auto");
  assert.equal(helpers.MODEL_REGISTRY["auto-embed"].modality, "embedding");
  assert.equal(helpers.MODEL_REGISTRY["auto-embed"].type, "embedding");

  // Mixed targets resolve to the first one rather than taking the model offline.
  assert.equal(helpers.MODEL_REGISTRY["auto-chat"].modality, "text");
});

test("the admin derivation answers for disabled and invalid models too", () => {
  // The registry skips disabled models; the admin list shows them and needs a
  // modality for each.
  const derived = deriveModelModalities(
    {
      live: { backend: "live", version: "v3" },
      off: { backend: "off", version: "v2", disabled: true },
      dangling: { backend: "dangling", version: "v99" },
      auto: { type: "auto", targets: ["off", "live"] },
      "auto-empty": { type: "auto", targets: [] },
    },
    JSON.parse(fs.readFileSync(process.env.ENDPOINTS_PATH, "utf-8")),
  );

  assert.equal(derived.get("live"), "embedding");
  assert.equal(derived.get("off"), "image");
  // A missing endpoint categorizes nothing, so it takes the "text" fallback.
  assert.equal(derived.get("dangling"), "text");
  assert.equal(derived.get("auto"), "image");
  assert.equal(derived.get("auto-empty"), "text");
});
