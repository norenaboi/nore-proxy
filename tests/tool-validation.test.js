import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { validateToolCatalog } from "../middleware/toolValidation.js";
import { normalizeToolCatalog, ToolValidationError } from "../utils/toolValidation.js";

const schema = { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } }, required: ["value"] };
function tool(protocol, name = "lookup", parameters = schema) {
  return protocol === "openai"
    ? { type: "function", function: { name, description: "synthetic", parameters } }
    : { name, description: "synthetic", input_schema: parameters };
}
function expectError(work, code, param) {
  assert.throws(work, (error) => {
    assert.ok(error instanceof ToolValidationError);
    assert.equal(error.code, code);
    assert.equal(error.param, param);
    return true;
  });
}

for (const protocol of ["openai", "anthropic"]) {
  test(`${protocol}: preserves no-tools values and deduplicates without mutation`, () => {
    for (const value of [undefined, null]) assert.equal(normalizeToolCatalog(value, protocol), value);
    assert.deepEqual(normalizeToolCatalog([], protocol), []);
    const first = tool(protocol);
    const other = tool(protocol, "other");
    const reordered = { required: ["value"], properties: schema.properties, type: "object" };
    const input = [first, tool(protocol, "lookup", reordered), other];
    const snapshot = structuredClone(input);
    assert.deepEqual(normalizeToolCatalog(input, protocol), [first, other]);
    assert.deepEqual(input, snapshot);
    assert.equal(normalizeToolCatalog(input, protocol)[0], first);
    for (const name of ["__proto__", "constructor", "functions.lookup", " lookup "]) {
      const declaration = tool(protocol, name);
      assert.deepEqual(normalizeToolCatalog([declaration, structuredClone(declaration)], protocol), [declaration]);
    }
  });

  test(`${protocol}: detects schema and metadata conflicts with original indexes`, () => {
    const first = tool(protocol);
    const conflict = tool(protocol, "lookup", { type: "object", properties: { other: { type: "boolean" } } });
    const input = [first, structuredClone(first), tool(protocol, "other"), conflict];
    const snapshot = structuredClone(input);
    expectError(() => normalizeToolCatalog(input, protocol), "conflicting_tool_definitions", "tools[3]");
    assert.throws(() => normalizeToolCatalog(input, protocol), /tools\[3\] conflicts with tools\[0\]/);
    assert.deepEqual(input, snapshot);
    for (const extra of [{ cache_control: { type: "ephemeral" } }, { defer_loading: true }, { strict: false }]) {
      expectError(() => normalizeToolCatalog([first, { ...first, ...extra }], protocol), "conflicting_tool_definitions", "tools[1]");
    }
    const a = tool(protocol, "lookup", { type: "object", required: ["a", "b"] });
    const b = tool(protocol, "lookup", { type: "object", required: ["b", "a"] });
    expectError(() => normalizeToolCatalog([a, b], protocol), "conflicting_tool_definitions", "tools[1]");
  });

  test(`${protocol}: rejects malformed structures and blank names`, () => {
    for (const catalog of [{}, "tools", true, 1]) {
      expectError(() => normalizeToolCatalog(catalog, protocol), "invalid_tools", "tools");
    }
    for (const entry of [null, [], "lookup", 1, false]) {
      expectError(() => normalizeToolCatalog([entry], protocol), "invalid_tools", "tools[0]");
    }
    for (const name of [null, 1, {}, "", " \t\n"]) {
      const declaration = tool(protocol, name);
      expectError(() => normalizeToolCatalog([declaration], protocol), "invalid_tool_name", protocol === "openai" ? "tools[0].function.name" : "tools[0].name");
    }
    const missing = protocol === "openai" ? { type: "function", function: {} } : {};
    expectError(() => normalizeToolCatalog([missing], protocol), "invalid_tool_name", protocol === "openai" ? "tools[0].function.name" : "tools[0].name");
    for (const type of [null, "", " ", 2, {}]) {
      expectError(() => normalizeToolCatalog([{ ...tool(protocol), type }], protocol), "invalid_tools", "tools[0].type");
    }
  });

  test(`${protocol}: diagnostics are bounded and never echo schema or description`, () => {
    const name = "lookup\n\u001b‮" + "x".repeat(1000);
    const a = tool(protocol, name);
    const b = { ...a, description: "SECRET_DESCRIPTION", extra: { secret: "SECRET_SCHEMA" } };
    assert.throws(() => normalizeToolCatalog([a, b], protocol), (error) => {
      assert.ok(error.message.length < 350);
      assert.doesNotMatch(error.message, /[\n\u001b‮]|SECRET_DESCRIPTION|SECRET_SCHEMA/);
      assert.match(error.message, /\\n/);
      return true;
    });
  });
}

