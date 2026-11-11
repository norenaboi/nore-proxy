import "./isolated-config.js";
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

// Claude Code's auto-mode server-side safety check piggybacks on ordinary
// POST /v1/messages requests: the client adds an `anthropic-beta` value and a
// `safeguards` body field, and the upstream's verdict rides back on the normal
// response. These tests mount the real messages route against a mock Anthropic
// upstream on loopback and assert the header and the body field both arrive
// there, for streaming and non-streaming requests alike.

delete process.env.DATABASE_URL;

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-anthropic-headers-"));
process.env.API_KEY_DB_PATH = path.join(scratchDir, "api_keys.db");
process.env.KEY_STATE_DB_PATH = path.join(scratchDir, "key_states.db");
process.env.LOG_DB_PATH = path.join(scratchDir, "logs.db");

const BETA_VALUE = "claude-code-20250219,safeguards-2025-04-21";

// Requests the mock upstream receives, in arrival order.
const upstreamRequests = [];

// A minimal native-Anthropic upstream. It answers /v1/messages with either a
// complete message (non-streaming) or a full SSE sequence (streaming), and
// records the exact headers and body the proxy forwarded.
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    upstreamRequests.push({
      url: req.url,
      headers: req.headers,
      body: parsed,
    });
    if (parsed.stream === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      for (const [event, data] of events) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    }));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

test.after(async () => {
  upstream.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

// The proxy reads models and endpoints from the isolated-config scratch paths.
fs.writeFileSync(
  process.env.ENDPOINTS_PATH,
  JSON.stringify({
    v1: {
      name: "Mock Anthropic",
      url: upstreamBase,
      tokens: ["mock-upstream-token"],
      apiFormat: "anthropic",
    },
  }),
);
fs.writeFileSync(
  process.env.MODELS_PATH,
  JSON.stringify({
    models: { "mock-claude": { backend: "mock-claude", version: "v1", pricing: { input: 0, output: 0 } } },
  }),
);

const { default: apiKeyManager } = await import("../services/apiKeyManager.js");
const { default: keyStateManager } = await import("../services/keyStateManager.js");
const { default: logManager } = await import("../services/logManager.js");
const { default: Config } = await import("../config/index.js");
const { loadModelsFromFile } = await import("../utils/helpers.js");
const { verifyApiKey } = await import("../middleware/auth.js");
const { default: messagesRoutes } = await import("../routes/messages.js");

await Promise.all([
  apiKeyManager.initialize(),
  keyStateManager.initialize(),
  logManager.initialize(),
]);
Config.loadEndpoints();
loadModelsFromFile();

const rawKey = "sk-" + "H".repeat(48);
await apiKeyManager.addKey(rawKey, "Header passthrough key");

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use(messagesRoutes);
  return app;
}

async function withServer(work) {
  const server = buildApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await work(base);
  } finally {
    server.close();
  }
}

function anthropicRequest(extraHeaders = {}) {
  return {
    model: "mock-claude",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    safeguards: { id: "test-safeguard-check" },
    ...extraHeaders,
  };
}

test("non-streaming: anthropic-beta header and safeguards field reach the upstream verbatim", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
        "anthropic-beta": BETA_VALUE,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicRequest()),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, "message");

    const seen = upstreamRequests.at(-1);
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers["anthropic-beta"], BETA_VALUE);
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    // The proxy's own auth is untouched: the client key never leaks upstream
    // and the endpoint token is presented as the Anthropic credential.
    assert.equal(seen.headers["x-api-key"], "mock-upstream-token");
    assert.equal(seen.headers.authorization, undefined);
    // The safety-check body field survives the proxy→upstream hop.
    assert.deepEqual(seen.body.safeguards, { id: "test-safeguard-check" });
  });
});

test("streaming: anthropic-beta header and safeguards field reach the upstream verbatim", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
        "anthropic-beta": BETA_VALUE,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ ...anthropicRequest(), stream: true }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const sseText = await response.text();
    assert.match(sseText, /message_start/);
    assert.match(sseText, /message_stop/);

    const seen = upstreamRequests.at(-1);
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers["anthropic-beta"], BETA_VALUE);
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.headers["x-api-key"], "mock-upstream-token");
    assert.deepEqual(seen.body.safeguards, { id: "test-safeguard-check" });
    assert.equal(seen.body.stream, true);
  });
});

test("requests without anthropic-* headers add nothing beyond the adapter's own", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify(anthropicRequest()),
    });

    assert.equal(response.status, 200);
    const seen = upstreamRequests.at(-1);
    const anthropicHeaders = Object.keys(seen.headers).filter((h) => h.startsWith("anthropic-"));
    // Only the adapter's own version header — no forwarded values.
    assert.deepEqual(anthropicHeaders, ["anthropic-version"]);
  });
});

test("endpoint customHeaders still override forwarded client headers", async () => {
  // The operator's explicit endpoint header list is the stronger claim on the
  // upstream request, so a colliding client value must not win.
  fs.writeFileSync(
    process.env.ENDPOINTS_PATH,
    JSON.stringify({
      v1: {
        name: "Mock Anthropic",
        url: upstreamBase,
        tokens: ["mock-upstream-token"],
        apiFormat: "anthropic",
        headers: { "anthropic-beta": "operator-chosen-beta" },
      },
    }),
  );
  Config.loadEndpoints();

  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawKey}`,
        "anthropic-beta": BETA_VALUE,
      },
      body: JSON.stringify(anthropicRequest()),
    });

    assert.equal(response.status, 200);
    const seen = upstreamRequests.at(-1);
    assert.equal(seen.headers["anthropic-beta"], "operator-chosen-beta");
  });

  // Restore the plain endpoint for any later assertions in this file.
  fs.writeFileSync(
    process.env.ENDPOINTS_PATH,
    JSON.stringify({
      v1: {
        name: "Mock Anthropic",
        url: upstreamBase,
        tokens: ["mock-upstream-token"],
        apiFormat: "anthropic",
      },
    }),
  );
  Config.loadEndpoints();
});
