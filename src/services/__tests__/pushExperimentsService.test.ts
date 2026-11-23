import { PushExperimentsService, LegalContentViolationError, ExperimentNotActiveError } from '../pushExperimentsService';
import { PushExperimentsRepository } from '../../db/repositories/pushExperimentsRepository';
import { MetricsCollector } from '../../lib/metrics';
import { Pool } from 'pg';

jest.mock('../../db/repositories/pushExperimentsRepository');
jest.mock('../../lib/metrics');

describe('PushExperimentsService', () => {
  let service: PushExperimentsService;
  let mockRepo: jest.Mocked<PushExperimentsRepository>;
  let mockMetrics: jest.Mocked<MetricsCollector>;

  beforeEach(() => {
    mockRepo = new PushExperimentsRepository({} as Pool) as jest.Mocked<PushExperimentsRepository>;
    mockMetrics = {
      incrementCounter: jest.fn(),
      setGauge: jest.fn(),
    } as unknown as jest.Mocked<MetricsCollector>;
    service = new PushExperimentsService(mockRepo, mockMetrics);
    jest.clearAllMocks();
  });

  describe('createExperiment', () => {
    it('should create a new experiment with default weighted allocation', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'draft' as const,
        allocation_strategy: 'weighted' as const,
        started_at: null,
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockRepo.createExperiment.mockResolvedValue(mockExperiment);

      const result = await service.createExperiment('tenant-1', 'test-exp');

      expect(mockRepo.createExperiment).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        allocation_strategy: 'weighted',
      });
      expect(result).toEqual(mockExperiment);
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'push_experiment_created',
        { tenant_id: 'tenant-1', strategy: 'weighted' },
        1,
        'Push experiment created'
      );
    });

    it('should create a new experiment with uniform allocation', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'draft' as const,
        allocation_strategy: 'uniform' as const,
        started_at: null,
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockRepo.createExperiment.mockResolvedValue(mockExperiment);

      const result = await service.createExperiment('tenant-1', 'test-exp', 'uniform');

      expect(mockRepo.createExperiment).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        allocation_strategy: 'uniform',
      });
      expect(result).toEqual(mockExperiment);
    });
  });

  describe('addVariant', () => {
    const mockExperiment = {
      id: 'exp-1',
      tenant_id: 'tenant-1',
      experiment_key: 'test-exp',
      status: 'draft' as const,
      allocation_strategy: 'weighted' as const,
      started_at: null,
      ended_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('should add a variant to an experiment', async () => {
      const mockVariant = {
        id: 'var-1',
        experiment_id: 'exp-1',
        variant_key: 'control',
        weight: 50,
        title_template: 'Test {{name}}',
        body_template: 'Hello {{name}}',
        data_template: null,
        is_control: true,
        created_at: new Date(),
      };
      mockRepo.findExperimentById.mockResolvedValue(mockExperiment);
      mockRepo.findLegalAllowlistByTenant.mockResolvedValue({
        titles: ['Test {{name}}'],
        bodies: ['Hello {{name}}'],
      });
      mockRepo.findVariantsByExperiment.mockResolvedValue([]);
      mockRepo.createVariant.mockResolvedValue(mockVariant);

      const result = await service.addVariant(
        'exp-1',
        'control',
        50,
        'Test {{name}}',
        'Hello {{name}}',
        undefined,
        true
      );

      expect(mockRepo.findLegalAllowlistByTenant).toHaveBeenCalledWith('tenant-1');
      expect(mockRepo.createVariant).toHaveBeenCalledWith({
        experiment_id: 'exp-1',
        variant_key: 'control',
        weight: 50,
        title_template: 'Test {{name}}',
        body_template: 'Hello {{name}}',
        data_template: undefined,
        isControl: true,
      });
      expect(result).toEqual(mockVariant);
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'push_experiment_variant_added',
        { experiment_id: 'exp-1', is_control: 'true' },
        1,
        'Push experiment variant added'
      );
    });

    it('should add a variant with data template', async () => {
      const mockVariant = {
        id: 'var-1',
        experiment_id: 'exp-1',
        variant_key: 'variant-a',
        weight: 50,
        title_template: 'Test',
        body_template: 'Hello',
        data_template: { key: 'value' },
        is_control: false,
        created_at: new Date(),
      };
      mockRepo.findExperimentById.mockResolvedValue(mockExperiment);
      mockRepo.findLegalAllowlistByTenant.mockResolvedValue({
        titles: ['Test'],
        bodies: ['Hello'],
      });
      mockRepo.findVariantsByExperiment.mockResolvedValue([]);
      mockRepo.createVariant.mockResolvedValue(mockVariant);

      const result = await service.addVariant(
        'exp-1',
        'variant-a',
        50,
        'Test',
        'Hello',
        { key: 'value' }
      );

      expect(result).toEqual(mockVariant);
    });

    it('should reject disallowed title template', async () => {
      mockRepo.findExperimentById.mockResolvedValue(mockExperiment);
      mockRepo.findLegalAllowlistByTenant.mockResolvedValue({
        titles: ['Approved {{name}}'],
        bodies: ['Hello {{name}}'],
      });

      await expect(
        service.addVariant('exp-1', 'control', 50, 'Guaranteed returns!', 'Hello {{name}}')
      ).rejects.toThrow(LegalContentViolationError);

      expect(mockRepo.createVariant).not.toHaveBeenCalled();
    });

    it('should reject disallowed body template', async () => {
      mockRepo.findExperimentById.mockResolvedValue(mockExperiment);
      mockRepo.findLegalAllowlistByTenant.mockResolvedValue({
        titles: ['Approved {{name}}'],
        bodies: ['Hello {{name}}'],
      });

      await expect(
        service.addVariant('exp-1', 'control', 50, 'Approved {{name}}', 'Risk-free offer')
      ).rejects.toThrow(LegalContentViolationError);

      expect(mockRepo.createVariant).not.toHaveBeenCalled();
    });

    it('should throw if experiment does not exist', async () => {
      mockRepo.findExperimentById.mockResolvedValue(null);

      await expect(
        service.addVariant('missing', 'control', 50, 'Test', 'Hello')
      ).rejects.toThrow('Experiment "missing" not found');

      expect(mockRepo.createVariant).not.toHaveBeenCalled();
    });

    it('should skip validation when no existing variants', async () => {
      const mockVariant = {
        id: 'var-1',
        experiment_id: 'exp-1',
        variant_key: 'control',
        weight: 50,
        title_template: 'Test',
        body_template: 'Hello',
        data_template: null,
        is_control: true,
        created_at: new Date(),
      };
      mockRepo.findExperimentById.mockResolvedValue(mockExperiment);
      mockRepo.findLegalAllowlistByTenant.mockResolvedValue({
        titles: ['Test'],
        bodies: ['Hello'],
      });
      mockRepo.findVariantsByExperiment.mockResolvedValue([]);
      mockRepo.createVariant.mockResolvedValue(mockVariant);

      await service.addVariant('exp-1', 'control', 50, 'Test', 'Hello');

      expect(mockRepo.createVariant).toHaveBeenCalled();
    });
  });

  describe('activateExperiment', () => {
    it('should activate an experiment', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'active' as const,
        allocation_strategy: 'weighted' as const,
        started_at: new Date(),
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockRepo.updateExperimentStatus.mockResolvedValue(mockExperiment);

      const result = await service.activateExperiment('exp-1');

      expect(mockRepo.updateExperimentStatus).toHaveBeenCalledWith('exp-1', 'active');
      expect(result).toEqual(mockExperiment);
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'push_experiment_activated',
        { experiment_id: 'exp-1' },
        1,
        'Push experiment activated'
      );
    });
  });

  describe('allocateAndRender', () => {
    it('should allocate user to variant and render template', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'active' as const,
        allocation_strategy: 'weighted' as const,
        started_at: new Date(),
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const mockVariant = {
        id: 'var-1',
        experiment_id: 'exp-1',
        variant_key: 'control',
        weight: 100,
        title_template: 'Hello {{name}}',
        body_template: 'Welcome {{name}}',
        data_template: null,
        is_control: true,
        created_at: new Date(),
      };
      const mockAssignment = {
        id: 'assign-1',
        experiment_id: 'exp-1',
        variant_id: 'var-1',
        user_id: 'user-1',
        assigned_at: new Date(),
        delivered_at: null,
        opened_at: null,
      };

      mockRepo.findExperimentByKey.mockResolvedValue(mockExperiment);
      mockRepo.findVariantsByExperiment.mockResolvedValue([mockVariant]);
      mockRepo.findAssignmentByUser.mockResolvedValueOnce(null).mockResolvedValue(mockAssignment);
      mockRepo.assignUserToVariant.mockResolvedValue(mockAssignment);

      const result = await service.allocateAndRender('tenant-1', 'test-exp', 'user-1', { name: 'John' });

      expect(result.variant).toEqual(mockVariant);
      expect(result.rendered.title).toBe('Hello John');
      expect(result.rendered.body).toBe('Welcome John');
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'push_experiment_allocation',
        { experiment_id: 'exp-1', variant_id: 'var-1', strategy: 'weighted' },
        1,
        'User allocated to experiment variant'
      );
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'push_experiment_render',
        { experiment_id: 'exp-1', variant_id: 'var-1' },
        1,
        'Push template rendered for experiment'
      );
    });

    it('should use existing assignment if already allocated', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'active' as const,
        allocation_strategy: 'weighted' as const,
        started_at: new Date(),
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const mockVariant = {
        id: 'var-1',
        experiment_id: 'exp-1',
        variant_key: 'control',
        weight: 100,
        title_template: 'Hello {{name}}',
        body_template: 'Welcome {{name}}',
        data_template: null,
        is_control: true,
        created_at: new Date(),
      };
      const mockAssignment = {
        id: 'assign-1',
        experiment_id: 'exp-1',
        variant_id: 'var-1',
        user_id: 'user-1',
        assigned_at: new Date(),
        delivered_at: null,
        opened_at: null,
      };

      mockRepo.findExperimentByKey.mockResolvedValue(mockExperiment);
      mockRepo.findVariantsByExperiment.mockResolvedValue([mockVariant]);
      mockRepo.findAssignmentByUser.mockResolvedValue(mockAssignment);
      mockRepo.findVariantById.mockResolvedValue(mockVariant);

      const result = await service.allocateAndRender('tenant-1', 'test-exp', 'user-1', { name: 'John' });

      expect(mockRepo.assignUserToVariant).not.toHaveBeenCalled();
      expect(result.variant).toEqual(mockVariant);
    });

    it('should throw error if experiment not found', async () => {
      mockRepo.findExperimentByKey.mockResolvedValue(null);

      await expect(
        service.allocateAndRender('tenant-1', 'test-exp', 'user-1')
      ).rejects.toThrow('Experiment "test-exp" not found for tenant');
    });

    it('should throw error if experiment not active', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'draft' as const,
        allocation_strategy: 'weighted' as const,
        started_at: null,
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockRepo.findExperimentByKey.mockResolvedValue(mockExperiment);

      await expect(
        service.allocateAndRender('tenant-1', 'test-exp', 'user-1')
      ).rejects.toThrow(ExperimentNotActiveError);
    });

    it('should throw error if no variants found', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'active' as const,
        allocation_strategy: 'weighted' as const,
        started_at: new Date(),
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockRepo.findExperimentByKey.mockResolvedValue(mockExperiment);
      mockRepo.findVariantsByExperiment.mockResolvedValue([]);

      await expect(
        service.allocateAndRender('tenant-1', 'test-exp', 'user-1')
      ).rejects.toThrow('No variants found for experiment "test-exp"');
    });

    it('should handle missing template variables', async () => {
      const mockExperiment = {
        id: 'exp-1',
        tenant_id: 'tenant-1',
        experiment_key: 'test-exp',
        status: 'active' as const,
        allocation_strategy: 'weighted' as const,
        started_at: new Date(),
        ended_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const mockVariant = {
        id: 'var-1',
        experiment_id: 'exp-1',
        variant_key: 'control',
        weight: 100,
        title_template: 'Hello {{name}}',
        body_template: 'Welcome {{name}}',
        data_template: null,
        is_control: true,
        created_at: new Date(),
      };
      mockRepo.findExperimentByKey.mockResolvedValue(mockExperiment);
      mockRepo.findVariantsByExperiment.mockResolvedValue([mockVariant]);
      mockRepo.findAssignmentByUser.mockResolvedValue(null);
    });
  });
});
