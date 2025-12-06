/**
 * MessageStatusIndicator - Shared component for message delivery status
 *
 * Displays an icon indicating the current delivery state of a message.
 * Used by both MessagesTab and ChannelsTab.
 */

import React from 'react';
import { MeshMessage, MessageDeliveryState } from '../types/message';

/** Timeout for pending messages before showing timeout indicator */
const TIMEOUT_MS = 30000;

interface MessageStatusIndicatorProps {
  message: MeshMessage;
}

/**
 * Render message delivery status indicator
 */
export function MessageStatusIndicator({ message }: MessageStatusIndicatorProps): React.ReactElement {
  const messageAge = Date.now() - message.timestamp.getTime();

  // Check for explicit failures first
  if (message.ackFailed || message.routingErrorReceived || message.deliveryState === MessageDeliveryState.FAILED) {
    return (
      <span className="status-failed" title="Failed to send - routing error or max retries exceeded">
        ❌
      </span>
    );
  }

  // Confirmed - received by target node (DMs only)
  if (message.deliveryState === MessageDeliveryState.CONFIRMED) {
    return (
      <span className="status-confirmed" title="Received by target node">
        🔒
      </span>
    );
  }

  // Delivered - transmitted to mesh
  if (message.deliveryState === MessageDeliveryState.DELIVERED) {
    return (
      <span className="status-delivered" title="Transmitted to mesh">
        ✅
      </span>
    );
  }

  // Pending - still waiting for acknowledgment
  if (messageAge < TIMEOUT_MS) {
    return (
      <span className="status-pending" title="Sending...">
        ⏳
      </span>
    );
  }

  // Timeout - no acknowledgment received
  return (
    <span className="status-timeout" title="No acknowledgment received (timeout)">
      ⏱️
    </span>
  );
}

export default MessageStatusIndicator;
