"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const requestLog_1 = require("./requestLog");
describe('requestLogMiddleware', () => {
    let mockReq;
    let mockRes;
    let mockNext;
    let consoleLogSpy;
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
        const middleware = (0, requestLog_1.requestLogMiddleware)();
        middleware(mockReq, mockRes, mockNext);
        // Simulate response end
        mockRes.end();
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
        mockReq.method = 'POST';
        mockReq.path = '/auth/login';
        mockReq.user = { id: 'user-123' };
        const middleware = (0, requestLog_1.requestLogMiddleware)();
        middleware(mockReq, mockRes, mockNext);
        mockRes.end();
        expect(consoleLogSpy).toHaveBeenCalledTimes(3);
        const auditLog = JSON.parse(consoleLogSpy.mock.calls[2][0]);
        expect(auditLog.type).toBe('audit');
        expect(auditLog.action).toBe('login');
        expect(auditLog.userId).toBe('user-123');
    });
    it('should not audit non-sensitive action', () => {
        mockReq.method = 'GET';
        mockReq.path = '/health';
        const middleware = (0, requestLog_1.requestLogMiddleware)();
        middleware(mockReq, mockRes, mockNext);
        mockRes.end();
        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        // No audit log
    });
});
