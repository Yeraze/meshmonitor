/**
 * MeshCoreManager.traceContactPathDetailed() for direct neighbours (#5914).
 *
 * A contact with pathLen 0 has no out_path, and the trace used to fail with
 * "no known path", so scheduled traces to direct neighbours never ran. It now
 * traces the single hop through the target's own hash, which a repeater or
 * room server forwards back to us. A direct companion drops traces, so it
 * still fails, without sending anything.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const PK = 'f6e0' + 'a'.repeat(60);

function makeManager(contact: Record<string, unknown>, defaultHashSize: 1 | 2 | 3 = 1) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([[PK, { publicKey: PK, name: 'ORL G2', ...contact }]]);
  (m as any).getDefaultPathHashSize = async () => defaultHashSize;
  const bridgeCalls: { cmd: string; params: Record<string, any> }[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, any>) => {
    bridgeCalls.push({ cmd, params });
    return { id: '1', success: true, data: { pathSnrs: [0xe8], lastSnr: 7.5 } };
  };
  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — trace-path to a direct neighbour (#5914)', () => {
  it('traces a direct repeater through its own 1-byte hash and returns both SNRs', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.REPEATER, pathLen: 0, outPath: '' });
    const outcome = await manager.traceContactPathDetailed(PK);

    expect(outcome.ok).toBe(true);
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].cmd).toBe('trace_path');
    expect(bridgeCalls[0].params.path_hash_bytes).toBe(1);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0xf6]);
    if (outcome.ok) {
      expect(outcome.path).toEqual(['f6']);
      expect(outcome.hops).toEqual([{ index: 0, snr: -6 }]);
      expect(outcome.lastSnr).toBe(7.5);
    }
  });

  it('traces a direct room server the same way', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.ROOM_SERVER, pathLen: 0, outPath: '' });
    expect((await manager.traceContactPathDetailed(PK)).ok).toBe(true);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0xf6]);
  });

  it('uses the source default hash width of 2 bytes', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.REPEATER, pathLen: 0, outPath: '' }, 2);
    await manager.traceContactPathDetailed(PK);
    expect(bridgeCalls[0].params.path_hash_bytes).toBe(2);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0xf6, 0xe0]);
  });

  it('falls back to 1 byte when the default width is 3 (trace-path cannot encode it)', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.REPEATER, pathLen: 0, outPath: '' }, 3);
    await manager.traceContactPathDetailed(PK);
    expect(bridgeCalls[0].params.path_hash_bytes).toBe(1);
  });

  it('honours a caller-chosen hash width', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.REPEATER, pathLen: 0, outPath: '' }, 1);
    await manager.traceContactPathDetailed(PK, { hashBytes: 2 });
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0xf6, 0xe0]);
  });

  it('sends one hop whether or not auto-return is asked for', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.REPEATER, pathLen: 0, outPath: '' });
    await manager.traceContactPathDetailed(PK, { autoReturn: true });
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0xf6]);
  });

  it('fails without sending for a direct companion, which drops traces', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.COMPANION, pathLen: 0, outPath: '' });
    const outcome = await manager.traceContactPathDetailed(PK);
    expect(outcome.ok).toBe(false);
    expect(bridgeCalls).toHaveLength(0);
  });

  it('still fails without sending when the route is unknown', async () => {
    const { manager, bridgeCalls } = makeManager({ advType: MeshCoreDeviceType.REPEATER, pathLen: null, outPath: '' });
    expect((await manager.traceContactPathDetailed(PK)).ok).toBe(false);
    expect(bridgeCalls).toHaveLength(0);
  });
});
