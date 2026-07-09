/**
 * Multi-Database Solar Estimates Repository Tests
 *
 * Validates SolarEstimatesRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { SolarEstimatesRepository } from './solarEstimates.js';
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
  DROP TABLE IF EXISTS solar_estimates CASCADE;
  CREATE TABLE solar_estimates (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL UNIQUE,
    watt_hours DOUBLE PRECISION NOT NULL,
    fetched_at BIGINT NOT NULL,
    created_at BIGINT
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS solar_estimates;
  CREATE TABLE solar_estimates (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    watt_hours DOUBLE NOT NULL,
    fetched_at BIGINT NOT NULL,
    created_at BIGINT,
    UNIQUE (timestamp)
  )
`;

const ALL_TABLES = ['solar_estimates'];

/**
 * Shared test suite that runs against any backend.
 */
function runSolarEstimatesTests(getBackend: () => TestBackend) {
  let repo: SolarEstimatesRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new SolarEstimatesRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ SOLAR ESTIMATES ============

  it('upsertSolarEstimate - insert and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.upsertSolarEstimate({ timestamp: now, watt_hours: 1500.5, fetched_at: now });

    const results = await repo.getRecentSolarEstimates();
    expect(results).toHaveLength(1);
    expect(results[0].watt_hours).toBeCloseTo(1500.5);
    expect(results[0].timestamp).toBe(now);
  });

  it('upsertSolarEstimate - updates existing record on conflict', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const ts = Date.now();
    await repo.upsertSolarEstimate({ timestamp: ts, watt_hours: 1000, fetched_at: ts });
    await repo.upsertSolarEstimate({ timestamp: ts, watt_hours: 2000, fetched_at: ts + 1000 });

    const results = await repo.getRecentSolarEstimates();
    expect(results).toHaveLength(1);
    expect(results[0].watt_hours).toBeCloseTo(2000);
  });

  it('getRecentSolarEstimates - returns most recent first, respects limit', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await repo.upsertSolarEstimate({ timestamp: base + i * 1000, watt_hours: i * 100, fetched_at: base });
    }

    const all = await repo.getRecentSolarEstimates(5);
    expect(all).toHaveLength(5);
    // Most recent first
    expect(all[0].timestamp).toBeGreaterThan(all[1].timestamp);

    const limited = await repo.getRecentSolarEstimates(2);
    expect(limited).toHaveLength(2);
  });

  it('getSolarEstimatesInRange - returns only records in range', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = 1000000;
    await repo.upsertSolarEstimate({ timestamp: base, watt_hours: 100, fetched_at: base });
    await repo.upsertSolarEstimate({ timestamp: base + 1000, watt_hours: 200, fetched_at: base });
    await repo.upsertSolarEstimate({ timestamp: base + 2000, watt_hours: 300, fetched_at: base });
    await repo.upsertSolarEstimate({ timestamp: base + 3000, watt_hours: 400, fetched_at: base });

    const results = await repo.getSolarEstimatesInRange(base + 500, base + 2500);
    expect(results).toHaveLength(2);
    results.forEach(r => {
      expect(r.timestamp).toBeGreaterThanOrEqual(base + 500);
      expect(r.timestamp).toBeLessThanOrEqual(base + 2500);
    });
  });
}

// --- SQLite Backend ---
describe('SolarEstimatesRepository - SQLite Backend', () => {
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

  runSolarEstimatesTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('SolarEstimatesRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for solar estimates tests');
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

  runSolarEstimatesTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('SolarEstimatesRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for solar estimates tests');
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

  runSolarEstimatesTests(() => backend);
});
