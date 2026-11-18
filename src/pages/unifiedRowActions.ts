/**
 * Which row actions (reply, tapback) a Unified Messages item offers (#3045 P3).
 * Pure: the page passes the result to the row as two booleans.
 */
import type { SenderRef } from './unifiedSendRequest';
import { meshcoreReplyPrefix, meshcoreRowIdFor } from './unifiedSendRequest';
import type { UnifiedMessage } from './unifiedMessageTypes';
import { sourceTypeMeshProtocol } from '../utils/meshProtocol';

export interface RowActionAvailability {
  canReply: boolean;
  canReact: boolean;
}

const NONE: RowActionAvailability = { canReply: false, canReact: false };

/** `senders` are the refs of the selected channel; pass `[]` when no composer shows. */
export function rowActionAvailability(
  msg: UnifiedMessage,
  senders: readonly SenderRef[],
): RowActionAvailability {
  if (msg.reactionEmoji || senders.length === 0) return NONE;
  const protocol = sourceTypeMeshProtocol(msg.receptions[0]?.sourceType);
  const usable = senders.filter((s) => s.canSend);
  if (protocol === 'meshtastic') {
    if (msg.packetId == null) return NONE;
    const ok = usable.some((s) => s.sendKind === 'meshtastic' || s.sendKind === 'mqtt_native');
    return { canReply: ok, canReact: ok };
  }
  if (protocol === 'meshcore') {
    if (!msg.meshcoreRowRefs?.length) return NONE;
    const mc = usable.filter((s) => s.sendKind === 'meshcore');
    return {
      canReply: mc.length > 0 && meshcoreReplyPrefix(msg.fromNodeLongName) !== null,
      canReact: mc.some(
        (s) => s.reactionsOutbound === true && meshcoreRowIdFor(msg.meshcoreRowRefs, s.sourceId) !== null,
      ),
    };
  }
  return NONE;
}
