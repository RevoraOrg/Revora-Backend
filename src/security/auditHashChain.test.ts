import {
  AUDIT_LOG_GENESIS_HASH,
  AuditLogChainRow,
  buildAuditCanonicalPayload,
  computeAuditRowHash,
  verifyAuditHashChain,
  verifyAuditLogIntegrity,
} from './auditHashChain';

function makeRow(
  overrides: Partial<AuditLogChainRow> & Pick<AuditLogChainRow, 'id' | 'action' | 'created_at'>,
  prevHash: string = AUDIT_LOG_GENESIS_HASH,
): AuditLogChainRow {
  const base: Omit<AuditLogChainRow, 'row_hash'> = {
    id: overrides.id,
    user_id: overrides.user_id ?? null,
    action: overrides.action,
    resource: overrides.resource ?? null,
    details: overrides.details ?? null,
    ip_address: overrides.ip_address ?? null,
    user_agent: overrides.user_agent ?? null,
    created_at: overrides.created_at,
    prev_hash: overrides.prev_hash ?? prevHash,
  };

  return {
    ...base,
    row_hash: overrides.row_hash ?? computeAuditRowHash(base),
  };
}

function buildValidChain(count: number): AuditLogChainRow[] {
  const rows: AuditLogChainRow[] = [];
  let prev = AUDIT_LOG_GENESIS_HASH;

  for (let i = 0; i < count; i++) {
    const row = makeRow(
      {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        action: `action-${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        details: `event-${i}`,
      },
      prev,
    );
    rows.push(row);
    prev = row.row_hash;
  }

  return rows;
}

describe('auditHashChain', () => {
  describe('AUDIT_LOG_GENESIS_HASH', () => {
    it('matches the migration genesis anchor', () => {
      expect(AUDIT_LOG_GENESIS_HASH).toBe(
        'bee58147dc813f93e3b43277b5da53c1a1620f2258f953b75a25fe5774f999be',
      );
    });
  });

  describe('buildAuditCanonicalPayload', () => {
    it('serializes nullable fields as empty strings', () => {
      const row = makeRow({
        id: 'row-1',
        action: 'login',
        created_at: new Date('2026-01-15T10:00:00.000Z'),
      });

      expect(buildAuditCanonicalPayload(row)).toBe(
        [
          'row-1',
          '',
          'login',
          '',
          '',
          '',
          '',
          String(new Date('2026-01-15T10:00:00.000Z').getTime()),
          AUDIT_LOG_GENESIS_HASH,
        ].join('|'),
      );
    });

    it('strips CIDR suffix from ip addresses', () => {
      const row = makeRow({
        id: 'row-2',
        action: 'invest',
        created_at: new Date('2026-01-15T10:00:00.000Z'),
        ip_address: '10.0.0.1/32',
      });

      expect(buildAuditCanonicalPayload(row)).toContain('|10.0.0.1|');
    });
  });

  describe('verifyAuditHashChain', () => {
    it('accepts an empty chain', () => {
      const result = verifyAuditHashChain([]);
      expect(result.valid).toBe(true);
      expect(result.totalRows).toBe(0);
      expect(result.verifiedRows).toBe(0);
      expect(result.headHash).toBeNull();
    });

    it('accepts a valid single-row chain', () => {
      const rows = buildValidChain(1);
      const result = verifyAuditHashChain(rows);

      expect(result.valid).toBe(true);
      expect(result.verifiedRows).toBe(1);
      expect(rows[0].prev_hash).toBe(AUDIT_LOG_GENESIS_HASH);
      expect(result.headHash).toBe(rows[0].row_hash);
    });

    it('accepts a valid multi-row chain end to end', () => {
      const rows = buildValidChain(5);
      const result = verifyAuditHashChain(rows);

      expect(result.valid).toBe(true);
      expect(result.verifiedRows).toBe(5);
      expect(result.headHash).toBe(rows[4].row_hash);

      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].prev_hash).toBe(rows[i - 1].row_hash);
      }
    });

    it('verifies rows with identical timestamps using id tie-breaker', () => {
      const sharedTime = new Date('2026-01-01T00:00:00.000Z');
      const rowA = makeRow({
        id: 'a-row',
        action: 'first',
        created_at: sharedTime,
      });
      const rowB = makeRow(
        {
          id: 'b-row',
          action: 'second',
          created_at: sharedTime,
        },
        rowA.row_hash,
      );

      const result = verifyAuditHashChain([rowB, rowA]);
      expect(result.valid).toBe(true);
      expect(result.verifiedRows).toBe(2);
    });

    it('detects mid-chain tampering when action is edited', () => {
      const rows = buildValidChain(4);
      const tampered = rows.map((row, index) =>
        index === 2 ? { ...row, action: 'tampered-action' } : row,
      );

      const result = verifyAuditHashChain(tampered);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('hash_mismatch');
      expect(result.failure?.rowId).toBe(rows[2].id);
      expect(result.failure?.index).toBe(2);
      expect(result.verifiedRows).toBe(2);
    });

    it('detects tampering when details are edited but row_hash is unchanged', () => {
      const rows = buildValidChain(3);
      const tampered = rows.map((row, index) =>
        index === 1 ? { ...row, details: 'forged-details' } : row,
      );

      const result = verifyAuditHashChain(tampered);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('hash_mismatch');
      expect(result.failure?.rowId).toBe(rows[1].id);
    });

    it('detects a deleted row as a chain gap', () => {
      const rows = buildValidChain(4);
      const withoutMiddle = rows.filter((_, index) => index !== 2);

      const result = verifyAuditHashChain(withoutMiddle);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('gap_detected');
      expect(result.failure?.rowId).toBe(rows[3].id);
      expect(result.failure?.message).toMatch(/deleted row|gap/i);
    });

    it('detects replaced row_hash without matching payload', () => {
      const rows = buildValidChain(2);
      const tampered = [
        rows[0],
        {
          ...rows[1],
          row_hash: 'f'.repeat(64),
        },
      ];

      const result = verifyAuditHashChain(tampered);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('hash_mismatch');
    });

    it('detects missing hash columns', () => {
      const rows = buildValidChain(1);
      const tampered = [{ ...rows[0], row_hash: '' }];

      const result = verifyAuditHashChain(tampered);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('missing_hashes');
    });

    it('detects broken genesis when first row prev_hash is wrong', () => {
      const rows = buildValidChain(2);
      const tampered = [{ ...rows[0], prev_hash: 'a'.repeat(64) }, rows[1]];

      const result = verifyAuditHashChain(tampered);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('broken_chain');
      expect(result.failure?.index).toBe(0);
    });

    it('simulates post-migration backfill producing a valid chain', () => {
      const legacyRows = [
        {
          id: 'legacy-1',
          user_id: null,
          action: 'login',
          resource: 'auth',
          details: null,
          ip_address: null,
          user_agent: null,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'legacy-2',
          user_id: 'user-1',
          action: 'invest',
          resource: 'offering-1',
          details: '1000',
          ip_address: '192.168.0.10',
          user_agent: 'jest',
          created_at: new Date('2026-01-01T00:00:01.000Z'),
        },
      ];

      let prev = AUDIT_LOG_GENESIS_HASH;
      const chained = legacyRows.map((legacy) => {
        const row = makeRow(
          {
            ...legacy,
            id: legacy.id,
            action: legacy.action,
            created_at: legacy.created_at,
          },
          prev,
        );
        prev = row.row_hash;
        return row;
      });

      const result = verifyAuditHashChain(chained);
      expect(result.valid).toBe(true);
      expect(result.verifiedRows).toBe(2);
    });
  });

  describe('verifyAuditLogIntegrity', () => {
    it('loads rows from the database and verifies the chain', async () => {
      const rows = buildValidChain(2);
      const pool = {
        query: jest.fn().mockResolvedValue({
          rows: rows.map((row) => ({
            ...row,
            ip_address: row.ip_address,
          })),
        }),
      };

      const result = await verifyAuditLogIntegrity(pool);

      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM audit_logs'));
      expect(result.valid).toBe(true);
      expect(result.verifiedRows).toBe(2);
    });

    it('returns failure when database rows are tampered', async () => {
      const rows = buildValidChain(3);
      const tampered = rows.map((row, index) =>
        index === 1 ? { ...row, resource: 'tampered' } : row,
      );

      const pool = {
        query: jest.fn().mockResolvedValue({ rows: tampered }),
      };

      const result = await verifyAuditLogIntegrity(pool);

      expect(result.valid).toBe(false);
      expect(result.failure?.type).toBe('hash_mismatch');
    });

    it('parses string timestamps returned by the database driver', async () => {
      const rows = buildValidChain(1);
      const pool = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              ...rows[0],
              created_at: rows[0].created_at.toISOString(),
            },
          ],
        }),
      };

      const result = await verifyAuditLogIntegrity(pool);
      expect(result.valid).toBe(true);
    });
  });
});
