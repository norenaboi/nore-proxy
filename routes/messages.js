import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import settingsManager from "../services/settingsManager.js";
import keyStateManager, { ACTIONABLE_CODES } from "../services/keyStateManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import {
  logRequestStart,
  logRequestEnd,
  logError,
  normalizeBillingTokens,
} from "../utils/logging.js";
import {
  MODEL_REGISTRY,
  getEndpointForConcreteModel,
  getFullUrl,
  estimateTokens,
  applyGenerationPolicy,
  resolveKeyHealth,
  getClientIp,
} from "../utils/helpers.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import { openAIResponseToAnthropic } from "../utils/responseFormats.js";
import {
  attemptedKeyHashes,
  classifyUpstreamFailure,
  createRoutingState,
  markStreamOutputStarted,
  nextTarget,
  recordRoutingAttempt,
  routingMetadata,
  summarizeRoutingAttempts,
} from "../utils/autoRouting.js";
import {
  buildUpstreamErrorContext,
  getUpstreamErrorMessage,
  readUpstreamErrorBody,
} from "../utils/upstreamErrors.js";

const router = express.Router();

// --- Anthropic ↔ OpenAI conversion helpers ---

function anthropicToOpenAIMessages(anthropicReq) {
  const messages = [];

  if (anthropicReq.system) {
    if (typeof anthropicReq.system === "string") {
      messages.push({ role: "system", content: anthropicReq.system });
    } else if (Array.isArray(anthropicReq.system)) {
      const text = anthropicReq.system
        .map((b) => b.text || "")
        .filter(Boolean)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  for (const msg of anthropicReq.messages || []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    let content = msg.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    if (Array.isArray(content)) {
      const openaiBlocks = [];
      const toolCalls = [];
      const toolResultMessages = [];

      for (const block of content) {
        if (block.type === "text") {
          openaiBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const src = block.source;
          if (src?.type === "base64") {
            openaiBlocks.push({
              type: "image_url",
              image_url: { url: `data:${src.media_type};base64,${src.data}` },
            });
          }
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "tool_result") {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: toolResultText(block.content),
          });
        } else {
          openaiBlocks.push(block);
        }
      }

      // Emit the assistant/user message, attaching any tool_calls it produced.
      // Skip it entirely when the turn carried only tool_result blocks —
      // those become their own role:"tool" messages below.
      if (toolCalls.length > 0) {
        messages.push({
          role,
          content: openaiBlocks.length > 0 ? openaiBlocks : null,
          tool_calls: toolCalls,
        });
      } else if (openaiBlocks.length > 0 || toolResultMessages.length === 0) {
        messages.push({ role, content: openaiBlocks });
      }

      // tool_result blocks become their own role:"tool" messages.
      for (const trm of toolResultMessages) {
        messages.push(trm);
      }
      continue;
    }

    messages.push({ role, content: content || "" });
  }

  return messages;
}

function anthropicToolsToOpenAI(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));
}

