/**
 * Auto return path for MeshCore Trace Path (#5485).
 *
 * With `autoReturn`, the trace comes back along the same route: through the
 * target for repeaters and room servers (which forward traces), turning at the
 * last repeater for companions (which drop traces unless repeat is on).
 * Without it — the default, used by automations — the one-way path is sent
 * unchanged.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const TARGET = 'f6' + 'e'.repeat(62);

function makeManager(opts: { outPath: string; pathLen: number; advType: MeshCoreDeviceType; pathSnrs?: number[] }) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([
    [TARGET, { publicKey: TARGET, name: 'Target', outPath: opts.outPath, pathLen: opts.pathLen, advType: opts.advType }],
  ]);
  const sent: number[][] = [];
  (m as any).sendBridgeCommand = async (_cmd: string, params: Record<string, any>) => {
    sent.push(Array.from(params.path as Uint8Array));
    return { id: '1', success: true, data: { pathSnrs: opts.pathSnrs ?? [], lastSnr: 4.5 } };
  };
  return { m, sent };
}

describe('MeshCoreManager.traceContactPath — auto return path (#5485)', () => {
  it('loops through a repeater target: [5e] becomes [5e, f6, 5e]', async () => {
    const { m, sent } = makeManager({
      outPath: '5e', pathLen: 1, advType: MeshCoreDeviceType.REPEATER, pathSnrs: [40, 24, 8],
    });
    const r = await m.traceContactPath(TARGET, { autoReturn: true });
    expect(sent[0]).toEqual([0x5e, 0xf6, 0x5e]);
    expect(r?.path).toEqual(['5e', 'f6', '5e']);
    expect(r?.hops.map((h) => h.snr)).toEqual([10, 6, 2]);
  });

  it('loops through a room server target over two hops', async () => {
    const { m, sent } = makeManager({ outPath: 'a1,b2', pathLen: 2, advType: MeshCoreDeviceType.ROOM_SERVER });
    await m.traceContactPath(TARGET, { autoReturn: true });
    expect(sent[0]).toEqual([0xa1, 0xb2, 0xf6, 0xb2, 0xa1]);
  });

  it('turns at the last repeater for a companion target', async () => {
    const { m, sent } = makeManager({ outPath: 'a1,b2', pathLen: 2, advType: MeshCoreDeviceType.COMPANION });
    const r = await m.traceContactPath(TARGET, { autoReturn: true });
    expect(sent[0]).toEqual([0xa1, 0xb2, 0xa1]);
    expect(r?.path).toEqual(['a1', 'b2', 'a1']);
  });

  it('uses the target key prefix at the path hash width (2-byte hops)', async () => {
    const { m, sent } = makeManager({ outPath: '5e01', pathLen: 1, advType: MeshCoreDeviceType.REPEATER });
    await m.traceContactPath(TARGET, { autoReturn: true });
    expect(sent[0]).toEqual([0x5e, 0x01, 0xf6, 0xee, 0x5e, 0x01]);
  });

  it('sends the one-way path when autoReturn is off (the default)', async () => {
    const { m, sent } = makeManager({ outPath: '5e', pathLen: 1, advType: MeshCoreDeviceType.REPEATER });
    const r = await m.traceContactPath(TARGET);
    expect(sent[0]).toEqual([0x5e]);
    expect(r?.path).toEqual(['5e']);
  });
});
