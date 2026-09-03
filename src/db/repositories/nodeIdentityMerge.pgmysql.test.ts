/**
 * Node identity merge on PostgreSQL and MySQL (issue #5032).
 *
 * The SQLite suite (`nodeIdentityMerge.test.ts`) covers the behaviour in
 * depth. This one exists for the things only another backend can catch:
 *
 * - the transaction really rolls back (SQLite drives BEGIN/COMMIT explicitly,
 *   PG/MySQL go through Drizzle's `transaction()` — two different mechanisms)
 * - node numbers are BIGINT here and unsigned 32-bit in the protocol, so a
 *   comparison that works on SQLite's dynamic typing can quietly match nothing
 * - the `messages` id rewrite uses `||` on SQLite/PG and `CONCAT` on MySQL
 * - `undoable`/`journal` round-trip through BOOLEAN and LONGTEXT
 *
 * **Isolation:** this suite creates its own PostgreSQL *schema* and MySQL
 * *database*. Sharing fixture table names with another suite in the same test
 * database is an active race — two suites dropping `meshcore_nodes` is
 * currently breaking migrations 153 and 156 — and a merge fixture touches
 * sixteen tables including `nodes`, so it would be the worst possible offender.
 *
 * The DDL is generated from the Drizzle schema (`drizzleDdl.ts`) rather than
 * hand-written: sixteen tables of literal `CREATE TABLE` is exactly the drift
 * that cost ~92 CI failures in #4250.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { eq, and, sql } from 'drizzle-orm';
import pg from 'pg';
import mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { buildActiveSchema } from '../activeSchema.js';
import { postgresCreateTable, mysqlCreateTable } from '../../server/test-helpers/drizzleDdl.js';
import { postgresAvailable, mysqlAvailable } from './test-utils.js';
import { NodeIdentityMergeRepository, REKEY_TARGETS, SINGLETON_TARGETS } from './nodeIdentityMerge.js';
import type { DatabaseType } from '../types.js';

const { Pool: PgPool } = pg;

/** Dedicated namespace, so no other suite can collide with these tables. */
const PG_SCHEMA = 'nim_merge_test';
const MYSQL_DB = 'meshmonitor_test_nim_merge';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const OLD_NUM = 0x433d1ba4;
const NEW_NUM = 0x11223344;

/** Every table the merge reads or writes, by active-schema key. */
const FIXTURE_TABLES = Array.from(
  new Set([
    'nodes',
    'nodeIdentityMerges',
    ...REKEY_TARGETS.map(t => t.table),
    ...SINGLETON_TARGETS.map(t => t.table),
  ]),
);

