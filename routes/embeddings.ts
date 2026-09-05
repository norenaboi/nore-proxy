/**
 * OpenAI-compatible embeddings passthrough — POST /v1/embeddings.
 *
 * This is the general embeddings syntax: OpenRouter, DashScope compatible-mode,
 * Voyage, Jina, Cohere-compat, Together, Mistral, and Ollama all accept
 * `{ model, input, ... }` here and answer with an `object: "list"` body of
 * `{ object: "embedding", index, embedding }` entries. Provider-specific extras
 * (`dimensions`, `encoding_format`, `input_type`, `task_type`, `truncate`, …)
 * are forwarded untouched by the OpenAI-format embedding adapter, so a new
 * OpenAI-compatible provider needs no code here. Gemini, which has no OpenAI
 * embeddings surface, is translated by its own embedding adapter.
 *
 * Routing, key rotation, key health, retry classification, and automatic-model
 * fallback are the shared ones in utils/requestRouting.ts, so an embedding
 * request behaves exactly like a chat request in every respect the operator has
 * configured. Embeddings are never streamed, so the stream-output boundary that
 * constrains the chat routes does not apply.
 */

import express, { type Request, type Response } from "express";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import keyStateManager from "../services/keyStateManager.js";
import { logRequestStart, logRequestEnd, logError, normalizeBillingTokens } from "../utils/logging.js";
import { MODEL_REGISTRY, applyBodyParamPolicy, getClientIp } from "../utils/helpers.js";
import { getEmbeddingsUrl, supportsEmbeddings } from "../utils/endpointPolicies.js";
import { getExtraHeaders } from "../utils/adapters/index.js";
import {
  EmbeddingInputError,
  embeddingInputCount,
  embeddingInputToTexts,
  getEmbeddingAdapter,
} from "../utils/adapters/embeddings.js";
import { buildUpstreamErrorContext } from "../utils/upstreamErrors.js";
import { executeRouting, httpError, statusOf, withContext } from "../utils/requestRouting.js";
import { routingMetadata, summarizeRoutingAttempts } from "../utils/autoRouting.js";
import { proxyAgentsFor } from "../utils/proxyAgents.js";

type DynamicRecord = Record<string, any>;

const router = express.Router();
const clone = (value: any): any => structuredClone(value);

/**
 * Characters per token, matching the estimate the chat routes use. Embedding
 * upstreams that report no usage at all (Gemini's batchEmbedContents, and some
 * OpenAI-compatible providers) are still billed for the text they were sent.
 */
function estimateEmbeddingTokens(input: unknown): number {
  let texts: string[];
  try {
    texts = embeddingInputToTexts(input);
  } catch {
    // Token-id input: bill the token count directly rather than refusing to
    // estimate, since the client already did the tokenization.
    if (Array.isArray(input)) {
      return input.reduce<number>(
        (total, entry) => total + (Array.isArray(entry) ? entry.length : 1),
        0,
      );
    }
    return 0;
  }
  return texts.reduce((total, text) => total + Math.floor(String(text).length / 4), 0);
}

/**
 * An endpoint that has no embeddings API at all. Carries the code
 * classifyUpstreamFailure recognizes as "try the next automatic target", so one
 * misconfigured target does not fail an automatic model that has working ones.
 * A concrete model has no next target, so its client still sees this status.
 */
function unsupportedFormat(endpointName: string, apiFormat: string) {
  const error = new Error(
    `Endpoint '${endpointName}' uses the '${apiFormat}' format, which has no embeddings API.`,
  );
  error.name = "EmbeddingsUnsupportedFormatError";
  error.statusCode = 502;
  error.code = "endpoint_protocol_unsupported";
  return error;
}

function persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }: any) {
  return logError(requestId, error?.name || "Error", error?.message || "Unknown error", error?.stack || "", (buildUpstreamErrorContext as any)({ modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }));
}

/**
 * Builds the outbound embeddings request for one resolved endpoint.
 *
 * The endpoint's generation policy is deliberately NOT applied: temperature,
 * top_p, and max_tokens are completions parameters that no embeddings API
 * accepts, and forcing a configured value onto this body would make every
 * request fail. The body-param policy still runs last and remains the
 * endpoint's final say on the wire body, exactly as on the chat routes.
 */
function prepareAttempt(baseRequest: DynamicRecord, endpoint: any, requestId: string) {
  const adapter = getEmbeddingAdapter(endpoint.apiFormat);
  if (!supportsEmbeddings(endpoint.apiFormat) || !adapter) {
    throw unsupportedFormat(endpoint.endpointName, endpoint.apiFormat);
  }

  const request = clone(baseRequest);
  const data = adapter.transformEmbeddingRequest(request, endpoint.actualModel);
  applyBodyParamPolicy(data, endpoint.bodyParams);

  const ctx = { requestId, isStreaming: false };
  const headers: Record<string, string> = {
    ...endpoint.customHeaders,
    ...getExtraHeaders(endpoint.apiFormat, ctx),
    "Content-Type": "application/json",
  };
  if (endpoint.apiFormat !== "gemini") headers.Authorization = `Bearer ${endpoint.token}`;

  const fullUrl = getEmbeddingsUrl(endpoint.url, endpoint.apiFormat, endpoint.actualModel, endpoint.appendApiSuffix) as string;
  const requestUrl = endpoint.apiFormat === "gemini" ? `${fullUrl}?key=${endpoint.token}` : fullUrl;
  return { adapter, data, headers, fullUrl, requestUrl };
}

