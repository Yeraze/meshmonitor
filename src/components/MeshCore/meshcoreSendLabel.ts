/**
 * Hover / screen-reader text for the delivery mark on one of our MeshCore
 * DMs or room posts (#5682). Kept out of the stream component so it can be
 * tested alone, and so each line says only what the protocol backs: see
 * `getMeshCoreDirectSendState` for what each state means.
 */
import type { TFunction } from 'i18next';
import type { MeshCoreDirectSend } from '../../utils/deliveryDiagnostics/status';

const FALLBACK: Record<string, string> = {
  'dm.sent_to_radio':
    'Your radio accepted this message. MeshMonitor has no acknowledgement on record for it, so it cannot tell whether it arrived.',
  'dm.awaiting_ack':
    "Your radio accepted this message and MeshMonitor is waiting for the recipient's radio to acknowledge it. MeshCore radios do not report when they transmit.",
  'dm.delivered': "Delivered: the recipient's radio acknowledged this message.",
  'dm.delivered_rtt': "Delivered: the recipient's radio acknowledged this message ({{ms}} ms).",
  'dm.not_confirmed':
    'Not confirmed: no acknowledgement arrived after all retries. The message may still have arrived.',
  'room_post.sent_to_radio':
    'Your radio accepted this post. MeshMonitor has no acknowledgement on record for it, so it cannot tell whether the room server got it.',
  'room_post.awaiting_ack':
    'Your radio accepted this post and MeshMonitor is waiting for the room server to acknowledge it. MeshCore radios do not report when they transmit.',
  'room_post.delivered': 'The room server acknowledged this post.',
  'room_post.delivered_rtt': 'The room server acknowledged this post ({{ms}} ms).',
  'room_post.not_confirmed':
    'Not confirmed: the room server did not acknowledge this post in time. The post may still have arrived.',
};

export function directSendLabelKey(send: MeshCoreDirectSend, roundTripMs?: number): string {
  const withRtt = send.state === 'delivered' && typeof roundTripMs === 'number';
  return `${send.kind}.${send.state}${withRtt ? '_rtt' : ''}`;
}

export function directSendLabel(t: TFunction, send: MeshCoreDirectSend, roundTripMs?: number): string {
  const key = directSendLabelKey(send, roundTripMs);
  return t(`meshcore.send_state.${key}`, FALLBACK[key], { ms: roundTripMs });
}

/** Exposed so a test can hold the fallbacks against `en.json`. */
export const DIRECT_SEND_LABEL_FALLBACKS: Readonly<Record<string, string>> = FALLBACK;
