import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

class Config {
  static LOG_DIR = path.join(__dirname, "..", "logs");

  static PORT = parseInt(process.env.PORT || 8741);

  static REQUEST_TIMEOUT_SECONDS = 180;
  static CLEANUP_INTERVAL = 300;

  static MAX_LOG_MEMORY_ITEMS = 1000;
  static MAX_REQUEST_DETAILS = 500;

  static MASTER_KEY = (() => {
    const key = process.env.MASTER_KEY;
    if (!key || key.trim().length < 16) {
      console.error(
        "FATAL: MASTER_KEY environment variable is not set or is too short (minimum 16 characters). " +
          "Set it before starting the server.",
      );
      process.exit(1);
    }
    return key;
  })();
  static RPD_DEFAULT = parseInt(process.env.RPD_DEFAULT || "500", 10);
  static RPM_DEFAULT = parseInt(process.env.RPM_DEFAULT || "10", 10);
  static MAX_CONTEXT_SIZE_DEFAULT = parseInt(
    process.env.MAX_CONTEXT_SIZE_DEFAULT || "0",
    10,
  );

  static ENDPOINTS = {};

  // In-memory round-robin counters keyed by endpoint index string (e.g. "1", "2")
  static _rrCounters = {};

  static loadEndpoints() {
    this.ENDPOINTS = {};
    this._rrCounters = {};

    const endpointsPath = path.join(__dirname, "..", "endpoints.txt");

    if (!fs.existsSync(endpointsPath)) {
      console.log("endpoints.txt not found, no endpoints loaded");
      return this.ENDPOINTS;
    }

    const content = fs.readFileSync(endpointsPath, "utf-8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    const urlMap = {};
    // tokensMap stores an array of tokens per index
    const tokensMap = {};
    const headersMap = {};

    for (const line of lines) {
      const urlMatch = line.match(/^V(\d+)_URL=(.+)$/);
      const tokenMatch = line.match(/^V(\d+)_TOKEN=(.+)$/);
      // V{n}_TOKENS is comma-separated; takes precedence over V{n}_TOKEN
      const tokensMatch = line.match(/^V(\d+)_TOKENS=(.+)$/);
      const headersMatch = line.match(/^V(\d+)_HEADERS=(.+)$/);

      if (urlMatch) {
        urlMap[urlMatch[1]] = urlMatch[2];
      } else if (tokensMatch) {
        // TOKENS line: split on comma, trim each, filter empties
        tokensMap[tokensMatch[1]] = tokensMatch[2]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      } else if (tokenMatch) {
        // Legacy single-token line — only set if TOKENS hasn't been set yet
        if (!tokensMap[tokenMatch[1]]) {
          tokensMap[tokenMatch[1]] = [tokenMatch[2]];
        }
      } else if (headersMatch) {
        headersMap[headersMatch[1]] = headersMatch[2];
      }
    }

    for (const index of Object.keys(urlMap)) {
      const tokens = tokensMap[index];
      if (tokens && tokens.length > 0) {
        let headers = {};
        if (headersMap[index]) {
          try {
            headers = JSON.parse(headersMap[index]);
          } catch (e) {
            console.warn(
              `Warning: Invalid JSON in V${index}_HEADERS — falling back to {}. Error: ${e.message}`,
            );
            headers = {};
          }
        }

        this.ENDPOINTS[`v${index}`] = {
          url: urlMap[index],
          // Keep single `token` field for backward compat (first token)
          token: tokens[0],
          tokens,
          headers,
        };
        this._rrCounters[index] = 0;
      }
    }

    return this.ENDPOINTS;
  }

  /**
   * Returns the next token for a given endpoint index using round-robin.
   * Falls back to the first (and only) token if there's just one.
   * @param {string} endpointKey - e.g. "v1"
   * @returns {string} The token to use for this request
   */
  static getNextToken(endpointKey) {
    const endpoint = this.ENDPOINTS[endpointKey];
    if (!endpoint) return null;

    const tokens = endpoint.tokens;
    if (!tokens || tokens.length <= 1) return endpoint.token;

    // Extract numeric index from key (e.g. "v1" → "1")
    const idx = endpointKey.replace(/^v/, "");
    const counter = this._rrCounters[idx] || 0;
    const token = tokens[counter % tokens.length];
    this._rrCounters[idx] = (counter + 1) % tokens.length;
    return token;
  }

  static reload() {
    dotenv.config({ override: true });
    const key = process.env.MASTER_KEY;
    if (!key || key.trim().length < 16) {
      console.error("FATAL: MASTER_KEY is not set or too short after reload.");
      process.exit(1);
    }
    this.MASTER_KEY = key;
    this.RPD_DEFAULT = parseInt(process.env.RPD_DEFAULT || "500", 10);
    this.RPM_DEFAULT = parseInt(process.env.RPM_DEFAULT || "10", 10);
    this.MAX_CONTEXT_SIZE_DEFAULT = parseInt(
      process.env.MAX_CONTEXT_SIZE_DEFAULT || "0",
      10,
    );
    this.loadEndpoints();
  }
}

export default Config;
