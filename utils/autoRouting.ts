import type { EndpointKey } from "../types/endpoint.js";
import type { ModelDefinition, ModelRegistry, TargetSelection } from "../types/models.js";
import type { RoutingAttempt } from "../types/log.js";

const TARGET_SELECTIONS = new Set<TargetSelection>(["sticky", "roundrobin"]);
const MAX_ATTEMPT_RECORDS = 64;
const autoModelCounters = new Map<string, number>();

type ModelConfig = ModelDefinition & Record<string, unknown>;
type ModelsByName = Record<string, ModelConfig>;
type EndpointMap = Partial<Record<EndpointKey, unknown>>;
type ValidationContext = {
  models?: ModelsByName;
  endpoints?: EndpointMap;
  globalCeiling?: number;
};
type RoutingState = {
  requestId: string;
  requestedModel: string;
  autoModel: string | null;
  targetSequence: string[];
  targetCursor: number;
  currentTargetModel: string | null;
  attemptedTargets: Set<string>;
  attemptedKeyHashes: Map<string, Set<string>>;
  attempts: RoutingAttempt[];
  streamOutputStarted: boolean;
  maxTargetAttempts: number;
};
type RoutingExecution = {
  upstreamUrl?: string | null;
  upstreamStatus?: number | null;
  proxyStatus?: number | null;
};
type EndpointInfo = {
  targetModel?: string | null;
  actualModel?: string | null;
  endpointKey?: string | null;
  endpointName?: string | null;
  apiFormat?: string | null;
  token?: string | null;
};
type FailureOptions = {
  statusCode?: number | null;
  error?: { code?: unknown; message?: unknown; response?: unknown } | null;
  keyExhausted?: boolean;
  streamOutputStarted?: boolean;
};

