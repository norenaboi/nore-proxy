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
    v1: { name: "OpenAI-ish", url: "https://api.example.com", tokens: ["token-one"], apiFormat: "openai" },
  }),
);
fs.writeFileSync(
  process.env.MODELS_PATH,
  JSON.stringify({
    models: {
      // Written before modalities existed: no modality key at all.
      "legacy-chat": { backend: "legacy-chat", version: "v1" },
      "sees-things": { backend: "sees-things", version: "v1", modality: "vision" },
      "embed-small": { backend: "embed-small", version: "v1", modality: "embedding" },
      // A hand-edited file can hold anything; it must degrade, not break.
      "bogus-modality": { backend: "bogus-modality", version: "v1", modality: "audio" },
      "auto-embed": { type: "auto", modality: "embedding", targets: ["embed-small"] },
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

test("modality normalization keeps a pre-modality models.json behaving as text", () => {
  assert.deepEqual([...MODEL_MODALITIES], ["text", "vision", "embedding"]);
  assert.equal(normalizeModality(undefined), "text");
  assert.equal(normalizeModality(null), "text");
  assert.equal(normalizeModality(""), "text");
  assert.equal(normalizeModality("audio"), "text");
  assert.equal(normalizeModality("TEXT"), "text");
  assert.equal(normalizeModality("vision"), "vision");
  assert.equal(normalizeModality("embedding"), "embedding");

  assert.equal(isEmbeddingModality("embedding"), true);
  assert.equal(isEmbeddingModality("vision"), false);
  assert.equal(isEmbeddingModality(undefined), false);
});

test("the model registry records a modality and derives the client-facing type", () => {
  Config.loadEndpoints();
  loadModelsFromFile();

  assert.equal(helpers.MODEL_REGISTRY["legacy-chat"].modality, "text");
  assert.equal(helpers.MODEL_REGISTRY["legacy-chat"].type, "chat");

  assert.equal(helpers.MODEL_REGISTRY["sees-things"].modality, "vision");
  // Vision is still a chat model: it routes through /v1/chat/completions.
  assert.equal(helpers.MODEL_REGISTRY["sees-things"].type, "chat");

  assert.equal(helpers.MODEL_REGISTRY["embed-small"].modality, "embedding");
  assert.equal(helpers.MODEL_REGISTRY["embed-small"].type, "embedding");

  // An unrecognized stored value must not take the model offline.
  assert.equal(helpers.MODEL_REGISTRY["bogus-modality"].modality, "text");
  assert.equal(helpers.MODEL_REGISTRY["bogus-modality"].type, "chat");

  // An automatic model carries its own modality, so it can front embedding targets.
  assert.equal(helpers.MODEL_REGISTRY["auto-embed"].routingType, "auto");
  assert.equal(helpers.MODEL_REGISTRY["auto-embed"].modality, "embedding");
  assert.equal(helpers.MODEL_REGISTRY["auto-embed"].type, "embedding");
});
