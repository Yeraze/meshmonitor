/**
 * MeshCore Auto Ping (#5953) wired into the manager: a received `ping N` DM
 * starts a session, each ping is ONE DM (no #3977 retry cadence), the
 * firmware `send_confirmed` push settles it, disconnect clears every timer,
 * a Repeater ignores the command, and Auto-Acknowledge / Auto-Responder never
 * answer an Auto Ping DM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

const REQ_KEY = 'cd'.repeat(32);
const REQ_PREFIX = REQ_KEY.substring(0, 12);
const LOCAL_KEY = 'ee'.repeat(32);

function makeManager(opts: { settings?: Record<string, string>; deviceType?: MeshCoreDeviceType; outPathKnown?: boolean } = {}) {
  const m = new MeshCoreManager('autoping-source');
  (m as any).deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).nativeBackend = { disconnect: vi.fn(async () => {}) };
  (m as any).localNode = { publicKey: LOCAL_KEY, name: 'Base' };
  (m as any).contacts = new Map([
    [REQ_KEY, {
      publicKey: REQ_KEY,
      advName: 'Mobile',
      pathLen: opts.outPathKnown === false ? null : 1,
      outPath: opts.outPathKnown === false ? null : 'a3',
    }],
  ]);
  (m as any).addMessage = vi.fn(async () => true);
  (m as any).persistContact = vi.fn(async () => {});

  const settings: Record<string, string> = {
    autoPingEnabled: 'true',
    autoPingIntervalSeconds: '10',
    autoPingTimeoutSeconds: '10',
    autoPingMaxPings: '20',
    ...opts.settings,
  };

  const bridgeCalls: BridgeCall[] = [];
  /** ack CRC the fake radio gave each DM text (last one wins). */
  const crcByText = new Map<string, number>();
  let crc = 500;
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'send_message') {
      if (!params.to) return { id: '1', success: true, data: {} };
      const code = crc++;
      crcByText.set(String(params.text), code);
      return { id: '1', success: true, data: { expectedAckCrc: code, estTimeout: 4000 } };
    }
    return { id: '1', success: true, data: {} };
  };

  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async (_s: string, key: string) => settings[key] ?? null),
    getSettingAsBoolean: vi.fn(async () => false),
    getSetting: vi.fn(async () => null),
    setSourceSetting: vi.fn(async () => {}),
  } as any);
  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async () => null),
    getAllChannels: vi.fn(async () => []),
  } as any);

  return { m, bridgeCalls, settings, crcByText };
}

function receiveDm(m: MeshCoreManager, text: string, prefix = REQ_PREFIX): void {
  (m as any).handleBridgeEvent({
    event_type: 'contact_message',
    data: { pubkey_prefix: prefix, text, path_len: 1, sender_timestamp: Math.floor(Date.now() / 1000) },
  });
}

function sendConfirmed(m: MeshCoreManager, ackCode: number, rtt = 700): void {
  (m as any).handleBridgeEvent({ event_type: 'send_confirmed', data: { ack_code: ackCode, round_trip_ms: rtt } });
}

const dmTexts = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message' && c.params.to).map(c => String(c.params.text));