function anthropicToolChoiceToOpenAI(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto" || choice.type === "none") return choice.type;
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

// Anthropic tool_result content may be a string or an array of blocks.
// OpenAI's role:"tool" message expects a plain string.
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text") return b.text || "";
        return JSON.stringify(b);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

// --- Anthropic SSE stream writer ---

function writeAnthropicEvent(res, event, data) {
  if (res.writableEnded) return;
  if (res.__routingState) markStreamOutputStarted(res.__routingState);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- Error persistence (shared with chat.js pattern) ---

function persistUpstreamError({
  requestId,
  modelName,
  endpointInfo,
  requestHeaders,
  upstreamUrl,
  error,
  statusCode,
  responseBody,
  autoModel,
  targetModel,
  routingAttempts,
}) {
  const context = buildUpstreamErrorContext({
    modelName,
    endpointInfo,
    requestHeaders,
    upstreamUrl,
    error,
    statusCode,
    responseBody,
    autoModel,
    targetModel,
    routingAttempts,
  });
  return logError(
    requestId,
    error?.name || "Error",
    error?.message || "Unknown error",
    error?.stack || "",
    context,
  );
}

const clone = (value) => structuredClone(value);
const statusOf = (error) => error?.response?.status ?? error?.statusCode ?? null;

function autoExhausted(lastError, state) {
  const error = new Error(lastError?.message || "All automatic routing targets failed.");
  error.name = "AutoTargetsExhaustedError";
  error.code = "auto_targets_exhausted";
  error.statusCode = statusOf(lastError) || 502;
  error.responseBody = lastError?.responseBody;
  error.attemptContext = lastError?.attemptContext;
  error.routingState = state;
  return error;
}

function withAttemptContext(error, endpointInfo, headers, fullUrl, responseBody) {
  Object.defineProperty(error, "attemptContext", {
    value: {
      endpointInfo,
      requestHeaders: headers,
      upstreamUrl: fullUrl,
      responseBody: error.responseBody ?? responseBody ?? null,
      upstreamStatus: statusOf(error),
    },
    configurable: true,
  });
  return error;
}

async function executeMessagesRouting(requestId, requestedModel, runAttempt) {
  const state = createRoutingState({
    requestId,
    requestedModel,
    registry: MODEL_REGISTRY,
    globalCeiling: settingsManager.get("autoModelMaxTargetAttempts"),
  });
  const maxKeyAttempts = 1 + Math.max(
    0,
    parseInt(settingsManager.get("keyHopAttempts"), 10) || 0,
  );
  let lastError = null;
  let autoFallbackOccurred = false;

  for (let target = nextTarget(state); target; target = nextTarget(state)) {
    let fallbackTarget = false;
    let endpointKey = null;
    for (let keyAttempt = 1; keyAttempt <= maxKeyAttempts; keyAttempt++) {
      const excluded = endpointKey
        ? attemptedKeyHashes(state, endpointKey)
        : new Set();
      const endpointInfo = getEndpointForConcreteModel(target, {
        excludeHashes: excluded,
      });
      if (!endpointInfo) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = state.autoModel ? 503 : 404;
        if (!state.autoModel) throw error;
        lastError = error;
        const decision = classifyUpstreamFailure({ statusCode: 503 });
        recordRoutingAttempt(state, {
          targetModel: target,
          keyAttempt,
          outcome: "target_unavailable",
          retryReason: decision.reason,
          statusCode: 503,
        });
        fallbackTarget = true;
        break;
      }
      endpointKey = endpointInfo.endpointKey;
      const tried = attemptedKeyHashes(state, endpointKey);

      if (endpointInfo.tokenExhausted || !endpointInfo.token) {
        lastError = withAttemptContext(
          keyStateManager.buildExhaustionError(endpointKey),
          endpointInfo,
        );
        const decision = classifyUpstreamFailure({ keyExhausted: true });
        recordRoutingAttempt(state, {
          targetModel: target,
          endpointKey,
          endpointName: endpointInfo.endpointName,
          keyAttempt,
          outcome: "key_exhausted",
          retryReason: decision.reason,
          statusCode: 404,
        });
        fallbackTarget = true;
        break;
      }

      try {
        const result = await runAttempt(state, endpointInfo, keyAttempt);
        recordRoutingAttempt(state, {
          targetModel: target,
          endpointKey,
          endpointName: endpointInfo.endpointName,
          tokenHash: endpointInfo.tokenHash,
          keyAttempt,
          outcome: "success",
        });
        if (result && typeof result === "object") {
          Object.defineProperty(result, "routingState", {
            value: state,
            enumerable: false,
          });
        }
        return result;
      } catch (error) {
        if (error.clientAbort) throw error;
        lastError = error;
        const statusCode = statusOf(error);
        const decision = classifyUpstreamFailure({
          statusCode,
          error,
          streamOutputStarted: state.streamOutputStarted,
        });
        recordRoutingAttempt(state, {
          targetModel: target,
          endpointKey,
          endpointName: endpointInfo.endpointName,
          tokenHash: endpointInfo.tokenHash,
          keyAttempt,
          outcome: "failure",
          retryReason: decision.reason,
          statusCode,
        });
        if (endpointInfo.tokenHash) tried.add(endpointInfo.tokenHash);
        if (endpointInfo.token && ACTIONABLE_CODES.has(Number(statusCode))) {
          keyStateManager.recordFailure(
            endpointKey,
            endpointInfo.token,
            Number(statusCode),
            { sideline: resolveKeyHealth(endpointInfo.keyHealth) },
          );
        }
        if (decision.retryKey && keyAttempt < maxKeyAttempts) continue;
        fallbackTarget = decision.fallbackTarget;
        break;
      }
    }
    if (!fallbackTarget) throw lastError;
    if (state.autoModel) autoFallbackOccurred = true;
  }

  if (autoFallbackOccurred) throw autoExhausted(lastError, state);
  if (lastError) {
    lastError.routingState = state;
    throw lastError;
  }
  const error = new Error(`Model '${requestedModel}' not found.`);
  error.statusCode = 404;
  throw error;
}

function successfulRoutingMetadata(
  state,
  endpointInfo = null,
  execution = {},
) {
  const metadata = routingMetadata(state, endpointInfo, execution);
  metadata.routing_attempt_count += 1;
  return metadata;
}

function anthropicErrorType(statusCode) {
  if (statusCode === 400) return "invalid_request_error";
  if (statusCode === 401) return "authentication_error";
  if (statusCode === 403) return "permission_error";
  if (statusCode === 404) return "not_found_error";
  if (statusCode === 413) return "request_too_large";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode === 529) return "overloaded_error";
  return "api_error";
}

