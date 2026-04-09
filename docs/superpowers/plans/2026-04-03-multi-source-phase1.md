# Multi-Source Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation for multi-source support: ITransport interface, sources table, SourceManagerRegistry, and MeshtasticManager constructor refactored to accept sourceId + ITransport. Single-node behavior unchanged.

**Architecture:** Extract an `ITransport` interface from `TcpTransport`. Create a `sources` database table with CRUD API. Build a `SourceManagerRegistry` that wraps MeshtasticManager instances. Refactor MeshtasticManager's constructor to accept `sourceId` and an injected transport. On startup, auto-create a "Default" source from env vars if none exist, preserving backward compatibility.

**Tech Stack:** TypeScript, Drizzle ORM (SQLite/PostgreSQL/MySQL), Express, vitest

---

### Task 1: Create ITransport interface and refactor TcpTransport

**Files:**
- Create: `src/server/transports/transport.ts`
- Modify: `src/server/tcpTransport.ts` (add `implements ITransport`)
- Modify: `src/server/meshtasticManager.ts` (import ITransport type)

- [ ] **Step 1: Create ITransport interface**

Create `src/server/transports/transport.ts`:

```typescript
import { EventEmitter } from 'events';

/**
 * Transport interface for Meshtastic communication.
 * Implementations handle the connection and framing protocol.
 *
 * Events emitted:
 * - 'connect' — connection established
 * - 'disconnect' — connection lost
 * - 'message' (data: Uint8Array) — complete message received
 * - 'error' (error: Error) — transport error
 * - 'stale-connection' (info: object) — connection appears stale
 */
export interface ITransport extends EventEmitter {
  connect(host: string, port?: number): Promise<void>;
  disconnect(): void;
  send(data: Uint8Array): Promise<void>;
  getConnectionState(): boolean;
  getReconnectAttempts(): number;
}
```

- [ ] **Step 2: Make TcpTransport implement ITransport**

In `src/server/tcpTransport.ts`, add the import and implements clause:

```typescript
import { ITransport } from './transports/transport.js';
```

Change the class declaration from:
```typescript
export class TcpTransport extends EventEmitter {
```
to:
```typescript
export class TcpTransport extends EventEmitter implements ITransport {
```

- [ ] **Step 3: Update MeshtasticManager import**

In `src/server/meshtasticManager.ts`, add the ITransport import (after the TcpTransport import on line 5):

```typescript
import type { ITransport } from './transports/transport.js';
```

Change the `transport` property type (line ~282) from:
```typescript
private transport: TcpTransport | null = null;
```
to:
```typescript
private transport: ITransport | null = null;
```

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

Expected: No errors. TcpTransport already has all the methods ITransport requires.

- [ ] **Step 5: Commit**

```bash
git add src/server/transports/transport.ts src/server/tcpTransport.ts src/server/meshtasticManager.ts
git commit -m "refactor: extract ITransport interface from TcpTransport (4.0 Phase 1)"
```

---

### Task 2: Create sources database schema and migration

**Files:**
- Create: `src/db/schema/sources.ts`
- Modify: `src/db/activeSchema.ts` (register new tables)
- Create: `src/server/migrations/020_create_sources.ts`
- Modify: `src/db/migrations.ts` (register migration 020)
- Modify: `src/db/migrations.test.ts` (update count)

- [ ] **Step 1: Create sources schema**

Create `src/db/schema/sources.ts`:

```typescript
/**
 * Drizzle schema definition for the sources table
 * Stores configured data sources (Meshtastic TCP nodes, MQTT brokers, MeshCore devices)
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite schema
export const sourcesSqlite = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'meshtastic_tcp' | 'mqtt' | 'meshcore'
  config: text('config').notNull(), // JSON blob
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  createdBy: integer('createdBy'),
});

// PostgreSQL schema
export const sourcesPostgres = pgTable('sources', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  type: pgText('type').notNull(),
  config: pgText('config').notNull(),
  enabled: pgBoolean('enabled').notNull().default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  createdBy: pgInteger('createdBy'),
});

// MySQL schema
export const sourcesMysql = mysqlTable('sources', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull(),
  type: myVarchar('type', { length: 32 }).notNull(),
  config: myVarchar('config', { length: 4096 }).notNull(),
  enabled: myBoolean('enabled').notNull().default(true),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  createdBy: myInt('createdBy'),
});

// Type inference
export type SourceSqlite = typeof sourcesSqlite.$inferSelect;
export type NewSourceSqlite = typeof sourcesSqlite.$inferInsert;
export type SourcePostgres = typeof sourcesPostgres.$inferSelect;
export type NewSourcePostgres = typeof sourcesPostgres.$inferInsert;
export type SourceMysql = typeof sourcesMysql.$inferSelect;
export type NewSourceMysql = typeof sourcesMysql.$inferInsert;
```

