import { Pool, QueryResult } from 'pg';
import {
  OidcGroupMappingRepository,
  OidcGroupMappingRow,
  CreateOidcGroupMappingInput,
} from './oidcGroupMappingRepository';

describe('OidcGroupMappingRepository', () => {
  let repository: OidcGroupMappingRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as any;

    repository = new OidcGroupMappingRepository(mockPool as unknown as Pool);
  });

  describe('create', () => {
    it('should create an OIDC group mapping', async () => {
      const input: CreateOidcGroupMappingInput = {
        tenantId: 'tenant-123',
        claimGroup: 'admin-group',
        revoraRole: 'startup',
      };

      const mockResult: QueryResult<OidcGroupMappingRow> = {
        rows: [
          {
            id: 'mapping-123',
            tenant_id: 'tenant-123',
            claim_group: 'admin-group',
            revora_role: 'startup',
            created_at: new Date(),
          },
        ],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oidc_group_mappings'),
        ['tenant-123', 'admin-group', 'startup']
      );
      expect(result).toEqual({
        id: 'mapping-123',
        tenant_id: 'tenant-123',
        claim_group: 'admin-group',
        revora_role: 'startup',
        created_at: expect.any(Date),
      });
    });

    it('should handle database errors on create', async () => {
      const input: CreateOidcGroupMappingInput = {
        tenantId: 'tenant-123',
        claimGroup: 'admin-group',
        revoraRole: 'startup',
      };

      mockPool.query.mockRejectedValueOnce(new Error('Database error'));

      await expect(repository.create(input)).rejects.toThrow('Database error');
    });
  });

  describe('findByTenantId', () => {
    it('should find OIDC group mappings by tenant ID', async () => {
      const tenantId = 'tenant-123';
      const mockResult: QueryResult<OidcGroupMappingRow> = {
        rows: [
          {
            id: 'mapping-123',
            tenant_id: 'tenant-123',
            claim_group: 'admin-group',
            revora_role: 'startup',
            created_at: new Date(),
          },
          {
            id: 'mapping-124',
            tenant_id: 'tenant-123',
            claim_group: 'investor-group',
            revora_role: 'investor',
            created_at: new Date(),
          },
        ],
        rowCount: 2,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.findByTenantId(tenantId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id, tenant_id, claim_group, revora_role, created_at'),
        [tenantId]
      );
      expect(result).toHaveLength(2);
      expect(result[0].tenant_id).toBe(tenantId);
      expect(result[1].tenant_id).toBe(tenantId);
    });

    it('should return empty array when no mappings found', async () => {
      const mockResult: QueryResult<OidcGroupMappingRow> = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.findByTenantId('tenant-999');

      expect(result).toHaveLength(0);
    });
  });

  describe('deleteByTenantAndGroup', () => {
    it('should delete mapping and return true if rows were affected', async () => {
      const mockResult = {
        rowCount: 1,
        command: 'DELETE',
        oid: 0,
        fields: [],
        rows: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.deleteByTenantAndGroup('tenant-123', 'admin-group');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM oidc_group_mappings'),
        ['tenant-123', 'admin-group']
      );
      expect(result).toBe(true);
    });

    it('should return false if no rows were affected', async () => {
      const mockResult = {
        rowCount: 0,
        command: 'DELETE',
        oid: 0,
        fields: [],
        rows: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.deleteByTenantAndGroup('tenant-123', 'nonexistent-group');

      expect(result).toBe(false);
    });

    it('should return false if rowCount is undefined', async () => {
      const mockResult = {
        command: 'DELETE',
        oid: 0,
        fields: [],
        rows: [],
      }; // rowCount is undefined

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.deleteByTenantAndGroup('tenant-123', 'admin-group');

      expect(result).toBe(false);
    });
  });
});
