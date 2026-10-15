/**
 * ReceiveOnlyNote — protocol-neutral "paused" note (#5807).
 *
 * Shown at a config section whose settings stay saved but whose effect is
 * paused because the source cannot transmit (MeshCore receive-only mode,
 * Meshtastic TX disabled, MQTT). Renders `null` when not receive-only and a
 * single `role="status"` line otherwise. Pass `children` to replace the
 * default wording (MeshCore keeps its own "receive-only mode" text).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './ReceiveOnlyNote.module.css';

export interface ReceiveOnlyNoteProps {
  /** When falsy, the component renders nothing. */
  receiveOnly?: boolean;
  className?: string;
  /** Message override; defaults to the neutral paused text. */
  children?: React.ReactNode;
}

export const ReceiveOnlyNote: React.FC<ReceiveOnlyNoteProps> = ({
  receiveOnly,
  className,
  children,
}) => {
  const { t } = useTranslation();
  if (!receiveOnly) return null;

  return (
    <p role="status" className={className ? `${styles.note} ${className}` : styles.note}>
      <UiIcon name="pause" size={14} />
      {children ?? t(
        'automation.receive_only_note',
        'Paused: this source cannot transmit right now. These settings are saved and unchanged, and take effect again once it can.',
      )}
    </p>
  );
};

export default ReceiveOnlyNote;
