# Embeddable Map Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow MeshMonitor admins to create embeddable map iframes with configurable channels, tileset, center/zoom, and interactivity options.

**Architecture:** Server-side embed profiles stored in the database, served via a separate Vite entry point (`embed.html`). Each profile gets a unique UUID URL. A new embed middleware handles per-profile CSP `frame-ancestors` and CORS. The embed page polls the existing `/api/nodes/active` endpoint using anonymous user permissions.

**Tech Stack:** React + Leaflet (embed entry point), Express routes, Drizzle ORM (SQLite/Postgres/MySQL), Vitest + Supertest for testing.

**Design doc:** `docs/plans/2026-02-27-embed-map-design.md`

---

## Task 1: Database Schema for Embed Profiles

**Files:**
- Create: `src/db/schema/embedProfiles.ts`

**Step 1: Write the schema file**

Follow the pattern from `src/db/schema/settings.ts`. Create three table definitions (SQLite, Postgres, MySQL) and type exports.

```typescript
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite schema
export const embedProfilesSqlite = sqliteTable('embed_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  channels: text('channels').notNull().default('[]'),
  tileset: text('tileset').notNull().default('osm'),
  defaultLat: real('defaultLat').notNull().default(0),
  defaultLng: real('defaultLng').notNull().default(0),
  defaultZoom: integer('defaultZoom').notNull().default(10),
  showTooltips: integer('showTooltips', { mode: 'boolean' }).notNull().default(true),
  showPopups: integer('showPopups', { mode: 'boolean' }).notNull().default(true),
  showLegend: integer('showLegend', { mode: 'boolean' }).notNull().default(true),
  showPaths: integer('showPaths', { mode: 'boolean' }).notNull().default(false),
  showNeighborInfo: integer('showNeighborInfo', { mode: 'boolean' }).notNull().default(false),
  showMqttNodes: integer('showMqttNodes', { mode: 'boolean' }).notNull().default(true),
  pollIntervalSeconds: integer('pollIntervalSeconds').notNull().default(30),
  allowedOrigins: text('allowedOrigins').notNull().default('[]'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL schema
export const embedProfilesPostgres = pgTable('embed_profiles', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  enabled: pgBoolean('enabled').notNull().default(true),
  channels: pgText('channels').notNull().default('[]'),
  tileset: pgText('tileset').notNull().default('osm'),
  defaultLat: pgReal('defaultLat').notNull().default(0),
  defaultLng: pgReal('defaultLng').notNull().default(0),
  defaultZoom: pgInteger('defaultZoom').notNull().default(10),
  showTooltips: pgBoolean('showTooltips').notNull().default(true),
  showPopups: pgBoolean('showPopups').notNull().default(true),
  showLegend: pgBoolean('showLegend').notNull().default(true),
  showPaths: pgBoolean('showPaths').notNull().default(false),
  showNeighborInfo: pgBoolean('showNeighborInfo').notNull().default(false),
  showMqttNodes: pgBoolean('showMqttNodes').notNull().default(true),
  pollIntervalSeconds: pgInteger('pollIntervalSeconds').notNull().default(30),
  allowedOrigins: pgText('allowedOrigins').notNull().default('[]'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const embedProfilesMysql = mysqlTable('embed_profiles', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull(),
  enabled: myBoolean('enabled').notNull().default(true),
  channels: myText('channels').notNull(),
  tileset: myVarchar('tileset', { length: 255 }).notNull().default('osm'),
  defaultLat: myDouble('defaultLat').notNull().default(0),
  defaultLng: myDouble('defaultLng').notNull().default(0),
  defaultZoom: myInt('defaultZoom').notNull().default(10),
  showTooltips: myBoolean('showTooltips').notNull().default(true),
  showPopups: myBoolean('showPopups').notNull().default(true),
  showLegend: myBoolean('showLegend').notNull().default(true),
  showPaths: myBoolean('showPaths').notNull().default(false),
  showNeighborInfo: myBoolean('showNeighborInfo').notNull().default(false),
  showMqttNodes: myBoolean('showMqttNodes').notNull().default(true),
  pollIntervalSeconds: myInt('pollIntervalSeconds').notNull().default(30),
  allowedOrigins: myText('allowedOrigins').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type EmbedProfileSqlite = typeof embedProfilesSqlite.$inferSelect;
export type NewEmbedProfileSqlite = typeof embedProfilesSqlite.$inferInsert;
export type EmbedProfilePostgres = typeof embedProfilesPostgres.$inferSelect;
export type NewEmbedProfilePostgres = typeof embedProfilesPostgres.$inferInsert;
export type EmbedProfileMysql = typeof embedProfilesMysql.$inferSelect;
export type NewEmbedProfileMysql = typeof embedProfilesMysql.$inferInsert;
```

**Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit --project tsconfig.server.json 2>&1 | head -20`
Expected: No errors related to embedProfiles

**Step 3: Commit**

```bash
git add src/db/schema/embedProfiles.ts
git commit -m "feat(embed): add embed_profiles Drizzle schema for all 3 databases"
```

---

## Task 2: Database Repository for Embed Profiles

**Files:**
- Create: `src/db/repositories/embedProfiles.ts`

**Step 1: Write the failing test**

Create `src/db/repositories/embedProfiles.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the repository logic through the route tests in Task 4.
// This test validates the EmbedProfileRepository interface/types compile.
describe('EmbedProfileRepository', () => {
  it('should export the repository class', async () => {
    const mod = await import('./embedProfiles.js');
    expect(mod.EmbedProfileRepository).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/embedProfiles.test.ts`
Expected: FAIL — module not found

**Step 3: Write the repository**

Follow the pattern from `src/db/repositories/settings.ts`. The repository needs CRUD operations:

```typescript
import { eq } from 'drizzle-orm';
import { embedProfilesSqlite, embedProfilesPostgres, embedProfilesMysql } from '../schema/embedProfiles.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface EmbedProfile {
  id: string;
  name: string;
  enabled: boolean;
  channels: number[];
  tileset: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  showTooltips: boolean;
  showPopups: boolean;
  showLegend: boolean;
  showPaths: boolean;
  showNeighborInfo: boolean;
  showMqttNodes: boolean;
  pollIntervalSeconds: number;
  allowedOrigins: string[];
  createdAt: number;
  updatedAt: number;
}

export type EmbedProfileInput = Omit<EmbedProfile, 'createdAt' | 'updatedAt'>;

export class EmbedProfileRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private deserialize(row: Record<string, unknown>): EmbedProfile {
    return {
      ...row,
      channels: JSON.parse((row.channels as string) || '[]'),
      allowedOrigins: JSON.parse((row.allowedOrigins as string) || '[]'),
      enabled: Boolean(row.enabled),
      showTooltips: Boolean(row.showTooltips),
      showPopups: Boolean(row.showPopups),
      showLegend: Boolean(row.showLegend),
      showPaths: Boolean(row.showPaths),
      showNeighborInfo: Boolean(row.showNeighborInfo),
      showMqttNodes: Boolean(row.showMqttNodes),
    } as EmbedProfile;
  }

  async getAllAsync(): Promise<EmbedProfile[]> {
    if (this.isSQLite()) {
      const rows = await this.getSqliteDb().select().from(embedProfilesSqlite);
      return rows.map(r => this.deserialize(r as unknown as Record<string, unknown>));
    } else if (this.isPostgres()) {
      const rows = await this.getPostgresDb().select().from(embedProfilesPostgres);
      return rows.map(r => this.deserialize(r as unknown as Record<string, unknown>));
    } else {
      const rows = await this.getMysqlDb().select().from(embedProfilesMysql);
      return rows.map(r => this.deserialize(r as unknown as Record<string, unknown>));
    }
  }

  async getByIdAsync(id: string): Promise<EmbedProfile | null> {
    if (this.isSQLite()) {
      const rows = await this.getSqliteDb().select().from(embedProfilesSqlite)
        .where(eq(embedProfilesSqlite.id, id)).limit(1);
      return rows.length > 0 ? this.deserialize(rows[0] as unknown as Record<string, unknown>) : null;
    } else if (this.isPostgres()) {
      const rows = await this.getPostgresDb().select().from(embedProfilesPostgres)
        .where(eq(embedProfilesPostgres.id, id)).limit(1);
      return rows.length > 0 ? this.deserialize(rows[0] as unknown as Record<string, unknown>) : null;
    } else {
      const rows = await this.getMysqlDb().select().from(embedProfilesMysql)
        .where(eq(embedProfilesMysql.id, id)).limit(1);
      return rows.length > 0 ? this.deserialize(rows[0] as unknown as Record<string, unknown>) : null;
    }
  }

  async createAsync(input: EmbedProfileInput): Promise<EmbedProfile> {
    const now = this.now();
    const row = {
      ...input,
      channels: JSON.stringify(input.channels),
      allowedOrigins: JSON.stringify(input.allowedOrigins),
      createdAt: now,
      updatedAt: now,
    };
    if (this.isSQLite()) {
      await this.getSqliteDb().insert(embedProfilesSqlite).values(row);
    } else if (this.isPostgres()) {
      await this.getPostgresDb().insert(embedProfilesPostgres).values(row);
    } else {
      await this.getMysqlDb().insert(embedProfilesMysql).values(row);
    }
    return this.deserialize({ ...row, createdAt: now, updatedAt: now } as unknown as Record<string, unknown>);
  }

  async updateAsync(id: string, input: Partial<EmbedProfileInput>): Promise<EmbedProfile | null> {
    const existing = await this.getByIdAsync(id);
    if (!existing) return null;

    const updates: Record<string, unknown> = { updatedAt: this.now() };
    for (const [key, value] of Object.entries(input)) {
      if (key === 'channels' || key === 'allowedOrigins') {
        updates[key] = JSON.stringify(value);
      } else {
        updates[key] = value;
      }
    }

    if (this.isSQLite()) {
      await this.getSqliteDb().update(embedProfilesSqlite).set(updates).where(eq(embedProfilesSqlite.id, id));
    } else if (this.isPostgres()) {
      await this.getPostgresDb().update(embedProfilesPostgres).set(updates).where(eq(embedProfilesPostgres.id, id));
    } else {
      await this.getMysqlDb().update(embedProfilesMysql).set(updates).where(eq(embedProfilesMysql.id, id));
    }
    return this.getByIdAsync(id);
  }

  async deleteAsync(id: string): Promise<boolean> {
    const existing = await this.getByIdAsync(id);
    if (!existing) return false;

    if (this.isSQLite()) {
      await this.getSqliteDb().delete(embedProfilesSqlite).where(eq(embedProfilesSqlite.id, id));
    } else if (this.isPostgres()) {
      await this.getPostgresDb().delete(embedProfilesPostgres).where(eq(embedProfilesPostgres.id, id));
    } else {
      await this.getMysqlDb().delete(embedProfilesMysql).where(eq(embedProfilesMysql.id, id));
    }
    return true;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/embedProfiles.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/embedProfiles.ts src/db/repositories/embedProfiles.test.ts
git commit -m "feat(embed): add EmbedProfileRepository with CRUD operations"
```

---

## Task 3: Database Migration 078 — Create embed_profiles Table

**Files:**
- Create: `src/server/migrations/078_create_embed_profiles.ts`
- Modify: `src/services/database.ts` (import + 3 call sites)

**Step 1: Write the migration file**

Follow pattern from `src/server/migrations/077_upgrade_ignored_nodes_nodenum_bigint.ts`:

```typescript
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 078: Create embed_profiles table (SQLite)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS embed_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        channels TEXT NOT NULL DEFAULT '[]',
        tileset TEXT NOT NULL DEFAULT 'osm',
        defaultLat REAL NOT NULL DEFAULT 0,
        defaultLng REAL NOT NULL DEFAULT 0,
        defaultZoom INTEGER NOT NULL DEFAULT 10,
        showTooltips INTEGER NOT NULL DEFAULT 1,
        showPopups INTEGER NOT NULL DEFAULT 1,
        showLegend INTEGER NOT NULL DEFAULT 1,
        showPaths INTEGER NOT NULL DEFAULT 0,
        showNeighborInfo INTEGER NOT NULL DEFAULT 0,
        showMqttNodes INTEGER NOT NULL DEFAULT 1,
        pollIntervalSeconds INTEGER NOT NULL DEFAULT 30,
        allowedOrigins TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
  },
  down: (db: Database): void => {
    db.exec('DROP TABLE IF EXISTS embed_profiles');
  }
};

export async function runMigration078Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 078 (PostgreSQL): Create embed_profiles table');
  try {
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'embed_profiles'`
    );
    if (check.rows.length > 0) {
      logger.debug('Migration 078: embed_profiles table already exists, skipping');
      return;
    }
    await client.query(`
      CREATE TABLE embed_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        channels TEXT NOT NULL DEFAULT '[]',
        tileset TEXT NOT NULL DEFAULT 'osm',
        "defaultLat" REAL NOT NULL DEFAULT 0,
        "defaultLng" REAL NOT NULL DEFAULT 0,
        "defaultZoom" INTEGER NOT NULL DEFAULT 10,
        "showTooltips" BOOLEAN NOT NULL DEFAULT true,
        "showPopups" BOOLEAN NOT NULL DEFAULT true,
        "showLegend" BOOLEAN NOT NULL DEFAULT true,
        "showPaths" BOOLEAN NOT NULL DEFAULT false,
        "showNeighborInfo" BOOLEAN NOT NULL DEFAULT false,
        "showMqttNodes" BOOLEAN NOT NULL DEFAULT true,
        "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
        "allowedOrigins" TEXT NOT NULL DEFAULT '[]',
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      )
    `);
    logger.info('Migration 078: embed_profiles table created successfully');
  } catch (error: any) {
    logger.error('Migration 078 failed:', error.message);
    throw error;
  }
}

export async function runMigration078Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 078 (MySQL): Create embed_profiles table');
  try {
    const [rows] = await pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'embed_profiles'`
    );
    if (Array.isArray(rows) && rows.length > 0) {
      logger.debug('Migration 078: embed_profiles table already exists, skipping');
      return;
    }
    await pool.query(`
      CREATE TABLE embed_profiles (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        channels TEXT NOT NULL,
        tileset VARCHAR(255) NOT NULL DEFAULT 'osm',
        defaultLat DOUBLE NOT NULL DEFAULT 0,
        defaultLng DOUBLE NOT NULL DEFAULT 0,
        defaultZoom INT NOT NULL DEFAULT 10,
        showTooltips BOOLEAN NOT NULL DEFAULT true,
        showPopups BOOLEAN NOT NULL DEFAULT true,
        showLegend BOOLEAN NOT NULL DEFAULT true,
        showPaths BOOLEAN NOT NULL DEFAULT false,
        showNeighborInfo BOOLEAN NOT NULL DEFAULT false,
        showMqttNodes BOOLEAN NOT NULL DEFAULT true,
        pollIntervalSeconds INT NOT NULL DEFAULT 30,
        allowedOrigins TEXT NOT NULL,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL
      )
    `);
    logger.info('Migration 078: embed_profiles table created successfully');
  } catch (error: any) {
    logger.error('Migration 078 failed:', error.message);
    throw error;
  }
}
```

**Step 2: Register migration in `src/services/database.ts`**

Add import near line 86 (after migration 077 import):
```typescript
import { migration as createEmbedProfilesMigration, runMigration078Postgres, runMigration078Mysql } from '../server/migrations/078_create_embed_profiles.js';
```

Add SQLite private method (after `runIgnoredNodesNodeNumBigintMigration` ~line 2489):
```typescript
private runCreateEmbedProfilesMigration(): void {
  const migrationKey = 'migration_078_create_embed_profiles';
  try {
    const migrationStatus = this.getSetting(migrationKey);
    if (migrationStatus === 'completed') {
      logger.debug('Migration 078 (create embed_profiles) already completed');
      return;
    }
    logger.debug('Running migration 078: Create embed_profiles table...');
    createEmbedProfilesMigration.up(this.db);
    this.setSetting(migrationKey, 'completed');
    logger.debug('Create embed_profiles migration completed successfully');
  } catch (error) {
    logger.error('Failed to run create embed_profiles migration:', error);
    throw error;
  }
}
```

Add call in SQLite init (~line 969, after `this.runIgnoredNodesNodeNumBigintMigration()`):
```typescript
this.runCreateEmbedProfilesMigration();
```

Add call in Postgres init (~line 11008, after `await runMigration077Postgres(client)`):
```typescript
// Run migration 078: Create embed_profiles table
await runMigration078Postgres(client);
```

Add call in MySQL init (~line 11151, after `await runMigration077Mysql(pool)`):
```typescript
// Run migration 078: Create embed_profiles table
await runMigration078Mysql(pool);
```

Also wire up the repository in DatabaseService. Find where other repositories are instantiated and add:
```typescript
// In the repository initialization section
import { EmbedProfileRepository } from '../db/repositories/embedProfiles.js';

