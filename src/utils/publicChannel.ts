/**
 * Shared "is this a known public channel?" detection (#4705).
 *
 * The base64 `AQ==` PSK is Meshtastic's 1-byte default key — the one the stock
 * LongFast/MediumFast presets ship with. A channel using it is readable by
 * anyone running default firmware, so it is "public" in every sense that
 * matters, despite technically being encrypted.
 *
 * The constant was previously copy-pasted into four files
 * (`ChannelsConfigSection.tsx`, `ChannelsTab.tsx`, `NodeFilterPopup.tsx`, and
 * server-side `channelView.ts`). This is the shared frontend definition; the
 * server keeps its own copy so server code never imports from `src/components`.
 */

/** Meshtastic's default public PSK: base64 of the single byte 0x01. */
export const DEFAULT_PUBLIC_PSK = 'AQ==';

/**
 * Firmware clamps `position_precision` to this many bits on known-public
 * channels (~564 m accuracy).
 *
 * Introduced by meshtastic/firmware#10665 (merged to `develop` 2026-06-14, part
 * of the 2.8 line — NOT in 2.7.x). The firmware enforces it twice: once in
 * `AdminModule.cpp` when the config is saved, and again in `PositionModule.cpp`
 * at transmit time. A client may still *request* a higher value; the radio
 * silently reduces it either way.
 */
export const PUBLIC_CHANNEL_PRECISION_MAX_BITS = 15;

/** Approximate ground accuracy of PUBLIC_CHANNEL_PRECISION_MAX_BITS, in metres. */
export const PUBLIC_CHANNEL_PRECISION_MAX_METERS = 564;

/**
 * True when a channel counts as "known public" for the firmware's precision
 * clamp: either unencrypted, or using the default public PSK.
 *
 * Mirrors the firmware's own definition. A custom PSK — of any length — is a
 * private channel and is not clamped.
 */
export function isKnownPublicChannel(psk: string | null | undefined): boolean {
  if (psk == null || psk === '') return true; // no encryption at all
  return psk === DEFAULT_PUBLIC_PSK;
}

/**
 * True when this precision setting will be silently reduced by 2.8+ firmware.
 *
 * Deliberately NOT firmware-version-gated: MeshMonitor generally cannot know
 * the target node's firmware version when configuring a remote channel, and the
 * warning is useful in both directions — it tells 2.7 users the constraint is
 * coming, and explains to 2.8 users why their setting reduced itself.
 */
export function exceedsPublicChannelPrecisionClamp(
  psk: string | null | undefined,
  precisionBits: number,
): boolean {
  return isKnownPublicChannel(psk) && precisionBits > PUBLIC_CHANNEL_PRECISION_MAX_BITS;
}
