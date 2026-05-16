/**
 * Tests for MeshCoreManager channel CRUD + sync.
 *
 * The manager exposes:
 *   - listChannels() — pulls the channel list from the device via `get_channels`.
 *   - setChannel(idx, name, secretHex) — writes via `set_channel` and re-syncs DB.
 *   - deleteChannel(idx) — writes via `delete_channel` and re-syncs DB.
 *   - syncChannelsFromDevice() — mirrors the device's channel list into the
 *     shared `channels` table (Meshtastic-only columns left null).
 *
 * These tests use the same private-method-stubbing pattern as
 * meshcoreManager.telemetry.test.ts to exercise the logic without spinning up
 * a real native backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall {
  cmd: string;
  params: Record<string, unknown>;
}

function makeManager(opts: {
  deviceType?: MeshCoreDeviceType;
  getChannelsResponse?: { success: boolean; data?: unknown; error?: string };
  failOnSet?: boolean;
  /** Pre-existing DB rows for this source — what `getAllChannels(sourceId)` returns. */
  preExistingRows?: Array<{ id: number; name?: string; psk?: string | null }>;
}): {
  manager: MeshCoreManager;
  bridgeCalls: BridgeCall[];
  upsertCalls: Array<{ data: any; sourceId: string | undefined; opts: any }>;
  deleteCalls: Array<{ id: number; sourceId: string | undefined }>;
} {
  const deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  const m = new MeshCoreManager('test-source');
  // Force the device type so the manager doesn't short-circuit on the
  // "not connected" branch — the same trick the existing telemetry tests use.
  (m as any).deviceType = deviceType;

  const bridgeCalls: BridgeCall[] = [];
  const upsertCalls: Array<{ data: any; sourceId: string | undefined; opts: any }> = [];
  const deleteCalls: Array<{ id: number; sourceId: string | undefined }> = [];
  // syncChannelsFromDevice tracks pre-existing DB rows so it can reconcile
  // (delete rows for slots the device no longer reports as configured).
  // Each upsert mutates this view so subsequent calls in the same test see
  // the post-upsert state.
  const dbRows: Map<number, { id: number; name: string; psk: string | null }> = new Map(
    (opts.preExistingRows ?? []).map(r => [r.id, { id: r.id, name: r.name ?? '', psk: r.psk ?? null }]),
  );

  const defaultGetChannels = {
    success: true,
    data: [
      { channel_idx: 0, name: 'Public', secret_hex: '00112233445566778899aabbccddeeff' },
      { channel_idx: 1, name: 'Private', secret_hex: 'ffeeddccbbaa99887766554433221100' },
    ],
  };

  // Stub the private bridge transport.
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'get_channels') {
      return { id: '1', ...(opts.getChannelsResponse ?? defaultGetChannels) };
    }
    if (cmd === 'set_channel') {
      if (opts.failOnSet) {
        return { id: '1', success: false, error: 'firmware rejected' };
      }
      return { id: '1', success: true, data: { ok: true } };
    }
    if (cmd === 'delete_channel') {
      return { id: '1', success: true, data: { ok: true } };
    }
    return { id: '1', success: true, data: {} };
  };

  // Stub the channels repository on the shared databaseService singleton.
  // We don't initialise a real DB here — this is a pure unit test.
  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    upsertChannel: vi.fn(async (data: any, sourceId?: string, opts?: any) => {
      upsertCalls.push({ data, sourceId, opts });
      dbRows.set(data.id, { id: data.id, name: data.name ?? '', psk: data.psk ?? null });
    }),
    getAllChannels: vi.fn(async (_sourceId?: string) => {
      return Array.from(dbRows.values());
    }),
    deleteChannel: vi.fn(async (id: number, sourceId?: string) => {
      deleteCalls.push({ id, sourceId });
      dbRows.delete(id);
    }),
  } as any);

  return { manager: m, bridgeCalls, upsertCalls, deleteCalls };
}

describe('MeshCoreManager — listChannels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] when device is not in Companion mode', async () => {
    const { manager, bridgeCalls } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    const list = await manager.listChannels();
    expect(list).toEqual([]);
    // Repeater short-circuits before issuing any bridge command.
    expect(bridgeCalls).toHaveLength(0);
  });

  it('maps wire-shaped rows into MeshCoreChannel objects', async () => {
    const { manager, bridgeCalls } = makeManager({});
    const list = await manager.listChannels();
    expect(bridgeCalls).toEqual([{ cmd: 'get_channels', params: {} }]);
    expect(list).toEqual([
      { channelIdx: 0, name: 'Public', secretHex: '00112233445566778899aabbccddeeff' },
      { channelIdx: 1, name: 'Private', secretHex: 'ffeeddccbbaa99887766554433221100' },
    ]);
  });

  it('throws when the bridge response is not successful', async () => {
    const { manager } = makeManager({
      getChannelsResponse: { success: false, error: 'transport closed' },
    });
    await expect(manager.listChannels()).rejects.toThrow('transport closed');
  });
});

