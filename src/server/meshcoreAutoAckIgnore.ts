/**
 * MeshCore Auto-Acknowledge sender ignore list (#4391).
 *
 * The Meshtastic Auto-Acknowledge module skips senders listed in
 * `autoAckIgnoredNodes`, parsed as canonical `!xxxxxxxx` node IDs. MeshCore has
 * no equivalent identifier, so this list matches on what a MeshCore operator can
 * actually see and copy in the UI:
 *
 *  - **Public key / key prefix** — hex, with or without a leading `!`. A DM
 *    arrives carrying only a 12-hex-char (6-byte) key prefix while the contact
 *    panel shows the full 64-char key, so matching is prefix-wise in BOTH
 *    directions: a stored entry matches when either value is a prefix of the
 *    other. Minimum 2 hex characters, so a stray single character can't
 *    black-hole the whole mesh.
 *  - **Contact / sender name** — matched case-insensitively with surrounding and
 *    repeated whitespace collapsed. Names are the ONLY sender identity a channel
 *    message carries: MeshCore channel packets have no sender field on the wire,
 *    so the manager synthesises `fromPublicKey` as `channel-<idx>` and recovers
 *    the sender from the `"Name: "` body prefix. Without name entries a channel
 *    bot could not be excluded at all.
 *
 * Entries are separated by commas or newlines — NOT arbitrary whitespace, unlike
 * the Meshtastic parser, because MeshCore contact names routinely contain
 * spaces ("Alice MeshCore").
 */

export interface MeshCoreIgnoreList {
  /** Lowercase hex public-key prefixes. */
  keys: string[];
  /** Lowercase, whitespace-collapsed display names. */
  names: string[];
}

/** Hex entry: 2–64 characters, so a 1-char typo can't match every sender. */
const HEX_ENTRY = /^[0-9a-f]{2,64}$/;
const HEX_ONLY = /^[0-9a-f]+$/;

const normalizeName = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Parse the raw `meshcoreAutoAckIgnoredNodes` setting into key-prefix and name
 * buckets. An entry that looks like hex lands in BOTH buckets, so a contact
 * literally named "beef" is still excludable.
 */
export function parseMeshCoreIgnoreList(raw: string | null | undefined): MeshCoreIgnoreList {
  const keys = new Set<string>();
  const names = new Set<string>();
  if (!raw) return { keys: [], names: [] };

  for (const token of raw.split(/[,\r\n]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    names.add(normalizeName(trimmed));
    const hex = (trimmed.startsWith('!') ? trimmed.slice(1) : trimmed).toLowerCase();
    if (HEX_ENTRY.test(hex)) keys.add(hex);
  }

  return { keys: [...keys], names: [...names] };
}

export function isMeshCoreIgnoreListEmpty(list: MeshCoreIgnoreList): boolean {
  return list.keys.length === 0 && list.names.length === 0;
}

export interface MeshCoreSenderIdentity {
  /** Public key or key prefix from the triggering message. */
  publicKey?: string | null;
  /** Candidate display names (message sender name, resolved contact names). */
  names?: Array<string | null | undefined>;
}

/**
 * True when the sender matches any entry in the ignore list.
 */
export function isMeshCoreSenderIgnored(
  list: MeshCoreIgnoreList,
  sender: MeshCoreSenderIdentity,
): boolean {
  if (isMeshCoreIgnoreListEmpty(list)) return false;

  const key = (sender.publicKey ?? '').trim().toLowerCase();
  // Channel senders carry a synthetic `channel-<idx>` key — non-hex, so it can
  // never collide with a real key entry.
  if (key.length >= 2 && HEX_ONLY.test(key)) {
    for (const entry of list.keys) {
      if (key.startsWith(entry) || entry.startsWith(key)) return true;
    }
  }

  for (const candidate of sender.names ?? []) {
    if (!candidate) continue;
    const name = normalizeName(candidate);
    if (name && list.names.includes(name)) return true;
  }

  return false;
}
