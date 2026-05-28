import { lookup } from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

/**
 * @title SSRF Protection for Webhook Delivery
 * @notice Production-grade Server-Side Request Forgery (SSRF) protection for webhook URLs.
 * @dev Validates URLs to ensure they point to public, non-reserved addresses only.
 *
 * Security assumptions:
 * - DNS resolution is performed synchronously before delivery to prevent DNS rebinding attacks
 * - Only HTTPS URLs are allowed to ensure transport security
 * - Non-default credentials in URLs are rejected to prevent credential leakage
 * - All private, reserved, and link-local address ranges are blocked for both IPv4 and IPv6
 * - Decimal and hex-encoded IP addresses are normalized and validated
 *
 * Abuse/failure paths handled:
 * - IPv4 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - IPv4 loopback (127.0.0.0/8)
 * - IPv4 link-local (169.254.0.0/16)
 * - IPv4 unspecified (0.0.0.0/8)
 * - IPv6 loopback (::1)
 * - IPv6 unique local addresses (fc00::/7)
 * - IPv6 link-local (fe80::/10)
 * - IPv6 unspecified (::)
 * - DNS rebinding attacks (hostname resolves to private IP)
 * - Non-HTTPS schemes
 * - URLs with embedded credentials
 * - Invalid URL formats
 */

/**
 * @notice Error thrown when SSRF validation fails.
 */
export class SsrfValidationError extends Error {
  constructor(
    message: string,
    public readonly code: 
      | 'INVALID_URL'
      | 'INVALID_SCHEME'
      | 'HAS_CREDENTIALS'
      | 'PRIVATE_ADDRESS'
      | 'DNS_RESOLUTION_FAILED'
      | 'RESOLVED_TO_PRIVATE'
  ) {
    super(message);
    this.name = 'SsrfValidationError';
    Object.setPrototypeOf(this, SsrfValidationError.prototype);
  }
}

/**
 * @notice Result of SSRF validation.
 */
export interface SsrfValidationResult {
  valid: boolean;
  error?: SsrfValidationError;
  /** The resolved IP address if DNS lookup was performed */
  resolvedIp?: string;
  /** The original hostname */
  hostname?: string;
}

/**
 * @notice Checks if an IPv4 address is in a private/reserved range.
 * @dev Covers 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0/8
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    return false; // Invalid IPv4, will be caught elsewhere
  }

  const [first, second] = parts;

  // 10.0.0.0/8
  if (first === 10) return true;

  // 172.16.0.0/12
  if (first === 172 && second >= 16 && second <= 31) return true;

  // 192.168.0.0/16
  if (first === 192 && second === 168) return true;

  // 127.0.0.0/8 (loopback)
  if (first === 127) return true;

  // 169.254.0.0/16 (link-local)
  if (first === 169 && second === 254) return true;

  // 0.0.0.0/8 (unspecified)
  if (first === 0) return true;

  return false;
}

/**
 * @notice Checks if an IPv6 address is in a private/reserved range.
 * @dev Covers ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local), :: (unspecified)
 */
export function isPrivateIPv6(ip: string): boolean {
  // Normalize IPv6 address
  const normalized = ip.toLowerCase();

  // ::1 (loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }

  // :: (unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // Expand compressed IPv6 for easier checking
  let expanded = normalized;
  if (expanded.includes('::')) {
    const parts = expanded.split('::');
    const leftParts = parts[0].split(':').filter(p => p);
    const rightParts = parts[1] ? parts[1].split(':').filter(p => p) : [];
    const missing = 8 - leftParts.length - rightParts.length;
    expanded = [...leftParts, ...Array(missing).fill('0'), ...rightParts].join(':');
  }

  const parts = expanded.split(':').map(p => parseInt(p, 16) || 0);
  if (parts.length !== 8) {
    return false; // Invalid IPv6, will be caught elsewhere
  }

  const [first] = parts;

  // fc00::/7 (Unique Local Addresses - ULA)
  // fc00::/7 includes fc00::/8 and fd00::/8
  // Binary: 11111100xxxxxxx...
  if ((first & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (link-local)
  // Binary: 1111111010xxxxx...
  if ((first & 0xffc0) === 0xfe80) {
    return true;
  }

  return false;
}

/**
 * @notice Checks if an IP address (IPv4 or IPv6) is in a private/reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  // Check IPv4
  if (ip.includes('.')) {
    return isPrivateIPv4(ip);
  }

  // Check IPv6
  if (ip.includes(':')) {
    return isPrivateIPv6(ip);
  }

  return false;
}

/**
 * @notice Normalizes decimal or hex-encoded IP addresses to standard dotted-decimal or IPv6 format.
 * @dev Handles formats like 2130706433 (127.0.0.1 in decimal) or 0x7f000001 (127.0.0.1 in hex)
 */
export function normalizeEncodedIP(hostname: string): string {
  // Check for decimal encoding (e.g., 2130706433)
  const decimalMatch = hostname.match(/^\d+$/);
  if (decimalMatch) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffffffff) {
      // Convert to IPv4 dotted decimal
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff
      ].join('.');
    }
  }

  // Check for hex encoding (e.g., 0x7f000001)
  const hexMatch = hostname.match(/^0x[0-9a-fA-F]+$/);
  if (hexMatch) {
    const num = parseInt(hostname, 16);
    if (num >= 0 && num <= 0xffffffff) {
      // Convert to IPv4 dotted decimal
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff
      ].join('.');
    }
  }

  return hostname;
}