- [ ] **Step 2: Register schema in activeSchema.ts**

In `src/db/activeSchema.ts`, import the new tables and add them to the schema maps for each database type. Follow the pattern of existing tables (search for `channels` or `nodes` to see the registration pattern).

- [ ] **Step 3: Create migration 020**

Create `src/server/migrations/020_create_sources.ts`:

```typescript
import type Database from 'better-sqlite3';

export const migration = {
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        createdBy INTEGER
      )
    `);
  }
};

export async function runMigration020Postgres(client: any): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL,
      "createdBy" INTEGER
    )
  `);
}

export async function runMigration020Mysql(pool: any): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'sources'`
    );
    if (rows[0].cnt === 0) {
      await conn.query(`
        CREATE TABLE sources (
          id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(32) NOT NULL,
          config VARCHAR(4096) NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          createdAt BIGINT NOT NULL,
          updatedAt BIGINT NOT NULL,
          createdBy INTEGER
        )
      `);
    }
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 4: Register migration in migrations.ts**

In `src/db/migrations.ts`, import and register migration 020 after migration 019:

```typescript
import { migration as createSourcesMigration, runMigration020Postgres, runMigration020Mysql } from '../server/migrations/020_create_sources.js';

registry.register({
  number: 20,
  name: 'create_sources',
  settingsKey: 'migration_020_create_sources',
  sqlite: (db) => createSourcesMigration.up(db),
  postgres: (client) => runMigration020Postgres(client),
  mysql: (pool) => runMigration020Mysql(pool),
});
```

- [ ] **Step 5: Update migration test count**

In `src/db/migrations.test.ts`, update the migration count and last migration name to reflect migration 020.

- [ ] **Step 6: Type check and run tests**

```bash
npx tsc --noEmit
./node_modules/.bin/vitest run src/db/migrations.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/db/schema/sources.ts src/db/activeSchema.ts src/server/migrations/020_create_sources.ts src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat: add sources table schema and migration 020 (4.0 Phase 1)"
```

---

### Task 3: Create sources repository

**Files:**
- Create: `src/db/repositories/sources.ts`
- Modify: `src/services/database.ts` (expose repository)

- [ ] **Step 1: Create SourcesRepository**

Create `src/db/repositories/sources.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { BaseRepository } from './base.js';
import { logger } from '../../utils/logger.js';

export interface Source {
  id: string;
  name: string;
  type: 'meshtastic_tcp' | 'mqtt' | 'meshcore';
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: number | null;
}

export interface CreateSourceInput {
  id: string;
  name: string;
  type: Source['type'];
  config: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: number;
}

export class SourcesRepository extends BaseRepository {

  async getAllSources(): Promise<Source[]> {
    const rows = await this.executeQuery(
      this.db.select().from(this.tables.sources)
    );
    return rows.map((r: any) => this.toSource(r));
  }

  async getEnabledSources(): Promise<Source[]> {
    const rows = await this.executeQuery(
      this.db.select().from(this.tables.sources).where(eq(this.tables.sources.enabled, true))
    );
    return rows.map((r: any) => this.toSource(r));
  }

  async getSource(id: string): Promise<Source | null> {
    const rows = await this.executeQuery(
      this.db.select().from(this.tables.sources).where(eq(this.tables.sources.id, id))
    );
    return rows.length > 0 ? this.toSource(rows[0]) : null;
  }

  async createSource(input: CreateSourceInput): Promise<Source> {
    const now = Date.now();
    const row = {
      id: input.id,
      name: input.name,
      type: input.type,
      config: JSON.stringify(input.config),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    };
    await this.executeRun(
      this.db.insert(this.tables.sources).values(row)
    );
    logger.info(`✅ Created source: ${input.name} (${input.type})`);
    return this.toSource(row);
  }

  async updateSource(id: string, updates: Partial<Pick<Source, 'name' | 'config' | 'enabled'>>): Promise<Source | null> {
    const setValues: any = { updatedAt: Date.now() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.config !== undefined) setValues.config = JSON.stringify(updates.config);
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

    await this.executeRun(
      this.db.update(this.tables.sources).set(setValues).where(eq(this.tables.sources.id, id))
    );
    return this.getSource(id);
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.executeRun(
      this.db.delete(this.tables.sources).where(eq(this.tables.sources.id, id))
    );
    const affected = this.getAffectedRows(result);
    if (affected > 0) {
      logger.info(`🗑️ Deleted source: ${id}`);
    }
    return affected > 0;
  }

  async getSourceCount(): Promise<number> {
    const rows = await this.getAllSources();
    return rows.length;
  }

  private toSource(row: any): Source {
    return {
      id: row.id,
      name: row.name,
      type: row.type as Source['type'],
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      enabled: Boolean(row.enabled),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      createdBy: row.createdBy ? Number(row.createdBy) : null,
    };
  }
}
```

