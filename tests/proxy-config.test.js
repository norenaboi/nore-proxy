import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolated configuration only: this exercises the endpoints.json/proxies.json
// load paths and the proxy manager's persistence, so it must never read or
// write the deployed files. MASTER_KEY is required by config validation and is
// a throwaway value with no deployment meaning.
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nore-proxy-config-"));
process.env.MASTER_KEY = "test-only-master-key";
process.env.ENDPOINTS_PATH = path.join(fixtureDirectory, "endpoints.json");
process.env.MODELS_PATH = path.join(fixtureDirectory, "models.json");
process.env.SETTINGS_PATH = path.join(fixtureDirectory, "settings.json");
process.env.PROXIES_PATH = path.join(fixtureDirectory, "proxies.json");

fs.writeFileSync(
  process.env.ENDPOINTS_PATH,
  JSON.stringify({
    v1: {
      name: "Proxied",
      url: "https://api.example.com",
      tokens: ["token-one"],
      apiFormat: "openai",
      proxyId: "p1",
    },
    v2: {
      name: "Legacy",
      url: "https://api2.example.com",
      tokens: ["token-two"],
      apiFormat: "openai",
    },
    v3: {
      name: "Stale reference",
      url: "https://api3.example.com",
      tokens: ["token-three"],
      apiFormat: "openai",
      proxyId: "p-missing",
    },
  }),
);
fs.writeFileSync(
  process.env.MODELS_PATH,
  JSON.stringify({
    models: {
      "gpt-x": { backend: "gpt-x", version: "v1", pricing: { input: 0, output: 0 } },
      "gpt-legacy": { backend: "gpt-legacy", version: "v2", pricing: { input: 0, output: 0 } },
    },
  }),
);
fs.writeFileSync(process.env.SETTINGS_PATH, JSON.stringify({}));
fs.writeFileSync(
  process.env.PROXIES_PATH,
  JSON.stringify({
    proxies: {
      p1: { name: "Residential", type: "http", host: "proxy.example.com", port: 8080, username: "user", password: "secret-password-1" },
      p2: { type: "socks5", host: "127.0.0.1", port: 1080 },
      "not-a-proxy": { type: "http", host: "bad-id.example.com", port: 8080 },
    },
  }),
);

test.after(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));

const { default: Config } = await import("../config/index.js");
const { getEndpointForConcreteModel, loadModelsFromFile } = await import("../utils/helpers.js");
const { default: proxyManager } = await import("../services/proxyManager.js");
const { proxyAgentsFor } = await import("../utils/proxyAgents.js");
const {
  isMaskedProxyPassword,
  maskProxyPassword,
  validateProxyConfig,
} = await import("../shared/contracts/proxies.js");

