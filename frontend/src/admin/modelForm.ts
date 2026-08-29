export type NumericInputValue = string | number | undefined;
export type ModelFormType = "concrete" | "auto";
export type TargetHealth = "live" | "disabled" | "missing";

/**
 * Health of each configured target of an auto model, keyed by target name.
 *
 * "missing" means no concrete model answers to that name any more, so routing
 * skips it and only an edit can fix it; "disabled" is recoverable by re-enabling
 * the target. Both are dead at request time, which is why the editor has to
 * distinguish them from a target that simply hasn't been tested.
 */
export function targetHealth(
  targets: readonly string[],
  models: ReadonlyArray<{ name: string; modelType?: "auto" | "concrete"; disabled?: boolean }>,
): Map<string, TargetHealth> {
  const byName = new Map(models.map((model) => [model.name, model]));
  return new Map(
    targets.map((target) => {
      const model = byName.get(target);
      if (!model || model.modelType === "auto") return [target, "missing"];
      return [target, model.disabled === true ? "disabled" : "live"];
    }),
  );
}

export function deadTargets(
  targets: readonly string[],
  models: ReadonlyArray<{ name: string; modelType?: "auto" | "concrete"; disabled?: boolean }>,
): string[] {
  const health = targetHealth(targets, models);
  return targets.filter((target) => health.get(target) === "missing");
}

export function numericInputValue(value: NumericInputValue): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function effectiveModelName(displayName: string, type: ModelFormType, backend: string): string {
  const name = displayName.trim();
  return name || (type === "concrete" ? backend.trim() : "");
}

export function isDuplicateModelName(
  name: string,
  models: Array<{ name: string }>,
  editingName: string | null = null,
): boolean {
  return models.some((model) => model.name === name && model.name !== editingName);
}

export function moveTargetTo(targets: string[], from: number, to: number): string[] {
  if (from < 0 || from >= targets.length) return targets;
  const destination = Math.min(Math.max(to, 0), targets.length - 1);
  if (destination === from) return targets;

  const next = [...targets];
  const [moved] = next.splice(from, 1);
  next.splice(destination, 0, moved);
  return next;
}

export function mergeTargets(existing: string[], added: string[]): string[] {
  const merged = [...existing];
  for (const name of added) {
    if (!name || merged.includes(name)) continue;
    merged.push(name);
  }
  return merged;
}

export function filterModelNames(names: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return names;
  return names.filter((name) => name.toLowerCase().includes(normalizedQuery));
}
