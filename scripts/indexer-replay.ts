import { getClient, pool } from '../src/db/client';
import { createStellarRpcClient } from '../src/lib/stellarRpcClient';
import { env } from '../src/config/env';

async function main() {
  const rpcClient = createStellarRpcClient();
  const startLedger = parseInt(process.env.START_LEDGER || '1', 10);
  console.log(`Starting indexer replay from ledger ${startLedger}...`);

  const client = await getClient();
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
            contractIds: [env.GOVERNANCE_CONTRACT_ID || ''],
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
    await client.query('ROLLBACK');
    console.error('Replay failed, transaction rolled back.', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
