import {
  HorizonTransactionHistoryFetcher,
  HorizonTransactionPage,
} from './horizonTransactionHistoryFetcher';

function page(tokens: string[]): HorizonTransactionPage {
  return {
    _embedded: {
      records: tokens.map((paging_token) => ({
        paging_token,
        id: `tx-${paging_token}`,
        created_at: '2026-01-01T00:00:00Z',
        ledger: Number(paging_token),
      })),
    },
    _links: { self: { href: '/transactions' } },
  };
}

describe('HorizonTransactionHistoryFetcher regression behavior', () => {
  it('propagates upstream failures without advancing state', async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error('Horizon unavailable'));
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage,
      initialCursor: '41',
    });

    await expect(fetcher.fetchNextPage()).rejects.toThrow('Horizon unavailable');
    expect(fetcher.getCursor()).toBe('41');
    expect(fetcher.getTotalPagesFetched()).toBe(0);
    expect(fetcher.getTotalIngested()).toBe(0);
  });

  it('treats an empty page as a safe no-op and records the audit event', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => page([]),
      initialCursor: '41',
    });
    const audit = jest.fn();
    fetcher.on('audit', audit);

    const result = await fetcher.fetchNextPage();

    expect(result.records).toEqual([]);
    expect(result.cursor).toBe('41');
    expect(result.paused).toBe(false);
    expect(fetcher.getTotalPagesFetched()).toBe(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ingest.page.empty', cursor: '41' }));
  });

  it('advances only after a clean page is accepted', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => page(['42', '43']),
      initialCursor: '41',
    });

    const result = await fetcher.fetchNextPage();

    expect(result.records).toHaveLength(2);
    expect(result.cursor).toBe('43');
    expect(result.gapDetected).toBe(false);
    expect(fetcher.getTotalIngested()).toBe(2);
  });

  it('does not consume records or move the cursor when a gap is detected', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => page(['44']),
      initialCursor: '41',
    });

    const result = await fetcher.fetchNextPage();

    expect(result.gapDetected).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.records).toEqual([]);
    expect(result.cursor).toBe('41');
    expect(fetcher.getTotalIngested()).toBe(0);
  });
});
