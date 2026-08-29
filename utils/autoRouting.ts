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
  /**
   * Reject targets that name no concrete model. Only admin writes set this: the
   * registry loader must stay permissive, since failing the whole definition
   * would take an auto model offline over one stale name instead of routing
   * around it.
   */
  requireExistingTargets?: boolean;
  /**
   * Targets exempt from that check because the stored definition already had
   * them. Without this an auto model left holding a stale name after a deletion
   * could not be saved at all, so an unrelated edit would be blocked by damage
   * the operator did not cause.
   */
  grandfatheredTargets?: readonly string[];
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

function isConcreteModel(config: ModelConfig | null | undefined): boolean {
  // modelType() defaults an absent definition to "concrete", so existence has to
  // be checked before its type — otherwise a target naming nothing reads as valid.
  return Boolean(config) && modelType(config) === "concrete";
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
    } else if (maxTargetAttempts > globalCeiling) {
      errors.push("Maximum target attempts cannot exceed the global ceiling");
    }
  }

  for (const target of uniqueTargets) {
    if (target === trimmedName) {
      errors.push("Auto model cannot target itself");
    }
  }

  if (context.requireExistingTargets && context.models) {
    const grandfathered = new Set(context.grandfatheredTargets || []);
    const unknown = uniqueTargets.filter(
      (target) =>
        target !== trimmedName &&
        !grandfathered.has(target) &&
        !isConcreteModel(context.models?.[target]),
    );
    // Named individually: the operator needs to know which one to fix, and a
    // typo and a since-deleted model look identical without the name.
    for (const target of unknown) {
      errors.push(`Auto model target '${target}' is not an existing concrete model`);
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

/**
 * Drops the named concrete models from every auto model's target list, returning
 * the auto models that changed so the caller can report them.
 *
 * Called wherever a concrete model stops existing under its name — deletion, or
 * conversion to an auto model. Pruning at the write is what keeps `models.json`
 * free of dead targets, rather than leaving them to be filtered on every request
 * forever.
 */
export function pruneAutoTargetReferences(
  models: ModelsByName | null | undefined,
  removedNames: readonly string[],
) {
  const removed = new Set(removedNames);
  if (removed.size === 0) return [];
  const affected: Array<{ name: string; remainingTargets: number }> = [];
  for (const [name, config] of Object.entries(models || {})) {
    if (modelType(config) !== "auto" || !Array.isArray(config.targets)) continue;
    const kept = config.targets.filter((target) => !removed.has(target));
    if (kept.length === config.targets.length) continue;
    config.targets = kept;
    affected.push({ name, remainingTargets: kept.length });
  }
  return affected;
}

export function resetAutoRoutingCounters() {
  autoModelCounters.clear();
}

/**
 * Splits an auto model's configured targets into the ones that can actually be
 * routed to and the dead ones, preserving configured order.
 *
 * A target is only routable while it is registered as a concrete model. Names
 * that were deleted, models that are disabled or invalid (neither reaches the
 * registry), and other auto models are all dead ends. They have to be dropped
 * before the attempt ceiling is applied: counted in, a dead name consumes one
 * of the few failover slots and a healthy target further down the list is never
 * reached, so an auto model with one stale target can fail while a working one
 * sits right behind it.
 */
export function resolveAutoTargets(
  targets: readonly string[] | null | undefined,
  registry: ModelRegistry | null | undefined,
): { targets: string[]; dropped: string[] } {
  const live: string[] = [];
  const dropped: string[] = [];
  for (const target of new Set(targets || [])) {
    if (registry?.[target]?.routingType === "concrete") live.push(target);
    else dropped.push(target);
  }
  return { targets: live, dropped };
}

export function getTargetSequence(
  requestedModel: string,
  registry: ModelRegistry | null | undefined,
  globalCeiling = 3,
) {
  const definition = registry?.[requestedModel];
  if (!definition) return [];
  if (definition.routingType !== "auto") return [requestedModel];

  const { targets } = resolveAutoTargets(definition.targets, registry);
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
    retryAttempt: attempt.retryAttempt ?? null,
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
  if (streamOutputStarted) return { reason: "output_started", retrySame: false, retryKey: false, fallbackTarget: false };
  if (keyExhausted) return { reason: "key_exhausted", retrySame: false, retryKey: false, fallbackTarget: true };

  const status = Number(statusCode);
  // Actionable codes belong to the key, not the moment: another attempt on the
  // same credential would fail identically, so hop instead of retrying.
  if (Number.isInteger(status) && [401, 402, 403, 429].includes(status)) {
    return { reason: `http_${status}`, retrySame: false, retryKey: true, fallbackTarget: true };
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { reason: "http_5xx", retrySame: true, retryKey: false, fallbackTarget: true };
  }
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    return { reason: `http_${status}`, retrySame: false, retryKey: false, fallbackTarget: false };
  }

  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  const timeout = ["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || message.includes("timeout");
  if (timeout) return { reason: "timeout", retrySame: true, retryKey: false, fallbackTarget: true };
  const network = !error?.response && (code.startsWith("E") || /network|socket|dns|tls|connection/.test(message));
  if (network) return { reason: "network", retrySame: true, retryKey: false, fallbackTarget: true };
  return { reason: "terminal", retrySame: false, retryKey: false, fallbackTarget: false };
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
