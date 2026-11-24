import crypto from 'crypto';
import { KycProvider } from './KycProvider';

export interface RouteTableEntry {
  jurisdiction: string; // ISO 3166-1 alpha-2 e.g. 'US', 'EU'
  providerName: string;
}

export interface RouteTable {
  version: string;
  entries: RouteTableEntry[];
  signature: string; // HMAC of version + entries using a secret key
}

export interface LoadRouteTableOptions {
  /**
   * If true, permits loading a route table whose version is equal to or older
   * than the currently active route table version. Defaults to false.
   */
  allowDowngrade?: boolean;
}

export interface ParsedVersion {
  numbers: number[];
  prerelease?: string[];
}

/**
 * Route table version format:
 * Route table versions follow standard numeric / Semantic Versioning (SemVer 2.0.0):
 *   [v|V]?<major>[.<minor>[.<patch>[.<build>...]]][-<prerelease>]
 *
 * Supported formats:
 * - Simple integer (e.g. "1", "2", "42")
 * - Two-part numeric (e.g. "1.0", "1.1", "2026.09")
 * - Semantic Versioning (e.g. "1.0.0", "1.2.3", "2.1.0-alpha.1")
 * - Date/calendar versioning (e.g. "2026.10-regression")
 *
 * Comparison rules:
 * - Numeric segments are compared numerically from left to right (e.g. 10 > 2, so 1.10.0 > 1.2.0).
 * - Shorter numeric versions are zero-padded to match lengths (e.g. "1.0" is equal in precedence to "1.0.0").
 * - A normal release has higher precedence than a pre-release version with the same numeric components
 *   (e.g. "1.0.0" > "1.0.0-rc.1").
 * - Pre-release segments are compared segment-by-segment: numeric segments numerically, others lexicographically.
 * - Build metadata (+...) is stripped and ignored for precedence.
 */
export function parseVersion(versionStr: string): ParsedVersion {
  if (typeof versionStr !== 'string') {
    throw new Error(`Invalid version format: expected string, got ${typeof versionStr}`);
  }
  const trimmed = versionStr.trim();
  if (!trimmed) {
    throw new Error('Invalid version format: version cannot be empty');
  }

  // Remove optional leading 'v' or 'V'
  const cleanStr = trimmed.replace(/^v/i, '');

  // Strip build metadata (+...)
  const withoutBuild = cleanStr.split('+')[0];

  // Split numeric segments from pre-release segments (-...)
  const parts = withoutBuild.split('-');
  const numericPart = parts[0];
  const prereleasePart = parts.slice(1).join('-');

  const segments = numericPart.split('.');
  if (segments.length === 0 || segments.some(s => s === '' || !/^\d+$/.test(s))) {
    throw new Error(`Invalid version format: "${versionStr}". Must start with dot-separated numbers.`);
  }

  const numbers = segments.map(s => parseInt(s, 10));
  const prerelease = prereleasePart
    ? prereleasePart.split('.').filter(Boolean)
    : undefined;

  return { numbers, prerelease };
}

/**
 * Compares two version strings according to SemVer and numeric precedence rules.
 *
 * @returns
 *  - > 0 if v1 is newer than v2 (upgrade)
 *  - 0 if v1 is equal to v2
 *  - < 0 if v1 is older than v2 (downgrade)
 */
export function compareVersions(v1: string, v2: string): number {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);

  const maxLen = Math.max(p1.numbers.length, p2.numbers.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1.numbers[i] ?? 0;
    const num2 = p2.numbers[i] ?? 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  // Pre-release precedence: normal release > pre-release
  if (!p1.prerelease && p2.prerelease) return 1;
  if (p1.prerelease && !p2.prerelease) return -1;
  if (!p1.prerelease && !p2.prerelease) return 0;

  const pre1 = p1.prerelease!;
  const pre2 = p2.prerelease!;
  const maxPreLen = Math.max(pre1.length, pre2.length);
  for (let i = 0; i < maxPreLen; i++) {
    if (pre1[i] === undefined) return -1;
    if (pre2[i] === undefined) return 1;
    if (pre1[i] === pre2[i]) continue;

    const isNum1 = /^\d+$/.test(pre1[i]);
    const isNum2 = /^\d+$/.test(pre2[i]);
    if (isNum1 && isNum2) {
      const n1 = parseInt(pre1[i], 10);
      const n2 = parseInt(pre2[i], 10);
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    } else if (isNum1 && !isNum2) {
      return -1;
    } else if (!isNum1 && isNum2) {
      return 1;
    } else {
      const cmp = pre1[i].localeCompare(pre2[i]);
      if (cmp !== 0) return cmp;
    }
  }

  return 0;
}

