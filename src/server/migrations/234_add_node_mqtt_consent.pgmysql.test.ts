/**
 * Migration 234 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration234Postgres, runMigration234Mysql } from './234_add_node_mqtt_consent.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 234 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig234'));
    await pool.query('DROP TABLE IF EXISTS nodes CASCADE');
    await pool.query(`CREATE TABLE nodes ("nodeNum" BIGINT NOT NULL, "sourceId" TEXT NOT NULL, PRIMARY KEY ("nodeNum", "sourceId"))`);
    await pool.query(`INSERT INTO nodes ("nodeNum", "sourceId") VALUES (4294967295, 'src-a')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds nullable columns of the right types and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration234Postgres(client);
      await expect(runMigration234Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT "mqttOkToMqtt", "mqttOkToMqttAt", "rfDirectLastHeard" FROM nodes`);
    expect(rows[0]).toEqual({ mqttOkToMqtt: null, mqttOkToMqttAt: null, rfDirectLastHeard: null });
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'nodes' AND column_name IN ('mqttOkToMqtt','mqttOkToMqttAt','rfDirectLastHeard') ORDER BY column_name`,
    );
    expect(cols.map((c: { column_name: string; data_type: string }) => `${c.column_name}:${c.data_type}`)).toEqual([
      'mqttOkToMqtt:boolean',
      'mqttOkToMqttAt:bigint',
      'rfDirectLastHeard:bigint',
    ]);
  });
});

describe.skipIf(!mysqlAvailable)('migration 234 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig234'));
    await pool.query('DROP TABLE IF EXISTS nodes');
    await pool.query(`CREATE TABLE nodes (nodeNum BIGINT NOT NULL, sourceId VARCHAR(64) NOT NULL, PRIMARY KEY (nodeNum, sourceId))`);
    await pool.query(`INSERT INTO nodes (nodeNum, sourceId) VALUES (4294967295, 'src-a')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds nullable columns and is idempotent', async () => {
    await runMigration234Mysql(pool);
    await expect(runMigration234Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(`SELECT mqttOkToMqtt, mqttOkToMqttAt, rfDirectLastHeard FROM nodes`);
    expect((rows as Array<Record<string, unknown>>)[0]).toEqual({ mqttOkToMqtt: null, mqttOkToMqttAt: null, rfDirectLastHeard: null });
  });
});
