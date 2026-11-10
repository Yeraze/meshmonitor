/**
 * runAutoAnnounceCycle with split on / off (#6316).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';

const LONG = 'word '.repeat(70);
let n = 0;

async function setup(split: boolean, failChannel?: number) {
  const sourceId = `announce-split-${++n}`;
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  const calls: number[] = [];
  (m as any).sendMessage = vi.fn(async (_t: string, _d?: string, ch?: number) => { calls.push(ch as number); return ch !== failChannel; });
  const s = databaseService.settings;
  await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceMessage', LONG);
  await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceChannelIndexes', '0,1');
  await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceSplitLongMessages', String(split));
  return { m, calls };
}

describe('runAutoAnnounceCycle split (#6316)', () => {
  beforeEach(() => {
    for (const k of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(logger, k).mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('off: one send per channel', async () => {
    const { m, calls } = await setup(false);
    const r = await m.runAutoAnnounceCycle('manual');
    expect(calls).toEqual([0, 1]);
    expect(r).toEqual({ sent: 2, total: 2 });
  });

  it('on: three parts per channel, part by part', async () => {
    vi.useFakeTimers();
    const { m, calls } = await setup(true);
    const p = m.runAutoAnnounceCycle('manual');
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(calls).toEqual([0, 1, 0, 1, 0, 1]);
    expect(r).toEqual({ sent: 2, total: 2 });
  });

  it('counts only channels where every part went out', async () => {
    vi.useFakeTimers();
    const { m } = await setup(true, 1);
    const p = m.runAutoAnnounceCycle('manual');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toEqual({ sent: 1, total: 2 });
  });
});
