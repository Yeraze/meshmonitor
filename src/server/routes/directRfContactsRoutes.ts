/**
 * Direct RF Contacts API (#6210).
 *
 * Mounted at `/api/sources/:id/direct-rf-contacts` (`mergeParams`). Reads the
 * per-source daily rollup `direct_rf_contacts`: the nodes this source's own
 * radio heard at zero hops over RF. Read-only and passive; sends nothing.
 *
 *  - `GET /?from=&to=`               one row per node over the window
 *  - `GET /node/:nodeKey?from=&to=`  one node's summary plus its daily series
 *
 * `from` / `to` are unix ms; `to` defaults to now and `from` to 7 days
 * before `to`. Counts are whole UTC days: a window edge that cuts a day
 * counts that day's receptions in full.
 *
 * Gate: `nodes:read` on the source in the path. A distance is returned only
 * when both the contact's and the source's own node position pass the
 * per-row position gate (`buildPositionFilter` / `buildMeshCorePositionFilter`).
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  buildPositionFilter,
  buildMeshCorePositionFilter,
} from '../utils/positionVisibility.js';
import { loadSourcePermissions } from '../utils/sourcePermissions.js';
import { nodeCoveragePosition } from '../utils/coverageReceiverPositionCache.js';
import { resolveLocalNodeNums } from '../utils/localNodeNums.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { calculateDistance } from '../../utils/distance.js';
import { clampDirectRfRetentionDays, DIRECT_RF_RETENTION_SETTING } from '../../utils/directRfContacts.js';
import { DIRECT_RF_DAY_MS, type DirectRfContactSummary } from '../../db/repositories/directRfContacts.js';
import type { DbNode } from '../../db/types.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';

const router = Router({ mergeParams: true });

const DEFAULT_WINDOW_MS = 7 * DIRECT_RF_DAY_MS;
const MAX_WINDOW_MS = 366 * DIRECT_RF_DAY_MS;

const MESHTASTIC_KEY = /^![0-9a-f]{8}$/;
const MESHCORE_KEY = /^[0-9a-f]{64}$/;

export interface DirectRfContactRow extends DirectRfContactSummary {
  name: string | null;
  shortName: string | null;
  /** Great-circle km between this node and the source's own node; null when either position is unknown or hidden. */
  distanceKm: number | null;
}

type Window = { fromMs: number; toMs: number };

/** Parse `from` / `to`; null when the range is invalid. */
export function parseWindow(query: Record<string, unknown>, nowMs: number): Window | null {
  const num = (v: unknown): number | null | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const to = num(query.to);
  const from = num(query.from);
  if (to === null || from === null) return null;
  const toMs = to ?? nowMs;
  const fromMs = from ?? toMs - DEFAULT_WINDOW_MS;
  if (fromMs < 0 || fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS) return null;
  return { fromMs, toMs };
}

/** Normalise a path node key: `!xxxxxxxx` or a 64-hex public key, lowercased. */
export function parseNodeKey(raw: string | undefined): string | null {
  const key = (raw ?? '').trim().toLowerCase();
  return MESHTASTIC_KEY.test(key) || MESHCORE_KEY.test(key) ? key : null;
}

type Pos = { lat: number; lon: number } | null;
const usable = (lat: number | null | undefined, lon: number | null | undefined): Pos =>
  lat == null || lon == null || isBogusPosition(lat, lon) ? null : { lat, lon };

