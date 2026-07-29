import { Request, Response, NextFunction } from 'express';
import { requireMobileAttestation } from './mobileAttestation';
import { globalMetrics } from '../lib/metrics';
import { globalLogger as logger } from '../lib/logger';

// Mock metrics and logger
jest.mock('../lib/metrics', () => ({
  globalMetrics: {
    incrementCounter: jest.fn()
  }
}));

jest.mock('../lib/logger', () => ({
  globalLogger: {
    error: jest.fn(),
    info: jest.fn()
  }
}));

describe('mobileAttestation middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction = jest.fn();

  beforeEach(() => {
    mockRequest = {
      header: jest.fn()
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    jest.clearAllMocks();
  });

  const setHeaders = (attestation?: string, provider?: string, nonce?: string) => {
    (mockRequest.header as jest.Mock).mockImplementation((name: string) => {
      switch(name) {
        case 'x-mobile-attestation': return attestation;
        case 'x-attestation-provider': return provider;
        case 'x-attestation-nonce': return nonce;
        default: return undefined;
      }
    });
  };

  it('rejects missing headers', () => {
    setHeaders(undefined, undefined, undefined);
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith(
      'mobile.attestation.rejected', 
      { reason: 'missing_headers' }
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('rejects rooted device signature', () => {
    setHeaders('play-integrity-rooted', 'play-integrity', 'nonce-123');
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith(
      'mobile.attestation.rejected', 
      { reason: 'rooted_device' }
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('rejects jailbroken device signature', () => {
    setHeaders('app-attest-jailbroken', 'app-attest', 'nonce-124');
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith(
      'mobile.attestation.rejected', 
      { reason: 'rooted_device' }
    );
  });

  it('rejects unknown provider', () => {
    setHeaders('some-signature', 'unknown-provider', 'nonce-125');
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith(
      'mobile.attestation.rejected', 
      { reason: 'unknown_provider' }
    );
  });

  it('rejects invalid play-integrity signature', () => {
    setHeaders('invalid-signature', 'play-integrity', 'nonce-126');
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith(
      'mobile.attestation.rejected', 
      { reason: 'invalid_attestation' }
    );
  });

  it('rejects reused nonce', () => {
    setHeaders('play-integrity-valid', 'play-integrity', 'nonce-127');
    
    // First request should pass
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    
    // Second request with same nonce should fail
    jest.clearAllMocks();
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);
    
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith(
      'mobile.attestation.rejected', 
      { reason: 'nonce_reused' }
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('accepts valid play-integrity assertion', () => {
    setHeaders('play-integrity-valid', 'play-integrity', 'nonce-128');
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(globalMetrics.incrementCounter).not.toHaveBeenCalled();
  });

  it('accepts valid app-attest assertion', () => {
    setHeaders('app-attest-valid', 'app-attest', 'nonce-129');
    requireMobileAttestation(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(globalMetrics.incrementCounter).not.toHaveBeenCalled();
  });
});
