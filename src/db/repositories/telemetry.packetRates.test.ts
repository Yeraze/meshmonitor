/**
 * TelemetryRepository.getPacketRates / computePacketRates tests
 *
 * Covers the packet-rate computation extracted from
 * DatabaseService.getPacketRatesAsync (Phase 3.4, #3962):
 *  - pure rate-delta edge cases (counter reset, stale gap, tiny interval)
 *  - the Drizzle-backed repo query on SQLite (source scoping + since filter)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TelemetryRepository } from './telemetry.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const MINUTE = 60 * 1000;

describe('TelemetryRepository.computePacketRates (pure)', () => {
  const T0 = 1_700_000_000_000;

  it('computes per-minute rates between consecutive samples', () => {
    const rows = [
      { telemetryType: 'packetsTx', timestamp: T0, value: 100 },
      { telemetryType: 'packetsTx', timestamp: T0 + 10 * MINUTE, value: 150 },
      { telemetryType: 'packetsTx', timestamp: T0 + 20 * MINUTE, value: 250 },
    ];
    const result = TelemetryRepository.computePacketRates(rows, ['packetsTx']);
    expect(result.packetsTx).toHaveLength(2);
    expect(result.packetsTx[0]).toEqual({ timestamp: T0 + 10 * MINUTE, ratePerMinute: 5 });
    expect(result.packetsTx[1]).toEqual({ timestamp: T0 + 20 * MINUTE, ratePerMinute: 10 });
  });

  it('skips negative deltas (counter reset)', () => {
    const rows = [
      { telemetryType: 'packetsTx', timestamp: T0, value: 500 },
      { telemetryType: 'packetsTx', timestamp: T0 + 10 * MINUTE, value: 20 }, // reboot reset
      { telemetryType: 'packetsTx', timestamp: T0 + 20 * MINUTE, value: 120 },
    ];
    const result = TelemetryRepository.computePacketRates(rows, ['packetsTx']);
    expect(result.packetsTx).toHaveLength(1);
    expect(result.packetsTx[0].ratePerMinute).toBe(10);
  });

  it('skips gaps longer than 60 minutes', () => {
    const rows = [
      { telemetryType: 'packetsTx', timestamp: T0, value: 100 },
      { telemetryType: 'packetsTx', timestamp: T0 + 61 * MINUTE, value: 200 }, // stale gap
      { telemetryType: 'packetsTx', timestamp: T0 + 71 * MINUTE, value: 300 },
    ];
    const result = TelemetryRepository.computePacketRates(rows, ['packetsTx']);
    expect(result.packetsTx).toHaveLength(1);
    expect(result.packetsTx[0].timestamp).toBe(T0 + 71 * MINUTE);
  });

  it('skips intervals shorter than 0.1 minutes', () => {
    const rows = [
      { telemetryType: 'packetsTx', timestamp: T0, value: 100 },
      { telemetryType: 'packetsTx', timestamp: T0 + 5_000, value: 105 }, // 5s — too small
      { telemetryType: 'packetsTx', timestamp: T0 + 10 * MINUTE, value: 205 },
    ];
    const result = TelemetryRepository.computePacketRates(rows, ['packetsTx']);
    expect(result.packetsTx).toHaveLength(1);
    expect(result.packetsTx[0].timestamp).toBe(T0 + 10 * MINUTE);
  });

  it('returns empty arrays for requested types with no samples', () => {
    const result = TelemetryRepository.computePacketRates([], ['packetsTx', 'packetsRx']);
    expect(result).toEqual({ packetsTx: [], packetsRx: [] });
  });

  it('groups by telemetry type independently', () => {
    const rows = [
      { telemetryType: 'packetsTx', timestamp: T0, value: 100 },
      { telemetryType: 'packetsRx', timestamp: T0, value: 10 },
      { telemetryType: 'packetsTx', timestamp: T0 + 10 * MINUTE, value: 200 },
      { telemetryType: 'packetsRx', timestamp: T0 + 10 * MINUTE, value: 40 },
    ];
    const result = TelemetryRepository.computePacketRates(rows, ['packetsTx', 'packetsRx']);
    expect(result.packetsTx[0].ratePerMinute).toBe(10);
    expect(result.packetsRx[0].ratePerMinute).toBe(3);
  });
});

describe('TelemetryRepository.getPacketRates (SQLite)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TelemetryRepository;

  const NODE = '!aabbccdd';
  const NODE_NUM = 0xaabbccdd;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insert = async (
    telemetryType: string,
    timestamp: number,
    value: number,
    sourceId: string
  ) => {
    await repo.insertTelemetry(
      {
        nodeId: NODE,
        nodeNum: NODE_NUM,
        telemetryType,
        timestamp,
        value,
        unit: 'packets',
        createdAt: timestamp,
      },
      sourceId
    );
  };

  it('computes rates for a concrete sourceId, excluding other sources', async () => {
    await insert('packetsTx', T0, 100, 'src-a');
    await insert('packetsTx', T0 + 10 * MINUTE, 150, 'src-a');
    // Same node via another source — must not pollute src-a's series
    await insert('packetsTx', T0 + 5 * MINUTE, 9999, 'src-b');

    const result = await repo.getPacketRates(NODE, ['packetsTx'], undefined, 'src-a');
    expect(result.packetsTx).toHaveLength(1);
    expect(result.packetsTx[0]).toEqual({ timestamp: T0 + 10 * MINUTE, ratePerMinute: 5 });
  });

  it('pools every source with ALL_SOURCES (legacy facade behavior)', async () => {
    await insert('packetsTx', T0, 100, 'src-a');
    await insert('packetsTx', T0 + 10 * MINUTE, 150, 'src-a');

    const result = await repo.getPacketRates(NODE, ['packetsTx'], undefined, ALL_SOURCES);
    expect(result.packetsTx).toHaveLength(1);
  });

  it('honors the sinceTimestamp lower bound', async () => {
    await insert('packetsTx', T0, 100, 'src-a');
    await insert('packetsTx', T0 + 10 * MINUTE, 150, 'src-a');
    await insert('packetsTx', T0 + 20 * MINUTE, 250, 'src-a');

    // Excluding the first sample leaves a single consecutive pair
    const result = await repo.getPacketRates(NODE, ['packetsTx'], T0 + 10 * MINUTE, 'src-a');
    expect(result.packetsTx).toHaveLength(1);
    expect(result.packetsTx[0].timestamp).toBe(T0 + 20 * MINUTE);
  });
});
