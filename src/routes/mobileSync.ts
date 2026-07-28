import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';
import {
  signCursor,
  verifyCursor,
  validateCursorTimestamp,
  CURSOR_PAGE_SIZE,
  SyncCursorPayload,
} from '../lib/cursor';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncRequest {
  cursor?: string;
  resources?: string[];
  page_size?: number;
}

export interface SyncHolding {
  id: string;
  investor_id: string;
  offering_id: string;
  amount: string;
  asset: string;
  status: string;
  tx_hash?: string;
  updated_at: string;
  /** Server-authoritative resolved version */
  server_version: boolean;
}

export interface SyncDistribution {
  id: string;
  distribution_id: string;
  investor_id: string;
  amount: string;
  status: string;
  tx_hash?: string;
  updated_at: string;
  server_version: boolean;
}

export interface ConflictRecord {
  resource_type: string;
  resource_id: string;
  client_version: Record<string, unknown>;
  server_version: Record<string, unknown>;
  resolution: 'server_wins';
  resolved_at: string;
}

export interface SyncResponse {
  cursor: string;
  holdings?: { items: SyncHolding[]; has_more: boolean };
  distributions?: { items: SyncDistribution[]; has_more: boolean };
  conflicts: ConflictRecord[];
  server_time: string;
}

const VALID_RESOURCES = ['holdings', 'distributions'] as const;

// ─── Repository Interfaces (for DI / testability) ─────────────────────────────

export interface MobileSyncHoldingRepo {
  listSinceInvestor(
    investorId: string,
    since: Date,
    limit: number,
    offset: number,
  ): Promise<SyncHolding[]>;
  countSinceInvestor(investorId: string, since: Date): Promise<number>;
}

export interface MobileSyncDistributionRepo {
  listSinceInvestor(
    investorId: string,
    since: Date,
    limit: number,
    offset: number,
  ): Promise<SyncDistribution[]>;
  countSinceInvestor(investorId: string, since: Date): Promise<number>;
}

// ─── SQL-backed Repositories ──────────────────────────────────────────────────

export class SqlHoldingRepo implements MobileSyncHoldingRepo {
  constructor(private db: Pool) {}

  async listSinceInvestor(
    investorId: string,
    since: Date,
    limit: number,
    offset: number,
  ): Promise<SyncHolding[]> {
    const result = await this.db.query(
      `SELECT id, investor_id, offering_id, amount, asset, status, tx_hash, updated_at
       FROM investments
       WHERE investor_id = $1 AND updated_at >= $2
       ORDER BY updated_at ASC
       LIMIT $3 OFFSET $4`,
      [investorId, since, limit, offset],
    );
    return result.rows.map((r) => ({
      id: r.id,
      investor_id: r.investor_id,
      offering_id: r.offering_id,
      amount: r.amount,
      asset: r.asset,
      status: r.status,
      tx_hash: r.tx_hash || undefined,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      server_version: true,
    }));
  }

  async countSinceInvestor(investorId: string, since: Date): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM investments WHERE investor_id = $1 AND updated_at >= $2`,
      [investorId, since],
    );
    return result.rows[0]?.cnt ?? 0;
  }
}

export class SqlDistributionRepo implements MobileSyncDistributionRepo {
  constructor(private db: Pool) {}

  async listSinceInvestor(
    investorId: string,
    since: Date,
    limit: number,
    offset: number,
  ): Promise<SyncDistribution[]> {
    const result = await this.db.query(
      `SELECT dp.id, dp.distribution_id, dp.investor_id, dp.amount, dp.status, dp.tx_hash, dp.updated_at
       FROM distribution_payouts dp
       WHERE dp.investor_id = $1 AND dp.updated_at >= $2
       ORDER BY dp.updated_at ASC
       LIMIT $3 OFFSET $4`,
      [investorId, since, limit, offset],
    );
    return result.rows.map((r) => ({
      id: r.id,
      distribution_id: r.distribution_id,
      investor_id: r.investor_id,
      amount: r.amount,
      status: r.status,
      tx_hash: r.tx_hash || undefined,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      server_version: true,
    }));
  }

  async countSinceInvestor(investorId: string, since: Date): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM distribution_payouts dp WHERE dp.investor_id = $1 AND dp.updated_at >= $2`,
      [investorId, since],
    );
    return result.rows[0]?.cnt ?? 0;
  }
}

// ─── Conflict Resolution ──────────────────────────────────────────────────────

