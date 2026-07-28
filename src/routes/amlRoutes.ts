/**
 * AML Routes
 * 
 * REST API endpoints for AML transaction monitoring and case management.
 */

import { NextFunction, Router, Request, RequestHandler, Response } from 'express';
import { AMLService } from '../aml/amlService';
import { z } from 'zod';

/**
 * Validation schemas for AML endpoints
 */
const createRuleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().min(1).max(1000),
  type: z.enum(['velocity', 'structuring', 'geo_mismatch', 'amount_threshold']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  config: z.record(z.string(), z.unknown()),
});

const updateRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  change_reason: z.string().min(1).max(500),
});

const createCaseSchema = z.object({
  alert_ids: z.array(z.string()).min(1),
  investor_id: z.string().min(1),
  assigned_to: z.string().optional(),
  notes: z.string().optional(),
});

const updateCaseSchema = z.object({
  status: z.enum(['open', 'assigned', 'investigating', 'closed', 'dismissed']).optional(),
  assigned_to: z.string().optional(),
  disposition: z.enum(['confirmed_suspicious', 'false_positive', 'inconclusive', 'legitimate']).optional(),
  notes: z.string().optional(),
});

const rollbackRuleSchema = z.object({
  version: z.object({
    major: z.number().int().min(0),
    minor: z.number().int().min(0),
    patch: z.number().int().min(0),
  }),
});

const createOFACReviewSchema = z.object({
  alert_id: z.string().min(1),
  case_id: z.string().min(1).optional(),
  investor_id: z.string().min(1),
  matched_name: z.string().min(1).max(255),
  list_entry_id: z.string().min(1).max(255).optional(),
  rationale: z.string().min(10).max(4000),
  expires_at: z.string().datetime().optional(),
});

const approveOFACReviewSchema = z.object({
  rationale: z.string().min(10).max(4000),
});

export interface AMLRouteOptions {
  reviewQueueGuards?: RequestHandler[];
}

function zodDetails(error: z.ZodError): unknown {
  return error.issues;
}

function getActor(req: Request): { id?: string; role?: string } {
  const user = (req as any).user;
  const securityUser = (req as any).securityContext?.user;

  return {
    id: user?.id || securityUser?.id || req.header('x-user-id') || undefined,
    role: user?.role || securityUser?.role || req.header('x-user-role') || undefined,
  };
}

function requireReviewQueueRole(req: Request, res: Response, next: NextFunction): void {
  const actor = getActor(req);
  const allowedRoles = ['admin', 'compliance', 'compliance_officer'];

  if (!actor.id || !actor.role) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  if (!allowedRoles.includes(actor.role)) {
    res.status(403).json({ success: false, error: 'Compliance role required' });
    return;
  }

  (req as any).amlActor = actor;
  next();
}

function requireCsrfToken(req: Request, res: Response, next: NextFunction): void {
  const csrfHeader = req.header('x-csrf-token');
  const csrfCookie = req.header('cookie')?.match(/(?:^|;\s*)csrfToken=([^;]+)/)?.[1];

  if (!csrfHeader || (csrfCookie && csrfHeader !== decodeURIComponent(csrfCookie))) {
    res.status(403).json({ success: false, error: 'Valid CSRF token required' });
    return;
  }

  next();
}

/**
 * Create AML routes
 */
