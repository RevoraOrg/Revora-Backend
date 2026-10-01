import { createScimAuth } from './scimAuth';
import { Request, Response, NextFunction } from 'express';

describe('createScimAuth', () => {
  const token = 'secret-token';
  const middleware = createScimAuth(token);
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      headers: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it('calls next when valid token is provided', () => {
    req.headers = { authorization: `Bearer ${token}` };
    middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 401 when missing Authorization header', () => {
    middleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: 401,
      scimType: 'authorization',
      detail: 'Missing or malformed Authorization header',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is malformed', () => {
    req.headers = { authorization: `Basic user:pass` };
    middleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: 401,
      scimType: 'authorization',
      detail: 'Missing or malformed Authorization header',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when invalid token is provided', () => {
    req.headers = { authorization: `Bearer wrong-token` };
    middleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: 401,
      scimType: 'authorization',
      detail: 'Invalid SCIM bearer token',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
