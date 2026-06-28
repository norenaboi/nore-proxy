import Config from "../config/index.js";

class RealtimeStats {
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
