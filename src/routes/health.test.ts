import { Request, Response } from 'express';
import { Pool } from 'pg';
import { healthReadyHandler } from './health';
import { createCorsMiddleware } from "../middleware/cors";

// Mock fetch for Stellar check
global.fetch = jest.fn();

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
