import { hashPassword, verifyPassword } from "./hash";

const SALT_HEX_LENGTH = 32; // 16 random bytes
const DERIVED_KEY_HEX_LENGTH = 128; // scrypt 64-byte derived key

describe("hash :: hashPassword", () => {
  it("returns a hash in the salt:key hex format", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it("uses a 16-byte random salt and a 64-byte derived key", () => {
    const hash = hashPassword("correct horse battery staple");
    const [salt, key] = hash.split(":");
    expect(salt).toHaveLength(SALT_HEX_LENGTH);
    expect(key).toHaveLength(DERIVED_KEY_HEX_LENGTH);
  });

  it("produces a different hash each call for the same password", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    // The salts must differ so the derived keys differ too.
    expect(a.split(":")[0]).not.toBe(b.split(":")[0]);
  });

  it("accepts empty and boundary-length passwords", () => {
    expect(() => hashPassword("")).not.toThrow();
    expect(() => hashPassword("x".repeat(1))).not.toThrow();
    expect(() => hashPassword("x".repeat(1000))).not.toThrow();
  });
});

describe("hash :: verifyPassword", () => {
  it("returns true for the correct password", () => {
    const password = "hunter2-very-secret";
    const hash = hashPassword(password);
    expect(verifyPassword(password, hash)).toBe(true);
  });

  it("returns false for an incorrect password", () => {
    const hash = hashPassword("right-password");
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("round-trips different passwords independently", () => {
    const first = hashPassword("first-password");
    const second = hashPassword("second-password");
    expect(verifyPassword("first-password", first)).toBe(true);
    expect(verifyPassword("second-password", second)).toBe(true);
    expect(verifyPassword("second-password", first)).toBe(false);
    expect(verifyPassword("first-password", second)).toBe(false);
  });

  it("returns false for an empty password when a non-empty one was stored", () => {
    const hash = hashPassword("non-empty");
    expect(verifyPassword("", hash)).toBe(false);
  });

  it("returns false when passwords differ only by case", () => {
    const hash = hashPassword("Password123");
    expect(verifyPassword("password123", hash)).toBe(false);
  });

  it("throws on a hash without the salt:key separator", () => {
    const hash = hashPassword("some-password");
    const malformed = hash.split(":")[1]; // key hex with no salt prefix
    expect(() => verifyPassword("some-password", malformed)).toThrow();
  });

  it("throws on a key segment that is not valid hex", () => {
    const hash = hashPassword("some-password");
    const salt = hash.split(":")[0];
    const malformed = `${salt}:not-a-hex-key!`;
    expect(() => verifyPassword("some-password", malformed)).toThrow();
  });

  it("throws on a key length that differs from the derived key", () => {
    const hash = hashPassword("some-password");
    const salt = hash.split(":")[0];
    const shortKey = "a".repeat(16);
    expect(() => verifyPassword("some-password", `${salt}:${shortKey}`)).toThrow();
  });
});