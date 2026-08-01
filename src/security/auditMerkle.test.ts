/**
 * Tests for auditMerkle.ts — day-scoped Merkle root helpers (issue #721).
 */

import { computeMerkleRoot, hashPair, utcDayBounds } from './auditMerkle';
import { createHash } from 'crypto';

describe('auditMerkle', () => {
  describe('hashPair', () => {
    it('is deterministic and order-sensitive', () => {
      const a = hashPair('aa', 'bb');
      const b = hashPair('aa', 'bb');
      const c = hashPair('bb', 'aa');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('computeMerkleRoot', () => {
    it('returns null for an empty leaf list', () => {
      expect(computeMerkleRoot([])).toBeNull();
    });

    it('returns the single leaf unchanged', () => {
      const leaf = createHash('sha256').update('only').digest('hex');
      expect(computeMerkleRoot([leaf])).toBe(leaf);
    });

    it('builds a two-leaf root', () => {
      const left = createHash('sha256').update('L').digest('hex');
      const right = createHash('sha256').update('R').digest('hex');
      expect(computeMerkleRoot([left, right])).toBe(hashPair(left, right));
    });

    it('promotes an odd leaf unchanged', () => {
      const a = createHash('sha256').update('a').digest('hex');
      const b = createHash('sha256').update('b').digest('hex');
      const c = createHash('sha256').update('c').digest('hex');
      // Level1: hash(a,b), c  →  root: hash(hash(a,b), c)
      expect(computeMerkleRoot([a, b, c])).toBe(hashPair(hashPair(a, b), c));
    });

    it('is order-sensitive across the full list', () => {
      const leaves = ['a', 'b', 'c', 'd'].map((x) =>
        createHash('sha256').update(x).digest('hex'),
      );
      const root = computeMerkleRoot(leaves)!;
      const reversed = computeMerkleRoot([...leaves].reverse())!;
      expect(root).not.toBe(reversed);
    });
  });

  describe('utcDayBounds', () => {
    it('returns a half-open UTC day interval', () => {
      const { start, end } = utcDayBounds(new Date('2026-07-31T15:30:00Z'));
      expect(start.toISOString()).toBe('2026-07-31T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });
  });
});
