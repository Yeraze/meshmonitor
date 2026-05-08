# Architecture Lessons Learned

This document captures critical insights learned during MeshMonitor development. Reference these patterns when making architectural decisions to avoid repeating past mistakes.

---

## Table of Contents
1. [Meshtastic Protocol Fundamentals](#meshtastic-protocol-fundamentals)
2. [Asynchronous Operations](#asynchronous-operations)
3. [State Management & Consistency](#state-management--consistency)
4. [Node Communication Patterns](#node-communication-patterns)
5. [Backup & Restore](#backup--restore)
6. [Testing Strategy](#testing-strategy)
7. [Background Task Management](#background-task-management)
8. [Multi-Database Architecture](#multi-database-architecture)
9. [Multi-Source Architecture](#multi-source-architecture)

---

## Meshtastic Protocol Fundamentals

### The Node is NOT a REST API

**Problem**: It's tempting to treat node interactions like HTTP requests - send command, get immediate response.

**Reality**:
- LoRa transmissions take seconds and can fail silently
- Nodes may be asleep, out of range, or busy
- ACKs arrive asynchronously (or never)
- Multiple commands must be queued and serialized

**Architecture Decision**:
```
❌ DON'T: Let frontend send commands directly to nodes
✅ DO: All node communication goes through backend queue

Frontend → Backend API → Command Queue → Serial/TCP → Node
                           ↓
                    ACK tracking & timeout handling
```

### Multi-layered Telemetry

**Lesson**: NodeInfo packets contain valuable local node telemetry that complements mesh-wide data.

**Implementation**:
- Capture telemetry from NodeInfo packets (local node hardware stats)
- Supplement with mesh-propagated telemetry (other nodes)
- Store both with proper timestamps and attribution

**Location**: `src/db/repositories/telemetry.ts`, `src/db/schema/telemetry.ts`, `src/server/routes/v1/telemetry.ts` - NodeInfo handling (PR #427)

### Protocol Constants

**Lesson**: Magic numbers for protocol values lead to scattered, hard-to-maintain code.

**Solution**: Use shared constants from `src/server/constants/meshtastic.ts`:

```typescript
import { PortNum, RoutingError, isPkiError, getPortNumName } from './constants/meshtastic.js';

// Use constants instead of magic numbers
if (portnum === PortNum.TEXT_MESSAGE_APP) { ... }
if (isPkiError(errorReason)) { ... }

// Get human-readable names for logging
logger.info(`Received ${getPortNumName(portnum)} packet`);
```

**Available Constants**:
- `PortNum` - All Meshtastic application port numbers
- `RoutingError` - Routing error codes
- `getPortNumName(portnum)` - Convert port number to name
- `getRoutingErrorName(code)` - Convert error code to name
- `isPkiError(code)` - Check if error is PKI-related
- `isInternalPortNum(portnum)` - Check if port is internal (ADMIN/ROUTING)

**Location**: `src/server/constants/meshtastic.ts`

### Config Management Complexity

**Pattern**: The wantConfigId/ConfigComplete handshake requires careful state machine management.

**Critical Points**:
1. Client sends `wantConfigId` with specific ID
2. Server must respond with matching config ID
3. Client validates ID match before trusting config
4. ConfigComplete confirms successful handshake

**Common Mistake**: Sending generic config without respecting the requested ID.

**Reference**: Virtual Node implementation - `src/server/virtualNodeServer.ts`

---

## Asynchronous Operations

### Request State Tracking

**Problem**: When you send a command to a node, you need to track its lifecycle.

**States Required**:
- `pending`: Sent to node, awaiting ACK
- `confirmed`: ACK received successfully
- `failed`: Timeout or explicit error
- `unknown`: Connection lost during operation

**Implementation Pattern**:
```typescript
interface PendingOperation {
  id: string;
  command: string;
  sentAt: Date;
  timeout: number;
  retryCount: number;
  onSuccess: (response: any) => void;
  onFailure: (error: Error) => void;
}
```

**Location**: Context parameter threading (PR #430)

### ACK Tracking

**Lesson**: ACKs must be correlated with their originating requests using request IDs.

**Critical Pattern**:
```typescript
// When sending request
const requestId = generateRequestId();
trackPendingRequest(requestId, operation);
sendToNode(command, requestId);

// When receiving ACK
const pendingOp = getPendingRequest(ackData.requestId);
if (pendingOp) {
  completePendingRequest(pendingOp, ackData);
}
```

### Timeout Strategies

**Required**: Every node operation MUST have a timeout.

**Pattern**:
- Short operations (queries): 10-30 seconds
- Config updates: 60-120 seconds
- Long operations (traceroutes): 5-10 minutes
- **Connection idle timeout**: 5 minutes (300 seconds)

**Critical**: Clean up pending operations on timeout to prevent memory leaks.

### Stale Connection Detection

**Problem**: TCP connections can appear "alive" at the socket level but have stale/frozen application-level communication ("zombie connections").

**Solution**: Application-level health monitoring with idle timeout.

**Implementation** (`src/server/tcpTransport.ts`):
- Track `lastDataReceived` timestamp
- Periodic health check every 60 seconds
- Configurable idle timeout (default: 5 minutes)
- Force reconnection if no data received within timeout period

**Configuration**:
```bash
# Set via environment variable (in milliseconds)
MESHTASTIC_STALE_CONNECTION_TIMEOUT=300000  # 5 minutes (default)
MESHTASTIC_STALE_CONNECTION_TIMEOUT=0       # Disable (not recommended)

# TCP connect/reconnect timing (for advanced troubleshooting)
MESHTASTIC_CONNECT_TIMEOUT_MS=10000         # Initial TCP connect timeout (default: 10s)
MESHTASTIC_RECONNECT_INITIAL_DELAY_MS=1000  # First reconnect delay (default: 1s)
MESHTASTIC_RECONNECT_MAX_DELAY_MS=60000     # Max reconnect delay cap (default: 60s)
# Reconnect uses exponential backoff: initial * 2^(attempt-1), capped at max
# Set initial = max for fixed delay (e.g., both = 60000 for 1-minute fixed delay)

# Module config request throttling
MESHTASTIC_MODULE_CONFIG_DELAY_MS=100       # Delay between config requests (default: 100ms)
# Increase to 250-1000ms if device shows queue overflow during config loading
```

**Why Needed**:
- Serial ports can enter half-open states
- USB disconnects may not trigger TCP errors
- Meshtastic devices can freeze without closing socket
- Docker serial passthrough adds failure points

**Symptoms of Stale Connection**:
- No incoming messages appear
- Outbound sends succeed but device doesn't respond
- Traceroute shows "no response"
- Manual reconnect fixes the issue

**Related**: Issue #492 - Serial-connected device stops responding after idle
**Related**: Issue #2213 - Configurable TCP connect/reconnect timing
**Related**: Issue #2214 - Configurable module config request delay

---

## State Management & Consistency

### Where State Lives

MeshMonitor state exists in multiple places:

1. **Database**: Persistent historical data
2. **In-memory caches**: Active sessions, pending operations
3. **Node-side configs**: Radio settings, channel configs
4. **Frontend state**: UI state, optimistic updates

**Critical Rule**: Database is source of truth. Caches are invalidated, not updated.

### Optimistic UI vs. Reality

**Pattern**: Show immediate feedback, but handle reality gracefully.

```typescript
// Frontend shows optimistic state
setNodeConfig({ power: 30 }); // Immediate UI update

// Backend tracks actual state
await sendConfigToNode(nodeId, { power: 30 });
// Show "pending" indicator
await waitForAck(timeout);
// Update to "confirmed" or "failed"
```

**Visual States**:
- Default (current confirmed state)
- Pending (sent, awaiting confirmation)
- Confirmed (ACK received)
- Failed (timeout/error)
- Stale (connection lost, state unknown)

### In-flight Operations

**Problem**: What happens to pending operations during shutdown, restart, or backup?

**Solutions**:
- Graceful shutdown: Wait for pending ops with timeout
- Crash recovery: Mark orphaned operations as `unknown` on restart
- Backup: Include pending operations with metadata
- Restore: Decide policy - retry, fail, or mark uncertain

---

## Node Communication Patterns

### Command Queue Architecture

**Requirement**: Serialize all commands to prevent conflicts.

**Implementation**:
```typescript
class NodeCommandQueue {
  private queue: Map<string, Operation[]>; // nodeId -> operations

  async enqueue(nodeId: string, operation: Operation) {
    // Add to node-specific queue
    // Process serially with backoff
  }

  private async processQueue(nodeId: string) {
    while (hasOperations(nodeId)) {
      const op = dequeue(nodeId);
      await executeWithRetry(op);
      await backoff(); // Prevent overwhelming node
    }
  }
}
```

### Update Ordering

**Critical**: Some operations have dependencies.

**Example Order Requirements**:
1. Config changes → Wait for ACK → Reboot (if needed)
2. Channel add → Wait for propagation → Send message
3. Position request → Wait for response → Update map

**Anti-pattern**: Sending multiple config changes simultaneously.

### Command vs. Config Semantics

**Commands** (ephemeral, usually safe to retry):
- Send text message
- Request position
- Request telemetry

**Configs** (persistent, retry carefully):
- Change radio power
- Modify channel settings
- Update node name

**Configs require**:
- Confirmation before retry
- User awareness of changes
- Rollback capability where possible

### Backoff & Retry Strategy

**Pattern**:
```typescript
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // ms
  maxDelay: 30000,
  multiplier: 2,
};

async function sendWithRetry(operation: Operation) {
  for (let i = 0; i < RETRY_CONFIG.maxRetries; i++) {
    try {
      return await send(operation);
    } catch (error) {
      if (i === RETRY_CONFIG.maxRetries - 1) throw error;

      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.multiplier, i),
        RETRY_CONFIG.maxDelay
      );
      await sleep(delay);
    }
  }
}
```

---

## Backup & Restore

### What to Backup

**Include**:
- Database schema version (for migration)
- All tables with relationships intact
- Configuration settings
- Metadata (backup timestamp, MeshMonitor version)

**Exclude**:
- Temporary data (in-flight operations)
- Cached data (can be regenerated)
- Session tokens (security risk)
- Secrets (.env files)

### Backup Format

**Requirements**:
- Version identifier
- Schema migrations
- Forward compatibility markers
- Integrity checksums

**Structure**:
```json
{
  "backupVersion": "1.0",
  "meshmonitorVersion": "2.13.0",
  "timestamp": "2025-01-15T10:30:00Z",
  "schemaVersion": 12,
  "checksum": "sha256:abc123...",
  "data": {
    "nodes": [...],
    "messages": [...],
    "telemetry": [...]
  }
}
```

### Restore Consistency

**Problem**: Restoring into a running system with active state.

**Safe Restore Process**:
1. Validate backup integrity
2. Check schema compatibility
3. Stop all background tasks
4. Clear in-memory caches
5. Restore database atomically
6. Migrate schema if needed
7. Restart background tasks
8. Mark all node states as "unknown" (must re-query)

**Critical**: Never restore directly into production without stopping services.

### Idempotency

**Requirement**: Restore should be safely retryable.

**Pattern**:
- Use transactions
- Check for existing data before insert
- Provide rollback mechanism
- Log all restore operations for audit

---

## Testing Strategy

### Virtual Node Power

**Lesson**: Testing with physical hardware is slow and unreliable.

**Solution**: Virtual Node with capture/replay (PR #429).

**Benefits**:
- Reproducible test scenarios
- No hardware dependency
- Fast iteration cycles
- Protocol validation

**Location**: `src/server/virtualNodeServer.ts`, `tests/test-virtual-node-cli.sh`

### Integration Testing is Critical

**Lesson**: Unit tests miss integration failures.

**Required Tests**:
- Full stack (Docker + API + Virtual Node)
- Connection stability
- Config handshake sequences
- Backup/restore cycles
- Long-running operations

**Location**: `tests/system-tests.sh`

### Test Before PR

**Policy**: Run `tests/system-tests.sh` before creating PR.

**Why**: Catches:
- Docker build issues
- API breaking changes
- Database migration problems
- Environment-specific bugs

---

## Background Task Management

### Lifecycle Management

**Requirements for Background Tasks**:
1. Graceful startup
2. Progress tracking
3. Cancellation support
4. Resource cleanup on crash
5. Logging for debugging

### Security Scanner Pattern

**Lesson**: Long-running scans need careful management.

**Implementation** (runs every 5 minutes):
- Non-blocking (doesn't interfere with main operations)
- Respects node availability
- Logs progress for visibility
- Handles failures gracefully

**Location**: Security scanner service

### Task Scheduling

**Pattern**:
```typescript
class BackgroundTask {
  private running: boolean = false;
  private handle: NodeJS.Timeout | null = null;

  start(intervalMs: number) {
    if (this.running) return;
    this.running = true;
    this.schedule(intervalMs);
  }

  private schedule(intervalMs: number) {
    this.handle = setTimeout(async () => {
      try {
        await this.execute();
      } catch (error) {
        logger.error('Task failed', error);
      } finally {
        if (this.running) {
          this.schedule(intervalMs);
        }
      }
    }, intervalMs);
  }

  stop() {
    this.running = false;
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }
}
```

---

## Multi-Database Architecture

### Overview

MeshMonitor v3.0+ supports three database backends: SQLite, PostgreSQL, and MySQL/MariaDB. This flexibility requires careful attention to database-agnostic patterns.

**Why Multiple Databases?**
- **SQLite**: Zero-config default, perfect for home users and Raspberry Pi
- **PostgreSQL**: Enterprise-grade for high-volume deployments (1000+ nodes)
- **MySQL/MariaDB**: Alternative for existing MySQL infrastructure

### Database Abstraction with Drizzle ORM

**Lesson**: Raw SQL queries break when switching databases.

**Solution**: Use Drizzle ORM for type-safe, database-agnostic queries.

**Architecture**:
```
DatabaseService (facade)
    ↓
Repositories (domain logic)
    ↓
Drizzle ORM (query building)
    ↓
Database Drivers (sqlite/postgres/mysql)
```

**Location**: `src/db/schema/`, `src/db/repositories/`, `src/services/database.ts`

### Async-First Pattern

**Problem**: SQLite with better-sqlite3 is synchronous, but PostgreSQL/MySQL are async.

**Solution**: ALL DatabaseService methods are async, regardless of backend.

**Pattern**:
```typescript
// ❌ DON'T: Synchronous methods
getNode(nodeNum: number): DbNode | undefined

// ✅ DO: Async methods with Async suffix
async getNodeAsync(nodeNum: number): Promise<DbNode | undefined>
```

**Critical**: When adding new database methods:
1. Name them with `Async` suffix
2. Return Promises
3. Use `await` at all call sites
4. Update tests to mock async versions

### Type Coercion Pitfalls

**Problem**: PostgreSQL BIGINT returns strings, MySQL returns BigInt objects, SQLite returns numbers.

**Lesson Learned**: Node IDs (which are large integers like `4294967295`) can cause type mismatches.

**Solution**: Always coerce to Number when comparing:
```typescript
// ❌ DON'T: Direct comparison
if (row.nodeNum === nodeNum)

// ✅ DO: Coerce to Number
if (Number(row.nodeNum) === Number(nodeNum))
```

**Location**: See `src/server/routes/packetRoutes.ts` for examples of BIGINT handling.

### Boolean Column Differences

**Problem**: SQLite stores booleans as 0/1, PostgreSQL uses true/false.

**Solution**: Drizzle handles this automatically when using schema-defined boolean columns.

**Pattern**:
```typescript
// Schema definition (Drizzle handles conversion)
isActive: integer('is_active', { mode: 'boolean' }).default(true)

// Query result is always JavaScript boolean
if (user.isActive) { ... }
```

### Database-Specific SQL

**Problem**: Some operations require different SQL syntax per database.

**Pattern**: Check `drizzleDbType` for database-specific code paths:
```typescript
if (this.drizzleDbType === 'sqlite') {
  // SQLite-specific: VACUUM, PRAGMA, etc.
} else if (this.drizzleDbType === 'postgres') {
  // PostgreSQL-specific: BIGINT casting, sequences
} else if (this.drizzleDbType === 'mysql') {
  // MySQL-specific: AUTO_INCREMENT, LIMIT syntax
}
```

**Common Differences**:
| Feature | SQLite | PostgreSQL | MySQL |
|---------|--------|------------|-------|
| Auto-increment | `AUTOINCREMENT` | `SERIAL` | `AUTO_INCREMENT` |
| Boolean | `INTEGER (0/1)` | `BOOLEAN` | `TINYINT(1)` |
| Upsert | `ON CONFLICT` | `ON CONFLICT` | `ON DUPLICATE KEY` |
| Case sensitivity | Case-insensitive | Case-sensitive | Configurable |

### Schema Definition Strategy

**Lesson**: Maintain a single source of truth for schema that works across all databases.

**Pattern**: Define schema in `src/db/schema/` using Drizzle's database-agnostic types:
```typescript
// src/db/schema/nodes.ts
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
// OR for PostgreSQL: import from 'drizzle-orm/pg-core';
// OR for MySQL: import from 'drizzle-orm/mysql-core';

export const nodes = sqliteTable('nodes', {
  nodeNum: integer('nodeNum').primaryKey(),
  nodeId: text('nodeId').notNull().unique(),
  // ...
});
```

**Note**: Currently schema files are per-database-type. Future work may unify to single schema.

### Cache Synchronization

**Problem**: In-memory caches must stay in sync with database across all backends.

**Solution**: Every database write that affects cached data must update the cache.

**Pattern**:
```typescript
async updateNodeAsync(nodeNum: number, data: Partial<DbNode>): Promise<void> {
  // 1. Update database
  await this.nodesRepository.update(nodeNum, data);

  // 2. Invalidate/update cache
  this.nodeCache.delete(nodeNum);
  // OR: this.nodeCache.set(nodeNum, { ...existing, ...data });
}
```

**Location**: See `src/services/database.ts` for cache sync patterns.

### Migration Between Databases

**Lesson**: Users need to migrate existing SQLite data to PostgreSQL/MySQL.

**Solution**: Migration CLI tool that handles schema and data transfer.

**Location**: `src/cli/migrate-db.ts`

**Key Considerations**:
- Schema must be created fresh on target (don't copy SQLite schema)
- Handle auto-increment sequence reset after bulk insert
- Validate data integrity with row counts
- Provide verbose logging for troubleshooting

### Migration Registry System

**Problem**: The old migration system required adding migration calls in 3 separate places in `database.ts` (SQLite init, Postgres init, MySQL init), which was error-prone and hard to maintain.

**Solution**: Centralized `MigrationRegistry` in `src/db/migrations.ts`. Each migration is registered once with functions for all three backends.

**Architecture**:
```
src/db/
  migrations.ts          # Registry barrel - imports and registers all migrations
  migrationRegistry.ts   # MigrationRegistry class (runner logic)
src/server/migrations/
  001_v37_baseline.ts    # v3.7 baseline (selfIdempotent)
  002_*.ts - 013_*.ts    # Incremental migrations
```

**Pattern for new migrations** (e.g., migration 014):
```typescript
// src/server/migrations/014_description.ts
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// SQLite
export const migration = {
  up: (db: Database): void => {
    try {
      db.exec('ALTER TABLE foo ADD COLUMN bar TEXT');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('foo.bar already exists, skipping');
      } else { throw e; }
    }
  },
  down: (_db: Database): void => {}
};

// PostgreSQL
export async function runMigration014Postgres(client: import('pg').PoolClient): Promise<void> {
  await client.query('ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar TEXT');
}

// MySQL
export async function runMigration014Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'foo' AND COLUMN_NAME = 'bar'
  `);
  if (!Array.isArray(rows) || rows.length === 0) {
    await pool.query('ALTER TABLE foo ADD COLUMN bar TEXT');
  }
}
```

Then register in `src/db/migrations.ts`:
```typescript
import { migration as descriptionMigration, runMigration014Postgres, runMigration014Mysql } from '../server/migrations/014_description.js';

registry.register({
  number: 14,
  name: 'description',
  settingsKey: 'migration_014_description',
  sqlite: (db) => descriptionMigration.up(db),
  postgres: (client) => runMigration014Postgres(client),
  mysql: (pool) => runMigration014Mysql(pool),
});
```

**Key Rules**:
- Migration 001 is `selfIdempotent` (detects existing v3.7+ databases). All others use `settingsKey` for tracking.
- Migrations MUST be idempotent: SQLite uses try/catch (`duplicate column`), PostgreSQL uses `IF NOT EXISTS`, MySQL uses `information_schema` checks.
- Column naming: SQLite uses `snake_case`, PostgreSQL/MySQL use `camelCase` (quoted `"camelCase"` in raw PG SQL).
- Update `src/db/migrations.test.ts` when adding migrations (count, last migration assertions).

### Test Mocking for Multi-Database

**Problem**: Tests that mock DatabaseService fail when auth middleware calls async methods.

**Lesson Learned**: Auth middleware uses `findUserByIdAsync`, `checkPermissionAsync`, etc.

**Solution**: All test files mocking DatabaseService must include async method mocks:
```typescript
vi.mock('../../services/database.js', () => ({
  default: {
    // ... other mocks ...
    // REQUIRED for auth middleware
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

beforeEach(() => {
  mockDatabase.findUserByIdAsync.mockResolvedValue(testUser);
  mockDatabase.checkPermissionAsync.mockResolvedValue(true);
  // ...
});
```

**Reference**: PR #1436 - async test mock fixes

---

## Summary: Critical Design Principles

1. **Assume Async**: Everything involving nodes AND databases is asynchronous. Plan for it.

2. **Queue Everything**: Serial command processing prevents conflicts and race conditions.

3. **Track State**: Always know what operations are pending and their status.

4. **Timeout Everything**: No operation should wait forever.

5. **Backend is Orchestrator**: Frontend shows UI, backend manages reality.

6. **Test Integration**: Unit tests aren't enough for distributed systems.

7. **Version Everything**: Backups, schemas, APIs - version them all.

8. **Graceful Degradation**: Handle failures without breaking the entire system.

9. **Idempotency**: Operations should be safely retryable.

10. **Log Everything**: You can't debug what you can't see.

11. **Database Agnostic**: Use Drizzle ORM, async methods, and type coercion for multi-database support.

12. **Test Mock Completeness**: Mock ALL async database methods that auth middleware needs.

---

## When to Reference This Document

- Before implementing new node communication features
- When designing state management systems
- Before building backup/restore functionality
- When troubleshooting timeout or ACK issues
- During architectural reviews
- When onboarding new developers
- **Before adding or modifying database methods**
- **When tests fail with async/mock issues**
- **Before adding PostgreSQL/MySQL specific features**

---

## Key Management & PKI

### Key Authority Model

**Problem**: A node's public key can come from two sources: the connected device's local database (device sync) and mesh-received NodeInfo packets. These can disagree after a remote node regenerates its key.

**Rule**: Mesh-received keys are authoritative. Device-synced keys may be stale.

**Implementation** (PR #2243):
- `lastMeshReceivedKey` field tracks keys received via mesh NodeInfo
- `keyMismatchDetected` flag marks nodes where device key ≠ mesh key
- Mismatch detection in `processNodeInfoMessageProtobuf`
- Resolution in device DB sync when device picks up the new key

### Key Repair Channel Routing

**Problem**: When keys are mismatched, PKI-encrypted DMs fail because they use the wrong (old) key.

**Solution**: Send key repair NodeInfo exchanges on the node's **channel** (shared PSK), not as DMs.

```typescript
// ✅ DO: Use the node's channel for key repair
const nodeData = databaseService.getNode(nodeNum);
await this.sendNodeInfoRequest(nodeNum, nodeData?.channel ?? 0);

// ❌ DON'T: Hardcode channel 0 (DM with PKI encryption)
await this.sendNodeInfoRequest(nodeNum, 0);
```

**Location**: `src/server/meshtasticManager.ts` — `processKeyRepairs()` and immediate purge path

### PKI Error Detection

**Problem**: PKI routing errors (`PKI_UNKNOWN_PUBKEY`, `PKI_SEND_FAIL_PUBLIC_KEY`, `PKI_FAILED`) should always flag `keyMismatchDetected` on the target node.

**Rule**: Never suppress PKI error detection based on device DB state. All three PKI errors must trigger key mismatch detection regardless of whether the target node is in the radio's local database. The mismatch flag clears naturally when keys are re-synced (via NodeInfo exchange or device sync).

**Anti-pattern**: Don't gate PKI error handling on `isNodeInDeviceDb()` — the radio not having the node is exactly the scenario where `PKI_UNKNOWN_PUBKEY` fires.

**Location**: `src/server/meshtasticManager.ts` — `processRoutingErrorMessage()`, both Path A (request packets) and Path B (message-tracked packets).

**Helper**: `isPkiError(errorReason)` in `src/server/constants/meshtastic.ts` classifies all three PKI error codes.

### Settings Allowlist

**Problem**: New settings silently fail to save if not added to the allowlist.

**Rule**: When adding any new setting key that gets saved via `POST /api/settings`, add it to `VALID_SETTINGS_KEYS` in `src/server/constants/settings.ts`.

**Location**: `src/server/constants/settings.ts`

---

## Multi-Source Architecture

MeshMonitor 4.0 (April 2026, PR #2611) replaced the singleton `meshtasticManager` with a **per-source manager registry**, letting one MeshMonitor instance run N concurrent Meshtastic node connections side-by-side.

### Why Multi-Source

A single user often runs multiple radios — a home base, a vehicle gateway, a remote site. Pre-4.0 you'd run a separate MeshMonitor instance per radio with separate databases. 4.0 unifies them into one instance with one database, where every row carries a `sourceId` foreign key and pages either render one source at a time (`SourceProvider` wrap) or aggregate across sources (`Unified*Page`).

### Manager Registry

`src/server/sourceManagerRegistry.ts` maps `sourceId → MeshtasticManager` (or `MeshcoreManager` for the Meshcore protocol). Every server-side caller looks up the right manager by `sourceId`:

```ts
const manager = sourceManagerRegistry.getManager(sourceId);
const localNode = manager.getLocalNodeInfo();      // not meshtasticManager.getLocalNodeInfo()
```

The legacy `meshtasticManager` import is now a deprecated compatibility shim for callers that haven't been ported. `tsc` flags every reference as `[6385] deprecated`.

### Source Lifecycle

A source progresses through:

1. **Registered** — row in `sources` table; user provided host/port/auth.
2. **Connecting** — manager instantiated; TCP socket opened; protobuf config requested.
3. **Configuring** — receiving `Config`, `ModuleConfig`, `Channel`, and node DB packets from the device.
4. **Ready** — `localNodeInfo` populated; manager handling normal traffic.
5. **Reconnecting** — exponential backoff on socket close. Initial=2s, max=60s. Configurable via env vars (see Asynchronous Operations §).

The registry exposes `getStatus(sourceId)` to surface this state to the UI.

### The "Default Source" Concept

Pre-4.0 rows had no `sourceId`. Migration `050_promote_globals_to_default_source` back-fills every `NULL sourceId` to the first registered source (or creates a placeholder source if none exists). After 050, every row has a non-null `sourceId` and downstream queries can rely on the FK.

### Migrations 020–052: the Source-Scoping Push

Roughly two-thirds of all migrations are source-scoping work:

- **020–028, 037, 048** — add `sourceId` columns to existing per-source tables (nodes, messages, telemetry, traceroutes, neighbor_info, channels, key_repair_log, ignored_nodes, distance_delete_log, time_sync_nodes, embed_profiles).
- **022, 033** — per-source permissions (`permissions.sourceId`, then per-resource refinement).
- **029** — composite PK `(nodeNum, sourceId)` on `nodes` so the same nodeNum heard by two sources doesn't collide.
- **039–045** — `drop_legacy_*_nodes_fk`. These look alarming but are routine: each one drops a single-column FK that pointed at the old `nodes` PK, after the composite-PK refactor in 029. They had to land separately because each FK was created in a different earlier migration.
- **050** — back-fill globals to default source (described above).
- **051–052** — final source scoping for notification preferences and embed profiles.

When you see a migration named `add_source_id_to_<table>` or `drop_legacy_<table>_nodes_fk`, this is the lineage.

### Source-Scoped Query Convention

Repositories that touch per-source data take an optional `sourceId?: string` parameter and apply it via `withSourceScope` (in `src/db/repositories/base.ts`):

```ts
async getMessagesByChannel(channel: number, limit = 100, offset = 0, sourceId?: string) {
  return this.db.select().from(messages).where(
    and(eq(messages.channel, channel), this.withSourceScope(messages, sourceId))
  ).limit(limit).offset(offset);
}
```

`withSourceScope` returns `eq(table.sourceId, sourceId)` when `sourceId` is provided, else `undefined` (Drizzle `and(...)` ignores undefined entries). This keeps backward compatibility for legacy unscoped callers while letting new code opt in.

**Counts and aggregations are the most common bug.** Per-source unread badges, pending-ACK counts, and node totals all need the `sourceId` predicate or they bleed across sources.

### Permissions Are Per-Source

`permissions.sourceId` is part of the row. `requirePermission(resource, action)` middleware looks up the calling user's permission set scoped to the route's `sourceId` (read from path params or body). A user can be admin on one source and have read-only on another.

Tests that mock `getUserPermissionSetAsync` must mock the `(userId, sourceId)` signature, not the legacy `(userId)` signature, or the source-scoping branch silently falls through.

### Frontend Source Awareness

`src/contexts/SourceContext.tsx` exposes `useSource()` returning `{ sourceId, sourceName }`. Pages mounted under `/source/:sourceId/*` are wrapped in a `SourceProvider`, so any descendant calling `useSource()` gets the active source. Pages outside `SourceProvider` (Dashboard, Unified*) get `sourceId === null` and are expected to fan out across sources explicitly via `useSources()`.

`Unified*Page` components are the cross-source view layer. Anything they render that says "messages" or "telemetry" is across-all-sources by design; the per-source view lives under `/source/:sourceId/...`.

### Key Repair / NodeInfo Exchange Caveat

Auto-key-management, immediate purge, and the manual key-repair button all send a NodeInfo exchange. This **must go on the node's channel**, not as a DM, because PKI-encrypted DMs use the stored (mismatched) key. Channel routing uses the shared PSK and works regardless. This is enforced in the `meshtasticManager.sendNodeInfoExchange` path.

### Critical Design Principles

- **Look up managers by sourceId; don't import `meshtasticManager` directly.**
- **Pass `sourceId` through every layer** — frontend → route → service → repository → query.
- **Multi-source is observable in tests.** Any feature that reads per-source data needs a `*.perSource.test.ts` file proving cross-source isolation.
- **Cross-source aggregation is opt-in,** never the default.

---

**Last Updated**: 2026-03-22
**Related PRs**: #427, #429, #430, #431, #432, #433, #1359 (packet filtering), #1360 (protocol constants), #1404 (PostgreSQL support), #1405 (MySQL support), #1436 (async test fixes), #2243 (key mismatch detection), #2246 (neighbor info zoom setting), #2365 (key mismatch clearing), #2382 (PKI error detection)
