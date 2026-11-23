import express from "express";
import request from "supertest";
import {
  createOfferingValidationRouter,
  evaluateOfferingValidationMatrix,
  OfferingActorRole,
  OfferingValidationAction,
  OfferingValidationPayload,
} from "./offeringValidation";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function evaluate(
  action: OfferingValidationAction,
  role: OfferingActorRole,
  offering: OfferingValidationPayload["offering"] = {},
  actorId = "actor-1",
) {
  return evaluateOfferingValidationMatrix(
    { id: actorId, role },
    { action, offering },
    NOW,
  );
}

function checkPassed(
  result: ReturnType<typeof evaluate>,
  code: string,
): boolean {
  const check = result.checks.find((candidate) => candidate.code === code);
  if (!check) {
    throw new Error(`Expected validation check ${code}`);
  }
  return check.passed;
}

describe("evaluateOfferingValidationMatrix", () => {
  it("allows startup creation with valid positive decimal amounts", () => {
    const result = evaluate("create", "startup", {
      targetAmount: "50000.00",
      minimumInvestment: "100.00",
    });

    expect(result.allowed).toBe(true);
    expect(result.decision).toBe("allow");
    expect(result.violations).toHaveLength(0);
    expect(result.offeringId).toBeNull();
  });

  it("denies actions not allowed for the actor role", () => {
    const result = evaluate(
      "update",
      "investor",
      { issuerId: "actor-1", targetAmount: "1000", minimumInvestment: "10" },
    );

    expect(checkPassed(result, "ROLE_ALLOWED_FOR_ACTION")).toBe(false);
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("deny");
  });

  it("denies startup management of another issuer's offering", () => {
    const result = evaluate("update", "startup", {
      issuerId: "another-startup",
      targetAmount: "1000",
      minimumInvestment: "10",
    });

    expect(checkPassed(result, "OWNERSHIP_CONFIRMED")).toBe(false);
    expect(result.violations.map(({ code }) => code)).toContain(
      "OWNERSHIP_CONFIRMED",
    );
  });

  it.each([
    ["malformed decimal input", "1e3", "10", "TARGET_AMOUNT_VALID"],
    ["minimum above target", "10", "20", "MINIMUM_NOT_GREATER_THAN_TARGET"],
  ])("rejects %s", (_description, targetAmount, minimumInvestment, code) => {
    const result = evaluate("create", "startup", {
      targetAmount,
      minimumInvestment,
    });

    expect(checkPassed(result, code)).toBe(false);
    expect(result.allowed).toBe(false);
  });

  it("validates publish status and ordered future subscription dates", () => {
    const valid = evaluate("publish", "startup", {
      status: "draft",
      targetAmount: "1000",
      minimumInvestment: "10",
      subscriptionStartsAt: "2026-01-16T00:00:00.000Z",
      subscriptionEndsAt: "2026-01-17T00:00:00.000Z",
    });

    expect(valid.allowed).toBe(true);
    expect(checkPassed(valid, "SUBSCRIPTION_WINDOW_ORDERED")).toBe(true);
    expect(checkPassed(valid, "SUBSCRIPTION_ENDS_IN_FUTURE")).toBe(true);

    const invalid = evaluate("publish", "startup", {
      status: "open",
      targetAmount: "1000",
      minimumInvestment: "10",
      subscriptionStartsAt: "2026-01-17T00:00:00.000Z",
      subscriptionEndsAt: "2026-01-16T00:00:00.000Z",
    });

    expect(checkPassed(invalid, "STATUS_ELIGIBLE_FOR_PUBLISH")).toBe(false);
    expect(checkPassed(invalid, "SUBSCRIPTION_WINDOW_ORDERED")).toBe(false);
    expect(invalid.allowed).toBe(false);
  });

  it.each([
    ["pause", "open", true],
    ["pause", "draft", false],
    ["close", "paused", true],
    ["close", "draft", false],
    ["cancel", "paused", true],
    ["cancel", "completed", false],
  ] as const)(
    "applies the %s status transition for %s offerings",
    (action, status, expected) => {
      const result = evaluate(action, "startup", { status });
      const checkCode = `STATUS_ELIGIBLE_FOR_${action.toUpperCase()}`;

      expect(checkPassed(result, checkCode)).toBe(expected);
    },
  );

  it("limits private offering views to the owner or privileged roles", () => {
    const owner = evaluate(
      "viewPrivate",
      "startup",
      { issuerId: "actor-1" },
    );
    const otherStartup = evaluate(
      "viewPrivate",
      "startup",
      { issuerId: "another-startup" },
    );
    const admin = evaluate(
      "viewPrivate",
      "admin",
      { issuerId: "another-startup" },
    );

    expect(checkPassed(owner, "PRIVATE_VIEW_ALLOWED")).toBe(true);
    expect(checkPassed(otherStartup, "PRIVATE_VIEW_ALLOWED")).toBe(false);
    expect(checkPassed(admin, "PRIVATE_VIEW_ALLOWED")).toBe(true);
  });

  it("allows an investor's valid investment at the inclusive window boundary", () => {
    const result = evaluate(
      "invest",
      "investor",
      {
        issuerId: "startup-1",
        status: "open",
        targetAmount: "1000",
        minimumInvestment: "100",
        investmentAmount: "100",
        subscriptionStartsAt: "2026-01-15T12:00:00.000Z",
        subscriptionEndsAt: "2026-01-16T12:00:00.000Z",
      },
      "investor-1",
    );

    expect(result.allowed).toBe(true);
    expect(checkPassed(result, "INVESTMENT_MEETS_MINIMUM")).toBe(true);
    expect(checkPassed(result, "INVESTMENT_WINDOW_ACTIVE")).toBe(true);
  });

  it("denies investment below the minimum, outside the window, or by the issuer", () => {
    const belowMinimum = evaluate("invest", "investor", {
      status: "open",
      minimumInvestment: "100",
      investmentAmount: "50",
      subscriptionStartsAt: "2026-01-15T00:00:00.000Z",
      subscriptionEndsAt: "2026-01-16T00:00:00.000Z",
    });
    const outsideWindow = evaluate("invest", "investor", {
      status: "open",
      minimumInvestment: "10",
      investmentAmount: "50",
      subscriptionStartsAt: "2026-01-16T00:00:00.000Z",
      subscriptionEndsAt: "2026-01-17T00:00:00.000Z",
    });
    const issuerInvesting = evaluate(
      "invest",
      "investor",
      {
        issuerId: "actor-1",
        status: "open",
        minimumInvestment: "10",
        investmentAmount: "50",
        subscriptionStartsAt: "2026-01-15T00:00:00.000Z",
        subscriptionEndsAt: "2026-01-16T00:00:00.000Z",
      },
      "actor-1",
    );

    expect(checkPassed(belowMinimum, "INVESTMENT_MEETS_MINIMUM")).toBe(false);
    expect(checkPassed(outsideWindow, "INVESTMENT_WINDOW_ACTIVE")).toBe(false);
    expect(checkPassed(issuerInvesting, "INVESTOR_NOT_ISSUER")).toBe(false);
    expect(belowMinimum.allowed).toBe(false);
    expect(outsideWindow.allowed).toBe(false);
    expect(issuerInvesting.allowed).toBe(false);
  });
});

describe("createOfferingValidationRouter", () => {
  const app = express();
  app.use(express.json());
  app.use("/offerings", createOfferingValidationRouter());

  it("serves the mounted matrix route for an authenticated valid request", async () => {
    const response = await request(app)
      .post("/offerings/validation-matrix")
      .set("x-user-id", "startup-1")
      .set("x-user-role", "startup")
      .send({
        action: "create",
        offering: {
          targetAmount: "50000.00",
          minimumInvestment: "100.00",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.allowed).toBe(true);
    expect(response.body.actor).toEqual({ id: "startup-1", role: "startup" });
  });
});
