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
