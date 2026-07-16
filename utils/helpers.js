import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Config from "../config/index.js";
import settingsManager from "../services/settingsManager.js";
import keyStateManager from "../services/keyStateManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model registry and aliases
export let MODEL_ALIASES = {};
export let MODEL_REGISTRY = {};
export let MODEL_PRICING = {};

export function maskKey(key) {
  if (!key || key.length <= 8) return key ? "****" : key;
  return key.substring(0, 5) + "..." + key.substring(key.length - 3);
}

export function resolveModelName(modelName) {
  return MODEL_ALIASES[modelName] || modelName;
}

export function loadModelsFromFile() {
  MODEL_REGISTRY = {};
  MODEL_ALIASES = {};
  MODEL_PRICING = {};

  const jsonPath = path.join(__dirname, "..", "models.json");

  try {
    if (!fs.existsSync(jsonPath)) {
      console.warn("models.json not found");
      return;
    }

    const content = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(content);

    for (const [displayName, modelConfig] of Object.entries(
      data.models || {},
    )) {
      // Skip disabled models — they won't appear in the registry or be routable
      if (modelConfig.disabled === true) continue;

      const backendName = modelConfig.backend || displayName;
      const version = modelConfig.version || "";
      const actualBackend = version ? `${backendName}-${version}` : backendName;

      MODEL_ALIASES[displayName] = actualBackend;
      MODEL_REGISTRY[displayName] = {
        type: "chat",
        capabilities: { outputCapabilities: {} },
        backend: actualBackend,
        version,
      };

      if (modelConfig.pricing) {
        MODEL_PRICING[displayName] = {
          input: modelConfig.pricing.input ?? 0,
          output: modelConfig.pricing.output ?? 0,
          cache_write: modelConfig.pricing.cache_write ?? 0,
          cache_read: modelConfig.pricing.cache_read ?? 0,
        };
      }
    }
  } catch (error) {
    console.error("Error loading models:", error);
  }
}

/**
 * Determines if a model name refers to a Claude model.
 */
export function isClaudeModel(modelName) {
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
 * OpenRouter (and the Anthropic API directly) understand.
 *
 * @param {Array} messages - OpenAI-style messages array
 * @param {number} cacheDepth - cache depth value
 * @returns {Array} - new messages array with cache_control injected where appropriate
 */
export function applyClaudePromptCaching(messages, cacheDepth) {
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

    return addCacheControlToMessage(message);
  });
}

/**
 * Adds a cache_control breakpoint to the last content block of a message.
 * Handles both string content and array-of-blocks content.
 */
