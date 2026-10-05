/**
 * Auto-traceroute picker (`NodesRepository.getEligibleNodesForTraceroute`):
 * the AIRTIME proof for counting a completed run in either stored form.
 *
 * The picker decides which nodes the scheduler may send a traceroute to. It
 * used to call a node "traced" only when a row was stored with OUR radio in
 * `fromNodeNum`. A run to that node asked from a phone app or a Virtual Node
 * client, or one whose pending row had timed out, is stored the other way
 * round (`src/utils/tracerouteOrientation.ts`), so the node stayed on the
 * 3-hour retry and was traced up to eight times as often as the 24-hour
 * expiry interval asks for.
 *
 * The fix may only ever REMOVE nodes from the picker's answer. This suite
 * builds one node for every (row shape x time since our last request) cell,
 * runs the picker as it was BEFORE (the old query, verbatim, below) and as it
 * is now against the same database, and asserts:
 *
 *   1. after is a subset of before: no node becomes eligible that was not;
 *   2. the nodes that changed are exactly the ones expected, and each moved
 *      from "eligible now" to "not yet eligible".
 *
 * On SQLite, PostgreSQL and MySQL. Node numbers above 2^31 prove the BIGINT
 * comparison on the last two.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { NodesRepository } from './nodes.js';
import type { DbNode } from '../types.js';
import {
  type TestBackend, createPostgresBackend, createMysqlBackend, postgresAvailable, mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { isStoredRequesterFirst } from '../../utils/tracerouteOrientation.js';
import { hasRouteData } from '../../utils/tracerouteSegments.js';

// ---------------------------------------------------------------------------
// BEFORE: the picker's query as it stood on main, copied verbatim (only
// `this.normalizeNode` is swapped for a local, since that method is private).
// ---------------------------------------------------------------------------
const normalize = (node: DbNode): DbNode => ({
  ...node,
  nodeNum: Number(node.nodeNum),
  lastHeard: node.lastHeard != null ? Number(node.lastHeard) : null,
  lastTracerouteRequest: node.lastTracerouteRequest != null ? Number(node.lastTracerouteRequest) : null,
});

class PickerBefore extends NodesRepository {
  async eligibleBefore(
    localNodeNum: number,
    activeNodeCutoffSeconds: number,
    threeHoursAgoMs: number,
    expirationMsAgo: number,
    sourceId?: string
  ): Promise<DbNode[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const sourceFilter = sourceId ? sql` AND n.sourceId = ${sourceId}` : sql``;
      // SQLite uses raw SQL for the complex subquery
      const results = await db.all<DbNode>(sql`
        SELECT n.*
        FROM nodes n
        WHERE n.nodeNum != ${localNodeNum}
          AND n.lastHeard > ${activeNodeCutoffSeconds}
          ${sourceFilter}
          AND (
            -- Category 1: No traceroute exists, and (never requested OR requested > 3 hours ago)
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) = 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${threeHoursAgoMs})
            )
            OR
            -- Category 2: Traceroute exists, and (never requested OR requested > expiration hours ago)
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) > 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${expirationMsAgo})
            )
          )
        ORDER BY n.lastHeard DESC
      `);
      return results.map(r => normalize(r));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const sourceFilter = sourceId ? sql` AND n.sourceId = ${sourceId}` : sql``;
      const results = await db.execute(sql`
        SELECT n.*
        FROM nodes n
        WHERE n.nodeNum != ${localNodeNum}
          AND n.lastHeard > ${activeNodeCutoffSeconds}
          ${sourceFilter}
          AND (
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) = 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${threeHoursAgoMs})
            )
            OR
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) > 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${expirationMsAgo})
            )
          )
        ORDER BY n.lastHeard DESC
      `);
      // MySQL returns [rows, fields] tuple
      const rows = (results as unknown as [unknown[], unknown])[0] as DbNode[];
      return rows.map(r => normalize(r));
    } else {
      // PostgreSQL
      const db = this.getPostgresDb();
      const nodeNum = this.col('nodeNum');
      const lastHeard = this.col('lastHeard');
      const fromNodeNum = this.col('fromNodeNum');
      const toNodeNum = this.col('toNodeNum');
      const lastTracerouteRequest = this.col('lastTracerouteRequest');
      const sourceFilter = sourceId ? sql` AND n."sourceId" = ${sourceId}` : sql``;
      const results = await db.execute(sql`
        SELECT n.*
        FROM nodes n
        WHERE n.${nodeNum} != ${localNodeNum}
          AND n.${lastHeard} > ${activeNodeCutoffSeconds}
          ${sourceFilter}
          AND (
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.${fromNodeNum} = ${localNodeNum} AND t.${toNodeNum} = n.${nodeNum}) = 0
              AND (n.${lastTracerouteRequest} IS NULL OR n.${lastTracerouteRequest} < ${threeHoursAgoMs})
            )
            OR
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.${fromNodeNum} = ${localNodeNum} AND t.${toNodeNum} = n.${nodeNum}) > 0
              AND (n.${lastTracerouteRequest} IS NULL OR n.${lastTracerouteRequest} < ${expirationMsAgo})
            )
          )
        ORDER BY n.${lastHeard} DESC
      `);
      // PostgreSQL returns { rows: [...] }
      const rows = (results as unknown as { rows: unknown[] }).rows as DbNode[];
      return rows.map(r => normalize(r));
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const SRC = 'src-radio';
const OTHER_SRC = 'src-mqtt';
const LOCAL = 3639506708; // our radio on SRC; above 2^31
const THIRD = 2732916556; // some other node, also above 2^31
const HOUR = 3_600_000;
const NOW = Date.now();

const FULL = { route: '[111]', routeBack: '[222]', snrTowards: '[4,8]', snrBack: '[12,16]' };
const NO_RETURN = { route: '[]', routeBack: '[]', snrTowards: '[]', snrBack: '[]' };
const NONE = { route: null, routeBack: null, snrTowards: null, snrBack: null };

interface Row {
  from: 'local' | 'node' | 'third';
  to: 'local' | 'node' | 'third';
  sourceId: string;
  route: string | null; routeBack: string | null; snrTowards: string | null; snrBack: string | null;
}

/**
 * Every way a node's traceroute history can look. `countsBefore` is whether
 * the old rule called the node traced; `countsNow` is whether the new rule
 * does. A shape may only go false -> true.
 */
