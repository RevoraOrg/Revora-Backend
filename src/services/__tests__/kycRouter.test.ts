import crypto from 'crypto';
import { KycRouter, RouteTable } from '../kyc/KycRouter';
import { NullKycProvider } from '../kyc/providers/NullKycProvider';
import { ExistingVendorKycProvider } from '../kyc/providers/ExistingVendorKycProvider';
import { KycApplicantInfo } from '../kyc/KycProvider';

describe('KycRouter', () => {
  const secretKey = 'test-secret-key';
  let router: KycRouter;
  let nullProvider: NullKycProvider;
  let vendorProvider: ExistingVendorKycProvider;

  beforeEach(() => {
    router = new KycRouter(secretKey);
    nullProvider = new NullKycProvider();
    vendorProvider = new ExistingVendorKycProvider();

    router.registerProvider(nullProvider);
    router.registerProvider(vendorProvider);
  });

  const createSignedTable = (version: string, entries: { jurisdiction: string; providerName: string }[]): RouteTable => {
    const payload = JSON.stringify({ version, entries });
    const signature = crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
    return { version, entries, signature };
  };

  it('fails closed when route table signature is invalid', () => {
    const table: RouteTable = {
      version: '1.0',
      entries: [{ jurisdiction: 'US', providerName: 'null_provider' }],
      signature: 'invalid_signature',
    };

    expect(() => router.loadRouteTable(table)).toThrow('Invalid route table signature. Fails closed.');
  });

  it('loads valid route table and routes correctly', () => {
    const table = createSignedTable('1.0', [
      { jurisdiction: 'US', providerName: 'null_provider' },
      { jurisdiction: 'EU', providerName: 'existing_vendor' },
    ]);

    router.loadRouteTable(table);

    expect(router.getVersion()).toBe('1.0');
    expect(router.route('US')).toBe(nullProvider);
    expect(router.route('EU')).toBe(vendorProvider);
  });

  it('fails closed for unknown jurisdictions', () => {
    const table = createSignedTable('1.0', [
      { jurisdiction: 'US', providerName: 'null_provider' },
    ]);
    router.loadRouteTable(table);

    expect(() => router.route('CA')).toThrow('Jurisdiction CA not supported. Fails closed.');
  });

  it('fails if the configured provider is not registered', () => {
    const table = createSignedTable('1.0', [
      { jurisdiction: 'JP', providerName: 'non_existent_provider' },
    ]);
    router.loadRouteTable(table);

    expect(() => router.route('JP')).toThrow('Configured provider non_existent_provider not registered.');
  });

  it('executes the correct provider methods via routing', async () => {
    const table = createSignedTable('1.0', [
      { jurisdiction: 'US', providerName: 'null_provider' },
    ]);
    router.loadRouteTable(table);

    const provider = router.route('US');
    const mockApplicant: KycApplicantInfo = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      dateOfBirth: '1990-01-01',
      address: {
        country: 'US',
        line1: '123 Main St',
        city: 'Anytown',
        postalCode: '12345',
      },
    };

    const result = await provider.initiateCheck('investor-123', mockApplicant);
    expect(result.provider).toBe('null_provider');
    expect(result.status).toBe('pending');
  });
});