- [ ] **Step 2: Expose repository in DatabaseService**

In `src/services/database.ts`, import `SourcesRepository` and add it alongside the other repositories. Follow the pattern of existing repositories (search for `NodesRepository` or `ChannelsRepository` to see how they're instantiated and exposed).

Add a `sources` getter property that returns the `SourcesRepository` instance, matching the pattern of `get nodes()`, `get channels()`, etc.

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/db/repositories/sources.ts src/services/database.ts
git commit -m "feat: add SourcesRepository with CRUD operations (4.0 Phase 1)"
```

---

### Task 4: Create sources REST API

**Files:**
- Create: `src/server/routes/sourceRoutes.ts`
- Modify: `src/server/server.ts` (mount routes)
- Modify: `src/types/permission.ts` (add 'sources' resource type)

- [ ] **Step 1: Add 'sources' resource type**

In `src/types/permission.ts`, add `'sources'` to the `ResourceType` union type.

- [ ] **Step 2: Create sourceRoutes.ts**

Create `src/server/routes/sourceRoutes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// List all sources
router.get('/', requirePermission('sources', 'read'), async (_req: Request, res: Response) => {
  try {
    const sources = await databaseService.sources.getAllSources();
    res.json(sources);
  } catch (error) {
    logger.error('Error listing sources:', error);
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

// Get single source
router.get('/:id', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json(source);
  } catch (error) {
    logger.error('Error fetching source:', error);
    res.status(500).json({ error: 'Failed to fetch source' });
  }
});

// Create source
router.post('/', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, type, config, enabled } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required and must be a string' });
    }
    if (!['meshtastic_tcp', 'mqtt', 'meshcore'].includes(type)) {
      return res.status(400).json({ error: 'type must be meshtastic_tcp, mqtt, or meshcore' });
    }
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config is required and must be an object' });
    }

    const source = await databaseService.sources.createSource({
      id: uuidv4(),
      name: name.trim(),
      type,
      config,
      enabled: enabled !== false,
      createdBy: req.user?.id,
    });

    res.status(201).json(source);
  } catch (error) {
    logger.error('Error creating source:', error);
    res.status(500).json({ error: 'Failed to create source' });
  }
});

