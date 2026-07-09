import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import { logRequestStart, logRequestEnd, logError } from "../utils/logging.js";
import {
  MODEL_REGISTRY,
  getEndpointForModel,
  getFullUrl,
  estimateTokens,
  isClaudeModel,
  applyClaudePromptCaching,
} from "../utils/helpers.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import settingsManager from "../services/settingsManager.js";

const router = express.Router();

router.post("/v1/chat/completions", verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;

  const contextTokens = estimateTokens(req.body.messages || []);

  try {
    apiKeyManager.checkForGeneration(apiKey, rateLimiter, contextTokens);
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: { message: error.message } });
  }

  const openaiReq = req.body;
  const requestId = uuidv4();
  const isStreaming = openaiReq.stream === true;
  const modelName = openaiReq.model;

  // Extract and remove cache_depth before forwarding.
  // Per-request override takes priority; falls back to the admin panel setting.
  let cacheDepth;
  if (openaiReq.cache_depth !== undefined) {
    cacheDepth = parseInt(openaiReq.cache_depth, 10);
  } else {
    const cachingEnabled = settingsManager.get("promptCachingEnabled");
    cacheDepth = cachingEnabled
      ? settingsManager.get("promptCachingDepth")
      : -1;
  }
  delete openaiReq.cache_depth;

  // Validate model
  const modelInfo = MODEL_REGISTRY[modelName];
  if (!modelInfo) {
    return res.status(404).json({ error: `Model '${modelName}' not found.` });
  }

  // Remove unwanted parameters
  const paramsToExclude = ["frequency_penalty", "presence_penalty"];
  for (const param of paramsToExclude) {
    delete openaiReq[param];
  }

  // Log request start
  const requestParams = {
    temperature: openaiReq.temperature,
    max_tokens: openaiReq.max_tokens,
    streaming: isStreaming,
  };
  const messages = openaiReq.messages || [];
  logRequestStart(requestId, modelName, requestParams, messages, apiKey);

  try {
    if (isStreaming) {
      await streamFromBackend(
        req,
        res,
        requestId,
        openaiReq,
        modelName,
        apiKey,
        cacheDepth,
      );
    } else {
      const responseData = await makeBackendRequest(
        requestId,
        openaiReq,
        modelName,
        apiKey,
        cacheDepth,
      );
      res.json(responseData);
    }
  } catch (error) {
    logRequestEnd(requestId, false, 0, 0, error.message);
    console.error(`API [ID: ${requestId}]: Exception:`, error);
    res.status(500).json({
      error: `Error: ${error}`,
    });
  }
});

