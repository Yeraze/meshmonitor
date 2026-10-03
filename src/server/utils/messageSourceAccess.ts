/**
 * What a caller may read from one source's stored messages, in the shape the
 * repository scopes take (#5517). Shared by message search and the CSV export
 * so both hide exactly what the message views hide.
 *
 * - Meshtastic (`messages` table) follows `resolveMessageReadAccess`, the rule
 *   `GET /api/messages` uses: a physical channel needs `channel_0:read` plus
 *   its own `channel_N:read`, DMs (-1) need `messages:read`, and a virtual
 *   (Channel Database) channel needs its per-entry `canRead` grant.
 * - MeshCore (`meshcore_messages`) follows `canAccessMeshcoreChannel`: a
 *   channel is readable with `channel_N:read` OR `messages:read`; DMs need
 *   `messages:read`.
 */
import type { User } from '../../types/auth.js';
import type { ResourceType } from '../../types/permission.js';
import type { MessageChannelScope, MeshCoreMessageScope } from '../../db/repositories/index.js';
import databaseService from '../../services/database.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { resolveMessageReadAccess } from './messageReadAccess.js';
import { resolveMeshcoreKeyAccess } from './meshcoreKeyAccess.js';

/**
 * Channel numbers the caller may read on a Meshtastic-family source: `'all'`
 * for admins, otherwise an explicit list (possibly empty) of physical slots,
 * -1 for DMs, and `CHANNEL_DB_OFFSET + id` for readable virtual channels.
 */
export async function resolveReadableMeshtasticChannels(
  user: User | null | undefined,
  sourceId: string,
): Promise<MessageChannelScope> {
  const access = await resolveMessageReadAccess(user, sourceId);
  if (access.isAdmin) return 'all';
  const channels: number[] = [];
  for (let n = 0; n <= 7; n++) {
    if (access.canReadChannel(n)) channels.push(n);
  }
  if (access.hasMessagesRead) channels.push(-1);
  if (access.readableVirtual !== 'all') {
    for (const id of access.readableVirtual) channels.push(CHANNEL_DB_OFFSET + id);
  }
  return channels;
}

/** Readable MeshCore traffic on one source, minus the `sourceId`. */
export async function resolveReadableMeshcoreScope(
  user: User | null | undefined,
  sourceId: string,
): Promise<Omit<MeshCoreMessageScope, 'sourceId'>> {
  if (!user) return { channels: [], includeDms: false, keyAccess: [] };
  if (user.isAdmin) return { channels: 'all', includeDms: true, keyAccess: 'all' };
  // #5551: repeater-decrypted rows also need read access to their key.
  const keyAccess = await resolveMeshcoreKeyAccess(user);
  if (await databaseService.checkPermissionAsync(user.id, 'messages', 'read', sourceId)) {
    return { channels: 'all', includeDms: true, keyAccess };
  }
  const channels: number[] = [];
  for (let idx = 0; idx <= 7; idx++) {
    const resource = `channel_${idx}` as ResourceType;
    if (await databaseService.checkPermissionAsync(user.id, resource, 'read', sourceId)) channels.push(idx);
  }
  return { channels, includeDms: false, keyAccess };
}

/** Narrow a readable scope to a requested channel list (`undefined` = no narrowing). */
export function intersectChannels(readable: MessageChannelScope, requested: number[] | undefined): MessageChannelScope {
  if (requested === undefined) return readable;
  if (readable === 'all') return [...requested];
  const allowed = new Set(readable);
  return requested.filter((c) => allowed.has(c));
}
