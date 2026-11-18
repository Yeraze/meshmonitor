import { describe, it, expect } from 'vitest';
import {
  buildUnifiedSendRequest,
  buildUnifiedReactionRequest,
  meshcoreRowIdFor,
  meshcoreReplyPrefix,
  senderFitsTarget,
  unifiedSendErrorKind,
  type SenderRef,
} from './unifiedSendRequest';

const mk = (over: Partial<SenderRef>): SenderRef => ({
  sourceId: 'a',
  sourceName: 'A',
  channelNumber: 2,
  canSend: true,
  sendKind: 'meshtastic',
  sendBlockedReason: null,
  reactionsOutbound: null,
  ...over,
});

describe('buildUnifiedSendRequest (#3045 P2)', () => {
  it('meshtastic: uses the ref own slot, source id in the body', () => {
    expect(buildUnifiedSendRequest(mk({}), 'hi')).toEqual({
      endpoint: '/api/messages/send',
      body: { sourceId: 'a', text: 'hi', channel: 2 },
    });
    const other = buildUnifiedSendRequest(mk({ sourceId: 'z', channelNumber: 5 }), 'hi');
    expect(other.body).toEqual({ sourceId: 'z', text: 'hi', channel: 5 });
  });

  it('mqtt_native: passes the virtual channel number, no sourceId in the body', () => {
    const r = buildUnifiedSendRequest(
      mk({ sourceId: 'b', sendKind: 'mqtt_native', channelNumber: 10003 }),
      'hi',
    );
    expect(r.endpoint).toBe('/api/sources/b/mqtt/native/send');
    expect(r.body).toEqual({ text: 'hi', channel: 10003 });
    expect(r.body).not.toHaveProperty('sourceId');
  });

  it('meshcore: sends exactly text and channelIdx', () => {
    const r = buildUnifiedSendRequest(
      mk({ sourceId: 'c', sendKind: 'meshcore', channelNumber: 1 }),
      'hi',
    );
    expect(r.endpoint).toBe('/api/sources/c/meshcore/messages/send');
    expect(r.body).toEqual({ text: 'hi', channelIdx: 1 });
    expect(Object.keys(r.body).sort()).toEqual(['channelIdx', 'text']);
  });

  it('encodes a source id with a slash', () => {
    const r = buildUnifiedSendRequest(mk({ sourceId: 'x/y', sendKind: 'meshcore' }), 'hi');
    expect(r.endpoint).toBe('/api/sources/x%2Fy/meshcore/messages/send');
  });

  it('throws when the ref cannot send', () => {
    expect(() => buildUnifiedSendRequest(mk({ canSend: false }), 'hi')).toThrow();
    expect(() => buildUnifiedSendRequest(mk({ sendKind: null }), 'hi')).toThrow();
  });
});

describe('unifiedSendErrorKind', () => {
  it.each([
    [{ status: 429, code: 'RATE_LIMITED' }, 'rate_limited'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 409, code: 'TX_DISABLED' }, 'tx_disabled'],
    [{ status: 409, code: 'SOURCE_NOT_CONNECTED' }, 'not_connected'],
    [{ status: 409, code: 'NOT_CONNECTED' }, 'not_connected'],
    [{ status: 404, code: 'SOURCE_NOT_FOUND' }, 'not_connected'],
    [{ status: 403, code: 'FORBIDDEN' }, 'forbidden'],
    [{ status: 403 }, 'forbidden'],
    [{ status: 400, code: 'MESSAGE_TOO_LONG' }, 'generic'],
    [{ status: 500 }, 'generic'],
    [new Error('network'), 'generic'],
    [null, 'generic'],
    ['oops', 'generic'],
  ])('%j -> %s', (err, kind) => {
    expect(unifiedSendErrorKind(err)).toBe(kind);
  });
});

