/**
 * The shared reply/tapback rule (utils/messageReplies).
 *
 * Two jobs:
 *  1. Characterisation — the predicates must give exactly what ChannelsTab and
 *     MessagesTab computed inline before the rule was lifted out. `legacy*`
 *     below are those expressions, copied verbatim, and every case is run
 *     through both.
 *  2. The table the Auto-Acknowledge response cap relies on.
 */
import { describe, it, expect } from 'vitest';
import { isEmoji } from './text';
import {
  countDistinctResponders,
  isReplyTo,
  isResponseTo,
  isTapbackMessage,
  isTapbackOf,
  replyKeyOfMessageId,
} from './messageReplies';

interface Msg { id: string; text: string; emoji?: number | null; replyId?: number | null; channel?: number }

// ── The views' inline expressions, verbatim from before the refactor ──
const legacyIsReaction = (msg: Msg): boolean =>
  msg.emoji === 1 || (msg.replyId != null && isEmoji(msg.text));
const legacyIsReactionOn = (m: Msg, msg: Msg): boolean =>
  Boolean((m.emoji === 1 || isEmoji(m.text)) && m.replyId && m.replyId.toString() === msg.id.split('_').pop());
// MessagesTab's parent lookup.
const legacyDmParent = (msg: Msg, m: Msg): boolean =>
  Boolean(msg.replyId) && m.id.split('_').pop() === msg.replyId?.toString();
// ChannelsTab's findMessageById.
const legacyChannelParent = (msg: Msg, m: Msg): boolean => {
  if (!msg.replyId) return false;
  const parts = m.id.split('_');
  return parseInt(parts[parts.length - 1] || '0') === msg.replyId;
};

const PARENT: Msg = { id: 'src-a_100_5555', text: 'ping', channel: 0 };

const CASES: Array<{ name: string; msg: Msg; tapback: boolean; reply: boolean }> = [
  { name: 'flagged tapback', msg: { id: 'src-a_200_1', text: '👍', emoji: 1, replyId: 5555 }, tapback: true, reply: false },
  { name: 'flagged tapback with hop-count text (not emoji-only)', msg: { id: 'src-a_200_2', text: '1️⃣', emoji: 1, replyId: 5555 }, tapback: true, reply: false },
  { name: 'emoji-only text with replyId but no flag is still a tapback', msg: { id: 'src-a_200_3', text: '🎉', replyId: 5555 }, tapback: true, reply: false },
  { name: 'text reply', msg: { id: 'src-a_200_4', text: 'Copy, 2 hops', replyId: 5555 }, tapback: false, reply: true },
  { name: 'reply that merely contains an emoji', msg: { id: 'src-a_200_5', text: '🤖 Copy, 2 hops', replyId: 5555 }, tapback: false, reply: true },
  { name: 'plain message', msg: { id: 'src-a_200_6', text: 'hello' }, tapback: false, reply: false },
  { name: 'emoji-only text that answers nothing', msg: { id: 'src-a_200_7', text: '👍' }, tapback: false, reply: false },
  { name: 'reply to a different packet', msg: { id: 'src-a_200_8', text: 'hi', replyId: 5556 }, tapback: false, reply: false },
  { name: 'tapback on a different packet', msg: { id: 'src-a_200_9', text: '👍', emoji: 1, replyId: 5556 }, tapback: false, reply: false },
  { name: 'replyId 0', msg: { id: 'src-a_200_10', text: 'hi', replyId: 0 }, tapback: false, reply: false },
  { name: 'replyId null', msg: { id: 'src-a_200_11', text: 'hi', replyId: null }, tapback: false, reply: false },
  { name: 'emoji flag 0 with replyId is a reply', msg: { id: 'src-a_200_12', text: 'hi', emoji: 0, replyId: 5555 }, tapback: false, reply: true },
  { name: 'emoji flag 2 with plain text is a reply (the views test === 1)', msg: { id: 'src-a_200_13', text: 'hi', emoji: 2, replyId: 5555 }, tapback: false, reply: true },
  { name: 'own node answering (the rule does not look at the sender)', msg: { id: 'src-a_100_14', text: 'me again', replyId: 5555 }, tapback: false, reply: true },
];