export function createAMLRoutes(amlService: AMLService, options: AMLRouteOptions = {}): Router {
  const router = Router();
  const reviewQueueGuards = options.reviewQueueGuards || [requireReviewQueueRole];
  const reviewQueueMutationGuards = [...reviewQueueGuards, requireCsrfToken];

  /**
   * GET /aml/rules
   * Get all AML rules
   */
  router.get('/rules', async (req: Request, res: Response) => {
    try {
      const rules = await amlService.getRules();
      res.json({ success: true, data: rules });
    } catch (error) {
      console.error('Error fetching AML rules:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch rules' });
    }
  });

  /**
   * GET /aml/rules/enabled
   * Get enabled AML rules
   */
  router.get('/rules/enabled', async (req: Request, res: Response) => {
    try {
      const rules = await amlService.getEnabledRules();
      res.json({ success: true, data: rules });
    } catch (error) {
      console.error('Error fetching enabled AML rules:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch enabled rules' });
    }
  });

  /**
   * GET /aml/rules/:ruleId/history
   * Get rule version history
   */
  router.get('/rules/:ruleId/history', async (req: Request, res: Response) => {
    try {
      const { ruleId } = req.params;
      const history = await amlService.getRuleHistory(ruleId);
      res.json({ success: true, data: history });
    } catch (error) {
      console.error('Error fetching rule history:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch rule history' });
    }
  });

  /**
   * POST /aml/rules
   * Create a new AML rule
   */
  router.post('/rules', async (req: Request, res: Response) => {
    try {
      const validated = createRuleSchema.parse(req.body);
      const rule = await amlService.createRule(validated);
      res.status(201).json({ success: true, data: rule });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else {
        console.error('Error creating AML rule:', error);
        res.status(500).json({ success: false, error: 'Failed to create rule' });
      }
    }
  });

  /**
   * PUT /aml/rules/:ruleId
   * Update an AML rule
   */
  router.put('/rules/:ruleId', async (req: Request, res: Response) => {
    try {
      const { ruleId } = req.params;
      const validated = updateRuleSchema.parse(req.body);
      const rule = await amlService.updateRule(ruleId, validated);
      res.json({ success: true, data: rule });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else {
        console.error('Error updating AML rule:', error);
        res.status(500).json({ success: false, error: 'Failed to update rule' });
      }
    }
  });

  /**
   * POST /aml/rules/:ruleId/rollback
   * Rollback a rule to a specific version
   */
  router.post('/rules/:ruleId/rollback', async (req: Request, res: Response) => {
    try {
      const { ruleId } = req.params;
      const validated = rollbackRuleSchema.parse(req.body);
      const rule = await amlService.rollbackRule(ruleId, validated.version);
      res.json({ success: true, data: rule });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else {
        console.error('Error rolling back AML rule:', error);
        res.status(500).json({ success: false, error: 'Failed to rollback rule' });
      }
    }
  });

  /**
   * GET /aml/cases
   * Get cases by status (query param)
   */
  router.get('/cases', async (req: Request, res: Response) => {
    try {
      const { status, analyst_id } = req.query;
      
      let cases;
      if (status && typeof status === 'string') {
        cases = await amlService.getCasesByStatus(status as any);
      } else if (analyst_id && typeof analyst_id === 'string') {
        cases = await amlService.getCasesByAnalyst(analyst_id);
      } else {
        res.status(400).json({ success: false, error: 'Must provide status or analyst_id query parameter' });
        return;
      }
      
      res.json({ success: true, data: cases });
    } catch (error) {
      console.error('Error fetching AML cases:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch cases' });
    }
  });

  /**
   * GET /aml/cases/:caseId
   * Get a specific case
   */
  router.get('/cases/:caseId', async (req: Request, res: Response) => {
    try {
      const { caseId } = req.params;
      const amlCase = await amlService.getCase(caseId);
      
      if (!amlCase) {
        res.status(404).json({ success: false, error: 'Case not found' });
        return;
      }
      
      res.json({ success: true, data: amlCase });
    } catch (error) {
      console.error('Error fetching AML case:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch case' });
    }
  });

  /**
   * GET /aml/cases/:caseId/alerts
   * Get alerts for a case
   */
  router.get('/cases/:caseId/alerts', async (req: Request, res: Response) => {
    try {
      const { caseId } = req.params;
      const alerts = await amlService.getCaseAlerts(caseId);
      res.json({ success: true, data: alerts });
    } catch (error) {
      console.error('Error fetching case alerts:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch case alerts' });
    }
  });

  /**
   * POST /aml/cases
   * Create a new AML case
   */
  router.post('/cases', async (req: Request, res: Response) => {
    try {
      const validated = createCaseSchema.parse(req.body);
      const amlCase = await amlService.createCase(validated);
      res.status(201).json({ success: true, data: amlCase });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else {
        console.error('Error creating AML case:', error);
        res.status(500).json({ success: false, error: 'Failed to create case' });
      }
    }
  });

  /**
   * PUT /aml/cases/:caseId
   * Update an AML case
   */
  router.put('/cases/:caseId', async (req: Request, res: Response) => {
    try {
      const { caseId } = req.params;
      const validated = updateCaseSchema.parse(req.body);
      const amlCase = await amlService.updateCase(caseId, validated);
      res.json({ success: true, data: amlCase });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else {
        console.error('Error updating AML case:', error);
        res.status(500).json({ success: false, error: 'Failed to update case' });
      }
    }
  });

  /**
   * GET /aml/alerts/pending
   * Get pending alerts
   */
  router.get('/alerts/pending', async (req: Request, res: Response) => {
    try {
      const alerts = await amlService.getPendingAlerts();
      res.json({ success: true, data: alerts });
    } catch (error) {
      console.error('Error fetching pending alerts:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch pending alerts' });
    }
  });

  /**
   * GET /aml/alerts/investor/:investorId
   * Get alerts for an investor
   */
  router.get('/alerts/investor/:investorId', async (req: Request, res: Response) => {
    try {
      const { investorId } = req.params;
      const alerts = await amlService.getInvestorAlerts(investorId);
      res.json({ success: true, data: alerts });
    } catch (error) {
      console.error('Error fetching investor alerts:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch investor alerts' });
    }
  });

  /**
   * POST /aml/alerts/:alertId/dismiss
   * Dismiss an alert as false positive
   */
  router.post('/alerts/:alertId/dismiss', async (req: Request, res: Response) => {
    try {
      const { alertId } = req.params;
      const alert = await amlService.dismissAlert(alertId);
      res.json({ success: true, data: alert });
    } catch (error) {
      console.error('Error dismissing alert:', error);
      res.status(500).json({ success: false, error: 'Failed to dismiss alert' });
    }
  });

  router.get('/ofac-reviews', ...reviewQueueGuards, async (req: Request, res: Response) => {
    try {
      const reviews = await amlService.getOFACReviewQueue();
      res.json({ success: true, data: reviews });
    } catch (error) {
      console.error('Error fetching OFAC review queue:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch OFAC review queue' });
    }
  });

  router.post('/ofac-reviews', ...reviewQueueMutationGuards, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).amlActor || getActor(req);
      const validated = createOFACReviewSchema.parse(req.body);
      const review = await amlService.createOFACReview({
        ...validated,
        expires_at: validated.expires_at ? new Date(validated.expires_at) : undefined,
      }, actor.id);

      res.status(201).json({ success: true, data: review });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else {
        console.error('Error creating OFAC review:', error);
        res.status(500).json({ success: false, error: 'Failed to create OFAC review' });
      }
    }
  });

  router.post('/ofac-reviews/:reviewId/approve', ...reviewQueueMutationGuards, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).amlActor || getActor(req);
      const { reviewId } = req.params;
      const validated = approveOFACReviewSchema.parse(req.body);
      const review = await amlService.approveOFACReview(reviewId, actor.id, validated.rationale);
      res.json({ success: true, data: review });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Invalid input', details: zodDetails(error) });
      } else if (error instanceof Error && /creator|twice|already cleared/.test(error.message)) {
        res.status(409).json({ success: false, error: error.message });
      } else {
        console.error('Error approving OFAC review:', error);
        res.status(500).json({ success: false, error: 'Failed to approve OFAC review' });
      }
    }
  });

  return router;
}