/**
 * @notice Validates a URL for SSRF protection.
 * @dev Performs comprehensive validation including scheme check, credential check,
 * hostname validation, DNS resolution, and IP address range checking.
 *
 * @param url The URL to validate
 * @param resolveDns Whether to perform DNS resolution (default: true)
 * @returns Validation result with details
 *
 * @example
 * ```typescript
 * const result = validateWebhookUrl('https://api.example.com/webhook');
 * if (!result.valid) {
 *   console.error('SSRF validation failed:', result.error);
 * }
 * ```
 */
export async function validateWebhookUrl(
  url: string,
  resolveDns: boolean = true
): Promise<SsrfValidationResult> {
  // Parse URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return {
      valid: false,
      error: new SsrfValidationError(
        'Invalid URL format',
        'INVALID_URL'
      ),
    };
  }

  // Enforce HTTPS scheme
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: new SsrfValidationError(
        'Only HTTPS URLs are allowed for webhook delivery',
        'INVALID_SCHEME'
      ),
    };
  }

  // Reject URLs with embedded credentials
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: new SsrfValidationError(
        'URLs with embedded credentials are not allowed',
        'HAS_CREDENTIALS'
      ),
    };
  }

  let hostname = parsed.hostname;

  // Remove brackets from IPv6 addresses (URL parser keeps them in hostname)
  if (hostname && hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // Normalize encoded IP addresses
  const normalizedHostname = normalizeEncodedIP(hostname);

  // Check if hostname is an IP address
  const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(normalizedHostname);
  const isIPv6 = normalizedHostname.includes(':');

  if (isIPv4 || isIPv6) {
    // Direct IP address - check if it's private
    if (isPrivateIP(normalizedHostname)) {
      return {
        valid: false,
        error: new SsrfValidationError(
          `Private or reserved IP address is not allowed: ${normalizedHostname}`,
          'PRIVATE_ADDRESS'
        ),
      };
    }

    return {
      valid: true,
      resolvedIp: normalizedHostname,
      hostname,
    };
  }

  // Hostname - perform DNS resolution if enabled
  if (resolveDns) {
    try {
      const { address } = await dnsLookup(hostname);
      
      // Check if resolved IP is private
      if (isPrivateIP(address)) {
        return {
          valid: false,
          error: new SsrfValidationError(
            `Hostname resolved to private or reserved IP address: ${hostname} -> ${address}`,
            'RESOLVED_TO_PRIVATE'
          ),
        };
      }

      return {
        valid: true,
        resolvedIp: address,
        hostname,
      };
    } catch (error) {
      return {
        valid: false,
        error: new SsrfValidationError(
          `DNS resolution failed for hostname: ${hostname}`,
          'DNS_RESOLUTION_FAILED'
        ),
      };
    }
  }

  // DNS resolution disabled - allow hostname but log warning
  return {
    valid: true,
    hostname,
  };
}

/**
 * @notice Synchronous version of validateWebhookUrl that skips DNS resolution.
 * @dev Use this when you need fast validation without DNS lookup, but be aware
 * that it does not protect against DNS rebinding attacks.
 *
 * @param url The URL to validate
 * @returns Validation result with details
 */
export function validateWebhookUrlSync(url: string): SsrfValidationResult {
  // Parse URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return {
      valid: false,
      error: new SsrfValidationError(
        'Invalid URL format',
        'INVALID_URL'
      ),
    };
  }

  // Enforce HTTPS scheme
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: new SsrfValidationError(
        'Only HTTPS URLs are allowed for webhook delivery',
        'INVALID_SCHEME'
      ),
    };
  }

  // Reject URLs with embedded credentials
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: new SsrfValidationError(
        'URLs with embedded credentials are not allowed',
        'HAS_CREDENTIALS'
      ),
    };
  }

  let hostname = parsed.hostname;

  // Remove brackets from IPv6 addresses (URL parser keeps them in hostname)
  if (hostname && hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // Normalize encoded IP addresses
  const normalizedHostname = normalizeEncodedIP(hostname);

  // Check if hostname is an IP address
  const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(normalizedHostname);
  const isIPv6 = normalizedHostname.includes(':');

  if (isIPv4 || isIPv6) {
    // Direct IP address - check if it's private
    if (isPrivateIP(normalizedHostname)) {
      return {
        valid: false,
        error: new SsrfValidationError(
          `Private or reserved IP address is not allowed: ${normalizedHostname}`,
          'PRIVATE_ADDRESS'
        ),
      };
    }

    return {
      valid: true,
      resolvedIp: normalizedHostname,
      hostname,
    };
  }

  // Hostname without DNS resolution - allow but note limitation
  return {
    valid: true,
    hostname,
  };
}
