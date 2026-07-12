/**
 * Shared traceroute decomposition utilities.
 *
 * Pure, React-free, leaflet-free — safe to import from anywhere (including
 * node-env tests) without pulling in `window`/`leaflet`. This is the SINGLE
 * home for four previously-duplicated behaviors:
 *   - #1862 — snapshot route positions (render historical traceroutes where
 *     nodes were at capture time, not where they are now).
 *   - #2051 — the empty-routeBack guard (don't draw a fictitious direct
 *     return line when the return path hasn't been recorded yet).
 *   - #2931 — the firmware unknown-SNR sentinel (MQTT-bridged / relay-role /
 *     decrypt-failure hops report a sentinel value, not a real SNR reading).
 *   - reserved/broadcast node-number filtering (route arrays can contain
 *     firmware placeholder values for a relay-role hop that never resolved
 *     its identity; segments touching them join across, not gap).
 *
 * `src/utils/mapHelpers.tsx` re-exports `UNKNOWN_SNR_SENTINEL`/`isUnknownSnr`
 * from here for backward compatibility with existing importers. This file
 * stays leaflet-free on purpose so `useTracerouteAnalysis.ts` and its tests
 * don't have to pull in `mapHelpers.tsx`'s leaflet import just for the
 * sentinel — don't add a leaflet/react-leaflet import here.
 */

// `nullIsland` is pure (no leaflet) — safe to import without breaking the
// leaflet-free guarantee above.
import { isNullIsland } from './nullIsland.js';

// ---------------------------------------------------------------------------
// #2931 — unknown-hop SNR sentinel (canonical home, re-exported by mapHelpers)
// ---------------------------------------------------------------------------

/**
 * Scaled SNR sentinel for unknown hops.
 * Raw Meshtastic value is INT8_MIN (-128), divided by 4 = -32.
 * Firmware writes this in TraceRouteModule::insertUnknownHops when a hop's
 * SNR can't be filled in: MQTT-bridged leg, decrypt failure, relay-role node,
 * or pre-snr-array firmware. It is NOT specifically an MQTT marker — the
 * firmware uses it as a generic "unknown SNR" sentinel.
 */
export const UNKNOWN_SNR_SENTINEL = -32;

/** Returns true if the scaled SNR value is the firmware unknown-hop sentinel */
export const isUnknownSnr = (snr: number | undefined): boolean =>
  snr === UNKNOWN_SNR_SENTINEL;

/**
 * Average SNR across samples, ignoring the unknown-hop sentinel (#2931).
 * Returns `null` when there are no samples, or every sample was the
 * sentinel (no real RF data to average).
 */
export function averageNonSentinelSnr(samples: Array<{ snr: number }> | undefined): number | null {
  if (!samples || samples.length === 0) return null;
  const rfSnrs = samples.filter((s) => !isUnknownSnr(s.snr)).map((s) => s.snr);
  if (rfSnrs.length === 0) return null;
  return rfSnrs.reduce((sum, v) => sum + v, 0) / rfSnrs.length;
}

// ---------------------------------------------------------------------------
// Reserved/broadcast node-number filtering
// ---------------------------------------------------------------------------

const BROADCAST_ADDR = 4294967295;

/**
 * True for a real, renderable node number — false for firmware reserved or
 * placeholder values that can appear inside a route/routeBack hop array:
 *   - `<= 3` — reserved
 *   - `255` (0xff) — reserved
 *   - `65535` (0xffff) — invalid placeholder
 *   - `4294967295` (0xffffffff) — broadcast address
 * Single home for this predicate — hop-array filtering lives inside
 * `decomposeTraceroute`/`buildLegSegments` below.
 */
export function isValidRouteNode(nodeNum: number): boolean {
  if (nodeNum <= 3) return false;
  if (nodeNum === 255) return false;
  if (nodeNum === 65535) return false;
  if (nodeNum === BROADCAST_ADDR) return false;
  return true;
}

// ---------------------------------------------------------------------------
// #1862 — snapshot route positions
// ---------------------------------------------------------------------------

