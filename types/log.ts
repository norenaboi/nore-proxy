export type RequestLogStatus = "active" | "success" | "failed" | "unknown";
export type RequestLogType = "request_start" | "request_end";

export interface RequestContext {
  client_ip?: string | null;
  protocol?: string | null;
  method?: string | null;
  path?: string | null;
  streaming?: boolean | null;
  params?: Record<string, unknown> | null;
}

export interface BillingCosts {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  total: number;
}

export interface BillingData {
  accounting_version: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  pricing_per_million: Record<string, number>;
  costs: BillingCosts;
}

export interface RoutingAttempt {
  targetModel: string | null;
  endpointKey: string | null;
  endpointName: string | null;
  tokenHash: string | null;
  targetAttempt: number | null;
  keyAttempt: number | null;
  outcome: string | null;
  retryReason: string | null;
  statusCode?: number | null;
}

export interface RequestLogEntry {
  type: RequestLogType;
  timestamp?: string | number;
  request_id?: string;
  model?: string;
  status?: RequestLogStatus;
  duration?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_write_tokens?: number;
  cache_read_tokens?: number;
  token_accounting_version?: string;
  request_context?: RequestContext | null;
  billing?: BillingData;
  error?: string | null;
  key_name?: string | null;
  api_key_id?: string | null;
  api_key?: string | null;
  api_key_masked?: string | null;
  requested_model?: string | null;
  auto_model?: string | null;
  target_model?: string | null;
  upstream_model?: string | null;
  endpoint_key?: string | null;
  endpoint_name?: string | null;
  api_format?: string | null;
  upstream_url?: string | null;
  masked_upstream_key?: string | null;
  upstream_status?: number | null;
  proxy_status?: number | null;
  routing_attempt_count?: number;
  routing_attempts?: RoutingAttempt[];
  [key: string]: unknown;
}

export interface ErrorLogContext {
  timestamp?: string | number;
  model?: string | null;
  upstreamModel?: string | null;
  endpointKey?: string | null;
  endpointName?: string | null;
  apiFormat?: string | null;
  maskedApiKey?: string | null;
  autoModel?: string | null;
  targetModel?: string | null;
  routingAttempts?: RoutingAttempt[] | null;
  statusCode?: number | null;
  errorCode?: string | number | null;
  requestHeaders?: Record<string, unknown> | null;
  upstreamUrl?: string | null;
  responseBody?: unknown;
}

/** Supports the camelCase runtime call shape and snake_case persistence aliases. */
export interface ErrorLogEntry extends ErrorLogContext {
  requestId?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  stackTrace?: string | null;
  request_id?: string | null;
  upstream_model?: string | null;
  endpoint_key?: string | null;
  endpoint_name?: string | null;
  api_format?: string | null;
  status_code?: number | string | null;
  error_type?: string | null;
  error_code?: string | number | null;
  error_message?: string | null;
  request_headers?: Record<string, unknown> | null;
  upstream_url?: string | null;
  response_body?: unknown;
  stack_trace?: string | null;
  masked_api_key?: string | null;
  auto_model?: string | null;
  target_model?: string | null;
  routing_attempts?: RoutingAttempt[] | null;
}

export interface ErrorLogRecord {
  id: number;
  timestamp: string;
  requestId: string | null;
  model: string | null;
  upstreamModel: string | null;
  endpointKey: string | null;
  endpointName: string | null;
  apiFormat: string | null;
  statusCode: number | null;
  errorType: string | null;
  errorCode: string | number | null;
  errorMessage: string | null;
  requestParams: unknown;
  requestHeaders: unknown;
  upstreamUrl: string | null;
  responseBody: unknown;
  stackTrace: string | null;
  maskedApiKey: string | null;
  autoModel: string | null;
  targetModel: string | null;
  routingAttempts: RoutingAttempt[] | unknown | null;
}

export interface RequestLogFilters {
  cursor?: number | string | null;
  limit?: number;
  model?: string | null;
  apiKey?: string | null;
  apiKeyMask?: string | null;
  legacyMask?: string | null;
  status?: Extract<RequestLogStatus, "success" | "failed"> | null;
  endpoint?: string | null;
  from?: number | null;
  to?: number | null;
}

export interface ErrorLogFilters {
  limit?: number;
  offset?: number;
  model?: string | null;
  endpoint?: string | null;
  key?: string | null;
  statusCode?: number | string | null;
}

export interface RequestLogSummary {
  id: number;
  timestamp: number | null;
  requestId: string | null;
  name: string;
  apiKey: string;
  apiKeyId: string | null;
  legacyKey: boolean;
  model: string;
  status: Extract<RequestLogStatus, "success" | "failed" | "unknown">;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  tokenAccountingVersion: string | null;
  duration: number;
  endpointKey: string | null;
  endpointName: string | null;
  recordedCost: number | null;
}

export interface RequestHistory {
  requests: RequestLogSummary[];
  hasMore: boolean;
  nextCursor: number | null;
}

export interface LogFiltersResponse {
  models: string[];
  apiKeys?: Array<{ value: string; label: string }>;
  endpoints?: string[];
  statuses: Array<string | number>;
  keys?: string[];
}
