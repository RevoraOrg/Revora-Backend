import { Request, Response } from 'express';
import { OfferingRepository } from '../db/offeringRepository';
import { ConcurrencyError } from '../lib/errors';
import { Logger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';

/**
 * Handler for updating offerings with ETag and Optimistic Concurrency support.
 */
export const createUpdateOfferingHandler = (
  offeringRepo: OfferingRepository,
  logger: Logger,
  metrics: MetricsCollector
) => {
  return async (req: Request, res: Response) => {
    const { id } = req.params;
    const issuerId = req.user?.id; // Assuming user is attached via auth middleware

    // Extract version from If-Match header (ETag) or request body
    const ifMatch = req.headers['if-match'];
    const bodyVersion = req.body.version;
    
    // Parse version from "W/5" or "5" formats if header is used
    const version = ifMatch 
      ? parseInt((ifMatch as string).replace(/^(W\/|")|(")$/g, ''), 10)
      : bodyVersion;

    if (issuerId === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (version === undefined || isNaN(version)) {
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: 'A valid version or If-Match header is required for updates.' 
      });
    }

    try {
      logger.info('Attempting to update offering', { offeringId: id, issuerId, version });

      const updatedOffering = await offeringRepo.update(id, issuerId, {
        ...req.body,
        version
      });

      // Set ETag for the new version
      res.setHeader('ETag', `W/"${updatedOffering.version}"`);
      
      return res.status(200).json(updatedOffering);
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        logger.warn('Concurrency conflict updating offering', { 
          offeringId: id, 
          providedVersion: version 
        });
        metrics.increment('offering.update.conflict', { offeringId: id });
        return res.status(error.statusCode).json(error.toJSON());
      }

      logger.error('Failed to update offering', { error, offeringId: id });
      return res.status(500).json({ 
        error: 'Internal Server Error', 
        message: 'An unexpected error occurred.' 
      });
    }
  };
};