# SSRF Protection Security Assumptions

## Overview

The webhook delivery system implements comprehensive Server-Side Request Forgery (SSRF) protection to prevent attackers from forcing the server to make requests to internal or restricted resources. This document outlines the security assumptions, threat model, and implementation details.

## Threat Model

### Attack Vectors Prevented

1. **Internal Network Access**
   - Blocking requests to private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
   - Blocking requests to IPv4 loopback (127.0.0.0/8)
   - Blocking requests to IPv4 link-local (169.254.0.0/16)
   - Blocking requests to IPv4 unspecified (0.0.0.0/8)

2. **IPv6 Internal Network Access**
   - Blocking requests to IPv6 loopback (::1)
   - Blocking requests to IPv6 unspecified (::)
   - Blocking requests to IPv6 Unique Local Addresses (fc00::/7)
   - Blocking requests to IPv6 link-local (fe80::/10)

3. **DNS Rebinding Attacks**
   - DNS resolution is performed before delivery
   - Resolved IP addresses are validated against private ranges
   - Hostnames that resolve to private IPs are rejected

4. **Encoding Bypasses**
   - Decimal-encoded IP addresses are normalized and validated (e.g., 2130706433 → 127.0.0.1)
   - Hex-encoded IP addresses are normalized and validated (e.g., 0x7f000001 → 127.0.0.1)

5. **Transport Security**
   - Only HTTPS URLs are allowed
   - HTTP and other schemes are rejected

6. **Credential Leakage**
   - URLs with embedded credentials are rejected
   - Prevents credential exposure in logs or error messages

## Security Assumptions

### DNS Resolution

- **Assumption**: DNS resolution is performed synchronously before webhook delivery
- **Risk**: If DNS is compromised or poisoned, an attacker could temporarily bypass protection
- **Mitigation**: DNS resolution is performed at validation time, not at delivery time, reducing the window for DNS rebinding attacks
- **Limitation**: The synchronous DNS lookup may impact performance; consider caching with short TTL

### IP Address Validation

- **Assumption**: All private and reserved IP ranges are correctly identified
- **Risk**: Future IP address allocations may introduce new private ranges
- **Mitigation**: The validation logic is centralized in `src/lib/ssrfProtection.ts` for easy updates
- **Coverage**: Current implementation covers RFC 1918, RFC 4193, RFC 3927, and RFC 4291

### URL Parsing

- **Assumption**: The Node.js URL parser correctly handles all URL formats
- **Risk**: Malformed URLs might bypass validation
- **Mitigation**: Invalid URL formats are rejected with `INVALID_URL` error code
- **Edge Cases**: IPv6 addresses in bracket notation are correctly handled

### HTTPS Enforcement

- **Assumption**: HTTPS provides sufficient transport security
- **Risk**: Man-in-the-middle attacks if TLS is misconfigured
- **Mitigation**: Certificate validation is handled by the Node.js HTTP client
- **Recommendation**: Ensure proper certificate validation in production

### Credential Handling

- **Assumption**: Webhook secrets are stored securely and never exposed
- **Risk**: Secrets might be leaked through logs or error messages
- **Mitigation**: URLs with embedded credentials are rejected; secrets are never logged
- **Best Practice**: Use separate secret management for webhook authentication

## Implementation Details

### Module: `src/lib/ssrfProtection.ts`

The SSRF protection module provides the following functions:

#### `validateWebhookUrl(url, resolveDns = true)`

Asynchronously validates a webhook URL with DNS resolution:

- Parses and validates URL format
- Enforces HTTPS scheme
- Rejects embedded credentials
- Normalizes encoded IP addresses
- Performs DNS resolution (if enabled)
- Validates resolved IP against private ranges

#### `validateWebhookUrlSync(url)`

Synchronously validates a webhook URL without DNS resolution:

- Same validation as async version
- Skips DNS resolution for performance
- Does not protect against DNS rebinding attacks
- Use only when DNS rebinding is not a concern

#### Helper Functions

