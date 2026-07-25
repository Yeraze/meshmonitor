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
import { ok, fail } from '../utils/apiResponse.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import type { PositionRow } from '../../db/repositories/analysis.js';
import mqttPacketLogService from '../services/mqttPacketLogService.js';
import type {
  ViolationGatewaySort,
  ViolationListSort,
  MqttViolationGateway,
  DbMqttOkToMqttViolation,
} from '../../db/repositories/mqttOkToMqttViolations.js';
import type { DbMqttPacket } from '../../db/repositories/mqttPacketLog.js';
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

// ── ok_to_mqtt violation detection (#4114) ──────────────────────────────────
//
// Two new helpers below (`parseUntilMs`, `parseLookbackDays`, `parseBoolParam`)
// are genuinely new — there is no `parseUntilMs`/`parseLookbackDays`/
// `parseBoolParam` under any similar name elsewhere in this file. `parseLookbackDays`
// deliberately accepts BOTH `lookbackDays` and `lookback_days` spellings so it does
// not become a third convention alongside the solar handlers' inline
// `lookback_days` parser (clamp 1..90) below, which is intentionally left
// untouched — see MQTT_OK_TO_MQTT_PHASE1_SPEC.md §3.17.

function parseUntilMs(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function parseLookbackDays(raw: unknown): number {
  const n = parseInt(String(raw ?? '7'), 10);
  if (!Number.isFinite(n)) return 7;
  return Math.min(Math.max(n, 1), 365);
}

function parseBoolParam(raw: unknown): boolean {
  return raw === 'true' || raw === '1';
}

const VIOLATION_GATEWAY_SORTS = ['violationCount', 'lastSeen', 'distinctOriginators', 'gatewayId'] as const;
const VIOLATION_LIST_SORTS = ['timestamp', 'fromNode', 'gatewayId'] as const;

/**
 * Cap on the pre-merge fetch used ONLY by the `includeUnknown=true` path
 * (#4330). It bounds `getGatewaySummary`/`getViolations`'s "confirmed" fetch
 * and `getSuspectedViolations`'s "suspected" fetch before they are merged and
 * re-sorted in JS — a merge that cannot be pushed into SQL because the two
 * sides come from different tables (see the handler doc comments). It plays
 * NO role in the default `includeUnknown=false` path, which pages entirely
 * in SQL and is uncapped. Exposed to the frontend as `scanCap` so it never
 * hardcodes the number independently.
 */
const API_SCAN_CAP = 2000;

/** Row shape for the merged `/mqtt-violations/gateways` response. */
interface ViolationGatewayRow extends MqttViolationGateway {
  suspectedCount: number;
  sourceIds: string[];
}

/** Row shape for the merged `/mqtt-violations/packets` response. */
interface ViolationPacketRow {
  id: number | undefined;
  kind: 'confirmed' | 'suspected';
  sourceId: string;
  packetId: number | null;
  fromNode: number | null;
  fromNodeId: string | null;
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  channelId: string | null;
  portnum: number | null;
  portnumName: string | null;
  bitfield: number | null;
  topic: string | null;
  rxTime: number | null;
  timestamp: number;
}

function toViolationPacketRow(
  kind: 'confirmed' | 'suspected',
  row: DbMqttOkToMqttViolation | DbMqttPacket,
): ViolationPacketRow {
  return {
    id: row.id,
    kind,
    sourceId: row.sourceId,
    packetId: row.packetId ?? null,
    fromNode: row.fromNode ?? null,
    fromNodeId: row.fromNodeId ?? null,
    gatewayId: row.gatewayId ?? null,
    gatewayNodeNum: row.gatewayNodeNum ?? null,
    channelId: row.channelId ?? null,
    portnum: row.portnum ?? null,
    portnumName: row.portnumName ?? null,
    bitfield: row.bitfield ?? null,
    topic: row.topic ?? null,
    rxTime: row.rxTime ?? null,
    timestamp: row.timestamp,
  };
}

/**
 * Build a synchronous position-row filter enforcing three kinds of gate:
 *
 *  - live-node presence (#4163 follow-up): a DISPLAY gate applied to EVERYONE.
 *    Position telemetry lives in the `telemetry` table and is NOT cascade-
 *    deleted when a node is removed, so bulk deletes that don't purge telemetry
 *    ("Clean up inactive nodes", "Prune Outside ROI") leave orphaned lat/lon
 *    rows behind. Those rows have no node record — hence no marker on any map —
 *    so they must not contribute heatmap/coverage density. A position whose
 *    `(sourceId, nodeNum)` has no current node is dropped.
 *  - `hideFromMap` (#4162/#4163): a DISPLAY gate applied to EVERYONE, admins
 *    included. A node with "Hide from Map" set has no marker on any map
 *    surface (`useAnalysisNodes`/`embedPublicRoutes` drop it), so its
 *    historical position telemetry must not contribute heatmap or
 *    coverage-grid density either.
 *  - per-channel `viewOnMap` + `positionOverrideIsPrivate`: PERMISSION gates
 *    applied only to non-admins.
 *
 * Always returns a predicate (never null): whether orphaned rows exist can't be
 * known without inspecting each position, so filtering can't be skipped up
 * front. The predicate is pure and cheap (one Map lookup per row).
 *
 * Pre-fetches all permissions and node metadata once so the returned predicate
 * is pure and cheap to call per item — avoids N async DB round-trips inside
 * the hot path of coverage-grid page iteration.
 */
async function buildPositionFilter(
  user: any,
  sourceIds: string[],
): Promise<(pos: PositionRow) => boolean> {
  const isAdmin = !!user?.isAdmin;
  const userId: number | null = user?.id ?? null;

  // Batch-load node metadata for all nodes across permitted sources so the
  // filter predicate runs synchronously. `hideFromMap` is read for every user
  // (display gate); channel/positionOverrideIsPrivate only feed the non-admin
  // permission gates below.
  const nodeInfoByKey = new Map<
    string,
    { channel: number; positionOverrideIsPrivate: boolean; hideFromMap: boolean }
  >();
  for (const srcId of sourceIds) {
    const nodes = await databaseService.nodes.getAllNodes(srcId);
    for (const n of nodes) {
      nodeInfoByKey.set(`${srcId}:${n.nodeNum}`, {
        channel: n.channel ?? 0,
        positionOverrideIsPrivate: !!n.positionOverrideIsPrivate,
        hideFromMap: !!n.hideFromMap,
      });
    }
  }

  // Admins bypass the permission gates, but the display gates still apply: a
  // position whose owning node is hidden (`hideFromMap`) or no longer exists
  // (orphaned telemetry from a deleted/pruned node — #4163) has no marker, so
  // it contributes no density.
  if (isAdmin) {
    return (pos: PositionRow): boolean => {
      const info = nodeInfoByKey.get(`${pos.sourceId}:${pos.nodeNum}`);
      return !!info && !info.hideFromMap;
    };
  }

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

  return (pos: PositionRow): boolean => {
    const info = nodeInfoByKey.get(`${pos.sourceId}:${pos.nodeNum}`);

    // #4163: orphaned telemetry (owning node deleted/pruned) has no node record
    // and therefore no marker, so it contributes no density. Drop it before the
    // permission gates rather than defaulting it onto channel 0.
    if (!info) return false;

    // #4162/#4163: hidden nodes have no marker, so contribute no density.
    if (info.hideFromMap) return false;

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
    result.items = result.items.filter(posFilter);

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
      postFilter: posFilter,
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

/**
 * GET /api/analysis/mqtt-violations/gateways
 *
 * Per-gateway `ok_to_mqtt` violation summary (#4114). Confirmed violations
 * come from the durable `mqtt_ok_to_mqtt_violations` table (90-day
 * retention, independent of the packet monitor). "Suspected" rows
 * (`includeUnknown=true`) come from `mqtt_packet_log` instead — bounded by
 * that table's much shorter retention window and gated on
 * `mqtt_packet_log_enabled` — so the response reports `suspectedAvailable`
 * / `suspectedWindowMs` alongside them. See
 * docs/internal/dev-notes/MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(e)/§3.17.
 */
router.get('/mqtt-violations/gateways', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req, 'packetmonitor');
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;

    const until = parseUntilMs(req.query.until);
    const lookbackDays = parseLookbackDays(req.query.lookbackDays ?? req.query.lookback_days);
    const hasExplicitSince = typeof req.query.since === 'string' && req.query.since.trim() !== '';
    const since = hasExplicitSince
      ? parseSinceMs(req.query.since)
      : until - lookbackDays * 24 * 60 * 60 * 1000;

    if (since > until) {
      fail(res, 400, 'INVALID_RANGE', 'since must be <= until');
      return;
    }

    const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : 'violationCount';
    if (!(VIOLATION_GATEWAY_SORTS as readonly string[]).includes(sortRaw)) {
      fail(res, 400, 'INVALID_SORT_FIELD', 'Unsupported sort field');
      return;
    }
    const sort = sortRaw as ViolationGatewaySort;

    const dirRaw = typeof req.query.dir === 'string' ? req.query.dir : 'desc';
    if (dirRaw !== 'asc' && dirRaw !== 'desc') {
      fail(res, 400, 'INVALID_SORT_DIRECTION', 'Sort direction must be asc or desc');
      return;
    }
    const dir = dirRaw;

    const includeUnknown = parseBoolParam(req.query.includeUnknown);
    const limit = clampPageSize(req.query.limit);
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    if (sourceIds.length === 0) {
      ok(res, {
        gateways: [],
        total: 0,
        limit,
        offset,
        since,
        until,
        includeUnknown,
        suspectedAvailable: false,
        suspectedWindowMs: 0,
        sources: [],
        capApplied: false,
        scanCap: API_SCAN_CAP,
      });
      return;
    }

    const rangeQuery = { sourceIds, since, until };

    if (!includeUnknown) {
      // ── Default path (#4330 fix) ──────────────────────────────────────
      // Only the confirmed table is involved, so there is nothing to merge:
      // push sort/dir/limit/offset straight into SQL. `total` is an exact
      // COUNT and every row at every offset is reachable — no cap, ever.
      const [gatewayRows, total, sourceIdPairs] = await Promise.all([
        databaseService.mqttOkToMqttViolations.getGatewaySummary({ ...rangeQuery, sort, dir, limit, offset }),
        databaseService.mqttOkToMqttViolations.getGatewaySummaryCount(rangeQuery),
        databaseService.mqttOkToMqttViolations.getGatewaySourceIds(rangeQuery),
      ]);

      const sourceIdsByGateway = new Map<string, Set<string>>();
      for (const pair of sourceIdPairs) {
        const set = sourceIdsByGateway.get(pair.gatewayId) ?? new Set<string>();
        set.add(pair.sourceId);
        sourceIdsByGateway.set(pair.gatewayId, set);
      }

      // Trap (#4330): sourceIds is attached here from the separate
      // getGatewaySourceIds query — skipping this step silently drops it
      // (every row would come back with sourceIds: []).
      const gateways: ViolationGatewayRow[] = gatewayRows
        .filter((g): g is MqttViolationGateway & { gatewayId: string } => g.gatewayId != null)
        .map((g) => ({
          ...g,
          suspectedCount: 0,
          sourceIds: Array.from(sourceIdsByGateway.get(g.gatewayId) ?? []),
        }));

      ok(res, {
        gateways,
        total,
        limit,
        offset,
        since,
        until,
        includeUnknown,
        suspectedAvailable: false,
        suspectedWindowMs: 0,
        sources: sourceIds,
        capApplied: false,
        scanCap: API_SCAN_CAP,
      });
      return;
    }

    // ── includeUnknown=true (#4330: opt-in, still merged+sorted in JS) ──
    // Confirmed rows (durable table) and suspected rows (mqtt_packet_log)
    // must be merged before ordering because they come from two different
    // tables — a SQL UNION was considered and declined for this PR. The
    // confirmed fetch below is capped at API_SCAN_CAP; capApplied reports
    // whether that cap actually dropped rows before the merge.
    const [confirmedRows, sourceIdPairs] = await Promise.all([
      databaseService.mqttOkToMqttViolations.getGatewaySummary({ ...rangeQuery, limit: API_SCAN_CAP, offset: 0 }),
      databaseService.mqttOkToMqttViolations.getGatewaySourceIds(rangeQuery),
    ]);

    // Seeded from the confirmed side; the suspected side (below) unions its
    // own (gatewayId, sourceId) pairs in — a gateway can be known to have
    // touched a source via either signal, and a suspected-only gateway must
    // still report which source(s) it was seen on (#4114 code review).
    const sourceIdsByGateway = new Map<string, Set<string>>();
    for (const pair of sourceIdPairs) {
      const set = sourceIdsByGateway.get(pair.gatewayId) ?? new Set<string>();
      set.add(pair.sourceId);
      sourceIdsByGateway.set(pair.gatewayId, set);
    }

    let suspectedWindowMs = 0;
    const suspectedByGateway = new Map<
      string,
      { suspectedCount: number; gatewayNodeNum: number | null; distinctOriginators: number; firstSeen: number; lastSeen: number }
    >();

    const suspectedAvailable = await mqttPacketLogService.isEnabled();
    if (suspectedAvailable) {
      // No dependency between these three — run concurrently.
      const [maxAgeHours, suspectedRows, suspectedSourceIdPairs] = await Promise.all([
        mqttPacketLogService.getMaxAgeHours(),
        databaseService.mqttPacketLog.getSuspectedViolationGateways(rangeQuery),
        databaseService.mqttPacketLog.getSuspectedGatewaySourceIds(rangeQuery),
      ]);
      suspectedWindowMs = maxAgeHours * 60 * 60 * 1000;
      for (const row of suspectedRows) {
        if (!row.gatewayId) continue;
        suspectedByGateway.set(row.gatewayId, {
          suspectedCount: row.suspectedCount,
          gatewayNodeNum: row.gatewayNodeNum,
          distinctOriginators: row.distinctOriginators,
          firstSeen: row.firstSeen,
          lastSeen: row.lastSeen,
        });
      }
      for (const pair of suspectedSourceIdPairs) {
        const set = sourceIdsByGateway.get(pair.gatewayId) ?? new Set<string>();
        set.add(pair.sourceId);
        sourceIdsByGateway.set(pair.gatewayId, set);
      }
    }

    const mergedByGateway = new Map<string, ViolationGatewayRow>();
    for (const g of confirmedRows) {
      // Defensive only, not reachable via the write path (#4330 review):
      // a confirmed row exists in mqtt_ok_to_mqtt_violations only when
      // detectOkToMqttViolation() set isViolation, which requires
      // `relayed`, which requires gatewayNodeNum !== null — and
      // gatewayNodeNum is parseGatewayNodeNum(envelope.gatewayId), which is
      // non-null only when envelope.gatewayId was itself a valid, non-empty
      // `!`-prefixed id. buildViolationRow() stores that same
      // envelope.gatewayId verbatim (mqttPacketLogService.ts:348,399), so a
      // written violation row can never carry a null gatewayId. This guard
      // therefore cannot cause `total = merged.length` (below) to diverge
      // from `capApplied = confirmedRows.length >= API_SCAN_CAP` — every
      // row fetched here is counted by both.
      if (!g.gatewayId) continue;
      const suspected = suspectedByGateway.get(g.gatewayId);
      mergedByGateway.set(g.gatewayId, {
        ...g,
        suspectedCount: suspected?.suspectedCount ?? 0,
        // A gateway confirmed AND suspected in the same window must report
        // the true first/last-seen span across both signals, not just the
        // confirmed side's (#4114 code review).
        firstSeen: suspected ? Math.min(g.firstSeen, suspected.firstSeen) : g.firstSeen,
        lastSeen: suspected ? Math.max(g.lastSeen, suspected.lastSeen) : g.lastSeen,
        sourceIds: Array.from(sourceIdsByGateway.get(g.gatewayId) ?? []),
      });
    }
    // Gateways present only in the suspected set appear with violationCount: 0.
    for (const [gatewayId, suspected] of suspectedByGateway) {
      if (mergedByGateway.has(gatewayId)) continue;
      mergedByGateway.set(gatewayId, {
        gatewayId,
        gatewayNodeNum: suspected.gatewayNodeNum,
        violationCount: 0,
        distinctOriginators: suspected.distinctOriginators,
        firstSeen: suspected.firstSeen,
        lastSeen: suspected.lastSeen,
        suspectedCount: suspected.suspectedCount,
        sourceIds: Array.from(sourceIdsByGateway.get(gatewayId) ?? []),
      });
    }

    const merged = Array.from(mergedByGateway.values());
    const dirMultiplier = dir === 'asc' ? 1 : -1;
    merged.sort((a, b) => {
      if (sort === 'gatewayId') {
        return dirMultiplier * String(a.gatewayId ?? '').localeCompare(String(b.gatewayId ?? ''));
      }
      return dirMultiplier * ((a[sort] ?? 0) - (b[sort] ?? 0));
    });

    const total = merged.length;
    const gateways = merged.slice(offset, offset + limit);
    // capApplied: the pre-merge confirmed fetch hit the cap, meaning rows
    // were dropped before the merge/sort ran (#4330).
    const capApplied = confirmedRows.length >= API_SCAN_CAP;

    ok(res, {
      gateways,
      total,
      limit,
      offset,
      since,
      until,
      includeUnknown,
      suspectedAvailable,
      suspectedWindowMs,
      sources: sourceIds,
      capApplied,
      scanCap: API_SCAN_CAP,
    });
  } catch (error) {
    logger.error('Error in GET /api/analysis/mqtt-violations/gateways:', error);
    fail(res, 500, 'MQTT_VIOLATIONS_FETCH_FAILED', 'Failed to fetch ok_to_mqtt violations');
  }
});

