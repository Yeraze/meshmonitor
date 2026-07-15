/**
 * Virtual channel (Channel Database) read-permission helpers.
 *
 * Virtual channels are MeshMonitor server-side PSKs stored in `channel_database`
 * and surfaced on the synthetic channel number `CHANNEL_DB_OFFSET + id`. Unlike
 * physical channels (`channel_0..7`, gated by the generic resource/action RBAC),
 * their read access lives in a parallel per-entry table
 * (`channel_database_permissions.canRead`). Admins bypass the table.
 *
 * These helpers are the single source of truth for that check, shared by the
 * unified routes, the legacy per-source `/api/messages*` endpoints, and the
 * channel-database list handler so every surface honors the same grants.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

/**
 * Set of channel-database ids the caller may read, or the sentinel `'all'` for
 * admins (avoids materializing every id).
 */
export type ReadableVirtualIds = Set<number> | 'all';

/**
 * Resolve the set of virtual-channel ids the user may read. Admins → `'all'`,
 * anonymous/unknown users → empty set, everyone else → their `canRead=true`
 * rows from `channel_database_permissions`.
 */
export async function getUserReadableVirtualChannelIds(
  user: { id: number } | undefined | null,
  isAdmin: boolean,
): Promise<ReadableVirtualIds> {
  if (isAdmin) return 'all';
  if (!user) return new Set();
  try {
    const perms = await databaseService.channelDatabase.getPermissionsForUserAsync(user.id);
    return new Set(perms.filter((p) => p.canRead).map((p) => p.channelDatabaseId));
  } catch (err) {
    logger.warn('Failed to load virtual channel permissions:', err);
    return new Set();
  }
}

/** True if the caller may read the virtual channel with database id `vcId`. */
export function canReadVirtualChannel(vcId: number, readable: ReadableVirtualIds): boolean {
  return readable === 'all' || readable.has(vcId);
}

/** True if `channelNumber` refers to a virtual (channel-database) channel. */
export function isVirtualChannelNumber(channelNumber: number): boolean {
  return channelNumber >= CHANNEL_DB_OFFSET;
}

/** Map a synthetic virtual channel number back to its `channel_database` id. */
export function virtualChannelDbId(channelNumber: number): number {
  return channelNumber - CHANNEL_DB_OFFSET;
}

/**
 * Whether the caller may read a message on `channelNumber`, where
 * `channelNumber` is a virtual channel (>= `CHANNEL_DB_OFFSET`). Maps the
 * synthetic number back to its database id before consulting `readable`.
 */
export function canReadVirtualChannelNumber(
  channelNumber: number,
  readable: ReadableVirtualIds,
): boolean {
  return canReadVirtualChannel(channelNumber - CHANNEL_DB_OFFSET, readable);
}

/** True if the caller can read at least one virtual channel. */
export function hasAnyReadableVirtualChannel(readable: ReadableVirtualIds): boolean {
  return readable === 'all' || readable.size > 0;
}
