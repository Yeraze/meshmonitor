/**
 * Network survey (#4726) — "what can this radio actually reach?"
 *
 * **Passive by design.** Every figure below is synthesized from data the app
 * has already collected: `packet_log` for what was heard directly, traceroutes
 * for how far the mesh extends, `nodes` for who exists. The survey generates
 * **no radio traffic at all**.
 *
 * That is a deliberate scoping decision rather than a first cut to be replaced.
 * An active scan costs airtime on a shared medium that every other user of the
 * mesh is also relying on, and the interesting questions here — who do I hear
 * directly, at what signal, how many hops out does the network go — are all
 * answerable from records already on disk. Active probing should only ever be
 * added if passive synthesis is demonstrably insufficient, and then behind
 * explicit user initiation and a TX-disabled guard.
 *
 * **Meshtastic-scoped.** MeshCore has its own discovery model (zero-hop
 * `CMD_SEND_CONTROL_DATA 55` + push `0x8E`) that answers a different question,
 * and the two should not be blended into one number as though they were
 * comparable. A MeshCore source returns an empty survey rather than a
 * misleading one.
 */
import databaseService from '../../services/database.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { logger } from '../../utils/logger.js';

/** A node heard at zero hops — i.e. genuinely within direct radio range. */
export interface DirectNeighbourSummary {
  nodeNum: number;
  name: string | null;
  avgRssi: number | null;
  packetCount: number;
  lastHeard: number;
}

export interface HopBucket {
  /** Hop count; 0 = direct. */
  hops: number;
  nodeCount: number;
}

export interface NetworkSurvey {
  sourceId: string;
  generatedAt: number;
  windowHours: number;
  nodes: {
    total: number;
    /** Heard at all within the window. */
    activeInWindow: number;
    withPosition: number;
  };
  /** Strongest-first, so the most useful relay candidates read first. */
  directNeighbours: DirectNeighbourSummary[];
  /** Reach distribution from answered traceroutes. */
  hopDistribution: HopBucket[];
  /** Largest hop count seen; null when no traceroute has been answered. */
  maxHops: number | null;
}

/** Clamp to a sane window — an unbounded lookback scans the whole packet log. */
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 30;
export const DEFAULT_WINDOW_HOURS = 24;

export function clampWindowHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_HOURS;
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, Math.floor(n)));
}

/**
 * Bucket hop counts into a distribution.
 *
 * Exported for tests: this is the one piece of real logic in the module, and
 * it is worth pinning independently of the database.
 */
export function bucketHops(entries: Array<{ hops: number }>): HopBucket[] {
  const counts = new Map<number, number>();
  for (const e of entries) {
    if (!Number.isFinite(e.hops) || e.hops < 0) continue;
    counts.set(e.hops, (counts.get(e.hops) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([hops, nodeCount]) => ({ hops, nodeCount }));
}

/**
 * Build a survey for one source.
 *
 * Each contributing query is independently fault-tolerant: a survey missing
 * its hop distribution is still worth rendering, whereas failing the whole
 * request because traceroutes are empty would make the view look broken on a
 * young install that simply has not run one yet.
 */
export async function buildNetworkSurvey(
  sourceId: string,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): Promise<NetworkSurvey> {
  const generatedAt = Date.now();
  const cutoff = generatedAt - windowHours * 60 * 60 * 1000;

  const survey: NetworkSurvey = {
    sourceId,
    generatedAt,
    windowHours,
    nodes: { total: 0, activeInWindow: 0, withPosition: 0 },
    directNeighbours: [],
    hopDistribution: [],
    maxHops: null,
  };

  let nodes: Array<Record<string, unknown>> = [];
  try {
    nodes = (await databaseService.nodes.getAllNodes(sourceId)) as unknown as Array<Record<string, unknown>>;
    survey.nodes.total = nodes.length;
    // A stored coordinate is not the same as a usable one. Firmware
    // position-precision re-centres an obscured (0,0) to (offset, offset), and
    // out-of-range junk gets stored too, so counting "has a latitude column"
    // would overstate how much of the mesh is actually locatable. Reuse the
    // canonical predicate rather than a second opinion on what counts.
    survey.nodes.withPosition = nodes.filter((n) => {
      const lat = n.latitude, lon = n.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') return false;
      return !isBogusPosition(lat, lon, n.positionPrecision as number | null | undefined);
    }).length;
    // `lastHeard` is SECONDS on the nodes table while the survey window is in
    // ms — comparing them directly would mark every node inactive.
    survey.nodes.activeInWindow = nodes.filter((n) => {
      const lh = Number(n.lastHeard);
      return Number.isFinite(lh) && lh > 0 && lh * 1000 >= cutoff;
    }).length;
  } catch (e) {
    logger.warn(`[NetworkSurvey] node counts failed for ${sourceId}: ${e instanceof Error ? e.message : e}`);
  }

  const nameFor = new Map<number, string | null>();
  for (const n of nodes) {
    const num = Number(n.nodeNum);
    if (Number.isFinite(num)) {
      // `||`, not `??`: a node stored with an EMPTY longName must fall through
      // to shortName and then to null, so the UI reaches its hex-id fallback.
      // `??` only catches null/undefined, which would render a blank label —
      // a neighbour row with no identifier at all.
      const long = typeof n.longName === 'string' ? n.longName.trim() : '';
      const short = typeof n.shortName === 'string' ? n.shortName.trim() : '';
      nameFor.set(num, long || short || null);
    }
  }

  try {
    const stats = await databaseService.neighbors.getDirectNeighborRssiAsync(windowHours, sourceId);
    survey.directNeighbours = Array.from(stats.values())
      .map((s) => ({
        nodeNum: s.nodeNum,
        name: nameFor.get(s.nodeNum) ?? null,
        avgRssi: Number.isFinite(s.avgRssi) ? Math.round(s.avgRssi * 10) / 10 : null,
        packetCount: Number(s.packetCount),
        lastHeard: Number(s.lastHeard),
      }))
      // Strongest first. RSSI is negative, so a larger value is better; nulls
      // sort last rather than to the top, which `??  0` would do.
      .sort((a, b) => (b.avgRssi ?? -Infinity) - (a.avgRssi ?? -Infinity));
  } catch (e) {
    logger.warn(`[NetworkSurvey] direct neighbours failed for ${sourceId}: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const { entries } = await databaseService.analysis.getHopCounts({ sourceIds: [sourceId] });
    survey.hopDistribution = bucketHops(entries);
    // Derived with Math.max rather than "last bucket": reading the tail is
    // correct only while bucketHops sorts ascending, and that coupling is
    // invisible — a re-sort would break this with no type error.
    survey.maxHops = survey.hopDistribution.length
      ? Math.max(...survey.hopDistribution.map((b) => b.hops))
      : null;
  } catch (e) {
    logger.warn(`[NetworkSurvey] hop distribution failed for ${sourceId}: ${e instanceof Error ? e.message : e}`);
  }

  return survey;
}