/**
 * Per-resource conflict resolution rules (server-authoritative):
 *
 * | Resource        | Rule                                                                 |
 * |-----------------|----------------------------------------------------------------------|
 * | holdings        | Server `updated_at` always wins. Client local edits are discarded.  |
 * | distributions   | Server `status` and `amount` always win. Pending transitions are    |
 * |                 | validated server-side; only pending → processed is allowed.          |
 *
 * In all cases the resolved record is returned with `server_version: true`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveConflicts(
  clientPayload: Record<string, unknown> | Record<string, unknown>[] | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serverItems: Array<{ id: string; [key: string]: any }>,
  resourceType: string,
): ConflictRecord[] {
  if (!clientPayload || typeof clientPayload !== 'object') return [];

  const conflicts: ConflictRecord[] = [];
  const clientItems = Array.isArray(clientPayload) ? clientPayload : [clientPayload];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serverLookup = new Map<string, any>(serverItems.map((s) => [s.id, s]));

  for (const clientItem of clientItems) {
    const clientId = (clientItem as Record<string, unknown>).id;
    if (typeof clientId !== 'string') continue;

    const serverItem = serverLookup.get(clientId);
    if (!serverItem) continue;

    const clientVersion = clientItem as Record<string, unknown>;
    const differs = Object.keys(serverItem).some((key) => {
      if (key === 'server_version') return false;
      return JSON.stringify(clientVersion[key]) !== JSON.stringify(serverItem[key]);
    });

    if (differs) {
      conflicts.push({
        resource_type: resourceType,
        resource_id: clientId,
        client_version: clientVersion as Record<string, unknown>,
        server_version: serverItem as unknown as Record<string, unknown>,
        resolution: 'server_wins',
        resolved_at: new Date().toISOString(),
      });
    }
  }

  return conflicts;
}

// ─── Handler Factory ──────────────────────────────────────────────────────────

export interface MobileSyncDeps {
  holdingRepo: MobileSyncHoldingRepo;
  distributionRepo: MobileSyncDistributionRepo;
  metrics: MetricsCollector;
  nowFn?: () => Date;
}

export function createMobileSyncHandlers(deps: MobileSyncDeps) {
  const nowFn = deps.nowFn ?? (() => new Date());

  async function syncHandler(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }
      const investorId = user.id;

      // Parse request body
      const body = (req.body ?? {}) as SyncRequest;
      const requestedResources = Array.isArray(body.resources)
        ? body.resources.filter((r) => (VALID_RESOURCES as readonly string[]).includes(r))
        : [...VALID_RESOURCES];
      const pageSize = Math.min(Math.max(
        body.page_size != null && !Number.isNaN(Number(body.page_size))
          ? Number(body.page_size)
          : CURSOR_PAGE_SIZE,
        1,
      ), 100);

      // Determine sync start point
      let syncSince: Date;
      let page = 0;

      if (body.cursor) {
        let cursorPayload: SyncCursorPayload;
        try {
          cursorPayload = verifyCursor(body.cursor);
        } catch (err) {
          throw Errors.badRequest('Invalid or expired sync cursor');
        }

        // Verify cursor belongs to this user
        if (cursorPayload.sub !== investorId) {
          throw Errors.forbidden('Cursor does not belong to authenticated user');
        }

        // Reject future cursors
        try {
          validateCursorTimestamp(cursorPayload.ts);
        } catch (err) {
          throw Errors.badRequest('Invalid or expired sync cursor');
        }

        syncSince = new Date(cursorPayload.ts);
        page = cursorPayload.page + 1;
      } else {
        // Initial sync: use epoch (return all data)
        syncSince = new Date(0);
        page = 0;
      }

      logger.info('Mobile sync request', {
        investorId,
        page,
        resources: requestedResources,
        requestId,
      });

      // Fetch data for each requested resource
      const response: SyncResponse = {
        cursor: '',
        conflicts: [],
        server_time: nowFn().toISOString(),
      };

      const offset = page * pageSize;
      let anyHasMore = false;

      if (requestedResources.includes('holdings')) {
        const [items, total] = await Promise.all([
          deps.holdingRepo.listSinceInvestor(investorId, syncSince, pageSize, offset),
          deps.holdingRepo.countSinceInvestor(investorId, syncSince),
        ]);
        const hasMore = offset + items.length < total;
        response.holdings = { items, has_more: hasMore };
        if (hasMore) anyHasMore = true;

        // Resolve any client-provided local versions
        const clientHoldings = (body as any).client_holdings;
        const conflicts = resolveConflicts(clientHoldings, items, 'holdings');
        response.conflicts.push(...conflicts);
      }

      if (requestedResources.includes('distributions')) {
        const [items, total] = await Promise.all([
          deps.distributionRepo.listSinceInvestor(investorId, syncSince, pageSize, offset),
          deps.distributionRepo.countSinceInvestor(investorId, syncSince),
        ]);
        const hasMore = offset + items.length < total;
        response.distributions = { items, has_more: hasMore };
        if (hasMore) anyHasMore = true;

        const clientDistributions = (body as any).client_distributions;
        const conflicts = resolveConflicts(clientDistributions, items, 'distributions');
        response.conflicts.push(...conflicts);
      }

      // Build next cursor (sign to prevent tampering)
      const cursorTs = syncSince.getTime() === 0
        ? nowFn().toISOString()
        : syncSince.toISOString();

      response.cursor = signCursor({
        sub: investorId,
        ts: cursorTs,
        page: anyHasMore ? page + 1 : 0,
        resources: requestedResources,
      });

      // Emit page counter metric
      deps.metrics.incrementCounter(
        'mobile_sync_pages',
        { resource: requestedResources.join(','), investor_id: investorId },
        1,
        'Number of mobile sync pages served',
      );

      logger.info('Mobile sync completed', {
        investorId,
        page,
        resources: requestedResources,
        holdingsCount: response.holdings?.items.length ?? 0,
        distributionsCount: response.distributions?.items.length ?? 0,
        conflictsCount: response.conflicts.length,
        requestId,
      });

      return res.status(200).json(response);
    } catch (err) {
      logger.error('Mobile sync failed', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  return { syncHandler };
}

// ─── Router Factory ───────────────────────────────────────────────────────────

export default function createMobileSyncRouter(
  deps: MobileSyncDeps,
  verifyJWT: (req: Request, res: Response, next: NextFunction) => void,
): Router {
  const router = Router();
  const handlers = createMobileSyncHandlers(deps);

  router.post('/sync', verifyJWT, handlers.syncHandler);

  return router;
}
