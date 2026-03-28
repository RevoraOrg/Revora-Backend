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
            findOverlappingReport: jest.fn(),
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

        mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
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

    it('should throw error if report overlaps with existing period', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-1',
            amount: '1000.00',
            periodStart: new Date('2024-01-15'),
            periodEnd: new Date('2024-02-15'),
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

        mockRevenueReportRepo.findOverlappingReport.mockResolvedValue({ id: 'existing' } as any);

        await expect(service.submitReport(input)).rejects.toThrow('overlaps');
    });

    it('should throw error for invalid amount format', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-1',
            amount: 'invalid-amount',
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
        };

        mockOfferingRepo.findById.mockResolvedValue({
            id: 'offering-1',
            issuer_id: 'issuer-1',
        } as any);

        await expect(service.submitReport(input)).rejects.toThrow('Invalid revenue amount format');
    });

    it('should throw error for non-positive amount', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-1',
            amount: '0.00',
            periodStart: new Date('2024-01-01'),
            periodEnd: new Date('2024-01-31'),
        };

        mockOfferingRepo.findById.mockResolvedValue({
            id: 'offering-1',
            issuer_id: 'issuer-1',
        } as any);

        await expect(service.submitReport(input)).rejects.toThrow('must be greater than zero');
    });

    it('should throw error if period end is not after start', async () => {
        const input: SubmitRevenueReportInput = {
            offeringId: 'offering-1',
            issuerId: 'issuer-1',
            amount: '100.00',
            periodStart: new Date('2024-01-31'),
            periodEnd: new Date('2024-01-01'),
        };

        mockOfferingRepo.findById.mockResolvedValue({
            id: 'offering-1',
            issuer_id: 'issuer-1',
        } as any);

        await expect(service.submitReport(input)).rejects.toThrow('end date must be strictly after start date');
    });
});
