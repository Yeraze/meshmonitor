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
 *  - **public**  — the well-known default channel, which the device always
 *    keeps in slot 0. Its secret is a shared, published key, so anyone can read
 *    it. Classified by slot id, not by name: slot 0 is public whatever it is
 *    named.
 *  - **hashtag** — a public topic channel whose name starts with `#` (e.g.
 *    `#general`). Its secret is derived deterministically from the name
 *    (`SHA-256("#name")[0:16]`), so everyone using the same `#name` shares the
 *    key. Still effectively public.
 *  - **private** — anything else: a channel in slot 1+ with a plain name and a
 *    random 16-byte secret shared only among its members.
 *
 * Slot id wins over the name, so a hashtag-looking name in slot 0 is still the
 * public channel — the same precedence the settings editor uses.
 */
import { isHashtagChannelName } from './meshcoreHelpers.js';

export type MeshCoreChannelKind = 'public' | 'hashtag' | 'private';

/** The device always keeps the well-known Public channel in slot 0. */
export const MESHCORE_PUBLIC_SLOT = 0;

export function meshcoreChannelKind(
  channel: { id: number; name: string | null | undefined },
): MeshCoreChannelKind {
  if (channel.id === MESHCORE_PUBLIC_SLOT) return 'public';
  if (isHashtagChannelName(channel.name)) return 'hashtag';
  return 'private';
}
