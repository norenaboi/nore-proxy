import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Config from "../config/index.js";
import settingsManager from "../services/settingsManager.js";
import keyStateManager from "../services/keyStateManager.js";
import { normalizeEndpointUrl } from "./endpointPolicies.js";
import { addModelPricing } from "./pricing.js";
import { getModelsPath } from "./configPaths.js";
import {
  resetAutoRoutingCounters,
  resolveAutoTargets,
  validateModelDefinition,
} from "./autoRouting.js";
import type { ModelDefinition, ModelPricingRegistry, ModelRegistry, RegisteredModel } from "../types/models.js";

type ModelLoadOptions = {
  excludeHashes?: Set<string>;
  ignoreState?: boolean;
  rotationOffset?: number;
};

type MessageContentBlock = Record<string, unknown>;
type OpenAIMessage = { content?: string | MessageContentBlock[]; [key: string]: unknown };

type ClientRequest = {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
};

export {
  normalizeEndpointUrl,
  getModelsUrl,
  getFullUrl,
  applyGenerationPolicy,
  applyBodyParamPolicy,
} from "./endpointPolicies.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model registry and aliases
export let MODEL_ALIASES: Record<string, string> = {};
export let MODEL_REGISTRY: ModelRegistry = {};
export let MODEL_PRICING: ModelPricingRegistry = {};

const ZERO_MODEL_PRICING = Object.freeze({
  input: 0,
  output: 0,
  cache_write: 0,
  cache_read: 0,
});

export function getModelPricing(modelName: any) {
  return MODEL_PRICING[modelName] || ZERO_MODEL_PRICING;
}

export function maskKey(key: any) {
  if (!key || key.length <= 8) return key ? "****" : key;
  return key.substring(0, 5) + "..." + key.substring(key.length - 3);
}

export function resolveModelName(modelName: any) {
  return MODEL_ALIASES[modelName] || modelName;
}

export function loadModelsFromFile() {
  MODEL_REGISTRY = {};
  MODEL_ALIASES = {};
  MODEL_PRICING = {};
  resetAutoRoutingCounters();

  const jsonPath = getModelsPath();

  try {
    if (!fs.existsSync(jsonPath)) {
      console.warn("models.json not found");
      return;
    }

    const content = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(content);
    const rawModels: Record<string, ModelDefinition> = data.models || {};
    const context = {
      models: rawModels,
      endpoints: Config.ENDPOINTS,
      globalCeiling: settingsManager.get("autoModelMaxTargetAttempts"),
    };

    for (const [displayName, modelConfig] of Object.entries(rawModels)) {
      addModelPricing(MODEL_PRICING, displayName, modelConfig);
      if (modelConfig.disabled === true || modelConfig.type === "auto") continue;

      const result = validateModelDefinition(displayName, modelConfig, context);
      if (!result.valid) {
        console.warn(`Skipping invalid model '${displayName}': ${result.errors.join("; ")}`);
        continue;
      }

      const definition = result.definition;
      if (!definition || definition.type !== "concrete") continue;
      const { backend, version } = definition;
      const actualBackend = `${backend}-${version}`;
      MODEL_ALIASES[displayName] = actualBackend;
      MODEL_REGISTRY[displayName] = {
        type: "chat",
        routingType: "concrete",
        capabilities: { outputCapabilities: {} },
        backend: actualBackend,
        version: version as `v${number}`,
        hidden: modelConfig.hidden === true,
      };
    }

    for (const [displayName, modelConfig] of Object.entries(rawModels)) {
      if (modelConfig.disabled === true || modelConfig.type !== "auto") continue;
      const result = validateModelDefinition(displayName, modelConfig, context);
      if (!result.valid) {
        console.warn(`Skipping invalid auto model '${displayName}': ${result.errors.join("; ")}`);
        continue;
      }
      const definition = result.definition;
      if (!definition || definition.type !== "auto") continue;
      // Concrete models are registered by the loop above, so the registry is
      // already complete enough to tell a live target from a dead one. Warn
      // rather than reject: routing skips the dead names, and taking the whole
      // auto model offline over one of them would be the worse failure.
      const { dropped } = resolveAutoTargets(definition.targets as string[], MODEL_REGISTRY);
      if (dropped.length > 0) {
        console.warn(
          `Auto model '${displayName}' has ${dropped.length} unroutable target(s) that will be skipped: ${dropped.join(", ")}`,
        );
      }
      MODEL_REGISTRY[displayName] = {
        type: "chat",
        routingType: "auto",
        capabilities: { outputCapabilities: {} },
        targets: definition.targets as string[],
        targetSelection: definition.targetSelection as "sticky" | "roundrobin",
        maxTargetAttempts: definition.maxTargetAttempts as number | null,
        hidden: modelConfig.hidden === true,
      };
    }
  } catch (error) {
    console.error("Error loading models:", error);
  }
}

