export type PublicTheme = "light" | "dark";

export const PUBLIC_THEME_KEY = "public-theme";
export const DEFAULT_PUBLIC_THEME: PublicTheme = "light";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
type ThemeRoot = { dataset: { theme?: string } };

export function normalizePublicTheme(value: unknown): PublicTheme {
  return value === "dark" ? "dark" : DEFAULT_PUBLIC_THEME;
}

export function readPublicTheme(storage?: ThemeStorage | null): PublicTheme {
  const target = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (!target) return DEFAULT_PUBLIC_THEME;

  try {
    return normalizePublicTheme(target.getItem(PUBLIC_THEME_KEY));
  } catch {
    return DEFAULT_PUBLIC_THEME;
  }
}

export function applyPublicTheme(theme: unknown, root?: ThemeRoot | null): PublicTheme {
  const normalized = normalizePublicTheme(theme);
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (target) target.dataset.theme = normalized;
  return normalized;
}

export function setPublicTheme(
  theme: unknown,
  storage?: ThemeStorage | null,
  root?: ThemeRoot | null,
): PublicTheme {
  const normalized = applyPublicTheme(theme, root);
  const target = storage ?? (typeof localStorage === "undefined" ? null : localStorage);

  try {
    target?.setItem(PUBLIC_THEME_KEY, normalized);
  } catch {
    // The selected appearance still applies when browser storage is unavailable.
  }

  return normalized;
}
