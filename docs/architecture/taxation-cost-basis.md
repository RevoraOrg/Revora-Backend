# Taxation Reports: Cost-Basis Tracking Architecture

## Overview
Per-lot cost-basis tracking for Revora-Backend, supporting FIFO, LIFO, and HIFO disposal strategies.

## Architecture

### Data Model
```
CostBasisLot {
  id: UUID
  offeringId: UUID
  investorId: UUID
  acquisitionDate: Date
  quantity: Decimal
  costBasisPerUnit: Decimal
  totalCostBasis: Decimal
  disposalMethod: 'FIFO' | 'LIFO' | 'HIFO'
  remainingQuantity: Decimal
}
```

### Strategy Pattern
Each disposal strategy implements the `CostBasisStrategy` interface:
- **FIFOStrategy**: Sell oldest lots first (default for most jurisdictions)
- **LIFOStrategy**: Sell newest lots first (tax deferral optimization)
- **HIFOStrategy**: Sell highest cost-basis first (tax loss harvesting)

### Service Layer
```typescript
interface CostBasisService {
  trackAcquisition(lot: CreateCostBasisLotInput): Promise<CostBasisLot>
  calculateDisposal(offeringId: string, quantity: Decimal, strategy: DisposalMethod): Promise<DisposalResult[]>
  getRemainingLots(offeringId: string): Promise<CostBasisLot[]>
  generateTaxReport(investorId: string, year: number): Promise<TaxReport>
}
```

### API Endpoints
- `POST /offerings/:id/cost-basis/acquisition` — Record lot acquisition
- `POST /offerings/:id/cost-basis/disposal` — Calculate disposal with strategy
- `GET /investors/:id/cost-basis/lots` — Get remaining lots
- `GET /investors/:id/tax-report/:year` — Generate annual tax report

### Testing Strategy
- Unit tests: Strategy implementations (FIFO/LIFO/HIFO ordering)
- Integration tests: Database persistence with postgres testcontainers
- E2E tests: Full API flow from acquisition to tax report generation
