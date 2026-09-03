/**
 * Node identity merge — the destructive path, pinned (issue #5032).
 *
 * These tests exist because a wrong merge is unrecoverable in a way almost
 * nothing else in this app is: it silently splices two physical nodes' histories
 * together and there is no signal afterwards that it happened. So they assert
 * the guarantees, not the plumbing:
 *
 * - the dry-run preview describes exactly what the merge then does
 * - every table in the inventory actually moves
 * - collisions are dropped by the documented rule, not by whatever the database
 *   raises first
 * - a failure part-way through leaves the database untouched
 * - undo restores the prior state, including the rows the merge deleted
 * - nothing crosses a source boundary
 *
 * SQLite only; the multi-backend run lives in `.pgmysql.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';
import {
  NodeIdentityMergeRepository,
  NodeIdentityMergeError,
  REKEY_TARGETS,
  chooseCapture,
  MAX_SURVIVOR_CAPTURE_PKS,
} from './nodeIdentityMerge.js';
import * as schema from '../schema/index.js';
// `sources` is not re-exported from the schema barrel; the FK below needs it.
import { sourcesSqlite } from '../schema/sources.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
/** Pre-2.8, MAC-derived. */
const OLD_NUM = 0x433d1ba4;
/** 2.8, key-derived. */
const NEW_NUM = 0x11223344;

let testDb: TestDb;
let repo: NodeIdentityMergeRepository;

function insertNode(nodeNum: number, sourceId: string, overrides: Record<string, unknown> = {}) {
  return testDb.db.insert(schema.nodesSqlite).values({
    nodeNum,
    nodeId: `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`,
    sourceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as never);
}

function insertTelemetry(nodeNum: number, sourceId: string, value: number) {
  return testDb.db.insert(schema.telemetrySqlite).values({
    nodeId: `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`,
    nodeNum,
    telemetryType: 'batteryLevel',
    timestamp: 1_700_000_000_000 + value,
    value,
    createdAt: Date.now(),
    sourceId,
  } as never);
}

function insertMessage(fromNum: number, packetId: number, sourceId: string, text: string) {
  return testDb.db.insert(schema.messagesSqlite).values({
    id: `${sourceId}_${fromNum}_${packetId}`,
    fromNodeNum: fromNum,
    toNodeNum: 0xffffffff,
    fromNodeId: `!${(fromNum >>> 0).toString(16).padStart(8, '0')}`,
    toNodeId: '!ffffffff',
    text,
    channel: 0,
    timestamp: 1_700_000_000_000,
    createdAt: Date.now(),
    sourceId,
  } as never);
}

async function countRows(table: never, where: never): Promise<number> {
  const rows = await testDb.db.select({ n: sql<number>`count(*)` }).from(table).where(where);
  return Number(rows[0]?.n ?? 0);
}

/**
 * `ignored_nodes.sourceId` carries a real FK to `sources(id)` (migration 048),
 * so the fixture has to register both sources before anything references them.
 */
async function insertSources() {
  for (const id of [SOURCE_A, SOURCE_B]) {
    await testDb.db.insert(sourcesSqlite).values({
      id,
      name: id,
      type: 'meshtastic',
      config: '{}',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
  }
}

beforeEach(async () => {
  testDb = createTestDb();
  repo = new NodeIdentityMergeRepository(testDb.db as never, 'sqlite');
  await insertSources();
});

afterEach(() => {
  testDb.close();
});

describe('the inventory itself', () => {
  it('names only tables and columns that exist in the schema', () => {
    // A typo here would silently skip a whole table's history: the merge walks
    // this list, and `this.table()` throwing at merge time is far too late.
    const active = schema as unknown as Record<string, unknown>;
    for (const target of REKEY_TARGETS) {
      const key = `${target.table}Sqlite`;
      expect(active[key], `missing schema export ${key}`).toBeDefined();
      const columns = active[key] as Record<string, unknown>;
      expect(columns[target.numColumn], `${target.label}.${target.numColumn}`).toBeDefined();
      expect(columns[target.pkColumn], `${target.label}.${target.pkColumn}`).toBeDefined();
      for (const idColumn of target.idColumns) {
        expect(columns[idColumn], `${target.label}.${idColumn}`).toBeDefined();
      }
      expect(columns.sourceId, `${target.label}.sourceId`).toBeDefined();
    }
  });

  it('only offers the cheap survivor capture where a monotonic key backs it', () => {
    // Without an auto-increment key there is no way to tell a re-keyed row from
    // one inserted after the merge, so undo would drag new traffic backwards.
    expect(chooseCapture(1000, 1, false)).toBe('moved');
    expect(chooseCapture(1000, 1, true)).toBe('survivor');
    // …and never a survivor list too long to fit in one bound-parameter list.
    expect(chooseCapture(10_000_000, MAX_SURVIVOR_CAPTURE_PKS + 1, true)).toBe('moved');
  });
});

describe('dry-run preview', () => {
  beforeEach(async () => {
    await insertNode(OLD_NUM, SOURCE_A, { longName: 'Hilltop', createdAt: 1_000_000 });
    await insertNode(NEW_NUM, SOURCE_A, { longName: 'Hilltop', createdAt: 9_000_000 });
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    await insertTelemetry(OLD_NUM, SOURCE_A, 2);
    await insertMessage(OLD_NUM, 111, SOURCE_A, 'old one');
  });

  it('writes nothing', async () => {
    const before = await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, OLD_NUM) as never);
    await repo.buildMergePlan(SOURCE_A, OLD_NUM, NEW_NUM);
    const after = await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, OLD_NUM) as never);
    expect(after).toBe(before);
    expect(after).toBe(2);
  });

  it('counts each affected table, and matches what the merge actually does', async () => {
    const preview = await repo.buildMergePlan(SOURCE_A, OLD_NUM, NEW_NUM);
    const telemetry = preview.entries.find(e => e.table === 'telemetry');
    expect(telemetry).toMatchObject({ action: 'rekey', rows: 2 });
    expect(preview.entries.some(e => e.action === 'deleteNodeRow')).toBe(true);

    const { plan } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
    });

    // Same code path, so the same numbers — that is the whole point of having
    // the merge re-run buildMergePlan inside its transaction.
    expect(plan.totalRowsRekeyed).toBe(preview.totalRowsRekeyed);
    expect(plan.totalRowsDropped).toBe(preview.totalRowsDropped);
    expect(plan.entries).toEqual(preview.entries);
  });

  it('refuses a node that does not exist on this source', async () => {
    await expect(repo.buildMergePlan(SOURCE_A, OLD_NUM, 0xdeadbeef)).rejects.toThrow(NodeIdentityMergeError);
    // …and the same node on ANOTHER source does not count as existing.
    await insertNode(0xdeadbeef, SOURCE_B);
    await expect(repo.buildMergePlan(SOURCE_A, OLD_NUM, 0xdeadbeef)).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND',
    });
  });

  it('lists what will NOT be re-keyed', async () => {
    const preview = await repo.buildMergePlan(SOURCE_A, OLD_NUM, NEW_NUM);
    const tables = preview.notRekeyed.map(n => n.table);
    expect(tables).toContain('estimated_positions');
    // Every exclusion carries a reason; an unexplained one is a trap.
    for (const entry of preview.notRekeyed) expect(entry.reason.length).toBeGreaterThan(20);
  });
});

