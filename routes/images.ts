/**
 * OpenAI-compatible image generation — POST /v1/images.
 *
 * Mounted at `/v1/images`, the path OpenRouter's unified image API uses, and at
 * `/v1/images/generations`, the path the OpenAI SDK posts to, so both client
 * styles reach the same handler. Requests are `{ model, prompt, ... }` and
 * answers are `{ created, data: [{ b64_json | url }], usage }`.
 *
 * Provider-specific extras (`aspect_ratio`, `quality`, `output_format`,
 * `input_references`, …) are forwarded untouched by the OpenRouter adapter, so a
 * new OpenAI-compatible images provider needs no code here. Gemini's
 * Interactions surface, which has no OpenAI images compatibility, is translated
 * by its own adapter.
 *
 * Which models this route serves is decided by the endpoint: a model is an
 * image model when its endpoint uses an Image API format.
 *
 * Routing, key rotation, key health, retry classification, and automatic-model
 * fallback are the shared ones in utils/requestRouting.ts. Images are never
 * streamed, so the stream-output boundary that constrains the chat routes does
 * not apply.
 */

import express from "express";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import keyStateManager from "../services/keyStateManager.js";
import { logRequestStart, logRequestEnd, logError, normalizeBillingTokens } from "../utils/logging.js";
import { MODEL_REGISTRY, applyBodyParamPolicy, estimateTokensFromLength, getClientIp } from "../utils/helpers.js";
import { applyQueryKeyAuth, getImagesUrl, supportsImages, upstreamAuthHeaders } from "../utils/endpointPolicies.js";
import { ImageInputError, getImageAdapter } from "../utils/adapters/images.js";
import { clientRouteForModality } from "../shared/contracts/models.js";
import { buildUpstreamErrorContext } from "../utils/upstreamErrors.js";
import { executeRouting, httpError, statusOf, withContext } from "../utils/requestRouting.js";
import { routingMetadata, summarizeRoutingAttempts } from "../utils/autoRouting.js";
import { proxyAgentsFor } from "../utils/proxyAgents.js";

type DynamicRecord = Record<string, any>;

const router = express.Router();
const clone = (value: any): any => structuredClone(value);

/**
 * An endpoint whose format has no images API. Carries the code
 * classifyUpstreamFailure recognizes as "try the next automatic target", so one
 * misconfigured target does not fail an automatic model that has working ones.
 * A concrete model has no next target, so its client still sees this status.
 */
function unsupportedFormat(endpointName: string, apiFormat: string) {
  const error = new Error(
    `Endpoint '${endpointName}' uses the '${apiFormat}' format, which is not an image format. ` +
    `Set it to an Image API format to generate images from it.`,
  );
  error.name = "ImagesUnsupportedFormatError";
  error.statusCode = 502;
  error.code = "endpoint_protocol_unsupported";
  return error;
}

function persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }: any) {
  return logError(requestId, error?.name || "Error", error?.message || "Unknown error", error?.stack || "", (buildUpstreamErrorContext as any)({ modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }));
}

/**
 * Builds the outbound images request for one resolved endpoint.
 *
 * The endpoint's generation policy is deliberately NOT applied: temperature,
 * top_p, and max_tokens are completions parameters that no images API accepts,
 * and forcing a configured value onto this body would make every request fail.
 * The body-param policy still runs last and remains the endpoint's final say on
 * the wire body, exactly as on the other routes.
 */
function prepareAttempt(baseRequest: DynamicRecord, endpoint: any, requestId: string) {
  const adapter = getImageAdapter(endpoint.apiFormat);
  if (!supportsImages(endpoint.apiFormat) || !adapter) {
    throw unsupportedFormat(endpoint.endpointName, endpoint.apiFormat);
  }

  const request = clone(baseRequest);
  const data = adapter.transformImageRequest(request, endpoint.actualModel);
  applyBodyParamPolicy(data, endpoint.bodyParams);

  const headers: Record<string, string> = {
    ...endpoint.customHeaders,
    ...upstreamAuthHeaders(endpoint.apiFormat, endpoint.token),
    "Content-Type": "application/json",
  };

  const fullUrl = getImagesUrl(endpoint.url, endpoint.apiFormat, endpoint.actualModel, endpoint.appendApiSuffix) as string;
  const requestUrl = applyQueryKeyAuth(fullUrl, endpoint.apiFormat, endpoint.token);
  return { adapter, data, headers, fullUrl, requestUrl, requestId };
}