// Update source
router.put('/:id', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, config, enabled } = req.body;
    const updates: any = {};
    if (name !== undefined) updates.name = name.trim();
    if (config !== undefined) updates.config = config;
    if (enabled !== undefined) updates.enabled = enabled;

    const source = await databaseService.sources.updateSource(req.params.id, updates);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json(source);
  } catch (error) {
    logger.error('Error updating source:', error);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

// Delete source
router.delete('/:id', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const deleted = await databaseService.sources.deleteSource(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting source:', error);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

export default router;
```

- [ ] **Step 3: Mount routes in server.ts**

In `src/server/server.ts`, import and mount the source routes on the API router:

```typescript
import sourceRoutes from './routes/sourceRoutes.js';
```

Mount alongside other routes (search for `apiRouter.use` to find the right area):

```typescript
apiRouter.use('/sources', sourceRoutes);
```

- [ ] **Step 4: Add uuid dependency if not present**

```bash
npm list uuid || npm install uuid --legacy-peer-deps
```

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/sourceRoutes.ts src/server/server.ts src/types/permission.ts
git commit -m "feat: add sources REST API with CRUD endpoints (4.0 Phase 1)"
```

---

### Task 5: Create SourceManagerRegistry

**Files:**
- Create: `src/server/sourceManagerRegistry.ts`

- [ ] **Step 1: Create SourceManagerRegistry**

Create `src/server/sourceManagerRegistry.ts`:

```typescript
import { EventEmitter } from 'events';
import type { ITransport } from './transports/transport.js';
import type { Source } from '../db/repositories/sources.js';
import { logger } from '../utils/logger.js';

/**
 * Status of a managed source
 */
export interface SourceStatus {
  sourceId: string;
  sourceName: string;
  sourceType: Source['type'];
  connected: boolean;
  nodeNum?: number;
  nodeId?: string;
}

/**
 * Interface that all source managers must implement
 */
export interface ISourceManager {
  readonly sourceId: string;
  readonly sourceType: Source['type'];
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SourceStatus;
}

/**
 * Registry that manages the lifecycle of source manager instances.
 * Replaces the singleton pattern — each source gets its own manager.
 */
export class SourceManagerRegistry extends EventEmitter {
  private managers: Map<string, ISourceManager> = new Map();

  /**
   * Register and start a source manager
   */
  async addManager(manager: ISourceManager): Promise<void> {
    if (this.managers.has(manager.sourceId)) {
      throw new Error(`Source manager already registered: ${manager.sourceId}`);
    }
    this.managers.set(manager.sourceId, manager);
    logger.info(`📡 Registered source manager: ${manager.sourceId} (${manager.sourceType})`);

    try {
      await manager.start();
    } catch (error) {
      logger.error(`❌ Failed to start source manager ${manager.sourceId}:`, error);
      // Keep it registered but not started — user can retry
    }
  }

  /**
   * Stop and remove a source manager
   */
  async removeManager(sourceId: string): Promise<void> {
    const manager = this.managers.get(sourceId);
    if (!manager) return;

    try {
      await manager.stop();
    } catch (error) {
      logger.error(`❌ Error stopping source manager ${sourceId}:`, error);
    }
    this.managers.delete(sourceId);
    logger.info(`🗑️ Removed source manager: ${sourceId}`);
  }

  /**
   * Get a specific source manager
   */
  getManager(sourceId: string): ISourceManager | undefined {
    return this.managers.get(sourceId);
  }

  /**
   * Get all registered source managers
   */
  getAllManagers(): ISourceManager[] {
    return Array.from(this.managers.values());
  }

  /**
   * Get status of all sources
   */
  getAllStatuses(): SourceStatus[] {
    return this.getAllManagers().map(m => m.getStatus());
  }

  /**
   * Stop all managers (for shutdown)
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.managers.keys()).map(id => this.removeManager(id));
    await Promise.allSettled(promises);
    logger.info('🛑 All source managers stopped');
  }

  /**
   * Number of registered managers
   */
  get size(): number {
    return this.managers.size;
  }
}

// Singleton registry instance
export const sourceManagerRegistry = new SourceManagerRegistry();
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sourceManagerRegistry.ts
git commit -m "feat: add SourceManagerRegistry for multi-source lifecycle management (4.0 Phase 1)"
```

---

### Task 6: Refactor MeshtasticManager constructor and auto-create default source

**Files:**
- Modify: `src/server/meshtasticManager.ts` (constructor accepts sourceId, connect accepts ITransport)
- Modify: `src/server/server.ts` (use registry, auto-create default source)

- [ ] **Step 1: Add sourceId to MeshtasticManager**

In `src/server/meshtasticManager.ts`:

1. Add `sourceId` as a class property (near the other private fields around line 282):
```typescript
public readonly sourceId: string;
```

2. Change the constructor to accept optional sourceId:
```typescript
constructor(sourceId: string = 'default') {
  this.sourceId = sourceId;
  // ... rest of existing constructor unchanged
```

3. Keep the singleton export for now (line 11786) — it creates with `sourceId = 'default'`.

- [ ] **Step 2: Make connect() accept an optional ITransport**

Change the `connect()` method signature from:
```typescript
async connect(): Promise<boolean> {
```
to:
```typescript
async connect(injectedTransport?: ITransport): Promise<boolean> {
```

Inside the method, change the transport creation (line 578) from:
```typescript
this.transport = new TcpTransport();
```
to:
```typescript
this.transport = injectedTransport || new TcpTransport();
```

Only configure transport timing if it's a TcpTransport (the timing methods are TCP-specific):
```typescript
if (this.transport instanceof TcpTransport) {
  const env = getEnvironmentConfig();
  this.transport.setStaleConnectionTimeout(env.meshtasticStaleConnectionTimeout);
  this.transport.setConnectTimeout(env.meshtasticConnectTimeoutMs);
  this.transport.setReconnectTiming(env.meshtasticReconnectInitialDelayMs, env.meshtasticReconnectMaxDelayMs);
}
```

- [ ] **Step 3: Implement ISourceManager on MeshtasticManager**

Add the import and implements:
```typescript
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
```

Change class declaration:
```typescript
class MeshtasticManager implements ISourceManager {
```

Add the required properties and methods:
```typescript
get sourceType(): 'meshtastic_tcp' {
  return 'meshtastic_tcp';
}

async start(): Promise<void> {
  await this.connect();
}

async stop(): Promise<void> {
  this.disconnect();
}

getStatus(): SourceStatus {
  return {
    sourceId: this.sourceId,
    sourceName: this.sourceId,
    sourceType: this.sourceType,
    connected: this.isConnected,
    nodeNum: this.localNodeInfo?.nodeNum,
    nodeId: this.localNodeInfo?.nodeId,
  };
}
```

Note: `disconnect()` already exists on the class.

- [ ] **Step 4: Wire up auto-source creation and registry in server.ts**

In `src/server/server.ts`:

1. Import the registry and uuid:
```typescript
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { v4 as uuidv4 } from 'uuid';
```

2. In the startup sequence (around line 486-497), replace the direct `meshtasticManager.connect()` call with:

```typescript
// Auto-create default source if none exist
const sourceCount = await databaseService.sources.getSourceCount();
if (sourceCount === 0) {
  const env = getEnvironmentConfig();
  if (env.meshtasticNodeIp) {
    const defaultSource = await databaseService.sources.createSource({
      id: uuidv4(),
      name: 'Default',
      type: 'meshtastic_tcp',
      config: { host: env.meshtasticNodeIp, port: env.meshtasticTcpPort },
      enabled: true,
    });
    logger.info(`📡 Auto-created default source from environment: ${defaultSource.name}`);
  }
}

// Start all enabled sources via the registry
const enabledSources = await databaseService.sources.getEnabledSources();
for (const source of enabledSources) {
  if (source.type === 'meshtastic_tcp') {
    const manager = new MeshtasticManager(source.id);
    await sourceManagerRegistry.addManager(manager);
  }
}

// Backward compat: if no sources configured, still use the singleton directly
if (enabledSources.length === 0) {
  await meshtasticManager.connect();
  logger.debug('Meshtastic manager connected (legacy mode, no sources configured)');
} else {
  logger.debug(`Started ${enabledSources.length} source manager(s) via registry`);
}

// Keep global reference for backward compat (routes still use it)
(global as any).meshtasticManager = enabledSources.length > 0
  ? sourceManagerRegistry.getManager(enabledSources[0].id) || meshtasticManager
  : meshtasticManager;
```

- [ ] **Step 5: Type check and run tests**

```bash
npx tsc --noEmit
./node_modules/.bin/vitest run --reporter=dot > /tmp/vitest-phase1.txt 2>&1
```

Wait for completion and check:
```bash
tail -5 /tmp/vitest-phase1.txt
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/meshtasticManager.ts src/server/server.ts
git commit -m "feat: refactor MeshtasticManager to accept sourceId and ITransport, auto-create default source (4.0 Phase 1)"
```

---

### Task 7: Build, deploy, and verify

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: Run full test suite**

```bash
./node_modules/.bin/vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Build and deploy**

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build meshmonitor-sqlite
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d meshmonitor-sqlite
```

- [ ] **Step 4: Verify backward compatibility**

1. Check logs: `docker compose -f docker-compose.dev.yml logs --tail=20 meshmonitor-sqlite` — should show "Auto-created default source" and successful connection
2. Verify the API: `./scripts/api-test.sh login && ./scripts/api-test.sh get /api/sources` — should return one source
3. Verify existing functionality works (nodes, messages, traceroutes, etc.)

- [ ] **Step 5: Push**

```bash
git push -u origin feature/4.0
```
