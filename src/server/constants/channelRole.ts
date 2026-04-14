/**
 * Channel role normalization helpers.
 *
 * Firmware encodes Channel.role using proto3 semantics: the default value
 * DISABLED(0) is elided from the wire, so a freshly-disabled channel decodes
 * with role=undefined rather than role=0. Without compensating for that, the
 * repository's `role ?? existingChannel.role` fallback preserves the stale
 * SECONDARY role and the channel never leaves the UI (#2666).
 */

export const CHANNEL_ROLE_DISABLED = 0;
export const CHANNEL_ROLE_PRIMARY = 1;
export const CHANNEL_ROLE_SECONDARY = 2;

export interface ChannelLike {
  index: number;
  role?: number;
  settings?: {
    name?: string;
    psk?: { length?: number } | Uint8Array | null;
  };
}

/**
 * Resolve the effective role for an incoming firmware Channel message,
 * compensating for proto3 default-value elision.
 *
 * Returns:
 *   - PRIMARY(1) for channel 0 regardless of incoming role (channel 0 is
 *     always primary by Meshtastic convention)
 *   - DISABLED(0) for secondary slots (1-7) that arrive with no role, no
 *     name, and no PSK — they are semantically empty and should clear any
 *     stale record on disk
 *   - SECONDARY(2) for secondary slots arriving with role=PRIMARY (defensive
 *     override; only channel 0 may be PRIMARY)
 *   - Otherwise, the original `channel.role` (may be undefined — the caller
 *     must then defer to existing-record role via nullish coalescing)
 */
export function normalizeChannelRole(channel: ChannelLike): number | undefined {
  if (channel.index === 0) {
    return CHANNEL_ROLE_PRIMARY;
  }

  const incoming = channel.role;
  const hasName = !!channel.settings?.name;
  const psk = channel.settings?.psk;
  const hasPsk = !!(psk && typeof psk === 'object' && 'length' in psk && (psk.length ?? 0) > 0);

  if (incoming === undefined && !hasName && !hasPsk) {
    return CHANNEL_ROLE_DISABLED;
  }

  if (incoming === CHANNEL_ROLE_PRIMARY) {
    return CHANNEL_ROLE_SECONDARY;
  }

  return incoming;
}
