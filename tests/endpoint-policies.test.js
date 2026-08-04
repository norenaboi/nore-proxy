import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGenerationPolicy,
  getFullUrl,
  getModelsUrl,
  normalizeEndpointUrl,
} from "../utils/endpointPolicies.js";

test("endpoint URLs use the correct protocol paths", () => {
  assert.equal(normalizeEndpointUrl("https://api.example/v1/"), "https://api.example");
  assert.equal(getModelsUrl("https://api.example/", "openai"), "https://api.example/v1/models");
  assert.equal(getModelsUrl("https://api.example/custom/", "gemini", false), "https://api.example/custom/models");
  assert.equal(getFullUrl("https://api.example", "anthropic", "model"), "https://api.example/v1/messages");
  assert.equal(getFullUrl("https://api.example", "openai-responses", "model"), "https://api.example/v1/responses");
  assert.equal(getFullUrl("https://api.example", "gemini", "gemini-pro", true), "https://api.example/v1beta/models/gemini-pro:streamGenerateContent");
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
