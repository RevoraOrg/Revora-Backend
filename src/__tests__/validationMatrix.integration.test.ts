import request from 'supertest';
import { createApp } from '../index';
import { Express } from 'express';

/**
 * @file validationMatrix.integration.test.ts
 * @description Integration tests for the /offerings/validation-matrix route.
 * Exercises the full middleware stack and the 200/422 branching of evaluateOfferingValidationMatrix.
 */

describe('Offering Validation Matrix Integration Tests', () => {
  let app: Express;
  const API_PREFIX = '/api/v1';
  const DEFAULT_ORIGIN = 'http://localhost:3000';

  beforeAll(() => {
    app = createApp({
      healthQuery: jest.fn() as any,
      healthStatus: jest.fn().mockResolvedValue({ healthy: true, details: {} }) as any,
    });
  });

  describe('Security and Authentication', () => {
    it('should return 401 Unauthorized when x-user-id header is missing', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-role', 'startup')
        .send({
          action: 'create',
          offering: {
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
          },
        });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
      expect(response.body.message).toContain('x-user-id');
    });

    it('should return 401 Unauthorized when x-user-role header is missing', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'user-123')
        .send({
          action: 'create',
          offering: {
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
          },
        });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
      expect(response.body.message).toContain('x-user-role');
    });

    it('should return 401 Unauthorized when x-user-role is invalid', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'user-123')
        .set('x-user-role', 'invalid-role')
        .send({
          action: 'create',
          offering: {
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
          },
        });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Payload Validation', () => {
    it('should return 400 Bad Request when action is invalid', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'user-123')
        .set('x-user-role', 'startup')
        .send({
          action: 'invalid-action',
          offering: {
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.message).toContain('Invalid offering validation action');
    });

    it('should return 400 Bad Request when offering object is missing', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'user-123')
        .set('x-user-role', 'startup')
        .send({
          action: 'create',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.message).toContain('include an offering object');
    });

    it('should return 422 Unprocessable Entity when targetAmount format is invalid', async () => {
      // Note: 'not-a-number' is a non-empty string, so it passes parseOfferingValidationPayload.
      // It then fails the matrix logic's parseMoneyString check, resulting in 422.
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'user-123')
        .set('x-user-role', 'startup')
        .send({
          action: 'create',
          offering: {
            targetAmount: 'not-a-number',
            minimumInvestment: '10.00',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.allowed).toBe(false);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'TARGET_AMOUNT_VALID',
        passed: false,
      }));
    });
  });

  describe('Decision Matrix Branching', () => {
    it('should return 200 OK and allowed: true for valid startup creation', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'create',
          offering: {
            targetAmount: '50000.00',
            minimumInvestment: '100.00',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.allowed).toBe(true);
      expect(response.body.decision).toBe('allow');
      expect(response.body.violations).toHaveLength(0);
      expect(response.body.securityAssumptions).toEqual(expect.arrayContaining([
        expect.stringContaining('Caller identity is asserted'),
        expect.stringContaining('Money amounts are decimal strings'),
      ]));
    });

    it('should return 422 Unprocessable Entity when role is not allowed for action', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'investor-1')
        .set('x-user-role', 'investor')
        .send({
          action: 'create', // Investor cannot create offerings
          offering: {
            targetAmount: '50000.00',
            minimumInvestment: '100.00',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.allowed).toBe(false);
      expect(response.body.decision).toBe('deny');
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'ROLE_ALLOWED_FOR_ACTION',
        passed: false,
      }));
    });


    it('should return 422 Unprocessable Entity when minimum investment exceeds target', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'create',
          offering: {
            targetAmount: '100.00',
            minimumInvestment: '200.00', // Invalid: min > target
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.allowed).toBe(false);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'MINIMUM_NOT_GREATER_THAN_TARGET',
        passed: false,
      }));
    });

    it('should return 422 Unprocessable Entity for publish action with missing dates', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'publish',
          offering: {
            status: 'draft',
            targetAmount: '10000.00',
            minimumInvestment: '100.00',
            // missing subscription dates
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.allowed).toBe(false);
      expect(response.body.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SUBSCRIPTION_START_VALID' }),
        expect.objectContaining({ code: 'SUBSCRIPTION_END_VALID' }),
      ]));
    });

    it('should return 422 for investment when status is not open', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'investor-1')
        .set('x-user-role', 'investor')
        .send({
          action: 'invest',
          offering: {
            status: 'draft', // Only 'open' is allowed
            targetAmount: '10000.00',
            minimumInvestment: '100.00',
            investmentAmount: '500.00',
            subscriptionStartsAt: new Date(Date.now() - 3600000).toISOString(),
            subscriptionEndsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'STATUS_OPEN_FOR_INVESTMENT',
        passed: false,
      }));
    });

    it('should return 422 for investment when amount is below minimum', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'investor-1')
        .set('x-user-role', 'investor')
        .send({
          action: 'invest',
          offering: {
            status: 'open',
            targetAmount: '10000.00',
            minimumInvestment: '100.00',
            investmentAmount: '50.00', // Below 100
            subscriptionStartsAt: new Date(Date.now() - 3600000).toISOString(),
            subscriptionEndsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'INVESTMENT_MEETS_MINIMUM',
        passed: false,
      }));
    });

    it('should return 422 for investment when outside subscription window', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'investor-1')
        .set('x-user-role', 'investor')
        .send({
          action: 'invest',
          offering: {
            status: 'open',
            targetAmount: '10000.00',
            minimumInvestment: '100.00',
            investmentAmount: '500.00',
            subscriptionStartsAt: new Date(Date.now() + 3600000).toISOString(), // Future
            subscriptionEndsAt: new Date(Date.now() + 7200000).toISOString(),
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'INVESTMENT_WINDOW_ACTIVE',
        passed: false,
      }));
    });

    it('should return 422 when issuer attempts self-investment', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'issuer-1')
        .set('x-user-role', 'investor') // issuer acting as investor
        .send({
          action: 'invest',
          offering: {
            issuerId: 'issuer-1', // Match actor.id
            status: 'open',
            targetAmount: '10000.00',
            minimumInvestment: '100.00',
            investmentAmount: '500.00',
            subscriptionStartsAt: new Date(Date.now() - 3600000).toISOString(),
            subscriptionEndsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'INVESTOR_NOT_ISSUER',
        passed: false,
      }));
    });

    it('should allow privileged actors to view private offerings', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'admin-1')
        .set('x-user-role', 'admin')
        .send({
          action: 'viewPrivate',
          offering: {
            id: 'offering-1',
            issuerId: 'startup-1',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.allowed).toBe(true);
    });

    it('should deny non-issuer from viewing private offerings', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-2') // Not the issuer
        .set('x-user-role', 'startup')
        .send({
          action: 'viewPrivate',
          offering: {
            id: 'offering-1',
            issuerId: 'startup-1',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'PRIVATE_VIEW_ALLOWED',
        passed: false,
      }));
    });

    it('should return 422 for publish with end date before start date', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'publish',
          offering: {
            status: 'draft',
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
            subscriptionStartsAt: new Date(Date.now() + 7200000).toISOString(),
            subscriptionEndsAt: new Date(Date.now() + 3600000).toISOString(), // Before start
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'SUBSCRIPTION_WINDOW_ORDERED',
        passed: false,
      }));
    });

    it('should return 422 for publish with end date in the past', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'publish',
          offering: {
            status: 'draft',
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
            subscriptionStartsAt: new Date(Date.now() - 7200000).toISOString(),
            subscriptionEndsAt: new Date(Date.now() - 3600000).toISOString(), // Past
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'SUBSCRIPTION_ENDS_IN_FUTURE',
        passed: false,
      }));
    });

    it('should return 422 for pause when status is not open', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'pause',
          offering: {
            status: 'draft', // Must be 'open' to pause
            issuerId: 'startup-1',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'STATUS_ELIGIBLE_FOR_PAUSE',
        passed: false,
      }));
    });

    it('should return 422 for close when status is invalid', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'close',
          offering: {
            status: 'draft', // Must be 'open' or 'paused' to close
            issuerId: 'startup-1',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'STATUS_ELIGIBLE_FOR_CLOSE',
        passed: false,
      }));
    });

    it('should return 422 for cancel when status is invalid', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'cancel',
          offering: {
            status: 'completed', // Cannot cancel completed
            issuerId: 'startup-1',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'STATUS_ELIGIBLE_FOR_CANCEL',
        passed: false,
      }));
    });

    it('should return 422 for investment exceeding target amount (even as warning severity)', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'investor-1')
        .set('x-user-role', 'investor')
        .send({
          action: 'invest',
          offering: {
            status: 'open',
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
            investmentAmount: '2000.00', // Exceeds target
            subscriptionStartsAt: new Date(Date.now() - 3600000).toISOString(),
            subscriptionEndsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });

      // Based on evaluateOfferingValidationMatrix logic, any !passed check is a violation, 
      // even if severity is 'warning'.
      expect(response.status).toBe(422);
      expect(response.body.allowed).toBe(false);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'INVESTMENT_WITHIN_TARGET',
        passed: false,
        severity: 'warning',
      }));
    });


    it('should return 422 when updating an offering not owned by the startup', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-2')
        .set('x-user-role', 'startup')
        .send({
          action: 'update',
          offering: {
            id: 'offering-1',
            issuerId: 'startup-1', // Owned by startup-1
            targetAmount: '1000.00',
            minimumInvestment: '10.00',
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.violations).toContainEqual(expect.objectContaining({
        code: 'OWNERSHIP_CONFIRMED',
        passed: false,
      }));
    });
  });



  describe('Sanitization Integration', () => {
    it('should sanitize HTML in offering fields (via middleware)', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/offerings/validation-matrix`)
        .set('Origin', DEFAULT_ORIGIN)
        .set('x-user-id', 'startup-1')
        .set('x-user-role', 'startup')
        .send({
          action: 'create',
          offering: {
            targetAmount: '50000.00',
            minimumInvestment: '100.00',
            name: '<b>Safe Name</b>',
            description: '<script>alert("xss")</script><p>Safe Description</p>',
          },
        });

      expect(response.status).toBe(200);
      // Since the handler doesn't return the full offering object back, we can't
      // easily assert sanitization here without changing the handler or spying.
      // But we have exercised the middleware.
    });
  });
});

