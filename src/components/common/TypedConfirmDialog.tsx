import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import styles from './TypedConfirmDialog.module.css';

export interface TypedConfirmDialogProps {
  isOpen: boolean;
  title: string;
  /** What the action does. Plain text or any nodes. */
  children: React.ReactNode;
  /**
   * The word the user must type before Confirm unlocks. Leave it out for a
   * plain confirm with the same look.
   */
  confirmWord?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Style Confirm as a destructive action. */
  danger?: boolean;
  /** Disable both buttons while the action runs. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** True when `typed` matches `word`, ignoring surrounding spaces. */
function matchesConfirmWord(typed: string, word: string): boolean {
  return typed.trim() === word.trim();
}

/**
 * A confirm dialog for actions that are hard to undo. With `confirmWord` set,
 * Confirm stays locked until the user types that word.
 */
export const TypedConfirmDialog: React.FC<TypedConfirmDialogProps> = ({
  isOpen,
  title,
  children,
  confirmWord,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const inputId = useId();
  const [typed, setTyped] = useState('');

  // Start empty each time the dialog opens or the word changes.
  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen, confirmWord]);

  const needsWord = confirmWord !== undefined && confirmWord.trim() !== '';
  const unlocked = !needsWord || matchesConfirmWord(typed, confirmWord);
  const canConfirm = unlocked && !busy;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canConfirm) onConfirm();
  };

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title} closeOnOverlayClick={false}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.body}>{children}</div>

        {needsWord && (
          <div className={styles.field}>
            <label htmlFor={inputId} className={styles.label}>
              {t('typed_confirm.prompt', { word: confirmWord })}
            </label>
            <input
              id={inputId}
              type="text"
              className={styles.input}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </div>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="submit"
            className={danger ? `${styles.confirm} ${styles.danger}` : styles.confirm}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default TypedConfirmDialog;
