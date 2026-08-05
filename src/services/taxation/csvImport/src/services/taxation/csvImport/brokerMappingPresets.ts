/**
 * Per-broker column mapping presets.
 *
 * Each preset maps a broker's CSV header names to the canonical fields in
 * ParsedBrokerRow. Add a new broker by adding a preset entry; the parser
 * stays unchanged.
 *
 * @module services/taxation/csvImport/brokerMappingPresets
 */

/** Canonical target fields a preset must map every source header onto. */
export interface BrokerMappingPreset {
  /** Human label for logs and errors. */
  label: string;
  /** Header in the CSV -> canonical field. */
  columns: {
    asset: string;
    quantity: string;
    costBasisPerUnit: string;
    acquiredAt: string;
    currency?: string;
  };
  /** Default currency when the file has no currency column. */
  defaultCurrency: string;
}

/**
 * Registry of supported brokers. Keys are the `broker` value callers pass.
 * Header names are compared case-insensitively after trimming.
 */
export const BROKER_PRESETS: Record<string, BrokerMappingPreset> = {
  schwab: {
    label: 'Charles Schwab',
    columns: {
      asset: 'Symbol',
      quantity: 'Quantity',
      costBasisPerUnit: 'Cost Per Share',
      acquiredAt: 'Acquired Date',
      currency: 'Currency',
    },
    defaultCurrency: 'USD',
  },
  fidelity: {
    label: 'Fidelity',
    columns: {
      asset: 'Security',
      quantity: 'Shares',
      costBasisPerUnit: 'Unit Cost',
      acquiredAt: 'Date Acquired',
    },
    defaultCurrency: 'USD',
  },
  generic: {
    label: 'Generic',
    columns: {
      asset: 'asset',
      quantity: 'quantity',
      costBasisPerUnit: 'cost_basis_per_unit',
      acquiredAt: 'acquired_at',
      currency: 'currency',
    },
    defaultCurrency: 'USD',
  },
};

/** Resolve a preset or throw a validation-friendly error. */
export function resolvePreset(broker: string): BrokerMappingPreset {
  const preset = BROKER_PRESETS[broker?.trim().toLowerCase()];
  if (!preset) {
    const known = Object.keys(BROKER_PRESETS).join(', ');
    throw new Error(`Unknown broker preset "${broker}". Known presets: ${known}`);
  }
  return preset;
}