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
}

export interface UnifiedSendRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

/** Route and body for one send from `ref`. Throws when the ref cannot send. */
export function buildUnifiedSendRequest(ref: SenderRef, text: string): UnifiedSendRequest {
  if (!ref.canSend || !ref.sendKind) {
    throw new Error(`Source ${ref.sourceId} cannot send on this channel`);
  }
  const id = encodeURIComponent(ref.sourceId);
  switch (ref.sendKind) {
    case 'meshtastic':
      return {
        endpoint: '/api/messages/send',
        body: { sourceId: ref.sourceId, text, channel: ref.channelNumber },
      };
    case 'mqtt_native':
      return {
        endpoint: `/api/sources/${id}/mqtt/native/send`,
        body: { text, channel: ref.channelNumber },
      };
    case 'meshcore':
      return {
        endpoint: `/api/sources/${id}/meshcore/messages/send`,
        body: { text, channelIdx: ref.channelNumber },
      };
    default:
      throw new Error(`Unknown send kind for source ${ref.sourceId}`);
  }
}

export type UnifiedSendErrorKind =
  | 'rate_limited'
  | 'tx_disabled'
  | 'not_connected'
  | 'forbidden'
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
  if (status === 403 || code === 'FORBIDDEN') return 'forbidden';
  return 'generic';
}
