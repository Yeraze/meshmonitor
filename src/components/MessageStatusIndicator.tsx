/**
 * MessageStatusIndicator - Shared component for message delivery status
 *
 * Displays an icon indicating the current delivery state of a message.
 * Used by both MessagesTab and ChannelsTab.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { MeshMessage } from '../types/message';
import { UiIcon, type UiIconName } from './icons';
import { getMeshtasticDeliveryState } from '../utils/deliveryDiagnostics/status';
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
