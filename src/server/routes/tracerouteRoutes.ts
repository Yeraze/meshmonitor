import { Router, Request, Response } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { isMqttSourceType } from '../../db/repositories/sources.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { filterNodesByChannelPermission, maskNodeLocationByChannel, maskTraceroutesByChannel } from '../utils/nodeEnhancer.js';
import { hasRouteData, parseHopArray } from '../../utils/tracerouteSegments.js';
import { getMaxNodeAgeHours } from '../services/nodeDisplaySettings.js';
import { applySignFlipToTraceroutes, loadSignFlipContexts } from '../services/signFlipCorrection.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { mergeExplorerNodes, type ExplorerNodeRow } from '../utils/tracerouteExplorerNodes.js';
import { getEnvironmentConfig } from '../config/environment.js';

const router = Router();

router.get('/recent', async (req: Request, res: Response) => {
  try {
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    const recentSourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;

    let limit: number;
    if (req.query.limit) {
      limit = parseInt(req.query.limit as string);
    } else {
      const tracerouteIntervalMinutes = parseInt(await databaseService.settings.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = await getMaxNodeAgeHours(databaseService.settings, recentSourceId ?? null);
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);
    }

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

    // #5363: stored routePositions snapshots drawn at the corrected point.
    res.json(await applySignFlipToTraceroutes(traceroutesWithHops, recentSourceId));
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

    res.json(await applySignFlipToTraceroutes(traceroutesWithHops, historySourceId)); // #5363
  } catch (error) {
    logger.error('Error fetching traceroute history:', error);
    res.status(500).json({ error: 'Failed to fetch traceroute history' });
  }
});

