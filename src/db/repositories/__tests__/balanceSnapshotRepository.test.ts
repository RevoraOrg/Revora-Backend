import { BalanceSnapshotRepository, CreateSnapshotInput } from '../balanceSnapshotRepository';

// Mock pg Pool
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockPool = {
  query: mockQuery,
  connect: mockConnect,
} as any;

const repo = new BalanceSnapshotRepository(mockPool);

const mockSnapshot = {
  id: 'uuid-1',
  offering_id: 'offering-1',
  period_id: 'period-1',
  holder_address_or_id: 'holder-abc',
  balance: '1000.00',
  snapshot_at: new Date('2024-01-01'),
  created_at: new Date('2024-01-01'),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BalanceSnapshotRepository', () => {
  describe('insert', () => {
    it('inserts a snapshot and returns it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot] });

      const input: CreateSnapshotInput = {
        offering_id: 'offering-1',
        period_id: 'period-1',
        holder_address_or_id: 'holder-abc',
        balance: '1000.00',
        snapshot_at: new Date('2024-01-01'),
      };

      const result = await repo.insert(input);
      expect(result.id).toBe('uuid-1');
      expect(result.balance).toBe('1000.00');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('throws if snapshot_at is missing', async () => {
      await expect(
        repo.insert({
          offering_id: 'o1',
          period_id: 'p1',
          holder_address_or_id: 'h1',
          balance: '0',
          snapshot_at: undefined as any,
        })
      ).rejects.toThrow('snapshot_at is required');
    });

    it('throws if no row returned', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(
        repo.insert({
          offering_id: 'o1',
          period_id: 'p1',
          holder_address_or_id: 'h1',
          balance: '0',
          snapshot_at: new Date(),
        })
      ).rejects.toThrow('Failed to insert token balance snapshot');
    });
  });

  describe('insertMany', () => {
    it('inserts multiple snapshots in a transaction', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnect.mockResolvedValueOnce(mockClient);
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [mockSnapshot] })
        .mockResolvedValueOnce({ rows: [mockSnapshot] })
        .mockResolvedValueOnce(undefined); // COMMIT

      const inputs: CreateSnapshotInput[] = [
        {
          offering_id: 'offering-1',
          period_id: 'period-1',
          holder_address_or_id: 'holder-1',
          balance: '100.00',
          snapshot_at: new Date('2024-01-01'),
        },
        {
          offering_id: 'offering-1',
          period_id: 'period-1',
          holder_address_or_id: 'holder-2',
          balance: '200.00',
          snapshot_at: new Date('2024-01-01'),
        },
      ];

      const results = await repo.insertMany(inputs);
      expect(results).toHaveLength(2);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('throws if any snapshot_at is missing', async () => {
      const inputs: CreateSnapshotInput[] = [
        {
          offering_id: 'offering-1',
          period_id: 'period-1',
          holder_address_or_id: 'holder-1',
          balance: '100.00',
          snapshot_at: new Date('2024-01-01'),
        },
        {
          offering_id: 'offering-1',
          period_id: 'period-1',
          holder_address_or_id: 'holder-2',
          balance: '200.00',
          snapshot_at: undefined as any,
        },
      ];

      await expect(repo.insertMany(inputs)).rejects.toThrow(
        'snapshot_at is required for all snapshots; input[1] is missing snapshot_at'
      );
    });

    it('rolls back transaction on error', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnect.mockResolvedValueOnce(mockClient);
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('DB error'));

      const inputs: CreateSnapshotInput[] = [
        {
          offering_id: 'offering-1',
          period_id: 'period-1',
          holder_address_or_id: 'holder-1',
          balance: '100.00',
          snapshot_at: new Date('2024-01-01'),
        },
      ];

      await expect(repo.insertMany(inputs)).rejects.toThrow('DB error');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('findByOfferingAndPeriod', () => {
    it('returns snapshots for offering and period', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot, mockSnapshot] });
      const results = await repo.findByOfferingAndPeriod('offering-1', 'period-1');
      expect(results).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['offering-1', 'period-1']);
    });

    it('returns empty array if none found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const results = await repo.findByOfferingAndPeriod('x', 'y');
      expect(results).toHaveLength(0);
    });

    it('sorts by snapshot_at and created_at descending', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot] });
      await repo.findByOfferingAndPeriod('offering-1', 'period-1');
      
      const query = mockQuery.mock.calls[0][0];
      expect(query).toContain('ORDER BY snapshot_at DESC, created_at DESC');
    });
  });

  describe('findByOffering', () => {
    it('returns all snapshots for an offering', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot] });
      const results = await repo.findByOffering('offering-1');
      expect(results).toHaveLength(1);
    });

    it('returns empty array if none found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const results = await repo.findByOffering('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('sorts by snapshot_at and created_at descending', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot] });
      await repo.findByOffering('offering-1');
      
      const query = mockQuery.mock.calls[0][0];
      expect(query).toContain('ORDER BY snapshot_at DESC, created_at DESC');
    });
  });

  describe('Determinism Contract', () => {
    it('ensures snapshot_at is required for all operations', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot] });

      const validInput: CreateSnapshotInput = {
        offering_id: 'offering-1',
        period_id: 'period-1',
        holder_address_or_id: 'holder-abc',
        balance: '1000.00',
        snapshot_at: new Date('2024-01-01'),
      };

      const result = await repo.insert(validInput);
      expect(result.snapshot_at).toBeDefined();
    });
  });
});
