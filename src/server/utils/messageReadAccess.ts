/**
 * Message read-access resolution (#5101 WP4).
 *
 * Pulled out of `GET /api/messages` verbatim (including the comments on why
 * each check is scoped) so the new `/api/messages/counts` route cannot drift
 * from the permission logic that the list endpoint it counts already
 * enforces. See `src/server/routes/messageRoutes.ts` `GET /` for the
 * pre-extraction call site, still using this helper with no behaviour
 * change.
 *
 * Not adopted (deliberately, #5101 Deferred): the poll's own third copy of
 * this predicate (`pollRoutes.ts` ~150-180), which works off a pre-loaded
 * permission set rather than per-call `hasPermission` — follow-up issue, not
 * P1.
 */
import type { User } from '../../types/auth.js';
import type { ResourceType } from '../../types/permission.js';
import { hasPermission } from '../auth/authMiddleware.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannelNumber,
  isVirtualChannelNumber,
  hasAnyReadableVirtualChannel,
  type ReadableVirtualIds,
} from './virtualChannelPermissions.js';

export interface MessageReadAccess {
  isAdmin: boolean;
  /** `channel_0:read`, scoped to `sourceId`. */
  hasChannelsRead: boolean;
  /** `messages:read`, scoped to `sourceId`. */
  hasMessagesRead: boolean;
  /** Virtual (Channel Database) channels this caller may read. */
  readableVirtual: ReadableVirtualIds;
  /** channel_0..7 ids with a scoped read grant. */
  authorizedChannelIds: Set<number>;
  /** True when the caller may read at least one channel kind. */
  canReadAny: boolean;
  /**
   * Whether the caller may read a message on `channel`. DM (-1) requires
   * `messages:read`; a virtual channel (>= CHANNEL_DB_OFFSET) requires its
   * per-entry `canRead` grant; a physical channel requires BOTH the legacy
   * `channel_0:read` gate AND a per-channel `channel_${id}:read`.
   */
  canReadChannel(channel: number): boolean;
}

/**
 * Resolve everything a caller may read for one source's messages. Mirrors
 * `GET /api/messages`'s pre-403 setup exactly — see the comments below,
 * carried over from that handler.
 */
export async function resolveMessageReadAccess(
  user: User | null | undefined,
  sourceId: string | undefined,
): Promise<MessageReadAccess> {
  // Check if user has either any channel permission or messages permission
  const isAdmin = user?.isAdmin === true;
  const hasChannelsRead = isAdmin || (user ? await hasPermission(user, 'channel_0', 'read', sourceId) : false);
  const hasMessagesRead = isAdmin || (user ? await hasPermission(user, 'messages', 'read', sourceId) : false);
  // Virtual (Channel Database) channels are gated by per-entry `canRead`
  // grants, not the channel_0..7 RBAC resources. Load them so virtual-channel
  // readers — including MQTT-bridge and anonymous users — can see their
  // messages instead of getting a blanket 403 / empty list.
  const readableVirtual = await getUserReadableVirtualChannelIds(user, isAdmin);

  // MM-SEC-3: pre-compute the channels this caller may read so we can
  // strip messages from hidden channels even when the caller has the
  // generic `channel_0:read` permission.
  const authorizedChannelIds = new Set<number>();
  if (isAdmin) {
    for (let id = 0; id <= 7; id++) authorizedChannelIds.add(id);
  } else if (user) {
    for (let id = 0; id <= 7; id++) {
      const channelResource = `channel_${id}` as ResourceType;
      // Scoped for the same reason as the gates above — an un-scoped check
      // here would let a channel grant on one source unhide that channel's
      // messages on every other source.
      if (await hasPermission(user, channelResource, 'read', sourceId)) authorizedChannelIds.add(id);
    }
  }

  const canReadAny = hasChannelsRead || hasMessagesRead || hasAnyReadableVirtualChannel(readableVirtual);

  // Filter messages based on permissions.
  // - DMs (channel -1) require `messages:read`.
  // - Virtual (Channel Database) channels require a per-entry `canRead`
  //   grant — the channel_0..7 gate can never authorize a >= CHANNEL_DB_OFFSET
  //   slot.
  // - Physical channel messages require BOTH the legacy `channel_0:read` gate
  //   above AND a per-channel `channel_${id}:read` for the message's actual
  //   channel.
  const canReadChannel = (channel: number): boolean => {
    if (channel === -1) return hasMessagesRead;
    if (isVirtualChannelNumber(channel)) {
      // readableVirtual resolves to 'all' for admins, so this already grants
      // them every virtual channel — no separate isAdmin short-circuit needed.
      return canReadVirtualChannelNumber(channel, readableVirtual);
    }
    return hasChannelsRead && (isAdmin || authorizedChannelIds.has(channel));
  };

  return {
    isAdmin,
    hasChannelsRead,
    hasMessagesRead,
    readableVirtual,
    authorizedChannelIds,
    canReadAny,
    canReadChannel,
  };
}
