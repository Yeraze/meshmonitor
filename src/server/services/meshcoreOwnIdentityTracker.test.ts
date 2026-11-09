import { describe, it, expect } from 'vitest';
import { MeshCoreOwnIdentityTracker, type OwnIdentitySettingsStore } from './meshcoreOwnIdentityTracker.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function makeStore() {
  const data = new Map<string, string>();
  const store: OwnIdentitySettingsStore = {
    getSettingForSource: async (s, k) => data.get(`${s}:${k}`) ?? null,
    setSourceSetting: async (s, k, v) => void data.set(`${s}:${k}`, v),
  };
  return { data, store };
}

describe('MeshCoreOwnIdentityTracker', () => {
  it('first key is a silent baseline; the same key is a no-op', async () => {
    const { store } = makeStore();
    const t = new MeshCoreOwnIdentityTracker(() => store);
    expect(await t.observe('s1', A)).toBe('baseline');
    expect(await t.observe('s1', A)).toBe('same');
    expect(await t.observe('s1', A.toUpperCase())).toBe('same');
    expect(await t.getChange('s1')).toBeNull();
    expect(await t.getCurrentKey('s1')).toBe(A);
  });

  it('ignores placeholders and bad keys without writing', async () => {
    const { store, data } = makeStore();
    const t = new MeshCoreOwnIdentityTracker(() => store);
    expect(await t.observe('s1', 'repeater')).toBe('same');
    expect(await t.observe('s1', null)).toBe('same');
    expect(data.size).toBe(0);
  });

  it('reports a change ONCE across repeated observes and a simulated restart', async () => {
    const { store } = makeStore();
    const t1 = new MeshCoreOwnIdentityTracker(() => store, () => 1234);
    await t1.observe('s1', A);
    expect(await t1.observe('s1', B)).toBe('changed');
    expect(await t1.observe('s1', B)).toBe('same');
    expect(await t1.getChange('s1')).toEqual({ previousKey: A, currentKey: B, detectedAt: 1234 });

    // New instance, same persisted store: a restart.
    const t2 = new MeshCoreOwnIdentityTracker(() => store);
    expect(await t2.observe('s1', B)).toBe('same');
    expect((await t2.getChange('s1'))?.currentKey).toBe(B);
  });

  it('overlapping observes report one change', async () => {
    const { store } = makeStore();
    const t = new MeshCoreOwnIdentityTracker(() => store);
    await t.observe('s1', A);
    const results = await Promise.all([t.observe('s1', B), t.observe('s1', B), t.observe('s1', B)]);
    expect(results.filter((r) => r === 'changed')).toHaveLength(1);
  });

  it('acknowledge clears the record and keeps the new baseline', async () => {
    const { store } = makeStore();
    const t = new MeshCoreOwnIdentityTracker(() => store);
    await t.observe('s1', A);
    await t.observe('s1', B);
    expect(await t.acknowledge('s1')).toBe(true);
    expect(await t.getChange('s1')).toBeNull();
    expect(await t.acknowledge('s1')).toBe(false);
    expect(await t.observe('s1', B)).toBe('same');
    expect(await t.observe('s1', A)).toBe('changed');
  });

  it('tracks sources independently', async () => {
    const { store } = makeStore();
    const t = new MeshCoreOwnIdentityTracker(() => store);
    await t.observe('s1', A);
    expect(await t.observe('s2', B)).toBe('baseline');
    expect(await t.observe('s1', B)).toBe('changed');
    expect(await t.getChange('s2')).toBeNull();
  });
});
