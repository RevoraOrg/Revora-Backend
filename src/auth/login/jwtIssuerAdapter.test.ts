import { JwtIssuerAdapter } from './jwtIssuerAdapter';
import * as jwtLib from '../../lib/jwt';

describe('JwtIssuerAdapter', () => {
  let adapter: JwtIssuerAdapter;

  beforeEach(() => {
    adapter = new JwtIssuerAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues access and refresh tokens with matching claims and their respective TTLs', () => {
    const issueTokenSpy = jest.spyOn(jwtLib, 'issueToken');
    issueTokenSpy
      .mockReturnValueOnce('access-token')
      .mockReturnValueOnce('refresh-token');

    const result = adapter.sign({
      userId: 'user-42',
      sessionId: 'session-99',
      role: 'investor',
    });

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(issueTokenSpy).toHaveBeenNthCalledWith(1, {
      subject: 'user-42',
      expiresIn: jwtLib.TOKEN_EXPIRY,
      additionalPayload: { sid: 'session-99', role: 'investor' },
    });
    expect(issueTokenSpy).toHaveBeenNthCalledWith(2, {
      subject: 'user-42',
      expiresIn: jwtLib.REFRESH_TOKEN_EXPIRY,
      additionalPayload: { sid: 'session-99', role: 'investor' },
    });
  });

  it('propagates access-token signing failures without attempting refresh signing', () => {
    const signingError = new Error('access signing failed');
    const issueTokenSpy = jest.spyOn(jwtLib, 'issueToken').mockImplementation(() => {
      throw signingError;
    });

    expect(() =>
      adapter.sign({ userId: 'user-42', sessionId: 'session-99', role: 'startup' }),
    ).toThrow(signingError);
    expect(issueTokenSpy).toHaveBeenCalledTimes(1);
  });

  it('does not return a partial result when refresh-token signing fails', () => {
    const signingError = new Error('refresh signing failed');
    const issueTokenSpy = jest
      .spyOn(jwtLib, 'issueToken')
      .mockReturnValueOnce('access-token')
      .mockImplementationOnce(() => {
        throw signingError;
      });

    expect(() =>
      adapter.sign({ userId: 'user-42', sessionId: 'session-99', role: 'startup' }),
    ).toThrow(signingError);
    expect(issueTokenSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [undefined, 'JWT_SECRET environment variable is not set'],
    ['short-secret', 'JWT_SECRET must be at least 32 characters for security'],
  ])('surfaces invalid signing configuration instead of returning tokens', (secret, expectedError) => {
    const originalSecret = process.env.JWT_SECRET;
    if (secret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = secret;
    }

    try {
      expect(() =>
        adapter.sign({ userId: 'user-42', sessionId: 'session-99', role: 'investor' }),
      ).toThrow(expectedError);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = originalSecret;
      }
    }
  });
});