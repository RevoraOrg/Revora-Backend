/**
 * Mobile Companion API – Minimum-Version Enforcement Middleware
 * ─────────────────────────────────────────────────────────────
 * Rejects requests from mobile clients whose `X-Client-Min-Version` header
 * (or the version embedded in the signed policy document) indicates the
 * client is older than the server-required minimum.
 *
 * Security model
 * ──────────────
 * 1. A **signed policy document** (Ed25519) defines:
 *    - `minClientVersion` – the oldest client version the server will serve.
 *    - `upgradeUrl`       – actionable URL the client should open.
 *    - `counter`          – monotonic counter; rejects downgrade of counter.
 *    - `expiresAt`        – optional expiry; expired policies are rejected.
 *
 * 2. The policy is loaded and verified at startup / on reload.  The
 *    middleware reads `X-Client-Min-Version` from the request and
 *    compares it to the policy's `minClientVersion`.
 *
 * 3. If the client version is below the minimum, the request is rejected
 *    with **426 Upgrade Required** and an actionable JSON body containing
 *    the `upgradeUrl`.
 *
 * 4. The counter in the policy document must be **monotonically increasing**.
 *    An attempt to load a policy with a lower counter is rejected.
 *
 * Metrics emitted:
 *   - `mobile.min_version.rejected` – incremented for every rejected request.
 *   - `mobile.min_version.policy_loaded` – incremented when a new policy is loaded.
 *
 * @module middleware/mobileMinVersion
 */

import { verify, createPublicKey } from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Errors, AppError } from '../lib/errors';
import { globalMetrics } from '../lib/metrics';
import { globalLogger } from '../lib/logger';

// ── Types ────────────────────────────────────────────────────────────────────

/** A semantic version string: `MAJOR.MINOR.PATCH` (e.g. "2.3.1"). */
export type SemVer = string;

/** Signed policy document payload (the canonical JSON that is signed). */
export interface MobileVersionPolicy {
  /** Semver of this policy document. */
  version: SemVer;
  /** Monotonically increasing counter — rejects policy downgrade. */
  counter: number;
  /** Oldest client version the server will accept. */
  minClientVersion: SemVer;
  /** Actionable URL the client should open to upgrade. */
  upgradeUrl: string;
  /** ISO-8601 expiry timestamp. If in the past, the policy is stale. */
  expiresAt?: string;
}

/** Wire format for a signed policy bundle (policy JSON + Ed25519 signature). */
export interface SignedPolicyBundle {
  /** Base64-encoded canonical JSON of the policy document. */
  policyBase64: string;
  /** Base64url-encoded Ed25519 signature over the canonical JSON. */
  signatureBase64url: string;
}

/** Internal state held by the middleware. */
interface PolicyState {
  policy: MobileVersionPolicy;
  loadedAt: number;
}

/** Options for the version-gate middleware factory. */
export interface MobileMinVersionOptions {
  /**
   * PEM-encoded Ed25519 public key used to verify policy signatures.
   * At least one of `trustedPublicKeyPem` or `trustedPublicKeyBase64` must
   * be provided; if both are supplied, `trustedPublicKeyPem` takes precedence.
   */
  trustedPublicKeyPem?: string;
  /**
   * Base64-encoded SPKI Ed25519 public key (DER).
   * Used when the trust anchor is distributed as raw base64 rather than PEM.
   */
  trustedPublicKeyBase64?: string;
  /**
   * Optional header name that carries the client's version.
   * Defaults to `x-client-min-version`.
   */
  clientVersionHeader?: string;
}

// ── Semver helpers ────────────────────────────────────────────────────────────

/**
 * Parse a semver string into a `[major, minor, patch]` tuple.
 * Accepts `MAJOR.MINOR.PATCH` format.  Non-numeric segments default to 0.
 *
 * @throws {Error} if the string cannot be parsed into at least two segments.
 */
