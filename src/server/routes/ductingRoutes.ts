/**
 * Tropospheric ducting forecast (#5734).
 *
 * GET /api/ducting/forecast?hoursAhead=0..72[&sourceId=<id>]
 *
 * Gates, in order:
 *  1. `ductingOverlayEnabled` (global, admin-set, off by default). While off,
 *     every caller (admins too) gets 403 DUCTING_DISABLED and nothing
 *     contacts NOAA.
 *  2. The map's read gate: the caller (or the anonymous user) needs
 *     `nodes:read` on at least one source.
 *
 * The area is the busiest cluster of recently heard Meshtastic nodes the
 * CALLER could see on the map (their readable sources, through
 * `buildPositionFilter`), anchored on those sources' own local nodes (#5951),
 * so the box never hints at nodes on a source they cannot read. Viewers with the
 * same visible nodes share one box and so one cache entry.
 *
 * `sourceId` (#5972) scopes the area to one source the caller can read: its
 * Meshtastic nodes, or its MeshCore nodes (through
 * `buildMeshCorePositionFilter`), anchored on its local node. The MeshCore
 * map passes it, since the default area holds only Meshtastic nodes. `bbox` stays
 * available to admins (debugging); others get 403, so a caller cannot make
 * the server fetch arbitrary boxes from NOAA.
 *
 * No timer and no prefetch: a NOAA request happens only on a cache miss for
 * the step a viewer opened.
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { resolvePermittedSourceIds } from '../utils/permittedSources.js';
import {
  buildMeshCorePositionFilter,
  buildPositionFilter,
  loadMeshCoreNodesBySource,
  loadNodesBySource,
} from '../utils/positionVisibility.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { DuctingForecastService, MAX_HOURS_AHEAD } from '../services/ducting/ductingForecastService.js';
import { GfsUnavailableError, type BBox } from '../services/ducting/gfsClient.js';
import { Grib2FormatError } from '../services/ducting/grib2.js';
import { GfsProfileError } from '../services/ducting/gfsProfile.js';

/** Largest box side, degrees. 20x20 at 0.25 degrees is 6,561 points, ~300 KB of GRIB per hour. */
export const MAX_BBOX_SPAN_DEG = 20;
/** Nodes heard within this window set the default area. */
const NODE_WINDOW_S = 7 * 86400;
/** Margin added around the nodes, degrees. */
const NODE_PAD_DEG = 0.5;
const GRID_DEG = 0.25;

let service = new DuctingForecastService();

/** Drop the forecast cache. Tests only. */
export function resetDuctingForecastForTests(): void {
  service = new DuctingForecastService();
}

