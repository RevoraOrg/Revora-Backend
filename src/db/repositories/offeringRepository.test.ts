import { Pool, QueryResult } from 'pg';
import {
  CreateOfferingInput,
  Offering,
  OfferingRepository,
} from './offeringRepository';

describe('OfferingRepository', () => {
  let repository: OfferingRepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    repository = new OfferingRepository(mockPool);
  });

  it('creates an offering with provided fields', async () => {
    const input: CreateOfferingInput = {
      issuer_user_id: 'issuer-123',
      title: 'Revenue Share 2026',
      status: 'draft',
      target_amount: '50000.00',
    };

    const mockResult = {
      rows: [{ id: 'off-1', ...input }],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(mockResult as never);

    const result = await repository.create(input);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO offerings'),
      ['issuer-123', 'Revenue Share 2026', 'draft', '50000.00']
    );
    expect(result.id).toBe('off-1');
    expect(result.issuer_user_id).toBe('issuer-123');
  });

  it('returns offering by id when found', async () => {
    const mockResult = {
      rows: [{ id: 'off-2', issuer_user_id: 'issuer-999', status: 'open' }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(mockResult as never);

    const result = await repository.getById('off-2');

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1'),
      ['off-2']
    );
    expect(result).toEqual({
      id: 'off-2',
      issuer_user_id: 'issuer-999',
      status: 'open',
    });
  });

  it('returns null when offering is not found by id', async () => {
    const mockResult = {
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(mockResult as never);

    const result = await repository.getById('missing-id');
    expect(result).toBeNull();
  });

  it('lists offerings by issuer with filters', async () => {
    const mockResult = {
      rows: [
        { id: 'off-a', issuer_user_id: 'issuer-1', status: 'open' },
        { id: 'off-b', issuer_user_id: 'issuer-1', status: 'open' },
      ],
      rowCount: 2,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(mockResult as never);

    const result = await repository.listByIssuer('issuer-1', {
      status: 'open',
      limit: 10,
      offset: 5,
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE issuer_user_id = $1 AND status = $2'),
      ['issuer-1', 'open', 10, 5]
    );
    expect(result).toHaveLength(2);
  });

  it('updates offering with provided partial fields', async () => {
    const mockResult = {
      rows: [{ id: 'off-3', title: 'Updated Title', status: 'open' }],
      rowCount: 1,
      command: 'UPDATE',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(mockResult as never);

    const result = await repository.update('off-3', {
      title: 'Updated Title',
      status: 'open',
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE offerings'),
      ['Updated Title', 'open', 'off-3']
    );
    expect(result).toEqual({
      id: 'off-3',
      title: 'Updated Title',
      status: 'open',
    });
  });

  it('update returns current row when partial payload is empty', async () => {
    const getByIdResult = {
      rows: [{ id: 'off-4', issuer_user_id: 'issuer-4', status: 'draft' }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(getByIdResult as never);

    const result = await repository.update('off-4', {});

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1'),
      ['off-4']
    );
    expect(result?.id).toBe('off-4');
  });

  it('updateStatus delegates to update and returns updated row', async () => {
    const mockResult = {
      rows: [{ id: 'off-5', status: 'closed' }],
      rowCount: 1,
      command: 'UPDATE',
      oid: 0,
      fields: [],
    } as QueryResult<Offering>;

    mockPool.query.mockResolvedValueOnce(mockResult as never);

    const result = await repository.updateStatus('off-5', 'closed');

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $1, updated_at = NOW()'),
      ['closed', 'off-5']
    );
    expect(result?.status).toBe('closed');
  });
});
