/**
 * Analysis Routes
 *
 * Cross-source endpoints for the /analysis workspace. Each handler:
 *  1. Resolves the requesting user's permitted source IDs (admin = all
 *     enabled; otherwise filtered via checkPermissionAsync(uid, 'nodes',
 *     'read', sourceId)).
 *  2. Intersects with the optional `sources` query param.
 *  3. Delegates to AnalysisRepository.
 *
 * The page itself is public; data filtering happens here, mirroring
 * unifiedRoutes.ts.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import type { PositionRow } from '../../db/repositories/analysis.js';
import {
  identifySolarNodes,
  summarizeSolarProduction,
  computeSolarForecast,
  type SolarTelemetryRow,
  type NodeNameLookup,
} from '../services/solarAnalysis.js';

const router = Router();
router.use(optionalAuth());

async function resolvePermittedSourceIds(
  req: Request,
  resource: string = 'nodes',
): Promise<string[]> {
  const user = (req as any).user;
  const isAdmin = user?.isAdmin ?? false;
  const allSources = await databaseService.sources.getAllSources();
  const enabled = allSources.filter((s: any) => s.enabled !== false);

  if (isAdmin) return enabled.map((s: any) => s.id);

  const checks = await Promise.all(
    enabled.map(async (s: any) => {
      const ok = user
        ? await databaseService.checkPermissionAsync(user.id, resource, 'read', s.id)
        : await databaseService.checkPermissionAsync(0, resource, 'read', s.id);
      return ok ? s.id : null;
    }),
  );
  return checks.filter((id): id is string => id !== null);
}

function parseSourcesParam(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function clampPageSize(raw: unknown): number {
  const n = parseInt(String(raw ?? '500'), 10);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 2000);
}

function parseSinceMs(raw: unknown): number {
  const n = parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Build a synchronous position-row filter that enforces per-channel viewOnMap
 * and positionOverrideIsPrivate gating. Returns null for admins (allow all).
 *
 * Pre-fetches all permissions and node metadata once so the returned predicate
 * is pure and cheap to call per item — avoids N async DB round-trips inside
 * the hot path of coverage-grid page iteration.
 */
async function buildPositionFilter(
  user: any,
  sourceIds: string[],
): Promise<((pos: PositionRow) => boolean) | null> {
  if (user?.isAdmin) return null;

  const userId: number | null = user?.id ?? null;

  // Fetch channel permission sets once per source
  const permsBySource = new Map<string, Record<string, { viewOnMap?: boolean } | undefined>>();
  for (const srcId of sourceIds) {
    const perms = userId !== null
      ? await databaseService.getUserPermissionSetAsync(userId, srcId)
      : {};
    permsBySource.set(srcId, perms);
  }

  // Fetch virtual-channel (channel DB) permissions and nodes_private:read once
  const channelDbPerms: Record<number, { viewOnMap: boolean } | undefined> = userId !== null
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(userId)
    : {};
  const canViewPrivate = userId !== null
    ? await databaseService.checkPermissionAsync(userId, 'nodes_private', 'read')
    : false;

  // Batch-load node metadata (channel, positionOverrideIsPrivate) for all nodes
  // across permitted sources so the filter predicate runs synchronously.
  const nodeInfoByKey = new Map<string, { channel: number; positionOverrideIsPrivate: boolean }>();
  for (const srcId of sourceIds) {
    const nodes = await databaseService.nodes.getAllNodes(srcId);
    for (const n of nodes) {
      nodeInfoByKey.set(`${srcId}:${n.nodeNum}`, {
        channel: n.channel ?? 0,
        positionOverrideIsPrivate: !!n.positionOverrideIsPrivate,
      });
    }
  }

  return (pos: PositionRow): boolean => {
    const info = nodeInfoByKey.get(`${pos.sourceId}:${pos.nodeNum}`)
      ?? { channel: 0, positionOverrideIsPrivate: false };

    // Block private-position nodes unless the user has nodes_private:read
    if (info.positionOverrideIsPrivate && !canViewPrivate) return false;

    // Block nodes on channels the user lacks viewOnMap permission for
    const perms = permsBySource.get(pos.sourceId) ?? {};
    const ch = info.channel;
    if (ch < CHANNEL_DB_OFFSET) {
      return perms[`channel_${ch}`]?.viewOnMap === true;
    }
    return channelDbPerms[ch - CHANNEL_DB_OFFSET]?.viewOnMap === true;
  };
}

