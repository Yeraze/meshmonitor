/**
 * DiscardChangesDialog — "drop your unsaved edits?" for lists that open one
 * card at a time (#5829). Pair it with `useDiscardGuard`.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../automation/ConfirmDialog';
import type { DiscardGuard } from './useDiscardGuard';

export const DiscardChangesDialog: React.FC<{ guard: DiscardGuard; itemLabel?: React.ReactNode }> = ({
  guard,
  itemLabel,
}) => {
  const { t } = useTranslation();
  if (!guard.pending) return null;
  return (
    <ConfirmDialog
      title={t('config_item_card.discard_title', 'Discard unsaved changes?')}
      message={t(
        'config_item_card.discard_message',
        'You have changes that are not saved to the device. Opening another item drops them.',
      )}
      preview={itemLabel}
      confirmLabel={t('config_item_card.discard_confirm', 'Discard changes')}
      cancelLabel={t('config_item_card.keep_editing', 'Keep editing')}
      onConfirm={guard.confirmDiscard}
      onCancel={guard.cancelDiscard}
    />
  );
};

export default DiscardChangesDialog;