// Add property
private embedProfileRepo?: EmbedProfileRepository;

// In the init section where repos are created:
this.embedProfileRepo = new EmbedProfileRepository(this.drizzleDb, this.drizzleDbType);

// Add facade methods:
async getEmbedProfilesAsync(): Promise<EmbedProfile[]> {
  return this.embedProfileRepo!.getAllAsync();
}
async getEmbedProfileByIdAsync(id: string): Promise<EmbedProfile | null> {
  return this.embedProfileRepo!.getByIdAsync(id);
}
async createEmbedProfileAsync(input: EmbedProfileInput): Promise<EmbedProfile> {
  return this.embedProfileRepo!.createAsync(input);
}
async updateEmbedProfileAsync(id: string, input: Partial<EmbedProfileInput>): Promise<EmbedProfile | null> {
  return this.embedProfileRepo!.updateAsync(id, input);
}
async deleteEmbedProfileAsync(id: string): Promise<boolean> {
  return this.embedProfileRepo!.deleteAsync(id);
}
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.server.json 2>&1 | head -30`
Expected: No errors

**Step 4: Commit**

```bash
git add src/server/migrations/078_create_embed_profiles.ts src/db/schema/embedProfiles.ts src/db/repositories/embedProfiles.ts src/services/database.ts
git commit -m "feat(embed): add migration 078 and wire EmbedProfileRepository into DatabaseService"
```

---

## Task 4: Embed Profile API Routes (Admin CRUD)

**Files:**
- Create: `src/server/routes/embedProfileRoutes.ts`
- Create: `src/server/routes/embedProfileRoutes.test.ts`
- Modify: `src/server/server.ts` (mount routes)

**Step 1: Write the failing test**

Follow the pattern from `src/server/routes/apiTokenRoutes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import embedProfileRoutes from './embedProfileRoutes.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getEmbedProfilesAsync: vi.fn(),
    getEmbedProfileByIdAsync: vi.fn(),
    createEmbedProfileAsync: vi.fn(),
    updateEmbedProfileAsync: vi.fn(),
    deleteEmbedProfileAsync: vi.fn(),
    auditLog: vi.fn(),
  }
}));

