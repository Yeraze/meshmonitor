# Multi-Database Backend Parity — Design Spec

**Goal**: Ensure all MeshMonitor features work correctly on PostgreSQL and MySQL, not just SQLite.

**Architecture**: MeshMonitor's `DatabaseService` uses sync methods for SQLite (via `better-sqlite3`) and async methods for PostgreSQL (`pg` pool) and MySQL (`mysql2` pool). Many sync methods were never implemented for PG/MySQL, returning stubs. This spec covers implementing all missing async equivalents and updating callers.

**Approach**: Three independent PRs, each buildable and testable on its own.

---

## Sub-Project A: Fix Critical Crashes

**PR scope**: Methods that throw runtime errors (call `this.db.prepare()` without a PG/MySQL guard) or completely disable features.

### Methods to Implement

| Method | Location | Current Behavior | Fix |
|--------|----------|-----------------|-----|
| `createCustomTheme()` | database.ts:11829 | Crashes (raw SQLite call) | Add async version with PG/MySQL queries |
| `updateCustomTheme()` | database.ts:11863 | Crashes (raw SQLite call) | Add async version |
| `deleteCustomTheme()` | database.ts:11912 | Crashes (raw SQLite call) | Add async version |
| `getAllCustomThemes()` | database.ts:11783 | Returns `[]` | Add async version |
| `getCustomThemeBySlug()` | database.ts:11806 | Returns `undefined` | Add async version |
| `getAuditStats()` | database.ts:~10008 | Crashes (3x `this.db.prepare()`) | Add async version |
| `checkInactiveNodes()` | inactiveNodeNotificationService.ts:85 | Returns early (no-op) | Implement PG/MySQL queries |
| `getUserNotificationPreferences()` | notificationFiltering.ts:42 | Crashes via `.prepare()` Proxy | Add async version, update callers |

### Caller Updates

- `server.ts` theme endpoints (5148, 5160, 5190, 5203, 5230, 5264, 5290) → use async versions
- `auditRoutes.ts:86` → use async version
- `server.ts` test notification endpoints (7494, 7692) → use async `applyNodeNamePrefix`
- `inactiveNodeNotificationService.ts` → rewrite `checkInactiveNodes` with async DB queries

### Pattern

Each async method follows the established pattern:
```typescript
async methodNameAsync(...): Promise<ReturnType> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      // quoted column names, $1 params
      const result = await client.query(...);
      return result.rows.map(row => ({ ...coerce Number() on BIGINTs... }));
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query(...);
    return (rows as any[]).map(row => ({ ...coerce Number() on BIGINTs... }));
  }
  // SQLite fallback
  return this.methodName(...);
}
```

Sync methods get a PG/MySQL guard that delegates to the async version (fire-and-forget for void methods, return stub for value methods).

---

## Sub-Project B: Implement Missing Async Data Methods

**PR scope**: Methods that silently return empty/zero/null for PG/MySQL, causing degraded UX.

### Methods to Implement

| Method | Location | Current Behavior | Impact |
|--------|----------|-----------------|--------|
| `getDirectMessages()` | database.ts:4591 | Returns `[]` | DM history empty |
| `getMessagesByDay()` | database.ts:4854 | Returns `[]` | Dashboard stats chart empty |
| `getAllNodesEstimatedPositions()` | database.ts:5611 | Returns `new Map()` | No estimated positions on map |
| `getPacketRates()` | database.ts:5953 | Returns empty arrays | Packet rate charts empty |
| `getTelemetryCount()` | database.ts:4674 | Returns `0` | V1 API count always 0 |
| `markMessageAsRead()` | database.ts:10058 | No-op | Sent messages not tracked |
| `markMessagesAsRead()` | database.ts:10074 | No-op | Batch read tracking broken |
| `cleanupOldPacketLogs()` | database.ts:11489 | Returns `0` | Packet logs grow unbounded |

### Caller Migration

- `getLatestTelemetryForType()` — async version exists at database.ts:8010. Migrate 4 callers in meshtasticManager.ts (lines 4323, 4350, 5973, 10720) to use `getLatestTelemetryForTypeAsync()`.
- `server.ts:2035` (GET direct messages) → use `getDirectMessagesAsync()`
- `server.ts:2742` (GET stats) → use `getMessagesByDayAsync()`
- `server.ts:829, 3783` (nodes/poll) → use `getAllNodesEstimatedPositionsAsync()`
- `server.ts:3527` (telemetry rates) → use `getPacketRatesAsync()`
- `v1/telemetry.ts:91` → use `getTelemetryCountAsync()`
- `meshtasticManager.ts:6235` → use `markMessageAsReadAsync()`
- `server.ts:2080` → use `markMessagesAsReadAsync()`
- `packetLogService.ts:31` → use `cleanupOldPacketLogsAsync()`

---

## Sub-Project C: Schema Drift Cleanup

**PR scope**: Align `postgres-create.ts` and `mysql-create.ts` CREATE TABLE statements with Drizzle schemas. Only affects fresh installs — existing deployments use migrations.

### Tables to Fix

| Table | Issue | Fix |
|-------|-------|-----|
| `read_messages` | MySQL has `visitorKey` column + wrong PK; Postgres has composite PK but Drizzle expects serial `id` | Align PK to `id SERIAL PRIMARY KEY`, remove `visitorKey`, add `userId`/`messageId`/`readAt` |
| `system_backup_history` | Column names (`dirname`, `type`, `size`) don't match Drizzle (`backupPath`, `backupType`, `totalSize`) | Use Drizzle column names in CREATE TABLE |
| `user_map_preferences` | PK is `userId` but Drizzle expects serial `id`; missing `selectedLayer`/`createdAt`; has extra `selectedNodeNum` | Align with Drizzle schema |
| `custom_themes` | Missing `slug` (UNIQUE) and `is_builtin` columns | Add both columns to CREATE TABLE |

### Scope Boundary

- No runtime code changes
- No migration changes (migrations already handle upgrades)
- Only `postgres-create.ts` and `mysql-create.ts` modified

---

## Success Criteria

- All 2953+ existing tests continue to pass
- No `this.db.prepare()` calls reachable on PostgreSQL/MySQL without guards
- No methods returning stubs (`[]`, `null`, `0`, no-op) for PG/MySQL when data should be available
- CREATE TABLE statements in create SQL match Drizzle schema column names and types

## Execution Order

A → B → C (crashes first, then degraded features, then schema cleanup)
