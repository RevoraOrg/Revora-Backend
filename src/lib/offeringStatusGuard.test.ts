import {
  ALLOWED_TRANSITIONS,
  canTransition,
  enforceTransition,
  normalizeOfferingStatus,
} from './offeringStatusGuard';

describe('offeringStatusGuard', () => {
  it('normalizes offering status aliases used across the backend', () => {
    expect(normalizeOfferingStatus('published')).toBe('open');
    expect(normalizeOfferingStatus('archived')).toBe('completed');
    expect(normalizeOfferingStatus('ACTIVE')).toBe('active');
    expect(normalizeOfferingStatus('unknown')).toBeNull();
  });

  it('documents the allowed lifecycle transitions', () => {
    expect(ALLOWED_TRANSITIONS.draft).toEqual(['active', 'open', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.closed).toEqual(['completed']);
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
  });

  it('allows same-state and valid forward transitions', () => {
    expect(canTransition('active', 'active')).toBe(true);
    expect(canTransition('active', 'closed')).toBe(true);
    expect(canTransition('paused', 'open')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('completed', 'open')).toBe(false);
  });

  it('throws structured bad-request errors for invalid status input', () => {
    expect(() => enforceTransition(undefined, undefined)).toThrow('Offering status is invalid');
    expect(() => enforceTransition('mystery', 'active')).toThrow(
      'Offering current status is invalid',
    );
    expect(() => enforceTransition('active', 'mystery')).toThrow(
      'Offering target status is invalid',
    );
  });

  it('throws a structured conflict error for incompatible transitions', () => {
    expect(() => enforceTransition('closed', 'open')).toThrow(
      'Offering status transition is not allowed',
    );
  });
});
