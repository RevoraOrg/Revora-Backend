/**
 * Regression coverage for the failure paths of src/lib/offeringStatusGuard.ts
 * (Issue #1041). The guard's `normalizeOfferingStatus` returns `null` for any
 * non-string / unknown value and `enforceTransition` turns that null into one of
 * three structured errors; these tests pin that contract and the boundary inputs
 * around it.
 */
import {
  ALLOWED_TRANSITIONS,
  OFFERING_STATUS_ALIASES,
  buildInvalidStatusInputError,
  buildInvalidTransitionError,
  buildUnknownStatusError,
  canTransition,
  enforceTransition,
  isKnownOfferingStatus,
  normalizeOfferingStatus,
  type OfferingStatus,
} from './offeringStatusGuard';
import { AppError, ErrorCode } from './errors';

const ALL_STATUSES: OfferingStatus[] = [
  'draft',
  'active',
  'open',
  'paused',
  'closed',
  'completed',
  'cancelled',
];

function captureError(fn: () => void): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the guard to throw');
}

describe('normalizeOfferingStatus failure handling', () => {
  it('returns null for every non-string input', () => {
    const nonStrings: unknown[] = [undefined, null, 42, 0, true, false, {}, [], () => undefined];
    for (const input of nonStrings) {
      expect(normalizeOfferingStatus(input)).toBeNull();
    }
  });

  it('returns null for empty, whitespace-only and unknown strings', () => {
    expect(normalizeOfferingStatus('')).toBeNull();
    expect(normalizeOfferingStatus('   ')).toBeNull();
    expect(normalizeOfferingStatus('mystery')).toBeNull();
    expect(normalizeOfferingStatus('open ')).toBe('open');
    expect(normalizeOfferingStatus('  PUBLISHED ')).toBe('open');
  });

  it('narrows known statuses only', () => {
    expect(isKnownOfferingStatus('open')).toBe(true);
    expect(isKnownOfferingStatus('published')).toBe(true);
    expect(isKnownOfferingStatus('mystery')).toBe(false);
    expect(isKnownOfferingStatus(42)).toBe(false);
    expect(isKnownOfferingStatus(null)).toBe(false);
  });

  it('keeps the alias map stable for the two legacy names', () => {
    expect(OFFERING_STATUS_ALIASES.published).toBe('open');
    expect(OFFERING_STATUS_ALIASES.archived).toBe('completed');
  });
});

describe('ALLOWED_TRANSITIONS table', () => {
  it('has a row for every status in the union', () => {
    expect(new Set(Object.keys(ALLOWED_TRANSITIONS))).toEqual(new Set(ALL_STATUSES));
  });

  it('only points at known, self-normalising statuses', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(normalizeOfferingStatus(from)).toBe(from);
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
        expect(normalizeOfferingStatus(target)).toBe(target);
      }
    }
  });

  it('treats completed and cancelled as terminal and closed as completion-only', () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(ALLOWED_TRANSITIONS.closed).toEqual(['completed']);
  });
});

describe('enforceTransition error contract', () => {
  it('rejects when both sides are missing or non-string with a bare 400', () => {
    const pairs: Array<[unknown, unknown]> = [
      [undefined, undefined],
      [null, null],
      ['mystery', 'nope'],
      [42, {}],
      [{}, []],
    ];

    for (const [from, to] of pairs) {
      const error = captureError(() => enforceTransition(from, to));
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.BAD_REQUEST);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Offering status is invalid');
      expect(error.details).toBeUndefined();
    }
  });

  it('reports an unknown current status and preserves the raw value', () => {
    const error = captureError(() => enforceTransition('mystery', 'active'));
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Offering current status is invalid');
    expect(error.details).toEqual({ status: 'mystery' });
  });

  it('reports an unknown target status, normalising non-strings to null', () => {
    const stringError = captureError(() => enforceTransition('active', 'mystery'));
    expect(stringError.message).toBe('Offering target status is invalid');
    expect(stringError.details).toEqual({ status: 'mystery' });

    const nullError = captureError(() => enforceTransition('active', null));
    expect(nullError.message).toBe('Offering target status is invalid');
    expect(nullError.details).toEqual({ status: null });
  });

  it('reports an illegal transition as a 409 conflict carrying both sides', () => {
    const error = captureError(() => enforceTransition('closed', 'open'));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(ErrorCode.CONFLICT);
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('Offering status transition is not allowed');
    expect(error.details).toEqual({ from: 'closed', to: 'open' });
  });

  it('accepts every transition the table allows, including aliased inputs', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const target of targets) {
        expect(() => enforceTransition(from, target)).not.toThrow();
      }
    }
    expect(() => enforceTransition('published', 'paused')).not.toThrow();
    expect(() => enforceTransition('archived', 'archived')).not.toThrow();
  });

  it('allows a self-transition for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
      expect(() => enforceTransition(status, status)).not.toThrow();
    }
  });
});

describe('guard error factories', () => {
  it('buildInvalidStatusInputError is a bare BAD_REQUEST', () => {
    const error = buildInvalidStatusInputError();
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(error.statusCode).toBe(400);
    expect(error.details).toBeUndefined();
  });

  it('buildUnknownStatusError records which side failed', () => {
    expect(buildUnknownStatusError('current', 'x').message).toBe('Offering current status is invalid');
    expect(buildUnknownStatusError('target', 'x').message).toBe('Offering target status is invalid');
    expect(buildUnknownStatusError('target', 7).details).toEqual({ status: null });
  });

  it('buildInvalidTransitionError is a CONFLICT carrying both statuses', () => {
    const error = buildInvalidTransitionError('completed', 'open');
    expect(error.code).toBe(ErrorCode.CONFLICT);
    expect(error.statusCode).toBe(409);
    expect(error.details).toEqual({ from: 'completed', to: 'open' });
  });
});
