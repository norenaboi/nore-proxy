import logManager from "../services/logManager.js";
import apiKeyManager from "../services/apiKeyManager.js";
import realtimeStats from "../services/realtimeStats.js";
import { getModelPricing, maskKey } from "./helpers.js";
import { getSafeKeyMetadata } from "./keyIdentity.js";
import { calculateModelCost, normalizeModelPricing } from "./pricing.js";
import { sanitizeHeadersForLogging } from "./errorLogging.js";
import { sanitizeUpstreamUrl } from "./upstreamErrors.js";

export { sanitizeHeadersForLogging } from "./errorLogging.js";
export { normalizeBillingTokens, TOKEN_ACCOUNTING_VERSION } from "./pricing.js";

// Cost calculation function based on model type
export function calculateCost(
  model,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
  tokenAccountingVersion = null,
) {
  return calculateModelCost(
    getModelPricing(model),
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    tokenAccountingVersion,
  );
}

export function logRequestStart(
  requestId,
  model,
  params,
  messages = [],
  apiKey = null,
  requestContext = null,
) {
  const requestInfo = {
    id: requestId,
    model,
    start_time: Date.now() / 1000,
    status: "active",
    params,
    messages: messages || [],
    api_key: apiKey,
    request_context:
      requestContext && typeof requestContext === "object"
        ? { ...requestContext }
        : null,
  };

  realtimeStats.activeRequests.set(requestId, requestInfo);

  const logEntry = {
    type: "request_start",
    timestamp: Date.now() / 1000,
    request_id: requestId,
    model,
    ...getSafeKeyMetadata(apiKey),
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
  tokenAccountingVersion = null,
  routingMetadata = null,
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

  // Write to log file
  const resolvedKey = apiKey || req.api_key;
  const allowedRoutingMetadata = {};
  if (routingMetadata && typeof routingMetadata === "object") {
    for (const key of [
      "requested_model",
      "auto_model",
      "target_model",
      "upstream_model",
      "endpoint_key",
      "endpoint_name",
      "api_format",
      "upstream_status",
      "proxy_status",
      "routing_attempt_count",
      "routing_attempts",
    ]) {
      if (routingMetadata[key] !== undefined) {
        allowedRoutingMetadata[key] = routingMetadata[key];
      }
    }
    if (routingMetadata.upstream_url !== undefined) {
      allowedRoutingMetadata.upstream_url = sanitizeUpstreamUrl(
        routingMetadata.upstream_url,
      );
    }
    if (routingMetadata.upstream_token) {
      allowedRoutingMetadata.masked_upstream_key = maskKey(
        routingMetadata.upstream_token,
      );
    }
  }
  const pricing = normalizeModelPricing(getModelPricing(req.model));
  const costs = calculateModelCost(
    pricing,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    tokenAccountingVersion,
  );
  const billing = {
    accounting_version: tokenAccountingVersion,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_read_tokens: cacheReadTokens,
    pricing_per_million: pricing,
    costs: {
      input: costs.inputCost,
      output: costs.outputCost,
      cache_write: costs.cacheWriteCost,
      cache_read: costs.cacheReadCost,
      total: costs.totalCost,
    },
  };
  const logEntry = {
    type: "request_end",
    timestamp: Date.now() / 1000,
    request_id: requestId,
    model: req.model,
    status: success ? "success" : "failed",
    duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_read_tokens: cacheReadTokens,
    ...(tokenAccountingVersion !== null
      ? { token_accounting_version: tokenAccountingVersion }
      : {}),
    request_context: req.request_context
      ? { ...req.request_context, params: req.params || null }
      : { params: req.params || null },
    billing,
    ...allowedRoutingMetadata,
    error,
    key_name: apiKeyManager.getKeyName(resolvedKey),
    ...getSafeKeyMetadata(resolvedKey),
  };
  logManager.writeRequestLog(logEntry);

  realtimeStats.activeRequests.delete(requestId);
}

export function logError(
  requestId,
  errorType,
  errorMessage,
  stackTrace = "",
  context = {},
) {
  if (stackTrace) console.error(`[${requestId}] ${errorType}:`, stackTrace);

  const errorData = {
    timestamp: context.timestamp || new Date().toISOString(),
    requestId,
    model: context.model ?? null,
    upstreamModel: context.upstreamModel ?? null,
    endpointKey: context.endpointKey ?? null,
    endpointName: context.endpointName ?? null,
    apiFormat: context.apiFormat ?? null,
    maskedApiKey: context.maskedApiKey ?? null,
    autoModel: context.autoModel ?? null,
    targetModel: context.targetModel ?? null,
    routingAttempts: context.routingAttempts ?? null,
    statusCode: context.statusCode ?? null,
    errorType,
    errorCode: context.errorCode ?? null,
    errorMessage,
    requestHeaders: sanitizeHeadersForLogging(context.requestHeaders),
    upstreamUrl: context.upstreamUrl ?? null,
    responseBody: context.responseBody ?? null,
    stackTrace: stackTrace || null,
  };

  return logManager.writeErrorLog(errorData);
}
