/**
 * Tests for MeshCoreManager.pingContactZeroHop() — issue #4393.
 *
 * A zero-hop ping is a TRACE (companion command SendTracePath, opcode 36,
 * issued here through the `trace_path` bridge command) whose path is the
 * single 1-byte hop hash of the target's own public key. The firmware only
 * forwards a route-direct TRACE whose next path byte matches its identity
 * hash (MeshCore `src/Mesh.cpp`, `Mesh::onRecvPacket`), so a reply proves the
 * node is in direct RF range.
 *
 * These tests pin the command construction (which bridge command, which path
 * bytes) and the SNR sign handling — trace SNRs arrive as unsigned bytes of an
 * int8 × 4, so a naive `raw / 4` turns -6 dB into +62.5 dB.
 *
 * Uses the private-method-stubbing pattern from meshcoreManager.shareContact.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

interface BridgeCall {
  cmd: string;
  params: Record<string, unknown>;
  timeout?: number;
}

const PK = 'a3' + 'f'.repeat(62); // first byte 0xa3 → hop hash "a3"

function makeManager(opts: {
  deviceType?: MeshCoreDeviceType;
  connected?: boolean;
  knownContact?: boolean;
  response?: { success: boolean; data?: unknown; error?: string };
  throws?: boolean;
}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = opts.connected ?? true;
  if (opts.knownContact !== false) {
    (m as any).contacts = new Map([[PK, { publicKey: PK, name: 'Repeater One' }]]);
  }

  const bridgeCalls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (
    cmd: string,
    params: Record<string, unknown>,
    timeout?: number,
  ) => {
    bridgeCalls.push({ cmd, params, timeout });
    if (opts.throws) throw new Error('link dropped');
    return {
      id: '1',
      ...(opts.response ?? {
        success: true,
        data: { pathLen: 1, flags: 0, pathSnrs: [40], lastSnr: 7.25 },
      }),
    };
  };

  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — pingContactZeroHop (#4393)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('issues trace_path with a single-byte synthetic path built from the target key', async () => {
    const { manager, bridgeCalls } = makeManager({});
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(true);
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].cmd).toBe('trace_path');

    const path = bridgeCalls[0].params.path as Uint8Array;
    expect(path).toBeInstanceOf(Uint8Array);
    // Zero hop == exactly one hash byte, the target's own leading key byte.
    expect(Array.from(path)).toEqual([0xa3]);
    expect(bridgeCalls[0].params.extra_timeout).toBe(3000);
  });

  it('ignores the contact cached out_path (the point is to bypass the learned route)', async () => {
    const { manager, bridgeCalls } = makeManager({});
    // A multi-hop cached route must not leak into the ping path.
    (manager as any).contacts.set(PK, {
      publicKey: PK,
      outPath: '11,22,33',
      pathLen: 3,
    });

    await manager.pingContactZeroHop(PK);
    expect(Array.from(bridgeCalls[0].params.path as Uint8Array)).toEqual([0xa3]);
  });

  it('reports the SNR pair and a measured round-trip time on success', async () => {
    const { manager } = makeManager({
      response: { success: true, data: { pathLen: 1, flags: 0, pathSnrs: [40], lastSnr: 7.25 } },
    });
    const result = await manager.pingContactZeroHop(PK);

    expect(result).toMatchObject({
      ok: true,
      hopHash: 'a3',
      snrToTarget: 10, // 40 / 4
      snrFromTarget: 7.25,
    });
    if (result.ok) {
      expect(result.rttMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.rttMs)).toBe(true);
    }
  });

  it('sign-extends the trace SNR byte so a negative link SNR is not read as huge and positive', async () => {
    // -6 dB → int8(-24) → wire byte 0xE8 (232 unsigned). Naive /4 gives +58.
    const { manager } = makeManager({
      response: { success: true, data: { pathLen: 1, flags: 0, pathSnrs: [232], lastSnr: -3.5 } },
    });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snrToTarget).toBe(-6);
      expect(result.snrFromTarget).toBe(-3.5);
    }
  });

  it('returns snrToTarget=null when the reply carries no path SNRs', async () => {
    const { manager } = makeManager({
      response: { success: true, data: { pathLen: 1, flags: 0, pathSnrs: [], lastSnr: 1 } },
    });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snrToTarget).toBeNull();
  });

  it('maps a device/backend failure to reason "no-reply" with an out-of-range message', async () => {
    const { manager } = makeManager({
      response: { success: false, error: 'timeout' },
    });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-reply');
      expect(result.error).toMatch(/direct radio range/i);
    }
  });

  it('maps a thrown bridge error to reason "no-reply" rather than propagating', async () => {
    const { manager } = makeManager({ throws: true });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-reply');
  });

  it('refuses on non-Companion firmware without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-companion');
      expect(result.error).toMatch(/Companion/i);
    }
    expect(bridgeCalls).toHaveLength(0);
  });

  it('refuses when disconnected without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({ connected: false });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('disconnected');
    expect(bridgeCalls).toHaveLength(0);
  });

  it('refuses an unknown contact without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({ knownContact: false });
    const result = await manager.pingContactZeroHop(PK);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-contact');
    expect(bridgeCalls).toHaveLength(0);
  });

  it('refuses a malformed public key without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({});
    const result = await manager.pingContactZeroHop('nothex');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-contact');
    expect(bridgeCalls).toHaveLength(0);
  });
});
