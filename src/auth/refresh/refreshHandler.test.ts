/**
 * @file src/auth/refresh/refreshHandler.test.ts
 * @description Unit and HTTP integration tests for refresh handler and router.
 */

import express from 'express';
import request from 'supertest';
import { createRefreshRouter } from './refreshRoute';
import { RefreshService } from './refreshService';

describe('createRefreshRouter & createRefreshHandler', () => {
    let mockRefreshService: jest.Mocked<RefreshService>;
    let app: express.Express;

    beforeEach(() => {
        mockRefreshService = {
            refresh: jest.fn(),
        } as unknown as jest.Mocked<RefreshService>;

        app = express();
        app.use(express.json());
        app.use(createRefreshRouter({ refreshService: mockRefreshService }));
    });

    it('returns 400 Bad Request when refreshToken is missing in request body', async () => {
        const res = await request(app)
            .post('/api/auth/refresh')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'Bad Request',
            message: '"refreshToken" is required.',
        });
        expect(mockRefreshService.refresh).not.toHaveBeenCalled();
    });

    it('returns 401 when refreshService returns null (invalid or expired token)', async () => {
        mockRefreshService.refresh.mockResolvedValue(null);

        const res = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: 'invalid-token' });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Invalid or expired refresh token' });
        expect(mockRefreshService.refresh).toHaveBeenCalledWith('invalid-token');
    });

    it('returns 200 with tokens when refresh succeeds', async () => {
        const expectedResponse = {
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
        };
        mockRefreshService.refresh.mockResolvedValue(expectedResponse);

        const res = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: 'valid-refresh-token' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expectedResponse);
        expect(mockRefreshService.refresh).toHaveBeenCalledWith('valid-refresh-token');
    });

    it('propagates errors to error middleware when refreshService throws', async () => {
        mockRefreshService.refresh.mockRejectedValue(new Error('Database unavailable'));

        const res = await request(app)
            .post('/api/auth/refresh')
            .send({ refreshToken: 'valid-refresh-token' });

        expect(res.status).toBe(500);
    });
});
