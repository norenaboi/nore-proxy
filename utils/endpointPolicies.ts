import { isReservedBodyParam } from "../shared/contracts/bodyParams.js";
import { apiFormatCategory } from "../shared/contracts/apiFormats.js";

export function normalizeEndpointUrl(rawUrl: any, appendApiSuffix = true) {
  let url = rawUrl.replace(/\/+$/, "");
  if (appendApiSuffix) {
    url = url.replace(/\/v\d+[a-z]*(?:\/.*)?$/i, "");
  }
  return url;
}

/** Google surfaces are under /v1beta in every category; all others use /v1. */
function versionPrefixFor(apiFormat: string, appendApiSuffix: boolean) {
  if (!appendApiSuffix) return "";
  return apiFormat === "gemini" || apiFormat === "gemini-interactions" || apiFormat === "gemini-embeddings"
    ? "/v1beta"
    : "/v1";
}

export function getModelsUrl(baseUrl: any, apiFormat: any, appendApiSuffix = true) {
  const normalizedBaseUrl = normalizeEndpointUrl(baseUrl, appendApiSuffix);
  return `${normalizedBaseUrl}${versionPrefixFor(String(apiFormat || ""), appendApiSuffix)}/models`;
}

export function getFullUrl(
  baseUrl: string,
  apiFormat: string,
  modelName: string,
  isStreaming = false,
  appendApiSuffix = true,
) {
  const versionPrefix = appendApiSuffix ? "/v1" : "";

  switch (apiFormat) {
    case "anthropic":
      return `${baseUrl}${versionPrefix}/messages`;

    case "gemini": {
      const geminiPrefix = appendApiSuffix ? "/v1beta" : "";
      return isStreaming
        ? `${baseUrl}${geminiPrefix}/models/${modelName}:streamGenerateContent`
        : `${baseUrl}${geminiPrefix}/models/${modelName}:generateContent`;
    }

    case "openai-responses":
    case "openai-codex":
      return `${baseUrl}${versionPrefix}/responses`;

    case "openai":
    default:
      return `${baseUrl}${versionPrefix}/chat/completions`;
  }
}

/**
 * Upstream credential placement, by format:
 *   gemini, gemini-embeddings  -> `?key=` query parameter
 *   gemini-interactions        -> `x-goog-api-key` header
 *   anthropic                  -> `x-api-key` header
 *   all others                 -> `Authorization: Bearer`
 */
export function usesQueryKeyAuth(apiFormat: string | null | undefined): boolean {
  return apiFormat === "gemini" || apiFormat === "gemini-embeddings";
}

export function upstreamAuthHeaders(
  apiFormat: string | null | undefined,
  token: string | null | undefined,
): Record<string, string> {
  if (!token) return {};
  if (usesQueryKeyAuth(apiFormat)) return {};
  if (apiFormat === "anthropic") return { "x-api-key": token };
  if (apiFormat === "gemini-interactions") return { "x-goog-api-key": token };
  return { Authorization: `Bearer ${token}` };
}

/** Appends the query-string credential for the formats that authenticate that way. */
export function applyQueryKeyAuth(
  url: string,
  apiFormat: string | null | undefined,
  token: string | null | undefined,
  extraQuery = "",
): string {
  if (!usesQueryKeyAuth(apiFormat)) return url;
  return `${url}?${extraQuery}key=${token}`;
}

/**
 * Whether an endpoint's format serves embeddings: its declared category, not a
 * capability inferred from a chat format. `openai` speaks completions and
 * `openai-embeddings` speaks vectors; one endpoint is never both.
 */
export function supportsEmbeddings(apiFormat: string | null | undefined): boolean {
  return apiFormatCategory(apiFormat) === "embedding";
}

/**
 * The upstream embeddings URL for an endpoint, or null for formats outside the
 * embedding category. Callers turn null into a configuration error naming the
 * endpoint rather than an upstream 404.
 */
export function getEmbeddingsUrl(
  baseUrl: string,
  apiFormat: string,
  modelName: string,
  appendApiSuffix = true,
) {
  if (!supportsEmbeddings(apiFormat)) return null;

  if (apiFormat === "gemini-embeddings") {
    const geminiPrefix = appendApiSuffix ? "/v1beta" : "";
    return `${baseUrl}${geminiPrefix}/models/${modelName}:embedContent`;
  }

  return `${baseUrl}${appendApiSuffix ? "/v1" : ""}/embeddings`;
}

/**
 * Whether an endpoint's format serves image generation: its declared category.
 */
export function supportsImages(apiFormat: string | null | undefined): boolean {
  return apiFormatCategory(apiFormat) === "image";
}

/**
 * The upstream images URL for an endpoint, or null for formats outside the
 * image category. Callers turn null into a configuration error naming the
 * endpoint rather than an upstream 404.
 */
export function getImagesUrl(
  baseUrl: string,
  apiFormat: string,
  modelName: string,
  appendApiSuffix = true,
) {
  if (!supportsImages(apiFormat)) return null;

  if (apiFormat === "gemini-interactions") {
    return `${baseUrl}${appendApiSuffix ? "/v1beta" : ""}/interactions`;
  }

  return `${baseUrl}${appendApiSuffix ? "/v1" : ""}/images`;
}

export function applyGenerationPolicy(requestBody: any, policy: Record<string, any> = {}) {
  for (const param of ["temperature", "top_p", "max_tokens"]) {
    const config = policy[param] || { enabled: false, value: null };
    if (config.enabled !== true) {
      delete requestBody[param];
    } else if (config.value !== undefined && config.value !== null) {
      requestBody[param] = config.value;
    }
  }
  return requestBody;
}

/**
 * Applies an endpoint's custom body-param policy to an already-transformed
 * outbound body. Stripping runs before adding, so a param may be listed in both
 * editors to force a value regardless of what the adapter produced. Params the
 * proxy owns are ignored here as well as at edit and persist time, since a
 * policy can also arrive from a hand-edited endpoints.json.
 *
 * Mutates and returns `requestBody`, matching applyGenerationPolicy. This runs
 * last, after the adapter and the generation policy, so it is the endpoint's
 * final say on the wire body.
 */
export function applyBodyParamPolicy(requestBody: any, policy: any) {
  if (!requestBody || typeof requestBody !== "object") return requestBody;
  if (!policy || typeof policy !== "object") return requestBody;

  if (Array.isArray(policy.strip)) {
    for (const name of policy.strip) {
      if (typeof name !== "string" || isReservedBodyParam(name)) continue;
      delete requestBody[name];
    }
  }

  if (policy.add && typeof policy.add === "object" && !Array.isArray(policy.add)) {
    for (const [name, value] of Object.entries(policy.add)) {
      if (isReservedBodyParam(name)) continue;
      requestBody[name] = value;
    }
  }

  return requestBody;
}
