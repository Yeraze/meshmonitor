/**
 * v1 API Router
 *
 * Main router for the versioned v1 REST API
 * All v1 routes require API token authentication
 */

import express from 'express';
import { requireAPIToken } from '../../auth/authMiddleware.js';
import nodesRouter from './nodes.js';
import channelsRouter from './channels.js';
import channelDatabaseRouter from './channelDatabase.js';
import telemetryRouter from './telemetry.js';
import traceroutesRouter from './traceroutes.js';
import messagesRouter from './messages.js';
import networkRouter from './network.js';
import packetsRouter from './packets.js';
import solarRouter from './solar.js';
import positionHistoryRouter from './positionHistory.js';
import docsRouter from './docs.js';

const router = express.Router();

// Documentation route (public access, no token required)
router.use('/docs', docsRouter);

// All other v1 API routes require API token authentication
router.use(requireAPIToken());

// API version info endpoint
router.get('/', (_req, res) => {
  res.json({
    version: 'v1',
    description: 'MeshMonitor REST API v1',
    documentation: '/api/v1/docs',
    endpoints: {
      nodes: '/api/v1/nodes',
      channels: '/api/v1/channels',
      channelDatabase: '/api/v1/channel-database',
      telemetry: '/api/v1/telemetry',
      traceroutes: '/api/v1/traceroutes',
      messages: '/api/v1/messages',
      network: '/api/v1/network',
      packets: '/api/v1/packets',
      solar: '/api/v1/solar',
      positionHistory: '/api/v1/nodes/{nodeId}/position-history'
    }
  });
});

// Mount resource routers
router.use('/nodes', positionHistoryRouter);
router.use('/nodes', nodesRouter);
router.use('/channels', channelsRouter);
router.use('/channel-database', channelDatabaseRouter);
router.use('/telemetry', telemetryRouter);
router.use('/traceroutes', traceroutesRouter);
router.use('/messages', messagesRouter);
router.use('/network', networkRouter);
router.use('/packets', packetsRouter);
router.use('/solar', solarRouter);

export default router;
