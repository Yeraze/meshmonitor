/**
 * Protocol dispatch for "which messages may this caller translate/read
 * translations of" (#6261).
 *
 * `translationRoutes` used to hard-wire the Meshtastic `messages` table. A
 * source of a MeshCore type stores rows in `meshcore_messages`, with its own
 * visibility rules, so the route asks this module for a scope instead. Each
 * branch reuses the predicate of the matching message-list routes; nothing is
 * re-implemented here, so the two cannot drift.
 *
 *  - Meshtastic: `resolveMessageReadAccess` + `canReadChannel` (moved
 *    verbatim from the route).
 *  - MeshCore: the channel's grant (`canAccessMeshcoreChannel`) AND the
 *    channel key gate (`canSeeKeyedMessage`) for channel rows; `messages:read`
 *    for DM / room / legacy null-recipient rows. Reactions are never
 *    translatable. This is the same predicate as `/messages`,
 *    `/messages/channel/:idx` and `MESHCORE_MESSAGE_GATE`.
 *
 * An unknown source gets `canReadAny: false`. Hidden, missing and reaction
 * rows are indistinguishable to the caller (all absent from `loadReadable`).
 */
import databaseService from '../../../services/database.js';
import type { User } from '../../../types/auth.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';
import { hasPermission } from '../../auth/authMiddleware.js';
import { resolveMessageReadAccess } from '../../utils/messageReadAccess.js';
import { meshcoreChannelIdx } from '../../utils/meshcoreChannelIdx.js';
import { resolveMeshcoreKeyAccess, canSeeKeyedMessage } from '../../utils/meshcoreKeyAccess.js';
import {
  canAccessMeshcoreChannel,
  channelResourceFor,
  MESHCORE_CHANNEL_RESOURCE_MAX,
} from '../../routes/meshcoreRouteShared.js';

export interface TranslatableMessageScope {
  /** Gate for `GET /stored`: false means 403. */
  canReadAny: boolean;
  /** The caller-readable rows among `ids`, as `{ id, text }`. */
  loadReadable(ids: string[]): Promise<Array<{ id: string; text: string }>>;
}

const DENY: TranslatableMessageScope = {
  canReadAny: false,
  loadReadable: async () => [],
};

async function resolveMeshtasticScope(user: User | null | undefined, sourceId: string): Promise<TranslatableMessageScope> {
  const access = await resolveMessageReadAccess(user, sourceId);
  return {
    canReadAny: access.canReadAny,
    async loadReadable(ids) {
      if (!access.canReadAny || ids.length === 0) return [];
      const rows = await databaseService.messages.getMessagesByIdsInSource(sourceId, ids);
      return rows
        .filter((msg) => access.canReadChannel(Number(msg.channel)))
        .map((msg) => ({ id: msg.id, text: msg.text }));
    },
  };
}

async function resolveMeshcoreScope(user: User | null | undefined, sourceId: string): Promise<TranslatableMessageScope> {
  if (!user) return DENY;
  const isAdmin = user.isAdmin === true;

  const messagesRead = isAdmin || await hasPermission(user, 'messages', 'read', sourceId);
  let canReadAny = messagesRead;
  if (!canReadAny) {
    for (let idx = 0; idx <= MESHCORE_CHANNEL_RESOURCE_MAX; idx++) {
      const resource = channelResourceFor(idx);
      if (resource && await hasPermission(user, resource, 'read', sourceId)) {
        canReadAny = true;
        break;
      }
    }
  }
  if (!canReadAny) return DENY;

  return {
    canReadAny,
    async loadReadable(ids) {
      if (ids.length === 0) return [];
      const rows = await databaseService.meshcore.getMessagesByIdsInSource(sourceId, ids);
      // A reaction has no text of its own to translate.
      const candidates = rows.filter((row) => !row.reactionEmoji);
      if (candidates.length === 0) return [];

      // Resolved once per call, and only when a channel row needs it.
      let keyAccess: Awaited<ReturnType<typeof resolveMeshcoreKeyAccess>> | null = null;
      const out: Array<{ id: string; text: string }> = [];
      for (const row of candidates) {
        const idx = meshcoreChannelIdx(row);
        if (idx === null) {
          // DM, room post, or a legacy null-recipient row.
          if (!messagesRead) continue;
        } else {
          if (!isAdmin && !(await canAccessMeshcoreChannel(user.id, idx, 'read', sourceId))) continue;
          keyAccess ??= await resolveMeshcoreKeyAccess(user);
          if (!canSeeKeyedMessage(keyAccess, row)) continue;
        }
        out.push({ id: row.id, text: row.text });
      }
      return out;
    },
  };
}

export async function resolveTranslatableMessageScope(
  user: User | null | undefined,
  sourceId: string,
): Promise<TranslatableMessageScope> {
  const source = await databaseService.sources.getSource(sourceId);
  if (!source) return DENY;
  return isAnyMeshCoreSourceType(source.type)
    ? resolveMeshcoreScope(user, sourceId)
    : resolveMeshtasticScope(user, sourceId);
}
