import { describe, it, expect } from 'vitest';
import { isLiveNodeDiscovery, meshCoreTriggerChanges } from './nodeDiscovery.js';

describe('isLiveNodeDiscovery (#5534)', () => {
  const nowMs = 1_800_000_000_000;
  const nowSec = nowMs / 1000;
  const base = { existsOnSource: false, fromNum: 0x1234, localNodeNum: 0x9999, rxTimeSec: nowSec - 5, nowMs };

  it('is a discovery for a live packet from a node with no row on this source', () => {
    expect(isLiveNodeDiscovery(base)).toBe(true);
  });

  it('is a discovery when the packet carries no rx_time', () => {
    expect(isLiveNodeDiscovery({ ...base, rxTimeSec: undefined })).toBe(true);
  });

  it('is not a discovery when the node already has a row on this source', () => {
    expect(isLiveNodeDiscovery({ ...base, existsOnSource: true })).toBe(false);
  });

  it('is not a discovery for a firmware 2.8 NodeDB replay (old rx_time)', () => {
    expect(isLiveNodeDiscovery({ ...base, rxTimeSec: nowSec - 30 * 60 })).toBe(false);
  });

  it('is not a discovery for our own node or node 0', () => {
    expect(isLiveNodeDiscovery({ ...base, fromNum: 0x9999 })).toBe(false);
    expect(isLiveNodeDiscovery({ ...base, fromNum: 0 })).toBe(false);
  });
});

describe('meshCoreTriggerChanges (#5534)', () => {
  const known = {
    advName: 'Hill', latitude: 1, longitude: 2, advType: 2, outPath: 'aa,bb', pathLen: 2,
  };

  it('returns [] for a re-advert that changes nothing', () => {
    expect(meshCoreTriggerChanges(known, { ...known })).toEqual([]);
  });

  it('ignores fields the update did not report', () => {
    expect(meshCoreTriggerChanges(known, { advName: 'Hill' })).toEqual([]);
  });

  it('lists name, position, type and path changes', () => {
    expect(meshCoreTriggerChanges(known, {
      advName: 'Ridge', latitude: 1.5, longitude: 2, advType: 3, outPath: null, pathLen: null,
    })).toEqual(['name', 'latitude', 'advType', 'outPath', 'pathLen']);
  });

  it('treats undefined and null path as the same "unknown route"', () => {
    expect(meshCoreTriggerChanges({ advName: 'X' }, { advName: 'X', outPath: null, pathLen: null })).toEqual([]);
  });

  it('returns [] with no prior snapshot', () => {
    expect(meshCoreTriggerChanges(undefined, known)).toEqual([]);
  });
});
