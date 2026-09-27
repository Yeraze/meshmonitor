/**
 * MeshCoreManager.reorderChannels (#5379) against a simulated companion.
 *
 * The fake device keeps a real slot table and answers the three bridge
 * commands the reorder uses (get_channel_table, set_channel_verified,
 * device_query). Faults are injected per write to prove the rollback path:
 * after ANY outcome, no channel that was on the device at the start may be
 * missing from it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const remapMock = vi.fn();
vi.mock('./services/meshcoreChannelRemapService.js', () => ({
  remapMeshCoreChannelReferences: (...args: unknown[]) => remapMock(...args),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';

type Slot = { name: string; secret: string };
const EMPTY: Slot = { name: '', secret: '0'.repeat(32) };
const sec = (c: string) => c.repeat(32);

interface FakeDevice {
  slots: Slot[];
  writes: Array<{ idx: number; name: string }>;
  /** Return a failure for the Nth set_channel_verified call (0-based), every attempt. */
  failWrites: Set<number>;
  /** After this many writes, every later write fails (simulates a lost link). */
  dieAfter?: number;
  /** Make the Nth table read return a different table. */
  corruptRead?: number;
  reads: number;
}

function makeDevice(names: string[], size = 8): FakeDevice {
  const slots: Slot[] = Array.from({ length: size }, () => ({ ...EMPTY }));
  slots[0] = { name: '', secret: '0'.repeat(32) }; // Public reads as empty
  names.forEach((n, i) => { slots[i + 1] = { name: n, secret: sec(String.fromCharCode(97 + i)) }; });
  return { slots, writes: [], failWrites: new Set(), reads: 0 };
}

function channelSet(d: FakeDevice): Set<string> {
  return new Set(d.slots.filter((s) => s.name || /[1-9a-f]/.test(s.secret)).map((s) => `${s.name}|${s.secret}`));
}

function makeManager(device: FakeDevice) {
  const m = new MeshCoreManager('src-reorder');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).nativeBackend = {};
  (m as any).refreshKnownScopes = async () => {};
  const sync = vi.fn(async () => {});
  // Only stub the public sync used after the reorder; the guard logic is tested separately.
  (m as any).syncChannelsFromDevice = sync;
  let writeCount = 0;
  (m as any).sendBridgeCommand = async (cmd: string, params: any) => {
    if (cmd === 'get_channel_table') {
      const n = device.reads++;
      const rows = device.slots.map((s, i) => ({ channel_idx: i, name: s.name, secret_hex: s.secret }));
      if (device.corruptRead === n) rows[1] = { ...rows[1], name: 'glitch' };
      return { id: 'r', success: true, data: rows };
    }
    if (cmd === 'device_query') {
      return { id: 'q', success: true, data: { 'fw ver': 9, max_channels: device.slots.length } };
    }
    if (cmd === 'set_channel_verified') {
      const n = writeCount++;
      if (device.failWrites.has(n) || (device.dieAfter !== undefined && n >= device.dieAfter)) {
        return { id: 'w', success: false, error: 'Native command timeout: set_channel_verified' };
      }
      device.slots[params.idx] = { name: params.name, secret: params.secret_hex };
      device.writes.push({ idx: params.idx, name: params.name });
      return {
        id: 'w', success: true,
        data: { verified: true, channel_idx: params.idx, name: params.name, secret_hex: params.secret_hex },
      };
    }
    return { id: 'x', success: false, error: `unexpected ${cmd}` };
  };
  return { manager: m, sync };
}

beforeEach(() => {
  remapMock.mockReset();
  remapMock.mockImplementation(async (_sid: string, moves: Array<{ from: number; to: number }>) => ({
    messages: 0, channels: 0, readMarkers: 0, permissionsMoved: 0, permissionsDropped: 0,
    settingsUpdated: [], appliedMoves: moves, automationsToReview: [],
  }));
});

