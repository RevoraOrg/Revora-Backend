import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Interface for pagination parameters.
 * Supports both offset-based and cursor-based pagination.
 */
export interface PaginationParams {
  limit: number;
  offset?: number;
  cursor?: string;
}

/**
 * Interface for a paginated response.
 */
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    offset?: number;
    nextCursor?: string;
    hasMore: boolean;
  };
}

/**
 * Default pagination constants.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parses pagination parameters from an Express request query.
 * 
 * Expected query parameters:
 * - limit: number (default: 20, max: 100)
 * - offset: number (default: 0)
 * - cursor: string (optional)
 * 
 * @param req Express Request object
 * @returns PaginationParams
 */
export function parsePagination(req: Request): PaginationParams {
  const queryLimit = parseInt(req.query.limit as string, 10);
  const limit = isNaN(queryLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, queryLimit), MAX_LIMIT);

  const queryOffset = parseInt(req.query.offset as string, 10);
  const offset = isNaN(queryOffset) ? 0 : Math.max(0, queryOffset);

  const cursor = req.query.cursor as string;

  return {
    limit,
    offset,
    cursor: cursor || undefined,
  };
}

/**
 * Formats a list of data into a paginated response.
 * 
 * @param data The array of items for the current page
 * @param total Total number of items across all pages
 * @param params The pagination parameters used for this query
 * @param nextCursor Optional cursor for the next page (for cursor-based pagination)
 * @returns PaginatedResponse<T>
 */
export function formatPage<T>(
  data: T[],
  total: number,
  params: PaginationParams,
  nextCursor?: string
): PaginatedResponse<T> {
  const { limit, offset = 0 } = params;

  // For offset-based, hasMore is true if offset + limit < total
  // For cursor-based, hasMore is true if nextCursor is provided
  const hasMore = nextCursor ? true : offset + data.length < total;

  return {
    data,
    meta: {
      total,
      limit,
      offset,
      nextCursor,
      hasMore,
    },
  };
}

function getCursorSecret(): string {
  return process.env.CURSOR_SIGNING_SECRET ?? 'dev-cursor-secret-change-in-prod';
}

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64url');
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export interface CursorPayload {
  id: string;
  gl: string;
  t: number;
}

export function signCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  const encoded = toBase64Url(json);
  const secret = getCursorSecret();
  const sig = createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyCursor(cursor: string, expectedGl?: string): CursorPayload | null {
  const parts = cursor.split('.');
  if (parts.length !== 2) return null;

  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const secret = getCursorSecret();
  const expectedSig = createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');

  try {
    const sigBuffer = Buffer.from(sig, 'base64url');
    const expectedBuffer = Buffer.from(expectedSig, 'base64url');
    if (sigBuffer.length !== expectedBuffer.length) return null;
    if (!timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  } catch {
    return null;
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(fromBase64Url(encoded)) as CursorPayload;
  } catch {
    return null;
  }

  if (!payload.id || !payload.gl || typeof payload.t !== 'number') return null;

  if (expectedGl !== undefined && payload.gl !== expectedGl) return null;

  return payload;
}
