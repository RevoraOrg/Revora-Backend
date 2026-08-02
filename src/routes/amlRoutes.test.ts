/**
 * AML Routes Tests
 * 
 * Comprehensive test coverage for AML API endpoints including
 * rule management, case workflow, and alert operations.
 */

import request from 'supertest';
import express, { Express } from 'express';
import { createAMLRoutes } from './amlRoutes';
import { AMLService } from '../aml/amlService';
import { AMLRule, AMLCase, AMLAlert, OFACReview, SemVer } from '../aml/types';

// Mock AMLService
class MockAMLService {
  private rules: AMLRule[] = [];
  private cases: AMLCase[] = [];
  private alerts: AMLAlert[] = [];
  private ofacReviews: OFACReview[] = [];

  async getRules(): Promise<AMLRule[]> {
    return this.rules;
  }

  async getEnabledRules(): Promise<AMLRule[]> {
    return this.rules.filter(r => r.enabled);
  }

  async getRuleHistory(ruleId: string): Promise<any[]> {
    return [
      {
        id: 'history_1',
        rule_id: ruleId,
        version: { major: 1, minor: 0, patch: 0 },
        config: {},
        enabled: true,
        changed_by: 'user_123',
        change_reason: 'Initial',
        created_at: new Date(),
      }
    ];
  }

  async createRule(input: any): Promise<AMLRule> {
    const rule: AMLRule = {
      id: `rule_${Date.now()}`,
      ...input,
      version: { major: 1, minor: 0, patch: 0 },
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.rules.push(rule);
    return rule;
  }

  async updateRule(ruleId: string, input: any): Promise<AMLRule> {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      // Return a mock rule for testing
      return {
        id: ruleId,
        name: input.name || 'Updated Rule',
        description: input.description || 'Updated description',
        type: 'velocity',
        version: { major: 1, minor: 1, patch: 0 },
        severity: 'high',
        enabled: input.enabled !== undefined ? input.enabled : true,
        config: input.config || {},
        created_at: new Date(),
        updated_at: new Date(),
      };
    }
    
    this.rules[index] = {
      ...this.rules[index],
      ...input,
      version: { major: 1, minor: 1, patch: 0 },
      updated_at: new Date(),
    };
    return this.rules[index];
  }

  async rollbackRule(ruleId: string, version: SemVer): Promise<AMLRule> {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      // Return a mock rule for testing
      return {
        id: ruleId,
        name: 'Test Rule',
        description: 'Test description',
        type: 'velocity',
        version: { major: version.major, minor: version.minor, patch: version.patch + 1 },
        severity: 'high',
        enabled: true,
        config: {},
        created_at: new Date(),
        updated_at: new Date(),
      };
    }
    
