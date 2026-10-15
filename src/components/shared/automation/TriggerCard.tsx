/**
 * TriggerCard — one trigger in an automation list (#5808).
 *
 * Collapsed, it shows an optional enable toggle, a title, a one-line summary,
 * small chips and Edit / Delete. Expanded, it renders the protocol's edit form
 * (`children`) with a Done button that asks the section to collapse it.
 *
 * The card holds no trigger state. Edits go straight to the section's draft,
 * and the section's SaveBar saves; `onDone` lets the section validate first
 * and refuse to collapse. Delete asks for confirmation, then calls `onDelete`,
 * which also only edits the draft.
 *
 * The editor's number fields report to a card-level scope, so Done stays off
 * while one holds invalid text. That scope nests inside the section's, so the
 * SaveBar is blocked too.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { NumberInputScope } from '../../common/NumberInputScope';
import { useNumberInputScope } from '../../common/numberInputScopeContext';
import { ConfirmDialog } from './ConfirmDialog';
import styles from './TriggerCard.module.css';

export interface TriggerChip {
  label: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'info' | 'caution';
  title?: string;
}

export interface TriggerCardProps {
  /** Title: the trigger's name, or its pattern when the protocol has no name. */
  title: React.ReactNode;
  /** Render the title in monospace (patterns). */
  titleMono?: boolean;
  /** One-line response summary. */
  summary?: React.ReactNode;
  chips?: TriggerChip[];
  /** Per-trigger enable state. Omit for protocols without one. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  enableLabel?: string;
  expanded: boolean;
  onEdit: () => void;
  /** Ask to collapse. The section may validate and keep the card open. */
  onDone: () => void;
  onDelete: () => void;
  /** Disables Edit, Delete and the toggle (e.g. the section is turned off). */
  disabled?: boolean;
  /** Text for the delete confirmation. */
  deleteTitle?: React.ReactNode;
  deleteMessage?: React.ReactNode;
  /** Shown in the confirmation, e.g. the pattern being removed. */
  deletePreview?: React.ReactNode;
  /** Shown on the collapsed card, e.g. "has errors". */
  invalid?: boolean;
  /**
   * Protocol-only buttons placed before Edit / Delete, e.g. MeshCore "Run
   * now" or a script "Test" (#5812). Shown collapsed and expanded; the
   * caller owns their disabled state.
   */
  actions?: React.ReactNode;
  /** The expanded edit form. Mounted only while expanded. */
  children?: React.ReactNode;
}

/** A button styled like Edit / Delete, for the `actions` slot (#5812). */
export const TriggerCardAction: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    className={className ? `${styles.button} ${className}` : styles.button}
    {...rest}
  />
);

export const TriggerCard: React.FC<TriggerCardProps> = ({
  title,
  titleMono = false,
  summary,
  chips,
  enabled,
  onEnabledChange,
  enableLabel,
  expanded,
  onEdit,
  onDone,
  onDelete,
  disabled = false,
  deleteTitle,
  deleteMessage,
  deletePreview,
  invalid = false,
  actions,
  children,
}) => {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const numberScope = useNumberInputScope();
  const editorId = useId();
  const editorRef = useRef<HTMLDivElement>(null);

  // Move focus into the form when it opens, so keyboard users land on the
  // first field (a newly added trigger opens expanded, too).
  useEffect(() => {
    if (!expanded) return;
    const first = editorRef.current?.querySelector<HTMLElement>(
      'input:not([type="checkbox"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
    );
    first?.focus();
  }, [expanded]);

  const cardClass = [
    styles.card,
    expanded ? styles.expanded : '',
    enabled === false ? styles.off : '',
    invalid && !expanded ? styles.invalid : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClass} data-testid="trigger-card" data-expanded={expanded || undefined}>
      <div className={styles.head}>
        {onEnabledChange && (
          <input
            type="checkbox"
            className={styles.toggle}
            checked={!!enabled}
            disabled={disabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            aria-label={enableLabel}
          />
        )}
        <div className={styles.main}>
          <div className={titleMono ? `${styles.title} ${styles.mono}` : styles.title}>{title}</div>
          {!expanded && summary && <div className={styles.summary}>{summary}</div>}
          {!expanded && (chips?.length || invalid) ? (
            <div className={styles.chips}>
              {invalid && (
                <span className={`${styles.chip} ${styles.chipError}`}>
                  <UiIcon name="alert" size={12} /> {t('automation.trigger_card.has_errors', 'Needs attention')}
                </span>
              )}
              {chips?.map((chip, i) => (
                <span
                  key={i}
                  className={`${styles.chip} ${styles[`tone_${chip.tone ?? 'neutral'}`] ?? ''}`}
                  title={chip.title}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className={styles.actions}>
          {actions}
          {!expanded && (
            <button
              type="button"
              className={styles.button}
              onClick={onEdit}
              disabled={disabled}
              aria-expanded={false}
              aria-controls={editorId}
            >
              <UiIcon name="edit" size={14} /> {t('common.edit', 'Edit')}
            </button>
          )}
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            onClick={() => setConfirming(true)}
            disabled={disabled}
          >
            <UiIcon name="delete" size={14} /> {t('common.delete', 'Delete')}
          </button>
        </div>
      </div>

      {expanded && (
        <div id={editorId} ref={editorRef} className={styles.editor}>
          <NumberInputScope scope={numberScope}>{children}</NumberInputScope>
          <div className={styles.footer}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={onDone}
              disabled={numberScope.invalid}
              aria-expanded
              aria-controls={editorId}
            >
              <UiIcon name="check" size={14} /> {t('common.done', 'Done')}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={deleteTitle ?? t('automation.trigger_card.delete_title', 'Delete trigger?')}
          message={deleteMessage ?? t(
            'automation.trigger_card.delete_message',
            'The trigger is removed from the list now and deleted when you save.',
          )}
          preview={deletePreview}
          confirmLabel={t('common.delete', 'Delete')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
        />
      )}
    </div>
  );
};

export default TriggerCard;