export function parseBBox(raw: string): BBox | string {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return 'bbox must be minLon,minLat,maxLon,maxLat';
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return 'bbox is outside -180..180 / -90..90';
  if (minLat >= maxLat || minLon >= maxLon) return 'bbox min must be below max (boxes across 180 degrees are not supported)';
  if (maxLat - minLat > MAX_BBOX_SPAN_DEG || maxLon - minLon > MAX_BBOX_SPAN_DEG) {
    return `bbox sides must be at most ${MAX_BBOX_SPAN_DEG} degrees`;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Side of the search window, whole degrees: the span cap less the padding on both sides. */
const WINDOW_DEG = Math.floor(MAX_BBOX_SPAN_DEG - 2 * NODE_PAD_DEG);

type LatLon = { lat: number; lon: number };

/**
 * The nodes in the busiest WINDOW_DEG x WINDOW_DEG square (#5951). Positions
 * are binned on a 1 degree grid with 2D prefix sums, so every window position
 * is scored in O(1). A window scores first by how many `anchors` (the
 * caller's sources' own local nodes) it holds, then by how many `points`.
 * Taking the spread of every node instead let a couple of stray MQTT nodes
 * pull the box into empty space between clusters: Japan's nodes plus two in
 * western Russia gave a box over Mongolia that held none of them.
 */
function busiestWindow(points: readonly LatLon[], anchors: readonly LatLon[]): LatLon[] {
  const W = 360;
  const H = 180;
  const cellOf = (p: LatLon): [number, number] => [
    Math.min(H - 1, Math.max(0, Math.floor(p.lat + 90))),
    Math.min(W - 1, Math.max(0, Math.floor(p.lon + 180))),
  ];
  const prefix = (list: readonly LatLon[]): Int32Array => {
    const sum = new Int32Array((H + 1) * (W + 1));
    for (const p of list) {
      const [r, c] = cellOf(p);
      sum[(r + 1) * (W + 1) + (c + 1)] += 1;
    }
    for (let r = 1; r <= H; r++) {
      for (let c = 1; c <= W; c++) {
        const i = r * (W + 1) + c;
        sum[i] += sum[i - 1] + sum[i - (W + 1)] - sum[i - (W + 1) - 1];
      }
    }
    return sum;
  };
  const pointSum = prefix(points);
  const anchorSum = anchors.length > 0 ? prefix(anchors) : null;
  const count = (sum: Int32Array, r0: number, c0: number): number => {
    const r1 = Math.min(H, r0 + WINDOW_DEG);
    const c1 = Math.min(W, c0 + WINDOW_DEG);
    return sum[r1 * (W + 1) + c1] - sum[r0 * (W + 1) + c1] - sum[r1 * (W + 1) + c0] + sum[r0 * (W + 1) + c0];
  };
  let best = { anchors: -1, points: -1, r0: 0, c0: 0 };
  for (let r0 = 0; r0 + WINDOW_DEG <= H; r0++) {
    for (let c0 = 0; c0 + WINDOW_DEG <= W; c0++) {
      const a = anchorSum ? count(anchorSum, r0, c0) : 0;
      const n = count(pointSum, r0, c0);
      if (a > best.anchors || (a === best.anchors && n > best.points)) best = { anchors: a, points: n, r0, c0 };
    }
  }
  const inside = (p: LatLon) => {
    const [r, c] = cellOf(p);
    return r >= best.r0 && r < best.r0 + WINDOW_DEG && c >= best.c0 && c < best.c0 + WINDOW_DEG;
  };
  return [...anchors.filter(inside), ...points.filter(inside)];
}

/**
 * The forecast area: the busiest cluster of nodes (see busiestWindow; the
 * caller's local nodes, `anchors`, win over a busier group without one),
 * padded and snapped out to the GFS grid. The window keeps it within
 * MAX_BBOX_SPAN_DEG on each side.
 */
export function bboxFromPositions(points: readonly LatLon[], anchors: readonly LatLon[] = []): BBox | null {
  if (points.length === 0 && anchors.length === 0) return null;
  const members = busiestWindow(points, anchors);
  const lats = members.map((p) => p.lat);
  const lons = members.map((p) => p.lon);
  const snapDown = (v: number) => Math.floor(v / GRID_DEG) * GRID_DEG;
  const snapUp = (v: number) => Math.ceil(v / GRID_DEG) * GRID_DEG;
  const fit = (lo: number, hi: number, min: number, max: number): [number, number] => [
    Math.max(min, snapDown(lo - NODE_PAD_DEG)),
    Math.min(max, snapUp(hi + NODE_PAD_DEG)),
  ];
  const [minLat, maxLat] = fit(Math.min(...lats), Math.max(...lats), -90, 90);
  const [minLon, maxLon] = fit(Math.min(...lons), Math.max(...lons), -180, 180);
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * The area the caller's visible nodes cover. Reads only `sourceIds` (the
 * caller's readable sources) and drops any node the map would not draw for
 * them (hidden, private position, channel without viewOnMap). Each source's
 * own local node, when the caller may see its position, anchors the box
 * (#5951), so it lands where the caller's radios are. `includeMeshCore`
 * (#5972) adds the sources' MeshCore nodes under the MeshCore map's rules.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5734 req.user's shape isn't exported as a type (same as buildPositionFilter)
async function nodeArea(user: any, sourceIds: string[], includeMeshCore = false): Promise<BBox | null> {
  const cutoff = Math.floor(Date.now() / 1000) - NODE_WINDOW_S;
  const nodesBySource = await loadNodesBySource(sourceIds);
  const visible = await buildPositionFilter(user, sourceIds, nodesBySource);
  const points: LatLon[] = [];
  const anchors: LatLon[] = [];
  for (const [sourceId, nodes] of nodesBySource) {
    const localNodeNum = sourceManagerRegistry.getManager(sourceId)?.getLocalNodeInfo()?.nodeNum;
    for (const n of nodes) {
      const lat = n.latitude;
      const lon = n.longitude;
      if (lat == null || lon == null || isBogusPosition(lat, lon)) continue;
      if (!visible({ sourceId, nodeNum: Number(n.nodeNum) })) continue;
      // The local node anchors the box however long ago it was last heard:
      // it is the source's own radio, and its position is where the source is.
      if (localNodeNum != null && Number(n.nodeNum) === Number(localNodeNum)) {
        anchors.push({ lat, lon });
        continue;
      }
      if (n.lastHeard == null || n.lastHeard < cutoff) continue;
      points.push({ lat, lon });
    }
  }
  // #5972: MeshCore nodes too, so a MeshCore source has an area. Only the
  // MeshCore map asks for one (with `sourceId`), so this loads nothing on the
  // default, all-sources request.
  if (includeMeshCore) {
    const mcNodesBySource = await loadMeshCoreNodesBySource(sourceIds);
    const mcVisible = await buildMeshCorePositionFilter(user, sourceIds, mcNodesBySource);
    const cutoffMs = cutoff * 1000;
    for (const [sourceId, nodes] of mcNodesBySource) {
      for (const n of nodes) {
        if (!mcVisible({ sourceId, publicKey: n.publicKey })) continue;
        // The filter already dropped a private override the caller may not see.
        const useOverride = n.positionOverrideEnabled === true && n.latitudeOverride != null && n.longitudeOverride != null;
        const lat = useOverride ? n.latitudeOverride : n.latitude;
        const lon = useOverride ? n.longitudeOverride : n.longitude;
        if (lat == null || lon == null || isBogusPosition(lat, lon)) continue;
        if (n.isLocalNode === true) {
          anchors.push({ lat, lon });
          continue;
        }
        // MeshCore lastHeard is epoch milliseconds.
        if (n.lastHeard == null || n.lastHeard < cutoffMs) continue;
        points.push({ lat, lon });
      }
    }
  }
  return bboxFromPositions(points, anchors);
}

/** True when an admin has switched the overlay on. */
async function ductingEnabled(): Promise<boolean> {
  return (await databaseService.settings.getSetting('ductingOverlayEnabled')) === 'true';
}

const router = Router();

router.get('/forecast', optionalAuth(), async (req: Request, res: Response) => {
  if (!(await ductingEnabled())) {
    return fail(res, 403, 'DUCTING_DISABLED', 'The ducting overlay is turned off. An admin can enable it in Settings.');
  }
  const sourceIds = await resolvePermittedSourceIds(req);
  if (sourceIds.length === 0) {
    return fail(res, 403, 'FORBIDDEN', 'Viewing the ducting overlay needs map access (nodes:read) on a source');
  }
  const hoursAhead = req.query.hoursAhead === undefined ? 0 : Number(req.query.hoursAhead);
  if (!Number.isInteger(hoursAhead) || hoursAhead < 0 || hoursAhead > MAX_HOURS_AHEAD) {
    return fail(res, 400, 'INVALID_INPUT', `hoursAhead must be an integer from 0 to ${MAX_HOURS_AHEAD}`);
  }
  // #5972: one source's area (the MeshCore map). Only a source the caller
  // can read, so the box never hints at a source they cannot see.
  let areaSourceIds = sourceIds;
  if (req.query.sourceId !== undefined) {
    if (typeof req.query.sourceId !== 'string' || req.query.sourceId === '') {
      return fail(res, 400, 'INVALID_INPUT', 'sourceId must be a source id');
    }
    if (!sourceIds.includes(req.query.sourceId)) {
      return fail(res, 403, 'FORBIDDEN', 'Viewing the ducting overlay needs map access (nodes:read) on that source');
    }
    areaSourceIds = [req.query.sourceId];
  }
  let bbox: BBox | null;
  if (req.query.bbox !== undefined) {
    if (!req.user?.isAdmin) {
      return fail(res, 403, 'FORBIDDEN', 'Only an admin may pick the forecast area; omit bbox to use the nodes you can see');
    }
    if (typeof req.query.bbox !== 'string') return fail(res, 400, 'INVALID_INPUT', 'bbox must be minLon,minLat,maxLon,maxLat');
    const parsed = parseBBox(req.query.bbox);
    if (typeof parsed === 'string') return fail(res, 400, 'INVALID_INPUT', parsed);
    bbox = parsed;
  } else {
    bbox = await nodeArea(req.user, areaSourceIds, req.query.sourceId !== undefined);
    if (!bbox) return fail(res, 400, 'NO_AREA', 'No recently heard node you can see has a position');
  }
  try {
    return ok(res, { bbox, ...(await service.getForecast(bbox, hoursAhead)) });
  } catch (err) {
    if (err instanceof GfsUnavailableError) return fail(res, 503, 'GFS_UNAVAILABLE', err.message);
    if (err instanceof Grib2FormatError || err instanceof GfsProfileError) {
      logger.warn('Ducting forecast: unreadable GFS data:', err);
      return fail(res, 502, 'GFS_UNREADABLE', err.message);
    }
    logger.error('Ducting forecast failed:', err);
    return fail(res, 500, 'INTERNAL_ERROR', 'Ducting forecast failed');
  }
});

export default router;
