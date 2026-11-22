/**
 * The default gate reads the earliest row from all three source tables (#6341 P2), so a
 * Meshtastic MQTT source that already logged for weeks arms at once on upgrade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mc = vi.hoisted(() => vi.fn());
const mt = vi.hoisted(() => vi.fn());
const rt = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('../../services/database.js', () => ({
  default: {
    meshcore: { getEarliestNodeCreatedAt: mc },
    nodes: { getEarliestNodeCreatedAt: mt },
    reticulum: { getEarliestDestinationCreatedAt: rt },
    settings: {
      getSettingForSource: async (s: string, k: string) => store.get(`${s}:${k}`) ?? null,
      setSourceSetting: async (s: string, k: string, v: string) => { store.set(`${s}:${k}`, v); },
    },
  },
}));

import { NewNodeAlertGate, LEARN_MS } from './newNodeAlertGate.js';

const DAY = 24 * 3600_000;

describe('NewNodeAlertGate default deps', () => {
  beforeEach(() => {
    store.clear();
    mc.mockReset();
    mt.mockReset();
    rt.mockReset();
    rt.mockResolvedValue(null);
  });

  it('a nodes-only source (old Meshtastic MQTT feed) arms immediately', async () => {
    mc.mockResolvedValue(null);
    mt.mockResolvedValue(Date.now() - 30 * DAY);
    expect((await new NewNodeAlertGate().admit('s')).allow).toBe(true);
  });

  it('a meshcore-only source arms immediately', async () => {
    mc.mockResolvedValue(Date.now() - 30 * DAY);
    mt.mockResolvedValue(null);
    expect((await new NewNodeAlertGate().admit('s')).allow).toBe(true);
  });

  it('a reticulum-only source arms immediately', async () => {
    mc.mockResolvedValue(null);
    mt.mockResolvedValue(null);
    rt.mockResolvedValue(Date.now() - 30 * DAY);
    expect((await new NewNodeAlertGate().admit('s')).allow).toBe(true);
  });

  it('takes the oldest of the three tables', async () => {
    const now = Date.now();
    mc.mockResolvedValue(now - 1 * DAY);
    mt.mockResolvedValue(now - 2 * DAY);
    rt.mockResolvedValue(now - 30 * DAY);
    expect((await new NewNodeAlertGate().admit('s')).allow).toBe(true);
  });

  it('takes the older of the two tables', async () => {
    const now = Date.now();
    mc.mockResolvedValue(now - 1 * DAY);
    mt.mockResolvedValue(now - 30 * DAY);
    expect((await new NewNodeAlertGate().admit('s')).allow).toBe(true);
  });

  it('a source with no rows in either table learns for the full window', async () => {
    mc.mockResolvedValue(null);
    mt.mockResolvedValue(null);
    expect(await new NewNodeAlertGate().admit('s')).toEqual({ allow: false, reason: 'learning' });
    const until = Number(store.get('s:newNodeAlertLearnUntil'));
    expect(until).toBeGreaterThan(Date.now() + LEARN_MS - 60_000);
  });
});
