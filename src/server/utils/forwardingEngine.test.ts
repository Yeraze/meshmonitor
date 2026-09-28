import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ForwardingRateLimiter,
  buildForwardText,
  forwardingNodeIdsMatch,
  isForwardedText,
  parseStoredForwardingRules,
  planForwards,
  runForwarding,
  type ForwardingMessage,
} from './forwardingEngine.js';
import {
  FORWARDED_MARKER,
  FORWARDING_MAX_TEXT_CHARS,
  validateForwardingRules,
  type ForwardingRule,
} from '../../types/forwarding.js';

const dmRule = (over: Partial<ForwardingRule> = {}): ForwardingRule => ({
  id: 'r1',
  name: 'DMs to phone',
  enabled: true,
  match: { isDM: true },
  forwardTo: { destinationNodeId: '!0000beef' },
  prefix: '{from}: ',
  ...over,
});

const chanRule = (over: Partial<ForwardingRule> = {}): ForwardingRule => ({
  id: 'c1',
  name: 'Bridge 1 to 2',
  enabled: true,
  match: { channel: 1 },
  forwardTo: { channel: 2 },
  prefix: '',
  ...over,
});

const dm = (over: Partial<ForwardingMessage> = {}): ForwardingMessage => ({
  text: 'hello there',
  isDM: true,
  channel: null,
  fromNodeId: '!12345678',
  isSelf: false,
  fromName: 'BOB',
  ...over,
});

const onChannel = (channel: number, over: Partial<ForwardingMessage> = {}): ForwardingMessage => ({
  text: 'channel chatter',
  isDM: false,
  channel,
  fromNodeId: '!12345678',
  isSelf: false,
  fromName: 'BOB',
  channelName: `Ch${channel}`,
  ...over,
});

let limiter: ForwardingRateLimiter;
const plan = (rules: ForwardingRule[], message: ForwardingMessage, extra: { canTransmit?: boolean; now?: number } = {}) =>
  planForwards({ sourceId: 'src', rules, message, canTransmit: extra.canTransmit ?? true, now: extra.now ?? 1_000_000, limiter });

beforeEach(() => {
  limiter = new ForwardingRateLimiter();
});

describe('forwardingEngine matching', () => {
  it('forwards a matching DM to the destination node with marker + prefix', () => {
    const p = plan([dmRule()], dm());
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].target).toEqual({ kind: 'dm', nodeId: '!0000beef' });
    expect(p.actions[0].text).toBe(`${FORWARDED_MARKER}BOB: hello there`);
  });

  it('forwards a channel message to another channel and renders {channel}', () => {
    const p = plan([chanRule({ prefix: '#{channel} ' })], onChannel(1));
    expect(p.actions[0].target).toEqual({ kind: 'channel', channel: 2 });
    expect(p.actions[0].text).toBe(`${FORWARDED_MARKER}#Ch1 channel chatter`);
  });

  it('does not match a DM rule against a channel message, or a channel rule against a DM', () => {
    expect(plan([dmRule()], onChannel(1)).actions).toHaveLength(0);
    expect(plan([chanRule()], dm()).actions).toHaveLength(0);
    expect(plan([chanRule()], onChannel(3)).actions).toHaveLength(0);
  });

  it('honours the sender filter, including MeshCore key prefixes', () => {
    expect(plan([dmRule({ match: { isDM: true, fromNodeId: '!12345678' } })], dm()).actions).toHaveLength(1);
    expect(plan([dmRule({ match: { isDM: true, fromNodeId: '!87654321' } })], dm()).actions).toHaveLength(0);
    expect(forwardingNodeIdsMatch('ABCDEF012345', 'abcdef0123456789aa')).toBe(true);
    expect(forwardingNodeIdsMatch('abcd', 'abcdef0123456789')).toBe(false);
  });

  it('honours the text regex (case-insensitive) and skips an unsafe one', () => {
    expect(plan([dmRule({ match: { isDM: true, textRegex: '^HELLO' } })], dm()).actions).toHaveLength(1);
    expect(plan([dmRule({ match: { isDM: true, textRegex: '^bye' } })], dm()).actions).toHaveLength(0);
    const bad = plan([dmRule({ match: { isDM: true, textRegex: '(.*)(.*)' } })], dm());
    expect(bad.actions).toHaveLength(0);
    expect(bad.skipped).toContainEqual({ ruleId: 'r1', reason: 'invalid_regex' });
  });

  it('skips a disabled rule', () => {
    const p = plan([dmRule({ enabled: false })], dm());
    expect(p.actions).toHaveLength(0);
  });
});

