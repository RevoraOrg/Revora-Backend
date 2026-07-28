import { KycProvider, KycApplicantInfo, KycCheckResult } from '../KycProvider';

export class NullKycProvider implements KycProvider {
  readonly name = 'null_provider';

  async initiateCheck(investorId: string, info: KycApplicantInfo): Promise<KycCheckResult> {
    // Fails closed or returns a safe deterministic mock for tests
    return {
      status: 'pending',
      provider: this.name,
      referenceId: `null-ref-${investorId}`,
      metadata: { note: 'Mock provider used' },
    };
  }

  async getStatus(referenceId: string): Promise<KycCheckResult> {
    return {
      status: 'pending',
      provider: this.name,
      referenceId,
    };
  }

  async handleWebhook(payload: any, signature: string): Promise<KycCheckResult> {
    return {
      status: 'rejected',
      provider: this.name,
      referenceId: 'unknown',
    };
  }
}