async function streamFromBackend(
  req,
  res,
  requestId,
  openaiReq,
  modelName,
  apiKey,
  cacheDepth = -1,
) {
  let accumulatedContent = "";
  let accumulatedReasoning = "";

  const endpointInfo = getEndpointForModel(modelName);

  if (!endpointInfo) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const errorChunk = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "error",
        },
      ],
      error: {
        message: "Error 404: Can't find the model you're looking for.",
        type: "server_error",
        code: 404,
      },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
    return;
  }

  const { url: backendUrl, token: backendToken, actualModel, customHeaders, apiFormat } = endpointInfo;
  const adapter = getAdapter(apiFormat);
  const fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, true); // true = streaming

  // Set streaming headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Build adapter context for building OpenAI-shaped chunks
  const streamCtx = {
    requestId,
    modelName,
    streamId: `chatcmpl-${requestId}`,
    streamCreated: Math.floor(Date.now() / 1000),
  };

  try {
    let messages = openaiReq.messages || [];
    let streamUsage = null;

    // Apply Claude prompt caching if the target model is Claude and caching is enabled
    // (only meaningful for OpenAI-compat and Anthropic formats)
    if (isClaudeModel(actualModel) && cacheDepth !== -1) {
      messages = applyClaudePromptCaching(messages, cacheDepth);
      console.log(
        `Prompt caching applied (depth=${cacheDepth}): ${
          messages.filter((m) => {
            const content = m.content;
            if (Array.isArray(content))
              return content.some((b) => b.cache_control);
            return false;
          }).length
        } message(s) marked for caching`,
      );
    }

    // Build the request body using the adapter
    const reqForAdapter = { ...openaiReq, messages };
    const data = adapter.transformStreamRequest(reqForAdapter, actualModel);

    // Build headers: custom + adapter-specific (e.g. anthropic-version) + auth
    const extraHeaders = getExtraHeaders(apiFormat);
    const headers = {
      ...customHeaders,
      ...extraHeaders,
      "Content-Type": "application/json",
    };

    // Auth depends on format: gemini uses ?key=, anthropic uses x-api-key, openai uses Bearer
    if (apiFormat === "gemini") {
      // Auth is in the URL query param, no auth header needed
    } else if (apiFormat === "anthropic") {
      headers["x-api-key"] = backendToken;
    } else {
      headers["Authorization"] = `Bearer ${backendToken}`;
    }

    const requestUrl = apiFormat === "gemini"
      ? `${fullUrl}?alt=sse&key=${backendToken}`
      : fullUrl;

    const response = await axios({
      method: "post",
      url: requestUrl,
      headers,
      data,
      responseType: "stream",
      timeout: 180000,
    });

    if (response.status !== 200) {
      const errorChunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "error",
          },
        ],
        error: {
          message: `Error ${response.status}: ${response.data.statusMessage}`,
          type: "server_error",
          code: response.status,
        },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    let buffer = "";
    let currentEvent = null; // track event: type for typed-event streams (anthropic, responses)

    response.data.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // Track event type for typed-event streams (Anthropic, Responses API)
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7).trim();
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6).trim();

          // Check for [DONE] sentinel (OpenAI / OpenAI-compat streams)
          if (adapter.isStreamEnd(payload)) {
            res.write("data: [DONE]\n\n");
            return;
          }

          try {
            const chunkData = JSON.parse(payload);
            if (chunkData && typeof chunkData === "object") {
              // Build OpenAI-compatible chunk via adapter
              const openaiChunk = adapter.buildStreamChunk(chunkData, streamCtx);
              if (openaiChunk) {
                // Track accumulated content for usage estimation
                const parsed = adapter.parseStreamChunk(chunkData, streamCtx);
                if (parsed?.deltaContent) {
                  accumulatedContent += parsed.deltaContent;
                }
                if (parsed?.deltaReasoning) {
                  accumulatedReasoning += parsed.deltaReasoning;
                }
                if (parsed?.usage) {
                  streamUsage = parsed.usage;
                }
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
              }
            }
          } catch (e) {
            console.warn(`BACKEND [ID: ${requestId}]: Invalid JSON in stream.`);
          }
          // Reset event tracker after processing data line
          currentEvent = null;
        }
      }
    });

    response.data.on("end", () => {
      // Use real usage from the final chunk if available, otherwise estimate
      const inputTokens =
        streamUsage?.prompt_tokens ?? estimateTokens(openaiReq);
      // Include reasoning text in the estimate — thinking models can spend
      // many tokens on reasoning that isn't in accumulatedContent. If the
      // upstream reported a non-zero completion_tokens we trust that;
      // otherwise estimate from content + reasoning combined.
      const estimatedOutput =
        estimateTokens(accumulatedContent) +
        estimateTokens(accumulatedReasoning);
      const outputTokens =
        streamUsage?.completion_tokens ?? estimatedOutput;
      const cacheWriteTokens =
        streamUsage?.prompt_tokens_details?.cache_creation_input_tokens
        ?? streamUsage?.prompt_tokens_details?.cache_write_tokens
        ?? 0;
      const cacheReadTokens =
        streamUsage?.prompt_tokens_details?.cached_tokens
        ?? streamUsage?.prompt_tokens_details?.cache_read_tokens
        ?? 0;
      logRequestEnd(
        requestId,
        true,
        inputTokens,
        outputTokens,
        null,
        accumulatedContent,
        apiKey,
        cacheWriteTokens,
        cacheReadTokens,
      );
      // Always send [DONE] to close the stream for the client
      res.write("data: [DONE]\n\n");
      res.end();
    });

    response.data.on("error", (error) => {
      console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);
      const errorChunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "error",
          },
        ],
        error: {
          message: error.message || "Stream error occurred",
          type: "server_error",
          code: 500,
        },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      logError(requestId, error.name, error.message, error.stack);
      logRequestEnd(requestId, false, 0, 0, error.message);
      res.end();
    });
  } catch (error) {
    console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);

    const errorChunk = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "error",
        },
      ],
      error: {
        message: error.message || "Unknown error",
        type: "server_error",
        code: 500,
      },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write(`data: [DONE]\n\n`);
    logError(requestId, error.name || "Error", error.message, error.stack);
    logRequestEnd(requestId, false, 0, 0, error.message);
    res.end();
  }
}

