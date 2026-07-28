import { Request, Response } from 'express';
import { requestIdMiddleware } from '../requestId';
import { errorHandler } from '../errorHandler';
import { Logger } from '../../lib/logger';
import { AppError, Errors } from '../../lib/errors';

// Helper mock structures - casting directly to any avoids complex Express interface mismatches
function createMockRequest(headers: Record<string, string | string[]> = {}): Partial<Request> {
  return {
    headers,
    method: 'GET',
    path: '/test-route',
  } as unknown as Request;
}

function createMockResponse(): any {
  const headers = new Map<string, string>();
  const res: any = {
    statusCode: 200,
    setHeader: jest.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
      return res;
    }),
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('Request ID Propagation Pipeline', () => {
  let mockConsoleLog: jest.SpyInstance;
  let mockConsoleError: jest.SpyInstance;

  beforeEach(() => {
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  describe('requestIdMiddleware', () => {
    it('should reuse an incoming X-Request-Id header value', () => {
      const req = createMockRequest({ 'x-request-id': 'client-provided-id-123' }) as Request;
      const res = createMockResponse() as Response;
      const next = jest.fn();

      requestIdMiddleware()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.requestId).toBe('client-provided-id-123');
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-provided-id-123');
      expect(req.logger).toBeInstanceOf(Logger);
    });

    it('should automatically generate a unique random UUID string if the tracking header is absent', () => {
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = jest.fn();

      requestIdMiddleware()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.requestId).toBeDefined();
      // FIX: Standard Jest asymmetric object matcher equality verification syntax
      expect(req.requestId).toEqual(uuidAsymmetricMatcher);
    });

    it('should attach a valid child logger that automatically passes down context details', () => {
      const req = createMockRequest({ 'x-request-id': 'trace-id-999' }) as Request;
      const res = createMockResponse() as Response;
      const next = jest.fn();

      requestIdMiddleware()(req, res, next);

      req.logger?.info('Sample operational event string');

      expect(mockConsoleLog).toHaveBeenCalled();
      const rawLogPayload = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(rawLogPayload.requestId).toBe('trace-id-999');
      expect(rawLogPayload.message).toBe('Sample operational event string');
    });
  });

  describe('errorHandler Global Router Integration', () => {
    it('should intercept thrown AppErrors, trace logging, and structure json responses properly', () => {
      const req = createMockRequest({ 'x-request-id': 'err-trace-111' }) as Request;
      const res = createMockResponse() as Response;
      const next = jest.fn();

      requestIdMiddleware()(req, res, next);

      const standardError = Errors.badRequest('Client Payload Mismatch');
      errorHandler(standardError, req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'err-trace-111');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'err-trace-111',
          code: 'BAD_REQUEST',
        })
      );
    });

    it('should downgrade unmapped exceptions safely inside production parameters', () => {
      const req = createMockRequest({ 'x-request-id': 'fatal-500-trace' }) as Request;
      const res = createMockResponse() as Response;
      const next = jest.fn();

      requestIdMiddleware()(req, res, next);

      const nativeFatalError = new Error('Database hardware timeout fault down');
      errorHandler(nativeFatalError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockConsoleError).toHaveBeenCalled();
      
      const loggedOutput = JSON.parse(mockConsoleError.mock.calls[0][0]);
      expect(loggedOutput.requestId).toBe('fatal-500-trace');
    });
  });
});

// Structural UUID shape matching regex context bounds definition
const uuidShapeRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidAsymmetricMatcher = {
  asymmetricMatch: (actual: string) => uuidShapeRegex.test(actual),
};