function modelType(config: ModelConfig | null | undefined) {
  return config?.type === "auto" ? "auto" : "concrete";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateModelDefinition(
  name: string,
  config: ModelConfig | null | undefined,
  context: ValidationContext = {},
) {
  const errors = [];
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) errors.push("Model name is required");
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["Model definition must be an object"] };
  }

  const type = modelType(config);
  if (type === "concrete") {
    const configuredBackend =
      typeof config.backend === "string" ? config.backend.trim() : "";
    const backend = configuredBackend || trimmedName;
    const version = typeof config.version === "string" ? config.version.trim() : "";
    if (!version) errors.push("Concrete model endpoint version is required");
    if (version && context.endpoints && !context.endpoints[version as `v${number}`]) {
      errors.push(`Endpoint '${version}' does not exist`);
    }
    return {
      valid: errors.length === 0,
      errors,
      definition: {
        type: "concrete",
        backend,
        version,
        pricing: config.pricing,
        disabled: config.disabled === true,
      },
    };
  }

  const targets = Array.isArray(config.targets)
    ? config.targets.map((target) => String(target).trim()).filter(Boolean)
    : [];
  const uniqueTargets = [...new Set(targets)];
  if (targets.length < 2) errors.push("Auto model requires at least two targets");
  if (uniqueTargets.length !== targets.length) errors.push("Auto model targets must be unique");

  const targetSelection =
    typeof config.targetSelection === "string" ? config.targetSelection : "sticky";
  if (!TARGET_SELECTIONS.has(targetSelection as TargetSelection)) {
    errors.push("Target selection must be 'sticky' or 'roundrobin'");
  }

  const globalCeiling = context.globalCeiling ?? 3;
  let maxTargetAttempts = null;
  if (config.maxTargetAttempts !== undefined && config.maxTargetAttempts !== null && config.maxTargetAttempts !== "") {
    maxTargetAttempts = Number(config.maxTargetAttempts);
    if (!positiveInteger(maxTargetAttempts)) {
      errors.push("Maximum target attempts must be a positive integer");
    } else {
      if (maxTargetAttempts > targets.length) {
        errors.push("Maximum target attempts cannot exceed target count");
      }
      if (maxTargetAttempts > globalCeiling) {
        errors.push("Maximum target attempts cannot exceed the global ceiling");
      }
    }
  }

  const rawModels = context.models || {};
  for (const target of uniqueTargets) {
    if (target === trimmedName) {
      errors.push("Auto model cannot target itself");
      continue;
    }
    const targetConfig = rawModels[target];
    if (!targetConfig) {
      errors.push(`Target '${target}' does not exist`);
      continue;
    }
    if (modelType(targetConfig) !== "concrete") {
      errors.push(`Target '${target}' must be a concrete model`);
      continue;
    }
    if (targetConfig.disabled === true) {
      errors.push(`Target '${target}' is disabled`);
    }
    if (
      context.endpoints &&
      (typeof targetConfig.version !== "string" || !context.endpoints[targetConfig.version as EndpointKey])
    ) {
      errors.push(`Target '${target}' references a missing endpoint`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    definition: {
      type: "auto",
      targets: uniqueTargets,
      targetSelection: TARGET_SELECTIONS.has(targetSelection as TargetSelection)
        ? targetSelection as TargetSelection
        : "sticky",
      maxTargetAttempts: positiveInteger(maxTargetAttempts) ? maxTargetAttempts : null,
      pricing: config.pricing,
      disabled: config.disabled === true,
    },
  };
}

export function findAutoDependents(models: ModelsByName | null | undefined, concreteName: string) {
  return Object.entries(models || {})
    .filter(([, config]) =>
      modelType(config) === "auto" &&
      Array.isArray(config.targets) &&
      config.targets.includes(concreteName),
    )
    .map(([name]) => name);
}

export function rewriteAutoTargetReferences(
  models: ModelsByName | null | undefined,
  oldName: string,
  newName: string,
) {
  for (const config of Object.values(models || {})) {
    if (modelType(config) !== "auto" || !Array.isArray(config.targets)) continue;
    config.targets = config.targets.map((target) => target === oldName ? newName : target);
  }
}

export function resetAutoRoutingCounters() {
  autoModelCounters.clear();
}

export function getTargetSequence(
  requestedModel: string,
  registry: ModelRegistry | null | undefined,
  globalCeiling = 3,
) {
  const definition = registry?.[requestedModel];
  if (!definition) return [];
  if (definition.routingType !== "auto") return [requestedModel];

  const targets = [...new Set(definition.targets || [])];
  if (targets.length === 0) return [];
  const modelLimit = definition.maxTargetAttempts ?? globalCeiling;
  const limit = Math.min(targets.length, modelLimit, globalCeiling);
  let start = 0;
  if (definition.targetSelection === "roundrobin") {
    start = autoModelCounters.get(requestedModel) || 0;
    autoModelCounters.set(requestedModel, (start + 1) % targets.length);
  }
  const ordered = targets.map((_, index) => targets[(start + index) % targets.length]);
  return ordered.slice(0, limit);
}

export function createRoutingState({
  requestId,
  requestedModel,
  registry,
  globalCeiling = 3,
}: {
  requestId: string;
  requestedModel: string;
  registry: ModelRegistry | null | undefined;
  globalCeiling?: number;
}): RoutingState {
  const definition = registry?.[requestedModel];
  const targetSequence = getTargetSequence(requestedModel, registry, globalCeiling);
  return {
    requestId,
    requestedModel,
    autoModel: definition?.routingType === "auto" ? requestedModel : null,
    targetSequence,
    targetCursor: 0,
    currentTargetModel: null,
    attemptedTargets: new Set(),
    attemptedKeyHashes: new Map(),
    attempts: [],
    streamOutputStarted: false,
    maxTargetAttempts: targetSequence.length,
  };
}

export function nextTarget(state: RoutingState) {
  while (state.targetCursor < state.targetSequence.length) {
    const target = state.targetSequence[state.targetCursor++];
    if (state.attemptedTargets.has(target)) continue;
    state.attemptedTargets.add(target);
    state.currentTargetModel = target;
    return target;
  }
  state.currentTargetModel = null;
  return null;
}

export function attemptedKeyHashes(state: RoutingState, endpointKey: string) {
  if (!state.attemptedKeyHashes.has(endpointKey)) {
    state.attemptedKeyHashes.set(endpointKey, new Set());
  }
  return state.attemptedKeyHashes.get(endpointKey);
}

export function recordRoutingAttempt(state: RoutingState, attempt: Partial<RoutingAttempt>) {
  const safe = {
    targetModel: attempt.targetModel ?? state.currentTargetModel ?? null,
    endpointKey: attempt.endpointKey ?? null,
    endpointName: attempt.endpointName ?? null,
    tokenHash: attempt.tokenHash ?? null,
    targetAttempt: attempt.targetAttempt ?? state.attemptedTargets.size,
    keyAttempt: attempt.keyAttempt ?? null,
    outcome: attempt.outcome ?? null,
    retryReason: attempt.retryReason ?? null,
    statusCode: Number.isInteger(attempt.statusCode) ? attempt.statusCode : null,
  };
  if (state.attempts.length < MAX_ATTEMPT_RECORDS) state.attempts.push(safe);
  return safe;
}

export function markStreamOutputStarted(state: RoutingState) {
  state.streamOutputStarted = true;
}

export function classifyUpstreamFailure({
  statusCode = null,
  error = null,
  keyExhausted = false,
  streamOutputStarted = false,
}: FailureOptions = {}) {
  if (streamOutputStarted) return { reason: "output_started", retryKey: false, fallbackTarget: false };
  if (keyExhausted) return { reason: "key_exhausted", retryKey: false, fallbackTarget: true };

  const status = Number(statusCode);
  if (Number.isInteger(status) && [401, 402, 403, 429].includes(status)) {
    return { reason: `http_${status}`, retryKey: true, fallbackTarget: true };
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { reason: "http_5xx", retryKey: false, fallbackTarget: true };
  }
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    return { reason: `http_${status}`, retryKey: false, fallbackTarget: false };
  }

  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  const timeout = ["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || message.includes("timeout");
  if (timeout) return { reason: "timeout", retryKey: false, fallbackTarget: true };
  const network = !error?.response && (code.startsWith("E") || /network|socket|dns|tls|connection/.test(message));
  if (network) return { reason: "network", retryKey: false, fallbackTarget: true };
  return { reason: "terminal", retryKey: false, fallbackTarget: false };
}

export function summarizeRoutingAttempts(state: Pick<RoutingState, "attempts"> | null | undefined) {
  return (state?.attempts || []).map((attempt) => ({ ...attempt }));
}

export function routingMetadata(
  state: Pick<RoutingState, "requestedModel" | "autoModel" | "currentTargetModel" | "attempts"> | null | undefined,
  endpointInfo: EndpointInfo | null = null,
  execution: RoutingExecution = {},
) {
  return {
    requested_model: state?.requestedModel ?? null,
    auto_model: state?.autoModel ?? null,
    target_model: state?.currentTargetModel ?? endpointInfo?.targetModel ?? null,
    upstream_model: endpointInfo?.actualModel ?? null,
    endpoint_key: endpointInfo?.endpointKey ?? null,
    endpoint_name: endpointInfo?.endpointName ?? null,
    api_format: endpointInfo?.apiFormat ?? null,
    upstream_url: execution.upstreamUrl ?? null,
    upstream_token: endpointInfo?.token ?? null,
    upstream_status: execution.upstreamStatus ?? null,
    proxy_status: execution.proxyStatus ?? null,
    routing_attempt_count: state?.attempts?.length ?? 0,
    routing_attempts: summarizeRoutingAttempts(state),
  };
}
