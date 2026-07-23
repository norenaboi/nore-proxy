import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.join(path.dirname(__filename), "..");

export function getModelsPath() {
  return process.env.NORE_PROXY_MODELS_PATH || path.join(ROOT_DIR, "models.json");
}

export function getEndpointsPath() {
  return process.env.NORE_PROXY_ENDPOINTS_PATH || path.join(ROOT_DIR, "endpoints.json");
}

export function getSettingsPath() {
  return process.env.NORE_PROXY_SETTINGS_PATH || path.join(ROOT_DIR, "settings.json");
}
