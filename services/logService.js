import { EventEmitter } from "events";

class LogService extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.maxLogs = 1000; // Keep last 1000 logs in memory
    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };

    this.interceptConsole();
  }

  interceptConsole() {
    const self = this;

    console.log = function (...args) {
      self.addLog("info", args);
      self.originalConsole.log.apply(console, args);
    };

    console.error = function (...args) {
      self.addLog("error", args);
      self.originalConsole.error.apply(console, args);
    };

    console.warn = function (...args) {
      self.addLog("warn", args);
      self.originalConsole.warn.apply(console, args);
    };

    console.info = function (...args) {
      self.addLog("info", args);
      self.originalConsole.info.apply(console, args);
    };
  }

  addLog(level, args) {
    const message = args
      .map((arg) => {
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg, null, 2);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    this.logs.push(logEntry);

    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Emit the log to all SSE clients
    this.emit("log", logEntry);
  }

  getLogs(limit = 100) {
    return this.logs.slice(-limit);
  }

  clearLogs() {
    this.logs = [];
  }
}

const logService = new LogService();

export default logService;
