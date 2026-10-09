/**
 * Auto-Acknowledge: random 5-30 s wait and "Maximum number of responses".
 *
 * A channel message that matches is held for a random 5-30 s. When the wait
 * ends MeshMonitor counts the other nodes that have replied to or tapbacked
 * that message (same rule the message views render with) and sends nothing if
 * the count has reached the cap. Everything here runs on fake timers against a
 * mocked queue: nothing can reach a radio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';
import {
  AUTO_ACK_MAX_PENDING,
  AUTO_ACK_RESPONSE_WAIT_MAX_MS,
  AUTO_ACK_RESPONSE_WAIT_MIN_MS,
} from './autoAckResponseCap.js';

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn(),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      getActiveNodes: vi.fn().mockResolvedValue([]),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
    },
    messages: {
      getReplyCandidates: vi.fn().mockResolvedValue([]),
      getMessage: vi.fn(),
    },
  },
}));

// One queue mock PER manager, so two sources can be told apart.
vi.mock('./messageQueueService.js', () => {
  function MessageQueueService() {
    return {
      enqueue: vi.fn(),
      setSendCallback: vi.fn(),
      clear: vi.fn(),
      getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
    } as any;
  }
  return { messageQueueService: MessageQueueService(), MessageQueueService };
});

const LOCAL = 0x0a0a0a0a;
const SENDER = 0x11223344;
const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const CHANNEL = 2;

type SettingsTable = Record<string, string | null>;

const baseSettings = (over: SettingsTable = {}): SettingsTable => ({
  autoAckEnabled: 'true',
  autoAckRegex: '^ping',
  autoAckChannels: String(CHANNEL),
  autoAckCooldownSeconds: '0',
  autoAckChannelZeroHopTapbackEnabled: 'true',
  autoAckChannelMultiHopTapbackEnabled: 'true',
  autoAckDirectZeroHopTapbackEnabled: 'true',
  ...over,
});

/** Per-source settings tables; anything unlisted reads null (so the cap is its default, 2). */
let tables: Record<string, SettingsTable>;

function makeManager(sourceId = SOURCE_A, random = 0): any {
  const manager: any = new MeshtasticManager(sourceId);
  manager.isConnected = true;
  manager.actualDeviceConfig = { lora: { txEnabled: true } };
  manager.localNodeInfo = { nodeNum: LOCAL, nodeId: '!0a0a0a0a' };
  manager.autoAckRandom = () => random;
  manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(false);
  manager.replaceAcknowledgementTokens = vi.fn().mockResolvedValue('Copy');
  return manager;
}

let nextPacketId = 1000;

/** Feed one inbound message through the real auto-ack path. Returns its packet id. */
async function receive(
  manager: any,
  opts: { packetId?: number; from?: number; dm?: boolean; text?: string } = {},
): Promise<number> {
  const packetId = opts.packetId ?? nextPacketId++;
  const from = opts.from ?? SENDER;
  await manager.checkAutoAcknowledge(
    { id: `${manager.sourceId}_${from}_${packetId}`, fromNodeId: '!11223344', hopStart: 3, hopLimit: 3, timestamp: 1_700_000_000_000 },
    opts.text ?? 'ping',
    CHANNEL,
    opts.dm === true,
    from,
    packetId,
  );
  return packetId;
}

const enqueueOf = (manager: any) => manager.messageQueue.enqueue as ReturnType<typeof vi.fn>;

/** A stored answer to `packetId` from `fromNodeNum`. */
const tapback = (fromNodeNum: number, packetId: number) =>
  ({ id: `${SOURCE_A}_${fromNodeNum}_${fromNodeNum}1`, fromNodeNum, text: '👍', emoji: 1, replyId: packetId });
const reply = (fromNodeNum: number, packetId: number) =>
  ({ id: `${SOURCE_A}_${fromNodeNum}_${fromNodeNum}2`, fromNodeNum, text: 'Copy, 1 hops', emoji: null, replyId: packetId });

