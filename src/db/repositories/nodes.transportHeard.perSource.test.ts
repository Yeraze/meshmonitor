/**
 * `#5101` P3 — `NodesRepository.countNodesHeardByTransport` per-source isolation.
 *
 * The transport-traffic writer (WP3) queries this once per source, per bin.
 * A leak here would double-count nodes across sources that happen to share a
 * `nodeNum` (routine on a mesh with multiple gateways), inflating the "nodes
 * heard" chart for every source at once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodesRepository } from './nodes.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';

const BIN_START_SEC = 1_760_000_000;
const BIN_END_SEC = BIN_START_SEC + 300;
const HEARD_SEC = BIN_START_SEC + 100;

function makeNode(nodeNum: number, overrides: Record<string, unknown> = {}) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    ...overrides,
  };
}

/**
 * `upsertNode`'s INSERT branch does not carry `transportLast*` fields — those
 * are only ever set on the UPDATE branch, matching production: a node's row
 * is created from NodeInfo (no transport stamp yet) and the stamp is applied
 * by a later, separate per-packet write. Mirror that here: insert bare, then
 * a second upsert (now an UPDATE, since the row exists) applies the stamps.
 */
async function seedNode(
  repo: NodesRepository,
  sourceId: string,
  nodeNum: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await repo.upsertNode(makeNode(nodeNum), sourceId);
  if (Object.keys(overrides).length > 0) {
    await repo.upsertNode(makeNode(nodeNum, overrides), sourceId);
  }
}

describe('NodesRepository.countNodesHeardByTransport - per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: NodesRepository;

  function setup() {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new NodesRepository(drizzleDb as any, 'sqlite');
  }

  afterEach(() => {
    if (db) db.close();
  });

  it('never counts source B\'s nodes toward source A\'s window', async () => {
    setup();
    // Same nodeNum on both sources, both heard inside the window.
    await seedNode(repo, SOURCE_A, 100, { transportLastRf: HEARD_SEC });
    await seedNode(repo, SOURCE_B, 100, { transportLastMqtt: HEARD_SEC });

    const a = await repo.countNodesHeardByTransport(SOURCE_A, BIN_START_SEC, BIN_END_SEC);
    const b = await repo.countNodesHeardByTransport(SOURCE_B, BIN_START_SEC, BIN_END_SEC);

    expect(a).toEqual({ rf: 1, udp: 0, mqtt: 0 });
    expect(b).toEqual({ rf: 0, udp: 0, mqtt: 1 });
  });

  it('a node that exists only on source B contributes nothing to source A', async () => {
    setup();
    await seedNode(repo, SOURCE_B, 200, { transportLastUdp: HEARD_SEC });

    const a = await repo.countNodesHeardByTransport(SOURCE_A, BIN_START_SEC, BIN_END_SEC);
    expect(a).toEqual({ rf: 0, udp: 0, mqtt: 0 });
  });

  it('excludeNodeNum only excludes that node on the scoped source, not the other source\'s node with the same num', async () => {
    setup();
    await seedNode(repo, SOURCE_A, 300, { transportLastRf: HEARD_SEC });
    await seedNode(repo, SOURCE_B, 300, { transportLastRf: HEARD_SEC });
    // Also add a second, non-excluded node on B so B's count isn't trivially zero either way.
    await seedNode(repo, SOURCE_B, 301, { transportLastRf: HEARD_SEC });

    const a = await repo.countNodesHeardByTransport(SOURCE_A, BIN_START_SEC, BIN_END_SEC, 300);
    const b = await repo.countNodesHeardByTransport(SOURCE_B, BIN_START_SEC, BIN_END_SEC, 999);

    expect(a).toEqual({ rf: 0, udp: 0, mqtt: 0 });
    expect(b).toEqual({ rf: 2, udp: 0, mqtt: 0 });
  });
});
