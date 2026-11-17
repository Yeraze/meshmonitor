/**
 * v1 API - Documentation Endpoint
 *
 * Serves interactive Swagger UI documentation for the v1 API
 */

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Load OpenAPI specification
const openapiPath = path.join(__dirname, 'openapi.yaml');
const swaggerDocument = YAML.load(openapiPath);

// Swagger UI options
const options = {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'MeshMonitor API Documentation',
  customfavIcon: '/favicon.ico',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    syntaxHighlight: {
      activate: true,
      theme: 'monokai'
    }
  }
};

/**
 * The spec's `servers` entry, built per request (#6462).
 *
 * `req.baseUrl` is the path this router is mounted under, e.g. `/api/v1/docs`
 * or `/meshmonitor/api/v1/docs` with BASE_URL. Dropping `/docs` gives the API
 * root. It is host-relative, so Swagger UI's "Try it out" sends requests to
 * whatever host, IP, port or reverse proxy the page was loaded from, never a
 * hardcoded localhost.
 */
export function apiServerUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/docs\/?$/, '');
  return root || '/api/v1';
}

export function buildRuntimeSpec(baseUrl: string): Record<string, unknown> {
  return {
    ...swaggerDocument,
    servers: [{ url: apiServerUrl(baseUrl), description: 'This MeshMonitor instance' }],
  };
}

// Serve raw OpenAPI spec as JSON
router.get('/openapi.json', (req, res) => {
  res.json(buildRuntimeSpec(req.baseUrl));
});

// Serve raw OpenAPI spec as YAML
router.get('/openapi.yaml', (_req, res) => {
  res.type('text/yaml').sendFile(openapiPath);
});

// Attach the per-request spec. swagger-ui-express reads `req.swaggerDoc` both
// when rendering the page and when serving swagger-ui-init.js (serveFiles),
// so the "Try it out" target always matches the host the page came from.
const attachRuntimeSpec: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { swaggerDoc?: unknown }).swaggerDoc = buildRuntimeSpec(req.baseUrl);
  next();
};

// Serve Swagger UI
router.use('/', attachRuntimeSpec, swaggerUi.serveFiles(undefined, options));
router.get('/', attachRuntimeSpec, swaggerUi.setup(undefined, options));

export default router;