describe('MeshCoreManager — syncChannelsFromDevice', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('upserts each channel into the shared channels table with sourceId scoping', async () => {
    const { manager, upsertCalls } = makeManager({});
    await manager.syncChannelsFromDevice();

    expect(upsertCalls).toHaveLength(2);

    // Channel 0 — base64 of the 16 hex bytes 00112233445566778899aabbccddeeff
    expect(upsertCalls[0].data).toMatchObject({
      id: 0,
      name: 'Public',
      psk: Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64'),
      role: null,
      uplinkEnabled: null,
      downlinkEnabled: null,
      positionPrecision: null,
    });
    expect(upsertCalls[0].sourceId).toBe('test-source');
    expect(upsertCalls[0].opts).toEqual({ allowBlankName: true });

    // Channel 1
    expect(upsertCalls[1].data).toMatchObject({
      id: 1,
      name: 'Private',
      psk: Buffer.from('ffeeddccbbaa99887766554433221100', 'hex').toString('base64'),
    });
  });

  it('handles an empty channel list without throwing', async () => {
    const { manager, upsertCalls } = makeManager({
      getChannelsResponse: { success: true, data: [] },
    });
    await manager.syncChannelsFromDevice();
    expect(upsertCalls).toHaveLength(0);
  });

  it('stores psk as null when the device reports an empty secret', async () => {
    const { manager, upsertCalls } = makeManager({
      getChannelsResponse: {
        success: true,
        data: [{ channel_idx: 0, name: 'OpenChannel', secret_hex: '' }],
      },
    });
    await manager.syncChannelsFromDevice();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].data.psk).toBeNull();
  });

  it('filters out empty/unconfigured slots (the MAX_CHANNELS leak)', async () => {
    // MeshCore Companion firmware returns success for every slot up to
    // MAX_CHANNELS (typically 40) with an empty name and all-zero secret
    // for unused slots. The sync must skip those.
    const zero = '00'.repeat(16);
    const { manager, upsertCalls } = makeManager({
      getChannelsResponse: {
        success: true,
        data: [
          { channel_idx: 0, name: 'Public', secret_hex: 'aa'.repeat(16) },
          { channel_idx: 1, name: '', secret_hex: zero }, // empty slot — skip
          { channel_idx: 2, name: '', secret_hex: zero }, // empty slot — skip
          { channel_idx: 5, name: 'Town', secret_hex: 'bb'.repeat(16) },
          { channel_idx: 6, name: '', secret_hex: zero }, // empty slot — skip
        ],
      },
    });
    await manager.syncChannelsFromDevice();
    expect(upsertCalls.map(c => c.data.id)).toEqual([0, 5]);
  });

  it('keeps a slot configured when the user blanks the name but keeps a real secret', async () => {
    const { manager, upsertCalls } = makeManager({
      getChannelsResponse: {
        success: true,
        data: [{ channel_idx: 3, name: '', secret_hex: 'cc'.repeat(16) }],
      },
    });
    await manager.syncChannelsFromDevice();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].data.id).toBe(3);
  });

  it('reconciles: deletes DB rows for slots the device no longer treats as configured', async () => {
    // Pre-existing DB has channels at idx 0, 1, 5 (left over from before the
    // empty-slot filter, OR from an out-of-band delete via meshcore-cli).
    // The device now only reports 0 + 5 as configured; 1 should be deleted.
    const zero = '00'.repeat(16);
    const { manager, deleteCalls, upsertCalls } = makeManager({
      preExistingRows: [
        { id: 0, name: 'Public', psk: 'old' },
        { id: 1, name: '', psk: '' },
        { id: 5, name: 'Town', psk: 'oldtoo' },
      ],
      getChannelsResponse: {
        success: true,
        data: [
          { channel_idx: 0, name: 'Public', secret_hex: 'aa'.repeat(16) },
          { channel_idx: 1, name: '', secret_hex: zero }, // empty — filtered out
          { channel_idx: 5, name: 'Town', secret_hex: 'bb'.repeat(16) },
        ],
      },
    });
    await manager.syncChannelsFromDevice();

    // Upserted only the two configured slots.
    expect(upsertCalls.map(c => c.data.id)).toEqual([0, 5]);
    // Deleted the stale empty-slot row at idx 1.
    expect(deleteCalls).toEqual([{ id: 1, sourceId: 'test-source' }]);
  });
});

describe('MeshCoreManager — setChannel / deleteChannel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('setChannel passes idx + name + secret_hex and then re-syncs', async () => {
    const { manager, bridgeCalls, upsertCalls } = makeManager({});
    await manager.setChannel(2, 'New', 'aabbccddeeff00112233445566778899');

    // First the set_channel write, then a get_channels re-sync.
    expect(bridgeCalls.map((c) => c.cmd)).toEqual(['set_channel', 'get_channels']);
    expect(bridgeCalls[0].params).toEqual({
      idx: 2,
      name: 'New',
      secret_hex: 'aabbccddeeff00112233445566778899',
    });
    // Re-sync upserts the (mocked) channel list (Public + Private from the default fixture).
    expect(upsertCalls.length).toBeGreaterThan(0);
  });

  it('setChannel throws when device is not Companion', async () => {
    const { manager } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    await expect(manager.setChannel(0, 'x', '00'.repeat(16))).rejects.toThrow(/Companion mode/);
  });

  it('setChannel surfaces firmware errors instead of swallowing them', async () => {
    const { manager } = makeManager({ failOnSet: true });
    await expect(manager.setChannel(0, 'x', '00'.repeat(16))).rejects.toThrow('firmware rejected');
  });

  it('deleteChannel passes idx and then re-syncs', async () => {
    const { manager, bridgeCalls } = makeManager({});
    await manager.deleteChannel(3);
    expect(bridgeCalls.map((c) => c.cmd)).toEqual(['delete_channel', 'get_channels']);
    expect(bridgeCalls[0].params).toEqual({ idx: 3 });
  });

  it('deleteChannel throws when device is not Companion', async () => {
    const { manager } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    await expect(manager.deleteChannel(0)).rejects.toThrow(/Companion mode/);
  });
});
