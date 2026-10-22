import { parseMoneyString } from "./index";
import supertest from "supertest";
import { createApp } from "./index";
import { issueToken } from "./lib/jwt";
import { hashSessionToken } from "./auth/session";

describe("src/index.ts", () => {
  describe("distribution and payout routes", () => {
    const jwtSecret = "test-secret-for-distribution-route-tests";
    const issuerId = "issuer-test";
    const investorId = "investor-test";

    beforeAll(() => {
      process.env.JWT_SECRET = jwtSecret;
    });

    function appWithFakes() {
      const sessions = new Map<string, { id: string; user_id: string; token_hash: string; expires_at: Date }>();
      const tokenFor = (userId: string, role: string) => {
        const sessionId = `${role}-session`;
        const token = issueToken({
          subject: userId,
          additionalPayload: { sid: sessionId, role },
        });
        sessions.set(sessionId, {
          id: sessionId,
          user_id: userId,
          token_hash: hashSessionToken(token),
          expires_at: new Date(Date.now() + 60_000),
        });
        return token;
      };

      const issuerToken = tokenFor(issuerId, "startup");
      const investorToken = tokenFor(investorId, "investor");
      const app = createApp({
        sessionRepository: {
          findById: async (id) => sessions.get(id) ?? null,
        },
        distributionOfferingRepo: {
          getById: async (id) =>
            id === "offering-1"
              ? { id, issuer_id: issuerId }
              : null,
        },
        distributionEngine: {
          distribute: jest.fn(),
          previewRun: jest.fn().mockResolvedValue({
            preview_id: "preview-1",
            offering_id: "offering-1",
            period_id: "2026-01",
            revenue_amount: "100",
            computed_at: "2026-01-31T00:00:00.000Z",
            investor_count: 1,
            projections: [{ investor_id: investorId, amount: "100.00" }],
          }),
        },
        payoutRepo: {
          listPayoutsByInvestor: async (id) =>
            id === investorId
              ? [{
                  id: "payout-1",
                  distribution_run_id: "run-1",
                  investor_id: investorId,
                  amount: "100.00",
                  status: "processed",
                  created_at: new Date("2026-01-31T00:00:00.000Z"),
                  updated_at: new Date("2026-01-31T00:00:00.000Z"),
                }]
              : [],
        },
      });

      return { app, issuerToken, investorToken };
    }

    it("serves a distribution preview to the authenticated offering issuer", async () => {
      const { app, issuerToken } = appWithFakes();

      const response = await supertest(app)
        .post("/api/v1/offerings/offering-1/distribute/preview")
        .set("Authorization", `Bearer ${issuerToken}`)
        .send({
          revenue_amount: "100",
          period: {
            id: "2026-01",
            start: "2026-01-01T00:00:00.000Z",
            end: "2026-01-31T00:00:00.000Z",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.preview_id).toBe("preview-1");
    });

    it("requires a valid session-backed token for distribution previews", async () => {
      const { app } = appWithFakes();

      const response = await supertest(app)
        .post("/api/v1/offerings/offering-1/distribute/preview")
        .send({
          revenue_amount: "100",
          period: {
            start: "2026-01-01T00:00:00.000Z",
            end: "2026-01-31T00:00:00.000Z",
          },
        });

      expect(response.status).toBe(401);
    });

    it("requires a valid session-backed token to list payouts", async () => {
      const { app } = appWithFakes();

      const response = await supertest(app).get("/api/v1/investments/payouts");

      expect(response.status).toBe(401);
    });

    it("lists only the authenticated investor's payouts", async () => {
      const { app, investorToken } = appWithFakes();

      const response = await supertest(app)
        .get("/api/v1/investments/payouts")
        .set("Authorization", `Bearer ${investorToken}`);

      expect(response.status).toBe(200);
      expect(response.body.payouts).toHaveLength(1);
      expect(response.body.payouts[0].investor_id).toBe(investorId);
    });
  });

  describe("parseMoneyString", () => {
    it("should return null for non-string values", () => {
      // Evidence: if (typeof value !== "string") return null;
      expect(parseMoneyString(123)).toBeNull();
      expect(parseMoneyString(undefined)).toBeNull();
      expect(parseMoneyString(null)).toBeNull();
      expect(parseMoneyString({})).toBeNull();
    });

    it("should return null for invalid strings (regex failure)", () => {
      // Evidence: if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) return null;
      expect(parseMoneyString("")).toBeNull();
      expect(parseMoneyString("not-a-number")).toBeNull();
      expect(parseMoneyString("01")).toBeNull(); // leading zero not allowed for >0
      expect(parseMoneyString("123.456")).toBeNull(); // > 2 decimal places
      expect(parseMoneyString("1234567890123")).toBeNull(); // > 12 integer digits
      expect(parseMoneyString("-100")).toBeNull(); // negative numbers not allowed
      expect(parseMoneyString(" 100 ")).toBeNull(); // spaces not allowed
    });

    it("should return null if Number.isFinite fails", () => {
      // Evidence: if (!Number.isFinite(parsed)) return null;
      // The regex naturally protects against Infinity and NaN. 
      // We temporarily bypass the regex check to explicitly exercise the Number.isFinite boundary.
      const originalTest = RegExp.prototype.test;
      RegExp.prototype.test = function (str: string) {
        if (str === "Infinity" || str === "NaN") {
          return true; // Bypass regex for this test
        }
        return originalTest.call(this, str);
      };

      try {
        expect(parseMoneyString("Infinity")).toBeNull();
        expect(parseMoneyString("NaN")).toBeNull();
      } finally {
        RegExp.prototype.test = originalTest;
      }
    });

    it("should parse valid money strings successfully (normal path)", () => {
      expect(parseMoneyString("0")).toBe(0);
      expect(parseMoneyString("10")).toBe(10);
      expect(parseMoneyString("100.5")).toBe(100.5);
      expect(parseMoneyString("12345.67")).toBe(12345.67);
      expect(parseMoneyString("999999999999.99")).toBe(999999999999.99); // max valid boundary
    });
  });
});
