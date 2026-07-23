/**
 * SettingsManager — runtime overrides for proxy settings.
 *
 * Defaults are hardcoded. Admin panel PUT updates persist to settings.json
 * and survive process restarts. No .env variables are used here.
 */

import fs from "fs";
import { getSettingsPath } from "../utils/configPaths.js";
import type { GenerationDefaults } from "../types/endpoint.js";
import type { Settings, SettingsUpdate } from "../types/settings.js";

class SettingsManager {
  private _defaults!: Settings;
  private _overrides: SettingsUpdate;

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
      // actionable code (401/402/403/429). 0 = no hop, 1 = retry once, N = up to N hops.
      keyHopAttempts: 1,
      // Hard upper bound for distinct concrete targets attempted by an auto model.
      autoModelMaxTargetAttempts: 3,
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

  _loadFromFile(): SettingsUpdate {
    try {
      const settingsPath = getSettingsPath();
      if (!fs.existsSync(settingsPath)) return {};
      const content = fs.readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as SettingsUpdate;
    } catch (err) {
      console.error(
        "[SettingsManager] Failed to load settings.json:",
        err instanceof Error ? err.message : String(err),
      );
      return {};
    }
  }

  _saveToFile() {
    try {
      fs.writeFileSync(
        getSettingsPath(),
        JSON.stringify(this._overrides, null, 2),
      );
    } catch (err) {
      console.error(
        "[SettingsManager] Failed to save settings.json:",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  _currentSettings(): Settings {
    return { ...this._defaults, ...this._overrides };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    if (!(key in this._defaults)) {
      throw Object.assign(new Error(`Unknown setting: "${key}"`), {
        statusCode: 400,
      });
    }
    return (key in this._overrides ? this._overrides[key] : this._defaults[key]) as Settings[K];
  }

  getAll(): Settings {
    return this._currentSettings();
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (!(key in this._defaults)) {
      throw Object.assign(new Error(`Unknown setting: "${key}"`), {
        statusCode: 400,
      });
    }
    (this._overrides as any)[key] = value;
    this._saveToFile();
  }

  update(updates: SettingsUpdate): void {
    for (const [key, value] of Object.entries(updates) as Array<[keyof Settings, Settings[keyof Settings]]>) {
      if (!(key in this._defaults)) {
        throw Object.assign(new Error(`Unknown setting: "${key}"`), {
          statusCode: 400,
        });
      }
      (this._overrides as any)[key] = value;
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
  getDefaultGenerationDefaults(): GenerationDefaults {
    const entry = (
      enabledKey:
        | "defaultEndpointTemperatureEnabled"
        | "defaultEndpointTopPEnabled"
        | "defaultEndpointMaxTokensEnabled",
      valueKey:
        | "defaultEndpointTemperature"
        | "defaultEndpointTopP"
        | "defaultEndpointMaxTokens",
    ) => {
      const enabled = this.get(enabledKey);
      const value = this.get(valueKey);
      return { enabled, value: enabled ? value : null };
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