function anthropicErrorEnvelope(error, statusCode) {
  if (error?.responseBody?.type === "error" && error.responseBody.error?.type) {
    return {
      ...error.responseBody,
      error: {
        ...error.responseBody.error,
        ...(error.code ? { code: error.code } : {}),
      },
    };
  }
  return {
    type: "error",
    error: {
      type: anthropicErrorType(statusCode),
      message: error?.message || "Internal server error",
      ...(error?.code ? { code: error.code } : {}),
    },
  };
}

// --- Route: POST /v1/messages ---

router.post("/v1/messages", verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;
  const anthropicReq = clone(req.body);
  const modelName = anthropicReq.model;
  const isStreaming = anthropicReq.stream === true;
  const requestId = uuidv4();

  // Convert Anthropic messages to OpenAI format for token estimation
  const openaiMessages = anthropicToOpenAIMessages(anthropicReq);
  const contextTokens = estimateTokens(openaiMessages);

  try {
    apiKeyManager.checkForGeneration(apiKey, rateLimiter, contextTokens);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      type: "error",
      error: { type: "invalid_request_error", message: error.message },
    });
  }

  // Validate model
  const modelInfo = MODEL_REGISTRY[modelName];
  if (!modelInfo) {
    return res.status(404).json({
      type: "error",
      error: { type: "not_found_error", message: `Model '${modelName}' not found.` },
    });
  }

  // Log request start
  const requestParams = {
    temperature: anthropicReq.temperature,
    max_tokens: anthropicReq.max_tokens,
    streaming: isStreaming,
  };
  logRequestStart(
    requestId,
    modelName,
    requestParams,
    openaiMessages,
    apiKey,
    {
      client_ip: getClientIp(req),
      protocol: "anthropic-messages",
      method: req.method,
      path: req.path,
      streaming: isStreaming,
    },
  );

  try {
    if (isStreaming) {
      await streamMessages(req, res, requestId, anthropicReq, modelName, apiKey, openaiMessages);
    } else {
      const responseData = await makeMessagesRequest(requestId, anthropicReq, modelName, apiKey, openaiMessages);
      res.json(responseData);
    }
  } catch (error) {
    const state = error.routingState || null;
    const context = error.attemptContext || {};
    logRequestEnd(
      requestId,
      false,
      0,
      0,
      error.message,
      "",
      null,
      0,
      0,
      null,
      routingMetadata(state, context.endpointInfo, {
        upstreamUrl: context.upstreamUrl,
        upstreamStatus: context.upstreamStatus ?? statusOf(error),
        proxyStatus: error.clientAbort ? null : statusOf(error) || 500,
      }),
    );
    const statusCode = statusOf(error) || 500;
    if (!error.clientAbort) {
      persistUpstreamError({
        requestId,
        modelName,
        endpointInfo: context.endpointInfo,
        requestHeaders: context.requestHeaders,
        upstreamUrl: context.upstreamUrl,
        error,
        statusCode,
        responseBody: context.responseBody,
        autoModel: state?.autoModel,
        targetModel: state?.currentTargetModel,
        routingAttempts: summarizeRoutingAttempts(state),
      });
      console.error(
        `MESSAGES [ID: ${requestId}]: ${error?.name || "Error"}: ${error?.message || String(error)}`,
      );
    }

    if (error.clientAbort) {
      if (!res.writableEnded) try { res.end(); } catch (_) {}
    } else if (isStreaming && res.headersSent && !res.writableEnded) {
      writeAnthropicEvent(res, "error", anthropicErrorEnvelope(error, statusCode));
      res.end();
    } else if (!res.headersSent) {
      res.status(statusCode).json(anthropicErrorEnvelope(error, statusCode));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// --- Non-streaming request ---

async function makeMessagesRequest(requestId, anthropicReq, modelName, apiKey, openaiMessages) {
  return executeMessagesRouting(requestId, modelName, (state, endpointInfo) =>
    makeMessagesAttempt(
      requestId,
      anthropicReq,
      modelName,
      apiKey,
      openaiMessages,
      endpointInfo,
      state,
    ),
  );
}

async function makeMessagesAttempt(
  requestId,
  baseAnthropicReq,
  modelName,
  apiKey,
  baseOpenaiMessages,
  endpointOverride,
  routingState,
) {
  const anthropicReq = clone(baseAnthropicReq);
  const openaiMessages = clone(baseOpenaiMessages);
  if (endpointOverride?.generationDefaults) {
    applyGenerationPolicy(anthropicReq, endpointOverride.generationDefaults);
  }
  let endpointInfo = null;
  let fullUrl = null;
  let requestUrl = null;
  let responseStatus = null;
  let data = null;
  let headers = {};
  let upstreamResponseBody = null;

  try {
    let response = null;
    let apiFormat = null;

    // Smart key selection with single-request retry across usable keys.
    // Only 400/401/402/429 trigger a hop; any other status/error is terminal.
    const triedHashes = new Set();
    const maxAttempts = endpointOverride
      ? 1
      : 1 + Math.max(0, parseInt(settingsManager.get("keyHopAttempts"), 10) || 0);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      endpointInfo = endpointOverride || getEndpointForConcreteModel(modelName, { excludeHashes: triedHashes });
      if (!endpointInfo) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = 404;
        throw error;
      }
      if (endpointInfo.tokenExhausted || !endpointInfo.token) {
        throw keyStateManager.buildExhaustionError(endpointInfo.endpointKey);
      }

      const {
        url: backendUrl,
        token: backendToken,
        actualModel,
        customHeaders,
        endpointKey,
        tokenHash,
      } = endpointInfo;
      apiFormat = endpointInfo.apiFormat;

      if (apiFormat === "anthropic") {
        // Backend is native Anthropic — forward the request mostly as-is
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, false, endpointInfo.appendApiSuffix);
        data = {
          ...anthropicReq,
          model: actualModel,
          stream: false,
        };
        delete data.stream;

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
          "x-api-key": backendToken,
        };
      } else {
        // Backend is OpenAI/Gemini — convert Anthropic → OpenAI, then use adapters
        const adapter = getAdapter(apiFormat);
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, false, endpointInfo.appendApiSuffix);

        const openaiReq = {
          model: actualModel,
          messages: openaiMessages,
          max_tokens: anthropicReq.max_tokens,
          temperature: anthropicReq.temperature,
          top_p: anthropicReq.top_p,
          tools: anthropicToolsToOpenAI(anthropicReq.tools),
          tool_choice: anthropicToolChoiceToOpenAI(anthropicReq.tool_choice),
          stop: anthropicReq.stop_sequences,
          stream: false,
        };
        Object.keys(openaiReq).forEach((k) => {
          if (openaiReq[k] === undefined || openaiReq[k] === null) delete openaiReq[k];
        });

        data = adapter.transformRequest(openaiReq, actualModel);

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
        };

        if (apiFormat === "gemini") {
          // handled in URL
        } else {
          headers["Authorization"] = `Bearer ${backendToken}`;
        }
      }

      requestUrl = apiFormat === "gemini" ? `${fullUrl}?key=${backendToken}` : fullUrl;

      const resp = await axios({
        method: "post",
        url: requestUrl,
        headers,
        data,
        timeout: 180000,
        validateStatus: () => true,
      });

      responseStatus = resp.status;
      if (resp.status >= 200 && resp.status < 300) {
        keyStateManager.recordSuccess(endpointKey, backendToken);
        response = resp;
        upstreamResponseBody = resp.data;
        break;
      }

      upstreamResponseBody = resp.data;
      const error = new Error(`Error ${resp.status}: ${getUpstreamErrorMessage(resp.data)}`);
      error.name = "UpstreamHttpError";
      error.statusCode = resp.status;
      error.responseBody = resp.data;
      throw error;
    }

    if (!response) {
      throw keyStateManager.buildExhaustionError(endpointInfo?.endpointKey);
    }

    const rawData = response.data;
    let anthropicResponse;
    let contentText = "";
    let usage = {};

    if (apiFormat === "anthropic") {
      // Already in Anthropic format
      anthropicResponse = rawData;
      contentText = (rawData.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      usage = {
        prompt_tokens: rawData.usage?.input_tokens || 0,
        completion_tokens: rawData.usage?.output_tokens || 0,
        prompt_tokens_details: {
          cache_creation_input_tokens:
            rawData.usage?.cache_creation_input_tokens || 0,
          cached_tokens: rawData.usage?.cache_read_input_tokens || 0,
        },
      };
    } else {
      // Convert OpenAI response → Anthropic format
      const adapter = getAdapter(apiFormat);
      const parsed = adapter.parseResponseData(rawData);
      contentText = parsed.content || "";
      usage = parsed.usage || {};
      anthropicResponse = openAIResponseToAnthropic(parsed.response || rawData, modelName, requestId);
    }

    if (anthropicResponse && typeof anthropicResponse === "object") {
      anthropicResponse.model = modelName;
    }

    const inputTokens = usage.prompt_tokens ?? estimateTokens(openaiMessages);
    const outputTokens = usage.completion_tokens ?? estimateTokens(contentText);
    const cacheWriteTokens = usage.prompt_tokens_details?.cache_creation_input_tokens
      ?? usage.prompt_tokens_details?.cache_write_tokens ?? 0;
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cache_read_tokens ?? 0;

    const billingTokens = normalizeBillingTokens({
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      inputIncludesCache: apiFormat !== "anthropic",
    });
    logRequestEnd(
      requestId,
      true,
      billingTokens.inputTokens,
      billingTokens.outputTokens,
      null,
      contentText,
      apiKey,
      billingTokens.cacheWriteTokens,
      billingTokens.cacheReadTokens,
      billingTokens.tokenAccountingVersion,
      successfulRoutingMetadata(routingState, endpointInfo, {
        upstreamUrl: requestUrl,
        upstreamStatus: responseStatus,
        proxyStatus: 200,
      }),
    );

    return anthropicResponse;
  } catch (error) {
    const responseBody = await readUpstreamErrorBody(
      error.responseBody ?? error.response?.data ?? upstreamResponseBody,
    );
    throw withAttemptContext(error, endpointInfo, headers, fullUrl, responseBody);
  }
}

