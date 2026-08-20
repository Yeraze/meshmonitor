/**
 * Shared, pure delivery-state selectors (#4816 Phase 1).
 *
 * Extracted so the status icon (`MessageStatusIndicator`) and the Delivery
 * Details modal's describe functions can never disagree about what state a
 * message is in — both consume these selectors instead of re-implementing
 * the branching logic separately.
 */

import { MeshMessage, MessageDeliveryState } from '../../types/message.js';
import type { MessageDeliveryStatus } from '../../components/MeshCore/hooks/useMeshCore.js';

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
