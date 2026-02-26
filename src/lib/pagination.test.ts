import { Request } from 'express';
import { parsePagination, formatPage } from './pagination';

describe('Pagination Helper', () => {
    describe('parsePagination', () => {
        it('should use defaults when no query params are provided', () => {
            const req = { query: {} } as unknown as Request;
            const result = parsePagination(req);
            expect(result).toEqual({
                limit: 20,
                offset: 0,
                cursor: undefined,
            });
        });

        it('should parse valid limit and offset', () => {
            const req = {
                query: { limit: '50', offset: '10' },
            } as unknown as Request;
            const result = parsePagination(req);
            expect(result).toEqual({
                limit: 50,
                offset: 10,
                cursor: undefined,
            });
        });

        it('should cap limit at MAX_LIMIT (100)', () => {
            const req = {
                query: { limit: '200' },
            } as unknown as Request;
            const result = parsePagination(req);
            expect(result.limit).toBe(100);
        });

        it('should ensure limit is at least 1', () => {
            const req = {
                query: { limit: '0' },
            } as unknown as Request;
            const result = parsePagination(req);
            expect(result.limit).toBe(1);
        });

        it('should parse cursor', () => {
            const req = {
                query: { cursor: 'abc-123' },
            } as unknown as Request;
            const result = parsePagination(req);
            expect(result.cursor).toBe('abc-123');
        });

        it('should handle invalid numbers by using defaults', () => {
            const req = {
                query: { limit: 'foo', offset: 'bar' },
            } as unknown as Request;
            const result = parsePagination(req);
            expect(result).toEqual({
                limit: 20,
                offset: 0,
                cursor: undefined,
            });
        });
    });

    describe('formatPage', () => {
        const mockData = [{ id: 1 }, { id: 2 }];
        const params = { limit: 10, offset: 0 };

        it('should format page metadata correctly for offset-based pagination', () => {
            const result = formatPage(mockData, 100, params);
            expect(result.meta).toEqual({
                total: 100,
                limit: 10,
                offset: 0,
                nextCursor: undefined,
                hasMore: true,
            });
            expect(result.data).toEqual(mockData);
        });

        it('should set hasMore to false when at the end of data', () => {
            const result = formatPage(mockData, 2, params);
            expect(result.meta.hasMore).toBe(false);
        });

        it('should set hasMore to true when nextCursor is provided', () => {
            const result = formatPage(mockData, 100, params, 'next-token');
            expect(result.meta.hasMore).toBe(true);
            expect(result.meta.nextCursor).toBe('next-token');
        });

        it('should use provided offset from params', () => {
            const result = formatPage(mockData, 100, { limit: 10, offset: 20 });
            expect(result.meta.offset).toBe(20);
        });
    });
});
