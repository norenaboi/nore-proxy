import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolated configuration only: this exercises the endpoints.json load path, so it
// must never read the deployed file. MASTER_KEY is required by config validation
// and is a throwaway value with no deployment meaning.
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nore-body-params-"));
process.env.MASTER_KEY = "test-only-master-key";
process.env.ENDPOINTS_PATH = path.join(fixtureDirectory, "endpoints.json");
process.env.MODELS_PATH = path.join(fixtureDirectory, "models.json");
process.env.SETTINGS_PATH = path.join(fixtureDirectory, "settings.json");

fs.writeFileSync(
  process.env.ENDPOINTS_PATH,
  JSON.stringify({
    v1: {
      name: "With policy",
      url: "https://api.example.com",
      tokens: ["token-one"],
      apiFormat: "openai",
      bodyParams: { add: { reasoning_effort: "high", stop: ["END"] }, strip: ["frequency_penalty"] },
    },
    v2: {
      name: "Legacy",
      url: "https://api2.example.com",
      tokens: ["token-two"],
      apiFormat: "openai",
    },
  }),
);
fs.writeFileSync(
  process.env.MODELS_PATH,
  JSON.stringify({
    models: { "gpt-x": { backend: "gpt-x", version: "v1", pricing: { input: 0, output: 0 } } },
  }),
);
fs.writeFileSync(process.env.SETTINGS_PATH, JSON.stringify({}));

const { default: Config } = await import("../config/index.js");
const { getEndpointForConcreteModel, loadModelsFromFile } = await import("../utils/helpers.js");
const { applyBodyParamPolicy } = await import("../utils/endpointPolicies.js");
const { getAdapter } = await import("../utils/adapters/index.js");

test("endpoint loading carries a body-param policy and defaults legacy endpoints to none", () => {
  Config.loadEndpoints();

  assert.deepEqual(Config.ENDPOINTS.v1.bodyParams, {
    add: { reasoning_effort: "high", stop: ["END"] },
    strip: ["frequency_penalty"],
  });
  // An endpoint written before the feature existed must not inherit a policy.
  assert.equal(Config.ENDPOINTS.v2.bodyParams, null);
});

test("resolved endpoint metadata reaches the routes with the policy attached", async () => {
  Config.loadEndpoints();
  loadModelsFromFile();

  const resolved = await getEndpointForConcreteModel("gpt-x", { ignoreState: true });
  assert.deepEqual(resolved.bodyParams, {
    add: { reasoning_effort: "high", stop: ["END"] },
    strip: ["frequency_penalty"],
  });

  // The policy runs on the adapter's finished body, which is what both route
  // handlers send: added params appear, stripped ones are gone, and the params
  // the proxy owns are untouched.
  const body = getAdapter("openai").transformStreamRequest(
    { messages: [{ role: "user", content: "hi" }], temperature: 0.7, frequency_penalty: 0.4 },
    "gpt-x",
    {},
  );
  applyBodyParamPolicy(body, resolved.bodyParams);

  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.stop, ["END"]);
  assert.equal("frequency_penalty" in body, false);
  assert.equal(body.model, "gpt-x");
  assert.equal(body.stream, true);
});

after(() => {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});
