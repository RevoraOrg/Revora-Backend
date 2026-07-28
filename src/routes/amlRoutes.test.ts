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
});
