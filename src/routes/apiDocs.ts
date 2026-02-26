import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import path from 'path';

/**
 * Factory for an Express router that serves:
 *
 *   - GET /openapi.yaml  – raw OpenAPI 3.0 spec
 *   - GET /api-docs      – Swagger UI backed by the spec
 *
 * Mount this router only in development, for example:
 *
 *   if (process.env.NODE_ENV !== 'production') {
 *     app.use(createApiDocsRouter());
 *   }
 */
export const createApiDocsRouter = (): Router => {
  const router = Router();

  const specFilePath = path.resolve(__dirname, '../docs/openapi.yaml');

  router.get('/openapi.yaml', (req, res, next) => {
    res.sendFile(specFilePath, (err) => {
      if (err) {
        next(err);
      }
    });
  });

  router.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      swaggerOptions: {
        url: '/openapi.yaml',
      },
    })
  );

  return router;
};

