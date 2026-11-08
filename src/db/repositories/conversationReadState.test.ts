/**
 * Multi-backend tests for ConversationReadStateRepository (#4607).
 *
 * The properties under test are the ones the unread divider depends on being
 * true regardless of backend: watermarks are per-user, per-source, per
 * conversation, and they never move backwards.
 *
 * SQLite always runs (in-memory, schema built from the migration registry).
 * PostgreSQL / MySQL run only when their test containers are up (5433 / 3307).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { ConversationReadStateRepository, emptyReadStateMap, isConversationKind, readStateUserId } from './conversationReadState.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS conversation_read_state CASCADE;
  CREATE TABLE conversation_read_state (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL,
    "conversationKind" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "lastReadAt" BIGINT NOT NULL,
    UNIQUE ("userId", "sourceId", "conversationKind", "conversationKey")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS conversation_read_state;
  CREATE TABLE conversation_read_state (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    userId INT NOT NULL,
    sourceId VARCHAR(64) NOT NULL,
    conversationKind VARCHAR(32) NOT NULL,
    conversationKey VARCHAR(128) NOT NULL,
    lastReadAt BIGINT NOT NULL,
    UNIQUE KEY idx_conversation_read_state_unique (userId, sourceId, conversationKind, conversationKey)
  )
`;

const ALL_TABLES = ['conversation_read_state'];

function runReadStateTests(getBackend: () => TestBackend) {
  let repo: ConversationReadStateRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new ConversationReadStateRepository(backend.drizzleDb, backend.dbType);
  });

  it('returns an empty, fully-populated map when nothing is stored', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const state = await repo.getForSourceAsync(1, 'src-a');
    // Every kind must be present so callers can index without guarding.
    expect(state).toEqual({ meshcore_channel: {}, meshcore_dm: {}, meshcore_room: {} });
  });

  it('round-trips a channel watermark', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '3', 1_700_000_000_000);

    const state = await repo.getForSourceAsync(1, 'src-a');
    expect(state.meshcore_channel['3']).toBe(1_700_000_000_000);
    expect(state.meshcore_dm).toEqual({});
  });

  it('never moves a watermark backwards', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', 'peerA', 5000);
    // A stale tab / late-landing write must not resurrect dismissed messages.
    const effective = await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', 'peerA', 4000);

    expect(effective).toBe(5000);
    const state = await repo.getForSourceAsync(1, 'src-a');
    expect(state.meshcore_dm.peerA).toBe(5000);
  });

  it('moves a watermark forward and reports the new value', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', 'peerA', 5000);
    const effective = await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', 'peerA', 9000);

    expect(effective).toBe(9000);
    const state = await repo.getForSourceAsync(1, 'src-a');
    expect(state.meshcore_dm.peerA).toBe(9000);
  });

  it('keeps watermarks isolated per user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    // This is the whole reason the table exists — localStorage could not tell
    // two operators apart on a shared browser.
    await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '0', 1000);
    await repo.setLastReadAsync(2, 'src-a', 'meshcore_channel', '0', 8000);

    expect((await repo.getForSourceAsync(1, 'src-a')).meshcore_channel['0']).toBe(1000);
    expect((await repo.getForSourceAsync(2, 'src-a')).meshcore_channel['0']).toBe(8000);
  });

  it('keeps watermarks isolated per source', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '0', 1000);
    await repo.setLastReadAsync(1, 'src-b', 'meshcore_channel', '0', 8000);

    expect((await repo.getForSourceAsync(1, 'src-a')).meshcore_channel['0']).toBe(1000);
    expect((await repo.getForSourceAsync(1, 'src-b')).meshcore_channel['0']).toBe(8000);
  });

  it('keeps channel and DM watermarks apart even when the key collides', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '0', 1000);
    await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', '0', 8000);

    const state = await repo.getForSourceAsync(1, 'src-a');
    expect(state.meshcore_channel['0']).toBe(1000);
    expect(state.meshcore_dm['0']).toBe(8000);
  });

  it('treats a null userId as the anonymous sentinel, distinct from user 0-less users', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(null, 'src-a', 'meshcore_channel', '0', 4000);
    await repo.setLastReadAsync(9, 'src-a', 'meshcore_channel', '0', 7000);

    expect((await repo.getForSourceAsync(null, 'src-a')).meshcore_channel['0']).toBe(4000);
    expect((await repo.getForSourceAsync(9, 'src-a')).meshcore_channel['0']).toBe(7000);
  });

  it('ignores writes with an empty source, key, or non-finite timestamp', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    expect(await repo.setLastReadAsync(1, '', 'meshcore_channel', '0', 1000)).toBe(0);
    expect(await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '', 1000)).toBe(0);
    expect(await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '0', Number.NaN)).toBe(0);

    expect(await repo.getForSourceAsync(1, 'src-a')).toEqual({ meshcore_channel: {}, meshcore_dm: {}, meshcore_room: {} });
  });

  it('round-trips a room watermark, apart from channel and DM keys', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_room', 'ab'.repeat(32), 5000);
    await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', 'ab'.repeat(32), 1000);
    const state = await repo.getForSourceAsync(1, 'src-a');
    expect(state.meshcore_room['ab'.repeat(32)]).toBe(5000);
    expect(state.meshcore_dm['ab'.repeat(32)]).toBe(1000);
    expect(state.meshcore_channel).toEqual({});
  });

  it('setManyLastReadAsync writes every entry, never rewinds, and returns effective values', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_dm', 'peerA', 9000);
    const out = await repo.setManyLastReadAsync(1, 'src-a', [
      { kind: 'meshcore_channel', conversationKey: '0', lastReadAt: 1000 },
      { kind: 'meshcore_dm', conversationKey: 'peerA', lastReadAt: 100 },
      { kind: 'meshcore_room', conversationKey: 'roomR', lastReadAt: 2000 },
    ]);
    expect(out).toEqual({
      meshcore_channel: { '0': 1000 },
      meshcore_dm: { peerA: 9000 },
      meshcore_room: { roomR: 2000 },
    });
    const state = await repo.getForSourceAsync(1, 'src-a');
    expect(state.meshcore_dm.peerA).toBe(9000);
    expect(state.meshcore_room.roomR).toBe(2000);
  });

  it('setManyLastReadAsync with no entries or no source is a no-op', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    expect(await repo.setManyLastReadAsync(1, 'src-a', [])).toEqual(emptyReadStateMap());
    expect(await repo.setManyLastReadAsync(1, '', [{ kind: 'meshcore_dm', conversationKey: 'p', lastReadAt: 5 }])).toEqual(emptyReadStateMap());
    expect(await repo.getForSourceAsync(1, 'src-a')).toEqual(emptyReadStateMap());
  });

  it('deletes every watermark for a source without touching the others', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setLastReadAsync(1, 'src-a', 'meshcore_channel', '0', 1000);
    await repo.setLastReadAsync(2, 'src-a', 'meshcore_dm', 'peer', 2000);
    await repo.setLastReadAsync(1, 'src-b', 'meshcore_channel', '0', 3000);

    await repo.deleteForSourceAsync('src-a');

    expect(await repo.getForSourceAsync(1, 'src-a')).toEqual({ meshcore_channel: {}, meshcore_dm: {}, meshcore_room: {} });
    expect((await repo.getForSourceAsync(1, 'src-b')).meshcore_channel['0']).toBe(3000);
  });
}

describe('conversationReadState helpers', () => {
  it('emptyReadStateMap lists every tracked kind', () => {
    expect(Object.keys(emptyReadStateMap()).sort()).toEqual(['meshcore_channel', 'meshcore_dm', 'meshcore_room']);
  });

  it('isConversationKind rejects anything not in the enum', () => {
    expect(isConversationKind('meshcore_dm')).toBe(true);
    expect(isConversationKind('meshtastic_channel')).toBe(false);
    expect(isConversationKind(undefined)).toBe(false);
    expect(isConversationKind(3)).toBe(false);
  });

  it('readStateUserId folds null/undefined onto the anonymous sentinel', () => {
    expect(readStateUserId(null)).toBe(0);
    expect(readStateUserId(undefined)).toBe(0);
    expect(readStateUserId(12)).toBe(12);
  });
});

// --- SQLite Backend ---
describe('ConversationReadStateRepository - SQLite Backend', () => {
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

  runReadStateTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('ConversationReadStateRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_conversationreadstate');
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for conversation read-state tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runReadStateTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('ConversationReadStateRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_conversationreadstate');
    if (backend.available) {
      console.log('✓ MySQL connection established for conversation read-state tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runReadStateTests(() => backend);
});
