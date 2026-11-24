
import { Request, Response, NextFunction } from 'express';

import { createKycRoutes } from './kyc';
import { KycRouter } from '../services/kyc/KycRouter';

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

  const executeHandler = async () => {
    const router = createKycRoutes(
      mockKycRouter as unknown as KycRouter,
    );

    const routeLayer = router.stack.find(
      (layer: any) => layer.route?.path === '/',
    );

    if (!routeLayer) {
      throw new Error('KYC POST route not found');
    }

    const handlers = routeLayer.route.stack;
    const handler = handlers[handlers.length - 1].handle;

    await handler(
      {
        ...req,
        user: { id: 'investor-123', role: 'investor' },
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
});
