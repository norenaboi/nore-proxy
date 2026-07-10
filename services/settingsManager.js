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
   * Returns the default generationDefaults object for endpoints that do not
   * define their own and for which the client did not send a value.
   */
  getDefaultGenerationDefaults() {
    return {
      temperature: {
        enabled: this.get("defaultEndpointTemperatureEnabled"),
        value: this.get("defaultEndpointTemperature"),
      },
      top_p: {
        enabled: this.get("defaultEndpointTopPEnabled"),
        value: this.get("defaultEndpointTopP"),
      },
      max_tokens: {
        enabled: this.get("defaultEndpointMaxTokensEnabled"),
        value: this.get("defaultEndpointMaxTokens"),
      },
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
