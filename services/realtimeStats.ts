import Config from "../config/index.js";

interface ActiveRequest {
  start_time: number;
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
