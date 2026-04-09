# MES-10: Multi-Source Channel Data Fix & Message Routing Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs: (1) messages always sent through source 1's radio regardless of which source the user is viewing, and (2) channel data from multiple sources overwriting each other because the channels table has `id` as a single-column primary key (slot 0-7) instead of a composite `(sourceId, id)` unique key.

**Architecture:** Add migration 023 to rebuild the channels table with a surrogate `pk` primary key and a UNIQUE constraint on `(sourceId, id)`, giving each source its own independent set of channel slots. Update the repository to scope reads and writes by sourceId. Fix the message send endpoint to accept a sourceId and look up the correct manager from `sourceManagerRegistry`.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite/PostgreSQL/MySQL, React, Express.

---

## File Map

| File | Change |
|------|--------|
| `src/db/schema/channels.ts` | Add `pk` surrogate PK, make `id` plain integer, add unique on `(sourceId, id)` |
| `src/server/migrations/023_multi_source_channels.ts` | New migration: recreate channels table with new schema |
| `src/db/migrations.ts` | Import and register migration 023 |
| `src/db/migrations.test.ts` | Update count to 23 and last-migration assertions |
| `src/db/repositories/channels.ts` | Update `getChannelById`, `upsertChannel`, `getChannelCount` for sourceId |
| `src/server/meshtasticManager.ts` | Pass `this.sourceId` to all channel DB calls |
| `src/server/server.ts` | Accept `sourceId` in `/api/messages/send`, use registry to pick manager |
| `src/App.tsx` | Include `sourceId` in message send request body |

---

## Task 1: Update channels schema

**Files:**
- Modify: `src/db/schema/channels.ts`

- [ ] **Step 1: Update the schema file**

Replace the entire file content:

