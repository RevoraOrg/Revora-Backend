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
  it('returns true for the correct password', async () => {
    const hash = await hashPassword('correctHorse99');
    expect(await comparePassword('correctHorse99', hash)).toBe(true);
  });

  it('returns false for an incorrect password', async () => {
    const hash = await hashPassword('correctHorse99');
    expect(await comparePassword('wrongPassword', hash)).toBe(false);
  });

  it('returns false for a malformed hash', async () => {
    expect(await comparePassword('anything', 'not-a-valid-hash')).toBe(false);
  });
});