test("proxy validation accepts a full definition and normalizes blank optionals", () => {
  const result = validateProxyConfig({
    name: "  Datacenter  ",
    type: "socks5",
    host: "  socks.example.com  ",
    port: "1080",
    username: " ",
    password: "",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { name: "Datacenter", type: "socks5", host: "socks.example.com", port: 1080 });
});

test("proxy validation rejects malformed definitions with a named field", () => {
  const cases = [
    [{ host: "h", port: 1, type: "nope" }, "type"],
    [{ host: "h", port: 1 }, "type"],
    [{ type: "http", port: 1 }, "host"],
    [{ type: "http", host: "http://h", port: 1 }, "host"],
    [{ type: "http", host: "has space", port: 1 }, "host"],
    [{ type: "http", host: "h", port: 0 }, "port"],
    [{ type: "http", host: "h", port: 70000 }, "port"],
    [{ type: "http", host: "h", port: 1.5 }, "port"],
    [{ type: "http", host: "h", port: 1, username: 5 }, "username"],
    [{ type: "http", host: "h", port: 1, password: true }, "password"],
  ];
  for (const [input, field] of cases) {
    const result = validateProxyConfig(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.ok(result.error.toLowerCase().includes(field), result.error);
  }
});

test("proxy passwords mask like endpoint tokens and round-trip as placeholders", () => {
  assert.equal(maskProxyPassword("secret-password-1"), "secr****rd-1");
  assert.equal(isMaskedProxyPassword("secr****rd-1"), true);
  assert.equal(maskProxyPassword("short"), "****");
  assert.equal(isMaskedProxyPassword("secr****ord-1"), true);
  assert.equal(isMaskedProxyPassword("plain"), false);
});

test("endpoint loading carries the proxy reference and defaults legacy endpoints to direct", () => {
  Config.loadEndpoints();

  assert.equal(Config.ENDPOINTS.v1.proxyId, "p1");
  assert.equal(Config.ENDPOINTS.v2.proxyId, null);
});

test("resolved endpoint metadata reaches the routes with the proxy reference attached", async () => {
  Config.loadEndpoints();
  loadModelsFromFile();

  const resolved = await getEndpointForConcreteModel("gpt-x", { ignoreState: true });
  assert.equal(resolved.proxyId, "p1");

  const legacy = await getEndpointForConcreteModel("gpt-legacy", { ignoreState: true });
  assert.equal(legacy.proxyId, null);
});

test("the manager loads proxies.json, skipping invalid entries without dropping valid ones", () => {
  // p1 and p2 from the fixture; the malformed id is skipped at load.
  assert.equal(proxyManager.has("p1"), true);
  assert.equal(proxyManager.has("p2"), true);
  assert.equal(proxyManager.has("not-a-proxy"), false);

  const list = proxyManager.maskedList();
  assert.deepEqual(list.map((entry) => entry.id), ["p1", "p2"]);
  // The password never leaves the manager in raw form.
  assert.equal(list[0].password, "secr****rd-1");
  assert.equal(list[1].password, null);
  assert.equal(list[0].username, "user");
});

test("manager CRUD assigns fresh ids, persists atomically, and never reuses one", () => {
  const created = proxyManager.create({ type: "http", host: "new.example.com", port: 3128 });
  assert.match(created, /^p3$/);
  assert.equal(proxyManager.get(created).host, "new.example.com");

  const persisted = JSON.parse(fs.readFileSync(process.env.PROXIES_PATH, "utf-8"));
  assert.equal(persisted.proxies.p3.host, "new.example.com");

  assert.equal(proxyManager.update(created, { type: "socks4", host: "other.example.com", port: 1080 }), true);
  assert.equal(proxyManager.get(created).type, "socks4");
  assert.equal(proxyManager.update("p-missing", { type: "http", host: "h", port: 1 }), false);

  assert.equal(proxyManager.remove(created), true);
  assert.equal(proxyManager.has(created), false);
  assert.equal(proxyManager.remove(created), false);

  // A removed id stays retired: the next create moves past it.
  const next = proxyManager.create({ type: "http", host: "again.example.com", port: 3128 });
  assert.match(next, /^p4$/);
  proxyManager.remove(next);
});

test("agent lookup returns null for direct connections and unknown references", () => {
  assert.equal(proxyAgentsFor(null), null);
  assert.equal(proxyAgentsFor(undefined), null);
  assert.equal(proxyAgentsFor(""), null);
  // An endpoint with a stale proxy id must degrade to direct rather than fail.
  assert.equal(proxyAgentsFor("p-missing"), null);
});

test("agent lookup builds agents for configured proxies and swaps them after an edit", () => {
  const first = proxyAgentsFor("p1");
  assert.ok(first && first.httpAgent && first.httpsAgent, "expected agents for a configured proxy");

  // Healthy proxies keep their pooled agent across requests.
  assert.equal(proxyAgentsFor("p1"), first);

  // Editing the proxy config invalidates the cache on the next request.
  const original = proxyManager.get("p1");
  proxyManager.update("p1", { ...original, password: "rotated-secret-2" });
  const second = proxyAgentsFor("p1");
  assert.notEqual(second, first);
  // The stored secret is what the agent URL was built from, not the mask.
  assert.equal(proxyManager.get("p1").password, "rotated-secret-2");

  proxyManager.update("p1", original);
  assert.notEqual(proxyAgentsFor("p1"), second);
});
