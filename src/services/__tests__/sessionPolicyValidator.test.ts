import { SessionPolicyValidator } from '../sessionPolicyValidator';
import { OidcProviderRepository } from '../../db/repositories/oidcProviderRepository';

describe('SessionPolicyValidator', () => {
  let mockRepo: jest.Mocked<OidcProviderRepository>;
  let validator: SessionPolicyValidator;

  beforeEach(() => {
    mockRepo = {
      findByTenantId: jest.fn(),
      create: jest.fn(),
      findByIssuerUrl: jest.fn(),
      findAll: jest.fn(),
    } as any;
    validator = new SessionPolicyValidator(mockRepo, 'https://backend.example.com');
  });

  it('allows opt-in if tenant has no OIDC provider', async () => {
    mockRepo.findByTenantId.mockResolvedValue(null);
    await expect(validator.validateStrictOptIn('tenant-1')).resolves.toBeUndefined();
  });

  it('allows opt-in if all redirect URIs share the same origin as the backend', async () => {
    mockRepo.findByTenantId.mockResolvedValue({
      redirect_uris: 'https://backend.example.com/callback, https://backend.example.com/another',
    } as any);
    await expect(validator.validateStrictOptIn('tenant-1')).resolves.toBeUndefined();
  });

  it('allows opt-in if redirect URI is a relative path (treated as invalid URL or same origin if handled differently)', async () => {
    // Current implementation ignores invalid URLs (like relative paths) and assumes they're same-site
    mockRepo.findByTenantId.mockResolvedValue({
      redirect_uris: '/callback',
    } as any);
    await expect(validator.validateStrictOptIn('tenant-1')).resolves.toBeUndefined();
  });

  it('allows opt-in if redirect URI is completely invalid (not a URL)', async () => {
    mockRepo.findByTenantId.mockResolvedValue({
      redirect_uris: 'not-a-url-at-all',
    } as any);
    await expect(validator.validateStrictOptIn('tenant-1')).resolves.toBeUndefined();
  });

  it('throws if any redirect URI is cross-site', async () => {
    mockRepo.findByTenantId.mockResolvedValue({
      redirect_uris: 'https://backend.example.com/callback, https://app.example.com/callback',
    } as any);
    await expect(validator.validateStrictOptIn('tenant-1')).rejects.toThrow('Cannot opt-in to Strict mode: configured cross-site redirect URI found (https://app.example.com/callback)');
  });
});
