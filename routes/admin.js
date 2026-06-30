import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifySession } from "../middleware/auth.js";
import { adminRateLimit } from "../middleware/rateLimiter.js";
import apiKeyManager from "../services/apiKeyManager.js";
import logManager from "../services/logManager.js";
import Config from "../config/index.js";
import { loadModelsFromFile } from "../utils/helpers.js";
import { calculateCost } from "../utils/logging.js";
import settingsManager from "../services/settingsManager.js";
import crypto from "crypto";
import { createSession, deleteSession } from "../services/sessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Apply IP-level rate limiting to all admin routes to limit brute-force attempts
router.use(adminRateLimit);

// POST /admin/login — validate master key and issue a session cookie
router.post("/admin/login", (req, res) => {
  const provided = (req.body.masterKey || "").toString();
  const expected = Config.MASTER_KEY;
  let valid = false;
  try {
    valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {}

  if (!valid) {
    return res.status(403).json({ error: "Invalid master key" });
  }

  const sessionId = createSession();
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("adminSession", sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge:
      parseInt(process.env.SESSION_TTL_HOURS || "24", 10) * 60 * 60 * 1000,
  });
  res.json({ success: true });
});

// POST /admin/logout — delete the session and clear the cookie
router.post("/admin/logout", (req, res) => {
  const sessionId = req.cookies?.adminSession;
  deleteSession(sessionId);
  res.clearCookie("adminSession", { httpOnly: true, sameSite: "strict" });
  res.json({ success: true });
});

/*
    GET for logs in database
*/

// Get logs
/**
 * Sum costs from an array of log entries, calculating per-model to respect different pricing.
 * Returns { total_cost, daily_cost } where daily = entries from the last 24 h.
 */
function computeCostsFromLogs(logs) {
  const currentTime = Date.now() / 1000;
  const dayAgo = currentTime - 86400;

  let totalCost = 0;
  let totalInputCost = 0;
  let totalOutputCost = 0;
  let totalCacheWriteCost = 0;
  let totalCacheReadCost = 0;

  let dailyCost = 0;
  let dailyInputCost = 0;
  let dailyOutputCost = 0;
  let dailyCacheWriteCost = 0;
  let dailyCacheReadCost = 0;

  for (const log of logs) {
    if (log.type !== "request_end" || log.status !== "success") continue;
    const costs = calculateCost(
      log.model || "unknown",
      log.input_tokens || 0,
      log.output_tokens || 0,
      log.cache_write_tokens || 0,
      log.cache_read_tokens || 0,
    );
    totalCost += costs.totalCost;
    totalInputCost += costs.inputCost;
    totalOutputCost += costs.outputCost;
    totalCacheWriteCost += costs.cacheWriteCost;
    totalCacheReadCost += costs.cacheReadCost;

    if ((log.timestamp || 0) > dayAgo) {
      dailyCost += costs.totalCost;
      dailyInputCost += costs.inputCost;
      dailyOutputCost += costs.outputCost;
      dailyCacheWriteCost += costs.cacheWriteCost;
      dailyCacheReadCost += costs.cacheReadCost;
    }
  }

  return {
    total_cost: totalCost,
    total_input_cost: totalInputCost,
    total_output_cost: totalOutputCost,
    total_cache_write_cost: totalCacheWriteCost,
    total_cache_read_cost: totalCacheReadCost,
    daily_cost: dailyCost,
    daily_input_cost: dailyInputCost,
    daily_output_cost: dailyOutputCost,
    daily_cache_write_cost: dailyCacheWriteCost,
    daily_cache_read_cost: dailyCacheReadCost,
  };
}

