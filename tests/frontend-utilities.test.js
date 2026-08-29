import assert from "node:assert/strict";
import test from "node:test";

import { deadTargets, effectiveModelName, filterModelNames, isDuplicateModelName, mergeTargets, moveTargetTo, numericInputValue, targetHealth } from "../frontend/src/admin/modelForm.js";
import {
  extractHeaderPresets,
  mergeBulkTokens,
  mergeHeaderPresets,
  parseCustomHeaders,
  removeTokenAt,
  serializeCustomHeaders,
} from "../frontend/src/lib/endpoints/editor.js";
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
import {
  groupStatusModels,
  providerCounts,
  statusMatchesFilter,
  statusTotals,
  worstStatus,
} from "../frontend/src/lib/status.js";

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

  // Only the o-series counts as OpenAI, not every id that happens to start with "o".
  assert.equal(getProvider("o3-mini"), "OpenAI");
  assert.equal(getProvider("o1"), "OpenAI");
  assert.equal(getProvider("or-deepseek-r1"), "DeepSeek");
  assert.equal(getProvider("openrouter-kimi-k2"), "MoonshotAI");
  assert.equal(getProvider("omni-router"), "Others");
  assert.equal(getProvider("gpt-4o"), "OpenAI");

  // A routing prefix never outranks the model family that follows it.
  assert.equal(getProvider("kiro-glm-5"), "ZhipuAI");
  assert.equal(getProvider("kiro-claude-opus-5"), "Anthropic");
  assert.equal(getProvider("openai-gpt-5.6-sol"), "OpenAI");
  assert.equal(getProvider("models/nano-banana-pro-preview"), "Google");
  assert.equal(getProvider("harvester"), "Others");

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

test("status helpers roll up categories and group filtered models without mutating input", () => {
  const models = [
    { model_name: "gpt-zeta", success_rate: 100, avg_latency_ms: 10, status: "operational", series: [] },
    { model_name: "claude-beta", success_rate: 99.5, avg_latency_ms: 20, status: "minor", series: [] },
    { model_name: "claude-alpha", success_rate: 96, avg_latency_ms: 30, status: "degraded", series: [] },
    { model_name: "gemini-down", success_rate: 90, avg_latency_ms: 40, status: "major", series: [] },
    { model_name: "gemini-new", success_rate: 0, avg_latency_ms: 0, status: "unknown", series: [] },
  ];
  const originalOrder = models.map((model) => model.model_name);

  assert.equal(statusMatchesFilter("minor", "degraded"), true);
  assert.equal(statusMatchesFilter("degraded", "degraded"), true);
  assert.equal(statusMatchesFilter("major", "down"), true);
  assert.equal(statusMatchesFilter("unknown", "down"), true);
  assert.equal(statusMatchesFilter("operational", "down"), false);
  assert.equal(worstStatus(["operational", "minor", "major"]), "major");
  assert.equal(worstStatus([]), "unknown");
  assert.deepEqual(statusTotals(models), { total: 5, operational: 1, degraded: 2, down: 2 });
  assert.deepEqual([...providerCounts(models)], [["Anthropic", 2], ["Google", 2], ["OpenAI", 1]]);

  const groups = groupStatusModels(models);
  assert.deepEqual(groups.map((group) => group.provider), ["Anthropic", "Google", "OpenAI"]);
  assert.deepEqual(groups[0].models.map((model) => model.model_name), ["claude-alpha", "claude-beta"]);
  assert.equal(groups[0].status, "degraded");
  assert.deepEqual(models.map((model) => model.model_name), originalOrder);

  assert.deepEqual(groupStatusModels(models, { query: "ANTHROPIC" }).map((group) => group.provider), ["Anthropic"]);
  assert.deepEqual(groupStatusModels(models, { query: "GPT-Z" })[0].models.map((model) => model.model_name), ["gpt-zeta"]);
  assert.deepEqual(
    groupStatusModels(models, { filter: "degraded", providers: new Set(["Anthropic"]) })[0].models.map((model) => model.model_name),
    ["claude-alpha", "claude-beta"],
  );
  assert.equal(groupStatusModels(models, { filter: "operational", providers: new Set(["Google"]) }).length, 0);
  assert.equal(groupStatusModels(models, { providers: new Set() }).length, 3);
});