function meshCorePosition(n: DbMeshCoreNode): Pos {
  const hasOverride = !!n.positionOverrideEnabled && n.latitudeOverride != null && n.longitudeOverride != null;
  return usable(hasOverride ? n.latitudeOverride : n.latitude, hasOverride ? n.longitudeOverride : n.longitude);
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/**
 * Add names and distances to summaries of one source. Loads that source's
 * node table(s) once; the position gates run per row on that source.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #6210 req.user's shape is not exported from authMiddleware; matches buildPositionFilter's signature
async function enrich(user: any, sourceId: string, summaries: DirectRfContactSummary[]): Promise<DirectRfContactRow[]> {
  const needMt = summaries.some((s) => s.protocol === 'meshtastic');
  const needMc = summaries.some((s) => s.protocol === 'meshcore');
  const permissions = (needMt || needMc) ? await loadSourcePermissions(user?.id != null ? user : null) : undefined;

  const mtNodes = new Map<number, DbNode>();
  let mtVisible: ((r: { sourceId: string; nodeNum: number }) => boolean) | null = null;
  let mtLocal: Pos = null;
  if (needMt) {
    const nodes = await databaseService.nodes.getAllNodes(sourceId);
    for (const n of nodes) mtNodes.set(Number(n.nodeNum), n);
    mtVisible = await buildPositionFilter(user, [sourceId], new Map([[sourceId, nodes]]), permissions);
    const localNum = (await resolveLocalNodeNums([sourceId])).get(sourceId);
    const localNode = localNum != null ? mtNodes.get(localNum) : undefined;
    if (localNode && mtVisible({ sourceId, nodeNum: localNum! })) {
      const p = nodeCoveragePosition(localNode);
      mtLocal = usable(p.lat, p.lon);
    }
  }

  const mcNodes = new Map<string, DbMeshCoreNode>();
  let mcVisible: ((r: { sourceId: string; publicKey: string }) => boolean) | null = null;
  let mcLocal: Pos = null;
  if (needMc) {
    const nodes = await databaseService.meshcore.getNodesBySource(sourceId);
    for (const n of nodes) mcNodes.set(n.publicKey.toLowerCase(), n);
    mcVisible = await buildMeshCorePositionFilter(user, [sourceId], new Map([[sourceId, nodes]]), permissions);
    const local = nodes.find((n) => n.isLocalNode);
    if (local && mcVisible({ sourceId, publicKey: local.publicKey })) mcLocal = meshCorePosition(local);
  }

  return summaries.map((s) => {
    let name: string | null = null;
    let shortName: string | null = null;
    let distanceKm: number | null = null;
    if (s.protocol === 'meshtastic' && s.nodeNum != null) {
      const n = mtNodes.get(s.nodeNum);
      name = n?.longName?.trim() || null;
      shortName = n?.shortName?.trim() || null;
      if (n && mtLocal && mtVisible?.({ sourceId, nodeNum: s.nodeNum })) {
        const p = nodeCoveragePosition(n);
        const pos = usable(p.lat, p.lon);
        if (pos) distanceKm = calculateDistance(mtLocal.lat, mtLocal.lon, pos.lat, pos.lon);
      }
    } else if (s.protocol === 'meshcore') {
      const n = mcNodes.get(s.nodeKey);
      name = n?.name?.trim() || null;
      if (n && mcLocal && mcVisible?.({ sourceId, publicKey: s.nodeKey })) {
        const pos = meshCorePosition(n);
        if (pos) distanceKm = calculateDistance(mcLocal.lat, mcLocal.lon, pos.lat, pos.lon);
      }
    }
    return {
      ...s,
      avgSnr: round1(s.avgSnr),
      avgRssi: round1(s.avgRssi),
      name,
      shortName,
      distanceKm: distanceKm === null ? null : Math.round(distanceKm * 100) / 100,
    };
  });
}

async function retentionDays(): Promise<number> {
  return clampDirectRfRetentionDays(await databaseService.getSettingAsync(DIRECT_RF_RETENTION_SETTING));
}

/** GET /api/sources/:id/direct-rf-contacts?from=&to= */
router.get(
  '/',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id?: string }).id!;
    const window = parseWindow(req.query as Record<string, unknown>, Date.now());
    if (!window) {
      fail(res, 400, 'INVALID_RANGE', 'from/to must be unix ms with from < to and a window of at most 366 days');
      return;
    }
    try {
      const summaries = await databaseService.directRfContacts.getContacts({ sourceId, ...window });
      const contacts = await enrich(req.user, sourceId, summaries);
      ok(res, {
        sourceId,
        from: window.fromMs,
        to: window.toMs,
        retentionDays: await retentionDays(),
        contacts,
      });
    } catch (error) {
      logger.error('[API] Error reading direct RF contacts:', error);
      fail(res, 500, 'DIRECT_RF_CONTACTS_FAILED', 'Failed to read direct RF contacts');
    }
  },
);

/** GET /api/sources/:id/direct-rf-contacts/node/:nodeKey?from=&to= */
router.get(
  '/node/:nodeKey',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id?: string }).id!;
    const nodeKey = parseNodeKey((req.params as { nodeKey?: string }).nodeKey);
    if (!nodeKey) {
      fail(res, 400, 'INVALID_NODE_ID', 'nodeKey must be !xxxxxxxx or a 64-hex public key');
      return;
    }
    const window = parseWindow(req.query as Record<string, unknown>, Date.now());
    if (!window) {
      fail(res, 400, 'INVALID_RANGE', 'from/to must be unix ms with from < to and a window of at most 366 days');
      return;
    }
    try {
      const daily = await databaseService.directRfContacts.getNodeDaily({ sourceId, nodeKey, ...window });
      const summaries = daily.length > 0
        ? await databaseService.directRfContacts.getContacts({ sourceId, nodeKey, ...window })
        : [];
      const [summary] = summaries.length > 0 ? await enrich(req.user, sourceId, summaries) : [null];
      ok(res, {
        sourceId,
        nodeKey,
        from: window.fromMs,
        to: window.toMs,
        retentionDays: await retentionDays(),
        summary: summary ?? null,
        daily,
      });
    } catch (error) {
      logger.error('[API] Error reading direct RF contact detail:', error);
      fail(res, 500, 'DIRECT_RF_CONTACTS_FAILED', 'Failed to read direct RF contact detail');
    }
  },
);

export default router;
