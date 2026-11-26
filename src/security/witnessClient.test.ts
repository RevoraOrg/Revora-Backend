import { MockWitnessClient } from './witnessClient';

describe('MockWitnessClient', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a receipt with the expected shape and increments attempts', async () => {
    const publishedAt = new Date('2026-01-02T03:04:05.000Z');
    jest.useFakeTimers().setSystemTime(publishedAt);
    const client = new MockWitnessClient();

    const first = await client.publish('root-1');
    const second = await client.publish('root-2');

    expect(first).toEqual({
      rootHash: 'root-1',
      witnessType: 'mock',
      publishedAt,
      receiptData: {
        attempt: 1,
        txId: `mock-tx-${publishedAt.getTime()}`,
      },
    });
    expect(second).toEqual({
      rootHash: 'root-2',
      witnessType: 'mock',
      publishedAt,
      receiptData: {
        attempt: 2,
        txId: `mock-tx-${publishedAt.getTime()}`,
      },
    });
  });

  it('fails the configured number of attempts before succeeding', async () => {
    const client = new MockWitnessClient();
    client.simulateFailureAttempts = 2;

    await expect(client.publish('root-1')).rejects.toThrow('Mock witness publish failed');
    await expect(client.publish('root-1')).rejects.toThrow('Mock witness publish failed');
    await expect(client.publish('root-1')).resolves.toMatchObject({
      rootHash: 'root-1',
      witnessType: 'mock',
      publishedAt: expect.any(Date),
      receiptData: {
        attempt: 3,
      },
    });
    expect(client.simulateFailureAttempts).toBe(0);
  });
});
