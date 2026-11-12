/**
 * Required Repeaters gate auto-retry pause (4.17.3 review L3).
 *
 * When the gate alone drives the #3979 channel auto-retry (some repeater was
 * heard, just not the required one) and the gate is still unmet one echo
 * window after the resend, gate-driven retries on that channel pause for an
 * hour with one warning. A zero-heard miss always retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';

const REQUIRED = 'cc'.repeat(32);
const WINDOW = 30_000;
const HOUR = 60 * 60 * 1000;

interface BridgeCall { cmd: string; params: Record<string, unknown> }

function makeManager(heard: { value: Array<{ repeaterHash: string }> }) {
  const m = new MeshCoreManager('gate-src');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  // The required repeater is a known relay contact, so its hash resolves.
  (m as any).contacts = new Map([[REQUIRED, { publicKey: REQUIRED, advType: 2 }]]);
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    return { id: '1', success: true, data: {} };
  };
  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({ getChannelById: vi.fn(async () => null) } as any);
  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async (_s: string, key: string) => {
      if (key === 'meshcoreRequiredRepeaters') return JSON.stringify([REQUIRED]);
      if (key === 'meshcoreRequiredRepeaterMode') return 'any';
      return null;
    }),
    setSourceSetting: vi.fn(async () => {}),
    getSettingAsBoolean: vi.fn(async () => true),
  } as any);
  vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessage').mockImplementation((async () => heard.value) as any);
  const sends = () => calls.filter((c) => c.cmd === 'send_message');
  return { manager: m, sends };
}

describe('Required Repeaters gate retry pause (L3)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const gateWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('pausing gate-driven retries'));

  it('pauses gate retries on the channel for an hour after a retry leaves the gate unmet, warning once', async () => {
    const heard = { value: [{ repeaterHash: 'ab' }] }; // a relay, not the required one
    const { manager, sends } = makeManager(heard);

    await manager.sendMessage('one', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW); // gate unmet → resend
    expect(sends()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WINDOW); // re-check: still unmet → pause
    expect(gateWarnings()).toHaveLength(1);

    // Next automated send on the same channel: gate unmet, but paused → no resend.
    await manager.sendMessage('two', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    expect(sends()).toHaveLength(3);
    expect(gateWarnings()).toHaveLength(1);

    // Another channel is not paused.
    await manager.sendMessage('three', undefined, 1, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(sends()).toHaveLength(5);
    expect(sends()[4].params.channel_idx).toBe(1);

    // A zero-heard miss on the paused channel still retries (#3979).
    heard.value = [];
    await manager.sendMessage('four', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(sends()).toHaveLength(7);

    // After the hour, gate retries on channel 0 resume.
    heard.value = [{ repeaterHash: 'ab' }];
    await vi.advanceTimersByTimeAsync(HOUR);
    const before = sends().length;
    await manager.sendMessage('five', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(sends()).toHaveLength(before + 2);
  });

  it('does not pause when the resend satisfies the gate', async () => {
    const heard = { value: [{ repeaterHash: 'ab' }] };
    const { manager, sends } = makeManager(heard);

    await manager.sendMessage('one', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(sends()).toHaveLength(2);
    heard.value = [{ repeaterHash: 'ab' }, { repeaterHash: 'cc' }]; // the required repeater relayed the resend
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(gateWarnings()).toHaveLength(0);

    heard.value = [{ repeaterHash: 'ab' }];
    await manager.sendMessage('two', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(sends()).toHaveLength(4);
  });
});
