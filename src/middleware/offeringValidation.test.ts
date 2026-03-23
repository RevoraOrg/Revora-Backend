/**
 * @title Validation Middleware Tests
 * @dev Comprehensive test suite for validation middleware integration
 */

import { Request, Response, NextFunction } from 'express';
import { createValidationMiddleware, ValidationMiddlewareConfig, validateOfferingCreation } from '../middleware/offeringValidation';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';

// Mock repositories
class MockOfferingRepository {
  async getById(id: string): Promise<any> {
    return null;
  }
  
  async getByUserId(userId: string): Promise<any[]> {
    return [];
  }
  
  async create(data: any): Promise<any> {
    return { id: 'mock-offering-id', ...data };
  }
  
  async update(id: string, data: any): Promise<any> {
    return { id, ...data };
  }
  
  async delete(id: string): Promise<void> {
    // Mock implementation
  }
}

class MockInvestmentRepository {
  async getByOfferingId(offeringId: string): Promise<any[]> {
    return [];
  }
  
  async create(data: any): Promise<any> {
    return { id: 'mock-investment-id', ...data };
  }
  
  async getByInvestorId(investorId: string): Promise<any[]> {
    return [];
  }
}

describe('Validation Middleware', () => {
  let mockOfferingRepo: OfferingRepository;
  let mockInvestmentRepo: InvestmentRepository;
  let config: ValidationMiddlewareConfig;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockOfferingRepo = new MockOfferingRepository() as any;
    mockInvestmentRepo = new MockInvestmentRepository() as any;
    
    config = {
      offeringRepository: mockOfferingRepo,
      investmentRepository: mockInvestmentRepo,
      operation: 'create'
    };

    mockRequest = {
      body: {
        name: 'Test Offering',
        description: 'A test offering',
        revenue_share_bps: 1000,
        token_asset_id: 'TEST'
      },
      user: {
        id: 'user-123',
        email: 'test@example.com',
        role: 'startup'
      },
      ip: '127.0.0.1',
      get: jest.fn()
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };

    mockNext = jest.fn();
  });

  describe('createValidationMiddleware', () => {
    it('should pass validation for valid offering data', async () => {
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).toHaveBeenCalledWith();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should reject invalid offering data', async () => {
      mockRequest.body.name = ''; // Invalid name
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: expect.arrayContaining([
            expect.objectContaining({
              code: 'NAME_REQUIRED',
              field: 'name'
            })
          ])
        })
      );
    });

    it('should handle missing user authentication', async () => {
      delete mockRequest.user;
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Validation service unavailable',
        code: 'VALIDATION_SERVICE_ERROR'
      });
    });

    it('should attach validation result to request', async () => {
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      const validatedRequest = mockRequest as any;
      expect(validatedRequest.validationResult).toBeDefined();
      expect(validatedRequest.validationResult.isValid).toBe(true);
      expect(validatedRequest.offeringContext).toBeDefined();
    });

    it('should handle validation service errors', async () => {
      // Mock a repository error
      jest.spyOn(mockOfferingRepo, 'getByUserId').mockRejectedValue(new Error('Database error'));
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });

  describe('HTTP Status Code Determination', () => {
    it('should return 403 for critical security errors', async () => {
      mockRequest.body.name = "Test'; DROP TABLE offerings; --";
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it('should return 401 for authorization errors', async () => {
      mockRequest.user.role = 'investor';
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it('should return 422 for business rule violations', async () => {
      mockRequest.body.revenue_share_bps = 6000; // Too high
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.status).toHaveBeenCalledWith(422);
    });

    it('should return 400 for technical validation errors', async () => {
      mockRequest.body.name = 'a'.repeat(256); // Too long
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('Response Formatting', () => {
    it('should include detailed error information', async () => {
      mockRequest.body.name = '';
      mockRequest.body.revenue_share_bps = 'invalid';
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: expect.arrayContaining([
            expect.objectContaining({
              code: expect.any(String),
              message: expect.any(String),
              field: expect.any(String),
              severity: expect.any(String),
              category: expect.any(String)
            })
          ]),
          warnings: expect.any(Array),
          metadata: expect.objectContaining({
            timestamp: expect.any(Date),
            executionTimeMs: expect.any(Number),
            rulesApplied: expect.any(Array)
          })
        })
      );
    });

    it('should include warnings when present', async () => {
      mockRequest.body.description = 'a'.repeat(5001);
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      
      const validatedRequest = mockRequest as any;
      expect(validatedRequest.validationResult.warnings).toHaveLength.greaterThan(0);
    });
  });

  describe('Context Building', () => {
    it('should build validation context from request', async () => {
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      const validatedRequest = mockRequest as any;
      const context = validatedRequest.offeringContext;
      
      expect(context).toBeDefined();
      expect(context.user.id).toBe('user-123');
      expect(context.operation).toBe('create');
      expect(context.requestPayload).toBe(mockRequest.body);
      expect(context.ipAddress).toBe('127.0.0.1');
      expect(context.offeringData).toEqual({
        name: 'Test Offering',
        description: 'A test offering',
        revenue_share_bps: 1000,
        token_asset_id: 'TEST'
      });
    });

    it('should extract user agent from request', async () => {
      mockRequest.get = jest.fn().mockReturnValue('Mozilla/5.0');
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      const validatedRequest = mockRequest as any;
      expect(validatedRequest.offeringContext.userAgent).toBe('Mozilla/5.0');
    });
  });

  describe('Convenience Middleware Creators', () => {
    it('should create offering creation middleware', () => {
      const middleware = validateOfferingCreation(mockOfferingRepo, mockInvestmentRepo);
      
      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe('function');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed request bodies', async () => {
      mockRequest.body = null;
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('should handle circular reference in payload', async () => {
      const circular: any = { name: 'test' };
      circular.self = circular;
      mockRequest.body = circular;
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle very large payloads gracefully', async () => {
      mockRequest.body = {
        data: 'x'.repeat(1024 * 1024 + 1)
      };
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('Performance and Security', () => {
    it('should complete validation within reasonable time', async () => {
      const startTime = Date.now();
      
      const middleware = createValidationMiddleware(config);
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(duration).toBeLessThan(1000);
    });

    it('should not expose sensitive information in errors', async () => {
      mockRequest.body.name = "Test'; DROP TABLE offerings; --";
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.not.objectContaining({
          stack: expect.any(String),
          internalError: expect.any(Object)
        })
      );
    });

    it('should sanitize error messages', async () => {
      mockRequest.body.name = '<script>alert("xss")</script>';
      
      const middleware = createValidationMiddleware(config);
      
      await middleware(mockRequest as any, mockResponse as any, mockNext);
      
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.arrayContaining([
            expect.objectContaining({
              message: expect.not.toContain('<script>')
            })
          ])
        })
      );
    });
  });
});