- `isPrivateIPv4(ip)`: Checks if an IPv4 address is in a private range
- `isPrivateIPv6(ip)`: Checks if an IPv6 address is in a private range
- `isPrivateIP(ip)`: Checks if an IP address (IPv4 or IPv6) is private
- `normalizeEncodedIP(hostname)`: Normalizes decimal/hex-encoded IPs

### Integration: `src/index.ts` - WebhookQueue

The `WebhookQueue` class uses the SSRF protection module:

```typescript
private static async isSafeUrl(url: string): Promise<boolean> {
  try {
    const result = await validateWebhookUrl(url, true);
    if (!result.valid) {
      console.error(`[Security] SSRF validation failed for ${url}: ${result.error?.message}`);
    }
    return result.valid;
  } catch (error) {
    console.error(`[Security] Error validating webhook URL ${url}:`, error);
    return false;
  }
}
```

## Abuse/Failure Paths Handled

### Invalid URL Format
- **Error Code**: `INVALID_URL`
- **Action**: Reject webhook delivery
- **Logging**: Error logged with URL

### Invalid Scheme (non-HTTPS)
- **Error Code**: `INVALID_SCHEME`
- **Action**: Reject webhook delivery
- **Logging**: Error logged with URL

### Embedded Credentials
- **Error Code**: `HAS_CREDENTIALS`
- **Action**: Reject webhook delivery
- **Logging**: Error logged with URL (credentials not logged)

### Private/Reserved IP Address
- **Error Code**: `PRIVATE_ADDRESS`
- **Action**: Reject webhook delivery
- **Logging**: Error logged with IP address

### DNS Resolution Failure
- **Error Code**: `DNS_RESOLUTION_FAILED`
- **Action**: Reject webhook delivery
- **Logging**: Error logged with hostname

### DNS Rebinding (Resolved to Private IP)
- **Error Code**: `RESOLVED_TO_PRIVATE`
- **Action**: Reject webhook delivery
- **Logging**: Error logged with hostname and resolved IP

## Testing

Comprehensive test coverage is provided in `src/lib/ssrfProtection.test.ts`:

- **59 test cases** covering all security scenarios
- **IPv4 private range tests**: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0/8
- **IPv6 private range tests**: ::1, ::, fc00::/7, fe80::/10
- **URL scheme tests**: HTTPS enforcement, HTTP rejection
- **Credential tests**: Embedded credential rejection
- **Encoded IP tests**: Decimal and hex encoding normalization
- **DNS rebinding tests**: Resolution and validation
- **Edge cases**: Ports, paths, query parameters, fragments

## Recommendations

### Production Deployment

1. **Monitor DNS Resolution Failures**
   - Track `DNS_RESOLUTION_FAILED` errors
   - Investigate patterns that might indicate DNS poisoning attempts

2. **Review Private IP Rejections**
   - Monitor `PRIVATE_ADDRESS` rejections
   - Ensure legitimate webhook endpoints are not being blocked

3. **Certificate Validation**
   - Ensure proper TLS certificate validation
   - Consider certificate pinning for high-security environments

4. **Rate Limiting**
   - Implement rate limiting on webhook delivery attempts
   - Prevent abuse through repeated SSRF attempts

### Future Enhancements

1. **DNS Caching**
   - Implement short TTL DNS caching to improve performance
   - Cache should be invalidated on security events

2. **IP Reputation**
   - Integrate IP reputation services
   - Block known malicious IP ranges

3. **Allowlist Support**
   - Add optional allowlist for specific internal endpoints
   - Use with caution and strict access controls

4. **Monitoring Integration**
   - Export SSRF validation metrics to monitoring system
   - Set up alerts for suspicious patterns

## References

- [RFC 1918 - Private IPv4 Address Spaces](https://tools.ietf.org/html/rfc1918)
- [RFC 4193 - Unique Local IPv6 Unicast Addresses](https://tools.ietf.org/html/rfc4193)
- [RFC 3927 - Dynamic Configuration of IPv4 Link-Local Addresses](https://tools.ietf.org/html/rfc3927)
- [RFC 4291 - IPv6 Address Architecture](https://tools.ietf.org/html/rfc4291)
- [OWASP Server-Side Request Forgery (SSRF)](https://owasp.org/www-community/attacks/Server-Side_Request_Forgery)