function addCacheControlToMessage(message) {
  if (!message || !message.content) {
    return message;
  }

  const cacheControl = { type: "ephemeral" };

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
    const blocks = message.content.map((block, i) => {
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

export function estimateTokens(input) {
  if (!input) return 0;

  if (typeof input === "string") {
    return Math.floor(input.length / 4);
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
 * Normalizes an endpoint base URL:
 * - Strips /v1 and anything after it, but keeps any path prefix before /v1.
 * - Example: https://api.example.com/generate/v1/chat/completions -> https://api.example.com/generate
 * - Example: https://api.example.com/v1 -> https://api.example.com
 * - Example: https://api.example.com -> https://api.example.com (unchanged)
 */
export function normalizeEndpointUrl(rawUrl) {
  // Remove trailing slash first
  let url = rawUrl.replace(/\/$/, '');
  // Strip /v1 and everything after it (handles /v1, /v1/, /v1/anything)
  // But keep any prefix path segment before /v1 (e.g. /generate)
  url = url.replace(/\/v1(\/.*)?$/, '');
  return url;
}

/**
 * Builds the full backend URL by appending the correct path for the given apiFormat.
 * @param {string} baseUrl - normalized base URL (no trailing /v1)
 * @param {string} apiFormat - one of: 'openai', 'anthropic', 'gemini', 'gemini-openai', 'openai-responses', 'openai-codex'
 * @param {string} modelName - the actual model name (used by gemini to build the path)
 * @param {boolean} isStreaming - when true, returns the streaming endpoint for formats that need a different URL (gemini)
 * @returns {string} full URL with path appended
 */
export function getFullUrl(baseUrl, apiFormat, modelName, isStreaming = false) {
  switch (apiFormat) {
    case 'anthropic':
      return `${baseUrl}/v1/messages`;

    case 'gemini':
      // Gemini uses a separate streaming endpoint with SSE output
      return isStreaming
        ? `${baseUrl}/v1beta/models/${modelName}:streamGenerateContent`
        : `${baseUrl}/v1beta/models/${modelName}:generateContent`;

    case 'gemini-openai':
      // Gemini's OpenAI-compatible endpoint — same body/response shape as OpenAI
      return `${baseUrl}/v1beta/openai/chat/completions`;

    case 'openai-responses':
    case 'openai-codex':
      return `${baseUrl}/v1/responses`;

    case 'openai':
    default:
      return `${baseUrl}/v1/chat/completions`;
  }
}

/**
 * Resolves a model name to its endpoint WITHOUT selecting a token or advancing
 * any round-robin state. Side-effect free — safe to call for metadata reads
 * (prompt-caching depth, generation defaults) without consuming a key slot.
 * Returns null when the model has no configured endpoint.
 */
export function getEndpointMeta(modelName) {
  const actualModelName = resolveModelName(modelName);
  const match = actualModelName.match(/-v(\d+)$/);
  if (!match) return null;

  const version = match[1];
  const endpointKey = `v${version}`;
  const endpoint = Config.ENDPOINTS[endpointKey];
  if (!endpoint) return null;

  const actualModel = actualModelName.replace(new RegExp(`-v${version}$`), "");
  const normalizedUrl = normalizeEndpointUrl(endpoint.url);

  return {
    url: normalizedUrl,
    actualModel,
    endpointKey,
    endpointName: endpoint.name || endpointKey,
    customHeaders: endpoint.headers || {},
    apiFormat: endpoint.apiFormat || "openai",
    generationDefaults:
      endpoint.generationDefaults || settingsManager.getDefaultGenerationDefaults(),
    promptCaching:
      endpoint.promptCaching !== undefined ? endpoint.promptCaching : null,
    keyRotation: endpoint.keyRotation ?? null,
    // Whether an actionable error benches the key (invalid/timeout). Absent =>
    // fall back to the global default at the point of use.
    keyHealth: endpoint.keyHealth ?? null,
  };
}

/**
 * Resolves the effective key-health flag for an endpoint: the per-endpoint
 * keyHealth if set, otherwise the global default. Returns a boolean.
 */
export function resolveKeyHealth(endpointKeyHealth) {
  if (endpointKeyHealth === true || endpointKeyHealth === false) {
    return endpointKeyHealth;
  }
  return settingsManager.get("defaultEndpointKeyHealth") !== false;
}

/**
 * Resolves the effective rotation mode for an endpoint: the per-endpoint
 * keyRotation if set, otherwise the global default.
 */
function resolveRotationMode(endpointKeyRotation) {
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
 *   - roundrobin: rotate across usable keys.
 *
 * Returns null when the model has no endpoint. When an endpoint exists but no
 * usable key remains, returns the meta with `token: null` and
 * `tokenExhausted: true` so the caller can surface the 404.
 *
 * @param {string} modelName
 * @param {{ excludeHashes?: Set<string> }} [opts]
 */
export function getEndpointForModel(modelName, opts = {}) {
  const meta = getEndpointMeta(modelName);
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
    };
  }

  const usable = keyStateManager.getUsableTokens(meta.endpointKey, allTokens, {
    excludeHashes,
  });

  if (usable.length === 0) {
    return { ...meta, token: null, tokenHash: null, tokenExhausted: true };
  }

  const mode = resolveRotationMode(meta.keyRotation);
  let chosen = usable[0];
  if (mode === "roundrobin") {
    const rotatedToken = Config.rotateUsableToken(
      meta.endpointKey,
      usable.map(({ token }) => token),
    );
    chosen = usable.find(({ token }) => token === rotatedToken) || chosen;
  }

  return {
    ...meta,
    token: chosen.token,
    tokenHash: chosen.tokenHash,
    tokenExhausted: false,
  };
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
export function getClientIp(req) {
  return req.headers["cf-connecting-ip"] || req.socket?.remoteAddress || "unknown";
}
