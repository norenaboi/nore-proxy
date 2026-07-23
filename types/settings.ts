import type { ApiFormat, GenerationDefaults, KeyRotation, PromptCachingConfig } from "./endpoint.js";

export interface Settings {
  rpdDefault: number;
  rpmDefault: number;
  maxContextSizeDefault: number;
  defaultEndpointPromptCachingEnabled: boolean;
  defaultEndpointPromptCachingDepth: number;
  keyHopAttempts: number;
  autoModelMaxTargetAttempts: number;
  keyTimeoutHours: number;
  defaultEndpointKeyRotation: KeyRotation;
  defaultEndpointKeyHealth: boolean;
  defaultEndpointApiFormat: ApiFormat;
  defaultEndpointTemperatureEnabled: boolean;
  defaultEndpointTemperature: number;
  defaultEndpointTopPEnabled: boolean;
  defaultEndpointTopP: number;
  defaultEndpointMaxTokensEnabled: boolean;
  defaultEndpointMaxTokens: number;
}

export type SettingsUpdate = Partial<Settings>;

export interface SettingsManager {
  get<K extends keyof Settings>(key: K): Settings[K];
  getAll(): Settings;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  update(updates: SettingsUpdate): void;
  getDefaultPromptCaching(): PromptCachingConfig;
  getDefaultGenerationDefaults(): GenerationDefaults;
  reload(): void;
}

export interface SettingsResponse {
  settings: Settings;
}
