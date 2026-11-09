/**
 * MeshCore adapter for the shared node-list primitives (#6259). It merges the
 * node and contact feeds into one row type and supplies the key, filter
 * subject and export columns the shared sort / filter / export code needs.
 * No comparator, predicate or exporter lives here: those stay shared.
 */
import type { MeshCoreNode } from '../components/MeshCore/hooks/useMeshCore.js';
import type { MeshCoreContact } from './meshcoreHelpers.js';
import { meshcoreLastHeardMs } from './meshcoreAge.js';
import { MESHCORE_DEVICE_TYPE_LABELS } from '../components/MeshCore/meshcoreRole.js';
import type { SortField } from '../types/ui.js';
import type { SortKey } from './nodeSort.js';
import type { NodeFilterSubject } from './nodeAdvancedFilter.js';
import type { ExportColumn } from './nodeExport.js';
import { findNameReuse, nameReuseSuspectKeys } from './meshcoreNameReuse.js';

export interface MeshCoreNodeRow {
  publicKey: string;
  name: string;
  /** True when a real advertised name exists (before the 'Unknown' display
   *  fallback). Drives "hide incomplete nodes" (#6258). */
  hasName: boolean;
  advType?: number;
  rssi?: number;
  snr?: number;
  /** Epoch milliseconds. */
  lastHeard?: number;
  /** Epoch milliseconds. */
  firstHeard?: number;
  batteryMv?: number;
  uptimeSecs?: number;
  /** Hop count of the cached forwarding route; null/undefined = unknown. */
  pathLen?: number | null;
  latitude?: number;
  longitude?: number;
  hasPosition: boolean;
  isFavorite: boolean;
  /** Listed in the shared ignore list (#6259 "show ignored"). */
  isIgnored: boolean;
  /** #5553: listed in the local repeater's `neighbors` table (zero-hop). */
  isRepeaterNeighbor: boolean;
  /** Propagated from the contact's `isLocal` flag (#4438). */
  isLocal: boolean;
  /** P7a #6254: latest advert signature failed verification (null/unset = not checked). */
  advertSignatureFailed: boolean;
  /** P7a #6254: another key heard first uses this name (display only). */
  nameReuseSuspect: boolean;
  /** Lets shared grouping treat a row with no `advType` as MeshCore. */
  readonly isMeshCore: true;
}

/**
 * Merge node rows and live contacts by public key. `ignoredKeys` holds
 * lowercase keys (see `useHiddenMeshCoreKeys`).
 */
export function mergeNodesAndContacts(
  nodes: readonly MeshCoreNode[],
  contacts: readonly MeshCoreContact[],
  ignoredKeys?: ReadonlySet<string>,
): MeshCoreNodeRow[] {
  const byKey = new Map<string, MeshCoreNodeRow>();
  for (const n of nodes) {
    if (!n.publicKey) continue;
    byKey.set(n.publicKey, {
      publicKey: n.publicKey,
      name: n.name || 'Unknown',
      hasName: typeof n.name === 'string' && n.name.trim() !== '',
      advType: n.advType,
      rssi: n.rssi,
      snr: n.snr,
      lastHeard: n.lastHeard,
      firstHeard: typeof n.firstHeard === 'number' ? n.firstHeard : undefined,
      batteryMv: n.batteryMv,
      uptimeSecs: n.uptimeSecs,
      latitude: n.latitude,
      longitude: n.longitude,
      hasPosition: false,
      isFavorite: n.isFavorite ?? false,
      isIgnored: false,
      isRepeaterNeighbor: typeof n.repeaterNeighborAt === 'number' && n.repeaterNeighborAt > 0,
      // `MeshCoreNode` never carries `isLocal`; only the synthetic local
      // contact row does (#4438). Filled in when a matching contact merges.
      isLocal: false,
      advertSignatureFailed: n.advertSignatureVerified === false,
      nameReuseSuspect: false,
      isMeshCore: true,
    });
  }
  for (const c of contacts) {
    if (!c.publicKey) continue;
    const existing = byKey.get(c.publicKey);
    const hasPos = typeof c.latitude === 'number' && typeof c.longitude === 'number';
    if (existing) {
      existing.name = existing.name === 'Unknown'
        ? (c.advName || c.name || existing.name)
        : existing.name;
      existing.hasName = existing.hasName
        || (typeof (c.advName || c.name) === 'string' && (c.advName || c.name || '').trim() !== '');
      existing.rssi = existing.rssi ?? c.rssi;
      existing.snr = existing.snr ?? c.snr;
      // `0` means "unknown" here too (matches meshcoreLastHeardMs): a DB row
      // with `lastHeard: 0` must still fall through to the contact's
      // lastSeen/lastAdvert, or the age filter wrongly drops it (#4433).
      existing.lastHeard = (existing.lastHeard || null) ?? meshcoreLastHeardMs(c) ?? undefined;
      existing.hasPosition = existing.hasPosition || hasPos;
      existing.advType = existing.advType ?? c.advType;
      existing.isLocal = existing.isLocal || c.isLocal === true;
      existing.pathLen = c.pathLen ?? existing.pathLen;
      existing.batteryMv = existing.batteryMv ?? c.batteryMv;
      if (hasPos) {
        existing.latitude = c.latitude;
        existing.longitude = c.longitude;
      }
    } else {
      byKey.set(c.publicKey, {
        publicKey: c.publicKey,
        name: c.advName || c.name || 'Unknown',
        hasName: (c.advName || c.name || '').trim() !== '',
        advType: c.advType,
        rssi: c.rssi,
        snr: c.snr,
        lastHeard: meshcoreLastHeardMs(c) ?? undefined,
        firstHeard: typeof c.firstHeard === 'number' ? c.firstHeard : undefined,
        batteryMv: c.batteryMv,
        pathLen: c.pathLen,
        latitude: c.latitude,
        longitude: c.longitude,
        hasPosition: hasPos,
        isFavorite: false,
        isIgnored: false,
        isRepeaterNeighbor: false,
        isLocal: c.isLocal === true,
        advertSignatureFailed: c.advertSignatureVerified === false,
        nameReuseSuspect: false,
        isMeshCore: true,
      });
    }
  }
  const rows = Array.from(byKey.values());
  // Same rule as the server's Security findings (one shared implementation).
  const suspects = nameReuseSuspectKeys(findNameReuse(nodes));
  if (suspects.size > 0) {
    for (const r of rows) r.nameReuseSuspect = suspects.has(r.publicKey.toLowerCase());
  }
  if (ignoredKeys && ignoredKeys.size > 0) {
    for (const r of rows) r.isIgnored = ignoredKeys.has(r.publicKey.toLowerCase());
  }
  return rows;
}

