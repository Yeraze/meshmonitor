/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MeshMessage } from '../../types/message';
import { isReplyTo, isTapbackMessage, isTapbackOf } from '../../utils/messageReplies';
import {
  buildResponseIndex,
  messageRowPropsEqual,
  repliedMessageFor,
  tapbacksFor,
  useNodeNamesToken,
} from './messageRowSupport';

function m(id: string, extra: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id,
    from: '!a',
    to: '^all',
    fromNodeId: '!a',
    toNodeId: '^all',
    text: 'hi',
    channel: 0,
    timestamp: new Date(0),
    ...extra,
  };
}

describe('buildResponseIndex', () => {
  // Covers the quirks the shared rule keeps: emoji flag vs emoji-only text,
  // replyId 0, rows whose id does not end in a packet id, and a duplicate
  // reply key (the first match wins, as with Array.find).
  const list: MeshMessage[] = [
    m('s_1_100', { text: 'parent' }),
    m('s_1_100_dbchan', { text: 'server copy' }),
    m('s_2_101', { text: '👍', emoji: 1, replyId: 100 }),
    m('s_3_102', { text: '🎉', replyId: 100 }),
    m('s_4_103', { text: 'a reply', replyId: 100 }),
    m('s_5_104', { text: 'reply to nothing', replyId: 999 }),
    m('s_6_105', { text: '👍', emoji: 1, replyId: 0 }),
    m('s_7_100', { text: 'same packet id, other sender' }),
    m('s_8_106', { text: '❤️', emoji: 1, replyId: 103 }),
  ];

  it('gives the same tapbacks and quoted parents as the per-row scans', () => {
    const index = buildResponseIndex(list);
    for (const msg of list) {
      expect(tapbacksFor(index, msg)).toEqual(list.filter(x => isTapbackOf(x, msg)));
      if (!isTapbackMessage(msg)) {
        expect(repliedMessageFor(index, msg)).toBe(list.find(x => isReplyTo(msg, x)) ?? null);
      }
    }
  });
});

describe('messageRowPropsEqual', () => {
  const fn = () => {};
  it('treats a re-fetched message (new object, new Date) as equal', () => {
    const a = { msg: m('x', { timestamp: new Date(5) }), reactions: [m('r')], onClick: fn };
    const b = { msg: m('x', { timestamp: new Date(5) }), reactions: [m('r')], onClick: fn };
    expect(messageRowPropsEqual(a, b)).toBe(true);
  });

  it('sees a changed field, Date, reaction or callback', () => {
    const base = { msg: m('x'), reactions: [m('r')], onClick: fn };
    expect(messageRowPropsEqual(base, { ...base, msg: m('x', { deliveryState: 'confirmed' as MeshMessage['deliveryState'] }) })).toBe(false);
    expect(messageRowPropsEqual(base, { ...base, msg: m('x', { timestamp: new Date(1) }) })).toBe(false);
    expect(messageRowPropsEqual(base, { ...base, reactions: [m('r'), m('r2')] })).toBe(false);
    expect(messageRowPropsEqual(base, { ...base, onClick: () => {} })).toBe(false);
  });
});

describe('useNodeNamesToken', () => {
  const nodes = (long: string) => [
    { user: { id: '!a', longName: long, shortName: 'A' }, lastHeard: Math.random() },
    { user: { id: '!b', longName: 'Bob', shortName: 'B' } },
  ];

  it('keeps the token while names are unchanged and replaces it on a rename', () => {
    const { result, rerender } = renderHook(({ list }) => useNodeNamesToken(list), {
      initialProps: { list: nodes('Alice') },
    });
    const first = result.current;
    rerender({ list: nodes('Alice') });
    expect(result.current).toBe(first);
    rerender({ list: nodes('Alicia') });
    expect(result.current).not.toBe(first);
  });
});
