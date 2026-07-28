import { Pool } from 'pg';
import { WebhookEndpointRepository, CreateWebhookEndpointInput } from './webhookEndpointRepository';

describe('WebhookEndpointRepository', () => {
  let mockPool: jest.Mocked<Pool>;
  let repository: WebhookEndpointRepository;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;
    repository = new WebhookEndpointRepository(mockPool);
  });

  describe('create', () => {
    it('should create a webhook endpoint', async () => {
      const input: CreateWebhookEndpointInput = {
        owner_id: 'user-123',
        url: 'https://example.com/webhook',
        secret: 'webhook-secret',
        events: ['offering.created', 'offering.updated'],
      };

      const mockRow = {
        id: 'webhook-1',
        owner_id: input.owner_id,
        url: input.url,
        secret: input.secret,
        events: input.events,
        active: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [mockRow],
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO webhook_endpoints'),
        [input.owner_id, input.url, input.secret, input.events]
      );
      expect(result).toEqual({
        id: 'webhook-1',
        owner_id: input.owner_id,
        url: input.url,
        secret: input.secret,
        events: input.events,
        active: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
      });
    });

    it('should handle empty events array', async () => {
      const input: CreateWebhookEndpointInput = {
        owner_id: 'user-123',
        url: 'https://example.com/webhook',
        secret: 'webhook-secret',
        events: [],
      };

      const mockRow = {
        id: 'webhook-1',
        owner_id: input.owner_id,
        url: input.url,
        secret: input.secret,
        events: [],
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [mockRow],
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.create(input);

      expect(result.events).toEqual([]);
    });
  });

  describe('findById', () => {
    it('should find webhook endpoint by id', async () => {
      const mockRow = {
        id: 'webhook-1',
        owner_id: 'user-123',
        url: 'https://example.com/webhook',
        secret: 'webhook-secret',
        events: ['offering.created'],
        active: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [mockRow],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.findById('webhook-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM webhook_endpoints WHERE id = $1'),
        ['webhook-1']
      );
      expect(result).toEqual({
        id: 'webhook-1',
        owner_id: 'user-123',
        url: 'https://example.com/webhook',
        secret: 'webhook-secret',
        events: ['offering.created'],
        active: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
      });
    });

    it('should return null when webhook endpoint not found', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await repository.findById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listByOwner', () => {
    it('should list webhook endpoints by owner', async () => {
      const mockRows = [
        {
          id: 'webhook-1',
          owner_id: 'user-123',
          url: 'https://example.com/webhook1',
          secret: 'secret1',
          events: ['offering.created'],
          active: true,
          created_at: new Date('2024-01-01T00:00:00Z'),
          updated_at: new Date('2024-01-01T00:00:00Z'),
        },
        {
          id: 'webhook-2',
          owner_id: 'user-123',
          url: 'https://example.com/webhook2',
          secret: 'secret2',
          events: ['payout.completed'],
          active: false,
          created_at: new Date('2024-01-02T00:00:00Z'),
          updated_at: new Date('2024-01-02T00:00:00Z'),
        },
      ];

      mockPool.query.mockResolvedValueOnce({
        rows: mockRows,
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      });

      const result = await repository.listByOwner('user-123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM webhook_endpoints WHERE owner_id = $1'),
        ['user-123']
      );
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('webhook-1');
      expect(result[1].id).toBe('webhook-2');
    });

    it('should return empty array when owner has no webhooks', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await repository.listByOwner('user-no-webhooks');

      expect(result).toEqual([]);
    });
  });

  describe('listActiveByEvent', () => {
    it('should list active webhook endpoints subscribed to event', async () => {
      const mockRows = [
        {
          id: 'webhook-1',
          owner_id: 'user-123',
          url: 'https://example.com/webhook1',
          secret: 'secret1',
          events: ['offering.created', 'offering.updated'],
          active: true,
          created_at: new Date('2024-01-01T00:00:00Z'),
          updated_at: new Date('2024-01-01T00:00:00Z'),
        },
        {
          id: 'webhook-2',
          owner_id: 'user-456',
          url: 'https://example.com/webhook2',
          secret: 'secret2',
          events: ['offering.created'],
          active: true,
          created_at: new Date('2024-01-02T00:00:00Z'),
          updated_at: new Date('2024-01-02T00:00:00Z'),
        },
      ];

      mockPool.query.mockResolvedValueOnce({
        rows: mockRows,
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      });

      const result = await repository.listActiveByEvent('offering.created');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE active = TRUE AND $1 = ANY(events)'),
        ['offering.created']
      );
      expect(result).toHaveLength(2);
      expect(result[0].active).toBe(true);
      expect(result[1].active).toBe(true);
    });

    it('should return empty array when no active endpoints for event', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await repository.listActiveByEvent('rare.event');

      expect(result).toEqual([]);
    });

    it('should not return inactive endpoints', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await repository.listActiveByEvent('offering.created');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE active = TRUE'),
        ['offering.created']
      );
      expect(result).toEqual([]);
    });
  });

  describe('deactivate', () => {
    it('should deactivate webhook endpoint', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'UPDATE',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      await repository.deactivate('webhook-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE webhook_endpoints SET active = FALSE WHERE id = $1'),
        ['webhook-1']
      );
    });

    it('should handle deactivating non-existent endpoint', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'UPDATE',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await expect(repository.deactivate('non-existent')).resolves.not.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete webhook endpoint', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'DELETE',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      await repository.delete('webhook-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM webhook_endpoints WHERE id = $1'),
        ['webhook-1']
      );
    });

    it('should handle deleting non-existent endpoint', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        command: 'DELETE',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await expect(repository.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      await expect(repository.findById('webhook-1')).rejects.toThrow('Database connection failed');
    });

    it('should handle malformed date strings', async () => {
      const mockRow = {
        id: 'webhook-1',
        owner_id: 'user-123',
        url: 'https://example.com/webhook',
        secret: 'secret',
        events: ['test.event'],
        active: true,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [mockRow],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.findById('webhook-1');

      expect(result?.created_at).toBeInstanceOf(Date);
      expect(result?.updated_at).toBeInstanceOf(Date);
    });

    it('should handle multiple events in array', async () => {
      const input: CreateWebhookEndpointInput = {
        owner_id: 'user-123',
        url: 'https://example.com/webhook',
        secret: 'secret',
        events: [
          'offering.created',
          'offering.updated',
          'revenue.reported',
          'distribution.started',
          'distribution.completed',
          'payout.completed',
          'payout.failed',
        ],
      };

      const mockRow = {
        id: 'webhook-1',
        ...input,
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [mockRow],
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await repository.create(input);

      expect(result.events).toHaveLength(7);
      expect(result.events).toContain('offering.created');
      expect(result.events).toContain('payout.failed');
    });
  });
});