describe('the merge itself', () => {
  beforeEach(async () => {
    await insertNode(OLD_NUM, SOURCE_A, { longName: 'Hilltop', createdAt: 1_000_000, notes: 'mast at 40m' });
    await insertNode(NEW_NUM, SOURCE_A, { longName: 'Hilltop', createdAt: 9_000_000 });
  });

  it('re-keys history onto the surviving node number', async () => {
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    await insertTelemetry(OLD_NUM, SOURCE_A, 2);
    await testDb.db.insert(schema.traceroutesSqlite).values({
      fromNodeNum: OLD_NUM, toNodeNum: 999, fromNodeId: '!433d1ba4', toNodeId: '!000003e7',
      timestamp: 1, createdAt: 1, sourceId: SOURCE_A,
    } as never);

    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
    });

    expect(await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, NEW_NUM) as never)).toBe(2);
    expect(await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, OLD_NUM) as never)).toBe(0);

    const [trace] = await testDb.db.select().from(schema.traceroutesSqlite);
    expect(trace.fromNodeNum).toBe(NEW_NUM);
    // The `!hex` mirror column has to move with its number, or the UI reads a
    // node id that no longer resolves.
    expect(trace.fromNodeId).toBe('!11223344');
  });

  it('rewrites the messages primary key, which encodes the sender', async () => {
    await insertMessage(OLD_NUM, 4242, SOURCE_A, 'before the upgrade');

    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });

    const [message] = await testDb.db.select().from(schema.messagesSqlite);
    // `${sourceId}_${fromNodeNum}_${packetId}` — packet id LAST, and preserved.
    expect(message.id).toBe(`${SOURCE_A}_${NEW_NUM}_4242`);
    expect(message.fromNodeNum).toBe(NEW_NUM);
    expect(message.text).toBe('before the upgrade');
  });

  it('drops the predecessor copy when a message id would collide, keeping the survivor', async () => {
    await insertMessage(OLD_NUM, 777, SOURCE_A, 'old copy');
    await insertMessage(NEW_NUM, 777, SOURCE_A, 'new copy');
    await insertMessage(OLD_NUM, 778, SOURCE_A, 'no collision');

    const preview = await repo.buildMergePlan(SOURCE_A, OLD_NUM, NEW_NUM);
    expect(preview.entries.find(e => e.action === 'dropCollision')).toMatchObject({ rows: 1 });
    expect(preview.warnings.join(' ')).toContain('same packet id');

    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });

    const messages = await testDb.db.select().from(schema.messagesSqlite);
    expect(messages).toHaveLength(2);
    const collided = messages.find(m => m.id === `${SOURCE_A}_${NEW_NUM}_777`);
    expect(collided?.text).toBe('new copy');
  });

  it('drops neighbour rows that would become self-loops', async () => {
    // "old node heard new node" is a real observation before the upgrade and a
    // nonsense one after it.
    await testDb.db.insert(schema.neighborInfoSqlite).values([
      { nodeNum: OLD_NUM, neighborNodeNum: NEW_NUM, timestamp: 1, createdAt: 1, sourceId: SOURCE_A },
      { nodeNum: OLD_NUM, neighborNodeNum: 555, timestamp: 1, createdAt: 1, sourceId: SOURCE_A },
    ] as never);

    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });

    const rows = await testDb.db.select().from(schema.neighborInfoSqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeNum: NEW_NUM, neighborNodeNum: 555 });
  });

  it('moves a singleton row when the survivor has none, and drops it when it does', async () => {
    await testDb.db.insert(schema.ignoredNodesSqlite).values({
      nodeNum: OLD_NUM, sourceId: SOURCE_A, nodeId: '!433d1ba4', ignoredAt: 5, reason: 'spammer',
    } as never);

    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });

    const rows = await testDb.db.select().from(schema.ignoredNodesSqlite);
    expect(rows).toHaveLength(1);
    // The ignore has to follow the node, or ignored traffic quietly resumes
    // under the new number.
    expect(rows[0]).toMatchObject({ nodeNum: NEW_NUM, nodeId: '!11223344', reason: 'spammer' });
  });

  it('retires the old nodes row and carries its first-seen date and notes over', async () => {
    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
    });

    const rows = await testDb.db.select().from(schema.nodesSqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeNum).toBe(NEW_NUM);
    // Otherwise the node's whole recorded life appears to start at the upgrade.
    expect(rows[0].createdAt).toBe(1_000_000);
    // Operator-entered text must not vanish because a row was retired.
    expect(rows[0].notes).toBe('mast at 40m');
  });

  it('refuses to merge a node into itself', async () => {
    await expect(
      repo.executeMerge({
        sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: OLD_NUM, basis: 'manual', mergedBy: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'SAME_NODE' });
  });

  it('refuses without a sourceId', async () => {
    await expect(
      repo.executeMerge({
        sourceId: '', fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'manual', mergedBy: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_REQUIRED' });
  });

  it('records an audit row describing what it did', async () => {
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
    });

    const merges = await repo.listMerges(SOURCE_A);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      id: mergeId,
      fromNodeNum: OLD_NUM,
      toNodeNum: NEW_NUM,
      basis: 'derivedNodeNum',
      mergedBy: 'admin',
      undoable: true,
      undoneAt: null,
    });
    expect(merges[0].rowsRekeyed).toBeGreaterThan(0);
  });
});

