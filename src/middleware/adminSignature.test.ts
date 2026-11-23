import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { verifyAdminSignature } from './adminSignature';
import { globalLogger } from '../lib/logger';

describe('verifyAdminSignature', () => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const kid = 'test-admin';
  const privateKey = keyPair.privateKey;
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const originalPubKeys = process.env.ADMIN_PUBKEYS;
  const originalV1Enabled = process.env.ADMIN_SIGNATURE_V1_ENABLED;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.ADMIN_PUBKEYS = JSON.stringify({ [kid]: publicKeyBase64 });
    delete process.env.ADMIN_SIGNATURE_V1_ENABLED;
    warnSpy = jest.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalPubKeys === undefined) delete process.env.ADMIN_PUBKEYS;
    else process.env.ADMIN_PUBKEYS = originalPubKeys;
    if (originalV1Enabled === undefined) delete process.env.ADMIN_SIGNATURE_V1_ENABLED;
    else process.env.ADMIN_SIGNATURE_V1_ENABLED = originalV1Enabled;
  });

  function sign(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  }

  function makeRequest(options: {
    body: Record<string, unknown>;
    version?: string;
    method?: string;
    originalUrl?: string;
  }): Request {
    const headers: Record<string, string> = {
      'x-admin-signature': sign(options.body),
      'x-admin-kid': kid,
    };
    if (options.version !== undefined) headers['x-admin-signature-version'] = options.version;
    const settings = new Map<string, unknown>();
    return {
      body: options.body,
      method: options.method ?? 'POST',
      originalUrl: options.originalUrl ?? '/api/startup/offerings/offering-456/approve',
      path: options.originalUrl?.split('?')[0] ?? '/api/startup/offerings/offering-456/approve',
      header: (name: string) => headers[name.toLowerCase()],
      app: {
        get: (name: string) => settings.get(name),
        set: (name: string, value: unknown) => settings.set(name, value),
      },
    } as unknown as Request;
  }

  function invoke(req: Request): jest.Mock {
    const next = jest.fn() as jest.Mock;
    verifyAdminSignature()(req, {} as Response, next as NextFunction);
    return next;
  }

  function fields(nonce: string): Record<string, unknown> {
    return {
      action: 'approve',
      offeringId: 'offering-456',
      nonce,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  it('rejects a v2 signature replayed against a different route', () => {
    const signedRoute = '/api/startup/offerings/offering-456/approve';
    const signedBody = {
      ...fields('route-replay'),
      method: 'POST',
      path: signedRoute,
    };
    const req = makeRequest({
      body: signedBody,
      version: '2',
      originalUrl: '/api/startup/offerings/offering-456/reject',
    });

    const next = invoke(req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(req.app.get('adminNonceStore')).toBeUndefined();
  });

  it('rejects a v2 signature replayed with a different HTTP method', () => {
    const path = '/api/startup/offerings/offering-456/approve';
    const req = makeRequest({
      body: { ...fields('method-replay'), method: 'PUT', path },
      version: '2',
      method: 'POST',
    });

    const next = invoke(req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(req.app.get('adminNonceStore')).toBeUndefined();
  });

  it('accepts a v2 signature for the exact method and pathname', () => {
    const path = '/api/startup/offerings/offering-456/approve';
    const req = makeRequest({
      body: { ...fields('route-match'), method: 'POST', path },
      version: '2',
      originalUrl: `${path}?source=dashboard`,
    });
    const next = invoke(req);

    expect(next).toHaveBeenCalledWith();
    expect(req.app.get('adminNonceStore')).toContain('route-match');
  });

  it('keeps header-less v1 signatures working and emits a deprecation warning', () => {
    const req = makeRequest({ body: fields('legacy-compatible') });
    const next = invoke(req);

    expect(next).toHaveBeenCalledWith();
    expect(warnSpy).toHaveBeenCalledWith(
      'Legacy admin signature version is deprecated',
      expect.objectContaining({ kid, path: req.path }),
    );
  });

  it('rejects v1 signatures when the compatibility flag is disabled', () => {
    process.env.ADMIN_SIGNATURE_V1_ENABLED = 'false';
    const req = makeRequest({ body: fields('legacy-disabled'), version: '1' });
    const next = invoke(req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