/**
 * Determines if a model name refers to a Claude model.
 */
export function isClaudeModel(modelName: any) {
  return /claude/i.test(modelName);
}

/**
 * Applies Claude prompt caching to a messages array.
 *
 * cache_depth semantics:
 *   -1  → caching disabled, messages returned unchanged
 *    0  → cache every message
 *    N  → cache every message except the last N messages
 *         (i.e. messages[0 .. length-N] get cache_control)
 *
 * Cache breakpoints are inserted by adding `cache_control: { type: "ephemeral" }`
 * to the last content block of each eligible message, which is the format
 * OpenRouter (and the Anthropic API directly) understand. When ttl is `"1h"`,
 * it is included on each injected breakpoint; otherwise the provider default is used.
 *
 * @param {Array} messages - OpenAI-style messages array
 * @param {number} cacheDepth - cache depth value
 * @param {"1h" | undefined} ttl - optional Anthropic cache lifetime
 * @returns {Array} - new messages array with cache_control injected where appropriate
 */
export function applyClaudePromptCaching(messages: any, cacheDepth: any, ttl?: "1h") {
  // -1 means caching is disabled
  if (cacheDepth === -1) {
    return messages;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Determine the index boundary: messages at index < cacheUntil get cached
  // cacheDepth 0  → cache all  → cacheUntil = messages.length
  // cacheDepth N  → skip last N → cacheUntil = messages.length - N
  const cacheUntil = Math.max(0, messages.length - cacheDepth);

  // Anthropic allows a maximum of 4 cache breakpoints per request.
  // Pick up to 4 evenly distributed indices within the eligible range [0, cacheUntil).
  const MAX_BREAKPOINTS = 4;
  const eligibleCount = cacheUntil;
  const breakpointIndices = new Set();

  if (eligibleCount > 0) {
    const count = Math.min(MAX_BREAKPOINTS, eligibleCount);
    for (let i = 0; i < count; i++) {
      // Distribute evenly, always including the last eligible message
      const idx = Math.round((i / (count - 1 || 1)) * (eligibleCount - 1));
      breakpointIndices.add(idx);
    }
  }

  return messages.map((message, index) => {
    if (!breakpointIndices.has(index)) {
      return message;
    }

    return addCacheControlToMessage(message, ttl);
  });
}

/**
 * Adds a cache_control breakpoint to the last content block of a message.
 * Handles both string content and array-of-blocks content.
 */
function addCacheControlToMessage(message: any, ttl?: "1h") {
  if (!message || !message.content) {
    return message;
  }

  const cacheControl = ttl === "1h"
    ? { type: "ephemeral", ttl }
    : { type: "ephemeral" };

  if (typeof message.content === "string") {
    // Convert string content to a content block array so we can attach cache_control
    return {
      ...message,
      content: [
        {
          type: "text",
          text: message.content,
          cache_control: cacheControl,
        },
      ],
    };
  }

  if (Array.isArray(message.content)) {
    // Clone the array and attach cache_control to the last block
    const blocks = message.content.map((block: any, i: number) => {
      if (i === message.content.length - 1) {
        return { ...block, cache_control: cacheControl };
      }
      return block;
    });

    return { ...message, content: blocks };
  }

  // Unknown content shape – return unchanged
  return message;
}

/**
 * Rough token estimate from a character count. Split out so callers that
 * retain only a bounded prefix of generated text can still estimate from the
 * full length that passed through.
 */
export function estimateTokensFromLength(length: any) {
  return Number.isFinite(length) && length > 0 ? Math.floor(length / 4) : 0;
}

export function estimateTokens(input: any) {
  if (!input) return 0;

  if (typeof input === "string") {
    return estimateTokensFromLength(input.length);
  }

  if (Array.isArray(input)) {
    const text = input
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join(" ");
    return Math.floor(text.length / 4);
  }

  if (input.messages && Array.isArray(input.messages)) {
    return estimateTokens(input.messages);
  }

  return Math.floor(String(input).length / 4);
}

/**
 * Resolves a model name to its endpoint WITHOUT selecting a token or advancing
 * any round-robin state. Side-effect free — safe to call for metadata reads
 * (prompt-caching depth, generation defaults) without consuming a key slot.
 * Returns null when the model has no configured endpoint.
 */
export function getModelDefinition(modelName: any) {
  return MODEL_REGISTRY[modelName] || null;
}

/**
 * The models a client is allowed to see, as `[name, definition]` pairs.
 *
 * Every public surface must derive its model list from here rather than
 * filtering `MODEL_REGISTRY` itself: when `/v1/models` and the status page each
 * carry their own idea of visibility they drift, and a surface that answers
 * with a model the catalog denies discloses it. Models that are hidden,
 * disabled, or invalid are absent — the last two never reach the registry.
 */
export function publicModelEntries(): Array<[string, RegisteredModel]> {
  return Object.entries(MODEL_REGISTRY).filter(([, model]) => model.hidden !== true);
}

export function getConcreteModelMeta(modelName: any) {
  const definition = getModelDefinition(modelName);
  if (!definition || definition.routingType === "auto") return null;
  const actualModelName = resolveModelName(modelName);
  const match = actualModelName.match(/-v(\d+)$/);
  if (!match) return null;

  const version = match[1];
  const endpointKey = `v${version}`;
  const endpoint = Config.ENDPOINTS[endpointKey];
  if (!endpoint) return null;

  const actualModel = actualModelName.replace(new RegExp(`-v${version}$`), "");
  const appendApiSuffix = endpoint.appendApiSuffix !== false;
  const normalizedUrl = normalizeEndpointUrl(endpoint.url, appendApiSuffix);

  return {
    url: normalizedUrl,
    targetModel: modelName,
    actualModel,
    endpointKey,
    endpointName: endpoint.name || endpointKey,
    customHeaders: endpoint.headers || {},
    apiFormat: endpoint.apiFormat || "openai",
    appendApiSuffix,
    generationDefaults:
      endpoint.generationDefaults || settingsManager.getDefaultGenerationDefaults(),
    promptCaching:
      endpoint.promptCaching !== undefined ? endpoint.promptCaching : null,
    keyRotation: endpoint.keyRotation ?? null,
    // Whether an actionable error benches the key (invalid/timeout). Absent =>
    // fall back to the global default at the point of use.
    keyHealth: endpoint.keyHealth ?? null,
    // Per-endpoint outbound body edits. Absent => leave the adapter's body alone.
    bodyParams: endpoint.bodyParams ?? null,
    // Extra same-key attempts on a transient failure. Absent => fall back to
    // the global default at the point of use.
    retryAttempts: endpoint.retryAttempts ?? null,
    // Outbound proxy to route upstream traffic through. Absent => direct.
    proxyId: endpoint.proxyId ?? null,
  };
}

/**
 * Resolves the effective key-health flag for an endpoint: the per-endpoint
 * keyHealth if set, otherwise the global default. Returns a boolean.
 */
export function resolveKeyHealth(endpointKeyHealth: any) {
  if (endpointKeyHealth === true || endpointKeyHealth === false) {
    return endpointKeyHealth;
  }
  return settingsManager.get("defaultEndpointKeyHealth") !== false;
}

/**
 * Resolves the effective retry count for an endpoint: the per-endpoint
 * retryAttempts if set, otherwise the global default. Returns a non-negative
 * integer; 0 means a failure is never retried on the same key.
 */
export function resolveRetryAttempts(endpointRetryAttempts: any) {
  const configured = endpointRetryAttempts ?? settingsManager.get("defaultEndpointRetryAttempts");
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Resolves the effective rotation mode for an endpoint: the per-endpoint
 * keyRotation if set, otherwise the global default.
 */
function resolveRotationMode(endpointKeyRotation: any) {
  const mode = endpointKeyRotation ?? settingsManager.get("defaultEndpointKeyRotation");
  return mode === "roundrobin" ? "roundrobin" : "sticky";
}

/**
 * Resolves a model to its endpoint AND selects a usable upstream key.
 *
 * Only keys that are usable (active, or a timeout whose cooldown has elapsed)
 * participate in selection. `invalid` keys are excluded until manually
 * re-enabled. Keys whose hash is in `excludeHashes` (already tried this request)
 * are skipped so a single request never retries the same key.
 *
 * Rotation mode:
 *   - sticky (default): use the first usable key (lowest index) until it errors.
 *   - roundrobin: start at a random position in the endpoint's key list, then
 *     walk it in order. `rotationOffset` carries that starting position across
 *     the key hops of one request, so a hop lands on the next usable key rather
 *     than re-randomizing; omitting it draws a fresh offset, which is what keeps
 *     two consecutive requests from beginning on the same key.
 *
 * Returns null when the model has no endpoint. When an endpoint exists but no
 * usable key remains, returns the meta with `token: null` and
 * `tokenExhausted: true` so the caller can surface the 404. On success the
 * returned `rotationOffset` is the offset used, for the caller to feed back.
 *
 * @param {string} modelName
 * @param {{ excludeHashes?: Set<string>, ignoreState?: boolean, rotationOffset?: number }} [opts]
 */
export async function getEndpointForConcreteModel(
  modelName: string,
  opts: ModelLoadOptions = {},
) {
  const meta = getConcreteModelMeta(modelName);
  if (!meta) return null;

  const excludeHashes = opts.excludeHashes || new Set();
  const endpoint = Config.ENDPOINTS[meta.endpointKey];
  const allTokens = endpoint.tokens || [];

  // Diagnostic callers (admin model list / test ping) want a token even for a
  // key that's currently invalid/timed-out, and must not advance rotation.
  if (opts.ignoreState) {
    const token = allTokens[0] ?? endpoint.token ?? null;
    return {
      ...meta,
      token,
      tokenHash: token ? keyStateManager.hashToken(meta.endpointKey, token) : null,
      tokenExhausted: token == null,
      rotationOffset: 0,
    };
  }

  const usable = await keyStateManager.getUsableTokens(meta.endpointKey, allTokens, {
    excludeHashes,
  });

  if (usable.length === 0) {
    return { ...meta, token: null, tokenHash: null, tokenExhausted: true, rotationOffset: 0 };
  }

  const mode = resolveRotationMode(meta.keyRotation);
  let rotationOffset = 0;
  let chosen = usable[0];
  if (mode === "roundrobin") {
    rotationOffset = opts.rotationOffset ?? Config.randomRotationOffset(allTokens.length);
    const usableByToken = new Map(usable.map((entry) => [entry.token, entry]));
    for (const token of Config.orderTokensFrom(allTokens, rotationOffset)) {
      const entry = usableByToken.get(token);
      if (entry) {
        chosen = entry;
        break;
      }
    }
  }

  return {
    ...meta,
    token: chosen.token,
    tokenHash: chosen.tokenHash,
    tokenExhausted: false,
    rotationOffset,
  };
}

export function getEndpointMeta(modelName: any) {
  return getConcreteModelMeta(modelName);
}

export async function getEndpointForModel(
  modelName: string,
  opts: ModelLoadOptions = {},
) {
  return await getEndpointForConcreteModel(modelName, opts);
}

/**
 * Get the real client IP regardless of how many proxy layers sit in front
 * of Express (Cloudflare → nginx → Express, direct, etc.).
 *
 * Cloudflare sets `CF-Connecting-IP` to the real client IP at the edge
 * based on the TCP connection — it can't be spoofed because CF overwrites
 * any incoming copy. This works no matter how many proxies follow CF.
 *
 * Falls back to the raw socket address when there's no Cloudflare (local
 * dev, direct exposure, etc.).
 */
export function getClientIp(req: ClientRequest) {
  const forwardedIp = req.headers["cf-connecting-ip"];
  const firstForwardedIp = Array.isArray(forwardedIp)
    ? forwardedIp[0]
    : forwardedIp;
  return typeof firstForwardedIp === "string"
    ? firstForwardedIp || req.socket?.remoteAddress || "unknown"
    : req.socket?.remoteAddress || "unknown";
}
