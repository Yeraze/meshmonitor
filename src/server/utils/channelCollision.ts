/**
 * Channel collision detection (#3644).
 *
 * A "collision" is when a server-side decryption entry (`channel_database`)
 * shares a PSK with a configured device channel but carries a DIFFERENT display
 * name. When that happens, MeshMonitor server-decrypts matching packets and
 * files them under the channel_database entry's synthetic tab
 * (`CHANNEL_DB_OFFSET + id`) instead of the device channel — so the device
 * channel's own tab looks empty while its messages appear under the other name.
 *
 * Surfacing the collision lets the operator reconcile the names (rename one, or
 * remove the redundant server-decryption entry).
 *
 * Same-name + same-PSK is intentionally NOT a collision: that's the normal case
 * where a channel_database entry simply mirrors the device channel under the
 * same label. An unencrypted (empty PSK) channel never collides.
 *
 * PSKs are compared server-side because the channels API only exposes raw PSKs
 * to authorized writers — readers (e.g. the Unified Messaging view) can't do the
 * comparison client-side.
 */

/**
 * Normalize a base64 PSK for comparison. Trims surrounding whitespace and maps
 * the empty / no-encryption case to `null` (which never matches). Device slots
 * and channel_database rows both persist the 1-byte default-public shorthand
 * (`AQ==`) identically, so no key expansion is required here.
 */
export function normalizePsk(psk: string | null | undefined): string | null {
  if (psk == null) return null;
  const trimmed = psk.trim();
  return trimmed === '' ? null : trimmed;
}

export interface CollisionChannel {
  id: number;
  name: string;
  psk?: string | null;
}

export interface CollisionDbEntry {
  id: number;
  name: string;
  psk: string;
}

export interface ChannelCollision {
  /** Device channel slot id (0–7). */
  channelId: number;
  /** Device channel display name. */
  channelName: string;
  /** Colliding channel_database entry id. */
  dbId: number;
  /** Colliding channel_database entry name (the tab messages actually land under). */
  dbName: string;
}

/**
 * Find device channels whose PSK matches a channel_database entry under a
 * different name. Returns one entry per colliding (channel, db-entry) pair.
 */
export function detectChannelCollisions(
  channels: CollisionChannel[],
  dbEntries: CollisionDbEntry[],
): ChannelCollision[] {
  const out: ChannelCollision[] = [];
  for (const ch of channels) {
    const chPsk = normalizePsk(ch.psk);
    if (chPsk == null) continue; // unencrypted — never collides
    for (const db of dbEntries) {
      if (normalizePsk(db.psk) !== chPsk) continue; // different key
      if (db.name.trim() === ch.name.trim()) continue; // same label — benign mirror
      out.push({ channelId: ch.id, channelName: ch.name, dbId: db.id, dbName: db.name });
    }
  }
  return out;
}
