/**
 * MessageStatusIndicator - Shared component for message delivery status
 *
 * Displays an icon indicating the current delivery state of a message.
 * Used by both MessagesTab and ChannelsTab.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const messageAge = Date.now() - message.timestamp.getTime();

  // Check for explicit failures first
  if (message.ackFailed || message.routingErrorReceived || message.deliveryState === MessageDeliveryState.FAILED) {
    return (
      <span className="status-failed" title={t('message_status.failed')}>
        ❌
      </span>
    );
  }

  // Confirmed - received by target node (DMs only)
  if (message.deliveryState === MessageDeliveryState.CONFIRMED) {
    return (
      <span className="status-confirmed" title={t('message_status.confirmed')}>
        🔒
      </span>
    );
  }

  // Delivered - transmitted to mesh
  if (message.deliveryState === MessageDeliveryState.DELIVERED) {
    return (
      <span className="status-delivered" title={t('message_status.delivered')}>
        ✅
      </span>
    );
  }

  // Pending - still waiting for acknowledgment
  if (messageAge < TIMEOUT_MS) {
    return (
      <span className="status-pending" title={t('message_status.pending')}>
        ⏳
      </span>
    );
  }

  // Timeout - no acknowledgment received
  return (
    <span className="status-timeout" title={t('message_status.timeout')}>
      ⏱️
    </span>
  );
}

export default MessageStatusIndicator;
