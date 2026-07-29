# Push Notification A/B Testing with Per-Tenant Experiment Allocations

## Overview

This feature adds A/B testing capabilities for push notifications with per-tenant experiment allocations and per-variant open metrics. The system ensures legally required content cannot be varied across experiment variants through a configurable allowlist.

## Architecture

### Database Schema

#### `push_experiments`
Stores experiment metadata and status:
- `id`: UUID primary key
- `tenant_id`: Tenant identifier (VARCHAR 64)
- `experiment_key`: Unique experiment key per tenant
- `status`: draft, active, paused, completed
- `allocation_strategy`: weighted or uniform
- `started_at`, `ended_at`: Experiment timeline
- `created_at`, `updated_at`: Timestamps

#### `push_experiment_variants`
Stores experiment variants with templates:
- `id`: UUID primary key
- `experiment_id`: Foreign key to push_experiments
- `variant_key`: Unique variant key per experiment
- `weight`: Allocation percentage (0-100)
- `title_template`, `body_template`: Push notification templates with `{{variable}}` syntax
- `data_template`: Optional JSONB data template
- `is_control`: Boolean flag for control variant

#### `push_experiment_assignments`
Tracks user assignments and metrics:
- `id`: UUID primary key
- `experiment_id`, `variant_id`: Foreign keys
- `user_id`: Assigned user
- `assigned_at`, `delivered_at`, `opened_at`: Event timestamps
- Unique constraint on (experiment_id, user_id) for consistent assignment

#### `push_experiment_legal_allowlist`
Enforces legal content invariants:
- `id`: UUID primary key
- `tenant_id`: Tenant identifier
- `field_key`: Field name that cannot vary (e.g., 'disclaimer')
- `required_value`: Required constant value

### Service Layer

#### `PushExperimentsService`
Main service for experiment management:

**Key Methods:**
- `createExperiment()`: Creates a new experiment
- `addVariant()`: Adds a variant with legal content validation
- `activateExperiment()`: Starts the allocation phase
- `allocateAndRender()`: Allocates user to variant and renders template
- `recordDelivery()`: Records push delivery
- `recordOpen()`: Records push open
- `getMetrics()`: Retrieves experiment metrics including open rates
- `addLegalAllowlistEntry()`: Adds legal content field to allowlist

#### `PushExperimentsRepository`
Database access layer with CRUD operations for all tables.

## Security Assumptions

1. **Legal Content Enforcement**: Fields in the legal allowlist cannot vary across variants. The service validates this when adding variants.

2. **Deterministic Allocation**: User allocation is deterministic based on SHA-256 hash of user_id. This ensures:
   - Consistent assignment across multiple calls
   - No re-allocation when experiment is active
   - Predictable distribution for statistical analysis

3. **Experiment Status Guard**: Only active experiments can deliver notifications. Draft, paused, or completed experiments throw errors.

4. **Per-Tenant Isolation**: All experiments are scoped to tenant_id, preventing cross-tenant data leakage.

5. **Metric Emission**: All allocation, delivery, and open events emit metrics for observability and audit.

## Allocation Strategies

### Weighted Allocation
Uses cumulative weight buckets based on user hash:
- Variants with higher weight receive proportionally more users
- Total weights are normalized to 100%
- Example: Variant A (weight 60), Variant B (weight 40) → 60% of users get A

### Uniform Allocation
Simple round-robin based on user hash:
- All variants receive equal user distribution
- Deterministic based on hash modulo variant count
- Example: 2 variants → 50% each

## Template Rendering

Templates use `{{variable}}` syntax for substitution:
```
title_template: "Hello {{name}}"
body_template: "Your balance is {{balance}}"
```

Variables are passed to `allocateAndRender()` as a simple object:
```typescript
await service.allocateAndRender('tenant-1', 'test-exp', 'user-1', {
  name: 'John',
  balance: 1000
});
```

Missing variables are left as-is (e.g., `{{missing}}`).

## Metrics Emitted

- `push_experiment_created`: When experiment is created
- `push_experiment_variant_added`: When variant is added
- `push_experiment_activated`: When experiment is activated
- `push_experiment_allocation`: When user is allocated to variant
- `push_experiment_render`: When template is rendered
- `push_experiment_delivered`: When push is delivered
- `push_experiment_opened`: When push is opened
- `push_experiment_legal_allowlist_added`: When legal allowlist entry is added

All metrics include relevant tags (tenant_id, experiment_id, variant_id, etc.).

## Usage Example

```typescript
import { PushExperimentsService } from '../services/pushExperimentsService';
import { PushExperimentsRepository } from '../db/repositories/pushExperimentsRepository';

const repo = new PushExperimentsRepository(dbPool);
const service = new PushExperimentsService(repo);

// 1. Add legal content that cannot vary
await service.addLegalAllowlistEntry('tenant-1', 'disclaimer', 'Investment risks apply');

// 2. Create experiment
const experiment = await service.createExperiment('tenant-1', 'onboarding-push', 'weighted');

// 3. Add variants
const control = await service.addVariant(
  experiment.id,
  'control',
  50,
  'Welcome to Revora',
  'Start your investment journey today. Disclaimer: Investment risks apply',
  undefined,
  true
);

const variantA = await service.addVariant(
  experiment.id,
  'variant-a',
  50,
  'Grow your wealth with Revora',
  'Join thousands of investors. Disclaimer: Investment risks apply',
  undefined,
  false
);

// 4. Activate experiment
await service.activateExperiment(experiment.id);

// 5. Allocate and render for user
const result = await service.allocateAndRender(
  'tenant-1',
  'onboarding-push',
  'user-123',
  { name: 'Alice' }
);

// 6. Send push via FCM/APNs
await fcm.send({
  token: userFcmToken,
  notification: {
    title: result.rendered.title,
    body: result.rendered.body,
  },
  data: result.rendered.data,
});

// 7. Record delivery
await service.recordDelivery(result.assignment.id);

// 8. Record open (when user opens)
await service.recordOpen(result.assignment.id);

// 9. Get metrics
const metrics = await service.getMetrics(experiment.id);
console.log(`Overall open rate: ${metrics.overall_open_rate}`);
console.log('Variant metrics:', metrics.variant_metrics);
```

## Testing

Comprehensive test coverage in `src/services/__tests__/pushExperimentsService.test.ts`:

- Experiment creation and activation
- Variant addition with legal validation
- User allocation and template rendering
- Deterministic allocation consistency
- Delivery and open recording
- Metrics calculation
- Error cases (not found, not active, no variants)

Run tests:
```bash
npm test -- src/services/__tests__/pushExperimentsService.test.ts
```

## Statistical Power Considerations

For statistically significant results:
- Minimum sample size per variant: 1000 users
- Minimum detectable effect: 5% lift
- Confidence level: 95%
- Power: 80%

Use the metrics endpoint to monitor sample sizes and open rates before concluding experiments.

## Failure Paths

1. **Experiment Not Found**: Throws error when allocating to non-existent experiment
2. **Experiment Not Active**: Throws `ExperimentNotActiveError` for draft/paused/completed experiments
3. **No Variants**: Throws error if experiment has no variants
4. **Legal Content Violation**: Throws `LegalContentViolationError` if variant attempts to vary legal content
5. **Database Errors**: Propagated from repository layer

## Future Enhancements

- Automatic experiment stopping based on statistical significance
- Multi-armed bandit allocation for dynamic optimization
- Integration with existing push quiet hours service
- Webhook notifications for experiment completion
- A/B test result export and analysis tools
