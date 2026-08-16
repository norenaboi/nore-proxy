import assert from "node:assert/strict";
import test from "node:test";

import { numericInputValue, effectiveModelName, isDuplicateModelName } from "../frontend/src/admin/modelForm.js";
import { mergeBulkTokens, removeTokenAt } from "../frontend/src/lib/endpoints/editor.js";
import {
  clearModelCache,
  formatModelName,
  formatPrice,
  getProvider,
  normalizeModels,
  readModelCache,
  writeModelCache,
} from "../frontend/src/lib/models/catalog.js";
import {
  applyPublicTheme,
  PUBLIC_THEME_KEY,
  readPublicTheme,
  setPublicTheme,
} from "../frontend/src/lib/publicTheme.js";

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key) { return this.values.get(key) ?? null; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, value); }
}

test("public theme normalizes, applies, persists, and tolerates storage failures", () => {
  const storage = new MemoryStorage();
  const root = { dataset: {} };

  assert.equal(readPublicTheme(storage), "light");
  storage.setItem(PUBLIC_THEME_KEY, "invalid");
  assert.equal(readPublicTheme(storage), "light");
  storage.setItem(PUBLIC_THEME_KEY, "dark");
  assert.equal(readPublicTheme(storage), "dark");

  assert.equal(applyPublicTheme("dark", root), "dark");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(setPublicTheme("light", storage, root), "light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(storage.getItem(PUBLIC_THEME_KEY), "light");

  const throwingStorage = {
    getItem() { throw new Error("unavailable"); },
    setItem() { throw new Error("unavailable"); },
  };
  assert.equal(readPublicTheme(throwingStorage), "light");
  assert.equal(setPublicTheme("dark", throwingStorage, root), "dark");
  assert.equal(root.dataset.theme, "dark");
});

test("model catalog classifies, normalizes, caches, and formats models", () => {
  assert.equal(getProvider("claude-sonnet-5"), "Anthropic");
  assert.equal(getProvider("gemini-2.5-pro"), "Google");
  assert.equal(getProvider("gpt-5"), "OpenAI");

  const models = normalizeModels({
    object: "list",
    data: [
      { id: "gpt-5", pricing: null },
      { id: "claude-sonnet-5", pricing: { input: 3 } },
    ],
  });
  assert.deepEqual(models.map((model) => model.id), ["claude-sonnet-5", "gpt-5"]);
  assert.deepEqual(models[0].pricing, { input: 3, output: 0, cache_write: 0, cache_read: 0 });

  const storage = new MemoryStorage();
  writeModelCache(storage, models);
  assert.deepEqual(readModelCache(storage), models);
  clearModelCache(storage);
  assert.equal(readModelCache(storage), null);
  assert.equal(formatModelName("deepseek-v4-pro"), "Deepseek V4 Pro");
  assert.equal(formatModelName("gpt-5"), "GPT 5");
  assert.equal(formatModelName("glm-4.5-air"), "GLM 4.5 Air");
  assert.equal(formatModelName("claude-opus-4-8"), "Claude Opus 4.8");
  assert.equal(formatModelName("claude-3-5-sonnet"), "Claude 3.5 Sonnet");
  assert.equal(formatModelName("claude-3-7-sonnet-20250219"), "Claude 3.7 Sonnet 20250219");
  assert.equal(formatModelName("gpt-4-32k"), "GPT 4 32k");
  assert.equal(formatPrice(0.003), "$0.003");
});

test("model editor derives names and detects duplicates", () => {
  assert.equal(numericInputValue("12.5"), 12.5);
  assert.equal(numericInputValue(""), null);
  assert.equal(effectiveModelName("", "concrete", "provider-model"), "provider-model");
  assert.equal(isDuplicateModelName("existing", [{ name: "existing" }]), true);
  assert.equal(isDuplicateModelName("existing", [{ name: "existing" }], "existing"), false);
});

test("endpoint token editing skips duplicates and remaps confirmations", () => {
  const merged = mergeBulkTokens(["abcd****wxyz"], "abcd1234wxyz\nnew-token\nnew-token");
  assert.deepEqual(merged, {
    tokens: ["abcd****wxyz", "new-token"],
    added: 1,
    skipped: 2,
  });

  const removed = removeTokenAt(["a", "b", "c"], new Set([0, 2]), 1);
  assert.deepEqual(removed.tokens, ["a", "c"]);
  assert.deepEqual([...removed.pendingConfirmations], [0, 1]);
});
