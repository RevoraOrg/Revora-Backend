import { NextFunction, Request, Response } from 'express';
import {
  createListInvestmentsByOfferingHandler,
  Investment,
  InvestmentRepository,
  OfferingRepository,
} from './offerings.investments';

/**
 * Regression coverage for the failure/empty-result path of the investment
 * listing route (`parseNonNegativeInt` in `src/routes/offerings.investments.ts`).
 *
 * The parser has three explicit "give up" branches - `undefined`, array-valued
 * query parameters, and non-integer/negative numbers - and the handler turns a
 * refusal into `400 { error: 'Invalid <field>' }` without touching the
 * repository. Those branches change silently because `Number()` coerces
 * aggressively, so the boundary inputs that *do* coerce are pinned here too.
 */

type Query = Record<string, string | string[] | undefined>;
type Caller = { id: string; role?: string };
type PaginationOptions = { limit?: number; offset?: number };

const makeRes = (): jest.Mocked<Response> => {
  const res = {} as unknown as jest.Mocked<Response>;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeNext = (): NextFunction => jest.fn();

const makeReq = (
  overrides: {
    query?: Query;
    params?: Record<string, string>;
    user?: Caller;
    auth?: { userId: string; role?: string };
  } = {}
): Request =>
  ({
    params: overrides.params ?? { id: 'offering-1' },
    query: overrides.query ?? {},
    user: overrides.user,
    auth: overrides.auth,
  }) as unknown as Request;

const issuer: Caller = { id: 'issuer-1', role: 'issuer' };
const ownedOffering = { id: 'offering-1', issuer_id: 'issuer-1' };

describe('GET /api/offerings/:id/investments - query failure and boundary paths', () => {
  let investmentRepository: jest.Mocked<InvestmentRepository>;
  let offeringRepository: jest.Mocked<OfferingRepository>;

  const buildHandler = () =>
    createListInvestmentsByOfferingHandler({ investmentRepository, offeringRepository });

  const forwardedOptions = (): PaginationOptions =>
    investmentRepository.listByOffering.mock.calls[0][1] as PaginationOptions;

  beforeEach(() => {
    investmentRepository = { listByOffering: jest.fn() };
    offeringRepository = { getById: jest.fn() };
    offeringRepository.getById.mockResolvedValue(ownedOffering);
    investmentRepository.listByOffering.mockResolvedValue([]);
  });

  it('forwards limit 0 and offset 0 (0 is a valid non-negative integer)', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: '0', offset: '0' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 0,
      offset: 0,
    });
  });

  it('coerces blank query values to 0 rather than rejecting them', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: '', offset: '   ' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 0,
      offset: 0,
    });
  });

  it('accepts exponent and hexadecimal notation', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: '1e3', offset: '0x10' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 1000,
      offset: 16,
    });
  });

  it('accepts plus-signed and decimal-zero forms', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: '+5', offset: '5.0' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 5,
      offset: 5,
    });
  });

  it('treats a literal -0 as zero', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { offset: '-0' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    const options = forwardedOptions();
    expect(options.limit).toBeUndefined();
    expect(Number.isInteger(options.offset)).toBe(true);
    expect(options.offset === 0).toBe(true);
  });

  it('forwards large integers with Number precision (no guard above MAX_SAFE_INTEGER)', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: '9007199254740993' } }), res, makeNext());

    // Documents current behaviour: the value is a valid integer as far as the
    // parser is concerned, so it is forwarded after Number() rounding.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 9007199254740992,
      offset: undefined,
    });
  });

  it('round-trips an empty result set', async () => {
    investmentRepository.listByOffering.mockResolvedValueOnce([]);
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: [] });
  });

  it('resolves the caller from req.auth when req.user is absent', async () => {
    const res = makeRes();
    await buildHandler()(
      makeReq({ auth: { userId: 'issuer-1', role: 'issuer' }, query: { limit: '3' } }),
      res,
      makeNext()
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 3,
      offset: undefined,
    });
  });

  const invalidCases: Array<[string, Query, string]> = [
    ['an array limit (duplicated query parameter)', { limit: ['1', '2'] }, 'Invalid limit'],
    ['an array offset (duplicated query parameter)', { offset: ['1', '2'] }, 'Invalid offset'],
    ['a fractional limit', { limit: '1.5' }, 'Invalid limit'],
    ['a fractional offset', { offset: '2.5' }, 'Invalid offset'],
    ['a non-numeric limit', { limit: 'abc' }, 'Invalid limit'],
    ['a boolean-looking limit', { limit: 'true' }, 'Invalid limit'],
    ['an Infinity limit', { limit: 'Infinity' }, 'Invalid limit'],
    ['a NaN literal offset', { offset: 'NaN' }, 'Invalid offset'],
    ['a negative offset', { offset: '-1' }, 'Invalid offset'],
    ['a negative fractional offset', { offset: '-2.5' }, 'Invalid offset'],
  ];

  it.each(invalidCases)('returns 400 for %s', async (_label, query, expectedError) => {
    const next = makeNext();
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query }), res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expectedError });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid offset even when the limit is valid', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: '5', offset: 'bad' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('reports the limit error first when both parameters are invalid', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: 'bad', offset: 'bad' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid limit even when the offset is valid', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, query: { limit: 'bad', offset: '5' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('rejects a request without an offering id before any repository lookup', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer, params: {} }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' });
    expect(offeringRepository.getById).not.toHaveBeenCalled();
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('propagates repository failures to next() instead of writing a response', async () => {
    const failure = new Error('db down');
    investmentRepository.listByOffering.mockRejectedValueOnce(failure);
    const next = makeNext();
    const res = makeRes();

    await buildHandler()(makeReq({ user: issuer, query: { limit: '10' } }), res, next);

    expect(next).toHaveBeenCalledWith(failure);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('propagates offering lookup failures to next()', async () => {
    const failure = new Error('offering lookup failed');
    offeringRepository.getById.mockRejectedValueOnce(failure);
    const next = makeNext();
    const res = makeRes();

    await buildHandler()(makeReq({ user: issuer }), res, next);

    expect(next).toHaveBeenCalledWith(failure);
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('never forwards a parsed value when the parameter was absent', async () => {
    const res = makeRes();
    await buildHandler()(makeReq({ user: issuer }), res, makeNext());

    expect(forwardedOptions()).toEqual({ limit: undefined, offset: undefined });
  });
});

describe('GET /api/offerings/:id/investments - repository contract', () => {
  it('only ever receives integers in the pagination options', async () => {
    const calls: PaginationOptions[] = [];
    const investmentRepository: InvestmentRepository = {
      listByOffering: jest.fn(async (_offeringId: string, options?: PaginationOptions) => {
        calls.push(options ?? {});
        return [] as Investment[];
      }),
    };
    const offeringRepository: OfferingRepository = {
      getById: jest.fn(async () => ({ id: 'offering-1', issuer_id: 'issuer-1' })),
    };
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });

    const accepted: Query[] = [
      { limit: '0', offset: '0' },
      { limit: '10', offset: '20' },
      { limit: '1e3', offset: '0x10' },
      { limit: '', offset: '   ' },
    ];

    for (const query of accepted) {
      await handler(makeReq({ user: issuer, query }), makeRes(), makeNext());
    }

    expect(calls).toHaveLength(accepted.length);
    for (const options of calls) {
      if (options.limit !== undefined) {
        expect(Number.isInteger(options.limit)).toBe(true);
        expect(options.limit).toBeGreaterThanOrEqual(0);
      }
      if (options.offset !== undefined) {
        expect(Number.isInteger(options.offset)).toBe(true);
        expect(options.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
