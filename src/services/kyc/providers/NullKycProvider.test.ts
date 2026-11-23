import { KycApplicantInfo } from '../KycProvider';
import { NullKycProvider } from './NullKycProvider';

const applicant: KycApplicantInfo = {
  firstName: 'Jane',
  lastName: 'Investor',
  email: 'jane@example.com',
  dateOfBirth: '1990-02-14',
  address: {
    country: 'US',
    line1: '100 Main St',
    city: 'Boston',
    postalCode: '02108',
  },
};

describe('NullKycProvider', () => {
  let provider: NullKycProvider;

  beforeEach(() => {
    provider = new NullKycProvider();
  });

  it('exposes the null provider name', () => {
    expect(provider.name).toBe('null_provider');
  });

  it('returns a deterministic pending result when initiating a check', async () => {
    await expect(provider.initiateCheck('investor-42', applicant)).resolves.toEqual({
      status: 'pending',
      provider: 'null_provider',
      referenceId: 'null-ref-investor-42',
      metadata: { note: 'Mock provider used' },
    });
  });

  it('returns pending for an issued reference', async () => {
    await expect(provider.getStatus('null-ref-investor-42')).resolves.toEqual({
      status: 'pending',
      provider: 'null_provider',
      referenceId: 'null-ref-investor-42',
    });
  });

  it.each([
    ['a valid-looking signature', 'sha256=valid-test-signature'],
    ['an invalid signature', 'invalid-signature'],
    ['an empty signature', ''],
  ])('fails closed for webhook payloads with %s', async (_description, signature) => {
    await expect(
      provider.handleWebhook({ status: 'approved', referenceId: 'null-ref-investor-42' }, signature),
    ).resolves.toEqual({
      status: 'rejected',
      provider: 'null_provider',
      referenceId: 'unknown',
    });
  });
});
