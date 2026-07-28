import { OfferingRepository } from '../db/offeringRepository';
import { createUpdateOfferingHandler } from './offeringHandler';
import { ConcurrencyError } from '../lib/errors';
import { Request, Response } from 'express';

describe('Offering Handler - Optimistic Concurrency', () => {
  let mockRepo: jest.Mocked<OfferingRepository>;
  let mockLogger: any;
  let mockMetrics: any;
  let mockRes: Partial<Response>;
  let handler: any;

  beforeEach(() => {
    mockRepo = { update: jest.fn() } as any;
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    mockMetrics = { increment: jest.fn() };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    handler = createUpdateOfferingHandler(mockRepo as any, mockLogger, mockMetrics);
  });

  it('should update successfully when version matches', async () => {
    const req = {
      params: { id: 'offering-1' },
      user: { id: 'startup-1' },
      body: { title: 'New Title', version: 1 },
      headers: {}
    } as any;

    const updated = { id: 'offering-1', version: 2, title: 'New Title' };
    mockRepo.update.mockResolvedValue(updated as any);

    await handler(req, mockRes as Response);

    expect(mockRepo.update).toHaveBeenCalledWith('offering-1', 'startup-1', expect.objectContaining({ version: 1 }));
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.setHeader).toHaveBeenCalledWith('ETag', 'W/"2"');
    expect(mockRes.json).toHaveBeenCalledWith(updated);
  });

  it('should return 409 Conflict when repository throws ConcurrencyError', async () => {
    const req = {
      params: { id: 'offering-1' },
      user: { id: 'startup-1' },
      body: { title: 'New Title', version: 1 },
      headers: {}
    } as any;

    mockRepo.update.mockRejectedValue(new ConcurrencyError('Version mismatch'));

    await handler(req, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockMetrics.increment).toHaveBeenCalledWith('offering.update.conflict', expect.any(Object));
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CONCURRENCY_CONFLICT'
    }));
  });

  it('should support version from If-Match header', async () => {
    const req = {
      params: { id: 'offering-1' },
      user: { id: 'startup-1' },
      body: { title: 'New Title' },
      headers: { 'if-match': 'W/"5"' }
    } as any;

    mockRepo.update.mockResolvedValue({ version: 6 } as any);

    await handler(req, mockRes as Response);

    expect(mockRepo.update).toHaveBeenCalledWith(
      'offering-1', 
      'startup-1', 
      expect.objectContaining({ version: 5 })
    );
  });

  it('should return 400 if version is missing', async () => {
    const req = {
      params: { id: 'offering-1' },
      user: { id: 'startup-1' },
      body: { title: 'New Title' },
      headers: {}
    } as any;

    await handler(req, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Bad Request'
    }));
  });
});