describe('MeshCoreManager.reorderChannels', () => {
  it('applies a swap, verifies it, then remaps once', async () => {
    const device = makeDevice(['a', 'b', 'c']);
    const before = channelSet(device);
    const { manager, sync } = makeManager(device);
    const events: any[] = [];
    const onData = (e: any) => { if (e.type === 'meshcore:channels:reordered') events.push(e); };
    dataEventEmitter.on('data', onData);

    const result = await manager.reorderChannels([2, 1, 3]);
    dataEventEmitter.off('data', onData);

    expect(result.status).toBe('applied');
    expect(device.slots[1].name).toBe('b');
    expect(device.slots[2].name).toBe('a');
    expect(device.slots[3].name).toBe('c');
    expect(device.slots[7]).toEqual(EMPTY); // scratch cleaned up
    expect(channelSet(device)).toEqual(before);
    expect(remapMock).toHaveBeenCalledTimes(1);
    expect(remapMock).toHaveBeenCalledWith('src-reorder', [{ from: 2, to: 1 }, { from: 1, to: 2 }]);
    expect(events).toHaveLength(1);
    expect(sync).toHaveBeenCalled();
    expect(manager.isChannelReorderInProgress()).toBe(false);
  });

  it('returns unchanged and writes nothing for the current order', async () => {
    const device = makeDevice(['a', 'b']);
    const { manager } = makeManager(device);
    expect(await manager.reorderChannels([1, 2])).toEqual({ status: 'unchanged' });
    expect(device.writes).toHaveLength(0);
    expect(remapMock).not.toHaveBeenCalled();
  });

  it('rolls back after a mid-sequence write failure and leaves the original layout', async () => {
    const device = makeDevice(['a', 'b', 'c']);
    const original = device.slots.map((s) => ({ ...s }));
    device.failWrites = new Set([2, 3]); // the third write fails, and its retry
    const { manager } = makeManager(device);

    const result = await manager.reorderChannels([3, 1, 2]);

    expect(result.status).toBe('rolled_back');
    expect(device.slots).toEqual(original);
    expect(remapMock).not.toHaveBeenCalled();
  });

  it('reports inconsistent when the link dies, and still loses no channel', async () => {
    const statuses = new Set<string>();
    for (let dieAfter = 0; dieAfter < 8; dieAfter++) {
      const device = makeDevice(['a', 'b', 'c']);
      const before = channelSet(device);
      device.dieAfter = dieAfter;
      const { manager } = makeManager(device);

      const result = await manager.reorderChannels([3, 1, 2]);

      expect(['rolled_back', 'inconsistent', 'applied']).toContain(result.status);
      statuses.add(result.status);
      if (result.status === 'inconsistent') {
        expect(result.deviceSlots.length).toBeGreaterThan(0);
      }
      // Every channel that was there is still there somewhere.
      for (const key of before) expect(channelSet(device)).toContain(key);
      // The DB is only touched once the device is confirmed in the new layout.
      expect(remapMock).toHaveBeenCalledTimes(result.status === 'applied' ? 1 : 0);
      remapMock.mockClear();
    }
    expect(statuses).toContain('inconsistent');
    expect(statuses).toContain('applied');
  });

  it('puts the device back when the DB remap fails', async () => {
    const device = makeDevice(['a', 'b']);
    const original = device.slots.map((s) => ({ ...s }));
    remapMock.mockRejectedValueOnce(new Error('db down'));
    const { manager } = makeManager(device);

    const result = await manager.reorderChannels([2, 1]);

    expect(result.status).toBe('rolled_back');
    if (result.status === 'rolled_back') expect(result.error).toMatch(/db down/);
    expect(device.slots).toEqual(original);
  });

  it('refuses before writing when two table reads disagree', async () => {
    const device = makeDevice(['a', 'b']);
    device.corruptRead = 1;
    const { manager } = makeManager(device);
    await expect(manager.reorderChannels([2, 1])).rejects.toMatchObject({ code: 'TABLE_READ_FAILED' });
    expect(device.writes).toHaveLength(0);
  });

  it('refuses a stale order before writing, then resyncs the DB mirror', async () => {
    const device = makeDevice(['a', 'b', 'c']);
    const { manager, sync } = makeManager(device);
    await expect(manager.reorderChannels([2, 1])).rejects.toMatchObject({ code: 'ORDER_MISMATCH' });
    expect(device.writes).toHaveLength(0);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('refuses while disconnected or on a repeater', async () => {
    const device = makeDevice(['a', 'b']);
    const { manager } = makeManager(device);
    (manager as any).connected = false;
    await expect(manager.reorderChannels([2, 1])).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    (manager as any).connected = true;
    (manager as any).deviceType = MeshCoreDeviceType.REPEATER;
    await expect(manager.reorderChannels([2, 1])).rejects.toMatchObject({ code: 'NOT_COMPANION' });
  });

  it('blocks channel writes, deletes and a second reorder while one runs', async () => {
    const device = makeDevice(['a', 'b']);
    const { manager } = makeManager(device);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send = (manager as any).sendBridgeCommand;
    (manager as any).sendBridgeCommand = async (cmd: string, params: any) => {
      if (cmd === 'set_channel_verified') await gate;
      return send(cmd, params);
    };

    const running = manager.reorderChannels([2, 1]);
    await vi.waitFor(() => expect(manager.isChannelReorderInProgress()).toBe(true));
    await expect(manager.setChannel(3, 'x', sec('9'))).rejects.toMatchObject({ code: 'REORDER_IN_PROGRESS' });
    await expect(manager.deleteChannel(1)).rejects.toMatchObject({ code: 'REORDER_IN_PROGRESS' });
    await expect(manager.reorderChannels([2, 1])).rejects.toMatchObject({ code: 'REORDER_IN_PROGRESS' });
    release();
    expect((await running).status).toBe('applied');
  });

  it('files a message received mid-reorder under the channel\'s original slot', async () => {
    const device = makeDevice(['a', 'b']);
    const { manager } = makeManager(device);
    const seen: string[] = [];
    manager.on('message', (msg: any) => seen.push(msg.fromPublicKey));
    (manager as any).checkAutoAcknowledge = async () => {};
    (manager as any).checkAutoResponder = async () => {};
    (manager as any).addMessage = () => {};

    const send = (manager as any).sendBridgeCommand;
    let injected = false;
    (manager as any).sendBridgeCommand = async (cmd: string, params: any) => {
      const res = await send(cmd, params);
      // After the first write (channel 'a' copied to scratch slot 7), the
      // firmware would report a message on channel 'a' from whichever slot
      // matches first; pretend it reported slot 7.
      if (cmd === 'set_channel_verified' && !injected) {
        injected = true;
        (manager as any).handleBridgeEvent({
          event_type: 'channel_message',
          data: { channel_idx: 7, text: 'Bob: hi', sender_timestamp: 0, path_len: 0 },
        });
      }
      return res;
    };

    await manager.reorderChannels([2, 1]);
    expect(seen).toEqual(['channel-1']);
  });
});
