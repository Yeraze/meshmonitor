/**
 * Telemetry bad-timestamp handling (issue #3362).
 *
 * A node that reboots without GPS/NTP can broadcast telemetry with a hardware
 * clock months/years off. Those embedded timestamps used to be stored verbatim
 * and rendered on the chart X-axis, stretching every telemetry graph. Two
 * defenses are tested here:
 *   1. Ingest-time sanitizer — out-of-range timestamps are replaced with the
 *      server-receipt time and the claimed value is preserved in packetTimestamp.
 *   2. Query upper-bound — future-dated rows (e.g. stored before the fix) are
 *      excluded from the averaged chart query so they can't distort the axis.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { telemetrySqlite } from '../schema/telemetry.js';
import { TelemetryRepository } from './telemetry.js';
import * as schema from '../schema/index.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NODE = '!aabbccdd';
const NODE_NUM = 0xaabbccdd;

describe('Telemetry bad-timestamp handling (#3362)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TelemetryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT NOT NULL, nodeNum INTEGER NOT NULL, telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL, value REAL NOT NULL, unit TEXT,
        createdAt INTEGER NOT NULL, packetTimestamp INTEGER, packetId INTEGER,
        channel INTEGER, precisionBits INTEGER, gpsAccuracy INTEGER, sourceId TEXT
      )`);
    drizzleDb = drizzle(db, { schema });
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  const readRow = (telemetryType: string) =>
    drizzleDb.select().from(telemetrySqlite).where(eq(telemetrySqlite.telemetryType, telemetryType)).all()[0];

  describe('ingest-time sanitizer', () => {
    it('keeps a sane timestamp untouched', async () => {
      const now = Date.now();
      const ts = now - 5 * 60 * 1000; // 5 min ago — fine
      await repo.insertTelemetry({ nodeId: NODE, nodeNum: NODE_NUM, telemetryType: 'voltage', timestamp: ts, value: 3.9, unit: 'V', createdAt: now });
      const row = readRow('voltage');
      expect(row.timestamp).toBe(ts);
      expect(row.packetTimestamp).toBeNull();
    });

    it('replaces a future timestamp with receipt time and preserves the claim', async () => {
      const now = Date.now();
      const bad = now + 90 * DAY; // node clock months ahead
      await repo.insertTelemetry({ nodeId: NODE, nodeNum: NODE_NUM, telemetryType: 'altitude', timestamp: bad, value: 100, unit: 'm', createdAt: now });
      const row = readRow('altitude');
      expect(row.timestamp).toBe(now);
      expect(row.packetTimestamp).toBe(bad); // original claim retained for forensics
    });

    it('leaves an old timestamp untouched (handled by the chart cutoff, not ingest)', async () => {
      // Old embedded times are indistinguishable from buffered / store-forward
      // telemetry at ingest, so we keep them; the windowed query filters them.
      const now = Date.now();
      const old = now - 120 * DAY;
      await repo.insertTelemetry({ nodeId: NODE, nodeNum: NODE_NUM, telemetryType: 'snr', timestamp: old, value: -8, unit: 'dB', createdAt: now });
      const row = readRow('snr');
      expect(row.timestamp).toBe(old);
      expect(row.packetTimestamp).toBeNull();
    });

    it('does not clobber an existing packetTimestamp', async () => {
      const now = Date.now();
      const bad = now + 30 * DAY;
      await repo.insertTelemetry({ nodeId: NODE, nodeNum: NODE_NUM, telemetryType: 'voltage', timestamp: bad, value: 3.7, unit: 'V', createdAt: now, packetTimestamp: 12345 });
      const row = readRow('voltage');
      expect(row.timestamp).toBe(now);
      expect(row.packetTimestamp).toBe(12345);
    });

    it('sanitizes batch inserts too', async () => {
      const now = Date.now();
      await repo.insertTelemetryBatch([
        { nodeId: NODE, nodeNum: NODE_NUM, telemetryType: 'channelUtilization', timestamp: now + 365 * DAY, value: 10, unit: '%', createdAt: now },
        { nodeId: NODE, nodeNum: NODE_NUM, telemetryType: 'airUtilTx', timestamp: now - 60 * 1000, value: 2, unit: '%', createdAt: now },
      ]);
      expect(readRow('channelUtilization').timestamp).toBe(now); // clamped
      expect(readRow('airUtilTx').timestamp).toBe(now - 60 * 1000); // untouched
    });
  });

  describe('averaged query excludes future-dated rows', () => {
    it('drops a future row that slipped into the table before the ingest fix', () => {
      const now = Date.now();
      // Insert directly (bypassing the sanitizer) to simulate pre-fix data.
      const insertRaw = (type: string, ts: number, value: number) =>
        db.prepare('INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt) VALUES (?,?,?,?,?,?,?)')
          .run(NODE, NODE_NUM, type, ts, value, '%', now);
      insertRaw('channelUtilization', now - 30 * 60 * 1000, 11); // good, 30 min ago
      insertRaw('channelUtilization', now + 60 * DAY, 99);       // bad future row

      const rows = repo.getTelemetryByNodeAveragedSqlite(NODE, now - 72 * HOUR, 5, 72, undefined);
      const timestamps = rows.map(r => r.timestamp);
      // No returned bucket may sit in the future.
      expect(timestamps.every(t => t <= now + HOUR)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