/**
 * Parse the `routePositions` JSON snapshot stored on a traceroute row.
 * Shape: `{ [nodeNum]: { lat, lng, alt? } }`.
 *
 * Presence is checked with `typeof === 'number'`, not a truthy check — a
 * node sitting exactly on the equator or prime meridian (`lat===0` or
 * `lng===0`) must still resolve to its stored snapshot position rather than
 * silently falling through to the live position.
 */
export function parseSnapshotRoutePositions(
  routePositions: string | null | undefined,
): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>();
  if (!routePositions) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(routePositions);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object') return result;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const nodeNum = Number(key);
    if (!Number.isFinite(nodeNum)) continue;
    const entry = value as { lat?: unknown; lng?: unknown } | null;
    if (entry && typeof entry.lat === 'number' && typeof entry.lng === 'number') {
      // A snapshot captured while the node was at Null Island (a garbage GPS
      // default, e.g. the 2^15 value 0.0032768) must NOT anchor a route
      // segment there — skip it so resolveSegmentPosition falls through to the
      // live position (#02ecd5e0 "Jupiter Dad" routes shooting to 0,0).
      if (isNullIsland(entry.lat, entry.lng)) continue;
      result.set(nodeNum, [entry.lat, entry.lng]);
    }
  }
  return result;
}

/**
 * Resolve a hop's render position, preferring the historical snapshot
 * (#1862) over the live position. Both maps are expected to already be
 * normalized to `[lat, lng]` tuples — normalizing a consumer's own live-node
 * shape (digest array, raw node map with `latitudeI/longitudeI` vs
 * `latitude/longitude`, etc.) is the caller's job, not this function's.
 */
export function resolveSegmentPosition(
  nodeNum: number,
  snapshot: Map<number, [number, number]>,
  liveNodes: Map<number, [number, number]>,
): [number, number] | null {
  return snapshot.get(nodeNum) ?? liveNodes.get(nodeNum) ?? null;
}

/**
 * Build a `nodeNum -> [lat, lng]` map from a consumer's live node list.
 * `extract` returns the node number and raw (possibly missing) coordinates
 * for one item, or `null` to skip it entirely.
 *
 * Validity rule: coordinates must both be numbers AND must not be at Null
 * Island — a coordinate within {@link isNullIsland}'s radius of `(0, 0)` is an
 * uninitialized/garbage GPS default and is dropped, while a single axis at
 * exactly 0 (equator or prime meridian, with the other axis far from 0) is a
 * legitimate position and is kept. This uses the shared Null-Island radius
 * (not an exact `(0,0)` check) so garbage defaults like the 2^15 value
 * 0.0032768 don't anchor neighbor/route line endpoints at (0, 0).
 */
