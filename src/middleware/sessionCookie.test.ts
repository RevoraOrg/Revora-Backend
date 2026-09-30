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

import type { Response } from "express";

import {
  buildSessionCookie,
  clearSessionCookie,
  issueSessionCookie,
  resolveSessionCookieName,
  SESSION_COOKIE_NAME,
} from "./session";

const FUTURE = Date.now() + 60_000;

const originalCookieName = process.env.SESSION_COOKIE_NAME;

afterEach(() => {
  if (originalCookieName === undefined) {
    delete process.env.SESSION_COOKIE_NAME;
  } else {
    process.env.SESSION_COOKIE_NAME = originalCookieName;
  }
});

describe("SESSION_COOKIE_NAME", () => {
  it("uses the environment-configured name for issue and clear headers", () => {
    process.env.SESSION_COOKIE_NAME = "__Host-revora_session";

    expect(buildSessionCookie("tok123", FUTURE, { isProduction: false })).toContain(
      "__Host-revora_session=tok123",
    );
    expect(clearSessionCookie()).toContain("__Host-revora_session=;");
  });

  it("allows a valid per-call name to override the environment", () => {
    process.env.SESSION_COOKIE_NAME = "environment-session";

    expect(resolveSessionCookieName("tenant-session")).toBe("tenant-session");
  });

  it.each(["", "contains space", "session; Path=/", "session\r\nX-Injected: yes"])(
    "rejects invalid configured name %j",
    (name) => {
      process.env.SESSION_COOKIE_NAME = name;

      expect(() => buildSessionCookie("tok123", FUTURE)).toThrow(
        /SESSION_COOKIE_NAME must be a non-empty RFC 6265 cookie name/,
      );
    },
  );
});

describe("buildSessionCookie", () => {
  it("always sets HttpOnly, SameSite=Strict by default and Path=/", () => {
    const cookie = buildSessionCookie("tok123", FUTURE, { isProduction: false });

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("can be configured to SameSite=Lax", () => {
    const cookie = buildSessionCookie("tok123", FUTURE, { isProduction: false, sameSite: 'Lax' });
    expect(cookie).toContain("SameSite=Lax");
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
    const append = jest.fn();
    const res = { append } as unknown as Response;

    issueSessionCookie(res, "tok123", FUTURE, { isProduction: false });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith("Set-Cookie", expect.stringContaining("HttpOnly"));
    expect(append).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringContaining("SameSite=Strict"),
    );
  });

  it("propagates the production refusal (throws, sets nothing)", () => {
    const res = { append: jest.fn() } as unknown as Response;
    expect(() =>
      issueSessionCookie(res, "tok123", FUTURE, { isProduction: true, secure: false }),
    ).toThrow(/Secure/i);
    expect(res.append).not.toHaveBeenCalled();
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately and keeps it HttpOnly + SameSite=Strict by default", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("can clear cookie with SameSite=Lax", () => {
    const cookie = clearSessionCookie({ sameSite: 'Lax' });
    expect(cookie).toContain("SameSite=Lax");
  });
});
