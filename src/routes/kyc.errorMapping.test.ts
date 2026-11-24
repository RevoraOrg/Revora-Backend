import express from 'express';
import request from 'supertest';
import {
  ProviderNotRegisteredError,
  UnsupportedJurisdictionError,
} from '../lib/errors';
import { globalLogger } from '../lib/logger';
import { KycRouter } from '../services/kyc/KycRouter';
import type { KycApplicantInfo, KycCheckResult, KycProvider } from '../services/kyc/KycProvider';
import { createKycRoutes } from './kyc';

jest.mock('../middleware/auth', () => ({
  requireInvestor: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: string } }).user = { id: 'investor-1' };
    next();
  },
}));

const APPLICANT: KycApplicantInfo = {
  firstName: 'Test',
  lastName: 'Investor',
  email: 'investor@example.test',
  dateOfBirth: '1990-01-01',
  address: {
    country: 'ZZ',
    line1: '1 Test Way',
    city: 'Testville',
    postalCode: '00000',
  },
};

function makeProvider(): KycProvider {
  const result: KycCheckResult = {
    status: 'pending',
    provider: 'registered-provider',
    referenceId: 'ref-1',
  };
  return {
    name: 'registered-provider',
    initiateCheck: jest.fn().mockResolvedValue(result),
    getStatus: jest.fn().mockResolvedValue(result),
    handleWebhook: jest.fn().mockResolvedValue(result),
  };
}

function createApp(router: Pick<KycRouter, 'route'>): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/kyc', createKycRoutes(router as KycRouter));
  return app;
}

describe('KYC route error mapping', () => {
  let loggerSpy: jest.SpyInstance;

  beforeEach(() => {
    loggerSpy = jest.spyOn(globalLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerSpy.mockRestore();
  });

  it('maps an unsupported jurisdiction to 403 without echoing the input country', async () => {
    const router = { route: jest.fn(() => {
      throw new UnsupportedJurisdictionError('ZZ');
    }) };
    const response = await request(createApp(router))
      .post('/kyc')
      .send(APPLICANT)
      .expect(403);

    expect(response.body).toEqual({ error: 'Jurisdiction not supported' });
    expect(JSON.stringify(response.body)).not.toContain('ZZ');
    expect(loggerSpy).not.toHaveBeenCalled();
  });

  it('maps a missing provider registration to a generic 500 and logs the detail', async () => {
    const providerName = 'internal-vendor-prod';
    const router = { route: jest.fn(() => {
      throw new ProviderNotRegisteredError(providerName);
    }) };
    const response = await request(createApp(router))
      .post('/kyc')
      .send({ ...APPLICANT, address: { ...APPLICANT.address, country: 'DE' } })
      .expect(500);

    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(response.body)).not.toContain(providerName);
    expect(loggerSpy).toHaveBeenCalledWith(
      'KYC provider misconfiguration',
      expect.objectContaining({
        providerName,
        jurisdiction: 'DE',
        error: expect.any(ProviderNotRegisteredError),
      }),
    );
  });

  it('does not call a provider when routing fails', async () => {
    const provider = makeProvider();
    const router = {
      route: jest.fn(() => {
        throw new ProviderNotRegisteredError('ghost-provider');
      }),
      registerProvider: jest.fn(() => provider),
    };
    await request(createApp(router))
      .post('/kyc')
      .send(APPLICANT)
      .expect(500);

    expect(provider.initiateCheck).not.toHaveBeenCalled();
  });
});
