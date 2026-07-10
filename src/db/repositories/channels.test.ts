/**
 * Multi-Database Channels Repository Tests
 *
 * Validates ChannelsRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { ChannelsRepository } from './channels.js';
import { ALL_SOURCES } from './base.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

// SQL for creating the channels + sources tables per backend.
// `sources` is required because cleanupInvalidChannels reads source.type to
// exempt MeshCore-owned channels from the 0-7 slot cap.
// Note: SQLite DDL is now provided by createTestDb() via the migration registry.

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS channels CASCADE;
  CREATE TABLE channels (
    pk SERIAL PRIMARY KEY,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    psk TEXT,
    role INTEGER DEFAULT 0,
    "uplinkEnabled" BOOLEAN DEFAULT false,
    "downlinkEnabled" BOOLEAN DEFAULT false,
    "positionPrecision" INTEGER DEFAULT 0,
    "createdAt" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" BIGINT NOT NULL DEFAULT 0,
    "sourceId" TEXT,
    scope TEXT,
    UNIQUE ("sourceId", id)
  );
  DROP TABLE IF EXISTS sources CASCADE;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    "createdAt" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" BIGINT NOT NULL DEFAULT 0,
    "createdBy" INTEGER
  );
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS channels;
  CREATE TABLE channels (
    pk INT AUTO_INCREMENT PRIMARY KEY,
    id INTEGER NOT NULL,
    name VARCHAR(64) NOT NULL,
    psk VARCHAR(64),
    role INTEGER DEFAULT 0,
    uplinkEnabled BOOLEAN DEFAULT false,
    downlinkEnabled BOOLEAN DEFAULT false,
    positionPrecision INTEGER DEFAULT 0,
    createdAt BIGINT NOT NULL DEFAULT 0,
    updatedAt BIGINT NOT NULL DEFAULT 0,
    sourceId VARCHAR(36),
    scope VARCHAR(64),
    UNIQUE KEY channels_source_id_uniq (sourceId, id)
  );
  DROP TABLE IF EXISTS sources;
  CREATE TABLE sources (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL,
    config VARCHAR(4096) NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    createdAt BIGINT NOT NULL DEFAULT 0,
    updatedAt BIGINT NOT NULL DEFAULT 0,
    createdBy INT
  );
`;

/**
 * Shared test suite that runs against any backend.
 * Call within a describe() block with a function that returns the current backend.
 */
