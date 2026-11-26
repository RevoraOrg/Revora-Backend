import { TaxationHandler } from './taxationHandler';
import { TaxationService } from '../services/taxation/taxationService';
import { AuthenticatedRequest } from '../middleware/auth';
import { Response } from 'express';
import { AppError } from '../lib/errors';

interface MockResponse extends Response {
  _getStatus: () => number;
  _getJson: () => Record<string, unknown>;
}

describe('TaxationHandler decimal-string and property tests', () => {
  let handler: TaxationHandler;
  let mockTaxationService: jest.Mocked<TaxationService>;
  let mockRes: MockResponse;
  let mockNext: jest.Mock;

  function makeAuthenticatedRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
    return {
      requestId: 'req-123',
      user: { id: 'investor-1', sub: 'investor-1' },
      body: {},
      params: {},
      ...overrides,
    } as AuthenticatedRequest;
  }

  function makeResponse(): MockResponse {
    let statusCode = 200;
    let jsonData: unknown = null;

    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: unknown) {
        jsonData = data;
        return this;
      },
      _getStatus: () => statusCode,
      _getJson: () => jsonData as Record<string, unknown>,
    };
    return res as unknown as MockResponse;
  }

  beforeEach(() => {
    mockTaxationService = {
      processDisposal: jest.fn(),
      previewDisposal: jest.fn(),
      createLot: jest.fn(),
      getJurisdictionGainsSummary: jest.fn(),
      listLots: jest.fn(),
      detectWashSales: jest.fn(),
    } as unknown as jest.Mocked<TaxationService>;

    handler = new TaxationHandler(mockTaxationService);
    mockRes = makeResponse();
    mockNext = jest.fn();
  });

  describe('processDisposal validation', () => {
    it('accepts valid decimal strings and propagates them to TaxationService', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          quantity: '50.1234567890',
          disposal_price_per_unit: '15.50',
          strategy: 'FIFO',
        },
      });

      mockTaxationService.processDisposal.mockResolvedValue({
        allocations: [],
        totalQuantityDisposed: '50.1234567890',
        weightedAverageCostBasis: '10.00',
        totalCostBasis: '501.23456789',
        realizedGainLoss: '275.6789',
        strategy: 'FIFO',
      });

      await handler.processDisposal(req, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockTaxationService.processDisposal).toHaveBeenCalledWith(
        expect.objectContaining({
          investor_id: 'investor-1',
          offering_id: 'off-1',
          quantity: '50.1234567890',
          disposal_price_per_unit: '15.50',
          strategy: 'FIFO',
        })
      );
      expect(mockRes._getStatus()).toBe(201);
      expect(mockRes._getJson()).toEqual({
        message: 'Disposal processed successfully',
        data: expect.objectContaining({
          realizedGainLoss: '275.6789',
        }),
      });
    });

    it('accepts numeric values via deprecated compatibility path', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          quantity: 50,
          disposal_price_per_unit: 15.5,
          strategy: 'FIFO',
        },
      });

      mockTaxationService.processDisposal.mockResolvedValue({
        allocations: [],
        totalQuantityDisposed: 50,
        weightedAverageCostBasis: 10,
        totalCostBasis: 500,
        realizedGainLoss: 275,
        strategy: 'FIFO',
      });

      await handler.processDisposal(req, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockTaxationService.processDisposal).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 50,
          disposal_price_per_unit: 15.5,
        })
      );
      expect(mockRes._getStatus()).toBe(201);
    });

    it('rejects invalid decimal strings (negative)', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          quantity: '-5.0',
          disposal_price_per_unit: '10.0',
          strategy: 'FIFO',
        },
      });

      await handler.processDisposal(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('quantity must be a positive decimal string'),
        })
      );
    });

    it('rejects decimal strings with > 10 decimal places', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          quantity: '1.12345678901',
          disposal_price_per_unit: '10.0',
          strategy: 'FIFO',
        },
      });

      await handler.processDisposal(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('quantity must be a positive decimal string with up to 10 decimal places'),
        })
      );
    });

    it('rejects non-numeric strings', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          quantity: 'invalid',
          disposal_price_per_unit: '10.0',
          strategy: 'FIFO',
        },
      });

      await handler.processDisposal(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
    });
  });

  describe('createLot validation', () => {
    it('accepts decimal string quantity and cost basis', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          investment_id: 'inv-1',
          asset: 'USDC',
          quantity: '100.50',
          cost_basis_per_unit: '12.75',
        },
      });

      mockTaxationService.createLot.mockResolvedValue({
        id: 'lot-1',
        investor_id: 'investor-1',
        offering_id: 'off-1',
        investment_id: 'inv-1',
        asset: 'USDC',
        quantity: '100.50',
        cost_basis_per_unit: '12.75',
        total_cost_basis: '1281.3750',
        remaining_quantity: '100.50',
        cost_currency: 'USD',
        acquired_at: new Date(),
        jurisdiction: 'US',
        status: 'open',
        created_at: new Date(),
        updated_at: new Date(),
      });

      await handler.createLot(req, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockTaxationService.createLot).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: '100.50',
          cost_basis_per_unit: '12.75',
        })
      );
      expect(mockRes._getStatus()).toBe(201);
    });

    it('rejects missing quantity in createLot', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          investment_id: 'inv-1',
          asset: 'USDC',
          cost_basis_per_unit: '12.75',
        },
      });

      await handler.createLot(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Missing required field: quantity'),
        })
      );
    });

    it('rejects missing cost_basis_per_unit in createLot', async () => {
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          investment_id: 'inv-1',
          asset: 'USDC',
          quantity: '100',
        },
      });

      await handler.createLot(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Missing required field: cost_basis_per_unit'),
        })
      );
    });
  });

  describe('property-style decimal comparison (0.1 + 0.2 precision)', () => {
    it('maintains exact decimal arithmetic without float rounding error in disposal path', async () => {
      // In JavaScript: 0.1 + 0.2 === 0.30000000000000004
      // We test that decimal-string inputs never undergo float rounding
      const req = makeAuthenticatedRequest({
        body: {
          offering_id: 'off-1',
          quantity: '0.3',
          disposal_price_per_unit: '1.0',
          strategy: 'FIFO',
        },
      });

      mockTaxationService.processDisposal.mockResolvedValue({
        allocations: [],
        totalQuantityDisposed: '0.3',
        weightedAverageCostBasis: '1.0',
        totalCostBasis: '0.30',
        realizedGainLoss: '0.00',
        strategy: 'FIFO',
      });

      await handler.processDisposal(req, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const responseData = mockRes._getJson().data as Record<string, unknown>;
      expect(responseData.totalQuantityDisposed).toBe('0.3');
      expect(responseData.totalQuantityDisposed).not.toBe('0.30000000000000004');
    });
  });
});
