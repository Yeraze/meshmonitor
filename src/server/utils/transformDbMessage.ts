import { DbMessage } from '../../services/database.js';
import { MeshMessage } from '../../types/message.js';
import { canonicalMessageTime, messageReceivedAt } from './messageTime.js';

/**
 * Transform a DbMessage (raw repository row shape) into the MeshMessage shape
 * consumed by the frontend. This mirrors the transformation in
 * meshtasticManager.getRecentMessages().
 *
 * Extracted verbatim from server.ts (was `transformDbMessageToMeshMessage`,
 * L2337) as part of #3502 — shared by messageRoutes and pollRoutes.
 */
export function transformDbMessageToMeshMessage(msg: DbMessage): MeshMessage {
  return {
    id: msg.id,
    from: msg.fromNodeId,
    to: msg.toNodeId,
    fromNodeId: msg.fromNodeId,
    toNodeId: msg.toNodeId,
    text: msg.text,
    channel: msg.channel,
    portnum: msg.portnum ?? undefined,
    timestamp: new Date(canonicalMessageTime(msg)),
    // Server-side ingest time — robust against sender-clock drift, used by
    // the client for sort order (issue #3187). Falls back to `timestamp` for
    // pre-migration rows where `createdAt` was never written.
    receivedAt: new Date(messageReceivedAt(msg)),
    hopStart: msg.hopStart ?? undefined,
    hopLimit: msg.hopLimit ?? undefined,
    relayNode: msg.relayNode ?? undefined,
    replyId: msg.replyId ?? undefined,
    emoji: msg.emoji ?? undefined,
    viaMqtt: Boolean((msg as any).viaMqtt),
    rxSnr: msg.rxSnr ?? undefined,
    rxRssi: msg.rxRssi ?? undefined,
    requestId: (msg as any).requestId,
    wantAck: Boolean((msg as any).wantAck),
    ackFailed: Boolean((msg as any).ackFailed),
    routingErrorReceived: Boolean((msg as any).routingErrorReceived),
    deliveryState: (msg as any).deliveryState,
    acknowledged:
      msg.channel === -1
        ? (msg as any).deliveryState === 'confirmed'
          ? true
          : undefined
        : (msg as any).deliveryState === 'delivered' || (msg as any).deliveryState === 'confirmed'
        ? true
        : undefined,
    decryptedBy: msg.decryptedBy ?? (msg as any).decrypted_by ?? null,
    sourceIp: (msg as any).sourceIp ?? (msg as any).source_ip ?? null,
    sourcePath: (msg as any).sourcePath ?? (msg as any).source_path ?? null,
    spoofSuspected: Boolean((msg as any).spoofSuspected),
  };
}
