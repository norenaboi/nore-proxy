export class AdminApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function requestAdminJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, options);
  if (response.status === 401 || response.status === 403) {
    window.location.href = "/admin/login";
    throw new AdminApiError("Session expired", response.status);
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new AdminApiError(
      (data.error as string) || `Request failed (${response.status})`,
      response.status,
    );
  }
  return data as T;
}

export async function logout(): Promise<void> {
  await fetch("/admin/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/admin/login";
}

export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function naturalSort(a: string, b: string): number {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
