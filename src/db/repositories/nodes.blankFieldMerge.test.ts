/**
 * #5231 — `upsertNode` must not let an uninformative incoming value overwrite
 * a learned one.
 *
 * The reported symptom was a NodeInfo Enrichment count that never reached
 * zero: a user copies a public key onto an MQTT source's row, the report says
 * "No nodes need enrichment", and the same row is fillable again on the next
 * refresh. The merge for `publicKey` used `??`, which preserves only
 * null/undefined — so an empty-string key (what an unset protobuf `bytes`
 * field decodes to) sailed through and wiped the copy. `macaddr` had the same
 * shape of hole for the deprecated all-zero MAC.
 *
 * The merge logic is plain TypeScript, identical on all three backends, so
 * this runs on SQLite only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodesRepository } from './nodes.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const NODE_NUM = 0x9e80e848;
const NODE_ID = '!9e80e848';
const SOURCE = 'mqtt-1';
const REAL_KEY = 'ebRjBiASEf/mQjHkDm0p1UKPPCH0Z4qLZbIRtWOQrXY=';
const REAL_MAC = 'c4d266f1c31d';

describe('NodesRepository.upsertNode — uninformative values never clobber (#5231)', () => {
  let testDb: TestDb;
  let repo: NodesRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new NodesRepository(testDb.db, 'sqlite');
    // The enriched row: a public key and a MAC copied in from another source.
    await repo.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'SKYC', shortName: 'SKYC',
        publicKey: REAL_KEY, macaddr: REAL_MAC },
      SOURCE,
    );
  });

  afterEach(() => testDb.close());

  it('preserves a stored public key when a later packet carries an empty one', async () => {
    await repo.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'SKYC', publicKey: '' },
      SOURCE,
    );
    const node = await repo.getNode(NODE_NUM, SOURCE);
    expect(node?.publicKey).toBe(REAL_KEY);
  });

  it('preserves a stored public key when a later packet carries none at all', async () => {
    await repo.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'SKYC' }, SOURCE);
    const node = await repo.getNode(NODE_NUM, SOURCE);
    expect(node?.publicKey).toBe(REAL_KEY);
  });

  it('still accepts a genuine key change', async () => {
    const rotated = 'xelVqM80mckmDCr8ZmS1kVp0aZ5nC9TAkQbT9NOeQ3E=';
    await repo.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, publicKey: rotated }, SOURCE);
    const node = await repo.getNode(NODE_NUM, SOURCE);
    expect(node?.publicKey).toBe(rotated);
  });

  it('preserves a stored MAC against the deprecated all-zero MAC', async () => {
    await repo.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, macaddr: '000000000000' },
      SOURCE,
    );
    const node = await repo.getNode(NODE_NUM, SOURCE);
    expect(node?.macaddr).toBe(REAL_MAC);
  });

  it('still accepts a genuine MAC change', async () => {
    await repo.upsertNode({ nodeNum: NODE_NUM, nodeId: NODE_ID, macaddr: 'aabbccddeeff' }, SOURCE);
    const node = await repo.getNode(NODE_NUM, SOURCE);
    expect(node?.macaddr).toBe('aabbccddeeff');
  });

  it('stores an all-zero MAC as null on a first-seen insert', async () => {
    const other = 0x433b3de0;
    await repo.upsertNode(
      { nodeNum: other, nodeId: '!433b3de0', longName: 'SKYB', macaddr: '000000000000', publicKey: '' },
      SOURCE,
    );
    const node = await repo.getNode(other, SOURCE);
    expect(node?.macaddr).toBeNull();
    expect(node?.publicKey).toBeNull();
  });
});
