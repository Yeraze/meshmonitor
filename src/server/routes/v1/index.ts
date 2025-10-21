/**
 * API v1 Router
 *
 * Main router for versioned API endpoints
 */

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../../docs/openapi.js';
import { apiKeyOrSessionAuth } from '../../auth/apiKeyAuth.js';
import { apiKeyRateLimiter, docsRateLimiter } from '../../middleware/apiKeyRateLimiter.js';
import nodesRouter from './nodes.js';
import messagesRouter from './messages.js';
import channelsRouter from './channels.js';
import statsRouter from './stats.js';
import telemetryRouter from './telemetry.js';
import systemRouter from './system.js';

const router = express.Router();

// Apply rate limiting to all v1 routes
router.use(apiKeyRateLimiter);

// Apply API key or session authentication to all v1 routes
router.use(apiKeyOrSessionAuth);

// API Documentation (with relaxed rate limiting)
router.use('/docs', docsRateLimiter, swaggerUi.serve);
router.get('/docs', swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'MeshMonitor API Documentation'
}));

// Serve OpenAPI spec as JSON
router.get('/openapi.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Mount route modules
router.use('/nodes', nodesRouter);
router.use('/messages', messagesRouter);
router.use('/channels', channelsRouter);
router.use('/stats', statsRouter);
router.use('/telemetry', telemetryRouter);
router.use('/health', systemRouter);
router.use('/status', systemRouter);

export default router;
