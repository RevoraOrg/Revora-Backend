import { RevenueHandler } from './revenueHandler';
import { RevenueService } from '../services/revenueService';
import { AppError, Errors } from '../lib/errors';
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';

/**
 * Comprehensive test suite for RevenueHandler
 *
 * Coverage Targets:
 * - Both submitReport and submitReportByBody methods
 * - Success paths and error handling
 * - AppError responses and structured logging
 * - Authentication and authorization
 * - Input validation and field presence checks
 *
 * Security Assumptions:
 * - AuthenticatedRequest.user is set by JWT middleware if authenticated
 * - req.id contains the request tracking ID for logging
 */
describe('RevenueHandler', () => {
    let handler: RevenueHandler;
    let mockRevenueService: jest.Mocked<RevenueService>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock<void, [error?: unknown]>;

    function makeAuthenticatedRequest(
        overrides: Partial<AuthenticatedRequest> = {}
    ): AuthenticatedRequest {
        return {
            requestId: 'req-123',
            user: { id: 'issuer-1' },
            params: {},
            body: {},
            ...overrides,
        } as AuthenticatedRequest;
    }

    function makeResponse(): Partial<Response> {
        let statusCode = 200;
        let jsonData: unknown = null;
        let sentStatus = false;

        return {
            status(code: number) {
                statusCode = code;
                sentStatus = true;
                return this;
            },
            json(obj: unknown) {
                jsonData = obj;
                return this;
            },
            _getStatus() {
                return statusCode;
            },
            _getJson() {
                return jsonData;
            },
            _isSent() {
                return sentStatus;
            },
        };
    }

    beforeEach(() => {
        mockRevenueService = {
            submitReport: jest.fn(),
        } as any;

        handler = new RevenueHandler(mockRevenueService);
        mockNext = jest.fn();
    });

    describe('submitReport: path parameter based submission', () => {
        describe('Success path', () => {
            it('should return 201 with report data on successful submission', async () => {
                const mockReport = {
                    id: 'report-1',
                    offering_id: 'offering-1',
                    amount: '1000.00',
                };

                mockRevenueService.submitReport.mockResolvedValue(mockReport as any);
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01T00:00:00Z',
                        periodEnd: '2024-01-31T00:00:00Z',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect((mockRes as any)._getStatus()).toBe(201);
                expect((mockRes as any)._getJson()).toEqual({
                    message: 'Revenue report submitted successfully',
                    data: mockReport,
                });
                expect(mockNext).not.toHaveBeenCalled();
            });

            it('should call service with correct parameters including request ID', async () => {
                mockRevenueService.submitReport.mockResolvedValue({ id: 'report-1' } as any);
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    requestId: 'req-custom-456',
                    params: { id: 'offering-1' },
                    body: {
                        amount: '500.50',
                        periodStart: '2024-02-01',
                        periodEnd: '2024-02-28',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockRevenueService.submitReport).toHaveBeenCalledWith({
                    offeringId: 'offering-1',
                    issuerId: 'issuer-1',
                    amount: '500.50',
                    periodStart: new Date('2024-02-01'),
                    periodEnd: new Date('2024-02-28'),
                    requestId: 'req-custom-456',
                });
            });
        });

        describe('Authentication errors', () => {
            it('should reject request without authenticated user', async () => {
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    user: undefined, // No authenticated user
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(401);
                expect(error.code).toBe('UNAUTHORIZED');
            });

            it('should reject request with null user', async () => {
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    user: null,
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                } as any);

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });
        });

        describe('Input validation errors', () => {
            beforeEach(() => {
                mockRes = makeResponse();
            });

            it('should reject request missing amount field', async () => {
                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        // amount is missing
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(400);
            });

            it('should reject request missing periodStart field', async () => {
                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        // periodStart is missing
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });

            it('should reject request missing periodEnd field', async () => {
                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        // periodEnd is missing
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });

            it('should reject request with empty body', async () => {
                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {},
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });
        });

        describe('Service layer errors', () => {
            beforeEach(() => {
                mockRes = makeResponse();
            });

            it('should forward AppError from service to next handler', async () => {
                const serviceError = Errors.notFound('Offering not found');
                mockRevenueService.submitReport.mockRejectedValue(serviceError);

                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(serviceError);
            });

            it('should sanitize unexpected errors from service', async () => {
                const unexpectedError = new Error('Database connection failed');
                mockRevenueService.submitReport.mockRejectedValue(unexpectedError);

                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(500);
                expect(error.code).toBe('INTERNAL_ERROR');
                expect(error.expose).toBe(false);
            });

            it('should sanitize non-Error thrown values', async () => {
                mockRevenueService.submitReport.mockRejectedValue('string error');

                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.code).toBe('INTERNAL_ERROR');
            });

            it('should handle service authorization errors correctly', async () => {
                const forbiddenError = Errors.forbidden('You do not have permission');
                mockRevenueService.submitReport.mockRejectedValue(forbiddenError);

                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(forbiddenError);
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(403);
            });

            it('should handle service conflict errors (overlapping periods)', async () => {
                const conflictError = Errors.conflict('Period overlaps with existing report');
                mockRevenueService.submitReport.mockRejectedValue(conflictError);

                const req = makeAuthenticatedRequest({
                    params: { id: 'offering-1' },
                    body: {
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReport(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(conflictError);
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(409);
            });
        });
    });

    describe('submitReportByBody: body-based offering ID submission', () => {
        describe('Success path', () => {
            it('should return 201 with report data on successful submission', async () => {
                const mockReport = {
                    id: 'report-1',
                    offering_id: 'offering-1',
                    amount: '2000.00',
                };

                mockRevenueService.submitReport.mockResolvedValue(mockReport as any);
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-1',
                        amount: '2000.00',
                        periodStart: '2024-01-01T00:00:00Z',
                        periodEnd: '2024-01-31T00:00:00Z',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect((mockRes as any)._getStatus()).toBe(201);
                expect((mockRes as any)._getJson()).toEqual({
                    message: 'Revenue report submitted successfully',
                    data: mockReport,
                });
            });

            it('should call service with offeringId from body', async () => {
                mockRevenueService.submitReport.mockResolvedValue({ id: 'report-1' } as any);
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-2',
                        amount: '500.50',
                        periodStart: '2024-02-01',
                        periodEnd: '2024-02-28',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockRevenueService.submitReport).toHaveBeenCalledWith(
                    expect.objectContaining({
                        offeringId: 'offering-2',
                        issuerId: 'issuer-1',
                    })
                );
            });
        });

        describe('Authentication errors', () => {
            it('should reject request without authenticated user', async () => {
                mockRes = makeResponse();

                const req = makeAuthenticatedRequest({
                    user: undefined,
                    body: {
                        offeringId: 'offering-1',
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(401);
            });
        });

        describe('Input validation errors', () => {
            beforeEach(() => {
                mockRes = makeResponse();
            });

            it('should reject request missing offeringId field', async () => {
                const req = makeAuthenticatedRequest({
                    body: {
                        // offeringId is missing
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.statusCode).toBe(400);
            });

            it('should reject request missing amount field', async () => {
                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-1',
                        // amount is missing
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });

            it('should reject request missing periodStart field', async () => {
                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-1',
                        amount: '1000.00',
                        // periodStart is missing
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });

            it('should reject request missing periodEnd field', async () => {
                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-1',
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        // periodEnd is missing
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
            });
        });

        describe('Service layer errors', () => {
            beforeEach(() => {
                mockRes = makeResponse();
            });

            it('should forward AppError from service to next handler', async () => {
                const serviceError = Errors.forbidden('You do not have permission');
                mockRevenueService.submitReport.mockRejectedValue(serviceError);

                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-1',
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(serviceError);
            });

            it('should sanitize unexpected errors', async () => {
                const unexpectedError = new Error('Database error');
                mockRevenueService.submitReport.mockRejectedValue(unexpectedError);

                const req = makeAuthenticatedRequest({
                    body: {
                        offeringId: 'offering-1',
                        amount: '1000.00',
                        periodStart: '2024-01-01',
                        periodEnd: '2024-01-31',
                    },
                });

                await handler.submitReportByBody(req, mockRes as Response, mockNext);

                expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
                const error = (mockNext as jest.Mock).mock.calls[0][0];
                expect(error.code).toBe('INTERNAL_ERROR');
            });
        });
    });

    describe('Edge cases', () => {
        beforeEach(() => {
            mockRes = makeResponse();
        });

        it('should handle missing request ID gracefully', async () => {
            mockRevenueService.submitReport.mockResolvedValue({ id: 'report-1' } as any);

            const req = makeAuthenticatedRequest({
                requestId: undefined,
                params: { id: 'offering-1' },
                body: {
                    amount: '1000.00',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                },
            } as any);

            await handler.submitReport(req, mockRes as Response, mockNext);

            expect((mockRes as any)._getStatus()).toBe(201);
        });

        it('should handle large amounts within decimal boundaries', async () => {
            mockRevenueService.submitReport.mockResolvedValue({
                id: 'report-1',
                amount: '99999999999999999999.9999999999',
            } as any);

            const req = makeAuthenticatedRequest({
                params: { id: 'offering-1' },
                body: {
                    amount: '99999999999999999999.9999999999',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                },
            });

            await handler.submitReport(req, mockRes as Response, mockNext);

            expect((mockRes as any)._getStatus()).toBe(201);
            expect(mockRevenueService.submitReport).toHaveBeenCalled();
        });

        it('should handle very small amounts', async () => {
            mockRevenueService.submitReport.mockResolvedValue({
                id: 'report-1',
                amount: '0.0000000001',
            } as any);

            const req = makeAuthenticatedRequest({
                params: { id: 'offering-1' },
                body: {
                    amount: '0.0000000001',
                    periodStart: '2024-01-01',
                    periodEnd: '2024-01-31',
                },
            });

            await handler.submitReport(req, mockRes as Response, mockNext);

            expect((mockRes as any)._getStatus()).toBe(201);
        });
    });
});
