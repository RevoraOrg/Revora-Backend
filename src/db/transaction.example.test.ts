import { Pool } from 'pg';
import {
  createUserExample,
  transferFundsExample,
  processPaymentExample,
} from './transaction.example';
import { TransactionError } from './transaction';

describe('transaction.example.ts', () => {
  let mockClient: any;
  let mockPool: any;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    } as unknown as Pool;
  });

  describe('createUserExample', () => {
    it('should create a user and audit log on success', async () => {
      const email = 'test@example.com';
      const name = 'Test User';
      const user = { id: 'user-123', email, name };

      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // INSERT INTO users
      mockClient.query.mockResolvedValueOnce({ rows: [user] });
      // INSERT INTO audit_logs
      mockClient.query.mockResolvedValueOnce({});
      // COMMIT
      mockClient.query.mockResolvedValueOnce({});

      const result = await createUserExample(mockPool, email, name);

      expect(result).toEqual(user);
      expect(mockClient.query).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
        [email, name]
      );
      expect(mockClient.query).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO audit_logs (action, user_id, details) VALUES ($1, $2, $3)',
        ['USER_CREATED', user.id, JSON.stringify({ email, name })]
      );
    });

    it('should fail with an error when user insert returns an empty result', async () => {
      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // INSERT INTO users returns empty rows
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      // ROLLBACK
      mockClient.query.mockResolvedValueOnce({});

      let error: any;
      try {
        await createUserExample(mockPool, 'test@example.com', 'Test User');
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TransactionError);
      expect(error.message).toMatch(/Cannot read properties of undefined|Cannot read property 'id' of undefined/);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('transferFundsExample', () => {
    it('should successfully transfer funds', async () => {
      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // Debit
      mockClient.query.mockResolvedValueOnce({ rows: [{ balance: 100 }] });
      // Credit
      mockClient.query.mockResolvedValueOnce({});
      // Audit
      mockClient.query.mockResolvedValueOnce({});
      // COMMIT
      mockClient.query.mockResolvedValueOnce({});

      const result = await transferFundsExample(mockPool, 'acc-1', 'acc-2', 50);

      expect(result).toEqual({ success: true, amount: 50 });
      expect(mockClient.query).toHaveBeenCalledWith(
        'UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance',
        [50, 'acc-1']
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
        [50, 'acc-2']
      );
    });

    it('should fail with Insufficient funds error', async () => {
      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // Debit (returns negative balance)
      mockClient.query.mockResolvedValueOnce({ rows: [{ balance: -10 }] });
      // ROLLBACK
      mockClient.query.mockResolvedValueOnce({});

      let error: any;
      try {
        await transferFundsExample(mockPool, 'acc-1', 'acc-2', 50);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TransactionError);
      expect(error.message).toMatch(/Insufficient funds/);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('processPaymentExample', () => {
    it('should process payment successfully', async () => {
      const order = { id: 'order-1', status: 'pending', total: 100 };
      
      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // SELECT FOR UPDATE
      mockClient.query.mockResolvedValueOnce({ rows: [order] });
      // UPDATE
      mockClient.query.mockResolvedValueOnce({});
      // INSERT payment
      mockClient.query.mockResolvedValueOnce({});
      // COMMIT
      mockClient.query.mockResolvedValueOnce({});

      const result = await processPaymentExample(mockPool, 'order-1', 100);

      expect(result).toEqual({ success: true, orderId: 'order-1' });
    });

    it('should fail when order is not pending', async () => {
      const order = { id: 'order-1', status: 'completed', total: 100 };
      
      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // SELECT FOR UPDATE
      mockClient.query.mockResolvedValueOnce({ rows: [order] });
      // ROLLBACK
      mockClient.query.mockResolvedValueOnce({});

      let error: any;
      try {
        await processPaymentExample(mockPool, 'order-1', 100);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TransactionError);
      expect(error.message).toMatch(/Order is not in pending status/);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should fail when payment amount mismatches', async () => {
      const order = { id: 'order-1', status: 'pending', total: 100 };
      
      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // SELECT FOR UPDATE
      mockClient.query.mockResolvedValueOnce({ rows: [order] });
      // ROLLBACK
      mockClient.query.mockResolvedValueOnce({});

      let error: any;
      try {
        await processPaymentExample(mockPool, 'order-1', 50);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(TransactionError);
      expect(error.message).toMatch(/Payment amount mismatch/);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });
});
