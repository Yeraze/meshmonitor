/**
 * MeshCore Repository Tests
 *
 * Slice 1 of multi-source MeshCore: every write to `meshcore_nodes` /
 * `meshcore_messages` must be stamped with its owning sourceId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';

describe('MeshCoreRepository — sourceId stamping', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    // Match the post-migration-056 schema.
    db.exec(`
      CREATE TABLE meshcore_nodes (
        publicKey TEXT PRIMARY KEY,
        name TEXT,
        advType INTEGER,
        txPower INTEGER,
        maxTxPower INTEGER,
        radioFreq REAL,
        radioBw REAL,
        radioSf INTEGER,
        radioCr INTEGER,
        latitude REAL,
        longitude REAL,
        altitude REAL,
        batteryMv INTEGER,
        uptimeSecs INTEGER,
        rssi INTEGER,
        snr REAL,
        lastHeard INTEGER,
        hasAdminAccess INTEGER DEFAULT 0,
        lastAdminCheck INTEGER,
        isLocalNode INTEGER DEFAULT 0,
        sourceId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE meshcore_messages (
        id TEXT PRIMARY KEY,
        fromPublicKey TEXT NOT NULL,
        toPublicKey TEXT,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        rssi INTEGER,
        snr INTEGER,
        messageType TEXT DEFAULT 'text',
        delivered INTEGER DEFAULT 0,
        deliveredAt INTEGER,
        sourceId TEXT,
        createdAt INTEGER NOT NULL
      );
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('upsertNode stamps sourceId on insert', async () => {
    await repo.upsertNode({ publicKey: 'pk-1', name: 'first' }, 'src-a');

    const row = db.prepare(`SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-1'`).get() as {
      sourceId: string;
      name: string;
    };
    expect(row.sourceId).toBe('src-a');
    expect(row.name).toBe('first');
  });

  it('upsertNode stamps sourceId on update too', async () => {
    await repo.upsertNode({ publicKey: 'pk-1', name: 'first' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-1', name: 'updated' }, 'src-b');

    const row = db.prepare(`SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-1'`).get() as {
      sourceId: string;
      name: string;
    };
    expect(row.sourceId).toBe('src-b');
    expect(row.name).toBe('updated');
  });

  it('upsertNode throws when called without a sourceId', async () => {
    // @ts-expect-error — exercising runtime guard
    await expect(repo.upsertNode({ publicKey: 'pk-1' }, '')).rejects.toThrow(/requires a sourceId/);
  });

  it('insertMessage stamps sourceId', async () => {
    await repo.insertMessage(
      {
        id: 'm1',
        fromPublicKey: 'pk-1',
        text: 'hello',
        timestamp: 1000,
        createdAt: 1000,
      },
      'src-a',
    );

    const row = db.prepare(`SELECT sourceId, text FROM meshcore_messages WHERE id = 'm1'`).get() as {
      sourceId: string;
      text: string;
    };
    expect(row.sourceId).toBe('src-a');
    expect(row.text).toBe('hello');
  });

  it('insertMessage throws when called without a sourceId', async () => {
    await expect(
      repo.insertMessage(
        {
          id: 'm1',
          fromPublicKey: 'pk-1',
          text: 'hello',
          timestamp: 1000,
          createdAt: 1000,
        },
        '',
      ),
    ).rejects.toThrow(/requires a sourceId/);
  });
});
