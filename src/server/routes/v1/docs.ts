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

// Serve Swagger UI
router.use('/', swaggerUi.serve);
router.get('/', swaggerUi.setup(swaggerDocument, options));

export default router;
