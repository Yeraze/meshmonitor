import { describe, it, expect } from 'vitest';
import { isMqttBridgeMessage } from './messageFilters';
import type { MeshMessage } from '../types/message';

/** Build a minimal MeshMessage with sensible non-MQTT defaults. */
function makeMessage(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: 'src_123_456',
    from: 'Test Node',
    to: 'Broadcast',
    fromNodeId: '!abcd1234',
    toNodeId: '!ffffffff',
    text: 'hello',
    channel: 0,
    timestamp: new Date('2026-08-16T00:00:00Z'),
    ...overrides,
  };
}

describe('isMqttBridgeMessage', () => {
  // Regression: issue #4751 — a real URL a user typed was substring-matched
  // against the 'areyoumeshingwith.us' MQTT-broker blocklist and hidden.
  it('does NOT filter a genuine mesh message whose body contains areyoumeshingwith.us (viaMqtt: false)', () => {
    const msg = makeMessage({ text: 'Check out map.areyoumeshingwith.us', viaMqtt: false });
    expect(isMqttBridgeMessage(msg)).toBe(false);
  });

  it('does NOT filter a genuine mesh message whose body contains "mqtt." (viaMqtt: false)', () => {
    const msg = makeMessage({ text: 'try broker.mqtt.example', viaMqtt: false });
    expect(isMqttBridgeMessage(msg)).toBe(false);
  });

  it('still filters a real MQTT bridge packet (viaMqtt: true)', () => {
    const msg = makeMessage({ text: 'anything at all', viaMqtt: true });
    expect(isMqttBridgeMessage(msg)).toBe(true);
  });

  it('filters messages from unknown senders regardless of viaMqtt', () => {
    expect(isMqttBridgeMessage(makeMessage({ from: 'unknown' }))).toBe(true);
    expect(isMqttBridgeMessage(makeMessage({ fromNodeId: 'unknown' }))).toBe(true);
  });

  describe('legacy fallback (viaMqtt absent)', () => {
    it('filters a legacy message that matches an MQTT text pattern', () => {
      const msg = makeMessage({ text: 'mqtt.areyoumeshingwith.us', viaMqtt: undefined });
      expect(isMqttBridgeMessage(msg)).toBe(true);
    });

    it('filters a legacy version-string bridge line', () => {
      const msg = makeMessage({ text: '2.5.7.f77c87d', viaMqtt: undefined });
      expect(isMqttBridgeMessage(msg)).toBe(true);
    });

    it('does not filter ordinary legacy text', () => {
      const msg = makeMessage({ text: 'hello from the mesh', viaMqtt: undefined });
      expect(isMqttBridgeMessage(msg)).toBe(false);
    });

    it('does not filter example.com in legacy text', () => {
      const msg = makeMessage({ text: 'visit example.com today', viaMqtt: undefined });
      expect(isMqttBridgeMessage(msg)).toBe(false);
    });
  });
});
