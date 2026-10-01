/**
 * Dedicated test suite for src/auth/social/types.ts
 *
 * Covers:
 *   - SocialAuthProvider: valid values, exhaustive union, type narrowing
 *   - SocialProviderClaims: required fields, optional isPrivateRelay, field types
 *   - SocialTokenVerifier: contract verification via fake implementations,
 *     resolve and reject paths, Apple private-relay handling
 *   - SocialIdentityRecord: field contract, default isPrivateRelay semantics
 *   - SocialIdentityRepository: CRUD contract via fake implementation
 *   - SocialUserRecord / SocialUserRepository: lookup contract
 *   - SocialAuthErrorCode: exhaustive set, no unknown codes accepted at compile time
 *   - SocialAuthError: construction, `code`, `message`, `name`, prototype chain,
 *     instanceof checks across serialization boundaries, all valid error codes
 *   - SocialLinkResult / SocialUnlinkResult: shape contract
 *   - SocialLoginResult: structural compatibility with LoginSuccessResponse
 */

import {
  SocialAuthError,
  SocialAuthErrorCode,
  SocialAuthProvider,
  SocialIdentityRecord,
  SocialIdentityRepository,
  SocialLinkResult,
  SocialLoginResult,
  SocialProviderClaims,
  SocialTokenVerifier,
  SocialUnlinkResult,
  SocialUserRecord,
  SocialUserRepository,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers / Fakes
// ─────────────────────────────────────────────────────────────────────────────

function makeIdentityRecord(
  overrides: Partial<SocialIdentityRecord> = {},
): SocialIdentityRecord {
  return {
    id: 'identity-1',
    userId: 'user-1',
    provider: 'google',
    providerSubject: 'sub-001',
    providerEmail: 'alice@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeProviderClaims(
  overrides: Partial<SocialProviderClaims> = {},
): SocialProviderClaims {
  return {
    provider: 'google',
    subject: 'sub-001',
    email: 'alice@example.com',
    emailVerified: true,
    issuer: 'https://accounts.google.com',
    audience: 'client-id',
    ...overrides,
  };
}

/** Fake implementation of SocialTokenVerifier used throughout these tests. */
class FakeTokenVerifier implements SocialTokenVerifier {
  private readonly claimsOrError: SocialProviderClaims | Error;

  constructor(claimsOrError: SocialProviderClaims | Error) {
    this.claimsOrError = claimsOrError;
  }

  async verify(
    _provider: SocialAuthProvider,
    _idToken: string,
  ): Promise<SocialProviderClaims> {
    if (this.claimsOrError instanceof Error) {
      throw this.claimsOrError;
    }
    return this.claimsOrError;
  }
}

/** Fake implementation of SocialIdentityRepository used throughout these tests. */
class FakeIdentityRepository implements SocialIdentityRepository {
  private store = new Map<string, SocialIdentityRecord>();
  private nextId = 1;

  seed(record: SocialIdentityRecord): void {
    this.store.set(record.id, record);
  }

  async findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string,
  ): Promise<SocialIdentityRecord | null> {
    for (const rec of this.store.values()) {
      if (rec.provider === provider && rec.providerSubject === providerSubject) {
        return rec;
      }
    }
    return null;
  }

  async findByUserAndProvider(
    userId: string,
    provider: SocialAuthProvider,
  ): Promise<SocialIdentityRecord | null> {
    for (const rec of this.store.values()) {
      if (rec.userId === userId && rec.provider === provider) {
        return rec;
      }
    }
    return null;
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
    const rec = this.store.get(id);
    if (rec) {
      rec.providerEmail = providerEmail;
      rec.updatedAt = new Date();
      if (isPrivateRelay !== undefined) {
        rec.isPrivateRelay = isPrivateRelay;
      }
    }
  }

  async deleteByUserAndProvider(
    userId: string,
    provider: SocialAuthProvider,
  ): Promise<boolean> {
    for (const [key, rec] of this.store.entries()) {
      if (rec.userId === userId && rec.provider === provider) {
        this.store.delete(key);
        return true;
      }
    }
    return false;
  }
}

/** Fake implementation of SocialUserRepository. */
class FakeUserRepository implements SocialUserRepository {
  private store = new Map<string, SocialUserRecord>();

  seed(record: SocialUserRecord): void {
    this.store.set(record.id, record);
  }

  async findById(id: string): Promise<SocialUserRecord | null> {
    return this.store.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<SocialUserRecord | null> {
    for (const rec of this.store.values()) {
      if (rec.email === email) return rec;
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SocialAuthProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialAuthProvider', () => {
  it('accepts "google" as a valid provider value', () => {
    const provider: SocialAuthProvider = 'google';
    expect(provider).toBe('google');
  });

  it('accepts "apple" as a valid provider value', () => {
    const provider: SocialAuthProvider = 'apple';
    expect(provider).toBe('apple');
  });

  it('covers the full set of valid provider literals', () => {
    const validProviders: SocialAuthProvider[] = ['google', 'apple'];
    expect(validProviders).toHaveLength(2);
    expect(validProviders).toContain('google');
    expect(validProviders).toContain('apple');
  });

  it('is usable as a map key to distinguish providers', () => {
    const providerLabels: Record<SocialAuthProvider, string> = {
      google: 'Google',
      apple: 'Apple',
    };
    expect(providerLabels['google']).toBe('Google');
    expect(providerLabels['apple']).toBe('Apple');
  });

  it('is a string at runtime (not an object or number)', () => {
    const p: SocialAuthProvider = 'google';
    expect(typeof p).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialProviderClaims
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialProviderClaims', () => {
  describe('required fields', () => {
    it('holds all required fields for a Google token', () => {
      const claims = makeProviderClaims();
      expect(claims.provider).toBe('google');
      expect(claims.subject).toBe('sub-001');
      expect(claims.email).toBe('alice@example.com');
      expect(claims.emailVerified).toBe(true);
      expect(claims.issuer).toBe('https://accounts.google.com');
      expect(claims.audience).toBe('client-id');
    });

    it('holds all required fields for an Apple token', () => {
      const claims = makeProviderClaims({
        provider: 'apple',
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.app',
      });
      expect(claims.provider).toBe('apple');
      expect(claims.issuer).toBe('https://appleid.apple.com');
      expect(claims.audience).toBe('com.example.app');
    });

    it('emailVerified can be false for unverified accounts', () => {
      const claims = makeProviderClaims({ emailVerified: false });
      expect(claims.emailVerified).toBe(false);
    });

    it('subject is a non-empty string', () => {
      const claims = makeProviderClaims({ subject: 'unique-subject-42' });
      expect(typeof claims.subject).toBe('string');
      expect(claims.subject.length).toBeGreaterThan(0);
    });
  });

  describe('optional isPrivateRelay field', () => {
    it('is absent by default (undefined) when not provided', () => {
      const claims = makeProviderClaims();
      expect(claims.isPrivateRelay).toBeUndefined();
    });

    it('accepts true for Apple Hide My Email private-relay addresses', () => {
      const claims = makeProviderClaims({
        provider: 'apple',
        email: 'abc123@privaterelay.appleid.com',
        isPrivateRelay: true,
      });
      expect(claims.isPrivateRelay).toBe(true);
    });

    it('accepts false for non-relay Apple addresses', () => {
      const claims = makeProviderClaims({
        provider: 'apple',
        isPrivateRelay: false,
      });
      expect(claims.isPrivateRelay).toBe(false);
    });

    it('indicates a relay address is transient and should not be used for lookup', () => {
      // The @notice on the interface says account lookup must key on `subject`.
      const relay = makeProviderClaims({
        provider: 'apple',
        subject: 'stable-sub-abc',
        email: 'transient@privaterelay.appleid.com',
        isPrivateRelay: true,
      });
      const nonRelay = makeProviderClaims({
        provider: 'apple',
        subject: 'stable-sub-abc',
        email: 'real@example.com',
        isPrivateRelay: false,
      });
      // Both share the same stable subject; the lookup key is `subject`, not email.
      expect(relay.subject).toBe(nonRelay.subject);
    });
  });

  describe('field types', () => {
    it('email is a string', () => {
      const claims = makeProviderClaims();
      expect(typeof claims.email).toBe('string');
    });

    it('issuer is a string (URL)', () => {
      const claims = makeProviderClaims();
      expect(typeof claims.issuer).toBe('string');
    });

    it('audience is a string', () => {
      const claims = makeProviderClaims();
      expect(typeof claims.audience).toBe('string');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialTokenVerifier
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialTokenVerifier', () => {
  describe('successful verification', () => {
    it('resolves with SocialProviderClaims for a valid Google token', async () => {
      const expected = makeProviderClaims();
      const verifier = new FakeTokenVerifier(expected);

      const result = await verifier.verify('google', 'valid-id-token');

      expect(result).toEqual(expected);
    });

    it('resolves with SocialProviderClaims for a valid Apple token', async () => {
      const expected = makeProviderClaims({
        provider: 'apple',
        issuer: 'https://appleid.apple.com',
        audience: 'com.example.app',
        isPrivateRelay: false,
      });
      const verifier = new FakeTokenVerifier(expected);

      const result = await verifier.verify('apple', 'valid-apple-id-token');

      expect(result.provider).toBe('apple');
      expect(result.subject).toBe(expected.subject);
      expect(result.email).toBe(expected.email);
      expect(result.emailVerified).toBe(expected.emailVerified);
    });

    it('returns isPrivateRelay=true for Apple Hide My Email tokens', async () => {
      const expected = makeProviderClaims({
        provider: 'apple',
        email: 'relay@privaterelay.appleid.com',
        isPrivateRelay: true,
      });
      const verifier = new FakeTokenVerifier(expected);

      const result = await verifier.verify('apple', 'apple-relay-token');

      expect(result.isPrivateRelay).toBe(true);
    });

    it('returns isPrivateRelay=false when Apple token has no private relay', async () => {
      const expected = makeProviderClaims({
        provider: 'apple',
        email: 'real@example.com',
        isPrivateRelay: false,
      });
      const verifier = new FakeTokenVerifier(expected);

      const result = await verifier.verify('apple', 'apple-real-token');

      expect(result.isPrivateRelay).toBe(false);
    });

    it('returns emailVerified=false when the provider reports an unverified email', async () => {
      const expected = makeProviderClaims({ emailVerified: false });
      const verifier = new FakeTokenVerifier(expected);

      const result = await verifier.verify('google', 'unverified-token');

      expect(result.emailVerified).toBe(false);
    });
  });

  describe('failure paths', () => {
    it('rejects with SocialAuthError code INVALID_TOKEN for an invalid token', async () => {
      const error = new SocialAuthError('INVALID_TOKEN', 'Token signature invalid');
      const verifier = new FakeTokenVerifier(error);

      await expect(verifier.verify('google', 'bad-token')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects with SocialAuthError code PROVIDER_NOT_CONFIGURED when provider is not set up', async () => {
      const error = new SocialAuthError(
        'PROVIDER_NOT_CONFIGURED',
        'Provider "google" is not configured',
      );
      const verifier = new FakeTokenVerifier(error);

      await expect(verifier.verify('google', 'any-token')).rejects.toMatchObject({
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    });

    it('rejects with SocialAuthError code INVALID_PROVIDER for an unknown provider string', async () => {
      const error = new SocialAuthError('INVALID_PROVIDER', 'Unknown provider');
      const verifier = new FakeTokenVerifier(error);

      await expect(verifier.verify('google', 'any-token')).rejects.toMatchObject({
        code: 'INVALID_PROVIDER',
      });
    });

    it('propagates non-SocialAuthError errors without wrapping', async () => {
      const networkError = new Error('Network timeout');
      const verifier = new FakeTokenVerifier(networkError);

      await expect(verifier.verify('google', 'any-token')).rejects.toThrow(
        'Network timeout',
      );
    });

    it('rejects with UNVERIFIED_EMAIL code when verifier detects unverified state', async () => {
      const error = new SocialAuthError('UNVERIFIED_EMAIL', 'Email not verified');
      const verifier = new FakeTokenVerifier(error);

      await expect(verifier.verify('apple', 'unverified-token')).rejects.toMatchObject({
        code: 'UNVERIFIED_EMAIL',
      });
    });
  });

  describe('contract: verify() signature', () => {
    it('is called with provider and idToken arguments', async () => {
      const claims = makeProviderClaims();
      const verifier = new FakeTokenVerifier(claims);
      const verifySpy = jest.spyOn(verifier, 'verify');

      await verifier.verify('google', 'test-id-token');

      expect(verifySpy).toHaveBeenCalledWith('google', 'test-id-token');
    });

    it('returns a Promise', () => {
      const verifier = new FakeTokenVerifier(makeProviderClaims());
      const result = verifier.verify('google', 'token');
      expect(result).toBeInstanceOf(Promise);
    });

    it('resolves the provider field in claims to match the requested provider', async () => {
      const googleClaims = makeProviderClaims({ provider: 'google' });
      const verifier = new FakeTokenVerifier(googleClaims);

      const result = await verifier.verify('google', 'token');
      expect(result.provider).toBe('google');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialAuthError
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialAuthError', () => {
  describe('construction', () => {
    it('stores the code on the instance', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'bad token');
      expect(err.code).toBe('INVALID_TOKEN');
    });

    it('stores the message on the instance', () => {
      const err = new SocialAuthError('USER_NOT_FOUND', 'User not found');
      expect(err.message).toBe('User not found');
    });

    it('sets name to "SocialAuthError"', () => {
      const err = new SocialAuthError('INVALID_PROVIDER', 'Unknown provider');
      expect(err.name).toBe('SocialAuthError');
    });

    it('extends Error', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'bad token');
      expect(err).toBeInstanceOf(Error);
    });

    it('is instanceof SocialAuthError', () => {
      const err = new SocialAuthError('INVALID_TOKEN', 'bad token');
      expect(err).toBeInstanceOf(SocialAuthError);
    });
  });

  describe('prototype chain integrity', () => {
    it('instanceof check succeeds after round-tripping through catch(e)', async () => {
      let caught: unknown;
      try {
        throw new SocialAuthError('STEP_UP_REQUIRED', 'Step-up required');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SocialAuthError);
    });

    it('instanceof check succeeds after being stored in a variable of type Error', () => {
      const err: Error = new SocialAuthError('INVALID_TOKEN', 'bad token');
      expect(err).toBeInstanceOf(SocialAuthError);
    });

    it('instanceof check succeeds even after Object.setPrototypeOf fix', () => {
      // Verifies that the constructor correctly calls Object.setPrototypeOf
      const err = new SocialAuthError('INVALID_TOKEN', 'test');
      expect(err instanceof SocialAuthError).toBe(true);
      expect(err instanceof Error).toBe(true);
    });
  });

  describe('all valid error codes', () => {
    const allCodes: SocialAuthErrorCode[] = [
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

    it.each(allCodes)('constructs successfully with code "%s"', (code) => {
      const err = new SocialAuthError(code, `Error: ${code}`);
      expect(err.code).toBe(code);
      expect(err.name).toBe('SocialAuthError');
      expect(err.message).toBe(`Error: ${code}`);
      expect(err).toBeInstanceOf(SocialAuthError);
    });

    it('covers 9 distinct error codes', () => {
      expect(allCodes).toHaveLength(9);
    });
  });

  describe('code field is readonly', () => {
    it('preserves the original code after construction', () => {
      const err = new SocialAuthError('USER_NOT_FOUND', 'msg');
      // TypeScript marks code as readonly; verify the value is stable at runtime.
      expect(err.code).toBe('USER_NOT_FOUND');
      expect(err.code).toBe('USER_NOT_FOUND'); // stable on repeated read
    });
  });

  describe('observable in rejects', () => {
    it('can be matched via .rejects.toMatchObject with code and message', async () => {
      const throwIt = async () => {
        throw new SocialAuthError('EMAIL_ACCOUNT_REQUIRES_LINK', 'Email exists');
      };
      await expect(throwIt()).rejects.toMatchObject({
        code: 'EMAIL_ACCOUNT_REQUIRES_LINK',
        message: 'Email exists',
        name: 'SocialAuthError',
      });
    });

    it('can be matched via .rejects.toBeInstanceOf', async () => {
      const throwIt = async () => {
        throw new SocialAuthError('IDENTITY_LINKED_TO_ANOTHER_USER', 'Already linked');
      };
      await expect(throwIt()).rejects.toBeInstanceOf(SocialAuthError);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialAuthErrorCode exhaustive check
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialAuthErrorCode', () => {
  it('contains INVALID_PROVIDER', () => {
    const code: SocialAuthErrorCode = 'INVALID_PROVIDER';
    expect(code).toBe('INVALID_PROVIDER');
  });

  it('contains PROVIDER_NOT_CONFIGURED', () => {
    const code: SocialAuthErrorCode = 'PROVIDER_NOT_CONFIGURED';
    expect(code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('contains INVALID_TOKEN', () => {
    const code: SocialAuthErrorCode = 'INVALID_TOKEN';
    expect(code).toBe('INVALID_TOKEN');
  });

  it('contains UNVERIFIED_EMAIL', () => {
    const code: SocialAuthErrorCode = 'UNVERIFIED_EMAIL';
    expect(code).toBe('UNVERIFIED_EMAIL');
  });

  it('contains SOCIAL_IDENTITY_NOT_LINKED', () => {
    const code: SocialAuthErrorCode = 'SOCIAL_IDENTITY_NOT_LINKED';
    expect(code).toBe('SOCIAL_IDENTITY_NOT_LINKED');
  });

  it('contains EMAIL_ACCOUNT_REQUIRES_LINK', () => {
    const code: SocialAuthErrorCode = 'EMAIL_ACCOUNT_REQUIRES_LINK';
    expect(code).toBe('EMAIL_ACCOUNT_REQUIRES_LINK');
  });

  it('contains USER_NOT_FOUND', () => {
    const code: SocialAuthErrorCode = 'USER_NOT_FOUND';
    expect(code).toBe('USER_NOT_FOUND');
  });

  it('contains STEP_UP_REQUIRED', () => {
    const code: SocialAuthErrorCode = 'STEP_UP_REQUIRED';
    expect(code).toBe('STEP_UP_REQUIRED');
  });

  it('contains IDENTITY_LINKED_TO_ANOTHER_USER', () => {
    const code: SocialAuthErrorCode = 'IDENTITY_LINKED_TO_ANOTHER_USER';
    expect(code).toBe('IDENTITY_LINKED_TO_ANOTHER_USER');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialIdentityRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialIdentityRecord', () => {
  it('has the expected shape for a Google identity', () => {
    const rec = makeIdentityRecord();
    expect(typeof rec.id).toBe('string');
    expect(typeof rec.userId).toBe('string');
    expect(rec.provider).toBe('google');
    expect(typeof rec.providerSubject).toBe('string');
    expect(typeof rec.providerEmail).toBe('string');
    expect(typeof rec.emailVerified).toBe('boolean');
    expect(typeof rec.isPrivateRelay).toBe('boolean');
    expect(rec.createdAt).toBeInstanceOf(Date);
    expect(rec.updatedAt).toBeInstanceOf(Date);
  });

  it('has the expected shape for an Apple identity with private relay', () => {
    const rec = makeIdentityRecord({
      provider: 'apple',
      providerEmail: 'relay@privaterelay.appleid.com',
      isPrivateRelay: true,
    });
    expect(rec.provider).toBe('apple');
    expect(rec.isPrivateRelay).toBe(true);
  });

  it('isPrivateRelay defaults to false for non-relay addresses', () => {
    const rec = makeIdentityRecord({ isPrivateRelay: false });
    expect(rec.isPrivateRelay).toBe(false);
  });

  it('updatedAt is a Date and can differ from createdAt after an update', () => {
    const rec = makeIdentityRecord({
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-06-01T00:00:00.000Z'),
    });
    expect(rec.updatedAt.getTime()).toBeGreaterThan(rec.createdAt.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialIdentityRepository (via FakeIdentityRepository)
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialIdentityRepository', () => {
  let repo: FakeIdentityRepository;

  beforeEach(() => {
    repo = new FakeIdentityRepository();
  });

  describe('findByProviderSubject', () => {
    it('returns null when no identity exists', async () => {
      const result = await repo.findByProviderSubject('google', 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns the record when a matching identity exists', async () => {
      const rec = makeIdentityRecord({
        provider: 'google',
        providerSubject: 'sub-google-1',
      });
      repo.seed(rec);

      const result = await repo.findByProviderSubject('google', 'sub-google-1');
      expect(result).not.toBeNull();
      expect(result?.providerSubject).toBe('sub-google-1');
    });

    it('does not return a record when provider does not match', async () => {
      repo.seed(makeIdentityRecord({ provider: 'google', providerSubject: 'sub-1' }));

      const result = await repo.findByProviderSubject('apple', 'sub-1');
      expect(result).toBeNull();
    });
  });

  describe('findByUserAndProvider', () => {
    it('returns null when no identity exists', async () => {
      const result = await repo.findByUserAndProvider('user-99', 'google');
      expect(result).toBeNull();
    });

    it('returns the record when a matching identity exists', async () => {
      repo.seed(makeIdentityRecord({ userId: 'user-1', provider: 'google' }));

      const result = await repo.findByUserAndProvider('user-1', 'google');
      expect(result).not.toBeNull();
      expect(result?.userId).toBe('user-1');
    });

    it('does not return a record for a different user', async () => {
      repo.seed(makeIdentityRecord({ userId: 'user-1', provider: 'google' }));

      const result = await repo.findByUserAndProvider('user-2', 'google');
      expect(result).toBeNull();
    });
  });

  describe('createIdentity', () => {
    it('creates and returns a new identity record', async () => {
      const created = await repo.createIdentity({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'new-sub',
        providerEmail: 'new@example.com',
        emailVerified: true,
      });

      expect(created.id).toBeDefined();
      expect(created.userId).toBe('user-1');
      expect(created.provider).toBe('google');
      expect(created.providerSubject).toBe('new-sub');
      expect(created.providerEmail).toBe('new@example.com');
      expect(created.emailVerified).toBe(true);
      expect(created.isPrivateRelay).toBe(false); // default
    });

    it('stores isPrivateRelay=true when explicitly provided', async () => {
      const created = await repo.createIdentity({
        userId: 'user-1',
        provider: 'apple',
        providerSubject: 'apple-sub',
        providerEmail: 'relay@privaterelay.appleid.com',
        emailVerified: true,
        isPrivateRelay: true,
      });

      expect(created.isPrivateRelay).toBe(true);
    });

    it('returns a record with createdAt and updatedAt as Dates', async () => {
      const created = await repo.createIdentity({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'sub-99',
        providerEmail: 'test@example.com',
        emailVerified: true,
      });

      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
    });

    it('is retrievable via findByProviderSubject after creation', async () => {
      await repo.createIdentity({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'lookup-sub',
        providerEmail: 'test@example.com',
        emailVerified: true,
      });

      const found = await repo.findByProviderSubject('google', 'lookup-sub');
      expect(found).not.toBeNull();
      expect(found?.userId).toBe('user-1');
    });
  });

  describe('updateIdentityEmail', () => {
    it('updates the providerEmail on an existing record', async () => {
      const created = await repo.createIdentity({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'sub-1',
        providerEmail: 'old@example.com',
        emailVerified: true,
      });

      await repo.updateIdentityEmail(created.id, 'new@example.com');

      const updated = await repo.findByUserAndProvider('user-1', 'google');
      expect(updated?.providerEmail).toBe('new@example.com');
    });

    it('updates isPrivateRelay when provided', async () => {
      const created = await repo.createIdentity({
        userId: 'user-1',
        provider: 'apple',
        providerSubject: 'apple-sub',
        providerEmail: 'first-relay@privaterelay.appleid.com',
        emailVerified: true,
        isPrivateRelay: true,
      });

      await repo.updateIdentityEmail(
        created.id,
        'second-relay@privaterelay.appleid.com',
        true,
      );

      const updated = await repo.findByUserAndProvider('user-1', 'apple');
      expect(updated?.providerEmail).toBe('second-relay@privaterelay.appleid.com');
      expect(updated?.isPrivateRelay).toBe(true);
    });

    it('does not change isPrivateRelay when argument is omitted', async () => {
      const created = await repo.createIdentity({
        userId: 'user-1',
        provider: 'apple',
        providerSubject: 'sub-stable',
        providerEmail: 'relay@privaterelay.appleid.com',
        emailVerified: true,
        isPrivateRelay: true,
      });

      await repo.updateIdentityEmail(created.id, 'still-relay@privaterelay.appleid.com');

      const updated = await repo.findByUserAndProvider('user-1', 'apple');
      expect(updated?.isPrivateRelay).toBe(true); // unchanged
    });

    it('silently ignores unknown record ids', async () => {
      // Must not throw — the operation is a no-op for unknown ids
      await expect(
        repo.updateIdentityEmail('nonexistent-id', 'any@example.com'),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteByUserAndProvider', () => {
    it('returns true when an identity is deleted', async () => {
      await repo.createIdentity({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'sub-del',
        providerEmail: 'del@example.com',
        emailVerified: true,
      });

      const result = await repo.deleteByUserAndProvider('user-1', 'google');
      expect(result).toBe(true);
    });

    it('returns false when no identity exists to delete', async () => {
      const result = await repo.deleteByUserAndProvider('user-99', 'google');
      expect(result).toBe(false);
    });

    it('record is no longer findable after deletion', async () => {
      await repo.createIdentity({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'sub-2',
        providerEmail: 'user1@example.com',
        emailVerified: true,
      });

      await repo.deleteByUserAndProvider('user-1', 'google');

      const found = await repo.findByUserAndProvider('user-1', 'google');
      expect(found).toBeNull();
    });

    it('is idempotent: second delete returns false', async () => {
      await repo.createIdentity({
        userId: 'user-1',
        provider: 'apple',
        providerSubject: 'apple-sub',
        providerEmail: 'u@example.com',
        emailVerified: true,
      });

      await repo.deleteByUserAndProvider('user-1', 'apple');
      const result = await repo.deleteByUserAndProvider('user-1', 'apple');
      expect(result).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialUserRecord / SocialUserRepository
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialUserRepository', () => {
  let repo: FakeUserRepository;

  beforeEach(() => {
    repo = new FakeUserRepository();
  });

  describe('findById', () => {
    it('returns null for an unknown id', async () => {
      expect(await repo.findById('unknown')).toBeNull();
    });

    it('returns the record for a known id', async () => {
      const user: SocialUserRecord = {
        id: 'user-1',
        email: 'alice@example.com',
        role: 'investor',
        passwordHash: 'hash-abc',
      };
      repo.seed(user);

      const found = await repo.findById('user-1');
      expect(found).toEqual(user);
    });
  });

  describe('findByEmail', () => {
    it('returns null for an unknown email', async () => {
      expect(await repo.findByEmail('nobody@example.com')).toBeNull();
    });

    it('returns the record for a known email', async () => {
      const user: SocialUserRecord = {
        id: 'user-2',
        email: 'bob@example.com',
        role: 'startup',
        passwordHash: 'hash-xyz',
      };
      repo.seed(user);

      const found = await repo.findByEmail('bob@example.com');
      expect(found).toEqual(user);
    });
  });

  describe('SocialUserRecord shape', () => {
    it('stores role as "startup"', () => {
      const user: SocialUserRecord = {
        id: 'u1',
        email: 'startup@example.com',
        role: 'startup',
        passwordHash: 'h',
      };
      expect(user.role).toBe('startup');
    });

    it('stores role as "investor"', () => {
      const user: SocialUserRecord = {
        id: 'u2',
        email: 'investor@example.com',
        role: 'investor',
        passwordHash: 'h',
      };
      expect(user.role).toBe('investor');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialLinkResult
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialLinkResult', () => {
  it('has linked=true and a valid identity record', () => {
    const result: SocialLinkResult = {
      linked: true,
      identity: makeIdentityRecord(),
    };
    expect(result.linked).toBe(true);
    expect(result.identity).toBeDefined();
    expect(result.identity.provider).toBe('google');
  });

  it('preserves identity isPrivateRelay for Apple private-relay results', () => {
    const result: SocialLinkResult = {
      linked: true,
      identity: makeIdentityRecord({
        provider: 'apple',
        providerEmail: 'relay@privaterelay.appleid.com',
        isPrivateRelay: true,
      }),
    };
    expect(result.identity.isPrivateRelay).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialUnlinkResult
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialUnlinkResult', () => {
  it('has unlinked=true when a link was successfully removed', () => {
    const result: SocialUnlinkResult = { unlinked: true };
    expect(result.unlinked).toBe(true);
  });

  it('has unlinked=false when no link existed (idempotent unlink)', () => {
    const result: SocialUnlinkResult = { unlinked: false };
    expect(result.unlinked).toBe(false);
  });

  it('unlinked field is a boolean', () => {
    expect(typeof ({ unlinked: true } as SocialUnlinkResult).unlinked).toBe('boolean');
    expect(typeof ({ unlinked: false } as SocialUnlinkResult).unlinked).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SocialLoginResult (alias for LoginSuccessResponse)
// ─────────────────────────────────────────────────────────────────────────────

describe('SocialLoginResult', () => {
  it('conforms to the LoginSuccessResponse shape', () => {
    const result: SocialLoginResult = {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        role: 'investor',
      },
    };
    expect(result.accessToken).toBe('access-abc');
    expect(result.refreshToken).toBe('refresh-xyz');
    expect(result.user.id).toBe('user-1');
    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.role).toBe('investor');
  });

  it('user.role can be "startup"', () => {
    const result: SocialLoginResult = {
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: 'u1', email: 'e@x.com', role: 'startup' },
    };
    expect(result.user.role).toBe('startup');
  });

  it('accessToken and refreshToken are strings', () => {
    const result: SocialLoginResult = {
      accessToken: 'access',
      refreshToken: 'refresh',
      user: { id: 'u', email: 'e@x.com', role: 'investor' },
    };
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary / cross-cutting: invalid representative inputs
// ─────────────────────────────────────────────────────────────────────────────

describe('boundary and invalid inputs', () => {
  describe('SocialTokenVerifier with empty token string', () => {
    it('rejects an empty idToken with INVALID_TOKEN', async () => {
      const error = new SocialAuthError('INVALID_TOKEN', 'Token must not be empty');
      const verifier = new FakeTokenVerifier(error);

      await expect(verifier.verify('google', '')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });
  });

  describe('SocialAuthError with empty message', () => {
    it('accepts an empty string message without throwing', () => {
      const err = new SocialAuthError('INVALID_TOKEN', '');
      expect(err.message).toBe('');
      expect(err.code).toBe('INVALID_TOKEN');
    });
  });

  describe('SocialProviderClaims with empty subject', () => {
    it('constructs but would fail verification downstream', () => {
      // The type allows an empty string; rejection is the verifier's responsibility.
      const claims = makeProviderClaims({ subject: '' });
      expect(claims.subject).toBe('');
    });
  });

  describe('SocialIdentityRepository with unknown provider string at runtime', () => {
    it('findByProviderSubject returns null for an unrecognised provider at runtime', async () => {
      const repo = new FakeIdentityRepository();
      repo.seed(makeIdentityRecord({ provider: 'google', providerSubject: 'sub' }));
      // Cast to exercise the runtime path an untrusted caller might trigger
      const result = await repo.findByProviderSubject(
        'facebook' as SocialAuthProvider,
        'sub',
      );
      expect(result).toBeNull();
    });
  });

  describe('concurrent createIdentity calls', () => {
    it('creates distinct records with unique ids', async () => {
      const repo = new FakeIdentityRepository();
      const [a, b] = await Promise.all([
        repo.createIdentity({
          userId: 'user-1',
          provider: 'google',
          providerSubject: 'sub-a',
          providerEmail: 'a@example.com',
          emailVerified: true,
        }),
        repo.createIdentity({
          userId: 'user-2',
          provider: 'google',
          providerSubject: 'sub-b',
          providerEmail: 'b@example.com',
          emailVerified: true,
        }),
      ]);
      expect(a.id).not.toBe(b.id);
    });
  });
});