describe('per-source isolation', () => {
  beforeEach(async () => {
    await insertNode(OLD_NUM, SOURCE_A);
    await insertNode(NEW_NUM, SOURCE_A);
    // The SAME two node numbers on a second source. A merge on source A must
    // not touch a single row of these — that is the #3745 leak class.
    await insertNode(OLD_NUM, SOURCE_B);
    await insertNode(NEW_NUM, SOURCE_B);
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    await insertTelemetry(OLD_NUM, SOURCE_B, 1);
    await insertMessage(OLD_NUM, 900, SOURCE_A, 'source A');
    await insertMessage(OLD_NUM, 900, SOURCE_B, 'source B');
  });

  it('leaves the other source completely untouched', async () => {
    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });

    expect(
      await countRows(
        schema.telemetrySqlite as never,
        and(eq(schema.telemetrySqlite.sourceId, SOURCE_B), eq(schema.telemetrySqlite.nodeNum, OLD_NUM)) as never,
      ),
    ).toBe(1);

    const [otherMessage] = await testDb.db
      .select()
      .from(schema.messagesSqlite)
      .where(eq(schema.messagesSqlite.sourceId, SOURCE_B));
    expect(otherMessage.id).toBe(`${SOURCE_B}_${OLD_NUM}_900`);
    expect(otherMessage.fromNodeNum).toBe(OLD_NUM);

    // Source B still has both node rows; only source A retired one.
    const bNodes = await testDb.db
      .select()
      .from(schema.nodesSqlite)
      .where(eq(schema.nodesSqlite.sourceId, SOURCE_B));
    expect(bNodes).toHaveLength(2);
  });
});

