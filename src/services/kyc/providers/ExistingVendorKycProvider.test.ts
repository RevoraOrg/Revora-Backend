import { ExistingVendorKycProvider } from './ExistingVendorKycProvider';
import { KycApplicantInfo } from '../KycProvider';

describe('ExistingVendorKycProvider', () => {
  let provider: ExistingVendorKycProvider;

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
      state: 'MA',
    },
  };

  beforeEach(() => {
    provider = new ExistingVendorKycProvider();
  });

  it('exposes the legacy vendor provider name', () => {
    expect(provider.name).toBe('existing_vendor');
  });

  it('starts a legacy check in the pending state', async () => {
    const result = await provider.initiateCheck('investor-42', applicant);

    expect(result).toEqual({
      status: 'pending',
      provider: 'existing_vendor',
      referenceId: 'legacy-ref-investor-42',
    });
  });

  it('resolves a previously issued reference to the approved state', async () => {
    const result = await provider.getStatus('legacy-ref-investor-42');

    expect(result).toEqual({
      status: 'approved',
      provider: 'existing_vendor',
      referenceId: 'legacy-ref-investor-42',
    });
  });

  it('handles a valid webhook payload and preserves the reference id', async () => {
    const result = await provider.handleWebhook(
      { referenceId: 'legacy-ref-investor-42', status: 'approved' },
      'legacy-signature',
    );

    expect(result).toEqual({
      status: 'approved',
      provider: 'existing_vendor',
      referenceId: 'legacy-ref-investor-42',
    });
  });

  it('fails safe when a webhook payload does not include a reference id', async () => {
    const result = await provider.handleWebhook({}, 'legacy-signature');

    expect(result).toEqual({
      status: 'approved',
      provider: 'existing_vendor',
      referenceId: 'unknown',
    });
  });

  it('keeps the state transition deterministic even for empty or missing identifiers', async () => {
    const initiated = await provider.initiateCheck('', applicant);
    const resolved = await provider.getStatus('');

    expect(initiated.status).toBe('pending');
    expect(initiated.referenceId).toBe('legacy-ref-');

    expect(resolved).toEqual({
      status: 'approved',
      provider: 'existing_vendor',
      referenceId: '',
    });
  });
});
