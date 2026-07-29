/**
 * Fixture recording harness for KYC/AML provider adapters.
 *
 * Records redacted provider interaction traces once, then replays them
 * in CI without any live vendor keys or secrets.
 *
 * Workflow:
 * 1. Developer runs tests with RECORD_FIXTURES=true against live providers.
 * 2. The recorder captures request/response pairs and applies redaction.
 * 3. Redacted fixtures are written to disk as JSON.
 * 4. In CI (RECORD_FIXTURES unset or false), fixtures are loaded and
 *    replayed through the adapter's test harness instead of hitting
 *    live providers.
 *
 * Security:
 * - All fixture data passes through `redactObject` before persisting.
 * - Redaction is deterministic per RedactionContext so fixtures are stable.
 * - The recorder is a test-only utility and must never be imported into
 *   production code paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  redactObject,
  createRedactionContext,
  RedactionOptions,
  RedactionContext,
} from './redaction';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecordedRequest {
  /** HTTP method (GET, POST, etc.). */
  method: string;
  /** Full URL path (without base URL). */
  path: string;
  /** Request headers (will be redacted). */
  headers: Record<string, string>;
  /** Request body (will be redacted). */
  body?: unknown;
  /** ISO-8601 timestamp of the request. */
  timestamp: string;
}

export interface RecordedResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers (will be redacted). */
  headers: Record<string, string>;
  /** Response body (will be redacted). */
  body: unknown;
  /** ISO-8601 timestamp of the response. */
  timestamp: string;
}

export interface RecordedInteraction {
  /** Redacted request trace. */
  request: RecordedRequest;
  /** Redacted response trace. */
  response: RecordedResponse;
  /** Human-readable label (e.g., "kyc_check_success"). */
  label: string;
}

export interface FixtureFile {
  /** Provider identifier (e.g., "sumsub", "jumio", "onfido"). */
  provider: string;
  /** Fixture version for schema evolution. */
  version: 1;
  /** ISO-8601 timestamp of recording. */
  recordedAt: string;
  /** All recorded interactions. */
  interactions: RecordedInteraction[];
  /** Redaction metadata for audit. */
  redaction: {
    totalRedactions: number;
    placeholderCount: number;
  };
}

export interface RecorderOptions {
  /** Base directory for fixture files. Defaults to ./fixtures */
  fixtureDir: string;
  /** Provider identifier. */
  provider: string;
  /** Additional redaction rules. */
  redactionOptions?: RedactionOptions;
}

// ── Recorder ─────────────────────────────────────────────────────────────────

/**
 * Records provider interactions with automatic PII redaction.
 *
 * Usage:
 * ```ts
 * const recorder = createRecorder({ fixtureDir: './fixtures', provider: 'sumsub' });
 * await recorder.record('kyc_check_success', request, response);
 * await recorder.flush(); // writes fixture file
 * ```
 */
export function createRecorder(options: RecorderOptions) {
  const { fixtureDir, provider, redactionOptions } = options;
  const ctx = createRedactionContext();
  const interactions: RecordedInteraction[] = [];
  let totalRedactions = 0;

  function redact<T>(obj: T): T {
    const before = JSON.stringify(obj);
    const result = redactObject(obj, ctx, redactionOptions);
    const after = JSON.stringify(result);
    // Count approximate redaction count by comparing length changes
    if (before !== after) totalRedactions++;
    return result;
  }

  return {
    /**
     * Record a single request/response interaction.
     */
    record(
      label: string,
      req: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      },
      res: {
        status: number;
        headers: Record<string, string>;
        body: unknown;
      },
    ): void {
      interactions.push({
        request: redact({
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body,
          timestamp: new Date().toISOString(),
        }),
        response: redact({
          status: res.status,
          headers: res.headers,
          body: res.body,
          timestamp: new Date().toISOString(),
        }),
        label,
      });
    },

    /**
     * Write all recorded interactions to a fixture file.
     */
    async flush(): Promise<string> {
      const fixture: FixtureFile = {
        provider,
        version: 1,
        recordedAt: new Date().toISOString(),
        interactions,
        redaction: {
          totalRedactions,
          placeholderCount: ctx.privateValues.size,
        },
      };

      await fs.promises.mkdir(fixtureDir, { recursive: true });
      const filePath = path.join(fixtureDir, `${provider}.fixtures.json`);
      await fs.promises.writeFile(filePath, JSON.stringify(fixture, null, 2));
      return filePath;
    },

    /**
     * Get the redaction context (useful for tests).
     */
    getRedactionContext(): RedactionContext {
      return ctx;
    },

    /**
     * Get recorded interactions count.
     */
    getCount(): number {
      return interactions.length;
    },
  };
}

// ── Fixture loader ───────────────────────────────────────────────────────────

/**
 * Load a previously recorded fixture file.
 */
export async function loadFixtures(
  fixtureDir: string,
  provider: string,
): Promise<FixtureFile> {
  const filePath = path.join(fixtureDir, `${provider}.fixtures.json`);
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return JSON.parse(content) as FixtureFile;
}

/**
 * Check if a fixture file exists for the given provider.
 */
export async function hasFixtures(
  fixtureDir: string,
  provider: string,
): Promise<boolean> {
  try {
    const filePath = path.join(fixtureDir, `${provider}.fixtures.json`);
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine if the test environment should record new fixtures
 * or replay existing ones.
 */
export function shouldRecord(): boolean {
  return process.env.RECORD_FIXTURES === 'true';
}

export const __test = {
  createRecorder,
  loadFixtures,
  hasFixtures,
  shouldRecord,
};
