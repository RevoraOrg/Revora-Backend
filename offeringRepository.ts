import { Pool, PoolClient } from 'pg';
import { Offering, UpdateOfferingInput } from '../types/offering';
import { ConcurrencyError } from '../lib/errors';
import { withTransaction } from './transaction';

/**
 * Repository for Offering operations implementing optimistic concurrency.
 */
export class OfferingRepository {
  constructor(private pool: Pool) {}

  /**
   * Updates an offering only if the version matches.
   * @param id The offering ID
   * @param issuerId The ID of the startup performing the update (for auth boundary)
   * @param input Update data including the expected version
   * @throws ConcurrencyError if the version does not match or record is missing
   */
  async update(id: string, issuerId: string, input: UpdateOfferingInput): Promise<Offering> {
    return withTransaction(this.pool, async (client: PoolClient) => {
      const { title, description, amount, status, version } = input;

      const query = `
        UPDATE offerings 
        SET 
          title = COALESCE($1, title),
          description = COALESCE($2, description),
          amount = COALESCE($3, amount),
          status = COALESCE($4, status),
          version = version + 1,
          updated_at = NOW()
        WHERE id = $5 
          AND issuer_id = $6 
          AND version = $7
        RETURNING *;
      `;

      const values = [title, description, amount, status, id, issuerId, version];
      const result = await client.query(query, values);

      if (result.rowCount === 0) {
        // Check if it's a version mismatch or missing record
        const check = await client.query('SELECT version FROM offerings WHERE id = $1', [id]);
        if (check.rowCount > 0) {
          throw new ConcurrencyError(
            `Conflict detected: Current version is ${check.rows[0].version}, but ${version} was provided.`
          );
        } else {
          throw new Error('Offering not found or unauthorized');
        }
      }

      return result.rows[0];
    });
  }
}