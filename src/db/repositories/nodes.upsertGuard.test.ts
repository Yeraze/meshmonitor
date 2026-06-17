import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';
import { NodesRepository } from './nodes.js';

// Regression for #3505 (durable form of the #3456 fix): the node upsert merge
// guard must not clobber a learned name / macaddr / hwModel when a later
// (e.g. position/telemetry) refresh reports blanks — while still writing
// genuine zeros for numeric columns where 0 is a real value.
describe('NodesRepository.upsertNodeSqlite — blank/zero clobber guard (#3505)', () => {
  let t: TestDb;
  let repo: NodesRepository;
  const NUM = 0xaabbccdd;
  const ID = '!aabbccdd';

  beforeEach(() => {
    t = createTestDb();
    repo = new NodesRepository(t.db, 'sqlite');
  });
  afterEach(() => t.close());

  it('preserves a learned longName / shortName / macaddr / hwModel when re-upserted with blanks', () => {
    repo.upsertNodeSqlite({
      nodeNum: NUM, nodeId: ID, sourceId: 'default',
      longName: 'Repeater North', shortName: 'RPTN', macaddr: 'aabbccddeeff', hwModel: 9,
    } as never);
    // A bare refresh reporting empty names + hwModel 0 (UNSET) must NOT wipe them.
    repo.upsertNodeSqlite({
      nodeNum: NUM, nodeId: ID, sourceId: 'default',
      longName: '', shortName: '', macaddr: '', hwModel: 0,
    } as never);

    const row = repo.getNodeSqlite(NUM, 'default')!;
    expect(row.longName).toBe('Repeater North');
    expect(row.shortName).toBe('RPTN');
    expect(row.macaddr).toBe('aabbccddeeff');
    expect(row.hwModel).toBe(9);
  });

  it('still writes a genuine numeric 0 (snr / batteryLevel) — 0 is a legitimate value', () => {
    repo.upsertNodeSqlite({
      nodeNum: NUM, nodeId: ID, sourceId: 'default', longName: 'N', snr: 5, batteryLevel: 80,
    } as never);
    repo.upsertNodeSqlite({
      nodeNum: NUM, nodeId: ID, sourceId: 'default', snr: 0, batteryLevel: 0,
    } as never);

    const row = repo.getNodeSqlite(NUM, 'default')!;
    expect(row.snr).toBe(0);
    expect(row.batteryLevel).toBe(0);
    expect(row.longName).toBe('N'); // not provided in the 2nd upsert → preserved
  });
});
