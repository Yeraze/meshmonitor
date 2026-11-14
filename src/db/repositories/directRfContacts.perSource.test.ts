/**
 * DirectRfContactsRepository — per-source isolation on SQLite (#6210). The
 * PG/MySQL twin is `directRfContacts.multiBackend.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DirectRfContactsRepository, directRfDayBucket, type DirectRfContactDelta } from './directRfContacts.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const D0 = directRfDayBucket(1_760_000_000_000);
const NODE = 0xdeadbeef; // > 2^31, exercises unsigned handling

function delta(sourceId: string, over: Partial<DirectRfContactDelta> = {}): DirectRfContactDelta {
  return {
    sourceId, protocol: 'meshtastic', nodeKey: '!deadbeef', nodeNum: NODE,
    dayBucket: D0, firstHeardAt: D0 + 1000, lastHeardAt: D0 + 2000, count: 1,
    bestSnr: 4, bestRssi: -80, snrSum: 4, snrCount: 1, rssiSum: -80, rssiCount: 1,
    ...over,
  };
}

describe('DirectRfContactsRepository — per-source isolation', () => {
  let t: TestDb;
  let repo: DirectRfContactsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new DirectRfContactsRepository(t.db, 'sqlite');
  });
  afterEach(() => t.close());

  it('the same node heard by two sources keeps two independent rows', async () => {
    await repo.applyDelta(delta('src-a', { count: 2, bestSnr: 9 }));
    await repo.applyDelta(delta('src-b', { count: 5, bestSnr: -3 }));
    const win = { fromMs: D0, toMs: D0 + 86_400_000 };
    const [a] = await repo.getContacts({ sourceId: 'src-a', ...win });
    const [b] = await repo.getContacts({ sourceId: 'src-b', ...win });
    expect(a).toMatchObject({ nodeNum: NODE, receptionCount: 2, bestSnr: 9 });
    expect(b).toMatchObject({ nodeNum: NODE, receptionCount: 5, bestSnr: -3 });
  });

  it('a source with no rows sees nothing from another source', async () => {
    await repo.applyDelta(delta('src-a'));
    expect(await repo.getContacts({ sourceId: 'src-b', fromMs: D0, toMs: D0 + 86_400_000 })).toEqual([]);
    expect(await repo.getNodeDaily({ sourceId: 'src-b', nodeKey: '!deadbeef', fromMs: D0, toMs: D0 + 86_400_000 })).toEqual([]);
  });

  it('deleteForSource leaves the other source untouched', async () => {
    await repo.applyDelta(delta('src-a'));
    await repo.applyDelta(delta('src-b'));
    expect(await repo.deleteForSource('src-a')).toBe(1);
    expect(await repo.getContacts({ sourceId: 'src-b', fromMs: D0, toMs: D0 + 86_400_000 })).toHaveLength(1);
  });
});
