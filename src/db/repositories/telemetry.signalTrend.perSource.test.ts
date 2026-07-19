/**
 * TelemetryRepository.getSignalTrendSamples tests (issue #4110).
 *
 * Verifies the source-scoping, type-filtering, and time-window behavior of the
 * repository query that feeds the pure signal-trend computation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TelemetryRepository } from './telemetry.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import {
  SIGNAL_TREND_TELEMETRY_TYPES,
  RSSI_TELEMETRY_TYPE,
  SNR_TELEMETRY_TYPE,
  NOISE_FLOOR_TELEMETRY_TYPE,
} from '../../server/services/signalTrend.js';

const NODE = '!aabbccdd';
const NODE_NUM = 0xaabbccdd;
const T0 = 1_700_000_000_000;

describe('TelemetryRepository.getSignalTrendSamples (#4110)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<Record<string, never>>;
  let repo: TelemetryRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insert = async (type: string, timestamp: number, value: number, sourceId: string, unit = 'dBm') => {
    await repo.insertTelemetry(
      { nodeId: NODE, nodeNum: NODE_NUM, telemetryType: type, timestamp, value, unit, createdAt: timestamp },
      sourceId,
    );
  };

  it('returns only the signal telemetry types, scoped to one source', async () => {
    await insert(RSSI_TELEMETRY_TYPE, T0, -90, 'src-a');
    await insert(SNR_TELEMETRY_TYPE, T0 + 1000, 5, 'src-a', 'dB');
    await insert(NOISE_FLOOR_TELEMETRY_TYPE, T0 + 2000, -98, 'src-a');
    // Non-signal type — must be excluded.
    await insert('batteryLevel', T0 + 3000, 80, 'src-a', '%');
    // Same node/type via another source — must not leak into src-a.
    await insert(RSSI_TELEMETRY_TYPE, T0 + 4000, -50, 'src-b');

    const rows = await repo.getSignalTrendSamples(NODE, SIGNAL_TREND_TELEMETRY_TYPES, 0, 'src-a');

    expect(rows).toHaveLength(3);
    const types = rows.map(r => r.telemetryType).sort();
    expect(types).toEqual([NOISE_FLOOR_TELEMETRY_TYPE, RSSI_TELEMETRY_TYPE, SNR_TELEMETRY_TYPE].sort());
    // The other source's -50 dBm value must not appear.
    expect(rows.every(r => r.value !== -50)).toBe(true);
  });

  it('honors the sinceTimestamp lower bound', async () => {
    await insert(RSSI_TELEMETRY_TYPE, T0, -90, 'src-a');
    await insert(RSSI_TELEMETRY_TYPE, T0 + 10_000, -88, 'src-a');

    const rows = await repo.getSignalTrendSamples(NODE, SIGNAL_TREND_TELEMETRY_TYPES, T0 + 5_000, 'src-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(T0 + 10_000);
  });

  it('pools every source with ALL_SOURCES', async () => {
    await insert(RSSI_TELEMETRY_TYPE, T0, -90, 'src-a');
    await insert(RSSI_TELEMETRY_TYPE, T0 + 1000, -50, 'src-b');

    const rows = await repo.getSignalTrendSamples(NODE, SIGNAL_TREND_TELEMETRY_TYPES, 0, ALL_SOURCES);
    expect(rows).toHaveLength(2);
  });

  it('returns numbers for timestamp/value (BIGINT coercion safe)', async () => {
    await insert(RSSI_TELEMETRY_TYPE, T0, -90, 'src-a');
    const rows = await repo.getSignalTrendSamples(NODE, SIGNAL_TREND_TELEMETRY_TYPES, 0, 'src-a');
    expect(typeof rows[0].timestamp).toBe('number');
    expect(typeof rows[0].value).toBe('number');
  });
});
