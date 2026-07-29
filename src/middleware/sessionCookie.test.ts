/**
 * @file src/middleware/sessionCookie.test.ts
 * @description
 * Tests for the hardened session cookie issuer.
 *
 * Security invariants verified:
 *  - Every issued cookie carries HttpOnly, SameSite=Lax (or Strict), and Path=/.
 *  - In production the Secure attribute is mandatory; a non-Secure cookie is
 *    refused (throws).
 *  - The clear cookie expires the session immediately (Max-Age=0).
 */

import {
  buildSessionCookie,
  clearSessionCookie,
  issueSessionCookie,
  SESSION_COOKIE_NAME,
} from "./session";

const FUTURE = Date.now() + 60_000;

describe("buildSessionCookie", () => {
  it("always sets HttpOnly, SameSite=Lax by default and Path=/", () => {
    const cookie = buildSessionCookie("tok123", FUTURE, { isProduction: false });

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("can be configured to SameSite=Strict", () => {
    const cookie = buildSessionCookie("tok123", FUTURE, { isProduction: false, sameSite: 'Strict' });
    expect(cookie).toContain("SameSite=Strict");
  });

  it("sets the Secure attribute in production", () => {
    const cookie = buildSessionCookie("tok123", FUTURE, { isProduction: true });
    expect(cookie).toContain("Secure");
  });

  it("omits Secure in development by default", () => {
    const cookie = buildSessionCookie("tok123", FUTURE, { isProduction: false });
    expect(cookie).not.toContain("Secure");
  });

  it("refuses to issue a non-Secure cookie in production", () => {
    expect(() =>
      buildSessionCookie("tok123", FUTURE, { isProduction: true, secure: false }),
    ).toThrow(/Secure/i);
  });

  it("allows an explicitly Secure cookie in production", () => {
    expect(() =>
      buildSessionCookie("tok123", FUTURE, { isProduction: true, secure: true }),
    ).not.toThrow();
  });

  it("clamps a past expiry to Max-Age=0", () => {
    const cookie = buildSessionCookie("tok123", Date.now() - 10_000, {
      isProduction: false,
    });
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("issueSessionCookie", () => {
  it("appends a Set-Cookie header to the response", () => {
    const appended: Array<[string, string]> = [];
    const res = {
      append: (name: string, value: string) => appended.push([name, value]),
    } as any;

    issueSessionCookie(res, "tok123", FUTURE, { isProduction: false });

    expect(appended).toHaveLength(1);
    expect(appended[0][0]).toBe("Set-Cookie");
    expect(appended[0][1]).toContain("HttpOnly");
  });

  it("propagates the production refusal (throws, sets nothing)", () => {
    const res = { append: jest.fn() } as any;
    expect(() =>
      issueSessionCookie(res, "tok123", FUTURE, { isProduction: true, secure: false }),
    ).toThrow(/Secure/i);
    expect(res.append).not.toHaveBeenCalled();
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately and keeps it HttpOnly + SameSite=Lax by default", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("can clear cookie with SameSite=Strict", () => {
    const cookie = clearSessionCookie({ sameSite: 'Strict' });
    expect(cookie).toContain("SameSite=Strict");
  });
});
