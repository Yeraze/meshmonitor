/**
 * Who can send where (#3045 Phase 1). Annotates the unified channel groups with
 * a per-(channel, source) send verdict for one signed-in viewer.
 *
 * Every permission lookup is scoped to the ref's own source: a grant on source A
 * never makes a ref under source B sendable. The checks mirror the real send
 * routes (Meshtastic `/api/messages/send`, MeshCore messaging, MQTT-native) and
 * the MQTT-native precondition is the same `prepareMqttNativeSend` the send
 * path runs, so the list and the routes cannot drift.
 */
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager, isMeshCoreManager } from '../sourceManagerTypes.js';
import { isMqttSourceType } from '../../db/repositories/sources.js';
import { isDeviceMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import { canReadVirtualChannel, getUserReadableVirtualChannelIds } from '../utils/virtualChannelPermissions.js';
import {
  MqttNativeSendError,
  prepareMqttNativeSend,
  usableChannel,
} from './mqttNative/mqttNativeSendService.js';
import type { UnifiedChannelGroup, UnifiedChannelRef } from './unifiedChannelGroups.js';
import type { User } from '../../types/auth.js';

export type SendKind = 'meshtastic' | 'mqtt_native' | 'meshcore';

export type SendBlockedReason =
  | 'FORBIDDEN'
  | 'UNSUPPORTED_SOURCE'
  | 'VIRTUAL_CHANNEL'
  | 'PHYSICAL_CHANNEL'
  | 'CHANNEL_NOT_FOUND'
  | 'SOURCE_NOT_CONNECTED'
  | 'TX_DISABLED'
  | 'MQTT_NATIVE_DISABLED'
  | 'READ_ONLY'
  | 'NO_ROOT_TOPIC'
  | 'NO_IDENTITY'
  | 'KEY_UNAVAILABLE';

export interface SenderRef {
  sourceId: string;
  sourceName: string;
  channelNumber: number;
  canSend: boolean;
  sendKind: SendKind | null;
  sendBlockedReason: SendBlockedReason | null;
}

type PermSet = Record<string, { read?: boolean; write?: boolean } | undefined>;

interface SourceContext {
  /** null means admin: everything allowed. */
  perms: PermSet | null;
  mqttBlock?: Promise<SendBlockedReason | null>;
}

function kindOf(sourceType: string): SendKind | null {
  if (sourceType === 'meshtastic_tcp') return 'meshtastic';
  if (isMqttSourceType(sourceType)) return 'mqtt_native';
  if (isDeviceMeshCoreSourceType(sourceType)) return 'meshcore';
  return null;
}

/** Read or write on `messages` or any `channel_N`: enough to know the source exists. */
function canSeeSource(perms: PermSet): boolean {
  return Object.entries(perms).some(
    ([resource, p]) => (resource === 'messages' || resource.startsWith('channel_')) && !!(p?.read || p?.write)
  );
}

async function mqttPreconditionBlock(sourceId: string): Promise<SendBlockedReason | null> {
  try {
    await prepareMqttNativeSend(sourceId);
    return null;
  } catch (err) {
    if (!(err instanceof MqttNativeSendError)) throw err;
    switch (err.code) {
      case 'SOURCE_NOT_FOUND':
      case 'NOT_CONNECTED':
        return 'SOURCE_NOT_CONNECTED';
      case 'NOT_MQTT_SOURCE':
        return 'UNSUPPORTED_SOURCE';
      case 'MQTT_NATIVE_DISABLED':
      case 'READ_ONLY':
      case 'NO_ROOT_TOPIC':
      case 'NO_IDENTITY':
      case 'KEY_UNAVAILABLE':
        return err.code;
      default:
        throw err;
    }
  }
}

export async function resolveUnifiedSenders(
  user: User,
  groups: UnifiedChannelGroup[]
): Promise<Array<{ name: string; sources: SenderRef[] }>> {
  const isAdmin = user.isAdmin ?? false;
  const readableVirtualIds = await getUserReadableVirtualChannelIds(user, isAdmin);

  // One context per source, computed once however many refs it has.
  const contexts = new Map<string, Promise<SourceContext>>();
  const contextFor = (sourceId: string): Promise<SourceContext> => {
    let c = contexts.get(sourceId);
    if (!c) {
      c = isAdmin
        ? Promise.resolve({ perms: null })
        : databaseService.getUserPermissionSetAsync(user.id, sourceId).then((perms) => ({ perms }));
      contexts.set(sourceId, c);
    }
    return c;
  };

  const evaluate = async (ref: UnifiedChannelRef): Promise<SenderRef> => {
    const base = { sourceId: ref.sourceId, sourceName: ref.sourceName, channelNumber: ref.channelNumber };
    const blocked = (
      reason: SendBlockedReason,
      sendKind: SendKind | null = null
    ): SenderRef => ({ ...base, canSend: false, sendKind, sendBlockedReason: reason });

    const ctx = await contextFor(ref.sourceId);
    const perms = ctx.perms;

    // 1. Visibility gate: reveal nothing about a source the viewer has no grant on.
    if (perms && !canSeeSource(perms)) return blocked('FORBIDDEN');

    // 2. Kind.
    const kind = kindOf(ref.sourceType);
    if (!kind) return blocked('UNSUPPORTED_SOURCE');

    // 3. Slot rule.
    if (kind === 'meshtastic') {
      if (ref.isVirtual) return blocked('VIRTUAL_CHANNEL');
      if (ref.channelNumber < 0 || ref.channelNumber > 7) return blocked('CHANNEL_NOT_FOUND');
    } else if (kind === 'meshcore') {
      if (ref.isVirtual) return blocked('VIRTUAL_CHANNEL');
    } else {
      if (!ref.isVirtual) return blocked('PHYSICAL_CHANNEL');
      if (!usableChannel(ref.virtualRow ?? null)) return blocked('CHANNEL_NOT_FOUND');
    }

    // 4. Permission, scoped to this source.
    let permitted: boolean;
    if (perms === null) {
      permitted = true;
    } else if (kind === 'meshtastic') {
      permitted = !!perms[`channel_${ref.channelNumber}`]?.write;
    } else if (kind === 'meshcore') {
      permitted = !!perms.messages?.write;
    } else {
      permitted =
        !!perms.messages?.write &&
        ref.virtualRow?.id !== undefined &&
        canReadVirtualChannel(ref.virtualRow.id, readableVirtualIds);
    }
    if (!permitted) return blocked('FORBIDDEN');

    // 5. Live state.
    const manager = sourceManagerRegistry.getManager(ref.sourceId);
    if (kind === 'meshtastic') {
      if (!manager || !isMeshtasticManager(manager) || !manager.getStatus().connected) {
        return blocked('SOURCE_NOT_CONNECTED', kind);
      }
      if (!manager.canTransmit()) return blocked('TX_DISABLED', kind);
    } else if (kind === 'meshcore') {
      if (!manager || !isMeshCoreManager(manager) || !manager.isConnected()) {
        return blocked('SOURCE_NOT_CONNECTED', kind);
      }
      if (manager.isRepeaterSource()) return blocked('UNSUPPORTED_SOURCE', kind);
      if (manager.isReceiveOnly()) return blocked('TX_DISABLED', kind);
    } else {
      ctx.mqttBlock ??= mqttPreconditionBlock(ref.sourceId);
      const block = await ctx.mqttBlock;
      if (block) return blocked(block, kind);
    }

    return { ...base, canSend: true, sendKind: kind, sendBlockedReason: null };
  };

  return Promise.all(
    groups.map(async (g) => ({ name: g.name, sources: await Promise.all(g.sources.map(evaluate)) }))
  );
}
