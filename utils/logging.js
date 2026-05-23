import logManager from "../services/logManager.js";
import apiKeyManager from "../services/apiKeyManager.js";
import realtimeStats from "../services/realtimeStats.js";
import performanceMonitor from "../services/performanceMonitor.js";
import requestDetailsStorage from "../services/requestDetailsStorage.js";
import { MODEL_PRICING } from "./helpers.js";

// Cost calculation function based on model type
export function calculateCost(
  model,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
) {
  let inputRate, outputRate, cacheWriteRate, cacheReadRate;

  // Try to get pricing from MODEL_PRICING first
  if (MODEL_PRICING[model]) {
    inputRate = MODEL_PRICING[model].input / 1_000_000;
    outputRate = MODEL_PRICING[model].output / 1_000_000;
    cacheWriteRate = MODEL_PRICING[model].cache_write / 1_000_000;
    cacheReadRate = MODEL_PRICING[model].cache_read / 1_000_000;
  } else {
    // Fallback to pattern matching for backward compatibility
    const modelLower = (model || "").toLowerCase();

    if (modelLower.includes("sonnet")) {
      inputRate = 3 / 1_000_000;
      outputRate = 15 / 1_000_000;
      cacheWriteRate = 3.75 / 1_000_000;
      cacheReadRate = 0.3 / 1_000_000;
    } else if (modelLower.includes("opus")) {
      inputRate = 5 / 1_000_000;
      outputRate = 25 / 1_000_000;
      cacheWriteRate = 6.25 / 1_000_000;
      cacheReadRate = 0.5 / 1_000_000;
    } else {
      // Default pricing
      inputRate = 1 / 1_000_000;
      outputRate = 1 / 1_000_000;
      cacheWriteRate = 1 / 1_000_000;
      cacheReadRate = 1 / 1_000_000;
    }
  }

  // Calculate normal input tokens (excluding cache write and cache read tokens)
  const normalInputTokens = inputTokens - cacheWriteTokens - cacheReadTokens;

  const inputCost = normalInputTokens * inputRate;
  const outputCost = outputTokens * outputRate;
  const cacheWriteCost = cacheWriteTokens * cacheWriteRate;
  const cacheReadCost = cacheReadTokens * cacheReadRate;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}

export function logRequestStart(
  requestId,
  model,
  params,
  messages = [],
  apiKey = null,
) {
  const requestInfo = {
    id: requestId,
    model,
    start_time: Date.now() / 1000,
    status: "active",
    params,
    messages: messages || [],
    api_key: apiKey,
  };

  realtimeStats.activeRequests.set(requestId, requestInfo);

  const logEntry = {
    type: "request_start",
    timestamp: Date.now() / 1000,
    request_id: requestId,
    model,
    params,
    api_key: apiKey,
  };

  logManager.writeRequestLog(logEntry);
}

export function logRequestEnd(
  requestId,
  success,
  inputTokens = 0,
  outputTokens = 0,
  error = null,
  responseContent = "",
  apiKey = null,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
) {
  if (!realtimeStats.activeRequests.has(requestId)) {
    return;
  }

  const req = realtimeStats.activeRequests.get(requestId);
  const duration = Date.now() / 1000 - req.start_time;

  req.status = success ? "success" : "failed";
  req.duration = duration;
  req.input_tokens = inputTokens;
  req.output_tokens = outputTokens;
  req.cache_write_tokens = cacheWriteTokens;
  req.cache_read_tokens = cacheReadTokens;
  req.error = error;
  req.end_time = Date.now() / 1000;
  req.response_content = responseContent;

  // Console block
  const status = success ? "✓" : "✗";
  const durationStr = `${duration.toFixed(2)}s`;
  const lines = [
    "",
    `  ${status} ${req.model}  [${requestId.slice(0, 8)}]  ${durationStr}`,
    `  ├─ Tokens  in: ${inputTokens}  out: ${outputTokens}`,
  ];
  if (cacheWriteTokens > 0 || cacheReadTokens > 0) {
    lines.push(
      `  ├─ Cache   write: ${cacheWriteTokens}  read: ${cacheReadTokens}`,
    );
  }
  if (!success && error) {
    lines.push(`  ├─ Error   ${error}`);
  }
  lines.push("");
  console.log(lines.join("\n"));

  realtimeStats.addRecentRequest({ ...req });

  const model = req.model;
  const stats = realtimeStats.getModelUsage(model);
  stats.requests++;
  if (success) {
    stats.tokens += inputTokens + outputTokens;
  } else {
    stats.errors++;
  }

  performanceMonitor.recordRequest(model, duration, success);

  // Store request details — no message content or response body to limit PII exposure
  const details = {
    request_id: requestId,
    timestamp: req.start_time,
    model,
    status: success ? "success" : "failed",
    duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    error,
    request_params: req.params || {},
    headers: {},
  };
  requestDetailsStorage.add(details);

  // Write to log file
  const resolvedKey = apiKey || req.api_key;
  const logEntry = {
    type: "request_end",
    timestamp: Date.now() / 1000,
    request_id: requestId,
    model,
    status: success ? "success" : "failed",
    duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_read_tokens: cacheReadTokens,
    error,
    params: req.params || {},
    key_name: apiKeyManager.getKeyName(resolvedKey),
    api_key: maskKey(resolvedKey),
  };
  logManager.writeRequestLog(logEntry);

  realtimeStats.activeRequests.delete(requestId);
}

function maskKey(key) {
  if (!key || key.length <= 8) return key ? "****" : key;
  return key.substring(0, 5) + "..." + key.substring(key.length - 3);
}

export function logError(requestId, errorType, errorMessage, stackTrace = "") {
  // Log full stack trace to console only — not persisted to DB
  if (stackTrace) console.error(`[${requestId}] ${errorType}:`, stackTrace);

  const errorData = {
    timestamp: Date.now() / 1000,
    request_id: requestId,
    error_type: errorType,
    error_message: errorMessage,
    // stack_trace intentionally omitted from DB storage
  };

  realtimeStats.addRecentError(errorData);

  logManager.writeErrorLog(errorData);
}
