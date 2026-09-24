/**
 * Coverage Report receiver-filter wire format (#5277 Phase 2 WP1).
 *
 * P1 sent `receivers=<id>,<id>` — a flat CSV of receiver ids with no source
 * scoping. That format breaks at MQTT-gateway scale: source ids are 36-char
 * UUIDs, and with hundreds of gateways the list can exceed Node's 16 KB
 * header limit. It was also ambiguous: `receivers=!abcd` matched that id on
 * EVERY source, not just the one the user meant (P1 bug, fixed here).
 *
 * New format (`receivers` query param), source-scoped:
 *   `<sourceId>:+<id>,<id>;<sourceId>:-<id>,<id>`
 *   - `+` = include ONLY these receivers of that source.
 *   - `-` = ALL of that source's receivers EXCEPT these.
 *   - A source with no entry is fully selected (all its receivers included).
 *   - A source deliberately omitted from the caller's receiver set (see
 *     `buildReceiverQuery`) is fully deselected.
 *
 * Not backward compatible with the P1 CSV format — Decision D8. This module
 * is dependency-free (no `src/server` or `src/components` imports), shared
 * verbatim by the server parser (`coverageRoutes.ts`, WP1) and the client
 * builder (`CoverageReport.tsx` / `CoverageReceiverFilter.tsx`, WP4).
 * `src/utils/**` is included in `tsconfig.server.json`, so any relative
 * import ADDED to this file needs an explicit `.js` extension.
 *
 * See COVERAGE_P2_SPEC.md §2.5 and Decision D8.
 */

export type CoverageReceiverFilterMode = 'include' | 'exclude';

export interface CoverageReceiverFilterEntry {
  sourceId: string;
  mode: CoverageReceiverFilterMode;
  receiverIds: string[];
}

export interface BuildReceiverQueryResult {
  /**
   * Explicit list of sources to query, omitted when every source with
   * receivers keeps at least one selected — the server then uses all
   * permitted sources (its normal default).
   */
  sources?: string[];
  receiverFilter?: CoverageReceiverFilterEntry[];
  /** True once at least one receiver exists and none of them are selected. */
  noneSelected: boolean;
  /**
   * Set only when the minimised entry set would exceed the 1000-id cap (a
   * single source with well over 2000 gateways, roughly half selected). The
   * hook falls back to filtering rows on the client instead of encoding the
   * filter on the wire.
   */
  clientSideFilter?: boolean;
}

/** A sourceId segment: no `:`, `;`, `,`, reasonably short. */
const SOURCE_ID_RE = /^[0-9A-Za-z_-]{1,100}$/;
/** Fits Meshtastic `!hex` ids today; P3 pubkey-hex receiver ids later. */
const RECEIVER_ID_RE = /^[!0-9A-Za-z_-]{1,80}$/;
/** Total ids across every entry — matches `parseReceiverFilter`'s cap. */
const MAX_TOTAL_IDS = 1000;

/** Composite key used everywhere a receiver must be identified across sources (carry-over a). */
export function receiverKey(sourceId: string, receiverId: string): string {
  return `${sourceId}|${receiverId}`;
}

/** Serialise entries with at least one id into the wire grammar. Entries with an empty `receiverIds` are dropped (they'd encode to unparseable grammar). */
export function encodeReceiverFilter(entries: CoverageReceiverFilterEntry[]): string {
  return entries
    .filter((e) => e.receiverIds.length > 0)
    .map((e) => `${e.sourceId}:${e.mode === 'include' ? '+' : '-'}${e.receiverIds.join(',')}`)
    .join(';');
}

/**
 * Parse the `receivers` query param. Returns `null` on ANY malformed input:
 * bad grammar (empty segments, missing `+`/`-`, no ids), a sourceId or
 * receiver id with disallowed characters (including one that embeds `:`,
 * `;` or `,`, which the id regexes reject), or more than 1000 ids total
 * across every entry.
 */
export function parseReceiverFilter(raw: unknown): CoverageReceiverFilterEntry[] | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(';');
  const entries: CoverageReceiverFilterEntry[] = [];
  let totalIds = 0;

  for (const part of parts) {
    if (part.length === 0) return null; // e.g. a stray ";;"

    const colonIdx = part.indexOf(':');
    if (colonIdx <= 0) return null; // no sourceId, or no colon at all

    const sourceId = part.slice(0, colonIdx);
    if (!SOURCE_ID_RE.test(sourceId)) return null;

    const rest = part.slice(colonIdx + 1);
    if (rest.length === 0) return null;

    const modeChar = rest[0];
    if (modeChar !== '+' && modeChar !== '-') return null;

    const idsRaw = rest.slice(1);
    if (idsRaw.length === 0) return null;

    const ids = idsRaw.split(',');
    for (const id of ids) {
      if (!RECEIVER_ID_RE.test(id)) return null;
    }

    totalIds += ids.length;
    if (totalIds > MAX_TOTAL_IDS) return null;

    entries.push({ sourceId, mode: modeChar === '+' ? 'include' : 'exclude', receiverIds: ids });
  }

  return entries;
}

/**
 * Compose a `sources` / `receiverFilter` pair from the full receiver set and
 * the (composite-keyed) deselected set — the inverse of what the report UI
 * tracks (default-all-selected; a newly-seen receiver shows up selected).
 *
 * Per source: fully selected → no entry (and the source stays out of any
 * explicit `sources` list); fully deselected → the source is dropped from
 * `sources` entirely; partial → an include or exclude entry, whichever
 * encodes fewer ids.
 */
export function buildReceiverQuery(
  receivers: Array<{ sourceId: string; receiverId: string }>,
  deselected: Set<string>,
): BuildReceiverQueryResult {
  const bySource = new Map<string, string[]>();
  for (const r of receivers) {
    const existing = bySource.get(r.sourceId);
    if (existing) {
      existing.push(r.receiverId);
    } else {
      bySource.set(r.sourceId, [r.receiverId]);
    }
  }

  const keptSources: string[] = [];
  const entries: CoverageReceiverFilterEntry[] = [];
  let totalFilterIds = 0;

  for (const [sourceId, ids] of bySource) {
    const selectedIds = ids.filter((id) => !deselected.has(receiverKey(sourceId, id)));
    const deselectedIds = ids.filter((id) => deselected.has(receiverKey(sourceId, id)));

    if (selectedIds.length === 0) {
      // Fully deselected: drop the source entirely, no entry.
      continue;
    }

    keptSources.push(sourceId);

    if (deselectedIds.length === 0) {
      // Fully selected: no entry needed.
      continue;
    }

    // Partial: encode whichever side is shorter.
    if (selectedIds.length <= deselectedIds.length) {
      entries.push({ sourceId, mode: 'include', receiverIds: selectedIds });
      totalFilterIds += selectedIds.length;
    } else {
      entries.push({ sourceId, mode: 'exclude', receiverIds: deselectedIds });
      totalFilterIds += deselectedIds.length;
    }
  }

  const noneSelected = bySource.size > 0 && keptSources.length === 0;
  const sources = keptSources.length === bySource.size ? undefined : keptSources;

  if (totalFilterIds > MAX_TOTAL_IDS) {
    return { sources, noneSelected, clientSideFilter: true };
  }

  return {
    sources,
    receiverFilter: entries.length > 0 ? entries : undefined,
    noneSelected,
  };
}
