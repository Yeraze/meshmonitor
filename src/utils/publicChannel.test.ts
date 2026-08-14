import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PUBLIC_PSK,
  PUBLIC_CHANNEL_PRECISION_MAX_BITS,
  isKnownPublicChannel,
  exceedsPublicChannelPrecisionClamp,
} from './publicChannel';

/**
 * #4705 — firmware 2.8 clamps position precision to 15 bits on known-public
 * channels. Getting "public" wrong in either direction is a real problem:
 * too broad and we nag users on private channels that are never clamped;
 * too narrow and we stay silent while the radio quietly discards their setting.
 */
describe('isKnownPublicChannel', () => {
  it('treats the default PSK as public', () => {
    expect(isKnownPublicChannel(DEFAULT_PUBLIC_PSK)).toBe(true);
    expect(DEFAULT_PUBLIC_PSK).toBe('AQ==');
  });

  it('treats an absent or empty PSK as public (no encryption at all)', () => {
    expect(isKnownPublicChannel('')).toBe(true);
    expect(isKnownPublicChannel(null)).toBe(true);
    expect(isKnownPublicChannel(undefined)).toBe(true);
  });

  it('treats any custom PSK as private', () => {
    expect(isKnownPublicChannel('AQAAAAAAAAAAAAAAAAAAAA==')).toBe(false);
    expect(isKnownPublicChannel('c2VjcmV0LWtleS1oZXJl')).toBe(false);
  });

  it('is case-sensitive — base64 is, and a differing case is a different key', () => {
    expect(isKnownPublicChannel('aq==')).toBe(false);
  });
});

describe('exceedsPublicChannelPrecisionClamp', () => {
  it('warns above the clamp on a public channel', () => {
    expect(exceedsPublicChannelPrecisionClamp(DEFAULT_PUBLIC_PSK, 32)).toBe(true);
    expect(exceedsPublicChannelPrecisionClamp('', 16)).toBe(true);
  });

  it('does not warn at or below the clamp', () => {
    expect(exceedsPublicChannelPrecisionClamp(DEFAULT_PUBLIC_PSK, PUBLIC_CHANNEL_PRECISION_MAX_BITS)).toBe(false);
    expect(exceedsPublicChannelPrecisionClamp(DEFAULT_PUBLIC_PSK, 10)).toBe(false);
    expect(exceedsPublicChannelPrecisionClamp(DEFAULT_PUBLIC_PSK, 0)).toBe(false);
  });

  it('never warns on a private channel, even at full precision', () => {
    // Private channels are not clamped by the firmware, so 32 is legitimate.
    expect(exceedsPublicChannelPrecisionClamp('c2VjcmV0LWtleS1oZXJl', 32)).toBe(false);
  });

  it('pins the clamp at 15 bits', () => {
    // Matches meshtastic/firmware#10665; if firmware changes this, the
    // warning text's "~564 m" figure has to move with it.
    expect(PUBLIC_CHANNEL_PRECISION_MAX_BITS).toBe(15);
  });
});