router.post("/v1/embeddings", verifyApiKey, async (req: any, res: any) => {
  const apiKey = req.apiKey;
  const baseRequest = clone(req.body) || {};
  const modelName = baseRequest.model;
  const contextTokens = estimateEmbeddingTokens(baseRequest.input);

  try { await apiKeyManager.checkForGeneration(apiKey, rateLimiter, contextTokens); }
  catch (error: any) { return res.status(error.statusCode || 500).json({ error: { message: error.message } }); }

  const registered = MODEL_REGISTRY[modelName];
  if (!registered) return res.status(404).json({ error: `Model '${modelName}' not found.` });
  if (registered.modality !== "embedding") {
    return res.status(400).json({
      error: {
        message: `Model '${modelName}' is not an embedding model. Use POST /v1/chat/completions instead.`,
        code: "not_an_embedding_model",
      },
    });
  }
  if (baseRequest.input === undefined || baseRequest.input === null || embeddingInputCount(baseRequest.input) === 0) {
    return res.status(400).json({
      error: { message: "Embedding request requires a non-empty 'input'.", code: "invalid_input" },
    });
  }

  const requestId = randomUUID();
  await logRequestStart(
    requestId,
    modelName,
    { streaming: false, embedding_inputs: embeddingInputCount(baseRequest.input) },
    // The embedded text is the request payload; it is never persisted as
    // message content, matching how the chat routes keep prompts out of logs
    // beyond what logRequestStart already retains.
    [],
    apiKey,
    {
      client_ip: getClientIp(req),
      protocol: "openai-embeddings",
      method: req.method,
      path: req.path,
      streaming: false,
    },
  );

  try {
    res.json(await makeEmbeddingRequest(requestId, baseRequest, modelName, apiKey, contextTokens));
  } catch (error: any) {
    const state = error.routingState || null;
    const c = error.attemptContext || {};
    await logRequestEnd(
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
      routingMetadata(state, c.endpointInfo, {
        upstreamUrl: c.upstreamUrl,
        upstreamStatus: c.upstreamStatus ?? statusOf(error),
        proxyStatus: statusOf(error) || 500,
      }),
    );
    await persistUpstreamError({ requestId, modelName, endpointInfo: c.endpointInfo, requestHeaders: c.requestHeaders, upstreamUrl: c.upstreamUrl, error, statusCode: statusOf(error), responseBody: c.responseBody, autoModel: state?.autoModel, targetModel: state?.currentTargetModel, routingAttempts: summarizeRoutingAttempts(state) });
    console.error(
      `API [ID: ${requestId}]: ${error?.name || "Error"}: ${error?.message || String(error)}`,
    );
    if (!res.headersSent) {
      res.status(statusOf(error) || 500).json({ error: { message: error.message || String(error), ...(error.code ? { code: error.code } : {}) } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

async function makeEmbeddingRequest(
  requestId: string,
  baseRequest: DynamicRecord,
  modelName: string,
  apiKey: string,
  contextTokens: number,
): Promise<any> {
  const result = await executeRouting(requestId, modelName, async (_state: any, endpoint: any) => {
    let prepared;
    try {
      prepared = prepareAttempt(baseRequest, endpoint, requestId);
    } catch (error: any) {
      // A malformed input or an endpoint that cannot serve embeddings at all is
      // the client's or the operator's problem, not a transient upstream one.
      // Tagging it 400 keeps classifyUpstreamFailure from retrying the key or
      // falling through every remaining automatic target for the same reason.
      if (error instanceof EmbeddingInputError) error.statusCode = 400;
      throw withContext(error, endpoint);
    }

    const proxy = proxyAgentsFor(endpoint.proxyId);
    let response;
    try {
      response = await axios({ method: "post", url: prepared.requestUrl, headers: prepared.headers, data: prepared.data, timeout: 180000, validateStatus: () => true, ...(proxy ? { httpAgent: proxy.httpAgent, httpsAgent: proxy.httpsAgent } : {}) });
    } catch (error: any) {
      throw withContext(error, endpoint, prepared);
    }
    if (response.status < 200 || response.status >= 300) {
      throw withContext(httpError(response.status, response.data), endpoint, prepared, response.data);
    }
    await keyStateManager.recordSuccess(endpoint.endpointKey, endpoint.token);
    return {
      parsed: prepared.adapter.parseEmbeddingResponse(response.data, { modelName }),
      endpoint,
      upstreamUrl: prepared.requestUrl,
      upstreamStatus: response.status,
    };
  });

  // Embeddings produce no completion tokens, so only the input side is billed.
  // Upstreams that report usage win over the estimate; the rest fall back to it.
  const reportedInput = Number(result.parsed.usage?.prompt_tokens) || 0;
  const billing = normalizeBillingTokens({
    inputTokens: reportedInput > 0 ? reportedInput : contextTokens,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    inputIncludesCache: true,
  });

  await logRequestEnd(
    requestId,
    true,
    billing.inputTokens,
    0,
    null,
    "",
    apiKey,
    0,
    0,
    String(billing.tokenAccountingVersion),
    routingMetadata(result.routingState, result.endpoint, {
      upstreamUrl: result.upstreamUrl,
      upstreamStatus: result.upstreamStatus,
      proxyStatus: 200,
    }),
  );

  const response = result.parsed.response;
  // The proxy's own model name is what the client asked for and what its usage
  // is recorded against; the upstream's name must never leak back.
  if (response && typeof response === "object") response.model = modelName;
  return response;
}

export default router;
