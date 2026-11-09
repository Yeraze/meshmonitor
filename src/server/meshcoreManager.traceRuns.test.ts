/**
 * Trace attempt log (#6276 P14 WP4): every trace a Companion sends is recorded
 * as pending before the frame goes out and settled once as answered, timeout
 * or failed. The tag comes from the manager and is passed to the backend.
 *
 * RF is unchanged: the same single `trace_path` bridge call goes out per trace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import databaseService from '../services/database.js';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const SRC = 'trace-runs-src';
const PK = 'a3' + 'f'.repeat(62);

type Response = { success: boolean; data?: unknown; error?: string };

function makeManager(response: Response, onSend?: () => Promise<void>) {
  const m = new MeshCoreManager(SRC);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([[PK, { publicKey: PK, name: 'Repeater One', outPath: '11,22', pathLen: 2, advType: 2 }]]);
  const bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    await onSend?.();
    return { id: '1', ...response };
  };
  return { manager: m, bridgeCalls };
}

const rows = async () => (await databaseService.meshcoreTraceRuns.getForExplorer(SRC, 0, 100)).runs;
const settle = async (n: number) => {
  for (let i = 0; i < 50; i++) {
    if ((await rows()).length >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('MeshCoreManager trace attempt log (#6276)', () => {
  beforeEach(async () => {
    await databaseService.waitForReady();
    await databaseService.meshcoreTraceRuns.deleteBySourceId(SRC);
  });
  afterEach(async () => {
    await databaseService.meshcoreTraceRuns.deleteBySourceId(SRC);
  });

  it('records an answered trace once, with the tag the backend was given', async () => {
    let pendingDuringSend = -1;
    const { manager, bridgeCalls } = makeManager({ success: true, data: { pathSnrs: [40, 24], lastSnr: 7.25 } }, async () => {
      const raw = await databaseService.meshcoreTraceRuns.getForExplorer(SRC, 0, 10);
      // Pending rows are not listed for the Explorer; the row must exist already.
      pendingDuringSend = raw.runs.length;
    });
    const outcome = await manager.traceContactPathDetailed(PK, { autoReturn: true, origin: 'schedule' });
    expect(outcome.ok).toBe(true);
    await settle(1);
    const [row] = await rows();
    expect(row).toMatchObject({
      sourceId: SRC, traceTag: bridgeCalls[0].params.tag, authCode: 0, targetPublicKey: PK,
      autoReturn: true, origin: 'schedule', status: 'answered', hashBytes: 1,
    });
    expect(row.completedAt).not.toBeNull();
    expect(pendingDuringSend).toBe(0);
    expect(typeof bridgeCalls[0].params.tag).toBe('number');
  });

  it('records a timeout and a device failure', async () => {
    const t = makeManager({ success: false, error: 'x', data: { timed_out: true, wait_ms: 1000, suggested_timeout_ms: 500 } });
    expect(await t.manager.traceContactPathDetailed(PK)).toMatchObject({ ok: false, reason: 'timeout' });
    const f = makeManager({ success: false, error: 'Device rejected trace-path request' });
    expect(await f.manager.traceContactPathDetailed(PK, { origin: 'api' })).toEqual({ ok: false, reason: 'failed' });
    await settle(2);
    const got = await rows();
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.status).sort()).toEqual(['failed', 'timeout']);
    expect(got.find((r) => r.status === 'failed')!.origin).toBe('api');
    expect(got.find((r) => r.status === 'timeout')!.origin).toBe('manual');
  });

  it('does not record a trace that never reaches the radio', async () => {
    const { manager, bridgeCalls } = makeManager({ success: true, data: {} });
    (manager as any).contacts = new Map([[PK, { publicKey: PK, name: 'No path', advType: 2 }]]);
    expect(await manager.traceContactPathDetailed(PK)).toEqual({ ok: false, reason: 'failed' });
    (manager as any).connected = false;
    expect(await manager.traceContactPathDetailed(PK)).toEqual({ ok: false, reason: 'failed' });
    expect(bridgeCalls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(await rows()).toHaveLength(0);
  });

  it('no-transmit pin: one bridge call per trace, same frame inputs plus the tag only', async () => {
    const { manager, bridgeCalls } = makeManager({ success: true, data: { pathSnrs: [40, 24], lastSnr: 7.25 } });
    await manager.traceContactPathDetailed(PK);
    await manager.traceContactPathDetailed(PK, { autoReturn: true });
    expect(bridgeCalls).toHaveLength(2);
    for (const c of bridgeCalls) {
      expect(c.cmd).toBe('trace_path');
      expect(Object.keys(c.params).sort()).toEqual(['path', 'path_hash_bytes', 'tag']);
    }
    expect(bridgeCalls[0].params.tag).not.toBe(bridgeCalls[1].params.tag);
  });

  it('a logging failure never blocks or changes the trace', async () => {
    const { manager, bridgeCalls } = makeManager({ success: true, data: { pathSnrs: [40], lastSnr: 1 } });
    const repo = databaseService.meshcoreTraceRuns;
    const orig = repo.insertPending.bind(repo);
    repo.insertPending = async () => { throw new Error('db down'); };
    try {
      expect((await manager.traceContactPathDetailed(PK)).ok).toBe(true);
      expect(bridgeCalls).toHaveLength(1);
    } finally {
      repo.insertPending = orig;
    }
  });

  it('sweeps pending runs from before startup to timeout', async () => {
    await databaseService.meshcoreTraceRuns.insertPending({
      sourceId: SRC, traceTag: 5, authCode: 0, targetPublicKey: PK, pathHex: '11', hashBytes: 1,
      autoReturn: false, origin: 'manual', sentAt: 1000,
    });
    const { manager } = makeManager({ success: true, data: {} });
    await (manager as any).sweepStaleTraceRuns();
    expect((await rows())[0]).toMatchObject({ traceTag: 5, status: 'timeout' });
  });
});
