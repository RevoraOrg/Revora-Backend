/**
 * AML Alert Repository Tests
 * 
 * Comprehensive test coverage for AML alert repository including
 * alert management and case workflow operations.
 */

import { AMLAlertRepository } from './amlAlertRepository';
import { Pool } from 'pg';
import { CreateCaseInput, UpdateCaseInput } from './types';

// Mock Pool
class MockPool {
  private client: any;
  
  constructor() {
    this.client = new MockClient();
  }

  async connect() {
    return this.client;
  }

  async query(text: string, values?: any[]) {
    return this.client.query(text, values);
  }
}

class MockClient {
  private queries: any[] = [];
  private inTransaction = false;

  async query(text: string, values?: any[]) {
    this.queries.push({ text, values });
    
    // Handle BEGIN/COMMIT/ROLLBACK
    if (text.includes('BEGIN')) {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (text.includes('COMMIT')) {
      this.inTransaction = false;
      return { rows: [] };
    }
    if (text.includes('ROLLBACK')) {
      this.inTransaction = false;
      return { rows: [] };
    }

    // Handle INSERT alert
    if (text.includes('INSERT INTO aml_alerts')) {
      return {
        rows: [{
          id: 'alert_test_123',
          investment_id: values?.[1] || 'inv_1',
          investor_id: values?.[2] || 'inv_1',
          rule_id: values?.[3] || 'rule_1',
          rule_version: values?.[4] || { major: 1, minor: 0, patch: 0 },
          severity: values?.[5] || 'high',
          details: values?.[6] || {},
          status: values?.[7] || 'pending',
          case_id: values?.[8] || null,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle SELECT by ID
    if (text.includes('SELECT * FROM aml_alerts WHERE id = $1')) {
      if (values && values[0] === 'nonexistent') {
        return { rows: [] };
      }
      return {
        rows: [{
          id: values?.[0] || 'alert_1',
          investment_id: 'inv_1',
          investor_id: 'inv_1',
          rule_id: 'rule_1',
          rule_version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          details: {},
          status: 'pending',
          case_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle SELECT by investment
    if (text.includes('WHERE investment_id = $1')) {
      return {
        rows: [{
          id: 'alert_1',
          investment_id: values?.[0] || 'inv_1',
          investor_id: 'inv_1',
          rule_id: 'rule_1',
          rule_version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          details: {},
          status: 'pending',
          case_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle SELECT by investor
    if (text.includes('WHERE investor_id = $1')) {
      return {
        rows: [{
          id: 'alert_1',
          investment_id: 'inv_1',
          investor_id: values?.[0] || 'inv_1',
          rule_id: 'rule_1',
          rule_version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          details: {},
          status: 'pending',
          case_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle pending alerts
    if (text.includes('WHERE status = \'pending\'')) {
      return {
        rows: [{
          id: 'alert_1',
          investment_id: 'inv_1',
          investor_id: 'inv_1',
          rule_id: 'rule_1',
          rule_version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          details: {},
          status: 'pending',
          case_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle UPDATE alert status
    if (text.includes('UPDATE aml_alerts')) {
      const alertId = values?.[2];
      if (alertId === 'nonexistent') {
        return { rows: [] }; // Simulate not found
      }
      return {
        rows: [{
          id: alertId || 'alert_1',
          investment_id: 'inv_1',
          investor_id: 'inv_1',
          rule_id: 'rule_1',
          rule_version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          details: {},
          status: values?.[0] || 'dismissed',
          case_id: values?.[1] || null,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle INSERT case
    if (text.includes('INSERT INTO aml_cases')) {
      return {
        rows: [{
          id: 'case_test_123',
          alert_ids: values?.[1] || ['alert_1'],
          investor_id: values?.[2] || 'inv_1',
          status: values?.[3] || 'open',
          assigned_to: values?.[4] || null,
          disposition: values?.[5] || null,
          notes: values?.[6] || null,
          created_at: new Date(),
          updated_at: new Date(),
          closed_at: null,
        }]
      };
    }

    // Handle SELECT case by ID
    if (text.includes('SELECT * FROM aml_cases WHERE id = $1')) {
      if (values && values[0] === 'nonexistent') {
        return { rows: [] };
      }
      return {
        rows: [{
          id: values?.[0] || 'case_1',
          alert_ids: ['alert_1'],
          investor_id: 'inv_1',
          status: 'open',
          assigned_to: 'analyst_1',
          disposition: null,
          notes: null,
          created_at: new Date(),
          updated_at: new Date(),
          closed_at: null,
        }]
      };
    }

    // Handle SELECT cases by status
    if (text.includes('SELECT * FROM aml_cases WHERE status = $1')) {
      return {
        rows: [{
          id: 'case_1',
          alert_ids: ['alert_1'],
          investor_id: 'inv_1',
          status: values?.[0] || 'open',
          assigned_to: 'analyst_1',
          disposition: null,
          notes: null,
          created_at: new Date(),
          updated_at: new Date(),
          closed_at: null,
        }]
      };
    }

    // Handle SELECT cases by analyst
    if (text.includes('WHERE assigned_to = $1')) {
      return {
        rows: [{
          id: 'case_1',
          alert_ids: ['alert_1'],
          investor_id: 'inv_1',
          status: 'assigned',
          assigned_to: values?.[0] || 'analyst_1',
          disposition: null,
          notes: null,
          created_at: new Date(),
          updated_at: new Date(),
          closed_at: null,
        }]
      };
    }

    // Handle UPDATE case
    if (text.includes('UPDATE aml_cases')) {
      const caseId = values ? values[values.length - 1] : 'case_1';
      if (caseId === 'nonexistent') {
        return { rows: [] }; // Simulate not found
      }
      return {
        rows: [{
          id: caseId,
          alert_ids: ['alert_1'],
          investor_id: 'inv_1',
          status: 'closed',
          assigned_to: 'analyst_1',
          disposition: 'false_positive',
          notes: 'Investigated',
          created_at: new Date(),
          updated_at: new Date(),
          closed_at: new Date(),
        }]
      };
    }

    // Handle SELECT alerts for case
    if (text.includes('WHERE case_id = $1')) {
      return {
        rows: [{
          id: 'alert_1',
          investment_id: 'inv_1',
          investor_id: 'inv_1',
          rule_id: 'rule_1',
          rule_version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          details: {},
          status: 'reviewed',
          case_id: values?.[0] || 'case_1',
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    return { rows: [] };
  }

  release() {
    this.inTransaction = false;
  }
}

describe('AMLAlertRepository', () => {
  let repository: AMLAlertRepository;
  let mockPool: any;

  beforeEach(() => {
    mockPool = new MockPool();
    repository = new AMLAlertRepository(mockPool as Pool);
  });

  describe('create', () => {
    it('should create a new alert', async () => {
      const alert = await repository.create({
        investment_id: 'inv_1',
        investor_id: 'inv_1',
        rule_id: 'rule_1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: { reason: 'test' },
        status: 'pending',
      });

      expect(alert).toBeDefined();
      expect(alert.investment_id).toBe('inv_1');
      expect(alert.status).toBe('pending');
    });
  });

  describe('findById', () => {
    it('should find alert by ID', async () => {
      const alert = await repository.findById('alert_1');

      expect(alert).toBeDefined();
      expect(alert?.id).toBe('alert_1');
    });

    it('should return null for nonexistent alert', async () => {
      const alert = await repository.findById('nonexistent');

      expect(alert).toBeNull();
    });
  });

  describe('findByInvestment', () => {
    it('should find alerts by investment ID', async () => {
      const alerts = await repository.findByInvestment('inv_1');

      expect(alerts).toBeDefined();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts[0].investment_id).toBe('inv_1');
    });
  });

  describe('findByInvestor', () => {
    it('should find alerts by investor ID', async () => {
      const alerts = await repository.findByInvestor('inv_1');

      expect(alerts).toBeDefined();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts[0].investor_id).toBe('inv_1');
    });
  });

  describe('findPending', () => {
    it('should find pending alerts without case', async () => {
      const alerts = await repository.findPending();

      expect(alerts).toBeDefined();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.every(a => a.status === 'pending')).toBe(true);
    });
  });

  describe('updateStatus', () => {
    it('should update alert status', async () => {
      const alert = await repository.updateStatus('alert_1', 'dismissed');

      expect(alert).toBeDefined();
      expect(alert.status).toBe('dismissed');
    });

    it('should assign alert to case', async () => {
      const alert = await repository.updateStatus('alert_1', 'reviewed', 'case_1');

      expect(alert).toBeDefined();
      expect(alert.status).toBe('reviewed');
      expect(alert.case_id).toBe('case_1');
    });

    it('should throw error for nonexistent alert', async () => {
      await expect(repository.updateStatus('nonexistent', 'dismissed'))
        .rejects.toThrow('Alert nonexistent not found');
    });
  });

  describe('createCase', () => {
    it('should create a new case', async () => {
      const input: CreateCaseInput = {
        alert_ids: ['alert_1'],
        investor_id: 'inv_1',
        assigned_to: 'analyst_1',
        notes: 'Test case',
      };

      const amlCase = await repository.createCase(input);

      expect(amlCase).toBeDefined();
      expect(amlCase.investor_id).toBe('inv_1');
      expect(amlCase.assigned_to).toBe('analyst_1');
    });

    it('should set status to assigned when analyst provided', async () => {
      const input: CreateCaseInput = {
        alert_ids: ['alert_1'],
        investor_id: 'inv_1',
        assigned_to: 'analyst_1',
      };

      const amlCase = await repository.createCase(input);

      expect(amlCase.status).toBe('assigned');
    });

    it('should set status to open when no analyst provided', async () => {
      const input: CreateCaseInput = {
        alert_ids: ['alert_1'],
        investor_id: 'inv_1',
      };

      const amlCase = await repository.createCase(input);

      expect(amlCase.status).toBe('open');
    });
  });

  describe('findCaseById', () => {
    it('should find case by ID', async () => {
      const amlCase = await repository.findCaseById('case_1');

      expect(amlCase).toBeDefined();
      expect(amlCase?.id).toBe('case_1');
    });

    it('should return null for nonexistent case', async () => {
      const amlCase = await repository.findCaseById('nonexistent');

      expect(amlCase).toBeNull();
    });
  });

  describe('findCasesByStatus', () => {
    it('should find cases by status', async () => {
      const cases = await repository.findCasesByStatus('open');

      expect(cases).toBeDefined();
      expect(Array.isArray(cases)).toBe(true);
      expect(cases[0].status).toBe('open');
    });
  });

  describe('findCasesByAnalyst', () => {
    it('should find cases assigned to analyst', async () => {
      const cases = await repository.findCasesByAnalyst('analyst_1');

      expect(cases).toBeDefined();
      expect(Array.isArray(cases)).toBe(true);
      expect(cases[0].assigned_to).toBe('analyst_1');
    });
  });

  describe('updateCase', () => {
    it('should update case status', async () => {
      const input: UpdateCaseInput = {
        status: 'closed',
        disposition: 'false_positive',
      };

      const amlCase = await repository.updateCase('case_1', input);

      expect(amlCase).toBeDefined();
      expect(amlCase.status).toBe('closed');
      expect(amlCase.disposition).toBe('false_positive');
    });

    it('should set closed_at when status is closed', async () => {
      const input: UpdateCaseInput = {
        status: 'closed',
      };

      const amlCase = await repository.updateCase('case_1', input);

      expect(amlCase.closed_at).toBeDefined();
    });

    it('should throw error for nonexistent case', async () => {
      await expect(repository.updateCase('nonexistent', {}))
        .rejects.toThrow('Case nonexistent not found');
    });
  });

  describe('getAlertsForCase', () => {
    it('should get alerts for a case', async () => {
      const alerts = await repository.getAlertsForCase('case_1');

      expect(alerts).toBeDefined();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts[0].case_id).toBe('case_1');
    });
  });
});
