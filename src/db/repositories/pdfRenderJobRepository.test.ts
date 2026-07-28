/**
 * Repository unit tests for pdf_render_jobs checkpointing (#540).
 */

import { Pool } from 'pg';
import {
  PdfRenderJobRepository,
  buildStatementStorageKey,
  checksumPayload,
} from './pdfRenderJobRepository';

function makePool(handlers: {
  query?: jest.Mock;
  connect?: jest.Mock;
}): Pool {
  return {
    query: handlers.query ?? jest.fn(),
    connect: handlers.connect ?? jest.fn(),
  } as unknown as Pool;
}

describe('PdfRenderJobRepository', () => {
  it('enqueueBatch inserts batch + unique investors', async () => {
    const query = jest
      .fn()
      // batch insert
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'b1',
            period_id: '2026-06',
            total_jobs: 2,
            completed_jobs: 0,
            failed_jobs: 0,
            status: 'running',
            started_at: new Date(),
            completed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      // job inserts
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'j1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'j2' }] });

    const repo = new PdfRenderJobRepository(makePool({ query }));
    const result = await repo.enqueueBatch('2026-06', ['inv-1', 'inv-2', 'inv-1']);
    expect(result.inserted).toBe(2);
    expect(result.batch.id).toBe('b1');
    const batchIdUsed = query.mock.calls[0][1][0] as string;
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pdf_render_jobs'),
      expect.arrayContaining([
        batchIdUsed,
        'inv-1',
        '2026-06',
        buildStatementStorageKey('2026-06', 'inv-1'),
      ]),
    );
  });

  it('claimJobs uses a transaction and SKIP LOCKED', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'j1',
            batch_id: 'b1',
            investor_id: 'inv-1',
            period_id: '2026-06',
            status: 'pending',
            attempts: 0,
            available_at: new Date(),
            claimed_at: null,
            storage_key: 'statements/2026-06/inv-1.pdf',
            checksum: null,
            error: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'j1',
            batch_id: 'b1',
            investor_id: 'inv-1',
            period_id: '2026-06',
            status: 'processing',
            attempts: 1,
            available_at: new Date(),
            claimed_at: new Date(),
            storage_key: 'statements/2026-06/inv-1.pdf',
            checksum: null,
            error: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce(undefined); // COMMIT

    const client = { query: clientQuery, release: jest.fn() };
    const connect = jest.fn().mockResolvedValue(client);
    const repo = new PdfRenderJobRepository(makePool({ connect }));

    const claimed = await repo.claimJobs(10, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('processing');
    expect(clientQuery.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(client.release).toHaveBeenCalled();
  });

  it('markCompleted checkpoints storage_key and checksum', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    await repo.markCompleted('j1', 'statements/2026-06/inv-1.pdf', 'abc');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'completed'"),
      ['j1', 'statements/2026-06/inv-1.pdf', 'abc'],
    );
  });

  it('markFailed with retryAfter returns job to pending', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    const when = new Date(Date.now() + 1000);
    await repo.markFailed('j1', 'boom', when);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'pending'"),
      ['j1', when, 'boom'],
    );
  });

  it('markFailed without retryAfter dead-letters', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    await repo.markFailed('j1', 'boom');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      ['j1', 'boom'],
    );
  });

  it('getBatch and countPending query helpers', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'b1',
            period_id: '2026-06',
            total_jobs: 1,
            completed_jobs: 0,
            failed_jobs: 0,
            status: 'running',
            started_at: null,
            completed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] });

    const repo = new PdfRenderJobRepository(makePool({ query }));
    expect((await repo.getBatch('b1'))?.id).toBe('b1');
    expect(await repo.getBatch('missing')).toBeNull();
    expect(await repo.countPending('b1')).toBe(3);
    expect(await repo.countPending()).toBe(4);
  });

  it('claimJobs rolls back on error', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('db down'));
    const client = { query: clientQuery, release: jest.fn() };
    // ROLLBACK after failure
    clientQuery.mockResolvedValueOnce(undefined);
    const repo = new PdfRenderJobRepository(
      makePool({ connect: jest.fn().mockResolvedValue(client) }),
    );
    await expect(repo.claimJobs(1, 1000)).rejects.toThrow('db down');
    expect(client.release).toHaveBeenCalled();
  });

  it('enqueueBatch adjusts total_jobs when inserts are skipped', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'b2',
            period_id: '2026-06',
            total_jobs: 2,
            completed_jobs: 0,
            failed_jobs: 0,
            status: 'running',
            started_at: new Date(),
            completed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'j1' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const repo = new PdfRenderJobRepository(makePool({ query }));
    const result = await repo.enqueueBatch('2026-06', ['inv-1', 'inv-2']);
    expect(result.inserted).toBe(1);
    expect(result.batch.total_jobs).toBe(1);
    const batchIdUsed = query.mock.calls[0][1][0] as string;
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pdf_render_batches SET total_jobs'),
      [batchIdUsed, 1],
    );
  });

  it('enqueueBatch treats undefined rowCount as zero inserts', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'b4',
            period_id: '2026-06',
            total_jobs: 1,
            completed_jobs: 0,
            failed_jobs: 0,
            status: 'running',
            started_at: new Date(),
            completed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const repo = new PdfRenderJobRepository(makePool({ query }));
    const result = await repo.enqueueBatch('2026-06', ['inv-1']);
    expect(result.inserted).toBe(0);
    expect(result.batch.total_jobs).toBe(0);
  });

  it('enqueueBatch filters empty investor ids', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'b3',
            period_id: '2026-06',
            total_jobs: 1,
            completed_jobs: 0,
            failed_jobs: 0,
            status: 'running',
            started_at: new Date(),
            completed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'j1' }] });

    const repo = new PdfRenderJobRepository(makePool({ query }));
    const result = await repo.enqueueBatch('2026-06', ['inv-1', '', 'inv-1']);
    expect(result.inserted).toBe(1);
    expect(query.mock.calls[0][1][2]).toBe(1);
  });

  it('markCompleted updates batch counters', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    await repo.markCompleted('j1', 'key', 'sum');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('UPDATE pdf_render_batches');
  });

  it('markFailed dead-letter updates batch counters', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    await repo.markFailed('j1', 'boom');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('failed_jobs = failed_jobs + 1');
  });


  it('claimJobs skips rows when update returns no row', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 'j1', batch_id: 'b1', investor_id: 'i', period_id: 'p', status: 'pending', attempts: 0, available_at: new Date(), claimed_at: null, storage_key: null, checksum: null, error: null, created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const client = { query: clientQuery, release: jest.fn() };
    const repo = new PdfRenderJobRepository(
      makePool({ connect: jest.fn().mockResolvedValue(client) }),
    );
    expect(await repo.claimJobs(1, 1000)).toEqual([]);
  });

  it('countPending treats missing count as zero', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{}] });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    expect(await repo.countPending()).toBe(0);
  });

  it('getBatch maps nullable timestamps', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'b1',
          period_id: 'p',
          total_jobs: '1',
          completed_jobs: '0',
          failed_jobs: '0',
          status: 'running',
          started_at: null,
          completed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    const batch = await repo.getBatch('b1');
    expect(batch?.started_at).toBeNull();
    expect(batch?.completed_at).toBeNull();
  });


  it('getBatch maps non-null timestamps', async () => {
    const started = new Date('2020-01-01T00:00:00Z');
    const completed = new Date('2020-01-02T00:00:00Z');
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'b1',
          period_id: 'p',
          total_jobs: 1,
          completed_jobs: 0,
          failed_jobs: 0,
          status: 'completed',
          started_at: started,
          completed_at: completed,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });
    const repo = new PdfRenderJobRepository(makePool({ query }));
    const batch = await repo.getBatch('b1');
    expect(batch?.started_at?.toISOString()).toBe(started.toISOString());
    expect(batch?.completed_at?.toISOString()).toBe(completed.toISOString());
  });

  it('claimJobs maps nullable job fields from update row', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'j1',
            batch_id: 'b1',
            investor_id: 'i',
            period_id: 'p',
            status: 'pending',
            attempts: 0,
            available_at: new Date(),
            claimed_at: null,
            storage_key: null,
            checksum: null,
            error: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'j1',
            batch_id: 'b1',
            investor_id: 'i',
            period_id: 'p',
            status: 'processing',
            attempts: 1,
            available_at: new Date(),
            claimed_at: new Date(),
            storage_key: null,
            checksum: null,
            error: 'prev',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce(undefined);
    const client = { query: clientQuery, release: jest.fn() };
    const repo = new PdfRenderJobRepository(
      makePool({ connect: jest.fn().mockResolvedValue(client) }),
    );
    const claimed = await repo.claimJobs(1, 1000);
    expect(claimed[0].storage_key).toBeNull();
    expect(claimed[0].claimed_at).toBeInstanceOf(Date);
    expect(claimed[0].error).toBe('prev');
  });

  it('claimJobs maps null claimed_at after claim', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'j1',
            batch_id: 'b1',
            investor_id: 'i',
            period_id: 'p',
            status: 'pending',
            attempts: 0,
            available_at: new Date(),
            claimed_at: null,
            storage_key: 'k',
            checksum: null,
            error: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'j1',
            batch_id: 'b1',
            investor_id: 'i',
            period_id: 'p',
            status: 'processing',
            attempts: 1,
            available_at: new Date(),
            claimed_at: null,
            storage_key: 'k',
            checksum: null,
            error: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce(undefined);
    const client = { query: clientQuery, release: jest.fn() };
    const repo = new PdfRenderJobRepository(
      makePool({ connect: jest.fn().mockResolvedValue(client) }),
    );
    const claimed = await repo.claimJobs(1, 1000);
    expect(claimed[0].claimed_at).toBeNull();
  });

  it('checksumPayload hashes bytes deterministically', () => {
    expect(checksumPayload('abc')).toBe(checksumPayload(Buffer.from('abc')));
  });
});
