import express from 'express';
import { Request, Response } from 'express';
import request from 'supertest';
import { createCorsMiddleware } from './cors';

// Mock the logger to avoid console output during tests
jest.mock('../lib/logger', () => ({
  globalLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the env module
jest.mock('../config/env', () => ({
  env: {
    ALLOWED_ORIGINS: [],
  },
}));

describe('CORS Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Helper to create a test app with CORS
  function createTestApp(dependencies: { allowedOrigins?: string[]; corsAllowNoOrigin?: string; nodeEnv?: string } = {}) {
    // Mock the env for this test
    const mockEnv = jest.requireMock('../config/env');
    mockEnv.env.ALLOWED_ORIGINS = dependencies.allowedOrigins || [];

    if (dependencies.corsAllowNoOrigin !== undefined) {
      process.env.CORS_ALLOW_NO_ORIGIN = dependencies.corsAllowNoOrigin;
    }
    if (dependencies.nodeEnv !== undefined) {
      process.env.NODE_ENV = dependencies.nodeEnv;
    }

    const app = express();
    app.use(createCorsMiddleware());
    app.get('/test', (req: Request, res: Response) => res.json({ ok: true }));
    return app;
  }

  describe('Configuration', () => {
    it('should throw error in production without ALLOWED_ORIGINS', () => {
      expect(() => createTestApp({ nodeEnv: 'production', allowedOrigins: [] })).toThrow('ALLOWED_ORIGINS must be configured in production environment');
    });

    it('should throw error if wildcard "*" is in ALLOWED_ORIGINS', () => {
      expect(() => createTestApp({ allowedOrigins: ['*'] })).toThrow("CORS configuration error: Wildcard origin '*' is not allowed when credentials are true");
    });

    it('should not throw in development without ALLOWED_ORIGINS', () => {
      expect(() => createTestApp({ nodeEnv: 'development', allowedOrigins: [] })).not.toThrow();
    });

    it('should accept ALLOWED_ORIGINS in production', () => {
      expect(() => createTestApp({ nodeEnv: 'production', allowedOrigins: ['https://app.example.com'] })).not.toThrow();
    });
  });

  describe('Origin Validation', () => {
    it('should allow requests from allowed origins', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'] });

      const response = await request(app)
        .options('/test')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('should deny requests from unknown origins', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'] });

      const response = await request(app)
        .options('/test')
        .set('Origin', 'https://evil.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(200); // CORS preflight still returns 200 but without allow headers
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should allow requests without origin when CORS_ALLOW_NO_ORIGIN is true', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'], corsAllowNoOrigin: 'true' });

      const response = await request(app)
        .get('/test');

      expect(response.status).toBe(200);
    });

    it('should deny requests without origin when CORS_ALLOW_NO_ORIGIN is false', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'], corsAllowNoOrigin: 'false' });

      const response = await request(app)
        .options('/test')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('CORS Headers', () => {
    it('should include correct CORS headers in preflight response', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'] });

      const response = await request(app)
        .options('/test')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'content-type,authorization');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
      expect(response.headers['access-control-allow-headers']).toContain('X-Request-Id');
      expect(response.headers['access-control-max-age']).toBe('86400');
    });

    it('should include exposed headers in actual response', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'] });

      const response = await request(app)
        .get('/test')
        .set('Origin', 'https://app.example.com');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-expose-headers']).toBe('X-Request-Id');
    });

    it('should handle actual requests with allowed origin', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'] });

      const response = await request(app)
        .get('/test')
        .set('Origin', 'https://app.example.com');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle malformed origins gracefully', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com'] });

      const response = await request(app)
        .options('/test')
        .set('Origin', 'not-a-valid-origin')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should handle empty ALLOWED_ORIGINS array', async () => {
      const app = createTestApp({ allowedOrigins: [], nodeEnv: 'development' });

      const response = await request(app)
        .options('/test')
        .set('Origin', 'https://any.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should handle comma-separated origins correctly', async () => {
      const app = createTestApp({ allowedOrigins: ['https://app.example.com', 'https://admin.example.com', 'https://test.example.com'] });

      // Test first origin
      let response = await request(app)
        .options('/test')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');

      // Test second origin (with spaces)
      response = await request(app)
        .options('/test')
        .set('Origin', 'https://admin.example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(response.headers['access-control-allow-origin']).toBe('https://admin.example.com');

      // Test third origin
      response = await request(app)
        .options('/test')
        .set('Origin', 'https://test.example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(response.headers['access-control-allow-origin']).toBe('https://test.example.com');
    });
  });
});