describe('forwardingEngine safety guards', () => {
  it('never forwards our own sends (self-origin guard)', () => {
    const p = plan([dmRule()], dm({ isSelf: true }));
    expect(p.actions).toHaveLength(0);
    expect(p.skipped).toContainEqual({ ruleId: '*', reason: 'self_origin' });
  });

  it('never forwards a message that is already a forward', () => {
    const p = plan([dmRule()], dm({ text: `${FORWARDED_MARKER}BOB: hi` }));
    expect(p.actions).toHaveLength(0);
    expect(p.skipped).toContainEqual({ ruleId: '*', reason: 'already_forwarded' });
    expect(isForwardedText('  [FWD] x')).toBe(true);
    expect(isForwardedText('fwd x')).toBe(false);
  });

  it('breaks A->B->A loops: never forwards a DM back to the node it came from', () => {
    const p = plan([dmRule()], dm({ fromNodeId: '!0000BEEF' }));
    expect(p.actions).toHaveLength(0);
    expect(p.skipped).toContainEqual({ ruleId: 'r1', reason: 'from_destination' });
  });

  it('sends nothing when the source cannot transmit (receive-only / TX disabled)', () => {
    const p = plan([dmRule(), chanRule()], dm(), { canTransmit: false });
    expect(p.actions).toHaveLength(0);
    expect(p.skipped).toContainEqual({ ruleId: '*', reason: 'tx_disabled' });
  });

  it('caps each rule at 5 forwards per rolling 60s, then recovers', () => {
    const rule = dmRule();
    const t0 = 5_000_000;
    for (let i = 0; i < 5; i++) {
      expect(plan([rule], dm(), { now: t0 + i * 1000 }).actions).toHaveLength(1);
    }
    const sixth = plan([rule], dm(), { now: t0 + 10_000 });
    expect(sixth.actions).toHaveLength(0);
    expect(sixth.skipped).toContainEqual({ ruleId: 'r1', reason: 'rate_limited' });
    // Still limited just before the first send ages out...
    expect(plan([rule], dm(), { now: t0 + 59_999 }).actions).toHaveLength(0);
    // ...and allowed once it has.
    expect(plan([rule], dm(), { now: t0 + 60_001 }).actions).toHaveLength(1);
  });

  it('limits rules independently and per source', () => {
    const a = dmRule({ id: 'a' });
    const b = dmRule({ id: 'b' });
    for (let i = 0; i < 5; i++) plan([a], dm(), { now: 1 + i });
    expect(plan([a], dm(), { now: 10 }).actions).toHaveLength(0);
    expect(plan([b], dm(), { now: 10 }).actions).toHaveLength(1);
    const other = planForwards({ sourceId: 'other', rules: [a], message: dm(), canTransmit: true, now: 10, limiter });
    expect(other.actions).toHaveLength(1);
  });

  it('a settings re-save (fresh rule objects, same ids) does not reset the window', () => {
    for (let i = 0; i < 5; i++) plan([dmRule()], dm(), { now: 100 + i });
    const resaved = parseStoredForwardingRules(JSON.stringify([dmRule()]));
    expect(plan(resaved, dm(), { now: 200 }).actions).toHaveLength(0);
  });

  it('logs the rate-limit drop once per window, not on every message', () => {
    expect(limiter.shouldLogDrop('k', 0)).toBe(true);
    expect(limiter.shouldLogDrop('k', 30_000)).toBe(false);
    expect(limiter.shouldLogDrop('k', 60_000)).toBe(true);
  });

  it('caps forwarded text at 200 characters including the prefix', () => {
    const long = 'x'.repeat(500);
    const text = buildForwardText(dmRule({ prefix: '{from} says: ' }), dm({ text: long }));
    expect(Array.from(text).length).toBe(FORWARDING_MAX_TEXT_CHARS);
    expect(text.startsWith(`${FORWARDED_MARKER}BOB says: `)).toBe(true);
    expect(text.endsWith('...')).toBe(true);
    const short = buildForwardText(dmRule(), dm({ text: 'hi' }));
    expect(short).toBe(`${FORWARDED_MARKER}BOB: hi`);
  });

  it('does not split an emoji when truncating', () => {
    const text = buildForwardText(dmRule({ prefix: '' }), dm({ text: '\u{1F600}'.repeat(300) }));
    expect(Array.from(text).length).toBe(FORWARDING_MAX_TEXT_CHARS);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('runForwarding', () => {
  it('dispatches each action and swallows send errors', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true);
    const p = await runForwarding({
      sourceId: 'src',
      rules: [dmRule({ id: 'a' }), dmRule({ id: 'b' })],
      message: dm(),
      canTransmit: true,
      limiter,
      send,
    });
    expect(p.actions).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never calls send while receive-only', async () => {
    const send = vi.fn();
    await runForwarding({ sourceId: 'src', rules: [dmRule()], message: dm(), canTransmit: false, limiter, send });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('validateForwardingRules', () => {
  it('accepts a valid rule and drops unknown fields', () => {
    const v = validateForwardingRules([{ ...dmRule(), extra: 1 }]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.rules[0]).not.toHaveProperty('extra');
  });

  it.each([
    ['not an array', {}],
    ['missing name', [{ ...dmRule(), name: '' }]],
    ['both DM and channel', [{ ...dmRule(), match: { isDM: true, channel: 1 } }]],
    ['neither DM nor channel', [{ ...dmRule(), match: {} }]],
    ['two targets', [{ ...dmRule(), forwardTo: { channel: 1, destinationNodeId: '!1' } }]],
    ['no target', [{ ...dmRule(), forwardTo: {} }]],
    ['channel target with no channel picked', [{ ...dmRule(), forwardTo: { channel: null } }]],
    ['channel to itself', [chanRule({ forwardTo: { channel: 1 } })]],
    ['node back to itself', [dmRule({ match: { isDM: true, fromNodeId: '!0000BEEF' } })]],
    ['long prefix', [dmRule({ prefix: 'p'.repeat(41) })]],
    ['duplicate ids', [dmRule(), dmRule()]],
    ['too many rules', Array.from({ length: 21 }, (_, i) => dmRule({ id: `r${i}` }))],
  ])('rejects %s', (_label, input) => {
    expect(validateForwardingRules(input).ok).toBe(false);
  });

  it('names the missing channel when a channel target has none picked', () => {
    const v = validateForwardingRules([{ ...dmRule(), forwardTo: { channel: null } }]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/choose a channel/);
  });

  it('parseStoredForwardingRules returns [] for garbage', () => {
    expect(parseStoredForwardingRules(null)).toEqual([]);
    expect(parseStoredForwardingRules('not json')).toEqual([]);
    expect(parseStoredForwardingRules('{"a":1}')).toEqual([]);
  });
});
