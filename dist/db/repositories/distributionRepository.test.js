"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const distributionRepository_1 = require("./distributionRepository");
describe('DistributionRepository', () => {
    let repository;
    let mockPool;
    beforeEach(() => {
        // Mock Pool
        mockPool = {
            query: jest.fn(),
        };
        repository = new distributionRepository_1.DistributionRepository(mockPool);
    });
    describe('createDistributionRun', () => {
        it('should create a distribution run with default status', async () => {
            const input = {
                offering_id: 'offering-123',
                total_amount: '10000.50',
                distribution_date: new Date('2024-01-15'),
            };
            const mockResult = {
                rows: [
                    {
                        id: 'run-123',
                        offering_id: 'offering-123',
                        total_amount: '10000.50',
                        distribution_date: new Date('2024-01-15'),
                        status: 'pending',
                        created_at: new Date(),
                        updated_at: new Date(),
                    },
                ],
                rowCount: 1,
                command: 'INSERT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.createDistributionRun(input);
            expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO distribution_runs'), ['offering-123', '10000.50', input.distribution_date, 'pending']);
            expect(result.id).toBe('run-123');
            expect(result.offering_id).toBe('offering-123');
            expect(result.status).toBe('pending');
        });
        it('should create a distribution run with custom status', async () => {
            const input = {
                offering_id: 'offering-123',
                total_amount: '10000.50',
                distribution_date: new Date('2024-01-15'),
                status: 'processing',
            };
            const mockResult = {
                rows: [
                    {
                        id: 'run-123',
                        offering_id: 'offering-123',
                        total_amount: '10000.50',
                        distribution_date: new Date('2024-01-15'),
                        status: 'processing',
                        created_at: new Date(),
                        updated_at: new Date(),
                    },
                ],
                rowCount: 1,
                command: 'INSERT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.createDistributionRun(input);
            expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO distribution_runs'), ['offering-123', '10000.50', input.distribution_date, 'processing']);
            expect(result.status).toBe('processing');
        });
        it('should throw error if creation fails', async () => {
            const input = {
                offering_id: 'offering-123',
                total_amount: '10000.50',
                distribution_date: new Date('2024-01-15'),
            };
            const mockResult = {
                rows: [],
                rowCount: 0,
                command: 'INSERT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            await expect(repository.createDistributionRun(input)).rejects.toThrow('Failed to create distribution run');
        });
    });
    describe('createPayout', () => {
        it('should create a payout with default status', async () => {
            const input = {
                distribution_run_id: 'run-123',
                investor_id: 'investor-456',
                amount: '500.25',
            };
            const mockResult = {
                rows: [
                    {
                        id: 'payout-789',
                        distribution_run_id: 'run-123',
                        investor_id: 'investor-456',
                        amount: '500.25',
                        status: 'pending',
                        transaction_hash: null,
                        created_at: new Date(),
                        updated_at: new Date(),
                    },
                ],
                rowCount: 1,
                command: 'INSERT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.createPayout(input);
            expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO payouts'), ['run-123', 'investor-456', '500.25', 'pending', null]);
            expect(result.id).toBe('payout-789');
            expect(result.investor_id).toBe('investor-456');
            expect(result.status).toBe('pending');
        });
        it('should create a payout with transaction hash', async () => {
            const input = {
                distribution_run_id: 'run-123',
                investor_id: 'investor-456',
                amount: '500.25',
                transaction_hash: 'tx-hash-abc123',
                status: 'processed',
            };
            const mockResult = {
                rows: [
                    {
                        id: 'payout-789',
                        distribution_run_id: 'run-123',
                        investor_id: 'investor-456',
                        amount: '500.25',
                        status: 'processed',
                        transaction_hash: 'tx-hash-abc123',
                        created_at: new Date(),
                        updated_at: new Date(),
                    },
                ],
                rowCount: 1,
                command: 'INSERT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.createPayout(input);
            expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO payouts'), ['run-123', 'investor-456', '500.25', 'processed', 'tx-hash-abc123']);
            expect(result.transaction_hash).toBe('tx-hash-abc123');
            expect(result.status).toBe('processed');
        });
        it('should throw error if creation fails', async () => {
            const input = {
                distribution_run_id: 'run-123',
                investor_id: 'investor-456',
                amount: '500.25',
            };
            const mockResult = {
                rows: [],
                rowCount: 0,
                command: 'INSERT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            await expect(repository.createPayout(input)).rejects.toThrow('Failed to create payout');
        });
    });
    describe('listByOffering', () => {
        it('should return distribution runs for an offering', async () => {
            const offeringId = 'offering-123';
            const mockResult = {
                rows: [
                    {
                        id: 'run-1',
                        offering_id: 'offering-123',
                        total_amount: '10000.50',
                        distribution_date: new Date('2024-01-15'),
                        status: 'completed',
                        created_at: new Date('2024-01-15'),
                        updated_at: new Date('2024-01-15'),
                    },
                    {
                        id: 'run-2',
                        offering_id: 'offering-123',
                        total_amount: '5000.00',
                        distribution_date: new Date('2024-01-10'),
                        status: 'pending',
                        created_at: new Date('2024-01-10'),
                        updated_at: new Date('2024-01-10'),
                    },
                ],
                rowCount: 2,
                command: 'SELECT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.listByOffering(offeringId);
            expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM distribution_runs'), [offeringId]);
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe('run-1');
            expect(result[1].id).toBe('run-2');
        });
        it('should return empty array if no distribution runs found', async () => {
            const offeringId = 'offering-999';
            const mockResult = {
                rows: [],
                rowCount: 0,
                command: 'SELECT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.listByOffering(offeringId);
            expect(result).toHaveLength(0);
        });
    });
    describe('listPayoutsByInvestor', () => {
        it('should return payouts for an investor', async () => {
            const investorId = 'investor-456';
            const mockResult = {
                rows: [
                    {
                        id: 'payout-1',
                        distribution_run_id: 'run-123',
                        investor_id: 'investor-456',
                        amount: '500.25',
                        status: 'processed',
                        transaction_hash: 'tx-hash-1',
                        created_at: new Date('2024-01-15'),
                        updated_at: new Date('2024-01-15'),
                    },
                    {
                        id: 'payout-2',
                        distribution_run_id: 'run-124',
                        investor_id: 'investor-456',
                        amount: '300.00',
                        status: 'pending',
                        transaction_hash: null,
                        created_at: new Date('2024-01-10'),
                        updated_at: new Date('2024-01-10'),
                    },
                ],
                rowCount: 2,
                command: 'SELECT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.listPayoutsByInvestor(investorId);
            expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM payouts'), [investorId]);
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe('payout-1');
            expect(result[0].transaction_hash).toBe('tx-hash-1');
            expect(result[1].id).toBe('payout-2');
            expect(result[1].transaction_hash).toBeUndefined();
        });
        it('should return empty array if no payouts found', async () => {
            const investorId = 'investor-999';
            const mockResult = {
                rows: [],
                rowCount: 0,
                command: 'SELECT',
                oid: 0,
                fields: [],
            };
            mockPool.query.mockResolvedValueOnce(mockResult);
            const result = await repository.listPayoutsByInvestor(investorId);
            expect(result).toHaveLength(0);
        });
    });
});
