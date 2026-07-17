export function normalizeEndpointUrl(rawUrl, appendApiSuffix = true) {
  let url = rawUrl.replace(/\/+$/, "");
  if (appendApiSuffix) {
    url = url.replace(/\/v\d+[a-z]*(?:\/.*)?$/i, "");
  }
  return url;
}

export function getFullUrl(
  baseUrl,
  apiFormat,
  modelName,
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

export function applyGenerationPolicy(requestBody, policy = {}) {
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