describe('atomicity', () => {
  it('leaves the database untouched when a step fails part-way', async () => {
    await insertNode(OLD_NUM, SOURCE_A);
    await insertNode(NEW_NUM, SOURCE_A);
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    await insertMessage(OLD_NUM, 5, SOURCE_A, 'still mine');

    // Break a step that runs AFTER several tables have already been re-keyed:
    // if the transaction is not doing its job, telemetry stays moved and the
    // messages row keeps a rewritten primary key.
    const broken = new NodeIdentityMergeRepository(testDb.db as never, 'sqlite');
    (broken as unknown as { applyNodeRows: () => Promise<void> }).applyNodeRows = async () => {
      throw new Error('boom');
    };

    await expect(
      broken.executeMerge({
        sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'manual', mergedBy: 'admin',
      }),
    ).rejects.toThrow('boom');

    expect(await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, OLD_NUM) as never)).toBe(1);
    const [message] = await testDb.db.select().from(schema.messagesSqlite);
    expect(message.id).toBe(`${SOURCE_A}_${OLD_NUM}_5`);
    expect(await repo.listMerges(SOURCE_A)).toHaveLength(0);
    // Both node rows survive, so the merge can simply be retried.
    expect(await testDb.db.select().from(schema.nodesSqlite)).toHaveLength(2);
  });
});