router.get('/positions', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;

    const result = await databaseService.analysis.getPositions({
      sourceIds,
      sinceMs: parseSinceMs(req.query.since),
      pageSize: clampPageSize(req.query.pageSize),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    });

    // Enforce per-channel viewOnMap and positionOverrideIsPrivate gates,
    // matching the checks the main map and v1/position-history already apply.
    const posFilter = await buildPositionFilter(user, sourceIds);
    if (posFilter) {
      result.items = result.items.filter(posFilter);
    }

    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

router.get('/traceroutes', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req, 'traceroute');
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;
    const result = await databaseService.analysis.getTraceroutes({
      sourceIds,
      sinceMs: parseSinceMs(req.query.since),
      pageSize: clampPageSize(req.query.pageSize),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch traceroutes' });
  }
});

router.get('/neighbors', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;
    const result = await databaseService.analysis.getNeighbors({
      sourceIds,
      sinceMs: parseSinceMs(req.query.since),
    });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/neighbors:', error);
    res.status(500).json({ error: 'Failed to fetch neighbors' });
  }
});

// In-memory cache for coverage-grid responses. Coverage grids are expensive
// to compute (binning thousands of pivoted fixes) and rarely change at
// minute-scale, so we cache by (sourceIds, since, zoom) for 5 minutes.
const coverageCache = new Map<string, { at: number; data: unknown }>();
const COVERAGE_TTL_MS = 5 * 60_000;

router.get('/coverage-grid', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;
    const sinceMs = parseSinceMs(req.query.since);
    const zoom = parseInt(String(req.query.zoom ?? '12'), 10) || 12;

    // Cache only for admin requests — non-admin results vary by user permissions.
    const key = `${sourceIds.slice().sort().join(',')}|${sinceMs}|${zoom}`;
    if (isAdmin) {
      const cached = coverageCache.get(key);
      if (cached && Date.now() - cached.at < COVERAGE_TTL_MS) {
        res.json(cached.data);
        return;
      }
    }

    // Enforce the same per-channel viewOnMap / positionOverrideIsPrivate gates
    // that /positions applies — pre-built as a synchronous predicate so it can
    // be applied inside getCoverageGrid's internal pagination loop.
    const posFilter = await buildPositionFilter(user, sourceIds);
    const result = await databaseService.analysis.getCoverageGrid({
      sourceIds,
      sinceMs,
      zoom,
      postFilter: posFilter ?? undefined,
    });

    if (isAdmin) {
      coverageCache.set(key, { at: Date.now(), data: result });
    }
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/coverage-grid:', error);
    res.status(500).json({ error: 'Failed to fetch coverage grid' });
  }
});

/**
 * GET /api/analysis/solar-nodes
 *
 * Identifies likely solar-powered nodes by analyzing battery and voltage
 * telemetry over a lookback window. Filters telemetry by the requesting
 * user's permitted source IDs (admin = all enabled sources).
 */
