import cors from "cors";
import { env } from "../config/env";

/**
 * Creates a CORS middleware configured from environment variables.
 *
 * Tightened security behavior:
 * - Only allow explicit origins
 * - Default deny unknown origins
 * - Supports string[] from env
 * - Optional allow no origin
 *
 * ENV:
 * ALLOWED_ORIGINS = ["http://localhost:3000"]
 * CORS_ALLOW_NO_ORIGIN = true
 */
export function createCorsMiddleware() {
  const allowedOrigins: string[] =
    env.ALLOWED_ORIGINS ?? ["http://localhost:3000"];

  const allowNoOrigin =
    process.env.CORS_ALLOW_NO_ORIGIN === "true";

  if (
    process.env.NODE_ENV === "production" &&
    (!allowedOrigins || allowedOrigins.length === 0)
  ) {
    console.warn(
      "[security] ALLOWED_ORIGINS not set in production"
    );
  }

  return cors({
    origin(origin, callback) {
      // allow requests without origin (health / curl / internal)
      if (!origin) {
        if (allowNoOrigin) {
          return callback(null, true);
        }

        return callback(null, false);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },

    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-user-role"],
  });
}