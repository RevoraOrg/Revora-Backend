# Revenue Report Ingestion Validation

## Overview
The Revenue Report Ingestion system allows startup issuers to submit periodic revenue reports. These reports are critical for the automated distribution engine. To ensure data integrity and security, the ingestion endpoint implements several layers of validation.

## Security Assumptions
- **Authentication**: All requests must be authenticated via a Bearer JWT. The user's identity (`issuer_id`) is extracted from the token.
- **Ownership**: The authenticated issuer must be the primary owner of the offering for which the report is being submitted.
- **Role-Based Access**: Currently, any authenticated user with an `issuer` role can submit reports for offerings they own.

## Validation Rules

### 1. Amount Validation
- **Format**: Must be a valid positive decimal string.
- **Precision**: Supports up to 10 decimal places (matching `NUMERIC(30,10)` in the database).
- **Constraints**: Must be strictly greater than zero.

### 2. Period Validation
- **Logic**: The `period_end` date must be strictly after the `period_start` date.
- **Overlaps**: The system enforces a **strict non-overlap** policy. A new revenue report cannot be submitted if its time period (start to end) overlaps with any existing report for the same offering. This prevents double-counting of revenue.

## API Behavior and Error Codes

| Error Case | HTTP Status | Error Message Example |
|------------|-------------|-----------------------|
| Missing Auth | 401 | `Unauthorized` |
| Wrong Issuer | 403 | `Unauthorized: Issuer does not own offering...` |
| Invalid Amount | 400 | `Invalid revenue amount format...` |
| End < Start | 400 | `Invalid period: end date must be strictly after...` |
| Period Overlap | 409 | `A revenue report already exists that overlaps...` |
| Offering Not Found | 404 | `Offering ... not found` |

## Implementation Details
- **Handler**: `src/handlers/revenueHandler.ts`
- **Service**: `src/services/revenueService.ts`
- **Repository**: `src/db/repositories/revenueReportRepository.ts`
- **Table**: `revenue_reports`