/**
 * HMAC-SHA256 digests are exactly 32 bytes, encoded as 64 lowercase hex
 * characters. Rejecting anything else before decoding keeps malformed input
 * out of `Buffer.from(..., 'hex')`, which silently truncates at the first
 * invalid character instead of throwing.
 */
const ROUTE_TABLE_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Constant-time comparison of a supplied route-table signature against the
 * expected HMAC.
 *
 * A plain `!==` short-circuits on the first mismatched character, leaking
 * prefix matches through timing. `crypto.timingSafeEqual` requires
 * equal-length buffers (it throws `RangeError` otherwise), so length is
 * checked first and any malformed input fails closed with `false`.
 */
function isValidRouteTableSignature(
  suppliedSignature: unknown,
  expectedSignature: string,
): boolean {
  if (
    typeof suppliedSignature !== 'string' ||
    !ROUTE_TABLE_SIGNATURE_PATTERN.test(suppliedSignature)
  ) {
    return false;
  }

  const suppliedBuffer = Buffer.from(suppliedSignature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (suppliedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export class KycRouter {
  private providers: Map<string, KycProvider> = new Map();
  private routeMap: Map<string, string> = new Map();
  private currentVersion: string = '';

  constructor(
    private readonly secretKey: string,
    private readonly defaultOptions: LoadRouteTableOptions = {}
  ) {}

  /**
   * Registers a provider strategy.
   */
  registerProvider(provider: KycProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Loads a signed and versioned route table.
   *
   * Security guarantees:
   * 1. Cryptographic integrity: Validates HMAC-SHA256 signature with the configured secret key.
   *    Fails closed if the signature does not match.
   * 2. Replay & Downgrade protection: Validates that the submitted version is strictly newer
   *    than the active `currentVersion`. Replaying the same version or submitting an older
   *    version is rejected with an Error and a warning log unless `allowDowngrade` is explicitly set.
   *
   * @param table - The signed route table to load.
   * @param options - Optional load options (e.g. allowDowngrade).
   * @throws Error if the signature is invalid or if the table version is <= currentVersion.
   */
  loadRouteTable(table: RouteTable, options?: LoadRouteTableOptions): void {
    if (!table || typeof table !== 'object') {
      throw new Error('Invalid route table: table is required.');
    }

    const payload = JSON.stringify({ version: table.version, entries: table.entries });
    const expectedSignature = crypto
      .createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks that could leak
    // prefix matches of the HMAC signature, matching the rest of the codebase
    // (see src/lib/webhookSignature.ts). Malformed hex and wrong-length input
    // fail closed with the same error rather than throwing a RangeError.
    if (!isValidRouteTableSignature(table.signature, expectedSignature)) {
      throw new Error('Invalid route table signature. Fails closed.');
    }

    // Validate table version format
    parseVersion(table.version);

    // If a route table is already active, reject equal or older versions unless allowDowngrade is set
    const allowDowngrade = options?.allowDowngrade ?? this.defaultOptions.allowDowngrade ?? false;
    if (this.currentVersion) {
      const comparison = compareVersions(table.version, this.currentVersion);
      if (comparison <= 0 && !allowDowngrade) {
        const action = comparison === 0 ? 'same version' : 'downgraded version';
        console.warn(
          `[KycRouter] Rejected ${action}: attempted table version "${table.version}" is not newer than current version "${this.currentVersion}".`
        );
        throw new Error(
          `Route table version rejection: version "${table.version}" is not newer than current version "${this.currentVersion}". Downgrades and replays are rejected unless allowDowngrade is specified.`
        );
      }
    }

    this.routeMap.clear();
    for (const entry of table.entries) {
      this.routeMap.set(entry.jurisdiction, entry.providerName);
    }
    this.currentVersion = table.version;
  }

  /**
   * Routes an applicant to the correct KYC provider based on their jurisdiction.
   * "Unknown country fails closed" per requirements.
   */
  route(jurisdiction: string): KycProvider {
    const providerName = this.routeMap.get(jurisdiction);
    if (!providerName) {
      throw new Error(`Jurisdiction ${jurisdiction} not supported. Fails closed.`);
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Configured provider ${providerName} not registered.`);
    }

    return provider;
  }

  getVersion(): string {
    return this.currentVersion;
  }
}
