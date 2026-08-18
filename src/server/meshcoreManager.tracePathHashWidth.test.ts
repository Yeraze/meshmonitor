/**
 * Tests for MeshCoreManager.traceContactPath()'s per-hop hash-width handling
 * (#4786).
 *
 * traceContactPath() previously flattened a cached out_path into raw bytes
 * without telling the native backend how wide each hop hash is, so a
 * discovered 2-byte path (e.g. "0d34") was always sent as 1-byte hops and
 * the device timed out waiting for a nonexistent second hop. It now infers
 * the width from the cached path, validates it is uniform across hops, and
 * rejects widths the device's trace-path command cannot encode (3 bytes).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const PK = 'a3' + 'f'.repeat(62);

function makeManager(opts: {
  outPath: string;
  pathLen?: number;
  response?: { success: boolean; data?: unknown; error?: string };
}): { manager: MeshCoreManager; bridgeCalls: { cmd: string; params: Record<string, any> }[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([
    [
      PK,
      {
        publicKey: PK,
        name: 'Repeater One',
        outPath: opts.outPath,
        pathLen: opts.pathLen ?? 1,
      },
    ],
  ]);

  const bridgeCalls: { cmd: string; params: Record<string, any> }[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, any>) => {
    bridgeCalls.push({ cmd, params });
    return {
      id: '1',
      ...(opts.response ?? {
        success: true,
        data: { pathLen: params.path?.length ?? 0, flags: 0, pathSnrs: [], lastSnr: 0 },
      }),
    };
  };

  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — traceContactPath hop hash width (#4786)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a 1-byte path with path_hash_bytes=1', async () => {
    const { manager, bridgeCalls } = makeManager({ outPath: '11,22', pathLen: 2 });
    const result = await manager.traceContactPath(PK);

    expect(result).not.toBeNull();
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].cmd).toBe('trace_path');
    expect(bridgeCalls[0].params.path_hash_bytes).toBe(1);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0x11, 0x22]);
  });

  it('sends a single 2-byte hop ("0d34") as one hop with path_hash_bytes=2, not two 1-byte hops', async () => {
    const { manager, bridgeCalls } = makeManager({ outPath: '0d34', pathLen: 1 });
    const result = await manager.traceContactPath(PK);

    expect(result).not.toBeNull();
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].params.path_hash_bytes).toBe(2);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0x0d, 0x34]);
  });

  it('sends multiple 2-byte hops with path_hash_bytes=2 and preserves hop order', async () => {
    const { manager, bridgeCalls } = makeManager({ outPath: '0d34,7fa2', pathLen: 2 });
    const result = await manager.traceContactPath(PK);

    expect(result).not.toBeNull();
    expect(bridgeCalls[0].params.path_hash_bytes).toBe(2);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0x0d, 0x34, 0x7f, 0xa2]);
  });

  it('rejects a 3-byte cached path without transmitting (device trace command cannot encode it)', async () => {
    const { manager, bridgeCalls } = makeManager({ outPath: '0d34ff', pathLen: 1 });
    const result = await manager.traceContactPath(PK);

    expect(result).toBeNull();
    expect(bridgeCalls).toHaveLength(0);
  });

  it('rejects a cached path with mixed-width hops without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({ outPath: '11,0d34', pathLen: 2 });
    const result = await manager.traceContactPath(PK);

    expect(result).toBeNull();
    expect(bridgeCalls).toHaveLength(0);
  });

  it('rejects an empty/malformed cached path without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({ outPath: 'zz,--', pathLen: 1 });
    const result = await manager.traceContactPath(PK);

    expect(result).toBeNull();
    expect(bridgeCalls).toHaveLength(0);
  });
});
