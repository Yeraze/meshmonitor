/**
 * The slot a MeshCore channel message belongs to, from the synthetic
 * `channel-<idx>` key on either end. Null for a DM or a room post.
 *
 * Lives here (not in `socketEventGates`) so route code and the translation
 * scope resolver can share it without importing the socket layer.
 */
const CHANNEL_KEY_RE = /^channel-(\d+)$/;

export function meshcoreChannelIdx(message: { fromPublicKey?: string | null; toPublicKey?: string | null }): number | null {
  for (const key of [message.toPublicKey, message.fromPublicKey]) {
    const match = typeof key === 'string' ? CHANNEL_KEY_RE.exec(key) : null;
    if (match) return Number(match[1]);
  }
  return null;
}