describe('replies and tapbacks (#3045 P3)', () => {
  it('meshtastic reply carries replyId from the packet id', () => {
    const r = buildUnifiedSendRequest(mk({}), 'hi', { replyId: 123 });
    expect(r.body).toEqual({ sourceId: 'a', text: 'hi', channel: 2, replyId: 123 });
  });

  it('meshcore ignores reply and tapback options', () => {
    const r = buildUnifiedSendRequest(mk({ sourceId: 'c', sendKind: 'meshcore', channelNumber: 1 }), 'hi', {
      replyId: 5,
      tapback: true,
    });
    expect(r.body).toEqual({ text: 'hi', channelIdx: 1 });
  });

  it('tapback for meshtastic and mqtt_native uses replyId and emoji flag', () => {
    const parent = { packetId: 123, meshcoreRowRefs: undefined };
    expect(buildUnifiedReactionRequest(mk({}), parent, '👍')).toEqual({
      endpoint: '/api/messages/send',
      body: { sourceId: 'a', text: '👍', channel: 2, replyId: 123, emoji: 1 },
    });
    expect(
      buildUnifiedReactionRequest(mk({ sourceId: 'b', sendKind: 'mqtt_native', channelNumber: 10003 }), parent, '👍'),
    ).toEqual({
      endpoint: '/api/sources/b/mqtt/native/send',
      body: { text: '👍', channel: 10003, replyId: 123, emoji: 1 },
    });
    expect(() => buildUnifiedReactionRequest(mk({}), { packetId: null }, '👍')).toThrow();
  });

  it('meshcore tapback targets the reaction route of that source row', () => {
    const ref = mk({ sourceId: 'my src', sendKind: 'meshcore', reactionsOutbound: true });
    const r = buildUnifiedReactionRequest(
      ref,
      { packetId: null, meshcoreRowRefs: ['mc:other:9', 'mc:my src:id:1:x', 'mc:my src:second'] },
      '👍',
    );
    expect(r).toEqual({
      endpoint: '/api/sources/my%20src/meshcore/messages/id%3A1%3Ax/reaction',
      body: { emoji: '👍' },
    });
    expect(() => buildUnifiedReactionRequest(ref, { packetId: null, meshcoreRowRefs: ['mc:other:9'] }, '👍')).toThrow();
  });

  it('meshcoreRowIdFor takes the first match by prefix', () => {
    expect(meshcoreRowIdFor(['mc:a:1', 'mc:a:2'], 'a')).toBe('1');
    expect(meshcoreRowIdFor(['mc:ab:1'], 'a')).toBeNull();
    expect(meshcoreRowIdFor(undefined, 'a')).toBeNull();
  });

  it('meshcoreReplyPrefix frames a name or returns null', () => {
    expect(meshcoreReplyPrefix('Bob')).toBe('@[Bob]: ');
    expect(meshcoreReplyPrefix('')).toBeNull();
    expect(meshcoreReplyPrefix('a]b')).toBeNull();
    expect(meshcoreReplyPrefix('a\nb')).toBeNull();
    expect(meshcoreReplyPrefix(undefined)).toBeNull();
  });

  it('senderFitsTarget filters by protocol and explains MeshCore react limits', () => {
    const mt = mk({});
    const mq = mk({ sendKind: 'mqtt_native' });
    const mc = mk({ sourceId: 'c', sendKind: 'meshcore', reactionsOutbound: true });
    expect(senderFitsTarget(mt, null)).toEqual({ fits: true });
    const mtT = { mode: 'reply' as const, protocol: 'meshtastic' as const };
    expect(senderFitsTarget(mt, mtT).fits).toBe(true);
    expect(senderFitsTarget(mq, mtT).fits).toBe(true);
    expect(senderFitsTarget(mc, mtT)).toEqual({ fits: false });
    const mcReply = { mode: 'reply' as const, protocol: 'meshcore' as const };
    expect(senderFitsTarget(mt, mcReply)).toEqual({ fits: false });
    expect(senderFitsTarget(mc, mcReply).fits).toBe(true);
    const mcReact = { mode: 'react' as const, protocol: 'meshcore' as const, meshcoreRowRefs: ['mc:c:1'] };
    expect(senderFitsTarget(mc, mcReact).fits).toBe(true);
    expect(senderFitsTarget(mk({ sourceId: 'd', sendKind: 'meshcore', reactionsOutbound: true }), mcReact)).toEqual({
      fits: false,
      reason: 'not_heard',
    });
    expect(senderFitsTarget({ ...mc, reactionsOutbound: false }, mcReact)).toEqual({
      fits: false,
      reason: 'reactions_off',
    });
  });

  it.each([
    ['DUPLICATE_REACTION', 'duplicate_reaction'],
    ['REACTIONS_OUTBOUND_DISABLED', 'reactions_off'],
    ['MESSAGE_NOT_FOUND', 'target_missing'],
    ['TARGET_IS_REACTION', 'not_reactable'],
    ['TARGET_IS_ROOM_POST', 'not_reactable'],
    ['TARGET_NO_HASH', 'not_reactable'],
    ['TARGET_NOT_REACTABLE', 'not_reactable'],
    ['INVALID_EMOJI', 'invalid_emoji'],
  ])('maps %s to %s', (code, kind) => {
    expect(unifiedSendErrorKind({ status: 400, code })).toBe(kind);
  });
});
