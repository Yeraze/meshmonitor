/**
 * Cross-source telemetry reads behind `/api/unified/telemetry*` (#5896).
 *
 * Both reads apply, per source, the rules of the per-node route
 * `GET /api/telemetry/:nodeId`:
 *   - the source needs `nodes:read`;
 *   - a Meshtastic node needs `viewOnMap` on the channel it was heard on THERE
 *     (a MeshCore peer, which has no channel, needs `nodes:viewOnMap`);
 *   - a private-position node's position rows need `nodes_private:read` there.
 * Grants load once per request (`loadNodeViewAccess`), so no check queries per
 * node.
 *
 * Neither read loops per node: the snapshot is one query per source, and the
 * series are one averaged query per (source, favorited node), asking only for
 * the favorited types.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import { loadNodeViewAccess, omitPositionTelemetry, type NodeViewAccess } from '../utils/nodeEnhancer.js';
import { expandFavoriteType, parseTelemetryFavorites } from '../../utils/telemetryRetention.js';
import { getTelemetryCategory, isObserverRelative, type TelemetryCategory } from '../../utils/telemetryCategory.js';
import type { User } from '../../types/auth.js';

/** Longest window either read serves: the telemetry retention window. */
export const UNIFIED_TELEMETRY_MAX_HOURS = 168;

const FAVORITES_KEY = 'telemetryFavorites';

interface SourceRow {
  id: string;
  name: string;
  type: string;
}

/** A node the caller may read telemetry for on one source. */
interface TelemetrySubject {
  /** The telemetry rows' nodeId: `!hex` for Meshtastic, the public key for MeshCore. */
  telemetryNodeId: string;
  longName: string | null;
  shortName: string | null;
  /** Drop position rows: private position and no `nodes_private:read` here. */
  hidePosition: boolean;
}

/** Clamp a `?hours=` value: positive, at most the retention window, default 24. */
export function parseTelemetryHours(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return Math.min(parsed, UNIFIED_TELEMETRY_MAX_HOURS);
}

