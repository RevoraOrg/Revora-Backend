import { Request, Response } from 'express';
import { offeringSanitizeMiddleware } from './offeringSanitize';

describe('offeringSanitizeMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = { body: {} };
    res = {};
    next = jest.fn();
  });

  it('sanitizes offering fields in req.body', () => {
    req.body = {
      name: '<b>Safe Name</b>',
      description: '<p>Hello</p><script>alert(1)</script>',
      other: '<script>ignore</script>'
    };

    offeringSanitizeMiddleware(req as Request, res as Response, next);

    expect(req.body.name).toBe('Safe Name'); // HTML stripped
    expect(req.body.description).toBe('<p>Hello</p>'); // Safe HTML kept
    expect(req.body.other).toBe('<script>ignore</script>'); // Non-specified fields untouched
    expect(next).toHaveBeenCalled();
  });

  it('handles missing body', () => {
    req.body = undefined;
    offeringSanitizeMiddleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('sanitizes symbol and title', () => {
    req.body = {
      symbol: '<i>ABC</i>',
      title: '<h1>Title</h1>'
    };
    offeringSanitizeMiddleware(req as Request, res as Response, next);
    expect(req.body.symbol).toBe('ABC');
    expect(req.body.title).toBe('Title');
  });
});
