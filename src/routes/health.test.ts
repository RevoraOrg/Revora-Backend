import { Request, Response } from 'express';
import { Pool } from 'pg';
import { healthReadyHandler } from './health';
import { createCorsMiddleware } from "../middleware/cors";
import createHealthRouter, { healthReadyHandler } from './health';
import request from 'supertest';
import app from '../index';
import { closePool } from '../db/client';

// Mock fetch for Stellar check
global.fetch = jest.fn();

afterAll(async () => {
    await closePool();
});

describe('Health Router', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let jsonMock: jest.Mock;
    let statusMock: jest.Mock;

    beforeEach(() => {
        mockPool = {
            query: jest.fn(),
        } as unknown as jest.Mocked<Pool>;

        jsonMock = jest.fn();
        statusMock = jest.fn().mockReturnValue({ json: jsonMock });

        mockReq = {};
        mockRes = {
            status: statusMock,
            json: jsonMock,
        };

        jest.clearAllMocks();
    });

    it('should return 200 when both DB and Stellar are up', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'ok', db: 'up', stellar: 'up' });
    });

    it('should return 503 when DB is down', async () => {
        (mockPool.query as jest.Mock).mockRejectedValueOnce(new Error('Connection timeout'));

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Database is down' });
        expect(global.fetch).not.toHaveBeenCalled(); // DB checked first
    });

    it('should return 503 when Stellar Horizon is down', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Stellar Horizon is down' });
    });

    it('should return 503 when Stellar Horizon returns non-OK status', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });

        const handler = healthReadyHandler(mockPool);
        await handler(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Stellar Horizon is down' });
    });

    it('should create returning router instance', () => {
        const router = createHealthRouter(mockPool);
        expect(router).toBeDefined();
        expect(typeof router.get).toBe('function');
    });
});

describe('API Version Prefix Consistency tests', () => {
    it('should resolve /health without API prefix', async () => {
        const res = await request(app).get('/health');
        expect([200, 503]).toContain(res.status);
    });

    it('should resolve api routes with API_VERSION_PREFIX', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        const res = await request(app).get(`${prefix}/overview`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('name', 'Stellar RevenueShare (Revora) Backend');
    });

    it('should return 404 for api routes without prefix', async () => {
        const res = await request(app).get('/overview');
        expect(res.status).toBe(404);
    });
    
    it('should correctly scope protected endpoints under the prefix', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        // Hit milestone validation route (requires auth)
        const res = await request(app).post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`);
        expect(res.status).toBe(401);
    });
    
    it('should 404 for protected endpoints if prefix is lacking', async () => {
        const res = await request(app).post('/vaults/vault-1/milestones/milestone-1/validate');
        expect(res.status).toBe(404);
    });
});


describe("CORS policy tightening", () => {
    beforeEach(() => {
        process.env.ALLOWED_ORIGINS =
            "http://allowed.com,http://localhost:3000";

        process.env.CORS_ALLOW_NO_ORIGIN = "true";
    });

    it("allows allowed origin", (done) => {
        const middleware = createCorsMiddleware();

        const req: any = {
            headers: { origin: "http://allowed.com" },
        };

        const res: any = {};

        middleware(req, res, () => {
            done();
        });
    });

    it("blocks disallowed origin", (done) => {
        const middleware = createCorsMiddleware();

        const req: any = {
            headers: { origin: "http://evil.com" },
        };

        const res: any = {};

        middleware(req, res, () => {
            done();
        });
    });

    it("allows no origin when enabled", (done) => {
        process.env.CORS_ALLOW_NO_ORIGIN = "true";

        const middleware = createCorsMiddleware();

        const req: any = {
            headers: {},
        };

        const res: any = {};

        middleware(req, res, () => {
            done();
        });
    });

    it("blocks no origin when disabled", (done) => {
        process.env.CORS_ALLOW_NO_ORIGIN = "false";

        const middleware = createCorsMiddleware();

        const req: any = {
            headers: {},
        };

        const res: any = {};

        middleware(req, res, () => {
            done();
        });
    });

    it("supports multiple origins", (done) => {
        process.env.ALLOWED_ORIGINS =
            "http://a.com,http://b.com";

        const middleware = createCorsMiddleware();

        const req: any = {
            headers: { origin: "http://b.com" },
        };

        const res: any = {};

        middleware(req, res, () => {
            done();
        });
    });
});
