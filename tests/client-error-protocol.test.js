import "./isolated-config.js";
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import express from "express";

// End-to-end checks for the error envelope every client sees, wired the same
// way server.ts wires it: verifyApiKey in front of the route, the global
// body-parser, and the protocol-aware 404/error handlers behind it.
import { verifyApiKey } from "../middleware/auth.js";
import {
  applyRetryAfter,
  clientErrorBody,
  protocolForPath,
} from "../utils/clientErrors.js";

process.env.MASTER_KEY ??= "test-only-master-key-value";
delete process.env.DATABASE_URL;

const { default: apiKeyManager } = await import("../services/apiKeyManager.js");

// The manager reads API_KEY_DB_PATH at construction; point it at a scratch
// file before it is built.
const { default: os } = await import("node:os");
const { default: fs } = await import("node:fs");
const { default: path } = await import("node:path");
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-error-protocol-"));
process.env.API_KEY_DB_PATH = path.join(scratchDir, "api_keys.db");
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

// verifyApiKey resolves the same singleton, so this is the instance the
// middleware actually authenticates against.
await apiKeyManager.initialize();
const rawKey = "sk-" + "E".repeat(48);
await apiKeyManager.addKey(rawKey, "Error protocol key");
test.after(async () => { await apiKeyManager.close(); });

function buildApp() {
  const app = express();
  app.use(express.json({ strict: false }));
  app.post("/v1/messages", verifyApiKey, (_req, res) => res.json({ ok: true }));
  app.post("/v1/chat/completions", verifyApiKey, (_req, res) => res.json({ ok: true }));

  // 404 + error handlers, same as server.ts
  app.use(async (req, res) => {
    if (protocolForPath(req.path) === "anthropic") {
      return res.status(404).json({
        type: "error",
        error: { type: "not_found_error", message: `Not found: ${req.method} ${req.path}` },
      });
    }
    if (req.path.startsWith("/v1/")) {
      return res.status(404).json({
        error: { message: `Not found: ${req.method} ${req.path}`, code: "not_found" },
      });
    }
    res.status(404).json({ error: "Not found" });
  });
  const errorHandler = (err, req, res, _next) => {
    applyRetryAfter(res, err);
    res.status(err.statusCode || 500).json(
      clientErrorBody(
        { message: err.statusCode ? err.message : "Internal server error" },
        err.statusCode,
        protocolForPath(req.path),
      ),
    );
  };
  app.use(errorHandler);
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

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("auth rejections on /v1/messages are Anthropic-shaped, not OpenAI-shaped", async () => {
  await withServer(async (base) => {
    const missing = await post(base, "/v1/messages", { model: "m" });
    assert.equal(missing.status, 401);
    const missingBody = await missing.json();
    assert.equal(missingBody.type, "error");
    assert.equal(missingBody.error.type, "authentication_error");
    assert.match(missingBody.error.message, /Authorization: Bearer/);

    const invalid = await post(base, "/v1/messages", { model: "m" }, { Authorization: "Bearer sk-wrong" });
    assert.equal(invalid.status, 401);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.type, "error");
    assert.equal(invalidBody.error.type, "authentication_error");
    assert.equal(invalidBody.error.message, "Invalid API Key");
  });
});

test("auth rejections on /v1/chat/completions keep the OpenAI shape", async () => {
  await withServer(async (base) => {
    const response = await post(base, "/v1/chat/completions", { model: "m" });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.deepEqual(body, {
      error: { message: "Invalid authorization header format. Expected 'Authorization: Bearer <token>'." },
    });
  });
});

test("malformed JSON bodies get the parser message in the route's protocol shape", async () => {
  await withServer(async (base) => {
    const openai = await post(base, "/v1/chat/completions", "{not json", { Authorization: `Bearer ${rawKey}` });
    assert.equal(openai.status, 400);
    const openaiBody = await openai.json();
    assert.match(openaiBody.error.message, /not valid JSON|property name|JSON at position/);
    assert.equal(typeof openaiBody.error.message, "string");

    const anthropic = await post(base, "/v1/messages", "{not json", { Authorization: `Bearer ${rawKey}` });
    assert.equal(anthropic.status, 400);
    const anthropicBody = await anthropic.json();
    assert.equal(anthropicBody.type, "error");
    assert.equal(anthropicBody.error.type, "invalid_request_error");
    assert.match(anthropicBody.error.message, /JSON|property name/);
  });
});

test("unknown /v1 paths answer with a proper error instead of a bare string", async () => {
  await withServer(async (base) => {
    const openai = await post(base, "/v1/unknown", {});
    assert.equal(openai.status, 404);
    const openaiBody = await openai.json();
    assert.deepEqual(openaiBody, {
      error: { message: "Not found: POST /v1/unknown", code: "not_found" },
    });

    const anthropic = await post(base, "/v1/messages/count_tokens", {});
    assert.equal(anthropic.status, 404);
    const anthropicBody = await anthropic.json();
    assert.equal(anthropicBody.type, "error");
    assert.equal(anthropicBody.error.type, "not_found_error");
  });
});

test("valid keys still pass through and dispatch normally", async () => {
  await withServer(async (base) => {
    for (const path of ["/v1/messages", "/v1/chat/completions"]) {
      const response = await post(base, path, { model: "m" }, { Authorization: `Bearer ${rawKey}` });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
  });
});
