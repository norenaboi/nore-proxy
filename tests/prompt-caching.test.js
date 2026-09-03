import "./isolated-config.js";
import assert from "node:assert/strict";
import test from "node:test";

import { applyClaudePromptCaching } from "../utils/helpers.js";

test("Claude prompt caching uses the provider default lifetime when no TTL is configured", () => {
  const messages = [{ role: "user", content: "Hello" }];
  const result = applyClaudePromptCaching(messages, 0);

  assert.deepEqual(result, [{
    role: "user",
    content: [{
      type: "text",
      text: "Hello",
      cache_control: { type: "ephemeral" },
    }],
  }]);
  assert.deepEqual(messages, [{ role: "user", content: "Hello" }]);
});

test("Claude prompt caching adds the one-hour TTL to injected breakpoints", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "Hello" }],
  }];
  const result = applyClaudePromptCaching(messages, 0, "1h");

  assert.deepEqual(result, [{
    role: "user",
    content: [{
      type: "text",
      text: "Hello",
      cache_control: { type: "ephemeral", ttl: "1h" },
    }],
  }]);
  assert.deepEqual(messages, [{
    role: "user",
    content: [{ type: "text", text: "Hello" }],
  }]);
});
