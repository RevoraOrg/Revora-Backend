import { Pool, QueryResult, QueryResultRow } from 'pg';
import { InvestmentRepository, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import { InvestmentService, CreateInvestmentRequest, createInvestmentService } from './investmentService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPool(): jest.Mocked<Pool> {
  return { query: jest.fn() } as unknown as jest.Mocked<Pool>;
}

function makeInvestmentRow(override: Partial<Investment> = {}): Investment {
  return {
    id: 'inv-1',
    investor_id: 'investor-123',
    offering_id: 'offering-abc',
    amount: '5000.00',
    asset: 'USDC',
    status: 'pending',
    created_at: new Date('2024-01-15'),
    updated_at: new Date('2024-01-15'),
    ...override,
  };
}

function makeOfferingRow(override: Partial<Offering> = {}): Offering {
  return {
    id: 'offering-abc',
    contract_address: 'CA123...',
    status: 'active',
    total_raised: '10000.00',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockQueryResult<T = any>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvestmentService', () => {
  let mockPool: jest.Mocked<Pool>;
  let investmentRepo: InvestmentRepository;
  let offeringRepo: OfferingRepository;
  let service: InvestmentService;

  beforeEach(() => {
    mockPool = makeMockPool();
    investmentRepo = new InvestmentRepository(mockPool);
    offeringRepo = new OfferingRepository(mockPool);
    service = new InvestmentService(investmentRepo, offeringRepo);
  });

  describe('createInvestment', () => {
    const baseInput: CreateInvestmentRequest = {
      investor_id: 'investor-123',
      offering_id: 'offering-abc',
      amount: '5000.00',
      asset: 'USDC',
    };

    it('creates an investment when offering exists and is active', async () => {
      // Arrange
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow();
      
      // First query: findById (offering)
      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        // Second query: create (investment)
        .mockResolvedValueOnce({ rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<Investment>);

      // Act
      const result = await service.createInvestment(baseInput);

      // Assert
      expect(result).toEqual(investmentRow);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('creates an investment when offering status is "open"', async () => {
      // Arrange
      const offeringRow = makeOfferingRow({ status: 'open' });
      const investmentRow = makeInvestmentRow();
      
      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({ rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<Investment>);

      // Act
      const result = await service.createInvestment(baseInput);

      // Assert
      expect(result).toEqual(investmentRow);
    });

    it('throws NOT_FOUND error when offering does not exist', async () => {
      // Arrange
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

      // Act & Assert
      await expect(service.createInvestment(baseInput)).rejects.toThrow('Offering offering-abc not found');
    });

    it('throws VALIDATION_ERROR when offering is not active', async () => {
      // Arrange
      const offeringRow = makeOfferingRow({ status: 'closed' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));

      // Act & Assert
      await expect(service.createInvestment(baseInput)).rejects.toThrow('Offering is not active');
    });

    it('throws VALIDATION_ERROR when amount is invalid', async () => {
      // Arrange
      const offeringRow = makeOfferingRow({ status: 'active' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));

      // Act & Assert
      await expect(service.createInvestment({ ...baseInput, amount: '-100' })).rejects.toThrow('Invalid amount');
      await expect(service.createInvestment({ ...baseInput, amount: '0' })).rejects.toThrow('Invalid amount');
      await expect(service.createInvestment({ ...baseInput, amount: 'abc' })).rejects.toThrow('Invalid amount');
    });

    it('throws VALIDATION_ERROR when asset is empty', async () => {
      // Arrange
      const offeringRow = makeOfferingRow({ status: 'active' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));

      // Act & Assert
      await expect(service.createInvestment({ ...baseInput, asset: '' })).rejects.toThrow('Asset is required');
    });

    it('creates investment with pending status by default', async () => {
      // Arrange
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow({ status: 'pending' });
      
      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({ rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<Investment>);

      // Act
      const result = await service.createInvestment(baseInput);

      // Assert
      expect(result.status).toBe('pending');
    });
  });
});

describe('createInvestmentService', () => {
  it('creates an InvestmentService instance', () => {
    // Arrange
    const mockPool = makeMockPool();
    
    // Act
    const service = createInvestmentService(mockPool);
    
    // Assert
    expect(service).toBeInstanceOf(InvestmentService);
  });
});
