import { describe, it, expect } from 'vitest';
import {
  normalizeChannelRole,
  CHANNEL_ROLE_DISABLED,
  CHANNEL_ROLE_PRIMARY,
  CHANNEL_ROLE_SECONDARY,
} from './channelRole.js';

describe('normalizeChannelRole', () => {
  it('always returns PRIMARY for channel 0', () => {
    expect(normalizeChannelRole({ index: 0 })).toBe(CHANNEL_ROLE_PRIMARY);
    expect(normalizeChannelRole({ index: 0, role: CHANNEL_ROLE_DISABLED })).toBe(CHANNEL_ROLE_PRIMARY);
    expect(normalizeChannelRole({ index: 0, role: CHANNEL_ROLE_SECONDARY })).toBe(CHANNEL_ROLE_PRIMARY);
  });

  it('normalizes empty secondary channel with undefined role to DISABLED (#2666)', () => {
    // Firmware elides role=DISABLED on the wire — arrives as undefined
    expect(normalizeChannelRole({ index: 2, settings: {} })).toBe(CHANNEL_ROLE_DISABLED);
    expect(normalizeChannelRole({ index: 2, settings: { name: '' } })).toBe(CHANNEL_ROLE_DISABLED);
    expect(normalizeChannelRole({ index: 7, settings: { psk: new Uint8Array(0) } })).toBe(CHANNEL_ROLE_DISABLED);
  });

  it('preserves undefined role when channel has a name (config update without role)', () => {
    // Don't auto-disable a channel that's still configured — let the repo
    // fall back to the existing role via nullish coalescing
    expect(normalizeChannelRole({ index: 2, settings: { name: 'Gauntlet' } })).toBeUndefined();
  });

  it('preserves undefined role when channel has a PSK', () => {
    expect(
      normalizeChannelRole({ index: 2, settings: { psk: new Uint8Array([1, 2, 3]) } })
    ).toBeUndefined();
  });

  it('keeps explicit DISABLED role on secondary slots', () => {
    expect(normalizeChannelRole({ index: 2, role: CHANNEL_ROLE_DISABLED, settings: {} })).toBe(CHANNEL_ROLE_DISABLED);
  });

  it('keeps explicit SECONDARY role', () => {
    expect(
      normalizeChannelRole({ index: 3, role: CHANNEL_ROLE_SECONDARY, settings: { name: 'Work' } })
    ).toBe(CHANNEL_ROLE_SECONDARY);
  });

  it('downgrades PRIMARY role on secondary slots to SECONDARY (defensive)', () => {
    // Only channel 0 may be PRIMARY; defend against misconfigured firmware
    expect(
      normalizeChannelRole({ index: 4, role: CHANNEL_ROLE_PRIMARY, settings: { name: 'Oops' } })
    ).toBe(CHANNEL_ROLE_SECONDARY);
  });

  it('treats falsy/missing settings gracefully', () => {
    expect(normalizeChannelRole({ index: 5 })).toBe(CHANNEL_ROLE_DISABLED);
  });
});
