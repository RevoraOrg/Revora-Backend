import request from "supertest";
import app from "../index";

describe("Overview contract", () => {
  it("GET /api/v1/overview returns the documented overview payload", async () => {
    const prefix = process.env.API_VERSION_PREFIX ?? "/api/v1";

    const res = await request(app).get(`${prefix}/overview`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "Stellar RevenueShare (Revora) Backend",
      description:
        "Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).",
      version: "0.1.0",
    });
  });
});

