/**
 * Shared routing execution for the client-facing request routes.
 *
 * This is the target/key/retry loop that every proxied request runs, extracted
 * verbatim from routes/chat.ts so the embeddings route executes exactly the same
 * automatic-model fallback, key rotation, key-health accounting, and retry
 * classification rather than growing a second dialect of them.
 *
 * The loop itself is protocol-agnostic: everything protocol-specific lives in
 * the `runAttempt` callback the route supplies, which builds the outbound body,
 * performs the network call, and returns whatever result that route needs.
 */

import settingsManager from "../services/settingsManager.js";
import keyStateManager, { ACTIONABLE_CODES } from "../services/keyStateManager.js";
import { MODEL_REGISTRY, getEndpointForConcreteModel, resolveKeyHealth, resolveRetryAttempts } from "./helpers.js";
import {
  attemptedKeyHashes,
  classifyUpstreamFailure,
  createRoutingState,
  nextTarget,
  recordRoutingAttempt,
} from "./autoRouting.js";
import { getUpstreamErrorMessage } from "./upstreamErrors.js";

declare global {
  interface Error {
    statusCode?: number; code?: string | number | null; responseBody?: any;
    attemptContext?: any; routingState?: any; clientAbort?: boolean;
  }
}

export type RoutingAttemptRunner = (state: any, endpoint: any) => Promise<any>;

export const statusOf = (error: any): any => error?.response?.status ?? error?.statusCode ?? null;

export function httpError(status: any, body: any) {
  const error = new Error(`Error ${status}: ${getUpstreamErrorMessage(body)}`);
  error.name = "UpstreamHttpError";
  error.statusCode = status;
  error.responseBody = body;
  return error;
}

export function withContext(error: Error, endpointInfo: any, prepared: Record<string, any> = {}, responseBody?: any): Error {
  Object.defineProperty(error, "attemptContext", {
    value: {
      endpointInfo,
      requestHeaders: prepared.headers,
      upstreamUrl: prepared.fullUrl,
      responseBody: error.responseBody ?? responseBody ?? null,
      upstreamStatus: statusOf(error),
    },
    configurable: true,
  });
  return error;
}

export function autoExhausted(lastError: any, state: any) {
  const unavailable = state.attempts.length === 0 || state.attempts.every(
    (attempt: any) => attempt.outcome === "target_unavailable" || attempt.outcome === "key_exhausted",
  );
  const error = new Error(
    unavailable
      ? `Automatic model '${state.requestedModel}' has no available targets.`
      : lastError?.message || "All automatic routing targets failed.",
  );
  error.name = unavailable ? "AutoTargetsUnavailableError" : "AutoTargetsExhaustedError";
  error.code = unavailable ? "auto_targets_unavailable" : "auto_targets_exhausted";
  error.statusCode = unavailable ? 503 : statusOf(lastError) || 502;
  error.responseBody = lastError?.responseBody;
  error.attemptContext = lastError?.attemptContext;
  error.routingState = state;
  return error;
}

export async function recordKeyFailure(endpoint: any, status: any) {
  if (!endpoint?.token || !ACTIONABLE_CODES.has(Number(status))) return;
  await keyStateManager.recordFailure(endpoint.endpointKey, endpoint.token, Number(status), { sideline: resolveKeyHealth(endpoint.keyHealth) });
}

export function noteAttempt(state: any, endpoint: any, keyAttempt: any, outcome: any, decision: any, statusCode: any, retryAttempt: any = 0) {
  recordRoutingAttempt(state, { targetModel: endpoint?.targetModel, endpointKey: endpoint?.endpointKey, endpointName: endpoint?.endpointName, tokenHash: endpoint?.tokenHash, keyAttempt, retryAttempt, outcome, retryReason: decision?.reason, statusCode });
}

export async function executeRouting(requestId: string, requestedModel: string, runAttempt: RoutingAttemptRunner): Promise<any> {
  const state = createRoutingState({ requestId, requestedModel, registry: MODEL_REGISTRY, globalCeiling: settingsManager.get("autoModelMaxTargetAttempts") });
  const maxKeyAttempts = 1 + Math.max(0, parseInt(String(settingsManager.get("keyHopAttempts")), 10) || 0);
  let lastError = null;

  for (let target = nextTarget(state); target; target = nextTarget(state)) {
    let fallback = false;
    let endpointKey = null;
    // One rotation start per target: the hops below continue round-robin from it
    // instead of drawing a new random position each time.
    let rotationOffset: number | undefined;
    for (let keyAttempt = 1; keyAttempt <= maxKeyAttempts; keyAttempt++) {
      const excluded: Set<string> = endpointKey ? attemptedKeyHashes(state, endpointKey) ?? new Set<string>() : new Set<string>();
      const endpoint = await getEndpointForConcreteModel(target, { excludeHashes: excluded, rotationOffset });
      if (!endpoint) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = state.autoModel ? 503 : 404;
        if (!state.autoModel) throw error;
        lastError = error;
        recordRoutingAttempt(state, {
          targetModel: target,
          keyAttempt,
          outcome: "target_unavailable",
          retryReason: "http_5xx",
          statusCode: 503,
        });
        fallback = true;
        break;
      }
      endpointKey = endpoint.endpointKey;
      rotationOffset = endpoint.rotationOffset ?? rotationOffset;
      const tried = attemptedKeyHashes(state, endpointKey) ?? new Set<string>();
      if (endpoint.tokenExhausted || !endpoint.token) {
        lastError = withContext(await keyStateManager.buildExhaustionError(String(endpointKey)), endpoint);
        const decision = classifyUpstreamFailure({ keyExhausted: true });
        noteAttempt(state, endpoint, keyAttempt, "key_exhausted", decision, 404);
        fallback = true;
        break;
      }
      // Same-key retries for transient failures (5xx, timeout, network), before
      // this key is written off and the request hops or falls back.
      const maxRetries = resolveRetryAttempts(endpoint.retryAttempts);
      let decision: any = null;
      for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt++) {
        try {
          const result = await runAttempt(state, endpoint);
          noteAttempt(state, endpoint, keyAttempt, "success", null, null, retryAttempt);
          if (result && typeof result === "object") {
            Object.defineProperty(result, "routingState", {
              value: state,
              enumerable: false,
            });
          }
          return result;
        } catch (error: any) {
          if (error.clientAbort) throw error;
          lastError = error;
          const status = statusOf(error);
          decision = classifyUpstreamFailure({ statusCode: status, error, streamOutputStarted: state.streamOutputStarted });
          const retrying = decision.retrySame && retryAttempt < maxRetries;
          noteAttempt(state, endpoint, keyAttempt, retrying ? "retry" : "failure", decision, status, retryAttempt);
          await recordKeyFailure(endpoint, status);
          if (!retrying) break;
        }
      }
      if (endpoint.tokenHash) tried.add(endpoint.tokenHash);
      if (decision.retryKey && keyAttempt < maxKeyAttempts) continue;
      fallback = decision.fallbackTarget;
      break;
    }
    if (!fallback) throw lastError;
  }
  if (state.autoModel) throw autoExhausted(lastError, state);
  if (lastError) {
    lastError.routingState = state;
    throw lastError;
  }
  const error = new Error(`Model '${requestedModel}' not found.`);
  error.statusCode = 404;
  throw error;
}
