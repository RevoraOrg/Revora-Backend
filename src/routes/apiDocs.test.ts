import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import request from 'supertest';
import { createApiDocsRouter } from './apiDocs';

describe('createApiDocsRouter', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(createApiDocsRouter());
  });

  it('serves the OpenAPI specification', async () => {
    const response = await request(app).get('/openapi.yaml');

    expect(response.status).toBe(200);
    expect(response.text).toContain('openapi: 3.0.0');
    expect(response.text).toContain('title: Revora Backend API');
  });

  it('serves Swagger UI configured to load the OpenAPI specification', async () => {
    const response = await request(app).get('/api-docs/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('Swagger UI');
    expect(response.text).toContain('/openapi.yaml');
  });

  it('returns not found for unsupported paths and methods', async () => {
    const unknownPath = await request(app).get('/not-api-docs');
    const unsupportedMethod = await request(app).post('/openapi.yaml');

    expect(unknownPath.status).toBe(404);
    expect(unsupportedMethod.status).toBe(404);
  });

  it('passes OpenAPI file errors to Express error middleware', async () => {
    const resolveSpy = jest.spyOn(path, 'resolve').mockReturnValue('/missing/openapi.yaml');
    try {
      app = express();
      app.use(createApiDocsRouter());
    } finally {
      resolveSpy.mockRestore();
    }
    app.use((error: NodeJS.ErrnoException, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ code: error.code });
    });

    const response = await request(app).get('/openapi.yaml');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ code: 'ENOENT' });
  });
});