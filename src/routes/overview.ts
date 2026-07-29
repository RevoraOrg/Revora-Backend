import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { AMLAlertRepository } from '../aml/amlAlertRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { InMemorySecurityAuditRepository } from '../security/audit';
import { RiskScoreEngine } from '../aml/riskScoreEngine';

const router = Router();

const amlAuditRepo = new InMemorySecurityAuditRepository();
const userRepo = new UserRepository(pool);
const alertRepo = new AMLAlertRepository(pool);
export const riskScoreEngine = new RiskScoreEngine(userRepo, alertRepo, amlAuditRepo);

export const overviewHandler = (_req: Request, res: Response) => {
    res.json({
        name: 'Stellar RevenueShare (Revora) Backend',
        description:
            'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).',
        version: '0.1.0'
    });
};

export const investorOverviewHandler = async (req: Request, res: Response) => {
    try {
        const { investorId } = req.params;
        const actorId = req.headers['x-user-id'] as string || 'system';
        const riskScore = await riskScoreEngine.calculateScore(investorId, actorId);
        res.json({ investorId, riskScore });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const updateWeightsHandler = async (req: Request, res: Response) => {
    try {
        const actorId = req.headers['x-user-id'] as string || 'system';
        const confirmationHeader = req.get('x-revora-dual-confirmation') === 'true';
        const confirmationBody = req.body?.confirmation === true || req.body?.confirmation === 'true';
        const confirmed = confirmationHeader && confirmationBody;
        
        await riskScoreEngine.updateWeights(req.body.weights, confirmed, actorId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
};

router.get('/api/overview', overviewHandler);
router.get('/api', overviewHandler);
router.get('/api/overview/investor/:investorId', investorOverviewHandler);
router.put('/api/overview/risk-score-weights', updateWeightsHandler);

export default router;
