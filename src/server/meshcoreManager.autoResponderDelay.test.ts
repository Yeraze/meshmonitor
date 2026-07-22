/**
 * Tests for the MeshCore Auto-Responder pre-send delay (#3953).
 *
 * A per-trigger `preSendDelaySeconds` (0–120, clamped) makes the responder
 * wait after a match before sending its reply, so a relaying repeater can
 * finish its own transmission first — mirroring the Auto-Acknowledge pre-send
 * delay (#3876). The delay is applied ONCE per fire (before the text/script
 * branch), not per dispatch.
 *
 * We drive the private `checkAutoResponder` via `(m as any)` with fake timers,
 * mocking only the settings reads and `sendMessage`, mirroring the lightweight
 * access pattern in the sibling auto-responder tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';
import databaseService from '../services/database.js';

function makeManager(triggers: unknown[], enabled = true) {
  const m = new MeshCoreManager('test-source');
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (_sourceId: string, key: string) => {
      if (key === 'meshcoreAutoResponderEnabled') return enabled ? 'true' : 'false';
      if (key === 'meshcoreAutoResponderTriggers') return JSON.stringify(triggers);
      return null;
    },
  );
  const sendMessage = vi.fn().mockResolvedValue(true);
  (m as any).sendMessage = sendMessage;
  return { m, sendMessage };
}

const baseTrigger = {
  id: 't1',
  name: 'ping',
  enabled: true,
  pattern: '^ping',
  responseType: 'text' as const,
  response: 'pong',
  channels: [] as number[],
  listenDMs: true,
  replyAsDM: true,
  cooldownSeconds: 0,
};

const message = {
  id: 'm1',
  fromPublicKey: 'deadbeefcafebabe0011223344556677',
  text: 'ping',
  timestamp: Date.now(),
  snr: 5,
};

describe('Auto-Responder pre-send delay (#3953)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits the configured delay before sending, then sends exactly once', async () => {
    const { m, sendMessage } = makeManager([{ ...baseTrigger, preSendDelaySeconds: 5 }]);

    const done = (m as any).checkAutoResponder(message, true, undefined);
    // Let the synchronous lead-up (settings reads, regex, dispatch build) run.
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).not.toHaveBeenCalled();

    // Not yet at the deadline.
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendMessage).not.toHaveBeenCalled();

    // Cross the 5s deadline → the reply goes out.
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Reply body + DM target (scope override is inherit/undefined here).
    expect(sendMessage.mock.calls[0][0]).toBe('pong');
    expect(sendMessage.mock.calls[0][1]).toBe(message.fromPublicKey);
  });

  it('sends immediately when the delay is 0 / absent', async () => {
    const { m, sendMessage } = makeManager([{ ...baseTrigger, preSendDelaySeconds: 0 }]);
    await (m as any).checkAutoResponder(message, true, undefined);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('clamps an over-max delay to 120s', async () => {
    const { m, sendMessage } = makeManager([{ ...baseTrigger, preSendDelaySeconds: 9999 }]);
    const done = (m as any).checkAutoResponder(message, true, undefined);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
