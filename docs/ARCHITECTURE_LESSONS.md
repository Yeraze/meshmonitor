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

**Location**: `src/services/telemetry.ts` - NodeInfo handling (PR #427)

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

**Reference**: Virtual Node implementation - `src/services/virtualNode.ts`

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
  "version": "2.0",
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

**Location**: `src/services/virtualNode.ts`, `tests/test-virtual-node-cli.sh`

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

**Last Updated**: 2026-01-12
**Related PRs**: #427, #429, #430, #431, #432, #433, #1359 (packet filtering), #1360 (protocol constants), #1404 (PostgreSQL support), #1405 (MySQL support), #1436 (async test fixes)
