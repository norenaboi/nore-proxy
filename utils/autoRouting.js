const TARGET_SELECTIONS = new Set(["sticky", "roundrobin"]);
const MAX_ATTEMPT_RECORDS = 64;
const autoModelCounters = new Map();

function modelType(config) {
  return config?.type === "auto" ? "auto" : "concrete";
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function validateModelDefinition(name, config, context = {}) {
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
    if (version && context.endpoints && !context.endpoints[version]) {
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

  const targetSelection = config.targetSelection ?? "sticky";
  if (!TARGET_SELECTIONS.has(targetSelection)) {
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
    if (context.endpoints && !context.endpoints[targetConfig.version]) {
      errors.push(`Target '${target}' references a missing endpoint`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    definition: {
      type: "auto",
      targets: uniqueTargets,
      targetSelection: TARGET_SELECTIONS.has(targetSelection) ? targetSelection : "sticky",
      maxTargetAttempts: positiveInteger(maxTargetAttempts) ? maxTargetAttempts : null,
      pricing: config.pricing,
      disabled: config.disabled === true,
    },
  };
}

export function findAutoDependents(models, concreteName) {
  return Object.entries(models || {})
    .filter(([, config]) => modelType(config) === "auto" && config.targets?.includes(concreteName))
    .map(([name]) => name);
}

export function rewriteAutoTargetReferences(models, oldName, newName) {
  for (const config of Object.values(models || {})) {
    if (modelType(config) !== "auto" || !Array.isArray(config.targets)) continue;
    config.targets = config.targets.map((target) => target === oldName ? newName : target);
  }
}

export function resetAutoRoutingCounters() {
  autoModelCounters.clear();
}

export function getTargetSequence(requestedModel, registry, globalCeiling = 3) {
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

export function createRoutingState({ requestId, requestedModel, registry, globalCeiling = 3 }) {
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

export function nextTarget(state) {
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

export function attemptedKeyHashes(state, endpointKey) {
  if (!state.attemptedKeyHashes.has(endpointKey)) {
    state.attemptedKeyHashes.set(endpointKey, new Set());
  }
  return state.attemptedKeyHashes.get(endpointKey);
}

export function recordRoutingAttempt(state, attempt) {
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

export function markStreamOutputStarted(state) {
  state.streamOutputStarted = true;
}

export function classifyUpstreamFailure({ statusCode = null, error = null, keyExhausted = false, streamOutputStarted = false } = {}) {
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

export function summarizeRoutingAttempts(state) {
  return (state?.attempts || []).map((attempt) => ({ ...attempt }));
}

export function routingMetadata(state, endpointInfo = null, execution = {}) {
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
