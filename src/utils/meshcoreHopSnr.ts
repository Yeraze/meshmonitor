/**
 * MeshCore per-hop trace SNR (#5722): shared shapes and the per-link summary.
 *
 * A link is DIRECTIONAL: `receiver` heard `sender`. A→B and B→A are two links.
 */

/** The hop-row fields the summary reads (a subset of the repository row). */
export interface HopSnrSample {
  senderPublicKey: string | null;
  senderHash: string | null;
  senderCandidates: number;
  receiverPublicKey: string | null;
  receiverHash: string | null;
  receiverCandidates: number;
  snrQuarterDb: number;
  initiated: boolean;
  timestamp: number;
}

/** One end of a link: a resolved contact, an unresolved hash, or unknown. */
export interface HopSnrEnd {
  publicKey: string | null;
  /** Path hash as hex when the key is not resolved. */
  hash: string | null;
  /** 1 = resolved, 0 = unknown, >1 = that many contacts share the hash. */
  candidates: number;
}

export interface HopSnrLink {
  sender: HopSnrEnd;
  receiver: HopSnrEnd;
  count: number;
  /** dB */
  lastSnr: number;
  avgSnr: number;
  minSnr: number;
  maxSnr: number;
  lastTimestamp: number;
  /** How many samples came from traces MeshMonitor sent. */
  initiatedCount: number;
  /** Oldest first, capped at the request's point cap (default {@link HOP_SNR_POINTS_PER_LINK}). `[timestamp, dB]`. */
  points: Array<[number, number]>;
}

/** Default point cap per link: enough for the summary card's sparkline. */
export const HOP_SNR_POINTS_PER_LINK = 120;
/** Most points per link a caller may ask for (`?points=`). */
export const HOP_SNR_MAX_POINTS_PER_LINK = 2000;
/** What the full-size charts ask for (#5765). */
export const HOP_SNR_CHART_POINTS = 1000;

const endKey = (publicKey: string | null, hash: string | null): string =>
  publicKey ? `k:${publicKey}` : hash ? `h:${hash}` : '?';

/**
 * One end of a link as a query value for the link delete (#5970): the 64-hex
 * public key, `h:<hash>` for an unresolved path hash, or `unknown`. It names
 * the same end `summarizeHopSnrLinks` grouped the graph by.
 */
export function hopSnrEndParam(end: Pick<HopSnrEnd, 'publicKey' | 'hash'>): string {
  if (end.publicKey) return end.publicKey.toLowerCase();
  if (end.hash) return `h:${end.hash.toLowerCase()}`;
  return 'unknown';
}

/** Parse {@link hopSnrEndParam}'s output. Returns null when it is not valid. */
export function parseHopSnrEndParam(value: unknown): { publicKey: string | null; hash: string | null } | null {
  if (typeof value !== 'string') return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return { publicKey: value.toLowerCase(), hash: null };
  // Path hashes are 1, 2 or 4 bytes (see the ingest service).
  const m = /^h:([0-9a-f]{2}|[0-9a-f]{4}|[0-9a-f]{8})$/i.exec(value);
  if (m) return { publicKey: null, hash: m[1].toLowerCase() };
  if (value === 'unknown') return { publicKey: null, hash: null };
  return null;
}

/**
 * Group hop rows into directional links, newest link first. Each link keeps
 * its newest `pointsPerLink` samples; the stats cover every row passed in.
 */
