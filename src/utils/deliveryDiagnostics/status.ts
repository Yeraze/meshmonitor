/**
 * Shared, pure delivery-state selectors (#4816 Phase 1).
 *
 * Extracted so the status icon (`MessageStatusIndicator`) and the Delivery
 * Details modal's describe functions can never disagree about what state a
 * message is in — both consume these selectors instead of re-implementing
 * the branching logic separately.
 */

import { MeshMessage, MessageDeliveryState } from '../../types/message.js';
import type { MeshCoreMessage, MessageDeliveryStatus } from '../../components/MeshCore/hooks/useMeshCore.js';

/** Timeout for pending messages before showing the timeout indicator (ms). */
export const TIMEOUT_MS = 30000;

export type MeshtasticDeliveryState = 'failed' | 'confirmed' | 'delivered' | 'pending' | 'timeout';

export type MeshCoreDeliveryState = 'sending' | 'sent' | 'delivered' | 'failed' | 'unknown';

/**
 * Reproduces `MessageStatusIndicator`'s current branching EXACTLY:
 * failed > confirmed > delivered > pending (age < TIMEOUT_MS) > timeout.
 *
 * `now` defaults to `Date.now()` but can be passed explicitly for
 * deterministic tests of the 30s pending/timeout boundary.
 */
export function getMeshtasticDeliveryState(
  message: Pick<MeshMessage, 'ackFailed' | 'routingErrorReceived' | 'deliveryState' | 'timestamp'>,
  now: number = Date.now()
): MeshtasticDeliveryState {
  // Check for explicit failures first
  if (
    message.ackFailed ||
    message.routingErrorReceived ||
    message.deliveryState === MessageDeliveryState.FAILED
  ) {
    return 'failed';
  }

  // Confirmed - received by target node (DMs only)
  if (message.deliveryState === MessageDeliveryState.CONFIRMED) {
    return 'confirmed';
  }

  // Delivered - transmitted to mesh
  if (message.deliveryState === MessageDeliveryState.DELIVERED) {
    return 'delivered';
  }

  // Pending - still waiting for acknowledgment
  const messageAge = now - message.timestamp.getTime();
  if (messageAge < TIMEOUT_MS) {
    return 'pending';
  }

  // Timeout - no acknowledgment received
  return 'timeout';
}

/** Maps a MeshCore message's `deliveryStatus` to a normalized state. */
export function getMeshCoreDeliveryState(
  deliveryStatus: MessageDeliveryStatus | undefined
): MeshCoreDeliveryState {
  switch (deliveryStatus) {
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * State of one of OUR MeshCore channel sends (#5682).
 *
 * - `sent_to_radio`: the companion answered `Ok` to the send command, which is
 *   the only reason the row exists (a refused or failed send stores no row).
 *   `Ok` means the firmware built the packet and queued it. The companion
 *   protocol has no transmit report: `LogRxData` (0x88) fires on receive only,
 *   and the firmware's `logTx` / `logTxFail` hooks are not wired to the host.
 *   So this state does NOT say the radio transmitted, and says nothing about
 *   who heard it.
 * - `relayed`: MeshMonitor heard at least one repeater re-flood the message
 *   (`heardBy`, #3700). That does prove it went out.
 *
 * Derived from fields the row already carries, so a message reads the same
 * live, after a reload and after a restart, and a state can only move forward:
 * `heardBy` is a stored set that never shrinks.
 *
 * Returns null for anything else: received messages, DMs (they have a real
 * ack, see `getMeshCoreDeliveryState`) and room posts.
 */
export type MeshCoreChannelSendState = 'sent_to_radio' | 'relayed';

export function getMeshCoreChannelSendState(
  msg: Pick<MeshCoreMessage, 'fromPublicKey' | 'toPublicKey' | 'heardBy' | 'messageType'>,
  selfPublicKey: string | null | undefined,
): MeshCoreChannelSendState | null {
  if (!selfPublicKey || msg.fromPublicKey !== selfPublicKey) return null;
  if (!msg.toPublicKey || !msg.toPublicKey.startsWith('channel-')) return null;
  if (msg.messageType === 'room_post') return null;
  return msg.heardBy && msg.heardBy.length > 0 ? 'relayed' : 'sent_to_radio';
}
