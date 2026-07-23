export type ApiFormat =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-responses"
  | "openai-codex";

export type EndpointKey = `v${number}`;
export type KeyRotation = "sticky" | "roundrobin";

export interface GenerationDefault {
  enabled: boolean;
  value: number | null;
}

export interface GenerationDefaults {
  temperature: GenerationDefault;
  top_p: GenerationDefault;
  max_tokens: GenerationDefault;
}

export interface PromptCachingConfig {
  enabled: boolean;
  depth: number;
}

/** Persisted endpoint configuration in endpoints.json. */
export interface Endpoint {
  name?: string;
  url: string;
  tokens: string[];
  headers?: Record<string, string>;
  apiFormat?: ApiFormat;
  appendApiSuffix?: boolean;
  generationDefaults?: GenerationDefaults;
  /** Absent on legacy endpoints; null is used after loading to mean disabled. */
  promptCaching?: PromptCachingConfig | null;
  /** Null/absent defers to the global default. */
  keyRotation?: KeyRotation | null;
  /** Null/absent defers to the global default. */
  keyHealth?: boolean | null;
}

export type EndpointsDocument = Record<EndpointKey, Endpoint>;

/** Normalized configuration held by Config.ENDPOINTS. */
export interface LoadedEndpoint extends Omit<Endpoint, "name" | "headers" | "apiFormat" | "appendApiSuffix" | "generationDefaults" | "promptCaching"> {
  name: string;
  token: string;
  headers: Record<string, string>;
  apiFormat: ApiFormat;
  appendApiSuffix: boolean;
  generationDefaults: GenerationDefaults;
  promptCaching: PromptCachingConfig | null;
  keyRotation: KeyRotation | null;
  keyHealth: boolean | null;
}

export interface EndpointMetadata {
  url: string;
  targetModel: string;
  actualModel: string;
  endpointKey: EndpointKey;
  endpointName: string;
  customHeaders: Record<string, string>;
  apiFormat: ApiFormat;
  appendApiSuffix: boolean;
  generationDefaults: GenerationDefaults;
  promptCaching: PromptCachingConfig | null;
  keyRotation: KeyRotation | null;
  keyHealth: boolean | null;
}

/** A resolved endpoint with the selected upstream credential. */
export interface ResolvedEndpoint extends EndpointMetadata {
  token: string | null;
  tokenHash: string | null;
  tokenExhausted: boolean;
}

/** Endpoint shape returned to the admin UI; tokens are masked. */
export interface EndpointListItem {
  index: number;
  name: string;
  url: string;
  token?: string;
  tokens: string[];
  headers: Record<string, string>;
  apiFormat: ApiFormat;
  appendApiSuffix: boolean;
  generationDefaults: GenerationDefaults;
  promptCaching: PromptCachingConfig | null;
  keyRotation: KeyRotation | null;
  keyHealth: boolean | null;
}
