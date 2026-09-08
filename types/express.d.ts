declare global {
  namespace Express {
    interface Request {
      /** Validated bearer credential assigned by verifyApiKey middleware. */
      apiKey?: string;
      /** Stored hash of the API key signed in through the account session. */
      accountKeyHash?: string;
      /** Parsed by the server's dependency-free cookie middleware. */
      cookies?: Record<string, string>;
    }
  }
}

export {};