```typescript
/**
 * Drizzle schema definition for the channels table
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * Each source has its own independent channel slots (0-7).
 * The composite unique key (sourceId, id) ensures per-source isolation.
 * A surrogate `pk` column is the actual primary key so Drizzle can do
 * ON CONFLICT upserts on the composite key.
 */
import {
  sqliteTable, text, integer, uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable, text as pgText, integer as pgInteger,
  boolean as pgBoolean, bigint as pgBigint, serial as pgSerial,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable, varchar as myVarchar, int as myInt,
  boolean as myBoolean, bigint as myBigint,
} from 'drizzle-orm/mysql-core';

// SQLite schema
export const channelsSqlite = sqliteTable('channels', {
  pk: integer('pk').primaryKey({ autoIncrement: true }),
  id: integer('id').notNull(),
  name: text('name').notNull(),
  psk: text('psk'),
  role: integer('role'),
  uplinkEnabled: integer('uplinkEnabled', { mode: 'boolean' }).notNull().default(true),
  downlinkEnabled: integer('downlinkEnabled', { mode: 'boolean' }).notNull().default(true),
  positionPrecision: integer('positionPrecision'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  sourceId: text('sourceId'),
}, (t) => ({
  sourceChannelUniq: uniqueIndex('channels_source_id_idx').on(t.sourceId, t.id),
}));

// PostgreSQL schema
export const channelsPostgres = pgTable('channels', {
  pk: pgSerial('pk').primaryKey(),
  id: pgInteger('id').notNull(),
  name: pgText('name').notNull(),
  psk: pgText('psk'),
  role: pgInteger('role'),
  uplinkEnabled: pgBoolean('uplinkEnabled').notNull().default(true),
  downlinkEnabled: pgBoolean('downlinkEnabled').notNull().default(true),
  positionPrecision: pgInteger('positionPrecision'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  sourceId: pgText('sourceId'),
});

// MySQL schema
export const channelsMysql = mysqlTable('channels', {
  pk: myInt('pk').autoincrement().primaryKey(),
  id: myInt('id').notNull(),
  name: myVarchar('name', { length: 64 }).notNull(),
  psk: myVarchar('psk', { length: 64 }),
  role: myInt('role'),
  uplinkEnabled: myBoolean('uplinkEnabled').notNull().default(true),
  downlinkEnabled: myBoolean('downlinkEnabled').notNull().default(true),
  positionPrecision: myInt('positionPrecision'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  sourceId: myVarchar('sourceId', { length: 36 }),
});

// Type inference
export type ChannelSqlite = typeof channelsSqlite.$inferSelect;
export type NewChannelSqlite = typeof channelsSqlite.$inferInsert;
export type ChannelPostgres = typeof channelsPostgres.$inferSelect;
export type NewChannelPostgres = typeof channelsPostgres.$inferInsert;
export type ChannelMysql = typeof channelsMysql.$inferSelect;
export type NewChannelMysql = typeof channelsMysql.$inferInsert;
```

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
cd /home/yeraze/Development/meshmonitor
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors related to channels schema (there may be errors from downstream uses — that's expected at this stage).

- [ ] **Step 3: Commit schema change**

```bash
git add src/db/schema/channels.ts
git commit -m "feat: update channels schema for multi-source isolation

Add surrogate pk primary key and UNIQUE(sourceId, id) constraint.
Each source now gets its own independent channel slots (0-7).

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 2: Write migration 023

**Files:**
- Create: `src/server/migrations/023_multi_source_channels.ts`

- [ ] **Step 1: Create the migration file**

```typescript
/**
 * Migration 023: Multi-source channels table rebuild
 *
 * Changes channels table from single `id INTEGER PRIMARY KEY` to a surrogate
 * `pk` primary key with a UNIQUE constraint on `(sourceId, id)`.
 *
 * This allows each source to have its own independent set of channel slots
 * (0-7) without overwriting each other's data.
 *
 * Data is preserved: existing rows keep their id and sourceId values.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 023 (SQLite): Rebuilding channels table for multi-source...');

    // SQLite does not support DROP PRIMARY KEY or ADD CONSTRAINT on existing tables.
    // The only safe way is: create new table → copy data → drop old → rename.
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels_new (
        pk         INTEGER PRIMARY KEY AUTOINCREMENT,
        id         INTEGER NOT NULL,
        name       TEXT NOT NULL,
        psk        TEXT,
        role       INTEGER,
        uplinkEnabled    INTEGER NOT NULL DEFAULT 1,
        downlinkEnabled  INTEGER NOT NULL DEFAULT 1,
        positionPrecision INTEGER,
        createdAt  INTEGER NOT NULL,
        updatedAt  INTEGER NOT NULL,
        sourceId   TEXT,
        UNIQUE(sourceId, id)
      )
    `);

    // Copy all existing rows (sourceId may be NULL — UNIQUE constraint in SQLite
    // treats each NULL as distinct, so legacy rows survive the copy).
    db.exec(`
      INSERT INTO channels_new (id, name, psk, role, uplinkEnabled, downlinkEnabled,
                                positionPrecision, createdAt, updatedAt, sourceId)
      SELECT id, name, psk, role, uplinkEnabled, downlinkEnabled,
             positionPrecision, createdAt, updatedAt, sourceId
      FROM channels
    `);

    db.exec(`DROP TABLE channels`);
    db.exec(`ALTER TABLE channels_new RENAME TO channels`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_source_id ON channels(sourceId)`);

    logger.info('Migration 023 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 023 down: Not implemented (destructive schema reversal)');
  },
};

// ============ PostgreSQL ============

export async function runMigration023Postgres(client: any): Promise<void> {
  logger.info('Running migration 023 (PostgreSQL): Rebuilding channels table for multi-source...');

  // Check if pk column already exists (idempotent guard)
  const colCheck = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'channels' AND column_name = 'pk'
  `);
  if (colCheck.rows.length > 0) {
    logger.info('Migration 023 (PostgreSQL): channels.pk already exists, skipping');
    return;
  }

  // Drop existing primary key on id
  await client.query(`
    ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_pkey
  `);

  // Add surrogate serial pk
  await client.query(`
    ALTER TABLE channels ADD COLUMN pk SERIAL PRIMARY KEY
  `);

  // Add unique constraint on (sourceId, id)
  await client.query(`
    ALTER TABLE channels
      ADD CONSTRAINT channels_source_id_uniq UNIQUE ("sourceId", id)
  `);

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_channels_source_id ON channels("sourceId")`
  );

  logger.info('Migration 023 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration023Mysql(pool: any): Promise<void> {
  logger.info('Running migration 023 (MySQL): Rebuilding channels table for multi-source...');

  const conn = await pool.getConnection();
  try {
    // Idempotent check
    const [pkRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channels' AND COLUMN_NAME = 'pk'`
    );
    if (Array.isArray(pkRows) && pkRows.length > 0) {
      logger.info('Migration 023 (MySQL): channels.pk already exists, skipping');
      return;
    }

    // Drop existing PK (MySQL requires the PK to be named 'PRIMARY')
    await conn.query(`ALTER TABLE channels DROP PRIMARY KEY`);

    // Add surrogate auto-increment pk as new PK
    await conn.query(`
      ALTER TABLE channels ADD COLUMN pk INT AUTO_INCREMENT PRIMARY KEY FIRST
    `);

    // Add unique constraint on (sourceId, id)
    await conn.query(`
      ALTER TABLE channels ADD UNIQUE KEY channels_source_id_uniq (sourceId, id)
    `);

    await conn.query(
      `CREATE INDEX idx_channels_source_id ON channels(sourceId)`
    ).catch(() => {
      logger.debug('idx_channels_source_id already exists');
    });
  } finally {
    conn.release();
  }

  logger.info('Migration 023 complete (MySQL)');
}
```

- [ ] **Step 2: Register migration in migrations.ts**

At the top of `src/db/migrations.ts`, add the import after the migration 022 import line:

```typescript
import { migration as multiSourceChannelsMigration, runMigration023Postgres, runMigration023Mysql } from '../server/migrations/023_multi_source_channels.js';
```

At the bottom of `src/db/migrations.ts`, add the registration:

```typescript
// ---------------------------------------------------------------------------
// Migration 023: Multi-source channels table rebuild
// Changes channels table PK to surrogate key + UNIQUE(sourceId, id) constraint
// so each source has its own independent channel slots.
// ---------------------------------------------------------------------------

registry.register({
  number: 23,
  name: 'multi_source_channels',
  settingsKey: 'migration_023_multi_source_channels',
  sqlite: (db) => multiSourceChannelsMigration.up(db),
  postgres: (client) => runMigration023Postgres(client),
  mysql: (pool) => runMigration023Mysql(pool),
});
```

- [ ] **Step 3: Update migrations.test.ts**

In `src/db/migrations.test.ts`, update the three assertions:

```typescript
it('has all 23 migrations registered', () => {
  expect(registry.count()).toBe(23);
});
```

```typescript
it('last migration is multi_source_channels', () => {
  const all = registry.getAll();
  const last = all[all.length - 1];
  expect(last.number).toBe(23);
  expect(last.name).toContain('multi_source_channels');
});
```

```typescript
it('migrations are sequentially numbered from 1 to 23', () => {
  const all = registry.getAll();
  for (let i = 0; i < all.length; i++) {
    expect(all[i].number).toBe(i + 1);
  }
});
```

- [ ] **Step 4: Run migration tests**

```bash
cd /home/yeraze/Development/meshmonitor
npx vitest run src/db/migrations.test.ts 2>&1
```

Expected: All 4 tests pass. If they fail, check the import path and registration block.

- [ ] **Step 5: Commit migration**

```bash
git add src/server/migrations/023_multi_source_channels.ts src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat: migration 023 — rebuild channels table for multi-source isolation

Add surrogate pk PK + UNIQUE(sourceId, id) so each source maintains
its own independent set of channel slots (0-7) without collision.
Existing data is preserved during the table recreation.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 3: Update channels repository

**Files:**
- Modify: `src/db/repositories/channels.ts`

The key changes:
1. `getChannelById(id, sourceId?)` — when `sourceId` is given, filter by `(id AND sourceId)`; otherwise return first match by id (backward compat for legacy single-source callers)
2. `upsertChannel(data, sourceId?)` — look up by `(id, sourceId)` composite; include `sourceId` in the UPDATE SET so it gets stamped if missing
3. `getChannelCount(sourceId?)` — add source scoping

- [ ] **Step 1: Read the current repository**

Read `src/db/repositories/channels.ts` fully before editing.

- [ ] **Step 2: Update `getChannelById`**

Replace the existing `getChannelById` method (lines 36-51) with:

```typescript
/**
 * Get a channel by slot number, optionally scoped to a source.
 * When sourceId is provided, only returns the channel belonging to that source.
 * Without sourceId, returns the first matching row (legacy single-source behaviour).
 */
async getChannelById(id: number, sourceId?: string): Promise<DbChannel | null> {
  const { channels } = this.tables;

  const whereClause = sourceId
    ? and(eq(channels.id, id), eq(channels.sourceId, sourceId))
    : eq(channels.id, id);

  const result = await this.db
    .select()
    .from(channels)
    .where(whereClause)
    .limit(1);

  if (result.length === 0) return null;

  const channel = result[0];
  if (id === 0) {
    logger.info(`getChannelById(0) - RAW from DB: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
  }
  return this.normalizeBigInts(channel) as DbChannel;
}
```

- [ ] **Step 3: Update `getChannelCount`**

Replace the existing `getChannelCount` method (lines 70-74) with:

```typescript
/**
 * Get the total number of channels, optionally scoped to a source.
 */
async getChannelCount(sourceId?: string): Promise<number> {
  const { channels } = this.tables;
  const whereClause = this.withSourceScope(channels, sourceId);
  const result = whereClause
    ? await this.db.select({ count: count() }).from(channels).where(whereClause)
    : await this.db.select({ count: count() }).from(channels);
  return Number(result[0].count);
}
```

- [ ] **Step 4: Update `upsertChannel`**

Replace the existing `upsertChannel` method (lines 82-148) with the version below.
Key differences:
- Lookup uses `(id, sourceId)` composite when sourceId is provided
- UPDATE SET includes `sourceId` to stamp it if the row was previously NULL-sourced
- INSERT always sets `sourceId`

```typescript
/**
 * Insert or update a channel.
 * Enforces channel role rules:
 * - Channel 0 must always be PRIMARY (role=1)
 * - Other channels cannot be PRIMARY (will be forced to SECONDARY)
 *
 * When sourceId is provided the lookup uses (id, sourceId) so each source
 * manages its own independent set of channel slots.
 */
async upsertChannel(channelData: ChannelInput, sourceId?: string): Promise<void> {
  const now = this.now();
  let data = { ...channelData };
  const { channels } = this.tables;

  // Enforce role rules
  if (data.id === 0 && data.role === 0) {
    logger.warn(`Blocking attempt to set Channel 0 role to DISABLED (0), forcing to PRIMARY (1)`);
    data.role = 1;
  }

  if (data.id > 0 && data.role === 1) {
    logger.warn(`Blocking attempt to set Channel ${data.id} role to PRIMARY (1), forcing to SECONDARY (2)`);
    logger.warn(`Only Channel 0 can be PRIMARY - all other channels must be SECONDARY or DISABLED`);
    data.role = 2;
  }

  logger.info(`upsertChannel called with ID: ${data.id}, name: "${data.name}" (length: ${data.name.length})`);

  // Look up existing channel using composite key when sourceId is available
  const existingChannel = await this.getChannelById(data.id, sourceId);
  logger.info(`getChannelById(${data.id}, sourceId=${sourceId ?? 'none'}) returned: ${existingChannel ? `"${existingChannel.name}"` : 'null'}`);

  if (existingChannel) {
    // Update existing channel
    // Preserve existing non-empty name if incoming name is empty (fixes #1567)
    const effectiveName = data.name || existingChannel.name;
    logger.info(`Updating channel ${existingChannel.id}: name "${existingChannel.name}" -> "${effectiveName}" (incoming: "${data.name}")`);

    const updateSet: any = {
      name: effectiveName,
      psk: (data.psk !== undefined && data.psk !== '') ? data.psk : existingChannel.psk,
      role: data.role ?? existingChannel.role,
      uplinkEnabled: data.uplinkEnabled ?? existingChannel.uplinkEnabled,
      downlinkEnabled: data.downlinkEnabled ?? existingChannel.downlinkEnabled,
      positionPrecision: data.positionPrecision ?? existingChannel.positionPrecision,
      updatedAt: now,
    };
    // Stamp sourceId on existing rows that were created without it (legacy migration)
    if (sourceId && !(existingChannel as any).sourceId) {
      updateSet.sourceId = sourceId;
    }

    // Update by pk (surrogate PK) so we target exactly this source's row
    const existingPk = (existingChannel as any).pk;
    if (existingPk !== undefined) {
      await this.db
        .update(channels)
        .set(updateSet)
        .where(eq((channels as any).pk, existingPk));
    } else {
      // Fallback for environments where pk is not yet present (shouldn't happen post-migration)
      await this.db
        .update(channels)
        .set(updateSet)
        .where(eq(channels.id, existingChannel.id));
    }

    logger.info(`Updated channel ${existingChannel.id}`);
  } else {
    // Create new channel
    logger.debug(`Creating new channel with ID: ${data.id}`);

    const newChannel: any = {
      id: data.id,
      name: data.name,
      psk: data.psk ?? null,
      role: data.role ?? null,
      uplinkEnabled: data.uplinkEnabled ?? true,
      downlinkEnabled: data.downlinkEnabled ?? true,
      positionPrecision: data.positionPrecision ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (sourceId) {
      newChannel.sourceId = sourceId;
    }
    await this.db.insert(channels).values(newChannel);

    logger.debug(`Created channel: ${data.name} (ID: ${data.id})`);
  }
}
```

- [ ] **Step 5: Update `deleteChannel` to accept optional sourceId**

Replace the existing `deleteChannel` method with:

```typescript
/**
 * Delete a channel by slot ID, optionally scoped to a source.
 */
async deleteChannel(id: number, sourceId?: string): Promise<void> {
  const { channels } = this.tables;
  const whereClause = sourceId
    ? and(eq(channels.id, id), eq(channels.sourceId, sourceId))
    : eq(channels.id, id);
  await this.db.delete(channels).where(whereClause);
}
```

- [ ] **Step 6: Run channel repository tests**

```bash
cd /home/yeraze/Development/meshmonitor
npx vitest run src/db/repositories/channels.test.ts 2>&1
```

Expected: All tests pass. If any fail, check that the `and` import from `drizzle-orm` is present at the top of the file.

- [ ] **Step 7: Commit repository changes**

```bash
git add src/db/repositories/channels.ts
git commit -m "fix: scope channel DB ops by sourceId for multi-source isolation

getChannelById, upsertChannel, getChannelCount, deleteChannel now all
accept an optional sourceId to scope their queries to a specific source.
Lookup in upsertChannel now uses the (id, sourceId) composite key so
channels from different sources no longer overwrite each other.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 4: Fix meshtasticManager channel calls

**Files:**
- Modify: `src/server/meshtasticManager.ts`

The manager has `this.sourceId` available throughout. Pass it to every channel DB call.

- [ ] **Step 1: Fix `preConfigChannelSnapshot` (around line 699)**

Find this code block:
```typescript
this.preConfigChannelSnapshot = (await databaseService.channels.getAllChannels())
  .map(ch => ({ id: ch.id, psk: ch.psk, name: ch.name }));
```

Change to:
```typescript
this.preConfigChannelSnapshot = (await databaseService.channels.getAllChannels(this.sourceId))
  .map(ch => ({ id: ch.id, psk: ch.psk, name: ch.name }));
```

- [ ] **Step 2: Fix `createDefaultChannels` (around line 867)**

Find this code:
```typescript
const existingChannel0 = await databaseService.channels.getChannelById(0);
if (!existingChannel0) {
  await databaseService.channels.upsertChannel({
    id: 0,
    name: 'Primary',
    role: 1  // PRIMARY
  });
```

Change to:
```typescript
const existingChannel0 = await databaseService.channels.getChannelById(0, this.sourceId);
if (!existingChannel0) {
  await databaseService.channels.upsertChannel({
    id: 0,
    name: 'Primary',
    role: 1  // PRIMARY
  }, this.sourceId);
```

- [ ] **Step 3: Fix `ensureBasicSetup` channel count (around line 887)**

Find:
```typescript
const channelCount = await databaseService.channels.getChannelCount();
```

Change to:
```typescript
const channelCount = await databaseService.channels.getChannelCount(this.sourceId);
```

- [ ] **Step 4: Fix `processChannelConfig` upsertChannel (around line 3590)**

Find the upsert call inside the channel processing loop (look for `'📡 Saving channel'`):
```typescript
await databaseService.channels.upsertChannel({
  id: channel.index,
  name: channelName,
  psk: pskString,
  role: channelRole,
  uplinkEnabled: channel.settings.uplinkEnabled ?? true,
  downlinkEnabled: channel.settings.downlinkEnabled ?? true,
  positionPrecision: positionPrecision !== undefined ? positionPrecision : undefined
});
```

Change to:
```typescript
await databaseService.channels.upsertChannel({
  id: channel.index,
  name: channelName,
  psk: pskString,
  role: channelRole,
  uplinkEnabled: channel.settings.uplinkEnabled ?? true,
  downlinkEnabled: channel.settings.downlinkEnabled ?? true,
  positionPrecision: positionPrecision !== undefined ? positionPrecision : undefined
}, this.sourceId);
```

- [ ] **Step 5: Fix device channel lookup in message processing (around line 4021)**

Find:
```typescript
const deviceChannels = await databaseService.channels.getAllChannels();
```

Change to:
```typescript
const deviceChannels = await databaseService.channels.getAllChannels(this.sourceId);
```

- [ ] **Step 6: Fix channel 0 existence check in message processing (around line 4041)**

Find:
```typescript
const channel0 = await databaseService.channels.getChannelById(0);
if (!channel0) {
  logger.debug('📡 Creating channel 0 for message (name will be set when device config syncs)');
  await databaseService.channels.upsertChannel({ id: 0, name: '', role: 1 });
}
```

Change to:
```typescript
const channel0 = await databaseService.channels.getChannelById(0, this.sourceId);
if (!channel0) {
  logger.debug('📡 Creating channel 0 for message (name will be set when device config syncs)');
  await databaseService.channels.upsertChannel({ id: 0, name: '', role: 1 }, this.sourceId);
}
```

- [ ] **Step 7: Search for any remaining unscoped channel calls in meshtasticManager**

Run this to find any remaining unscoped channel calls in meshtasticManager.ts:

```bash
grep -n "databaseService\.channels\." /home/yeraze/Development/meshmonitor/src/server/meshtasticManager.ts
```

For each `getAllChannels()` call without args, add `this.sourceId`.
For each `getChannelById(N)` call without sourceId (where `N` is a literal or variable), add `, this.sourceId`.
For each `upsertChannel({...})` call without sourceId, add `, this.sourceId`.

Check lines around 6339, 6464, 6911, 9550, 11296 from the earlier grep output.

- [ ] **Step 8: Run meshtasticManager tests**

```bash
cd /home/yeraze/Development/meshmonitor
npx vitest run src/server/meshtasticManager.test.ts 2>&1 | tail -20
```

Expected: Pass. If tests use mocked channel calls, they should still work since the new sourceId parameter is optional.

- [ ] **Step 9: Commit meshtasticManager changes**

```bash
git add src/server/meshtasticManager.ts
git commit -m "fix: pass this.sourceId to all channel DB operations in meshtasticManager

Channels from different sources no longer overwrite each other because
every upsertChannel, getAllChannels, getChannelById, and getChannelCount
call is now scoped to the current source's ID.

Fixes the 'channel flapping' half of MES-10.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 5: Fix message send routing

**Files:**
- Modify: `src/server/server.ts` (around line 3213)

The `POST /api/messages/send` endpoint currently always uses the singleton `meshtasticManager`. It needs to accept an optional `sourceId` and look up the correct manager.

- [ ] **Step 1: Verify sourceManagerRegistry is imported in server.ts**

```bash
grep -n "sourceManagerRegistry" /home/yeraze/Development/meshmonitor/src/server/server.ts | head -5
```

Expected: the import already exists (it's used around line 539). If not, add:
```typescript
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
```

- [ ] **Step 2: Update the send endpoint**

Find the `POST /api/messages/send` handler (around line 3213). The line that currently reads:
```typescript
const { text, channel, destination, replyId, emoji } = req.body;
```

Change to:
```typescript
const { text, channel, destination, replyId, emoji, sourceId: reqSourceId } = req.body;
```

Then find the two lines (around 3283-3285):
```typescript
// Note: sendTextMessage() now handles saving the message to the database
// Pass userId so sent messages are automatically marked as read for the sender
await meshtasticManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji, req.user?.id);
```

Replace with:
```typescript
// Route to the correct source manager when sourceId is provided
const activeManager = (reqSourceId
  ? (sourceManagerRegistry.getManager(reqSourceId) as typeof meshtasticManager ?? meshtasticManager)
  : meshtasticManager);

// Note: sendTextMessage() now handles saving the message to the database
// Pass userId so sent messages are automatically marked as read for the sender
await activeManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji, req.user?.id);
```

- [ ] **Step 3: Run server-related tests**

```bash
cd /home/yeraze/Development/meshmonitor
npx vitest run src/server/routes/messageRoutes.test.ts 2>&1 | tail -20
```

Expected: All pass. No new failures.

- [ ] **Step 4: Commit server fix**

```bash
git add src/server/server.ts
git commit -m "fix: route POST /api/messages/send to correct source manager

Accept optional sourceId in request body and look up the matching
manager from sourceManagerRegistry. Falls back to the singleton when
sourceId is absent, preserving backward compatibility.

Fixes the 'wrong source' half of MES-10.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 6: Fix frontend to pass sourceId when sending

**Files:**
- Modify: `src/App.tsx`

`useSource()` already returns `sourceId` (line 116). It just isn't being passed to the send API.

- [ ] **Step 1: Find the three send call sites**

```bash
grep -n "api/messages/send" /home/yeraze/Development/meshmonitor/src/App.tsx
```

Expected output shows three line numbers (DM send ~2967, tapback send ~3047, channel message send ~3495).

- [ ] **Step 2: Update DM send (around line 2967)**

Find the JSON body for the DM send:
```typescript
body: JSON.stringify({
  text: messageText,
  channel: 0, // Backend may expect channel 0 for DMs
  destination: destinationNodeId,
  replyId: replyId,
}),
```

Change to:
```typescript
body: JSON.stringify({
  text: messageText,
  channel: 0, // Backend may expect channel 0 for DMs
  destination: destinationNodeId,
  replyId: replyId,
  sourceId: sourceId || undefined,
}),
```

- [ ] **Step 3: Update tapback send (around line 3047)**

Find the tapback `body: JSON.stringify(requestBody)`. The `requestBody` is built in an if/else block above it (around lines 3031-3044). Both branches need sourceId added.

For the DM branch (around line 3031):
```typescript
requestBody = {
  text: emoji,
  destination: toNodeId,
  replyId: replyId,
  emoji: EMOJI_FLAG,
};
```
Change to:
```typescript
requestBody = {
  text: emoji,
  destination: toNodeId,
  replyId: replyId,
  emoji: EMOJI_FLAG,
  sourceId: sourceId || undefined,
};
```

For the channel branch (around line 3038):
```typescript
requestBody = {
  text: emoji,
  channel: originalMessage.channel,
  replyId: replyId,
  emoji: EMOJI_FLAG,
};
```
Change to:
```typescript
requestBody = {
  text: emoji,
  channel: originalMessage.channel,
  replyId: replyId,
  emoji: EMOJI_FLAG,
  sourceId: sourceId || undefined,
};
```

- [ ] **Step 4: Update channel message send (around line 3495)**

Find:
```typescript
body: JSON.stringify({
  text: messageText,
  channel: messageChannel,
  replyId: replyId,
}),
```

Change to:
```typescript
body: JSON.stringify({
  text: messageText,
  channel: messageChannel,
  replyId: replyId,
  sourceId: sourceId || undefined,
}),
```

- [ ] **Step 5: Check for any other message send calls in App.tsx**

```bash
grep -n "api/messages/send" /home/yeraze/Development/meshmonitor/src/App.tsx
```

There should be exactly 3 results. If there are more, add `sourceId: sourceId || undefined` to each.

- [ ] **Step 6: Check App.tsx builds without TypeScript errors**

```bash
cd /home/yeraze/Development/meshmonitor
npx tsc --noEmit 2>&1 | grep -i "app\.tsx" | head -10
```

Expected: No errors in App.tsx.

- [ ] **Step 7: Commit frontend changes**

```bash
git add src/App.tsx
git commit -m "fix: pass sourceId to POST /api/messages/send from frontend

When viewing a specific source, the active sourceId from SourceContext
is now included in all message send requests so the backend routes the
message through the correct source's radio.

Fixes MES-10 message routing.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 7: Full test suite and docker build verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full Vitest suite**

```bash
cd /home/yeraze/Development/meshmonitor
npx vitest run 2>&1 | tail -30
```

Expected: 0 failures. If any failures appear, investigate and fix before proceeding.

- [ ] **Step 2: Build the docker dev image**

```bash
cd /home/yeraze/Development/meshmonitor
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build 2>&1 | tail -20
```

Expected: Build completes successfully with no TypeScript compilation errors.

- [ ] **Step 3: Start dev container and verify migration runs**

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d 2>&1
sleep 10
docker compose -f docker-compose.dev.yml logs meshmonitor 2>&1 | grep -i "migration 023\|023\|multi_source"
```

Expected: See `Migration 023 complete (SQLite)` in the logs.

- [ ] **Step 4: Verify channels API works**

```bash
./scripts/api-test.sh login
./scripts/api-test.sh get /api/poll | jq '.channels'
```

Expected: Returns the channels array (not null/empty).

- [ ] **Step 5: Shut down container before running system tests**

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml down
```

- [ ] **Step 6: Run system tests**

```bash
cd /home/yeraze/Development/meshmonitor
bash tests/system-tests.sh 2>&1 | tail -30
```

Expected: All system tests pass.

- [ ] **Step 7: Create final summary comment on MES-10**

Post to the MES-10 task explaining what was fixed, what files changed, and that the system is ready for board review / PR approval.

---

## Notes

- The server.ts admin channel config endpoints (`PUT /api/channels/:id`, etc.) still use the singleton `meshtasticManager` and don't scope by sourceId. This is a follow-up task (they affect single-source use cases correctly; multi-source channel config from the admin UI is not yet implemented).
- The `getChannelById(id)` without sourceId still works for backward compatibility — it returns the first matching row, which is fine for single-source deployments.
- The UNIQUE constraint on `(sourceId, id)` in SQLite treats NULL values as distinct (i.e., two rows with `(NULL, 0)` are allowed). The `assignNullSourceIds` startup routine will migrate those to a real sourceId before any new writes, so this is not a problem in practice.
