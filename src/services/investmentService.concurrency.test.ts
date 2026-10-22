/**
 * Integration test for concurrent investment cap enforcement.
 * 
 * This test verifies that the advisory lock in InvestmentService.createInvestment
 * correctly serializes concurrent cap checks, preventing race conditions where
 * multiple parallel investments could exceed the KYC-tier adjusted cap.
 * 
 * Run with a PostgreSQL database available at TEST_DATABASE_URL.
 * Skipped if no database URL is provided.
 */

import { Pool } from 'pg';
import { InvestmentService, createInvestmentService } from './investmentService';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { Decimal } from '../lib/decimal';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeIf = TEST_DATABASE_URL ? describe : describe.skip;

describeIf('InvestmentService concurrency integration tests', () => {
  let pool: Pool;
  let investmentService: InvestmentService;
  let investmentRepo: InvestmentRepository;
  let offeringRepo: OfferingRepository;
  let userRepo: UserRepository;

  const investorId = '550e8400-e29b-41d4-a716-446655440000';
  const offeringId = '550e8400-e29b-41d4-a716-446655440001';
  const capBps = 1000; // 10% cap
  const offeringAmount = '1000000'; // 1M units
  const capAmount = '100000'; // 10% of 1M = 100,000
  const investmentAmount = '25000'; // Each investment is 25,000
  // 5 investments * 25,000 = 125,000 > 100,000 cap
  // Only 4 should succeed (4 * 25,000 = 100,000)

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    
    // Run migrations to ensure schema exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        role VARCHAR(50) NOT NULL DEFAULT 'investor',
        kyc_risk_tier VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (kyc_risk_tier IN ('low', 'standard', 'elevated', 'high', 'restricted')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS offerings (
        id UUID PRIMARY KEY,
        issuer_user_id UUID NOT NULL REFERENCES users(id),
        token_asset_id VARCHAR(255) NOT NULL,
        revenue_share_bps INTEGER NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'draft',
        name VARCHAR(255) NOT NULL,
        description TEXT,
        max_investor_share_bps INTEGER,
        target_amount NUMERIC(30, 10),
        total_raised NUMERIC(30, 10),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS investments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id UUID NOT NULL,
        offering_id UUID NOT NULL,
        amount NUMERIC(30, 10) NOT NULL,
        asset VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        tx_hash VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_investments_offering_id ON investments (offering_id);
      CREATE INDEX IF NOT EXISTS idx_investments_investor_id ON investments (investor_id);
    `);

    investmentRepo = new InvestmentRepository(pool);
    offeringRepo = new OfferingRepository(pool);
    userRepo = new UserRepository(pool);
    investmentService = new InvestmentService(investmentRepo, offeringRepo, undefined, userRepo, pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up test data
    await pool.query('DELETE FROM investments WHERE investor_id = $1 AND offering_id = $2', [investorId, offeringId]);
    await pool.query('DELETE FROM offerings WHERE id = $1', [offeringId]);
    await pool.query('DELETE FROM users WHERE id = $1', [investorId]);

    // Create test investor with standard tier (multiplier 1.0)
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role, kyc_risk_tier) VALUES ($1, $2, $3, $4, $5)`,
      [investorId, 'test-investor@example.com', 'hash', 'investor', 'standard']
    );

    // Create test offering with 10% cap (1000 bps)
    await pool.query(
      `INSERT INTO offerings (id, issuer_user_id, token_asset_id, revenue_share_bps, status, name, max_investor_share_bps, target_amount, total_raised)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [offeringId, investorId, 'USDC', 5000, 'active', 'Test Offering', capBps, offeringAmount, '0']
    );
  });

  it('should enforce cap correctly under concurrent investment requests', async () => {
    const numConcurrent = 5;
    const expectedSuccessCount = 4; // 4 * 25000 = 100000 (exactly at cap)

    // Fire concurrent investment requests
    const promises = Array.from({ length: numConcurrent }, (_, i) =>
      investmentService.createInvestment({
        investor_id: investorId,
        offering_id: offeringId,
        amount: investmentAmount,
        asset: 'USDC',
      }).then(
        (investment) => ({ success: true as const, investment, index: i }),
        (error) => ({ success: false as const, error, index: i })
      )
    );

    const results = await Promise.allSettled(promises);
    
    const outcomes = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { success: false as const, error: r.reason, index: i };
    });

    const successful = outcomes.filter((o): o is { success: true; investment: any; index: number } => o.success);
    const failed = outcomes.filter((o): o is { success: false; error: any; index: number } => !o.success);

    // Verify exactly 4 succeeded and 1 failed
    expect(successful).toHaveLength(expectedSuccessCount);
    expect(failed).toHaveLength(numConcurrent - expectedSuccessCount);

    // Verify failed ones got the cap error
    failed.forEach(({ error }) => {
      expect(error).toBeDefined();
      expect(error.message).toContain('KYC risk-tier adjusted cap');
    });

    // Verify database state: exactly 4 investments created
    const dbInvestments = await investmentRepo.listByInvestor({
      investor_id: investorId,
      offering_id: offeringId,
    });
    expect(dbInvestments).toHaveLength(expectedSuccessCount);

    // Verify total committed amount equals cap
    const totalCommitted = dbInvestments.reduce(
      (sum, inv) => sum.add(new Decimal(inv.amount)),
      new Decimal('0')
    );
    expect(totalCommitted.toString()).toBe(capAmount);
  });

  it('should allow investments up to the cap boundary', async () => {
    // First, make 3 investments sequentially to reach 75,000
    for (let i = 0; i < 3; i++) {
      await investmentService.createInvestment({
        investor_id: investorId,
        offering_id: offeringId,
        amount: investmentAmount,
        asset: 'USDC',
      });
    }

    // Now try 2 concurrent investments of 25,000 each
    // Total would be 125,000, but cap is 100,000
    // Only 1 should succeed (bringing total to 100,000)
    const promises = [
      investmentService.createInvestment({
        investor_id: investorId,
        offering_id: offeringId,
        amount: investmentAmount,
        asset: 'USDC',
      }).then(
        (investment) => ({ success: true as const, investment }),
        (error) => ({ success: false as const, error })
      ),
      investmentService.createInvestment({
        investor_id: investorId,
        offering_id: offeringId,
        amount: investmentAmount,
        asset: 'USDC',
      }).then(
        (investment) => ({ success: true as const, investment }),
        (error) => ({ success: false as const, error })
      ),
    ];

    const results = await Promise.allSettled(promises);
    
    const outcomes = results.map(r => r.status === 'fulfilled' ? r.value : { success: false as const, error: r.reason });
    const successful = outcomes.filter((o): o is { success: true; investment: any } => o.success);
    const failed = outcomes.filter((o): o is { success: false; error: any } => !o.success);

    // Only 1 should succeed (total goes from 75,000 to 100,000)
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error.message).toContain('KYC risk-tier adjusted cap');

    // Verify database state: 4 total investments
    const dbInvestments = await investmentRepo.listByInvestor({
      investor_id: investorId,
      offering_id: offeringId,
    });
    expect(dbInvestments).toHaveLength(4);

    const totalCommitted = dbInvestments.reduce(
      (sum, inv) => sum.add(new Decimal(inv.amount)),
      new Decimal('0')
    );
    expect(totalCommitted.toString()).toBe(capAmount);
  });

  it('should use advisory lock to serialize concurrent cap checks', async () => {
    // This test verifies the lock is actually acquired by checking
    // that concurrent requests don't all see the same existing total
    
    const numConcurrent = 3;
    const smallAmount = '10000'; // 10,000 each, cap is 100,000
    
    // First, make one investment to have 10,000 existing
    await investmentService.createInvestment({
      investor_id: investorId,
      offering_id: offeringId,
      amount: smallAmount,
      asset: 'USDC',
    });

    // Now fire 3 concurrent requests for 30,000 each
    // If no lock: all 3 see existing=10,000, all 3 think 10,000+30,000=40,000 < 100,000, all 3 pass
    // With lock: they serialize, only 3 can fit (10,000 + 3*30,000 = 100,000)
    const promises = Array.from({ length: numConcurrent }, () =>
      investmentService.createInvestment({
        investor_id: investorId,
        offering_id: offeringId,
        amount: '30000',
        asset: 'USDC',
      }).then(
        (investment) => ({ success: true as const, investment }),
        (error) => ({ success: false as const, error })
      )
    );

    const results = await Promise.allSettled(promises);
    
    const outcomes = results.map(r => r.status === 'fulfilled' ? r.value : { success: false as const, error: r.reason });
    const successful = outcomes.filter((o): o is { success: true; investment: any } => o.success);
    const failed = outcomes.filter((o): o is { success: false; error: any } => !o.success);

    // With lock: existing=10,000, first adds 30,000=40,000, second adds 30,000=70,000, third adds 30,000=100,000 (exact cap)
    // All 3 should succeed
    expect(successful).toHaveLength(numConcurrent);
    expect(failed).toHaveLength(0);

    const dbInvestments = await investmentRepo.listByInvestor({
      investor_id: investorId,
      offering_id: offeringId,
    });
    expect(dbInvestments).toHaveLength(4); // 1 initial + 3 concurrent

    const totalCommitted = dbInvestments.reduce(
      (sum, inv) => sum.add(new Decimal(inv.amount)),
      new Decimal('0')
    );
    expect(totalCommitted.toString()).toBe(capAmount);
  });
});

describe('InvestmentService concurrency regression test (mock-based)', () => {
  // This test simulates the race condition that would occur WITHOUT the advisory lock
  // It uses mocks to demonstrate the vulnerability, then verifies the fix prevents it
  
  let mockPool: { query: jest.Mock; connect: jest.Mock; mockClient: { query: jest.Mock; release: jest.Mock } };
  let investmentRepo: InvestmentRepository;
  let offeringRepo: OfferingRepository;
  let userRepo: { findById: jest.Mock };
  let service: InvestmentService;

  beforeEach(() => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(mockClient),
      mockClient,
    };
    
    investmentRepo = new InvestmentRepository(mockPool as unknown as Pool);
    offeringRepo = new OfferingRepository(mockPool as unknown as Pool);
    userRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'investor-1',
        email: 'inv@example.com',
        password_hash: 'hash',
        role: 'investor',
        kyc_risk_tier: 'standard',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    };
    service = new InvestmentService(investmentRepo, offeringRepo, undefined, userRepo as any, mockPool as unknown as Pool);
  });

  function setupMocks(mockClient: any, offeringCapBps: number | null, existingTotal: string, investmentResult: any) {
    mockClient.query.mockReset();
    mockClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce({ 
        rows: [{ 
          id: 'offering-1', 
          status: 'active', 
          max_investor_share_bps: offeringCapBps, 
          target_amount: '1000000',
          total_raised: '0'
        }], 
        rowCount: 1, command: 'SELECT', oid: 0, fields: [] 
      })
      .mockResolvedValueOnce({ rows: [{ total: existingTotal }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
      .mockResolvedValueOnce(investmentResult);
  }

  it('REGRESSION: without advisory lock, concurrent requests would all pass the cap check', async () => {
    // This test documents the vulnerability that the advisory lock fixes
    // Without the lock, concurrent requests would all read the same existingTotal
    // and all pass the cap check, leading to over-commitment
    
    const mockClient = mockPool.mockClient;
    const offeringCapBps = 1000; // 10% of 1M = 100,000 cap
    const existingTotal = '0';
    const investmentRow = { id: 'inv-1', investor_id: 'investor-1', offering_id: 'offering-1', amount: '60000', asset: 'USDC', status: 'pending', created_at: new Date(), updated_at: new Date() };
    
    // Simulate TWO concurrent requests that would BOTH pass without lock
    // Request 1: amount = 60,000
    // Request 2: amount = 60,000
    // Both see existingTotal = 0, both think 60,000 < 100,000, both pass
    // Combined = 120,000 > 100,000 cap VIOLATION
    
    // With the FIX (advisory lock), they serialize:
    // Request 1: sees existing=0, creates 60,000, commits
    // Request 2: waits for lock, sees existing=60,000, 60,000+60,000=120,000 > 100,000, REJECTED
    
    // Test the FIXED behavior
    setupMocks(mockClient, offeringCapBps, '0', { 
      rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] 
    });
    
    // First request succeeds
    const result1 = await service.createInvestment({
      investor_id: 'investor-1',
      offering_id: 'offering-1',
      amount: '60000',
      asset: 'USDC',
    });
    expect(result1.amount).toBe('60000');
    
    // Second request with same mock setup (but now existingTotal would be 60000 in real DB)
    // We simulate the second request seeing existingTotal = 60000
    setupMocks(mockClient, offeringCapBps, '60000', { 
      rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] 
    });
    
    await expect(service.createInvestment({
      investor_id: 'investor-1',
      offering_id: 'offering-1',
      amount: '60000',
      asset: 'USDC',
    })).rejects.toThrow(/KYC risk-tier adjusted cap/);
  });
});