/**
 * CoverageSurveysRepository — cross-dialect coverage on PostgreSQL and MySQL
 * (Coverage Report epic #5277, Phase 4b WP1).
 *
 * Per the spec, the table is created with the migration-173 runners
 * (`runMigration173Postgres`/`runMigration173Mysql`), NOT hand-written DDL —
 * this suite is the one place that matters, since a drift between the real
 * migration and a hand-rolled `CREATE TABLE` would otherwise go unnoticed.
 * Each backend gets its OWN isolated database (`isolationKey: 'covsv'`) so
 * this suite can run concurrently with any other PG/MySQL suite without a
 * fixture-table race (see CLAUDE.md "PG/MySQL fixture races").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { CoverageSurveysRepository, type CreateCoverageSurveyParams } from './coverageSurveys.js';
import { runMigration173Postgres, runMigration173Mysql } from '../../server/migrations/173_create_coverage_surveys.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { COVERAGE_SURVEY_LIVE_MAX_MS } from '../../utils/coverage.js';

const NOW = 1_760_000_000_000;

function makeSurvey(overrides: Partial<CreateCoverageSurveyParams> = {}): CreateCoverageSurveyParams {
  return {
    name: 'Downtown drive',
    senderId: '!aabbccdd',
    startAt: NOW - 60_000,
    endAt: NOW,
    receivers: null,
    intervalSec: 30,
    notes: null,
    createdBy: 7,
    ...overrides,
  };
}

interface Ctx {
  repo: CoverageSurveysRepository;
}

/** Behaviours that must hold identically on every dialect. */
function runSharedTests(getCtx: () => Ctx) {
  it('UUID text PK and bigint start/end times round-trip', async () => {
    const { repo } = getCtx();
    const created = await repo.createSurvey(makeSurvey());
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(typeof created.startAt).toBe('number');
    expect(created.startAt).toBe(NOW - 60_000);
    expect(created.endAt).toBe(NOW);

    const fetched = await repo.getSurvey(created.id);
    expect(fetched).toEqual(created);
  });

  it('a live survey (endAt null) round-trips and is found by getLiveSurveyForSender', async () => {
    const { repo } = getCtx();
    const created = await repo.createSurvey(makeSurvey({ senderId: '!live0001', endAt: null }));
    expect(created.endAt).toBeNull();

    const live = await repo.getLiveSurveyForSender('!live0001', NOW + 1000);
    expect(live?.id).toBe(created.id);
  });

  it('a live survey past its cap no longer counts as live, even with endAt still null', async () => {
    const { repo } = getCtx();
    await repo.createSurvey(makeSurvey({ senderId: '!lapsed01', startAt: NOW, endAt: null }));
    const pastCap = NOW + COVERAGE_SURVEY_LIVE_MAX_MS + 1;
    expect(await repo.getLiveSurveyForSender('!lapsed01', pastCap)).toBeNull();
  });

  it('updateSurvey patches fields and deleteSurvey removes the row', async () => {
    const { repo } = getCtx();
    const created = await repo.createSurvey(makeSurvey({ name: 'Before' }));

    expect(await repo.updateSurvey(created.id, { name: 'After', endAt: NOW + 2000 })).toBe(true);
    const updated = await repo.getSurvey(created.id);
    expect(updated?.name).toBe('After');
    expect(updated?.endAt).toBe(NOW + 2000);

    expect(await repo.deleteSurvey(created.id)).toBe(true);
    expect(await repo.getSurvey(created.id)).toBeNull();
  });

  it('countSurveys / countSurveysByUser aggregate correctly', async () => {
    const { repo } = getCtx();
    await repo.createSurvey(makeSurvey({ createdBy: 1 }));
    await repo.createSurvey(makeSurvey({ createdBy: 1 }));
    await repo.createSurvey(makeSurvey({ createdBy: 2 }));

    expect(await repo.countSurveys()).toBe(3);
    expect(await repo.countSurveysByUser(1)).toBe(2);
    expect(await repo.countSurveysByUser(2)).toBe(1);
  });

  it('getExemptionWindows resolves stopped and live surveys correctly', async () => {
    const { repo } = getCtx();
    await repo.createSurvey(makeSurvey({ senderId: '!stopped2', startAt: NOW - 10_000, endAt: NOW - 5_000 }));
    await repo.createSurvey(makeSurvey({ senderId: '!live0002', startAt: NOW - 1_000, endAt: null }));

    const windows = await repo.getExemptionWindows(NOW);
    expect(windows).toHaveLength(2);
    const bySender = new Map(windows.map((w) => [w.senderId, w]));
    expect(bySender.get('!stopped2')).toEqual({ senderId: '!stopped2', startAt: NOW - 10_000, endAt: NOW - 5_000 });
    expect(bySender.get('!live0002')).toEqual({ senderId: '!live0002', startAt: NOW - 1_000, endAt: NOW });
  });

  it('round-trips a 64-hex MeshCore senderId', async () => {
    const { repo } = getCtx();
    const pubkey64 = 'a'.repeat(64);
    const created = await repo.createSurvey(makeSurvey({ senderId: pubkey64 }));
    const fetched = await repo.getSurvey(created.id);
    expect(fetched?.senderId).toBe(pubkey64);
  });
}

describe.skipIf(!postgresAvailable)('CoverageSurveysRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CoverageSurveysRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('covsv');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;

    const client = await pool.connect();
    try {
      await runMigration173Postgres(client);
    } finally {
      client.release();
    }

    const drizzleDb = drizzlePostgres(pool, { schema });
    repo = new CoverageSurveysRepository(drizzleDb, 'postgres');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE coverage_surveys RESTART IDENTITY CASCADE');
  });

  runSharedTests(() => ({ repo }));
});

describe.skipIf(!mysqlAvailable)('CoverageSurveysRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CoverageSurveysRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('covsv');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;

    await runMigration173Mysql(pool);

    const drizzleDb = drizzleMysql(pool, { schema, mode: 'default' });
    repo = new CoverageSurveysRepository(drizzleDb, 'mysql');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    await pool.query('TRUNCATE TABLE coverage_surveys');
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  });

  runSharedTests(() => ({ repo }));
});
