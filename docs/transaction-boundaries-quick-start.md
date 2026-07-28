# Transaction Boundaries - Quick Start Guide

## TL;DR

Use `withTransaction()` to wrap database operations that need to be atomic (all succeed or all fail together).

```typescript
import { withTransaction } from '../db/transaction';
import { pool } from '../db/pool';

await withTransaction(pool, async (client) => {
  // All queries here are atomic
  await client.query('INSERT INTO users ...');
  await client.query('INSERT INTO profiles ...');
  // If any query fails, both are rolled back
});
```

## When to Use Transactions

✅ **Use transactions when:**
- Creating related records across multiple tables
- Updating multiple records that must stay consistent
- Performing operations that must all succeed or all fail
- Preventing race conditions with locks (FOR UPDATE)

❌ **Don't use transactions for:**
- Single INSERT/UPDATE/DELETE operations (already atomic)
- Read-only queries that don't need consistency
- Operations with external API calls (keep transactions short)

## Common Patterns

### Pattern 1: Create Related Records

```typescript
// Create user with profile atomically
await withTransaction(pool, async (client) => {
  const user = await client.query(
    'INSERT INTO users (email) VALUES ($1) RETURNING *',
    [email]
  );
  
  await client.query(
    'INSERT INTO profiles (user_id, name) VALUES ($1, $2)',
    [user.rows[0].id, name]
  );
});
```

### Pattern 2: Update Multiple Records

```typescript
// Transfer funds between accounts
await withTransaction(pool, async (client) => {
  await client.query(
    'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
    [amount, fromAccountId]
  );
  
  await client.query(
    'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
    [amount, toAccountId]
  );
});
```

### Pattern 3: Repository Integration

```typescript
// Add optional client parameter to repository methods
class UserRepository {
  async create(input: CreateUserInput, client?: PoolClient) {
    const db = client || this.pool;
    return db.query('INSERT INTO users ...');
  }
}

// Use in transaction
await withTransaction(pool, async (client) => {
  const user = await userRepo.create({ email }, client);
  const profile = await profileRepo.create({ userId: user.id }, client);
});
```

### Pattern 4: Batch Operations

```typescript
import { transactional } from '../db/transaction';

// Create multiple records atomically
const results = await transactional(pool, [
  (client) => client.query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']),
  (client) => client.query('INSERT INTO users (email) VALUES ($1)', ['user2@example.com']),
  (client) => client.query('INSERT INTO users (email) VALUES ($1)', ['user3@example.com']),
]);
```

## Transaction Options

### Isolation Levels

```typescript
// Default: READ COMMITTED (usually sufficient)
await withTransaction(pool, async (client) => {
  // ...
});

// REPEATABLE READ: Consistent snapshot
await withTransaction(pool, async (client) => {
  // All reads see same data snapshot
}, { isolationLevel: 'REPEATABLE READ' });

// SERIALIZABLE: Strictest isolation
await withTransaction(pool, async (client) => {
  // Prevents all concurrency anomalies
}, { isolationLevel: 'SERIALIZABLE' });
```

### Read-Only Transactions

```typescript
// Optimize read-only operations
await withTransaction(pool, async (client) => {
  const users = await client.query('SELECT * FROM users');
  const orders = await client.query('SELECT * FROM orders');
  return { users: users.rows, orders: orders.rows };
}, { readOnly: true });
```

### After Commit Hooks for External Side Effects

Use `afterCommit` for external calls that should happen only once the database transaction is durable.
This is important for cross-system workflows such as Stellar/Horizon submissions or other blockchain interactions.

```typescript
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO transactions (amount, user_id) VALUES ($1, $2)', [amount, userId]);
  return { transactionId };
}, {
  afterCommit: async (result) => {
    await submitStellarPayment(result.transactionId);
  },
});
```

If the `afterCommit` callback fails, the DB transaction has already committed, so compensation logic must be handled explicitly.

## Error Handling

Transactions automatically rollback on error:

```typescript
try {
  await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO users ...');
    throw new Error('Something went wrong');
    // Automatic ROLLBACK - user not inserted
  });
} catch (error) {
  // Handle error
  console.log(error.rollbackSucceeded); // true if rollback worked
}
```

## Best Practices

### ✅ DO

- Keep transactions short and focused
- Use parameterized queries ($1, $2, etc.)
- Handle errors appropriately
- Use appropriate isolation level (READ COMMITTED is usually fine)
- Validate inputs before starting transaction

### ❌ DON'T

- Make external API calls inside transactions
- Hold transactions open for user input
- Nest transactions (keep operations in single transaction)
- Use transactions for single operations (already atomic)
- Ignore errors or swallow exceptions

## Performance Tips

1. **Batch operations** when possible
   ```typescript
   // ❌ BAD: Multiple transactions
   for (const user of users) {
     await withTransaction(pool, async (client) => {
       await client.query('INSERT INTO users ...');
     });
   }
   
   // ✅ GOOD: Single transaction
   await withTransaction(pool, async (client) => {
     for (const user of users) {
       await client.query('INSERT INTO users ...');
     }
   });
   ```

2. **Keep transactions short** to reduce lock contention

3. **Use read-only mode** for queries that don't modify data

4. **Choose appropriate isolation level** (READ COMMITTED is usually sufficient)

## Common Mistakes

### Mistake 1: Not Using Client Parameter

```typescript
// ❌ BAD: Doesn't use transaction client
await withTransaction(pool, async (client) => {
  await pool.query('INSERT INTO users ...'); // Uses pool, not client!
});

// ✅ GOOD: Uses transaction client
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO users ...'); // Uses client
});
```

### Mistake 2: External Calls in Transaction

```typescript
// ❌ BAD: External API call in transaction
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO orders ...');
  await fetch('https://api.example.com/notify'); // Slow!
  await client.query('UPDATE inventory ...');
});

// ✅ GOOD: External calls outside transaction
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO orders ...');
  await client.query('UPDATE inventory ...');
});
await fetch('https://api.example.com/notify'); // After commit
```

### Mistake 3: Ignoring Errors

```typescript
// ❌ BAD: Swallowing errors
try {
  await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO users ...');
  });
} catch (error) {
  // Ignoring error - bad!
}

// ✅ GOOD: Handling errors
try {
  await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO users ...');
  });
} catch (error) {
  logger.error('Transaction failed:', error);
  throw error; // Re-throw or handle appropriately
}
```

## Testing Transactions

```typescript
describe('User Service', () => {
  it('should create user and profile atomically', async () => {
    const result = await withTransaction(pool, async (client) => {
      // Test transaction logic
    });
    
    expect(result).toBeDefined();
  });
  
  it('should rollback on error', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO users ...');
        throw new Error('Test error');
      })
    ).rejects.toThrow();
    
    // Verify user was not created
    const users = await pool.query('SELECT * FROM users');
    expect(users.rows).toHaveLength(0);
  });
});
```

## Need More Details?

See the full documentation: `docs/repository-transaction-boundaries.md`

## Examples

- Basic examples: `src/db/transaction.example.ts`
- Integration examples: `src/db/transaction.integration.example.ts`
- Test examples: `src/db/transaction.test.ts`
