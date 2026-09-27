/**
 * Server side of sign-flipped position correction (#5363).
 *
 * Resolves each source's settings and reference point, then rewrites the
 * position on node payloads leaving the API. Display only: nothing here writes
 * to the database, and every feature that reads positions from the database
 * (distance auto-delete, geo-ignore, position estimation, coverage, automations)
 * keeps seeing the reported coordinates.
 *
 * Correction happens here, at the node → API mapping step, rather than in the
 * browser because the reference point is per source (each source's own node),
 * and the unified views merge nodes from many sources before they reach the
 * map. Correcting each source's rows before the merge keeps the corrected
 * point and its "reported" pair on the same record.
 */
import databaseService from '../../services/database.js';
import { getEffectiveDbNodePosition, type EffectivePosition } from '../utils/nodeEnhancer.js';
import { logger } from '../../utils/logger.js';
import {
  detectSignFlip,
  parseSignFlipSettings,
  type LatLon,
} from '../../utils/signFlipPosition.js';
import { isBogusPosition } from '../../utils/nullIsland.js';

export const SIGN_FLIP_SETTING_KEYS = {
  enabled: 'signFlipCorrectionEnabled',
  rangeKm: 'signFlipCorrectionRangeKm',
  referenceLat: 'signFlipReferenceLatitude',
  referenceLon: 'signFlipReferenceLongitude',
} as const;

/** What a payload needs to correct positions for one source. */
export interface SignFlipContext {
  reference: LatLon;
  rangeKm: number;
}

/** Fields added to a node whose position was corrected. */
export interface SignFlipFields {
  positionSignFlipCorrected?: boolean;
  reportedLatitude?: number;
  reportedLongitude?: number;
}

/**
 * The source's own node position: its Meshtastic local node row, with a user
 * override honoured. Sources without a local node (MQTT, MeshCore) return
 * null, so they need a manual reference point.
 */
async function resolveOwnNodePosition(sourceId: string): Promise<LatLon | null> {
  const raw = await databaseService.settings.getLocalNodeNumForSource(sourceId);
  const nodeNum = raw ? Number(raw) : NaN;
  if (!Number.isFinite(nodeNum) || nodeNum <= 0) return null;
  const row = await databaseService.nodes.getNode(nodeNum, sourceId);
  const eff = getEffectiveDbNodePosition(row);
  if (eff.latitude == null || eff.longitude == null) return null;
  if (isBogusPosition(eff.latitude, eff.longitude)) return null;
  return { latitude: eff.latitude, longitude: eff.longitude };
}

/**
 * Load one source's correction context. Null when the feature is off for the
 * source or no reference point is known (no manual point and no own-node fix).
 */
export async function loadSignFlipContext(sourceId: string | null | undefined): Promise<SignFlipContext | null> {
  if (!sourceId) return null;
  try {
    const settings = databaseService.settings;
    const enabledRaw = await settings.getSettingForSource(sourceId, SIGN_FLIP_SETTING_KEYS.enabled);
    // Cheap exit: one read per request when the feature is off (the default).
    if (enabledRaw !== 'true' && enabledRaw !== '1') return null;
    const [rangeKm, referenceLat, referenceLon] = await Promise.all([
      settings.getSettingForSource(sourceId, SIGN_FLIP_SETTING_KEYS.rangeKm),
      settings.getSettingForSource(sourceId, SIGN_FLIP_SETTING_KEYS.referenceLat),
      settings.getSettingForSource(sourceId, SIGN_FLIP_SETTING_KEYS.referenceLon),
    ]);
    const parsed = parseSignFlipSettings({ enabled: enabledRaw, rangeKm, referenceLat, referenceLon });
    const reference = parsed.manualReference ?? await resolveOwnNodePosition(sourceId);
    if (!reference) return null;
    return { reference, rangeKm: parsed.rangeKm };
  } catch (err) {
    // A failed lookup must never break the node list; show positions as reported.
    logger.warn(`Sign-flip context failed for source ${sourceId}:`, err);
    return null;
  }
}

/**
 * Per-request memo so a payload that spans several sources (unified views,
 * embed profiles) loads each source's context once.
 */
