# Sync-to-Async Migration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate ~250 sync method calls in production code to async repository equivalents, making all database access work across SQLite, PostgreSQL, and MySQL.

**Architecture:** Sync methods use `this.db.prepare()` (SQLite-only better-sqlite3 API). Async equivalents use Drizzle ORM repositories that work on all 3 backends. Migration must be done file-by-file with tests passing after each to avoid cascading breakage.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest

---

## Why This Matters

The sync methods work on SQLite (the primary deployment) but fail silently on PostgreSQL/MySQL. As MeshMonitor grows multi-DB adoption, these become real bugs. The sync methods also block the removal of legacy model files and further database.ts decomposition.

## Migration Rules

1. **One file per commit** — never leave tests broken between commits
2. **Making a function async cascades** — if `foo()` calls `databaseService.getSetting()` and we make it `await databaseService.settings.getSetting()`, then `foo` must become `async foo()`, and every caller of `foo` must `await` it
3. **Test mocks must be updated** — if a test mocks `databaseService.getSetting`, it needs to mock `databaseService.settings.getSetting` instead
4. **Hot paths need care** — meshtasticManager.ts processes packets in real-time. Making methods async adds microtask overhead. Profile if concerned.

## Method Mapping

| Sync Method | Async Replacement |
|-------------|-------------------|
| `databaseService.getSetting(key)` | `await databaseService.settings.getSetting(key)` |
| `databaseService.setSetting(key, val)` | `await databaseService.settings.setSetting(key, val)` |
| `databaseService.getNode(nodeNum)` | `await databaseService.nodes.getNode(nodeNum)` |
| `databaseService.upsertNode(data)` | `await databaseService.nodes.upsertNode(data)` |
| `databaseService.getAllNodes()` | `await databaseService.nodes.getAllNodes()` |
| `databaseService.getActiveNodes()` | `await databaseService.nodes.getActiveNodes()` |
| `databaseService.getChannel(id)` | `await databaseService.channels.getChannel(id)` |
| `databaseService.getChannelById(id)` | `await databaseService.channels.getChannelById(id)` |
| `databaseService.getAllChannels()` | `await databaseService.channels.getAllChannels()` |
| `databaseService.insertMessage(msg)` | `await databaseService.messages.insertMessage(msg)` |
| `databaseService.updateMessage(id, data)` | `await databaseService.messages.updateMessage(id, data)` |
| `databaseService.deleteMessage(id)` | `await databaseService.messages.deleteMessage(id)` |
| `databaseService.insertTelemetry(data)` | `await databaseService.telemetry.insertTelemetry(data)` |
| `databaseService.auditLog(...)` | `await databaseService.auditLogAsync(...)` or `databaseService.auth.createAuditLogEntry(...)` |
| `databaseService.getNodeCount()` | `await databaseService.nodes.getNodeCount()` |

> **Note for implementer:** Before migrating each method, verify the async equivalent exists on the repository. If it doesn't, add it first.

---

## Phase 1: Small Files (low risk, ~30 calls)

These files have few sync calls and limited cascade impact.

### Task 1.1: nodeEnhancer.ts (~2 calls)

**Files:** `src/server/utils/nodeEnhancer.ts`

- [ ] Replace `databaseService.getNode()` with `await databaseService.nodes.getNode()`
- [ ] Make enclosing function async if needed
- [ ] Run tests: `npx vitest run src/server/utils/`
- [ ] Commit

### Task 1.2: dynamicCsp.ts (~3 calls)

**Files:** `src/server/middleware/dynamicCsp.ts`

- [ ] Replace `databaseService.getSetting()` calls
- [ ] Make middleware function async
- [ ] Run tests
- [ ] Commit

### Task 1.3: deviceBackupService.ts (~4 calls)

**Files:** `src/server/services/deviceBackupService.ts`

- [ ] Replace `getSetting`, `getAllChannels`, `getNode`
- [ ] Run tests
- [ ] Commit

### Task 1.4: duplicateKeySchedulerService.ts (~14 calls)

**Files:** `src/server/services/duplicateKeySchedulerService.ts`

- [ ] Replace all sync calls
- [ ] Run tests
- [ ] Commit

### Task 1.5: autoDeleteByDistanceService.ts (~4 calls)

**Files:** `src/server/services/autoDeleteByDistanceService.ts`

- [ ] Replace `getSetting` calls
- [ ] Run tests
- [ ] Commit

### Task 1.6: packetLogService.ts (~3 calls)

**Files:** `src/server/services/packetLogService.ts`, `src/server/routes/packetRoutes.ts`