/**
 * GET /api/analysis/mqtt-violations/packets
 *
 * Drill-down list of individual `ok_to_mqtt` violations (#4114), optionally
 * filtered to one `gateway`. Same confirmed/suspected split as
 * `/mqtt-violations/gateways` — see that handler's doc comment and
 * MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(e)/§3.17.
 */
router.get('/mqtt-violations/packets', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req, 'packetmonitor');
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;

    const until = parseUntilMs(req.query.until);
    const lookbackDays = parseLookbackDays(req.query.lookbackDays ?? req.query.lookback_days);
    const hasExplicitSince = typeof req.query.since === 'string' && req.query.since.trim() !== '';
    const since = hasExplicitSince
      ? parseSinceMs(req.query.since)
      : until - lookbackDays * 24 * 60 * 60 * 1000;

    if (since > until) {
      fail(res, 400, 'INVALID_RANGE', 'since must be <= until');
      return;
    }

    const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : 'timestamp';
    if (!(VIOLATION_LIST_SORTS as readonly string[]).includes(sortRaw)) {
      fail(res, 400, 'INVALID_SORT_FIELD', 'Unsupported sort field');
      return;
    }
    const sort = sortRaw as ViolationListSort;

    const dirRaw = typeof req.query.dir === 'string' ? req.query.dir : 'desc';
    if (dirRaw !== 'asc' && dirRaw !== 'desc') {
      fail(res, 400, 'INVALID_SORT_DIRECTION', 'Sort direction must be asc or desc');
      return;
    }
    const dir = dirRaw;

    const includeUnknown = parseBoolParam(req.query.includeUnknown);
    const gateway = typeof req.query.gateway === 'string' && req.query.gateway.trim() !== ''
      ? req.query.gateway
      : undefined;
    const limit = clampPageSize(req.query.limit);
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    if (sourceIds.length === 0) {
      ok(res, {
        violations: [],
        total: 0,
        limit,
        offset,
        since,
        until,
        gateway: gateway ?? null,
        includeUnknown,
        suspectedAvailable: false,
        suspectedWindowMs: 0,
        sources: [],
        capApplied: false,
        scanCap: API_SCAN_CAP,
      });
      return;
    }

    const rangeQuery = { sourceIds, since, until, gatewayId: gateway };

    if (!includeUnknown) {
      // ── Default path (#4330 fix) ──────────────────────────────────────
      // Only the confirmed table is involved, so there is nothing to merge:
      // push sort/dir/limit/offset straight into SQL. `total` is an exact
      // COUNT and every row at every offset is reachable — no cap, ever.
      const [confirmedRows, total] = await Promise.all([
        databaseService.mqttOkToMqttViolations.getViolations({ ...rangeQuery, sort, dir, limit, offset }),
        databaseService.mqttOkToMqttViolations.getViolationCount(rangeQuery),
      ]);

      const violations = confirmedRows.map((r) => toViolationPacketRow('confirmed', r));

      ok(res, {
        violations,
        total,
        limit,
        offset,
        since,
        until,
        gateway: gateway ?? null,
        includeUnknown,
        suspectedAvailable: false,
        suspectedWindowMs: 0,
        sources: sourceIds,
        capApplied: false,
        scanCap: API_SCAN_CAP,
      });
      return;
    }

    // ── includeUnknown=true (#4330: opt-in, still merged+sorted in JS) ──
    // Confirmed rows (durable table) and suspected rows (mqtt_packet_log)
    // must be merged before ordering because they come from two different
    // tables — a SQL UNION was considered and declined for this PR. Both
    // pre-merge fetches below are capped at API_SCAN_CAP; capApplied reports
    // whether either cap actually dropped rows before the merge.
    // The confirmed fetch and the suspectedAvailable check have no data
    // dependency on each other — run them concurrently (#4330 review).
    const [confirmedRows, suspectedAvailable] = await Promise.all([
      databaseService.mqttOkToMqttViolations.getViolations({
        ...rangeQuery,
        limit: API_SCAN_CAP,
        offset: 0,
      }),
      mqttPacketLogService.isEnabled(),
    ]);

    let suspectedWindowMs = 0;
    let suspectedRows: DbMqttPacket[] = [];

    if (suspectedAvailable) {
      // No dependency between these two — run concurrently.
      const [maxAgeHours, rows] = await Promise.all([
        mqttPacketLogService.getMaxAgeHours(),
        databaseService.mqttPacketLog.getSuspectedViolations({ ...rangeQuery, limit: API_SCAN_CAP, offset: 0 }),
      ]);
      suspectedWindowMs = maxAgeHours * 60 * 60 * 1000;
      suspectedRows = rows;
    }

    const merged = [
      ...confirmedRows.map((r) => toViolationPacketRow('confirmed', r)),
      ...suspectedRows.map((r) => toViolationPacketRow('suspected', r)),
    ];
    const dirMultiplier = dir === 'asc' ? 1 : -1;
    merged.sort((a, b) => {
      if (sort === 'gatewayId') {
        return dirMultiplier * String(a.gatewayId ?? '').localeCompare(String(b.gatewayId ?? ''));
      }
      return dirMultiplier * ((a[sort] ?? 0) - (b[sort] ?? 0));
    });

    const total = merged.length;
    const violations = merged.slice(offset, offset + limit);
    // capApplied: either pre-merge fetch hit its cap, meaning rows were
    // dropped before the merge/sort ran (#4330).
    const capApplied = confirmedRows.length >= API_SCAN_CAP || suspectedRows.length >= API_SCAN_CAP;

    ok(res, {
      violations,
      total,
      limit,
      offset,
      since,
      until,
      gateway: gateway ?? null,
      includeUnknown,
      suspectedAvailable,
      suspectedWindowMs,
      sources: sourceIds,
      capApplied,
      scanCap: API_SCAN_CAP,
    });
  } catch (error) {
    logger.error('Error in GET /api/analysis/mqtt-violations/packets:', error);
    fail(res, 500, 'MQTT_VIOLATIONS_FETCH_FAILED', 'Failed to fetch ok_to_mqtt violations');
  }
});

export default router;