router.post(["/v1/images", "/v1/images/generations"], verifyApiKey, async (req: any, res: any) => {
  const apiKey = req.apiKey;
  const baseRequest = clone(req.body) || {};
  const modelName = baseRequest.model;
  const prompt = typeof baseRequest.prompt === "string" ? baseRequest.prompt : "";
  const contextTokens = estimateTokensFromLength(prompt.length);

  try { await apiKeyManager.checkForGeneration(apiKey, rateLimiter, contextTokens); }
  catch (error: any) { return res.status(error.statusCode || 500).json({ error: { message: error.message } }); }

  const registered = MODEL_REGISTRY[modelName];
  if (!registered) return res.status(404).json({ error: `Model '${modelName}' not found.` });
  if (registered.modality !== "image") {
    return res.status(400).json({
      error: {
        message: `Model '${modelName}' is not an image model. Use ${clientRouteForModality(registered.modality)} instead.`,
        code: "not_an_image_model",
      },
    });
  }
  if (!prompt.trim()) {
    return res.status(400).json({
      error: { message: "Image request requires a non-empty 'prompt'.", code: "invalid_prompt" },
    });
  }

  const requestId = randomUUID();
  await logRequestStart(
    requestId,
    modelName,
    { streaming: false, image_count: Number(baseRequest.n) || 1 },
    // The prompt is the request payload; it is never persisted as message
    // content, matching how the other routes keep prompts out of logs beyond
    // what logRequestStart already retains.
    [],
    apiKey,
    {
      client_ip: getClientIp(req),
      protocol: "openai-images",
      method: req.method,
      path: req.path,
      streaming: false,
    },
  );

  try {
    res.json(await makeImageRequest(requestId, baseRequest, modelName, apiKey, contextTokens));
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

async function makeImageRequest(
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
      // A malformed request or an endpoint that cannot generate images at all is
      // the client's or the operator's problem, not a transient upstream one.
      // Tagging it 400 keeps classifyUpstreamFailure from retrying the key or
      // falling through every remaining automatic target for the same reason.
      if (error instanceof ImageInputError) error.statusCode = 400;
      throw withContext(error, endpoint);
    }

    const proxy = proxyAgentsFor(endpoint.proxyId);
    let response;
    try {
      // Image generation is slower than a completion of the same size, so the
      // upstream deadline is longer than the 180s the other routes use.
      response = await axios({ method: "post", url: prepared.requestUrl, headers: prepared.headers, data: prepared.data, timeout: 300000, validateStatus: () => true, ...(proxy ? { httpAgent: proxy.httpAgent, httpsAgent: proxy.httpsAgent } : {}) });
    } catch (error: any) {
      throw withContext(error, endpoint, prepared);
    }
    if (response.status < 200 || response.status >= 300) {
      throw withContext(httpError(response.status, response.data), endpoint, prepared, response.data);
    }
    let parsed;
    try {
      parsed = prepared.adapter.parseImageResponse(response.data, { modelName });
    } catch (error: any) {
      // An interaction that reports a terminal status in a 200 body surfaces
      // here; it is classified from the error's own status, not the HTTP one.
      throw withContext(error, endpoint, prepared, error.responseBody ?? response.data);
    }
    await keyStateManager.recordSuccess(endpoint.endpointKey, endpoint.token);
    return {
      parsed,
      endpoint,
      upstreamUrl: prepared.requestUrl,
      upstreamStatus: response.status,
    };
  });

  // Upstreams that report usage win over the prompt-length estimate; the rest
  // fall back to it. Generated images are billed as output tokens where the
  // provider prices them that way, and as zero where it does not.
  const reportedInput = Number(result.parsed.usage?.prompt_tokens) || 0;
  const billing = normalizeBillingTokens({
    inputTokens: reportedInput > 0 ? reportedInput : contextTokens,
    outputTokens: Number(result.parsed.usage?.completion_tokens) || 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    inputIncludesCache: true,
  });

  await logRequestEnd(
    requestId,
    true,
    billing.inputTokens,
    billing.outputTokens,
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