// --- Streaming request ---

async function streamMessages(req, res, requestId, anthropicReq, modelName, apiKey, openaiMessages) {
  const abortController = new AbortController();
  let activeStream = null;
  let cancelActiveAttempt = null;
  let clientAborted = false;
  const abortClient = () => {
    if (clientAborted || res.writableEnded) return;
    clientAborted = true;
    const error = new Error("Client aborted stream");
    error.clientAbort = true;
    cancelActiveAttempt?.(error);
    abortController.abort();
    activeStream?.destroy?.(error);
  };
  req.once("aborted", abortClient);
  res.once("close", abortClient);
  try {
    return await executeMessagesRouting(requestId, modelName, (state, endpointInfo) =>
      streamMessagesAttempt(
        res,
        requestId,
        anthropicReq,
        modelName,
        apiKey,
        openaiMessages,
        state,
        endpointInfo,
        abortController,
        () => clientAborted,
        (stream) => { activeStream = stream; },
        (cancel) => { cancelActiveAttempt = cancel; },
      ),
    );
  } finally {
    cancelActiveAttempt = null;
    activeStream = null;
    req.off("aborted", abortClient);
    res.off("close", abortClient);
  }
}

async function streamMessagesAttempt(
  res,
  requestId,
  baseAnthropicReq,
  modelName,
  apiKey,
  baseOpenaiMessages,
  routingState,
  endpointOverride,
  abortController,
  isClientAborted,
  setActiveStream,
  setAttemptCancel,
) {
  const anthropicReq = clone(baseAnthropicReq);
  const openaiMessages = clone(baseOpenaiMessages);
  if (endpointOverride?.generationDefaults) {
    applyGenerationPolicy(anthropicReq, endpointOverride.generationDefaults);
  }
  let accumulatedContent = "";
  let endpointInfo = null;
  let fullUrl = null;
  let requestUrl = null;
  let headers = {};

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    let response = null;
    let apiFormat = null;

    // Smart key selection with single-request retry across usable keys.
    // Only 400/401/402/429 trigger a hop; any other status/error is terminal.
    const triedHashes = new Set();
    const maxAttempts = endpointOverride
      ? 1
      : 1 + Math.max(0, parseInt(settingsManager.get("keyHopAttempts"), 10) || 0);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      endpointInfo = endpointOverride || getEndpointForConcreteModel(modelName, { excludeHashes: triedHashes });
      if (!endpointInfo) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = 404;
        throw error;
      }
      if (endpointInfo.tokenExhausted || !endpointInfo.token) {
        throw keyStateManager.buildExhaustionError(endpointInfo.endpointKey);
      }

      const {
        url: backendUrl,
        token: backendToken,
        actualModel,
        customHeaders,
        endpointKey,
        tokenHash,
      } = endpointInfo;
      apiFormat = endpointInfo.apiFormat;

      let data;

      if (apiFormat === "anthropic") {
        // Native Anthropic backend — forward as-is with stream: true
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, false, endpointInfo.appendApiSuffix);
        data = {
          ...anthropicReq,
          model: actualModel,
          stream: true,
        };

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
          "x-api-key": backendToken,
        };
      } else {
        // Non-Anthropic backend — convert to OpenAI format, stream, then re-wrap as Anthropic SSE
        const adapter = getAdapter(apiFormat);
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, true, endpointInfo.appendApiSuffix);

        const openaiReq = {
          model: actualModel,
          messages: openaiMessages,
          max_tokens: anthropicReq.max_tokens,
          temperature: anthropicReq.temperature,
          top_p: anthropicReq.top_p,
          tools: anthropicToolsToOpenAI(anthropicReq.tools),
          tool_choice: anthropicToolChoiceToOpenAI(anthropicReq.tool_choice),
          stop: anthropicReq.stop_sequences,
          stream: true,
        };
        Object.keys(openaiReq).forEach((k) => {
          if (openaiReq[k] === undefined || openaiReq[k] === null) delete openaiReq[k];
        });

        data = adapter.transformStreamRequest(openaiReq, actualModel);

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
        };

        if (apiFormat === "gemini") {
          // handled in URL
        } else {
          headers["Authorization"] = `Bearer ${backendToken}`;
        }
      }

      requestUrl = apiFormat === "gemini"
        ? `${fullUrl}?alt=sse&key=${backendToken}`
        : fullUrl;

      const resp = await axios({
        method: "post",
        url: requestUrl,
        headers,
        data,
        responseType: "stream",
        timeout: 180000,
        validateStatus: () => true,
        signal: abortController.signal,
      });
      setActiveStream(resp.data);

      if (resp.status >= 200 && resp.status < 300) {
        response = resp;
        break;
      }

      // The outer routing executor owns key retry and target fallback.
      const responseBody = await readUpstreamErrorBody(resp.data);
      resp.data?.destroy?.();
      const error = new Error(`Error ${resp.status}: ${getUpstreamErrorMessage(responseBody)}`);
      error.name = "UpstreamHttpError";
      error.statusCode = resp.status;
      error.responseBody = responseBody;
      throw error;
    }

    if (!response) {
      throw keyStateManager.buildExhaustionError(endpointInfo?.endpointKey);
    }

    const consume = apiFormat === "anthropic"
      ? streamAnthropicPassthrough
      : streamOpenAIToAnthropic;
    const execution = {
      endpointInfo,
      upstreamUrl: requestUrl,
      upstreamStatus: response.status,
      proxyStatus: 200,
    };
    const args = apiFormat === "anthropic"
      ? [res, response.data, requestId, modelName, apiKey, openaiMessages, routingState, execution]
      : [res, response.data, requestId, modelName, apiKey, openaiMessages, apiFormat, routingState, execution];
    const streamPromise = consume(...args);
    setAttemptCancel(streamPromise.cancel);
    await streamPromise;
    setAttemptCancel(null);
    setActiveStream(null);
    keyStateManager.recordSuccess(endpointInfo.endpointKey, endpointInfo.token);
    return { streamed: true };
  } catch (error) {
    if (isClientAborted()) error.clientAbort = true;
    const responseBody = await readUpstreamErrorBody(
      error.responseBody ?? error.response?.data,
    );
    throw withAttemptContext(error, endpointInfo, headers, fullUrl, responseBody);
  }
}

