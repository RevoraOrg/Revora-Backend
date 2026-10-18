import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import {
  ContractUpgradeInput,
  ContractUpgradeService,
  createContractUpgradeRouter,
} from './contractUpgradeRoutes';

const validContractId = `C${'A'.repeat(55)}`;
const validWasmHash = 'a'.repeat(64);

const createAuthMiddleware = (userId?: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as any).auth = { userId };
    next();
  };
};

const createTestApp = (contractUpgradeService: ContractUpgradeService, userId?: string) => {
  const app = express();
  app.use(express.json());
  app.use(
    createContractUpgradeRouter({
      requireAuth: createAuthMiddleware(userId),
      contractUpgradeService,
    })
  );
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return app;
};

describe('createContractUpgradeRouter', () => {
  let contractUpgradeService: jest.Mocked<ContractUpgradeService>;

  beforeEach(() => {
    contractUpgradeService = {
      requestUpgrade: jest.fn(),
    };
  });

  it('requires authentication before accepting an upgrade request', async () => {
    const response = await request(createTestApp(contractUpgradeService))
      .post(`/contracts/${validContractId}/upgrade`)
      .send({ wasmHash: validWasmHash });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
    expect(contractUpgradeService.requestUpgrade).not.toHaveBeenCalled();
  });

  it('rejects a malformed contract ID', async () => {
    const response = await request(createTestApp(contractUpgradeService, 'user-1'))
      .post('/contracts/not-a-contract/upgrade')
      .send({ wasmHash: validWasmHash });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid contract ID' });
    expect(contractUpgradeService.requestUpgrade).not.toHaveBeenCalled();
  });

  it.each(['', 'not-hex', 'a'.repeat(63), 'a'.repeat(65)])(
    'rejects invalid WASM hash input (%s)',
    async (wasmHash) => {
      const response = await request(createTestApp(contractUpgradeService, 'user-1'))
        .post(`/contracts/${validContractId}/upgrade`)
        .send({ wasmHash });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid WASM hash' });
      expect(contractUpgradeService.requestUpgrade).not.toHaveBeenCalled();
    }
  );

  it('submits a valid request and returns the pending upgrade state', async () => {
    const pendingUpgrade = {
      id: 'upgrade-1',
      contractId: validContractId,
      wasmHash: validWasmHash,
      status: 'pending',
    };
    contractUpgradeService.requestUpgrade.mockResolvedValueOnce(pendingUpgrade);

    const response = await request(createTestApp(contractUpgradeService, 'user-1'))
      .post(`/contracts/${validContractId}/upgrade`)
      .send({ wasmHash: validWasmHash.toUpperCase() });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: pendingUpgrade });
    expect(contractUpgradeService.requestUpgrade).toHaveBeenCalledWith({
      contractId: validContractId,
      wasmHash: validWasmHash,
      requestedBy: 'user-1',
    } satisfies ContractUpgradeInput);
  });

  it('forwards service failures to Express error handling', async () => {
    contractUpgradeService.requestUpgrade.mockRejectedValueOnce(new Error('upgrade unavailable'));

    const response = await request(createTestApp(contractUpgradeService, 'user-1'))
      .post(`/contracts/${validContractId}/upgrade`)
      .send({ wasmHash: validWasmHash });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'upgrade unavailable' });
    expect(contractUpgradeService.requestUpgrade).toHaveBeenCalledTimes(1);
  });
});