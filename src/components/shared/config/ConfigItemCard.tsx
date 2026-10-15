/**
 * ConfigItemCard — one item in a config list that opens in place (#5829).
 *
 * Built first as the automation `TriggerCard` (#5808) and generalised so the
 * channel lists can use it too. `TriggerCard` is now a thin wrapper.
 *
 * Collapsed, it shows an optional leading badge, an optional enable toggle, a
 * title, a one-line summary, small chips, an optional notice and Edit /
 * Delete. Expanded, it renders the edit form (`children`) and the caller's
 * `footer` (Done, or Save / Cancel).
 *
 * The card holds no item state. Delete asks for confirmation, then calls
 * `onDelete`. Leave out `onEdit` or `onDelete` to hide that button.
 *
 * The editor's number fields report to a card-level scope; the footer gets
 * `numberInvalid` so it can keep its buttons off while one holds bad text.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { NumberInputScope } from '../../common/NumberInputScope';
import { useNumberInputScope } from '../../common/numberInputScopeContext';
import { ConfirmDialog } from '../automation/ConfirmDialog';
import styles from './ConfigItemCard.module.css';

export interface ConfigItemChip {
  label: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'info' | 'caution';
  title?: string;
}

export interface ConfigItemFooterContext {
  /** A number field in the editor holds invalid text. */
  numberInvalid: boolean;
  /** Id of the editor region, for `aria-controls`. */
  editorId: string;
}

export interface ConfigItemCardProps {
  title: React.ReactNode;
  /** Render the title in monospace (patterns). */
  titleMono?: boolean;
  /** Small badge before the title, e.g. a slot number. */
  leading?: React.ReactNode;
  /** One-line summary, shown collapsed. */
  summary?: React.ReactNode;
  chips?: ConfigItemChip[];
  /** Warning line under the chips, shown collapsed and expanded. */
  notice?: React.ReactNode;
  /** Per-item enable state. Omit for items without one. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  enableLabel?: string;
  expanded: boolean;
  /** Omit to hide Edit (e.g. an item the device will not let you change). */
  onEdit?: () => void;
  /** Omit to hide Delete. */
  onDelete?: () => void;
  /** Disables Edit, Delete and the toggle. */
  disabled?: boolean;
  /** Disables Edit only; `editTitle` says why. */
  editDisabled?: boolean;
  editTitle?: string;
  deleteTitle?: React.ReactNode;
  deleteMessage?: React.ReactNode;
  /** Shown in the confirmation, e.g. the item being removed. */
  deletePreview?: React.ReactNode;
  deleteConfirmLabel?: string;
  /** Shown on the collapsed card, e.g. "has errors". */
  invalid?: boolean;
  invalidLabel?: React.ReactNode;
  /** Extra buttons before Edit / Delete. The caller owns their state. */
  actions?: React.ReactNode;
  /** Accent outline (e.g. a primary channel). */
  highlighted?: boolean;
  /** Rendered under the editor while expanded. */
  footer?: (ctx: ConfigItemFooterContext) => React.ReactNode;
  testId?: string;
  /** The expanded edit form. Mounted only while expanded. */
  children?: React.ReactNode;
}

/** A button styled like Edit / Delete, for the `actions` slot and footers. */
export const ConfigItemCardButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }
> = ({ className, type = 'button', variant = 'default', ...rest }) => {
  const classes = [
    styles.button,
    variant === 'primary' ? styles.primary : '',
    variant === 'danger' ? styles.danger : '',
    className ?? '',
  ].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...rest} />;
};

export const ConfigItemCard: React.FC<ConfigItemCardProps> = ({
  title,
  titleMono = false,
  leading,
  summary,
  chips,
  notice,
  enabled,
  onEnabledChange,
  enableLabel,
  expanded,
  onEdit,
  onDelete,
  disabled = false,
  editDisabled = false,
  editTitle,
  deleteTitle,
  deleteMessage,
  deletePreview,
  deleteConfirmLabel,
  invalid = false,
  invalidLabel,
  actions,
  highlighted = false,
  footer,
  testId = 'config-item-card',
  children,
}) => {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const numberScope = useNumberInputScope();
  const editorId = useId();
  const editorRef = useRef<HTMLDivElement>(null);

  // Move focus into the form when it opens, so keyboard users land on the
  // first field (a newly added item opens expanded, too).
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
    highlighted ? styles.highlight : '',
    enabled === false ? styles.off : '',
    invalid && !expanded ? styles.invalid : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClass} data-testid={testId} data-expanded={expanded || undefined}>
      <div className={styles.head}>
        {leading !== undefined && <span className={styles.leading}>{leading}</span>}
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
                  <UiIcon name="alert" size={12} /> {invalidLabel ?? t('config_item_card.has_errors', 'Needs attention')}
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
          {notice && <div className={styles.notice}>{notice}</div>}
        </div>
        <div className={styles.actions}>
          {actions}
          {!expanded && onEdit && (
            <button
              type="button"
              className={styles.button}
              onClick={onEdit}
              disabled={disabled || editDisabled}
              title={editTitle}
              aria-expanded={false}
              aria-controls={editorId}
            >
              <UiIcon name="edit" size={14} /> {t('common.edit', 'Edit')}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className={`${styles.button} ${styles.danger}`}
              onClick={() => setConfirming(true)}
              disabled={disabled}
            >
              <UiIcon name="delete" size={14} /> {t('common.delete', 'Delete')}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div id={editorId} ref={editorRef} className={styles.editor}>
          <NumberInputScope scope={numberScope}>{children}</NumberInputScope>
          {footer && (
            <div className={styles.footer}>
              {footer({ numberInvalid: numberScope.invalid, editorId })}
            </div>
          )}
        </div>
      )}

      {confirming && onDelete && (
        <ConfirmDialog
          title={deleteTitle ?? t('config_item_card.delete_title', 'Delete this item?')}
          message={deleteMessage}
          preview={deletePreview}
          confirmLabel={deleteConfirmLabel ?? t('common.delete', 'Delete')}
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

export default ConfigItemCard;