export function buildLiveNodePositionMap<T>(
  items: Iterable<T>,
  extract: (item: T) => { nodeNum: number; lat: number | null | undefined; lng: number | null | undefined } | null,
): Map<number, [number, number]> {
  const map = new Map<number, [number, number]>();
  for (const item of items) {
    const entry = extract(item);
    if (!entry) continue;
    const { nodeNum, lat, lng } = entry;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (isNullIsland(lat, lng)) continue;
    map.set(nodeNum, [lat, lng]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// #2051 — empty-routeBack guard
// ---------------------------------------------------------------------------

/**
 * True only when a return path genuinely exists — i.e. either `routeBack`
 * has intermediate hops, or `snrBack` carries actual data. When
 * MeshMonitor is connected to the traceroute's target node, it can observe
 * its own outgoing RESPONSE before relay nodes have populated `routeBack`;
 * naively building `[to, ...routeBack, from]` in that window draws a
 * fictitious direct return line. (Issues #1140, #3622, #2051.)
 *
 * `snrBack` accepts either the raw JSON string as stored on the traceroute
 * row (checked against `''`/`'null'`/`'[]'`) or an already-parsed array
 * (checked by length) — the two pre-existing per-consumer implementations
 * this replaces (Widget: string form; useTracerouteAnalysis: parsed-array
 * form) used one or the other, so this accepts both. Widened to also accept
 * `undefined` (not just `null`) since traceroute rows commonly type
 * `snrBack` as optional.
 */
export function hasReturnPath(
  routeBack: number[],
  snrBack: string | number[] | null | undefined,
): boolean {
  if (routeBack.length > 0) return true;
  if (snrBack == null) return false;
  if (typeof snrBack === 'string') {
    return snrBack !== '' && snrBack !== 'null' && snrBack !== '[]';
  }
  return snrBack.length > 0;
}

// ---------------------------------------------------------------------------
// Per-traceroute decomposition
// ---------------------------------------------------------------------------

export interface TracerouteRenderSegment {
  key: string;
  from: [number, number];              // lat,lng — already snapshot-resolved
  to: [number, number];
  /** Hop node numbers this segment connects, in traversal order (from -> to). */
  fromNodeNum: number;
  toNodeNum: number;
  leg: 'forward' | 'return' | 'neutral';
  direction?: 'inbound' | 'outbound' | 'neutral'; // MapAnalysis relative-to-selection
  avgSnr: number | null;               // /4-scaled dB; null = no data
  isMqtt: boolean;                      // per-hop sentinel (#2931), NOT node.viaMqtt
  usageCount?: number;                  // weightByUsage
  occurrences?: number;                 // weightByOccurrence
  timestamp?: number;                   // temporal fade
  snrSamples?: { snr: number; timestamp?: number }[]; // popup/chart + array color/opacity
}

/**
 * Minimal traceroute row shape `decomposeTraceroute` needs. A structural
 * subset of `TracerouteDigest` (useTraceroutePaths.tsx) so callers can pass
 * their existing traceroute records without an adapter.
 */
export interface TracerouteDecomposeInput {
  fromNodeNum: number;
  toNodeNum: number;
  route?: string | null;
  routeBack?: string | null;
  snrTowards?: string | null;
  snrBack?: string | null;
  timestamp?: number;
  createdAt?: number;
}

export interface DecomposeTracerouteOptions {
  /** Resolve a hop's node number to a render position, or null if unknown
   *  (the segment touching that hop is skipped, matching all three
   *  pre-existing renderers' "only push a segment when both endpoints
   *  resolve" behavior). Typically `(n) => resolveSegmentPosition(n, snapshot, liveNodes)`. */
  resolvePosition: (nodeNum: number) => [number, number] | null;
}

/** `JSON.parse` a route/hop/SNR array, tolerating null/'null'/'' (all -> []).
 *  Deliberately does NOT filter node validity — this parses both node-number
 *  arrays (route/routeBack) and SNR-sample arrays (snrTowards/snrBack), and
 *  filtering only applies to the former. Node filtering happens in
 *  `buildLegSegments`, where it can stay index-aligned with the paired SNR
 *  sample instead of shifting it. */
function parseHopArray(json: string | null | undefined): number[] {
  if (!json || json === 'null' || json === '') return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)) : [];
  } catch {
    return [];
  }
}

/** True when `route` carries actual (possibly empty-array) route data, as
 *  opposed to being entirely absent/failed. */
function hasRouteData(route: string | null | undefined): boolean {
  return route != null && route !== 'null' && route !== '';
}

/** One raw hop paired with the SNR observed arriving at it, before any
 *  node-validity filtering — keeping the pairing lets a hop be dropped
 *  without shifting its neighbors' SNR samples out of alignment. */
interface HopEntry {
  nodeNum: number;
  /** Already-scaled by caller? No — raw firmware int (dB x4); undefined for
   *  the leg's start (nothing "arrives" there) or a missing array entry. */
  snr: number | undefined;
}

