import { Request, Response } from 'express';
import { Pool } from 'pg';
import { createStartupAuthRouter } from './startupAuth';

describe('StartupAuth Route', () => {
    let mockDb: jest.Mocked<Pool>;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let jsonSpy: jest.Mock;
    let statusSpy: jest.Mock;

    beforeEach(() => {
        mockDb = {
            query: jest.fn(),
        } as any;

        jsonSpy = jest.fn();
        statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });

        mockRes = {
            status: statusSpy,
            json: jsonSpy,
        };
    });

    it('should return 400 if email is missing', async () => {
        mockReq = { body: { password: 'password123' } };
        const router = createStartupAuthRouter(mockDb);
        const handler = (router.stack[0].route as any).stack[0].handle;

        await handler(mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
            error: 'Email and password are required',
        });
    });

    it('should return 400 if email format is invalid', async () => {
        mockReq = { body: { email: 'invalid-email', password: 'password123' } };
        const router = createStartupAuthRouter(mockDb);
        const handler = (router.stack[0].route as any).stack[0].handle;

        await handler(mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
            error: 'Invalid email format',
        });
    });

    it('should return 400 if password is too short', async () => {
        mockReq = { body: { email: 'test@example.com', password: 'short' } };
        const router = createStartupAuthRouter(mockDb);
        const handler = (router.stack[0].route as any).stack[0].handle;

        await handler(mockReq as Request, mockRes as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith({
            error: 'Password must be at least 8 characters long',
        });
    });
});
