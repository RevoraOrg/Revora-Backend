import { Request, Response } from 'express';
import { Pool } from 'pg';
import createHealthRouter, { healthReadyHandler } from './health';
import request from 'supertest';
import app, { 
    OfferingConflictResolver, 
    SyncOfferingInput,
    ConflictDetectionResult,
    ConflictResolutionResult 
} from '../index';
import { closePool } from '../db/client';

// Mock fetch for Stellar check
global.fetch = jest.fn();

afterAll(async () => {
    await closePool();
});

describe('Health Router', () => {
    let mockPool: any;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let jsonMock: jest.Mock;
    let statusMock: jest.Mock;

    beforeEach(() => {
        mockPool = {
            query: jest.fn(),
        } as unknown as any;

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

/**
 * @title Offering Sync Conflict Resolution Tests
 * @notice Comprehensive test suite for conflict detection and resolution
 * @dev Tests cover edge cases, race conditions, security boundaries, and deterministic behavior
 */
describe('OfferingConflictResolver', () => {
    let mockPool: any;
    let mockClient: any;
    let resolver: OfferingConflictResolver;

    beforeEach(() => {
        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };

        mockPool = {
            query: jest.fn(),
            connect: jest.fn().mockResolvedValue(mockClient),
        } as unknown as any;

        resolver = new OfferingConflictResolver(mockPool);
        jest.clearAllMocks();
    });

    describe('detectConflict', () => {
        it('should detect no conflict when versions match', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 5, updated_at: new Date(), sync_hash: 'abc123' }],
            });

            const result = await resolver.detectConflict('offering-1', 5);

            expect(result.hasConflict).toBe(false);
            expect(result.currentVersion).toBe(5);
            expect(result.attemptedVersion).toBe(5);
            expect(result.message).toBe('No conflict detected');
        });

        it('should detect concurrent update conflict when version differs by 1', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 6, updated_at: new Date(), sync_hash: 'abc123' }],
            });

            const result = await resolver.detectConflict('offering-1', 5);

            expect(result.hasConflict).toBe(true);
            expect(result.conflictType).toBe('concurrent_update');
            expect(result.currentVersion).toBe(6);
            expect(result.attemptedVersion).toBe(5);
        });

        it('should detect stale data when version differs by more than 1', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 10, updated_at: new Date(), sync_hash: 'abc123' }],
            });

            const result = await resolver.detectConflict('offering-1', 5);

            expect(result.hasConflict).toBe(true);
            expect(result.conflictType).toBe('stale_data');
            expect(result.currentVersion).toBe(10);
            expect(result.attemptedVersion).toBe(5);
        });

        it('should detect conflict when offering not found', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

            const result = await resolver.detectConflict('missing-id', 5);

            expect(result.hasConflict).toBe(true);
            expect(result.conflictType).toBe('version_mismatch');
            expect(result.currentVersion).toBe(-1);
            expect(result.message).toBe('Offering not found');
        });

        it('should use FOR UPDATE lock to prevent race conditions', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 5, updated_at: new Date(), sync_hash: 'abc123' }],
            });

            await resolver.detectConflict('offering-1', 5);

            expect(mockPool.query).toHaveBeenCalledWith(
                expect.stringContaining('FOR UPDATE'),
                ['offering-1']
            );
        });
    });

    describe('resolveConflict', () => {
        const validInput: SyncOfferingInput = {
            offeringId: '123e4567-e89b-12d3-a456-426614174000',
            expectedVersion: 5,
            newStatus: 'active',
            newTotalRaised: '10000.00',
            syncHash: 'a'.repeat(64),
            syncedAt: new Date('2026-03-24T12:00:00Z'),
        };

        it('should successfully resolve conflict and update offering', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 5,
                        sync_hash: 'old_hash',
                        status: 'draft',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 6,
                        sync_hash: validInput.syncHash,
                        status: 'active',
                        total_raised: '10000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: validInput.syncedAt,
                    }],
                })
                .mockResolvedValueOnce({ rows: [] }); // COMMIT

            const result = await resolver.resolveConflict(validInput);

            expect(result.success).toBe(true);
            expect(result.resolved).toBe(true);
            expect(result.strategy).toBe('blockchain_wins');
            expect(result.finalVersion).toBe(6);
            expect(result.offering?.status).toBe('active');
            expect(result.offering?.total_raised).toBe('10000.00');
            expect(mockClient.release).toHaveBeenCalled();
        });

        it('should skip update when sync_hash matches (idempotent)', async () => {
            const sameHashInput = { ...validInput, syncHash: 'existing_hash' };

            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 5,
                        sync_hash: 'existing_hash',
                        status: 'active',
                        total_raised: '10000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

            const result = await resolver.resolveConflict(sameHashInput);

            expect(result.success).toBe(true);
            expect(result.resolved).toBe(true);
            expect(result.strategy).toBe('blockchain_wins');
            expect(result.finalVersion).toBe(5);
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        });

        it('should handle offering not found error', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({ rows: [] }) // No offering found
                .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

            const result = await resolver.resolveConflict(validInput);

            expect(result.success).toBe(false);
            expect(result.resolved).toBe(false);
            expect(result.strategy).toBe('manual_review');
            expect(result.error).toBe('Offering not found');
        });

        it('should handle serialization failure with retry strategy', async () => {
            const serializationError = new Error('Serialization failure');
            (serializationError as any).code = '40001';

            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockRejectedValueOnce(serializationError);

            const result = await resolver.resolveConflict(validInput);

            expect(result.success).toBe(false);
            expect(result.resolved).toBe(false);
            expect(result.strategy).toBe('retry');
            expect(result.error).toBe('Serialization conflict, retry recommended');
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        });

        it('should rollback transaction on unexpected errors', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockRejectedValueOnce(new Error('Unexpected database error'));

            const result = await resolver.resolveConflict(validInput);

            expect(result.success).toBe(false);
            expect(result.strategy).toBe('manual_review');
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalled();
        });

        it('should increment version atomically', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 5,
                        sync_hash: 'old_hash',
                        status: 'draft',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 6,
                        sync_hash: validInput.syncHash,
                        status: 'active',
                        total_raised: '10000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: validInput.syncedAt,
                    }],
                })
                .mockResolvedValueOnce({ rows: [] }); // COMMIT

            const result = await resolver.resolveConflict(validInput);

            expect(result.finalVersion).toBe(6);
            const updateCall = mockClient.query.mock.calls.find((call: any) => 
                call[0].includes('UPDATE offerings')
            );
            expect(updateCall).toBeDefined();
            expect(updateCall[0]).toContain('version =');
        });
    });

    describe('syncWithConflictResolution', () => {
        const validInput: SyncOfferingInput = {
            offeringId: '123e4567-e89b-12d3-a456-426614174000',
            expectedVersion: 5,
            newStatus: 'active',
            newTotalRaised: '10000.00',
            syncHash: 'a'.repeat(64),
            syncedAt: new Date('2026-03-24T12:00:00Z'),
        };

        it('should proceed with update when no conflict detected', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 5, updated_at: new Date(), sync_hash: 'old_hash' }],
            });

            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 5,
                        sync_hash: 'old_hash',
                        status: 'draft',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 6,
                        sync_hash: validInput.syncHash,
                        status: 'active',
                        total_raised: '10000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: validInput.syncedAt,
                    }],
                })
                .mockResolvedValueOnce({ rows: [] }); // COMMIT

            const result = await resolver.syncWithConflictResolution(validInput);

            expect(result.success).toBe(true);
            expect(result.resolved).toBe(true);
        });

        it('should reject stale data and require retry', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 10, updated_at: new Date(), sync_hash: 'current_hash' }],
            });

            const result = await resolver.syncWithConflictResolution(validInput);

            expect(result.success).toBe(false);
            expect(result.resolved).toBe(false);
            expect(result.strategy).toBe('retry');
            expect(result.error).toContain('Stale data');
            expect(result.finalVersion).toBe(10);
        });

        it('should apply blockchain state for concurrent updates', async () => {
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 6, updated_at: new Date(), sync_hash: 'different_hash' }],
            });

            mockClient.query
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 6,
                        sync_hash: 'different_hash',
                        status: 'draft',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 7,
                        sync_hash: validInput.syncHash,
                        status: 'active',
                        total_raised: '10000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: validInput.syncedAt,
                    }],
                })
                .mockResolvedValueOnce({ rows: [] }); // COMMIT

            const result = await resolver.syncWithConflictResolution(validInput);

            expect(result.success).toBe(true);
            expect(result.strategy).toBe('blockchain_wins');
        });
    });

    describe('validateSyncInput', () => {
        it('should validate correct input', () => {
            const validInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                newStatus: 'active',
                newTotalRaised: '10000.00',
                syncHash: 'a'.repeat(64),
                syncedAt: new Date('2026-03-24T12:00:00Z'),
            };

            const result = resolver.validateSyncInput(validInput);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should reject invalid UUID format', () => {
            const invalidInput: SyncOfferingInput = {
                offeringId: 'not-a-uuid',
                expectedVersion: 5,
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Invalid offering ID format');
        });

        it('should reject negative version', () => {
            const invalidInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: -1,
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Expected version must be non-negative');
        });

        it('should reject invalid status', () => {
            const invalidInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                newStatus: 'invalid_status' as any,
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Invalid status value');
        });

        it('should reject negative total_raised', () => {
            const invalidInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                newTotalRaised: '-100.00',
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Invalid total_raised value');
        });

        it('should reject invalid sync hash format', () => {
            const invalidInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                syncHash: 'not-a-valid-hash',
                syncedAt: new Date(),
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Invalid sync hash format');
        });

        it('should reject future timestamps', () => {
            const futureDate = new Date();
            futureDate.setFullYear(futureDate.getFullYear() + 1);

            const invalidInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                syncHash: 'a'.repeat(64),
                syncedAt: futureDate,
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Synced timestamp cannot be in the future');
        });

        it('should accumulate multiple validation errors', () => {
            const invalidInput: SyncOfferingInput = {
                offeringId: 'not-a-uuid',
                expectedVersion: -1,
                newStatus: 'invalid' as any,
                newTotalRaised: '-100',
                syncHash: 'short',
                syncedAt: new Date(Date.now() + 86400000),
            };

            const result = resolver.validateSyncInput(invalidInput);

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(3);
        });
    });

    describe('Security and Edge Cases', () => {
        it('should prevent SQL injection in offering ID', async () => {
            const maliciousInput: SyncOfferingInput = {
                offeringId: "'; DROP TABLE offerings; --",
                expectedVersion: 0,
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            const validation = resolver.validateSyncInput(maliciousInput);
            expect(validation.valid).toBe(false);
        });

        it('should handle database connection failures gracefully', async () => {
            (mockPool.connect as jest.Mock).mockRejectedValueOnce(
                new Error('Connection pool exhausted')
            );

            const validInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            await expect(resolver.resolveConflict(validInput)).rejects.toThrow();
        });

        it('should handle concurrent transactions deterministically', async () => {
            // Simulate two concurrent sync operations
            const input1: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                newStatus: 'active',
                syncHash: 'hash1' + 'a'.repeat(59),
                syncedAt: new Date('2026-03-24T12:00:00Z'),
            };

            const input2: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                newStatus: 'closed',
                syncHash: 'hash2' + 'b'.repeat(59),
                syncedAt: new Date('2026-03-24T12:00:01Z'),
            };

            // First transaction succeeds
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 5, updated_at: new Date(), sync_hash: 'old' }],
            });

            mockClient.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{
                        id: input1.offeringId,
                        version: 5,
                        sync_hash: 'old',
                        status: 'draft',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: input1.offeringId,
                        version: 6,
                        sync_hash: input1.syncHash,
                        status: 'active',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: input1.syncedAt,
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const result1 = await resolver.syncWithConflictResolution(input1);
            expect(result1.success).toBe(true);
            expect(result1.finalVersion).toBe(6);

            // Second transaction detects conflict
            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 6, updated_at: new Date(), sync_hash: input1.syncHash }],
            });

            const result2 = await resolver.syncWithConflictResolution(input2);
            expect(result2.finalVersion).toBe(6);
        });

        it('should maintain data integrity under high concurrency', async () => {
            const offeringId = '123e4567-e89b-12d3-a456-426614174000';
            const promises = [];

            for (let i = 0; i < 10; i++) {
                const input: SyncOfferingInput = {
                    offeringId,
                    expectedVersion: 5,
                    newTotalRaised: `${(i + 1) * 1000}.00`,
                    syncHash: `hash${i}`.padEnd(64, '0'),
                    syncedAt: new Date(),
                };

                (mockPool.query as jest.Mock).mockResolvedValue({
                    rows: [{ version: 5 + i, updated_at: new Date(), sync_hash: `hash${i - 1}` }],
                });

                promises.push(resolver.detectConflict(offeringId, 5));
            }

            const results = await Promise.all(promises);
            // At least one should detect a conflict
            const conflictDetected = results.some(r => r.hasConflict);
            expect(conflictDetected).toBe(true);
        });
    });

    describe('Performance and Reliability', () => {
        it('should complete sync operation within reasonable time', async () => {
            const validInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                newStatus: 'active',
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            (mockPool.query as jest.Mock).mockResolvedValueOnce({
                rows: [{ version: 5, updated_at: new Date(), sync_hash: 'old' }],
            });

            mockClient.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 5,
                        sync_hash: 'old',
                        status: 'draft',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: new Date(),
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        id: validInput.offeringId,
                        version: 6,
                        sync_hash: validInput.syncHash,
                        status: 'active',
                        total_raised: '5000.00',
                        contract_address: 'CONTRACT_ABC',
                        updated_at: validInput.syncedAt,
                    }],
                })
                .mockResolvedValueOnce({ rows: [] });

            const startTime = Date.now();
            await resolver.syncWithConflictResolution(validInput);
            const duration = Date.now() - startTime;

            expect(duration).toBeLessThan(1000); // Should complete in under 1 second
        });

        it('should release database connections even on error', async () => {
            mockClient.query.mockRejectedValueOnce(new Error('Database error'));

            const validInput: SyncOfferingInput = {
                offeringId: '123e4567-e89b-12d3-a456-426614174000',
                expectedVersion: 5,
                syncHash: 'a'.repeat(64),
                syncedAt: new Date(),
            };

            await resolver.resolveConflict(validInput);

            expect(mockClient.release).toHaveBeenCalled();
        });
    });
});