function buildLegSegments(
  leg: 'forward' | 'return',
  startNum: number,
  intermediateHops: number[],
  endNum: number,
  snrRaw: number[],
  timestamp: number | undefined,
  resolvePosition: (nodeNum: number) => [number, number] | null,
): TracerouteRenderSegment[] {
  // Pair every raw hop (including the end endpoint) with its own arrival SNR
  // by index BEFORE filtering, then drop invalid/reserved intermediate hops.
  // Endpoints (index 0 and the last index) are never filtered — they're real
  // device node numbers, not raw route placeholders. This preserves index
  // alignment between a hop and its SNR sample even when hops in between are
  // dropped: adjacent segments join across the removed hop, carrying the
  // correct arrival SNR for the surviving side.
  const hops: HopEntry[] = [
    { nodeNum: startNum, snr: undefined },
    ...intermediateHops.map((nodeNum, idx): HopEntry => ({
      nodeNum,
      snr: idx < snrRaw.length ? snrRaw[idx] : undefined,
    })),
    {
      nodeNum: endNum,
      snr: intermediateHops.length < snrRaw.length ? snrRaw[intermediateHops.length] : undefined,
    },
  ];
  const filtered = hops.filter(
    (h, idx) => idx === 0 || idx === hops.length - 1 || isValidRouteNode(h.nodeNum),
  );

  const segments: TracerouteRenderSegment[] = [];
  for (let i = 0; i < filtered.length - 1; i++) {
    const fromNum = filtered[i].nodeNum;
    const toNum = filtered[i + 1].nodeNum;
    const fromPos = resolvePosition(fromNum);
    const toPos = resolvePosition(toNum);
    if (!fromPos || !toPos) continue;

    // SNR arriving at the segment's `to` end is what firmware recorded for
    // this hop (see HopEntry above).
    const rawSnr = filtered[i + 1].snr;
    const scaledSnr = rawSnr === undefined ? undefined : rawSnr / 4;
    const isMqtt = scaledSnr !== undefined && isUnknownSnr(scaledSnr);
    const avgSnr = scaledSnr === undefined || isMqtt ? null : scaledSnr;

    segments.push({
      key: `${leg}:${fromNum}-${toNum}`,
      from: fromPos,
      to: toPos,
      fromNodeNum: fromNum,
      toNodeNum: toNum,
      leg,
      avgSnr,
      isMqtt,
      timestamp,
    });
  }
  return segments;
}

/**
 * Decompose one traceroute record into per-hop forward + return render
 * segments. Consumers (NodesTab base/selected, Widget, Dashboard) call this
 * once per traceroute then apply their own cross-traceroute aggregation
 * (dedup, usage counting, zoom-adaptive filtering — data-side) on top; this
 * function does NOT aggregate across multiple traceroute records.
 *
 * - Forward leg: `[fromNodeNum, ...route, toNodeNum]` with `snrTowards`,
 *   matching the existing convention shared by useTraceroutePaths/Widget/
 *   DashboardMap (NOT the `useTracerouteAnalysis` requester/responder
 *   convention, which is a separate, untouched data hook). Gated solely by
 *   `hasRouteData(traceroute.route)`.
 * - Return leg: only emitted when `hasReturnPath` is true (#2051); sequence
 *   `[toNodeNum, ...routeBack, fromNodeNum]` with `snrBack`. Gated
 *   independently of the forward leg — a traceroute with no forward `route`
 *   but a populated `routeBack`/`snrBack` still yields return segments (and
 *   vice versa); the two legs are not coupled to a single whole-traceroute
 *   guard.
 *
 * `key` embeds the leg + hop node numbers (`"forward:123-456"`).
 */
export function decomposeTraceroute(
  traceroute: TracerouteDecomposeInput,
  opts: DecomposeTracerouteOptions,
): TracerouteRenderSegment[] {
  const timestamp = traceroute.timestamp ?? traceroute.createdAt;
  const segments: TracerouteRenderSegment[] = [];

  if (hasRouteData(traceroute.route)) {
    const route = parseHopArray(traceroute.route);
    const snrTowards = parseHopArray(traceroute.snrTowards);
    segments.push(
      ...buildLegSegments(
        'forward',
        traceroute.fromNodeNum,
        route,
        traceroute.toNodeNum,
        snrTowards,
        timestamp,
        opts.resolvePosition,
      ),
    );
  }

  const routeBack = parseHopArray(traceroute.routeBack);
  if (hasReturnPath(routeBack, traceroute.snrBack)) {
    const snrBack = parseHopArray(traceroute.snrBack);
    segments.push(
      ...buildLegSegments(
        'return',
        traceroute.toNodeNum,
        routeBack,
        traceroute.fromNodeNum,
        snrBack,
        timestamp,
        opts.resolvePosition,
      ),
    );
  }

  return segments;
}
