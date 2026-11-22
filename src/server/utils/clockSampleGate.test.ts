import { describe, it, expect } from 'vitest';
import { isClockSampleEligible, type ClockSampleGateInput } from './clockSampleGate.js';
import { MIN_PLAUSIBLE_UNIX_SEC } from './replayGuard.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW = NOW_MS / 1000;

const base: ClockSampleGateInput = {
  rxTimeSec: NOW - 5,
  nowMs: NOW_MS,
  fromNum: 0x11111111,
  localNodeNum: 0xaaaaaaaa,
  packetId: 12345,
  transport: 1,
  viaMqtt: false,
  viaStoreForward: false,
  fromMqttProxy: false,
  virtualNodeRequestId: undefined,
  senderSec: NOW - 40,
};

const ok = (o: Partial<ClockSampleGateInput> = {}) => isClockSampleEligible({ ...base, ...o });

describe('isClockSampleEligible (#6341 P5 D2)', () => {
  it('accepts a live LoRa packet', () => expect(ok()).toBe(true));
  it('accepts every LoRa transport 1-4', () => {
    for (const t of [1, 2, 3, 4]) expect(ok({ transport: t })).toBe(true);
  });
  it.each([0, 5, 6])('rejects transport %i', (t) => expect(ok({ transport: t })).toBe(false));
  it('rejects viaMqtt', () => expect(ok({ viaMqtt: true })).toBe(false));
  it('rejects Store & Forward', () => expect(ok({ viaStoreForward: true })).toBe(false));
  it('rejects the MQTT proxy', () => expect(ok({ fromMqttProxy: true })).toBe(false));
  it('rejects a Virtual Node request', () => expect(ok({ virtualNodeRequestId: 7 })).toBe(false));
  it('rejects the local node', () => expect(ok({ fromNum: 0xaaaaaaaa })).toBe(false));
  it('rejects an absent rxTime', () => {
    expect(ok({ rxTimeSec: null })).toBe(false);
    expect(ok({ rxTimeSec: undefined })).toBe(false);
  });
  it('rejects a stale rxTime (past window)', () => expect(ok({ rxTimeSec: NOW - 121 })).toBe(false));
  it('rejects a future rxTime beyond 120 s', () => expect(ok({ rxTimeSec: NOW + 121 })).toBe(false));
  it('accepts a slightly future rxTime', () => expect(ok({ rxTimeSec: NOW + 60 })).toBe(true));
  it('rejects an implausible rxTime', () => expect(ok({ rxTimeSec: MIN_PLAUSIBLE_UNIX_SEC - 1 })).toBe(false));
  it('rejects a firmware NodeDB replay id', () => {
    // Same hash as replayGuard.firmwareReplayPacketId(from, rx, kind 3).
    const from = 0x11111111;
    const rx = NOW - 5;
    let h = from >>> 0;
    h = (Math.imul(h, 2654435761) + (rx >>> 0)) >>> 0;
    h = (Math.imul(h, 2654435761) + 3) >>> 0;
    expect(ok({ packetId: h })).toBe(false);
  });
  it('rejects senderSec 0, uptime-like, absent', () => {
    expect(ok({ senderSec: 0 })).toBe(false);
    expect(ok({ senderSec: 86_400 })).toBe(false);
    expect(ok({ senderSec: null })).toBe(false);
    expect(ok({ senderSec: undefined })).toBe(false);
  });
});
