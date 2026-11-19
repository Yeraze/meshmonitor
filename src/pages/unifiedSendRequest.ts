/**
 * Builds the send request for the Unified Messages composer (#3045 P2).
 *
 * The channel number comes ONLY from the chosen ref: the same channel name can
 * sit on a different slot on each source, and MQTT-native refs already carry
 * their virtual-channel number. Types mirror the server's `SenderRef` in
 * `src/server/services/unifiedSendEligibility.ts` but are declared here so
 * client code never imports server modules.
 */

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
  /** MeshCore refs only: whether this source may send reactions. Null for other kinds. */
  reactionsOutbound: boolean | null;
}

export interface UnifiedSendRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

export interface UnifiedSendOptions {
  /** Wire id of the parent: its `packetId`, never its `requestId`. */
  replyId?: number;
  /** Send `text` as a tapback (`emoji: 1`). */
  tapback?: boolean;
  /** MeshCore reply only: the parent's region name, so the reply stays in its region. */
  scope?: string;
}

/**
 * Route and body for one send from `ref`. Throws when the ref cannot send.
 * MeshCore uses only `opts.scope`: a reply is a text prefix and a tapback has its own route.
 */
export function buildUnifiedSendRequest(
  ref: SenderRef,
  text: string,
  opts?: UnifiedSendOptions,
): UnifiedSendRequest {
  if (!ref.canSend || !ref.sendKind) {
    throw new Error(`Source ${ref.sourceId} cannot send on this channel`);
  }
  const id = encodeURIComponent(ref.sourceId);
  const extra: Record<string, unknown> = {};
  if (opts?.replyId != null) extra.replyId = opts.replyId;
  if (opts?.tapback) extra.emoji = 1;
  switch (ref.sendKind) {
    case 'meshtastic':
      return {
        endpoint: '/api/messages/send',
        body: { sourceId: ref.sourceId, text, channel: ref.channelNumber, ...extra },
      };
    case 'mqtt_native':
      return {
        endpoint: `/api/sources/${id}/mqtt/native/send`,
        body: { text, channel: ref.channelNumber, ...extra },
      };
    case 'meshcore':
      return {
        endpoint: `/api/sources/${id}/meshcore/messages/send`,
        body: { text, channelIdx: ref.channelNumber, ...(opts?.scope ? { scope: opts.scope } : {}) },
      };
    default:
      throw new Error(`Unknown send kind for source ${ref.sourceId}`);
  }
}

/** Server-side fields of the parent message that a reply or tapback needs. */
export interface UnifiedSendParent {
  packetId: number | null;
  meshcoreRowRefs?: string[];
}

/**
 * Row id of the parent on one MeshCore source. A source can hold two refs; take
 * the first. The id may itself contain ':', so slice off the prefix, never split.
 */
export function meshcoreRowIdFor(rowRefs: string[] | undefined, sourceId: string): string | null {
  const prefix = `mc:${sourceId}:`;
  const hit = rowRefs?.find((r) => r.startsWith(prefix));
  if (!hit) return null;
  const id = hit.slice(prefix.length);
  return id || null;
}

/** Route and body for one tapback from `ref`. Throws when it cannot be built. */
export function buildUnifiedReactionRequest(
  ref: SenderRef,
  parent: UnifiedSendParent,
  emoji: string,
): UnifiedSendRequest {
  if (ref.sendKind === 'meshcore') {
    if (!ref.canSend) throw new Error(`Source ${ref.sourceId} cannot send on this channel`);
    const rowId = meshcoreRowIdFor(parent.meshcoreRowRefs, ref.sourceId);
    if (!rowId) throw new Error(`Source ${ref.sourceId} has no copy of this message`);
    return {
      endpoint: `/api/sources/${encodeURIComponent(ref.sourceId)}/meshcore/messages/${encodeURIComponent(rowId)}/reaction`,
      body: { emoji },
    };
  }
  if (parent.packetId == null) throw new Error('This message has no packet id to react to');
  return buildUnifiedSendRequest(ref, emoji, { replyId: parent.packetId, tapback: true });
}

/** `@[Name]: ` prefix for a MeshCore reply, or null when the name cannot be framed. */
export function meshcoreReplyPrefix(name: string | null | undefined): string | null {
  if (!name || name.includes(']') || /[\r\n]/.test(name)) return null;
  return `@[${name}]: `;
}

export type TargetMode = 'reply' | 'react';

export interface SendTarget {
  mode: TargetMode;
  /** Protocol of the parent message. */
  /** `unsupported` (e.g. Reticulum): no node here can answer it. */
  protocol: 'meshtastic' | 'meshcore' | 'unsupported';
  meshcoreRowRefs?: string[];
}

export type SenderFitReason = 'not_heard' | 'reactions_off';

/** Whether `ref` may answer `target`. Cross-protocol refs do not fit and are not listed. */
export function senderFitsTarget(
  ref: SenderRef,
  target: SendTarget | null | undefined,
): { fits: boolean; reason?: SenderFitReason } {
  if (!target) return { fits: true };
  if (target.protocol === 'unsupported') return { fits: false };
  if (target.protocol === 'meshtastic') {
    return { fits: ref.sendKind === 'meshtastic' || ref.sendKind === 'mqtt_native' };
  }
  if (ref.sendKind !== 'meshcore') return { fits: false };
  if (target.mode === 'reply') return { fits: true };
  if (!meshcoreRowIdFor(target.meshcoreRowRefs, ref.sourceId)) return { fits: false, reason: 'not_heard' };
  if (ref.reactionsOutbound !== true) return { fits: false, reason: 'reactions_off' };
  return { fits: true };
}

export type UnifiedSendErrorKind =
  | 'rate_limited'
  | 'tx_disabled'
  | 'not_connected'
  | 'forbidden'
  | 'duplicate_reaction'
  | 'reactions_off'
  | 'target_missing'
  | 'not_reactable'
  | 'invalid_emoji'
  | 'generic';

/** Classify a thrown send error. Duck-types `{status, code}` (an `ApiError`). */
export function unifiedSendErrorKind(err: unknown): UnifiedSendErrorKind {
  const e = (err && typeof err === 'object' ? err : {}) as { status?: unknown; code?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (status === 429 || code === 'RATE_LIMITED') return 'rate_limited';
  if (code === 'TX_DISABLED') return 'tx_disabled';
  if (code === 'SOURCE_NOT_CONNECTED' || code === 'NOT_CONNECTED' || code === 'SOURCE_NOT_FOUND') {
    return 'not_connected';
  }
  if (code === 'DUPLICATE_REACTION') return 'duplicate_reaction';
  if (code === 'REACTIONS_OUTBOUND_DISABLED') return 'reactions_off';
  if (code === 'MESSAGE_NOT_FOUND') return 'target_missing';
  if (
    code === 'TARGET_IS_REACTION' ||
    code === 'TARGET_IS_ROOM_POST' ||
    code === 'TARGET_NO_HASH' ||
    code === 'TARGET_NOT_REACTABLE'
  ) {
    return 'not_reactable';
  }
  if (code === 'INVALID_EMOJI') return 'invalid_emoji';
  if (status === 403 || code === 'FORBIDDEN') return 'forbidden';
  return 'generic';
}