/** Sort fields the MeshCore node list offers (adverts lack short name / hardware). */
export const MESHCORE_NODE_SORT_FIELDS: readonly SortField[] = [
  'lastHeard', 'longName', 'id', 'snr', 'battery', 'uptime', 'hops',
];

/** Key adapter for the shared `sortByKey`. */
export function meshcoreNodeSortKey(r: MeshCoreNodeRow, field: SortField): SortKey | undefined {
  switch (field) {
    case 'longName':
      return r.name;
    case 'id':
      // Lowercase hex so mixed-case keys sort the same (#6185).
      return (r.publicKey ?? '').toLowerCase();
    case 'lastHeard':
      return r.lastHeard ?? 0;
    case 'snr':
      return r.snr ?? -999;
    case 'battery':
      return r.batteryMv ?? -1;
    case 'uptime':
      return r.uptimeSecs ?? -1;
    case 'hops':
      return r.pathLen ?? 999;
    default:
      return undefined;
  }
}

/** Subject for the shared `passesNodeFilters`. Only MeshCore-relevant fields are set. */
export function toMeshCoreFilterSubject(r: MeshCoreNodeRow): NodeFilterSubject {
  return {
    hasPosition: r.hasPosition,
    hops: r.pathLen,
    isUnknown: !r.hasName,
    isIgnored: r.isIgnored,
    isFavorite: r.isFavorite,
    role: r.advType ?? 0,
    channel: -1,
    securityFlagged: r.advertSignatureFailed || r.nameReuseSuspect,
  };
}

const iso = (ms: number | undefined): string =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : '';
const num = (v: number | null | undefined): string => (typeof v === 'number' ? String(v) : '');

export const MESHCORE_NODE_EXPORT_COLUMNS: ExportColumn<MeshCoreNodeRow>[] = [
  { key: 'name', label: 'Name', value: (r) => r.name },
  { key: 'publicKey', label: 'Public Key', value: (r) => r.publicKey },
  { key: 'type', label: 'Type', value: (r) => MESHCORE_DEVICE_TYPE_LABELS[r.advType ?? 0] ?? MESHCORE_DEVICE_TYPE_LABELS[0] },
  { key: 'hops', label: 'Hops', value: (r) => num(r.pathLen) },
  { key: 'snr', label: 'SNR', value: (r) => num(r.snr) },
  { key: 'rssi', label: 'RSSI', value: (r) => num(r.rssi) },
  {
    key: 'battery',
    label: 'Battery (V)',
    value: (r) => (typeof r.batteryMv === 'number' && r.batteryMv > 0 ? (r.batteryMv / 1000).toFixed(2) : ''),
  },
  { key: 'uptime', label: 'Uptime (s)', value: (r) => num(r.uptimeSecs) },
  { key: 'latitude', label: 'Latitude', value: (r) => num(r.latitude) },
  { key: 'longitude', label: 'Longitude', value: (r) => num(r.longitude) },
  { key: 'lastHeard', label: 'Last Heard', value: (r) => iso(r.lastHeard) },
  { key: 'firstHeard', label: 'First Heard', value: (r) => iso(r.firstHeard) },
];

/** Role checkboxes for the shared filter popup (advType 0-4). Labels are the
 *  English fallbacks; the view translates them with `meshcoreRoleLabelKey`. */
export const MESHCORE_ROLE_FILTER_OPTIONS: ReadonlyArray<{ value: number; label: string }> =
  [0, 1, 2, 3, 4].map((value) => ({ value, label: MESHCORE_DEVICE_TYPE_LABELS[value] }));