/** Sources the caller holds `nodes:read` on (every source for an admin). */
async function readableSources(access: NodeViewAccess): Promise<SourceRow[]> {
  const sources = await databaseService.sources.getAllSources();
  return sources
    .filter((s) => access.isAdmin || access.permissions.can('nodes', 'read', s.id))
    .map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

/** The nodes of `source` the caller may read telemetry for, keyed by telemetry nodeId. */
async function visibleSubjects(source: SourceRow, access: NodeViewAccess): Promise<Map<string, TelemetrySubject>> {
  const out = new Map<string, TelemetrySubject>();
  if (isAnyMeshCoreSourceType(source.type)) {
    if (!access.isAdmin && !access.permissions.can('nodes', 'viewOnMap', source.id)) return out;
    for (const n of await databaseService.meshcore.getNodesBySource(source.id)) {
      out.set(n.publicKey, { telemetryNodeId: n.publicKey, longName: n.name ?? null, shortName: null, hidePosition: false });
    }
    return out;
  }
  const canViewPrivate = access.canViewPrivate(source.id);
  for (const n of await databaseService.nodes.getAllNodes(source.id)) {
    if (!access.canViewNode(source.id, n.channel)) continue;
    out.set(n.nodeId, {
      telemetryNodeId: n.nodeId,
      longName: n.longName ?? null,
      shortName: n.shortName ?? null,
      hidePosition: !!n.positionOverrideIsPrivate && !canViewPrivate,
    });
  }
  return out;
}

/**
 * Each source's favorites list. A source with no list of its own reads the
 * legacy global list, as `GET /api/settings?sourceId=` does.
 */
async function favoritesBySource(sourceIds: string[]): Promise<Map<string, Array<{ nodeId: string; telemetryType: string }>>> {
  const [own, globalRaw] = await Promise.all([
    databaseService.settings.getSettingForSources(sourceIds, FAVORITES_KEY),
    databaseService.settings.getSetting(FAVORITES_KEY),
  ]);
  const out = new Map<string, Array<{ nodeId: string; telemetryType: string }>>();
  for (const id of sourceIds) {
    const raw = own.get(id) ?? globalRaw;
    out.set(id, parseTelemetryFavorites(raw, `source ${id}`));
  }
  return out;
}

function canEditFavorites(access: NodeViewAccess, sourceId: string): boolean {
  return access.isAdmin || access.permissions.can('settings', 'write', sourceId);
}

// ── Latest snapshot ──────────────────────────────────────────────────────

export interface LatestTelemetryEntry {
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  value: number;
  unit?: string;
  timestamp: number;
  sourceId: string;
  sourceName: string;
  nodeLongName: string | null;
  nodeShortName: string | null;
  /** On this source's favorites list. */
  favorited: boolean;
  /** The caller may change this source's favorites (`settings:write` there). */
  canEditFavorite: boolean;
}

/**
 * The newest reading per node per type, across every source the caller may
 * read, from the past `hours`. Newest first.
 */
export async function getLatestTelemetrySnapshot(user: User | null | undefined, hours: number): Promise<LatestTelemetryEntry[]> {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const access = await loadNodeViewAccess(user);
  const sources = await readableSources(access);
  const favorites = await favoritesBySource(sources.map((s) => s.id));

  const perSource = await Promise.allSettled(
    sources.map(async (source) => {
      const [subjects, rows] = await Promise.all([
        visibleSubjects(source, access),
        databaseService.telemetry.getLatestTelemetryPerNodeAndTypeSince(source.id, cutoff),
      ]);
      const favoriteKeys = new Set((favorites.get(source.id) ?? []).map((f) => `${f.nodeId}\u0000${f.telemetryType}`));
      const canEdit = canEditFavorites(access, source.id);
      const hidden = new Set<string>();
      for (const s of subjects.values()) if (s.hidePosition) hidden.add(s.telemetryNodeId);

      const entries: LatestTelemetryEntry[] = [];
      const visibleRows = rows.filter((r) => subjects.has(r.nodeId));
      const kept = visibleRows.filter((r) => !hidden.has(r.nodeId))
        .concat(omitPositionTelemetry(visibleRows.filter((r) => hidden.has(r.nodeId))));
      for (const r of kept) {
        const subject = subjects.get(r.nodeId)!;
        entries.push({
          nodeId: r.nodeId,
          nodeNum: r.nodeNum,
          telemetryType: r.telemetryType,
          value: r.value,
          unit: r.unit ?? undefined,
          timestamp: r.timestamp,
          sourceId: source.id,
          sourceName: source.name,
          nodeLongName: subject.longName,
          nodeShortName: subject.shortName,
          favorited: favoriteKeys.has(`${r.nodeId}\u0000${r.telemetryType}`),
          canEditFavorite: canEdit,
        });
      }
      return entries;
    }),
  );

  const all: LatestTelemetryEntry[] = [];
  perSource.forEach((result, i) => {
    if (result.status === 'fulfilled') all.push(...result.value);
    else logger.warn(`Unified telemetry: failed to read source ${sources[i].id}:`, result.reason);
  });
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all;
}

// ── Favorited series ─────────────────────────────────────────────────────

export interface TelemetrySeriesLine {
  sourceId: string;
  sourceName: string;
  unit: string | null;
  /** This (node, favorite type) is on this source's favorites list. */
  favorited: boolean;
  /** The caller may change this source's favorites (`settings:write` there). */
  canEditFavorite: boolean;
  /** Oldest first. */
  points: Array<{ timestamp: number; value: number }>;
}

export interface TelemetrySeries {
  /** `!hex` node id (Meshtastic, MQTT) or public key (MeshCore). */
  subjectKey: string;
  nodeName: string;
  /** The stored telemetry type this chart plots. */
  type: string;
  /** The favorites entry that put it here (a pseudo type such as `transportPacketsRx` plots as its parts). */
  favoriteType: string;
  category: TelemetryCategory;
  observerRelative: boolean;
  /** One line per source that holds data for this node and type. */
  lines: TelemetrySeriesLine[];
}

export interface TelemetrySeriesResponse {
  series: TelemetrySeries[];
}

/**
 * Every favorited series across the sources the caller may read (the union of
 * those sources' favorites lists), with one line per readable source that has
 * data for the node. Averaged to ~240 points per line.
 */
export async function getFavoriteTelemetrySeries(user: User | null | undefined, hours: number): Promise<TelemetrySeriesResponse> {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const access = await loadNodeViewAccess(user);
  const sources = await readableSources(access);
  if (sources.length === 0) return { series: [] };
  const [favorites, subjectLists] = await Promise.all([
    favoritesBySource(sources.map((s) => s.id)),
    Promise.all(
      sources.map((source) =>
        visibleSubjects(source, access).catch((err) => {
          logger.warn(`Unified telemetry series: failed to list nodes of source ${source.id}:`, err);
          return new Map<string, TelemetrySubject>();
        }),
      ),
    ),
  ]);
  const subjectsBySource = new Map(sources.map((s, i) => [s.id, subjectLists[i]]));

  // subjectKey → stored type → the favorite type it came from. A favorite
  // counts only where the caller may see its node on the source that holds it,
  // so the list never names a node the caller cannot otherwise see there.
  const wanted = new Map<string, Map<string, string>>();
  // `${source}\0${subject}\0${favoriteType}` for each favorite.
  const favoritedOn = new Set<string>();
  for (const [sourceId, list] of favorites) {
    const subjects = subjectsBySource.get(sourceId);
    for (const f of list) {
      if (!subjects?.has(f.nodeId)) continue;
      favoritedOn.add(`${sourceId}\u0000${f.nodeId}\u0000${f.telemetryType}`);
      let types = wanted.get(f.nodeId);
      if (!types) wanted.set(f.nodeId, (types = new Map()));
      for (const stored of expandFavoriteType(f.telemetryType)) {
        if (!types.has(stored)) types.set(stored, f.telemetryType);
      }
    }
  }
  if (wanted.size === 0) return { series: [] };

  // `${subject}\0${type}` → series under construction.
  const bySeries = new Map<string, TelemetrySeries>();
  const names = new Map<string, string>();

  await Promise.all(
    sources.map(async (source) => {
      const subjects = subjectsBySource.get(source.id)!;
      const canEdit = canEditFavorites(access, source.id);
      await Promise.all(
        [...wanted].map(async ([subjectKey, typeMap]) => {
          const subject = subjects.get(subjectKey);
          if (!subject) return;
          let rows;
          try {
            rows = await databaseService.getTelemetryByNodeAveragedAsync(
              subjectKey, cutoff, undefined, hours, source.id, [...typeMap.keys()],
            );
          } catch (err) {
            logger.warn(`Unified telemetry series: failed to read ${subjectKey} on source ${source.id}:`, err);
            return;
          }
          if (subject.hidePosition) rows = omitPositionTelemetry(rows);
          if (rows.length === 0) return;

          const name = subject.longName || subject.shortName;
          if (name && !names.has(subjectKey)) names.set(subjectKey, name);

          const byType = new Map<string, typeof rows>();
          for (const r of rows) {
            let list = byType.get(r.telemetryType);
            if (!list) byType.set(r.telemetryType, (list = []));
            list.push(r);
          }
          for (const [type, list] of byType) {
            const favoriteType = typeMap.get(type);
            if (!favoriteType) continue;
            const key = `${subjectKey}\u0000${type}`;
            let series = bySeries.get(key);
            if (!series) {
              series = {
                subjectKey,
                nodeName: subjectKey,
                type,
                favoriteType,
                category: getTelemetryCategory(type),
                observerRelative: isObserverRelative(type),
                lines: [],
              };
              bySeries.set(key, series);
            }
            list.sort((a, b) => a.timestamp - b.timestamp);
            series.lines.push({
              sourceId: source.id,
              sourceName: source.name,
              unit: list.find((r) => r.unit)?.unit ?? null,
              favorited: favoritedOn.has(`${source.id}\u0000${subjectKey}\u0000${favoriteType}`),
              canEditFavorite: canEdit,
              points: list.map((r) => ({ timestamp: r.timestamp, value: r.value })),
            });
          }
        }),
      );
    }),
  );

  const sourceOrder = new Map(sources.map((s, i) => [s.id, i]));
  const series = [...bySeries.values()];
  for (const s of series) {
    s.nodeName = names.get(s.subjectKey) ?? s.subjectKey;
    s.lines.sort((a, b) => (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0));
  }
  series.sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.type.localeCompare(b.type));
  return { series };
}
