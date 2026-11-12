/**
 * Classify a MeshCore channel as public, hashtag, or private (#6228).
 *
 * MeshMonitor lists MeshCore channels in several places (the Channels view, its
 * reorder panel, the mobile stream header, the settings editor). Every channel
 * used to show the same `#` marker, so a private channel — whose random 16-byte
 * secret is shared only among its members — was indistinguishable from the
 * public, world-readable channel. This is the single source of truth for which
 * of the three kinds a channel is, so the markers stay consistent everywhere.
 *
 * The rules mirror how the settings editor already labels a channel's key
 * (`MeshCoreChannelsConfigSection` `chipsFor`):
 *
 *  - **public**  — a channel whose secret is the well-known, published Public
 *    key, so anyone can read it. The device seeds slot 0 with that key but
 *    reports the slot as if it were empty, so no PSK may be on file for slot 0:
 *    a slot-0 channel with no known PSK is still taken to be Public. When the
 *    PSK is known it decides (#4173 review L18): the Public key in any slot is
 *    public, and slot 0 holding some other key is not.
 *  - **hashtag** — a public topic channel whose name starts with `#` (e.g.
 *    `#general`). Its secret is derived deterministically from the name
 *    (`SHA-256("#name")[0:16]`), so everyone using the same `#name` shares the
 *    key. Still effectively public.
 *  - **private** — anything else: a plain name and a random 16-byte secret
 *    shared only among its members.
 *
 * The Public key wins over the name, so a hashtag-looking name holding the
 * Public key (or in slot 0 with no known PSK) is still the public channel.
 */
import { isHashtagChannelName } from './meshcoreHelpers.js';

export type MeshCoreChannelKind = 'public' | 'hashtag' | 'private';

/** The device always keeps the well-known Public channel in slot 0. */
export const MESHCORE_PUBLIC_SLOT = 0;

/**
 * The well-known secret of MeshCore's Public channel (firmware
 * `PUBLIC_GROUP_PSK`, base64 `izOH6cXN6mrJ5e26oRXNcg==`), as lowercase hex.
 * Mirrors the server's `MESHCORE_PUBLIC_CHANNEL_SECRET`; a test keeps the two
 * in step.
 */
export const MESHCORE_PUBLIC_CHANNEL_SECRET_HEX = '8b3387e9c5cdea6ac9e5edbaa115cd72';

/** A channel secret (base64, as the channel list carries it, or hex) as
 *  lowercase hex, or null when it is empty or unreadable. */
export function meshcoreSecretToHex(secret: string | null | undefined): string | null {
  const s = (secret ?? '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase();
  try {
    const bin = atob(s);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex || null;
  } catch {
    return null;
  }
}

/** True when the secret is all zero bytes (how firmware reports an unset slot). */
function isZeroSecret(hex: string): boolean {
  return /^0+$/.test(hex);
}

export function meshcoreChannelKind(
  channel: { id: number; name: string | null | undefined; psk?: string | null },
): MeshCoreChannelKind {
  const hex = meshcoreSecretToHex(channel.psk);
  const knownKey = hex !== null && !isZeroSecret(hex);
  if (knownKey) {
    if (hex === MESHCORE_PUBLIC_CHANNEL_SECRET_HEX) return 'public';
  } else if (channel.id === MESHCORE_PUBLIC_SLOT) {
    return 'public';
  }
  if (isHashtagChannelName(channel.name)) return 'hashtag';
  return 'private';
}