    this.rules[index] = {
      ...this.rules[index],
      version: { major: version.major, minor: version.minor, patch: version.patch + 1 },
      updated_at: new Date(),
    };
    return this.rules[index];
  }

  async getCasesByStatus(status: string): Promise<AMLCase[]> {
    return this.cases.filter(c => c.status === status);
  }

  async getCasesByAnalyst(analystId: string): Promise<AMLCase[]> {
    return this.cases.filter(c => c.assigned_to === analystId);
  }

  async getCase(caseId: string): Promise<AMLCase | null> {
    const found = this.cases.find(c => c.id === caseId);
    if (found) return found;
    
    // Return a mock case for testing (not null)
    return {
      id: caseId,
      alert_ids: ['alert_1'],
      investor_id: 'inv_1',
      status: 'open',
      assigned_to: 'analyst_1',
      disposition: undefined,
      notes: undefined,
      created_at: new Date(),
      updated_at: new Date(),
      closed_at: undefined,
    };
  }

  async getCaseAlerts(caseId: string): Promise<AMLAlert[]> {
    return this.alerts.filter(a => a.case_id === caseId);
  }

  async createCase(input: any): Promise<AMLCase> {
    const amlCase: AMLCase = {
      id: `case_${Date.now()}`,
      ...input,
      status: input.assigned_to ? 'assigned' : 'open',
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.cases.push(amlCase);
    return amlCase;
  }

  async updateCase(caseId: string, input: any): Promise<AMLCase> {
    const index = this.cases.findIndex(c => c.id === caseId);
    if (index === -1) {
      // Return a mock case for testing
      return {
        id: caseId,
        alert_ids: ['alert_1'],
        investor_id: 'inv_1',
        status: input.status || 'closed',
        assigned_to: input.assigned_to || 'analyst_1',
        disposition: input.disposition || 'false_positive',
        notes: input.notes || 'Investigated',
        created_at: new Date(),
        updated_at: new Date(),
        closed_at: (input.status === 'closed' || input.status === 'dismissed') ? new Date() : undefined,
      };
    }
    
    this.cases[index] = {
      ...this.cases[index],
      ...input,
      updated_at: new Date(),
      closed_at: (input.status === 'closed' || input.status === 'dismissed') ? new Date() : undefined,
    };
    return this.cases[index];
  }

  async getPendingAlerts(): Promise<AMLAlert[]> {
    return this.alerts.filter(a => a.status === 'pending');
  }

  async getInvestorAlerts(investorId: string): Promise<AMLAlert[]> {
    return this.alerts.filter(a => a.investor_id === investorId);
  }

  async dismissAlert(alertId: string): Promise<AMLAlert> {
    const index = this.alerts.findIndex(a => a.id === alertId);
    if (index === -1) {
      // Return a mock alert for testing
      return {
        id: alertId,
        investment_id: 'inv_1',
        investor_id: 'inv_1',
        rule_id: 'rule_1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'dismissed',
        case_id: undefined,
        created_at: new Date(),
        updated_at: new Date(),
      };
    }
    
    this.alerts[index] = {
      ...this.alerts[index],
      status: 'dismissed',
    };
    return this.alerts[index];
  }

  async getOFACReviewQueue(): Promise<OFACReview[]> {
    return this.ofacReviews.filter(review =>
      review.status === 'pending_first_approval' || review.status === 'pending_second_approval'
    );
  }

  async createOFACReview(input: any, creatorId: string): Promise<OFACReview> {
    const review: OFACReview = {
      id: `ofac_${Date.now()}`,
      ...input,
      status: 'pending_first_approval',
      created_by: creatorId,
      created_at: new Date(),
      clearance_rationale: input.rationale,
      expires_at: input.expires_at || new Date(Date.now() + 86400000),
      updated_at: new Date(),
    };
    this.ofacReviews.push(review);
    return review;
  }

  async approveOFACReview(reviewId: string, approverId: string, rationale: string): Promise<OFACReview> {
    const review = this.ofacReviews.find(item => item.id === reviewId);
    if (!review) {
      throw new Error('OFAC review not found');
    }
    if (review.status === 'cleared') {
      throw new Error(`OFAC review ${reviewId} is already cleared`);
    }
    if (review.created_by === approverId) {
      throw new Error('Review creator cannot approve their own OFAC clearance');
    }
    if (review.first_approver_id === approverId) {
      throw new Error('Same compliance officer cannot approve an OFAC review twice');
    }
    if (review.status === 'pending_first_approval') {
      review.status = 'pending_second_approval';
      review.first_approver_id = approverId;
      review.first_approval_rationale = rationale;
      review.first_approved_at = new Date();
      return review;
    }

    review.status = 'cleared';
    review.second_approver_id = approverId;
    review.second_approval_rationale = rationale;
    review.second_approved_at = new Date();
    review.cleared_at = new Date();
    review.clearance_rationale = [
      review.clearance_rationale,
      `first approver ${review.first_approver_id}: ${review.first_approval_rationale}`,
      `second approver ${approverId}: ${rationale}`,
    ].filter(Boolean).join('\n');
    return review;
  }
}

