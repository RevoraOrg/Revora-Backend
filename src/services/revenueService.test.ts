import { RevenueService, SubmitRevenueReportInput } from './revenueService';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';

describe('RevenueService', () => {
    let service: RevenueService;
    let mockOfferingRepo: jest.Mocked<OfferingRepository>;
    let mockRevenueReportRepo: jest.Mocked<RevenueReportRepository>;

    beforeEach(() => {
        mockOfferingRepo = {
            findById: jest.fn(),
            isOwner: jest.fn(),
        } as any;

        mockRevenueReportRepo = {
            create: jest.fn(),
            findByOfferingAndPeriod: jest.fn(),
        } as any;

        service = new RevenueService(mockOfferingRepo, mockRevenueReportRepo);
    });

    it('should successfully submit a revenue report', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-1',
            amount: '1000.00',
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
        };

        mockOfferingRepo.findById.mockResolvedValue({
            id: 'offering-1',
            issuer_id: 'issuer-1',
            name: 'Test Offering',
            symbol: 'TEST',
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
        });

        mockRevenueReportRepo.findByOfferingAndPeriod.mockResolvedValue(null);
        mockRevenueReportRepo.create.mockResolvedValue({
            id: 'report-1',
            ...input,
            offering_id: input.offeringId,
            issuer_id: input.issuerId,
            period_start: input.periodStart,
            period_end: input.periodEnd,
            created_at: new Date(),
            updated_at: new Date(),
        } as any);

        const result = await service.submitReport(input);

        expect(result.id).toBe('report-1');
        expect(mockRevenueReportRepo.create).toHaveBeenCalled();
    });

    it('should throw error if offering not found', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-999',
            issuerId: 'issuer-1',
            amount: '1000.00',
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
        };

        mockOfferingRepo.findById.mockResolvedValue(null);

        await expect(service.submitReport(input)).rejects.toThrow('Offering offering-999 not found');
    });

    it('should throw error if issuer does not own offering', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-wrong',
            amount: '1000.00',
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
        };

        mockOfferingRepo.findById.mockResolvedValue({
            id: 'offering-1',
            issuer_id: 'issuer-correct',
            name: 'Test Offering',
            symbol: 'TEST',
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
        });

        await expect(service.submitReport(input)).rejects.toThrow('Unauthorized');
    });

    it('should throw error if report already exists for period', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-1',
            amount: '1000.00',
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
        };

        mockOfferingRepo.findById.mockResolvedValue({
            id: 'offering-1',
            issuer_id: 'issuer-1',
            name: 'Test Offering',
            symbol: 'TEST',
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
        });

        mockRevenueReportRepo.findByOfferingAndPeriod.mockResolvedValue({ id: 'existing' } as any);

        await expect(service.submitReport(input)).rejects.toThrow('Revenue report already exists');
    });
});
