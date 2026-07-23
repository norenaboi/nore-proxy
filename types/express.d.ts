declare global {
  namespace Express {
    interface Request {
      /** Validated bearer credential assigned by verifyApiKey middleware. */
      apiKey?: string;
      /** Parsed by the server's dependency-free cookie middleware. */
      cookies?: Record<string, string>;
    }
  }
}

export {};
