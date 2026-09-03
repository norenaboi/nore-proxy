import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "node:crypto";
import settingsManager from "../services/settingsManager.js";
import { getEndpointsPath } from "../utils/configPaths.js";
import type { EndpointsDocument, LoadedEndpoint } from "../types/endpoint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

class Config {
  static LOG_DIR = path.join(__dirname, "..", "logs");

  static PORT = parseInt(process.env.PORT || "8741");

  static REQUEST_TIMEOUT_SECONDS = 180;
  static CLEANUP_INTERVAL = 300;

  static MAX_LOG_MEMORY_ITEMS = 1000;
  static MAX_REQUEST_DETAILS = 500;

  static MASTER_KEY = (() => {
    const key = process.env.MASTER_KEY;
    if (!key || key.trim().length < 16) {
      console.error(
        "FATAL: MASTER_KEY environment variable is not set or is too short (minimum 16 characters). " +
          "Set it before starting the server.",
      );
      process.exit(1);
    }
    return key;
  })();

  // Runtime settings are managed by settingsManager and persisted in settings.json.
  static get RPD_DEFAULT() {
    return settingsManager.get("rpdDefault");
  }

  static get RPM_DEFAULT() {
    return settingsManager.get("rpmDefault");
  }

  static get MAX_CONTEXT_SIZE_DEFAULT() {
    return settingsManager.get("maxContextSizeDefault");
  }

  static ENDPOINTS: Record<string, LoadedEndpoint> = {};

  static loadEndpoints() {
    this.ENDPOINTS = {};

    const endpointsPath = getEndpointsPath();

    if (!fs.existsSync(endpointsPath)) {
      console.log("endpoints.json not found, no endpoints loaded");
      return this.ENDPOINTS;
    }

    try {
      const content = fs.readFileSync(endpointsPath, "utf-8");
      const data = JSON.parse(content) as EndpointsDocument;

      for (const [key, endpoint] of Object.entries(data)) {
        // Validate that key matches v{n} pattern
        const match = key.match(/^v(\d+)$/);
        if (!match) {
          console.warn(`Warning: Invalid endpoint key "${key}" — skipping`);
          continue;
        }

        const index = match[1];
        const tokens = Array.isArray(endpoint.tokens) ? endpoint.tokens : [];

        if (!endpoint.url) {
          console.warn(`Warning: Endpoint "${key}" missing url — skipping`);
          continue;
        }

        this.ENDPOINTS[key] = {
          name: endpoint.name || `Endpoint ${index}`,
          url: endpoint.url,
          token: tokens[0] ?? null, // Keep for backward compat
          tokens,
          headers: endpoint.headers || {},
          apiFormat: endpoint.apiFormat || "openai",
          appendApiSuffix: endpoint.appendApiSuffix !== false,
          // Per-endpoint generation policy: strip, pass through, or override.
          generationDefaults: endpoint.generationDefaults || settingsManager.getDefaultGenerationDefaults(),
          // Per-endpoint prompt caching (null for old endpoints = deliberately disabled/off).
          promptCaching: endpoint.promptCaching !== undefined ? endpoint.promptCaching : null,
          // Key rotation mode: 'sticky' | 'roundrobin' | null.
          // null/absent => fall back to the global defaultEndpointKeyRotation at runtime.
          keyRotation: endpoint.keyRotation !== undefined ? endpoint.keyRotation : null,
          // Key health: true | false | null. When true, an actionable error sidelines
          // the key (invalid/timeout); when false, keys are never sidelined (requests
          // still hop). null/absent => fall back to defaultEndpointKeyHealth at runtime.
          keyHealth: endpoint.keyHealth !== undefined ? endpoint.keyHealth : null,
          // Per-endpoint edits to the outbound request body, applied after the
          // adapter builds it. null/absent => the body is left as the adapter
          // produced it.
          bodyParams: endpoint.bodyParams !== undefined ? endpoint.bodyParams : null,
          // Extra attempts on the same key after a transient failure (5xx, timeout,
          // network) before the request hops keys. null/absent => fall back to
          // defaultEndpointRetryAttempts at runtime.
          retryAttempts: endpoint.retryAttempts !== undefined ? endpoint.retryAttempts : null,
          // Outbound proxy in proxies.json to route upstream traffic through.
          // null/absent => connect directly. A stale id degrades to direct at
          // request time rather than failing every request.
          proxyId: typeof endpoint.proxyId === "string" && endpoint.proxyId !== "" ? endpoint.proxyId : null,
        };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error loading endpoints.json: ${message}`);
    }

    return this.ENDPOINTS;
  }

  /**
   * Rotates a token list so it begins at `offset` and wraps around, e.g.
   * offset 2 over [a, b, c, d] yields [c, d, a, b].
   *
   * Pure, and deliberately indexed over the endpoint's full token list rather
   * than the usable subset: the subset shrinks as a request hops between keys,
   * so a fixed offset into it would not describe a stable sequence.
   */
  static orderTokensFrom<T>(tokens: T[], offset: number): T[] {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    const length = tokens.length;
    const normalized = Number.isFinite(offset) ? Math.trunc(offset) : 0;
    const start = ((normalized % length) + length) % length;
    return tokens.map((_, index) => tokens[(start + index) % length]);
  }

  /**
   * Draws the starting position for one request's key rotation. Each request
   * gets a fresh offset so consecutive requests do not begin on the same key,
   * which keeps a key that is failing with a non-actionable code (a 500, say,
   * which never sidelines it) from absorbing every request.
   */
  static randomRotationOffset(length: number): number {
    return Number.isInteger(length) && length > 1 ? crypto.randomInt(length) : 0;
  }

  static reload() {
    dotenv.config({ override: true });
    const key = process.env.MASTER_KEY;
    if (!key || key.trim().length < 16) {
      console.error("FATAL: MASTER_KEY is not set or too short after reload.");
      process.exit(1);
    }
    this.MASTER_KEY = key;
    this.loadEndpoints();
  }
}

export default Config;