describe('messageReplies — same answers as the views gave inline', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isTapbackOf(c.msg, PARENT)).toBe(c.tapback);
      expect(isReplyTo(c.msg, PARENT)).toBe(c.reply);
      expect(isResponseTo(c.msg, PARENT)).toBe(c.tapback || c.reply);

      // Characterisation against the pre-refactor expressions.
      expect(isTapbackMessage(c.msg)).toBe(legacyIsReaction(c.msg));
      expect(isTapbackOf(c.msg, PARENT)).toBe(legacyIsReactionOn(c.msg, PARENT));
      // The views only quote a parent on rows they did not hide as tapbacks.
      const shown = !legacyIsReaction(c.msg);
      expect(isReplyTo(c.msg, PARENT)).toBe(shown && legacyDmParent(c.msg, PARENT));
      expect(isReplyTo(c.msg, PARENT)).toBe(shown && legacyChannelParent(c.msg, PARENT));
    });
  }

  it('a replyId of 0 with emoji text is hidden as a tapback yet attaches to nothing', () => {
    // A quirk of the views, kept: `!= null` hides it, truthiness refuses to attach it.
    const odd: Msg = { id: 'src-a_200_20', text: '👍', replyId: 0 };
    expect(isTapbackMessage(odd)).toBe(true);
    expect(isTapbackOf(odd, { id: 'src-a_100_0' })).toBe(false);
    expect(isResponseTo(odd, { id: 'src-a_100_0' })).toBe(false);
  });

  it('matches the parent on the last id segment only', () => {
    expect(replyKeyOfMessageId('src-a_100_5555')).toBe('5555');
    // A source id with underscores does not confuse it.
    expect(isReplyTo({ text: 'hi', replyId: 5555 }, { id: 'my_src_100_5555' })).toBe(true);
    // The `_dbchan` / `_radio` copies of a server-decrypted row never match.
    expect(isResponseTo({ text: 'hi', replyId: 5555 }, { id: 'src-a_100_5555_dbchan' })).toBe(false);
    // The sender part of the id is not the key.
    expect(isResponseTo({ text: 'hi', replyId: 100 }, PARENT)).toBe(false);
  });

  it('does not look at channel, source or MQTT origin — the caller\'s lookup does', () => {
    const viaMqtt = { text: '👍', emoji: 1, replyId: 5555, channel: 3, viaMqtt: true };
    expect(isTapbackOf(viaMqtt, PARENT)).toBe(true);
  });
});

describe('countDistinctResponders', () => {
  const row = (fromNodeNum: number, over: Partial<Msg> = {}) =>
    ({ fromNodeNum, text: '👍', emoji: 1, replyId: 5555, ...over });

  it('counts nodes, not packets: a tapback plus a reply from one node is one', () => {
    const rows = [row(1), row(1, { text: 'Copy', emoji: null }), row(2, { text: 'Copy', emoji: null })];
    expect(countDistinctResponders(PARENT, rows)).toBe(2);
  });

  it('counts replies only, tapbacks only, and a mix', () => {
    expect(countDistinctResponders(PARENT, [row(1, { text: 'a', emoji: null }), row(2, { text: 'b', emoji: null })])).toBe(2);
    expect(countDistinctResponders(PARENT, [row(1), row(2), row(3)])).toBe(3);
    expect(countDistinctResponders(PARENT, [row(1), row(2, { text: 'b', emoji: null })])).toBe(2);
  });

  it('leaves out excluded nodes and rows that answer something else', () => {
    const rows = [row(1), row(9), row(3, { replyId: 4444 }), row(4, { replyId: null, emoji: null, text: 'hi' })];
    expect(countDistinctResponders(PARENT, rows, [9, null, undefined])).toBe(1);
  });

  it('treats a bigint-as-string node number and a number as the same node', () => {
    expect(countDistinctResponders(PARENT, [row(7), { ...row(7), fromNodeNum: '7' }])).toBe(1);
  });
});
