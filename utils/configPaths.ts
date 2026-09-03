import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.join(path.dirname(__filename), "..");

/**
 * Runtime JSON configuration defaults to the data/ directory. Older layouts
 * kept these files at the repository root: when data/<file> does not exist yet
 * but the root file does, the root file keeps being used so an upgrade
 * neither loses nor forks the configuration. An explicit *_PATH env var
 * always wins outright and disables the fallback, which is what keeps tests
 * hermetic.
 */
export function resolveConfigPath(
  override: string | undefined,
  fileName: string,
  rootDir: string = ROOT_DIR,
): string {
  if (override) return override;
  const dataPath = path.join(rootDir, "data", fileName);
  if (fs.existsSync(dataPath)) return dataPath;
  const legacyPath = path.join(rootDir, fileName);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return dataPath;
}

export function getModelsPath() {
  return resolveConfigPath(process.env.MODELS_PATH, "models.json");
}

export function getEndpointsPath() {
  return resolveConfigPath(process.env.ENDPOINTS_PATH, "endpoints.json");
}

export function getSettingsPath() {
  return resolveConfigPath(process.env.SETTINGS_PATH, "settings.json");
}

export function getProxiesPath() {
  return resolveConfigPath(process.env.PROXIES_PATH, "proxies.json");
}