interface Backend {
  dbType: DatabaseType;
  db: any;
  repo: NodeIdentityMergeRepository;
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

async function setupPostgres(): Promise<Backend> {
  const admin = new PgPool({
    host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
  });
  await admin.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${PG_SCHEMA}`);
  await admin.end();

  // `options` pins search_path per connection, so the unqualified table names
  // in the Drizzle schema resolve inside our private namespace.
  const pool = new PgPool({
    host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
    options: `-c search_path=${PG_SCHEMA}`,
  });
  const tables = buildActiveSchema('postgres') as unknown as Record<string, unknown>;
  for (const key of FIXTURE_TABLES) {
    for (const statement of postgresCreateTable(tables[key]).split(';\n')) {
      await pool.query(statement);
    }
  }
  const db = drizzlePostgres(pool, { schema });
  return {
    dbType: 'postgres',
    db,
    repo: new NodeIdentityMergeRepository(db as never, 'postgres'),
    truncate: async () => {
      await pool.query(
        `TRUNCATE ${FIXTURE_TABLES.map(k => `${PG_SCHEMA}.${pgName(tables[k])}`).join(', ')}`,
      );
    },
    close: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    },
  };
}

function pgName(table: unknown): string {
  // The physical name is what TRUNCATE needs; the generator already knows it.
  return postgresCreateTable(table).match(/CREATE TABLE "([^"]+)"/)![1];
}

function myName(table: unknown): string {
  return mysqlCreateTable(table).match(/CREATE TABLE `([^`]+)`/)![1];
}

async function setupMysql(): Promise<Backend> {
  const admin = mysql.createPool({
    host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
  await admin.query(`GRANT ALL ON \`${MYSQL_DB}\`.* TO 'test'@'%'`);
  await admin.query('FLUSH PRIVILEGES');
  await admin.end();

  const pool = mysql.createPool({
    host: 'localhost', port: 3307, user: 'test', password: 'test', database: MYSQL_DB, connectionLimit: 5,
  });
  const tables = buildActiveSchema('mysql') as unknown as Record<string, unknown>;
  for (const key of FIXTURE_TABLES) {
    await pool.query(mysqlCreateTable(tables[key]));
  }
  const db = drizzleMysql(pool, { schema, mode: 'default' });
  return {
    dbType: 'mysql',
    db,
    repo: new NodeIdentityMergeRepository(db as never, 'mysql'),
    truncate: async () => {
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const key of FIXTURE_TABLES) await pool.query(`TRUNCATE TABLE \`${myName(tables[key])}\``);
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');
    },
    close: async () => {
      await pool.end();
      const cleanup = mysql.createPool({
        host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1,
      });
      await cleanup.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
      await cleanup.end();
    },
  };
}

/**
 * The shared body of the multi-backend run. Both dialects get exactly the same
 * assertions — a difference in outcome is the bug this file exists to find.
 */
function runSuite(name: string, dialect: 'postgres' | 'mysql', enabled: boolean) {
  describe.skipIf(!enabled)(`node identity merge — ${name}`, () => {
    let backend: Backend;
    let tables: Record<string, any>;

    beforeAll(async () => {
      backend = dialect === 'postgres' ? await setupPostgres() : await setupMysql();
      tables = buildActiveSchema(dialect) as unknown as Record<string, any>;
    }, 60_000);

    afterAll(async () => {
      if (backend) await backend.close();
    });

    beforeEach(async () => {
      await backend.truncate();
      for (const sourceId of [SOURCE_A, SOURCE_B]) {
        for (const nodeNum of [OLD_NUM, NEW_NUM]) {
          await backend.db.insert(tables.nodes).values({
            nodeNum,
            nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
            sourceId,
            createdAt: nodeNum === OLD_NUM ? 1_000_000 : 9_000_000,
            updatedAt: 9_000_000,
          });
        }
      }
    });

    const addTelemetry = (nodeNum: number, sourceId: string, value: number) =>
      backend.db.insert(tables.telemetry).values({
        nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
        nodeNum,
        telemetryType: 'batteryLevel',
        timestamp: 1_700_000_000_000 + value,
        value,
        createdAt: 1_700_000_000_000,
        sourceId,
      });

    const addMessage = (fromNum: number, packetId: number, sourceId: string, text: string) =>
      backend.db.insert(tables.messages).values({
        id: `${sourceId}_${fromNum}_${packetId}`,
        fromNodeNum: fromNum,
        toNodeNum: 0xffffffff,
        fromNodeId: `!${fromNum.toString(16).padStart(8, '0')}`,
        toNodeId: '!ffffffff',
        text,
        channel: 0,
        timestamp: 1_700_000_000_000,
        createdAt: 1_700_000_000_000,
        sourceId,
      });

    it('re-keys history and rewrites the messages primary key', async () => {
      await addTelemetry(OLD_NUM, SOURCE_A, 1);
      await addTelemetry(OLD_NUM, SOURCE_A, 2);
      await addMessage(OLD_NUM, 4242, SOURCE_A, 'before the upgrade');

      const preview = await backend.repo.buildMergePlan(SOURCE_A, OLD_NUM, NEW_NUM);
      const { plan } = await backend.repo.executeMerge({
        sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
      });
      expect(plan.entries).toEqual(preview.entries);

      const telemetry = await backend.db
        .select()
        .from(tables.telemetry)
        .where(and(eq(tables.telemetry.sourceId, SOURCE_A), eq(tables.telemetry.nodeNum, NEW_NUM)));
      expect(telemetry).toHaveLength(2);

      const [message] = await backend.db
        .select()
        .from(tables.messages)
        .where(eq(tables.messages.sourceId, SOURCE_A));
      // `||` on PostgreSQL, `CONCAT` on MySQL — the one place the SQL differs.
      expect(message.id).toBe(`${SOURCE_A}_${NEW_NUM}_4242`);
      expect(Number(message.fromNodeNum)).toBe(NEW_NUM);

      const nodes = await backend.db
        .select()
        .from(tables.nodes)
        .where(eq(tables.nodes.sourceId, SOURCE_A));
      expect(nodes).toHaveLength(1);
      expect(Number(nodes[0].nodeNum)).toBe(NEW_NUM);
      // BIGINT round-trip: the earlier first-seen date has to survive it.
      expect(Number(nodes[0].createdAt)).toBe(1_000_000);
    });

    it('never touches another source', async () => {
      await addTelemetry(OLD_NUM, SOURCE_A, 1);
      await addTelemetry(OLD_NUM, SOURCE_B, 1);
      await addMessage(OLD_NUM, 900, SOURCE_B, 'source B');

      await backend.repo.executeMerge({
        sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
      });

      const other = await backend.db
        .select()
        .from(tables.telemetry)
        .where(and(eq(tables.telemetry.sourceId, SOURCE_B), eq(tables.telemetry.nodeNum, OLD_NUM)));
      expect(other).toHaveLength(1);

      const [message] = await backend.db
        .select()
        .from(tables.messages)
        .where(eq(tables.messages.sourceId, SOURCE_B));
      expect(message.id).toBe(`${SOURCE_B}_${OLD_NUM}_900`);

      const bNodes = await backend.db
        .select()
        .from(tables.nodes)
        .where(eq(tables.nodes.sourceId, SOURCE_B));
      expect(bNodes).toHaveLength(2);
    });

    it('rolls the whole merge back when a step fails', async () => {
      await addTelemetry(OLD_NUM, SOURCE_A, 1);
      await addMessage(OLD_NUM, 5, SOURCE_A, 'still mine');

      const broken = new NodeIdentityMergeRepository(backend.db as never, dialect);
      (broken as unknown as { applyNodeRows: () => Promise<void> }).applyNodeRows = async () => {
        throw new Error('boom');
      };
      await expect(
        broken.executeMerge({
          sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'manual', mergedBy: 'admin',
        }),
      ).rejects.toThrow('boom');

      const telemetry = await backend.db
        .select()
        .from(tables.telemetry)
        .where(eq(tables.telemetry.nodeNum, OLD_NUM));
      expect(telemetry).toHaveLength(1);
      const [message] = await backend.db.select().from(tables.messages);
      expect(message.id).toBe(`${SOURCE_A}_${OLD_NUM}_5`);
      expect(await backend.repo.listMerges(SOURCE_A)).toHaveLength(0);
    });

    it('undoes a merge, restoring dropped rows and the retired node', async () => {
      await addTelemetry(OLD_NUM, SOURCE_A, 1);
      await addTelemetry(OLD_NUM, SOURCE_A, 2);
      await addTelemetry(NEW_NUM, SOURCE_A, 3);
      await addMessage(OLD_NUM, 777, SOURCE_A, 'old copy');
      await addMessage(NEW_NUM, 777, SOURCE_A, 'new copy');

      const { mergeId } = await backend.repo.executeMerge({
        sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
      });
      await backend.repo.undoMerge(mergeId, 'admin', SOURCE_A);

      const rows = await backend.db
        .select()
        .from(tables.telemetry)
        .where(eq(tables.telemetry.sourceId, SOURCE_A));
      const byValue = new Map(rows.map((r: { value: number; nodeNum: number }) => [Number(r.value), Number(r.nodeNum)]));
      expect(byValue.get(1)).toBe(OLD_NUM);
      expect(byValue.get(2)).toBe(OLD_NUM);
      expect(byValue.get(3)).toBe(NEW_NUM);

      // The dropped collision copy is back, under its original id.
      const ids = (
        await backend.db.select().from(tables.messages).where(eq(tables.messages.sourceId, SOURCE_A))
      )
        .map((m: { id: string }) => m.id)
        .sort();
      expect(ids).toEqual([`${SOURCE_A}_${NEW_NUM}_777`, `${SOURCE_A}_${OLD_NUM}_777`].sort());

      const nodes = await backend.db
        .select()
        .from(tables.nodes)
        .where(eq(tables.nodes.sourceId, SOURCE_A));
      expect(nodes).toHaveLength(2);

      // BOOLEAN + LONGTEXT round-trip on the journal row itself.
      const [record] = await backend.repo.listMerges(SOURCE_A);
      expect(record.undoable).toBe(true);
      expect(record.undoneAt).toBeGreaterThan(0);
    });

    it('refuses an undo from a different source before writing anything', async () => {
      await addTelemetry(OLD_NUM, SOURCE_A, 1);
      const { mergeId } = await backend.repo.executeMerge({
        sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
      });
      await expect(backend.repo.undoMerge(mergeId, 'admin', SOURCE_B)).rejects.toMatchObject({
        code: 'WRONG_SOURCE',
      });
      const moved = await backend.db
        .select({ n: sql<number>`count(*)` })
        .from(tables.telemetry)
        .where(and(eq(tables.telemetry.sourceId, SOURCE_A), eq(tables.telemetry.nodeNum, NEW_NUM)));
      expect(Number(moved[0].n)).toBe(1);
    });
  });
}

runSuite('PostgreSQL', 'postgres', postgresAvailable);
runSuite('MySQL', 'mysql', mysqlAvailable);
