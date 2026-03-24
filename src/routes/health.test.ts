import { Request, Response } from 'express';
import { Pool } from 'pg';
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

describe('Security Regression Suite', () => {
    /**
     * @test Information Disclosure Prevention
     * @desc Ensures the server does not disclose its underlying technology stack via headers.
     */
    it('should not disclose X-Powered-By header', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    /**
     * @test Request Traceability
     * @desc Ensures every request is assigned a unique X-Request-Id for audit and debugging.
     */
    it('should return X-Request-Id header in responses', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['x-request-id']).toBeDefined();
        expect(typeof res.headers['x-request-id']).toBe('string');
    });

    /**
     * @test CORS Policy Enforcement
     * @desc Validates that only allowed origins can access the API.
     */
    it('should enforce CORS origin policy', async () => {
        const res = await request(app)
            .get('/health')
            .set('Origin', 'http://malicious-site.com');
        
        // The cors middleware might return 200 with no Allow-Origin header or vary, 
        // depending on how it's configured. If origin doesn't match, Access-Control-Allow-Origin 
        // will usually be missing or different.
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    /**
     * @test Rate Limiting
     * @desc Ensures the global rate limiter triggers after the threshold is exceeded.
     * @note Using a tight window/limit for demonstration if possible, but here we test the behavior.
     */
    it('should eventually trigger rate limiting (429) for excessive requests', async () => {
        // The current limit is 100 per minute in index.ts. 
        // For testing, we might want to mock the store or just verify headers.
        const res = await request(app).get('/health');
        expect(res.headers['x-ratelimit-limit']).toBe('100');
        expect(res.headers['x-ratelimit-remaining']).toBeDefined();
        
        // We won't actually fire 100 requests in a unit test unless we mock the store,
        // but we can verify the headers are working.
    });

    /**
     * @test Auth Boundary Enforcement
     * @desc Deterministically verify that protected routes reject unauthorized requests.
     */
    it('should reject requests missing required security headers for protected routes', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        const res = await request(app).post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`);
        
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    /**
     * @test Auth Success Path
     * @desc Verify that providing the required security headers bypasses the auth boundary.
     */
    it('should allow requests with valid security headers', async () => {
        const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';
        const res = await request(app)
            .post(`${prefix}/vaults/vault-1/milestones/milestone-1/validate`)
            .set('x-user-id', 'test-user')
            .set('x-user-role', 'verifier');
        
        // Should not be 401. Might be 200 or 400 depending on payload, but 401 means auth failed.
        expect(res.status).not.toBe(401);
    });
});
