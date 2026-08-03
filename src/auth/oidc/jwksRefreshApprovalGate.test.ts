import {
  ALL_ISSUERS_SCOPE,
  ApprovalAlreadyApprovedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalSelfApprovalError,
  DuplicateApprovalError,
  JwksRefreshApprovalGate,
  JWKS_REFRESH_APPROVAL_TTL_MS,
} from './jwksRefreshApprovalGate';

describe('JwksRefreshApprovalGate', () => {
  let now: number;
  let gate: JwksRefreshApprovalGate;
  let idCounter: number;

  beforeEach(() => {
    now = 1_000_000;
    idCounter = 0;
    gate = new JwksRefreshApprovalGate({
      ttlMs: JWKS_REFRESH_APPROVAL_TTL_MS,
      now: () => now,
      randomId: () => `approval-${++idCounter}`,
    });
  });

  describe('propose (step 1)', () => {
    it('creates a pending approval for a specific issuer', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      expect(approval).toMatchObject({
        approvalId: 'approval-1',
        scope: 'https://idp.example.com',
        issuer: 'https://idp.example.com',
        proposer: 'admin-a',
        status: 'pending_second_approval',
      });
      expect(approval.expiresAt).toBe(now + JWKS_REFRESH_APPROVAL_TTL_MS);
    });

    it('creates a pending approval for the global (all issuers) scope when issuer omitted', () => {
      const approval = gate.propose('admin-a');
      expect(approval.scope).toBe(ALL_ISSUERS_SCOPE);
      expect(approval.issuer).toBeUndefined();
    });

    it('rejects a duplicate active proposal for the same scope', () => {
      gate.propose('admin-a', 'https://idp.example.com');
      try {
        gate.propose('admin-b', 'https://idp.example.com');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateApprovalError);
        expect((err as DuplicateApprovalError).existingApprovalId).toBe('approval-1');
      }
    });

    it('allows a new proposal for a different scope while another is pending', () => {
      gate.propose('admin-a', 'https://idp.example.com');
      const second = gate.propose('admin-a', 'https://idp2.example.com');
      expect(second.scope).toBe('https://idp2.example.com');
    });

    it('allows a new proposal once the previous one expired', () => {
      gate.propose('admin-a', 'https://idp.example.com');
      now += JWKS_REFRESH_APPROVAL_TTL_MS + 1;
      const second = gate.propose('admin-a', 'https://idp.example.com');
      expect(second.approvalId).toBe('approval-2');
    });

    it('allows a new proposal once the previous one was executed', () => {
      const first = gate.propose('admin-a', 'https://idp.example.com');
      gate.approve(first.approvalId, 'admin-b');
      const second = gate.propose('admin-a', 'https://idp.example.com');
      expect(second.approvalId).toBe('approval-2');
    });

    it('generates unique approval ids by default', () => {
      const fresh = new JwksRefreshApprovalGate();
      const a = fresh.propose('admin-a', 'issuer-1');
      const b = fresh.propose('admin-b', 'issuer-2');
      expect(a.approvalId).not.toBe(b.approvalId);
    });
  });

  describe('approve (step 2)', () => {
    it('approves when a distinct admin acts within the window', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      const result = gate.approve(approval.approvalId, 'admin-b');
      expect(result.status).toBe('approved');
      expect(result.approvalId).toBe(approval.approvalId);
    });

    it('rejects self-approval by the proposer', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      expect(() => gate.approve(approval.approvalId, 'admin-a'))
        .toThrow(ApprovalSelfApprovalError);
    });

    it('rejects an unknown approval id', () => {
      expect(() => gate.approve('nope', 'admin-b'))
        .toThrow(ApprovalNotFoundError);
    });

    it('rejects an expired approval and removes it', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      now += JWKS_REFRESH_APPROVAL_TTL_MS + 1;
      expect(() => gate.approve(approval.approvalId, 'admin-b'))
        .toThrow(ApprovalExpiredError);
      expect(gate.get(approval.approvalId)).toBeUndefined();
    });

    it('rejects approving an already-executed approval', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      gate.approve(approval.approvalId, 'admin-b');
      expect(() => gate.approve(approval.approvalId, 'admin-c'))
        .toThrow(ApprovalAlreadyApprovedError);
    });

    it('rejects at exactly the expiry boundary (now === expiresAt is still valid)', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      now = approval.expiresAt;
      expect(() => gate.approve(approval.approvalId, 'admin-b')).not.toThrow();
    });
  });

  describe('read / sweep helpers', () => {
    it('returns undefined for unknown or expired approvals via get()', () => {
      expect(gate.get('unknown')).toBeUndefined();
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      now += JWKS_REFRESH_APPROVAL_TTL_MS + 1;
      expect(gate.get(approval.approvalId)).toBeUndefined();
    });

    it('returns an approved approval via get() even after its window', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      gate.approve(approval.approvalId, 'admin-b');
      now += 10 * 60 * 1000;
      expect(gate.get(approval.approvalId)?.status).toBe('approved');
    });

    it('cleanupExpired removes only expired pending approvals', () => {
      const fresh = gate.propose('admin-a', 'https://a.example.com');
      const stale = gate.propose('admin-b', 'https://b.example.com');
      const executed = gate.propose('admin-c', 'https://c.example.com');
      gate.approve(executed.approvalId, 'admin-d');

      now += JWKS_REFRESH_APPROVAL_TTL_MS + 1;
      const removed = gate.cleanupExpired();

      expect(removed).toBe(2);
      expect(gate.get(fresh.approvalId)).toBeUndefined();
      expect(gate.get(stale.approvalId)).toBeUndefined();
      expect(gate.get(executed.approvalId)?.status).toBe('approved');
    });

    it('reset clears all approvals', () => {
      const approval = gate.propose('admin-a', 'https://idp.example.com');
      gate.reset();
      expect(gate.get(approval.approvalId)).toBeUndefined();
    });
  });
});
