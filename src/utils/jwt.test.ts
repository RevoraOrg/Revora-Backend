import { signJwt, verifyJwt } from './jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
});

describe('signJwt / verifyJwt', () => {
  it('round-trips: sign then verify returns the payload', () => {
    const token = signJwt({ sub: 'user-1', sid: 'session-1' });
    const payload = verifyJwt(token);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-1');
    expect(payload!.sid).toBe('session-1');
  });

  it('returns null for a tampered token', () => {
    const token = signJwt({ sub: 'user-1', sid: 'session-1' });
    const tampered = token.slice(0, -4) + 'xxxx';
    expect(verifyJwt(tampered)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const token = signJwt({ sub: 'user-1', sid: 'session-1' }, -1); // already expired
    expect(verifyJwt(token)).toBeNull();
  });

  it('returns null for a malformed string', () => {
    expect(verifyJwt('not.a.token')).toBeNull();
    expect(verifyJwt('')).toBeNull();
  });

  it('throws if JWT_SECRET is not set', () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => signJwt({ sub: 'u', sid: 's' })).toThrow('JWT_SECRET');
    process.env.JWT_SECRET = original;
  });
});