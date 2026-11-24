import "./isolated-config.js";
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

// When an upstream stream dies mid-response — a socket idle timeout abort, an
// upstream that simply closes without a terminal event — the client is left
// holding a half-finished Anthropic SSE sequence: an open content block and,
// on tool calls, argument JSON that was never completed. A strict consumer
// like Claude Code cannot continue its session on that. These tests mount the
// real messages route against mock upstreams that cut the stream mid-tool-call
// and assert the proxy closes the sequence for the client: content_block_stop,
// a message_delta, message_stop, and a repaired tool-input tail delta.

delete process.env.DATABASE_URL;

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-stream-rescue-"));
process.env.API_KEY_DB_PATH = path.join(scratchDir, "api_keys.db");
process.env.KEY_STATE_DB_PATH = path.join(scratchDir, "key_states.db");
process.env.LOG_DB_PATH = path.join(scratchDir, "logs.db");

// A native-Anthropic upstream that streams a tool call, then destroys the
// socket mid-argument-JSON without any terminal event.
const anthropicUpstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "mock-claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"rm -rf ' } }],
      // Next delta would have completed the arguments; the socket dies here.
    ];
    for (const [event, data] of events) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    // Give the socket time to flush the frames before tearing it down; an
    // immediate destroy would RST before the bytes leave the kernel buffer
    // and the proxy would see a connection error instead of a cut stream.
    setTimeout(() => res.destroy(), 100);
  });
});
await new Promise((resolve) => anthropicUpstream.listen(0, "127.0.0.1", resolve));

// An OpenAI-format upstream whose stream also dies mid tool-call, exercising
// the converted path and its tool-fragment repair tail.
const openaiUpstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"rm" } }] }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: " -rf /tmp/x" } }] }, finish_reason: null }] },
      // The closing arguments chunk never arrives; the socket dies instead.
    ];
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    setTimeout(() => res.destroy(), 100);
  });
});
await new Promise((resolve) => openaiUpstream.listen(0, "127.0.0.1", resolve));

test.after(async () => {
  anthropicUpstream.close();
  openaiUpstream.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

fs.writeFileSync(
  process.env.ENDPOINTS_PATH,
  JSON.stringify({
    v1: {
      name: "Cut Anthropic",
      url: `http://127.0.0.1:${anthropicUpstream.address().port}`,
      tokens: ["mock-upstream-token"],
      apiFormat: "anthropic",
    },
    v2: {
      name: "Cut OpenAI",
      url: `http://127.0.0.1:${openaiUpstream.address().port}`,
      tokens: ["mock-upstream-token"],
      apiFormat: "openai",
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

const rawKey = "sk-" + "R".repeat(48);
await apiKeyManager.addKey(rawKey, "Rescue key");

function parseSse(text) {
  const events = [];
  for (const record of text.split("\n\n")) {
    let type = null;
    let data = null;
    for (const line of record.split("\n")) {
      if (line.startsWith("event: ")) type = line.slice(7).trim();
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (type && data) {
      try { events.push({ type, data: JSON.parse(data) }); } catch { /* ignore */ }
    }
  }
  return events;
}

// Reconstruct what a client would consider the final tool input: concat every
// partial_json delta per block index and parse the result.
function toolInputOf(events, index) {
  let json = "";
  for (const event of events) {
    if (event.type === "content_block_delta" && event.data.index === index &&
        event.data.delta?.type === "input_json_delta") {
      json += event.data.delta.partial_json;
    }
  }
  return { json, parsed: JSON.parse(json) };
}

async function waitForStream(base) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({
      model: "mock-claude",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  return response.text();
}

test("anthropic passthrough: a stream cut mid-tool-call ends with valid framing", async () => {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use(messagesRoutes);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sseText = await waitForStream(base);
    const events = parseSse(sseText);

    assert.ok(events.some((e) => e.type === "message_start"));
    // The block the client saw opened is closed before the message terminates.
    assert.ok(events.some((e) => e.type === "content_block_stop" && e.data.index === 0));
    const deltas = events.filter((e) => e.type === "message_delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].data.delta.stop_reason, null);
    const stops = events.filter((e) => e.type === "message_stop");
    assert.equal(stops.length, 1);
    // message_stop is the last frame the client sees.
    assert.equal(events.at(-1).type, "message_stop");
    // No error event is appended: the rescue tail already terminated the
    // sequence, and an error frame after message_stop would confuse clients.
    assert.ok(!events.some((e) => e.type === "error"));
  } finally {
    server.close();
  }
});

test("openai conversion: a stream cut mid-tool-call delivers parseable tool input", async () => {
  // Point the model at the OpenAI-format upstream for this run.
  fs.writeFileSync(
    process.env.MODELS_PATH,
    JSON.stringify({
      models: { "mock-claude": { backend: "mock-openai", version: "v2", pricing: { input: 0, output: 0 } } },
    }),
  );
  loadModelsFromFile();

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use(messagesRoutes);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sseText = await waitForStream(base);
    const events = parseSse(sseText);

    assert.ok(events.some((e) => e.type === "message_start"));
    // The rescue flush emits the tool call as a completed block.
    const toolStarts = events.filter((e) => e.type === "content_block_start" &&
      e.data.content_block?.type === "tool_use");
    assert.equal(toolStarts.length, 1);
    assert.equal(toolStarts[0].data.content_block.name, "bash");
    const toolIndex = toolStarts[0].data.index;

    // Every argument fragment the client holds, joined, is valid JSON — the
    // repair tail delta closed the cut bracket.
    const { json, parsed } = toolInputOf(events, toolIndex);
    assert.deepEqual(parsed, { command: "rm -rf /tmp/x" });

    assert.ok(events.some((e) => e.type === "content_block_stop" && e.data.index === toolIndex));
    const stops = events.filter((e) => e.type === "message_stop");
    assert.equal(stops.length, 1);
    assert.equal(events.at(-1).type, "message_stop");
    assert.ok(!events.some((e) => e.type === "error"));
  } finally {
    server.close();
  }
});