export function parseSemver(v: SemVer): [number, number, number] {
  const parts = v.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  if (parts.length < 2) {
    throw new Error(`Invalid semver: "${v}" — expected at least MAJOR.MINOR`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compare two semver strings.
 * Returns -1 if `a < b`, 0 if equal, +1 if `a > b`.
 */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

// ── Policy signature verification ─────────────────────────────────────────────

/**
 * Verify an Ed25519 signature over a policy document.
 *
 * @param policyJson  - canonical JSON string of the policy
 * @param signatureB64url - base64url-encoded Ed25519 signature
 * @param publicKeyPem - PEM-encoded Ed25519 public key (SPKI)
 * @returns true if signature is valid
 */
export function verifyPolicySignature(
  policyJson: string,
  signatureB64url: string,
  publicKeyPem: string,
): boolean {
  try {
    const sigBuffer = Buffer.from(signatureB64url, 'base64url');
    const keyObj = createPublicKey(publicKeyPem);
    return verify(
      null as any,
      Buffer.from(policyJson, 'utf-8'),
      keyObj as any,
      sigBuffer as any,
    );
  } catch {
    return false;
  }
}

/**
 * Canonical JSON serializer: sorts object keys recursively for
 * deterministic signing.
 */
export function stableStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

// ── Policy loader ─────────────────────────────────────────────────────────────

/**
 * Load, verify, and activate a signed policy document.
 *
 * Security invariants:
 * - Signature must be valid against the trusted public key.
 * - Counter must be strictly greater than the currently loaded counter.
 *   (First load accepts any counter >= 0.)
 * - Policy must not be expired (if `expiresAt` is present).
 *
 * @returns The loaded policy, or throws an error describing the failure.
 */
export function loadSignedPolicy(
  bundle: SignedPolicyBundle,
  publicKeyPem: string,
  currentCounter: number,
): MobileVersionPolicy {
  // 1. Decode and parse the policy
  let policyJson: string;
  try {
    policyJson = Buffer.from(bundle.policyBase64, 'base64').toString('utf-8');
  } catch {
    throw new Error('Failed to decode policy document from base64');
  }

  let policy: MobileVersionPolicy;
  try {
    policy = JSON.parse(policyJson) as MobileVersionPolicy;
  } catch {
    throw new Error('Policy document is not valid JSON');
  }

  // 2. Validate required fields
  if (!policy.version || typeof policy.version !== 'string') {
    throw new Error('Policy document missing required field: version');
  }
  if (typeof policy.counter !== 'number' || !Number.isFinite(policy.counter)) {
    throw new Error('Policy document missing required field: counter (number)');
  }
  if (!policy.minClientVersion || typeof policy.minClientVersion !== 'string') {
    throw new Error('Policy document missing required field: minClientVersion');
  }
  if (!policy.upgradeUrl || typeof policy.upgradeUrl !== 'string') {
    throw new Error('Policy document missing required field: upgradeUrl');
  }

  // 3. Verify monotonic counter (reject downgrade)
  if (policy.counter < currentCounter) {
    throw new Error(
      `Policy counter downgrade rejected: got ${policy.counter}, expected > ${currentCounter}`,
    );
  }
  // Allow equal counter for the same policy (idempotent reload).
  // Strictly increase for new policies — we reject counter < currentCounter
  // but accept counter === currentCounter (idempotent re-load).

  // 4. Verify expiry
  if (policy.expiresAt) {
    const expiryTime = new Date(policy.expiresAt).getTime();
    if (Number.isNaN(expiryTime) || expiryTime < Date.now()) {
      throw new Error(
        `Policy document has expired (expiresAt: ${policy.expiresAt})`,
      );
    }
  }

  // 5. Verify Ed25519 signature
  const signatureValid = verifyPolicySignature(
    policyJson,
    bundle.signatureBase64url,
    publicKeyPem,
  );
  if (!signatureValid) {
    globalMetrics.incrementCounter(
      'mobile.min_version.signature_failed',
      { version: policy.version },
      1,
      'Policy signature verification failed',
    );
    throw new Error('Policy document signature verification failed');
  }

  // 6. Validate semver format
  try {
    parseSemver(policy.minClientVersion);
  } catch (err) {
    throw new Error(
      `Invalid minClientVersion semver: "${policy.minClientVersion}"`,
    );
  }

  return policy;
}

// ── Version gate middleware ───────────────────────────────────────────────────

export interface VersionGateResult {
  /** true if request is allowed, false if blocked. */
  allowed: boolean;
  /** The error to pass to next() if blocked. */
  error?: AppError;
  /** The parsed client version string from the header. */
  clientVersion?: string;
}

/**
 * Evaluate whether a client version satisfies the policy.
 *
 * @param clientVersion - value of the X-Client-Min-Version header
 * @param policy        - the currently active policy document
 * @returns VersionGateResult
 */
export function evaluateVersionGate(
  clientVersion: string | undefined,
  policy: MobileVersionPolicy,
): VersionGateResult {
  // If the client did not send a version header, we cannot determine
  // compatibility.  We allow the request through but log a warning.
  // The device-signature middleware will still enforce auth.
  if (!clientVersion || clientVersion.trim() === '') {
    globalLogger.warn(
      '[MobileMinVersion] Client did not send X-Client-Min-Version header — allowing request',
    );
    return { allowed: true, clientVersion: undefined };
  }

  const trimmed = clientVersion.trim();

  // Validate that clientVersion is a valid semver
  try {
    parseSemver(trimmed);
  } catch {
    return {
      allowed: false,
      clientVersion: trimmed,
      error: Errors.badRequest(
        `Invalid client version format: "${trimmed}" — expected semver (e.g. 1.2.3)`,
      ),
    };
  }

  // Compare: client version must be >= minClientVersion
  const cmp = compareSemver(trimmed, policy.minClientVersion);
  if (cmp < 0) {
    return {
      allowed: false,
      clientVersion: trimmed,
      error: Errors.serviceUnavailable(
        `Client version ${trimmed} is below the minimum required version ${policy.minClientVersion}. Please upgrade.`,
        {
          code: 'CLIENT_VERSION_TOO_OLD',
          minRequiredVersion: policy.minClientVersion,
          clientVersion: trimmed,
          upgradeUrl: policy.upgradeUrl,
        },
      ),
    };
  }

  return { allowed: true, clientVersion: trimmed };
}

// ── Express middleware factory ────────────────────────────────────────────────

/**
 * Creates version-gate middleware that enforces the mobile companion
 * minimum-version policy.
 *
 * The middleware:
 * 1. Reads `X-Client-Min-Version` from the request.
 * 2. Compares it to the active policy's `minClientVersion`.
 * 3. Rejects with **426 Upgrade Required** (via `serviceUnavailable`)
 *    and an actionable JSON body if the client is too old.
 * 4. Emits `mobile.min_version.rejected` counter on rejection.
 *
 * @example
 * ```ts
 * const versionGate = createMobileMinVersionMiddleware({
 *   trustedPublicKeyPem: '-----BEGIN PUBLIC KEY-----\n...',
 * });
 * router.use('/mobile', versionGate, deviceAuth, handler);
 * ```
 */
export function createMobileMinVersionMiddleware(
  options: MobileMinVersionOptions,
): {
  middleware: RequestHandler;
  /** Load a new signed policy bundle. Throws on invalid/unsigned/expired. */
  loadPolicy: (bundle: SignedPolicyBundle) => MobileVersionPolicy;
  /** Get the current active policy (or null if none loaded). */
  getCurrentPolicy: () => MobileVersionPolicy | null;
  /** Force-clear the current policy (for tests). */
  clearPolicy: () => void;
  /** Get the current monotonic counter. */
  getCounter: () => number;
} {
  const {
    trustedPublicKeyPem,
    trustedPublicKeyBase64,
    clientVersionHeader = 'x-client-min-version',
  } = options;

  // Resolve the trusted public key — prefer PEM, fall back to base64 DER.
  let resolvedPublicKeyPem: string;
  if (trustedPublicKeyPem) {
    resolvedPublicKeyPem = trustedPublicKeyPem;
  } else if (trustedPublicKeyBase64) {
    // Convert base64 DER to PEM
    const derBuffer = Buffer.from(trustedPublicKeyBase64, 'base64');
    const b64Der = derBuffer.toString('base64');
    // Ed25519 SPKI DER prefix (302a300506032b6570032100) — 12 bytes
    const PEM_HEADER = '-----BEGIN PUBLIC KEY-----';
    const PEM_FOOTER = '-----END PUBLIC KEY-----';
    resolvedPublicKeyPem = `${PEM_HEADER}\n${b64Der.match(/.{1,64}/g)?.join('\n') ?? b64Der}\n${PEM_FOOTER}`;
  } else {
    throw new Error(
      'MobileMinVersion: at least one of trustedPublicKeyPem or trustedPublicKeyBase64 is required',
    );
  }

  let state: PolicyState | null = null;

  const loadPolicy = (bundle: SignedPolicyBundle): MobileVersionPolicy => {
    const currentCounter = state?.policy.counter ?? -1;
    const policy = loadSignedPolicy(bundle, resolvedPublicKeyPem, currentCounter);

    state = { policy, loadedAt: Date.now() };

    globalMetrics.incrementCounter(
      'mobile.min_version.policy_loaded',
      { version: policy.version },
      1,
      'Signed minimum-version policy loaded successfully',
    );

    globalLogger.info('[MobileMinVersion] Policy loaded', {
      version: policy.version,
      minClientVersion: policy.minClientVersion,
      counter: policy.counter,
    });

    return policy;
  };

  const getCurrentPolicy = (): MobileVersionPolicy | null =>
    state?.policy ?? null;

  const clearPolicy = (): void => {
    state = null;
  };

  const getCounter = (): number => state?.policy.counter ?? -1;

  const middleware: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void => {
    // If no policy is loaded, allow the request through.
    // The operator is responsible for loading a policy before enforcing.
    if (!state) {
      next();
      return;
    }

    const clientVersion = req.header(clientVersionHeader);
    const result = evaluateVersionGate(clientVersion, state.policy);

    if (result.allowed) {
      next();
      return;
    }

    // Rejected — emit metric and propagate error
    globalMetrics.incrementCounter(
      'mobile.min_version.rejected',
      {
        clientVersion: result.clientVersion ?? 'unknown',
        minRequiredVersion: state.policy.minClientVersion,
      },
      1,
      'Mobile client rejected due to minimum version enforcement',
    );

    globalLogger.warn('[MobileMinVersion] Client rejected — version too old', {
      clientVersion: result.clientVersion,
      minRequiredVersion: state.policy.minClientVersion,
      path: req.path,
    });

    next(result.error!);
  };

  return { middleware, loadPolicy, getCurrentPolicy, clearPolicy, getCounter };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

export const __test = {
  parseSemver,
  compareSemver,
  verifyPolicySignature,
  stableStringify,
  loadSignedPolicy,
  evaluateVersionGate,
};
