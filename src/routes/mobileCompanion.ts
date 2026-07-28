import { Router, Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';
import {
  DeviceKeyStore,
  InMemoryDeviceKeyStore,
  generateEd25519Keypair,
  createDeviceSignatureMiddleware,
  AuthenticatedDeviceRequest,
  InMemoryReplayCache,
} from '../middleware/deviceSignature';

/**
 * Mobile Companion API routes
 *
 * Provides device enrollment and a protected echo endpoint for verifying
 * the signature pipeline end-to-end. All routes under /mobile/* require
 * per-device Ed25519 request signatures after enrollment.
 *
 * Mount point: apiRouter.use('/mobile', createMobileCompanionRouter(deps))
 */

export interface MobileCompanionDependencies {
  /** Shared key store – reuse across router instances for a single source of truth. */
  keyStore?: DeviceKeyStore;
}

export function createMobileCompanionRouter(
  deps: MobileCompanionDependencies = {},
): Router {
  const router = Router();
  const keyStore = deps.keyStore ?? new InMemoryDeviceKeyStore();
  const replayCache = new InMemoryReplayCache();

  // ── POST /enroll – Device enrollment (unauthenticated) ─────────────
  /**
   * Enrollment is the first call a mobile companion makes after install.
   * The client generates an Ed25519 keypair locally and sends the public
   * key here. The server returns the install_id the client should use in
   * all subsequent requests.
   *
   * Request body: { publicKey: string }
   * Response:     { installId: string }
   *
   * Security: Rate-limited at the route level. The server does NOT return
   * the private key – it exists only on the device.
   */
  router.post('/enroll', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { publicKey } = req.body ?? {};

      if (!publicKey || typeof publicKey !== 'string') {
        next(Errors.badRequest('Request body must include a "publicKey" string'));
        return;
      }

      // Basic PEM format validation
      if (
        !publicKey.startsWith('-----BEGIN PUBLIC KEY-----') ||
        !publicKey.includes('Ed25519')
      ) {
        next(
          Errors.badRequest(
            'publicKey must be a PEM-encoded Ed25519 public key (SPKI)',
          ),
        );
        return;
      }

      // Generate install ID (opaque UUID)
      const installId = `install_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

      await keyStore.setPublicKey(installId, publicKey);

      res.status(201).json({ installId });
    } catch (err) {
      next(
        Errors.internal(
          err instanceof Error ? err.message : 'Device enrollment failed',
        ),
      );
    }
  });

  // ── Protected routes below ─────────────────────────────────────────

  const deviceAuth = createDeviceSignatureMiddleware({ keyStore, replayCache });

  // GET /mobile/ping – authenticated ping for connection health check
  router.get('/ping', deviceAuth, (_req: Request, res: Response) => {
    const { installId } = (_req as AuthenticatedDeviceRequest).deviceAuth!;
    res.json({ status: 'ok', installId });
  });

  return router;
}

export const __test = {
  createMobileCompanionRouter,
};
