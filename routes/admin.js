import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifySession } from "../middleware/auth.js";
import { adminRateLimit } from "../middleware/rateLimiter.js";
import settingsManager from "../services/settingsManager.js";
import apiKeyManager from "../services/apiKeyManager.js";
import logManager from "../services/logManager.js";
import keyStateManager from "../services/keyStateManager.js";
import Config from "../config/index.js";
import { loadModelsFromFile, normalizeEndpointUrl, getEndpointForModel, getFullUrl, maskKey } from "../utils/helpers.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import axios from "axios";
import { calculateCost } from "../utils/logging.js";
import { getApiKeyId } from "../utils/keyIdentity.js";
import crypto from "crypto";
import { createSession, deleteSession } from "../services/sessionManager.js";
import {
  findAutoDependents,
  rewriteAutoTargetReferences,
  validateModelDefinition,
} from "../utils/autoRouting.js";
import { getEndpointsPath, getModelsPath } from "../utils/configPaths.js";

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
      log.token_accounting_version ?? null,
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

const DASHBOARD_RANGES = {
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  total: null,
};

function emptyDashboardAggregate() {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    success_rate: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    input_cost: 0,
    output_cost: 0,
    cache_write_cost: 0,
    cache_read_cost: 0,
    estimated_cost: 0,
  };
}

function addRequestToAggregate(aggregate, request) {
  aggregate.requests += 1;
  if (request.status === "success") aggregate.successes += 1;
  if (request.status === "failed") aggregate.failures += 1;
  aggregate.input_tokens += request.inputTokens;
  aggregate.output_tokens += request.outputTokens;
  aggregate.cache_write_tokens += request.cacheWriteTokens;
  aggregate.cache_read_tokens += request.cacheReadTokens;
  if (request.status === "success") {
    const costs = calculateCost(
      request.model,
      request.inputTokens,
      request.outputTokens,
      request.cacheWriteTokens,
      request.cacheReadTokens,
      request.tokenAccountingVersion,
    );
    aggregate.input_cost += costs.inputCost;
    aggregate.output_cost += costs.outputCost;
    aggregate.cache_write_cost += costs.cacheWriteCost;
    aggregate.cache_read_cost += costs.cacheReadCost;
    aggregate.estimated_cost += costs.totalCost;
  }
}

function finalizeDashboardAggregate(aggregate) {
  return {
    ...aggregate,
    success_rate: aggregate.requests
      ? (aggregate.successes / aggregate.requests) * 100
      : 0,
  };
}

function buildDashboardRanges(requests, configuredKeys) {
  const now = Date.now() / 1000;
  const keyDefinitions = Object.entries(configuredKeys).map(([apiKey, key]) => ({
    id: getApiKeyId(apiKey),
    mask: maskKey(apiKey),
    name: key.name || "Unnamed",
  }));
  const masks = new Map();
  for (const key of keyDefinitions) {
    masks.set(key.mask, (masks.get(key.mask) || 0) + 1);
  }

  return Object.fromEntries(
    Object.entries(DASHBOARD_RANGES).map(([range, seconds]) => {
      const from = seconds === null ? null : now - seconds;
      const matching = requests.filter(
        (request) =>
          request.timestamp !== null && (from === null || request.timestamp >= from),
      );
      const summary = emptyDashboardAggregate();
      const byKey = new Map(
        keyDefinitions.map((key) => [key.id, emptyDashboardAggregate()]),
      );

      for (const request of matching) {
        addRequestToAggregate(summary, request);
        let keyId = request.apiKeyId;
        if (!keyId && masks.get(request.apiKey) === 1) {
          keyId = keyDefinitions.find((key) => key.mask === request.apiKey)?.id;
        }
        if (keyId && byKey.has(keyId)) {
          addRequestToAggregate(byKey.get(keyId), request);
        }
      }

      const apiKeys = keyDefinitions
        .map((key) => ({
          id: key.id,
          name: key.name,
          api_key: key.mask,
          ...finalizeDashboardAggregate(byKey.get(key.id)),
        }))
        .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));

      return [range, { summary: finalizeDashboardAggregate(summary), api_keys: apiKeys }];
    }),
  );
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
    const maskedKey = maskKey(apiKey);

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
      const model = log.model || "Unknown";
      const costs = calculateCost(
        model,
        log.input_tokens,
        log.output_tokens,
        log.cache_write_tokens,
        log.cache_read_tokens,
        log.token_accounting_version ?? null,
      );
      return {
        timestamp: log.timestamp || 0,
        request_id: log.request_id || "",
        name:
          log.key_name ||
          (apiKey !== "Unknown" ? apiKeyManager.getKeyName(apiKey) : "Unknown"),
        api_key: apiKey.length > 5 ? apiKey.substring(0, 5) + "..." : apiKey,
        model,
        input_tokens: log.input_tokens || 0,
        output_tokens: log.output_tokens || 0,
        cache_write_tokens: log.cache_write_tokens || 0,
        cache_read_tokens: log.cache_read_tokens || 0,
        token_accounting_version:
          log.token_accounting_version ?? null,
        total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0),
        duration: log.duration || 0,
        cost: costs.totalCost,
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

  const ranges = buildDashboardRanges(
    logManager.getDashboardRequestLogs(),
    allApiKeys,
  );

  res.json({
    summary: totals,
    api_keys: dashboardData,
    recent_logs: formattedLogs,
    ranges,
  });
});

function parseRequestInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return null;
  }
  return parsed;
}