describe('undo', () => {
  beforeEach(async () => {
    await insertNode(OLD_NUM, SOURCE_A, { longName: 'Hilltop', createdAt: 1_000_000, notes: 'mast at 40m' });
    await insertNode(NEW_NUM, SOURCE_A, { longName: 'Hilltop', createdAt: 9_000_000 });
  });

  it('restores re-keyed rows, dropped rows and the retired node row', async () => {
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    await insertTelemetry(OLD_NUM, SOURCE_A, 2);
    await insertTelemetry(NEW_NUM, SOURCE_A, 3);
    await insertMessage(OLD_NUM, 777, SOURCE_A, 'old copy');
    await insertMessage(NEW_NUM, 777, SOURCE_A, 'new copy');
    await insertMessage(OLD_NUM, 778, SOURCE_A, 'moves cleanly');
    await testDb.db.insert(schema.neighborInfoSqlite).values(
      { nodeNum: OLD_NUM, neighborNodeNum: NEW_NUM, timestamp: 1, createdAt: 1, sourceId: SOURCE_A } as never,
    );

    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'derivedNodeNum', mergedBy: 'admin',
    });
    await repo.undoMerge(mergeId, 'admin', SOURCE_A);

    // Telemetry: the two moved rows are back, the survivor's own row stayed.
    expect(await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, OLD_NUM) as never)).toBe(2);
    expect(await countRows(schema.telemetrySqlite as never, eq(schema.telemetrySqlite.nodeNum, NEW_NUM) as never)).toBe(1);

    // Messages: original ids, and the collision copy that was dropped is back.
    const ids = (await testDb.db.select().from(schema.messagesSqlite)).map(m => m.id).sort();
    expect(ids).toEqual(
      [
        `${SOURCE_A}_${OLD_NUM}_777`,
        `${SOURCE_A}_${OLD_NUM}_778`,
        `${SOURCE_A}_${NEW_NUM}_777`,
      ].sort(),
    );

    // The self-loop neighbour row is back in its original form.
    const neighbours = await testDb.db.select().from(schema.neighborInfoSqlite);
    expect(neighbours).toHaveLength(1);
    expect(neighbours[0]).toMatchObject({ nodeNum: OLD_NUM, neighborNodeNum: NEW_NUM });

    // Both node rows exist again, with their own createdAt and notes.
    const nodes = await testDb.db.select().from(schema.nodesSqlite).orderBy(schema.nodesSqlite.nodeNum);
    expect(nodes).toHaveLength(2);
    const survivor = nodes.find(n => n.nodeNum === NEW_NUM)!;
    expect(survivor.createdAt).toBe(9_000_000);
    expect(survivor.notes).toBeNull();
    const retired = nodes.find(n => n.nodeNum === OLD_NUM)!;
    expect(retired.notes).toBe('mast at 40m');
  });

  it('leaves rows that arrived after the merge under the new number', async () => {
    // The survivor-capture path reverts "everything on the new number except
    // the survivor's own rows". Traffic that arrived after the merge belongs to
    // the new number and must not be dragged back to a node that no longer
    // transmits.
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);
    await insertTelemetry(OLD_NUM, SOURCE_A, 2);
    await insertTelemetry(NEW_NUM, SOURCE_A, 3);

    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });
    await insertTelemetry(NEW_NUM, SOURCE_A, 4); // post-merge traffic
    await repo.undoMerge(mergeId, 'admin', SOURCE_A);

    const rows = await testDb.db.select().from(schema.telemetrySqlite);
    const byValue = new Map(rows.map(r => [r.value, r.nodeNum]));
    expect(byValue.get(1)).toBe(OLD_NUM);
    expect(byValue.get(2)).toBe(OLD_NUM);
    expect(byValue.get(3)).toBe(NEW_NUM);
    expect(byValue.get(4)).toBe(NEW_NUM);
  });

  it('reverts correctly when the moved side is the smaller one', async () => {
    // Forces `capture: 'moved'`: the survivor has more history than the
    // predecessor, which is the reverse of the usual 2.8 shape.
    for (let i = 0; i < 5; i++) await insertTelemetry(NEW_NUM, SOURCE_A, 100 + i);
    await insertTelemetry(OLD_NUM, SOURCE_A, 1);

    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });
    await repo.undoMerge(mergeId, 'admin', SOURCE_A);

    const rows = await testDb.db.select().from(schema.telemetrySqlite);
    expect(rows.filter(r => r.nodeNum === OLD_NUM).map(r => r.value)).toEqual([1]);
    expect(rows.filter(r => r.nodeNum === NEW_NUM)).toHaveLength(5);
  });

  it('marks the merge undone and refuses a second undo', async () => {
    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });
    await repo.undoMerge(mergeId, 'admin', SOURCE_A);

    const [record] = await repo.listMerges(SOURCE_A);
    expect(record.undoneAt).toBeGreaterThan(0);
    expect(record.undoneBy).toBe('admin');

    await expect(repo.undoMerge(mergeId, 'admin', SOURCE_A)).rejects.toMatchObject({ code: 'ALREADY_UNDONE' });
  });

  it('refuses an undo from a different source', async () => {
    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });
    await expect(repo.undoMerge(mergeId, 'admin', SOURCE_B)).rejects.toMatchObject({ code: 'WRONG_SOURCE' });
    // …and refusing means refusing: nothing was written first.
    const [record] = await repo.listMerges(SOURCE_A);
    expect(record.undoneAt).toBeNull();
  });

  it('refuses when the retired node has reappeared', async () => {
    const { mergeId } = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });
    // The old identity is heard again — restoring the snapshot would collide
    // with a live row, so the undo stops instead of overwriting it.
    await insertNode(OLD_NUM, SOURCE_A, { longName: 'Someone else' });

    await expect(repo.undoMerge(mergeId, 'admin', SOURCE_A)).rejects.toMatchObject({ code: 'NODE_REAPPEARED' });
  });

  it('refuses to undo out of order', async () => {
    const third = 0x99887766;
    await insertNode(third, SOURCE_A);
    const first = await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, basis: 'publicKey', mergedBy: 'admin',
    });
    await repo.executeMerge({
      sourceId: SOURCE_A, fromNodeNum: NEW_NUM, toNodeNum: third, basis: 'manual', mergedBy: 'admin',
    });

    await expect(repo.undoMerge(first.mergeId, 'admin', SOURCE_A)).rejects.toMatchObject({
      code: 'LATER_MERGE_PENDING',
    });
  });

  it('refuses an unknown merge id', async () => {
    await expect(repo.undoMerge('nope', 'admin', SOURCE_A)).rejects.toMatchObject({ code: 'MERGE_NOT_FOUND' });
  });
});
