# Drizzle JOIN Refactor (Phase 1) — Design Spec

**Date:** 2026-03-21
**Status:** Approved

## Overview

Replace 4 raw SQL queries in `src/db/repositories/misc.ts` that branch on database type (PostgreSQL vs SQLite/MySQL) for column quoting with unified Drizzle ORM query builder calls. This eliminates ~80 lines of duplicated SQL and 4 `isPostgres()` conditional blocks.

## Scope

Only queries where the branching is purely about column name quoting. Excludes queries with genuine SQL syntax differences (DISTINCT ON, DELETE RETURNING, etc.) — those are future phases.

## Queries to Refactor

### 1. `getPacketLogs` (lines ~965-984)
- `packet_log` LEFT JOIN `nodes` twice (as from_nodes, to_nodes)
- Selects `longName` from each joined node
- Has WHERE clause, ORDER BY timestamp DESC + created_at DESC, LIMIT/OFFSET

### 2. `getPacketLogById` (lines ~999-1015)
- Same double LEFT JOIN as above
- Filtered by `pl.id = ${id}`

### 3. `getPacketCountsByNode` (lines ~1175-1195)
- `packet_log` LEFT JOIN `nodes` once
- GROUP BY + COUNT(*) + ORDER BY count DESC
- Postgres uses `COUNT(*)::int` cast (unnecessary with Drizzle)

### 4. `getDistinctRelayNodes` (lines ~1100-1104)
- Simple SELECT from nodes with bitwise WHERE
- Not a JOIN, just quoting difference on column names

## Design

### Approach
Use Drizzle's `alias()` function for double-joining the nodes table, and the standard `.select().from().leftJoin()` builder for all queries. Drizzle handles column quoting per-backend automatically.

### Key Drizzle patterns needed

**Table alias for double-join:**
```typescript
import { alias } from 'drizzle-orm/sqlite-core'; // or pg-core, mysql-core
// Use the active schema's nodes table
const fromNodes = alias(this.tables.nodes, 'from_nodes');
const toNodes = alias(this.tables.nodes, 'to_nodes');
```

Note: `alias()` is backend-specific in Drizzle. Since we have three backends, we need to use the correct `alias` import or find a backend-agnostic approach. The `sql` tagged template with `this.tables.nodes` column references may be simpler — Drizzle's `sql` helper auto-quotes column references from table schemas.

**Unified column references:**
```typescript
const { packetLog, nodes } = this.tables;
// Drizzle auto-quotes: nodes.longName → "longName" (PG) or longName (SQLite)
```

**COUNT without cast:**
```typescript
sql<number>`COUNT(*)`  // Works across all backends
```

### What changes
- Remove 4 `if (this.isPostgres()) { ... } else { ... }` blocks
- Replace with single Drizzle query builder call per method
- No changes to method signatures or return types
- `normalizePacketLogRow()` continues to handle result normalization

### Files Modified

| File | Change |
|------|--------|
| `src/db/repositories/misc.ts` | Replace 4 branched queries with Drizzle query builder |

## Testing

- Existing tests cover these methods — they must continue to pass
- Run full test suite (3052+ tests)
- Build verification (TypeScript clean)

## Risk

Low — method signatures and return types don't change. The Drizzle query builder generates the same SQL that's currently hardcoded, just with correct quoting per backend. If any query doesn't translate cleanly to the Drizzle builder, we keep the raw SQL but use Drizzle column references for auto-quoting instead of full builder conversion.
