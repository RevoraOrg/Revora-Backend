import { KycProvider, KycApplicantInfo, KycCheckResult } from '../KycProvider';

export class ExistingVendorKycProvider implements KycProvider {
  readonly name = 'existing_vendor';

  async initiateCheck(investorId: string, info: KycApplicantInfo): Promise<KycCheckResult> {
    // This represents the legacy behavior interacting with the single vendor
    return {
      status: 'pending',
      provider: this.name,
      referenceId: `legacy-ref-${investorId}`,
    };
  }

  async getStatus(referenceId: string): Promise<KycCheckResult> {
    return {
      status: 'approved',
      provider: this.name,
      referenceId,
    };
  }

  async handleWebhook(payload: any, signature: string): Promise<KycCheckResult> {
    return {
      status: 'approved',
      provider: this.name,
      referenceId: payload?.referenceId || 'unknown',
    };
  }
}
