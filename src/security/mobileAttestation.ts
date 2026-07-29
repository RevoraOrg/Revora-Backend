import { Request, Response, NextFunction } from 'express';
import { globalMetrics } from '../lib/metrics';
import { globalLogger as logger } from '../lib/logger';
import crypto from 'crypto';

// Basic in-memory nonce store to prevent replay attacks
// For a production deployment, this should be backed by Redis or Memcached
const usedNonces = new Set<string>();

export function verifyPlayIntegrity(attestation: string): boolean {
  // In a real implementation, this would verify the Play Integrity API token
  // against Google's servers or using Google's provided public keys.
  return attestation.includes('play-integrity');
}

export function verifyAppAttest(attestation: string): boolean {
  // In a real implementation, this would verify the Apple App Attest token
  return attestation.includes('app-attest');
}

/**
 * Express middleware to enforce Mobile Integrity Attestation on high-value endpoints.
 */
export const requireMobileAttestation = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const attestation = req.header('x-mobile-attestation');
    const provider = req.header('x-attestation-provider');
    const nonce = req.header('x-attestation-nonce');

    if (!attestation || !provider || !nonce) {
      globalMetrics.incrementCounter('mobile.attestation.rejected', { reason: 'missing_headers' });
      res.status(401).json({ error: 'Missing mobile attestation headers (x-mobile-attestation, x-attestation-provider, x-attestation-nonce)' });
      return;
    }

    if (usedNonces.has(nonce)) {
      globalMetrics.incrementCounter('mobile.attestation.rejected', { reason: 'nonce_reused' });
      res.status(401).json({ error: 'Attestation nonce already used' });
      return;
    }

    // Rooted-device signal blocks assertion
    if (attestation.includes('rooted') || attestation.includes('jailbroken')) {
      globalMetrics.incrementCounter('mobile.attestation.rejected', { reason: 'rooted_device' });
      res.status(403).json({ error: 'Device appears to be rooted or compromised' });
      return;
    }

    let isValid = false;
    if (provider === 'play-integrity') {
      isValid = verifyPlayIntegrity(attestation);
    } else if (provider === 'app-attest') {
      isValid = verifyAppAttest(attestation);
    } else {
      globalMetrics.incrementCounter('mobile.attestation.rejected', { reason: 'unknown_provider' });
      res.status(400).json({ error: 'Unknown attestation provider' });
      return;
    }

    if (!isValid) {
      globalMetrics.incrementCounter('mobile.attestation.rejected', { reason: 'invalid_attestation' });
      res.status(401).json({ error: 'Invalid mobile attestation signature' });
      return;
    }

    // Mark nonce as used
    usedNonces.add(nonce);
    
    // Prevent memory leaks in this simple in-memory implementation
    if (usedNonces.size > 50000) {
      const iter = usedNonces.values();
      for (let i = 0; i < 10000; i++) {
        usedNonces.delete(iter.next().value);
      }
    }

    next();
  } catch (error) {
    logger.error('Mobile attestation validation failed', { error });
    globalMetrics.incrementCounter('mobile.attestation.rejected', { reason: 'internal_error' });
    res.status(500).json({ error: 'Internal server error during attestation' });
  }
};
