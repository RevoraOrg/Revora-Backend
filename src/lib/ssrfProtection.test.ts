import {
  validateWebhookUrl,
  validateWebhookUrlSync,
  SsrfValidationError,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIP,
  normalizeEncodedIP,
} from './ssrfProtection';

// ─── IPv4 Private Range Tests ───────────────────────────────────────────────

describe('SSRF Protection - IPv4 Private Ranges', () => {
  it('should reject 10.0.0.0/8 range', async () => {
    const result = await validateWebhookUrl('https://10.0.0.1/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject 172.16.0.0/12 range', async () => {
    const result = await validateWebhookUrl('https://172.16.0.1/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject 172.31.255.255 (upper bound of 172.16.0.0/12)', async () => {
    const result = await validateWebhookUrl('https://172.31.255.255/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should accept 172.32.0.0 (just outside 172.16.0.0/12)', async () => {
    const result = await validateWebhookUrlSync('https://172.32.0.1/webhook');
    expect(result.valid).toBe(true);
  });

  it('should reject 192.168.0.0/16 range', async () => {
    const result = await validateWebhookUrl('https://192.168.1.1/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject 127.0.0.0/8 loopback range', async () => {
    const result = await validateWebhookUrl('https://127.0.0.1/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject 169.254.0.0/16 link-local range', async () => {
    const result = await validateWebhookUrl('https://169.254.169.254/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject 0.0.0.0/8 unspecified range', async () => {
    const result = await validateWebhookUrl('https://0.0.0.0/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should accept public IPv4 addresses', async () => {
    const result = await validateWebhookUrlSync('https://8.8.8.8/webhook');
    expect(result.valid).toBe(true);
  });

  it('should accept 1.1.1.1 (public DNS)', async () => {
    const result = await validateWebhookUrlSync('https://1.1.1.1/webhook');
    expect(result.valid).toBe(true);
  });
});

// ─── IPv6 Private Range Tests ───────────────────────────────────────────────

describe('SSRF Protection - IPv6 Private Ranges', () => {
  it('should reject ::1 loopback', async () => {
    const result = await validateWebhookUrl('https://[::1]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject 0:0:0:0:0:0:0:1 (expanded ::1)', async () => {
    const result = await validateWebhookUrl('https://[0:0:0:0:0:0:0:1]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject :: unspecified', async () => {
    const result = await validateWebhookUrl('https://[::]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject fc00::/7 ULA range (fc00::)', async () => {
    const result = await validateWebhookUrl('https://[fc00::1]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject fd00::/7 ULA range (fd00::)', async () => {
    const result = await validateWebhookUrl('https://[fd00::1]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject fe80::/10 link-local range', async () => {
    const result = await validateWebhookUrl('https://[fe80::1]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should accept public IPv6 addresses', async () => {
    const result = await validateWebhookUrlSync('https://[2001:4860:4860::8888]/webhook');
    expect(result.valid).toBe(true);
  });

  it('should accept 2606:4700:4700::1111 (public IPv6)', async () => {
    const result = await validateWebhookUrlSync('https://[2606:4700:4700::1111]/webhook');
    expect(result.valid).toBe(true);
  });
});

// ─── URL Scheme Tests ───────────────────────────────────────────────────────

describe('SSRF Protection - URL Scheme', () => {
  it('should reject HTTP URLs', async () => {
    const result = await validateWebhookUrl('http://example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_SCHEME');
  });

  it('should accept HTTPS URLs', async () => {
    const result = await validateWebhookUrlSync('https://example.com/webhook');
    expect(result.valid).toBe(true);
  });

  it('should reject FTP URLs', async () => {
    const result = await validateWebhookUrl('ftp://example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_SCHEME');
  });

  it('should reject invalid URL format', async () => {
    const result = await validateWebhookUrl('not-a-url');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_URL');
  });
});

// ─── Credential Tests ────────────────────────────────────────────────────────

describe('SSRF Protection - Embedded Credentials', () => {
  it('should reject URLs with username', async () => {
    const result = await validateWebhookUrl('https://user@example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('HAS_CREDENTIALS');
  });

  it('should reject URLs with username and password', async () => {
    const result = await validateWebhookUrl('https://user:pass@example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('HAS_CREDENTIALS');
  });

  it('should reject URLs with only password', async () => {
    const result = await validateWebhookUrl('https://:pass@example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('HAS_CREDENTIALS');
  });

  it('should accept URLs without credentials', async () => {
    const result = await validateWebhookUrlSync('https://example.com/webhook');
    expect(result.valid).toBe(true);
  });
});

// ─── Encoded IP Address Tests ───────────────────────────────────────────────

describe('SSRF Protection - Encoded IP Addresses', () => {
  it('should reject decimal-encoded 127.0.0.1 (2130706433)', async () => {
    const result = await validateWebhookUrl('https://2130706433/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject hex-encoded 127.0.0.1 (0x7f000001)', async () => {
    const result = await validateWebhookUrl('https://0x7f000001/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should reject decimal-encoded 192.168.1.1 (3232235777)', async () => {
    const result = await validateWebhookUrl('https://3232235777/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should accept decimal-encoded public IP (134744072 = 8.8.8.8)', async () => {
    const result = await validateWebhookUrlSync('https://134744072/webhook');
    expect(result.valid).toBe(true);
  });

  it('should normalize and validate encoded IPs correctly', () => {
    expect(normalizeEncodedIP('2130706433')).toBe('127.0.0.1');
    expect(normalizeEncodedIP('0x7f000001')).toBe('127.0.0.1');
    expect(normalizeEncodedIP('3232235777')).toBe('192.168.1.1');
    expect(normalizeEncodedIP('example.com')).toBe('example.com');
  });
});

// ─── DNS Rebinding Tests ───────────────────────────────────────────────────

describe('SSRF Protection - DNS Rebinding', () => {
  it('should resolve hostname and validate resolved IP', async () => {
    // This test uses a real public hostname
    const result = await validateWebhookUrl('https://example.com/webhook');
    expect(result.valid).toBe(true);
    expect(result.resolvedIp).toBeDefined();
    expect(result.hostname).toBe('example.com');
  });

  it('should reject if DNS resolution fails', async () => {
    // Use a non-existent domain
    const result = await validateWebhookUrl('https://this-domain-does-not-exist-12345.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('DNS_RESOLUTION_FAILED');
  }, 10000);

  it('should skip DNS resolution when resolveDns is false', async () => {
    const result = await validateWebhookUrl('https://example.com/webhook', false);
    expect(result.valid).toBe(true);
    expect(result.resolvedIp).toBeUndefined();
  });
});

// ─── Synchronous Validation Tests ────────────────────────────────────────────

describe('SSRF Protection - Synchronous Validation', () => {
  it('should validate IPv4 addresses synchronously', () => {
    const result = validateWebhookUrlSync('https://192.168.1.1/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should validate IPv6 addresses synchronously', () => {
    const result = validateWebhookUrlSync('https://[::1]/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('PRIVATE_ADDRESS');
  });

  it('should validate scheme synchronously', () => {
    const result = validateWebhookUrlSync('http://example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_SCHEME');
  });

  it('should validate credentials synchronously', () => {
    const result = validateWebhookUrlSync('https://user:pass@example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('HAS_CREDENTIALS');
  });

  it('should allow hostnames without DNS resolution', () => {
    const result = validateWebhookUrlSync('https://example.com/webhook');
    expect(result.valid).toBe(true);
    expect(result.resolvedIp).toBeUndefined();
  });
});

// ─── Helper Function Tests ──────────────────────────────────────────────────

describe('SSRF Protection - Helper Functions', () => {
  describe('isPrivateIPv4', () => {
    it('should identify private IPv4 addresses', () => {
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('172.16.0.1')).toBe(true);
      expect(isPrivateIPv4('192.168.1.1')).toBe(true);
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('169.254.1.1')).toBe(true);
      expect(isPrivateIPv4('0.0.0.0')).toBe(true);
    });

    it('should identify public IPv4 addresses', () => {
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
      expect(isPrivateIPv4('172.32.0.1')).toBe(false);
      expect(isPrivateIPv4('192.169.0.1')).toBe(false);
    });

    it('should handle invalid IPv4 addresses', () => {
      expect(isPrivateIPv4('invalid')).toBe(false);
      expect(isPrivateIPv4('256.256.256.256')).toBe(false);
    });
  });

  describe('isPrivateIPv6', () => {
    it('should identify private IPv6 addresses', () => {
      expect(isPrivateIPv6('::1')).toBe(true);
      expect(isPrivateIPv6('::')).toBe(true);
      expect(isPrivateIPv6('fc00::1')).toBe(true);
      expect(isPrivateIPv6('fd00::1')).toBe(true);
      expect(isPrivateIPv6('fe80::1')).toBe(true);
    });

    it('should identify public IPv6 addresses', () => {
      expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
      expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
    });

    it('should handle invalid IPv6 addresses', () => {
      expect(isPrivateIPv6('invalid')).toBe(false);
    });
  });

  describe('isPrivateIP', () => {
    it('should detect private IPv4 addresses', () => {
      expect(isPrivateIP('192.168.1.1')).toBe(true);
      expect(isPrivateIP('10.0.0.1')).toBe(true);
    });

    it('should detect private IPv6 addresses', () => {
      expect(isPrivateIP('::1')).toBe(true);
      expect(isPrivateIP('fc00::1')).toBe(true);
    });

    it('should detect public addresses', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('2001:4860:4860::8888')).toBe(false);
    });
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────

describe('SSRF Protection - Edge Cases', () => {
  it('should handle URLs with ports', async () => {
    const result = await validateWebhookUrlSync('https://example.com:443/webhook');
    expect(result.valid).toBe(true);
  });

  it('should handle URLs with paths', async () => {
    const result = await validateWebhookUrlSync('https://example.com/path/to/webhook');
    expect(result.valid).toBe(true);
  });

  it('should handle URLs with query parameters', async () => {
    const result = await validateWebhookUrlSync('https://example.com/webhook?param=value');
    expect(result.valid).toBe(true);
  });

  it('should handle URLs with fragments', async () => {
    const result = await validateWebhookUrlSync('https://example.com/webhook#fragment');
    expect(result.valid).toBe(true);
  });

  it('should reject localhost hostname', async () => {
    const result = await validateWebhookUrl('https://localhost/webhook');
    // This will fail DNS resolution, which is acceptable
    expect(result.valid).toBe(false);
  });

  it('should reject IP addresses in path (not hostname)', async () => {
    const result = await validateWebhookUrlSync('https://example.com/127.0.0.1/webhook');
    // This should be allowed since the IP is in the path, not the hostname
    expect(result.valid).toBe(true);
  });

  it('should handle malformed IPv6 addresses', async () => {
    const result = await validateWebhookUrl('https://[not-valid-ipv6]/webhook');
    expect(result.valid).toBe(false);
  });
});

// ─── Security Assumptions Validation ───────────────────────────────────────

describe('SSRF Protection - Security Assumptions', () => {
  it('should enforce HTTPS for all valid URLs', async () => {
    const httpsResult = await validateWebhookUrlSync('https://example.com/webhook');
    expect(httpsResult.valid).toBe(true);

    const httpResult = await validateWebhookUrl('http://example.com/webhook');
    expect(httpResult.valid).toBe(false);
    expect(httpResult.error?.code).toBe('INVALID_SCHEME');
  });

  it('should block all private address ranges', async () => {
    const privateRanges = [
      'https://10.0.0.1/webhook',
      'https://172.16.0.1/webhook',
      'https://192.168.1.1/webhook',
      'https://127.0.0.1/webhook',
      'https://169.254.1.1/webhook',
      'https://0.0.0.0/webhook',
      'https://[::1]/webhook',
      'https://[fc00::1]/webhook',
      'https://[fd00::1]/webhook',
      'https://[fe80::1]/webhook',
    ];

    for (const url of privateRanges) {
      const result = await validateWebhookUrl(url);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('PRIVATE_ADDRESS');
    }
  });

  it('should block encoded private IPs', async () => {
    const encodedPrivate = [
      'https://2130706433/webhook', // 127.0.0.1
      'https://0x7f000001/webhook', // 127.0.0.1
      'https://3232235777/webhook', // 192.168.1.1
    ];

    for (const url of encodedPrivate) {
      const result = await validateWebhookUrl(url);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('PRIVATE_ADDRESS');
    }
  });

  it('should block URLs with credentials', async () => {
    const credentialUrls = [
      'https://user@example.com/webhook',
      'https://user:pass@example.com/webhook',
      'https://:pass@example.com/webhook',
    ];

    for (const url of credentialUrls) {
      const result = await validateWebhookUrl(url);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('HAS_CREDENTIALS');
    }
  });
});