test("model editor derives names and detects duplicates", () => {
  assert.equal(numericInputValue("12.5"), 12.5);
  assert.equal(numericInputValue(""), null);
  assert.equal(effectiveModelName("", "concrete", "provider-model"), "provider-model");
  assert.equal(isDuplicateModelName("existing", [{ name: "existing" }]), true);
  assert.equal(isDuplicateModelName("existing", [{ name: "existing" }], "existing"), false);
});

test("auto target health separates missing targets from disabled ones", () => {
  const models = [
    { name: "live", modelType: "concrete" },
    { name: "off", modelType: "concrete", disabled: true },
    { name: "router", modelType: "auto", targets: [] },
  ];
  const targets = ["live", "off", "router", "deleted"];

  assert.deepEqual([...targetHealth(targets, models)], [
    ["live", "live"],
    ["off", "disabled"],
    ["router", "missing"],
    ["deleted", "missing"],
  ]);
  // Only names nothing answers to are offered for removal: a disabled target
  // comes back on its own when it is re-enabled.
  assert.deepEqual(deadTargets(targets, models), ["router", "deleted"]);
  assert.deepEqual(deadTargets(["live"], models), []);
  assert.deepEqual(deadTargets([], models), []);
});

test("model target search filters names without changing their order", () => {  const names = ["Claude/Sonnet-5", "gemini-2.5-pro", "GPT-5 Mini"];

  assert.equal(filterModelNames(names, ""), names);
  assert.equal(filterModelNames(names, "   "), names);
  assert.deepEqual(filterModelNames(names, "CLAUDE/"), ["Claude/Sonnet-5"]);
  assert.deepEqual(filterModelNames(names, "2.5-"), ["gemini-2.5-pro"]);
  assert.deepEqual(filterModelNames(names, "GPT-5 M"), ["GPT-5 Mini"]);
  assert.deepEqual(filterModelNames(names, "-"), names);
  assert.deepEqual(filterModelNames(names, "missing"), []);
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

test('custom headers parse one "Name: value" pair per line', () => {
  assert.deepEqual(parseCustomHeaders(""), { ok: true, headers: {} });
  assert.deepEqual(parseCustomHeaders("   "), { ok: true, headers: {} });
  assert.deepEqual(parseCustomHeaders("X-A: 1"), { ok: true, headers: { "X-A": "1" } });

  // Blank lines are skipped, surrounding whitespace is trimmed, and only the first
  // colon separates a pair, so a value may hold colons of its own.
  assert.deepEqual(parseCustomHeaders("  X-A :  1  \n\n X-Ref: https://example.com:8443/a "), {
    ok: true,
    headers: { "X-A": "1", "X-Ref": "https://example.com:8443/a" },
  });
  assert.deepEqual(parseCustomHeaders("X-Empty:"), { ok: true, headers: { "X-Empty": "" } });

  assert.equal(parseCustomHeaders("X-A 1").ok, false);
  assert.equal(parseCustomHeaders("X-A: 1\nnope").error, 'Custom header line 2 must look like "Header: value"');
  assert.equal(parseCustomHeaders(": 1").error, "Custom header line 1 does not start with a valid header name");
  assert.equal(parseCustomHeaders("X A: 1").error, "Custom header line 1 does not start with a valid header name");
  assert.equal(parseCustomHeaders('{ "X-A": "1" }').ok, false);
  assert.equal(parseCustomHeaders("X-A: 1\nx-a: 2").error, 'Custom header "x-a" is listed more than once');
});

test("header presets extract case-insensitively and keep unrecognized headers arbitrary", () => {
  const extracted = extractHeaderPresets({
    "ANTHROPIC-BETA": "context-1m-2025-08-07",
    "Anthropic-Version": "2023-06-01",
    "user-agent": "my-app/2.0",
    "X-Keep": "keep-me",
  });
  assert.deepEqual(extracted.presets, {
    anthropicBeta: true,
    anthropicVersion: true,
    userAgent: true,
    userAgentValue: "my-app/2.0",
  });
  assert.deepEqual(extracted.rest, { "X-Keep": "keep-me" });

  // A preset name carrying a non-canonical value stays arbitrary so editing never rewrites it.
  const other = extractHeaderPresets({ "anthropic-beta": "some-other-beta" });
  assert.equal(other.presets.anthropicBeta, false);
  assert.deepEqual(other.rest, { "anthropic-beta": "some-other-beta" });

  assert.deepEqual(extractHeaderPresets(undefined).rest, {});
  assert.equal(extractHeaderPresets(undefined).presets.userAgentValue, "");
});

test("header presets merge once with canonical names and preserve arbitrary headers", () => {
  const merged = mergeHeaderPresets(
    { "X-Keep": "keep-me", "ANTHROPIC-BETA": "stale", "User-agent": "stale-agent" },
    { anthropicBeta: true, anthropicVersion: true, userAgent: true, userAgentValue: "  my-app/1.0  " },
  );
  assert.deepEqual(merged, {
    "X-Keep": "keep-me",
    "anthropic-beta": "context-1m-2025-08-07",
    "anthropic-version": "2023-06-01",
    "User-Agent": "my-app/1.0",
  });

  const noPresets = mergeHeaderPresets(
    { "anthropic-beta": "manual-value", "X-Keep": "keep-me" },
    { anthropicBeta: false, anthropicVersion: false, userAgent: false, userAgentValue: "" },
  );
  assert.deepEqual(noPresets, { "anthropic-beta": "manual-value", "X-Keep": "keep-me" });
});

test("header presets survive an edit and resubmit round trip", () => {
  const stored = {
    "Anthropic-Beta": "context-1m-2025-08-07",
    "user-agent": "my-app/3.1",
    "X-Trace": "on",
  };
  const { presets, rest } = extractHeaderPresets(stored);
  assert.equal(serializeCustomHeaders(rest), "X-Trace: on");

  const resubmitted = mergeHeaderPresets(parseCustomHeaders(serializeCustomHeaders(rest)).headers, presets);
  assert.deepEqual(resubmitted, {
    "X-Trace": "on",
    "anthropic-beta": "context-1m-2025-08-07",
    "User-Agent": "my-app/3.1",
  });
  assert.equal(serializeCustomHeaders({}), "");
  assert.equal(serializeCustomHeaders({ "X-A": "1", "X-B": "2" }), "X-A: 1\nX-B: 2");
});

test("auto model targets reorder to any position and guard bad indexes", () => {
  const targets = ["a", "b", "c", "d"];

  assert.deepEqual(moveTargetTo(targets, 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveTargetTo(targets, 0, 3), ["b", "c", "d", "a"]);
  assert.deepEqual(moveTargetTo(targets, 1, 2), ["a", "c", "b", "d"]);
  assert.deepEqual(moveTargetTo(targets, 0, 9), ["b", "c", "d", "a"]);
  assert.deepEqual(moveTargetTo(targets, 2, -4), ["c", "a", "b", "d"]);

  // Unchanged input is returned as-is so callers can skip redundant updates.
  assert.equal(moveTargetTo(targets, 1, 1), targets);
  assert.equal(moveTargetTo(targets, -1, 0), targets);
  assert.equal(moveTargetTo(targets, 4, 0), targets);
  assert.deepEqual(targets, ["a", "b", "c", "d"]);
});

test("auto model target merging appends new names in order without duplicates", () => {
  assert.deepEqual(mergeTargets(["a"], ["b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(mergeTargets(["a", "b"], ["b", "a"]), ["a", "b"]);
  assert.deepEqual(mergeTargets(["a"], ["c", "c", "b"]), ["a", "c", "b"]);
  assert.deepEqual(mergeTargets([], ["z", "", "y"]), ["z", "y"]);

  const existing = ["a"];
  assert.deepEqual(mergeTargets(existing, []), ["a"]);
  assert.deepEqual(existing, ["a"]);
});
