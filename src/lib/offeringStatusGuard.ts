import { AppError, Errors } from './errors';

export type OfferingStatus =
  | 'draft'
  | 'active'
  | 'open'
  | 'paused'
  | 'closed'
  | 'completed'
  | 'cancelled';

export const OFFERING_STATUS_ALIASES: Record<string, OfferingStatus> = {
  draft: 'draft',
  active: 'active',
  open: 'open',
  paused: 'paused',
  closed: 'closed',
  completed: 'completed',
  cancelled: 'cancelled',
  published: 'open',
  archived: 'completed',
};

/**
 * Allowed lifecycle transitions for catalog/offering reconciliation.
 * `active` and `open` are both preserved because both appear in the current codebase.
 */
export const ALLOWED_TRANSITIONS: Record<OfferingStatus, readonly OfferingStatus[]> = {
  draft: ['active', 'open', 'cancelled'],
  active: ['open', 'paused', 'closed', 'completed', 'cancelled'],
  open: ['paused', 'closed', 'completed', 'cancelled'],
  paused: ['open', 'closed', 'cancelled'],
  closed: ['completed'],
  completed: [],
  cancelled: [],
};

export function normalizeOfferingStatus(status: unknown): OfferingStatus | null {
  if (typeof status !== 'string') {
    return null;
  }

  const normalized = OFFERING_STATUS_ALIASES[status.trim().toLowerCase()];
  return normalized ?? null;
}

export function isKnownOfferingStatus(status: unknown): status is OfferingStatus {
  return normalizeOfferingStatus(status) !== null;
}

export function canTransition(from: OfferingStatus, to: OfferingStatus): boolean {
  if (from === to) {
    return true;
  }

  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function buildInvalidStatusInputError(): AppError {
  return Errors.badRequest('Offering status is invalid');
}

export function buildUnknownStatusError(role: 'current' | 'target', status: unknown): AppError {
  return Errors.badRequest(`Offering ${role} status is invalid`, {
    status: typeof status === 'string' ? status : null,
  });
}

export function buildInvalidTransitionError(from: OfferingStatus, to: OfferingStatus): AppError {
  return Errors.conflict('Offering status transition is not allowed', {
    from,
    to,
  });
}

export function enforceTransition(from: unknown, to: unknown): void {
  const normalizedFrom = normalizeOfferingStatus(from);
  const normalizedTo = normalizeOfferingStatus(to);

  if (!normalizedFrom && !normalizedTo) {
    throw buildInvalidStatusInputError();
  }

  if (!normalizedFrom) {
    throw buildUnknownStatusError('current', from);
  }

  if (!normalizedTo) {
    throw buildUnknownStatusError('target', to);
  }

  if (!canTransition(normalizedFrom, normalizedTo)) {
    throw buildInvalidTransitionError(normalizedFrom, normalizedTo);
  }
}
