import { Pool } from 'pg';
import { OidcProviderRepository, CreateOidcProviderInput } from './oidcProviderRepository';
import { OidcProviderRow } from '../../auth/oidc/types';

describe('OidcProviderRepository', () => {
  let repository: OidcProviderRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() } as any;
    repository = new OidcProviderRepository(mockPool as unknown as Pool);
  });

  describe('create', () => {
    it('should create an oidc provider', async () => {
      const input: CreateOidcProviderInput = {
        tenantId: 'tenant-123',
        name: 'Google',
        issuerUrl: 'https://accounts.google.com',
        clientId: 'client-123',
        clientSecret: 'secret',
        scopes: 'openid profile email',
        redirectUris: 'https://app.example.com/callback',
      };

      const mockRow: OidcProviderRow = {
        id: 'prov-123',
        tenant_id: 'tenant-123',
        name: 'Google',
        issuer_url: 'https://accounts.google.com',
        client_id: 'client-123',
        client_secret: 'secret',
        scopes: 'openid profile email',
        redirect_uris: 'https://app.example.com/callback',
        enabled: true,
        created_at: new Date(),
      };

      const mockResult = {
        rows: [mockRow],
        rowCount: 1,
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oidc_providers'),
        [
          'tenant-123',
          'Google',
          'https://accounts.google.com',
          'client-123',
          'secret',
          'openid profile email',
          'https://app.example.com/callback',
        ]
      );
      expect(result).toEqual(mockRow);
    });

    it('should create an oidc provider with default scopes and null secret', async () => {
      const input: CreateOidcProviderInput = {
        tenantId: 'tenant-123',
        name: 'Google',
        issuerUrl: 'https://accounts.google.com',
        clientId: 'client-123',
        redirectUris: 'https://app.example.com/callback',
      };

      const mockRow: OidcProviderRow = {
        id: 'prov-123',
        tenant_id: 'tenant-123',
        name: 'Google',
        issuer_url: 'https://accounts.google.com',
        client_id: 'client-123',
        client_secret: null,
        scopes: 'openid profile email',
        redirect_uris: 'https://app.example.com/callback',
        enabled: true,
        created_at: new Date(),
      };

      const mockResult = {
        rows: [mockRow],
        rowCount: 1,
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oidc_providers'),
        [
          'tenant-123',
          'Google',
          'https://accounts.google.com',
          'client-123',
          null,
          'openid profile email',
          'https://app.example.com/callback',
        ]
      );
      expect(result).toEqual(mockRow);
    });
  });

  describe('findByTenantId', () => {
    it('should find provider by tenant id', async () => {
      const mockRow: OidcProviderRow = {
        id: 'prov-123',
        tenant_id: 'tenant-123',
        name: 'Google',
        issuer_url: 'https://accounts.google.com',
        client_id: 'client-123',
        client_secret: 'secret',
        scopes: 'openid profile email',
        redirect_uris: 'https://app.example.com/callback',
        enabled: true,
        created_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findByTenantId('tenant-123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM oidc_providers WHERE tenant_id = $1 AND enabled = TRUE LIMIT 1'),
        ['tenant-123']
      );
      expect(result).toEqual(mockRow);
    });

    it('should return null if no provider found by tenant id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findByTenantId('tenant-123');
      expect(result).toBeNull();
    });
  });

  describe('findByIssuerUrl', () => {
    it('should find provider by issuer url', async () => {
      const mockRow: OidcProviderRow = {
        id: 'prov-123',
        tenant_id: 'tenant-123',
        name: 'Google',
        issuer_url: 'https://accounts.google.com',
        client_id: 'client-123',
        client_secret: 'secret',
        scopes: 'openid profile email',
        redirect_uris: 'https://app.example.com/callback',
        enabled: true,
        created_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findByIssuerUrl('https://accounts.google.com');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM oidc_providers WHERE issuer_url = $1 AND enabled = TRUE LIMIT 1'),
        ['https://accounts.google.com']
      );
      expect(result).toEqual(mockRow);
    });

    it('should return null if no provider found by issuer url', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findByIssuerUrl('https://accounts.google.com');
      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all providers', async () => {
      const mockRow: OidcProviderRow = {
        id: 'prov-123',
        tenant_id: 'tenant-123',
        name: 'Google',
        issuer_url: 'https://accounts.google.com',
        client_id: 'client-123',
        client_secret: 'secret',
        scopes: 'openid profile email',
        redirect_uris: 'https://app.example.com/callback',
        enabled: true,
        created_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findAll();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM oidc_providers ORDER BY created_at DESC')
      );
      expect(result).toEqual([mockRow]);
    });
  });
});
