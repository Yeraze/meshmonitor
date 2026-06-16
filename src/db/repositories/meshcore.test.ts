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
        out_path TEXT,
        path_len INTEGER,
        adminCredential TEXT,
        roomSyncEnabled INTEGER DEFAULT 0,
        roomSyncIntervalMinutes INTEGER DEFAULT 60,
        lastRoomSyncAt INTEGER,
        lastRoomPostAt INTEGER,
        roomCredential TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE meshcore_messages (
        id TEXT PRIMARY KEY,
        fromPublicKey TEXT NOT NULL,
        fromName TEXT,
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

  it('upsertNode persists out_path and path_len round-trip', async () => {
    // Round-trip the MeshCore per-contact route columns (migration 068).
    // Drizzle treats `outPath`/`pathLen` as `out_path`/`path_len` per the
    // schema mapping, so a getNodeByPublicKey read should return the same
    // values we wrote.
    await repo.upsertNode(
      { publicKey: 'pk-path', outPath: 'a3,7f,02', pathLen: 3 },
      'src-a',
    );
    const row = db.prepare(
      `SELECT out_path AS outPath, path_len AS pathLen FROM meshcore_nodes WHERE publicKey = 'pk-path'`,
    ).get() as { outPath: string; pathLen: number };
    expect(row.outPath).toBe('a3,7f,02');
    expect(row.pathLen).toBe(3);

    // Updating with null clears the columns (CMD_RESET_PATH path).
    await repo.upsertNode(
      { publicKey: 'pk-path', outPath: null, pathLen: null },
      'src-a',
    );
    const cleared = db.prepare(
      `SELECT out_path AS outPath, path_len AS pathLen FROM meshcore_nodes WHERE publicKey = 'pk-path'`,
    ).get() as { outPath: string | null; pathLen: number | null };
    expect(cleared.outPath).toBeNull();
    expect(cleared.pathLen).toBeNull();
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

  it('upsertNode does NOT clobber stored name/position with incoming nulls (#3504)', async () => {
    // Seed a node with a learned name + position.
    await repo.upsertNode(
      { publicKey: 'pk-1', name: 'Repeater North', latitude: 43.65, longitude: -79.38 },
      'src-a',
    );
    // A later observation lacks position/name (e.g. a path-only advert), so the
    // callers pass `field ?? null`. These nulls must NOT wipe the stored values.
    await repo.upsertNode(
      { publicKey: 'pk-1', name: null, latitude: null, longitude: null, advType: 1 },
      'src-a',
    );

    const row = db.prepare(
      `SELECT name, latitude, longitude, advType FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
    ).get() as { name: string; latitude: number; longitude: number; advType: number };
    expect(row.name).toBe('Repeater North');
    expect(row.latitude).toBeCloseTo(43.65);
    expect(row.longitude).toBeCloseTo(-79.38);
    expect(row.advType).toBe(1); // a provided value still updates
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
        out_path TEXT,
        path_len INTEGER,
        adminCredential TEXT,
        roomSyncEnabled INTEGER DEFAULT 0,
        roomSyncIntervalMinutes INTEGER DEFAULT 60,
        lastRoomSyncAt INTEGER,
        lastRoomPostAt INTEGER,
        roomCredential TEXT,
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
        out_path TEXT,
        path_len INTEGER,
        adminCredential TEXT,
        roomSyncEnabled INTEGER DEFAULT 0,
        roomSyncIntervalMinutes INTEGER DEFAULT 60,
        lastRoomSyncAt INTEGER,
        lastRoomPostAt INTEGER,
        roomCredential TEXT,
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

  it('getLowVoltageNodes returns only same-source rows below the threshold with a positive batteryMv', async () => {
    await repo.upsertNode({ publicKey: 'pk-low', batteryMv: 3100 }, 'src-a');   // below 3300 → included
    await repo.upsertNode({ publicKey: 'pk-high', batteryMv: 3900 }, 'src-a');  // above 3300 → excluded
    await repo.upsertNode({ publicKey: 'pk-null', batteryMv: null }, 'src-a');  // no telemetry → excluded
    await repo.upsertNode({ publicKey: 'pk-zero', batteryMv: 0 }, 'src-a');     // non-positive → excluded
    await repo.upsertNode({ publicKey: 'pk-other', batteryMv: 3000 }, 'src-b'); // other source → excluded

    const result = await repo.getLowVoltageNodes('src-a', 3300);
    expect(result.map((n) => n.publicKey)).toEqual(['pk-low']);
    expect(result[0].batteryMv).toBe(3100);
  });

  it('getInactiveMeshcoreNodes returns only same-source rows whose lastHeard is older than the cutoff', async () => {
    // MeshCore lastHeard is in milliseconds; the cutoff is a millisecond value.
    const cutoffMs = 1_000_000;
    await repo.upsertNode({ publicKey: 'pk-old', lastHeard: 500_000 }, 'src-a');    // older → included
    await repo.upsertNode({ publicKey: 'pk-new', lastHeard: 2_000_000 }, 'src-a');  // newer → excluded
    await repo.upsertNode({ publicKey: 'pk-null', lastHeard: null }, 'src-a');      // never heard → excluded
    await repo.upsertNode({ publicKey: 'pk-other', lastHeard: 500_000 }, 'src-b');  // other source → excluded

    const result = await repo.getInactiveMeshcoreNodes('src-a', cutoffMs);
    expect(result.map((n) => n.publicKey)).toEqual(['pk-old']);
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

  // ============ Composite-PK regression (issue: UNIQUE constraint failed) ============

  it('setNodeTelemetryConfig succeeds for the same publicKey under two sources on the composite-PK schema', async () => {
    // Post-migration-061 schema: PK is (sourceId, publicKey). This was the
    // bug repro — POST /api/sources/{sourceId}/meshcore/nodes/{publicKey}
    // /telemetry-config raised `UNIQUE constraint failed:
    // meshcore_nodes.publicKey` when the same key already existed under a
    // different source.
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
        out_path TEXT,
        path_len INTEGER,
        adminCredential TEXT,
        roomSyncEnabled INTEGER DEFAULT 0,
        roomSyncIntervalMinutes INTEGER DEFAULT 60,
        lastRoomSyncAt INTEGER,
        lastRoomPostAt INTEGER,
        roomCredential TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (sourceId, publicKey)
      );
    `);

    // src-a owns the key first.
    await repo.setNodeTelemetryConfig('src-a', 'pk-shared', {
      enabled: true,
      intervalMinutes: 15,
    });

    // src-b setting telemetry-config on the SAME publicKey must NOT
    // raise UNIQUE constraint failed.
    await expect(
      repo.setNodeTelemetryConfig('src-b', 'pk-shared', {
        enabled: true,
        intervalMinutes: 45,
      }),
    ).resolves.not.toThrow();

    const rows = db
      .prepare(
        `SELECT sourceId, telemetryEnabled, telemetryIntervalMinutes
         FROM meshcore_nodes WHERE publicKey = 'pk-shared' ORDER BY sourceId`,
      )
      .all() as Array<{ sourceId: string; telemetryEnabled: number; telemetryIntervalMinutes: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ sourceId: 'src-a', telemetryEnabled: 1, telemetryIntervalMinutes: 15 });
    expect(rows[1]).toEqual({ sourceId: 'src-b', telemetryEnabled: 1, telemetryIntervalMinutes: 45 });
  });

  it('deleteNode requires a sourceId and only removes the matching (sourceId, publicKey) row', async () => {
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
        out_path TEXT,
        path_len INTEGER,
        adminCredential TEXT,
        roomSyncEnabled INTEGER DEFAULT 0,
        roomSyncIntervalMinutes INTEGER DEFAULT 60,
        lastRoomSyncAt INTEGER,
        lastRoomPostAt INTEGER,
        roomCredential TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (sourceId, publicKey)
      );
    `);

    await repo.upsertNode({ publicKey: 'pk-shared', name: 'A' }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk-shared', name: 'B' }, 'src-b');

    // Guard against missing sourceId
    await expect(repo.deleteNode('pk-shared', '')).rejects.toThrow(/requires a sourceId/);

    // Source-scoped delete leaves the other source's row alone
    const ok = await repo.deleteNode('pk-shared', 'src-a');
    expect(ok).toBe(true);

    const rows = db
      .prepare(`SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-shared'`)
      .all() as Array<{ sourceId: string; name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ sourceId: 'src-b', name: 'B' });
  });

  // ============ Per-channel message retrieval (#3442) ============
  //
  // getChannelMessages returns each channel's own backlog, scoped to a source,
  // independent of the global recent-tail that getRecentMessages serves.
  describe('getChannelMessages', () => {
    const insert = (
      id: string,
      fields: { fromPublicKey: string; toPublicKey?: string | null; timestamp: number; text?: string },
      sourceId: string,
    ) =>
      repo.insertMessage(
        {
          id,
          fromPublicKey: fields.fromPublicKey,
          toPublicKey: fields.toPublicKey ?? null,
          text: fields.text ?? id,
          timestamp: fields.timestamp,
          createdAt: fields.timestamp,
        },
        sourceId,
      );

    it('returns only the requested channel, source-scoped', async () => {
      await insert('c1-recv', { fromPublicKey: 'channel-1', timestamp: 100 }, 'src-a');
      await insert('c1-sent', { fromPublicKey: 'a'.repeat(64), toPublicKey: 'channel-1', timestamp: 110 }, 'src-a');
      await insert('c2-recv', { fromPublicKey: 'channel-2', timestamp: 120 }, 'src-a');
      await insert('dm', { fromPublicKey: 'cafe'.repeat(16), toPublicKey: 'beef'.repeat(16), timestamp: 130 }, 'src-a');
      // Same channel index but a different source must not leak in.
      await insert('c1-other-src', { fromPublicKey: 'channel-1', timestamp: 140 }, 'src-b');

      const rows = await repo.getChannelMessages(1, 100, 'src-a');
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['c1-recv', 'c1-sent']);
    });

    it('includes legacy channel-0 broadcasts (null recipient, non-channel sender)', async () => {
      await insert('c0-recv', { fromPublicKey: 'channel-0', timestamp: 200 }, 'src-a');
      // Pre-phase-2 outbound channel-0: null recipient, real-pubkey sender.
      await insert('c0-legacy', { fromPublicKey: 'a'.repeat(64), toPublicKey: null, timestamp: 210 }, 'src-a');
      // A different channel's received msg must NOT match the channel-0 legacy rule.
      await insert('c1-recv', { fromPublicKey: 'channel-1', timestamp: 220 }, 'src-a');

      const rows = await repo.getChannelMessages(0, 100, 'src-a');
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['c0-legacy', 'c0-recv']);
    });

    it('does not apply the legacy null-recipient rule to non-zero channels', async () => {
      await insert('c1-recv', { fromPublicKey: 'channel-1', timestamp: 300 }, 'src-a');
      await insert('legacy-bcast', { fromPublicKey: 'a'.repeat(64), toPublicKey: null, timestamp: 310 }, 'src-a');

      const rows = await repo.getChannelMessages(1, 100, 'src-a');
      expect(rows.map(r => r.id)).toEqual(['c1-recv']);
    });

    it('honors the limit and returns newest-first', async () => {
      for (let i = 0; i < 5; i++) {
        await insert(`c1-${i}`, { fromPublicKey: 'channel-1', timestamp: 400 + i }, 'src-a');
      }
      const rows = await repo.getChannelMessages(1, 2, 'src-a');
      expect(rows.map(r => r.id)).toEqual(['c1-4', 'c1-3']);
    });
  });

  describe('getChannelMessageCounts', () => {
    it('returns an accurate per-channel total, source-scoped, ignoring the pool cap', async () => {
      const insert = (id: string, from: string, to: string | null, ts: number, src: string) =>
        repo.insertMessage(
          { id, fromPublicKey: from, toPublicKey: to, text: id, timestamp: ts, createdAt: ts },
          src,
        );
      // channel 0: 3 (2 received + 1 legacy broadcast). channel 1: 1. DM: excluded.
      await insert('a', 'channel-0', null, 1, 'src-a');
      await insert('b', 'channel-0', null, 2, 'src-a');
      await insert('c', 'x'.repeat(64), null, 3, 'src-a'); // channel-0 legacy
      await insert('d', 'channel-1', null, 4, 'src-a');
      await insert('e', 'cafe'.repeat(16), 'beef'.repeat(16), 5, 'src-a'); // DM
      // Other source must not leak into the counts.
      await insert('f', 'channel-1', null, 6, 'src-b');

      const counts = await repo.getChannelMessageCounts([0, 1, 2], 'src-a');
      expect(counts).toEqual({ 0: 3, 1: 1, 2: 0 });
    });
  });
});