// Pass through Anthropic SSE events, tracking content for logging.
function streamAnthropicPassthrough(
  res,
  stream,
  requestId,
  modelName,
  apiKey,
  openaiMessages,
  routingState,
  execution,
) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let accumulatedContent = "";
    let usage = null;
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    cancel = (error) => settle(error);
    const onData = (chunk) => {
      if (settled) return;
      buffer += chunk.toString();
      const records = buffer.split("\n\n");
      buffer = records.pop() || "";
      for (const record of records) {
        if (settled) return;
        let eventName = null;
        let payload = null;
        for (const line of record.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          if (line.startsWith("data: ")) payload = line.slice(6).trim();
        }
        if (!payload) continue;
        let data;
        try { data = JSON.parse(payload); } catch { continue; }
        if (data.type === "error") {
          const error = new Error(data.error?.message || "Upstream stream failed");
          error.name = "UpstreamStreamError";
          error.statusCode = {
            invalid_request_error: 400,
            authentication_error: 401,
            billing_error: 402,
            permission_error: 403,
            not_found_error: 404,
            rate_limit_error: 429,
            overloaded_error: 529,
          }[data.error?.type] || 500;
          error.responseBody = data;
          settle(error);
          stream.destroy();
          return;
        }
        if (data.type === "message_start" && data.message) {
          data.message = { ...data.message, model: modelName };
          usage = { ...(usage || {}), ...(data.message.usage || {}) };
        } else if (data.type === "message_delta" && data.usage) {
          usage = { ...(usage || {}), ...data.usage };
        } else if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
          accumulatedContent += data.delta.text || "";
        }
        if (!res.writableEnded) {
          markStreamOutputStarted(routingState);
          writeAnthropicEvent(res, eventName || data.type, data);
        }
      }
    };
    const onEnd = () => {
      if (settled) return;
      const billingTokens = normalizeBillingTokens({
        inputTokens: usage?.input_tokens ?? estimateTokens(openaiMessages),
        outputTokens: usage?.output_tokens ?? estimateTokens(accumulatedContent),
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        inputIncludesCache: false,
      });
      logRequestEnd(requestId, true, billingTokens.inputTokens, billingTokens.outputTokens, null, accumulatedContent, apiKey, billingTokens.cacheWriteTokens, billingTokens.cacheReadTokens, billingTokens.tokenAccountingVersion, successfulRoutingMetadata(routingState, execution.endpointInfo, execution));
      if (!res.writableEnded) res.end();
      settle();
    };
    const onError = (error) => settle(error);
    const onClose = () => {
      if (!settled) settle(new Error("Upstream stream closed before completion"));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
  promise.cancel = (error) => cancel?.(error);
  return promise;
}