router.get("/api/requests/filters", verifySession, (_req, res) => {
  try {
    return res.json(logManager.getRequestHistoryFilters());
  } catch (error) {
    console.error("Error loading request filters:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/requests", verifySession, (req, res) => {
  const limit = parseRequestInteger(req.query.limit, 50, 1, 50);
  const cursor = parseRequestInteger(
    req.query.cursor,
    null,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (limit === null || (req.query.cursor !== undefined && cursor === null)) {
    return res.status(400).json({ error: "Invalid pagination values" });
  }

  const stringFilters = ["apiKey", "model", "status"];
  if (
    stringFilters.some(
      (name) =>
        req.query[name] !== undefined && typeof req.query[name] !== "string",
    )
  ) {
    return res.status(400).json({ error: "Invalid filter value" });
  }

  const status = req.query.status?.trim() || null;
  if (status && status !== "success" && status !== "failed") {
    return res.status(400).json({ error: "Invalid request status" });
  }

  const parseTimestamp = (value) => {
    if (value === undefined || value === "") return null;
    if (typeof value !== "string") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const from = parseTimestamp(req.query.from);
  const to = parseTimestamp(req.query.to);
  if (
    from === undefined ||
    to === undefined ||
    (from !== null && to !== null && from > to)
  ) {
    return res.status(400).json({ error: "Invalid time range" });
  }

  try {
    const result = logManager.getRequestHistory({
      limit,
      cursor,
      apiKey: req.query.apiKey?.trim() || null,
      model: req.query.model?.trim() || null,
      status,
      from,
      to,
    });
    const requests = result.requests.map((request) => {
      const costs = calculateCost(
        request.model,
        request.inputTokens,
        request.outputTokens,
        request.cacheWriteTokens,
        request.cacheReadTokens,
        request.tokenAccountingVersion,
      );
      const { tokenAccountingVersion, ...safeRequest } = request;
      return { ...safeRequest, estimatedCost: costs.totalCost };
    });

    return res.json({
      requests,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    console.error("Error loading request history:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// List stored upstream errors with exact-match filters and pagination.
router.get("/api/errors", verifySession, (req, res) => {
  try {
    const parseInteger = (value, fallback, minimum, maximum) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string" || !/^\d+$/.test(value)) return null;

      const parsed = Number(value);
      if (parsed < minimum || parsed > maximum) return null;
      return parsed;
    };

    const limit = parseInteger(req.query.limit, 50, 1, 200);
    const offset = parseInteger(
      req.query.offset,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (limit === null || offset === null) {
      return res.status(400).json({ error: "Invalid pagination values" });
    }

    let statusCode;
    if (req.query.status !== undefined) {
      statusCode = parseInteger(req.query.status, null, 100, 599);
      if (statusCode === null) {
        return res.status(400).json({ error: "Invalid HTTP status" });
      }
    }

    if (
      (req.query.model !== undefined && typeof req.query.model !== "string") ||
      (req.query.endpoint !== undefined &&
        typeof req.query.endpoint !== "string") ||
      (req.query.key !== undefined && typeof req.query.key !== "string")
    ) {
      return res.status(400).json({ error: "Invalid filter value" });
    }

    const filters = {
      limit,
      offset,
      model: req.query.model?.trim() || null,
      endpoint: req.query.endpoint?.trim() || null,
      key: req.query.key?.trim() || null,
      statusCode,
    };
    const errors = logManager.getErrorLogs(filters);
    const total = logManager.getErrorLogCount(filters);

    return res.json({ errors, total, limit, offset });
  } catch (error) {
    console.error("Error loading stored errors:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Filter values must be declared before /api/errors/:id.
router.get("/api/errors/filters", verifySession, (_req, res) => {
  try {
    return res.json(logManager.getErrorLogFilters());
  } catch (error) {
    console.error("Error loading error filters:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/errors/:id", verifySession, (req, res) => {
  if (!/^\d+$/.test(req.params.id) || Number(req.params.id) < 1) {
    return res.status(400).json({ error: "Invalid error ID" });
  }

  try {
    const errorLog = logManager.getErrorLogById(req.params.id);
    if (!errorLog) {
      return res.status(404).json({ error: "Error log not found" });
    }
    return res.json({ error: errorLog });
  } catch (error) {
    console.error("Error loading error detail:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/api/errors", verifySession, (_req, res) => {
  try {
    const deleted = logManager.clearErrorLogs();
    return res.json({ success: true, deleted });
  } catch (error) {
    console.error("Error clearing stored errors:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
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
    const rpd = req.body.rpd || settingsManager.get("rpdDefault");
    const rpm = req.body.rpm || settingsManager.get("rpmDefault");
    const max_context_size =
      req.body.max_context_size !== undefined
        ? parseInt(req.body.max_context_size, 10)
        : settingsManager.get("maxContextSizeDefault");

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
        : settingsManager.get("maxContextSizeDefault");
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

const DEFAULT_MODEL_PRICING = {
  input: 1,
  output: 1,
  cache_write: 1,
  cache_read: 1,
};

function readModelsDocument() {
  const modelsPath = getModelsPath();
  if (!fs.existsSync(modelsPath)) return { models: {} };
  const data = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
  data.models ||= {};
  return data;
}

function readEndpointsDocument() {
  const endpointsPath = getEndpointsPath();
  if (!fs.existsSync(endpointsPath)) return {};
  return JSON.parse(fs.readFileSync(endpointsPath, "utf-8"));
}

function modelType(config) {
  return config?.type === "auto" ? "auto" : "concrete";
}

function modelValidationContext(models) {
  return {
    models,
    endpoints: readEndpointsDocument(),
    globalCeiling: settingsManager.get("autoModelMaxTargetAttempts"),
  };
}

function validateAdminModel(name, config, models) {
  const result = validateModelDefinition(name, config, modelValidationContext(models));
  return result.valid ? null : result.errors.join("; ");
}

function normalizedModelRecord(name, config) {
  const common = {
    name,
    modelType: modelType(config),
    disabled: config.disabled === true,
    pricing: config.pricing || { ...DEFAULT_MODEL_PRICING },
  };
  if (common.modelType === "auto") {
    return {
      ...common,
      targets: Array.isArray(config.targets) ? [...config.targets] : [],
      targetSelection: config.targetSelection || "sticky",
      maxTargetAttempts: config.maxTargetAttempts ?? null,
    };
  }
  return {
    ...common,
    backend: typeof config.backend === "string" ? config.backend : name,
    version: typeof config.version === "string" ? config.version : "",
  };
}

function buildStoredModel(definition, existing = {}) {
  const incoming = { ...definition };
  delete incoming.name;
  delete incoming.oldName;
  if (incoming.modelType !== undefined) {
    incoming.type = incoming.modelType === "auto" ? "auto" : "concrete";
    delete incoming.modelType;
  }
  const stored = {
    ...existing,
    ...incoming,
    pricing: incoming.pricing ?? existing.pricing ?? { ...DEFAULT_MODEL_PRICING },
    disabled: incoming.disabled ?? existing.disabled ?? false,
  };
  const type = modelType(stored);
  if (type === "auto") {
    stored.type = "auto";
    delete stored.backend;
    delete stored.version;
  } else {
    delete stored.type;
    delete stored.targets;
    delete stored.targetSelection;
    delete stored.maxTargetAttempts;
  }
  return stored;
}

function dependencyConflict(res, dependents, message) {
  return res.status(409).json({ error: message, dependents });
}

// Get all models as normalized concrete/auto records.
router.get("/api/models", verifySession, async (_req, res) => {
  try {
    const data = readModelsDocument();
    return res.json({
      models: Object.entries(data.models).map(([name, config]) =>
        normalizedModelRecord(name, config),
      ),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Add model. Concrete and auto definitions share the same validator.
router.post("/api/models", verifySession, async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "Model name required" });

    const data = readModelsDocument();
    if (data.models[name]) {
      return res.status(400).json({ error: "Model already exists" });
    }

    const stored = buildStoredModel(req.body);
    const candidateModels = { ...data.models, [name]: stored };
    const validationError = validateAdminModel(name, stored, candidateModels);
    if (validationError) return res.status(400).json({ error: validationError });

    data.models[name] = stored;
    fs.writeFileSync(getModelsPath(), JSON.stringify(data, null, 2));
    loadModelsFromFile();
    return res.json({ message: "Model added" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Update model while preserving disabled and unrelated persisted fields.
router.put("/api/models", verifySession, async (req, res) => {
  try {
    const oldName = typeof req.body.oldName === "string" ? req.body.oldName.trim() : "";
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!oldName) return res.status(400).json({ error: "Old model name required" });
    if (!name) return res.status(400).json({ error: "Model name required" });

    const modelsPath = getModelsPath();
    if (!fs.existsSync(modelsPath)) {
      return res.status(404).json({ error: "Models file not found" });
    }
    const originalContent = fs.readFileSync(modelsPath, "utf-8");
    const data = JSON.parse(originalContent);
    data.models ||= {};
    const existing = data.models[oldName];
    if (!existing) return res.status(404).json({ error: "Model not found" });

    const nameChanged = oldName !== name;
    if (nameChanged && data.models[name]) {
      return res.status(400).json({ error: "Model already exists" });
    }

    const updates = { ...req.body };
    delete updates.oldName;
    delete updates.name;
    const stored = buildStoredModel(updates, existing);
    const existingIsConcrete = modelType(existing) === "concrete";
    if (existingIsConcrete && (modelType(stored) !== "concrete" || stored.disabled === true)) {
      const dependents = findAutoDependents(data.models, oldName);
      if (dependents.length) {
        return dependencyConflict(res, dependents, "Referenced concrete model cannot be disabled or converted");
      }
    }

    const candidateModels = { ...data.models };
    if (nameChanged) delete candidateModels[oldName];
    candidateModels[name] = stored;
    if (nameChanged && existingIsConcrete && modelType(stored) === "concrete") {
      rewriteAutoTargetReferences(candidateModels, oldName, name);
    }
    const validationError = validateAdminModel(name, stored, candidateModels);
    if (validationError) return res.status(400).json({ error: validationError });

    data.models = candidateModels;
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    try {
      if (nameChanged) logManager.renameModel(oldName, name);
    } catch (error) {
      fs.writeFileSync(modelsPath, originalContent);
      throw error;
    }

    loadModelsFromFile();
    return res.json({ message: "Model updated" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete("/api/models", verifySession, async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "Model name required" });
    const modelsPath = getModelsPath();
    if (!fs.existsSync(modelsPath)) {
      return res.status(404).json({ error: "Models file not found" });
    }
    const data = readModelsDocument();
    const existing = data.models[name];
    if (!existing) return res.status(404).json({ error: "Model not found" });
    if (modelType(existing) === "concrete") {
      const dependents = findAutoDependents(data.models, name);
      if (dependents.length) {
        return dependencyConflict(res, dependents, "Referenced concrete model cannot be deleted");
      }
    }

    delete data.models[name];
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    loadModelsFromFile();
    return res.json({ message: "Model deleted" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.patch("/api/models/toggle", verifySession, async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "Model name required" });
    const modelsPath = getModelsPath();
    if (!fs.existsSync(modelsPath)) {
      return res.status(404).json({ error: "Models file not found" });
    }
    const data = readModelsDocument();
    const existing = data.models[name];
    if (!existing) return res.status(404).json({ error: "Model not found" });

    const disabled = existing.disabled !== true;
    if (disabled && modelType(existing) === "concrete") {
      const dependents = findAutoDependents(data.models, name);
      if (dependents.length) {
        return dependencyConflict(res, dependents, "Referenced concrete model cannot be disabled");
      }
    }
    const updated = { ...existing, disabled };
    if (!disabled) {
      const validationError = validateAdminModel(name, updated, { ...data.models, [name]: updated });
      if (validationError) return res.status(400).json({ error: validationError });
    }
    data.models[name] = updated;
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    loadModelsFromFile();
    return res.json({ message: `Model ${disabled ? "disabled" : "enabled"}`, disabled });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/models/test — fire a silent ping to the upstream for a model.
// Does NOT touch logs, dashboard, stats, or rate-limit counters.
router.post("/api/models/test", verifySession, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "Model name required" });

    const modelsData = readModelsDocument();
    const modelConfig = modelsData.models[name];
    if (!modelConfig) {
      return res.status(400).json({ ok: false, error: `Model '${name}' does not exist` });
    }
    if (modelType(modelConfig) === "auto") {
      return res.status(400).json({ ok: false, error: "Auto models cannot be tested directly" });
    }
    if (modelConfig.disabled === true) {
      return res.status(400).json({ ok: false, error: "Disabled models cannot be tested" });
    }

    // ignoreState selects the endpoint's first configured token without advancing
    // endpoint key rotation or consulting mutable key health state.
    const endpointInfo = getEndpointForModel(name, { ignoreState: true });
    if (!endpointInfo) {
      return res.status(400).json({ ok: false, error: `No endpoint configured for model '${name}'` });
    }

    const { url: backendUrl, token: backendToken, actualModel, customHeaders, apiFormat } = endpointInfo;
    const fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, false, endpointInfo.appendApiSuffix);

    const start = Date.now();

    // Gemini uses a different auth + body shape
    const isGemini = apiFormat === 'gemini';
    // Stable identifier for this ping so the Codex cache key and ID headers
    // stay internally consistent for the single test request.
    const testRequestId = `models-test-${crypto.randomUUID()}`;
    // Codex needs its marker/ID headers on the ping; other formats are left
    // exactly as before. These merge before auth/content-type so they can never
    // override the bearer token or content type.
    const codexHeaders =
      apiFormat === 'openai-codex'
        ? getExtraHeaders(apiFormat, { requestId: testRequestId, isStreaming: false })
        : {};
    const requestHeaders = {
      ...customHeaders,
      ...codexHeaders,
      "Content-Type": "application/json",
      ...(isGemini ? {} : { Authorization: `Bearer ${backendToken}` }),
    };
    const requestUrl = isGemini ? `${fullUrl}?key=${backendToken}` : fullUrl;
    let requestBody;
    if (isGemini) {
      requestBody = { contents: [{ parts: [{ text: "ping" }] }] };
    } else if (apiFormat === 'anthropic') {
      // Anthropic requires max_tokens — keep it but don't send temperature/top_p
      requestBody = { model: actualModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
    } else if (apiFormat === 'openai-codex') {
      // Codex requires an array-shaped input, populated `include`, and a
      // non-empty prompt_cache_key. Build via the adapter so the ping matches
      // the enforced envelope rather than hand-rolling it here.
      const pingReq = { model: actualModel, messages: [{ role: "user", content: "ping" }] };
      requestBody = getAdapter(apiFormat).transformRequest(pingReq, actualModel, {
        requestId: testRequestId,
        isStreaming: false,
      });
      requestBody.stream = false;
    } else if (apiFormat === 'openai-responses') {
      // Responses API uses input instead of messages; don't persist the ping
      requestBody = { model: actualModel, input: "ping", store: false, stream: false };
    } else {
      // OpenAI format — newer reasoning models reject max_tokens, temperature, top_p
      // This is just a connectivity ping, so send the bare minimum.
      requestBody = { model: actualModel, messages: [{ role: "user", content: "ping" }], stream: false };
    }

    const response = await axios({
      method: "post",
      url: requestUrl,
      headers: requestHeaders,
      data: requestBody,
      timeout: 15000,
    });

    const latency_ms = Date.now() - start;

    if (response.status !== 200) {
      return res.json({ ok: false, error: `Upstream returned HTTP ${response.status}`, latency_ms });
    }

    return res.json({ ok: true, latency_ms });
  } catch (error) {
    const latency_ms = Date.now();
    const status = error.response?.status;
    const msg = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || "Request failed";
    return res.json({ ok: false, error: status ? `HTTP ${status}: ${msg}` : msg });
  }
});

/*
    GET PUT POST DELETE for endpoints.json
*/

// Get all endpoints
router.get("/api/endpoints", verifySession, async (req, res) => {
  try {
    const endpointsPath = getEndpointsPath();
    
    if (!fs.existsSync(endpointsPath)) {
      return res.json({ endpoints: [] });
    }

    const content = fs.readFileSync(endpointsPath, "utf-8");
    const data = JSON.parse(content);

    const endpoints = [];
    for (const [key, endpoint] of Object.entries(data)) {
      const match = key.match(/^v(\d+)$/);
      if (!match) continue;

      const rawTokens = endpoint.tokens || [];
      const maskedTokens = rawTokens.map((t) =>
        t.length > 8
          ? t.substring(0, 4) + "****" + t.substring(t.length - 4)
          : "****"
      );

      endpoints.push({
        index: parseInt(match[1]),
        name: endpoint.name || `Endpoint ${match[1]}`,
        url: endpoint.url,
        token: maskedTokens[0],
        tokens: maskedTokens,
        headers: endpoint.headers || {},
        apiFormat: endpoint.apiFormat || 'openai',
        appendApiSuffix: endpoint.appendApiSuffix !== false,
        generationDefaults: endpoint.generationDefaults || settingsManager.getDefaultGenerationDefaults(),
        promptCaching: endpoint.promptCaching !== undefined ? endpoint.promptCaching : null,
        keyRotation: endpoint.keyRotation ?? null,
        keyHealth: endpoint.keyHealth ?? null,
      });
    }

    // Sort by index
    endpoints.sort((a, b) => a.index - b.index);

    res.json({ endpoints });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add endpoint
router.post("/api/endpoints", verifySession, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
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

    // Validate and capture apiFormat from request, falling back to admin panel default
    const VALID_FORMATS = ['openai', 'anthropic', 'gemini', 'openai-responses', 'openai-codex'];
    const apiFormat =
      (req.body.apiFormat !== undefined
        ? req.body.apiFormat
        : settingsManager.get("defaultEndpointApiFormat")) || "openai";
    if (!VALID_FORMATS.includes(apiFormat)) {
      return res.status(400).json({ error: `Invalid apiFormat. Must be one of: ${VALID_FORMATS.join(', ')}` });
    }

    // Validate optional headers if provided
    let headersObj = {};
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

    const endpointsPath = getEndpointsPath();
    let data = {};
    
    if (fs.existsSync(endpointsPath)) {
      const content = fs.readFileSync(endpointsPath, "utf-8");
      data = JSON.parse(content);
    }

    // Find the next available index
    let maxIndex = 0;
    for (const key of Object.keys(data)) {
      const match = key.match(/^v(\d+)$/);
      if (match) maxIndex = Math.max(maxIndex, parseInt(match[1]));
    }

    const newIndex = maxIndex + 1;
    const endpointKey = `v${newIndex}`;
    if (req.body.appendApiSuffix !== undefined && typeof req.body.appendApiSuffix !== "boolean") {
      return res.status(400).json({ error: "appendApiSuffix must be a boolean" });
    }
    const appendApiSuffix = req.body.appendApiSuffix !== false;
    const normalizedUrl = normalizeEndpointUrl(url, appendApiSuffix);

    // Resolve generation policy from admin panel defaults when client provides none
    let generationDefaults = validateGenerationDefaults(req.body.generationDefaults);
    if (!req.body.generationDefaults || typeof req.body.generationDefaults !== "object" || Array.isArray(req.body.generationDefaults)) {
      generationDefaults = settingsManager.getDefaultGenerationDefaults();
    }

    // Resolve prompt caching from admin panel defaults when client provides none
    let promptCaching = validatePromptCaching(req.body.promptCaching);
    if (req.body.promptCaching === undefined) {
      promptCaching = settingsManager.getDefaultPromptCaching();
    }

    // Seed key rotation from the client value, else the global default.
    let keyRotation = validateKeyRotation(req.body.keyRotation);
    if (keyRotation === null) {
      keyRotation = validateKeyRotation(settingsManager.get("defaultEndpointKeyRotation")) || "sticky";
    }

    // Seed key health from the client value, else the global default.
    let keyHealth = validateKeyHealth(req.body.keyHealth);
    if (keyHealth === null) {
      keyHealth = settingsManager.get("defaultEndpointKeyHealth") !== false;
    }

    data[endpointKey] = {
      name: name || `Endpoint ${newIndex}`,
      url: normalizedUrl,
      tokens,
      headers: headersObj,
      apiFormat,
      appendApiSuffix,
      generationDefaults,
      promptCaching,
      keyRotation,
      keyHealth,
    };

    fs.writeFileSync(endpointsPath, JSON.stringify(data, null, 2));
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
    const name = req.body.name !== undefined ? (req.body.name || "").trim() : undefined;
    const url = (req.body.url || "").trim();
    if (!index || !url)
      return res.status(400).json({ error: "Index and URL are required" });

    // Validate and capture apiFormat (undefined means keep existing)
    const VALID_FORMATS = ['openai', 'anthropic', 'gemini', 'openai-responses', 'openai-codex'];
    let apiFormat = undefined;
    if (req.body.apiFormat !== undefined) {
      apiFormat = req.body.apiFormat;
      if (!VALID_FORMATS.includes(apiFormat)) {
        return res.status(400).json({ error: `Invalid apiFormat. Must be one of: ${VALID_FORMATS.join(', ')}` });
      }
    }

    // Validate optional suffix behavior if provided (undefined = keep existing)
    let appendApiSuffix = undefined;
    if (req.body.appendApiSuffix !== undefined) {
      if (typeof req.body.appendApiSuffix !== "boolean") {
        return res.status(400).json({ error: "appendApiSuffix must be a boolean" });
      }
      appendApiSuffix = req.body.appendApiSuffix;
    }

    // Validate optional generation defaults if provided
    let generationDefaults = undefined;
    if (req.body.generationDefaults !== undefined) {
      generationDefaults = validateGenerationDefaults(req.body.generationDefaults);
    }

    // Validate optional prompt caching if provided
    let promptCaching = undefined;
    if (req.body.promptCaching !== undefined) {
      promptCaching = validatePromptCaching(req.body.promptCaching);
    }

    // Validate optional key rotation if provided (undefined = keep existing)
    let keyRotation = undefined;
    if (req.body.keyRotation !== undefined) {
      keyRotation = validateKeyRotation(req.body.keyRotation) || "sticky";
    }

    // Validate optional key health if provided (undefined = keep existing)
    let keyHealth = undefined;
    if (req.body.keyHealth !== undefined) {
      const parsed = validateKeyHealth(req.body.keyHealth);
      keyHealth = parsed === null ? true : parsed;
    }

    // Validate index is a plain positive integer to prevent RegExp injection
    if (!/^\d+$/.test(String(index)))
      return res.status(400).json({ error: "Invalid endpoint index" });

    const endpointKey = `v${index}`;
    const endpointsPath = getEndpointsPath();
    
    if (!fs.existsSync(endpointsPath)) {
      return res.status(404).json({ error: "Endpoints file not found" });
    }

    const content = fs.readFileSync(endpointsPath, "utf-8");
    const data = JSON.parse(content);

    // Check the endpoint exists
    if (!data[endpointKey]) {
      return res.status(404).json({ error: "Endpoint not found" });
    }

    // Accept either `tokens` (array) or legacy `token` (string).
    // undefined tokens field = keep existing untouched (no tokens key sent at all).
    let incomingTokens = null; // null means "don't touch tokens"
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
    let resolvedTokens = null;
    if (incomingTokens !== null) {
      if (incomingTokens.length === 0) {
        return res.status(400).json({ error: "At least one token is required" });
      }

      const hasMasked = incomingTokens.some((t) => t.includes("****"));

      if (hasMasked) {
        // Read the real stored tokens so we can de-mask
        const storedTokens = data[endpointKey].tokens || [];

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

    // Update the endpoint object
    if (name !== undefined) {
      data[endpointKey].name = name || `Endpoint ${index}`;
    }
    const effectiveAppendApiSuffix = appendApiSuffix ?? (data[endpointKey].appendApiSuffix !== false);
    data[endpointKey].url = normalizeEndpointUrl(url, effectiveAppendApiSuffix);
    if (appendApiSuffix !== undefined) {
      data[endpointKey].appendApiSuffix = appendApiSuffix;
    }
    if (resolvedTokens !== null) {
      data[endpointKey].tokens = resolvedTokens;
    }
    if (headersProvided) {
      data[endpointKey].headers = headersObj || {};
    }
    if (apiFormat !== undefined) {
      data[endpointKey].apiFormat = apiFormat;
    }
    if (generationDefaults !== undefined) {
      data[endpointKey].generationDefaults = generationDefaults;
    }
    if (promptCaching !== undefined) {
      data[endpointKey].promptCaching = promptCaching;
    }
    if (keyRotation !== undefined) {
      data[endpointKey].keyRotation = keyRotation;
    }
    if (keyHealth !== undefined) {
      data[endpointKey].keyHealth = keyHealth;
    }

    fs.writeFileSync(endpointsPath, JSON.stringify(data, null, 2));
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

    const endpointKey = `v${index}`;
    const endpointsPath = getEndpointsPath();
    
    if (!fs.existsSync(endpointsPath)) {
      return res.status(404).json({ error: "Endpoints file not found" });
    }

    const content = fs.readFileSync(endpointsPath, "utf-8");
    const data = JSON.parse(content);

    if (!data[endpointKey]) {
      return res.status(404).json({ error: "Endpoint not found" });
    }

    const modelsPath = getModelsPath();
    const modelsContent = fs.existsSync(modelsPath)
      ? fs.readFileSync(modelsPath, "utf-8")
      : null;
    const modelsData = modelsContent === null
      ? { models: {} }
      : JSON.parse(modelsContent);
    modelsData.models ||= {};

    const endpointConcreteModels = Object.entries(modelsData.models)
      .filter(([, config]) => modelType(config) === "concrete" && config.version === endpointKey)
      .map(([modelName]) => modelName);
    const blockingConcreteModels = endpointConcreteModels.filter(
      (modelName) => findAutoDependents(modelsData.models, modelName).length > 0,
    );
    const autoBlockers = [...new Set(
      blockingConcreteModels.flatMap((modelName) =>
        findAutoDependents(modelsData.models, modelName),
      ),
    )];
    if (autoBlockers.length) {
      return res.status(409).json({
        error: "Endpoint models are referenced by auto models",
        blockers: { concrete: blockingConcreteModels, auto: autoBlockers },
      });
    }

    for (const modelName of endpointConcreteModels) {
      delete modelsData.models[modelName];
    }
    delete data[endpointKey];
    fs.writeFileSync(endpointsPath, JSON.stringify(data, null, 2));
    try {
      if (modelsContent !== null && endpointConcreteModels.length > 0) {
        fs.writeFileSync(modelsPath, JSON.stringify(modelsData, null, 2));
      }
    } catch (error) {
      fs.writeFileSync(endpointsPath, content);
      throw error;
    }

    Config.loadEndpoints();
    if (modelsContent !== null && endpointConcreteModels.length > 0) {
      loadModelsFromFile();
    }
    return res.json({
      message: "Endpoint deleted",
      deletedModels: endpointConcreteModels.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/endpoints/:version/models — proxy upstream model list for an endpoint.
// Uses the stored real token server-side so masked tokens are never exposed.
// Supports OpenAI-compatible, Anthropic, and Gemini formats.
router.get("/api/endpoints/:version/models", verifySession, async (req, res) => {
  try {
    const version = req.params.version;
    if (!/^v\d+$/.test(version)) {
      return res.status(400).json({ error: "Invalid endpoint version" });
    }

    const endpointInfo = getEndpointForModel(`proxy-${version}`, { ignoreState: true });
    if (!endpointInfo) {
      return res.status(404).json({ error: `Endpoint ${version} not found` });
    }

    const { url: backendUrl, token: backendToken, customHeaders, apiFormat } = endpointInfo;

    let requestUrl;
    let requestHeaders = { ...customHeaders };
    let extractModels = (data) => [];

    if (apiFormat === 'gemini') {
      // Gemini: key goes in query string, no Authorization header
      requestUrl = `${backendUrl}/v1beta/models?key=${encodeURIComponent(backendToken)}`;
      extractModels = (data) => {
        const list = Array.isArray(data.models) ? data.models : [];
        return list
          .map((m) => {
            const raw = typeof m === 'string' ? m : (m.name || '');
            // Gemini returns "models/gemini-1.5-flash"; strip the prefix
            return raw.replace(/^models\//, '');
          })
          .filter(Boolean);
      };
    } else if (apiFormat === 'anthropic') {
      // Anthropic: x-api-key header, optional anthropic-version
      requestUrl = `${backendUrl}/v1/models`;
      requestHeaders = {
        ...requestHeaders,
        'Content-Type': 'application/json',
        'x-api-key': backendToken,
        'anthropic-version': '2023-06-01',
      };
      extractModels = (data) => {
        const list = Array.isArray(data.data) ? data.data : [];
        return list
          .map((m) => (typeof m === 'string' ? m : (m.id || '')))
          .filter(Boolean);
      };
    } else {
      // OpenAI-compatible (default)
      requestUrl = `${backendUrl}/v1/models`;
      requestHeaders = {
        ...requestHeaders,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backendToken}`,
      };
      extractModels = (data) => {
        const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
        return list
          .map((m) => (typeof m === 'string' ? m : (m.id || '')))
          .filter(Boolean);
      };
    }

    const response = await axios({
      method: 'get',
      url: requestUrl,
      headers: requestHeaders,
      timeout: 15000,
    });

    if (response.status !== 200) {
      return res.status(502).json({ error: `Upstream returned HTTP ${response.status}` });
    }

    const models = extractModels(response.data);
    res.json({ models });
  } catch (error) {
    const status = error.response?.status;
    const msg = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || "Request failed";
    res.status(502).json({ error: status ? `HTTP ${status}: ${msg}` : msg });
  }
});

// Read the raw tokens for a validated endpoint version from endpoints.json.
// Helper for the key-state routes — the raw tokens never leave the server;
// they're only used to compute hashes/masks. Returns null if not found.
function readEndpointTokens(version) {
  const endpointsPath = getEndpointsPath();
  if (!fs.existsSync(endpointsPath)) return null;
  const data = JSON.parse(fs.readFileSync(endpointsPath, "utf-8"));
  const endpoint = data[`v${version}`];
  if (!endpoint) return null;
  return endpoint.tokens || [];
}

// GET /api/endpoints/:version/keys — per-key health + usage for the admin modal.
// Returns masked/hashed data only, never raw tokens.
router.get("/api/endpoints/:version/keys", verifySession, (req, res) => {
  try {
    const version = req.params.version;
    if (!/^\d+$/.test(version)) {
      return res.status(400).json({ error: "Invalid endpoint version" });
    }

    const tokens = readEndpointTokens(version);
    if (tokens === null) {
      return res.status(404).json({ error: `Endpoint v${version} not found` });
    }

    const keys = keyStateManager.getStatesForEndpoint(`v${version}`, tokens);
    res.json({ keys });
  } catch (error) {
    console.error("Error loading key states:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/endpoints/:version/keys/reset — re-enable a key (invalid/timeout →
// active), or all keys when { all: true }. Body: { tokenHash } | { all: true }.
router.post("/api/endpoints/:version/keys/reset", verifySession, (req, res) => {
  try {
    const version = req.params.version;
    if (!/^\d+$/.test(version)) {
      return res.status(400).json({ error: "Invalid endpoint version" });
    }
    if (readEndpointTokens(version) === null) {
      return res.status(404).json({ error: `Endpoint v${version} not found` });
    }

    const all = req.body.all === true;
    const tokenHash = typeof req.body.tokenHash === "string" ? req.body.tokenHash : null;
    if (!all && !tokenHash) {
      return res.status(400).json({ error: "tokenHash or all:true required" });
    }

    const changes = keyStateManager.resetKey(`v${version}`, { tokenHash, all });
    res.json({ message: "Key state reset", changes });
  } catch (error) {
    console.error("Error resetting key state:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/endpoints/:version/keys/disable — manually disable a key so it is
// skipped during rotation until re-enabled. Body: { tokenHash }. The raw token
// is resolved server-side from the tokenHash and never leaves the server.
router.post("/api/endpoints/:version/keys/disable", verifySession, (req, res) => {
  try {
    const version = req.params.version;
    if (!/^\d+$/.test(version)) {
      return res.status(400).json({ error: "Invalid endpoint version" });
    }

    const tokens = readEndpointTokens(version);
    if (tokens === null) {
      return res.status(404).json({ error: `Endpoint v${version} not found` });
    }

    const tokenHash = typeof req.body.tokenHash === "string" ? req.body.tokenHash : null;
    if (!tokenHash) {
      return res.status(400).json({ error: "tokenHash required" });
    }

    const endpointKey = `v${version}`;
    const token = tokens.find(
      (t) => keyStateManager.hashToken(endpointKey, t) === tokenHash,
    );
    if (!token) {
      return res.status(404).json({ error: "Key not found for this endpoint" });
    }

    keyStateManager.disableKey(endpointKey, token);
    res.json({ message: "Key disabled" });
  } catch (error) {
    console.error("Error disabling key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/endpoints/:version/keys/reset-stats — zero request/failure counters
// for a key, or all keys when { all: true }. Body: { tokenHash } | { all: true }.
router.post("/api/endpoints/:version/keys/reset-stats", verifySession, (req, res) => {
  try {
    const version = req.params.version;
    if (!/^\d+$/.test(version)) {
      return res.status(400).json({ error: "Invalid endpoint version" });
    }
    if (readEndpointTokens(version) === null) {
      return res.status(404).json({ error: `Endpoint v${version} not found` });
    }

    const all = req.body.all === true;
    const tokenHash = typeof req.body.tokenHash === "string" ? req.body.tokenHash : null;
    if (!all && !tokenHash) {
      return res.status(400).json({ error: "tokenHash or all:true required" });
    }

    keyStateManager.resetStats(`v${version}`, { tokenHash, all });
    res.json({ message: "Key stats reset" });
  } catch (error) {
    console.error("Error resetting key stats:", error);
    res.status(500).json({ error: "Internal server error" });
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

    // Validate key defaults if present
    if (updates.rpdDefault !== undefined && (!Number.isInteger(updates.rpdDefault) || updates.rpdDefault < 1)) {
      return res.status(400).json({ error: "RPD default must be an integer >= 1" });
    }
    if (updates.rpmDefault !== undefined && (!Number.isInteger(updates.rpmDefault) || updates.rpmDefault < 1)) {
      return res.status(400).json({ error: "RPM default must be an integer >= 1" });
    }
    if (updates.maxContextSizeDefault !== undefined && (!Number.isInteger(updates.maxContextSizeDefault) || updates.maxContextSizeDefault < 0)) {
      return res.status(400).json({ error: "Max context size default must be an integer >= 0" });
    }

    // Validate smart key management settings if present
    if (updates.keyHopAttempts !== undefined && (!Number.isInteger(updates.keyHopAttempts) || updates.keyHopAttempts < 0)) {
      return res.status(400).json({ error: "Key hop attempts must be an integer >= 0" });
    }
    if (
      updates.autoModelMaxTargetAttempts !== undefined &&
      (!Number.isInteger(updates.autoModelMaxTargetAttempts) ||
        updates.autoModelMaxTargetAttempts < 1 ||
        updates.autoModelMaxTargetAttempts > 20)
    ) {
      return res.status(400).json({
        error: "Auto model max target attempts must be an integer from 1 to 20",
      });
    }
    if (updates.autoModelMaxTargetAttempts !== undefined) {
      const models = readModelsDocument().models;
      const blockers = Object.entries(models)
        .filter(([, config]) =>
          modelType(config) === "auto" &&
          config.disabled !== true &&
          Number.isInteger(config.maxTargetAttempts) &&
          config.maxTargetAttempts > updates.autoModelMaxTargetAttempts,
        )
        .map(([name]) => name);
      if (blockers.length) {
        return res.status(409).json({
          error: "Enabled auto models exceed the requested global target-attempt ceiling",
          blockers,
        });
      }
    }
    if (updates.keyTimeoutHours !== undefined && (!Number.isInteger(updates.keyTimeoutHours) || updates.keyTimeoutHours < 1)) {
      return res.status(400).json({ error: "Key timeout hours must be an integer >= 1" });
    }
    if (updates.defaultEndpointKeyRotation !== undefined && !["sticky", "roundrobin"].includes(updates.defaultEndpointKeyRotation)) {
      return res.status(400).json({ error: "Default key rotation must be 'sticky' or 'roundrobin'" });
    }
    if (updates.defaultEndpointKeyHealth !== undefined && typeof updates.defaultEndpointKeyHealth !== "boolean") {
      return res.status(400).json({ error: "Default key health must be a boolean" });
    }
    if (
      updates.defaultEndpointApiFormat !== undefined &&
      !["openai", "anthropic", "gemini", "openai-responses", "openai-codex"].includes(updates.defaultEndpointApiFormat)
    ) {
      return res.status(400).json({ error: "Invalid default endpoint API format" });
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
  // Config and model validation consume runtime settings, so refresh those first.
  settingsManager.reload();
  Config.reload();
  apiKeyManager.loadKeys();
  loadModelsFromFile();
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
      .map((log) => {
        const model = log.model || "Unknown";
        const costs = calculateCost(
          model,
          log.input_tokens,
          log.output_tokens,
          log.cache_write_tokens,
          log.cache_read_tokens,
        );
        return {
          timestamp: log.timestamp || 0,
          model,
          input_tokens: log.input_tokens || 0,
          output_tokens: log.output_tokens || 0,
          cache_write_tokens: log.cache_write_tokens || 0,
          cache_read_tokens: log.cache_read_tokens || 0,
          total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0),
          duration: log.duration || 0,
          cost: costs.totalCost,
        };
      })
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
    const rows = logManager.db
      .prepare(
        "SELECT data FROM request_logs WHERE type = 'request_end' AND model IS NOT NULL",
      )
      .all();
    const modelsByName = new Map();

    for (const row of rows) {
      const log = JSON.parse(row.data);
      if (!log.model) continue;

      const model = modelsByName.get(log.model) || {
        model: log.model,
        requests: 0,
        success_count: 0,
        errors: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        cost: 0,
      };

      model.requests += 1;
      if (log.status === "success") {
        const inputTokens = log.input_tokens || 0;
        const outputTokens = log.output_tokens || 0;
        const cacheWriteTokens = log.cache_write_tokens || 0;
        const cacheReadTokens = log.cache_read_tokens || 0;

        model.success_count += 1;
        model.input_tokens += inputTokens;
        model.output_tokens += outputTokens;
        model.cache_write_tokens += cacheWriteTokens;
        model.cache_read_tokens += cacheReadTokens;
        model.cost += calculateCost(
          log.model,
          inputTokens,
          outputTokens,
          cacheWriteTokens,
          cacheReadTokens,
          log.token_accounting_version ?? null,
        ).totalCost;
      } else if (log.status === "failed") {
        model.errors += 1;
      }

      modelsByName.set(log.model, model);
    }

    const models = Array.from(modelsByName.values())
      .map((model) => ({
        ...model,
        total_tokens:
          model.input_tokens +
          model.output_tokens +
          model.cache_write_tokens +
          model.cache_read_tokens,
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens);

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

/**
 * Validate generation defaults payload.
 * Expected shape: { temperature: { enabled, value }, top_p: { enabled, value }, max_tokens: { enabled, value } }
 * Returns a sanitized object with only valid fields.
 */
function validateGenerationDefaults(input) {
  const defaults = {
    temperature: { enabled: false, value: null },
    top_p: { enabled: false, value: null },
    max_tokens: { enabled: false, value: null },
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaults;
  }

  for (const key of Object.keys(defaults)) {
    const entry = input[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    defaults[key].enabled = entry.enabled === true;

    if (defaults[key].enabled && entry.value !== undefined && entry.value !== null && entry.value !== "") {
      const num = Number(entry.value);
      if (!Number.isNaN(num)) {
        defaults[key].value = key === "max_tokens" ? Math.max(1, Math.floor(num)) : num;
      }
    }
  }

  return defaults;
}

/**
 * Validate prompt caching payload.
 * Expected shape: { enabled: boolean, depth: number }
 * Returns a sanitized object. Non-objects become { enabled: false, depth: 2 }.
 */
function validatePromptCaching(input) {
  const defaults = { enabled: false, depth: 2 };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaults;
  }

  const enabled = input.enabled === true;
  let depth = defaults.depth;

  if (input.depth !== undefined && input.depth !== null && input.depth !== "") {
    const num = Number(input.depth);
    if (!Number.isNaN(num)) {
      depth = Math.max(0, Math.floor(num));
    }
  }

  return { enabled, depth };
}

// Validate a keyRotation value. Returns "sticky" | "roundrobin", or null when
// the input is absent/invalid so the endpoint falls back to the global default.
function validateKeyRotation(input) {
  if (input === "sticky" || input === "roundrobin") return input;
  return null;
}

// Validate a keyHealth value. Returns true | false when a real boolean is given,
// or null when absent/invalid so the endpoint falls back to the global default.
// keyHealth on = actionable errors (400/401/402/429) bench the key; off = errors
// are counted but the key stays usable (the request still hops on its own).
function validateKeyHealth(input) {
  if (input === true || input === false) return input;
  return null;
}

export default router;
