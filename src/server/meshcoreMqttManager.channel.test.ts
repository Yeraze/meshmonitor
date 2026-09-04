/**
 * Channel-message ingest for an MQTT region feed (#5040 Phase 4).
 *
 * The behaviour that matters is duplicate collapse. A region feed relays the
 * same channel message once per observer that heard it, so without a
 * content-derived id twenty observers would mean twenty rows in the message
 * list AND twenty notifications / automation triggers.
 *
 * The design mirrors the Meshtastic messages table: content-derived id
 * including sourceId + insert-or-ignore, with the emit gated on whether a row
 * was actually written.
 */
import { describe, it, expect } from 'vitest';
import { channelMessageId, pskToHex } from './meshcoreMqttManager.js';

describe('channelMessageId', () => {
  it('is stable for the same message — so N observers collapse to one row', () => {
    const a = channelMessageId('src-1', 'a3', 1_700_000_000, 'hello mesh');
    const b = channelMessageId('src-1', 'a3', 1_700_000_000, 'hello mesh');
    expect(a).toBe(b);
  });

  it('differs per source — a copy your own radio heard keeps its own row', () => {
    const mqtt = channelMessageId('src-mqtt', 'a3', 1_700_000_000, 'hello');
    const device = channelMessageId('src-device', 'a3', 1_700_000_000, 'hello');
    expect(mqtt).not.toBe(device);
  });

  it('separates different text, timestamps, and channels', () => {
    const base = channelMessageId('s', 'a3', 100, 'x');
    expect(base).not.toBe(channelMessageId('s', 'a3', 100, 'y'));
    expect(base).not.toBe(channelMessageId('s', 'a3', 101, 'x'));
    expect(base).not.toBe(channelMessageId('s', 'b4', 100, 'x'));
  });

  it('does not collide when text and timestamp are swapped around the separator', () => {
    // A naive `${ts}${text}` concat would make these identical.
    expect(channelMessageId('s', 'a3', 1, '23hello')).not.toBe(
      channelMessageId('s', 'a3', 12, '3hello'),
    );
  });

  it('is namespaced so it cannot collide with a device-path random id', () => {
    expect(channelMessageId('s', 'a3', 1, 'x').startsWith('mqtt_s_')).toBe(true);
  });
});

describe('pskToHex', () => {
  it('passes hex through, lowercased', () => {
    expect(pskToHex('AABBCC')).toBe('aabbcc');
  });

  it('converts the base64 form channels are stored in', () => {
    const hex = pskToHex(Buffer.from('0123456789abcdef', 'hex').toString('base64'));
    expect(hex).toBe('0123456789abcdef');
  });

  it('returns null for absent or unusable values rather than throwing', () => {
    expect(pskToHex(null)).toBeNull();
    expect(pskToHex(undefined)).toBeNull();
    expect(pskToHex('')).toBeNull();
  });

  it('treats an odd-length hex-looking string as base64, not hex', () => {
    // 'abc' is hex-ish but cannot be bytes; falling through to base64 is the
    // safe reading, and a wrong key simply fails the channel-hash match.
    expect(pskToHex('abc')).not.toBe('abc');
  });
});
