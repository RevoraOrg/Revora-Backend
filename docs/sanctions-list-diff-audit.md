# Sanctions List Diff and Audit Trail

## Overview

This feature provides an auditable diff of added/removed entities when Treasury updates OFAC or EU consolidated sanctions lists. Every list load is stored as a signed `sanctions_list_versions` row with raw payload hash and diff summary, producing a human-readable changelog per update.

## Architecture

### Database Schema

#### `sanctions_list_versions`
Stores each sanctions list load with audit metadata:
- `id`: UUID primary key
- `list_source`: Source identifier ('ofac', 'eu_consolidated', 'un_sc', 'uk_hmt')
- `version`: Version identifier (e.g., date-based or sequential)
- `raw_payload_hash`: SHA-256 hash of raw CSV/JSON payload for integrity
- `parse_hash`: SHA-256 hash of normalized parsed entries
- `entry_count`: Number of entities in this version
- `diff_summary`: JSONB summary of changes from previous version
- `diff_size`: Total number of entities changed (added + removed + modified)
- `previous_version_id`: Foreign key to previous version
- `signature_valid`: Whether the list signature was verified
- `loaded_at`, `created_at`: Timestamps

#### `sanctions_list_diff_details`
Stores detailed change records:
- `id`: UUID primary key
- `version_id`: Foreign key to sanctions_list_versions
- `entity_uid`: Unique identifier of the entity
- `entity_name`: Name of the entity
- `change_type`: 'added', 'removed', or 'modified'
- `previous_data`: JSONB of previous entity state (for removed/modified)
- `new_data`: JSONB of new entity state (for added/modified)
- `created_at`: Timestamp

### Service Layer

#### `SanctionsListDiffService`
Main service for diff computation and audit:

**Key Methods:**
- `computeDiff()`: Computes diff between two sets of entries
- `recordLoadWithDiff()`: Records a list load with automatic diff computation
- `generateChangelog()`: Generates human-readable changelog for a version
- `applyRetentionPolicy()`: Deletes versions older than retention period

#### `SanctionsListVersionsRepository`
Database access layer with CRUD operations for all tables.

## Security Assumptions

1. **Payload Integrity**: Raw payload hash is stored for every load to detect tampering
2. **Deterministic Diff**: Diff computation is deterministic based on entity UID
3. **No-Change Handling**: No-change updates are recorded but do not trigger alerts
4. **7-Year Retention**: Versions older than 7 years are deleted by scheduled job
5. **Compliance-Only Access**: Changelog download is restricted to compliance role

## Diff Computation

The diff algorithm uses entity UID as the primary key:

- **Added**: Entities in current list but not in previous list
- **Removed**: Entities in previous list but not in current list
- **Modified**: Entities in both lists with different data

Modified entities are detected by comparing normalized JSON representations of all fields (name, sdnType, programs, title, remarks, addresses). Options allow ignoring specific fields or using case-insensitive comparison.

## Metrics Emitted

- `sanctions.list.diff.size`: Gauge metric for number of entities changed
- `sanctions.list.diff.changes_detected`: Counter when changes are detected
- `sanctions.list.retention.applied`: Counter when retention policy deletes versions

All metrics include relevant tags (list_source, version, etc.).

## Usage Example

```typescript
import { SanctionsListDiffService } from '../services/sanctionsListDiffService';
import { SanctionsListVersionsRepository } from '../db/repositories/sanctionsListVersionsRepository';
import { OfacSanctionsLoader } from '../services/ofacSanctionsLoader';

const repo = new SanctionsListVersionsRepository(dbPool);
const diffService = new SanctionsListDiffService(repo);
const ofacLoader = new OfacSanctionsLoader(config);

// 1. Load sanctions list
const result = await ofacLoader.loadSanctions('2024-01-15');

// 2. Record with automatic diff computation
const version = await diffService.recordLoadWithDiff(
  'ofac',
  '2024-01-15',
  rawCsvData,
  result.entries,
  result.signatureValid,
  result.parseHash
);

console.log(`Diff size: ${version.diff_size}`);
console.log(`Summary:`, version.diff_summary);

// 3. Generate changelog for compliance audit
const changelog = await diffService.generateChangelog(version.id);
console.log(changelog);

// 4. Apply retention policy (run weekly)
const cutoffDate = new Date();
cutoffDate.setFullYear(cutoffDate.getFullYear() - 7);
const deleted = await diffService.applyRetentionPolicy(cutoffDate);
console.log(`Deleted ${deleted} old versions`);
```

## Changelog Format

The changelog is a human-readable text format:

```
Sanctions List Changelog
======================
Source: ofac
Version: 2024-01-15
Loaded At: 2024-01-15T10:30:00.000Z
Previous Version: version-123
Total Changes: 15

Added Entities (10):
  - Entity A (UID: 12345)
  - Entity B (UID: 12346)
  ...

Removed Entities (3):
  - Entity C (UID: 78901)
  - Entity D (UID: 78902)
  ...

Modified Entities (2):
  - Entity E (UID: 11111)
  - Entity F (UID: 11112)
```

## API Endpoint

### GET /api/compliance/sanctions-changelog/:versionId

Downloads the changelog for a specific version. Restricted to users with `compliance` role.

**Response:** Text/plain changelog content

**Security:** Requires authentication and compliance role authorization.

## Testing

Comprehensive test coverage in `src/services/__tests__/sanctionsListDiffService.test.ts`:

- Diff computation (added, removed, modified)
- Empty list handling
- No-change detection
- Field comparison (programs, addresses)
- Ignore fields option
- Case-insensitive comparison
- Load recording with and without previous version
- No-change alert suppression
- Changelog generation
- Retention policy application

Run tests:
```bash
npm test -- src/services/__tests__/sanctionsListDiffService.test.ts
```

## Retention Policy

Versions older than 7 years are automatically deleted by a scheduled job. This should be configured to run weekly:

```typescript
// Example scheduled job (run weekly)
async function runRetentionJob() {
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 7);
  const deleted = await diffService.applyRetentionPolicy(cutoffDate);
  logger.info(`Retention policy: deleted ${deleted} versions`);
}
```

## Failure Paths

1. **Version Not Found**: Throws error when generating changelog for non-existent version
2. **Database Errors**: Propagated from repository layer
3. **Invalid Diff Data**: Handles gracefully with empty diff arrays
4. **Signature Verification**: Stored but does not block recording (for audit trail)

## Integration with Existing OFAC Loader

The diff service integrates with the existing `OfacSanctionsLoader`:

1. Load the sanctions list using `OfacSanctionsLoader.loadSanctions()`
2. Pass the result to `SanctionsListDiffService.recordLoadWithDiff()`
3. The service automatically computes diff against previous version
4. Metrics are emitted for monitoring

## Future Enhancements

- Real-time alerts for high-impact changes (e.g., large number of additions)
- Integration with AML alert system for automatic case creation
- Webhook notifications for compliance teams
- Historical trend analysis of sanctions list changes
- Support for additional sanctions sources (UN, UK HMT, etc.)
- Automated diff-based entity risk score updates
