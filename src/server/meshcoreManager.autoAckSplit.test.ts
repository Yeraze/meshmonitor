/**
 * Tests for MeshCore Auto-Acknowledge long-reply handling (#5564).
 *
 * Split OFF (default): one send, truncated server-side to the byte cap for its
 * destination and scope, so the stored row matches what went on air.
 * Split ON: up to 3 ordered sends with "(1/3) " markers, 10 s apart, stopping
 * at the first failed send or when the source turns receive-only.
 *
 * Same stubbing approach as meshcoreManager.autoAckScope.test.ts — no real
 * backend or DB, and nothing is transmitted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';

const SENDER_KEY = 'aa'.repeat(32);
const PART_DELAY_MS = 10_000;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

interface Send { text: string; dest?: string; channel?: number; scope?: string | null; autoRetry?: boolean; }

interface Opts {
  split?: boolean;
  reply: string;
  cooldownSeconds?: number;
  preSendDelaySeconds?: number;
  useDM?: boolean;
  scopeMode?: string;
  scopeName?: string;
  channelScope?: string | null;
  defaultScope?: string | null;
  /** Stub `sendMessage` itself (default). False drives the real send path over a stubbed bridge. */
  stubSendMessage?: boolean;
  /** Result of the Nth (1-based) stubbed send; default true. */
  sendResult?: (n: number) => boolean;
}

function makeManager(opts: Opts) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts.set(SENDER_KEY, { publicKey: SENDER_KEY, advName: 'Alice' });

  const sends: Send[] = [];
  if (opts.stubSendMessage !== false) {
    (m as any).sendMessage = vi.fn(async (text: string, dest?: string, channel?: number, scope?: string | null, autoRetry?: boolean) => {
      sends.push({ text, dest, channel, scope, autoRetry });
      return opts.sendResult ? opts.sendResult(sends.length) : true;
    });
  } else {
    (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
      if (cmd === 'send_message') {
        sends.push({ text: params.text as string, dest: (params.to as string) ?? undefined, channel: params.channel_idx as number | undefined });
      }
      if (cmd === 'get_channels') return { id: '1', success: true, data: [] };
      return { id: '1', success: true, data: {} };
    };
  }

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async (id: number) => ({ id, name: `ch${id}`, scope: opts.channelScope ?? null })),
    updateChannelScope: vi.fn(async () => {}),
    upsertChannel: vi.fn(async () => {}),
    getAllChannels: vi.fn(async () => []),
    deleteChannel: vi.fn(async () => {}),
  } as any);

  const values: Record<string, string | null> = {
    meshcoreAutoAckEnabled: 'true',
    meshcoreAutoAckRegex: '^(test|ping)',
    meshcoreAutoAckChannels: '1',
    meshcoreAutoAckDirectMessages: 'true',
    meshcoreAutoAckCooldownSeconds: String(opts.cooldownSeconds ?? 0),
    meshcoreAutoAckUseDM: String(opts.useDM ?? false),
    meshcoreAutoAckMessage: opts.reply,
    meshcoreAutoAckPreSendDelaySeconds: String(opts.preSendDelaySeconds ?? 0),
    meshcoreAutoAckScopeMode: opts.scopeMode ?? 'inherit',
    meshcoreAutoAckScopeName: opts.scopeName ?? null,
    meshcoreDefaultScope: opts.defaultScope ?? null,
  };
  if (opts.split !== undefined) values.meshcoreAutoAckSplitLongMessages = String(opts.split);
  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async (_sourceId: string, key: string) => (key in values ? values[key] : null)),
    // Channel-send auto-retry opt-in (#3979): off.
    getSettingAsBoolean: vi.fn(async () => false),
    setSourceSetting: vi.fn(async () => {}),
  } as any);

  return { manager: m, sends };
}

function trigger(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'm1',
    fromPublicKey: SENDER_KEY,
    fromName: 'Alice',
    text: 'ping',
    timestamp: Date.now(),
    scopeName: null,
    scopeCode: null,
    ...overrides,
  };
}

