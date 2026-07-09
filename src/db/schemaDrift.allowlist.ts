/**
 * KNOWN divergences between the two schema-bootstrap paths (see schemaDrift.test.ts).
 * Each entry is drift that Phase 3.3 (single source of truth for schema bootstrap)
 * will remove. When Phase 3.3 reconciles an item, DELETE its entry here — the test
 * fails on BOTH unexpected new drift AND stale (no-longer-present) allowlist entries,
 * so the list can only shrink. Keep sorted by `key`.
 */

export type DriftKind = 'onlyInBootstrap' | 'onlyInReplay' | 'sqlMismatch';
export interface AllowedDrift { key: string; kind: DriftKind; reason: string; }

export const SCHEMA_DRIFT_ALLOWLIST: readonly AllowedDrift[] = [
  // --- (3) Column-order drift: same column set, different physical order ---
  // createTables() defines the full DDL in one order; migrations reach the same
  // column set chronologically via ALTER TABLE ADD COLUMN (columns appended at end).
  // Functionally equivalent but normalized DDL strings differ. Phase 3.3 WP-B/C
  // will eliminate createTables() so both paths converge on the ALTER order.
  { key: 'table:auto_key_repair_log', kind: 'sqlMismatch',
    reason: 'Column order differs: bootstrap DDL has sourceid before oldkeyfragment/newkeyfragment; migration replay (ALTER TABLE ADD COLUMN order) places sourceid after oldkeyfragment/newkeyfragment.' },
  { key: 'table:user_map_preferences', kind: 'sqlMismatch',
    reason: 'Column order differs: bootstrap DDL places legacy columns (showaccuracyregions, showestimatedpositions, showmeshcorenodes, sortby, sortdirection) in mid-table position; migration replay appends them at the end via ALTER TABLE ADD COLUMN.' },
] as const;
