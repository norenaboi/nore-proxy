/**
 * SettingsManager — runtime overrides for proxy settings.
 * 
 * Defaults are always read from .env (via process.env).
 * Admin panel PUT updates persist in memory only and reset on reload() or restart.
 * No settings.json file is used.
 */

function parseEnvBool(val) {
  if (val === undefined || val === null || val === "") return false;
  const lower = String(val).toLowerCase().trim();
  return lower === "true" || lower === "1";
}

function parseEnvInt(val, fallback) {
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

class SettingsManager {
  constructor() {
    this._loadDefaults();
    // In-memory overrides (empty on startup)
    this._overrides = {};
  }

  _loadDefaults() {
    this._defaults = {
      promptCachingEnabled: parseEnvBool(process.env.PROMPT_CACHING),
      promptCachingDepth: parseEnvInt(process.env.PROMPT_CACHING_DEPTH, 2),
    };
  }

  _currentSettings() {
    return { ...this._defaults, ...this._overrides };
  }

  get(key) {
    if (!(key in this._defaults)) {
      throw Object.assign(new Error(`Unknown setting: "${key}"`), {
        statusCode: 400,
      });
    }
    return key in this._overrides ? this._overrides[key] : this._defaults[key];
  }

  getAll() {
    return this._currentSettings();
  }

  set(key, value) {
    if (!(key in this._defaults)) {
      throw Object.assign(new Error(`Unknown setting: "${key}"`), {
        statusCode: 400,
      });
    }
    this._overrides[key] = value;
  }

  update(updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in this._defaults)) {
        throw Object.assign(new Error(`Unknown setting: "${key}"`), {
          statusCode: 400,
        });
      }
      this._overrides[key] = value;
    }
  }

  reload() {
    // process.env is already updated by Config.reload() → dotenv.config({ override: true })
    this._loadDefaults();
    this._overrides = {};
    console.log(
      "[SettingsManager] Reloaded from .env, cleared runtime overrides:",
      this._currentSettings(),
    );
  }
}

export default new SettingsManager();