- [ ] Replace `getSetting` calls (makes methods async)
- [ ] Update callers in packetRoutes.ts to await
- [ ] Update test mocks in packetRoutes.test.ts
- [ ] Run tests
- [ ] Commit

### Task 1.7: notificationFiltering.ts (~4 calls)

**Files:** `src/server/utils/notificationFiltering.ts`

- [ ] Replace `getSetting` calls
- [ ] Make functions async, update all callers
- [ ] Run tests
- [ ] Commit

### Task 1.8: Remaining small files (~5 calls)

**Files:** Various route files (embedPublicRoutes.ts, securityRoutes.ts, v1/network.ts, v1/positionHistory.ts, virtualNodeServer.ts)

- [ ] Replace sync calls in each file
- [ ] Run tests after each
- [ ] Commit

### Phase 1 Checkpoint

- [ ] Run full test suite: `npm test`
- [ ] Run build: `node_modules/.bin/tsc --noEmit`
- [ ] Create PR for Phase 1

---

## Phase 2: server.ts (~62 calls)

The second largest file. Many sync calls are in route handlers that are already async.

### Task 2.1: Audit server.ts sync calls

- [ ] List all sync method calls with line numbers
- [ ] Group by method (getNode, getSetting, etc.)
- [ ] Identify which enclosing functions are already async (most route handlers are)

### Task 2.2: Migrate server.ts getNode calls (~29)

- [ ] Bulk replace `databaseService.getNode(` with `await databaseService.nodes.getNode(`
- [ ] Verify all are inside async functions
- [ ] Run tests
- [ ] Commit

### Task 2.3: Migrate server.ts getSetting/setSetting calls (~15)

- [ ] Replace all getSetting/setSetting calls
- [ ] Run tests
- [ ] Commit

### Task 2.4: Migrate server.ts remaining calls (~18)

- [ ] getChannelById, upsertNode, getAllNodes, insertMessage, etc.
- [ ] Run tests
- [ ] Commit

### Phase 2 Checkpoint

- [ ] Run full test suite
- [ ] Create PR for Phase 2

---

## Phase 3: meshtasticManager.ts (~157 calls)

The largest and most sensitive file — real-time packet processing.

### Task 3.1: Audit meshtasticManager.ts sync calls

- [ ] List all sync calls grouped by method
- [ ] Identify hot paths (packet handlers) vs cold paths (setup/config)
- [ ] Determine which enclosing methods are already async

### Task 3.2: Migrate cold path calls first

Config loading, setup, periodic tasks — not performance-sensitive.

- [ ] Replace getSetting calls in config/setup methods
- [ ] Run tests
- [ ] Commit

### Task 3.3: Migrate getNode calls (~62)

Most packet handlers already async (they `await` mesh operations).

- [ ] Bulk replace getNode calls
- [ ] Run tests
- [ ] Commit

### Task 3.4: Migrate insertTelemetry calls (~35)

- [ ] Replace all insertTelemetry calls
- [ ] Run tests
- [ ] Commit

### Task 3.5: Migrate upsertNode calls (~28)

- [ ] Replace all upsertNode calls
- [ ] Run tests
- [ ] Commit

### Task 3.6: Migrate remaining calls (~32)

- [ ] insertMessage, updateMessage, getSetting, etc.
- [ ] Run tests
- [ ] Commit

### Phase 3 Checkpoint

- [ ] Run full test suite
- [ ] Docker verification all 3 backends
- [ ] Create PR for Phase 3

---

## Phase 4: Cleanup

### Task 4.1: Remove sync methods from database.ts

- [ ] Identify sync methods with zero external callers
- [ ] Remove them (keep any still used internally)
- [ ] Run tests
- [ ] Commit

### Task 4.2: Remove legacy model files

- [ ] Check if User.ts, Permission.ts, APIToken.ts are still imported
- [ ] Delete unused model files
- [ ] Run tests
- [ ] Commit

### Task 4.3: Final database.ts line count

- [ ] Measure final line count (target: under 5,000)
- [ ] Create PR

---

## Estimated Effort

| Phase | Files | Calls | Effort | Risk |
|-------|-------|-------|--------|------|
| 1 | ~10 | ~30 | 1 session | Low |
| 2 | 1 (server.ts) | ~62 | 1 session | Medium |
| 3 | 1 (meshtasticManager.ts) | ~157 | 1-2 sessions | Medium-High |
| 4 | ~5 | cleanup | 1 session | Low |
| **Total** | ~17 | ~250 | 4-5 sessions | |
