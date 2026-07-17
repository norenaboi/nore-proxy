/**
 * SettingsManager — runtime overrides for proxy settings.
 *
 * Defaults are hardcoded. Admin panel PUT updates persist to settings.json
 * and survive process restarts. No .env variables are used here.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_PATH = path.join(__dirname, "..", "settings.json");

class SettingsManager {
  constructor() {
    this._loadDefaults();
    this._overrides = this._loadFromFile();
  }

  _loadDefaults() {
    this._defaults = {
      // Key defaults
      rpdDefault: 500,
      rpmDefault: 10,
      maxContextSizeDefault: 0,

      // Default prompt caching for new endpoints (only applied at creation time)
      defaultEndpointPromptCachingEnabled: false,
      defaultEndpointPromptCachingDepth: 2,

      // Smart key management
      // How many extra key hops a single request may make when a key returns an
      // actionable code (400/401/402/429). 0 = no hop, 1 = retry once, N = up to N hops.
      keyHopAttempts: 1,
      // How long a 429'd key stays timed out before auto-recovering (hours).
      keyTimeoutHours: 24,
      // Default rotation mode seeded onto new endpoints: "sticky" | "roundrobin".
      defaultEndpointKeyRotation: "sticky",
      // Default key-health mode seeded onto new endpoints.
      // true  = an actionable error (400/401/402/429) sidelines the key (invalid/timeout).
      // false = keys are never sidelined; requests still hop on an error but the key
      //         stays usable. Suited to RPM/TPM endpoints where a limit clears quickly.
      defaultEndpointKeyHealth: true,

      // Default endpoint creation settings (only affect new endpoints)
      defaultEndpointApiFormat: "openai",
      defaultEndpointTemperatureEnabled: true,
      defaultEndpointTemperature: 1,
      defaultEndpointTopPEnabled: true,
      defaultEndpointTopP: 1,
      defaultEndpointMaxTokensEnabled: false,
      defaultEndpointMaxTokens: 4096,
    };
  }

  _loadFromFile() {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) return {};
      const content = fs.readFileSync(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch (err) {
      console.error("[SettingsManager] Failed to load settings.json:", err.message);
      return {};
    }
  }

  _saveToFile() {
    try {
      fs.writeFileSync(
        SETTINGS_PATH,
        JSON.stringify(this._overrides, null, 2),
      );
    } catch (err) {
      console.error("[SettingsManager] Failed to save settings.json:", err.message);
      throw err;
    }
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
    this._saveToFile();
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
    this._saveToFile();
  }

  /**
   * Returns default prompt caching settings for new endpoints.
   */
  getDefaultPromptCaching() {
    return {
      enabled: this.get("defaultEndpointPromptCachingEnabled"),
      depth: this.get("defaultEndpointPromptCachingDepth"),
    };
  }

  /**
   * Returns the generation policy seeded onto endpoints without their own.
   */
  getDefaultGenerationDefaults() {
    const entry = (enabledKey, valueKey) => {
      const enabled = this.get(enabledKey);
      const value = this.get(valueKey);
      return { enabled, value: enabled && value !== null ? value : null };
    };
    return {
      temperature: entry("defaultEndpointTemperatureEnabled", "defaultEndpointTemperature"),
      top_p: entry("defaultEndpointTopPEnabled", "defaultEndpointTopP"),
      max_tokens: entry("defaultEndpointMaxTokensEnabled", "defaultEndpointMaxTokens"),
    };
  }

  reload() {
    this._loadDefaults();
    this._overrides = this._loadFromFile();
    console.log(
      "[SettingsManager] Reloaded from settings.json:",
      this._currentSettings(),
    );
  }
}

export default new SettingsManager();