describe('AML Routes', () => {
  let app: Express;
  let mockService: MockAMLService;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mockService = new MockAMLService();
    app.use('/aml', createAMLRoutes(mockService as any));
  });

  describe('GET /aml/rules', () => {
    it('should return all rules', async () => {
      const response = await request(app).get('/aml/rules');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(mockService, 'getRules').mockRejectedValueOnce(new Error('DB error'));

      const response = await request(app).get('/aml/rules');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('GET /aml/rules/enabled', () => {
    it('should return enabled rules', async () => {
      const response = await request(app).get('/aml/rules/enabled');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /aml/rules/:ruleId/history', () => {
    it('should return rule version history', async () => {
      const response = await request(app).get('/aml/rules/rule_1/history');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('POST /aml/rules', () => {
    it('should create a new rule', async () => {
      const newRule = {
        name: 'Test Rule',
        description: 'Test description',
        type: 'velocity',
        severity: 'high',
        config: { window_minutes: 60 },
      };

      const response = await request(app)
        .post('/aml/rules')
        .send(newRule);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe(newRule.name);
    });

    it('should validate input', async () => {
      const invalidRule = {
        name: '',
        description: 'Test',
        type: 'invalid_type',
        severity: 'high',
        config: {},
      };

      const response = await request(app)
        .post('/aml/rules')
        .send(invalidRule);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('PUT /aml/rules/:ruleId', () => {
    it('should update a rule', async () => {
      const update = {
        name: 'Updated Rule',
        enabled: false,
        change_reason: 'Testing',
      };

      const response = await request(app)
        .put('/aml/rules/rule_1')
        .send(update);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should validate input', async () => {
      const invalidUpdate = {
        change_reason: '', // Required field
      };

      const response = await request(app)
        .put('/aml/rules/rule_1')
        .send(invalidUpdate);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /aml/rules/:ruleId/rollback', () => {
    it('should rollback rule to version', async () => {
      const rollback = {
        version: { major: 1, minor: 0, patch: 0 },
      };

      const response = await request(app)
        .post('/aml/rules/rule_1/rollback')
        .send(rollback);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should validate version format', async () => {
      const invalidRollback = {
        version: { major: -1, minor: 0, patch: 0 },
      };

      const response = await request(app)
        .post('/aml/rules/rule_1/rollback')
        .send(invalidRollback);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /aml/cases', () => {
    it('should get cases by status', async () => {
      const response = await request(app).get('/aml/cases?status=open');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should get cases by analyst', async () => {
      const response = await request(app).get('/aml/cases?analyst_id=analyst_1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should require query parameter', async () => {
      const response = await request(app).get('/aml/cases');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /aml/cases/:caseId', () => {
    it('should get a specific case', async () => {
      const response = await request(app).get('/aml/cases/case_1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 for nonexistent case', async () => {
      jest.spyOn(mockService, 'getCase').mockResolvedValueOnce(null);

      const response = await request(app).get('/aml/cases/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /aml/cases/:caseId/alerts', () => {
    it('should get alerts for a case', async () => {
      const response = await request(app).get('/aml/cases/case_1/alerts');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('POST /aml/cases', () => {
    it('should create a new case', async () => {
      const newCase = {
        alert_ids: ['alert_1'],
        investor_id: 'inv_1',
        assigned_to: 'analyst_1',
        notes: 'Test case',
      };

      const response = await request(app)
        .post('/aml/cases')
        .send(newCase);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.investor_id).toBe(newCase.investor_id);
    });

    it('should validate input', async () => {
      const invalidCase = {
        alert_ids: [],
        investor_id: 'inv_1',
      };

      const response = await request(app)
        .post('/aml/cases')
        .send(invalidCase);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('PUT /aml/cases/:caseId', () => {
    it('should update a case', async () => {
      const update = {
        status: 'closed',
        disposition: 'false_positive',
        notes: 'Investigated',
      };

      const response = await request(app)
        .put('/aml/cases/case_1')
        .send(update);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should validate status enum', async () => {
      const invalidUpdate = {
        status: 'invalid_status',
      };

      const response = await request(app)
        .put('/aml/cases/case_1')
        .send(invalidUpdate);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /aml/alerts/pending', () => {
    it('should get pending alerts', async () => {
      const response = await request(app).get('/aml/alerts/pending');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /aml/alerts/investor/:investorId', () => {
    it('should get alerts for investor', async () => {
      const response = await request(app).get('/aml/alerts/investor/inv_1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('POST /aml/alerts/:alertId/dismiss', () => {
    it('should dismiss an alert', async () => {
      const response = await request(app).post('/aml/alerts/alert_1/dismiss');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('dismissed');
    });
  });

  // ── Case Assignment Service Endpoints ──────────────────────────────────────

  describe('POST /aml/cases/assign-auto', () => {
    let assignmentApp: Express;
    let mockAssignmentService: any;

    beforeEach(() => {
      mockAssignmentService = {
        assignCase: jest.fn(),
        assignAllOpenCases: jest.fn(),
        getReviewerCapacities: jest.fn(),
      };

      assignmentApp = express();
      assignmentApp.use(express.json());
      assignmentApp.use(
        '/aml',
        createAMLRoutes(mockService as any, mockAssignmentService as any),
      );
    });

    it('should auto-assign a case successfully', async () => {
      mockAssignmentService.assignCase.mockResolvedValue({
        case_id: 'c1',
        assigned_to: 'r1',
        age_days: 3,
        reviewer_capacities: [],
      });

      const response = await request(assignmentApp)
        .post('/aml/cases/assign-auto')
        .send({ case_id: 'c1' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.assigned_to).toBe('r1');
    });

    it('should return 400 when case_id is missing', async () => {
      const response = await request(assignmentApp)
        .post('/aml/cases/assign-auto')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 409 when no reviewer is eligible', async () => {
      mockAssignmentService.assignCase.mockRejectedValue({
        statusCode: 409,
        message: 'No eligible reviewer available',
      });

      const response = await request(assignmentApp)
        .post('/aml/cases/assign-auto')
        .send({ case_id: 'c1' });

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
    });

    it('should return 503 when assignment service is not available', async () => {
      const noServiceApp = express();
      noServiceApp.use(express.json());
      noServiceApp.use('/aml', createAMLRoutes(mockService as any));

      const response = await request(noServiceApp)
        .post('/aml/cases/assign-auto')
        .send({ case_id: 'c1' });

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('not available');
    });

    it('should handle generic errors', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockAssignmentService.assignCase.mockRejectedValue(new Error('DB connection lost'));

      const response = await request(assignmentApp)
        .post('/aml/cases/assign-auto')
        .send({ case_id: 'c1' });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('POST /aml/cases/assign-all', () => {
    let assignmentApp: Express;
    let mockAssignmentService: any;

    beforeEach(() => {
      mockAssignmentService = {
        assignCase: jest.fn(),
        assignAllOpenCases: jest.fn(),
        getReviewerCapacities: jest.fn(),
      };

      assignmentApp = express();
      assignmentApp.use(express.json());
      assignmentApp.use(
        '/aml',
        createAMLRoutes(mockService as any, mockAssignmentService as any),
      );
    });

    it('should batch-assign all open cases', async () => {
      mockAssignmentService.assignAllOpenCases.mockResolvedValue([
        { case_id: 'c1', assigned_to: 'r1', age_days: 5, reviewer_capacities: [] },
        { case_id: 'c2', assigned_to: 'r2', age_days: 2, reviewer_capacities: [] },
      ]);

      const response = await request(assignmentApp).post('/aml/cases/assign-all');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.assigned_count).toBe(2);
    });

    it('should return empty array when no cases to assign', async () => {
      mockAssignmentService.assignAllOpenCases.mockResolvedValue([]);

      const response = await request(assignmentApp).post('/aml/cases/assign-all');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    });

    it('should return 503 when assignment service is not available', async () => {
      const noServiceApp = express();
      noServiceApp.use(express.json());
      noServiceApp.use('/aml', createAMLRoutes(mockService as any));

      const response = await request(noServiceApp).post('/aml/cases/assign-all');

      expect(response.status).toBe(503);
    });

    it('should handle generic errors', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockAssignmentService.assignAllOpenCases.mockRejectedValue(new Error('Pool exhausted'));

      const response = await request(assignmentApp).post('/aml/cases/assign-all');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('GET /aml/cases/reviewer-capacities', () => {
    let assignmentApp: Express;
    let mockAssignmentService: any;

    beforeEach(() => {
      mockAssignmentService = {
        assignCase: jest.fn(),
        assignAllOpenCases: jest.fn(),
        getReviewerCapacities: jest.fn(),
      };

      assignmentApp = express();
      assignmentApp.use(express.json());
      assignmentApp.use(
        '/aml',
        createAMLRoutes(mockService as any, mockAssignmentService as any),
      );
    });

    it('should return reviewer capacities', async () => {
      mockAssignmentService.getReviewerCapacities.mockResolvedValue([
        {
          reviewer_id: 'r1',
          active_cases: 3,
          max_capacity: 10,
          remaining_capacity: 7,
          last_closed_at: null,
          in_cool_down: false,
          eligible: true,
        },
      ]);

      const response = await request(assignmentApp).get('/aml/cases/reviewer-capacities');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].eligible).toBe(true);
    });

    it('should return 503 when assignment service is not available', async () => {
      const noServiceApp = express();
      noServiceApp.use(express.json());
      noServiceApp.use('/aml', createAMLRoutes(mockService as any));

      const response = await request(noServiceApp).get('/aml/cases/reviewer-capacities');

      expect(response.status).toBe(503);
    });

    it('should handle generic errors', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockAssignmentService.getReviewerCapacities.mockRejectedValue(new Error('Timeout'));

      const response = await request(assignmentApp).get('/aml/cases/reviewer-capacities');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  // ── OFAC dual-control review queue routes ─────────────────────────────────

  /**
   * Helpers for OFAC route tests.
   *
   * The review queue endpoints require:
   *   - x-user-id   / x-user-role headers (or req.user) for RBAC
   *   - x-csrf-token header matching csrfToken cookie for mutation endpoints
   */
  const COMPLIANCE_HEADERS = {
    'x-user-id': 'officer_1',
    'x-user-role': 'compliance_officer',
  };

  const CSRF_HEADERS = {
    ...COMPLIANCE_HEADERS,
    'x-csrf-token': 'test-csrf-token',
    cookie: 'csrfToken=test-csrf-token',
  };

  const validCreateBody = {
    alert_id: 'alert_ofac_1',
    investor_id: 'investor_1',
    matched_name: 'Ahmad Al-Rashid',
    rationale: 'DOB and passport number do not match the SDN entry.',
  };

  describe('GET /aml/ofac-reviews', () => {
    it('should return the review queue for a compliance officer', async () => {
      const response = await request(app)
        .get('/aml/ofac-reviews')
        .set(COMPLIANCE_HEADERS);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should return only pending reviews in the queue', async () => {
      // Pre-populate a review so there is something in the queue
      await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send(validCreateBody);

      const response = await request(app)
        .get('/aml/ofac-reviews')
        .set(COMPLIANCE_HEADERS);

      expect(response.status).toBe(200);
      const statuses: string[] = response.body.data.map((r: any) => r.status);
      statuses.forEach(s =>
        expect(['pending_first_approval', 'pending_second_approval']).toContain(s)
      );
    });

    it('should return 401 when no authentication is provided', async () => {
      const response = await request(app).get('/aml/ofac-reviews');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should return 403 for a non-compliance role', async () => {
      const response = await request(app)
        .get('/aml/ofac-reviews')
        .set({ 'x-user-id': 'user_1', 'x-user-role': 'investor' });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it('should accept admin role', async () => {
      const response = await request(app)
        .get('/aml/ofac-reviews')
        .set({ 'x-user-id': 'admin_1', 'x-user-role': 'admin' });

      expect(response.status).toBe(200);
    });

    it('should accept compliance role', async () => {
      const response = await request(app)
        .get('/aml/ofac-reviews')
        .set({ 'x-user-id': 'officer_2', 'x-user-role': 'compliance' });

      expect(response.status).toBe(200);
    });

    it('should handle service errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(mockService, 'getOFACReviewQueue').mockRejectedValueOnce(new Error('DB error'));

      const response = await request(app)
        .get('/aml/ofac-reviews')
        .set(COMPLIANCE_HEADERS);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('POST /aml/ofac-reviews', () => {
    it('should create a new OFAC review for a compliance officer with CSRF token', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send(validCreateBody);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('pending_first_approval');
      expect(response.body.data.created_by).toBe('officer_1');
      expect(response.body.data.alert_id).toBe('alert_ofac_1');
    });

    it('should record the creator id from the authenticated actor', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set({
          'x-user-id': 'officer_99',
          'x-user-role': 'compliance_officer',
          'x-csrf-token': 'tok',
          cookie: 'csrfToken=tok',
        })
        .send(validCreateBody);

      expect(response.status).toBe(201);
      expect(response.body.data.created_by).toBe('officer_99');
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({ alert_id: 'a1', investor_id: 'i1' }); // missing matched_name & rationale

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.details).toBeDefined();
    });

    it('should return 400 when rationale is too short (< 10 chars)', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({ ...validCreateBody, rationale: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when rationale is too long (> 4000 chars)', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({ ...validCreateBody, rationale: 'x'.repeat(4001) });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when matched_name is too long (> 255 chars)', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({ ...validCreateBody, matched_name: 'A'.repeat(256) });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should accept optional case_id and list_entry_id', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({
          ...validCreateBody,
          case_id: 'case_123',
          list_entry_id: 'SDN-4567',
        });

      expect(response.status).toBe(201);
      expect(response.body.data.case_id).toBe('case_123');
    });

    it('should accept a valid ISO-8601 expires_at', async () => {
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({ ...validCreateBody, expires_at: expiresAt });

      expect(response.status).toBe(201);
    });

    it('should return 400 for invalid expires_at format', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send({ ...validCreateBody, expires_at: 'not-a-date' });

      expect(response.status).toBe(400);
    });

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .send(validCreateBody);

      expect(response.status).toBe(401);
    });

    it('should return 403 for non-compliance role', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set({ 'x-user-id': 'user_1', 'x-user-role': 'investor', 'x-csrf-token': 'tok', cookie: 'csrfToken=tok' })
        .send(validCreateBody);

      expect(response.status).toBe(403);
    });

    it('should return 403 when CSRF token is missing', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(COMPLIANCE_HEADERS) // no x-csrf-token
        .send(validCreateBody);

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('CSRF');
    });

    it('should return 403 when CSRF token does not match cookie', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set({
          ...COMPLIANCE_HEADERS,
          'x-csrf-token': 'wrong-token',
          cookie: 'csrfToken=correct-token',
        })
        .send(validCreateBody);

      expect(response.status).toBe(403);
    });

    it('should handle service errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(mockService, 'createOFACReview').mockRejectedValueOnce(new Error('DB error'));

      const response = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send(validCreateBody);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('POST /aml/ofac-reviews/:reviewId/approve', () => {
    let createdReviewId: string;

    beforeEach(async () => {
      // Create a review as officer_1 (the creator)
      const createRes = await request(app)
        .post('/aml/ofac-reviews')
        .set(CSRF_HEADERS)
        .send(validCreateBody);
      createdReviewId = createRes.body.data.id;
    });

    const approveAs = (userId: string, rationale: string) =>
      request(app)
        .post(`/aml/ofac-reviews/${createdReviewId}/approve`)
        .set({
          'x-user-id': userId,
          'x-user-role': 'compliance_officer',
          'x-csrf-token': 'tok',
          cookie: 'csrfToken=tok',
        })
        .send({ rationale });

    it('should record the first approval and advance status to pending_second_approval', async () => {
      const response = await approveAs('officer_2', 'DOB checked, no match on SDN entry date of birth.');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('pending_second_approval');
      expect(response.body.data.first_approver_id).toBe('officer_2');
    });

    it('should clear the review after two independent approvals', async () => {
      await approveAs('officer_2', 'First independent check passed.');
      const clearRes = await approveAs('officer_3', 'Second independent check passed.');

      expect(clearRes.status).toBe(200);
      expect(clearRes.body.data.status).toBe('cleared');
      expect(clearRes.body.data.second_approver_id).toBe('officer_3');
      expect(clearRes.body.data.clearance_rationale).toContain('officer_3');
    });

    it('should return 409 when the review creator attempts to approve their own case', async () => {
      // officer_1 created the review; should be blocked
      const response = await approveAs('officer_1', 'Self-approving incorrectly.');

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('creator cannot approve');
    });

    it('should return 409 when the same officer tries to approve twice (dual-control)', async () => {
      await approveAs('officer_2', 'First independent approval.');
      const response = await approveAs('officer_2', 'Second attempt by same officer.');

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('cannot approve an OFAC review twice');
    });

    it('should return 409 when attempting to approve an already-cleared review', async () => {
      await approveAs('officer_2', 'First independent approval.');
      await approveAs('officer_3', 'Second independent approval.');
      const response = await approveAs('officer_4', 'Third attempt after clearance.');

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('already cleared');
    });

    it('should return 404 when the review does not exist', async () => {
      const response = await request(app)
        .post('/aml/ofac-reviews/nonexistent_review_id/approve')
        .set(CSRF_HEADERS)
        .send({ rationale: 'Valid rationale text for this approval.' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when rationale is too short (< 10 chars)', async () => {
      const response = await approveAs('officer_2', 'short');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when rationale is missing', async () => {
      const response = await request(app)
        .post(`/aml/ofac-reviews/${createdReviewId}/approve`)
        .set(CSRF_HEADERS)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .post(`/aml/ofac-reviews/${createdReviewId}/approve`)
        .send({ rationale: 'Valid rationale for this test case.' });

      expect(response.status).toBe(401);
    });

    it('should return 403 for non-compliance role', async () => {
      const response = await request(app)
        .post(`/aml/ofac-reviews/${createdReviewId}/approve`)
        .set({ 'x-user-id': 'u1', 'x-user-role': 'investor', 'x-csrf-token': 'tok', cookie: 'csrfToken=tok' })
        .send({ rationale: 'Valid rationale for this test case.' });

      expect(response.status).toBe(403);
    });

    it('should return 403 when CSRF token is missing', async () => {
      const response = await request(app)
        .post(`/aml/ofac-reviews/${createdReviewId}/approve`)
        .set(COMPLIANCE_HEADERS) // no x-csrf-token
        .send({ rationale: 'Valid rationale for this test case.' });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('CSRF');
    });

    it('should handle unexpected service errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(mockService, 'approveOFACReview').mockRejectedValueOnce(new Error('Network timeout'));

      const response = await approveAs('officer_2', 'Valid rationale for this test case.');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should re-enter expired pending_second_approval reviews into the queue', async () => {
      // First approval
      await approveAs('officer_2', 'First independent approval before expiry.');

      // Simulate the scenario: the mock service will still process this correctly
      // as the repository-level expiry reset is tested in ofacReviewRepository.test.ts.
      // Here we verify the route correctly propagates the repository result.
      const queueRes = await request(app)
        .get('/aml/ofac-reviews')
        .set(COMPLIANCE_HEADERS);

      expect(queueRes.status).toBe(200);
      // The review is still in the queue (pending_second_approval)
      const inQueue = queueRes.body.data.some((r: any) => r.id === createdReviewId);
      expect(inQueue).toBe(true);
    });
  });
});
