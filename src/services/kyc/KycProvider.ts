export type KycStatus = 'pending' | 'approved' | 'rejected' | 'in_review';

export interface KycCheckResult {
  status: KycStatus;
  provider: string;
  referenceId: string;
  metadata?: Record<string, unknown>;
}

export interface KycApplicantInfo {
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: string; // ISO format
  address: {
    country: string;
    line1: string;
    line2?: string;
    city: string;
    postalCode: string;
    state?: string;
  };
}

export interface KycProvider {
  /**
   * Identifies the provider for logging and telemetry.
   */
  readonly name: string;

  /**
   * Initiates a KYC check for an applicant.
   * @param investorId Internal ID of the investor
   * @param info Applicant information
   * @returns The initial result of the KYC check
   */
  initiateCheck(investorId: string, info: KycApplicantInfo): Promise<KycCheckResult>;

  /**
   * Retrieves the latest status of a KYC check.
   * @param referenceId Provider-specific reference ID
   */
  getStatus(referenceId: string): Promise<KycCheckResult>;

  /**
   * Handles an incoming webhook from the provider.
   * @param payload Raw payload from the provider
   * @param signature Signature for verification
   */
  handleWebhook(payload: any, signature: string): Promise<KycCheckResult>;
}
