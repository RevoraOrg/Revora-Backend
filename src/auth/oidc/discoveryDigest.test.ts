import { digestDiscoveryDocument, stableStringify } from './discoveryDigest';
import { OidcDiscoveryDocument } from './types';

describe('discoveryDigest', () => {
  const base: OidcDiscoveryDocument = {
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://idp.example.com/jwks',
  };

  it('stableStringify sorts object keys', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('stableStringify handles arrays and nested objects', () => {
    expect(stableStringify([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
  });

  it('ignores _cachedUntil and whitespace/key order for digest equality', () => {
    const a = digestDiscoveryDocument({ ...base, _cachedUntil: 1 });
    const b = digestDiscoveryDocument({
      jwks_uri: base.jwks_uri,
      token_endpoint: base.token_endpoint,
      authorization_endpoint: base.authorization_endpoint,
      issuer: base.issuer,
      _cachedUntil: 999,
    });
    expect(a).toBe(b);
  });

  it('changes digest when an endpoint changes', () => {
    const a = digestDiscoveryDocument(base);
    const b = digestDiscoveryDocument({
      ...base,
      authorization_endpoint: 'https://idp.example.com/v2/authorize',
    });
    expect(a).not.toBe(b);
  });
});
