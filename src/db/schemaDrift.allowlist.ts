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
  // --- (1) Index name-case drift: createIndexes() uses camelCase; migrations create lowercase ---
  // SQLite treats both as distinct objects, so variant A has both and variant B has only lowercase.
  // Phase 3.3: rename createIndexes() entries to match the lowercase migration names (or drop dupes).
  { key: 'index:idx_nodes_lastHeard', kind: 'onlyInBootstrap',
    reason: 'Name-case drift vs idx_nodes_lastheard: createIndexes() uses camelCase; migration 001 creates lowercase idx_nodes_lastheard on nodes(lastHeard).' },
  { key: 'index:idx_nodes_nodeId', kind: 'onlyInBootstrap',
    reason: 'Name-case drift vs idx_nodes_nodeid: createIndexes() uses camelCase; migration 001 creates lowercase idx_nodes_nodeid on nodes(nodeId).' },
  { key: 'index:idx_telemetry_nodeId', kind: 'onlyInBootstrap',
    reason: 'Name-case drift vs idx_telemetry_nodeid: createIndexes() uses camelCase; migration 036 creates lowercase idx_telemetry_nodeid on telemetry(nodeId).' },

  // --- (2) Indexes only createIndexes() creates — no migration creates these ---
  // A replay-only fresh install silently loses these indexes (perf regression risk).
  // Phase 3.3: add a migration creating each, then delete from this allowlist.
  { key: 'index:idx_messages_createdAt', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index on messages(createdAt). Phase 3.3: add as a migration.' },
  { key: 'index:idx_messages_fromNodeId', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index on messages(fromNodeId). Phase 3.3: add as a migration.' },
  { key: 'index:idx_messages_toNodeId', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index on messages(toNodeId). Phase 3.3: add as a migration.' },
  { key: 'index:idx_nodes_updatedAt', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index on nodes(updatedAt). Phase 3.3: add as a migration.' },
  { key: 'index:idx_route_segments_distance', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index ON route_segments(distanceKm DESC). Phase 3.3: add as a migration.' },
  { key: 'index:idx_route_segments_recordholder', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index ON route_segments(isRecordHolder). Phase 3.3: add as a migration.' },
  { key: 'index:idx_route_segments_timestamp', kind: 'onlyInBootstrap',
    reason: 'createIndexes()-only; no migration creates this index ON route_segments(timestamp). Phase 3.3: add as a migration.' },

  // --- (1 cont.) Lowercase counterparts only in migration replay ---
  // Mirror entries for the name-case pairs above (these exist in B but not A).
  { key: 'index:idx_nodes_lastheard', kind: 'onlyInReplay',
    reason: 'Name-case drift vs idx_nodes_lastHeard: migration 001 creates lowercase; createIndexes() creates the camelCase variant as a separate object.' },
  { key: 'index:idx_nodes_nodeid', kind: 'onlyInReplay',
    reason: 'Name-case drift vs idx_nodes_nodeId: migration 001 creates lowercase; createIndexes() creates the camelCase variant as a separate object.' },
  { key: 'index:idx_telemetry_nodeid', kind: 'onlyInReplay',
    reason: 'Name-case drift vs idx_telemetry_nodeId: migration 036 creates lowercase; createIndexes() creates the camelCase variant as a separate object.' },

  // --- (3) Column-order drift: same column set, different physical order ---
  // createTables() defines the full DDL in one order; migrations reach the same
  // column set chronologically via ALTER TABLE ADD COLUMN (columns appended at end).
  // Functionally equivalent but normalized DDL strings differ. Phase 3.3: accept or
  // add a table-rebuild migration to align the order.
  { key: 'table:auto_key_repair_log', kind: 'sqlMismatch',
    reason: 'Column order differs: bootstrap DDL has sourceid before oldkeyfragment/newkeyfragment; migration replay (ALTER TABLE ADD COLUMN order) places sourceid after oldkeyfragment/newkeyfragment.' },
  { key: 'table:user_map_preferences', kind: 'sqlMismatch',
    reason: 'Column order differs: bootstrap DDL places legacy columns (showaccuracyregions, showestimatedpositions, showmeshcorenodes, sortby, sortdirection) in mid-table position; migration replay appends them at the end via ALTER TABLE ADD COLUMN.' },
] as const;
