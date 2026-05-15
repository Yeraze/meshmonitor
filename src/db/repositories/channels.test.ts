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
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

// SQL for creating the channels + sources tables per backend.
// `sources` is required because cleanupInvalidChannels reads source.type to
// exempt MeshCore-owned channels from the 0-7 slot cap.
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS channels (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    psk TEXT,
    role INTEGER DEFAULT 0,
    uplinkEnabled INTEGER DEFAULT 0,
    downlinkEnabled INTEGER DEFAULT 0,
    positionPrecision INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    sourceId TEXT,
    UNIQUE(sourceId, id)
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    createdBy INTEGER
  );
`;

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

    const channels = await repo.getAllChannels();
    expect(channels.length).toBe(3);
    expect(channels[0].id).toBe(0);
    expect(channels[1].id).toBe(1);
    expect(channels[2].id).toBe(3);
  });

  it('getChannelCount - returns correct count', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getChannelCount()).toBe(0);

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    expect(await repo.getChannelCount()).toBe(1);

    await repo.upsertChannel({ id: 1, name: 'Secondary', psk: 'p1', role: 2 });
    expect(await repo.getChannelCount()).toBe(2);
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
    expect(await repo.getChannelCount()).toBe(1);
  });

  it('deleteChannel - no-op for non-existent channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.deleteChannel(99);
    expect(await repo.getChannelCount()).toBe(1);
  });

  it('cleanupInvalidChannels - removes channels outside 0-7 range', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertChannel({ id: 0, name: 'Primary', psk: 'p0', role: 1 });
    await repo.upsertChannel({ id: 5, name: 'Valid', psk: 'p5', role: 2 });
    await repo.upsertChannel({ id: 7, name: 'MaxValid', psk: 'p7', role: 2 });

    // Insert invalid channels via raw SQL (IDs outside 0-7)
    const backend2 = getBackend();
    await backend2.exec(`INSERT INTO channels (id, name, psk, role) VALUES (8, 'Invalid8', 'psk', 2)`);
    await backend2.exec(`INSERT INTO channels (id, name, psk, role) VALUES (100, 'Invalid100', 'psk', 2)`);

    expect(await repo.getChannelCount()).toBe(5);

    const deleted = await repo.cleanupInvalidChannels();
    expect(deleted).toBe(2);
    expect(await repo.getChannelCount()).toBe(3);
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
    expect(await repo.getChannelCount()).toBe(2);
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
    const sourceIdCol = backend.dbType === 'postgres' ? '"sourceId"' : 'sourceId';

    // Set up two sources: one MeshCore, one Meshtastic.
    await backend.exec(`INSERT INTO sources (id, name, type, config) VALUES ('mc-1', 'My MeshCore', 'meshcore', '{}')`);
    await backend.exec(`INSERT INTO sources (id, name, type, config) VALUES ('mt-1', 'My Meshtastic', 'meshtastic_tcp', '{}')`);

    // MeshCore source has a channel at idx 8 (legal for its device).
    await backend.exec(`INSERT INTO channels (id, name, psk, ${sourceIdCol}) VALUES (8, 'MC-Eight', 'aGVsbG8=', 'mc-1')`);
    // Meshtastic source has an invalid channel at idx 8 (should be removed).
    await backend.exec(`INSERT INTO channels (id, name, psk, ${sourceIdCol}) VALUES (8, 'MT-Eight', 'aGVsbG8=', 'mt-1')`);
    // A legacy NULL-sourceId channel at idx 9 (implicitly Meshtastic; should be removed).
    await backend.exec(`INSERT INTO channels (id, name, psk) VALUES (9, 'Legacy-Nine', 'aGVsbG8=')`);

    expect(await repo.getChannelCount()).toBe(3);

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

    // Channels 3 and 4 with no psk and no role — should be removed
    // Must explicitly set psk and role to NULL (not default 0)
    const backend2 = getBackend();
    await backend2.exec(`INSERT INTO channels (id, name, psk, role) VALUES (3, 'Empty3', NULL, NULL)`);
    await backend2.exec(`INSERT INTO channels (id, name, psk, role) VALUES (4, 'Empty4', NULL, NULL)`);

    expect(await repo.getChannelCount()).toBe(5);

    const deleted = await repo.cleanupEmptyChannels();
    expect(deleted).toBe(2);
    expect(await repo.getChannelCount()).toBe(3);
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

    // Insert channels 0 and 1 with no psk/role via raw SQL
    const backend2 = getBackend();
    await backend2.exec(`INSERT INTO channels (id, name, psk, role) VALUES (0, 'Primary', NULL, NULL)`);
    await backend2.exec(`INSERT INTO channels (id, name, psk, role) VALUES (1, 'Chan1', NULL, NULL)`);

    const deleted = await repo.cleanupEmptyChannels();
    expect(deleted).toBe(0);
    expect(await repo.getChannelCount()).toBe(2);
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
    backend = createSqliteBackend(SQLITE_CREATE);
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
