/**
 * Type-specific table columns for the By-issue view (#4964 report
 * reorganization, WP3, spec §8). Pure — no React rendering side effects, no
 * network, no DOM. `columnsForType` is called once per section to build the
 * table header/cell definitions; the shell (WP4's `IssueTable`) adds the
 * shared expand/state/subject/sources/severity/lastDetected/actions columns
 * before and after these.
 *
 * `evidence` is parsed JSON from the database and is additionally
 * per-caller-redacted (`redactEvidence` replaces `*Name` fields with `null`
 * for unpermitted nodes). No column here may throw on `evidence === {}` or on
 * a redacted-null name — every accessor below is defensive (spec §8.3).
 */
import type { ReactNode } from 'react';
import {
  STRUCTURED_EVIDENCE_KEYS,
  formatDurationMs,
  formatEvidenceKey,
  hexNodeId,
  isEvidenceNodeRefArray,
  type MeshIssueRow,
} from '../meshIssueTypes';
import { asNodeRef, formatFieldValue } from './evidenceRenderers';

export type ColumnAlign = 'left' | 'right';

export interface ColumnCtx {
  sourceNames: Record<string, string>;
}

export interface IssueColumn {
  /** Stable id; the persisted sort key. Never renamed once shipped. */
  key: string;
  label: string;
  /** Sort value. `null` sorts LAST in BOTH directions (see grouping.ts's comparator). */
  sortValue: (row: MeshIssueRow) => number | string | null;
  /** Every implementation in this module returns a plain string (spec §8.1
   *  types this as `ReactNode` for a future non-text cell; nothing here needs
   *  one yet). */
  render: (row: MeshIssueRow, ctx: ColumnCtx) => ReactNode;
  align?: ColumnAlign;
  numeric?: boolean;
  /** Exactly one column per type carries this: the section's default sort. */
  primary?: boolean;
  /** Default direction when this column is first selected. Default 'desc'. */
  defaultDir?: 'asc' | 'desc';
  /** Allow the cell to wrap long text and cap its width. The base
   * `.reports-table td` rule pins `white-space: nowrap`, which forces a
   * cell holding a long free-text field (e.g. C1 `details`, or a
   * comma-separated node/source list) to be as wide as its content and
   * pushes the whole table into horizontal scroll. Set `wrap: true` on
   * those columns to enable word-break and a max-width; short numeric /
   * badge columns stay on the nowrap default. */
  wrap?: boolean;
}

// ── Defensive evidence accessors (spec §8.3) ────────────────────────────────

