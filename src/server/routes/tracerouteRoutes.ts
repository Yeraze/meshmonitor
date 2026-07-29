import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { maskTraceroutesByChannel } from '../utils/nodeEnhancer.js';
import { TRACEROUTE_DISPLAY_HOURS } from '../../utils/nodeHelpers.js';
import { hasRouteData, parseHopArray } from '../../utils/tracerouteSegments.js';

const router = Router();

router.get('/recent', async (req: Request, res: Response) => {
  try {
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    let limit: number;
    if (req.query.limit) {
      limit = parseInt(req.query.limit as string);
    } else {
      const tracerouteIntervalMinutes = parseInt(await databaseService.settings.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);
    }

    const recentSourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    const allTraceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, recentSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted

    const recentTraceroutes = allTraceroutes.filter(tr => tr.timestamp >= cutoffTime);

    const traceroutesWithHops = recentTraceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
        }
      } catch (e) {
        hopCount = 999;
      }
      return { ...tr, hopCount };
    });

    res.json(traceroutesWithHops);
  } catch (error) {
    logger.error('Error fetching recent traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch recent traceroutes' });
  }
});

router.get('/history/:fromNodeNum/:toNodeNum', requirePermission('traceroute', 'read', { sourceIdFrom: 'query' }), async (req: Request, res: Response) => {
  try {
    const fromNodeNum = parseInt(req.params.fromNodeNum);
    const toNodeNum = parseInt(req.params.toNodeNum);
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const historySourceId = req.query.sourceId as string | undefined;

    if (isNaN(fromNodeNum) || isNaN(toNodeNum)) {
      res.status(400).json({ error: 'Invalid node numbers provided' });
      return;
    }

    if (fromNodeNum < 0 || fromNodeNum > 0xffffffff || toNodeNum < 0 || toNodeNum > 0xffffffff) {
      res.status(400).json({ error: 'Node numbers must be between 0 and 4294967295' });
      return;
    }

    if (isNaN(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: 'Limit must be between 1 and 1000' });
      return;
    }

    const traceroutes = await databaseService.traceroutes.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit, historySourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted

    const traceroutesWithHops = traceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
        }
      } catch (e) {
        hopCount = 999;
      }
      return { ...tr, hopCount };
    });

    res.json(traceroutesWithHops);
  } catch (error) {
    logger.error('Error fetching traceroute history:', error);
    res.status(500).json({ error: 'Failed to fetch traceroute history' });
  }
});

// GET /api/traceroutes/participation/:nodeNum?sourceId=…&hours=168&limit=100
//
// Every stored traceroute on ONE source that this node took part in — as an
// endpoint or as an intermediate hop. Backs the Node Details traceroute picker
// (epic phase 2), which is the only way an MQTT source (no origin node, so no
// own-request traceroute) can render the strip at all.
//
// sourceId is REQUIRED: the picker is per-source by definition, and a silent
// ALL_SOURCES fallback would mix another source's rows for the same nodeNum.
router.get(
  '/participation/:nodeNum',
  requirePermission('traceroute', 'read', { sourceIdFrom: 'query' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId.trim() : '';
      if (!sourceId) {
        return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId query parameter is required');
      }

      const nodeNum = Number.parseInt(req.params.nodeNum, 10);
      if (!Number.isFinite(nodeNum) || nodeNum < 0 || nodeNum > 0xffffffff) {
        return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be between 0 and 4294967295');
      }

      const hours = req.query.hours
        ? Number.parseInt(req.query.hours as string, 10)
        : TRACEROUTE_DISPLAY_HOURS;
      if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 90) {
        return fail(res, 400, 'INVALID_HOURS', 'hours must be between 1 and 2160');
      }

      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 100;
      if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
        return fail(res, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200');
      }

      const rows = await databaseService.traceroutes.getTraceroutesInvolvingNode(nodeNum, {
        sourceId,
        sinceTimestamp: Date.now() - hours * 60 * 60 * 1000,
        limit,
      });

      // Same channel gate GET /api/sources/:id/traceroutes applies (#3092) — a
      // traceroute on a channel the caller can't view must not surface here.
      const visible = await maskTraceroutesByChannel(rows, req.user ?? null, sourceId);

      const entries = visible.map(tr => ({
        id: Number(tr.id),
        timestamp: tr.timestamp,
        fromNodeNum: Number(tr.fromNodeNum),
        toNodeNum: Number(tr.toNodeNum),
        fromNodeId: tr.fromNodeId,
        toNodeId: tr.toNodeId,
        route: tr.route ?? null,
        routeBack: tr.routeBack ?? null,
        snrTowards: tr.snrTowards ?? null,
        snrBack: tr.snrBack ?? null,
        channel: tr.channel ?? null,
        participation: tr.participation,
        // null (not the 999 sentinel the map/dashboard paths use) when the
        // forward route is absent or unparseable: a label wants honest absence,
        // and 999 would render as "999 hops".
        hopCount: hasRouteData(tr.route) ? parseHopArray(tr.route).length : null,
      }));

      return ok(res, { nodeNum, sourceId, entries });
    } catch (error) {
      logger.error('Error fetching traceroute participation:', error);
      return fail(res, 500, 'TRACEROUTE_PARTICIPATION_FAILED', 'Failed to fetch traceroute participation');
    }
  },
);

export default router;
