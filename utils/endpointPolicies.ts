import { isReservedBodyParam } from "../shared/contracts/bodyParams.js";

export function normalizeEndpointUrl(rawUrl: any, appendApiSuffix = true) {
  let url = rawUrl.replace(/\/+$/, "");
  if (appendApiSuffix) {
    url = url.replace(/\/v\d+[a-z]*(?:\/.*)?$/i, "");
  }
  return url;
}

export function getModelsUrl(baseUrl: any, apiFormat: any, appendApiSuffix = true) {
  const normalizedBaseUrl = normalizeEndpointUrl(baseUrl, appendApiSuffix);
  const versionPrefix = appendApiSuffix
    ? (apiFormat === "gemini" ? "/v1beta" : "/v1")
    : "";
  return `${normalizedBaseUrl}${versionPrefix}/models`;
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
