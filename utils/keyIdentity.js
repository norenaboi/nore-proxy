import crypto from "crypto";
import { maskKey } from "./helpers.js";

function identitySecret() {
  return process.env.NORE_PROXY_ANALYTICS_SECRET || process.env.MASTER_KEY || "";
}

export function getApiKeyId(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  const secret = identitySecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(apiKey).digest("base64url");
}

export function getSafeKeyMetadata(apiKey) {
  return {
    api_key: maskKey(apiKey) || "Unknown",
    api_key_id: getApiKeyId(apiKey),
  };
}