async function makeBackendRequest(
  requestId,
  openaiReq,
  modelName,
  apiKey,
  cacheDepth = -1,
) {
  const endpointInfo = getEndpointForModel(modelName);

  if (!endpointInfo) {
    const error = new Error("Can't find the model you're looking for.");
    error.statusCode = 404;
    throw error;
  }

  const { url: backendUrl, token: backendToken, actualModel, customHeaders, apiFormat } = endpointInfo;
  const adapter = getAdapter(apiFormat);
  const fullUrl = getFullUrl(backendUrl, apiFormat, actualModel);

  try {
    let messages = openaiReq.messages || [];

    // Apply Claude prompt caching if the target model is Claude and caching is enabled
    if (isClaudeModel(actualModel) && cacheDepth !== -1) {
      messages = applyClaudePromptCaching(messages, cacheDepth);
      console.log(
        `Prompt caching applied (depth=${cacheDepth}): ${
          messages.filter((m) => {
            const content = m.content;
            if (Array.isArray(content))
              return content.some((b) => b.cache_control);
            return false;
          }).length
        } message(s) marked for caching`,
      );
    }

    // Build the request body using the adapter
    const reqForAdapter = { ...openaiReq, messages };
    const data = adapter.transformRequest(reqForAdapter, actualModel);

    // Build headers: custom + adapter-specific + auth
    const extraHeaders = getExtraHeaders(apiFormat);
    const headers = {
      ...customHeaders,
      ...extraHeaders,
      "Content-Type": "application/json",
    };

    if (apiFormat === "gemini") {
      // Auth is in the URL query param
    } else if (apiFormat === "anthropic") {
      headers["x-api-key"] = backendToken;
    } else {
      headers["Authorization"] = `Bearer ${backendToken}`;
    }

    const requestUrl = apiFormat === "gemini" ? `${fullUrl}?key=${backendToken}` : fullUrl;

    const response = await axios({
      method: "post",
      url: requestUrl,
      headers,
      data,
      timeout: 180000,
    });

    if (response.status !== 200) {
      console.error(`BACKEND [ID: ${requestId}]:`, response.data);
      const error = new Error(
        `Error ${response.status}: ${response.data.statusMessage ?? response.data?.error?.message ?? "Unknown error"}`,
      );
      error.statusCode = response.status;
      throw error;
    }

    const rawData = response.data;

    // Parse the response using the adapter
    const parsed = adapter.parseResponseData(rawData);

    const content = parsed.content;
    const usage = parsed.usage || {};
    const inputTokens =
      usage.prompt_tokens ?? estimateTokens(openaiReq);
    const outputTokens = usage.completion_tokens ?? estimateTokens(content);
    const cacheWriteTokens =
      usage.prompt_tokens_details?.cache_creation_input_tokens
      ?? usage.prompt_tokens_details?.cache_write_tokens
      ?? 0;
    const cacheReadTokens =
      usage.prompt_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cache_read_tokens
      ?? 0;

    logRequestEnd(
      requestId,
      true,
      inputTokens,
      outputTokens,
      null,
      content,
      apiKey,
      cacheWriteTokens,
      cacheReadTokens,
    );

    // Return the OpenAI-compatible response object
    return parsed.response ?? rawData;
  } catch (error) {
    console.error(`BACKEND [ID: ${requestId}]: Error:`, error.message);
    if (error.response) {
      console.error(
        `BACKEND [ID: ${requestId}]: Status:`,
        error.response.status,
      );
      console.error(
        `BACKEND [ID: ${requestId}]: Response:`,
        JSON.stringify(error.response.data, null, 2),
      );
    }
    logError(requestId, error.name || "Error", error.message, error.stack);
    logRequestEnd(requestId, false, 0, 0, error.message);
    throw error;
  }
}

export default router;
