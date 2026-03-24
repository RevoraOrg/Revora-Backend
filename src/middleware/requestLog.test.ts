import { Request, Response, NextFunction } from 'express';
import { requestLogMiddleware } from './requestLog';

describe('requestLogMiddleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    mockReq = {
      method: 'GET',
      path: '/health',
      ip: '127.0.0.1',
      get: jest.fn().mockReturnValue('TestAgent/1.0'),
    };
    mockRes = {
      statusCode: 200,
      end: jest.fn(),
    };
    mockNext = jest.fn();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should log request start and end', () => {
    const middleware = requestLogMiddleware();
    middleware(mockReq as Request, mockRes as Response, mockNext);

    // Simulate response end
    mockRes.end!();

    expect(mockNext).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);

    const startLog = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(startLog.type).toBe('request_start');
    expect(startLog.method).toBe('GET');
    expect(startLog.path).toBe('/health');

    const endLog = JSON.parse(consoleLogSpy.mock.calls[1][0]);
    expect(endLog.type).toBe('request_end');
    expect(endLog.method).toBe('GET');
    expect(endLog.path).toBe('/health');
    expect(endLog.status).toBe(200);
    expect(endLog.duration).toBeDefined();
  });

  it('should audit sensitive action', () => {
    (mockReq as any).method = 'POST';
    (mockReq as any).path = '/auth/login';
    (mockReq as any).user = { id: 'user-123' };

    const middleware = requestLogMiddleware();
    middleware(mockReq as Request, mockRes as Response, mockNext);

    mockRes.end!();

    expect(consoleLogSpy).toHaveBeenCalledTimes(3);

    const auditLog = JSON.parse(consoleLogSpy.mock.calls[2][0]);
    expect(auditLog.type).toBe('audit');
    expect(auditLog.action).toBe('login');
    expect(auditLog.userId).toBe('user-123');
  });

  it('should not audit non-sensitive action', () => {
    (mockReq as any).method = 'GET';
    (mockReq as any).path = '/health';

    const middleware = requestLogMiddleware();
    middleware(mockReq as Request, mockRes as Response, mockNext);

    mockRes.end!();

    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    // No audit log
  });
});