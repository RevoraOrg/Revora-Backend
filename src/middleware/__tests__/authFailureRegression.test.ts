import crypto from "crypto";
import { verifyJwt } from "../auth";

describe("AdminSignatureContext & auth failure handling regression (Issue #1053)", () => {
	const SECRET = "primary-secret-key-with-at-least-32-chars-long";
	const ROTATED_SECRET = "secondary-secret-key-for-rotation-32-chars";
	const WRONG_SECRET = "wrong-secret-key-that-does-not-match-32-chars";

	function createToken(header: object, payload: object, secret: string): string {
		const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
		const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
		const sig = crypto.createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
		return `${headerB64}.${payloadB64}.${sig}`;
	}

	describe("Branch 1: Invalid token format handling (parts.length !== 3)", () => {
		test("throws 'Invalid token format' for an empty string", () => {
			expect(() => verifyJwt("", SECRET)).toThrow("Invalid token format");
		});

		test("throws 'Invalid token format' for a token with only one part", () => {
			expect(() => verifyJwt("onlyonepartwithoutdots", SECRET)).toThrow("Invalid token format");
		});

		test("throws 'Invalid token format' for a token with only two parts", () => {
			expect(() => verifyJwt("header.payload", SECRET)).toThrow("Invalid token format");
		});

		test("throws 'Invalid token format' for a token with more than three parts", () => {
			expect(() => verifyJwt("header.payload.signature.extra", SECRET)).toThrow("Invalid token format");
		});

		test("throws 'Invalid token format' for malformed dot sequences", () => {
			expect(() => verifyJwt("..", SECRET)).toThrow();
			expect(() => verifyJwt("a.b.c.d.e", SECRET)).toThrow("Invalid token format");
		});
	});

	describe("Branch 2: Invalid token signature handling (!payload)", () => {
		test("throws 'Invalid token signature' when signature was generated with wrong secret", () => {
			const validPayload = { sub: "admin-123", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 };
			const tokenWithWrongSecret = createToken({ alg: "HS256", typ: "JWT" }, validPayload, WRONG_SECRET);

			expect(() => verifyJwt(tokenWithWrongSecret, SECRET)).toThrow("Invalid token signature");
		});

		test("throws 'Invalid token signature' when payload is tampered after signing", () => {
			const originalPayload = { sub: "user-123", role: "user", exp: Math.floor(Date.now() / 1000) + 3600 };
			const token = createToken({ alg: "HS256", typ: "JWT" }, originalPayload, SECRET);
			const [header, , sig] = token.split(".");

			const tamperedPayloadB64 = Buffer.from(JSON.stringify({ sub: "user-123", role: "admin", exp: originalPayload.exp })).toString("base64url");
			const tamperedToken = `${header}.${tamperedPayloadB64}.${sig}`;

			expect(() => verifyJwt(tamperedToken, SECRET)).toThrow("Invalid token signature");
		});

		test("throws 'Invalid token signature' when header is tampered after signing", () => {
			const validPayload = { sub: "admin-1", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 };
			const token = createToken({ alg: "HS256", typ: "JWT" }, validPayload, SECRET);
			const [, payloadB64, sig] = token.split(".");

			const tamperedHeaderB64 = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
			const tamperedToken = `${tamperedHeaderB64}.${payloadB64}.${sig}`;

			expect(() => verifyJwt(tamperedToken, SECRET)).toThrow("Invalid token signature");
		});

		test("throws 'Invalid token signature' when secret rotation array contains no matching secret", () => {
			const validPayload = { sub: "admin-456", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 };
			const token = createToken({ alg: "HS256", typ: "JWT" }, validPayload, WRONG_SECRET);

			expect(() => verifyJwt(token, [SECRET, ROTATED_SECRET])).toThrow("Invalid token signature");
		});
	});

	describe("Branch 3: Token expiration handling (exp in past)", () => {
		test("throws 'Token expired' when token has expired timestamp in the past", () => {
			const expiredTime = Math.floor(Date.now() / 1000) - 300;
			const expiredPayload = { sub: "admin-789", role: "admin", exp: expiredTime };
			const expiredToken = createToken({ alg: "HS256", typ: "JWT" }, expiredPayload, SECRET);

			expect(() => verifyJwt(expiredToken, SECRET)).toThrow("Token expired");
		});

		test("throws 'Token expired' even when verified against rotated secrets", () => {
			const expiredTime = Math.floor(Date.now() / 1000) - 60;
			const expiredPayload = { sub: "admin-rot", role: "admin", exp: expiredTime };
			const expiredToken = createToken({ alg: "HS256", typ: "JWT" }, expiredPayload, ROTATED_SECRET);

			expect(() => verifyJwt(expiredToken, [SECRET, ROTATED_SECRET])).toThrow("Token expired");
		});
	});

	describe("Normal & Boundary Paths: Valid verification and secret rotation", () => {
		test("successfully verifies valid token with single primary secret", () => {
			const futureExp = Math.floor(Date.now() / 1000) + 3600;
			const payload = { sub: "admin-user", role: "superadmin", exp: futureExp };
			const token = createToken({ alg: "HS256", typ: "JWT" }, payload, SECRET);

			const decoded = verifyJwt(token, SECRET);
			expect(decoded).toBeDefined();
			expect(decoded.sub).toBe("admin-user");
			expect(decoded.role).toBe("superadmin");
			expect(decoded.exp).toBe(futureExp);
		});

		test("successfully verifies valid token matching previous secret during rotation", () => {
			const futureExp = Math.floor(Date.now() / 1000) + 1800;
			const payload = { sub: "rotated-admin", role: "admin", exp: futureExp };
			const token = createToken({ alg: "HS256", typ: "JWT" }, payload, ROTATED_SECRET);

			const decoded = verifyJwt(token, [SECRET, ROTATED_SECRET]);
			expect(decoded).toBeDefined();
			expect(decoded.sub).toBe("rotated-admin");
			expect(decoded.role).toBe("admin");
		});

		test("successfully verifies token without exp claim (indefinite expiry contract)", () => {
			const payload = { sub: "service-worker", role: "system" };
			const token = createToken({ alg: "HS256", typ: "JWT" }, payload, SECRET);

			const decoded = verifyJwt(token, SECRET);
			expect(decoded).toBeDefined();
			expect(decoded.sub).toBe("service-worker");
			expect(decoded.role).toBe("system");
		});
	});
});
