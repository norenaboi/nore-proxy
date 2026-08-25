import Config from "../config/index.js";

interface ActiveRequest {
  start_time: number;
  /** Unix seconds at which the client saw the first response byte. Streams only. */
  first_token_time?: number;
  model?: string;
  params?: unknown;
  request_context?: Record<string, unknown> | null;
  [key: string]: unknown;
}

class RealtimeStats {
  activeRequests: Map<string, ActiveRequest>;

  constructor() {
    this.activeRequests = new Map();
  }

  /**
   * Stamp the instant the first byte of a streaming response reached the client.
   * The first call wins, so every later chunk of the same stream is a no-op, and
   * a request that has already finished is ignored.
   */
  markFirstToken(requestId: string) {
    const request = this.activeRequests.get(requestId);
    if (request && request.first_token_time === undefined) {
      request.first_token_time = Date.now() / 1000;
    }
  }

  cleanupOldRequests() {
    const currentTime = Date.now() / 1000;
    const timeoutRequests = [];

    for (const [reqId, req] of this.activeRequests) {
      if (currentTime - req.start_time > Config.REQUEST_TIMEOUT_SECONDS) {
        timeoutRequests.push(reqId);
      }
    }

    for (const reqId of timeoutRequests) {
      console.warn(`Warning: Request timeout - ${reqId}`);
      this.activeRequests.delete(reqId);
    }
  }
}

const realtimeStats = new RealtimeStats();
export default realtimeStats;
