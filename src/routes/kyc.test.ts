
import { Request, Response, NextFunction } from 'express';

import { createKycRoutes } from './kyc';
import { KycRouter } from '../services/kyc/KycRouter';
import { Errors, UnsupportedJurisdictionError } from '../lib/errors';

jest.mock('../middleware/auth', () => ({
  requireInvestor: jest.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));

describe('createKycRoutes', () => {
  let mockKycRouter: {
    route: jest.Mock;
  };

  let mockProvider: {
    initiateCheck: jest.Mock;
  };

  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      initiateCheck: jest.fn().mockResolvedValue({
        id: 'kyc-123',
        status: 'pending',
      }),
    };

    mockKycRouter = {
      route: jest.fn().mockReturnValue(mockProvider),
    };

    req = {
      body: {
        address: {
          country: 'AR',
        },
      },
      user: undefined,
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  const executeHandler = async (user: { id: string; role: string } | null = {
    id: 'investor-123',
    role: 'investor',
  }) => {
    const router = createKycRoutes(
      mockKycRouter as unknown as KycRouter,
    );

    const routeLayer = router.stack.find(
      (layer: { route?: { path?: string } }) => layer.route?.path === '/',
    );

    if (!routeLayer) {
      throw new Error('KYC POST route not found');
    }

    const handlers = routeLayer.route.stack;
    const handler = handlers[handlers.length - 1].handle;

    await handler(
      {
        ...req,
        ...(user ? { user } : {}),
      } as Request,
      res as Response,
      next as NextFunction,
    );
  };

  describe('country validation', () => {
    it('returns 400 when country is a number', async () => {
      req.body = {
        address: {
          country: 123,
        },
      };

      await executeHandler();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid country code',
      });

      expect(mockKycRouter.route).not.toHaveBeenCalled();
      expect(mockProvider.initiateCheck).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when country is an object', async () => {
      req.body = {
        address: {
          country: {},
        },
      };

      await executeHandler();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid country code',
      });

      expect(mockKycRouter.route).not.toHaveBeenCalled();
      expect(mockProvider.initiateCheck).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when country is an empty string', async () => {
      req.body = {
        address: {
          country: '',
        },
      };

      await executeHandler();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Country jurisdiction is required in address',
      });

      expect(mockKycRouter.route).not.toHaveBeenCalled();
      expect(mockProvider.initiateCheck).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when country has three letters', async () => {
      req.body = {
        address: {
          country: 'ARG',
        },
      };

      await executeHandler();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid country code',
      });

      expect(mockKycRouter.route).not.toHaveBeenCalled();
      expect(mockProvider.initiateCheck).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when country is missing', async () => {
      req.body = {
        address: {},
      };

      await executeHandler();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Country jurisdiction is required in address',
      });

      expect(mockKycRouter.route).not.toHaveBeenCalled();
    });

    it('returns 400 when country is null', async () => {
      req.body = {
        address: {
          country: null,
        },
      };

      await executeHandler();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Country jurisdiction is required in address',
      });

      expect(mockKycRouter.route).not.toHaveBeenCalled();
    });
  });

  describe('valid country codes', () => {
    it('routes a valid lowercase country code in uppercase', async () => {
      req.body = {
        address: {
          country: 'ar',
        },
      };

      await executeHandler();

      expect(mockKycRouter.route).toHaveBeenCalledWith('AR');
      expect(mockProvider.initiateCheck).toHaveBeenCalledWith(
        'investor-123',
        expect.objectContaining({
          address: {
            country: 'ar',
          },
        }),
      );

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('routes a valid uppercase country code', async () => {
      req.body = {
        address: {
          country: 'AR',
        },
      };

      await executeHandler();

      expect(mockKycRouter.route).toHaveBeenCalledWith('AR');
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  it('returns 401 when the investor is not authenticated', async () => {
    await executeHandler(null);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unauthorized: User not authenticated',
    });
    expect(mockKycRouter.route).not.toHaveBeenCalled();
  });

  it('returns 403 for an unsupported jurisdiction', async () => {
    req.body = {
      address: {
        country: 'ZZ',
      },
    };
    mockKycRouter.route.mockImplementation(() => {
      throw new UnsupportedJurisdictionError('ZZ');
    });

    await executeHandler();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Jurisdiction not supported',
    });
  });

  it('passes an AppError provider failure through the route response', async () => {
    const appError = Errors.badRequest('Invalid KYC applicant');
    mockProvider.initiateCheck.mockRejectedValue(appError);

    await executeHandler();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(appError.toResponse());
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards unexpected provider failures to next', async () => {
    const unexpectedError = new Error('provider unavailable');
    mockProvider.initiateCheck.mockRejectedValue(unexpectedError);

    await executeHandler();

    expect(next).toHaveBeenCalledWith(unexpectedError);
    expect(res.status).not.toHaveBeenCalled();
  });
});
