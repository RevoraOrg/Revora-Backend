import { Request, Response } from 'express';
import { Pool } from 'pg';
import { healthReadyHandler } from './health';
import { OfferingValidationMatrix } from '../lib/validationMatrix';

// Mock fetch for Stellar check
global.fetch = jest.fn();

describe('Health Router with Validation Matrix Integration', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let jsonMock: jest.Mock;
    let statusMock: jest.Mock;
    let validationMatrix: OfferingValidationMatrix;

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

        validationMatrix = new OfferingValidationMatrix();
        jest.clearAllMocks();
    });

    it('should return 200 when DB, Stellar, and Validation Matrix are up', async () => {
        (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

        // Test validation matrix health
        const testContext = {
            user: {
                id: 'health-check-user',
                email: 'health@example.com',
                role: 'startup',
                created_at: new Date(),
                updated_at: new Date()
            },
            requestPayload: { name: 'Health Check' },
            operation: 'create' as const,
            offeringData: { name: 'Health Check' }
        };

        const validationResult = await validationMatrix.validateOffering(testContext);
        expect(validationResult.isValid).toBe(true);

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

    // Additional validation matrix health tests
    describe('Validation Matrix Health Checks', () => {
        it('should validate validation matrix is functional', async () => {
            const testContext = {
                user: {
                    id: 'test-user',
                    email: 'test@example.com',
                    role: 'startup',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { name: 'Test Offering' },
                operation: 'create' as const,
                offeringData: { name: 'Test Offering' }
            };

            const result = await validationMatrix.validateOffering(testContext);
            
            expect(result).toHaveProperty('isValid');
            expect(result).toHaveProperty('errors');
            expect(result).toHaveProperty('warnings');
            expect(result).toHaveProperty('metadata');
            expect(result.metadata).toHaveProperty('executionTimeMs');
            expect(result.metadata).toHaveProperty('rulesApplied');
            expect(result.metadata.rulesApplied.length).toBeGreaterThan(0);
        });

        it('should handle validation matrix errors gracefully', async () => {
            const invalidContext = {
                user: {
                    id: '',
                    email: '',
                    role: 'invalid',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: {},
                operation: 'create' as const,
                offeringData: {}
            };

            const result = await validationMatrix.validateOffering(invalidContext);
            
            expect(result.isValid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should complete validation within performance thresholds', async () => {
            const testContext = {
                user: {
                    id: 'perf-test-user',
                    email: 'perf@example.com',
                    role: 'startup',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { 
                    name: 'Performance Test Offering',
                    description: 'Testing validation performance',
                    revenue_share_bps: 1000,
                    token_asset_id: 'PERF'
                },
                operation: 'create' as const,
                offeringData: {
                    name: 'Performance Test Offering',
                    description: 'Testing validation performance',
                    revenue_share_bps: 1000,
                    token_asset_id: 'PERF'
                }
            };

            const startTime = Date.now();
            const result = await validationMatrix.validateOffering(testContext);
            const endTime = Date.now();

            expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
            expect(result.metadata.executionTimeMs).toBeLessThan(1000);
        });

        it('should handle concurrent validation requests', async () => {
            const testContext = {
                user: {
                    id: 'concurrent-user',
                    email: 'concurrent@example.com',
                    role: 'startup',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { name: 'Concurrent Test' },
                operation: 'create' as const,
                offeringData: { name: 'Concurrent Test' }
            };

            const promises = Array.from({ length: 10 }, () => 
                validationMatrix.validateOffering(testContext)
            );

            const results = await Promise.all(promises);

            expect(results).toHaveLength(10);
            results.forEach(result => {
                expect(result).toHaveProperty('isValid');
                expect(result).toHaveProperty('metadata');
            });
        });

        it('should maintain validation matrix integrity under load', async () => {
            const contexts = Array.from({ length: 50 }, (_, i) => ({
                user: {
                    id: `load-test-user-${i}`,
                    email: `load${i}@example.com`,
                    role: 'startup' as const,
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { name: `Load Test Offering ${i}` },
                operation: 'create' as const,
                offeringData: { name: `Load Test Offering ${i}` }
            }));

            const startTime = Date.now();
            const results = await Promise.all(
                contexts.map(context => validationMatrix.validateOffering(context))
            );
            const endTime = Date.now();

            expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
            expect(results).toHaveLength(50);
            
            // All validations should complete without throwing
            results.forEach(result => {
                expect(result).toHaveProperty('isValid');
                expect(typeof result.isValid).toBe('boolean');
            });
        });
    });

    describe('Security and Abuse Testing', () => {
        it('should detect SQL injection attempts', async () => {
            const maliciousContext = {
                user: {
                    id: 'security-test-user',
                    email: 'security@example.com',
                    role: 'startup',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { name: "Test'; DROP TABLE offerings; --" },
                operation: 'create' as const,
                offeringData: { name: "Test'; DROP TABLE offerings; --" }
            };

            const result = await validationMatrix.validateOffering(maliciousContext);
            
            expect(result.isValid).toBe(false);
            expect(result.errors.some(e => e.code === 'SQL_INJECTION_DETECTED')).toBe(true);
            expect(result.errors.some(e => e.severity === 'critical')).toBe(true);
        });

        it('should detect XSS attempts', async () => {
            const xssContext = {
                user: {
                    id: 'xss-test-user',
                    email: 'xss@example.com',
                    role: 'startup',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { 
                    name: 'XSS Test',
                    description: '<script>alert("xss")</script>Malicious content'
                },
                operation: 'create' as const,
                offeringData: { 
                    name: 'XSS Test',
                    description: '<script>alert("xss")</script>Malicious content'
                }
            };

            const result = await validationMatrix.validateOffering(xssContext);
            
            expect(result.isValid).toBe(false);
            expect(result.errors.some(e => e.code === 'XSS_PATTERN_DETECTED')).toBe(true);
            expect(result.errors.some(e => e.severity === 'critical')).toBe(true);
        });

        it('should handle malformed payloads', async () => {
            const malformedContext = {
                user: {
                    id: 'malformed-user',
                    email: 'malformed@example.com',
                    role: 'startup',
                    created_at: new Date(),
                    updated_at: new Date()
                },
                requestPayload: { 
                    name: null,
                    description: undefined,
                    revenue_share_bps: 'invalid',
                    token_asset_id: 12345
                },
                operation: 'create' as const,
                offeringData: {
                    name: null,
                    description: undefined,
                    revenue_share_bps: 'invalid',
                    token_asset_id: 12345
                }
            } as any;

            const result = await validationMatrix.validateOffering(malformedContext);
            
            expect(result.isValid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });
    });
});