// Convert an OpenAI-style SSE stream into Anthropic SSE events
function streamOpenAIToAnthropic(
  res,
  stream,
  requestId,
  modelName,
  apiKey,
  openaiMessages,
  apiFormat,
  routingState,
  execution,
) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
  let settled = false;
  res.__routingState = routingState;
  const adapter = getAdapter(apiFormat);
  let buffer = "";
  let accumulatedContent = "";
  let accumulatedReasoning = "";
  let streamUsage = null;
  let sentMessageStart = false;
  let terminated = false;
  let nextBlockIndex = 0;
  let thinkingBlockOpen = false;
  let thinkingBlockIndex = -1;
  let textBlockOpen = false;
  let textBlockIndex = -1;
  const toolFragments = new Map(); // OpenAI index -> { id, name, fragments[] }
  const toolOrder = [];
  let lastToolIndex = null;
  const msgId = `msg_${requestId.replace(/-/g, "").slice(0, 20)}`;

  const streamCtx = {
    requestId,
    modelName,
    streamId: `chatcmpl-${requestId}`,
    streamCreated: Math.floor(Date.now() / 1000),
  };

  function ensureMessageStart() {
    if (sentMessageStart) return;
    sentMessageStart = true;
    writeAnthropicEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeThinkingBlock() {
    if (!thinkingBlockOpen) return;
    writeAnthropicEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: thinkingBlockIndex,
    });
    thinkingBlockOpen = false;
    thinkingBlockIndex = -1;
  }

  function ensureThinkingBlockStart() {
    if (thinkingBlockOpen) return;
    thinkingBlockIndex = nextBlockIndex++;
    thinkingBlockOpen = true;
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: thinkingBlockIndex,
      content_block: { type: "thinking", thinking: "" },
    });
  }

  // Open a text content block on demand. Only used for text deltas so a
  // tool_use block is never masked by an empty text block (issue 6).
  function ensureTextBlockStart() {
    if (textBlockOpen) return;
    closeThinkingBlock();
    textBlockIndex = nextBlockIndex++;
    textBlockOpen = true;
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  function closeTextBlock() {
    if (!textBlockOpen) return;
    writeAnthropicEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
    textBlockOpen = false;
    textBlockIndex = -1;
  }

  function flushToolBlocks() {
    closeThinkingBlock();
    closeTextBlock();
    for (const toolIndex of toolOrder) {
      const tool = toolFragments.get(toolIndex);
      if (!tool?.id) continue;
      const index = nextBlockIndex++;
      writeAnthropicEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: tool.id,
          name: tool.name || "",
          input: {},
        },
      });
      for (const fragment of tool.fragments) {
        writeAnthropicEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: fragment },
        });
      }
      writeAnthropicEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    }
    toolFragments.clear();
    toolOrder.length = 0;
    lastToolIndex = null;
  }

  function closeOpenBlocks() {
    closeThinkingBlock();
    closeTextBlock();
    flushToolBlocks();
  }

  // Emit the terminal message_delta + message_stop exactly once (issue 5).
  function emitTerminal(finishReason) {
    if (terminated) return;
    terminated = true;
    closeOpenBlocks();
    const stopReason = finishReason === "length" ? "max_tokens"
      : finishReason === "tool_calls" ? "tool_use"
      : "end_turn";
    writeAnthropicEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: streamUsage?.completion_tokens ??
          (estimateTokens(accumulatedContent) + estimateTokens(accumulatedReasoning)),
      },
    });
    writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  }

  const cleanup = () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.off("close", onClose);
    delete res.__routingState;
  };
  const settle = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve();
  };
  cancel = (error) => settle(error);

  const onData = (chunk) => {
    if (settled) return;
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("event: ")) continue;

      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();

      if (adapter.isStreamEnd(payload)) {
        // [DONE] — terminal events are guarded so they fire only once
        // even if a finish_reason chunk already emitted them (issue 5).
        emitTerminal("stop");
        return;
      }

      let chunkData;
      try { chunkData = JSON.parse(payload); } catch { continue; }

      try {
        const parsed = adapter.parseStreamChunk(chunkData, streamCtx);
        if (!parsed) continue;

        ensureMessageStart();

        if (
          parsed.deltaReasoning &&
          !textBlockOpen &&
          toolFragments.size === 0
        ) {
          // Anthropic content blocks cannot overlap. Reasoning normally
          // precedes answer text; if an upstream emits more reasoning after a
          // later block has opened, do not open another thinking block.
          ensureThinkingBlockStart();
          accumulatedReasoning += parsed.deltaReasoning;
          writeAnthropicEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: thinkingBlockIndex,
            delta: {
              type: "thinking_delta",
              thinking: parsed.deltaReasoning,
            },
          });
        }

        if (parsed.deltaContent) {
          ensureTextBlockStart();
          accumulatedContent += parsed.deltaContent;
          writeAnthropicEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: parsed.deltaContent },
          });
        }

        if (parsed.toolCalls) {
          closeThinkingBlock();
          closeTextBlock();
          for (const tc of parsed.toolCalls) {
            const tcIndex = tc.index ?? lastToolIndex ?? 0;
            let tool = toolFragments.get(tcIndex);
            if (!tool) {
              tool = { id: null, name: "", fragments: [] };
              toolFragments.set(tcIndex, tool);
              toolOrder.push(tcIndex);
            }
            if (tc.id) tool.id = tc.id;
            if (tc.function?.name) tool.name = tc.function.name;
            // Preserve arguments carried on the same chunk as the tool ID.
            if (tc.function?.arguments) tool.fragments.push(tc.function.arguments);
            lastToolIndex = tcIndex;
          }
        }

        if (parsed.usage) {
          streamUsage = {
            ...(streamUsage || {}),
            ...parsed.usage,
            prompt_tokens_details: {
              ...(streamUsage?.prompt_tokens_details || {}),
              ...(parsed.usage.prompt_tokens_details || {}),
            },
          };
        }

        if (parsed.finishReason && parsed.finishReason !== "error") {
          emitTerminal(parsed.finishReason);
        }
      } catch (error) {
        if (settled) return;
        error.responseBody = error.responseBody ?? chunkData;
        settle(error);
        stream.destroy();
        return;
      }
    }
  };

  const onEnd = () => {
    if (settled) return;
    const inputTokens = streamUsage?.prompt_tokens ?? estimateTokens(openaiMessages);
    const outputTokens = streamUsage?.completion_tokens ??
      (estimateTokens(accumulatedContent) + estimateTokens(accumulatedReasoning));
    const cacheWriteTokens = streamUsage?.prompt_tokens_details?.cache_creation_input_tokens
      ?? streamUsage?.prompt_tokens_details?.cache_write_tokens ?? 0;
    const cacheReadTokens = streamUsage?.prompt_tokens_details?.cached_tokens
      ?? streamUsage?.prompt_tokens_details?.cache_read_tokens ?? 0;
    const billingTokens = normalizeBillingTokens({
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      inputIncludesCache: apiFormat !== "anthropic",
    });

    logRequestEnd(
      requestId,
      true,
      billingTokens.inputTokens,
      billingTokens.outputTokens,
      null,
      accumulatedContent,
      apiKey,
      billingTokens.cacheWriteTokens,
      billingTokens.cacheReadTokens,
      billingTokens.tokenAccountingVersion,
      successfulRoutingMetadata(routingState, execution.endpointInfo, execution),
    );

    if (!res.writableEnded) {
      res.end();
    }
    settle();
  };
  const onError = (error) => settle(error);
  const onClose = () => {
    if (!settled) settle(new Error("Upstream stream closed before completion"));
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("error", onError);
  stream.once("close", onClose);
  });
  promise.cancel = (error) => cancel?.(error);
  return promise;
}

export default router;