function runChannelsTests(getBackend: () => TestBackend) {
  let repo: ChannelsRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new ChannelsRepository(backend.drizzleDb, backend.dbType);
  });

  it('upsertChannel - insert new channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'AQ==', role: 1 });

    const channel = await repo.getChannelById(0);
    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('Primary');
    expect(channel!.psk).toBe('AQ==');
    expect(channel!.role).toBe(1);
  });

  it('upsertChannel - update existing channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 1, name: 'TestChan', psk: 'abc123', role: 2 });
    await repo.upsertChannel({ id: 1, name: 'UpdatedChan', psk: 'xyz789', role: 2 });

    const channel = await repo.getChannelById(1);
    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('UpdatedChan');
    expect(channel!.psk).toBe('xyz789');
  });

  it('upsertChannel - preserves existing name when incoming name is empty', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 2, name: 'KeepMe', psk: 'psk1', role: 2 });
    await repo.upsertChannel({ id: 2, name: '', psk: 'psk2', role: 2 });

    const channel = await repo.getChannelById(2);
    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('KeepMe');
  });

  // --- MeshCore region/scope (#3667) ------------------------------------

  it('upsertChannel - persists scope on insert and update', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 4, name: 'Scoped', psk: 'p', role: 2, scope: 'muenchen' });
    expect((await repo.getChannelById(4))!.scope).toBe('muenchen');

    // Explicitly changing scope works...
    await repo.upsertChannel({ id: 4, name: 'Scoped', psk: 'p', role: 2, scope: 'berlin' });
    expect((await repo.getChannelById(4))!.scope).toBe('berlin');

    // ...and an empty string clears it.
    await repo.upsertChannel({ id: 4, name: 'Scoped', psk: 'p', role: 2, scope: '' });
    expect((await repo.getChannelById(4))!.scope ?? null).toBeNull();
  });

  it('upsertChannel - preserves existing scope when scope is omitted (sync must not clobber)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // User sets a scope...
    await repo.upsertChannel({ id: 5, name: 'Town', psk: 'p', role: 2, scope: 'muenchen' });
    // ...then a device re-sync upserts WITHOUT scope (the device never reports
    // it). The stored scope must survive — this is the load-bearing regression
    // guard for syncChannelsFromDevice.
    await repo.upsertChannel({ id: 5, name: 'Town', psk: 'p2', role: 2 }, undefined, { allowBlankName: true });

    const channel = await repo.getChannelById(5);
    expect(channel!.psk).toBe('p2');        // other fields still update
    expect(channel!.scope).toBe('muenchen'); // scope preserved
  });

  it('updateChannelScope - sets and clears scope without touching other fields', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 6, name: 'Chan6', psk: 'keepme', role: 2 });
    await repo.updateChannelScope(6, 'sample-west');
    let channel = await repo.getChannelById(6);
    expect(channel!.scope).toBe('sample-west');
    expect(channel!.name).toBe('Chan6');
    expect(channel!.psk).toBe('keepme');

    await repo.updateChannelScope(6, null);
    channel = await repo.getChannelById(6);
    expect(channel!.scope ?? null).toBeNull();
    expect(channel!.psk).toBe('keepme');
  });

  it('upsertChannel - enforces channel 0 as PRIMARY role', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Attempt to set channel 0 role to DISABLED (0) — should force to PRIMARY (1)
    await repo.upsertChannel({ id: 0, name: 'Primary', role: 0 });
    const channel = await repo.getChannelById(0);
    expect(channel).not.toBeNull();
    expect(channel!.role).toBe(1);
  });

  it('upsertChannel - prevents non-zero channels from being PRIMARY', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Attempt to set channel 3 role to PRIMARY (1) — should force to SECONDARY (2)
    await repo.upsertChannel({ id: 3, name: 'Secondary', role: 1 });
    const channel = await repo.getChannelById(3);
    expect(channel).not.toBeNull();
    expect(channel!.role).toBe(2);
  });

  it('getChannelById - returns null for non-existent channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const channel = await repo.getChannelById(99);
    expect(channel).toBeNull();
  });

  it('getChannelById - returns existing channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 5, name: 'Five', psk: 'psk5', role: 2 });
    const channel = await repo.getChannelById(5);
    expect(channel).not.toBeNull();
    expect(channel!.id).toBe(5);
    expect(channel!.name).toBe('Five');
  });

  it('getAllChannels - returns all channels ordered by ID', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 3, name: 'Three', psk: 'p3', role: 2 });
    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 1, name: 'One', psk: 'p1', role: 2 });

    const channels = await repo.getAllChannels(ALL_SOURCES);
    expect(channels.length).toBe(3);
    expect(channels[0].id).toBe(0);
    expect(channels[1].id).toBe(1);
    expect(channels[2].id).toBe(3);
  });

  // Regression: the POST /api/channels/reorder handler builds a slot-keyed Map
  // from getAllChannels() and writes each slot back to the source it is
  // reordering. MeshCore and Meshtastic channels share the `channels` table
  // and both use slot ids 0-7, so an UNSCOPED getAllChannels() would let a
  // MeshCore channel at slot N collide with the Meshtastic channel at slot N in
  // that Map — silently replacing a Meshtastic channel with a MeshCore one on
  // reorder. Scoping the read by sourceId is what keeps reorder isolated.
  it('getAllChannels - scopes by sourceId so reorder cannot bleed channels across sources', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Meshtastic source: slot 0 (Primary) and slot 1.
    await repo.upsertChannel({ id: 0, name: 'MT-Primary', psk: 'p0', role: 1 }, 'mt-1');
    await repo.upsertChannel({ id: 1, name: 'MT-Secondary', psk: 'p1', role: 2 }, 'mt-1');
    // MeshCore source: also occupies slots 0 and 1 in the same table.
    await repo.upsertChannel({ id: 0, name: 'MC-Public', psk: 'mc0', role: 1 }, 'mc-1');
    await repo.upsertChannel({ id: 1, name: 'MC-Room', psk: 'mc1', role: 2 }, 'mc-1');

    // Mirror the reorder handler: scoped read -> slot-keyed Map.
    const mtChannels = await repo.getAllChannels('mt-1');
    const mtBySlot = new Map(mtChannels.map(ch => [ch.id, ch]));
    expect(mtBySlot.get(0)!.name).toBe('MT-Primary');
    expect(mtBySlot.get(1)!.name).toBe('MT-Secondary');
    // No MeshCore channel leaked into the Meshtastic source's view.
    expect(mtChannels.every(ch => ch.name.startsWith('MT-'))).toBe(true);

    // And the reverse: the MeshCore source sees only its own channels.
    const mcChannels = await repo.getAllChannels('mc-1');
    expect(mcChannels.every(ch => ch.name.startsWith('MC-'))).toBe(true);
  });

  // #3712: the sync (SQLite-only) read helpers must also honor sourceId so
  // legacy sync callers don't get cross-source results.
  it('sync read helpers scope by sourceId (SQLite only)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }
    if (backend.dbType !== 'sqlite') return; // sync helpers are SQLite-only

    await repo.upsertChannel({ id: 0, name: 'A-Primary', psk: 'p0', role: 1 }, 'src-a');
    await repo.upsertChannel({ id: 1, name: 'A-Sec', psk: 'p1', role: 2 }, 'src-a');
    await repo.upsertChannel({ id: 0, name: 'B-Primary', psk: 'q0', role: 1 }, 'src-b');

    // getChannelById scoped
    expect((await repo.getChannelById(0, 'src-a'))!.name).toBe('A-Primary');
    expect((await repo.getChannelById(0, 'src-b'))!.name).toBe('B-Primary');

    // getAllChannels scoped
    expect((await repo.getAllChannels('src-a')).map(c => c.name).sort()).toEqual(['A-Primary', 'A-Sec']);
    expect((await repo.getAllChannels('src-b')).map(c => c.name)).toEqual(['B-Primary']);

    // getChannelCount scoped
    expect(await repo.getChannelCount('src-a')).toBe(2);
    expect(await repo.getChannelCount('src-b')).toBe(1);
    // Unscoped sees everything (legacy behaviour).
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(3);
  });

  it('getChannelCount - returns correct count', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(0);

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(1);

    await repo.upsertChannel({ id: 1, name: 'Secondary', psk: 'p1', role: 2 });
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(2);
  });

  it('deleteChannel - removes a channel by ID', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 1, name: 'Secondary', psk: 'p1', role: 2 });

    await repo.deleteChannel(1);

    expect(await repo.getChannelById(1)).toBeNull();
    expect(await repo.getChannelById(0)).not.toBeNull();
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(1);
  });

  it('deleteChannel - no-op for non-existent channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.deleteChannel(99);
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(1);
  });

  it('cleanupInvalidChannels - removes channels outside 0-7 range', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const [cat, uat] = backend.dbType === 'postgres' ? ['"createdAt"', '"updatedAt"'] : ['createdAt', 'updatedAt'];

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 5, name: 'Valid', psk: 'p5', role: 2 });
    await repo.upsertChannel({ id: 7, name: 'MaxValid', psk: 'p7', role: 2 });

    // Insert invalid channels via raw SQL (IDs outside 0-7)
    const backend2 = getBackend();
    await backend2.exec(`INSERT INTO channels (id, name, psk, role, ${cat}, ${uat}) VALUES (8, 'Invalid8', 'psk', 2, 0, 0)`);
    await backend2.exec(`INSERT INTO channels (id, name, psk, role, ${cat}, ${uat}) VALUES (100, 'Invalid100', 'psk', 2, 0, 0)`);

    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(5);

    const deleted = await repo.cleanupInvalidChannels();
    expect(deleted).toBe(2);
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(3);
    expect(await repo.getChannelById(8)).toBeNull();
    expect(await repo.getChannelById(100)).toBeNull();
  });

  it('cleanupInvalidChannels - returns 0 when no invalid channels', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 3, name: 'Valid', psk: 'p3', role: 2 });

    const deleted = await repo.cleanupInvalidChannels();
    expect(deleted).toBe(0);
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(2);
  });

  it('cleanupInvalidChannels - preserves out-of-range channels owned by a MeshCore source', async () => {
    // MeshCore devices report a device-dependent number of channels; the 0-7
    // slot cap is a Meshtastic-only convention. cleanupInvalidChannels must
    // only apply the cap to Meshtastic-owned (or unscoped) channels.
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // PostgreSQL preserves camelCase only when the identifier is double-quoted;
    // MySQL's default sql_mode treats "..." as a string literal, not an
    // identifier. So `sourceId` needs dialect-specific quoting on the raw SQL
    // path. SQLite is happy either way.
    const [cat, uat] = backend.dbType === 'postgres' ? ['"createdAt"', '"updatedAt"'] : ['createdAt', 'updatedAt'];
    const sourceIdCol = backend.dbType === 'postgres' ? '"sourceId"' : 'sourceId';

    // Set up two sources: one MeshCore, one Meshtastic.
    await backend.exec(`INSERT INTO sources (id, name, type, config, ${cat}, ${uat}) VALUES ('mc-1', 'My MeshCore', 'meshcore', '{}', 0, 0)`);
    await backend.exec(`INSERT INTO sources (id, name, type, config, ${cat}, ${uat}) VALUES ('mt-1', 'My Meshtastic', 'meshtastic_tcp', '{}', 0, 0)`);

    // MeshCore source has a channel at idx 8 (legal for its device).
    await backend.exec(`INSERT INTO channels (id, name, psk, ${sourceIdCol}, ${cat}, ${uat}) VALUES (8, 'MC-Eight', 'aGVsbG8=', 'mc-1', 0, 0)`);
    // Meshtastic source has an invalid channel at idx 8 (should be removed).
    await backend.exec(`INSERT INTO channels (id, name, psk, ${sourceIdCol}, ${cat}, ${uat}) VALUES (8, 'MT-Eight', 'aGVsbG8=', 'mt-1', 0, 0)`);
    // A legacy NULL-sourceId channel at idx 9 (implicitly Meshtastic; should be removed).
    await backend.exec(`INSERT INTO channels (id, name, psk, ${cat}, ${uat}) VALUES (9, 'Legacy-Nine', 'aGVsbG8=', 0, 0)`);

    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(3);

    const deleted = await repo.cleanupInvalidChannels();
    expect(deleted).toBe(2);

    // MeshCore row survived.
    const survivor = await repo.getChannelById(8, 'mc-1');
    expect(survivor).not.toBeNull();
    expect(survivor!.name).toBe('MC-Eight');

    // Meshtastic row + legacy row gone.
    expect(await repo.getChannelById(8, 'mt-1')).toBeNull();
    expect(await repo.getChannelById(9)).toBeNull();
  });

  it('cleanupEmptyChannels - removes channels with id > 1 and no psk/role', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Channel 0 and 1 should be kept regardless
    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 1, name: 'Chan1', role: 2 });

    // Channel 2 with psk — should be kept
    await repo.upsertChannel({ id: 2, name: 'HasPsk', psk: 'somepsk', role: 2 });

    const [cat, uat] = backend.dbType === 'postgres' ? ['"createdAt"', '"updatedAt"'] : ['createdAt', 'updatedAt'];

    // Channels 3 and 4 with no psk and no role — should be removed
    // Must explicitly set psk and role to NULL (not default 0)
    const backend2 = getBackend();
    await backend2.exec(`INSERT INTO channels (id, name, psk, role, ${cat}, ${uat}) VALUES (3, 'Empty3', NULL, NULL, 0, 0)`);
    await backend2.exec(`INSERT INTO channels (id, name, psk, role, ${cat}, ${uat}) VALUES (4, 'Empty4', NULL, NULL, 0, 0)`);

    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(5);

    const deleted = await repo.cleanupEmptyChannels();
    expect(deleted).toBe(2);
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(3);
    expect(await repo.getChannelById(3)).toBeNull();
    expect(await repo.getChannelById(4)).toBeNull();
    // Protected channels still exist
    expect(await repo.getChannelById(0)).not.toBeNull();
    expect(await repo.getChannelById(1)).not.toBeNull();
    expect(await repo.getChannelById(2)).not.toBeNull();
  });

  it('cleanupEmptyChannels - does not remove channels 0 or 1', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const [cat, uat] = backend.dbType === 'postgres' ? ['"createdAt"', '"updatedAt"'] : ['createdAt', 'updatedAt'];

    // Insert channels 0 and 1 with no psk/role via raw SQL
    const backend2 = getBackend();
    await backend2.exec(`INSERT INTO channels (id, name, psk, role, ${cat}, ${uat}) VALUES (0, 'Primary', NULL, NULL, 0, 0)`);
    await backend2.exec(`INSERT INTO channels (id, name, psk, role, ${cat}, ${uat}) VALUES (1, 'Chan1', NULL, NULL, 0, 0)`);

    const deleted = await repo.cleanupEmptyChannels();
    expect(deleted).toBe(0);
    expect(await repo.getChannelCount(ALL_SOURCES)).toBe(2);
  });

  it('cleanupEmptyChannels - returns 0 when no empty channels', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 2, name: 'HasPsk', psk: 'somepsk', role: 2 });

    const deleted = await repo.cleanupEmptyChannels();
    expect(deleted).toBe(0);
  });
}

// --- SQLite Backend ---
describe('ChannelsRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runChannelsTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('ChannelsRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for channels tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'channels');
    await clearTable(backend, 'sources');
  });

  runChannelsTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('ChannelsRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for channels tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'channels');
    await clearTable(backend, 'sources');
  });

  runChannelsTests(() => backend);
});
