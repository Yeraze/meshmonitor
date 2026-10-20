/**
 * Cross-source hop candidates (#5909).
 *
 * A MeshCore route is a list of relay hashes: each is the leading 1–3 bytes of
 * a repeater's public key. The message route view names a hash from the
 * receiving source's own contacts. When none matches, this module offers names
 * from the OTHER MeshCore sources the viewer may read, so a busy `meshcore_mqtt`
 * feed can fill the gaps a companion's contact table leaves.
 *
 * Display only. Nothing here is written, sent, or fed into `cross_source_links`.
 *
 * Rules:
 *  - Only sources the viewer can read under `nodes` (admins: every enabled
 *    source), excluding the requesting source itself. A viewer who can read
 *    one source never sees a name from another.
 *  - Only relay infrastructure (repeaters advType 2, room servers advType 3),
 *    matching `resolveRoute` on the client.
 *  - A `meshcore_mqtt` node counts only when its latest advert's signature
 *    verified (`advertSignatureVerified === true`), since such a feed relays
 *    adverts published by strangers. Device-backed sources count as-is: the
 *    radio already accepted the contact.
 *  - A position is included only when `buildMeshCorePositionFilter` passes it
 *    (per-source `nodes:viewOnMap`, private overrides need `nodes_private:read`).
 *    A node whose position the viewer may not see is still a candidate, just
 *    without coordinates.
 *  - A node known to several sources appears once (device sources win the
 *    label; a position from any readable copy fills in a missing one).
 */
import type { Request } from 'express';
import databaseService from '../../services/database.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import { resolvePermittedSourceIds } from '../utils/permittedSources.js';
import { buildMeshCorePositionFilter, loadMeshCoreNodesBySource } from '../utils/positionVisibility.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { CROSS_SOURCE_HOP_RESOLUTION_SETTING } from './meshcoreFrameIngest.js';
import type { CrossSourceHopCandidate, CrossSourceHopPool } from '../../utils/meshcorePath.js';

/** One node on another source whose key starts with a requested hop hash. */
export type HopCandidate = CrossSourceHopCandidate;

/** Hop hash (lowercase hex) to its candidates. */
export type HopCandidatePool = CrossSourceHopPool;

/** Most hop hashes one request may ask about (a path holds at most 64). */
export const MAX_HOP_PREFIXES = 64;

const RELAY_ADV_TYPES = new Set([2, 3]);

/**
 * Parse the `prefixes` query value: comma-separated hop hashes of 2, 4 or 6
 * hex chars. Invalid tokens are dropped; duplicates collapse; capped at
 * {@link MAX_HOP_PREFIXES}.
 */
export function parseHopPrefixes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out = new Set<string>();
  for (const tok of raw.split(',')) {
    const t = tok.trim().toLowerCase();
    if (/^[0-9a-f]{2}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$/.test(t)) out.add(t);
    if (out.size >= MAX_HOP_PREFIXES) break;
  }
  return [...out];
}

/** Is the global opt-in on? Off by default. */
export async function isCrossSourceHopResolutionEnabled(): Promise<boolean> {
  return databaseService.settings.getSettingAsBoolean(CROSS_SOURCE_HOP_RESOLUTION_SETTING, false);
}

/** The node's display position: an enabled override wins, then the advert fix. */
function nodePosition(n: DbMeshCoreNode): { latitude: number; longitude: number } | null {
  const useOverride = n.positionOverrideEnabled === true
    && typeof n.latitudeOverride === 'number' && typeof n.longitudeOverride === 'number';
  const lat = useOverride ? n.latitudeOverride : n.latitude;
  const lon = useOverride ? n.longitudeOverride : n.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if ((lat === 0 && lon === 0) || isBogusPosition(lat, lon)) return null;
  return { latitude: lat, longitude: lon };
}

/**
 * Build the candidate pool for `prefixes`, as seen by `req.user`, for a route
 * received on `requestingSourceId`. Caller checks the toggle and the
 * requesting source's own `nodes:read`.
 */
export async function buildHopCandidatePool(
  req: Request,
  requestingSourceId: string,
  prefixes: string[],
): Promise<HopCandidatePool> {
  const pool: HopCandidatePool = {};
  if (prefixes.length === 0) return pool;

  const allSources = await databaseService.sources.getAllSources();
  const permitted = new Set(await resolvePermittedSourceIds(req, 'nodes', allSources));
  // Device-backed sources first, so their copy of a shared node names it.
  const others = allSources
    .filter((s) => s.id !== requestingSourceId && permitted.has(s.id))
    .filter((s) => s.type === 'meshcore' || s.type === 'meshcore_mqtt')
    .sort((a, b) => Number(a.type === 'meshcore_mqtt') - Number(b.type === 'meshcore_mqtt'));
  if (others.length === 0) return pool;

  const otherIds = others.map((s) => s.id);
  const nodesBySource = await loadMeshCoreNodesBySource(otherIds);
  const canSeePosition = await buildMeshCorePositionFilter(req.user, otherIds, nodesBySource);

  for (const prefix of prefixes) {
    const byKey = new Map<string, HopCandidate>();
    for (const src of others) {
      const isMqtt = src.type === 'meshcore_mqtt';
      for (const n of nodesBySource.get(src.id) ?? []) {
        const key = n.publicKey.toLowerCase();
        if (!key.startsWith(prefix)) continue;
        if (n.advType == null || !RELAY_ADV_TYPES.has(Number(n.advType))) continue;
        const name = (n.name ?? '').trim();
        if (!name) continue;
        if (isMqtt && n.advertSignatureVerified !== true) continue;

        const pos = canSeePosition({ sourceId: src.id, publicKey: n.publicKey }) ? nodePosition(n) : null;
        const existing = byKey.get(key);
        if (existing) {
          if (existing.latitude === undefined && pos) {
            existing.latitude = pos.latitude;
            existing.longitude = pos.longitude;
          }
          continue;
        }
        byKey.set(key, {
          name,
          publicKey: n.publicKey,
          sourceId: src.id,
          sourceName: src.name,
          ...(pos ?? {}),
        });
      }
    }
    if (byKey.size > 0) pool[prefix] = [...byKey.values()];
  }
  return pool;
}
