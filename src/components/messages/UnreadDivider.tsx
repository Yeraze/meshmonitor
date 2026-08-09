/**
 * UnreadDivider (#4607)
 *
 * The red "New messages" line drawn immediately above the oldest message the
 * operator had not seen when they opened the conversation. One component for
 * all three conversation surfaces (Meshtastic channels, Meshtastic DMs,
 * MeshCore stream) so the line looks and behaves the same everywhere.
 *
 * It carries `data-unread-divider` and an id so the entry-scroll logic in each
 * view can find it without knowing anything about this component's markup.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './UnreadDivider.module.css';

/** DOM id of the divider. Views scroll to this element on conversation entry. */
export const UNREAD_DIVIDER_ID = 'unread-divider';

const UnreadDivider: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div
      id={UNREAD_DIVIDER_ID}
      data-unread-divider="true"
      className={styles.divider}
      role="separator"
      aria-label={t('messages.unread_divider', 'New messages')}
    >
      <span className={styles.rule} />
      <span className={styles.label}>{t('messages.unread_divider', 'New messages')}</span>
      <span className={styles.rule} />
    </div>
  );
};

export default UnreadDivider;
