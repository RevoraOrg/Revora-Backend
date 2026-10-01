/**
 * Comprehensive test suite for TaxationHandler
 *
 * Coverage Targets:
 * - All six handler methods: processDisposal, previewDisposal, getGainsSummary, listLots, detectWashSales, createLot
 * - Success paths and error handling
 * - AppError responses and structured logging
 * - Authentication and authorization
 * - Input validation and field presence checks
 * - Type validation for numeric inputs
 * - Strategy validation
 * - Edge cases and boundary conditions
 *
 * Security Assumptions:
 * - AuthenticatedRequest.user is set by JWT middleware if authenticated
 * - req.requestId contains the request tracking ID for logging
 * - User can only access their own tax data
 */

import { TaxationHandler } from './taxationHandler';
import { TaxationService } from '../services/taxation/taxationService';
import { AppError, Errors } from '../lib/errors';
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';

describe('TaxationHandler', () => {
  let handler: TaxationHandler;
  let mockTaxationService: jest.Mocked<TaxationService>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock<void, [error?: unknown]>;

  function makeAuthenticatedRequest(
    overrides: Partial<AuthenticatedRequest> = {}
  ): AuthenticatedRequest {
    return {
      requestId: 'req-123',
      user: { id: 'user-1', sub: 'user-1' },
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
    mockTaxationService = {
      processDisposal: jest.fn(),
      previewDisposal: jest.fn(),
      getJurisdictionGainsSummary: jest.fn(),
      listLots: jest.fn(),
      detectWashSales: jest.fn(),
      createLot: jest.fn(),
    } as any;

    handler = new TaxationHandler(mockTaxationService);
    mockNext = jest.fn();
  });

  describe('processDisposal', () => {
    describe('Success path', () => {
      it('should return 201 with disposal result on successful processing', async () => {
        const mockResult = {
          realizedGainLoss: 500.50,
          strategy: 'FIFO',
          allocations: [
            { lot_id: 'lot-1', quantity: 10, cost_basis: 100, realized_gain_loss: 250 },
            { lot_id: 'lot-2', quantity: 5, cost_basis: 50, realized_gain_loss: 250.50 },
          ],
        };

        mockTaxationService.processDisposal.mockResolvedValue(mockResult as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 15,
            disposal_price_per_unit: 120,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(201);
        expect((mockRes as any)._getJson()).toEqual({
          message: 'Disposal processed successfully',
          data: mockResult,
        });
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should call service with correct parameters', async () => {
        mockTaxationService.processDisposal.mockResolvedValue({
          realizedGainLoss: 100,
          strategy: 'LIFO',
          allocations: [],
        } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { id: 'user-123' },
          body: {
            offering_id: 'offering-xyz',
            quantity: 20,
            disposal_price_per_unit: 150.75,
            strategy: 'LIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockTaxationService.processDisposal).toHaveBeenCalledWith(
          expect.objectContaining({
            investor_id: 'user-123',
            offering_id: 'offering-xyz',
            quantity: 20,
            disposal_price_per_unit: 150.75,
            strategy: 'LIFO',
            disposed_at: expect.any(Date),
          })
        );
      });

      it('should accept all valid strategies: FIFO, LIFO, HIFO', async () => {
        mockTaxationService.processDisposal.mockResolvedValue({
          realizedGainLoss: 0,
          strategy: 'HIFO',
          allocations: [],
        } as any);
        mockRes = makeResponse();

        const strategies = ['FIFO', 'LIFO', 'HIFO'];

        for (const strategy of strategies) {
          const req = makeAuthenticatedRequest({
            body: {
              offering_id: 'offering-1',
              quantity: 10,
              disposal_price_per_unit: 100,
              strategy,
            },
          });

          await handler.processDisposal(req, mockRes as Response, mockNext);

          expect(mockTaxationService.processDisposal).toHaveBeenCalledWith(
            expect.objectContaining({ strategy })
          );
        }
      });
    });

    describe('Authentication errors', () => {
      it('should reject request without authenticated user', async () => {
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: undefined,
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(401);
        expect(error.code).toBe('UNAUTHORIZED');
      });

      it('should reject request with null user', async () => {
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: null,
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        } as any);

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      });

      it('should use sub if id is not available', async () => {
        mockTaxationService.processDisposal.mockResolvedValue({
          realizedGainLoss: 0,
          strategy: 'FIFO',
          allocations: [],
        } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { sub: 'user-sub-123' },
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        } as any);

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockTaxationService.processDisposal).toHaveBeenCalledWith(
          expect.objectContaining({ investor_id: 'user-sub-123' })
        );
      });
    });

    describe('Input validation errors', () => {
      beforeEach(() => {
        mockRes = makeResponse();
      });

      it('should reject request missing offering_id', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(400);
        expect(error.message).toContain('offering_id');
      });

      it('should reject request missing quantity', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('quantity');
      });

      it('should reject request missing disposal_price_per_unit', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('disposal_price_per_unit');
      });

      it('should reject request missing strategy', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('strategy');
      });

      it('should reject non-numeric quantity', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 'invalid',
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('positive number');
      });

      it('should reject zero or negative quantity', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: -5,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      });

      it('should reject non-numeric disposal_price_per_unit', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 'invalid',
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      });

      it('should reject negative disposal_price_per_unit', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: -50,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      });

      it('should reject invalid strategy', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'INVALID_STRATEGY',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('Invalid strategy');
      });

      it('should accept zero disposal_price_per_unit', async () => {
        mockTaxationService.processDisposal.mockResolvedValue({
          realizedGainLoss: 0,
          strategy: 'FIFO',
          allocations: [],
        } as any);

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 0,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(201);
      });
    });

    describe('Service layer errors', () => {
      beforeEach(() => {
        mockRes = makeResponse();
      });

      it('should forward AppError from service', async () => {
        const serviceError = Errors.notFound('Investment lot not found');
        mockTaxationService.processDisposal.mockRejectedValue(serviceError);

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(serviceError);
      });

      it('should sanitize unexpected errors from service', async () => {
        const unexpectedError = new Error('Database connection failed');
        mockTaxationService.processDisposal.mockRejectedValue(unexpectedError);

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.processDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(500);
        expect(error.code).toBe('INTERNAL_ERROR');
      });
    });
  });

  describe('previewDisposal', () => {
    describe('Success path', () => {
      it('should return 200 with preview result', async () => {
        const mockResult = {
          realizedGainLoss: 300,
          strategy: 'LIFO',
          allocations: [{ lot_id: 'lot-1', quantity: 10 }],
        };

        mockTaxationService.previewDisposal.mockResolvedValue(mockResult as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'LIFO',
          },
        });

        await handler.previewDisposal(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(200);
        expect((mockRes as any)._getJson()).toEqual({
          message: 'Disposal preview generated successfully',
          data: mockResult,
        });
      });

      it('should call previewDisposal service method', async () => {
        mockTaxationService.previewDisposal.mockResolvedValue({
          realizedGainLoss: 0,
          strategy: 'HIFO',
          allocations: [],
        } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { id: 'user-456' },
          body: {
            offering_id: 'offering-2',
            quantity: 25,
            disposal_price_per_unit: 200,
            strategy: 'HIFO',
          },
        });

        await handler.previewDisposal(req, mockRes as Response, mockNext);

        expect(mockTaxationService.previewDisposal).toHaveBeenCalledWith({
          investor_id: 'user-456',
          offering_id: 'offering-2',
          quantity: 25,
          disposal_price_per_unit: 200,
          strategy: 'HIFO',
        });
      });
    });

    describe('Validation errors', () => {
      beforeEach(() => {
        mockRes = makeResponse();
      });

      it('should require authentication', async () => {
        const req = makeAuthenticatedRequest({
          user: undefined,
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'FIFO',
          },
        });

        await handler.previewDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(401);
      });

      it('should validate all required fields', async () => {
        const req = makeAuthenticatedRequest({
          body: {},
        });

        await handler.previewDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      });

      it('should validate strategy', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            quantity: 10,
            disposal_price_per_unit: 100,
            strategy: 'BAD_STRATEGY',
          },
        });

        await handler.previewDisposal(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('Invalid strategy');
      });
    });
  });

  describe('getGainsSummary', () => {
    describe('Success path', () => {
      it('should return 200 with gains summary', async () => {
        const mockSummary = [
          { jurisdiction: 'US', totalGains: 5000, totalLosses: 1000 },
          { jurisdiction: 'UK', totalGains: 3000, totalLosses: 500 },
        ];

        mockTaxationService.getJurisdictionGainsSummary.mockResolvedValue(mockSummary as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest();

        await handler.getGainsSummary(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(200);
        expect((mockRes as any)._getJson()).toEqual({
          message: 'Gains summary retrieved successfully',
          data: mockSummary,
        });
      });

      it('should call service with userId', async () => {
        mockTaxationService.getJurisdictionGainsSummary.mockResolvedValue([]);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { id: 'user-789' },
        });

        await handler.getGainsSummary(req, mockRes as Response, mockNext);

        expect(mockTaxationService.getJurisdictionGainsSummary).toHaveBeenCalledWith('user-789');
      });
    });

    describe('Authentication errors', () => {
      it('should require authenticated user', async () => {
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: undefined,
        });

        await handler.getGainsSummary(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(401);
      });
    });

    describe('Service errors', () => {
      it('should handle service errors', async () => {
        mockRes = makeResponse();
        const serviceError = Errors.internal('Database error');
        mockTaxationService.getJurisdictionGainsSummary.mockRejectedValue(serviceError);

        const req = makeAuthenticatedRequest();

        await handler.getGainsSummary(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(serviceError);
      });
    });
  });

  describe('listLots', () => {
    describe('Success path', () => {
      it('should return 200 with list of lots', async () => {
        const mockLots = [
          { id: 'lot-1', quantity: 100, cost_basis_per_unit: 50 },
          { id: 'lot-2', quantity: 200, cost_basis_per_unit: 75 },
        ];

        mockTaxationService.listLots.mockResolvedValue(mockLots as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest();

        await handler.listLots(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(200);
        expect((mockRes as any)._getJson()).toEqual({
          message: 'Lots retrieved successfully',
          data: mockLots,
        });
      });

      it('should call service with userId', async () => {
        mockTaxationService.listLots.mockResolvedValue([]);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { id: 'user-abc' },
        });

        await handler.listLots(req, mockRes as Response, mockNext);

        expect(mockTaxationService.listLots).toHaveBeenCalledWith('user-abc');
      });
    });

    describe('Authentication errors', () => {
      it('should require authenticated user', async () => {
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: undefined,
        });

        await handler.listLots(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(401);
      });
    });
  });

  describe('detectWashSales', () => {
    describe('Success path', () => {
      it('should return 200 with wash sale detection result', async () => {
        const mockResult = {
          isWashSale: true,
          adjustments: [{ lot_id: 'lot-1', adjustment_amount: 100 }],
          adjustmentAmount: 100,
        };

        mockTaxationService.detectWashSales.mockResolvedValue(mockResult as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(200);
        expect((mockRes as any)._getJson()).toEqual({
          message: 'Wash-sale condition detected and adjustments recorded',
          data: mockResult,
        });
      });

      it('should return appropriate message when no wash sale detected', async () => {
        const mockResult = {
          isWashSale: false,
          adjustments: [],
          adjustmentAmount: 0,
        };

        mockTaxationService.detectWashSales.mockResolvedValue(mockResult as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: 500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        const response = (mockRes as any)._getJson();
        expect(response.message).toContain('No wash-sale condition detected');
      });

      it('should call service with correct parameters', async () => {
        mockTaxationService.detectWashSales.mockResolvedValue({
          isWashSale: false,
          adjustments: [],
          adjustmentAmount: 0,
        } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { id: 'user-xyz' },
          body: {
            offering_id: 'offering-2',
            disposed_at: '2024-02-20T00:00:00Z',
            disposal_realized_gain_loss: -300,
            disposal_quantity: 15,
            disposal_cost_basis_per_unit: 80,
            window_days: 60,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect(mockTaxationService.detectWashSales).toHaveBeenCalledWith({
          investor_id: 'user-xyz',
          offering_id: 'offering-2',
          disposed_at: expect.any(Date),
          disposal_realized_gain_loss: -300,
          disposal_quantity: 15,
          disposal_cost_basis_per_unit: 80,
          window_days: 60,
        });
      });

      it('should accept optional window_days parameter', async () => {
        mockTaxationService.detectWashSales.mockResolvedValue({
          isWashSale: false,
          adjustments: [],
          adjustmentAmount: 0,
        } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(200);
      });
    });

    describe('Validation errors', () => {
      beforeEach(() => {
        mockRes = makeResponse();
      });

      it('should require authentication', async () => {
        const req = makeAuthenticatedRequest({
          user: undefined,
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(401);
      });

      it('should validate required fields', async () => {
        const requiredFields = [
          'offering_id',
          'disposed_at',
          'disposal_realized_gain_loss',
          'disposal_quantity',
          'disposal_cost_basis_per_unit',
        ];

        for (const field of requiredFields) {
          const body: any = {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
          };
          delete body[field];

          const req = makeAuthenticatedRequest({ body });

          await handler.detectWashSales(req, mockRes as Response, mockNext);

          expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
          const error = (mockNext as jest.Mock).mock.calls[0][0];
          expect(error.message).toContain(field);

          mockNext.mockClear();
        }
      });

      it('should validate disposal_realized_gain_loss is a number', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: 'invalid',
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('must be a number');
      });

      it('should validate disposal_quantity is positive', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: -10,
            disposal_cost_basis_per_unit: 100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('positive number');
      });

      it('should validate disposal_cost_basis_per_unit is non-negative', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: -100,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('non-negative');
      });

      it('should validate window_days range if provided', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            disposed_at: '2024-01-15T00:00:00Z',
            disposal_realized_gain_loss: -500,
            disposal_quantity: 10,
            disposal_cost_basis_per_unit: 100,
            window_days: 500,
          },
        });

        await handler.detectWashSales(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('between 1 and 365');
      });
    });
  });

  describe('createLot', () => {
    describe('Success path', () => {
      it('should return 201 with created lot', async () => {
        const mockLot = {
          id: 'lot-new',
          offering_id: 'offering-1',
          quantity: 100,
          cost_basis_per_unit: 50,
        };

        mockTaxationService.createLot.mockResolvedValue(mockLot as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect((mockRes as any)._getStatus()).toBe(201);
        expect((mockRes as any)._getJson()).toEqual({
          message: 'Investment lot created successfully',
          data: mockLot,
        });
      });

      it('should call service with correct parameters', async () => {
        mockTaxationService.createLot.mockResolvedValue({ id: 'lot-1' } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          user: { id: 'user-create' },
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: 50,
            acquired_at: '2024-01-01T00:00:00Z',
            cost_currency: 'USD',
            jurisdiction: 'US',
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockTaxationService.createLot).toHaveBeenCalledWith({
          investor_id: 'user-create',
          offering_id: 'offering-1',
          investment_id: 'investment-1',
          asset: 'STOCK',
          quantity: 100,
          cost_basis_per_unit: 50,
          acquired_at: expect.any(Date),
          cost_currency: 'USD',
          jurisdiction: 'US',
        });
      });

      it('should default acquired_at to current date if not provided', async () => {
        mockTaxationService.createLot.mockResolvedValue({ id: 'lot-1' } as any);
        mockRes = makeResponse();

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockTaxationService.createLot).toHaveBeenCalledWith(
          expect.objectContaining({
            acquired_at: expect.any(Date),
          })
        );
      });
    });

    describe('Validation errors', () => {
      beforeEach(() => {
        mockRes = makeResponse();
      });

      it('should require authentication', async () => {
        const req = makeAuthenticatedRequest({
          user: undefined,
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.statusCode).toBe(401);
      });

      it('should validate required fields', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            quantity: 100,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('offering_id, investment_id, asset');
      });

      it('should validate quantity is positive', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: -10,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('positive number');
      });

      it('should validate cost_basis_per_unit is non-negative', async () => {
        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: -50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.message).toContain('non-negative');
      });
    });

    describe('Service errors', () => {
      beforeEach(() => {
        mockRes = makeResponse();
      });

      it('should forward AppError from service', async () => {
        const serviceError = Errors.conflict('Lot already exists');
        mockTaxationService.createLot.mockRejectedValue(serviceError);

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(serviceError);
      });

      it('should sanitize unexpected errors', async () => {
        const unexpectedError = new Error('Database error');
        mockTaxationService.createLot.mockRejectedValue(unexpectedError);

        const req = makeAuthenticatedRequest({
          body: {
            offering_id: 'offering-1',
            investment_id: 'investment-1',
            asset: 'STOCK',
            quantity: 100,
            cost_basis_per_unit: 50,
          },
        });

        await handler.createLot(req, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.code).toBe('INTERNAL_ERROR');
      });
    });
  });
});
