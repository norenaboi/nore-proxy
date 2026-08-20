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

export function filterModelNames(names: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return names;
  return names.filter((name) => name.toLowerCase().includes(normalizedQuery));
}
