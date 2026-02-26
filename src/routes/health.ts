import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

export const healthReadyHandler = (db: Pool) => async (_req: Request, res: Response): Promise<void> => {
    try {
        // 1. Check Database connectivity
        await db.query('SELECT 1');

        // 2. Check Stellar Horizon connectivity
        try {
            const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
            const response = await fetch(horizonUrl);
            if (!response.ok) {
                throw new Error('Stellar Horizon returned non-ok status');
            }
        } catch (stellarError) {
            console.error('Stellar Horizon check failed:', stellarError);
            res.status(503).json({ status: 'error', message: 'Stellar Horizon is down' });
            return;
        }

        // If both checks pass
        res.status(200).json({ status: 'ok', db: 'up', stellar: 'up' });
    } catch (dbError) {
        console.error('Database check failed:', dbError);
        res.status(503).json({ status: 'error', message: 'Database is down' });
    }
};

export const createHealthRouter = (db: Pool): Router => {
    const router = Router();
    router.get('/ready', healthReadyHandler(db));
    return router;
};

export default createHealthRouter;
