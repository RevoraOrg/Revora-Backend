import {
  INDEXER_REPLAY_USAGE,
  main,
  parseReplayArgs,
} from './indexer-replay';

describe('indexer replay argument handling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to ledger 1 when no argument or environment value is provided', () => {
    expect(parseReplayArgs([], undefined)).toEqual({
      startLedger: 1,
      help: false,
    });
  });

  it('accepts START_LEDGER and CLI ledger values', () => {
    expect(parseReplayArgs([], '42').startLedger).toBe(42);
    expect(parseReplayArgs(['--start-ledger', '73']).startLedger).toBe(73);
    expect(parseReplayArgs(['--start-ledger=91']).startLedger).toBe(91);
    expect(parseReplayArgs(['123']).startLedger).toBe(123);
  });

  it('returns help mode for help flags', () => {
    expect(parseReplayArgs(['--help'])).toEqual({
      startLedger: 1,
      help: true,
    });
    expect(parseReplayArgs(['-h']).help).toBe(true);
  });

  it('rejects missing values for --start-ledger', () => {
    expect(() => parseReplayArgs(['--start-ledger'])).toThrow(
      'Missing value for --start-ledger',
    );
  });

  it('rejects invalid, unknown, duplicate, and extra arguments', () => {
    expect(() => parseReplayArgs(['--start-ledger', '0'])).toThrow(
      'Expected a positive integer',
    );
    expect(() => parseReplayArgs(['--start-ledger', '1.5'])).toThrow(
      'Expected a positive integer',
    );
    expect(() => parseReplayArgs(['--start-ledger', '9007199254740992'])).toThrow(
      'Expected a positive integer',
    );
    expect(() => parseReplayArgs(['--unknown'])).toThrow(
      'Unknown argument',
    );
    expect(() =>
      parseReplayArgs(['--start-ledger', '10', '--start-ledger=20']),
    ).toThrow('may only be specified once');
    expect(() => parseReplayArgs(['10', '20'])).toThrow('Too many arguments');
  });
});

describe('indexer replay main', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeDependencies(overrides: Record<string, unknown> = {}) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, last_indexed_ledger')) {
        return { rows: [{ id: 1, last_indexed_ledger: 1 }] };
      }
      return { rows: [] };
    });
    const client = {
      query,
      release: jest.fn(),
    };
    const rpcClient = {
      getLatestLedger: jest.fn(async () => ({ sequence: 101 })),
      getEvents: jest.fn(async () => ({ events: [] })),
    };
    const pool = {
      end: jest.fn(async () => undefined),
    };

    return {
      dependencies: {
        createRpcClient: jest.fn(() => rpcClient),
        getClient: jest.fn(async () => client),
        pool,
        env: { GOVERNANCE_CONTRACT_ID: 'contract-1' },
        exit: jest.fn(),
        ...overrides,
      },
      client,
      rpcClient,
      pool,
    };
  }

  it('exits with 1 and does not acquire dependencies for missing flag values', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exit = jest.fn();
    const createRpcClient = jest.fn();

    const result = await main(
      ['--start-ledger'],
      { createRpcClient, exit },
    );

    expect(result).toBe(1);
    expect(createRpcClient).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Missing value for --start-ledger',
    );
  });

  it('exits with 1 and does not acquire dependencies for invalid arguments', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exit = jest.fn();
    const createRpcClient = jest.fn();

    const result = await main(
      ['--start-ledger', '-1'],
      { createRpcClient, exit },
    );

    expect(result).toBe(1);
    expect(createRpcClient).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid START_LEDGER'),
    );
  });

  it('prints usage for help and succeeds without dependencies', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const createRpcClient = jest.fn();

    const result = await main(['--help'], { createRpcClient });

    expect(result).toBe(0);
    expect(createRpcClient).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(INDEXER_REPLAY_USAGE);
  });

  it('runs the replay happily with a mocked RPC and database', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const fixture = makeDependencies();

    const result = await main(
      ['--start-ledger', '100'],
      fixture.dependencies,
    );

    expect(result).toBe(0);
    expect(fixture.dependencies.createRpcClient).toHaveBeenCalledTimes(1);
    expect(fixture.rpcClient.getLatestLedger).toHaveBeenCalledTimes(1);
    expect(fixture.rpcClient.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        startLedger: 100,
        filters: [
          expect.objectContaining({
            contractIds: ['contract-1'],
          }),
        ],
      }),
    );
    expect(fixture.client.query).toHaveBeenCalledWith('BEGIN');
    expect(fixture.client.query).toHaveBeenCalledWith(
      'UPDATE indexer_state SET last_indexed_ledger = $1 WHERE id = 1',
      [101],
    );
    expect(fixture.client.query).toHaveBeenCalledWith('COMMIT');
    expect(fixture.client.release).toHaveBeenCalledTimes(1);
    expect(fixture.pool.end).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('Replay completed successfully.');
  });

  it('rolls back and exits 1 when replay dependencies or the transaction fail', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = makeDependencies();
    fixture.client.query.mockImplementationOnce(async () => {
      throw new Error('database unavailable');
    });

    const result = await main([], fixture.dependencies);

    expect(result).toBe(1);
    expect(fixture.dependencies.exit).toHaveBeenCalledWith(1);
    expect(fixture.client.release).toHaveBeenCalledTimes(1);
    expect(fixture.pool.end).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Replay failed, transaction rolled back.',
      expect.any(Error),
    );
  });

  it('exits 1 without a database client when getClient fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exit = jest.fn();
    const pool = { end: jest.fn(async () => undefined) };

    const result = await main([], {
      createRpcClient: jest.fn(() => ({ getLatestLedger: jest.fn(), getEvents: jest.fn() })),
      getClient: jest.fn(async () => {
        throw new Error('connection refused');
      }),
      pool,
      exit,
    });

    expect(result).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Replay failed, transaction rolled back.',
      expect.any(Error),
    );
  });

  it('exits 1 and closes the pool when RPC client creation fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exit = jest.fn();
    const pool = { end: jest.fn(async () => undefined) };
    const getClient = jest.fn();

    const result = await main([], {
      createRpcClient: jest.fn(() => {
        throw new Error('RPC unavailable');
      }),
      getClient,
      pool,
      exit,
    });

    expect(result).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(getClient).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Replay failed, transaction rolled back.',
      expect.any(Error),
    );
  });
});
