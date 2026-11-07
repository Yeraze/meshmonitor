/**
 * MeshCore Timer Triggers — multi-channel send (#6230).
 *
 * A timer can target several channels. runTimerTrigger sends one message per
 * channel, awaited in sequence through the same serialized send path
 * runAutoAnnounceCycle uses, so per-source spacing is reused unchanged and no
 * new cadence or cap is introduced. These tests assert one send per channel,
 * in order, with at most one send in flight at a time (spaced, not bursted),
 * plus back-compat for an old single-`channelIndex` timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';

let seq = 0;

interface SendCall { text: string; toPublicKey?: string; channelIdx?: number; autoRetry?: boolean }

/**
 * A companion whose sendMessage records each call, enforces "only one send in
 * flight" (proving the per-channel sends are serialized/spaced, not a burst),
 * and resolves true.
 */
function companion(sourceId: string) {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  const calls: SendCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  (m as any).sendMessage = vi.fn(async (text: string, toPublicKey?: string, channelIdx?: number, _scope?: unknown, autoRetry?: boolean) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    calls.push({ text, toPublicKey, channelIdx, autoRetry });
    inFlight -= 1;
    return true;
  });
  return { manager: m, calls, getMaxInFlight: () => maxInFlight };
}

describe('MeshCore timer multi-channel send (#6230)', () => {
  let sourceId: string;

  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    sourceId = `timer-mc-${++seq}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const save = (triggers: unknown[]) =>
    databaseService.settings.setSourceSetting(sourceId, 'meshcoreTimerTriggers', JSON.stringify(triggers));

  const textTrigger = (over: Record<string, unknown>) => ({
    id: 't1',
    name: 'beacon',
    enabled: true,
    scheduleType: 'interval',
    intervalMinutes: 60,
    responseType: 'text',
    response: 'hello',
    destination: 'channel',
    ...over,
  });

  it('sends to every selected channel, in order, one at a time (spaced not bursted)', async () => {
    const { manager, calls, getMaxInFlight } = companion(sourceId);
    await save([textTrigger({ channelIndexes: [0, 2] })]);

    const res = await manager.runTimerTrigger('t1');

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.channelIdx)).toEqual([0, 2]);
    // Reuses the per-source serialized send path (auto-announce's spacing):
    // never two channel sends on the air at once.
    expect(getMaxInFlight()).toBe(1);
    // Automated sender opts into channel-send auto-retry (#3979), like auto-announce.
    expect(calls.every((c) => c.autoRetry === true)).toBe(true);
  });

  it('back-compat: an old single-channelIndex timer sends once to that channel', async () => {
    const { manager, calls } = companion(sourceId);
    await save([textTrigger({ channelIndex: 3 })]); // legacy scalar, no channelIndexes

    const res = await manager.runTimerTrigger('t1');

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.channelIdx)).toEqual([3]);
  });

  it('fails cleanly when no channel is selected', async () => {
    const { manager, calls } = companion(sourceId);
    await save([textTrigger({ channelIndexes: [] })]);

    const res = await manager.runTimerTrigger('t1');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no destination configured');
    expect(calls).toHaveLength(0);
  });

  it('a DM timer is unaffected (single contact send)', async () => {
    const { manager, calls } = companion(sourceId);
    await save([textTrigger({ destination: 'dm', contactPublicKey: 'deadbeef', channelIndexes: undefined })]);

    const res = await manager.runTimerTrigger('t1');

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].toPublicKey).toBe('deadbeef');
    expect(calls[0].channelIdx).toBeUndefined();
  });
});
