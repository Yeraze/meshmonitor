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
        telemetryEnabled INTEGER DEFAULT 0,
        telemetryIntervalMinutes INTEGER DEFAULT 60,
        lastTelemetryRequestAt INTEGER,
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

  it('upsertNode updates same-source row in place', async () => {
    await repo.upsertNode({ publicKey: 'pk-1', name: 'first' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-1', name: 'updated' }, 'src-a');

    const row = db.prepare(`SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-1'`).get() as {
      sourceId: string;
      name: string;
    };
    expect(row.sourceId).toBe('src-a');
    expect(row.name).toBe('updated');
  });

  it('upsertNode does not let one source clobber another source\'s row', async () => {
    // Drop the SQLite PRIMARY KEY so the underlying schema can hold one
    // row per (publicKey, sourceId) — the eventual shape per the slice-1
    // PR description ("composite PK like Meshtastic"). Once that schema
    // change lands this guard goes away; the upsert-level scoping is
    // what we're proving here.
    db.exec(`
      DROP TABLE meshcore_nodes;
      CREATE TABLE meshcore_nodes (
        publicKey TEXT NOT NULL,
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
        sourceId TEXT NOT NULL,
        telemetryEnabled INTEGER DEFAULT 0,
        telemetryIntervalMinutes INTEGER DEFAULT 60,
        lastTelemetryRequestAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (publicKey, sourceId)
      );
    `);

    await repo.upsertNode({ publicKey: 'pk-shared', name: 'A-owned' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-shared', name: 'B-owned' }, 'src-b');

    const rows = db
      .prepare(`SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-shared' ORDER BY sourceId`)
      .all() as Array<{ sourceId: string; name: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ sourceId: 'src-a', name: 'A-owned' });
    expect(rows[1]).toEqual({ sourceId: 'src-b', name: 'B-owned' });
  });

  it('upsertNode lookup is sourceId-scoped (no cross-source UPDATE)', async () => {
    // Even with the singleton-PK schema in place, the repository must not
    // issue an UPDATE against another source's row. We seed src-a's row,
    // then have src-b try to upsert the same publicKey: src-a's row must
    // not be modified. (The INSERT may then collide on PK; that's a
    // schema-level concern handled by the composite-PK migration —
    // separately. The repository contract is the focus here.)
    await repo.upsertNode({ publicKey: 'pk-shared', name: 'A-owned' }, 'src-a');

    let threw = false;
    try {
      await repo.upsertNode({ publicKey: 'pk-shared', name: 'B-attempt' }, 'src-b');
    } catch {
      threw = true;
    }

    const aRow = db
      .prepare(`SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-shared' AND sourceId = 'src-a'`)
      .get() as { sourceId: string; name: string } | undefined;
    expect(aRow).toBeDefined();
    expect(aRow!.name).toBe('A-owned');
    // The row owned by src-a must never carry src-b's name.
    expect(aRow!.sourceId).toBe('src-a');
    // Either the INSERT collided (PK constraint) or it succeeded —
    // both are acceptable; the invariant is "src-a's row is untouched".
    expect(typeof threw).toBe('boolean');
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

  // ============ Per-node telemetry retrieval config (migration 060) ============

  it('setNodeTelemetryConfig inserts a stub row when none exists', async () => {
    await repo.setNodeTelemetryConfig('src-a', 'pk-new', {
      enabled: true,
      intervalMinutes: 15,
    });

    const row = db
      .prepare(
        `SELECT sourceId, telemetryEnabled, telemetryIntervalMinutes
         FROM meshcore_nodes WHERE publicKey = 'pk-new'`,
      )
      .get() as { sourceId: string; telemetryEnabled: number; telemetryIntervalMinutes: number };
    expect(row.sourceId).toBe('src-a');
    expect(row.telemetryEnabled).toBe(1);
    expect(row.telemetryIntervalMinutes).toBe(15);
  });

  it('setNodeTelemetryConfig updates an existing row in place', async () => {
    await repo.upsertNode({ publicKey: 'pk-1', name: 'a' }, 'src-a');
    await repo.setNodeTelemetryConfig('src-a', 'pk-1', { enabled: true });
    await repo.setNodeTelemetryConfig('src-a', 'pk-1', { intervalMinutes: 30 });

    const row = db
      .prepare(
        `SELECT telemetryEnabled, telemetryIntervalMinutes
         FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
      )
      .get() as { telemetryEnabled: number; telemetryIntervalMinutes: number };
    expect(row.telemetryEnabled).toBe(1);
    expect(row.telemetryIntervalMinutes).toBe(30);
  });

  it('setNodeTelemetryConfig is scoped by sourceId — same publicKey on two sources is independent', async () => {
    // Composite-PK schema mirrors the prior cross-source guard test: lets
    // one publicKey exist twice, scoped by sourceId. Must include every
    // column Drizzle's MeshCoreNode schema declares, since drizzle SELECT
    // pulls all of them by name.
    db.exec(`
      DROP TABLE meshcore_nodes;
      CREATE TABLE meshcore_nodes (
        publicKey TEXT NOT NULL,
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
        sourceId TEXT NOT NULL,
        telemetryEnabled INTEGER DEFAULT 0,
        telemetryIntervalMinutes INTEGER DEFAULT 60,
        lastTelemetryRequestAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (publicKey, sourceId)
      );
    `);
    await repo.upsertNode({ publicKey: 'pk-1', name: 'a' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-1', name: 'b' }, 'src-b');
    await repo.setNodeTelemetryConfig('src-a', 'pk-1', { enabled: true, intervalMinutes: 10 });
    await repo.setNodeTelemetryConfig('src-b', 'pk-1', { enabled: false, intervalMinutes: 90 });

    const rows = db
      .prepare(
        `SELECT sourceId, telemetryEnabled, telemetryIntervalMinutes
         FROM meshcore_nodes WHERE publicKey = 'pk-1' ORDER BY sourceId`,
      )
      .all() as Array<{ sourceId: string; telemetryEnabled: number; telemetryIntervalMinutes: number }>;
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.sourceId === 'src-a')!;
    const b = rows.find((r) => r.sourceId === 'src-b')!;
    expect(a.telemetryEnabled).toBe(1);
    expect(a.telemetryIntervalMinutes).toBe(10);
    expect(b.telemetryEnabled).toBe(0);
    expect(b.telemetryIntervalMinutes).toBe(90);
  });

  it('getTelemetryEnabledNodes only returns rows with telemetryEnabled=true and matching sourceId', async () => {
    await repo.upsertNode({ publicKey: 'pk-1' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-2' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-3' }, 'src-b');
    await repo.setNodeTelemetryConfig('src-a', 'pk-1', { enabled: true });
    await repo.setNodeTelemetryConfig('src-a', 'pk-2', { enabled: false });
    await repo.setNodeTelemetryConfig('src-b', 'pk-3', { enabled: true });

    const aResult = await repo.getTelemetryEnabledNodes('src-a');
    expect(aResult.map((n) => n.publicKey)).toEqual(['pk-1']);

    const bResult = await repo.getTelemetryEnabledNodes('src-b');
    expect(bResult.map((n) => n.publicKey)).toEqual(['pk-3']);
  });

  it('markTelemetryRequested stamps lastTelemetryRequestAt', async () => {
    await repo.upsertNode({ publicKey: 'pk-1' }, 'src-a');
    await repo.setNodeTelemetryConfig('src-a', 'pk-1', { enabled: true });
    await repo.markTelemetryRequested('src-a', 'pk-1', 999_999);

    const row = db
      .prepare(`SELECT lastTelemetryRequestAt FROM meshcore_nodes WHERE publicKey = 'pk-1'`)
      .get() as { lastTelemetryRequestAt: number };
    expect(row.lastTelemetryRequestAt).toBe(999_999);
  });

  it('setNodeTelemetryConfig throws without a sourceId', async () => {
    await expect(
      repo.setNodeTelemetryConfig('', 'pk-1', { enabled: true }),
    ).rejects.toThrow(/requires a sourceId/);
  });
});
