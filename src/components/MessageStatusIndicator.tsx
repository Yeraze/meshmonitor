/**
 * MessageStatusIndicator - Shared component for message delivery status
 *
 * Displays an icon indicating the current delivery state of a message.
 * Used by both MessagesTab and ChannelsTab.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshMessage } from '../types/message';
import { UiIcon, type UiIconName } from './icons';
import { getMeshtasticDeliveryState, TIMEOUT_MS } from '../utils/deliveryDiagnostics/status';
import styles from './MessageStatusIndicator.module.css';

interface MessageStatusIndicatorProps {
  message: MeshMessage;
  /** When provided, the indicator becomes a clickable button that opens the
   *  Delivery Details modal for this message (#4816 Phase 1). When absent,
   *  it stays a plain, non-interactive `<span>` for backward compatibility
   *  with existing callers/tests. */
  onShowDetails?: () => void;
}

/**
 * Render message delivery status indicator
 */
export function MessageStatusIndicator({ message, onShowDetails }: MessageStatusIndicatorProps): React.ReactElement {
  const { t } = useTranslation();
  const state = getMeshtasticDeliveryState(message);

  // A pending message turns into "timeout" TIMEOUT_MS after it was sent. The
  // message rows are memoized and no longer redraw on every poll or status
  // tick, so the indicator re-renders itself once at that moment.
  const [, setExpired] = useState(0);
  const sentAt = message.timestamp.getTime();
  useEffect(() => {
    if (state !== 'pending') return;
    const remaining = sentAt + TIMEOUT_MS - Date.now();
    const timer = setTimeout(() => setExpired((n) => n + 1), Math.max(0, remaining) + 50);
    return () => clearTimeout(timer);
  }, [state, sentAt]);

  let className: string;
  let titleKey: string;
  let iconName: UiIconName;

  switch (state) {
    case 'failed':
      className = 'status-failed';
      titleKey = 'message_status.failed';
      iconName = 'error';
      break;
    case 'confirmed':
      className = 'status-confirmed';
      titleKey = 'message_status.confirmed';
      iconName = 'encrypted';
      break;
    case 'delivered':
      className = 'status-delivered';
      titleKey = 'message_status.delivered';
      iconName = 'check';
      break;
    case 'pending':
      className = 'status-pending';
      titleKey = 'message_status.pending';
      iconName = 'time';
      break;
    case 'timeout':
    default:
      className = 'status-timeout';
      titleKey = 'message_status.timeout';
      iconName = 'timer';
      break;
  }

  const title = t(titleKey);

  if (onShowDetails) {
    return (
      <button
        type="button"
        className={`${className} ${styles.resetButton}`}
        title={title}
        aria-label={title}
        onClick={onShowDetails}
      >
        <UiIcon name={iconName} />
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      <UiIcon name={iconName} />
    </span>
  );
}

export default MessageStatusIndicator;
