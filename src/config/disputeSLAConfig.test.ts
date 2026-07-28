import {
  DISPUTE_STATES,
  DISPUTE_JURISDICTIONS,
  getSLADuration,
  getJurisdictionSLAConfig,
  isTerminalState,
  isAutoEscalateEnabled,
  JURISDICTION_SLA_CONFIGS,
  DisputeState,
  DisputeJurisdiction,
} from '../config/disputeSLAConfig';

describe('disputeSLAConfig', () => {
  describe('DISPUTE_STATES', () => {
    it('should include all expected states', () => {
      expect(DISPUTE_STATES).toContain('new');
      expect(DISPUTE_STATES).toContain('triage');
      expect(DISPUTE_STATES).toContain('investigating');
      expect(DISPUTE_STATES).toContain('awaiting_customer');
      expect(DISPUTE_STATES).toContain('awaiting_merchant');
      expect(DISPUTE_STATES).toContain('awaiting_evidence');
      expect(DISPUTE_STATES).toContain('under_review');
      expect(DISPUTE_STATES).toContain('resolution_proposed');
      expect(DISPUTE_STATES).toContain('escalated_internal');
      expect(DISPUTE_STATES).toContain('resolved');
      expect(DISPUTE_STATES).toContain('closed');
    });

    it('should be a const tuple with 11 states', () => {
      expect(DISPUTE_STATES).toHaveLength(11);
      expect(Array.isArray(DISPUTE_STATES)).toBe(true);
      // Verify uniqueness
      expect(new Set(DISPUTE_STATES).size).toBe(DISPUTE_STATES.length);
    });
  });

  describe('DISPUTE_JURISDICTIONS', () => {
    it('should include all expected jurisdictions', () => {
      expect(DISPUTE_JURISDICTIONS).toContain('US');
      expect(DISPUTE_JURISDICTIONS).toContain('EU');
      expect(DISPUTE_JURISDICTIONS).toContain('UK');
      expect(DISPUTE_JURISDICTIONS).toContain('CA');
      expect(DISPUTE_JURISDICTIONS).toContain('AU');
      expect(DISPUTE_JURISDICTIONS).toContain('SG');
      expect(DISPUTE_JURISDICTIONS).toContain('default');
    });
  });

  describe('getSLADuration', () => {
    it('should return the correct duration for US / investigating', () => {
      const duration = getSLADuration('US', 'investigating');
      expect(duration).toBe(72);
    });

    it('should return the correct duration for EU / awaiting_customer', () => {
      const duration = getSLADuration('EU', 'awaiting_customer');
      expect(duration).toBe(360);
    });

    it('should return 0 for resolved state', () => {
      const duration = getSLADuration('US', 'resolved');
      expect(duration).toBe(0);
    });

    it('should return 0 for closed state', () => {
      const duration = getSLADuration('US', 'closed');
      expect(duration).toBe(0);
    });

    it('should fall back to default for unknown jurisdiction', () => {
      const duration = getSLADuration('UNKNOWN', 'new');
      expect(duration).toBe(4); // default new SLA
    });

    it('should return a positive value for unknown state (max configured)', () => {
      // For default jurisdiction, the max SLA duration is 120h (awaiting_customer)
      const duration = getSLADuration('default', 'unknown_state');
      expect(duration).toBeGreaterThan(0);
    });

    it('should return configurable durations for all known jurisdictions', () => {
      for (const juris of DISPUTE_JURISDICTIONS) {
        for (const state of DISPUTE_STATES) {
          const duration = getSLADuration(juris, state);
          expect(duration).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(duration)).toBe(true);
        }
      }
    });

    it('should return different durations for different jurisdictions on same state', () => {
      const usDuration = getSLADuration('US', 'awaiting_customer');
      const caDuration = getSLADuration('CA', 'awaiting_customer');
      // CA has 56 calendar days vs US 10 business days
      expect(caDuration).toBeGreaterThan(usDuration);
    });
  });

  describe('getJurisdictionSLAConfig', () => {
    it('should return US config', () => {
      const config = getJurisdictionSLAConfig('US');
      expect(config.jurisdiction).toBe('US');
      expect(config.autoEscalate).toBe(true);
      expect(config.escalationContacts).toEqual(['compliance-us@revora.com']);
    });

    it('should return EU config', () => {
      const config = getJurisdictionSLAConfig('EU');
      expect(config.jurisdiction).toBe('EU');
      expect(config.autoEscalate).toBe(true);
    });

    it('should return default config for unknown jurisdiction', () => {
      const config = getJurisdictionSLAConfig('XX');
      expect(config.jurisdiction).toBe('default');
      expect(config.autoEscalate).toBe(false);
    });

    it('should have stateSLAs for all states', () => {
      const config = getJurisdictionSLAConfig('US');
      for (const state of DISPUTE_STATES) {
        expect(config.stateSLAs[state]).toBeDefined();
        expect(typeof config.stateSLAs[state]).toBe('number');
      }
    });
  });

  describe('isTerminalState', () => {
    it('should return true for resolved', () => {
      expect(isTerminalState('resolved')).toBe(true);
    });

    it('should return true for closed', () => {
      expect(isTerminalState('closed')).toBe(true);
    });

    it('should return false for non-terminal states', () => {
      expect(isTerminalState('new')).toBe(false);
      expect(isTerminalState('investigating')).toBe(false);
      expect(isTerminalState('awaiting_customer')).toBe(false);
      expect(isTerminalState('escalated_internal')).toBe(false);
    });
  });

  describe('isAutoEscalateEnabled', () => {
    it('should return true for US', () => {
      expect(isAutoEscalateEnabled('US')).toBe(true);
    });

    it('should return true for EU', () => {
      expect(isAutoEscalateEnabled('EU')).toBe(true);
    });

    it('should return true for UK', () => {
      expect(isAutoEscalateEnabled('UK')).toBe(true);
    });

    it('should return true for CA', () => {
      expect(isAutoEscalateEnabled('CA')).toBe(true);
    });

    it('should return true for AU', () => {
      expect(isAutoEscalateEnabled('AU')).toBe(true);
    });

    it('should return true for SG', () => {
      expect(isAutoEscalateEnabled('SG')).toBe(true);
    });

    it('should return false for default', () => {
      expect(isAutoEscalateEnabled('default')).toBe(false);
    });

    it('should return false for unknown jurisdiction (falls back to default)', () => {
      expect(isAutoEscalateEnabled('UNKNOWN')).toBe(false);
    });
  });

  describe('JURISDICTION_SLA_CONFIGS', () => {
    it('should have all jurisdictions covered', () => {
      for (const juris of DISPUTE_JURISDICTIONS) {
        expect(JURISDICTION_SLA_CONFIGS[juris]).toBeDefined();
      }
    });

    it('should have valid SLAs (>= 0) for each jurisdiction/state combo', () => {
      for (const juris of DISPUTE_JURISDICTIONS) {
        const config = JURISDICTION_SLA_CONFIGS[juris];
        for (const state of DISPUTE_STATES) {
          const duration = config.stateSLAs[state];
          expect(duration).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(duration)).toBe(true);
        }
      }
    });

    it('should have increasing SLA durations for more time-consuming states', () => {
      // awaiting_customer should have the longest SLA
      const configs = [
        JURISDICTION_SLA_CONFIGS['US'],
        JURISDICTION_SLA_CONFIGS['EU'],
        JURISDICTION_SLA_CONFIGS['CA'],
      ];
      for (const config of configs) {
        expect(config.stateSLAs['awaiting_customer']).toBeGreaterThanOrEqual(config.stateSLAs['new']);
        expect(config.stateSLAs['awaiting_customer']).toBeGreaterThanOrEqual(config.stateSLAs['triage']);
      }
    });
  });
});
