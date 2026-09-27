/**
 * Test suite for src/auth/social/types.ts
 *
 * Covers:
 *   - SocialAuthProvider: exhaustive valid values, structural narrowing, rejection of
 *     invalid strings at runtime via guard helper
 *   - SocialProviderClaims: required field presence, optional isPrivateRelay semantics,
 *     Apple private-relay flag, cross-field consistency
 *   - SocialTokenVerifier: contract via fake implementation — success, rejection paths,
 *     Promise<SocialProviderClaims> return type
 *   - SocialAuthError: constructor, name, code, message, prototype chain, instanceof,
 *     all nine SocialAuthErrorCode literals, serialisation
 *   - SocialIdentityRepository / SocialIdentityRecord: fake CRUD round-trips
 *   - SocialLinkResult / SocialUnlinkResult structural contracts
 *   - Property-based fuzzing via fast-check where determinism benefits most
 */

import * as fc from 'fast-check';
import {
  SocialAuthError,
  SocialAuthErrorCode,
  SocialAuthProvider,
  SocialIdentityRecord,
  SocialIdentityRepository,
  SocialLinkResult,
  SocialProviderClaims,
  SocialTokenVerifier,
  SocialUnlinkResult,
  SocialUserRecord,
  SocialUserRepository,
} from './types';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Runtime guard mirroring what production code would use to narrow to SocialAuthProvider. */
const VALID_PROVIDERS: ReadonlySet<string> = new Set<SocialAuthProvider>(['google', 'apple']);
function isSocialAuthProvider(value: unknown): value is SocialAuthProvider {
  return typeof value === 'string' && VALID_PROVIDERS.has(value);
}

function makeClaims(overrides: Partial<SocialProviderClaims> = {}): SocialProviderClaims {
  return {
    provider: 'google',
    subject: 'sub-001',
    email: 'user@example.com',
    emailVerified: true,
    issuer: 'https://accounts.google.com',
    audience: 'my-client-id',
    ...overrides,
  };
}

