import cors from "cors";
import { env } from "../config/env";

/**
 * Creates a CORS middleware configured from environment variables.
 *
 * Configuration is read from the ALLOWED_ORIGINS environment variable,
 * which should be a comma-separated list of allowed origins
 * (e.g., "http://localhost:3000,https://app.revora.com").
 *
 * If ALLOWED_ORIGINS is not set, defaults to http://localhost:3000.
 *
 * @returns Configured Express CORS middleware
 *
 * @example
 * import express from 'express';
 * import { createCorsMiddleware } from './middleware/cors';
 *
 * const app = express();
 * app.use(createCorsMiddleware());
 */
export function createCorsMiddleware() {
  return cors({
    origin: env.ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
}
