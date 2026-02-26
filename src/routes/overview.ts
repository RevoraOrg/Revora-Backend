import { Router, Request, Response } from 'express';

const router = Router();

// In a real scenario, this would be read from package.json or a config file.
// Since we are not allowed to modify existing config files or package.json,
// we'll read it dynamically or use a fallback if needed.
// For now, we'll use the values from the original index.ts.
export const overviewHandler = (_req: Request, res: Response) => {
    res.json({
        name: 'Stellar RevenueShare (Revora) Backend',
        description:
            'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).',
        version: '0.1.0'
    });
};

router.get('/api/overview', overviewHandler);
router.get('/api', overviewHandler);

export default router;
