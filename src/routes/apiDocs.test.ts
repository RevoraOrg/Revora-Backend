import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createApiDocsRouter } from './apiDocs';

describe('createApiDocsRouter', () => {
  it('serves the OpenAPI specification', async () => {
    const app = express();
    app.use(createApiDocsRouter());
    const expectedSpec = readFileSync(
      path.resolve(__dirname, '../docs/openapi.yaml'),
      'utf8',
    );

    const response = await request(app).get('/openapi.yaml');

    expect(response.status).toBe(200);
    expect(response.text).toBe(expectedSpec);
  });

  it('serves Swagger UI HTML', async () => {
    const app = express();
    app.use(createApiDocsRouter());

    const response = await request(app).get('/api-docs/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('<html');
  });

  it('forwards errors from sendFile to Express error middleware', async () => {
    const app = express();
    const sendFileError = new Error('Unable to serve OpenAPI specification');

    app.use((_, res, next) => {
      Object.defineProperty(res, 'sendFile', {
        value: (_filePath: string, callback: (error?: Error) => void) => {
          callback(sendFileError);
        },
      });
      next();
    });
    app.use(createApiDocsRouter());
    app.use(
      (
        error: Error,
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        void next;
        res.status(500).json({ message: error.message });
      },
    );

    const response = await request(app).get('/openapi.yaml');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      message: sendFileError.message,
    });
  });
});
