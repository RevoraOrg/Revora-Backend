import { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { app } from '../index';

describe('Startup Auth Brute-Force Mitigation', () => {
    const prefix = process.env.API_VERSION_PREFIX ?? '/api/v1';

    /**
     * @test Startup Registration Rate Limiting
     * @desc Verifies that the brute-force mitigation (rate limiting) is active on the startup registration endpoint.
     */
    it('should allow up to 5 registration attempts and block the 6th with 429', async () => {
        // Send 5 requests (within limit)
        for (let i = 0; i < 5; i++) {
            const res = await request(app)
                .post(`${prefix}/startup/register`)
                .send({
                    email: `brute-${i}@example.com`,
                    password: 'Password123!',
                    name: `User ${i}`
                });
            
            // Should not be 429. Might be 400/409, but NOT 429.
            expect(res.status).not.toBe(429);
        }

        // The 6th request should be rate limited
        const res6 = await request(app)
            .post(`${prefix}/startup/register`)
            .send({
                email: 'brute-6@example.com',
                password: 'Password123!',
                name: 'User 6'
            });

        expect(res6.status).toBe(429);
        expect(res6.body.error).toBe('TooManyRequests');
        expect(res6.body.message).toMatch(/Too many registration attempts/i);
        expect(res6.headers['x-ratelimit-limit']).toBe('5');
        expect(res6.headers['x-ratelimit-remaining']).toBe('0');
        expect(res6.headers['retry-after']).toBeDefined();
    });

    /**
     * @test Rate Limit Isolation
     * @desc Ensures that rate limiting on startup auth does not affect other endpoints like health.
     */
    it('should not affect health endpoint when startup auth is rate limited', async () => {
        const res = await request(app).get('/health');
        expect([200, 503]).toContain(res.status);
        expect(res.status).not.toBe(429);
    });
});
