import fs from 'fs';
import path from 'path';
import {
  AUDIT_LOG_GENESIS_HASH,
  computeAuditRowHash,
} from '../../../src/security/auditHashChain';

const dir = __dirname;

const row1Base = {
  id: '00000000-0000-4000-8000-000000000001',
  user_id: 'usr_101',
  action: 'user.login',
  resource: 'auth',
  details: 'User logged in successfully',
  ip_address: '192.168.1.1',
  user_agent: 'Mozilla/5.0 (Windows NT 10.0)',
  created_at: new Date('2026-01-15T10:00:00.000Z'),
  prev_hash: AUDIT_LOG_GENESIS_HASH,
};
const row1 = { ...row1Base, row_hash: computeAuditRowHash(row1Base) };

const row2Base = {
  id: '00000000-0000-4000-8000-000000000002',
  user_id: 'usr_101',
  action: 'offering.invest',
  resource: 'offering_99',
  details: 'Investment of 1000 USD',
  ip_address: '192.168.1.1',
  user_agent: 'Mozilla/5.0 (Windows NT 10.0)',
  created_at: new Date('2026-01-15T10:05:00.000Z'),
  prev_hash: row1.row_hash,
};
const row2 = { ...row2Base, row_hash: computeAuditRowHash(row2Base) };

const row3Base = {
  id: '00000000-0000-4000-8000-000000000003',
  user_id: 'usr_102',
  action: 'kyc.verify',
  resource: 'kyc_102',
  details: 'Tier 2 verified',
  ip_address: '10.0.0.5',
  user_agent: 'RevoraApp/1.0',
  created_at: new Date('2026-01-15T10:10:00.000Z'),
  prev_hash: row2.row_hash,
};
const row3 = { ...row3Base, row_hash: computeAuditRowHash(row3Base) };

const validExcerpt = [row1, row2, row3];

const validReceipt = {
  version: 'revora-audit-receipt-v1',
  published_at: '2026-01-15T10:15:00.000Z',
  start_prev_hash: AUDIT_LOG_GENESIS_HASH,
  expected_head_hash: row3.row_hash,
  total_rows: 3,
  start_id: row1.id,
  end_id: row3.id,
  signature: 'ed25519:abcdef1234567890',
};

const truncatedExcerpt = [row1, row2]; // missing row3

const tamperedExcerpt = [
  row1,
  {
    ...row2,
    details: 'Investment of 999999 USD (FORGED)', // modified payload
  },
  row3,
];

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'valid-receipt.json'), JSON.stringify(validReceipt, null, 2));
fs.writeFileSync(path.join(dir, 'valid-excerpt.json'), JSON.stringify(validExcerpt, null, 2));
fs.writeFileSync(path.join(dir, 'truncated-excerpt.json'), JSON.stringify(truncatedExcerpt, null, 2));
fs.writeFileSync(path.join(dir, 'tampered-excerpt.json'), JSON.stringify(tamperedExcerpt, null, 2));

console.log('Fixtures generated successfully in', dir);
