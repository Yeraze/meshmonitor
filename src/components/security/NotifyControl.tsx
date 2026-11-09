import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { NotifyState } from './securityTypes';
import styles from './SecurityIssues.module.css';

interface NotifyControlProps {
  state: NotifyState | undefined;
  onSend: () => void;
}

/**
 * "Send notification" button for one issue row, plus the flood warning. It only
 * opens a DM with a pre-filled draft: the user reads it and presses Send.
 */
export const NotifyControl: React.FC<NotifyControlProps> = ({ state, onSend }) => {
  const { t } = useTranslation();
  if (!state?.visible) return null;
  return (
    <span className={styles.notifyGroup}>
      <button
        className="send-notification-btn"
        disabled={state.disabled}
        onClick={(e) => {
          e.stopPropagation();
          onSend();
        }}
        title={state.hint ?? t('security.send_notification_title')}
      >
        <UiIcon name="forward" size={14} />
      </button>
      {state.floodWarning && !state.disabled && (
        <span className={styles.floodWarning} data-testid="security-flood-warning">
          {t('security.notify_flood_warning', 'No known path: this DM will flood the mesh')}
        </span>
      )}
    </span>
  );
};
