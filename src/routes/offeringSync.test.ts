import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../app';
import { OfferingSyncService, SyncResult, StaleCatalogResult } from '../services/offeringSyncService';
import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';

// Mock the services and dependencies
jest.mock('../services/offeringSyncService');
jest.mock('../lib/logger');

const mockOfferingSyncService = OfferingSyncService as jest.MockedClass<typeof OfferingSyncService>;
const mockLogger = globalLogger as jest.Mocked<typeof globalLogger>;

describe('Offering Sync Routes', () => {
  let app: Express;
  let mockService: jest.Mocked<OfferingSyncService>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mock logger
    mockLogger.child = jest.fn().mockReturnValue(mockLogger);
    mockLogger.info = jest.fn();
    mockLogger.warn = jest.fn();
    mockLogger.error = jest.fn();
    mockLogger.debug = jest.fn();

    // Setup mock service
    mockService = {
      syncOffering: jest.fn(),
      syncAll: jest.fn(),
      recoverStaleCatalog: jest.fn(),
      getSyncStats: jest.fn(),
    } as any;

    mockOfferingSyncService.mockImplementation(() => mockService);

    app = createApp();
  });

  describe('POST /api/v1/offerings/sync', () => {
    const validToken = 'Bearer valid-jwt-token';
    const mockAuth = { authorization: validToken };

    it('syncs a single offering successfully', async () => {
      const syncResult: SyncResult = {
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_ABC',
        success: true,
        updated: true,
        duration: 150,
      };

      mockService.syncOffering.mockResolvedValue(syncResult);

      const response = await request(app)
        .post('/api/v1/offerings/sync')
        .set('Authorization', validToken)
        .send({ offeringId: 'offering-1' })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          offeringId: 'offering-1',
          contractAddress: 'CONTRACT_ABC',
          updated: true,
          duration: 150,
        },
      });

      expect(mockService.syncOffering).toHaveBeenCalledWith('offering-1');
      expect(mockLogger.info).toHaveBeenCalledWith('Sync offering request', {
        offeringId: 'offering-1',
        requestId: expect.any(String),
      });
    });

    it('returns 404 when offering is not found', async () => {
      const syncResult: SyncResult = {
        offeringId: 'missing',
        contractAddress: '',
        success: false,
        updated: false,
        error: 'Offering missing not found',
        duration: 50,
      };

      mockService.syncOffering.mockResolvedValue(syncResult);

      const response = await request(app)
        .post('/api/v1/offerings/sync')
        .set('Authorization', validToken)
        .send({ offeringId: 'missing' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.message).toBe('Not found');
    });

    it('returns 429 when rate limited by Stellar', async () => {
      const syncResult: SyncResult = {
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_ABC',
        success: false,
        updated: false,
        error: 'Rate limit exceeded',
        failureClass: 'RATE_LIMIT',
        duration: 100,
      };

      mockService.syncOffering.mockResolvedValue(syncResult);

      await request(app)
        .post('/api/v1/offerings/sync')
        .set('Authorization', validToken)
        .send({ offeringId: 'offering-1' })
        .expect(429);
    });

    it('returns 400 for invalid request body', async () => {
      const response = await request(app)
        .post('/api/v1/offerings/sync')
        .set('Authorization', validToken)
        .send({}) // Missing offeringId
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.message).toBe('Invalid request parameters');
    });

    it('returns 401 without authentication', async () => {
      await request(app)
        .post('/api/v1/offerings/sync')
        .send({ offeringId: 'offering-1' })
        .expect(401);
    });
  });

  describe('POST /api/v1/offerings/sync/all', () => {
    const validToken = 'Bearer valid-jwt-token';

    it('syncs all offerings successfully', async () => {
      const syncResults: SyncResult[] = [
        {
          offeringId: 'offering-1',
          contractAddress: 'CONTRACT_ABC',
          success: true,
          updated: true,
          duration: 150,
        },
        {
          offeringId: 'offering-2',
          contractAddress: 'CONTRACT_DEF',
          success: true,
          updated: false,
          duration: 100,
        },
      ];

      mockService.syncAll.mockResolvedValue(syncResults);

      const response = await request(app)
        .post('/api/v1/offerings/sync/all')
        .set('Authorization', validToken)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          summary: {
            total: 2,
            successful: 2,
            failed: 0,
            updated: 1,
          },
          results: [
            {
              offeringId: 'offering-1',
              contractAddress: 'CONTRACT_ABC',
              success: true,
              updated: true,
              duration: 150,
            },
            {
              offeringId: 'offering-2',
              contractAddress: 'CONTRACT_DEF',
              success: true,
              updated: false,
              duration: 100,
            },
          ],
        },
      });

      expect(mockService.syncAll).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Sync all offerings completed', {
        total: 2,
        successful: 2,
        failed: 0,
        updated: 1,
        requestId: expect.any(String),
      });
    });

    it('handles empty offerings list', async () => {
      mockService.syncAll.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/v1/offerings/sync/all')
        .set('Authorization', validToken)
        .expect(200);

      expect(response.body.data.summary).toEqual({
        total: 0,
        successful: 0,
        failed: 0,
        updated: 0,
      });
    });

    it('returns 401 without authentication', async () => {
      await request(app)
        .post('/api/v1/offerings/sync/all')
        .expect(401);
    });
  });

  describe('POST /api/v1/offerings/sync/recover-stale', () => {
    const validToken = 'Bearer valid-jwt-token';

    it('recovers stale catalog successfully', async () => {
      const recoveryResult: StaleCatalogResult = {
        totalProcessed: 5,
        staleFound: 5,
        updated: 3,
        failed: 2,
        errors: [
          {
            offeringId: 'offering-4',
            error: 'RPC timeout',
            failureClass: 'TIMEOUT',
          },
          {
            offeringId: 'offering-5',
            error: 'Network error',
            failureClass: 'UPSTREAM_ERROR',
          },
        ],
        duration: 2500,
      };

      mockService.recoverStaleCatalog.mockResolvedValue(recoveryResult);

      const response = await request(app)
        .post('/api/v1/offerings/sync/recover-stale')
        .set('Authorization', validToken)
        .send({
          staleThresholdHours: 12,
          batchSize: 25,
          autoUpdate: true,
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: recoveryResult,
      });

      expect(mockService.recoverStaleCatalog).toHaveBeenCalledWith({
        staleThresholdHours: 12,
        batchSize: 25,
        autoUpdate: true,
      });
    });

    it('uses default configuration when none provided', async () => {
      const recoveryResult: StaleCatalogResult = {
        totalProcessed: 0,
        staleFound: 0,
        updated: 0,
        failed: 0,
        errors: [],
        duration: 100,
      };

      mockService.recoverStaleCatalog.mockResolvedValue(recoveryResult);

      await request(app)
        .post('/api/v1/offerings/sync/recover-stale')
        .set('Authorization', validToken)
        .send({})
        .expect(200);

      expect(mockService.recoverStaleCatalog).toHaveBeenCalledWith({});
    });

    it('returns 400 for invalid configuration', async () => {
      const response = await request(app)
        .post('/api/v1/offerings/sync/recover-stale')
        .set('Authorization', validToken)
        .send({
          staleThresholdHours: 200, // Exceeds max of 168
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without authentication', async () => {
      await request(app)
        .post('/api/v1/offerings/sync/recover-stale')
        .expect(401);
    });
  });

  describe('GET /api/v1/offerings/sync/stats', () => {
    const validToken = 'Bearer valid-jwt-token';

    it('returns sync statistics', async () => {
      const stats = {
        totalOfferings: 10,
        withContractAddress: 8,
        recentlyUpdated: 6,
        staleThreshold: new Date('2024-01-01T00:00:00.000Z'),
      };

      mockService.getSyncStats.mockResolvedValue(stats);

      const response = await request(app)
        .get('/api/v1/offerings/sync/stats')
        .set('Authorization', validToken)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          ...stats,
          staleThreshold: stats.staleThreshold.toISOString(),
        },
      });

      expect(mockService.getSyncStats).toHaveBeenCalled();
    });

    it('returns 401 without authentication', async () => {
      await request(app)
        .get('/api/v1/offerings/sync/stats')
        .expect(401);
    });
  });

  describe('Error Handling', () => {
    const validToken = 'Bearer valid-jwt-token';

    it('handles service errors gracefully', async () => {
      mockService.syncOffering.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app)
        .post('/api/v1/offerings/sync')
        .set('Authorization', validToken)
        .send({ offeringId: 'offering-1' })
        .expect(500);

      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Sync offering handler error',
        expect.objectContaining({
          error: 'Database connection failed',
        })
      );
    });

    it('handles stale catalog recovery errors', async () => {
      mockService.recoverStaleCatalog.mockRejectedValue(new Error('Service unavailable'));

      const response = await request(app)
        .post('/api/v1/offerings/sync/recover-stale')
        .set('Authorization', validToken)
        .send({})
        .expect(500);

      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Recover stale catalog handler error',
        expect.objectContaining({
          error: 'Service unavailable',
        })
      );
    });

    it('handles sync all errors', async () => {
      mockService.syncAll.mockRejectedValue(new Error('Network timeout'));

      const response = await request(app)
        .post('/api/v1/offerings/sync/all')
        .set('Authorization', validToken)
        .expect(500);

      expect(response.body.code).toBe('INTERNAL_ERROR');
    });

    it('handles stats errors', async () => {
      mockService.getSyncStats.mockRejectedValue(new Error('Query failed'));

      const response = await request(app)
        .get('/api/v1/offerings/sync/stats')
        .set('Authorization', validToken)
        .expect(500);

      expect(response.body.code).toBe('INTERNAL_ERROR');
    });
  });
});
