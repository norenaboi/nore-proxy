/**
 * Derives each model's modality from the endpoints that serve it.
 *
 * A concrete model takes its endpoint's API-format category; an automatic model
 * takes its first resolvable target's. This is the admin-API counterpart of the
 * derivation `loadModelsFromFile` performs against the live registry. It works
 * from the raw JSON documents, so it also covers disabled and invalid models,
 * which the registry skips but the admin list displays and filters.
 */

import { apiFormatCategory } from "../shared/contracts/apiFormats.js";
import type { ModelModality } from "../shared/contracts/models.js";
import { DEFAULT_MODEL_MODALITY } from "../shared/contracts/models.js";

type RawModels = Record<string, any>;
type RawEndpoints = Record<string, any>;

function isAuto(config: any): boolean {
  return config?.type === "auto" || config?.modelType === "auto";
}

export function deriveModelModalities(
  models: RawModels,
  endpoints: RawEndpoints,
): Map<string, ModelModality> {
  const derived = new Map<string, ModelModality>();

  for (const [name, config] of Object.entries(models || {})) {
    if (isAuto(config)) continue;
    const version = typeof config?.version === "string" ? config.version : "";
    derived.set(name, apiFormatCategory(endpoints?.[version]?.apiFormat));
  }

  // Resolved after the concrete models, so targets already carry a modality.
  // Mixed targets resolve to the first one, matching the loader.
  for (const [name, config] of Object.entries(models || {})) {
    if (!isAuto(config)) continue;
    const targets: string[] = Array.isArray(config?.targets) ? config.targets : [];
    const first = targets.map((target) => derived.get(target)).find(Boolean);
    derived.set(name, first ?? DEFAULT_MODEL_MODALITY);
  }

  return derived;
}

export function deriveModelModality(
  name: string,
  models: RawModels,
  endpoints: RawEndpoints,
): ModelModality {
  return deriveModelModalities(models, endpoints).get(name) ?? DEFAULT_MODEL_MODALITY;
}
