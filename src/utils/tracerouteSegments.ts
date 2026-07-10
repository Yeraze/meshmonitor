/**
 * Shared traceroute decomposition utilities (#4047 P3 WP2).
 *
 * Pure, React-free, leaflet-free — safe to import from anywhere (including
 * node-env tests) without pulling in `window`/`leaflet`. This is the SINGLE
 * home for three previously-duplicated behaviors:
 *   - #1862 — snapshot route positions (render historical traceroutes where
 *     nodes were at capture time, not where they are now).
 *   - #2051 — the empty-routeBack guard (don't draw a fictitious direct
 *     return line when the return path hasn't been recorded yet).
 *   - #2931 — the firmware unknown-SNR sentinel (MQTT-bridged / relay-role /
 *     decrypt-failure hops report a sentinel value, not a real SNR reading).
 *
 * `src/utils/mapHelpers.tsx` re-exports `UNKNOWN_SNR_SENTINEL`/`isUnknownSnr`
 * from here for backward compatibility with existing importers — this file
 * is the canonical definition site (moved out of mapHelpers.tsx in WP2 so
 * that `useTracerouteAnalysis.ts` and its tests don't have to pull in
 * mapHelpers.tsx's leaflet import just for the sentinel).
 */

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

// ---------------------------------------------------------------------------
// #1862 — snapshot route positions
// ---------------------------------------------------------------------------

/**
 * Parse the `routePositions` JSON snapshot stored on a traceroute row.
 * Shape: `{ [nodeNum]: { lat, lng, alt? } }`.
 *
 * **Three-way diff (#4047 P3 WP2, serena-verified 2026-07-10)** against the
 * pre-existing per-consumer copies this replaces:
 *   - `useTraceroutePaths.tsx` `parseRoutePositions`/`getNodePositionWithSnapshot`
 *   - `TracerouteWidget.tsx` inline snapshot parse + `getNodePosition`
 *   - `DashboardMap.tsx` `parseRoutePositions` + inline `lookup`
 *
 * Findings:
 *   1. **Stored field names are identical everywhere** — `{lat, lng, alt?}`.
 *      No field-name divergence in the snapshot JSON itself.
 *   2. **Presence-check divergence (behavior difference, fixed here):**
 *      useTraceroutePaths and the Widget test snapshot presence with
 *      `snapshot?.lat && snapshot?.lng` (truthy check) — a node sitting
 *      exactly on the equator or prime meridian (`lat===0` or `lng===0`)
 *      would silently fail that check and fall through to the live position
 *      instead of its stored snapshot. DashboardMap uses
 *      `typeof snap.lat === 'number' && typeof snap.lng === 'number'`, which
 *      handles `0` correctly. This function adopts DashboardMap's (correct)
 *      `typeof`-based check — a deliberate latent-bug fix, not a silent
 *      regression, but callers should be aware the two truthy-check
 *      consumers (NodesTab base+selected via useTraceroutePaths, Widget)
 *      will very slightly change behavior for nodes at exactly lat/lng 0
 *      once WP3/WP4 adopt this function.
 *   3. **Live-position fallback source differs per consumer** (out of scope
 *      for this function — it only resolves the snapshot half). Each
 *      consumer's live-node shape differs (a pre-built digest array, a raw
 *      `Map`/node lookup supporting both `latitudeI/longitudeI` integer and
 *      `latitude/longitude` float forms, or an already-normalized position
 *      map) so `resolveSegmentPosition` below deliberately takes an
 *      already-normalized `Map<number,[number,number]>` for the live side —
 *      callers pre-normalize their own node source into that shape.
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

/** `JSON.parse` a route/hop array, tolerating null/'null'/'' (all -> []). */
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

function buildLegSegments(
  leg: 'forward' | 'return',
  sequence: number[],
  snrRaw: number[],
  timestamp: number | undefined,
  resolvePosition: (nodeNum: number) => [number, number] | null,
): TracerouteRenderSegment[] {
  const segments: TracerouteRenderSegment[] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const fromNum = sequence[i];
    const toNum = sequence[i + 1];
    const fromPos = resolvePosition(fromNum);
    const toPos = resolvePosition(toNum);
    if (!fromPos || !toPos) continue;

    // SNR at index i is measured at the receiver of hop i (fullPath[i+1]).
    const rawSnr = i < snrRaw.length ? snrRaw[i] : undefined;
    const scaledSnr = rawSnr === undefined ? undefined : rawSnr / 4;
    const isMqtt = scaledSnr !== undefined && isUnknownSnr(scaledSnr);
    const avgSnr = scaledSnr === undefined || isMqtt ? null : scaledSnr;

    segments.push({
      key: `${leg}:${fromNum}-${toNum}`,
      from: fromPos,
      to: toPos,
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
 * (dedup, usage counting, zoom-adaptive filtering — data-side, per §4 of the
 * P3 spec) on top; this function does NOT aggregate across multiple
 * traceroute records.
 *
 * - Forward leg: `[fromNodeNum, ...route, toNodeNum]` with `snrTowards`,
 *   matching the existing convention shared by useTraceroutePaths/Widget/
 *   DashboardMap (NOT the `useTracerouteAnalysis` requester/responder
 *   convention, which is a separate, untouched data hook — see #4047 P3 §3.1
 *   migration nuance).
 * - Return leg: only emitted when `hasReturnPath` is true (#2051); sequence
 *   `[toNodeNum, ...routeBack, fromNodeNum]` with `snrBack`.
 * - A whole-traceroute guard mirrors the pre-existing "skip if route is
 *   entirely absent" behavior (`!tr.route`/`'null'`/`''`) — but, unlike
 *   useTraceroutePaths' current top-level guard, does NOT also require
 *   `routeBack` to be a valid non-empty string; the return leg is gated
 *   solely by `hasReturnPath`. This is intentional: it's the correct,
 *   unified fix for #2051 (the old NodesTab renderer had no `hasReturnPath`
 *   guard at all and could draw a fictitious direct return line; the old
 *   "skip whole traceroute if routeBack missing" guard was a blunt
 *   workaround for a related but distinct case).
 *
 * `key` embeds the leg + hop node numbers (`"forward:123-456"`) since
 * `TracerouteRenderSegment` intentionally has no separate node-num fields
 * (per spec §3.1) — consumers that need to build their own cross-traceroute
 * node-pair aggregation key can parse it back out of `key`.
 */
export function decomposeTraceroute(
  traceroute: TracerouteDecomposeInput,
  opts: DecomposeTracerouteOptions,
): TracerouteRenderSegment[] {
  if (!hasRouteData(traceroute.route)) return [];

  const route = parseHopArray(traceroute.route);
  const routeBack = parseHopArray(traceroute.routeBack);
  const snrTowards = parseHopArray(traceroute.snrTowards);
  const snrBack = parseHopArray(traceroute.snrBack);
  const timestamp = traceroute.timestamp ?? traceroute.createdAt;

  const segments: TracerouteRenderSegment[] = [];

  const forwardSequence = [traceroute.fromNodeNum, ...route, traceroute.toNodeNum];
  segments.push(
    ...buildLegSegments('forward', forwardSequence, snrTowards, timestamp, opts.resolvePosition),
  );

  if (hasReturnPath(routeBack, traceroute.snrBack)) {
    const backSequence = [traceroute.toNodeNum, ...routeBack, traceroute.fromNodeNum];
    segments.push(
      ...buildLegSegments('return', backSequence, snrBack, timestamp, opts.resolvePosition),
    );
  }

  return segments;
}