const onChannel = (m: MeshCoreManager, msg = trigger()) =>
  (m as any).checkAutoAcknowledge(msg, false, 1, null, null) as Promise<void>;
const asDm = (m: MeshCoreManager, msg = trigger()) =>
  (m as any).checkAutoAcknowledge(msg, true, undefined, null, null) as Promise<void>;

/** 50 words, 339 bytes: three parts on any cap, with room to spare. */
const LONG = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
const body = (part: string) => part.replace(/^\(\d+\/\d+\) /, '');

describe('MeshCoreManager — Auto-Ack long replies (#5564)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('split off (default)', () => {
    it('sends ONE reply truncated to the unscoped channel cap (130 bytes)', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400) });
      await onChannel(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      expect(sends).toHaveLength(1);
      expect(sends[0].text).toBe('x'.repeat(130));
      expect(sends[0].channel).toBe(1);
      expect(sends[0].autoRetry).toBe(true);
    });

    it('treats an explicit "false" the same as an unset key', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400), split: false });
      await onChannel(manager);
      expect(sends.map((s) => s.text)).toEqual(['x'.repeat(130)]);
    });

    it('truncates a DM reply to the DM cap (150 bytes)', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400) });
      await asDm(manager);
      expect(sends).toHaveLength(1);
      expect(sends[0].text).toBe('x'.repeat(150));
      expect(sends[0].dest).toBe(SENDER_KEY);
    });

    it('uses the DM cap for "always respond via DM" on a channel trigger', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400), useDM: true });
      await onChannel(manager);
      expect(sends.map((s) => bytes(s.text))).toEqual([150]);
      expect(sends[0].dest).toBe(SENDER_KEY);
    });

    it.each([
      ['the channel scope', { channelScope: 'berlin' }],
      ['the source default scope', { defaultScope: 'berlin' }],
      ['a named reply scope', { scopeMode: 'named', scopeName: 'lyon' }],
      ['the trigger scope', { scopeMode: 'trigger' }],
    ])('truncates to the scoped channel cap (120 bytes) under %s', async (_label, scopeOpts) => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400), ...scopeOpts });
      await onChannel(manager, trigger({ scopeName: 'lyon', scopeCode: 7 }));
      expect(sends.map((s) => bytes(s.text))).toEqual([120]);
    });

    it('uses the unscoped cap when the reply is forced unscoped over a scoped channel', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400), channelScope: 'berlin', scopeMode: 'unscoped' });
      await onChannel(manager);
      expect(sends.map((s) => bytes(s.text))).toEqual([130]);
    });

    it('never halves a multi-byte character at the cap', async () => {
      // 129 ASCII bytes then an emoji that straddles the 130-byte cap.
      const { manager, sends } = makeManager({ reply: `${'x'.repeat(129)}😀 tail` });
      await onChannel(manager);
      expect(sends.map((s) => s.text)).toEqual(['x'.repeat(129)]);
    });

    it('stores the same text it put on air', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(400), stubSendMessage: false });
      const stored: string[] = [];
      manager.on('message', (msg: MeshCoreMessage) => stored.push(msg.text));
      await onChannel(manager);
      expect(sends.map((s) => s.text)).toEqual(['x'.repeat(130)]);
      expect(stored).toEqual(['x'.repeat(130)]);
    });
  });

  describe('split on', () => {
    it('sends a reply that fits exactly as before: one send, no marker', async () => {
      const { manager, sends } = makeManager({ reply: 'Copy, Alice!', split: true });
      await onChannel(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      expect(sends.map((s) => s.text)).toEqual(['Copy, Alice!']);
    });

    it('sends the parts in order with markers, 10 s apart', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(0);
      expect(sends).toHaveLength(1);

      // Nothing more until the full gap has passed.
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS - 1);
      expect(sends).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sends).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(PART_DELAY_MS - 1);
      expect(sends).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sends).toHaveLength(3);
      await run;

      sends.forEach((s, i) => {
        expect(s.text.startsWith(`(${i + 1}/3) `)).toBe(true);
        expect(bytes(s.text)).toBeLessThanOrEqual(130);
        expect(s.channel).toBe(1);
        // Channel retry stays on for every part (#3979).
        expect(s.autoRetry).toBe(true);
      });
      expect(sends.map((s) => body(s.text)).join(' ')).toBe(LONG);

      // No fourth send, ever.
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      expect(sends).toHaveLength(3);
    });

    it('caps a very long reply at 3 parts and truncates the last', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(2000), split: true });
      const run = asDm(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(3);
      expect(sends.map((s) => bytes(s.text))).toEqual([150, 150, 150]);
      expect(sends.map((s) => s.text.slice(0, 6))).toEqual(['(1/3) ', '(2/3) ', '(3/3) ']);
      expect(sends.every((s) => s.dest === SENDER_KEY)).toBe(true);
    });

    it('budgets each part from the scoped channel cap', async () => {
      const { manager, sends } = makeManager({ reply: 'x'.repeat(2000), split: true, channelScope: 'berlin' });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends.map((s) => bytes(s.text))).toEqual([120, 120, 120]);
    });

    it('passes the same scope override to every part', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, scopeMode: 'named', scopeName: 'lyon' });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(3);
      expect(sends.map((s) => s.scope)).toEqual(['lyon', 'lyon', 'lyon']);
    });

    it('stops at the first failed send', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, sendResult: (n) => n !== 2 });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(2);
      expect(sends[1].text.startsWith('(2/3) ')).toBe(true);
    });

    it('sends nothing more when the first part fails', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, sendResult: () => false });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(1);
    });

    it('stops when the source turns receive-only between parts', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(0);
      expect(sends).toHaveLength(1);

      manager.setReceiveOnly(true);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(1);
    });

    it('sends nothing when the source turns receive-only during the pre-send delay', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, preSendDelaySeconds: 5 });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(1000);
      manager.setReceiveOnly(true);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(0);
    });

    it('starts the parts only after the pre-send delay', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, preSendDelaySeconds: 5 });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(4999);
      expect(sends).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sends).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 2);
      await run;
      expect(sends).toHaveLength(3);
    });

    it('stamps the cooldown once per trigger, not once per part', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, cooldownSeconds: 60 });
      const cooldowns: Map<string, number> = (manager as any).autoAckCooldowns;
      const setSpy = vi.spyOn(cooldowns, 'set');

      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(0);
      const stampedAt = cooldowns.get(`ch1:${SENDER_KEY}`);
      expect(stampedAt).toBeTypeOf('number');

      // A second trigger from the same sender mid-run is still in cooldown.
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS);
      await onChannel(manager);

      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 5);
      await run;
      expect(sends).toHaveLength(3);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(cooldowns.get(`ch1:${SENDER_KEY}`)).toBe(stampedAt);
    });

    it('does not hold the send lock while it waits between parts', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, stubSendMessage: false });
      const run = onChannel(manager);
      await vi.advanceTimersByTimeAsync(0);
      expect(sends).toHaveLength(1);

      // An unrelated send during the gap goes straight out.
      let done = false;
      void manager.sendMessage('hello', undefined, 2).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(sends.map((s) => s.text)).toEqual([sends[0].text, 'hello']);

      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 2);
      await run;
      expect(sends).toHaveLength(4);
    });

    it('stores one row per part, each matching what went on air', async () => {
      const { manager, sends } = makeManager({ reply: LONG, split: true, stubSendMessage: false });
      const stored: string[] = [];
      manager.on('message', (msg: MeshCoreMessage) => stored.push(msg.text));
      const run = asDm(manager);
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS * 2);
      await run;
      expect(sends).toHaveLength(3);
      expect(stored).toEqual(sends.map((s) => s.text));
    });
  });
});
