/**
 * Tests for migration 171 — best-effort reclassify of existing
 * `route_segments` record holders by transport (#5101).
 *
 * Uses `createTestDb()` (the real migration registry, so 169/170/171 have
 * already run against an empty database by the time the DB is built). Test
 * data is seeded AFTER that with raw SQL, then the 171 migration's `up()` is
 * invoked a second time directly to exercise the reclassify logic against
 * it — this is also exactly the "re-run after a crash before the ledger
 * write" scenario the migration must tolerate.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';
import { migration } from './171_reclassify_record_holder_transport.js';
import { TX_LORA, TX_MQTT } from '../../utils/nodeTransport.js';

interface SegmentRow {
  id: number;
  fromNodeNum: number;
  toNodeNum: number;
  isRecordHolder: number;
  transportMechanism: number | null;
  timestamp: number;
  sourceId: string | null;
  distanceKm: number;
}

function insertTraceroute(
  t: TestDb,
  tr: {
    fromNodeNum: number; toNodeNum: number; timestamp: number;
    route: string | null; snrTowards: string | null;
    transportMechanism: number | null; sourceId: string | null;
  },
): void {
  t.sqlite.prepare(`
    INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, route, snrTowards, transportMechanism, timestamp, createdAt, sourceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tr.fromNodeNum, tr.toNodeNum, `!${tr.fromNodeNum}`, `!${tr.toNodeNum}`,
    tr.route, tr.snrTowards, tr.transportMechanism, tr.timestamp, tr.timestamp, tr.sourceId,
  );
}

function insertSegment(
  t: TestDb,
  seg: {
    fromNodeNum: number; toNodeNum: number; isRecordHolder: boolean;
    timestamp: number; sourceId: string | null; distanceKm: number;
  },
): number {
  const info = t.sqlite.prepare(`
    INSERT INTO route_segments (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder, timestamp, createdAt, sourceId, transportMechanism)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    seg.fromNodeNum, seg.toNodeNum, `!${seg.fromNodeNum}`, `!${seg.toNodeNum}`,
    seg.distanceKm, seg.isRecordHolder ? 1 : 0, seg.timestamp, seg.timestamp, seg.sourceId,
  );
  return Number(info.lastInsertRowid);
}

function getSegment(t: TestDb, id: number): SegmentRow {
  return t.sqlite.prepare(`SELECT * FROM route_segments WHERE id = ?`).get(id) as SegmentRow;
}

function allSegments(t: TestDb): SegmentRow[] {
  return t.sqlite.prepare(`SELECT * FROM route_segments ORDER BY id`).all() as SegmentRow[];
}

describe('Migration 171 — reclassify record-holder transport (SQLite)', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.close();
  });

  it('an RF record whose traceroute has mechanism 1 is stamped 1, and its unflagged twin is stamped 1 too', () => {
    insertTraceroute(t, {
      fromNodeNum: 100, toNodeNum: 200, timestamp: 1000,
      route: '[10]', snrTowards: '[40,60]',
      transportMechanism: TX_LORA, sourceId: 'src-a',
    });
    const recordId = insertSegment(t, {
      fromNodeNum: 200, toNodeNum: 10, isRecordHolder: true, timestamp: 1000, sourceId: 'src-a', distanceKm: 5.0,
    });
    const twinId = insertSegment(t, {
      fromNodeNum: 200, toNodeNum: 10, isRecordHolder: false, timestamp: 1000, sourceId: 'src-a', distanceKm: 5.0,
    });

    migration.up(t.sqlite);

    expect(getSegment(t, recordId).transportMechanism).toBe(TX_LORA);
    expect(getSegment(t, recordId).isRecordHolder).toBe(1);
    expect(getSegment(t, twinId).transportMechanism).toBe(TX_LORA);
  });

  it('a record whose hop has the sentinel is stamped MQTT (5); a same-source RF record stays flagged too (different classes)', () => {
    insertTraceroute(t, {
      fromNodeNum: 100, toNodeNum: 200, timestamp: 1000,
      route: '[10]', snrTowards: '[40,60]',
      transportMechanism: TX_LORA, sourceId: 'src-a',
    });
    const rfRecordId = insertSegment(t, {
      fromNodeNum: 200, toNodeNum: 10, isRecordHolder: true, timestamp: 1000, sourceId: 'src-a', distanceKm: 5.0,
    });

    insertTraceroute(t, {
      fromNodeNum: 300, toNodeNum: 400, timestamp: 2000,
      route: '[30]', snrTowards: '[-128,50]',
      transportMechanism: TX_LORA, sourceId: 'src-a',
    });
    const mqttRecordId = insertSegment(t, {
      fromNodeNum: 400, toNodeNum: 30, isRecordHolder: true, timestamp: 2000, sourceId: 'src-a', distanceKm: 8.0,
    });

    migration.up(t.sqlite);

    expect(getSegment(t, rfRecordId).transportMechanism).toBe(TX_LORA);
    expect(getSegment(t, rfRecordId).isRecordHolder).toBe(1);
    expect(getSegment(t, mqttRecordId).transportMechanism).toBe(TX_MQTT);
    expect(getSegment(t, mqttRecordId).isRecordHolder).toBe(1);
  });

  it('two NULL-source flagged rows that both resolve to RF: the shorter is demoted', () => {
    const shortId = insertSegment(t, {
      fromNodeNum: 500, toNodeNum: 600, isRecordHolder: true, timestamp: 3000, sourceId: null, distanceKm: 15.0,
    });
    const longId = insertSegment(t, {
      fromNodeNum: 700, toNodeNum: 800, isRecordHolder: true, timestamp: 3000, sourceId: null, distanceKm: 25.0,
    });

    migration.up(t.sqlite);

    expect(getSegment(t, shortId).isRecordHolder).toBe(0);
    expect(getSegment(t, longId).isRecordHolder).toBe(1);
  });

  it('a record with no traceroute stays NULL and flagged', () => {
    const id = insertSegment(t, {
      fromNodeNum: 900, toNodeNum: 910, isRecordHolder: true, timestamp: 4000, sourceId: 'src-b', distanceKm: 30.0,
    });

    migration.up(t.sqlite);

    const row = getSegment(t, id);
    expect(row.transportMechanism).toBeNull();
    expect(row.isRecordHolder).toBe(1);
  });

  it('a traceroute row with malformed route is skipped without error', () => {
    insertTraceroute(t, {
      fromNodeNum: 1000, toNodeNum: 1100, timestamp: 5000,
      route: '[1,2', snrTowards: '[40]',
      transportMechanism: TX_LORA, sourceId: 'src-c',
    });
    const id = insertSegment(t, {
      fromNodeNum: 1100, toNodeNum: 1, isRecordHolder: true, timestamp: 5000, sourceId: 'src-c', distanceKm: 12.0,
    });

    expect(() => migration.up(t.sqlite)).not.toThrow();

    const row = getSegment(t, id);
    expect(row.transportMechanism).toBeNull();
    expect(row.isRecordHolder).toBe(1);
  });

  it('running the migration a second time changes nothing further, and never touches an unrelated unflagged row', () => {
    insertTraceroute(t, {
      fromNodeNum: 100, toNodeNum: 200, timestamp: 1000,
      route: '[10]', snrTowards: '[40,60]',
      transportMechanism: TX_LORA, sourceId: 'src-a',
    });
    insertSegment(t, {
      fromNodeNum: 200, toNodeNum: 10, isRecordHolder: true, timestamp: 1000, sourceId: 'src-a', distanceKm: 5.0,
    });
    // Unrelated, already-classified, non-flagged row — must never be touched.
    const unrelatedId = t.sqlite.prepare(`
      INSERT INTO route_segments (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder, timestamp, createdAt, sourceId, transportMechanism)
      VALUES (9999, 8888, '!9999', '!8888', 42.0, 0, 6000, 6000, 'src-a', 6)
    `).run().lastInsertRowid as number;

    migration.up(t.sqlite);
    const rowCountAfterFirst = allSegments(t).length;
    const snapshotAfterFirst = JSON.stringify(allSegments(t));
    const nonNullCountAfterFirst = allSegments(t).filter((r) => r.transportMechanism !== null).length;

    migration.up(t.sqlite);
    const rowCountAfterSecond = allSegments(t).length;
    const snapshotAfterSecond = JSON.stringify(allSegments(t));
    const nonNullCountAfterSecond = allSegments(t).filter((r) => r.transportMechanism !== null).length;

    expect(rowCountAfterSecond).toBe(rowCountAfterFirst);
    expect(snapshotAfterSecond).toBe(snapshotAfterFirst);
    expect(nonNullCountAfterSecond).toBe(nonNullCountAfterFirst);
    expect(getSegment(t, unrelatedId).transportMechanism).toBe(6);
  });
});
