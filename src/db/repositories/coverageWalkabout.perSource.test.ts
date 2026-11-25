/** CoverageWalkaboutRepository: per-source isolation (#5891 P1). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoverageWalkaboutRepository, type NewWalkaboutReception } from './coverageWalkabout.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const NOW = 1_760_000_000_000;
const rx = (sessionId: string, sourceId: string): NewWalkaboutReception => ({
  sessionId, sourceId, protocol: 'meshtastic', creditedKey: '!aabbccdd', creditedNodeNum: 1,
  creditKind: 'direct', hopsAway: 0, packetKey: 'p1', snr: null, rssi: null, heardAt: NOW,
  sampleId: null, latitude: 1, longitude: 2, accuracyM: 5, sampleAgeMs: 0,
});

describe('CoverageWalkaboutRepository — per-source isolation', () => {
  let repo: CoverageWalkaboutRepository;
  let close: () => void;

  beforeEach(async () => {
    const t = createTestDb();
    close = () => t.sqlite.close();
    repo = new CoverageWalkaboutRepository(t.db, 'sqlite');
    await repo.createSession({ id: 'a1', sourceId: 'src-a', name: 'A', startedAt: NOW, startedBy: null });
    await repo.createSession({ id: 'b1', sourceId: 'src-b', name: 'B', startedAt: NOW, startedBy: null });
    await repo.recordReception(rx('a1', 'src-a'));
    await repo.recordReception(rx('b1', 'src-b'));
  });
  afterEach(() => close());

  it('reads never cross sources', async () => {
    expect(await repo.getSession('src-a', 'b1')).toBeNull();
    expect((await repo.getOpenSession('src-a'))?.id).toBe('a1');
    expect((await repo.listSessions('src-b')).map((s) => s.id)).toEqual(['b1']);
    expect(await repo.getCounts('src-a', 'b1')).toMatchObject({ receptions: 0 });
    expect(await repo.getLatestSample('src-a', 'b1')).toBeNull();
  });

  it('writes with the wrong source do nothing', async () => {
    expect(await repo.endSession('src-a', 'b1', NOW + 1, 'user')).toBe(false);
    expect(await repo.deleteSession('src-a', 'b1')).toBe(false);
    expect((await repo.getCounts('src-b', 'b1')).receptions).toBe(1);
    expect((await repo.getSession('src-b', 'b1'))?.endedAt).toBeNull();
  });

  it('deleteForSource removes only that source', async () => {
    await repo.deleteForSource('src-a');
    expect(await repo.getSession('src-a', 'a1')).toBeNull();
    expect((await repo.getCounts('src-b', 'b1')).receptions).toBe(1);
  });

  it('the boot loader sees every source', async () => {
    expect((await repo.getOpenSessionsAllSources()).map((s) => s.id).sort()).toEqual(['a1', 'b1']);
  });
});