const SHAPES: Record<string, { rows: Row[]; countsBefore: boolean; countsNow: boolean; what: string }> = {
  sentCompleted: {
    what: 'sent from MeshMonitor, answered: { from: us, to: node }, both legs',
    rows: [{ from: 'local', to: 'node', sourceId: SRC, ...FULL }],
    countsBefore: true, countsNow: true,
  },
  phoneCompleted: {
    what: 'sent from a phone app / Virtual Node, answered: { from: node, to: us }',
    rows: [{ from: 'node', to: 'local', sourceId: SRC, ...FULL }],
    countsBefore: false, countsNow: true,
  },
  phoneCompletedDirect: {
    what: 'the same with no hops at all (route "[]" is still route data)',
    rows: [{ from: 'node', to: 'local', sourceId: SRC, ...NO_RETURN, snrTowards: '[20]' }],
    countsBefore: false, countsNow: true,
  },
  lateReply: {
    what: 'pending row timed out, then the reply came: one row of each form',
    rows: [
      { from: 'local', to: 'node', sourceId: SRC, ...NONE },
      { from: 'node', to: 'local', sourceId: SRC, ...FULL },
    ],
    countsBefore: true, countsNow: true,
  },
  pendingOnly: {
    what: 'our request, never answered: { from: us, to: node }, route NULL',
    rows: [{ from: 'local', to: 'node', sourceId: SRC, ...NONE }],
    countsBefore: true, countsNow: true, // rule A, kept as it was
  },
  ourReplyOnly: {
    what: 'the node traced US; our outgoing reply: { from: us, to: node }, no return leg',
    rows: [{ from: 'local', to: 'node', sourceId: SRC, ...NO_RETURN }],
    countsBefore: true, countsNow: true, // rule A, kept as it was
  },
  noRows: {
    what: 'never traced, or the request failed and its row has been pruned',
    rows: [],
    countsBefore: false, countsNow: false,
  },
  mqttOtherSource: {
    what: 'the answered run heard by ANOTHER source (MQTT) only',
    rows: [{ from: 'node', to: 'local', sourceId: OTHER_SRC, ...FULL }],
    countsBefore: false, countsNow: false,
  },
  replyFormNoRoute: {
    what: '{ from: node, to: us } with no route data (NULL, "null" and "")',
    rows: [
      { from: 'node', to: 'local', sourceId: SRC, ...NONE },
      { from: 'node', to: 'local', sourceId: SRC, ...NONE, route: 'null' },
      { from: 'node', to: 'local', sourceId: SRC, ...NONE, route: '' },
    ],
    countsBefore: false, countsNow: false,
  },
  thirdParty: {
    what: 'the node answered SOMEONE ELSE: { from: node, to: third }',
    rows: [
      { from: 'node', to: 'third', sourceId: SRC, ...FULL },
      { from: 'third', to: 'node', sourceId: SRC, ...FULL },
    ],
    countsBefore: false, countsNow: false,
  },
};

