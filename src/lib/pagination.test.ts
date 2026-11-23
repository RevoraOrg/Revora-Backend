import { Request } from 'express';
import { parsePagination, formatPage, signCursor, verifyCursor, CursorPayload } from './pagination';
import { createHmac } from 'crypto';

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

    // -----------------------------------------------------------------------
    // signCursor
    // -----------------------------------------------------------------------
    describe('signCursor', () => {
        const payload: CursorPayload = { id: 'abc123', gl: 'us', t: 1700000000000 };

        it('should return a string in the format <encoded>.<sig>', () => {
            const cursor = signCursor(payload);
            const parts = cursor.split('.');
            expect(parts).toHaveLength(2);
            expect(parts[0]).toBeTruthy();
            expect(parts[1]).toBeTruthy();
        });

        it('should produce a cursor that verifyCursor accepts (round-trip)', () => {
            const cursor = signCursor(payload);
            const result = verifyCursor(cursor);
            expect(result).toEqual(payload);
        });

        it('should produce different cursors for different payloads', () => {
            const a = signCursor({ id: 'x', gl: 'us', t: 1 });
            const b = signCursor({ id: 'y', gl: 'us', t: 1 });
            expect(a).not.toBe(b);
        });

        it('should be deterministic for the same payload and secret', () => {
            const c1 = signCursor(payload);
            const c2 = signCursor(payload);
            expect(c1).toBe(c2);
        });

        it('should encode the full payload in the cursor', () => {
            const cursor = signCursor(payload);
            const [encoded] = cursor.split('.');
            const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            expect(decoded).toEqual(payload);
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – success paths
    // -----------------------------------------------------------------------
    describe('verifyCursor – success', () => {
        const payload: CursorPayload = { id: 'user-42', gl: 'eu', t: 1700000001000 };

        it('should return the original payload for a valid cursor', () => {
            const cursor = signCursor(payload);
            expect(verifyCursor(cursor)).toEqual(payload);
        });

        it('should return the payload when expectedGl matches', () => {
            const cursor = signCursor(payload);
            expect(verifyCursor(cursor, 'eu')).toEqual(payload);
        });

        it('should return the payload when expectedGl is not provided', () => {
            const cursor = signCursor(payload);
            expect(verifyCursor(cursor, undefined)).toEqual(payload);
        });

        it('should handle payloads with t=0 (boundary timestamp)', () => {
            const zeroCursor = signCursor({ id: 'z', gl: 'us', t: 0 });
            const result = verifyCursor(zeroCursor);
            expect(result).not.toBeNull();
            expect(result!.t).toBe(0);
        });

        it('should handle payloads with very large t values', () => {
            const bigT = signCursor({ id: 'big', gl: 'jp', t: Number.MAX_SAFE_INTEGER });
            const result = verifyCursor(bigT);
            expect(result).not.toBeNull();
            expect(result!.t).toBe(Number.MAX_SAFE_INTEGER);
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 1: wrong number of dot-separated parts
    //   src/lib/pagination.ts:125  if (parts.length !== 2) return null;
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: wrong segment count (line 125)', () => {
        it('should return null for an empty string', () => {
            expect(verifyCursor('')).toBeNull();
        });

        it('should return null for a cursor with no dot (single segment)', () => {
            expect(verifyCursor('onlyone')).toBeNull();
        });

        it('should return null for a cursor with two dots (three segments)', () => {
            expect(verifyCursor('part1.part2.part3')).toBeNull();
        });

        it('should return null for a cursor with many dots', () => {
            expect(verifyCursor('a.b.c.d.e')).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 2: empty encoded or sig segment
    //   src/lib/pagination.ts:128  if (!encoded || !sig) return null;
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: empty encoded or sig segment (line 128)', () => {
        it('should return null when encoded segment is empty (.sig)', () => {
            expect(verifyCursor('.somesig')).toBeNull();
        });

        it('should return null when sig segment is empty (encoded.)', () => {
            expect(verifyCursor('someencoded.')).toBeNull();
        });

        it('should return null when both segments are empty (.)', () => {
            expect(verifyCursor('.')).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 3: tampered signature (length mismatch or
    //   different value triggers timingSafeEqual failure)
    //   src/lib/pagination.ts:138  if (sigBuffer.length !== expectedBuffer.length) return null;
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: signature length mismatch (line 138)', () => {
        it('should return null when sig has fewer bytes than expected', () => {
            const payload: CursorPayload = { id: 'p', gl: 'us', t: 1 };
            const cursor = signCursor(payload);
            const [encoded] = cursor.split('.');
            // Truncate the sig to 8 characters – far shorter than sha256 base64url output
            const truncatedSig = 'short';
            expect(verifyCursor(`${encoded}.${truncatedSig}`)).toBeNull();
        });

        it('should return null when sig has more bytes than expected', () => {
            const payload: CursorPayload = { id: 'p', gl: 'us', t: 1 };
            const cursor = signCursor(payload);
            const [encoded, sig] = cursor.split('.');
            // Pad the sig to make it longer
            const paddedSig = sig + sig;
            expect(verifyCursor(`${encoded}.${paddedSig}`)).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 4: correct length but wrong sig value
    //   timingSafeEqual check returns false → return null
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: tampered signature value (timingSafeEqual)', () => {
        it('should return null when the signature is wrong but same length', () => {
            const payload: CursorPayload = { id: 'q', gl: 'de', t: 999 };
            const cursor = signCursor(payload);
            const [encoded, sig] = cursor.split('.');

            // Flip the first character of the sig to produce a same-length wrong sig
            const flippedFirstChar = sig[0] === 'a' ? 'b' : 'a';
            const tamperedSig = flippedFirstChar + sig.slice(1);

            // Only proceed if the tampered sig has the same length (it will, since we
            // only changed a character, not the length)
            if (tamperedSig.length === sig.length) {
                expect(verifyCursor(`${encoded}.${tamperedSig}`)).toBeNull();
            } else {
                // If length changed (e.g. base64url edge case), skip with a note
                expect(true).toBe(true);
            }
        });

        it('should return null when the encoded portion is tampered (invalidates HMAC)', () => {
            const payload: CursorPayload = { id: 'r', gl: 'fr', t: 100 };
            const cursor = signCursor(payload);
            const [encoded, sig] = cursor.split('.');

            // Change one character in the encoded payload – signature is now stale
            const tamperedEncoded = (encoded[0] === 'a' ? 'b' : 'a') + encoded.slice(1);
            expect(verifyCursor(`${tamperedEncoded}.${sig}`)).toBeNull();
        });

        it('should return null for a cursor signed with a different secret', () => {
            // Manually build a cursor signed with a different key
            const otherPayload: CursorPayload = { id: 's', gl: 'us', t: 42 };
            const json = JSON.stringify(otherPayload);
            const encoded = Buffer.from(json, 'utf8').toString('base64url');
            const wrongSig = createHmac('sha256', 'wrong-secret')
                .update(encoded)
                .digest('base64url');
            expect(verifyCursor(`${encoded}.${wrongSig}`)).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 5: encoded segment is not valid JSON
    //   JSON.parse throws → return null
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: invalid JSON payload', () => {
        it('should return null when the encoded segment decodes to non-JSON', () => {
            const notJson = Buffer.from('not-json-at-all', 'utf8').toString('base64url');
            // Sign it with the real secret so the HMAC check passes
            const secret = process.env.CURSOR_SIGNING_SECRET ?? 'dev-cursor-secret-change-in-prod';
            const sig = createHmac('sha256', secret).update(notJson).digest('base64url');
            expect(verifyCursor(`${notJson}.${sig}`)).toBeNull();
        });

        it('should return null when the encoded segment decodes to malformed JSON', () => {
            const malformed = Buffer.from('{id:"missing-quotes"}', 'utf8').toString('base64url');
            const secret = process.env.CURSOR_SIGNING_SECRET ?? 'dev-cursor-secret-change-in-prod';
            const sig = createHmac('sha256', secret).update(malformed).digest('base64url');
            expect(verifyCursor(`${malformed}.${sig}`)).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 6: payload missing required fields
    //   !payload.id || !payload.gl || typeof payload.t !== 'number' → null
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: missing required payload fields', () => {
        function makeCursorFromRaw(obj: object): string {
            const secret = process.env.CURSOR_SIGNING_SECRET ?? 'dev-cursor-secret-change-in-prod';
            const encoded = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
            const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
            return `${encoded}.${sig}`;
        }

        it('should return null when id is missing', () => {
            expect(verifyCursor(makeCursorFromRaw({ gl: 'us', t: 1 }))).toBeNull();
        });

        it('should return null when id is an empty string', () => {
            expect(verifyCursor(makeCursorFromRaw({ id: '', gl: 'us', t: 1 }))).toBeNull();
        });

        it('should return null when gl is missing', () => {
            expect(verifyCursor(makeCursorFromRaw({ id: 'x', t: 1 }))).toBeNull();
        });

        it('should return null when gl is an empty string', () => {
            expect(verifyCursor(makeCursorFromRaw({ id: 'x', gl: '', t: 1 }))).toBeNull();
        });

        it('should return null when t is missing', () => {
            expect(verifyCursor(makeCursorFromRaw({ id: 'x', gl: 'us' }))).toBeNull();
        });

        it('should return null when t is a string instead of a number', () => {
            expect(verifyCursor(makeCursorFromRaw({ id: 'x', gl: 'us', t: '1234' }))).toBeNull();
        });

        it('should return null when t is null', () => {
            expect(verifyCursor(makeCursorFromRaw({ id: 'x', gl: 'us', t: null }))).toBeNull();
        });

        it('should return null for a completely empty payload object', () => {
            expect(verifyCursor(makeCursorFromRaw({}))).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // verifyCursor – failure path 7: expectedGl mismatch
    //   payload.gl !== expectedGl → return null
    // -----------------------------------------------------------------------
    describe('verifyCursor – failure: expectedGl mismatch', () => {
        it('should return null when expectedGl does not match payload gl', () => {
            const cursor = signCursor({ id: 'u1', gl: 'us', t: 500 });
            expect(verifyCursor(cursor, 'eu')).toBeNull();
        });

        it('should return null when expectedGl is empty string and payload gl is non-empty', () => {
            const cursor = signCursor({ id: 'u2', gl: 'us', t: 500 });
            expect(verifyCursor(cursor, '')).toBeNull();
        });

        it('should be case-sensitive when matching gl', () => {
            const cursor = signCursor({ id: 'u3', gl: 'US', t: 500 });
            expect(verifyCursor(cursor, 'us')).toBeNull();
        });

        it('should return the payload when gl values match exactly', () => {
            const cursor = signCursor({ id: 'u4', gl: 'ap', t: 500 });
            expect(verifyCursor(cursor, 'ap')).not.toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // parsePagination – boundary inputs (supplementary)
    // -----------------------------------------------------------------------
    describe('parsePagination – boundary inputs', () => {
        it('should clamp negative limit to 1', () => {
            const req = { query: { limit: '-5' } } as unknown as Request;
            expect(parsePagination(req).limit).toBe(1);
        });

        it('should clamp negative offset to 0', () => {
            const req = { query: { offset: '-10' } } as unknown as Request;
            expect(parsePagination(req).offset).toBe(0);
        });

        it('should treat limit=1 as valid', () => {
            const req = { query: { limit: '1' } } as unknown as Request;
            expect(parsePagination(req).limit).toBe(1);
        });

        it('should treat limit=100 as valid (MAX_LIMIT boundary)', () => {
            const req = { query: { limit: '100' } } as unknown as Request;
            expect(parsePagination(req).limit).toBe(100);
        });

        it('should treat limit=101 as 100 (just above MAX_LIMIT)', () => {
            const req = { query: { limit: '101' } } as unknown as Request;
            expect(parsePagination(req).limit).toBe(100);
        });

        it('should treat offset=0 as valid (boundary)', () => {
            const req = { query: { offset: '0' } } as unknown as Request;
            expect(parsePagination(req).offset).toBe(0);
        });

        it('should not include cursor field when cursor query param is absent', () => {
            const req = { query: {} } as unknown as Request;
            expect(parsePagination(req).cursor).toBeUndefined();
        });

        it('should not include cursor field when cursor query param is empty string', () => {
            const req = { query: { cursor: '' } } as unknown as Request;
            expect(parsePagination(req).cursor).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // formatPage – boundary inputs (supplementary)
    // -----------------------------------------------------------------------
    describe('formatPage – boundary inputs', () => {
        it('should handle empty data array', () => {
            const result = formatPage([], 0, { limit: 10, offset: 0 });
            expect(result.data).toEqual([]);
            expect(result.meta.hasMore).toBe(false);
            expect(result.meta.total).toBe(0);
        });

        it('should have hasMore=false when offset+data.length equals total', () => {
            const result = formatPage([1, 2, 3], 3, { limit: 10, offset: 0 });
            expect(result.meta.hasMore).toBe(false);
        });

        it('should have hasMore=true when offset+data.length is less than total', () => {
            const result = formatPage([1], 5, { limit: 10, offset: 0 });
            expect(result.meta.hasMore).toBe(true);
        });

        it('should default offset to 0 when not provided in params', () => {
            const result = formatPage([1], 10, { limit: 10 });
            expect(result.meta.offset).toBe(0);
            expect(result.meta.hasMore).toBe(true);
        });

        it('should prefer nextCursor hasMore=true over offset calculation', () => {
            // Even if offset+data.length === total, a nextCursor forces hasMore=true
            const result = formatPage([1, 2], 2, { limit: 10, offset: 0 }, 'cursor-token');
            expect(result.meta.hasMore).toBe(true);
        });
    });
});