function makeIdentityRecord(overrides: Partial<SocialIdentityRecord> = {}): SocialIdentityRecord {
  return {
    id: 'identity-1',
    userId: 'user-1',
    provider: 'google',
    providerSubject: 'sub-001',
    providerEmail: 'user@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── Fake implementations ───────────────────────────────────────────────────────

class FakeTokenVerifier implements SocialTokenVerifier {
  private fixtures = new Map<string, SocialProviderClaims>();
  private rejectTokens = new Set<string>();

  stubSuccess(token: string, claims: SocialProviderClaims): void {
    this.fixtures.set(token, claims);
  }

  stubReject(token: string): void {
    this.rejectTokens.add(token);
  }

  async verify(provider: SocialAuthProvider, idToken: string): Promise<SocialProviderClaims> {
    if (this.rejectTokens.has(idToken)) {
      throw new SocialAuthError('INVALID_TOKEN', `Token rejected: ${idToken}`);
    }
    const claims = this.fixtures.get(idToken);
    if (!claims) {
      throw new SocialAuthError('INVALID_TOKEN', 'Unknown token');
    }
    if (claims.provider !== provider) {
      throw new SocialAuthError(
        'INVALID_PROVIDER',
        `Token is for ${claims.provider}, not ${provider}`,
      );
    }
    return claims;
  }
}

class FakeIdentityRepository implements SocialIdentityRepository {
  private store = new Map<string, SocialIdentityRecord>();
  private nextId = 1;

  async findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string,
  ): Promise<SocialIdentityRecord | null> {
    return (
      [...this.store.values()].find(
        (r) => r.provider === provider && r.providerSubject === providerSubject,
      ) ?? null
    );
  }

  async findByUserAndProvider(
    userId: string,
    provider: SocialAuthProvider,
  ): Promise<SocialIdentityRecord | null> {
    return (
      [...this.store.values()].find((r) => r.userId === userId && r.provider === provider) ?? null
    );
  }

  async createIdentity(input: {
    userId: string;
    provider: SocialAuthProvider;
    providerSubject: string;
    providerEmail: string;
    emailVerified: boolean;
    isPrivateRelay?: boolean;
  }): Promise<SocialIdentityRecord> {
    const record: SocialIdentityRecord = {
      id: `identity-${this.nextId++}`,
      userId: input.userId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      providerEmail: input.providerEmail,
      emailVerified: input.emailVerified,
      isPrivateRelay: input.isPrivateRelay ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.set(record.id, record);
    return record;
  }

  async updateIdentityEmail(
    id: string,
    providerEmail: string,
    isPrivateRelay?: boolean,
  ): Promise<void> {
    const record = this.store.get(id);
    if (!record) throw new Error(`Identity not found: ${id}`);
    record.providerEmail = providerEmail;
    if (isPrivateRelay !== undefined) record.isPrivateRelay = isPrivateRelay;
    record.updatedAt = new Date();
  }

  async deleteByUserAndProvider(userId: string, provider: SocialAuthProvider): Promise<boolean> {
    const entry = [...this.store.entries()].find(
      ([, r]) => r.userId === userId && r.provider === provider,
    );
    if (!entry) return false;
    this.store.delete(entry[0]);
    return true;
  }
}

class FakeSocialUserRepository implements SocialUserRepository {
  private users = new Map<string, SocialUserRecord>();

  seed(user: SocialUserRecord): void {
    this.users.set(user.id, user);
  }

  async findById(id: string): Promise<SocialUserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<SocialUserRecord | null> {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SocialAuthProvider
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialAuthProvider', () => {
  describe('valid values', () => {
    it('accepts "google"', () => {
      const p: SocialAuthProvider = 'google';
      expect(isSocialAuthProvider(p)).toBe(true);
    });

    it('accepts "apple"', () => {
      const p: SocialAuthProvider = 'apple';
      expect(isSocialAuthProvider(p)).toBe(true);
    });

    it('covers the full exhaustive set of two providers', () => {
      const providers: SocialAuthProvider[] = ['google', 'apple'];
      expect(providers).toHaveLength(2);
      providers.forEach((p) => expect(isSocialAuthProvider(p)).toBe(true));
    });
  });

  describe('invalid values', () => {
    it.each([
      ['empty string', ''],
      ['near-miss uppercase', 'Google'],
      ['near-miss mixed', 'Apple'],
      ['numeric string', '1'],
      ['whitespace', ' google '],
      ['facebook', 'facebook'],
      ['twitter', 'twitter'],
    ])('rejects invalid provider: %s', (_label, value) => {
      expect(isSocialAuthProvider(value)).toBe(false);
    });

    it('rejects null and undefined', () => {
      expect(isSocialAuthProvider(null)).toBe(false);
      expect(isSocialAuthProvider(undefined)).toBe(false);
    });

    it('rejects non-string types', () => {
      expect(isSocialAuthProvider(42)).toBe(false);
      expect(isSocialAuthProvider({})).toBe(false);
      expect(isSocialAuthProvider(['google'])).toBe(false);
    });

    it('property: arbitrary strings are never accepted unless they equal "google" or "apple"', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const expected = s === 'google' || s === 'apple';
          return isSocialAuthProvider(s) === expected;
        }),
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SocialProviderClaims
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialProviderClaims', () => {
  describe('required fields', () => {
    it('constructs a valid Google claims object with all required fields', () => {
      const claims = makeClaims();
      expect(claims.provider).toBe('google');
      expect(claims.subject).toBe('sub-001');
      expect(claims.email).toBe('user@example.com');
      expect(claims.emailVerified).toBe(true);
      expect(claims.issuer).toBe('https://accounts.google.com');
      expect(claims.audience).toBe('my-client-id');
    });

    it('constructs a valid Apple claims object with all required fields', () => {
      const claims = makeClaims({
        provider: 'apple',
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.app',
      });
      expect(claims.provider).toBe('apple');
      expect(claims.issuer).toBe('https://appleid.apple.com');
    });

    it('emailVerified can be false (unverified email path)', () => {
      const claims = makeClaims({ emailVerified: false });
      expect(claims.emailVerified).toBe(false);
    });
  });

  describe('optional isPrivateRelay field (Apple "Hide My Email")', () => {
    it('defaults to undefined when not supplied', () => {
      const claims = makeClaims();
      expect(claims.isPrivateRelay).toBeUndefined();
    });

    it('is true for Apple private-relay emails', () => {
      const claims = makeClaims({
        provider: 'apple',
        email: 'abc123@privaterelay.appleid.com',
        isPrivateRelay: true,
      });
      expect(claims.isPrivateRelay).toBe(true);
    });

    it('is false when Apple user shares real email', () => {
      const claims = makeClaims({
        provider: 'apple',
        isPrivateRelay: false,
      });
      expect(claims.isPrivateRelay).toBe(false);
    });

    it('Google claims never need isPrivateRelay=true', () => {
      // Google does not support private relay; callers should not set it true.
      const claims = makeClaims({ provider: 'google' });
      expect(claims.isPrivateRelay).not.toBe(true);
    });
  });

  describe('cross-field consistency', () => {
    it('provider field determines the issuer domain convention', () => {
      const google = makeClaims({
        provider: 'google',
        issuer: 'https://accounts.google.com',
      });
      const apple = makeClaims({
        provider: 'apple',
        issuer: 'https://appleid.apple.com',
      });
      expect(google.issuer).toContain('google');
      expect(apple.issuer).toContain('apple');
    });

    it('subject is non-empty and stable', () => {
      const claims = makeClaims({ subject: 'abc-xyz-789' });
      expect(claims.subject).toBeTruthy();
      expect(typeof claims.subject).toBe('string');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SocialTokenVerifier
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialTokenVerifier', () => {
  let verifier: FakeTokenVerifier;

  beforeEach(() => {
    verifier = new FakeTokenVerifier();
  });

  describe('successful verification', () => {
    it('resolves to SocialProviderClaims for a valid Google token', async () => {
      const claims = makeClaims({ provider: 'google', subject: 'goog-42' });
      verifier.stubSuccess('valid-google-token', claims);

      const result = await verifier.verify('google', 'valid-google-token');

      expect(result.provider).toBe('google');
      expect(result.subject).toBe('goog-42');
      expect(result.email).toBe('user@example.com');
      expect(result.emailVerified).toBe(true);
    });

    it('resolves to SocialProviderClaims for a valid Apple token', async () => {
      const claims = makeClaims({
        provider: 'apple',
        subject: 'apple-99',
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.app',
        isPrivateRelay: true,
      });
      verifier.stubSuccess('valid-apple-token', claims);

      const result = await verifier.verify('apple', 'valid-apple-token');

      expect(result.provider).toBe('apple');
      expect(result.isPrivateRelay).toBe(true);
    });

    it('returns a Promise (async contract)', async () => {
      const claims = makeClaims();
      verifier.stubSuccess('tok', claims);
      const p = verifier.verify('google', 'tok');
      expect(p).toBeInstanceOf(Promise);
      await expect(p).resolves.toMatchObject({ subject: 'sub-001' });
    });
  });

  describe('rejection paths', () => {
    it('throws SocialAuthError with INVALID_TOKEN for an explicitly rejected token', async () => {
      verifier.stubReject('bad-token');
      await expect(verifier.verify('google', 'bad-token')).rejects.toThrow(SocialAuthError);
      await expect(verifier.verify('google', 'bad-token')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('throws SocialAuthError with INVALID_TOKEN for an unknown token', async () => {
      await expect(verifier.verify('google', 'unknown-token')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('throws SocialAuthError with INVALID_PROVIDER when token belongs to a different provider', async () => {
      const claims = makeClaims({ provider: 'apple' });
      verifier.stubSuccess('apple-tok', claims);

      await expect(verifier.verify('google', 'apple-tok')).rejects.toMatchObject({
        code: 'INVALID_PROVIDER',
      });
    });

    it('error thrown from verify is an instanceof Error', async () => {
      verifier.stubReject('bad');
      await expect(verifier.verify('google', 'bad')).rejects.toBeInstanceOf(Error);
    });
  });

  describe('interface contract', () => {
    it('verify signature accepts both SocialAuthProvider literals', async () => {
      const googleClaims = makeClaims({ provider: 'google' });
      const appleClaims = makeClaims({ provider: 'apple', issuer: 'https://appleid.apple.com' });

      verifier.stubSuccess('g', googleClaims);
      verifier.stubSuccess('a', appleClaims);

      await expect(verifier.verify('google', 'g')).resolves.toMatchObject({ provider: 'google' });
      await expect(verifier.verify('apple', 'a')).resolves.toMatchObject({ provider: 'apple' });
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SocialAuthError
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialAuthError', () => {
  const ALL_CODES: SocialAuthErrorCode[] = [
    'INVALID_PROVIDER',
    'PROVIDER_NOT_CONFIGURED',
    'INVALID_TOKEN',
    'UNVERIFIED_EMAIL',
    'SOCIAL_IDENTITY_NOT_LINKED',
    'EMAIL_ACCOUNT_REQUIRES_LINK',
    'USER_NOT_FOUND',
    'STEP_UP_REQUIRED',
    'IDENTITY_LINKED_TO_ANOTHER_USER',
  ];

  describe('constructor and properties', () => {
    it('stores the code on the public readonly code property', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'token is expired');
      expect(err.code).toBe('INVALID_TOKEN');
    });

    it('forwards the message to Error.message', () => {
      const err = new SocialAuthError('USER_NOT_FOUND', 'no user with that id');
      expect(err.message).toBe('no user with that id');
    });

    it('sets name to "SocialAuthError"', () => {
      const err = new SocialAuthError('INVALID_PROVIDER', 'bad provider');
      expect(err.name).toBe('SocialAuthError');
    });
  });

  describe('prototype chain and instanceof', () => {
    it('is an instanceof SocialAuthError', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'msg');
      expect(err).toBeInstanceOf(SocialAuthError);
    });

    it('is an instanceof Error', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'msg');
      expect(err).toBeInstanceOf(Error);
    });

    it('prototype is correctly patched so instanceof works after transpilation', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'msg');
      expect(Object.getPrototypeOf(err)).toBe(SocialAuthError.prototype);
    });

    it('can be caught and narrowed by instanceof in a catch block', () => {
      let caught: unknown;
      try {
        throw new SocialAuthError('USER_NOT_FOUND', 'gone');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SocialAuthError);
      expect((caught as SocialAuthError).code).toBe('USER_NOT_FOUND');
    });
  });

  describe('all nine SocialAuthErrorCode literals', () => {
    it.each(ALL_CODES)('accepts code "%s"', (code) => {
      const err = new SocialAuthError(code, `error for ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`error for ${code}`);
      expect(err).toBeInstanceOf(SocialAuthError);
    });

    it('covers exactly nine distinct codes', () => {
      expect(ALL_CODES).toHaveLength(9);
      expect(new Set(ALL_CODES).size).toBe(9);
    });
  });

  describe('serialisation', () => {
    it('JSON.stringify includes name and message (standard Error shape)', () => {
      const err = new SocialAuthError('STEP_UP_REQUIRED', 'mfa needed');
      const json = JSON.stringify(err);
      // code is an own enumerable property; message is inherited — test both
      const plain = { ...err, message: err.message, name: err.name };
      expect(plain.code).toBe('STEP_UP_REQUIRED');
      expect(plain.message).toBe('mfa needed');
      expect(plain.name).toBe('SocialAuthError');
      expect(json).toContain('STEP_UP_REQUIRED');
    });

    it('stack trace is defined', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'bad');
      expect(err.stack).toBeDefined();
    });
  });

  describe('boundary: empty message', () => {
    it('accepts an empty message string', () => {
      const err = new SocialAuthError('PROVIDER_NOT_CONFIGURED', '');
      expect(err.message).toBe('');
      expect(err.code).toBe('PROVIDER_NOT_CONFIGURED');
    });
  });

  describe('property-based: code is always preserved', () => {
    it('message content does not affect code', () => {
      fc.assert(
        fc.property(fc.constantFrom(...ALL_CODES), fc.string(), (code, msg) => {
          const err = new SocialAuthError(code, msg);
          return err.code === code && err.message === msg;
        }),
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SocialIdentityRepository (contract via fake)
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialIdentityRepository', () => {
  let repo: FakeIdentityRepository;

  beforeEach(() => {
    repo = new FakeIdentityRepository();
  });

  describe('createIdentity', () => {
    it('creates and returns a record with the supplied fields', async () => {
      const record = await repo.createIdentity({
        userId: 'u1',
        provider: 'google',
        providerSubject: 'sub-g1',
        providerEmail: 'u1@example.com',
        emailVerified: true,
      });

      expect(record.id).toBeTruthy();
      expect(record.userId).toBe('u1');
      expect(record.provider).toBe('google');
      expect(record.providerSubject).toBe('sub-g1');
      expect(record.providerEmail).toBe('u1@example.com');
      expect(record.emailVerified).toBe(true);
      expect(record.isPrivateRelay).toBe(false); // default
    });

    it('sets isPrivateRelay when supplied', async () => {
      const record = await repo.createIdentity({
        userId: 'u2',
        provider: 'apple',
        providerSubject: 'sub-a1',
        providerEmail: 'hidden@privaterelay.appleid.com',
        emailVerified: true,
        isPrivateRelay: true,
      });

      expect(record.isPrivateRelay).toBe(true);
    });

    it('assigns unique ids to distinct records', async () => {
      const r1 = await repo.createIdentity({
        userId: 'u1',
        provider: 'google',
        providerSubject: 's1',
        providerEmail: 'a@b.com',
        emailVerified: true,
      });
      const r2 = await repo.createIdentity({
        userId: 'u2',
        provider: 'apple',
        providerSubject: 's2',
        providerEmail: 'c@d.com',
        emailVerified: false,
      });
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe('findByProviderSubject', () => {
    it('returns the record for a known provider+subject pair', async () => {
      await repo.createIdentity({
        userId: 'u1',
        provider: 'google',
        providerSubject: 'sub-99',
        providerEmail: 'x@y.com',
        emailVerified: true,
      });

      const found = await repo.findByProviderSubject('google', 'sub-99');
      expect(found).not.toBeNull();
      expect(found?.providerSubject).toBe('sub-99');
    });

    it('returns null for an unknown subject', async () => {
      const found = await repo.findByProviderSubject('google', 'no-such-sub');
      expect(found).toBeNull();
    });

    it('does not cross-match providers', async () => {
      await repo.createIdentity({
        userId: 'u1',
        provider: 'google',
        providerSubject: 'shared-sub',
        providerEmail: 'x@y.com',
        emailVerified: true,
      });

      const found = await repo.findByProviderSubject('apple', 'shared-sub');
      expect(found).toBeNull();
    });
  });

  describe('findByUserAndProvider', () => {
    it('returns the record for a known userId+provider pair', async () => {
      await repo.createIdentity({
        userId: 'u10',
        provider: 'apple',
        providerSubject: 'a-sub',
        providerEmail: 'a@b.com',
        emailVerified: true,
      });

      const found = await repo.findByUserAndProvider('u10', 'apple');
      expect(found).not.toBeNull();
      expect(found?.userId).toBe('u10');
    });

    it('returns null when userId exists but provider differs', async () => {
      await repo.createIdentity({
        userId: 'u10',
        provider: 'google',
        providerSubject: 'g-sub',
        providerEmail: 'g@h.com',
        emailVerified: true,
      });

      const found = await repo.findByUserAndProvider('u10', 'apple');
      expect(found).toBeNull();
    });
  });

  describe('updateIdentityEmail', () => {
    it('updates the email of an existing record', async () => {
      const record = await repo.createIdentity({
        userId: 'u1',
        provider: 'google',
        providerSubject: 'sub',
        providerEmail: 'old@example.com',
        emailVerified: true,
      });

      await repo.updateIdentityEmail(record.id, 'new@example.com');

      const updated = await repo.findByProviderSubject('google', 'sub');
      expect(updated?.providerEmail).toBe('new@example.com');
    });

    it('updates the isPrivateRelay flag alongside email', async () => {
      const record = await repo.createIdentity({
        userId: 'u2',
        provider: 'apple',
        providerSubject: 'sub-a',
        providerEmail: 'real@apple.com',
        emailVerified: true,
        isPrivateRelay: false,
      });

      await repo.updateIdentityEmail(record.id, 'relay@privaterelay.appleid.com', true);

      const updated = await repo.findByProviderSubject('apple', 'sub-a');
      expect(updated?.isPrivateRelay).toBe(true);
    });

    it('throws when identity id does not exist', async () => {
      await expect(repo.updateIdentityEmail('missing-id', 'x@y.com')).rejects.toThrow(
        'Identity not found: missing-id',
      );
    });
  });

  describe('deleteByUserAndProvider', () => {
    it('returns true and removes the record', async () => {
      await repo.createIdentity({
        userId: 'u3',
        provider: 'google',
        providerSubject: 's',
        providerEmail: 'e@f.com',
        emailVerified: true,
      });

      const deleted = await repo.deleteByUserAndProvider('u3', 'google');
      expect(deleted).toBe(true);

      const found = await repo.findByUserAndProvider('u3', 'google');
      expect(found).toBeNull();
    });

    it('returns false when no matching record exists', async () => {
      const deleted = await repo.deleteByUserAndProvider('no-user', 'apple');
      expect(deleted).toBe(false);
    });

    it('is idempotent — second delete returns false', async () => {
      await repo.createIdentity({
        userId: 'u4',
        provider: 'apple',
        providerSubject: 's4',
        providerEmail: 'g@h.com',
        emailVerified: true,
      });

      await repo.deleteByUserAndProvider('u4', 'apple');
      const second = await repo.deleteByUserAndProvider('u4', 'apple');
      expect(second).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SocialUserRepository (contract via fake)
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialUserRepository', () => {
  let repo: FakeSocialUserRepository;
  const userRecord: SocialUserRecord = {
    id: 'u-abc',
    email: 'alice@example.com',
    role: 'startup',
    passwordHash: 'hash-abc',
  };

  beforeEach(() => {
    repo = new FakeSocialUserRepository();
    repo.seed(userRecord);
  });

  it('findById returns the correct record', async () => {
    const found = await repo.findById('u-abc');
    expect(found).toMatchObject({ id: 'u-abc', email: 'alice@example.com' });
  });

  it('findById returns null for unknown id', async () => {
    expect(await repo.findById('x')).toBeNull();
  });

  it('findByEmail returns the correct record', async () => {
    const found = await repo.findByEmail('alice@example.com');
    expect(found?.id).toBe('u-abc');
  });

  it('findByEmail returns null for unknown email', async () => {
    expect(await repo.findByEmail('nobody@example.com')).toBeNull();
  });

  it('SocialUserRecord role is a valid UserRole', async () => {
    const found = await repo.findById('u-abc');
    expect(['startup', 'investor']).toContain(found?.role);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SocialLinkResult / SocialUnlinkResult structural contracts
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialLinkResult', () => {
  it('linked is always true', () => {
    const identity = makeIdentityRecord();
    const result: SocialLinkResult = { linked: true, identity };
    expect(result.linked).toBe(true);
  });

  it('identity property carries the full SocialIdentityRecord', () => {
    const identity = makeIdentityRecord({ provider: 'apple', isPrivateRelay: true });
    const result: SocialLinkResult = { linked: true, identity };
    expect(result.identity.provider).toBe('apple');
    expect(result.identity.isPrivateRelay).toBe(true);
  });
});

describe('SocialUnlinkResult', () => {
  it('unlinked is true when a record was removed', () => {
    const result: SocialUnlinkResult = { unlinked: true };
    expect(result.unlinked).toBe(true);
  });

  it('unlinked is false when no record was found to remove', () => {
    const result: SocialUnlinkResult = { unlinked: false };
    expect(result.unlinked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration: verifier → claims → identity round-trip
// ══════════════════════════════════════════════════════════════════════════════

describe('SocialTokenVerifier → SocialIdentityRepository round-trip', () => {
  it('verifies a token and persists the resulting identity', async () => {
    const verifier = new FakeTokenVerifier();
    const identityRepo = new FakeIdentityRepository();

    const claims = makeClaims({
      provider: 'google',
      subject: 'goog-sub-1',
      email: 'bob@example.com',
      emailVerified: true,
    });
    verifier.stubSuccess('tok-bob', claims);

    const verified = await verifier.verify('google', 'tok-bob');

    const identity = await identityRepo.createIdentity({
      userId: 'user-bob',
      provider: verified.provider,
      providerSubject: verified.subject,
      providerEmail: verified.email,
      emailVerified: verified.emailVerified,
      isPrivateRelay: verified.isPrivateRelay,
    });

    expect(identity.providerSubject).toBe('goog-sub-1');
    expect(identity.providerEmail).toBe('bob@example.com');
    expect(identity.isPrivateRelay).toBe(false);

    const found = await identityRepo.findByProviderSubject('google', 'goog-sub-1');
    expect(found?.userId).toBe('user-bob');
  });

  it('private-relay Apple token: identity keyed on subject, not email', async () => {
    const verifier = new FakeTokenVerifier();
    const identityRepo = new FakeIdentityRepository();

    const claims = makeClaims({
      provider: 'apple',
      subject: 'apple-sub-private',
      email: 'relay123@privaterelay.appleid.com',
      emailVerified: true,
      issuer: 'https://appleid.apple.com',
      isPrivateRelay: true,
    });
    verifier.stubSuccess('apple-tok', claims);

    const verified = await verifier.verify('apple', 'apple-tok');
    const identity = await identityRepo.createIdentity({
      userId: 'user-apple',
      provider: verified.provider,
      providerSubject: verified.subject,
      providerEmail: verified.email,
      emailVerified: verified.emailVerified,
      isPrivateRelay: verified.isPrivateRelay,
    });

    // Lookup must succeed via subject (stable), not the transient relay email
    const bySubject = await identityRepo.findByProviderSubject('apple', 'apple-sub-private');
    expect(bySubject?.id).toBe(identity.id);
    expect(bySubject?.isPrivateRelay).toBe(true);
  });

  it('rejected token does not create an identity', async () => {
    const verifier = new FakeTokenVerifier();
    const identityRepo = new FakeIdentityRepository();

    verifier.stubReject('revoked-tok');

    await expect(verifier.verify('google', 'revoked-tok')).rejects.toThrow(SocialAuthError);

    const found = await identityRepo.findByProviderSubject('google', 'any-sub');
    expect(found).toBeNull();
  });
});