import databaseService from '../../services/database.js';
const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };

const createApp = (opts: { authenticated?: boolean; admin?: boolean } = {}): Express => {
  const { authenticated = true, admin = true } = opts;
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, cookie: { secure: false } }));

  if (authenticated) {
    app.use((req, _res, next) => {
      req.session.userId = adminUser.id;
      req.session.username = adminUser.username;
      next();
    });
  }

  // Mock findUserByIdAsync for requireAdmin
  mockDb.findUserByIdAsync.mockResolvedValue(admin ? adminUser : { ...adminUser, isAdmin: false });

  app.use('/api/embed-profiles', embedProfileRoutes);
  return app;
};

describe('Embed Profile Routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('GET /api/embed-profiles', () => {
    it('should return all profiles for admin', async () => {
      mockDb.getEmbedProfilesAsync.mockResolvedValue([
        { id: 'abc', name: 'Test', enabled: true, channels: [0], tileset: 'osm' }
      ]);
      const res = await request(createApp()).get('/api/embed-profiles');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Test');
    });

    it('should return 401 for unauthenticated', async () => {
      const res = await request(createApp({ authenticated: false })).get('/api/embed-profiles');
      expect(res.status).toBe(401);
    });

    it('should return 403 for non-admin', async () => {
      const res = await request(createApp({ admin: false })).get('/api/embed-profiles');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/embed-profiles', () => {
    it('should create a profile', async () => {
      const input = { name: 'My Embed', channels: [0, 1], tileset: 'osm', defaultLat: 40.7, defaultLng: -74.0, defaultZoom: 12, allowedOrigins: ['https://example.com'] };
      mockDb.createEmbedProfileAsync.mockResolvedValue({ id: 'new-id', ...input, enabled: true });
      const res = await request(createApp()).post('/api/embed-profiles').send(input);
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    it('should reject missing name', async () => {
      const res = await request(createApp()).post('/api/embed-profiles').send({ channels: [0] });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/embed-profiles/:id', () => {
    it('should update a profile', async () => {
      mockDb.updateEmbedProfileAsync.mockResolvedValue({ id: 'abc', name: 'Updated' });
      const res = await request(createApp()).put('/api/embed-profiles/abc').send({ name: 'Updated' });
      expect(res.status).toBe(200);
    });

    it('should return 404 for nonexistent profile', async () => {
      mockDb.updateEmbedProfileAsync.mockResolvedValue(null);
      const res = await request(createApp()).put('/api/embed-profiles/nope').send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/embed-profiles/:id', () => {
    it('should delete a profile', async () => {
      mockDb.deleteEmbedProfileAsync.mockResolvedValue(true);
      const res = await request(createApp()).delete('/api/embed-profiles/abc');
      expect(res.status).toBe(204);
    });

    it('should return 404 for nonexistent', async () => {
      mockDb.deleteEmbedProfileAsync.mockResolvedValue(false);
      const res = await request(createApp()).delete('/api/embed-profiles/nope');
      expect(res.status).toBe(404);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/routes/embedProfileRoutes.test.ts`
Expected: FAIL — module not found

**Step 3: Write the route handler**

```typescript
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All routes require admin
router.use(requireAdmin());

// GET / — list all embed profiles
router.get('/', async (_req: Request, res: Response) => {
  try {
    const profiles = await databaseService.getEmbedProfilesAsync();
    res.json(profiles);
  } catch (error) {
    logger.error('Failed to list embed profiles:', error);
    res.status(500).json({ error: 'Failed to list embed profiles' });
  }
});

// POST / — create embed profile
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, channels, tileset, defaultLat, defaultLng, defaultZoom,
            showTooltips, showPopups, showLegend, showPaths, showNeighborInfo,
            showMqttNodes, pollIntervalSeconds, allowedOrigins, enabled } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const profile = await databaseService.createEmbedProfileAsync({
      id: randomUUID(),
      name,
      enabled: enabled !== false,
      channels: Array.isArray(channels) ? channels : [],
      tileset: tileset || 'osm',
      defaultLat: Number(defaultLat) || 0,
      defaultLng: Number(defaultLng) || 0,
      defaultZoom: Number(defaultZoom) || 10,
      showTooltips: showTooltips !== false,
      showPopups: showPopups !== false,
      showLegend: showLegend !== false,
      showPaths: Boolean(showPaths),
      showNeighborInfo: Boolean(showNeighborInfo),
      showMqttNodes: showMqttNodes !== false,
      pollIntervalSeconds: Number(pollIntervalSeconds) || 30,
      allowedOrigins: Array.isArray(allowedOrigins) ? allowedOrigins : [],
    });

    res.status(201).json(profile);
  } catch (error) {
    logger.error('Failed to create embed profile:', error);
    res.status(500).json({ error: 'Failed to create embed profile' });
  }
});

// PUT /:id — update embed profile
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const updated = await databaseService.updateEmbedProfileAsync(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Embed profile not found' });
    }
    res.json(updated);
  } catch (error) {
    logger.error('Failed to update embed profile:', error);
    res.status(500).json({ error: 'Failed to update embed profile' });
  }
});

// DELETE /:id — delete embed profile
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await databaseService.deleteEmbedProfileAsync(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Embed profile not found' });
    }
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete embed profile:', error);
    res.status(500).json({ error: 'Failed to delete embed profile' });
  }
});

export default router;
```

**Step 4: Mount in server.ts**

In `src/server/server.ts`, add import and mount near the other route registrations (~line 752):
```typescript
import embedProfileRoutes from './routes/embedProfileRoutes.js';
// ...
apiRouter.use('/embed-profiles', embedProfileRoutes);
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/routes/embedProfileRoutes.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/server/routes/embedProfileRoutes.ts src/server/routes/embedProfileRoutes.test.ts src/server/server.ts
git commit -m "feat(embed): add admin CRUD routes for embed profiles"
```

---

## Task 5: Embed Middleware (CSP Frame-Ancestors + Public Config Endpoint)

**Files:**
- Create: `src/server/middleware/embedMiddleware.ts`
- Create: `src/server/middleware/embedMiddleware.test.ts`
- Create: `src/server/routes/embedPublicRoutes.ts`
- Modify: `src/server/server.ts` (mount public routes + middleware)

**Step 1: Write the failing test for the middleware**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/database.js', () => ({
  default: {
    getEmbedProfileByIdAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

import databaseService from '../../services/database.js';
import { createEmbedCspMiddleware } from './embedMiddleware.js';

const mockDb = databaseService as any;

describe('Embed CSP Middleware', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should set frame-ancestors with allowedOrigins', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue({
      id: 'abc', enabled: true, allowedOrigins: ['https://example.com', 'https://other.com']
    });

    const app = express();
    app.use('/embed/:profileId', createEmbedCspMiddleware(), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/embed/abc');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'self' https://example.com https://other.com");
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('should return 404 for disabled profile', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue({ id: 'abc', enabled: false });

    const app = express();
    app.use('/embed/:profileId', createEmbedCspMiddleware(), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/embed/abc');
    expect(res.status).toBe(404);
  });

  it('should return 404 for nonexistent profile', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue(null);

    const app = express();
    app.use('/embed/:profileId', createEmbedCspMiddleware(), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/embed/abc');
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/middleware/embedMiddleware.test.ts`
Expected: FAIL — module not found

**Step 3: Write the middleware**

```typescript
import { Request, Response, NextFunction } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export function createEmbedCspMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const profileId = req.params.profileId || req.params.id;
    if (!profileId) {
      return res.status(404).json({ error: 'Embed profile not found' });
    }

    try {
      const profile = await databaseService.getEmbedProfileByIdAsync(profileId);
      if (!profile || !profile.enabled) {
        return res.status(404).json({ error: 'Embed profile not found' });
      }

      // Store profile on request for downstream use
      (req as any).embedProfile = profile;

      // Remove X-Frame-Options (superseded by frame-ancestors)
      res.removeHeader('X-Frame-Options');

      // Set frame-ancestors CSP
      const origins = profile.allowedOrigins.length > 0
        ? profile.allowedOrigins.join(' ')
        : '*';
      const frameAncestors = `'self' ${origins}`;

      // Build a minimal CSP for the embed page
      res.setHeader('Content-Security-Policy',
        `frame-ancestors ${frameAncestors}; ` +
        `default-src 'self'; ` +
        `script-src 'self'; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data: http: https:; ` +
        `connect-src 'self' *.tile.openstreetmap.org *.basemaps.cartocdn.com services.arcgisonline.com *.opentopomap.org; ` +
        `worker-src 'self' blob:`
      );

      next();
    } catch (error) {
      logger.error('Embed middleware error:', error);
      return res.status(500).json({ error: 'Internal error' });
    }
  };
}
```

**Step 4: Write the public embed routes**

`src/server/routes/embedPublicRoutes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';

const router = Router();

// GET /embed/:profileId/config — public config endpoint
router.get('/:profileId/config', async (req: Request, res: Response) => {
  // embedProfile is attached by the middleware
  const profile = (req as any).embedProfile;
  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  res.json({
    id: profile.id,
    channels: profile.channels,
    tileset: profile.tileset,
    defaultLat: profile.defaultLat,
    defaultLng: profile.defaultLng,
    defaultZoom: profile.defaultZoom,
    showTooltips: profile.showTooltips,
    showPopups: profile.showPopups,
    showLegend: profile.showLegend,
    showPaths: profile.showPaths,
    showNeighborInfo: profile.showNeighborInfo,
    showMqttNodes: profile.showMqttNodes,
    pollIntervalSeconds: profile.pollIntervalSeconds,
  });
});

export default router;
```

**Step 5: Mount in server.ts**

Add embed routes BEFORE the SPA fallback, at the same level as the API router. This is important because `/embed/:id` is NOT under `/api`:

```typescript
import { createEmbedCspMiddleware } from './middleware/embedMiddleware.js';
import embedPublicRoutes from './routes/embedPublicRoutes.js';

// Embed config API (public, with embed CSP middleware)
app.use(`${BASE_URL}/api/embed`, createEmbedCspMiddleware(), embedPublicRoutes);

// Embed HTML page (serves embed.html — added in Task 7)
// app.get(`${BASE_URL}/embed/:profileId`, createEmbedCspMiddleware(), serveEmbedPage);
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run src/server/middleware/embedMiddleware.test.ts`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/server/middleware/embedMiddleware.ts src/server/middleware/embedMiddleware.test.ts src/server/routes/embedPublicRoutes.ts src/server/server.ts
git commit -m "feat(embed): add embed CSP middleware and public config endpoint"
```

---

## Task 6: Vite Multi-Page Build Configuration

**Files:**
- Create: `embed.html`
- Modify: `vite.config.ts`

**Step 1: Create embed.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>MeshMonitor Embedded Map</title>
  </head>
  <body>
    <div id="embed-root" style="width: 100%; height: 100vh; margin: 0; padding: 0;"></div>
    <script type="module" src="/src/embed.tsx"></script>
  </body>
</html>
```

**Step 2: Update vite.config.ts**

Add `resolve` import and multi-page input config:

```typescript
import { resolve } from 'path';

// In the build section, replace the existing rollupOptions:
build: {
  rollupOptions: {
    input: {
      main: resolve(__dirname, 'index.html'),
      embed: resolve(__dirname, 'embed.html'),
    },
    external: [
      './src/services/database.js',
      'better-sqlite3',
      'path',
      'url',
      'fs'
    ]
  }
}
```

**Step 3: Create minimal src/embed.tsx stub**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';

function EmbedApp() {
  return <div>Embed loading...</div>;
}

const root = createRoot(document.getElementById('embed-root')!);
root.render(<EmbedApp />);
```

**Step 4: Verify build works**

Run: `npx vite build 2>&1 | tail -20`
Expected: Build succeeds, produces both `index.html` and `embed.html` in `dist/`

**Step 5: Commit**

```bash
git add embed.html src/embed.tsx vite.config.ts
git commit -m "feat(embed): add embed.html entry point and multi-page Vite build"
```

---

## Task 7: Embed HTML Page Serving from Express

**Files:**
- Modify: `src/server/server.ts` (serve embed.html for `/embed/:profileId`)

**Step 1: Add embed page serving**

In `src/server/server.ts`, before the SPA fallback (but after static file serving), add:

```typescript
import path from 'path';
import fs from 'fs';

// Serve embed page (must be before SPA fallback)
app.get(`${BASE_URL}/embed/:profileId`, createEmbedCspMiddleware(), (req, res) => {
  const embedPath = path.join(buildPath, 'embed.html');
  if (!fs.existsSync(embedPath)) {
    return res.status(404).send('Embed page not found. Is the build up to date?');
  }

  // Read and rewrite base URL if needed (same pattern as index.html serving)
  let html = fs.readFileSync(embedPath, 'utf-8');
  if (BASE_URL) {
    html = html.replace(/src="\//g, `src="${BASE_URL}/`);
    html = html.replace(/href="\//g, `href="${BASE_URL}/`);
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});
```

**Step 2: Verify the embed page is served in dev**

Build the app, start the server, then:
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/meshmonitor/embed/nonexistent`
Expected: `404` (profile doesn't exist yet — this is correct)

**Step 3: Commit**

```bash
git add src/server/server.ts
git commit -m "feat(embed): serve embed.html with BASE_URL rewriting for embed routes"
```

---

## Task 8: EmbedMap React Component

**Files:**
- Create: `src/components/EmbedMap.tsx`
- Modify: `src/embed.tsx` (mount EmbedMap)

**Step 1: Write the EmbedMap component**

This is the core embed component. It fetches config, loads nodes, renders the map.

```tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip, Popup } from 'react-leaflet';
import { VectorTileLayer } from './VectorTileLayer';
import { getTilesetById } from '../config/tilesets';
import { createNodeIcon } from '../utils/mapIcons';
import type { DeviceInfo } from '../types/deviceInfo';
import 'leaflet/dist/leaflet.css';

interface EmbedConfig {
  id: string;
  channels: number[];
  tileset: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  showTooltips: boolean;
  showPopups: boolean;
  showLegend: boolean;
  showPaths: boolean;
  showNeighborInfo: boolean;
  showMqttNodes: boolean;
  pollIntervalSeconds: number;
}

export function EmbedMap({ profileId }: { profileId: string }) {
  const [config, setConfig] = useState<EmbedConfig | null>(null);
  const [nodes, setNodes] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect BASE_URL from current path
  const baseUrl = window.location.pathname.replace(/\/embed\/.*$/, '');

  // Fetch config on mount
  useEffect(() => {
    fetch(`${baseUrl}/api/embed/${profileId}/config`, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error('Embed not found');
        return r.json();
      })
      .then(setConfig)
      .catch(err => setError(err.message));
  }, [profileId, baseUrl]);

  // Fetch nodes, filter by channels
  const fetchNodes = useCallback(async () => {
    if (!config) return;
    try {
      const res = await fetch(`${baseUrl}/api/nodes/active`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const allNodes: DeviceInfo[] = Array.isArray(data) ? data : data.nodes || [];
      // Filter to configured channels
      const filtered = config.channels.length > 0
        ? allNodes.filter(n => n.channel !== undefined && config.channels.includes(n.channel))
        : allNodes;
      // Filter to nodes with position
      const withPosition = filtered.filter(n => n.position?.latitude && n.position?.longitude);
      // Filter MQTT nodes if disabled
      const final = config.showMqttNodes ? withPosition : withPosition.filter(n => !n.viaMqtt);
      setNodes(final);
    } catch (err) {
      // Silently fail on poll errors
    }
  }, [config, baseUrl]);

  // Poll nodes
  useEffect(() => {
    if (!config) return;
    fetchNodes();
    intervalRef.current = setInterval(fetchNodes, config.pollIntervalSeconds * 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [config, fetchNodes]);

  if (error) return <div style={{ padding: 20, color: 'red' }}>Error: {error}</div>;
  if (!config) return <div style={{ padding: 20 }}>Loading map...</div>;

  const tileset = getTilesetById(config.tileset, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}>
      <MapContainer
        center={[config.defaultLat, config.defaultLng]}
        zoom={config.defaultZoom}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
        attributionControl={true}
      >
        {tileset.isVector ? (
          <VectorTileLayer url={tileset.url} attribution={tileset.attribution} maxZoom={tileset.maxZoom} />
        ) : (
          <TileLayer url={tileset.url} attribution={tileset.attribution} maxZoom={tileset.maxZoom} />
        )}

        {nodes.map(node => {
          const lat = node.position?.latitude;
          const lng = node.position?.longitude;
          if (!lat || !lng) return null;
          const name = node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16)}`;

          return (
            <Marker
              key={node.nodeNum}
              position={[lat, lng]}
              icon={createNodeIcon(node)}
            >
              {config.showTooltips && (
                <Tooltip direction="top" offset={[0, -20]} opacity={0.9}>
                  <div style={{ textAlign: 'center', fontWeight: 'bold' }}>{name}</div>
                </Tooltip>
              )}
              {config.showPopups && (
                <Popup>
                  <div>
                    <strong>{name}</strong>
                    {node.user?.hwModel && <div>Hardware: {node.user.hwModel}</div>}
                    {node.lastHeard && <div>Last heard: {new Date(node.lastHeard * 1000).toLocaleString()}</div>}
                    {node.snr !== undefined && <div>SNR: {node.snr} dB</div>}
                  </div>
                </Popup>
              )}
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
```

**Step 2: Update src/embed.tsx to use EmbedMap**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EmbedMap } from './components/EmbedMap';

function EmbedApp() {
  // Extract profileId from URL path: /embed/:profileId or /meshmonitor/embed/:profileId
  const pathParts = window.location.pathname.split('/');
  const embedIndex = pathParts.indexOf('embed');
  const profileId = embedIndex >= 0 ? pathParts[embedIndex + 1] : null;

  if (!profileId) {
    return <div style={{ padding: 20, color: 'red' }}>Invalid embed URL</div>;
  }

  return <EmbedMap profileId={profileId} />;
}

const root = createRoot(document.getElementById('embed-root')!);
root.render(<EmbedApp />);
```

**Step 3: Verify build succeeds**

Run: `npx vite build 2>&1 | tail -20`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/components/EmbedMap.tsx src/embed.tsx
git commit -m "feat(embed): implement EmbedMap component with polling and configurable interactivity"
```

---

## Task 9: Settings UI — Embed Configuration Panel

**Files:**
- Create: `src/components/settings/EmbedSettings.tsx`
- Modify: `src/components/SettingsTab.tsx` (add embed section)

**Step 1: Create the EmbedSettings component**

This is a larger component with profile list + create/edit form + map picker + embed code preview.

The component should:
1. Fetch profiles from `GET /api/embed-profiles`
2. Show a list with edit/delete/copy-code buttons
3. Have a create/edit form with:
   - Name input
   - Enabled toggle
   - Channel multi-select (fetch available channels from `/api/channels`)
   - Tileset dropdown (reuse existing tileset selector pattern from SettingsTab)
   - Interactive mini-map for center/zoom (a small Leaflet MapContainer where clicking sets center, zoom changes set zoom)
   - Boolean toggles for showTooltips, showPopups, showLegend, showPaths, showNeighborInfo, showMqttNodes
   - Poll interval number input
   - Allowed origins text input (comma-separated)
4. Show iframe embed code preview
5. Show security notes about anonymous user permissions

**Implementation notes:**
- Look at `SettingsTab.tsx` for existing UI patterns (toggles, dropdowns, section headers)
- The mini-map picker: use a `MapContainer` with click handler that sets lat/lng, and a `ZoomHandler` that captures zoom
- Use `useTranslation()` for i18n keys (prefix with `settings.embed.`)
- CSRF token needed for POST/PUT/DELETE — use `useCsrf()` from CsrfContext
- Use `fetch` with credentials for API calls (same pattern as rest of settings)

**Step 2: Add embed section to SettingsTab.tsx**

Import `EmbedSettings` and add to the SectionNav items (admin-only conditional) and render it in the settings content.

In the SectionNav items array, add (conditionally if user isAdmin):
```typescript
...(isAdmin ? [{ id: 'settings-embed', label: t('settings.embed_maps', 'Embed Maps') }] : []),
```

In the settings content, add:
```tsx
{isAdmin && (
  <div id="settings-embed" className="settings-section">
    <h3>{t('settings.embed_maps', 'Embed Maps')}</h3>
    <EmbedSettings />
  </div>
)}
```

**Step 3: Build and manually verify**

Run: `npx vite build 2>&1 | tail -20`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/components/settings/EmbedSettings.tsx src/components/SettingsTab.tsx
git commit -m "feat(embed): add Embed Maps settings panel with profile CRUD and map picker"
```

---

## Task 10: CORS Integration for Embed Origins

**Files:**
- Modify: `src/server/server.ts` (CORS origin check)

**Step 1: Update CORS to include embed profile origins**

Currently CORS checks against `ALLOWED_ORIGINS` env var. We need to also allow origins from active embed profiles.

In `src/server/server.ts`, modify the CORS `origin` callback (~line 199) to also check embed profile origins. Since this is hot-path, cache the embed origins with a short TTL (60s).

```typescript
// Add a cached function to get all embed allowed origins
let embedOriginsCache: string[] = [];
let embedOriginsCacheTime = 0;
const EMBED_ORIGINS_CACHE_TTL = 60000; // 60 seconds

async function getEmbedAllowedOrigins(): Promise<string[]> {
  if (Date.now() - embedOriginsCacheTime < EMBED_ORIGINS_CACHE_TTL) {
    return embedOriginsCache;
  }
  try {
    const profiles = await databaseService.getEmbedProfilesAsync();
    embedOriginsCache = profiles
      .filter(p => p.enabled)
      .flatMap(p => p.allowedOrigins);
    embedOriginsCacheTime = Date.now();
  } catch {
    // On error, return cached value
  }
  return embedOriginsCache;
}

// Update CORS origin callback:
app.use(cors({
  origin: async (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    // Check embed profile origins
    const embedOrigins = await getEmbedAllowedOrigins();
    if (embedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization'],
}));
```

**Note:** Check that the `cors` package supports async origin functions. If it doesn't, we may need to use a synchronous cache that's populated on a timer. Verify with context7 docs.

**Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "feat(embed): integrate embed profile origins into CORS checks"
```

---

## Task 11: Integration Testing & Manual Verification

**Files:**
- No new files — testing existing work

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Build and deploy to dev Docker**

Run: `docker compose -f docker-compose.dev.yml build && docker compose -f docker-compose.dev.yml up -d --profile sqlite`

**Step 3: Create an embed profile via API**

```bash
./scripts/api-test.sh login
./scripts/api-test.sh post /api/embed-profiles '{"name":"Test Embed","channels":[0],"tileset":"osm","defaultLat":40.7128,"defaultLng":-74.006,"defaultZoom":12,"allowedOrigins":["*"]}'
```
Expected: 201 with profile JSON including an `id`

**Step 4: Verify the embed config endpoint**

```bash
curl http://localhost:8080/meshmonitor/api/embed/<profile-id>/config
```
Expected: JSON with the profile config

**Step 5: Verify the embed page loads**

Open `http://localhost:8080/meshmonitor/embed/<profile-id>` in browser.
Expected: A map centered on the configured location with nodes visible.

**Step 6: Test iframe embedding**

Create a simple HTML file locally:
```html
<html>
<body>
<h1>Embed Test</h1>
<iframe src="http://localhost:8080/meshmonitor/embed/<profile-id>" width="800" height="600"></iframe>
</body>
</html>
```
Open it and verify the map renders in the iframe.

**Step 7: Commit any fixes**

If any fixes were needed, commit them with descriptive messages.

---

## Task 12: Run System Tests

**Step 1: Stop Docker and tileserver**

```bash
docker compose -f docker-compose.dev.yml down
```

**Step 2: Run system tests**

Run: `bash tests/system-tests.sh`
Expected: All tests pass

**Step 3: Post results**

Save output for PR description.

---

## Summary of Files

| File | Action |
|------|--------|
| `src/db/schema/embedProfiles.ts` | Create |
| `src/db/repositories/embedProfiles.ts` | Create |
| `src/db/repositories/embedProfiles.test.ts` | Create |
| `src/server/migrations/078_create_embed_profiles.ts` | Create |
| `src/server/routes/embedProfileRoutes.ts` | Create |
| `src/server/routes/embedProfileRoutes.test.ts` | Create |
| `src/server/routes/embedPublicRoutes.ts` | Create |
| `src/server/middleware/embedMiddleware.ts` | Create |
| `src/server/middleware/embedMiddleware.test.ts` | Create |
| `embed.html` | Create |
| `src/embed.tsx` | Create |
| `src/components/EmbedMap.tsx` | Create |
| `src/components/settings/EmbedSettings.tsx` | Create |
| `vite.config.ts` | Modify |
| `src/server/server.ts` | Modify |
| `src/services/database.ts` | Modify |
| `src/components/SettingsTab.tsx` | Modify |
