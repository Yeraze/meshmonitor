import { describe, it, expect } from 'vitest';
import {
  autoAckIsZeroHop,
  autoAckCellKey,
  resolveAutoAckReplyRouting,
} from './autoAckDecision.js';

describe('autoAckIsZeroHop', () => {
  it('is true at 0 hops over RF', () => {
    expect(autoAckIsZeroHop(0, false)).toBe(true);
    expect(autoAckIsZeroHop(0, undefined)).toBe(true);
    expect(autoAckIsZeroHop(0, null)).toBe(true);
  });
  it('is false for >0 hops', () => {
    expect(autoAckIsZeroHop(1, false)).toBe(false);
    expect(autoAckIsZeroHop(3, undefined)).toBe(false);
  });
  it('is false for MQTT-relayed packets even at 0 hops', () => {
    expect(autoAckIsZeroHop(0, true)).toBe(false);
  });
});

describe('autoAckCellKey', () => {
  it('maps all four cells to their settings prefix', () => {
    expect(autoAckCellKey(false, true)).toBe('autoAckChannelZeroHop');
    expect(autoAckCellKey(false, false)).toBe('autoAckChannelMultiHop');
    expect(autoAckCellKey(true, true)).toBe('autoAckDirectZeroHop');
    expect(autoAckCellKey(true, false)).toBe('autoAckDirectMultiHop');
  });
});

describe('resolveAutoAckReplyRouting', () => {
  const base = { channelIndex: 2, fromNum: 0x1234abcd, packetId: 999 };

  it('channel reply, DM off → on-channel threaded reply', () => {
    const r = resolveAutoAckReplyRouting({ ...base, isDirectMessage: false, cellReplyDmEnabled: false });
    expect(r).toEqual({ replyViaDm: false, replyDest: 0, replyChannel: 2, replyId: 999 });
  });

  it('channel reply, DM on → DM to sender, cannot thread (replyId cleared)', () => {
    const r = resolveAutoAckReplyRouting({ ...base, isDirectMessage: false, cellReplyDmEnabled: true });
    expect(r).toEqual({ replyViaDm: true, replyDest: 0x1234abcd, replyChannel: undefined, replyId: undefined });
  });

  it('direct reply is inherently a DM and stays threaded regardless of the toggle', () => {
    const off = resolveAutoAckReplyRouting({ ...base, isDirectMessage: true, cellReplyDmEnabled: false });
    expect(off).toEqual({ replyViaDm: true, replyDest: 0x1234abcd, replyChannel: undefined, replyId: 999 });
    const on = resolveAutoAckReplyRouting({ ...base, isDirectMessage: true, cellReplyDmEnabled: true });
    expect(on).toEqual({ replyViaDm: true, replyDest: 0x1234abcd, replyChannel: undefined, replyId: 999 });
  });

  it('passes through an undefined packetId', () => {
    const r = resolveAutoAckReplyRouting({ channelIndex: 0, fromNum: 5, isDirectMessage: false, cellReplyDmEnabled: false });
    expect(r.replyId).toBeUndefined();
  });
});
