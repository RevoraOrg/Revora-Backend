import type {
  KycApplicantInfo,
  KycCheckResult,
  KycProvider,
  KycStatus,
} from '../KycProvider';
import { NullKycProvider } from '../providers/NullKycProvider';

const applicant: KycApplicantInfo = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  dateOfBirth: '1990-06-15',
  address: {
    country: 'US',
    line1: '456 Oak Ave',
    city: 'Springfield',
    postalCode: '62701',
  },
};

function checkResult(status: KycStatus, referenceId = 'kyc-ref-1'): KycCheckResult {
  return {
    status,
    provider: 'scripted',
    referenceId,
    metadata: { source: 'test' },
  };
}

class ScriptedKycProvider implements KycProvider {
  readonly name = 'scripted';
  private nextStatus = 0;

  constructor(private readonly statusTimeline: KycStatus[]) {}

  async initiateCheck(investorId: string, info: KycApplicantInfo): Promise<KycCheckResult> {
    void investorId;
    void info;
    return checkResult(this.statusTimeline[this.nextStatus++]);
  }

  async getStatus(referenceId: string): Promise<KycCheckResult> {
    return checkResult(this.statusTimeline[this.nextStatus++], referenceId);
  }

  async handleWebhook(payload: unknown, signature: string): Promise<KycCheckResult> {
    void payload;
    void signature;
    return checkResult(this.statusTimeline[this.nextStatus++]);
  }
}

function verifyInvalidShapesAreRejectedByTypes(): void {
  // @ts-expect-error KycStatus is a closed union of supported decisions.
  const invalidStatus: KycStatus = 'suspended';
  // @ts-expect-error Applicant identity and address fields are required.
  const invalidApplicant: KycApplicantInfo = { firstName: 'Jane' };
  // @ts-expect-error A result must include its provider reference.
  const invalidResult: KycCheckResult = { status: 'pending', provider: 'vendor' };
  void [invalidStatus, invalidApplicant, invalidResult];
}

verifyInvalidShapesAreRejectedByTypes();

describe('KYC provider contracts', () => {
  it('represents every supported status with a complete result', () => {
    const results = (['pending', 'in_review', 'approved', 'rejected'] satisfies KycStatus[])
      .map((status) => checkResult(status));

    expect(results.map(({ status }) => status)).toEqual([
      'pending',
      'in_review',
      'approved',
      'rejected',
    ]);
    expect(results[0]).toEqual({
      status: 'pending',
      provider: 'scripted',
      referenceId: 'kyc-ref-1',
      metadata: { source: 'test' },
    });
  });

  it('accepts optional applicant address fields and optional result metadata', () => {
    const extendedApplicant: KycApplicantInfo = {
      ...applicant,
      address: { ...applicant.address, line2: 'Unit 2', state: 'IL' },
    };
    const minimalResult: KycCheckResult = {
      status: 'pending',
      provider: 'vendor',
      referenceId: 'vendor-ref-1',
    };

    expect(extendedApplicant.address).toMatchObject({ line2: 'Unit 2', state: 'IL' });
    expect(minimalResult).not.toHaveProperty('metadata');
  });

  it('supports pending to in-review to approved transitions', async () => {
    const provider = new ScriptedKycProvider(['pending', 'in_review', 'approved']);

    const initial = await provider.initiateCheck('investor-1', applicant);
    const review = await provider.getStatus(initial.referenceId);
    const final = await provider.getStatus(review.referenceId);

    expect([initial.status, review.status, final.status]).toEqual([
      'pending',
      'in_review',
      'approved',
    ]);
    expect(review.referenceId).toBe(initial.referenceId);
    expect(final.referenceId).toBe(initial.referenceId);
  });

  it('supports a rejected final decision', async () => {
    const provider = new ScriptedKycProvider(['pending', 'in_review', 'rejected']);

    const initial = await provider.initiateCheck('investor-1', applicant);
    await provider.getStatus(initial.referenceId);
    const final = await provider.getStatus(initial.referenceId);

    expect(final.status).toBe('rejected');
    expect(final.referenceId).toBe(initial.referenceId);
  });

  it('returns deterministic null-provider initiation and status results', async () => {
    const provider = new NullKycProvider();

    await expect(provider.initiateCheck('investor-1', applicant)).resolves.toEqual({
      status: 'pending',
      provider: 'null_provider',
      referenceId: 'null-ref-investor-1',
      metadata: { note: 'Mock provider used' },
    });
    await expect(provider.getStatus('null-ref-investor-1')).resolves.toEqual({
      status: 'pending',
      provider: 'null_provider',
      referenceId: 'null-ref-investor-1',
    });
  });

  it('fails closed by rejecting webhook decisions from the null provider', async () => {
    const provider = new NullKycProvider();

    await expect(provider.handleWebhook({ status: 'approved' }, 'invalid-signature')).resolves.toEqual({
      status: 'rejected',
      provider: 'null_provider',
      referenceId: 'unknown',
    });
  });
});