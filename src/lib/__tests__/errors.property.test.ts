import * as fc from 'fast-check';
import { UniqueConstraintError } from '../errors';

// Feature: user-uniqueness-constraints, Property 5: UniqueConstraintError constructor invariants

/**
 * Property 5: UniqueConstraintError constructor invariants
 *
 * For any non-empty field string `f`, constructing `new UniqueConstraintError(f)`
 * must produce an object where:
 *   - `name === "UniqueConstraintError"`
 *   - `field === f`
 *   - `message === "Unique constraint violation on " + f`
 *   - `instanceof UniqueConstraintError === true` (prototype chain intact)
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 */
describe('UniqueConstraintError – constructor invariants (Property 5)', () => {
  it('satisfies all invariants for any non-empty field string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (field) => {
        const error = new UniqueConstraintError(field);

        // name must be "UniqueConstraintError"
        expect(error.name).toBe('UniqueConstraintError');

        // field must equal the constructor argument
        expect(error.field).toBe(field);

        // message must be the canonical form
        expect(error.message).toBe(`Unique constraint violation on ${field}`);

        // instanceof must work after TypeScript transpilation (prototype chain)
        expect(error instanceof UniqueConstraintError).toBe(true);

        // must also be an instance of Error
        expect(error instanceof Error).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
