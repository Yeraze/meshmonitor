import { describe, it, expect } from 'vitest';
import {
  autoAckIsIp,
  autoAckIsZeroHop,
  autoAckCellKey,
  resolveAutoAckReplyRouting,
} from './autoAckDecision.js';
import { TransportMechanism } from '../constants/meshtastic.js';

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
  it('is false at 0 hops when the transport is MQTT or multicast UDP (#5796)', () => {
    expect(autoAckIsZeroHop(0, false, TransportMechanism.MQTT)).toBe(false);
    expect(autoAckIsZeroHop(0, false, TransportMechanism.MULTICAST_UDP)).toBe(false);
  });
  it('stays true at 0 hops for LoRa and API transports', () => {
    expect(autoAckIsZeroHop(0, false, TransportMechanism.LORA)).toBe(true);
    expect(autoAckIsZeroHop(0, false, TransportMechanism.API)).toBe(true);
    expect(autoAckIsZeroHop(0, false, null)).toBe(true);
  });
});

describe('autoAckIsIp (#5796)', () => {
  it('is true for the legacy viaMqtt flag', () => {
    expect(autoAckIsIp(true)).toBe(true);
    expect(autoAckIsIp(true, TransportMechanism.LORA)).toBe(true);
  });
  it('is true for transport MQTT (5) and MULTICAST_UDP (6)', () => {
    expect(autoAckIsIp(false, 5)).toBe(true);
    expect(autoAckIsIp(undefined, 6)).toBe(true);
  });
  it('is false for API (7), LoRa, internal and unknown transports', () => {
    expect(autoAckIsIp(false, TransportMechanism.API)).toBe(false);
    expect(autoAckIsIp(false, TransportMechanism.LORA)).toBe(false);
    expect(autoAckIsIp(false, TransportMechanism.LORA_ALT1)).toBe(false);
    expect(autoAckIsIp(false, TransportMechanism.INTERNAL)).toBe(false);
    expect(autoAckIsIp(null, null)).toBe(false);
    expect(autoAckIsIp(undefined)).toBe(false);
  });
});

describe('autoAckCellKey', () => {
  it('maps the four RF cells to their settings prefix', () => {
    expect(autoAckCellKey(false, true)).toBe('autoAckChannelZeroHop');
    expect(autoAckCellKey(false, false)).toBe('autoAckChannelMultiHop');
    expect(autoAckCellKey(true, true)).toBe('autoAckDirectZeroHop');
    expect(autoAckCellKey(true, false)).toBe('autoAckDirectMultiHop');
  });
  it('puts IP packets in the Ip row whatever the hop flag (#5796)', () => {
    expect(autoAckCellKey(false, false, true)).toBe('autoAckChannelIp');
    expect(autoAckCellKey(false, true, true)).toBe('autoAckChannelIp');
    expect(autoAckCellKey(true, false, true)).toBe('autoAckDirectIp');
    expect(autoAckCellKey(true, true, true)).toBe('autoAckDirectIp');
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
