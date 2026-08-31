import { BalanceSnapshotRepository, CreateSnapshotInput } from './balanceSnapshotRepository';

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
      };

      const result = await repo.insert(input);
      expect(result.id).toBe('uuid-1');
      expect(result.balance).toBe('1000.00');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('throws if no row returned', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(
        repo.insert({
          offering_id: 'o1',
          period_id: 'p1',
          holder_address_or_id: 'h1',
          balance: '0',
        })
      ).rejects.toThrow('Failed to insert token balance snapshot');
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
  });

  describe('findByOffering', () => {
    it('returns all snapshots for an offering', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot] });
      const results = await repo.findByOffering('offering-1');
      expect(results).toHaveLength(1);
    });
  });

  describe('findByHolderAndPeriod', () => {
    it('returns snapshots for a holder across offerings in a period, ordered ascending', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSnapshot, mockSnapshot] });
      const results = await repo.findByHolderAndPeriod('holder-abc', 'period-1');
      expect(results).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['holder-abc', 'period-1']);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('ORDER BY snapshot_at ASC, created_at ASC, id ASC');
    });

    it('returns empty array when the holder has no snapshots in the period', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const results = await repo.findByHolderAndPeriod('holder-x', 'period-9');
      expect(results).toHaveLength(0);
    });
  });
});