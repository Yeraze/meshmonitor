/**
 * MeshCoreManager trace outcomes (#5588): a trace that ran out its wait is
 * reported as a timeout with the time waited, sent once, and never retried.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { MESHCORE_TRACE_BRIDGE_TIMEOUT_MS } from './constants/meshcoreFirmwareTimeout.js';

const PK = 'a3' + 'f'.repeat(62);

function makeManager(response: { success: boolean; data?: unknown; error?: string }) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([[PK, { publicKey: PK, name: 'Repeater One', outPath: '11,22', pathLen: 2 }]]);
  const bridgeCalls: { cmd: string; params: Record<string, unknown>; timeout: number }[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>, timeout: number) => {
    bridgeCalls.push({ cmd, params, timeout });
    return { id: '1', ...response };
  };
  return { manager: m, bridgeCalls };
}

const TIMED_OUT = {
  success: false,
  error: 'trace_path timed out',
  data: { timed_out: true, wait_ms: 11_000, suggested_timeout_ms: 2_500 },
};

describe('MeshCoreManager — trace timeout (#5588)', () => {
  it('reports a timeout with the wait and the firmware hint', async () => {
    const { manager, bridgeCalls } = makeManager(TIMED_OUT);
    const outcome = await manager.traceContactPathDetailed(PK);

    expect(outcome).toEqual({ ok: false, reason: 'timeout', waitMs: 11_000, suggestedTimeoutMs: 2_500 });
    // One trace per call: a timeout is not retried.
    expect(bridgeCalls).toHaveLength(1);
  });

  it('passes no timeout_ms, so the backend applies the firmware-hint policy', async () => {
    const { manager, bridgeCalls } = makeManager(TIMED_OUT);
    await manager.traceContactPathDetailed(PK);

    expect(bridgeCalls[0].cmd).toBe('trace_path');
    expect(bridgeCalls[0].params.timeout_ms).toBeUndefined();
    // The bridge ceiling sits above the longest backend wait.
    expect(bridgeCalls[0].timeout).toBe(MESHCORE_TRACE_BRIDGE_TIMEOUT_MS);
  });

  it('reports every other failure as failed', async () => {
    const { manager } = makeManager({ success: false, error: 'Device rejected trace-path request' });
    expect(await manager.traceContactPathDetailed(PK)).toEqual({ ok: false, reason: 'failed' });
  });

  it('returns the hops on success', async () => {
    const { manager } = makeManager({ success: true, data: { pathSnrs: [40, 24], lastSnr: 7.25 } });
    const outcome = await manager.traceContactPathDetailed(PK);
    expect(outcome).toMatchObject({ ok: true, lastSnr: 7.25, hops: [{ index: 0, snr: 10 }, { index: 1, snr: 6 }] });
  });

  it('traceContactPath keeps returning null on a timeout (automation callers)', async () => {
    const { manager, bridgeCalls } = makeManager(TIMED_OUT);
    expect(await manager.traceContactPath(PK)).toBeNull();
    expect(bridgeCalls).toHaveLength(1);
  });

  it('zero-hop ping treats a timeout as no-reply and sends once', async () => {
    const { manager, bridgeCalls } = makeManager(TIMED_OUT);
    const result = await manager.pingContactZeroHop(PK);
    expect(result).toMatchObject({ ok: false, reason: 'no-reply' });
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].timeout).toBe(MESHCORE_TRACE_BRIDGE_TIMEOUT_MS);
  });
});