export function summarizeHopSnrLinks(
  rows: readonly HopSnrSample[],
  pointsPerLink: number = HOP_SNR_POINTS_PER_LINK,
): HopSnrLink[] {
  const cap = Math.max(1, Math.min(Math.floor(pointsPerLink) || HOP_SNR_POINTS_PER_LINK, HOP_SNR_MAX_POINTS_PER_LINK));
  const byLink = new Map<string, { sender: HopSnrEnd; receiver: HopSnrEnd; samples: HopSnrSample[] }>();
  for (const r of rows) {
    const key = `${endKey(r.senderPublicKey, r.senderHash)}>${endKey(r.receiverPublicKey, r.receiverHash)}`;
    let entry = byLink.get(key);
    if (!entry) {
      entry = {
        sender: { publicKey: r.senderPublicKey, hash: r.senderPublicKey ? null : r.senderHash, candidates: r.senderCandidates },
        receiver: { publicKey: r.receiverPublicKey, hash: r.receiverPublicKey ? null : r.receiverHash, candidates: r.receiverCandidates },
        samples: [],
      };
      byLink.set(key, entry);
    }
    entry.samples.push(r);
  }
  const links: HopSnrLink[] = [];
  for (const { sender, receiver, samples } of byLink.values()) {
    samples.sort((a, b) => a.timestamp - b.timestamp);
    const db = samples.map((s) => s.snrQuarterDb / 4);
    const last = samples[samples.length - 1];
    links.push({
      sender,
      receiver,
      count: samples.length,
      lastSnr: last.snrQuarterDb / 4,
      avgSnr: Math.round((db.reduce((a, b) => a + b, 0) / db.length) * 100) / 100,
      minSnr: Math.min(...db),
      maxSnr: Math.max(...db),
      lastTimestamp: last.timestamp,
      initiatedCount: samples.filter((s) => s.initiated).length,
      points: samples.slice(-cap).map((s) => [s.timestamp, s.snrQuarterDb / 4]),
    });
  }
  links.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return links;
}

/** Sparkline box, in SVG units. */
export const SPARK_W = 96;
export const SPARK_H = 22;

/** SVG polyline points for a link's samples, scaled to the sparkline box. */
export function sparklinePoints(points: ReadonlyArray<[number, number]>): string {
  if (points.length === 0) return '';
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = points.length > 1 ? SPARK_W / (points.length - 1) : 0;
  return points
    .map((p, i) => `${(points.length > 1 ? i * step : SPARK_W / 2).toFixed(1)},${(SPARK_H - 2 - ((p[1] - min) / span) * (SPARK_H - 4)).toFixed(1)}`)
    .join(' ');
}

/** One chart datum. `snr` is null on a gap marker, which breaks the line. */
export interface HopSnrChartDatum {
  timestamp: number;
  snr: number | null;
}

/** Samples further apart than this are not joined (the telemetry charts' rule). */
export const HOP_SNR_CHART_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * Chart rows for a link's points, oldest first, with a null marker after any
 * sample whose successor is more than `gapMs` later.
 */
export function hopSnrChartData(
  points: ReadonlyArray<[number, number]>,
  gapMs: number = HOP_SNR_CHART_GAP_MS,
): HopSnrChartDatum[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const out: HopSnrChartDatum[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push({ timestamp: sorted[i][0], snr: sorted[i][1] });
    if (i < sorted.length - 1 && sorted[i + 1][0] - sorted[i][0] > gapMs) {
      out.push({ timestamp: sorted[i][0] + 1, snr: null });
    }
  }
  return out;
}

/** The translate function shape the name helper needs. */
export type HopSnrTranslate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

export interface HopSnrNameContext {
  /** The contact whose panel is open, as lowercase hex. */
  contactKey: string;
  /** This source's own node. */
  localPublicKey?: string | null;
  contacts?: ReadonlyArray<{ publicKey: string; name?: string | null; advName?: string | null }>;
  t: HopSnrTranslate;
}

/** Display name for one end of a link. Shared by the card and the charts. */
export function hopSnrEndName(end: HopSnrEnd, ctx: HopSnrNameContext): string {
  const { t } = ctx;
  if (end.publicKey) {
    if (end.publicKey === ctx.contactKey) return t('meshcore.trace_snr.this_contact', 'this contact');
    if (ctx.localPublicKey && end.publicKey === ctx.localPublicKey.toLowerCase()) return t('meshcore.trace_snr.this_node', 'This node');
    const c = ctx.contacts?.find((x) => x.publicKey?.toLowerCase() === end.publicKey);
    return c?.name || c?.advName || `${end.publicKey.slice(0, 8)}…`;
  }
  if (end.hash) {
    return end.candidates > 1
      ? t('meshcore.trace_snr.ambiguous', '{{hash}} ({{count}} contacts share it)', { hash: end.hash, count: end.candidates })
      : t('meshcore.trace_snr.unknown_hash', '{{hash}} (unknown)', { hash: end.hash });
  }
  return t('meshcore.trace_snr.unknown_origin', 'unknown sender');
}