// GET /api/traceroutes/participation/:nodeNum?sourceId=…&hours=168&limit=100
//
// Stored traceroutes on ONE source that this node took part in. What counts as
// "took part" depends on the source's type:
//
//   MQTT (mqtt_bridge / mqtt_broker) — endpoint OR intermediate hop. An MQTT
//     source has no origin node of its own and therefore no own-request
//     traceroute, so relayed rows are the only way its nodes can render the
//     strip at all. This is what the picker was built for (epic phase 2).
//
//   Everything else (meshtastic_tcp / meshcore) — endpoint only. These sources
//     DO have an origin node, and the picker should list the routes between it
//     and the selected node. Listing routes between two other nodes that merely
//     passed through the selected one is confusing, and it made the picker's
//     list disagree with the statistical aggregate's route count for the same
//     node (the aggregate is pair-scoped).
//
// An unknown/missing source falls back to endpoint-only: the narrower, less
// surprising list is the safe default when the type can't be established.
//
// sourceId is REQUIRED: the picker is per-source by definition, and a silent
// ALL_SOURCES fallback would mix another source's rows for the same nodeNum.
//
// `hours` is OPTIONAL (amendment, SR_PHASE2_SPEC.md D14/S1): omitted entirely
// by the picker so it lists the node's most recent stored traceroutes with no
// time window — parity with the Traceroute History dialog, per direct user
// request. When present, `hours` still validates and windows exactly as before.
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

      // `hours` is optional (amendment, SR_PHASE2_SPEC.md D14/S1): when absent,
      // the picker gets the node's most recent stored traceroutes with no time
      // window, matching the Traceroute History dialog. When present, the
      // existing window validation applies unchanged.
      let sinceTimestamp: number | undefined;
      if (req.query.hours !== undefined) {
        const hours = Number.parseInt(req.query.hours as string, 10);
        if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 90) {
          return fail(res, 400, 'INVALID_HOURS', 'hours must be between 1 and 2160');
        }
        sinceTimestamp = Date.now() - hours * 60 * 60 * 1000;
      }

      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 100;
      if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
        return fail(res, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200');
      }

      // Relayed (hop) participation is MQTT-only — see the header comment.
      const source = await databaseService.sources.getSource(sourceId);
      const endpointOnly = !isMqttSourceType(source?.type);

      const rows = await databaseService.traceroutes.getTraceroutesInvolvingNode(nodeNum, {
        sourceId,
        endpointOnly,
        sinceTimestamp,
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

// GET /api/traceroutes/explorer?sources=a,b&hours=24
//
// Traceroute Explorer report (#5511): every stored traceroute across the
// sources the caller can read, newest first, plus a display entry for every
// node those runs mention. Filtering by result, transport, node and hop count
// happens client-side over this window, so the map and table can re-filter
// without a round trip.
//
// Permission model (#3745 leak class): the source set is the caller's
// `traceroute:read` sources, optionally narrowed by `sources`; runs are then
// channel-masked per source, the same gate the per-source traceroute routes
// apply. Node positions come only from rows the caller may see on the map.
//
// Read-only: sends nothing to any node.
// A busy multi-source install stores ~5 rows per traceroute (each MQTT
// source keeps its own copy), so 24h can pass 5,000 rows on its own.
export const EXPLORER_SCAN_LIMIT = 20000;
const EXPLORER_MAX_HOURS = 24 * 365;

router.get('/explorer', optionalAuth(), async (req: Request, res: Response) => {
  try {
    let sinceTimestamp: number | undefined;
    if (req.query.hours !== undefined && req.query.hours !== '') {
      const hours = Number(req.query.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > EXPLORER_MAX_HOURS) {
        return fail(res, 400, 'INVALID_HOURS', `hours must be between 1 and ${EXPLORER_MAX_HOURS}`);
      }
      sinceTimestamp = Date.now() - hours * 60 * 60 * 1000;
    }

    const allSources = await databaseService.sources.getAllSources();
    const permitted = await resolvePermittedSourceIds(req, 'traceroute', allSources);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter(id => requested.includes(id)) : permitted;

    const rows = await databaseService.traceroutes.getTraceroutesForSources({
      sourceIds,
      sinceTimestamp,
      // One extra row tells "exactly the cap" apart from "more than the cap".
      limit: EXPLORER_SCAN_LIMIT + 1,
    });
    const truncated = rows.length > EXPLORER_SCAN_LIMIT;
    if (truncated) rows.length = EXPLORER_SCAN_LIMIT;

    const user = req.user ?? null;
    const bySource = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = bySource.get(row.sourceId);
      if (list) list.push(row);
      else bySource.set(row.sourceId, [row]);
    }
    const visibleRuns: typeof rows = [];
    for (const [sid, list] of bySource) {
      visibleRuns.push(...(await maskTraceroutesByChannel(list, user, sid)));
    }
    visibleRuns.sort((a, b) => b.timestamp - a.timestamp || Number(b.id) - Number(a.id));

    const wanted = new Set<number>();
    for (const tr of visibleRuns) {
      wanted.add(Number(tr.fromNodeNum));
      wanted.add(Number(tr.toNodeNum));
      for (const n of parseHopArray(tr.route)) wanted.add(Number(n));
      for (const n of parseHopArray(tr.routeBack)) wanted.add(Number(n));
    }

    // Node details need `nodes:read` as well: `traceroute:read` alone shows
    // the runs (and their hex node ids) but no names or positions.
    const nodeSourceIds = new Set(await resolvePermittedSourceIds(req, 'nodes', allSources));
    // intentional cross-source: node rows from every source, narrowed to the
    // permitted set before any field is read.
    const nodeRows = ((await databaseService.nodes.getAllNodes(ALL_SOURCES)) as unknown as ExplorerNodeRow[])
      .filter(n => sourceIds.includes(n.sourceId) && nodeSourceIds.has(n.sourceId) && wanted.has(Number(n.nodeNum)));
    const nodesBySource = new Map<string, ExplorerNodeRow[]>();
    for (const n of nodeRows) {
      const list = nodesBySource.get(n.sourceId);
      if (list) list.push(n);
      else nodesBySource.set(n.sourceId, [n]);
    }
    const safeNodeRows: ExplorerNodeRow[] = [];
    for (const [sid, list] of nodesBySource) {
      const onMap = new Set(await filterNodesByChannelPermission(list, user, sid));
      const masked = await maskNodeLocationByChannel(list, user, sid);
      masked.forEach((row, i) => {
        // A node the caller can't see on the map keeps its name but no position.
        safeNodeRows.push(
          onMap.has(list[i]) ? row : { ...row, latitude: null, longitude: null, positionOverrideEnabled: false },
        );
      });
    }
    const signFlip = await loadSignFlipContexts(sourceIds);
    const nodes = mergeExplorerNodes(safeNodeRows, wanted, signFlip);

    const sourceNames = new Map(allSources.map(s => [s.id, s.name]));
    return ok(res, {
      sources: sourceIds.map(id => ({ id, name: sourceNames.get(id) ?? id })),
      runs: visibleRuns.map(tr => ({
        id: Number(tr.id),
        sourceId: tr.sourceId,
        timestamp: tr.timestamp,
        fromNodeNum: Number(tr.fromNodeNum),
        toNodeNum: Number(tr.toNodeNum),
        route: tr.route ?? null,
        routeBack: tr.routeBack ?? null,
        snrTowards: tr.snrTowards ?? null,
        snrBack: tr.snrBack ?? null,
        channel: tr.channel ?? null,
        packetId: tr.packetId == null ? null : Number(tr.packetId),
        transportMechanism: tr.transportMechanism ?? null,
      })),
      nodes,
      truncated,
      scanLimit: EXPLORER_SCAN_LIMIT,
      retentionPerPair: getEnvironmentConfig().tracerouteHistoryLimit,
    });
  } catch (error) {
    logger.error('Error fetching traceroute explorer data:', error);
    return fail(res, 500, 'TRACEROUTE_EXPLORER_FAILED', 'Failed to fetch traceroutes');
  }
});

export default router;
