# Vesting Claim Security Fix

## Issue Summary

The POST /api/v1/vesting/claim endpoint had critical security vulnerabilities:

1. **Hard-coded mock data**: The service returned a fabricated schedule for ANY scheduleId
2. **No persistence**: Claims were only logged to console, not stored in the database
3. **No ownership validation**: Any authenticated user could claim against any scheduleId
4. **No double-claim prevention**: Repeated claims were never deducted, allowing unlimited claims

## Changes Made

### 1. Database Migration (`060_create_vesting_schedules.sql`)

Created a new table to store vesting schedules with proper ownership enforcement:

- `id`: UUID primary key
- `user_id`: Foreign key to users table with CASCADE delete
- `total_amount`: NUMERIC(20, 8) with CHECK constraint for non-negative values
- `claimed_amount`: NUMERIC(20, 8) tracking cumulative claims
- `last_claim_index`: Integer cursor for partial claim tracking
- `schedule_data`: JSONB storing vesting events
- Indexes on user_id and id for efficient lookups
- Trigger for automatic updated_at timestamp
- CHECK constraint ensuring claimed_amount <= total_amount

**Security features**:
- Ownership enforced at database level via user_id foreign key
- CASCADE delete prevents orphaned schedules
- CHECK constraints prevent invalid amounts

### 2. Vesting Schedule Repository (`vestingScheduleRepository.ts`)

New repository with ownership validation:

- `findByIdAndUserId(scheduleId, userId)`: Fetches schedule only if owned by user
- `create(input)`: Creates new schedules with ownership
- `updateClaim(input)`: Updates claim state with ownership validation in WHERE clause
- `existsAndOwned(scheduleId, userId)`: Checks ownership

**Security features**:
- All database operations include user_id in WHERE clauses
- Ownership validated before any read/write operations
- Repository-level enforcement prevents bypassing checks

### 3. Vesting Service Updates (`vestingService.ts`)

Replaced mock implementation with repository-backed logic:

- Constructor now accepts Pool for database connection
- Added `setRepository()` for test dependency injection
- `processPartialClaim()` now:
  - Validates userId is provided
  - Fetches schedule with ownership check via repository
  - Returns "Schedule not found or access denied" for unauthorized access
  - Persists claim state to database
  - Handles race conditions where schedule is deleted mid-operation
- Added `createSchedule()` for schedule creation

**Security features**:
- Ownership validated before processing any claim
- Claims persisted to database, preventing double-claiming
- Explicit error messages for access denied scenarios
- Handles missing authentication (empty userId)

### 4. Router Updates (`vesting.ts`)

Updated to pass Pool to VestingService constructor:

```typescript
const vestingService = new VestingService(pool);
```

This ensures the service has database access in production.

### 5. Test Updates

#### Service Tests (`vestingService.test.ts`)
Completely rewritten to test ownership and persistence:

- Tests for successful claims with ownership validation
- Tests for access denied when user doesn't own schedule
- Tests for schedule not found scenarios
- Tests for authentication required (missing userId)
- Tests for persistence failure handling
- Tests for double-claim prevention
- Tests for createSchedule

#### Repository Tests (`vestingScheduleRepository.test.ts`)
New comprehensive test suite:

- Tests for findByIdAndUserId with ownership checks
- Tests for create operations
- Tests for updateClaim with ownership validation in WHERE clause
- Tests for existsAndOwned
- Tests for empty schedule handling

#### Route Tests (`vesting.test.ts`)
Updated mock to include `setRepository` method for compatibility.

## Security Assumptions

1. **Database-level ownership**: user_id foreign key with CASCADE ensures data integrity
2. **Repository-level validation**: All operations include user_id in queries
3. **Service-level checks**: Explicit ownership validation before processing
4. **Persistence**: Claims are stored in database, not in-memory
5. **Authentication**: Route requires valid session via createRequireAuth middleware

## Testing Coverage

- **Ownership validation**: Tests verify users cannot claim schedules they don't own
- **Persistence**: Tests verify claims are persisted and double-claiming is prevented
- **Authentication**: Tests verify missing userId is rejected
- **Race conditions**: Tests handle schedule deletion mid-operation
- **Edge cases**: Tests for empty schedules, zero claims, full claims, over-claims

## Migration Instructions

1. Run the migration to create the vesting_schedules table:
   ```bash
   npm run migrate
   ```

2. The migration will create the table, indexes, and triggers automatically.

3. Existing vesting schedules (if any) need to be migrated manually or seeded via the new createSchedule API.

## Verification

To verify the fix:

1. Run the test suite:
   ```bash
   npm test -- src/services/vestingService.test.ts
   npm test -- src/db/repositories/vestingScheduleRepository.test.ts
   npm test -- src/routes/vesting.test.ts
   ```

2. Test the endpoint manually:
   - Create a vesting schedule for user-1
   - Attempt to claim with user-1 (should succeed)
   - Attempt to claim the same schedule with user-2 (should fail with "access denied")
   - Attempt to claim more than available (should fail with "exceeds available")
   - Claim again with user-1 (should deduct from remaining amount)

## Breaking Changes

- The VestingService constructor now requires a Pool parameter in production
- The mock implementation has been removed - all operations now require database
- Error messages changed from "Schedule not found" to "Schedule not found or access denied" to be more explicit about ownership failures
