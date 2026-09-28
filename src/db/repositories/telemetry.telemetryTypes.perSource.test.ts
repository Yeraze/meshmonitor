/**
 * getAllNodesTelemetryTypesSync is source-scoped (SQLite). It used to ignore
 * the source and return every source's telemetry types, so a per-source view
 * listed chart types for data that only another source held.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TelemetryRepository } from './telemetry.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const T0 = 1_700_000_000_000;

describe('TelemetryRepository.getAllNodesTelemetryTypesSync per source', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<Record<string, never>>;
  let repo: TelemetryRepository;

  beforeEach(async () => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
    const ins = (nodeId: string, nodeNum: number, type: string, sourceId: string) =>
      repo.insertTelemetry({ nodeId, nodeNum, telemetryType: type, timestamp: T0, value: 1, createdAt: T0 }, sourceId);
    await ins('!00000001', 1, 'batteryLevel', 'src-a');
    await ins('!00000001', 1, 'temperature', 'src-b');
    await ins('!00000002', 2, 'voltage', 'src-b');
  });

  afterEach(() => db.close());

  it('returns only the requested source\'s node types', () => {
    const a = repo.getAllNodesTelemetryTypesSync('src-a');
    expect(Object.fromEntries(a)).toEqual({ '!00000001': ['batteryLevel'] });

    const b = repo.getAllNodesTelemetryTypesSync('src-b');
    expect(Object.fromEntries(b)).toEqual({ '!00000001': ['temperature'], '!00000002': ['voltage'] });
  });

  it('ALL_SOURCES returns every source', () => {
    const all = repo.getAllNodesTelemetryTypesSync(ALL_SOURCES);
    expect(all.get('!00000001')?.sort()).toEqual(['batteryLevel', 'temperature']);
    expect(all.get('!00000002')).toEqual(['voltage']);
  });
});
