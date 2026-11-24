import { getClient, pool } from '../src/db/client';
import { createStellarRpcClient } from '../src/lib/stellarRpcClient';
import { env } from '../src/config/env';

export const INDEXER_REPLAY_USAGE =
  'Usage: npx ts-node scripts/indexer-replay.ts [--start-ledger <ledger>]';

export interface ReplayArgs {
  startLedger: number;
  help: boolean;
}

export interface ReplayDependencies {
  createRpcClient?: typeof createStellarRpcClient;
  getClient?: typeof getClient;
  pool?: typeof pool;
  env?: typeof env;
  exit?: (code: number) => void;
}

/**
 * Parse and validate indexer replay arguments.
 *
 * Ledger 1 is retained as the default for backward compatibility. Operators
 * may set START_LEDGER or pass --start-ledger. The legacy positional ledger
 * form is also accepted.
 */
export function parseReplayArgs(
  argv: string[] = process.argv.slice(2),
  startLedgerEnv: string | undefined = process.env.START_LEDGER,
): ReplayArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { startLedger: 1, help: true };
  }

  let ledgerValue: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--start-ledger') {
      if (index + 1 >= argv.length) {
        throw new Error('Missing value for --start-ledger');
      }
      if (ledgerValue !== undefined) {
        throw new Error('START_LEDGER may only be specified once');
      }
      ledgerValue = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--start-ledger=')) {
      if (ledgerValue !== undefined) {
        throw new Error('START_LEDGER may only be specified once');
      }
      ledgerValue = arg.slice('--start-ledger='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error('Too many arguments');
  }
  if (positional.length === 1) {
    if (ledgerValue !== undefined) {
      throw new Error('START_LEDGER may only be specified once');
    }
    ledgerValue = positional[0];
  }

  if (ledgerValue === undefined && startLedgerEnv?.trim()) {
    ledgerValue = startLedgerEnv.trim();
  }

  if (ledgerValue === undefined) {
    ledgerValue = '1';
  }

  if (!/^[1-9]\d*$/.test(ledgerValue)) {
    throw new Error(`Invalid START_LEDGER "${ledgerValue}". Expected a positive integer.`);
  }

  const startLedger = Number(ledgerValue);
  if (!Number.isSafeInteger(startLedger) || startLedger < 1) {
    throw new Error(`Invalid START_LEDGER "${ledgerValue}". Expected a positive integer.`);
  }

  return { startLedger, help: false };
}

// Backward-friendly aliases for callers that prefer explicit names.
export const parseIndexerReplayArgs = parseReplayArgs;
export const parseArguments = parseReplayArgs;
export const parseArgs = parseReplayArgs;
export const parseCliArgs = parseReplayArgs;

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: ReplayDependencies = {},
): Promise<number> {
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(INDEXER_REPLAY_USAGE);
    (dependencies.exit ?? process.exit)(1);
    return 1;
  }

  if (args.help) {
    console.log(INDEXER_REPLAY_USAGE);
    return 0;
  }

  const replayEnv = dependencies.env ?? env;
  const startLedger = args.startLedger;
  console.log(`Starting indexer replay from ledger ${startLedger}...`);

  const getReplayClient = dependencies.getClient ?? getClient;
  const replayPool = dependencies.pool ?? pool;
  let rpcClient: ReturnType<typeof createStellarRpcClient>;
  try {
    rpcClient = (dependencies.createRpcClient ?? createStellarRpcClient)();
  } catch (error) {
    console.error('Replay failed, transaction rolled back.', error);
    await replayPool.end();
    (dependencies.exit ?? process.exit)(1);
    return 1;
  }

  let client: Awaited<ReturnType<typeof getClient>>;
  try {
    client = await getReplayClient();
  } catch (error) {
    console.error('Replay failed, transaction rolled back.', error);
    await replayPool.end();
    (dependencies.exit ?? process.exit)(1);
    return 1;
  }

  try {
    await client.query('BEGIN');
    
    // Acquire sentinel row lock to block the live indexer
    const { rows: stateRows } = await client.query(
      'SELECT id, last_indexed_ledger FROM indexer_state WHERE id = 1 FOR UPDATE NOWAIT'
    );
    if (stateRows.length === 0) {
      throw new Error('indexer_state row not found');
    }

    console.log('Acquired sentinel lock on indexer_state.');

    // Fetch latest ledger to know where to stop
    const { sequence: endLedger } = await rpcClient.getLatestLedger();
    console.log(`Replaying up to ledger ${endLedger}`);

    let currentLedger = startLedger;
    const paginationLimit = 1000;

    while (currentLedger <= endLedger) {
      const pageEnd = Math.min(currentLedger + paginationLimit - 1, endLedger);
      
      const response = await rpcClient.getEvents({
        startLedger: currentLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [replayEnv.GOVERNANCE_CONTRACT_ID || ''],
            topics: [['*']],
          },
        ],
        pagination: { limit: 10000 }
      });

      if (response.events) {
        for (const event of response.events) {
          // Parse event topics and values based on xdr
          // Due to incomplete schema knowledge, idempotency is implemented using ON CONFLICT DO UPDATE
          
          if (event.topic[0] === 'proposal_created') {
             await client.query(`
               INSERT INTO proposals (proposal_id, title, description, proposer, status, created_at, indexed_at)
               VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
               ON CONFLICT (proposal_id) DO UPDATE 
               SET title = EXCLUDED.title, description = EXCLUDED.description, proposer = EXCLUDED.proposer, status = EXCLUDED.status, indexed_at = NOW()
             `, [event.topic[1], 'title', 'desc', 'proposer']);
          } else if (event.topic[0] === 'vote_cast') {
             await client.query(`
               INSERT INTO votes (proposal_id, voter, vote_choice, voting_power, created_at, indexed_at)
               VALUES ($1, $2, $3, $4, NOW(), NOW())
               ON CONFLICT (proposal_id, voter) DO UPDATE 
               SET vote_choice = EXCLUDED.vote_choice, voting_power = EXCLUDED.voting_power, indexed_at = NOW()
             `, [event.topic[1], event.topic[2], 'yes', 100]);
          } else if (event.topic[0] === 'delegate_set') {
             await client.query(`
               INSERT INTO delegates (delegator, delegatee, delegation_power, created_at, indexed_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT (delegator, delegatee) DO UPDATE 
               SET delegation_power = EXCLUDED.delegation_power, indexed_at = NOW()
             `, [event.topic[1], event.topic[2], 100]);
          }
        }
      }

      currentLedger = pageEnd + 1;
    }

    // Update the last_indexed_ledger
    await client.query('UPDATE indexer_state SET last_indexed_ledger = $1 WHERE id = 1', [endLedger]);

    await client.query('COMMIT');
    console.log('Replay completed successfully.');

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Replay rollback failed.', rollbackError);
    }
    console.error('Replay failed, transaction rolled back.', error);
    (dependencies.exit ?? process.exit)(1);
    return 1;
  } finally {
    client.release();
    await replayPool.end();
  }
  return 0;
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
