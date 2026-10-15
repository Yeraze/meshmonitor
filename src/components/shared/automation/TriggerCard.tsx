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
 * The layout lives in the shared `ConfigItemCard` (#5829); this wrapper adds
 * the Done footer and the trigger wording. The editor's number fields report
 * to a card-level scope, so Done stays off while one holds invalid text. That
 * scope nests inside the section's, so the SaveBar is blocked too.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import {
  ConfigItemCard,
  ConfigItemCardButton,
  type ConfigItemChip,
} from '../config/ConfigItemCard';

export type TriggerChip = ConfigItemChip;

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
export const TriggerCardAction: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = (props) => (
  <ConfigItemCardButton {...props} />
);

export const TriggerCard: React.FC<TriggerCardProps> = ({
  onDone,
  deleteTitle,
  deleteMessage,
  children,
  ...rest
}) => {
  const { t } = useTranslation();
  return (
    <ConfigItemCard
      {...rest}
      testId="trigger-card"
      invalidLabel={t('automation.trigger_card.has_errors', 'Needs attention')}
      deleteTitle={deleteTitle ?? t('automation.trigger_card.delete_title', 'Delete trigger?')}
      deleteMessage={deleteMessage ?? t(
        'automation.trigger_card.delete_message',
        'The trigger is removed from the list now and deleted when you save.',
      )}
      footer={({ numberInvalid, editorId }) => (
        <ConfigItemCardButton
          variant="primary"
          onClick={onDone}
          disabled={numberInvalid}
          aria-expanded
          aria-controls={editorId}
        >
          <UiIcon name="check" size={14} /> {t('common.done', 'Done')}
        </ConfigItemCardButton>
      )}
    >
      {children}
    </ConfigItemCard>
  );
};

export default TriggerCard;
