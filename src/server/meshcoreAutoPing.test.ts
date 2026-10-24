/**
 * MeshCore Auto Ping controller (#5953): the `ping N` / `ping stop` session
 * logic, driven through a fake host with fake timers. No radio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MeshCoreAutoPingController,
  isAutoPingOutputText,
  type AutoPingHost,
  type MeshCoreAutoPingResult,
} from './meshcoreAutoPing.js';
import { MESHCORE_MAX_MESSAGE_BYTES_DM } from './constants/meshcoreMessageLimits.js';

const REQ_KEY = 'ab'.repeat(32);
const REQ_PREFIX = REQ_KEY.substring(0, 12);

interface FakeHost extends AutoPingHost {
  settings: Record<string, string>;
  pings: Array<{ text: string; publicKey: string }>;
  replies: string[];
  failed: Array<[string, number]>;
  direct: boolean;
  companion: boolean;
  transmit: boolean;
  own: boolean;
  nextCrc: number;
  estTimeoutMs: number | undefined;
  meshTx: number;
}

function makeHost(over: Partial<FakeHost> = {}): FakeHost {
  const host: FakeHost = {
    sourceId: 'src-test',
    settings: { autoPingEnabled: 'true' },
    pings: [],
    replies: [],
    failed: [],
    direct: true,
    companion: true,
    transmit: true,
    own: false,
    nextCrc: 1000,
    estTimeoutMs: undefined,
    meshTx: 0,
    isCompanion: () => host.companion,
    canTransmit: () => host.transmit,
    isConnected: () => true,
    isOwnKey: () => host.own,
    resolveContact: (prefix: string) =>
      REQ_KEY.startsWith(prefix.toLowerCase())
        ? { publicKey: REQ_KEY, name: 'Mobile', direct: host.direct }
        : undefined,
    getSetting: async (key: string) => host.settings[key] ?? null,
    sendPing: async (text: string, publicKey: string) => {
      host.pings.push({ text, publicKey });
      const crc = host.nextCrc++;
      return { ok: true, ackCrc: crc, estTimeoutMs: host.estTimeoutMs, messageId: `msg-${crc}` };
    },
    sendReply: async (text: string) => {
      host.replies.push(text);
      return true;
    },
    markPingFailed: (id: string, crc: number) => { host.failed.push([id, crc]); },
    recordMeshTx: () => { host.meshTx++; },
    ...over,
  };
  return host;
}

describe('MeshCoreAutoPingController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts a session on "ping N" and sends the first ping after one interval', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    expect(await c.handleCommand(REQ_PREFIX, 'ping 3')).toBe(true);
    expect(host.replies[0]).toBe('Starting 3 pings every 30s. Send "ping stop" to cancel.');
    expect(c.getSessions()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(host.pings).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.pings).toEqual([{ text: 'Ping 1/3', publicKey: REQ_KEY }]);
  });

  it('clamps the count to the max pings setting', async () => {
    const host = makeHost({ settings: { autoPingEnabled: 'true', autoPingMaxPings: '5' } });
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'PING 50');
    expect(host.replies[0]).toBe('Starting 5 pings every 30s (capped to 5). Send "ping stop" to cancel.');
    expect(c.getSessions()[0].totalPings).toBe(5);
  });

  it('defaults to a 20-ping cap and refuses a zero count', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 0');
    expect(host.replies).toEqual(['Ping count must be at least 1.']);
    expect(c.getSessions()).toHaveLength(0);
    await c.handleCommand(REQ_PREFIX, 'ping 99');
    expect(c.getSessions()[0].totalPings).toBe(20);
  });

  it('spaces pings by the configured interval and waits for the pending ping', async () => {
    const host = makeHost({ settings: { autoPingEnabled: 'true', autoPingIntervalSeconds: '10', autoPingTimeoutSeconds: '25' } });
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 3');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.pings).toHaveLength(1);
    // Ping 1 is still waiting for its ACK: ticks at 20 s and 30 s send nothing.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.pings).toHaveLength(1);
    // Timed out at 35 s; the next tick (40 s) sends ping 2.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.pings.map(p => p.text)).toEqual(['Ping 1/3', 'Ping 2/3']);
  });

  it('records an ACK with the firmware trip time and the route', async () => {
    const host = makeHost({ direct: true });
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 2');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.handleSendConfirmed(1000, 1234)).toBe(true);
    const s = c.getSessions()[0];
    expect(s.successfulPings).toBe(1);
    expect(s.directPings).toBe(1);
    expect(s.results[0]).toMatchObject({ pingNum: 1, status: 'ack', durationMs: 1234, route: 'direct' });
    // A second confirm for the same code is not ours any more.
    expect(c.handleSendConfirmed(1000, 50)).toBe(false);
  });

  it('records flood when the contact has no known path', async () => {
    const host = makeHost({ direct: false });
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 1');
    await vi.advanceTimersByTimeAsync(30_000);
    c.handleSendConfirmed(1000, 900);
    expect(c.getSessions()[0].results[0].route).toBe('flood');
    expect(c.getSessions()[0].floodPings).toBe(1);
  });

  it('records a timeout and marks the ping message failed', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 2');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const s = c.getSessions()[0];
    expect(s.failedPings).toBe(1);
    expect(s.results[0].status).toBe('timeout');
    expect(host.failed).toEqual([['msg-1000', 1000]]);
    // A late ACK after the timeout changes nothing.
    expect(c.handleSendConfirmed(1000, 70_000)).toBe(false);
  });

  it('uses the firmware timeout when it is longer than the setting', async () => {
    const host = makeHost({ estTimeoutMs: 90_000 });
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 2');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.getSessions()[0].failedPings).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.getSessions()[0].failedPings).toBe(1);
  });

  it('sends the summary after the last ping and ends the session', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 2');
    await vi.advanceTimersByTimeAsync(30_000);
    c.handleSendConfirmed(1000, 800);
    host.direct = false;
    await vi.advanceTimersByTimeAsync(30_000);
    c.handleSendConfirmed(1001, 1200);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.getSessions()).toHaveLength(0);
    expect(host.replies.at(-1)).toBe('Auto-ping done: 2/2 ok\nMin/Avg/Max: 800/1000/1200ms\nDirect: 1 Flood: 1');
    // No more pings once it ended.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.pings).toHaveLength(2);
  });

  it('"ping stop" cancels with the Meshtastic reply text', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 5');
    await vi.advanceTimersByTimeAsync(30_000);
    c.handleSendConfirmed(1000, 500);
    expect(await c.handleCommand(REQ_PREFIX, 'ping stop')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSessions()).toHaveLength(0);
    expect(host.replies.at(-1)).toBe('Auto-ping cancelled: 1/1 successful out of 5 planned. Direct: 1 Flood: 0');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(host.pings).toHaveLength(1);
  });

  it('"ping stop" with no session says so', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    expect(await c.handleCommand(REQ_PREFIX, 'ping stop')).toBe(true);
    expect(host.replies).toEqual(['No active ping session to stop.']);
  });

  it('refuses a second session from the same requester', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 5');
    expect(await c.handleCommand(REQ_PREFIX, 'ping 3')).toBe(true);
    expect(host.replies.at(-1)).toBe('You already have an active ping session. Send "ping stop" to cancel it first.');
    expect(c.getSessions()).toHaveLength(1);
    expect(c.getSessions()[0].totalPings).toBe(5);
  });

  it('does nothing when disabled', async () => {
    const host = makeHost({ settings: {} });
    const c = new MeshCoreAutoPingController(host);
    expect(await c.handleCommand(REQ_PREFIX, 'ping 5')).toBe(false);
    expect(host.replies).toHaveLength(0);
    expect(c.getSessions()).toHaveLength(0);
  });

  it('ignores the command on a Repeater source', async () => {
    const host = makeHost({ companion: false });
    const c = new MeshCoreAutoPingController(host);
    expect(await c.handleCommand(REQ_PREFIX, 'ping 5')).toBe(false);
    expect(host.replies).toHaveLength(0);
  });

  it('ignores the command when receive-only', async () => {
    const host = makeHost({ transmit: false });
    const c = new MeshCoreAutoPingController(host);
    expect(await c.handleCommand(REQ_PREFIX, 'ping 5')).toBe(false);
    expect(host.replies).toHaveLength(0);
  });

  it('never takes a command from one of our own nodes', async () => {
    const host = makeHost({ own: true });
    const c = new MeshCoreAutoPingController(host);
    expect(await c.handleCommand(REQ_PREFIX, 'ping 5')).toBe(false);
    expect(c.getSessions()).toHaveLength(0);
  });

  it('never parses its own output as a command', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    const outputs = [
      'Ping 3/20',
      'Starting 3 pings every 30s. Send "ping stop" to cancel.',
      'Auto-ping done: 2/2 ok\nMin/Avg/Max: 1/2/3ms\nDirect: 1 Flood: 1',
      'Auto-ping cancelled: 1/1 successful out of 5 planned.',
      'No active ping session to stop.',
      'You already have an active ping session. Send "ping stop" to cancel it first.',
      'Ping count must be at least 1.',
    ];
    for (const text of outputs) {
      expect(await c.handleCommand(REQ_PREFIX, text), text).toBe(false);
      expect(isAutoPingOutputText(text), text).toBe(true);
    }
    expect(host.replies).toHaveLength(0);
    expect(isAutoPingOutputText('ping 5')).toBe(false);
    expect(isAutoPingOutputText('ping')).toBe(false);
  });

  it('clearAll drops every session and timer without sending', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 5');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.pings).toHaveLength(1);
    const repliesBefore = host.replies.length;
    c.clearAll();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(host.pings).toHaveLength(1);
    expect(host.replies).toHaveLength(repliesBefore);
    expect(c.getSessions()).toHaveLength(0);
  });

  it('stamps the shared mesh-TX clock on every send', async () => {
    const host = makeHost();
    const c = new MeshCoreAutoPingController(host);
    await c.handleCommand(REQ_PREFIX, 'ping 1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.meshTx).toBe(2); // start reply + ping 1
  });

  it('keeps the worst-case summary under the DM byte cap', () => {
    const results: MeshCoreAutoPingResult[] = Array.from({ length: 100 }, (_, i) => ({
      pingNum: i + 1,
      status: i % 2 === 0 ? 'ack' : 'timeout',
      durationMs: i % 2 === 0 ? 999_999 : undefined,
      sentAt: 0,
      route: i % 3 === 0 ? 'direct' : 'flood',
    }));
    const summary = MeshCoreAutoPingController.buildSummary(results, 100);
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(MESHCORE_MAX_MESSAGE_BYTES_DM);
    expect(summary).toContain('Timeouts: 50');
    expect(summary).toContain('Direct: 34 Flood: 66');
  });
});
