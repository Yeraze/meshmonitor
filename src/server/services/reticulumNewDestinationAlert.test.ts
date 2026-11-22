import { describe, it, expect, vi, beforeEach } from 'vitest';

const notify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const own = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock('../../services/database.js', () => ({
  default: { sources: { getSource: async (id: string) => ({ id, name: `Name ${id}` }) } },
}));
vi.mock('./notificationService.js', () => ({
  notificationService: { notifyNewReticulumDestination: notify },
}));
vi.mock('../utils/ownNodes.js', () => ({ isOwnReticulumAddress: own }));

import { NewNodeAlertGate, LEARN_MS, CAP_PER_HOUR } from './newNodeAlertGate.js';
import { NewNodeAlertTracker } from './newNodeAlertTracker.js';
import {
  isAlertableReticulumDestination,
  maybeAlertReticulumNewDestination,
} from './reticulumNewDestinationAlert.js';

let clock = 0;
const store = new Map<string, string>();
function makeTracker(earliest: number | null = 1): NewNodeAlertTracker {
  const gate = new NewNodeAlertGate({
    now: () => clock,
    getSourceSetting: async (s, k) => store.get(`${s}:${k}`) ?? null,
    setSourceSetting: async (s, k, v) => { store.set(`${s}:${k}`, v); },
    getEarliestNodeCreatedAt: async () => earliest,
  });
  return new NewNodeAlertTracker(gate);
}

const dest = (hash: string, over: Record<string, unknown> = {}) => ({
  destinationHash: hash,
  appName: 'lxmf' as string | null,
  aspects: 'delivery' as string | null,
  displayName: 'Alice' as string | null,
  hops: 2 as number | null,
  ...over,
});

describe('reticulumNewDestinationAlert', () => {
  beforeEach(() => {
    notify.mockClear();
    own.mockReset();
    own.mockReturnValue(false);
    store.clear();
    clock = LEARN_MS * 2; // armed: earliest row is at 1
  });

  it('alerts only for lxmf delivery destinations', () => {
    expect(isAlertableReticulumDestination({ appName: 'lxmf', aspects: 'delivery' })).toBe(true);
    expect(isAlertableReticulumDestination({ appName: 'lxmf', aspects: 'propagation' })).toBe(false);
    expect(isAlertableReticulumDestination({ appName: 'nomadnetwork', aspects: 'node' })).toBe(false);
    expect(isAlertableReticulumDestination({ appName: null, aspects: null })).toBe(false);
  });

  it('skips non-LXMF and own destinations', async () => {
    const t = makeTracker();
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa', { appName: 'nomadnetwork', aspects: 'node' }), true);
    own.mockReturnValue(true);
    await maybeAlertReticulumNewDestination(t, 's1', dest('bb'), true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('drops for good while learning', async () => {
    const t = makeTracker(clock); // first row is now: learning
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa'), true);
    expect(notify).not.toHaveBeenCalled();
    clock += LEARN_MS * 2;
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa'), true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('alerts when armed, with the sanitised name and hops', async () => {
    const t = makeTracker();
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa', { displayName: 'Bob\u0000junk' }), true);
    expect(notify).toHaveBeenCalledWith('aa', 'Bob', 2, 's1', 'Name s1', undefined);
  });

  it('uses the short hash for a nameless peer', async () => {
    const t = makeTracker();
    await maybeAlertReticulumNewDestination(t, 's1', dest('0123456789abcdef', { displayName: null }), true);
    expect(notify.mock.calls[0][1]).toBe('01234567…');
  });

  it('ignores inserted:false', async () => {
    const t = makeTracker();
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa'), false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a re-insert in the same process stays silent', async () => {
    const t = makeTracker();
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa'), true);
    await maybeAlertReticulumNewDestination(t, 's1', dest('aa'), true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('caps at the hourly limit and reports the overflow on the next alert', async () => {
    const t = makeTracker();
    for (let i = 0; i < CAP_PER_HOUR + 1; i++) {
      await maybeAlertReticulumNewDestination(t, 's1', dest(`h${i}`), true);
    }
    expect(notify).toHaveBeenCalledTimes(CAP_PER_HOUR);
    clock += 61 * 60_000;
    await maybeAlertReticulumNewDestination(t, 's1', dest('next'), true);
    expect(notify).toHaveBeenCalledTimes(CAP_PER_HOUR + 1);
    expect(notify.mock.calls[CAP_PER_HOUR][5]).toBe(1);
  });

  it('five concurrent copies take one slot', async () => {
    const t = makeTracker();
    await Promise.all(Array.from({ length: 5 }, () => maybeAlertReticulumNewDestination(t, 's1', dest('aa'), true)));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps cap and learn state per source (perSource)', async () => {
    const t1 = makeTracker();
    const t2 = makeTracker();
    for (let i = 0; i < CAP_PER_HOUR + 2; i++) {
      await maybeAlertReticulumNewDestination(t1, 's1', dest(`h${i}`), true);
    }
    notify.mockClear();
    await maybeAlertReticulumNewDestination(t2, 's2', dest('h0'), true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][3]).toBe('s2');
    expect(notify.mock.calls[0][5]).toBeUndefined();
  });

  it('never throws', async () => {
    const t = makeTracker();
    notify.mockRejectedValueOnce(new Error('boom'));
    await expect(maybeAlertReticulumNewDestination(t, 's1', dest('aa'), true)).resolves.toBeUndefined();
  });
});
