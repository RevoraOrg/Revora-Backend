// src/lib/offeringStatusGuard.ts

export type OfferingStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "published"
  | "archived";

/**
 * @notice Allowed status transitions map
 * @dev Acts as single source of truth for all transitions
 */
export const ALLOWED_TRANSITIONS: Record<
  OfferingStatus,
  OfferingStatus[]
> = {
  draft: ["pending_review"],
  pending_review: ["approved", "rejected"],
  approved: ["published"],
  rejected: ["draft"],
  published: ["archived"],
  archived: [],
};

/**
 * @notice Checks if a transition is valid
 */
export function canTransition(
  from: OfferingStatus,
  to: OfferingStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * @notice Enforces transition validity
 * @throws Error if invalid
 */
export function enforceTransition(
  from: OfferingStatus,
  to: OfferingStatus
) {
  if (!from || !to) {
    throw new Error("Invalid status input");
  }

  if (!ALLOWED_TRANSITIONS[from]) {
    throw new Error("Unknown current status");
  }

  if (!ALLOWED_TRANSITIONS[to] && to !== undefined) {
    throw new Error("Unknown target status");
  }

  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid transition from ${from} to ${to}`
    );
  }
}