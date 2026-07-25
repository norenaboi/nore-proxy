export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function requestPublicJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as {
        error?: string | { message?: string };
        message?: string;
      };
      message =
        (typeof body.error === "string" ? body.error : body.error?.message) ??
        body.message ??
        message;
    } catch {
      // Keep the status-based fallback for non-JSON errors.
    }
    throw new HttpError(message, response.status);
  }

  return (await response.json()) as T;
}