export function num(row: MeshIssueRow, key: string): number | null {
  const v = row.evidence[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function str(row: MeshIssueRow, key: string): string | null {
  const v = row.evidence[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function bool(row: MeshIssueRow, key: string): boolean | null {
  const v = row.evidence[key];
  return typeof v === 'boolean' ? v : null;
}

export function arr(row: MeshIssueRow, key: string): unknown[] | null {
  const v = row.evidence[key];
  return Array.isArray(v) ? v : null;
}

export function path(row: MeshIssueRow, a: string, b: string): unknown {
  const v = row.evidence[a];
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return (v as Record<string, unknown>)[b];
  }
  return undefined;
}

const EM_DASH = '—';

// ── Column factories ─────────────────────────────────────────────────────

/** A field rendered/sorted through the generic `formatFieldValue` path
 * (string/number/boolean/array/AgeMs-duration/`sources`) — covers the large
 * majority of §8.2's columns. */
function simpleColumn(
  key: string,
  label: string,
  opts: Partial<Pick<IssueColumn, 'primary' | 'defaultDir' | 'align' | 'numeric' | 'wrap'>> = {},
): IssueColumn {
  return {
    key,
    label,
    ...opts,
    sortValue: (row) => {
      const n = num(row, key);
      if (n !== null) return n;
      const s = str(row, key);
      if (s !== null) return s;
      const b = bool(row, key);
      if (b !== null) return b ? 1 : 0;
      return null;
    },
    render: (row, ctx) => formatFieldValue(key, row.evidence[key], ctx.sourceNames),
  };
}

/** Evidence stored as a 0-1 ratio (spec §8.2: `overlapRatio`, `hopShare`,
 * `areaShare`, `exhaustedRatio` only — verified against the emitting rule).
 * Renders `Math.round(v*100)%`; sorts on the raw ratio. */
function ratioPercentColumn(
  key: string,
  label: string,
  opts: Partial<Pick<IssueColumn, 'primary' | 'defaultDir'>> = {},
): IssueColumn {
  return {
    key,
    label,
    align: 'right',
    numeric: true,
    ...opts,
    sortValue: (row) => num(row, key),
    render: (row) => {
      const v = num(row, key);
      return v === null ? EM_DASH : `${Math.round(v * 100)}%`;
    },
  };
}

/** Evidence stored in metres; renders km to 1dp, sorts on the raw metres. */
function kmColumn(key: string, label: string, opts: Partial<Pick<IssueColumn, 'primary' | 'defaultDir'>> = {}): IssueColumn {
  return {
    key,
    label,
    align: 'right',
    numeric: true,
    ...opts,
    sortValue: (row) => num(row, key),
    render: (row) => {
      const v = num(row, key);
      return v === null ? EM_DASH : `${(v / 1000).toFixed(1)} km`;
    },
  };
}

/** Evidence stored in milliseconds but not `*AgeMs`-suffixed (so
 * `formatFieldValue` would not otherwise special-case it), rendered through
 * `formatDurationMs`. */
function durationMsColumn(
  key: string,
  label: string,
  opts: Partial<Pick<IssueColumn, 'primary' | 'defaultDir'>> = {},
): IssueColumn {
  return {
    key,
    label,
    align: 'right',
    numeric: true,
    ...opts,
    sortValue: (row) => num(row, key),
    render: (row) => {
      const v = num(row, key);
      return v === null ? EM_DASH : formatDurationMs(v);
    },
  };
}

/** A number nested one level in evidence, e.g. `snrToA.meanDb`. `key` is the
 * dotted display key (used as the column's stable id). */
function pathNumberColumn(
  objectKey: string,
  propKey: string,
  key: string,
  label: string,
  opts: Partial<Pick<IssueColumn, 'primary' | 'defaultDir'>> = {},
): IssueColumn {
  return {
    key,
    label,
    align: 'right',
    numeric: true,
    ...opts,
    sortValue: (row) => {
      const v = path(row, objectKey, propKey);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },
    render: (row) => {
      const v = path(row, objectKey, propKey);
      if (typeof v !== 'number' || !Number.isFinite(v)) return EM_DASH;
      return `${Math.round(v * 10) / 10} dB`;
    },
  };
}

/** B3's `deltaDb`: sorts by absolute value (bigger asymmetry is worse
 * regardless of sign), renders the signed value. */
function deltaDbColumn(): IssueColumn {
  return {
    key: 'deltaDb',
    label: 'Δ dB',
    primary: true,
    align: 'right',
    numeric: true,
    sortValue: (row) => {
      const v = num(row, 'deltaDb');
      return v === null ? null : Math.abs(v);
    },
    render: (row) => {
      const v = num(row, 'deltaDb');
      return v === null ? EM_DASH : `${Math.round(v * 10) / 10} dB`;
    },
  };
}

/** B3's `weakerDirection`: renders the weaker END'S NAME, never the raw
 * `'a->b' | 'b->a'` literal (spec §8.2). `snrToB` is measured AT b (the a->b
 * direction) and `snrToA` is measured AT a (the b->a direction) — see
 * `evidenceRenderers.tsx`'s `SnrDirections` direction-convention comment —
 * so a weak `a->b` direction means B is the poor listener, and vice versa. */
function weakerDirectionColumn(): IssueColumn {
  return {
    key: 'weakerDirection',
    label: 'Weaker',
    sortValue: (row) => str(row, 'weakerDirection'),
    render: (row) => {
      const dir = str(row, 'weakerDirection');
      if (dir !== 'a->b' && dir !== 'b->a') return EM_DASH;
      const nodeA = asNodeRef(row.evidence.nodeA);
      const nodeB = asNodeRef(row.evidence.nodeB);
      const weak = dir === 'a->b' ? nodeB : nodeA;
      if (weak === null) return EM_DASH;
      return weak.name ?? hexNodeId(weak.nodeNum);
    },
  };
}

/** B1's `members`: first 3 names + `+N`. */
function membersColumn(): IssueColumn {
  return {
    key: 'members',
    label: 'Members',
    sortValue: (row) => {
      const a = arr(row, 'members');
      return a === null ? null : a.length;
    },
    render: (row) => {
      const raw = row.evidence.members;
      if (!isEvidenceNodeRefArray(raw) || raw.length === 0) return EM_DASH;
      const names = raw.slice(0, 3).map((m) => m.name ?? hexNodeId(m.nodeNum));
      const extra = raw.length - names.length;
      return extra > 0 ? `${names.join(', ')} +${extra}` : names.join(', ');
    },
  };
}

/** B1's `edgesTotal ?? edges.length`. */
function edgesColumn(): IssueColumn {
  return {
    key: 'edges',
    label: 'Edges',
    align: 'right',
    numeric: true,
    sortValue: (row) => {
      const t = num(row, 'edgesTotal');
      if (t !== null) return t;
      const a = arr(row, 'edges');
      return a === null ? null : a.length;
    },
    render: (row) => {
      const t = num(row, 'edgesTotal');
      if (t !== null) return String(t);
      const a = arr(row, 'edges');
      return a === null ? EM_DASH : String(a.length);
    },
  };
}

/** B2's `sharedNeighborsTotal ?? sharedNeighbors.length`. */
function sharedNeighborsColumn(): IssueColumn {
  return {
    key: 'sharedNeighbors',
    label: 'Shared',
    align: 'right',
    numeric: true,
    sortValue: (row) => {
      const t = num(row, 'sharedNeighborsTotal');
      if (t !== null) return t;
      const a = arr(row, 'sharedNeighbors');
      return a === null ? null : a.length;
    },
    render: (row) => {
      const t = num(row, 'sharedNeighborsTotal');
      if (t !== null) return String(t);
      const a = arr(row, 'sharedNeighbors');
      return a === null ? EM_DASH : String(a.length);
    },
  };
}

/** C1_key_security's `clauses`: joined list, sorted by count. */
function clausesColumn(): IssueColumn {
  return {
    key: 'clauses',
    label: 'Clauses',
    primary: true,
    sortValue: (row) => {
      const a = arr(row, 'clauses');
      return a === null ? null : a.length;
    },
    render: (row) => {
      const a = arr(row, 'clauses');
      return a === null || a.length === 0 ? EM_DASH : a.map(String).join(', ');
    },
  };
}

/** C1_time_offset's `timeOffsetSeconds`: signed duration, sorted by absolute
 * offset (a large offset in either direction is equally bad). */
function timeOffsetColumn(): IssueColumn {
  return {
    key: 'timeOffsetSeconds',
    label: 'Clock offset',
    primary: true,
    sortValue: (row) => {
      const v = num(row, 'timeOffsetSeconds');
      return v === null ? null : Math.abs(v);
    },
    render: (row) => {
      const v = num(row, 'timeOffsetSeconds');
      if (v === null) return EM_DASH;
      const sign = v < 0 ? '-' : '+';
      return `${sign}${formatDurationMs(Math.abs(v) * 1000)}`;
    },
  };
}

// ── §8.2 per-type column sets ────────────────────────────────────────────

const COLUMNS_BY_TYPE: Record<string, () => IssueColumn[]> = {
  A1_deprecated_role: () => [
    simpleColumn('roleName', 'Role'),
    // §8.2: keep `desc` as the default (not the general "low is bad" `asc`
    // convention) — "newest-first is desc" for this column specifically.
    simpleColumn('lastHeardAgeMs', 'Last heard', { primary: true, align: 'right', numeric: true }),
  ],
  A2a_chatty_node: () => [
    simpleColumn('meanAirUtilTx', 'Mean AirUtilTx %', { primary: true, align: 'right', numeric: true }),
    simpleColumn('maxAirUtilTx', 'Max %', { align: 'right', numeric: true }),
    simpleColumn('sampleCount', 'Samples', { align: 'right', numeric: true }),
    simpleColumn('thresholdUsed', 'Threshold %', { align: 'right', numeric: true }),
  ],
  A2b_congested_area: () => [
    simpleColumn('nodeCount', 'Nodes', { align: 'right', numeric: true }),
    simpleColumn('meanChannelUtilization', 'Mean ChanUtil %', { primary: true, align: 'right', numeric: true }),
    simpleColumn('thresholdUsed', 'Threshold %', { align: 'right', numeric: true }),
    simpleColumn('binSizeDeg', 'Bin °', { align: 'right', numeric: true }),
  ],
  A2b_congested_node: () => [
    simpleColumn('meanChannelUtilization', 'Mean ChanUtil %', { primary: true, align: 'right', numeric: true }),
    simpleColumn('sampleCount', 'Samples', { align: 'right', numeric: true }),
    simpleColumn('binNodeCount', 'Nodes in bin', { align: 'right', numeric: true }),
    simpleColumn('thresholdUsed', 'Threshold %', { align: 'right', numeric: true }),
  ],
  A3_infra_power: () => [
    simpleColumn('roleName', 'Role'),
    simpleColumn('uptimeResets', 'Resets', { primary: true, align: 'right', numeric: true }),
    simpleColumn('minBatteryLevel', 'Min battery %', { align: 'right', numeric: true }),
    simpleColumn('latestBatteryLevel', 'Latest battery %', { align: 'right', numeric: true }),
    simpleColumn('clause', 'Clause'),
  ],
  A4_mobile_infra: () => [
    simpleColumn('roleName', 'Role'),
    simpleColumn('spanMeters', 'Span m', { primary: true, align: 'right', numeric: true }),
    simpleColumn('positionSampleCount', 'Samples', { align: 'right', numeric: true }),
    simpleColumn('mobileFlag', 'Mobile flag'),
    simpleColumn('positionPrecisionBits', 'Precision bits', { align: 'right', numeric: true }),
  ],
  A5_cosplay_router: () => [
    simpleColumn('roleName', 'Role'),
    simpleColumn('isUnmessagable', 'Unmessagable'),
    // ↑ low is bad: a short broadcast cadence looks like normal chatting.
    durationMsColumn('medianIntervalMs', 'Median interval', { primary: true, defaultDir: 'asc' }),
    simpleColumn('telemetryCadenceClause', 'Cadence'),
    simpleColumn('firmwareVersion', 'Firmware'),
  ],
  B1_router_cluster: () => [
    simpleColumn('size', 'Size', { primary: true, align: 'right', numeric: true }),
    membersColumn(),
    simpleColumn('bestSitedName', 'Best sited'),
    simpleColumn('inferredOnly', 'Inferred only'),
    edgesColumn(),
  ],
  B2_redundant_router: () => [
    simpleColumn('roleName', 'Role'),
    simpleColumn('neighborCount', 'Neighbours', { align: 'right', numeric: true }),
    simpleColumn('coveredByName', 'Covered by'),
    ratioPercentColumn('overlapRatio', 'Overlap %', { primary: true }),
    sharedNeighborsColumn(),
  ],
  B3_asymmetric_link: () => [
    pathNumberColumn('snrToB', 'meanDb', 'snrToB.meanDb', 'A -> B dB'),
    pathNumberColumn('snrToA', 'meanDb', 'snrToA.meanDb', 'B -> A dB'),
    deltaDbColumn(),
    weakerDirectionColumn(),
    simpleColumn('observationCount', 'Obs', { align: 'right', numeric: true }),
    simpleColumn('thresholdUsed', 'Threshold dB', { align: 'right', numeric: true }),
  ],
  B4_idle_router: () => [
    simpleColumn('roleName', 'Role'),
    // ↑ low is bad: an idle router carries almost none of its area's traffic.
    ratioPercentColumn('hopShare', 'Hop share %', { primary: true, defaultDir: 'asc' }),
    simpleColumn('areaPathCount', 'Area paths', { align: 'right', numeric: true }),
    simpleColumn('peerBestName', 'Best peer'),
    simpleColumn('peerBestShare', 'Peer share %', { align: 'right', numeric: true }),
    simpleColumn('directDegree', 'Direct degree', { align: 'right', numeric: true }),
  ],
  B5_load_bearing_client: () => [
    simpleColumn('roleName', 'Role'),
    ratioPercentColumn('areaShare', 'Area share %', { primary: true }),
    simpleColumn('hopCount', 'Hops', { align: 'right', numeric: true }),
    simpleColumn('areaPathCount', 'Area paths', { align: 'right', numeric: true }),
    simpleColumn('batteryLevel', 'Battery %', { align: 'right', numeric: true }),
    simpleColumn('fixedAndPowered', 'Fixed+powered'),
    simpleColumn('mobile', 'Mobile'),
  ],
  B6_hop_horizon: () => [
    ratioPercentColumn('exhaustedRatio', 'Exhausted %', { primary: true }),
    simpleColumn('exhaustedPackets', 'Exhausted', { align: 'right', numeric: true }),
    simpleColumn('totalPackets', 'Total', { align: 'right', numeric: true }),
    simpleColumn('behindRouterCluster', 'Behind cluster'),
    simpleColumn('hopDeltaIsLowerBound', 'Lower bound'),
  ],
  B7_coverage_shadow: () => [
    simpleColumn('nearestRouterName', 'Nearest router'),
    kmColumn('distanceM', 'Distance km', { primary: true }),
    kmColumn('routerObservedRangeM', 'Router range km'),
    simpleColumn('routerRangeSampleCount', 'Range samples', { align: 'right', numeric: true }),
    simpleColumn('rangeCappedAtCeiling', 'Capped'),
  ],
  C1_excessive_packets: () => [
    simpleColumn('roleName', 'Role'),
    simpleColumn('packetRatePerHour', 'Packets/hr', { primary: true, align: 'right', numeric: true }),
  ],
  C1_key_security: () => [clausesColumn(), simpleColumn('details', 'Details', { wrap: true })],
  C1_time_offset: () => [timeOffsetColumn()],
  C2_over_broadcasting: () => [
    simpleColumn('roleName', 'Role'),
    simpleColumn('stream', 'Stream'),
    // ↑ low is bad: a short cadence means over-broadcasting.
    simpleColumn('medianIntervalSeconds', 'Median interval s', {
      primary: true,
      defaultDir: 'asc',
      align: 'right',
      numeric: true,
    }),
    simpleColumn('meanIntervalSeconds', 'Mean s', { align: 'right', numeric: true }),
    simpleColumn('sampleCount', 'Samples', { align: 'right', numeric: true }),
    simpleColumn('thresholdUsed', 'Threshold s', { align: 'right', numeric: true }),
    simpleColumn('otherStreamMedianSeconds', 'Other stream s', { align: 'right', numeric: true }),
  ],
};

// ── §8.5 unknown-type fallback ───────────────────────────────────────────

/** Evidence keys excluded from the fallback's key hunt: structured keys
 * (handled by dedicated components elsewhere), `*Truncated`/`*Total` sibling
 * flags, and `recommendation`/`sources` (spec §8.5). */
function fallbackKeysForRow(row: MeshIssueRow): string[] {
  return Object.keys(row.evidence).filter((k) => {
    if (STRUCTURED_EVIDENCE_KEYS.has(k)) return false;
    if (k.endsWith('Truncated') || k.endsWith('Total')) return false;
    if (k === 'recommendation' || k === 'sources') return false;
    return true;
  });
}

/** A single fallback column, one per index 0-2. Each row independently picks
 * its own Nth non-structured evidence key (rules that emit an unknown type
 * are expected to emit a consistent evidence shape across their findings, so
 * in practice every row in a section shows the same field per column). When
 * a row's evidence has fewer keys than `index`, or is empty, the column
 * renders an em dash — except index 0 (`primary`), which falls back to a
 * synthetic `lastDetected` date so the primary column is never empty (spec
 * §8.5's "single synthetic lastDetected primary"). */
function fallbackColumn(index: number): IssueColumn {
  return {
    key: `fallback${index}`,
    label: `Field ${index + 1}`,
    primary: index === 0,
    sortValue: (row) => {
      const keys = fallbackKeysForRow(row);
      const key = keys[index];
      if (key === undefined) return index === 0 ? row.lastDetected : null;
      const v = row.evidence[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.length > 0) return v;
      return null;
    },
    render: (row, ctx) => {
      const keys = fallbackKeysForRow(row);
      const key = keys[index];
      if (key === undefined) {
        return index === 0 ? new Date(row.lastDetected).toLocaleString() : EM_DASH;
      }
      return `${formatEvidenceKey(key)}: ${formatFieldValue(key, row.evidence[key], ctx.sourceNames)}`;
    },
  };
}

function fallbackColumns(): IssueColumn[] {
  return [0, 1, 2].map((i) => fallbackColumn(i));
}

/** Type-specific columns only — the shell adds expand/state/subject before
 * and sources/severity/lastDetected/actions after. Unknown types (a future
 * rule not yet listed here) get the §8.5 fallback rather than an empty
 * table. */
export function columnsForType(issueType: string): IssueColumn[] {
  const build = COLUMNS_BY_TYPE[issueType];
  return build ? build() : fallbackColumns();
}
