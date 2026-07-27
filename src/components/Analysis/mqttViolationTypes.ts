/**
 * Wire types for the /api/analysis/mqtt-violations/* endpoints (#4114 Phase 1 §2(e)).
 * Mirrors src/server/routes/analysisRoutes.ts:107-130 — keep in step if that changes.
 */
export type ViolationGatewaySortField =
  | 'violationCount'
  | 'lastSeen'
  | 'distinctOriginators'
  | 'gatewayId';
export type ViolationPacketSortField = 'timestamp' | 'fromNode' | 'gatewayId';
export type SortDir = 'asc' | 'desc';

export interface ViolationGatewayRow {
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  /**
   * Display names resolved server-side from `nodes`, scoped to the caller's
   * permitted sources. Null when that nodeNum has no NodeInfo on any of them —
   * the report then falls back to the id, which is all it ever showed before.
   */
  gatewayLongName: string | null;
  gatewayShortName: string | null;
  violationCount: number;
  suspectedCount: number;
  distinctOriginators: number;
  sourceIds: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface ViolationPacketRow {
  id: number | undefined;
  kind: 'confirmed' | 'suspected';
  sourceId: string;
  packetId: number | null;
  fromNode: number | null;
  fromNodeId: string | null;
  /** See ViolationGatewayRow.gatewayLongName — same resolution and fallback. */
  fromLongName: string | null;
  fromShortName: string | null;
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  gatewayLongName: string | null;
  gatewayShortName: string | null;
  channelId: string | null;
  portnum: number | null;
  portnumName: string | null;
  bitfield: number | null;
  topic: string | null;
  rxTime: number | null;
  timestamp: number;
}

/** Common tail present on BOTH responses. */
export interface ViolationResponseMeta {
  total: number;
  limit: number;
  offset: number;
  since: number;
  until: number;
  includeUnknown: boolean;
  /** MEANINGLESS unless includeUnknown === true — see PHASE3 §2(a.2). */
  suspectedAvailable: boolean;
  /** MEANINGLESS unless includeUnknown === true. */
  suspectedWindowMs: number;
  sources: string[];
  /**
   * True only when a pre-merge fetch actually saturated the server's scan
   * cap before sorting (#4330). ALWAYS false on the default
   * (`includeUnknown=false`) path — that path sorts/pages in SQL with an
   * exact COUNT, so every row at every offset is reachable and there is no
   * cap. Never infer "capped" from `total >= scanCap` — a mesh can
   * legitimately have more rows than the cap with none of them dropped.
   */
  capApplied: boolean;
  /** The server's scan-cap ceiling (currently 2000). Use this, not a local
   * constant, whenever a cap value is displayed to the user — it can never
   * drift from what the server actually enforced. */
  scanCap: number;
}

export interface ViolationGatewaysResponse extends ViolationResponseMeta {
  gateways: ViolationGatewayRow[];
}

export interface ViolationPacketsResponse extends ViolationResponseMeta {
  violations: ViolationPacketRow[];
  gateway: string | null;
}

/** The report's window/scope filters. Draft-gated; see PHASE3 §2(e). */
export interface ViolationFilters {
  /** Used only when `from`/`to` are empty. Clamped 1..365 to mirror parseLookbackDays. */
  lookbackDays: number;
  /** 'YYYY-MM-DD' or '' */
  from: string;
  /** 'YYYY-MM-DD' or '' */
  to: string;
  includeUnknown: boolean;
  sort: ViolationGatewaySortField;
  dir: SortDir;
  limit: number;
  offset: number;
}

/** clampPageSize's hard maximum AND the handler's internal pre-merge cap (analysisRoutes.ts:68-72, :613). */
export const API_SCAN_CAP = 2000;

export const DEFAULT_VIOLATION_FILTERS: ViolationFilters = {
  lookbackDays: 7,
  from: '',
  to: '',
  includeUnknown: false,
  sort: 'violationCount',
  dir: 'desc',
  limit: 50,
  offset: 0,
};

/** Clamp to the same 1..365 range as the server's `parseLookbackDays` (analysisRoutes.ts:94-98). */
function clampLookbackDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_VIOLATION_FILTERS.lookbackDays;
  return Math.min(Math.max(Math.round(days), 1), 365);
}

