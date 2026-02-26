import { Request } from 'express';

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
