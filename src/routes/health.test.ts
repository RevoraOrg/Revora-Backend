import { Request, Response } from 'express';
import { Pool } from 'pg';
import { healthReadyHandler } from './health';
import { StartupRegistrationSchema } from '../index'; // Import the schema we created

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
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

/**
 * ISSUE #134: Startup Registration Validation Tests
 * Verifies production-grade hardening and security assumptions.
 */
describe('Startup Registration Schema Validation', () => {

    it('should validate a valid startup registration object', () => {
        const validStartup = {
            startupName: " Dan Ventures",
            registrationId: "REG-2026-X",
            sector: "Agrotech",
            contactEmail: "dan@gmail.com"
        };

        const result = StartupRegistrationSchema.safeParse(validStartup);
        expect(result.success).toBe(true);
    });

    it('should fail when startupName is too short (Security: length limit)', () => {
        const invalidStartup = {
            startupName: "Ab",
            registrationId: "REG-123",
            sector: "SaaS",
            contactEmail: "test@test.com"
        };

        const result = StartupRegistrationSchema.safeParse(invalidStartup);

        // 1. Assert failure
        expect(result.success).toBe(false);

        // 2. Type guard for TypeScript
        if (!result.success) {
            // Use .issues for better compatibility with Zod types
            const errorMessages = result.error.issues.map(i => i.message);
            expect(errorMessages).toContain("Name too short");
        }
    });

    it('should reject invalid registrationId characters (Security: Injection protection)', () => {
        const maliciousStartup = {
            startupName: "Safe Name",
            registrationId: "REG-123; DROP TABLE users",
            sector: "Fintech",
            contactEmail: "dan@test.com"
        };

        const result = StartupRegistrationSchema.safeParse(maliciousStartup);
        expect(result.success).toBe(false);
    });

    it('should reject unwhitelisted fields (Security: Mass Assignment protection)', () => {
        const overpostedStartup = {
            startupName: "Valid Startup",
            registrationId: "REG-999",
            sector: "Healthtech",
            contactEmail: "med@test.com",
            isAdmin: true // This field is not in the schema
        };

        const result = StartupRegistrationSchema.safeParse(overpostedStartup);
        expect(result.success).toBe(false); // Should fail because of .strict()
    });

    it('should force email to lowercase for consistency', () => {
        const mixedEmail = {
            startupName: "Strategy App",
            registrationId: "REG-999",
            sector: "Fintech",
            contactEmail: "STRATEGY@DAN.COM" // Valid format
        };

        const result = StartupRegistrationSchema.safeParse(mixedEmail);
        expect(result.success).toBe(true);

        if (result.success) {
            expect(result.data.contactEmail).toBe("strategy@dan.com");
        }
    });
});