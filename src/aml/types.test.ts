import { 
  AMLRuleType, 
  OfacEntityType, 
  OfacCounterparty, 
  AMLCaseStatus, 
  OFACReviewStatus 
} from './types';

describe('AML Types Behavior Coverage', () => {
  describe('AMLRuleType', () => {
    it('accepts all primary rule types', () => {
      const validTypes: AMLRuleType[] = [
        'velocity',
        'structuring',
        'geo_mismatch',
        'amount_threshold',
        'sanctions_screening',
        'ofac_counterparty_screening'
      ];
      
      expect(validTypes).toContain('velocity');
      expect(validTypes).toHaveLength(6);
    });

    it('rejects invalid rule types at compile time', () => {
      // @ts-expect-error - testing invalid rule type
      const invalidType: AMLRuleType = 'unknown_rule_type';
      expect(invalidType).toBe('unknown_rule_type');
    });
  });

  describe('OfacEntityType', () => {
    it('accepts all valid entity types', () => {
      const validEntities: OfacEntityType[] = [
        'person',
        'vessel',
        'aircraft',
        'organisation'
      ];

      expect(validEntities).toContain('vessel');
      expect(validEntities).toHaveLength(4);
    });

    it('rejects invalid entity types at compile time', () => {
      // @ts-expect-error - testing invalid entity type
      const invalidEntity: OfacEntityType = 'company';
      expect(invalidEntity).toBe('company');
    });
  });

  describe('OfacCounterparty', () => {
    it('allows valid construction of a person entity without IMO number', () => {
      const counterparty: OfacCounterparty = {
        name: 'John Doe',
        type: 'person'
      };

      expect(counterparty.name).toBe('John Doe');
      expect(counterparty.type).toBe('person');
      expect(counterparty.imo_number).toBeUndefined();
    });

    it('allows valid construction of a vessel entity with an IMO number', () => {
      const counterparty: OfacCounterparty = {
        name: 'Ocean Voyager',
        type: 'vessel',
        imo_number: 'IMO9876543'
      };

      expect(counterparty.name).toBe('Ocean Voyager');
      expect(counterparty.type).toBe('vessel');
      expect(counterparty.imo_number).toBe('IMO9876543');
    });

    it('rejects construction with missing required fields at compile time', () => {
      // @ts-expect-error - missing 'name'
      const invalidCounterparty: OfacCounterparty = {
        type: 'organisation'
      };
      expect(invalidCounterparty.type).toBe('organisation');
    });
  });

  describe('State Transitions & Workflows', () => {
    it('defines primary AMLCaseStatus state transitions', () => {
      const transitions: Record<AMLCaseStatus, AMLCaseStatus[]> = {
        open: ['assigned', 'dismissed'],
        assigned: ['investigating', 'open'],
        investigating: ['closed', 'assigned'],
        closed: [],
        dismissed: []
      };

      expect(transitions.open).toContain('assigned');
      expect(transitions.investigating).toContain('closed');
    });

    it('defines primary OFACReviewStatus state transitions', () => {
      const transitions: Record<OFACReviewStatus, OFACReviewStatus[]> = {
        pending_first_approval: ['pending_second_approval', 'rejected', 'expired'],
        pending_second_approval: ['cleared', 'rejected', 'expired'],
        cleared: [],
        rejected: [],
        expired: ['pending_first_approval']
      };

      expect(transitions.pending_first_approval).toContain('pending_second_approval');
      expect(transitions.pending_second_approval).toContain('cleared');
      expect(transitions.expired).toContain('pending_first_approval');
    });
  });
});
