export type NumericInputValue = string | number | undefined;
export type ModelFormType = "concrete" | "auto";

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
