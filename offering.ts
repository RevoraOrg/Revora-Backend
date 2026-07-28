/**
 * Offering interface with versioning support for optimistic concurrency.
 */
export interface Offering {
  id: string;
  issuer_id: string;
  title: string;
  description: string;
  amount: string;
  status: 'draft' | 'active' | 'closed';
  version: number; // Used for optimistic concurrency control
  created_at: Date;
  updated_at: Date;
}

export interface UpdateOfferingInput extends Partial<Omit<Offering, 'id' | 'issuer_id' | 'created_at' | 'updated_at'>> {
  version: number; // Required for updates to ensure consistency
}