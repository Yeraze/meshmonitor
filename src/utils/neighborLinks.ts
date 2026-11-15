/**
 * Pure, leaflet-free helpers shared by every neighbor-link renderer (Map
 * Consolidation epic #4047, Phase 7, WP1). Extracted from the near-identical
 * `snrToOpacity`/unordered-pair-dedup logic duplicated across DashboardMap,
 * MapAnalysis's `NeighborLinksLayer`/`MeshCoreNeighborLinksLayer`, and
 * MeshCoreMap, plus the bearing math NodesTab used for its unidirectional
 * arrow decorations (NodesTab.tsx, neighbor-link block). Consumed by the
 * descriptor-based `map/layers/NeighborLinksLayer.tsx` and by each
 * consumer's adapter — kept leaflet-free so adapters (and this file's own
 * tests) don't need to pull in `leaflet`/`react-leaflet`.
 */

/**
 * SNR → line opacity, the `null → 0.4, clamp((snr + 10) / 20, 0.2, 1)` form
 * used verbatim by DashboardMap, MapAnalysis's `NeighborLinksLayer` /
 * `MeshCoreNeighborLinksLayer`, and MeshCoreMap. NodesTab uses a different
 * 4-tier SNR → weight/opacity table instead — that stays in the NodesTab
 * adapter's own `pathOptions` computation; do NOT force it onto this helper.
 */
export function snrToNeighborOpacity(snr: number | null): number {
  if (snr === null) return 0.4;
  return Math.max(0.2, Math.min(1, (snr + 10) / 20));
}

/**
 * Collapse an array of edges that may report both `A→B` and `B→A` for the
 * same unordered pair down to one entry each, keeping the first occurrence.
 * The canonical `a < b ? "a~b" : "b~a"` pairing used by DashboardMap's
 * meshtastic + MeshCore neighbor-link dedup and MapAnalysis. `keyA`/`keyB`
 * extract each endpoint's identity (nodeNum, publicKey, …) — both must
 * return the same key type for a given `items` array so the `<` comparison
 * is meaningful (numeric for nodeNum, lexicographic for string keys).
 */
export function dedupByUnorderedPair<T, K extends string | number>(
  items: T[],
  keyA: (item: T) => K,
  keyB: (item: T) => K,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const a = keyA(item);
    const b = keyB(item);
    const pairKey = a < b ? `${a}~${b}` : `${b}~${a}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    out.push(item);
  }
  return out;
}

/**
 * Default fractions along a neighbor-link line at which direction arrows are
 * drawn (NodesTab's unidirectional-arrow decoration: 25%/50%/75% along the
 * line for visibility at any zoom). Consumers may override via
 * `NeighborLinkDescriptor.arrows.fractions`.
 */
export const neighborArrowFractions: number[] = [0.25, 0.5, 0.75];

/**
 * Bearing (degrees, 0 = "up"/north in the equirectangular sense
 * `createArrowIcon` expects — NOT a true great-circle bearing) from `from`
 * to `to`, longitude-delta scaled by `cos(midpoint latitude)` to correct for
 * latitude. Extracted verbatim from NodesTab's neighbor-link arrow bearing
 * calculation (`Math.atan2((toLng - fromLng) * cos(latMid), toLat - fromLat)`
 * in degrees). The shared `NeighborLinksLayer` calls this with `from` =
 * the link's second position and `to` = the link's first position, so an
 * arrow points from the second endpoint toward the first — matching
 * NodesTab's "arrow points FROM neighbor TO node" convention where
 * `positions = [[nodeLat, nodeLng], [neighborLat, neighborLng]]`.
 */
export function bearingBetween(from: [number, number], to: [number, number]): number {
  const latMid = (from[0] + to[0]) / 2;
  return (
    Math.atan2((to[1] - from[1]) * Math.cos((latMid * Math.PI) / 180), to[0] - from[0]) *
    (180 / Math.PI)
  );
}

/**
 * One directed MeshCore neighbour-table record: `publicKey` (the reporting
 * repeater) lists `neighborPublicKey` with `snr`, last heard `lastHeardSecs`
 * before the fetch at `timestamp` (ms).
 */
export interface DirectedNeighborRecord {
  publicKey: string;
  neighborPublicKey: string;
  snr: number | null;
  lastHeardSecs?: number | null;
  timestamp?: number | null;
}

/**
 * Wall-clock ms at which the reporter last heard its neighbour
 * (`timestamp - lastHeardSecs * 1000`), or `null` when either part is missing.
 */
export function neighborHeardAtMs(r: DirectedNeighborRecord): number | null {
  const ts = r.timestamp == null ? NaN : Number(r.timestamp);
  const secs = r.lastHeardSecs == null ? NaN : Number(r.lastHeardSecs);
  if (!Number.isFinite(ts) || !Number.isFinite(secs)) return null;
  return ts - secs * 1000;
}

/** True when `a` is a fresher observation than `b` (known age beats unknown). */
function isFresher(a: DirectedNeighborRecord, b: DirectedNeighborRecord): boolean {
  const ha = neighborHeardAtMs(a);
  const hb = neighborHeardAtMs(b);
  if (ha !== null && hb !== null && ha !== hb) return ha > hb;
  if (ha !== null && hb === null) return true;
  if (ha === null && hb !== null) return false;
  const ta = Number(a.timestamp ?? 0);
  const tb = Number(b.timestamp ?? 0);
  if (ta !== tb) return ta > tb;
  // Full tie: order by direction so the pick never depends on row order.
  return a.publicKey < b.publicKey;
}

/**
 * Both directions of one unordered MeshCore neighbour pair (#6403).
 * `primary` is the freshest observation (smallest effective age), `reverse`
 * the opposite direction when the other repeater also reported the link.
 */
export interface NeighborPair<T extends DirectedNeighborRecord> {
  pairKey: string;
  primary: T;
  reverse: T | null;
}

/**
 * Group directed MeshCore neighbour records by unordered pair. Unlike
 * `dedupByUnorderedPair` (first row wins), the result is independent of input
 * order: per direction the freshest record is kept, the fresher direction
 * becomes `primary`, and the other one `reverse` — so a stale 12-hour-old
 * entry no longer replaces the current one on every refresh.
 */
export function pairNeighborRecords<T extends DirectedNeighborRecord>(items: T[]): NeighborPair<T>[] {
  const byDirection = new Map<string, T>();
  for (const item of items) {
    const key = `${item.publicKey}>${item.neighborPublicKey}`;
    const cur = byDirection.get(key);
    if (!cur || isFresher(item, cur)) byDirection.set(key, item);
  }
  const byPair = new Map<string, T[]>();
  for (const item of byDirection.values()) {
    const a = item.publicKey;
    const b = item.neighborPublicKey;
    const pairKey = a < b ? `${a}~${b}` : `${b}~${a}`;
    const list = byPair.get(pairKey);
    if (list) list.push(item);
    else byPair.set(pairKey, [item]);
  }
  const out: NeighborPair<T>[] = [];
  for (const [pairKey, list] of byPair) {
    if (list.length === 1) {
      out.push({ pairKey, primary: list[0], reverse: null });
      continue;
    }
    const [x, y] = list;
    const primary = isFresher(x, y) ? x : y;
    out.push({ pairKey, primary, reverse: primary === x ? y : x });
  }
  return out;
}

/** Compact age, e.g. `45 s`, `4 min`, `12 h`, `3 d`. */
export function formatNeighborAge(secs: number | null | undefined): string | null {
  if (secs == null || !Number.isFinite(Number(secs))) return null;
  const s = Math.max(0, Math.round(Number(secs)));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