router.get('/solar-nodes', async (req: Request, res: Response) => {
  try {
    const lookbackDays = (() => {
      const n = parseInt(String(req.query.lookback_days ?? '7'), 10);
      if (!Number.isFinite(n)) return 7;
      return Math.min(Math.max(n, 1), 90);
    })();

    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;

    const sinceMs = Date.now() - lookbackDays * 24 * 3600_000;

    // INA voltage channels — covers ch1Voltage, ch2Voltage, ch3Voltage variants
    // recorded by the firmware.
    const telemetryTypes = [
      'batteryLevel',
      'voltage',
      'ch1Voltage',
      'ch2Voltage',
      'ch3Voltage',
    ];

    const telemetryRows = await databaseService.telemetry.getTelemetryByTypesSince(
      telemetryTypes,
      sinceMs,
      sourceIds.length > 0 ? sourceIds : undefined,
    );

    const rows: SolarTelemetryRow[] = telemetryRows
      .filter((r: any) => typeof r.value === 'number' && r.value !== null)
      .map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        telemetryType: String(r.telemetryType),
        timestamp: Number(r.timestamp),
        value: Number(r.value),
      }));

    // intentional cross-source: node name map for display purposes spans all sources
    const allNodes = await databaseService.nodes.getAllNodes(ALL_SOURCES);
    const nodeLookup: NodeNameLookup[] = allNodes.map((n: any) => ({
      nodeNum: Number(n.nodeNum),
      longName: n.longName,
      shortName: n.shortName,
    }));

    const result = identifySolarNodes(rows, nodeLookup, lookbackDays);

    // Overlay: hourly solar-production estimates from the forecast.solar
    // cache for the same lookback window. Returned alongside per-node chart
    // data so the UI can render an output curve under the battery line.
    try {
      const startSec = Math.floor(sinceMs / 1000);
      const endSec = Math.floor(Date.now() / 1000) + 5 * 24 * 3600; // include forecast window
      const estimates = await databaseService.getSolarEstimatesInRangeAsync(
        startSec,
        endSec,
      );
      result.solar_production = summarizeSolarProduction(estimates);
    } catch (e) {
      logger.warn('Failed to load solar estimates for analysis overlay:', e);
    }

    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/solar-nodes:', error);
    res.status(500).json({ error: 'Failed to analyze solar nodes' });
  }
});

/**
 * GET /api/analysis/solar-forecast
 *
 * Compares forecast.solar projections to historical production averages and
 * simulates each detected solar node's battery state across the forecast
 * horizon. Returns nodes predicted to drop below the at-risk threshold so
 * operators can intervene before they go offline.
 */
router.get('/solar-forecast', async (req: Request, res: Response) => {
  try {
    const lookbackDays = (() => {
      const n = parseInt(String(req.query.lookback_days ?? '7'), 10);
      if (!Number.isFinite(n)) return 7;
      return Math.min(Math.max(n, 1), 90);
    })();

    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;

    const sinceMs = Date.now() - lookbackDays * 24 * 3600_000;
    const telemetryTypes = [
      'batteryLevel',
      'voltage',
      'ch1Voltage',
      'ch2Voltage',
      'ch3Voltage',
    ];

    const telemetryRows = await databaseService.telemetry.getTelemetryByTypesSince(
      telemetryTypes,
      sinceMs,
      sourceIds.length > 0 ? sourceIds : undefined,
    );

    const rows: SolarTelemetryRow[] = telemetryRows
      .filter((r: any) => typeof r.value === 'number' && r.value !== null)
      .map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        telemetryType: String(r.telemetryType),
        timestamp: Number(r.timestamp),
        value: Number(r.value),
      }));

    // intentional cross-source: node name map for display purposes spans all sources
    const allNodes = await databaseService.nodes.getAllNodes(ALL_SOURCES);
    const nodeLookup: NodeNameLookup[] = allNodes.map((n: any) => ({
      nodeNum: Number(n.nodeNum),
      longName: n.longName,
      shortName: n.shortName,
    }));

    const analysis = identifySolarNodes(rows, nodeLookup, lookbackDays);

    // Need both historical (lookback window) and forecast (today + future) Wh
    const startSec = Math.floor(sinceMs / 1000);
    const endSec = Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
    const estimates = await databaseService.getSolarEstimatesInRangeAsync(
      startSec,
      endSec,
    );

    const forecast = computeSolarForecast(analysis, estimates);
    res.json(forecast);
  } catch (error) {
    logger.error('Error in GET /api/analysis/solar-forecast:', error);
    res.status(500).json({ error: 'Failed to compute solar forecast' });
  }
});

router.get('/hop-counts', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;
    const result = await databaseService.analysis.getHopCounts({ sourceIds });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/hop-counts:', error);
    res.status(500).json({ error: 'Failed to fetch hop counts' });
  }
});

export default router;
