/**
 * Migration 225 on the PostgreSQL / MySQL containers (#6285): columns, index,
 * backfill rule, schedule seed, idempotent rerun, no clobber. Each fixture
 * owns an isolated database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration225Postgres, runMigration225Mysql } from './225_backup_history_source_protocol.js';
import { postgresAvailable, mysqlAvailable, createIsolatedPostgresDatabase, createIsolatedMysqlDatabase } from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 225 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig225'));
  });
  afterAll(async () => {
    await cleanup?.();
  });
  beforeEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS backup_history; DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS settings;
      CREATE TABLE backup_history (id SERIAL PRIMARY KEY, "nodeId" TEXT, "nodeNum" BIGINT, filename TEXT NOT NULL, "filePath" TEXT NOT NULL, "fileSize" INTEGER, "backupType" TEXT NOT NULL, timestamp BIGINT NOT NULL, "createdAt" BIGINT NOT NULL);
      CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, "displayOrder" INTEGER NOT NULL DEFAULT 0, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL);
      INSERT INTO backup_history (filename, "filePath", "backupType", timestamp, "createdAt") VALUES ('old.yaml','/x/old.yaml','manual',1,1);
      INSERT INTO settings VALUES ('backup_enabled','true',1,1),('backup_time','04:30',1,1),('backup_maxBackups','12',1,1),('backup_lastAutomaticBackup','2026-11-08T02:00:00.000Z',1,1);`);
  });
  const run = async () => {
    const client = await pool.connect();
    try { await runMigration225Postgres(client); } finally { client.release(); }
  };
  const addSource = (id: string, type: string, order = 0) =>
    pool.query(`INSERT INTO sources (id,name,type,config,"displayOrder","createdAt","updatedAt") VALUES ($1,$1,$2,'{}',$3,1,1)`, [id, type, order]);
  const val = async (k: string) => (await pool.query(`SELECT value FROM settings WHERE key=$1`, [k])).rows[0]?.value;

  it('one source: columns, index, backfill, seed; rerun idempotent; no clobber', async () => {
    await addSource('a', 'meshtastic_tcp');
    await pool.query(`INSERT INTO settings VALUES ('source:a:backup_time','09:00',1,1)`);
    await run();
    await run();
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='backup_history' AND column_name IN ('sourceId','protocol')`);
    expect(cols.rowCount).toBe(2);
    expect((await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname='idx_backup_history_source_ts'`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT "sourceId", protocol FROM backup_history`)).rows[0]).toEqual({ sourceId: 'a', protocol: 'meshtastic' });
    expect(await val('source:a:backup_time')).toBe('09:00');
    expect(await val('source:a:backup_maxBackups')).toBe('12');
    expect(await val('source:a:backup_lastAutomaticBackupDate')).toBe('2026-11-08');
  });

  it('two sources: rows stay NULL; only the primary is seeded', async () => {
    await addSource('a', 'meshtastic_tcp', 2);
    await addSource('b', 'meshtastic_tcp', 1);
    await run();
    expect((await pool.query(`SELECT "sourceId" FROM backup_history`)).rows[0].sourceId).toBeNull();
    expect(await val('source:b:backup_enabled')).toBe('true');
    expect(await val('source:a:backup_enabled')).toBeUndefined();
  });

  it('zero sources: no seed', async () => {
    await run();
    expect((await pool.query(`SELECT COUNT(*)::int AS c FROM settings WHERE key LIKE 'source:%'`)).rows[0].c).toBe(0);
  });
});

describe.skipIf(!mysqlAvailable)('migration 225 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig225'));
  });
  afterAll(async () => {
    await cleanup?.();
  });
  beforeEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS backup_history`);
    await pool.query(`DROP TABLE IF EXISTS sources`);
    await pool.query(`DROP TABLE IF EXISTS settings`);
    await pool.query(`CREATE TABLE backup_history (id SERIAL PRIMARY KEY, nodeId VARCHAR(32), nodeNum BIGINT, filename VARCHAR(255) NOT NULL, filePath VARCHAR(512) NOT NULL, fileSize INT, backupType VARCHAR(32) NOT NULL, timestamp BIGINT NOT NULL, createdAt BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE sources (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, config TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, displayOrder INT NOT NULL DEFAULT 0, createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL)`);
    await pool.query('CREATE TABLE settings (`key` VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL, createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL)');
    await pool.query(`INSERT INTO backup_history (filename, filePath, backupType, timestamp, createdAt) VALUES ('old.yaml','/x/old.yaml','manual',1,1)`);
    await pool.query("INSERT INTO settings VALUES ('backup_enabled','true',1,1),('backup_time','04:30',1,1),('backup_maxBackups','12',1,1),('backup_lastAutomaticBackup','2026-11-08T02:00:00.000Z',1,1)");
  });
  const addSource = (id: string, type: string, order = 0) =>
    pool.query(`INSERT INTO sources (id,name,type,config,displayOrder,createdAt,updatedAt) VALUES (?,?,?,'{}',?,1,1)`, [id, id, type, order]);
  const val = async (k: string) => {
    const [r] = await pool.query('SELECT value FROM settings WHERE `key`=?', [k]);
    return (r as Array<{ value: string }>)[0]?.value;
  };

  it('one source: columns, index, backfill, seed; rerun idempotent; no clobber', async () => {
    await addSource('a', 'meshtastic_tcp');
    await pool.query("INSERT INTO settings VALUES ('source:a:backup_time','09:00',1,1)");
    await runMigration225Mysql(pool);
    await runMigration225Mysql(pool);
    const [cols] = await pool.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='backup_history' AND COLUMN_NAME IN ('sourceId','protocol')`);
    expect((cols as unknown[]).length).toBe(2);
    const [idx] = await pool.query(`SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME='idx_backup_history_source_ts'`);
    expect((idx as unknown[]).length).toBe(1);
    const [rows] = await pool.query(`SELECT sourceId, protocol FROM backup_history`);
    expect((rows as unknown[])[0]).toEqual({ sourceId: 'a', protocol: 'meshtastic' });
    expect(await val('source:a:backup_time')).toBe('09:00');
    expect(await val('source:a:backup_maxBackups')).toBe('12');
    expect(await val('source:a:backup_lastAutomaticBackupDate')).toBe('2026-11-08');
  });

  it('two sources: rows stay NULL; only the primary is seeded', async () => {
    await addSource('a', 'meshtastic_tcp', 2);
    await addSource('b', 'meshtastic_tcp', 1);
    await runMigration225Mysql(pool);
    const [rows] = await pool.query(`SELECT sourceId FROM backup_history`);
    expect((rows as Array<{ sourceId: string | null }>)[0].sourceId).toBeNull();
    expect(await val('source:b:backup_enabled')).toBe('true');
    expect(await val('source:a:backup_enabled')).toBeUndefined();
  });

  it('zero sources: no seed', async () => {
    await runMigration225Mysql(pool);
    const [r] = await pool.query("SELECT COUNT(*) AS c FROM settings WHERE `key` LIKE 'source:%'");
    expect(Number((r as Array<{ c: number }>)[0].c)).toBe(0);
  });
});
