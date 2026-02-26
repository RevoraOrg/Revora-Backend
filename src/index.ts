import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { dbHealth, closePool } from './db/client';

const app = express();
const port = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', async (_req: Request, res: Response) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? 'ok' : 'degraded',
    service: 'revora-backend',
    db,
  });
});

app.get('/api/overview', (_req: Request, res: Response) => {
  res.json({
    name: 'Stellar RevenueShare (Revora) Backend',
    description:
      'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).'
  });
});

const shutdown = async (signal: string) => {
  console.log(`\n[server] ${signal} DB shutting down…`);
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`revora-backend listening on http://localhost:${port}`);
});

