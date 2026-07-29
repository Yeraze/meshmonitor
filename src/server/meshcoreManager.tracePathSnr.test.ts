/**
 * Tests for MeshCoreManager.traceContactPath() per-hop SNR sign handling.
 *
 * Follow-up to #4393: the zero-hop ping added there sign-extends its trace SNR
 * byte, but traceContactPath — the older multi-hop trace that walks a contact's
 * cached out_path — still divided the raw byte, so a negative link SNR came out
 * large and positive.
 *
 * The asymmetry is in meshcore.js itself (src/connection/connection.js): a
 * TraceData frame's `lastSnr` is decoded with `readInt8() / 4` (signed, already
 * dB) while `pathSnrs` is a plain `readBytes(pathLen)` — raw UNSIGNED bytes of
 * an int8 × 4. meshcoreNativeBackend passes those through verbatim
 * (`Array.from(result.pathSnrs)`), so the sign extension has to happen here.
 *
 * Uses the private-method-stubbing pattern from meshcoreManager.zeroHopPing.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const PK = 'a3' + 'f'.repeat(62);

function makeManager(opts: {
  response?: { success: boolean; data?: unknown; error?: string };
  outPath?: string;
  pathLen?: number;
}): { manager: MeshCoreManager; bridgeCalls: { cmd: string }[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([
    [
      PK,
      {
        publicKey: PK,
        name: 'Repeater One',
        outPath: opts.outPath ?? '11,22',
        pathLen: opts.pathLen ?? 2,
      },
    ],
  ]);

  const bridgeCalls: { cmd: string }[] = [];
  (m as any).sendBridgeCommand = async (cmd: string) => {
    bridgeCalls.push({ cmd });
    return {
      id: '1',
      ...(opts.response ?? {
        success: true,
        data: { pathLen: 2, flags: 0, pathSnrs: [40, 24], lastSnr: 7.25 },
      }),
    };
  };

  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — traceContactPath per-hop SNR sign', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('scales positive per-hop SNR bytes to dB', async () => {
    const { manager } = makeManager({
      response: { success: true, data: { pathSnrs: [40, 24], lastSnr: 7.25 } },
    });
    const result = await manager.traceContactPath(PK);

    expect(result).not.toBeNull();
    expect(result!.hops).toEqual([
      { index: 0, snr: 10 }, // 40 / 4
      { index: 1, snr: 6 }, // 24 / 4
    ]);
    expect(result!.lastSnr).toBe(7.25);
  });

  it('sign-extends a negative hop SNR instead of reporting a huge positive value', async () => {
    // -6 dB → int8(-24) → wire byte 0xE8 (232 unsigned). A naive /4 gives +58.
    const { manager } = makeManager({
      response: { success: true, data: { pathSnrs: [232], lastSnr: -3.5 } },
    });
    const result = await manager.traceContactPath(PK);

    expect(result).not.toBeNull();
    expect(result!.hops).toEqual([{ index: 0, snr: -6 }]);
    // lastSnr arrives already signed and scaled from meshcore.js — untouched.
    expect(result!.lastSnr).toBe(-3.5);
  });

  it('handles a mixed path where some hops are negative and some positive', async () => {
    // 0xFF → -1 → -0.25 dB; 0x80 → -128 → -32 dB (the most negative int8).
    const { manager } = makeManager({
      response: { success: true, data: { pathSnrs: [40, 255, 128], lastSnr: 0 } },
    });
    const result = await manager.traceContactPath(PK);

    expect(result!.hops).toEqual([
      { index: 0, snr: 10 },
      { index: 1, snr: -0.25 },
      { index: 2, snr: -32 },
    ]);
  });

  it('keeps 0x7F as the largest positive value rather than wrapping it negative', async () => {
    const { manager } = makeManager({
      response: { success: true, data: { pathSnrs: [127], lastSnr: 0 } },
    });
    const result = await manager.traceContactPath(PK);

    expect(result!.hops).toEqual([{ index: 0, snr: 31.75 }]);
  });

  it('returns no hops when the reply carries an empty SNR array', async () => {
    const { manager } = makeManager({
      response: { success: true, data: { pathSnrs: [], lastSnr: 2 } },
    });
    const result = await manager.traceContactPath(PK);

    expect(result!.hops).toEqual([]);
    expect(result!.lastSnr).toBe(2);
  });

  it('returns null when the contact has no cached path, without transmitting', async () => {
    const { manager, bridgeCalls } = makeManager({});
    (manager as any).contacts.set(PK, { publicKey: PK, name: 'No Route' });

    expect(await manager.traceContactPath(PK)).toBeNull();
    expect(bridgeCalls).toHaveLength(0);
  });
});
