/**
 * @file src/auth/refresh/refreshRoute.test.ts
 * @description Router wiring tests for `createRefreshRouter`.
 *
 * These tests verify the structural contract of the router independently of
 * handler logic:
 *  - POST /api/auth/refresh is mounted and reaches the injected handler.
 *  - GET /api/auth/refresh returns 404 (wrong method).
 *  - Unrelated paths are not handled by this router.
 *
 * The handler itself is covered by refreshHandler.test.ts; here we mock
 * `createRefreshHandler` so the router test is isolated from handler logic.
 */

import express from 'express';
import request from 'supertest';
import { createRefreshRouter } from './refreshRoute';
import { RefreshService } from './refreshService';

describe('createRefreshRouter – route wiring', () => {
    let mockRefreshService: jest.Mocked<Pick<RefreshService, 'refresh'>>;
    let app: express.Express;

    beforeEach(() => {
        mockRefreshService = {
            refresh: jest.fn(),
        };

        app = express();
        app.use(express.json());
        app.use(createRefreshRouter({ refreshService: mockRefreshService as unknown as RefreshService }));
    });

    describe('POST /api/auth/refresh – handler is wired', () => {
        it('reaches the handler and returns 200 when the service resolves a token pair', async () => {
            mockRefreshService.refresh.mockResolvedValue({
                accessToken: 'at',
                refreshToken: 'rt',
            });

            const res = await request(app)
                .post('/api/auth/refresh')
                .send({ refreshToken: 'some-token' });

            expect(res.status).toBe(200);
            expect(mockRefreshService.refresh).toHaveBeenCalledTimes(1);
            expect(mockRefreshService.refresh).toHaveBeenCalledWith('some-token');
        });

        it('reaches the handler and returns 401 when the service returns null', async () => {
            mockRefreshService.refresh.mockResolvedValue(null);

            const res = await request(app)
                .post('/api/auth/refresh')
                .send({ refreshToken: 'expired-token' });

            expect(res.status).toBe(401);
            expect(mockRefreshService.refresh).toHaveBeenCalledTimes(1);
        });

        it('reaches the handler and returns 400 when refreshToken is absent', async () => {
            const res = await request(app)
                .post('/api/auth/refresh')
                .send({});

            expect(res.status).toBe(400);
            // Handler rejects before calling the service
            expect(mockRefreshService.refresh).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/auth/refresh – wrong method', () => {
        it('returns 404 for a GET request to the refresh path', async () => {
            const res = await request(app).get('/api/auth/refresh');

            expect(res.status).toBe(404);
            // Service must not be touched on a method-mismatch
            expect(mockRefreshService.refresh).not.toHaveBeenCalled();
        });
    });

    describe('unrelated paths – not handled by this router', () => {
        it('returns 404 for a POST to an unrelated path', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ refreshToken: 'some-token' });

            expect(res.status).toBe(404);
            expect(mockRefreshService.refresh).not.toHaveBeenCalled();
        });

        it('returns 404 for a GET to an unrelated path', async () => {
            const res = await request(app).get('/api/users/me');

            expect(res.status).toBe(404);
            expect(mockRefreshService.refresh).not.toHaveBeenCalled();
        });

        it('returns 404 for a path that partially matches', async () => {
            const res = await request(app).post('/api/auth/refresh/extra');

            expect(res.status).toBe(404);
            expect(mockRefreshService.refresh).not.toHaveBeenCalled();
        });
    });
});