/** Time since WE last sent this node a request. `null` = never. */
const AGES: Record<string, number | null> = { never: null, '1h': 1, '4h': 4, '30h': 30, '200h': 200 };

const shapeNames = Object.keys(SHAPES);
const ageNames = Object.keys(AGES);
// One node per cell. Half sit above 2^31.
const nodeNumFor = (shape: string, age: string): number =>
  (shapeNames.indexOf(shape) % 2 === 0 ? 0x90000000 : 0x10000000)
  + shapeNames.indexOf(shape) * 0x100 + ageNames.indexOf(age);
const cellOf = new Map<number, string>();
for (const s of shapeNames) for (const a of ageNames) cellOf.set(nodeNumFor(s, a), `${s}@${a}`);

const idOf = (n: number) => `!${n.toString(16).padStart(8, '0')}`;
const lit = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`);

async function seed(backend: TestBackend): Promise<void> {
  const q = (c: string) => (backend.dbType === 'postgres' ? `"${c}"` : c);
  const heard = Math.floor(NOW / 1000) - 60;
  const nodeRows: string[] = [];
  const trRows: string[] = [];
  const addNode = (num: number, sourceId: string, lastRequest: number | null) =>
    nodeRows.push(`(${[num, idOf(num), heard, lastRequest, sourceId, NOW, NOW].map(lit).join(', ')})`);

  addNode(LOCAL, SRC, null);
  addNode(THIRD, SRC, null);
  for (const shape of shapeNames) {
    for (const age of ageNames) {
      const num = nodeNumFor(shape, age);
      const hours = AGES[age];
      addNode(num, SRC, hours === null ? null : NOW - hours * HOUR);
      // The same node is also known to the MQTT source, as it would be.
      addNode(num, OTHER_SRC, null);
      const who = { local: LOCAL, node: num, third: THIRD };
      for (const r of SHAPES[shape].rows) {
        trRows.push(`(${[
          who[r.from], who[r.to], idOf(who[r.from]), idOf(who[r.to]),
          r.route, r.routeBack, r.snrTowards, r.snrBack, NOW - HOUR, NOW - HOUR, r.sourceId,
        ].map(lit).join(', ')})`);
      }
    }
  }
  await backend.exec(
    `INSERT INTO nodes (${['nodeNum', 'nodeId', 'lastHeard', 'lastTracerouteRequest', 'sourceId', 'createdAt', 'updatedAt'].map(q).join(', ')}) VALUES ${nodeRows.join(', ')}`,
  );
  await backend.exec(
    `INSERT INTO traceroutes (${['fromNodeNum', 'toNodeNum', 'fromNodeId', 'toNodeId', 'route', 'routeBack', 'snrTowards', 'snrBack', 'timestamp', 'createdAt', 'sourceId'].map(q).join(', ')}) VALUES ${trRows.join(', ')}`,
  );
}

// PostgreSQL/MySQL: only the columns the picker and the seed touch. The picker
// is `SELECT n.*` in raw SQL, so a narrow table is enough (SQLite below gets
// the real schema from the migration registry).
const POSTGRES_CREATE = `
  CREATE TABLE nodes (
    "nodeNum" BIGINT NOT NULL, "nodeId" TEXT NOT NULL, "lastHeard" BIGINT,
    "lastTracerouteRequest" BIGINT, "sourceId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL,
    PRIMARY KEY ("nodeNum", "sourceId")
  );
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY, "fromNodeNum" BIGINT NOT NULL, "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL, "toNodeId" TEXT NOT NULL, route TEXT, "routeBack" TEXT,
    "snrTowards" TEXT, "snrBack" TEXT, timestamp BIGINT NOT NULL, "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );
