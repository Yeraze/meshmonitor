/**
 * Cross-source notification key for a MeshCore message (P11 #6253, S4).
 *
 * Why this is MeshCore-only: Meshtastic keys a packet by (from, packetId). A
 * MeshCore channel packet carries neither a sender key nor a packet id that
 * every path knows (`packetHash` is missing on some), and the channel index
 * differs between sources. So the key is built from content both copies share:
 * the sender's wire second, the sender name and the text.
 *
 * The mention and the message notifier both build the key with this function,
 * so a mention and its message alert once per recipient.
 */
import { createHash } from 'node:crypto';
import { meshcoreChannelIndexOf } from '../utils/meshcoreMessageMerge.js';
import type { MeshCoreMessage } from '../meshcoreManager.js';

function hash16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Wire second of the message, or null when the message carries none. */
function wireSecond(msg: Pick<MeshCoreMessage, 'senderTimestamp'>): number | null {
  return typeof msg.senderTimestamp === 'number' && Number.isFinite(msg.senderTimestamp)
    ? Math.floor(msg.senderTimestamp)
    : null;
}

/**
 * @param fromKey  sender's canonical full key for a DM, the author key for a room post
 * @param roomKey  the room's key (room posts only)
 */
export function meshcoreNotificationKey(
  msg: Pick<MeshCoreMessage, 'id' | 'fromPublicKey' | 'fromName' | 'toPublicKey' | 'text' | 'senderTimestamp' | 'timestamp' | 'messageType'>,
  opts: { fromKey?: string; roomKey?: string } = {},
): string {
  const text = msg.text ?? '';
  if (msg.messageType === 'room_post') {
    // A room post carries no `senderTimestamp`; its `timestamp` is the sender's wire time.
    const sec = Math.floor((msg.timestamp ?? 0) / 1000);
    if (sec > 0) {
      const room = (opts.roomKey ?? msg.toPublicKey ?? '').toLowerCase();
      return `meshcore-room:${room}:${(opts.fromKey ?? msg.fromPublicKey ?? '').toLowerCase()}:${sec}:${hash16(text)}`;
    }
    return `meshcore-id:${msg.id}`;
  }
  const sec = wireSecond(msg);
  if (sec === null) return `meshcore-id:${msg.id}`;
  if (meshcoreChannelIndexOf(msg) !== null) {
    return `meshcore-ch:${sec}:${hash16(`${(msg.fromName ?? '').toLowerCase()}\n${text}`)}`;
  }
  return `meshcore-dm:${(opts.fromKey ?? msg.fromPublicKey ?? '').toLowerCase()}:${sec}:${hash16(text)}`;
}
