import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import crypto from "crypto";
import type { ModelTestResult } from "../shared/contracts/models.js";
import type { ApiFormat, BodyParamPolicy } from "../types/endpoint.js";
import { getAdapter, getExtraHeaders } from "./adapters/index.js";
import { applyBodyParamPolicy, getFullUrl } from "./endpointPolicies.js";
import { proxyAgentsFor } from "./proxyAgents.js";

export interface UpstreamModelTestInput {
  url: string;
  token: string;
  backend: string;
  customHeaders?: Record<string, string>;
  apiFormat: ApiFormat;
  appendApiSuffix: boolean;
  bodyParams?: BodyParamPolicy | null;
  proxyId?: string | null;
}

export type ModelTestRequester = (
  config: AxiosRequestConfig,
) => Promise<AxiosResponse>;

function safeErrorMessage(error: unknown, token: string): string {
  const candidate = error as {
    response?: { status?: number; data?: { error?: { message?: unknown } | unknown; message?: unknown } };
    message?: unknown;
  };
  const status = candidate.response?.status;
  const responseError = candidate.response?.data?.error;
  const rawMessage =
    (typeof responseError === "object" && responseError !== null && "message" in responseError
      ? (responseError as { message?: unknown }).message
      : undefined)
    ?? candidate.response?.data?.message
    ?? candidate.message
    ?? "Request failed";
  const message = String(rawMessage).split(token).join("[redacted]");
  return status ? `HTTP ${status}: ${message}` : message;
}

export async function testUpstreamModel(
  input: UpstreamModelTestInput,
  requester: ModelTestRequester = axios,
): Promise<ModelTestResult> {
  const { url, token, backend, customHeaders = {}, apiFormat, appendApiSuffix, bodyParams = null, proxyId = null } = input;
  const fullUrl = getFullUrl(url, apiFormat, backend, false, appendApiSuffix);
  const start = Date.now();
  const isGemini = apiFormat === "gemini";
  const testRequestId = `models-test-${crypto.randomUUID()}`;
  const codexHeaders = apiFormat === "openai-codex"
    ? getExtraHeaders(apiFormat, { requestId: testRequestId, isStreaming: false })
    : {};
  const headers = {
    ...customHeaders,
    ...codexHeaders,
    "Content-Type": "application/json",
    ...(isGemini ? {} : { Authorization: `Bearer ${token}` }),
  };
  const requestUrl = isGemini ? `${fullUrl}?key=${encodeURIComponent(token)}` : fullUrl;

  let data: Record<string, unknown>;
  if (isGemini) {
    data = { contents: [{ parts: [{ text: "ping" }] }] };
  } else if (apiFormat === "anthropic") {
    data = { model: backend, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
  } else if (apiFormat === "openai-codex") {
    const pingRequest = { model: backend, messages: [{ role: "user", content: "ping" }] };
    data = getAdapter(apiFormat).transformRequest(pingRequest, backend, {
      requestId: testRequestId,
      isStreaming: false,
    });
    data.stream = false;
  } else if (apiFormat === "openai-responses") {
    data = { model: backend, input: "ping", store: false, stream: false };
  } else {
    data = { model: backend, messages: [{ role: "user", content: "ping" }], stream: false };
  }

  // The ping carries the endpoint's body-param policy so a test reflects the
  // same wire body a real request would send: an upstream that rejects a param
  // the policy strips, or requires one it adds, fails or passes here for the
  // same reason it would in production.
  applyBodyParamPolicy(data, bodyParams);

  // The ping rides the endpoint's proxy as well, so a test reports the same
  // path a real request takes: a proxy that cannot be reached fails here for
  // the same reason it would in production.
  const proxy = proxyAgentsFor(proxyId);

  try {
    const response = await requester({
      method: "post",
      url: requestUrl,
      headers,
      data,
      timeout: 15000,
      ...(proxy ? { httpAgent: proxy.httpAgent, httpsAgent: proxy.httpsAgent } : {}),
    });
    const latency_ms = Date.now() - start;
    return response.status === 200
      ? { ok: true, latency_ms }
      : { ok: false, error: `Upstream returned HTTP ${response.status}`, latency_ms };
  } catch (error) {
    return {
      ok: false,
      error: safeErrorMessage(error, token),
      latency_ms: Date.now() - start,
    };
  }
}