export function createSignFlipResolver(): (sourceId: string | null | undefined) => Promise<SignFlipContext | null> {
  const cache = new Map<string, Promise<SignFlipContext | null>>();
  return (sourceId) => {
    if (!sourceId) return Promise.resolve(null);
    let hit = cache.get(sourceId);
    if (!hit) {
      hit = loadSignFlipContext(sourceId);
      cache.set(sourceId, hit);
    }
    return hit;
  };
}

type PositionLike = { latitude?: number | null; longitude?: number | null; [k: string]: unknown };
type NodeLike = {
  latitude?: number | null;
  longitude?: number | null;
  position?: PositionLike | null;
  positionPrecisionBits?: number | null;
  positionIsOverride?: boolean;
  positionIsEstimated?: boolean;
};

/**
 * Correct one lat/lon pair (for payloads that carry bare coordinates, such as
 * neighbor-link endpoints). Returns the input when no correction applies.
 */
export function correctLatLon(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  ctx: SignFlipContext | null,
  precisionBits?: number | null,
): { latitude: number | null | undefined; longitude: number | null | undefined } {
  if (!ctx) return { latitude, longitude };
  const r = detectSignFlip(latitude, longitude, ctx.reference, ctx.rangeKm, precisionBits);
  return r ? { latitude: r.latitude, longitude: r.longitude } : { latitude, longitude };
}

/**
 * Return `node` with its device-reported position corrected when it looks
 * sign-flipped. Handles both node shapes the API emits: the nested
 * `position: { latitude, longitude }` of DeviceInfo, and the flat
 * `latitude`/`longitude` of the dashboard rows (updating whichever are
 * present). User overrides and trilaterated estimates are never touched.
 */
export function applySignFlipCorrection<T extends object>(node: T, ctx: SignFlipContext | null): T & SignFlipFields {
  if (!ctx) return node;
  const n = node as T & NodeLike;
  if (n.positionIsOverride === true || n.positionIsEstimated === true) return node;

  const lat = n.position?.latitude ?? n.latitude;
  const lon = n.position?.longitude ?? n.longitude;
  const r = detectSignFlip(lat, lon, ctx.reference, ctx.rangeKm, n.positionPrecisionBits);
  if (!r) return node;

  const out: T & NodeLike & SignFlipFields = {
    ...n,
    positionSignFlipCorrected: true,
    reportedLatitude: lat as number,
    reportedLongitude: lon as number,
  };
  if (n.position && n.position.latitude != null && n.position.longitude != null) {
    out.position = { ...n.position, latitude: r.latitude, longitude: r.longitude };
  }
  if (n.latitude != null && n.longitude != null) {
    out.latitude = r.latitude;
    out.longitude = r.longitude;
  }
  return out;
}

/**
 * Load contexts for every distinct source id in `sourceIds`, for synchronous
 * loops over DB rows that may span several sources (embed profiles).
 */
export async function loadSignFlipContexts(
  sourceIds: Iterable<string | null | undefined>,
): Promise<Map<string, SignFlipContext | null>> {
  const resolve = createSignFlipResolver();
  const ids = [...new Set([...sourceIds].filter((id): id is string => !!id))];
  const out = new Map<string, SignFlipContext | null>();
  await Promise.all(ids.map(async (id) => { out.set(id, await resolve(id)); }));
  return out;
}

/**
 * `getEffectiveDbNodePosition` plus sign-flip correction for a DB row. An
 * override is shown as set; only a device-reported fix can be corrected.
 */
export function getDisplayDbNodePosition(
  node: Parameters<typeof getEffectiveDbNodePosition>[0],
  ctx: SignFlipContext | null | undefined,
): EffectivePosition {
  const eff = getEffectiveDbNodePosition(node);
  if (eff.isOverride || !ctx) return eff;
  const bits = (node as { positionPrecisionBits?: number | null } | null | undefined)?.positionPrecisionBits;
  const c = correctLatLon(eff.latitude, eff.longitude, ctx, bits);
  return { ...eff, latitude: c.latitude, longitude: c.longitude };
}

/**
 * A node row's source id. Rows carry the `sourceId` column even though the
 * shared `DbNode` type does not declare it.
 */
export function rowSourceId(row: unknown): string | undefined {
  const id = (row as { sourceId?: unknown } | null | undefined)?.sourceId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
