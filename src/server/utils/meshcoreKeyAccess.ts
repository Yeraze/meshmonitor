/**
 * Read gate for "keyed" MeshCore channel messages (#5551).
 *
 * A MESH_PACKET_LOGGING repeater has no channel keys of its own, so it
 * decrypts GRP_TXT with keys stored on OTHER sources. Storing the plaintext on
 * the repeater source must not widen who can read that channel: a message is
 * only visible to a viewer who could read a channel holding the same secret.
 *
 * Each such row carries `keyFingerprint` (hex SHA-256(secret)[0..8]). A viewer
 * may see it when they may read SOME `channels` row, on any source, whose
 * secret has that fingerprint, using the same rule as every other MeshCore
 * channel read (`canAccessMeshcoreChannel`: `channel_N:read` or
 * `messages:read` on that row's source). Keying on the secret rather than on
 * one (source, slot) means:
 *
 * - holding the key anywhere is enough (you could decrypt it yourself);
 * - deleting the key everywhere hides the rows from non-admins, instead of the
 *   grant silently passing to whatever key later lands in that slot.
 *
 * A MeshCore virtual channel (#5552, a `channel_database` row with protocol
 * 'meshcore') is a key too: its per-entry `canRead` grant adds its fingerprint.
 * A disabled row still grants reads of what it already decrypted.
 *
 * Rows WITHOUT a fingerprint (every message a source decrypted with its own
 * key, every DM, every MQTT row) are unaffected. This gate is ANDed onto the
 * existing per-source checks; it never grants anything they deny.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import type { MeshCoreKeyAccessFilter } from '../../db/repositories/index.js';
import { channelKeyFingerprint, pskToHex, type ChannelKeyRow } from '../services/meshcoreFrameIngest.js';

/** The caller fields this module reads. */
export interface KeyAccessUser {
  id: number;
  isAdmin?: boolean;
}

/**
 * Fingerprints of every channel key `user` may read. `'all'` for admins; an
 * empty list for anonymous / no grants (unkeyed rows still pass).
 *
 * `rows` lets a caller pass a pre-read channel list.
 */
export async function resolveMeshcoreKeyAccess(
  user: KeyAccessUser | null | undefined,
  rows?: ChannelKeyRow[],
): Promise<MeshCoreKeyAccessFilter> {
  if (!user) return [];
  if (user.isAdmin) return 'all';
  const all = rows ?? ((await databaseService.channels.getAllChannels(ALL_SOURCES)) as ChannelKeyRow[]);

  // One `messages:read` lookup per source, one `channel_N:read` per slot.
  const messagesRead = new Map<string, Promise<boolean>>();
  const allowed = new Set<string>();
  for (const ch of all) {
    const secretHex = pskToHex(ch.psk);
    if (!secretHex || !ch.sourceId) continue;
    const fp = channelKeyFingerprint(secretHex);
    if (allowed.has(fp)) continue;
    const idx = Number(ch.id);
    let ok = false;
    // 0-7 is the RBAC resource set (`channel_0`..`channel_7`), as in
    // `channelResourceFor`. A higher MeshCore slot has no per-channel resource
    // and is readable through `messages:read` on its source alone.
    if (Number.isInteger(idx) && idx >= 0 && idx <= 7) {
      ok = await databaseService.checkPermissionAsync(user.id, `channel_${idx}`, 'read', ch.sourceId);
    }
    if (!ok) {
      let p = messagesRead.get(ch.sourceId);
      if (!p) {
        p = databaseService.checkPermissionAsync(user.id, 'messages', 'read', ch.sourceId);
        messagesRead.set(ch.sourceId, p);
      }
      ok = await p;
    }
    if (ok) allowed.add(fp);
  }
  // MeshCore virtual channels (#5552): a per-entry `canRead` grant on the
  // channel_database row. Default-deny: a new row has no grants.
  try {
    const perms = await databaseService.channelDatabase.getPermissionsForUserAsync(user.id, 'meshcore');
    const readable = new Set(perms.filter((p) => p.canRead === true).map((p) => p.channelDatabaseId));
    if (readable.size > 0) {
      for (const vc of await databaseService.channelDatabase.getAllAsync('meshcore')) {
        if (vc.id === undefined || !readable.has(vc.id)) continue;
        const secretHex = pskToHex(vc.psk);
        if (secretHex) allowed.add(channelKeyFingerprint(secretHex));
      }
    }
  } catch (err) {
    // Fail closed: no virtual-channel fingerprints are added.
    logger.warn('Failed to resolve MeshCore virtual-channel access:', err);
  }
  return [...allowed];
}

/** True when a row passes the gate (unkeyed rows always pass). */
export function canSeeKeyedMessage(
  access: MeshCoreKeyAccessFilter,
  row: { keyFingerprint?: string | null },
): boolean {
  if (access === 'all') return true;
  if (!row.keyFingerprint) return true;
  return access.includes(row.keyFingerprint);
}

/** Drop the rows a reader may not see. Returns the input when nothing is gated. */
export function filterKeyedMessages<T extends { keyFingerprint?: string | null }>(
  rows: T[],
  access: MeshCoreKeyAccessFilter,
): T[] {
  if (access === 'all') return rows;
  return rows.filter((r) => canSeeKeyedMessage(access, r));
}
