import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimMqttPositionPacket,
  resetMqttPositionDedupe,
  MQTT_POSITION_DEDUPE_MS,
  MQTT_POSITION_DEDUPE_MAX,
} from './mqttPositionHistory.js';

describe('claimMqttPositionPacket', () => {
  beforeEach(() => resetMqttPositionDedupe());

  it('claims a packet once, then rejects repeats inside the window', () => {
    expect(claimMqttPositionPacket('s', 1, 42, 1_000)).toBe(true);
    expect(claimMqttPositionPacket('s', 1, 42, 2_000)).toBe(false);
  });

  it('claims it again after the window', () => {
    expect(claimMqttPositionPacket('s', 1, 42, 0)).toBe(true);
    expect(claimMqttPositionPacket('s', 1, 42, MQTT_POSITION_DEDUPE_MS)).toBe(true);
  });

  it('keys on source, sender and packet id', () => {
    expect(claimMqttPositionPacket('s', 1, 42, 0)).toBe(true);
    expect(claimMqttPositionPacket('t', 1, 42, 0)).toBe(true);
    expect(claimMqttPositionPacket('s', 2, 42, 0)).toBe(true);
    expect(claimMqttPositionPacket('s', 1, 43, 0)).toBe(true);
  });

  it('never dedupes a packet with no id', () => {
    expect(claimMqttPositionPacket('s', 1, 0, 0)).toBe(true);
    expect(claimMqttPositionPacket('s', 1, 0, 0)).toBe(true);
  });

  it('stays bounded, evicting the oldest entries first', () => {
    for (let i = 1; i <= MQTT_POSITION_DEDUPE_MAX + 1; i++) claimMqttPositionPacket('s', 1, i, 0);
    // The first id was evicted, so it can be claimed again; a recent one can't.
    expect(claimMqttPositionPacket('s', 1, 1, 0)).toBe(true);
    expect(claimMqttPositionPacket('s', 1, MQTT_POSITION_DEDUPE_MAX, 0)).toBe(false);
  });
});
