import { Request, Response, NextFunction } from 'express';

export function createScimAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: 401,
        scimType: 'authorization',
        detail: 'Missing or malformed Authorization header',
      });
      return;
    }
    const provided = auth.slice(7);
    if (provided !== token) {
      res.status(401).json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: 401,
        scimType: 'authorization',
        detail: 'Invalid SCIM bearer token',
      });
      return;
    }
    next();
  };
}