const candidates = () => vi.mocked(databaseService.messages.getReplyCandidates);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  tables = { [SOURCE_A]: baseSettings(), [SOURCE_B]: baseSettings() };
  vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(
    async (sourceId: any, key: string) => tables[sourceId as string]?.[key] ?? null,
  );
  vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
  candidates().mockResolvedValue([]);
  // The trigger row exists unless a test deletes it.
  vi.mocked(databaseService.messages.getMessage).mockImplementation(async (id: string) => ({ id }) as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the wait', () => {
  it('sends nothing before the wait ends, then sends once', async () => {
    const manager = makeManager(SOURCE_A, 0); // shortest wait: 5 s
    await receive(manager);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTO_ACK_RESPONSE_WAIT_MIN_MS - 1);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1); // no second try
  });

  it.each([
    [0, 5_000],
    [0.5, 17_500],
    [0.999999, 30_000],
  ])('random %f waits %i ms, inside [5 s, 30 s]', async (random, expectedMs) => {
    const manager = makeManager(SOURCE_A, random);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await receive(manager);
    const waits = spy.mock.calls.map((c) => c[1] as number);
    spy.mockRestore();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBe(expectedMs);
    expect(waits[0]).toBeGreaterThanOrEqual(AUTO_ACK_RESPONSE_WAIT_MIN_MS);
    expect(waits[0]).toBeLessThanOrEqual(AUTO_ACK_RESPONSE_WAIT_MAX_MS);
  });

  it('a longer Pre-Send Delay replaces the 5 s floor and keeps the 25 s spread', async () => {
    tables[SOURCE_A].autoAckPreSendDelaySeconds = '20';
    const manager = makeManager(SOURCE_A, 0.5);
    await receive(manager);
    await vi.advanceTimersByTimeAsync(32_499); // 20 s + half of the 25 s spread
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('a direct message is answered at once, with no wait and no count', async () => {
    const manager = makeManager();
    await receive(manager, { dm: true });
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
    expect(candidates()).not.toHaveBeenCalled();
    expect(manager.pendingAutoAcks.size).toBe(0);
  });

  it('what is sent is unchanged: same emoji, channel, replyId, one attempt', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    await vi.advanceTimersByTimeAsync(30_000);
    const args = enqueueOf(manager).mock.calls[0];
    expect(args[1]).toBe(0);          // channel broadcast
    expect(args[2]).toBe(packetId);   // reacts to the trigger
    expect(args[5]).toBe(CHANNEL);
    expect(args[6]).toBe(1);          // tapbacks never retry
    expect(args[7]).toBe(1);          // emoji flag
  });
});

