export type NumericInputValue = string | number | undefined;

export function numericInputValue(value: NumericInputValue): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
