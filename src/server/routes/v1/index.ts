/**
 * v1 API Router
 *
 * Main router for the versioned v1 REST API. All endpoints require an API
 * token (`Authorization: Bearer mm_v1_...`) except `/docs`.
 *
 * Routing layout (v1 ↔ 4.0 multi-source reshape — issue #2773 follow-up):
 *
 *   /api/v1/              — version index
 *   /api/v1/docs/*        — OpenAPI + Swagger UI (public)
 *   /api/v1/sources       — list sources the token can read (NEW)
 *   /api/v1/sources/:sourceId/{nodes,messages,channels,telemetry,traceroutes,
 *                              packets,network,status}  — per-source, canonical
 *   /api/v1/sources/:sourceId/nodes/:nodeId/position-history
 *   /api/v1/solar, /api/v1/channel-database — deployment-global (unchanged)
 *
 *   /api/v1/{nodes,messages,...}?sourceId=... — legacy shape, kept alive for
 *     one release with a `Warning: 299` header via `deprecationShim`.
 *
 * Every per-source sub-router opts into `Router({ mergeParams: true })` so
 * `req.params.sourceId` threads through both mounts. `attachSource` runs
 * before the handler on the new shape — it resolves the `default` alias,
 * enforces a per-source permission check, and normalises the sourceId.
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
import statusRouter from './status.js';
import sourcesRouter from './sources.js';
import { attachSource } from './sourceParam.js';
import { deprecationShim } from './deprecatedShim.js';

const router = express.Router();

// Documentation route (public access, no token required)
router.use('/docs', docsRouter);

// All other v1 API routes require API token authentication
router.use(requireAPIToken());

// API version info endpoint
router.get('/', (_req, res) => {
  res.json({
    version: 'v1',
    description: 'MeshMonitor REST API v1 (multi-source shape)',
    documentation: '/api/v1/docs',
    endpoints: {
      sources: '/api/v1/sources',
      perSource: '/api/v1/sources/{sourceId}',
      nodes: '/api/v1/sources/{sourceId}/nodes',
      channels: '/api/v1/sources/{sourceId}/channels',
      telemetry: '/api/v1/sources/{sourceId}/telemetry',
      traceroutes: '/api/v1/sources/{sourceId}/traceroutes',
      messages: '/api/v1/sources/{sourceId}/messages',
      network: '/api/v1/sources/{sourceId}/network',
      packets: '/api/v1/sources/{sourceId}/packets',
      positionHistory: '/api/v1/sources/{sourceId}/nodes/{nodeId}/position-history',
      status: '/api/v1/sources/{sourceId}/status',
      channelDatabase: '/api/v1/channel-database',
      solar: '/api/v1/solar',
    },
    note:
      'Per-source paths are canonical. Legacy root paths (e.g. /api/v1/nodes?sourceId=...) ' +
      'still work but emit a `Warning: 299` header and will be removed in a future release.',
  });
});

// Global (unscoped) routers
router.use('/sources', sourcesRouter);
router.use('/solar', solarRouter);
router.use('/channel-database', channelDatabaseRouter);

// Per-source canonical routes. `attachSource(resource, action)` resolves the
// :sourceId param (including the `default` alias) and enforces the
// per-source permission check in one shot. Each resource router uses
// `Router({ mergeParams: true })` so it sees `req.params.sourceId`.
router.use(
  '/sources/:sourceId/nodes',
  attachSource('nodes', 'read'),
  positionHistoryRouter,
  nodesRouter
);
router.use(
  '/sources/:sourceId/channels',
  attachSource('messages', 'read'),
  channelsRouter
);
router.use(
  '/sources/:sourceId/telemetry',
  attachSource('nodes', 'read'),
  telemetryRouter
);
router.use(
  '/sources/:sourceId/traceroutes',
  attachSource('traceroute', 'read'),
  traceroutesRouter
);
router.use(
  '/sources/:sourceId/messages',
  attachSource('messages', 'read'),
  messagesRouter
);
router.use(
  '/sources/:sourceId/network',
  attachSource('nodes', 'read'),
  networkRouter
);
router.use(
  '/sources/:sourceId/packets',
  attachSource('packetmonitor', 'read'),
  packetsRouter
);
router.use(
  '/sources/:sourceId/status',
  attachSource('info', 'read'),
  statusRouter
);

// Deprecated legacy routes (root-scoped). Same handlers, but gated by the
// `deprecationShim` that stamps a `Warning: 299` header on every response
// and logs once per request. Removed in the next release.
router.use('/nodes', deprecationShim('nodes'), positionHistoryRouter, nodesRouter);
router.use('/channels', deprecationShim('channels'), channelsRouter);
router.use('/telemetry', deprecationShim('telemetry'), telemetryRouter);
router.use('/traceroutes', deprecationShim('traceroutes'), traceroutesRouter);
router.use('/messages', deprecationShim('messages'), messagesRouter);
router.use('/network', deprecationShim('network'), networkRouter);
router.use('/packets', deprecationShim('packets'), packetsRouter);
router.use('/status', deprecationShim('status'), statusRouter);

export default router;
