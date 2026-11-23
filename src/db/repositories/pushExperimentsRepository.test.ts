import { Pool, QueryResult } from 'pg';
import { PushExperimentsRepository, CreateExperimentInput } from './pushExperimentsRepository';

describe('PushExperimentsRepository', () => {
  let repository: PushExperimentsRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };
    repository = new PushExperimentsRepository(mockPool as unknown as Pool);
  });

  describe('createExperiment', () => {
    const input: CreateExperimentInput = {
      tenant_id: 'tenant-1',
      experiment_key: 'exp-1',
      allocation_strategy: 'weighted',
    };

    it('should create an experiment on success', async () => {
      const mockResult: QueryResult = {
        rows: [{
          id: 'exp-id',
          tenant_id: 'tenant-1',
          experiment_key: 'exp-1',
          status: 'draft',
          allocation_strategy: 'weighted',
          started_at: null,
          ended_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.createExperiment(input);

      expect(result.id).toBe('exp-id');
      expect(result.experiment_key).toBe('exp-1');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('should throw an error if result rows are empty', async () => {
      const mockResult: QueryResult = {
        rows: [],
        rowCount: 0,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      await expect(repository.createExperiment(input)).rejects.toThrow('Failed to create experiment');
    });
  });

  describe('findExperimentByKey', () => {
    it('should return experiment if found', async () => {
      const mockResult: QueryResult = {
        rows: [{
          id: 'exp-id',
          tenant_id: 'tenant-1',
          experiment_key: 'exp-1',
          status: 'draft',
          allocation_strategy: 'weighted',
          started_at: null,
          ended_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.findExperimentByKey('tenant-1', 'exp-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('exp-id');
    });

    it('should return null if experiment is not found', async () => {
      const mockResult: QueryResult = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.findExperimentByKey('tenant-1', 'exp-1');
      expect(result).toBeNull();
    });
  });

  describe('updateExperimentStatus', () => {
    it('should update experiment status on success', async () => {
      const mockResult: QueryResult = {
        rows: [{
          id: 'exp-id',
          tenant_id: 'tenant-1',
          experiment_key: 'exp-1',
          status: 'active',
          allocation_strategy: 'weighted',
          started_at: new Date(),
          ended_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.updateExperimentStatus('exp-id', 'active');
      expect(result.status).toBe('active');
    });

    it('should throw an error if result rows are empty', async () => {
      const mockResult: QueryResult = {
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      await expect(repository.updateExperimentStatus('exp-id', 'active')).rejects.toThrow('Failed to update experiment status');
    });
  });
});
