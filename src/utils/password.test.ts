import { createHash } from 'crypto';
import { hashPassword, comparePassword } from './password';

describe('hashPassword', () => {
  it('produces a salt:hash string', async () => {
    const hash = await hashPassword('mySecret1');
    expect(hash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
  });

  it('produces a different hash each time (random salt)', async () => {
    const h1 = await hashPassword('mySecret1');
    const h2 = await hashPassword('mySecret1');
    expect(h1).not.toBe(h2);
  });
});

describe('comparePassword', () => {
  it('returns true for the correct password (scrypt format)', async () => {
    const hash = await hashPassword('correctHorse99');
    expect(await comparePassword('correctHorse99', hash)).toBe(true);
  });

  it('returns false for an incorrect password (scrypt format)', async () => {
    const hash = await hashPassword('correctHorse99');
    expect(await comparePassword('wrongPassword', hash)).toBe(false);
  });

  it('returns false for a malformed hash', async () => {
    expect(await comparePassword('anything', 'not-a-valid-hash')).toBe(false);
  });

  it('supports legacy SHA-256 format for backward compatibility', async () => {
    const legacyHash = createHash('sha256').update('legacyPassword123').digest('hex');
    expect(await comparePassword('legacyPassword123', legacyHash)).toBe(true);
  });

  it('rejects wrong password against legacy SHA-256 hash', async () => {
    const legacyHash = createHash('sha256').update('legacyPassword123').digest('hex');
    expect(await comparePassword('wrongPassword', legacyHash)).toBe(false);
  });

  it('distinguishes between scrypt and legacy formats by colon presence', async () => {
    const scryptHash = await hashPassword('testPassword');
    const legacyHash = createHash('sha256').update('testPassword').digest('hex');

    expect(scryptHash).toContain(':');
    expect(legacyHash).not.toContain(':');

    expect(await comparePassword('testPassword', scryptHash)).toBe(true);
    expect(await comparePassword('testPassword', legacyHash)).toBe(true);
  });
});