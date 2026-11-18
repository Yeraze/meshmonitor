import { describe, it, expect } from 'vitest';
import {
  buildUnifiedSendRequest,
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
