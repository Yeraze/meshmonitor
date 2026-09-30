/**
 * waypointService.upsertAndBroadcastForAutomation (#5482).
 *
 * The repository is an in-memory fake that behaves like the real one (merge on
 * upsert, stamp on send), so the tests can check what is PERSISTED — the
 * 30-minute floor has to survive a restart, which means it may only ever be
 * read back from the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rows, mockGetManager, emit } = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  mockGetManager: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../services/database.js', () => {
  const key = (s: string, id: number) => `${s}/${id}`;
  return {
    default: {
      waypoints: {
        getAsync: vi.fn(async (s: string, id: number) => rows.get(key(s, id)) ?? null),
        getByAutomationKeyAsync: vi.fn(async (s: string, k: string) =>
          [...rows.values()].find((r) => r.sourceId === s && r.automationKey === k) ?? null),
        getExistingIdsAsync: vi.fn(async () => new Set([...rows.values()].map((r) => r.waypointId))),
        upsertAsync: vi.fn(async (input: any) => {
          const prev = rows.get(key(input.sourceId, input.waypointId));
          const merged = { lastBroadcastAt: null, broadcastFingerprint: null, ...prev };
          for (const [k, v] of Object.entries(input)) if (v !== undefined) merged[k] = v;
          rows.set(key(input.sourceId, input.waypointId), merged);
          return { ...merged };
        }),
        markAutomationBroadcastAsync: vi.fn(async (s: string, id: number, nowSec: number, fp: string) => {
          const r = rows.get(key(s, id));
          if (!r) return false;
          r.lastBroadcastAt = nowSec;
          r.broadcastFingerprint = fp;
          return true;
        }),
      },
    },
  };
});

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (...args: unknown[]) => mockGetManager(...args) },
}));

vi.mock('./waypointNotificationService.js', () => ({
  waypointNotificationService: { notifyIfInRange: vi.fn(), forgetWaypoint: vi.fn() },
}));

vi.mock('./dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitWaypointUpserted: (...args: unknown[]) => emit('upserted', args),
    emitWaypointDeleted: vi.fn(),
    emitWaypointExpired: vi.fn(),
  },
}));

import { waypointService, truncateUtf8, type AutomationWaypointInput } from './waypointService.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';

function makeManager(opts: { canTransmit?: boolean; packetId?: number } = {}) {
  let next = opts.packetId ?? 100;
  return {
    sourceType: 'meshtastic_tcp',
    getLocalNodeInfo: () => ({ nodeNum: 555 }),
    canTransmit: vi.fn(() => opts.canTransmit ?? true),
    broadcastWaypoint: vi.fn(async () => (opts.packetId === 0 ? 0 : next++)),
  };
}

const T0 = 1_800_000_000;
const MIN = 60;

function input(overrides: Partial<AutomationWaypointInput> = {}): AutomationWaypointInput {
  return {
    sourceId: 'src-1',
    automationKey: 'auto-1:border-north',
    latitude: 32.54,
    longitude: -117.03,
    name: 'San Ysidro 40m',
    description: 'car lanes',
    icon: '🚗',
    expireAt: null,
    channel: 1,
    hopLimit: 2,
    onlyWhenChanged: false,
    ...overrides,
  };
}

beforeEach(() => {
  rows.clear();
  mockGetManager.mockReset();
  emit.mockReset();
});

describe('upsertAndBroadcastForAutomation (#5482)', () => {
  it('creates the waypoint, sends it with the stored hop limit and channel, and stamps lastBroadcastAt', async () => {
    const m = makeManager();
    mockGetManager.mockReturnValue(m);

    const r = await waypointService.upsertAndBroadcastForAutomation(input(), T0);

    expect(r).toMatchObject({ sent: true, packetId: 100 });
    expect(m.broadcastWaypoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: r.waypointId, name: 'San Ysidro 40m', icon: 0x1f697 }),
      { channel: 1, origin: 'automation', hopLimit: 2 },
    );
    const row = [...rows.values()][0];
    expect(row).toMatchObject({
      automationKey: 'auto-1:border-north', ownerNodeNum: 555, isVirtual: false, hopLimit: 2, lastBroadcastAt: T0,
    });
    expect(row.broadcastFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the same waypoint id across runs', async () => {
    mockGetManager.mockReturnValue(makeManager());
    const a = await waypointService.upsertAndBroadcastForAutomation(input(), T0);
    const b = await waypointService.upsertAndBroadcastForAutomation(input({ name: 'San Ysidro 55m' }), T0 + 31 * MIN);
    expect(b.waypointId).toBe(a.waypointId);
    expect(rows.size).toBe(1);
  });

  it('gives different keys different waypoints', async () => {
    mockGetManager.mockReturnValue(makeManager());
    const a = await waypointService.upsertAndBroadcastForAutomation(input(), T0);
    const b = await waypointService.upsertAndBroadcastForAutomation(input({ automationKey: 'auto-1:otay' }), T0);
    expect(b.waypointId).not.toBe(a.waypointId);
    expect(b.sent).toBe(true);
  });

  it('skips a send inside the 30-minute floor but still updates the row', async () => {
    const m = makeManager();
    mockGetManager.mockReturnValue(m);
    await waypointService.upsertAndBroadcastForAutomation(input(), T0);

    const r = await waypointService.upsertAndBroadcastForAutomation(input({ name: 'San Ysidro 55m' }), T0 + 29 * MIN);

    expect(r).toMatchObject({ sent: false, skipped: true, reason: 'MIN_INTERVAL', nextAllowedAt: T0 + 30 * MIN });
    expect(m.broadcastWaypoint).toHaveBeenCalledTimes(1);
    const row = [...rows.values()][0];
    expect(row.name).toBe('San Ysidro 55m');
    expect(row.lastBroadcastAt).toBe(T0);
  });

  it('reads the floor from the database, so a restart does not re-arm it', async () => {
    // A row persisted by a previous process: sent 10 minutes ago.
    rows.set('src-1/4242', {
      sourceId: 'src-1', waypointId: 4242, automationKey: 'auto-1:border-north',
      latitude: 1, longitude: 2, name: 'old', description: '', iconCodepoint: null, expireAt: null,
      channel: 1, hopLimit: 2, isVirtual: false, lastBroadcastAt: T0 - 10 * MIN, broadcastFingerprint: 'x',
    });
    // A brand-new manager instance, as after a restart: nothing in memory.
    const m = makeManager();
    mockGetManager.mockReturnValue(m);

    const r = await waypointService.upsertAndBroadcastForAutomation(input(), T0);

    expect(r).toMatchObject({ waypointId: 4242, skipped: true, reason: 'MIN_INTERVAL' });
    expect(m.broadcastWaypoint).not.toHaveBeenCalled();
  });

  it('lets only one of two overlapping runs for the same waypoint transmit', async () => {
    const m = makeManager();
    mockGetManager.mockReturnValue(m);

    const [a, b] = await Promise.all([
      waypointService.upsertAndBroadcastForAutomation(input(), T0),
      waypointService.upsertAndBroadcastForAutomation(input({ name: 'San Ysidro 45m' }), T0),
    ]);

    expect(m.broadcastWaypoint).toHaveBeenCalledTimes(1);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
    expect(b).toMatchObject({ skipped: true, reason: 'MIN_INTERVAL' });
    expect(rows.size).toBe(1);
  });

  it('keeps serving a waypoint after a run on it failed', async () => {
    const m = makeManager();
    m.broadcastWaypoint.mockRejectedValueOnce(new Error('radio gone'));
    mockGetManager.mockReturnValue(m);

    await expect(waypointService.upsertAndBroadcastForAutomation(input(), T0)).rejects.toThrow('radio gone');
    const r = await waypointService.upsertAndBroadcastForAutomation(input(), T0 + MIN);
    expect(r.sent).toBe(true);
  });

  it('sends again once 30 minutes have passed', async () => {
    const m = makeManager();
    mockGetManager.mockReturnValue(m);
    await waypointService.upsertAndBroadcastForAutomation(input(), T0);
    const r = await waypointService.upsertAndBroadcastForAutomation(input(), T0 + 30 * MIN);
    expect(r.sent).toBe(true);
    expect(m.broadcastWaypoint).toHaveBeenCalledTimes(2);
    expect([...rows.values()][0].lastBroadcastAt).toBe(T0 + 30 * MIN);
  });

  describe('onlyWhenChanged', () => {
    it('skips an unchanged waypoint after the floor', async () => {
      const m = makeManager();
      mockGetManager.mockReturnValue(m);
      await waypointService.upsertAndBroadcastForAutomation(input({ onlyWhenChanged: true }), T0);
      const r = await waypointService.upsertAndBroadcastForAutomation(input({ onlyWhenChanged: true }), T0 + 60 * MIN);
      expect(r).toMatchObject({ sent: false, skipped: true, reason: 'UNCHANGED' });
      expect(m.broadcastWaypoint).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['name', { name: 'San Ysidro 90m' }],
      ['description', { description: 'all lanes' }],
      ['position', { latitude: 32.55 }],
      ['icon', { icon: '🚚' }],
      ['expiry', { expireAt: T0 + 7200 }],
      ['channel', { channel: 2 }],
      ['hop limit', { hopLimit: 1 }],
    ])('sends when the %s changed', async (_label, change) => {
      const m = makeManager();
      mockGetManager.mockReturnValue(m);
      await waypointService.upsertAndBroadcastForAutomation(input({ onlyWhenChanged: true }), T0);
      const r = await waypointService.upsertAndBroadcastForAutomation(
        input({ onlyWhenChanged: true, ...change }), T0 + 60 * MIN,
      );
      expect(r.sent).toBe(true);
    });

    it('still sends a change that arrived while the floor held it back', async () => {
      const m = makeManager();
      mockGetManager.mockReturnValue(m);
      await waypointService.upsertAndBroadcastForAutomation(input({ onlyWhenChanged: true }), T0);
      // Changed inside the floor: row updated, nothing sent.
      await waypointService.upsertAndBroadcastForAutomation(input({ onlyWhenChanged: true, name: 'new' }), T0 + 5 * MIN);
      // Same content after the floor: the mesh has not seen it yet, so it goes out.
      const r = await waypointService.upsertAndBroadcastForAutomation(input({ onlyWhenChanged: true, name: 'new' }), T0 + 31 * MIN);
      expect(r.sent).toBe(true);
      expect(m.broadcastWaypoint).toHaveBeenCalledTimes(2);
    });

    it('defaults to sending every allowed run', async () => {
      const m = makeManager();
      mockGetManager.mockReturnValue(m);
      await waypointService.upsertAndBroadcastForAutomation(input(), T0);
      const r = await waypointService.upsertAndBroadcastForAutomation(input(), T0 + 31 * MIN);
      expect(r.sent).toBe(true);
    });
  });

  it('throws TxDisabledError after updating the row when the source cannot transmit', async () => {
    const m = makeManager({ canTransmit: false });
    mockGetManager.mockReturnValue(m);
    const err = await waypointService.upsertAndBroadcastForAutomation(input(), T0).catch((e) => e);
    expect(isTxDisabledError(err)).toBe(true);
    expect(m.broadcastWaypoint).not.toHaveBeenCalled();
    const row = [...rows.values()][0];
    expect(row.name).toBe('San Ysidro 40m');
    expect(row.lastBroadcastAt).toBeNull();
  });

  it('does not stamp the floor when nothing went out', async () => {
    mockGetManager.mockReturnValue(makeManager({ packetId: 0 }));
    const r = await waypointService.upsertAndBroadcastForAutomation(input(), T0);
    expect(r).toMatchObject({ sent: false, reason: 'NOT_CONNECTED' });
    expect([...rows.values()][0].lastBroadcastAt).toBeNull();
  });

  it('rejects a source that is not Meshtastic, writing nothing', async () => {
    mockGetManager.mockReturnValue({ sourceType: 'meshcore' });
    await expect(waypointService.upsertAndBroadcastForAutomation(input(), T0)).rejects.toThrow(/not a Meshtastic source/);
    mockGetManager.mockReturnValue(undefined);
    await expect(waypointService.upsertAndBroadcastForAutomation(input(), T0)).rejects.toThrow(/not a Meshtastic source/);
    expect(rows.size).toBe(0);
  });

  it('trims the name to the firmware 29-byte limit without splitting a character', async () => {
    mockGetManager.mockReturnValue(makeManager());
    await waypointService.upsertAndBroadcastForAutomation(input({ name: 'é'.repeat(20) }), T0);
    const row = [...rows.values()][0];
    expect(new TextEncoder().encode(row.name).length).toBe(28);
    expect(truncateUtf8('abc', 29)).toBe('abc');
  });
});