describe('the cap (default 2)', () => {
  it.each([
    [0, true],
    [1, true],
    [2, false],
    [3, false],
  ])('%i other responder(s) → sends: %s', async (others, sends) => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue(
      Array.from({ length: others }, (_, i) => tapback(0x500 + i, packetId)),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(sends ? 1 : 0);
  });

  it('counts replies only', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue([reply(0x501, packetId), reply(0x502, packetId)]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('counts a mix of one reply and one tapback from two nodes', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue([reply(0x501, packetId), tapback(0x502, packetId)]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('one node sending a tapback AND a reply is one response', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue([tapback(0x501, packetId), reply(0x501, packetId)]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('answers that arrive DURING the wait are counted', async () => {
    const manager = makeManager(SOURCE_A, 0.999999); // 30 s
    const packetId = await receive(manager);
    await vi.advanceTimersByTimeAsync(24_000);
    // Nothing has been read yet: the count happens when the wait ends.
    expect(candidates()).not.toHaveBeenCalled();
    candidates().mockResolvedValue([tapback(0x501, packetId), reply(0x502, packetId)]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(candidates()).toHaveBeenCalledTimes(1);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('our own send and the trigger author never count', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue([
      tapback(LOCAL, packetId), reply(LOCAL, packetId), // our own sends, back off the bus
      reply(SENDER, packetId),                          // the author following up
      tapback(0x501, packetId),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('rows that answer a different packet do not count', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue([tapback(0x501, packetId + 1), tapback(0x502, packetId + 1)]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('asks only for this source, this channel and this packet id', async () => {
    const manager = makeManager(SOURCE_B);
    const packetId = await receive(manager);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(candidates()).toHaveBeenCalledTimes(1);
    expect(candidates()).toHaveBeenCalledWith(SOURCE_B, packetId, CHANNEL);
  });

  it('cap 0 = no cap: always sends, still after the wait, without counting', async () => {
    tables[SOURCE_A].autoAckMaxResponses = '0';
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue(Array.from({ length: 9 }, (_, i) => tapback(0x500 + i, packetId)));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
    expect(candidates()).not.toHaveBeenCalled();
  });

  it('when the cap is reached neither the tapback nor the reply is sent', async () => {
    tables[SOURCE_A].autoAckChannelMultiHopReplyEnabled = 'true';
    tables[SOURCE_A].autoAckChannelZeroHopReplyEnabled = 'true';
    const quiet = makeManager();
    const p1 = await receive(quiet);
    candidates().mockResolvedValue([tapback(0x501, p1), tapback(0x502, p1)]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(quiet)).not.toHaveBeenCalled();

    const loud = makeManager();
    candidates().mockResolvedValue([]);
    await receive(loud);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(loud)).toHaveBeenCalledTimes(2); // tapback + reply, as before
  });

  it('reads the cap with the source scope: two sources, two caps', async () => {
    tables[SOURCE_A].autoAckMaxResponses = '1';
    tables[SOURCE_B].autoAckMaxResponses = '5';
    const a = makeManager(SOURCE_A);
    const b = makeManager(SOURCE_B);
    const packetId = 7777;
    await receive(a, { packetId });
    await receive(b, { packetId });
    candidates().mockResolvedValue([tapback(0x501, packetId)]);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(enqueueOf(a)).not.toHaveBeenCalled();   // 1 >= cap 1
    expect(enqueueOf(b)).toHaveBeenCalledTimes(1); // 1 <  cap 5
    const reads = vi.mocked(databaseService.settings.getSettingForSource).mock.calls
      .filter((c) => c[1] === 'autoAckMaxResponses').map((c) => c[0]);
    expect(reads.sort()).toEqual([SOURCE_A, SOURCE_B]);
    // Never the bare, unscoped key (#5080).
    expect(vi.mocked(databaseService.settings.getSetting).mock.calls.map((c) => c[0]))
      .not.toContain('autoAckMaxResponses');
  });

  it('a trigger with no packet id cannot be answered by anyone, so it is sent after the wait without a count', async () => {
    const manager = makeManager();
    await manager.checkAutoAcknowledge(
      { id: `${SOURCE_A}_${SENDER}_1700000000000`, fromNodeId: '!11223344', hopStart: 3, hopLimit: 3, timestamp: 1_700_000_000_000 },
      'ping', CHANNEL, false, SENDER, undefined,
    );
    // Heard twice with the same timestamp: still one waiting response.
    await manager.checkAutoAcknowledge(
      { id: `${SOURCE_A}_${SENDER}_1700000000000`, fromNodeId: '!11223344', hopStart: 3, hopLimit: 3, timestamp: 1_700_000_000_000 },
      'ping', CHANNEL, false, SENDER, undefined,
    );
    expect(manager.pendingAutoAcks.size).toBe(1);
    tables[SOURCE_A].autoAckChannelZeroHopReplyEnabled = 'true'; // a tapback needs a packet id; a reply does not
    await vi.advanceTimersByTimeAsync(30_000);
    expect(candidates()).not.toHaveBeenCalled();
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a count that throws sends nothing', async () => {
    const manager = makeManager();
    await receive(manager);
    candidates().mockRejectedValue(new Error('db gone'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });
});

describe('gates are asked again when the wait ends', () => {
  it('disconnected by then → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.isConnected = false; // link state only; timers left armed on purpose
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('TX disabled by then (receive-only radio) → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.actualDeviceConfig = { lora: { txEnabled: false } };
    expect(manager.canTransmit()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('TX disabled but a UDP relay still carries sends → not receive-only, sends', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.actualDeviceConfig = { lora: { txEnabled: false } };
    manager.isUdpBroadcastRelayEnabled = () => true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('airtime cutoff engaged by then → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('Auto-Acknowledge switched off during the wait → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    tables[SOURCE_A].autoAckEnabled = 'false';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('a dropped response is never retried later', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
    expect(manager.pendingAutoAcks.size).toBe(0);
  });

  it('a disconnect that lands while the count is being read → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    candidates().mockImplementation(async () => {
      manager.disconnect();
      return [];
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });
});

describe('pending timers', () => {
  it('the same trigger heard twice arms one timer and sends once', async () => {
    const manager = makeManager();
    await receive(manager, { packetId: 4242 });
    await receive(manager, { packetId: 4242 }); // relayed copy / RF + MQTT
    expect(manager.pendingAutoAcks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it('a burst of 200 matching messages arms at most AUTO_ACK_MAX_PENDING and sends that many', async () => {
    const manager = makeManager();
    for (let i = 0; i < 200; i++) await receive(manager, { from: 0x2000 + i });
    expect(manager.pendingAutoAcks.size).toBe(AUTO_ACK_MAX_PENDING);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(AUTO_ACK_MAX_PENDING);
    // The dropped ones are gone for good.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(AUTO_ACK_MAX_PENDING);
  });

  it('a trigger dropped for want of a slot does not use up its sender\'s cooldown', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '60';
    const manager = makeManager();
    for (let i = 0; i < AUTO_ACK_MAX_PENDING; i++) await receive(manager, { from: 0x2000 + i });
    await receive(manager, { from: 0x9999 });
    expect(manager.autoAckCooldowns.has(0x9999)).toBe(false);
    expect(manager.autoAckCooldowns.size).toBe(AUTO_ACK_MAX_PENDING);
  });

  it('the cooldown is taken when the response is armed, so the wait cannot slip past it', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '60';
    const manager = makeManager();
    await receive(manager);
    await receive(manager); // same sender, new packet, 0 s later
    await receive(manager);
    expect(manager.pendingAutoAcks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disconnect()', (m: any) => m.disconnect()],
    ['source removal / shutdown (stop())', (m: any) => m.stop()],
    ['unexpected transport loss', (m: any) => m.clearPendingAutoAcks()],
  ])('%s clears every waiting response with zero sends', async (_name, act) => {
    const manager = makeManager();
    for (let i = 0; i < 5; i++) await receive(manager, { from: 0x2000 + i });
    expect(manager.pendingAutoAcks.size).toBe(5);
    await act(manager);
    expect(manager.pendingAutoAcks.size).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('a busy channel cannot hold the slots forever: all are free again after one window', async () => {
    const manager = makeManager(SOURCE_A, 0.999999);
    for (let i = 0; i < 50; i++) await receive(manager, { from: 0x2000 + i });
    expect(manager.pendingAutoAcks.size).toBe(AUTO_ACK_MAX_PENDING);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.pendingAutoAcks.size).toBe(0);
    await receive(manager, { from: 0x7000 });
    expect(manager.pendingAutoAcks.size).toBe(1);
  });

  it('a slot is freed even when the response is dropped at send time', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.pendingAutoAcks.size).toBe(0);
  });

  it('handleDisconnected and userDisconnect both clear waiting responses', () => {
    const src = MeshtasticManager.prototype as any;
    for (const name of ['handleDisconnected', 'userDisconnect']) {
      expect(String(src[name]), name).toContain('clearPendingAutoAcks()');
    }
  });

  it('nothing waiting survives into a new connection', async () => {
    const manager = makeManager();
    await receive(manager);
    manager.disconnect();
    manager.isConnected = true; // reconnected inside the old wait
    await vi.advanceTimersByTimeAsync(600_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });
});

describe('cooldown and the wait', () => {
  const at = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms - (Date.now() - t0)); };
  let t0 = 0;
  beforeEach(() => { t0 = Date.now(); });

  it('cooldown (10 s) SHORTER than the wait (30 s): one answer, and the window restarts at the send', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '10';
    const manager = makeManager(SOURCE_A, 0.999999); // 30 s wait
    await receive(manager);                 // t=0   armed
    await at(12_000); await receive(manager); // t=12  cooldown over, but a response is still waiting
    await at(24_000); await receive(manager); // t=24  same
    expect(manager.pendingAutoAcks.size).toBe(1);

    await at(30_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);

    await at(35_000); await receive(manager); // 5 s after the SEND: still cooling down
    expect(manager.pendingAutoAcks.size).toBe(0);

    await at(40_001); await receive(manager); // 10 s after the send: allowed again
    expect(manager.pendingAutoAcks.size).toBe(1);

    await at(120_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(2);
    // The two sends were 40 s apart — never closer than the 10 s cooldown.
  });

  it('cooldown (120 s) LONGER than the wait: one answer per window, and it does not starve', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '120';
    const manager = makeManager(SOURCE_A, 0); // 5 s wait
    await receive(manager);                    // t=0, sends at t=5
    await at(5_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);

    for (const t of [20_000, 60_000, 124_000]) { // 124 s is past arm+120 but not send+120
      await at(t); await receive(manager);
      expect(manager.pendingAutoAcks.size).toBe(0);
    }
    await at(125_001); await receive(manager);
    expect(manager.pendingAutoAcks.size).toBe(1);
    await at(131_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(2);
  });

  it('a response skipped for the cap does not push the cooldown out', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '60';
    const manager = makeManager(SOURCE_A, 0.999999);
    const packetId = await receive(manager); // reserved at t=0
    candidates().mockResolvedValue([tapback(0x501, packetId), tapback(0x502, packetId)]);
    await at(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
    candidates().mockResolvedValue([]);
    await at(60_001); await receive(manager); // 60 s after the ARM, not after a send that never was
    expect(manager.pendingAutoAcks.size).toBe(1);
  });

  it('cooldown 0 (disabled): every message from one node may wait at once, up to the slot limit', async () => {
    const manager = makeManager();
    await receive(manager); await receive(manager); await receive(manager);
    expect(manager.pendingAutoAcks.size).toBe(3);
  });

  it('other senders are not held back by one sender\'s waiting response', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '60';
    const manager = makeManager();
    await receive(manager, { from: 0x3001 });
    await receive(manager, { from: 0x3002 });
    expect(manager.pendingAutoAcks.size).toBe(2);
  });
});

describe('the response follows the settings as they are when the wait ends', () => {
  it('regex changed so the message no longer matches → dropped', async () => {
    const manager = makeManager();
    await receive(manager, { text: 'ping' });
    tables[SOURCE_A].autoAckRegex = '^hello';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('channel removed from the list → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    tables[SOURCE_A].autoAckChannels = '0';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('sender added to the ignore list → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    tables[SOURCE_A].autoAckIgnoredNodes = '!11223344';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('the matrix cell switched off → dropped', async () => {
    const manager = makeManager();
    await receive(manager);
    tables[SOURCE_A].autoAckChannelZeroHopTapbackEnabled = 'false';
    tables[SOURCE_A].autoAckChannelMultiHopTapbackEnabled = 'false';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('the trigger message was deleted during the wait → dropped', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    vi.mocked(databaseService.messages.getMessage).mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(databaseService.messages.getMessage)).toHaveBeenCalledWith(`${SOURCE_A}_${SENDER}_${packetId}`);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('a cap lowered during the wait applies to the response already waiting', async () => {
    const manager = makeManager();
    const packetId = await receive(manager);
    candidates().mockResolvedValue([tapback(0x501, packetId)]);
    tables[SOURCE_A].autoAckMaxResponses = '1';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();
  });

  it('a hop limit or reply switched on during the wait is what gets sent', async () => {
    const manager = makeManager();
    await receive(manager);
    tables[SOURCE_A].autoAckHopLimit = '1';
    tables[SOURCE_A].autoAckChannelZeroHopReplyEnabled = 'true';
    await vi.advanceTimersByTimeAsync(30_000);
    const calls = enqueueOf(manager).mock.calls;
    expect(calls).toHaveLength(2);            // tapback + the newly enabled reply
    expect(calls.every((c: any[]) => c[8] === 1)).toBe(true); // current hop limit
  });

  it('the settings a response is armed under are read again, not remembered', async () => {
    const manager = makeManager();
    await receive(manager);
    const reads = () => vi.mocked(databaseService.settings.getSettingForSource).mock.calls
      .filter((c) => c[1] === 'autoAckRegex').length;
    const before = reads();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toBe(before + 1);
  });
});

describe('a settings save', () => {
  it('neither fires nor re-arms a waiting response, and leaves the cooldown alone', async () => {
    tables[SOURCE_A].autoAckCooldownSeconds = '60';
    const manager = makeManager(SOURCE_A, 0.999999); // 30 s
    await receive(manager);
    const cooldownBefore = manager.autoAckCooldowns.get(SENDER);
    const timerBefore = [...manager.pendingAutoAcks.values()][0].timer;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // Save half way through the wait: every auto-ack key rewritten.
    await vi.advanceTimersByTimeAsync(15_000);
    tables[SOURCE_A] = baseSettings({ autoAckCooldownSeconds: '60', autoAckMaxResponses: '4', autoAckRegex: '^(ping|test)' });

    expect(enqueueOf(manager)).not.toHaveBeenCalled();            // did not fire
    expect(setTimeoutSpy).not.toHaveBeenCalled();                 // did not re-arm
    expect([...manager.pendingAutoAcks.values()][0].timer).toBe(timerBefore);
    expect(manager.autoAckCooldowns.get(SENDER)).toBe(cooldownBefore);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(enqueueOf(manager)).not.toHaveBeenCalled();            // original deadline kept
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);          // fired once
    setTimeoutSpy.mockRestore();

    // The sender is still cooling down after the save.
    await vi.advanceTimersByTimeAsync(59_000);
    await receive(manager);
    expect(manager.pendingAutoAcks.size).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(enqueueOf(manager)).toHaveBeenCalledTimes(1);          // not twice
  });
});