`;
const MYSQL_CREATE = `
  CREATE TABLE nodes (
    nodeNum BIGINT NOT NULL, nodeId VARCHAR(32) NOT NULL, lastHeard BIGINT,
    lastTracerouteRequest BIGINT, sourceId VARCHAR(36) NOT NULL,
    createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL,
    PRIMARY KEY (nodeNum, sourceId)
  );
  CREATE TABLE traceroutes (
    id INT AUTO_INCREMENT PRIMARY KEY, fromNodeNum BIGINT NOT NULL, toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL, toNodeId VARCHAR(32) NOT NULL, route TEXT, routeBack TEXT,
    snrTowards TEXT, snrBack TEXT, timestamp BIGINT NOT NULL, createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36)
  )
`;

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
function runPickerTests(getBackend: () => TestBackend) {
  const activeCutoff = Math.floor(NOW / 1000) - 24 * 3600;

  /** Cells the picker returns, before and after, for one expiry setting. */
  const pick = async (expirationHours: number, scope: string | 'unscoped' = SRC) => {
    const sourceId = scope === 'unscoped' ? undefined : scope;
    const backend = getBackend();
    const repo = new PickerBefore(backend.drizzleDb, backend.dbType);
    const args = [LOCAL, activeCutoff, NOW - 3 * HOUR, NOW - expirationHours * HOUR, sourceId] as const;
    const cells = (nodes: DbNode[]) =>
      nodes.map((n) => cellOf.get(Number(n.nodeNum))).filter((c): c is string => !!c).sort();
    return {
      before: cells(await repo.eligibleBefore(...args)),
      after: cells(await repo.getEligibleNodesForTraceroute(...args)),
    };
  };

  /** What the rule says a cell should be, from the shape table alone. */
  const expected = (expirationHours: number, which: 'countsBefore' | 'countsNow'): string[] => {
    const out: string[] = [];
    for (const shape of shapeNames) {
      for (const age of ageNames) {
        const hours = AGES[age];
        const traced = SHAPES[shape][which];
        // A reply-form run (rule B) never shortens a wait: when the expiry is
        // under 3 h the node keeps the 3-hour retry it had.
        const viaB = which === 'countsNow' && traced && !SHAPES[shape].countsBefore;
        const wait = !traced ? 3 : viaB ? Math.max(3, expirationHours) : expirationHours;
        if (hours === null || hours > wait) out.push(`${shape}@${age}`);
      }
    }
    return out.sort();
  };

  it('the fixture shapes agree with the orientation helper about what a completed run to the node is', () => {
    // Rule B in SQL must be the helper's definition: a row with route data
    // that is NOT stored requester-first, whose `to` is our radio.
    for (const [name, shape] of Object.entries(SHAPES)) {
      const NODE = 42;
      const who = { local: LOCAL, node: NODE, third: THIRD };
      const viaB = shape.rows.some((r) => {
        const row = { fromNodeNum: who[r.from], toNodeNum: who[r.to], route: r.route, routeBack: r.routeBack, snrBack: r.snrBack };
        return r.sourceId === SRC
          && hasRouteData(r.route)
          && !isStoredRequesterFirst(row, LOCAL)
          && row.toNodeNum === LOCAL && row.fromNodeNum === NODE;
      });
      const viaA = shape.rows.some((r) => r.from === 'local' && r.to === 'node');
      expect({ name, countsBefore: viaA, countsNow: viaA || viaB })
        .toEqual({ name, countsBefore: shape.countsBefore, countsNow: shape.countsNow });
    }
  });

  describe.each([24, 168, 3, 2, 0])('expiry interval %i h', (expirationHours) => {
    it('BEFORE matches the old rule and AFTER matches the new one, cell by cell', async () => {
      const { before, after } = await pick(expirationHours);
      expect(before).toEqual(expected(expirationHours, 'countsBefore'));
      expect(after).toEqual(expected(expirationHours, 'countsNow'));
    });

    it('never makes a node eligible that was not eligible before', async () => {
      const { before, after } = await pick(expirationHours);
      const added = after.filter((c) => !before.includes(c));
      expect(added).toEqual([]);
    });
  });

  it('default 24 h expiry: exactly the phone-app runs last requested 4 h ago stop being eligible', async () => {
    const { before, after } = await pick(24);
    const removed = before.filter((c) => !after.includes(c));
    // 1h: inside both waits, never eligible. 30h/200h: past both, still
    // eligible. never: we have not sent one, still eligible.
    expect(removed).toEqual(['phoneCompleted@4h', 'phoneCompletedDirect@4h']);
  });

  it('168 h expiry: the phone-app runs requested 4 h and 30 h ago stop being eligible', async () => {
    const { before, after } = await pick(168);
    expect(before.filter((c) => !after.includes(c))).toEqual([
      'phoneCompleted@30h', 'phoneCompleted@4h', 'phoneCompletedDirect@30h', 'phoneCompletedDirect@4h',
    ]);
  });

  it.each([3, 2, 0])('expiry %i h (not above the 3 h retry): nothing changes', async (expirationHours) => {
    const { before, after } = await pick(expirationHours);
    expect(after).toEqual(before);
  });

  it('a run heard only by another source does not count for this one', async () => {
    const { after } = await pick(24);
    expect(after).toContain('mqttOtherSource@4h');
    // ...while the same run on THIS source does.
    expect(after).not.toContain('phoneCompleted@4h');
  });

  it('pending-only and our-own-reply nodes are exactly where the old rule had them', async () => {
    const { before, after } = await pick(24);
    const only = (cells: string[]) => cells.filter((c) => /^(pendingOnly|ourReplyOnly)@/.test(c));
    expect(only(after)).toEqual(only(before));
    expect(only(after)).toEqual([
      'ourReplyOnly@200h', 'ourReplyOnly@30h', 'ourReplyOnly@never',
      'pendingOnly@200h', 'pendingOnly@30h', 'pendingOnly@never',
    ]);
  });

  it('with no source given, rule B is off and the answer is the old one', async () => {
    const { before, after } = await pick(24, 'unscoped');
    expect(after).toEqual(before);
    // Unscoped, the MQTT source's copy of every node is a candidate too, and
    // the phone-app run that rule B would have held back is still eligible.
    expect(after.filter((c) => c === 'phoneCompleted@4h')).toHaveLength(2);
  });

  it('never returns our own radio, and returns each node once', async () => {
    const backend = getBackend();
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const nodes = await repo.getEligibleNodesForTraceroute(LOCAL, activeCutoff, NOW - 3 * HOUR, NOW - 24 * HOUR, SRC);
    const nums = nodes.map((n) => n.nodeNum);
    expect(nums).not.toContain(LOCAL);
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums.every((n) => typeof n === 'number')).toBe(true);
  });
}

describe('auto-traceroute picker, before/after - SQLite', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (statement: string) => { t.sqlite.exec(statement); },
      close: async () => { t.close(); },
      available: true,
    };
    await seed(backend);
  });
  afterAll(async () => { await backend.close(); });
  runPickerTests(() => backend);
});

describe.skipIf(!postgresAvailable)('auto-traceroute picker, before/after - PostgreSQL', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'tr_picker');
    await seed(backend);
  });
  afterAll(async () => { await backend?.close(); });
  runPickerTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('auto-traceroute picker, before/after - MySQL', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'tr_picker');
    await seed(backend);
  });
  afterAll(async () => { await backend?.close(); });
  runPickerTests(() => backend);
});