describe('MeshCoreManager — Auto Ping (#5953)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts a session from a received "ping N" DM and records an ACK with RTT', async () => {
    const { m, bridgeCalls, crcByText } = makeManager();
    receiveDm(m, 'ping 2');
    await vi.advanceTimersByTimeAsync(0);
    const startText = 'Starting 2 pings every 10s. Send "ping stop" to cancel.';
    expect(dmTexts(bridgeCalls)).toEqual([startText]);
    sendConfirmed(m, crcByText.get(startText)!); // the reply is acked

    await vi.advanceTimersByTimeAsync(10_000);
    expect(dmTexts(bridgeCalls).at(-1)).toBe('Ping 1/2');
    const pingCrc = crcByText.get('Ping 1/2')!;
    // The ping is a single attempt: no #3977 retry is armed for it.
    expect((m as any).pendingDmRetries.has(pingCrc)).toBe(false);

    sendConfirmed(m, pingCrc, 1500);
    const [s] = m.getAutoPingSessions();
    expect(s.results[0]).toMatchObject({ status: 'ack', durationMs: 1500, route: 'direct' });
  });

  it('records flood when the contact has no out path, and a ping never retries', async () => {
    const { m, bridgeCalls, crcByText } = makeManager({ outPathKnown: false });
    receiveDm(m, 'ping 1');
    await vi.advanceTimersByTimeAsync(0);
    // Ack the start reply so its own (normal) DM retry cadence stays quiet.
    sendConfirmed(m, crcByText.get('Starting 1 pings every 10s. Send "ping stop" to cancel.')!);
    await vi.advanceTimersByTimeAsync(10_000);
    // Timeout (10 s) passes with no ACK: no resend, no reset_path.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dmTexts(bridgeCalls).filter(t => t.startsWith('Ping '))).toEqual(['Ping 1/1']);
    expect(bridgeCalls.some(c => c.cmd === 'reset_path')).toBe(false);
    // The next tick ends the session and sends the summary.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dmTexts(bridgeCalls).at(-1)).toBe('Auto-ping done: 0/1 ok\nTimeouts: 1\nDirect: 0 Flood: 1');
  });

  it('does nothing when Auto Ping is disabled', async () => {
    const { m, bridgeCalls } = makeManager({ settings: { autoPingEnabled: 'false' } });
    receiveDm(m, 'ping 5');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dmTexts(bridgeCalls)).toEqual([]);
    expect(m.getAutoPingSessions()).toEqual([]);
  });

  it('a Repeater source ignores "ping"', async () => {
    const { m } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    expect(await (m as any).autoPing.handleCommand(REQ_PREFIX, 'ping 5')).toBe(false);
    expect(m.getAutoPingSessions()).toEqual([]);
  });

  it('ignores a ping command from our own local node', async () => {
    const { m, bridgeCalls } = makeManager();
    receiveDm(m, 'ping 5', LOCAL_KEY.substring(0, 12));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dmTexts(bridgeCalls)).toEqual([]);
  });

  it('disconnect clears every session timer and sends nothing more', async () => {
    const { m, bridgeCalls } = makeManager();
    receiveDm(m, 'ping 5');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.getAutoPingSessions()).toHaveLength(1);
    const sent = dmTexts(bridgeCalls).length;
    await m.disconnect();
    expect(m.getAutoPingSessions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(dmTexts(bridgeCalls)).toHaveLength(sent);
  });

  it('a settings save does not start a session', async () => {
    const { m, settings } = makeManager({ settings: { autoPingEnabled: 'false' } });
    settings.autoPingEnabled = 'true';
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.getAutoPingSessions()).toEqual([]);
  });

  it('a force-stop from the UI ends the session with the summary', async () => {
    const { m, bridgeCalls } = makeManager();
    receiveDm(m, 'ping 5');
    await vi.advanceTimersByTimeAsync(0);
    expect(m.stopAutoPingSession(REQ_KEY)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(dmTexts(bridgeCalls).at(-1)).toBe('Auto-ping force_stopped: 0/0 successful out of 5 planned.');
    expect(m.stopAutoPingSession(REQ_KEY)).toBe(false);
  });

  it('the ping command skips the Auto-Responder', async () => {
    const { m, settings } = makeManager();
    settings.meshcoreAutoResponderEnabled = 'true';
    settings.meshcoreAutoResponderTriggers = JSON.stringify([{
      id: 't', enabled: true, pattern: '^ping', response: 'pong', channels: [], listenDMs: true, replyAsDM: true, cooldownSeconds: 0,
    }]);
    const responder = vi.spyOn(m as any, 'checkAutoResponder');
    receiveDm(m, 'ping 2');
    await vi.advanceTimersByTimeAsync(0);
    expect(responder).not.toHaveBeenCalled();
  });

  it('Auto-Acknowledge and Auto-Responder never answer an Auto Ping DM', async () => {
    // Real timers: the reply path awaits real database reads.
    vi.useRealTimers();
    const { m, settings } = makeManager();
    const sent: string[] = [];
    (m as any).sendMessage = vi.fn(async (text: string) => { sent.push(text); return true; });
    Object.assign(settings, {
      autoPingEnabled: 'false',
      meshcoreAutoAckEnabled: 'true',
      meshcoreAutoAckDirectMessages: 'true',
      meshcoreAutoResponderEnabled: 'true',
      meshcoreAutoResponderTriggers: JSON.stringify([{
        id: 't', enabled: true, pattern: '^(ping|auto)', response: 'pong', channels: [], listenDMs: true, replyAsDM: true, cooldownSeconds: 0,
      }]),
    });
    for (const text of ['Ping 3/20', 'Auto-ping done: 2/2 ok\nDirect: 2 Flood: 0', 'Starting 5 pings every 30s. Send "ping stop" to cancel.']) {
      receiveDm(m, text);
    }
    // Control: an ordinary "ping" is still acknowledged and answered. Once its
    // two replies are out, the earlier DMs have had every chance to reply too.
    receiveDm(m, 'ping');
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(2);
    expect(sent).toContain('pong');
  });
});