router.get("/api/logs", verifySession, async (req, res) => {
  const allApiKeys = apiKeyManager.keys;
  const dashboardData = [];

  const allLogs = logManager.readRequestLogs(10000);
  const currentTime = Date.now() / 1000;
  const dayAgo = currentTime - 86400;

  for (const apiKey of Object.keys(allApiKeys)) {
    const stats = apiKeyManager.getUsageStats(apiKey);

    // Compute masked key used in logs for this API key
    const maskedKey =
      apiKey && apiKey.length > 8
        ? apiKey.substring(0, 5) + "..." + apiKey.substring(apiKey.length - 3)
        : apiKey
          ? "****"
          : apiKey;

    const keyLogs = allLogs.filter((l) => l.api_key === maskedKey);
    const { total_cost, daily_cost } = computeCostsFromLogs(keyLogs);

    dashboardData.push({
      name: apiKeyManager.getKeyName(apiKey),
      total_requests: stats.total_requests,
      daily_requests: stats.daily_requests || 0,
      total_input_tokens: stats.total_input_tokens || 0,
      total_output_tokens: stats.total_output_tokens || 0,
      total_cache_write_tokens: stats.total_cache_write_tokens || 0,
      total_cache_read_tokens: stats.total_cache_read_tokens || 0,
      daily_input_tokens: stats.daily_input_tokens || 0,
      daily_output_tokens: stats.daily_output_tokens || 0,
      daily_cache_write_tokens: stats.daily_cache_write_tokens || 0,
      daily_cache_read_tokens: stats.daily_cache_read_tokens || 0,
      total_cost,
      daily_cost,
    });
  }

  // Sort by daily requests
  dashboardData.sort((a, b) => b.daily_requests - a.daily_requests);

  // Get recent logs
  const logs = logManager.readRequestLogs(100);

  const formattedLogs = logs
    .filter((log) => log.type === "request_end" && log.status === "success")
    .map((log) => {
      const apiKey = log.api_key || "Unknown";
      return {
        timestamp: log.timestamp || 0,
        request_id: log.request_id || "",
        name:
          log.key_name ||
          (apiKey !== "Unknown" ? apiKeyManager.getKeyName(apiKey) : "Unknown"),
        api_key: apiKey.length > 5 ? apiKey.substring(0, 5) + "..." : apiKey,
        model: log.model || "Unknown",
        input_tokens: log.input_tokens || 0,
        output_tokens: log.output_tokens || 0,
        cache_write_tokens: log.cache_write_tokens || 0,
        cache_read_tokens: log.cache_read_tokens || 0,
        total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0),
        duration: log.duration || 0,
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);

  const summaryCosts = computeCostsFromLogs(allLogs);

  const totals = {
    total_api_keys: Object.keys(allApiKeys).length,
    total_requests: dashboardData.reduce((sum, d) => sum + d.total_requests, 0),
    daily_requests: dashboardData.reduce((sum, d) => sum + d.daily_requests, 0),
    total_input_tokens: dashboardData.reduce(
      (sum, d) => sum + d.total_input_tokens,
      0,
    ),
    total_output_tokens: dashboardData.reduce(
      (sum, d) => sum + d.total_output_tokens,
      0,
    ),
    total_cache_write_tokens: dashboardData.reduce(
      (sum, d) => sum + d.total_cache_write_tokens,
      0,
    ),
    total_cache_read_tokens: dashboardData.reduce(
      (sum, d) => sum + d.total_cache_read_tokens,
      0,
    ),
    daily_input_tokens: dashboardData.reduce(
      (sum, d) => sum + d.daily_input_tokens,
      0,
    ),
    daily_output_tokens: dashboardData.reduce(
      (sum, d) => sum + d.daily_output_tokens,
      0,
    ),
    daily_cache_write_tokens: dashboardData.reduce(
      (sum, d) => sum + d.daily_cache_write_tokens,
      0,
    ),
    daily_cache_read_tokens: dashboardData.reduce(
      (sum, d) => sum + d.daily_cache_read_tokens,
      0,
    ),
    total_cost: summaryCosts.total_cost,
    total_input_cost: summaryCosts.total_input_cost,
    total_output_cost: summaryCosts.total_output_cost,
    total_cache_write_cost: summaryCosts.total_cache_write_cost,
    total_cache_read_cost: summaryCosts.total_cache_read_cost,
    daily_cost: summaryCosts.daily_cost,
    daily_input_cost: summaryCosts.daily_input_cost,
    daily_output_cost: summaryCosts.daily_output_cost,
    daily_cache_write_cost: summaryCosts.daily_cache_write_cost,
    daily_cache_read_cost: summaryCosts.daily_cache_read_cost,
  };

  res.json({
    summary: totals,
    api_keys: dashboardData,
    recent_logs: formattedLogs,
  });
});

/*
    GET PUT POST DELETE for API keys in database
*/

// Get all API keys
router.get("/api/keys", verifySession, async (req, res) => {
  try {
    const keys = apiKeyManager.getKeys();
    res.json({ keys });
  } catch (error) {
    console.error("Error loading keys:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add new API key
router.post("/api/keys", verifySession, async (req, res) => {
  try {
    const apiKey = (req.body.api_key || "").trim();
    const name = (req.body.name || "").trim();
    const rpd = req.body.rpd || Config.RPD_DEFAULT;
    const rpm = req.body.rpm || Config.RPM_DEFAULT;
    const max_context_size =
      req.body.max_context_size !== undefined
        ? parseInt(req.body.max_context_size, 10)
        : Config.MAX_CONTEXT_SIZE_DEFAULT;

    if (!apiKey || !name) {
      return res.status(400).json({ error: "API key and name are required" });
    }

    if (apiKeyManager.keys[apiKey]) {
      return res.status(400).json({ error: "API key already exists" });
    }

    apiKeyManager.addKey(apiKey, name, rpd, rpm, max_context_size);
    console.log(`Added new API key: ${name}`);

    res.json({ message: "API key added successfully" });
  } catch (error) {
    console.error("Error adding key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update API key
router.put("/api/keys", verifySession, async (req, res) => {
  try {
    const newName = (req.body.name || "").trim();
    const apiKey = (req.body.api_key || "").trim();
    const rpd = req.body.rpd;
    const rpm = req.body.rpm;
    const max_context_size =
      req.body.max_context_size !== undefined
        ? parseInt(req.body.max_context_size, 10)
        : Config.MAX_CONTEXT_SIZE_DEFAULT;
    const active = req.body.active;

    if (!newName) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!rpd) {
      return res.status(400).json({ error: "RPD is required" });
    }
    if (!rpm) {
      return res.status(400).json({ error: "RPM is required" });
    }

    apiKeyManager.updateKey(
      apiKey,
      newName,
      rpd,
      rpm,
      max_context_size,
      active,
    );
    res.json({ message: "API key updated successfully" });
  } catch (error) {
    console.error("Error updating key:", error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Delete API key
router.delete("/api/keys", verifySession, async (req, res) => {
  try {
    const apiKey = (req.body.api_key || "").trim();

    apiKeyManager.removeKey(apiKey);
    console.log(`Deleted API key: ${apiKey}`);

    res.json({ message: "API key deleted successfully" });
  } catch (error) {
    console.error("Error deleting key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/*
    GET PUT POST DELETE for models.json
*/

// Get all models
router.get("/api/models", verifySession, async (req, res) => {
  try {
    const jsonPath = path.join(__dirname, "../models.json");

    if (!fs.existsSync(jsonPath)) {
      return res.json({ models: [] });
    }

    const content = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(content);
    const models = Object.entries(data.models || {}).map(([name, config]) => ({
      name,
      backend: config.backend || name,
      version: config.version || "",
      pricing: config.pricing || {
        input: 0,
        output: 0,
        cache_write: 0,
        cache_read: 0,
      },
    }));
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add model
router.post("/api/models", verifySession, async (req, res) => {
  try {
    const { name, backend, version, pricing } = req.body;
    if (!name) return res.status(400).json({ error: "Model name required" });

    const jsonPath = path.join(__dirname, "../models.json");
    let data = { models: {} };

    if (fs.existsSync(jsonPath)) {
      const content = fs.readFileSync(jsonPath, "utf-8");
      data = JSON.parse(content);
    }

    if (data.models[name]) {
      return res.status(400).json({ error: "Model already exists" });
    }

    data.models[name] = {
      backend: backend || name,
      version: version || "",
      pricing: pricing || {
        input: 1,
        output: 1,
        cache_write: 1,
        cache_read: 1,
      },
    };

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    loadModelsFromFile();
    res.json({ message: "Model added" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update model
router.put("/api/models", verifySession, async (req, res) => {
  try {
    const { oldName, name, backend, version, pricing } = req.body;

    if (!oldName) {
      return res.status(400).json({ error: "Old model name required" });
    }

    const jsonPath = path.join(__dirname, "../models.json");
    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({ error: "Models file not found" });
    }

    const content = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(content);

    if (!data.models[oldName]) {
      return res.status(404).json({ error: "Model not found" });
    }

    // If name changed, delete old and create new
    if (oldName !== name) {
      delete data.models[oldName];
    }

    data.models[name] = {
      backend: backend || name,
      version: version || "",
      pricing: pricing || {
        input: 1,
        output: 1,
        cache_write: 1,
        cache_read: 1,
      },
    };

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    loadModelsFromFile();
    res.json({ message: "Model updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete model
router.delete("/api/models", verifySession, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Model name required" });

    const jsonPath = path.join(__dirname, "../models.json");
    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({ error: "Models file not found" });
    }

    const content = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(content);

    if (!data.models[name]) {
      return res.status(404).json({ error: "Model not found" });
    }

    delete data.models[name];
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    loadModelsFromFile();
    res.json({ message: "Model deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/*
    GET PUT POST DELETE for endpoints.txt
*/

// Get all endpoints
router.get("/api/endpoints", verifySession, async (req, res) => {
  try {
    const endpointsPath = path.join(__dirname, "../endpoints.txt");
    const content = fs.existsSync(endpointsPath)
      ? fs.readFileSync(endpointsPath, "utf-8")
      : "";
    const lines = content.split("\n").filter((line) => line.trim());

    // Build maps keyed by index so HEADERS (optional) doesn't break iteration
    const urlMap = {};
    // tokenMap stores arrays of tokens per index
    const tokenMap = {};
    const headersMap = {};

    for (const line of lines) {
      const urlMatch = line.match(/^V(\d+)_URL=(.+)$/);
      if (urlMatch) { urlMap[urlMatch[1]] = urlMatch[2]; continue; }
      // V{n}_TOKENS — comma-separated; takes precedence
      const tokensMatch = line.match(/^V(\d+)_TOKENS=(.+)$/);
      if (tokensMatch) {
        tokenMap[tokensMatch[1]] = tokensMatch[2].split(",").map((t) => t.trim()).filter(Boolean);
        continue;
      }
      // V{n}_TOKEN — legacy single token; only set if TOKENS hasn't been set
      const tokenMatch = line.match(/^V(\d+)_TOKEN=(.+)$/);
      if (tokenMatch) {
        if (!tokenMap[tokenMatch[1]]) tokenMap[tokenMatch[1]] = [tokenMatch[2]];
        continue;
      }
      const headersMatch = line.match(/^V(\d+)_HEADERS=(.+)$/);
      if (headersMatch) { headersMap[headersMatch[1]] = headersMatch[2]; }
    }

    const endpoints = [];
    for (const idx of Object.keys(urlMap).sort((a, b) => parseInt(a) - parseInt(b))) {
      if (!tokenMap[idx]) continue;
      const rawTokens = tokenMap[idx];
      const maskedTokens = rawTokens.map((t) =>
        t.length > 8
          ? t.substring(0, 4) + "****" + t.substring(t.length - 4)
          : "****"
      );
      let headers = {};
      if (headersMap[idx]) {
        try { headers = JSON.parse(headersMap[idx]); } catch (_) { headers = {}; }
      }
      endpoints.push({
        index: parseInt(idx),
        url: urlMap[idx],
        token: maskedTokens[0],
        tokens: maskedTokens,
        headers,
      });
    }

    res.json({ endpoints });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add endpoint
router.post("/api/endpoints", verifySession, async (req, res) => {
  try {
    const url = (req.body.url || "").trim();

    // Accept either `tokens` (array) or legacy `token` (string)
    let tokens = [];
    if (Array.isArray(req.body.tokens)) {
      tokens = req.body.tokens.map((t) => String(t).trim()).filter(Boolean);
    } else if (req.body.token) {
      const single = String(req.body.token).trim();
      if (single) tokens = [single];
    }

    if (!url || tokens.length === 0)
      return res.status(400).json({ error: "URL and at least one token are required" });

    // Validate optional headers if provided
    let headersObj = null;
    if (req.body.headers !== undefined) {
      if (
        typeof req.body.headers !== "object" ||
        req.body.headers === null ||
        Array.isArray(req.body.headers)
      ) {
        return res.status(400).json({ error: "headers must be a JSON object" });
      }
      headersObj = req.body.headers;
    }

    // Validate URL is well-formed and uses http or https
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return res
          .status(400)
          .json({ error: "Endpoint URL must use HTTP or HTTPS" });
      }
    } catch (_) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const endpointsPath = path.join(__dirname, "../endpoints.txt");
    const content = fs.existsSync(endpointsPath)
      ? fs.readFileSync(endpointsPath, "utf-8")
      : "";
    const lines = content.split("\n").filter((line) => line.trim());

    let maxIndex = 0;
    for (const line of lines) {
      const match = line.match(/^V(\d+)_/);
      if (match) maxIndex = Math.max(maxIndex, parseInt(match[1]));
    }

    const newIndex = maxIndex + 1;
    // Use TOKENS (plural) for multi-key; fall back to TOKEN for a single key
    const tokenLine = tokens.length === 1
      ? `V${newIndex}_TOKEN=${tokens[0]}`
      : `V${newIndex}_TOKENS=${tokens.join(",")}`;
    let endpointBlock = `V${newIndex}_URL=${url}\n${tokenLine}`;
    if (headersObj && Object.keys(headersObj).length > 0) {
      endpointBlock += `\nV${newIndex}_HEADERS=${JSON.stringify(headersObj)}`;
    }
    const newContent =
      content.trim() +
      (content.trim() ? "\n\n" : "") +
      endpointBlock;
    fs.writeFileSync(endpointsPath, newContent);
    Config.loadEndpoints();
    res.json({ message: "Endpoint added", index: newIndex });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update endpoint
router.put("/api/endpoints", verifySession, async (req, res) => {
  try {
    const index = req.body.index;
    const url = (req.body.url || "").trim();
    if (!index || !url)
      return res.status(400).json({ error: "Index and URL are required" });

    // Validate index is a plain positive integer to prevent RegExp injection
    if (!/^\d+$/.test(String(index)))
      return res.status(400).json({ error: "Invalid endpoint index" });

    // Accept either `tokens` (array) or legacy `token` (string).
    // undefined tokens field = keep existing untouched (no tokens key sent at all).
    // Empty array = caller explicitly wants to keep existing (shouldn't happen from UI but handle it).
    let incomingTokens = null; // null means "don't touch token lines"
    if (Array.isArray(req.body.tokens)) {
      incomingTokens = req.body.tokens.map((t) => String(t).trim()).filter(Boolean);
    } else if (req.body.token !== undefined) {
      const single = String(req.body.token || "").trim();
      incomingTokens = single ? [single] : [];
    }

    // Resolve the final token list to write:
    //  - If no tokens field was sent at all, keep existing (resolvedTokens = null)
    //  - Otherwise read the current stored tokens, build a map of maskedForm→realToken,
    //    then replace each masked pill with its real value and keep real (new) tokens as-is.
    //    The result is exactly what the user sees in the pills, de-masked.
    let resolvedTokens = null;
    if (incomingTokens !== null) {
      if (incomingTokens.length === 0) {
        // Shouldn't happen from the UI (we validate at least one token), but be safe
        return res.status(400).json({ error: "At least one token is required" });
      }

      const hasMasked = incomingTokens.some((t) => t.includes("****"));

      if (hasMasked) {
        // Read the real stored tokens so we can de-mask
        const rawContent = fs.readFileSync(
          path.join(__dirname, "../endpoints.txt"),
          "utf-8"
        );
        const storedMatch = rawContent.match(
          new RegExp(`^V${String(index)}_TOKENS?=(.+)$`, "m")
        );
        let storedTokens = [];
        if (storedMatch) {
          const val = storedMatch[1];
          storedTokens = val.includes(",")
            ? val.split(",").map((t) => t.trim()).filter(Boolean)
            : [val.trim()];
        }

        // Build masked→real lookup (same masking logic as GET handler)
        const maskedToReal = new Map();
        for (const t of storedTokens) {
          const masked = t.length > 8
            ? t.substring(0, 4) + "****" + t.substring(t.length - 4)
            : "****";
          maskedToReal.set(masked, t);
        }

        resolvedTokens = incomingTokens.map((t) =>
          t.includes("****") ? (maskedToReal.get(t) ?? t) : t
        );
      } else {
        // All real (new) tokens — use directly
        resolvedTokens = incomingTokens;
      }
    }

    // Validate optional headers if provided
    let headersProvided = req.body.headers !== undefined;
    let headersObj = null;
    if (headersProvided) {
      if (
        typeof req.body.headers !== "object" ||
        req.body.headers === null ||
        Array.isArray(req.body.headers)
      ) {
        return res.status(400).json({ error: "headers must be a JSON object" });
      }
      headersObj = req.body.headers;
    }

    // Validate URL is well-formed and uses http or https
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return res
          .status(400)
          .json({ error: "Endpoint URL must use HTTP or HTTPS" });
      }
    } catch (_) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const endpointsPath = path.join(__dirname, "../endpoints.txt");
    const content = fs.readFileSync(endpointsPath, "utf-8");

    // Check the endpoint actually exists before doing anything
    if (!new RegExp(`^V${index}_URL=`, "m").test(content))
      return res.status(404).json({ error: "Endpoint not found" });

    let updated = content.replace(
      new RegExp(`^V${index}_URL=.+$`, "m"),
      `V${index}_URL=${url}`,
    );

    // Update tokens if resolved tokens are available
    if (resolvedTokens !== null) {
      const tokenLine = resolvedTokens.length === 1
        ? `V${index}_TOKEN=${resolvedTokens[0]}`
        : `V${index}_TOKENS=${resolvedTokens.join(",")}`;

      // Remove both old TOKEN and TOKENS lines first
      updated = updated
        .replace(new RegExp(`^V${index}_TOKEN=.+$\\n?`, "m"), "")
        .replace(new RegExp(`^V${index}_TOKENS=.+$\\n?`, "m"), "");

      // Insert the new token line after the URL line
      updated = updated.replace(
        new RegExp(`^(V${index}_URL=.+)$`, "m"),
        `$1\n${tokenLine}`,
      );
    }

    // Handle headers update
    if (headersProvided) {
      const headersLineRegex = new RegExp(`^V${index}_HEADERS=.+$`, "m");
      if (headersObj && Object.keys(headersObj).length > 0) {
        // Add or replace the HEADERS line
        if (headersLineRegex.test(updated)) {
          updated = updated.replace(
            headersLineRegex,
            `V${index}_HEADERS=${JSON.stringify(headersObj)}`,
          );
        } else {
          // Insert after the last token-related line for this index
          const tokenLineRegex = new RegExp(`^(V${index}_TOKENS?=.+)$`, "m");
          if (tokenLineRegex.test(updated)) {
            updated = updated.replace(
              tokenLineRegex,
              `$1\nV${index}_HEADERS=${JSON.stringify(headersObj)}`,
            );
          } else {
            updated = updated.replace(
              new RegExp(`^(V${index}_URL=.+)$`, "m"),
              `$1\nV${index}_HEADERS=${JSON.stringify(headersObj)}`,
            );
          }
        }
      } else {
        // Empty headers object — remove the HEADERS line if it exists
        updated = updated
          .replace(new RegExp(`\nV${index}_HEADERS=.*`, "m"), "")
          .replace(new RegExp(`^V${index}_HEADERS=.*\n?`, "m"), "");
      }
    }

    fs.writeFileSync(endpointsPath, updated);
    Config.loadEndpoints();
    res.json({ message: "Endpoint updated" });
  } catch (error) {
    console.error("Error updating endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete endpoint
router.delete("/api/endpoints", verifySession, async (req, res) => {
  try {
    const index = req.body.index;
    if (!index) return res.status(400).json({ error: "Index required" });

    // Validate index is a plain positive integer to prevent injection
    if (!/^\d+$/.test(String(index)))
      return res.status(400).json({ error: "Invalid endpoint index" });

    const endpointsPath = path.join(__dirname, "../endpoints.txt");
    const content = fs.readFileSync(endpointsPath, "utf-8");

    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(`V${index}_URL=`) &&
        !trimmed.startsWith(`V${index}_TOKEN=`) &&
        !trimmed.startsWith(`V${index}_TOKENS=`) &&
        !trimmed.startsWith(`V${index}_HEADERS=`)
      );
    });

    fs.writeFileSync(
      endpointsPath,
      lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    );
    Config.loadEndpoints();
    res.json({ message: "Endpoint deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/*
    POST for reloading and refreshing everything
*/

/*
    GET / PUT for proxy settings
*/

// Get all settings
router.get("/api/settings", verifySession, (req, res) => {
  try {
    res.json({ settings: settingsManager.getAll() });
  } catch (error) {
    console.error("Error loading settings:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update settings
router.put("/api/settings", verifySession, (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res
        .status(400)
        .json({ error: "Request body must be a JSON object of settings." });
    }
    settingsManager.update(updates);
    res.json({
      message: "Settings updated successfully.",
      settings: settingsManager.getAll(),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Reload configuration
router.post("/api/reload", verifySession, async (req, res) => {
  Config.reload();
  apiKeyManager.loadKeys();
  loadModelsFromFile();
  settingsManager.reload();
  apiKeyManager.resetDaily();

  res.json({
    status: "success",
    message: "Configuration, keys, models and settings reloaded.",
  });
});

/*
    GET for users list and individual user details
*/

// Get all users (API keys with usage stats)
router.get("/api/users", verifySession, async (req, res) => {
  try {
    const allApiKeys = apiKeyManager.keys;
    const users = [];

    for (const apiKey of Object.keys(allApiKeys)) {
      const stats = apiKeyManager.getUsageStats(apiKey);
      users.push({
        name: stats.name || "Unnamed",
        api_key: apiKey.length > 5 ? apiKey.substring(0, 5) + "..." : apiKey,
        api_key_full: apiKey, // Send full key for routing (admin-only endpoint, already behind session auth)
        active: stats.active,
        daily_requests: stats.daily_requests || 0,
        total_requests: stats.total_requests || 0,
        total_input_tokens: stats.total_input_tokens || 0,
        total_output_tokens: stats.total_output_tokens || 0,
        total_cache_write_tokens: stats.total_cache_write_tokens || 0,
        total_cache_read_tokens: stats.total_cache_read_tokens || 0,
        daily_input_tokens: stats.daily_input_tokens || 0,
        daily_output_tokens: stats.daily_output_tokens || 0,
        daily_cache_write_tokens: stats.daily_cache_write_tokens || 0,
        daily_cache_read_tokens: stats.daily_cache_read_tokens || 0,
      });
    }

    // Sort by total requests descending
    users.sort((a, b) => b.total_requests - a.total_requests);

    res.json({ users });
  } catch (error) {
    console.error("Error loading users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get individual user details with recent requests
router.get("/api/users/:apiKey", verifySession, async (req, res) => {
  try {
    const fullApiKey = req.params.apiKey;

    // Validate that the key exists
    if (!apiKeyManager.keys[fullApiKey]) {
      return res.status(404).json({ error: "User not found" });
    }

    const stats = apiKeyManager.getUsageStats(fullApiKey);
    const logs = logManager.readRequestLogs(10000);

    // Get masked key for log filtering
    const maskedKey =
      fullApiKey.length > 8
        ? fullApiKey.substring(0, 5) +
          "..." +
          fullApiKey.substring(fullApiKey.length - 3)
        : "****";

    // Filter logs for this user
    const allUserLogs = logs.filter((log) => log.api_key === maskedKey);
    const userCosts = computeCostsFromLogs(allUserLogs);

    const userLogs = allUserLogs
      .filter((log) => log.type === "request_end" && log.status === "success")
      .map((log) => ({
        timestamp: log.timestamp || 0,
        model: log.model || "Unknown",
        input_tokens: log.input_tokens || 0,
        output_tokens: log.output_tokens || 0,
        cache_write_tokens: log.cache_write_tokens || 0,
        cache_read_tokens: log.cache_read_tokens || 0,
        total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0),
        duration: log.duration || 0,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);

    res.json({
      name: stats.name || "Unnamed",
      api_key: fullApiKey.length > 5 ? fullApiKey.substring(0, 5) + "..." : fullApiKey,
      active: stats.active,
      daily_requests: stats.daily_requests || 0,
      total_requests: stats.total_requests || 0,
      total_input_tokens: stats.total_input_tokens || 0,
      total_output_tokens: stats.total_output_tokens || 0,
      total_cache_write_tokens: stats.total_cache_write_tokens || 0,
      total_cache_read_tokens: stats.total_cache_read_tokens || 0,
      daily_input_tokens: stats.daily_input_tokens || 0,
      daily_output_tokens: stats.daily_output_tokens || 0,
      daily_cache_write_tokens: stats.daily_cache_write_tokens || 0,
      daily_cache_read_tokens: stats.daily_cache_read_tokens || 0,
      total_cost: userCosts.total_cost,
      total_input_cost: userCosts.total_input_cost,
      total_output_cost: userCosts.total_output_cost,
      total_cache_write_cost: userCosts.total_cache_write_cost,
      total_cache_read_cost: userCosts.total_cache_read_cost,
      daily_cost: userCosts.daily_cost,
      daily_input_cost: userCosts.daily_input_cost,
      daily_output_cost: userCosts.daily_output_cost,
      daily_cache_write_cost: userCosts.daily_cache_write_cost,
      daily_cache_read_cost: userCosts.daily_cache_read_cost,
      recent_requests: userLogs,
    });
  } catch (error) {
    console.error("Error loading user details:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/*
    GET for model usage statistics from database
*/

// Get model usage statistics from database
router.get("/api/model-usage", verifySession, async (req, res) => {
  try {
    // Query all request_end logs from database
    const query = `
      SELECT
        model,
        COUNT(*) as request_count,
        SUM(CASE WHEN json_extract(data, '$.status') = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN json_extract(data, '$.status') = 'failed' THEN 1 ELSE 0 END) as error_count,
        SUM(CAST(json_extract(data, '$.input_tokens') AS INTEGER)) as total_input_tokens,
        SUM(CAST(json_extract(data, '$.output_tokens') AS INTEGER)) as total_output_tokens,
        SUM(CAST(json_extract(data, '$.cache_write_tokens') AS INTEGER)) as total_cache_write_tokens,
        SUM(CAST(json_extract(data, '$.cache_read_tokens') AS INTEGER)) as total_cache_read_tokens
      FROM request_logs
      WHERE type = 'request_end' AND model IS NOT NULL
      GROUP BY model
      ORDER BY total_input_tokens + total_output_tokens DESC
    `;

    const rows = logManager.db.prepare(query).all();

    const models = rows.map((row) => ({
      model: row.model,
      requests: row.request_count || 0,
      success_count: row.success_count || 0,
      errors: row.error_count || 0,
      input_tokens: row.total_input_tokens || 0,
      output_tokens: row.total_output_tokens || 0,
      cache_write_tokens: row.total_cache_write_tokens || 0,
      cache_read_tokens: row.total_cache_read_tokens || 0,
      total_tokens:
        (row.total_input_tokens || 0) +
        (row.total_output_tokens || 0) +
        (row.total_cache_write_tokens || 0) +
        (row.total_cache_read_tokens || 0),
    }));

    // Calculate totals
    const totals = models.reduce(
      (acc, model) => ({
        total_models: acc.total_models + 1,
        total_requests: acc.total_requests + model.requests,
        total_success: acc.total_success + model.success_count,
        total_errors: acc.total_errors + model.errors,
        total_input_tokens: acc.total_input_tokens + model.input_tokens,
        total_output_tokens: acc.total_output_tokens + model.output_tokens,
        total_cache_write_tokens:
          acc.total_cache_write_tokens + model.cache_write_tokens,
        total_cache_read_tokens:
          acc.total_cache_read_tokens + model.cache_read_tokens,
        total_tokens: acc.total_tokens + model.total_tokens,
      }),
      {
        total_models: 0,
        total_requests: 0,
        total_success: 0,
        total_errors: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_write_tokens: 0,
        total_cache_read_tokens: 0,
        total_tokens: 0,
      },
    );

    res.json({
      ...totals,
      models,
    });
  } catch (error) {
    console.error("Error loading model usage:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
