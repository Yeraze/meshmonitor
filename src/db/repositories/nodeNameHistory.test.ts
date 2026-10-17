/**
 * Node name history (#5862): the rename predicates, NodeNameHistoryRepository
 * on SQLite / PostgreSQL / MySQL (table built by migration 209, run twice), and
 * the hooks in the two node upserts on SQLite.
 *
 * PostgreSQL / MySQL run against the test containers on 5433 / 3307, each in a
 * private database. They skip silently without the containers — confirm via
 * the JSON reporter's numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import {
  NodeNameHistoryRepository,
  NODE_NAME_HISTORY_CAP,
  isMeshtasticRename,
  isMeshCoreRename,
  type NodeNameHistoryRow,
} from './nodeNameHistory.js';
import { NodesRepository } from './nodes.js';
import { MeshCoreRepository } from './meshcore.js';
import {
  migration as migration209,
  runMigration209Postgres,
  runMigration209Mysql,
} from '../../server/migrations/209_create_node_name_history.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';
const NODE_ID = '!9e80e848';
const NODE_NUM = 0x9e80e848; // above 2^31

const row = (over: Partial<NodeNameHistoryRow> = {}): Omit<NodeNameHistoryRow, 'id'> => ({
  sourceId: SRC_A,
  protocol: 'meshtastic',
  nodeKey: String(NODE_NUM),
  oldLongName: 'Alpha',
  newLongName: 'Bravo',
  oldShortName: 'ALP',
  newShortName: 'BRV',
  changedAt: 1_700_000_000_000,
  ...over,
});

describe('isMeshtasticRename', () => {
  it('logs a real long-name or short-name change', () => {
    expect(isMeshtasticRename({ longName: 'Alpha', shortName: 'ALP' }, { longName: 'Bravo', shortName: 'ALP' }, NODE_ID)).toBe(true);
    expect(isMeshtasticRename({ longName: 'Alpha', shortName: 'ALP' }, { longName: 'Alpha', shortName: 'AL2' }, NODE_ID)).toBe(true);
  });

  it('ignores an identical NodeInfo', () => {
    expect(isMeshtasticRename({ longName: 'Alpha', shortName: 'ALP' }, { longName: 'Alpha', shortName: 'ALP' }, NODE_ID)).toBe(false);
  });

  it('ignores a first real name replacing a placeholder', () => {
    for (const stub of [null, '', 'Unknown', 'Node !9e80e848', 'Meshtastic e848']) {
      expect(isMeshtasticRename({ longName: stub, shortName: 'e848' }, { longName: 'Alpha', shortName: 'ALP' }, NODE_ID)).toBe(false);
    }
    expect(isMeshtasticRename({ longName: 'Alpha', shortName: 'UNK' }, { longName: 'Alpha', shortName: 'ALP' }, NODE_ID)).toBe(false);
  });

  it('ignores a real name falling back to a placeholder', () => {
    expect(isMeshtasticRename({ longName: 'Alpha', shortName: 'ALP' }, { longName: 'Meshtastic e848', shortName: 'e848' }, NODE_ID)).toBe(false);
  });
});

describe('isMeshCoreRename', () => {
  it('logs one non-blank name replacing another', () => {
    expect(isMeshCoreRename('Alpha', 'Bravo')).toBe(true);
    expect(isMeshCoreRename('Alpha', 'Alpha')).toBe(false);
    expect(isMeshCoreRename(null, 'Alpha')).toBe(false);
    expect(isMeshCoreRename('Alpha', '  ')).toBe(false);
  });
});

function runRepoSuite(getRepo: () => NodeNameHistoryRepository, clear: () => Promise<void>) {
  let repo: NodeNameHistoryRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('round-trips a row, newest first, scoped to the given sources', async () => {
    await repo.record(row({ changedAt: 1000 }));
    await repo.record(row({ changedAt: 2000, oldLongName: 'Bravo', newLongName: 'Charlie' }));
    await repo.record(row({ sourceId: SRC_B, changedAt: 3000 }));

    const onA = await repo.listForNode('meshtastic', String(NODE_NUM), [SRC_A]);
    expect(onA.map(r => r.newLongName)).toEqual(['Charlie', 'Bravo']);
    expect(onA[0]).toMatchObject({ sourceId: SRC_A, protocol: 'meshtastic', nodeKey: String(NODE_NUM), changedAt: 2000 });

    expect(await repo.listForNode('meshtastic', String(NODE_NUM), [SRC_A, SRC_B])).toHaveLength(3);
    expect(await repo.listForNode('meshtastic', String(NODE_NUM), [])).toEqual([]);
    expect(await repo.listForNode('meshcore', String(NODE_NUM), [SRC_A])).toEqual([]);
  });

  it(`keeps only the newest ${NODE_NAME_HISTORY_CAP} rows per source and node`, async () => {
    for (let i = 0; i < NODE_NAME_HISTORY_CAP + 3; i++) {
      await repo.record(row({ changedAt: 1000 + i, newLongName: `Name ${i}` }));
    }
    await repo.record(row({ sourceId: SRC_B }));

    const onA = await repo.listForNode('meshtastic', String(NODE_NUM), [SRC_A]);
    expect(onA).toHaveLength(NODE_NAME_HISTORY_CAP);
    expect(onA[0].newLongName).toBe(`Name ${NODE_NAME_HISTORY_CAP + 2}`);
    expect(onA[onA.length - 1].newLongName).toBe('Name 3');
    expect(await repo.listForNode('meshtastic', String(NODE_NUM), [SRC_B])).toHaveLength(1);
  });

  it('deletes by node, by source + protocol, and by source', async () => {
    await repo.record(row());
    await repo.record(row({ nodeKey: '42' }));
    await repo.record(row({ sourceId: SRC_B }));
    await repo.record(row({ protocol: 'meshcore', nodeKey: 'a'.repeat(64) }));

    await repo.deleteForNode('meshtastic', String(NODE_NUM), SRC_A);
    expect(await repo.listForNode('meshtastic', String(NODE_NUM), [SRC_A, SRC_B])).toHaveLength(1);
    expect(await repo.listForNode('meshtastic', '42', [SRC_A])).toHaveLength(1);

    await repo.deleteForSourceProtocol(SRC_A, 'meshtastic');
    expect(await repo.listForNode('meshtastic', '42', [SRC_A])).toEqual([]);
    expect(await repo.listForNode('meshcore', 'a'.repeat(64), [SRC_A])).toHaveLength(1);

    await repo.deleteBySourceId(SRC_A);
    expect(await repo.listForNode('meshcore', 'a'.repeat(64), [SRC_A])).toEqual([]);
    expect(await repo.listForNode('meshtastic', String(NODE_NUM), [SRC_B])).toHaveLength(1);
  });
}

describe('NodeNameHistoryRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 209 is idempotent on SQLite', () => {
    expect(() => migration209.up(t.sqlite)).not.toThrow();
    expect(() => migration209.up(t.sqlite)).not.toThrow();
  });

  runRepoSuite(
    () => new NodeNameHistoryRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM node_name_history').run(); },
  );
});

describe('node upserts record renames (SQLite)', () => {
  let t: ReturnType<typeof createTestDb>;
  let nodes: NodesRepository;
  let meshcore: MeshCoreRepository;
  let history: NodeNameHistoryRepository;

  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });
  beforeEach(() => {
    t.sqlite.prepare('DELETE FROM node_name_history').run();
    t.sqlite.prepare('DELETE FROM nodes').run();
    t.sqlite.prepare('DELETE FROM meshcore_nodes').run();
    nodes = new NodesRepository(t.db, 'sqlite');
    meshcore = new MeshCoreRepository(t.db, 'sqlite');
    history = new NodeNameHistoryRepository(t.db, 'sqlite');
  });

  const listMeshtastic = (sources = [SRC_A]) => history.listForNode('meshtastic', String(NODE_NUM), sources);

  it('Meshtastic: logs a rename, but not the first name or a repeat NodeInfo', async () => {
    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: `Node ${NODE_ID}`, shortName: 'e848' }, SRC_A);
    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha', shortName: 'ALP' }, SRC_A);
    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha', shortName: 'ALP' }, SRC_A);
    expect(await listMeshtastic()).toEqual([]);

    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Bravo', shortName: 'BRV' }, SRC_A);
    const rows = await listMeshtastic();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: SRC_A, oldLongName: 'Alpha', newLongName: 'Bravo', oldShortName: 'ALP', newShortName: 'BRV',
    });
  });

  it('Meshtastic: a blank incoming name keeps the stored name and logs nothing', async () => {
    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha', shortName: 'ALP' }, SRC_A);
    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: '', shortName: '' }, SRC_A);
    await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, batteryLevel: 80 }, SRC_A);
    expect(await listMeshtastic()).toEqual([]);
  });

  it('Meshtastic: deleting the node on a source drops its history there only', async () => {
    for (const src of [SRC_A, SRC_B]) {
      await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Alpha', shortName: 'ALP' }, src);
      await nodes.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Bravo', shortName: 'BRV' }, src);
    }
    await nodes.deleteNodeRecord(NODE_NUM, SRC_A);
    expect(await listMeshtastic([SRC_A])).toEqual([]);
    expect(await listMeshtastic([SRC_B])).toHaveLength(1);

    await nodes.deleteAllNodes(SRC_B);
    expect(await listMeshtastic([SRC_B])).toEqual([]);
  });

  it('MeshCore: logs a rename and drops it with the node', async () => {
    const key = 'c'.repeat(64);
    await meshcore.upsertNode({ publicKey: key, name: 'Hill Repeater' }, SRC_A);
    await meshcore.upsertNode({ publicKey: key, name: 'Hill Repeater' }, SRC_A);
    await meshcore.upsertNode({ publicKey: key, name: null }, SRC_A);
    expect(await history.listForNode('meshcore', key, [SRC_A])).toEqual([]);

    await meshcore.upsertNode({ publicKey: key, name: 'Ridge Repeater' }, SRC_A);
    const rows = await history.listForNode('meshcore', key, [SRC_A]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldLongName: 'Hill Repeater', newLongName: 'Ridge Repeater', oldShortName: null, newShortName: null });

    await meshcore.deleteNode(key, SRC_A);
    expect(await history.listForNode('meshcore', key, [SRC_A])).toEqual([]);
  });
});

describe.skipIf(!postgresAvailable)('NodeNameHistoryRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig209'));
    const client = await pool.connect();
    try {
      await runMigration209Postgres(client);
      await runMigration209Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new NodeNameHistoryRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM node_name_history'); },
  );
});

describe.skipIf(!mysqlAvailable)('NodeNameHistoryRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig209'));
    await runMigration209Mysql(pool);
    await runMigration209Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new NodeNameHistoryRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM node_name_history'); },
  );
});
