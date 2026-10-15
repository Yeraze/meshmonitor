/**
 * ConfirmDialog — small "are you sure?" dialog shared by the automation
 * sections (#5808).
 *
 * Render it only while open. It takes Escape, initial focus, focus restore and
 * the focus trap from `useDialogA11y`, and portals to `document.body` so a
 * parent `<fieldset disabled>` or a faded section body cannot disable or dim
 * it.
 */
import React, { useId } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '../../../hooks/useDialogA11y';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  title: React.ReactNode;
  message?: React.ReactNode;
  /** Optional block under the message, e.g. the item being removed. */
  preview?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** Styles the confirm button as destructive. Default true. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  preview,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
}) => {
  const { contentRef, onKeyDown } = useDialogA11y(onCancel);
  const titleId = useId();
  const messageId = useId();

  return createPortal(
    <div className={styles.overlay} role="presentation">
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={styles.panel}
      >
        <h3 id={titleId} className={styles.title}>{title}</h3>
        {message && <p id={messageId} className={styles.message}>{message}</p>}
        {preview && <div className={styles.preview}>{preview}</div>}
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? styles.danger : styles.confirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ConfirmDialog;