test("OpenAI validates function envelopes but leaves explicit native types opaque", () => {
  for (const value of [undefined, null, [], "function"]) {
    expectError(() => normalizeToolCatalog([{ type: "function", function: value }], "openai"), "invalid_tools", "tools[0].function");
  }
  expectError(() => normalizeToolCatalog([{ function: { name: "lookup" } }], "openai"), "invalid_tools", "tools[0].type");
  const native = [{ type: "web_search" }, { type: "custom", custom: { name: "lookup", format: { type: "text" } } }];
  assert.deepEqual(normalizeToolCatalog([...native, native[0]], "openai"), [...native, native[0]]);
});

test("Anthropic native tools retain their metadata and need not have custom schemas or names", () => {
  const native = [
    { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
    { type: "mcp_toolset", mcp_server_name: "synthetic" },
  ];
  const custom = { ...tool("anthropic"), type: "custom", defer_loading: true };
  const input = [...native, native[0], custom, structuredClone(custom)];
  assert.deepEqual(normalizeToolCatalog(input, "anthropic"), [...native, native[0], custom]);
});

test("middleware preserves the original body and forwards unexpected failures", () => {
  const declaration = tool("openai");
  const body = { tools: [declaration, structuredClone(declaration)], tool_choice: { type: "function", function: { name: "lookup" } } };
  const snapshot = structuredClone(body);
  const req = { body };
  let calls = 0;
  validateToolCatalog("openai")(req, {}, (error) => { assert.equal(error, undefined); calls++; });
  assert.equal(calls, 1);
  assert.notEqual(req.body, body);
  assert.deepEqual(body, snapshot);
  assert.deepEqual(req.body.tools, [declaration]);
  assert.equal(req.body.tool_choice, body.tool_choice);
  const failure = new Error("unexpected");
  validateToolCatalog("openai")({ get body() { throw failure; } }, {}, (error) => assert.equal(error, failure));
});

test("isolated HTTP middleware validates before dispatch and preserves authentication precedence", async () => {
  const app = express();
  app.use(express.json({ strict: false }));
  let dispatched = 0;
  for (const protocol of ["openai", "anthropic"]) {
    app.post(`/${protocol}`, (req, res, next) => {
      if (req.headers.authorization !== "Bearer synthetic") return res.status(401).json({ error: "unauthorized" });
      next();
    }, validateToolCatalog(protocol), (req, res) => {
      dispatched++;
      res.json(req.body);
    });
  }
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(protocol, body, authorized = true) {
    return fetch(`${base}/${protocol}`, { method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer synthetic" } : {}) }, body: JSON.stringify(body) });
  }
  try {
    for (const protocol of ["openai", "anthropic"]) {
      const first = tool(protocol);
      const invalid = { tools: [first, tool(protocol, "lookup", {})] };
      const before = dispatched;
      const unauthenticated = await post(protocol, invalid, false);
      assert.equal(unauthenticated.status, 401);
      await unauthenticated.arrayBuffer();
      for (const stream of [false, true]) {
        const response = await post(protocol, { ...invalid, stream });
        assert.equal(response.status, 400);
        assert.match(response.headers.get("content-type"), /application\/json/);
        const error = await response.json();
        assert.equal(error.error.type, "invalid_request_error");
        assert.equal(error.error.code, "conflicting_tool_definitions");
        if (protocol === "anthropic") assert.equal(error.type, "error");
        else assert.equal(error.error.param, "tools[1]");
      }
      for (const body of [null, [], "bad", { tools: {} }]) {
        const response = await post(protocol, body);
        assert.equal(response.status, 400);
        await response.arrayBuffer();
      }
      assert.equal(dispatched, before);
      const choice = protocol === "openai" ? { type: "function", function: { name: "lookup" } } : { type: "tool", name: "lookup" };
      for (const stream of [false, true]) {
        const response = await post(protocol, { tools: [first, structuredClone(first)], tool_choice: choice, stream });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { tools: [first], tool_choice: choice, stream });
      }
      for (const body of [{}, { tools: null }, { tools: [] }]) {
        const response = await post(protocol, body);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), body);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
