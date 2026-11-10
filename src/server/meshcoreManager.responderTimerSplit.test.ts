/**
 * Auto Responder and Timer Triggers: split vs truncate, scripts (#6316).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';

const LONG = 'word '.repeat(70);
const GAP = 10_000;

function responderManager(triggers: unknown[]) {
  const m = new MeshCoreManager('resp-split');
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(async (_s: string, key: string) => {
    if (key === 'meshcoreAutoResponderEnabled') return 'true';
    if (key === 'meshcoreAutoResponderTriggers') return JSON.stringify(triggers);
    return null;
  });
  const sendMessage = vi.fn().mockResolvedValue(true);
  (m as any).sendMessage = sendMessage;
  return { m, sendMessage };
}

const trig = {
  id: 't1', name: 'ping', enabled: true, pattern: '^ping', responseType: 'text' as const,
  response: LONG, channels: [] as number[], listenDMs: true, replyAsDM: true, cooldownSeconds: 0,
};
const msg = { id: 'm1', fromPublicKey: 'deadbeefcafebabe0011223344556677', text: 'ping', timestamp: Date.now(), snr: 5 };

describe('Auto Responder split (#6316)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('truncates to one send when multiline is off', async () => {
    const { m, sendMessage } = responderManager([trig]);
    await (m as any).checkAutoResponder(msg, true, undefined);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(sendMessage.mock.calls[0][0])).toBeLessThanOrEqual(160);
  });

  it('sends up to 3 marked parts when multiline is on', async () => {
    const { m, sendMessage } = responderManager([{ ...trig, multiline: true }]);
    const done = (m as any).checkAutoResponder(msg, true, undefined);
    await vi.advanceTimersByTimeAsync(GAP * 3);
    await done;
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[0][0].startsWith('(1/3)')).toBe(true);
  });

  it('script with several messages truncates each, a single message splits', async () => {
    const { m, sendMessage } = responderManager([]);
    (m as any).canTransmit = () => true;
    const many = { dispatchCalls: [] as Array<[string, boolean | undefined]> };
    const dispatch = async (t: string, allow?: boolean) => { many.dispatchCalls.push([t, allow]); return true; };
    const scriptRunner = await import('./utils/scriptRunner.js');
    const spy = vi.spyOn(scriptRunner, 'runScript');
    spy.mockResolvedValueOnce({ success: true, wouldSendMessages: ['a', 'b'] } as any);
    await (m as any).runMeshCoreScript('s.sh', '', {}, dispatch, 'x');
    spy.mockResolvedValueOnce({ success: true, wouldSendMessages: ['only', ' '] } as any);
    await (m as any).runMeshCoreScript('s.sh', '', {}, dispatch, 'x');
    expect(many.dispatchCalls).toEqual([['a', false], ['b', false], ['only', true]]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('Timer Triggers split (#6316)', () => {
  let sid = 0;
  beforeEach(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function run(over: Record<string, unknown>) {
    const sourceId = `timer-split-${++sid}`;
    const m = new MeshCoreManager(sourceId);
    (m as any).deviceType = MeshCoreDeviceType.COMPANION;
    (m as any).connected = true;
    const calls: Array<{ text: string; ch?: number }> = [];
    (m as any).sendMessage = vi.fn(async (text: string, _d?: string, ch?: number) => { calls.push({ text, ch }); return true; });
    await databaseService.settings.setSourceSetting(sourceId, 'meshcoreTimerTriggers', JSON.stringify([{
      id: 't1', name: 'b', enabled: true, scheduleType: 'interval', intervalMinutes: 60,
      responseType: 'text', response: LONG, destination: 'channel', channelIndexes: [0, 2], ...over,
    }]));
    return { m, calls };
  }

  it('off: one truncated send per channel', async () => {
    const { m, calls } = await run({});
    const r = await m.runTimerTrigger('t1');
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.ch)).toEqual([0, 2]);
  });

  it('on: part by part across channels', async () => {
    vi.useFakeTimers();
    const { m, calls } = await run({ multiline: true });
    const p = m.runTimerTrigger('t1');
    await vi.advanceTimersByTimeAsync(GAP * 3);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.ch)).toEqual([0, 2, 0, 2, 0, 2]);
  });
});
