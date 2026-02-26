"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const investments_1 = require("./investments");
/**
 * Mock Investment Service
 */
class MockInvestmentService {
    constructor() {
        this.offerings = new Map();
        // Add a test offering
        this.offerings.set("offering-123", {
            id: "offering-123",
            name: "Test Offering",
            description: "Test description",
            target_amount: "100000",
            min_investment: "100",
            max_investment: "10000",
            status: "active",
            issuer_id: "issuer-1",
            created_at: new Date(),
            updated_at: new Date(),
        });
        // Add a closed offering
        this.offerings.set("offering-closed", {
            id: "offering-closed",
            name: "Closed Offering",
            target_amount: "100000",
            min_investment: "100",
            status: "closed",
            issuer_id: "issuer-1",
            created_at: new Date(),
            updated_at: new Date(),
        });
    }
    async createInvestment(input) {
        const offering = this.offerings.get(input.offering_id);
        if (!offering) {
            const error = new Error(`Offering with ID ${input.offering_id} not found`);
            error.name = "OfferingNotFoundError";
            throw error;
        }
        if (offering.status !== "active") {
            const error = new Error(`Offering with ID ${input.offering_id} is not active`);
            error.name = "OfferingClosedError";
            throw error;
        }
        const amount = parseFloat(input.amount);
        if (isNaN(amount) || amount <= 0) {
            const error = new Error("Investment amount must be a positive number");
            error.name = "InvalidInvestmentAmountError";
            throw error;
        }
        const minInvestment = parseFloat(offering.min_investment);
        if (amount < minInvestment) {
            const error = new Error(`Investment amount must be at least ${minInvestment}`);
            error.name = "InvalidInvestmentAmountError";
            throw error;
        }
        if (offering.max_investment) {
            const maxInvestment = parseFloat(offering.max_investment);
            if (amount > maxInvestment) {
                const error = new Error(`Investment amount cannot exceed ${maxInvestment}`);
                error.name = "InvalidInvestmentAmountError";
                throw error;
            }
        }
        return {
            id: `investment-${Date.now()}`,
            offering_id: input.offering_id,
            investor_id: input.investor_id,
            amount: input.amount,
            status: "pending",
            transaction_hash: input.transaction_hash || null,
            created_at: new Date(),
            updated_at: new Date(),
        };
    }
}
/**
 * Mock Response - captures status code and JSON data
 */
class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.jsonData = null;
    }
    status(code) {
        this.statusCode = code;
        return this;
    }
    json(data) {
        this.jsonData = data;
        return this;
    }
    send() {
        return this;
    }
}
/**
 * Test cases
 */
test("createInvestmentHandler creates investment successfully", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "offering-123",
            amount: "500",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 201);
    strict_1.default.equal(mockRes.jsonData.offering_id, "offering-123");
    strict_1.default.equal(mockRes.jsonData.investor_id, "investor-1");
    strict_1.default.equal(mockRes.jsonData.amount, "500");
    strict_1.default.equal(mockRes.jsonData.status, "pending");
});
test("createInvestmentHandler returns 400 when offering_id is missing", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            amount: "500",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 400);
    strict_1.default.equal(mockRes.jsonData.error, "offering_id is required");
});
test("createInvestmentHandler returns 400 when amount is missing", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "offering-123",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 400);
    strict_1.default.equal(mockRes.jsonData.error, "amount is required");
});
test("createInvestmentHandler returns 401 when user is not authenticated", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: undefined,
        body: {
            offering_id: "offering-123",
            amount: "500",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 401);
    strict_1.default.equal(mockRes.jsonData.error, "Unauthorized");
});
test("createInvestmentHandler returns 404 when offering does not exist", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "non-existent",
            amount: "500",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 404);
    strict_1.default.equal(mockRes.jsonData.error, "Offering with ID non-existent not found");
});
test("createInvestmentHandler returns 400 when offering is closed", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "offering-closed",
            amount: "500",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 400);
    strict_1.default.equal(mockRes.jsonData.error, "Offering with ID offering-closed is not active");
});
test("createInvestmentHandler returns 400 for invalid amount", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "offering-123",
            amount: "-100",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 400);
    strict_1.default.equal(mockRes.jsonData.error, "Investment amount must be a positive number");
});
test("createInvestmentHandler returns 400 when amount is below minimum", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "offering-123",
            amount: "50",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 400);
    strict_1.default.equal(mockRes.jsonData.error, "Investment amount must be at least 100");
});
test("createInvestmentHandler returns 400 when amount exceeds maximum", async () => {
    const mockService = new MockInvestmentService();
    const handler = (0, investments_1.createInvestmentHandler)(mockService);
    const mockReq = {
        auth: { userId: "investor-1", sessionId: "session-1" },
        body: {
            offering_id: "offering-123",
            amount: "50000",
        },
    };
    const mockRes = new MockResponse();
    await handler(mockReq, mockRes, () => undefined);
    strict_1.default.equal(mockRes.statusCode, 400);
    strict_1.default.equal(mockRes.jsonData.error, "Investment amount cannot exceed 10000");
});