/**
 * Build the query string shared by both `/mqtt-violations/gateways` and
 * `/mqtt-violations/packets` endpoints. Emits `lookbackDays` OR `since`+`until`,
 * never both (PHASE3 §2(e) / §3.1).
 *
 * - No explicit dates (`from`/`to` both non-empty required) → `lookbackDays` only, clamped 1..365.
 * - Both `from` and `to` set → `since`+`until` only, `until` normalized to 23:59:59.999 of `to`.
 * - `includeUnknown` is only ever emitted (as `'true'`) when true; omitted entirely when false.
 * - `sort`/`dir`/`limit`/`offset` default to the filters' own values but can be overridden via
 *   `extra` — used by the drill-down table, which sorts/paginates independently of the summary.
 * - `extra.gateway`, when present, scopes the packets endpoint to one gateway.
 */
export function buildViolationParams(
  f: ViolationFilters,
  extra?: { gateway?: string; sort?: string; dir?: SortDir; limit?: number; offset?: number },
): string {
  const params = new URLSearchParams();

  const from = f.from.trim();
  const to = f.to.trim();
  if (from !== '' && to !== '') {
    const since = new Date(from).getTime();
    const untilDate = new Date(to);
    untilDate.setHours(23, 59, 59, 999);
    params.set('since', String(since));
    params.set('until', String(untilDate.getTime()));
  } else {
    params.set('lookbackDays', String(clampLookbackDays(f.lookbackDays)));
  }

  if (f.includeUnknown) {
    params.set('includeUnknown', 'true');
  }

  params.set('sort', extra?.sort ?? f.sort);
  params.set('dir', extra?.dir ?? f.dir);
  params.set('limit', String(extra?.limit ?? f.limit));
  params.set('offset', String(extra?.offset ?? f.offset));

  if (extra?.gateway) {
    params.set('gateway', extra.gateway);
  }

  return params.toString();
}

/**
 * '!aabbccdd' passthrough, or hex-format a nodeNum, or '' — PHASE3 §2(h). Mirrors the
 * formatting already used server-side at src/server/services/solarAnalysis.ts:576.
 */
export function formatNodeRef(
  id: string | null | undefined,
  num: number | null | undefined,
): string {
  if (id) return id;
  if (num != null) return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
  return '';
}

/** Two-line node cell: a human label on top, the identifier beneath. */
export interface NodeDisplay {
  /** Name when one is known, otherwise the id — never empty. */
  primary: string;
  /** Second line, or null when there is nothing more to add. */
  secondary: string | null;
  /** Everything known about the node, for the cell's `title`. */
  title: string;
}

/**
 * Choose what to show for a node in the violations report.
 *
 * The report used to print the raw `!hex` id as the primary label, which for
 * most rows is the only thing the reader saw. Names now win the top line and
 * the id moves underneath, so a row is still traceable.
 *
 * Falls back to exactly the previous rendering (id on top, nodeNum beneath)
 * when no name is known — an unnamed node is not a regression, it is the old
 * behaviour, so a mesh with no NodeInfo looks unchanged rather than broken.
 */
export function formatNodeDisplay(
  longName: string | null | undefined,
  shortName: string | null | undefined,
  id: string | null | undefined,
  num: number | null | undefined,
): NodeDisplay {
  const ref = formatNodeRef(id, num);
  const name = (longName ?? '').trim() || (shortName ?? '').trim();

  if (!name) {
    return {
      primary: ref || '—',
      secondary: num != null ? String(num) : null,
      title: ref ? `${ref}${num != null ? ` (${num})` : ''}` : '—',
    };
  }

  const titleParts = [name];
  if (ref) titleParts.push(ref);
  if (num != null) titleParts.push(`(${num})`);
  return {
    primary: name,
    // The id is more useful than the decimal nodeNum for cross-referencing, and
    // the nodeNum stays in the tooltip.
    secondary: ref || (num != null ? String(num) : null),
    title: titleParts.join(' '),
  };
}

/**
 * suspectedWindowMs -> { hours } when under 48h, else { days } — PHASE3 §2(f). The caller
 * selects the `.window_hours` / `.window_days` i18n key based on which field is present.
 */
export function formatSuspectedWindow(ms: number): { hours?: number; days?: number } {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) {
    return { hours: Math.round(hours) };
  }
  return { days: Math.round(hours / 24) };
}
