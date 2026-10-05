import React from 'react';
import { useTranslation } from 'react-i18next';
import { TypedConfirmDialog } from '../common/TypedConfirmDialog';
import { PacketSignaturePolicy } from '../../utils/packetSignaturePolicy';

/** A policy change waiting for the user's answer. */
export interface PendingPolicyChange {
  /** The policy being set: BALANCED (plain confirm) or STRICT (typed confirm). */
  to: number;
  /** How the node is named in the dialog. */
  nodeLabel: string;
  /** The word to type for STRICT: the node's short name. */
  confirmWord: string;
}

export interface PacketSignaturePolicyConfirmDialogProps {
  pending: PendingPolicyChange | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirm shown before a policy change goes out (#5612): a plain confirm
 * for Balanced, a typed one (the node's short name) for Strict.
 */
export const PacketSignaturePolicyConfirmDialog: React.FC<PacketSignaturePolicyConfirmDialogProps> = ({
  pending,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const strict = pending?.to === PacketSignaturePolicy.STRICT;
  const node = pending?.nodeLabel ?? '';

  return (
    <TypedConfirmDialog
      isOpen={pending !== null}
      title={strict ? t('signature_policy.confirm_strict_title') : t('signature_policy.confirm_balanced_title')}
      confirmWord={strict ? pending?.confirmWord : undefined}
      confirmLabel={strict ? t('signature_policy.confirm_strict_button') : t('signature_policy.confirm_balanced_button')}
      danger={strict}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {strict ? (
        <>
          <p>{t('signature_policy.confirm_strict_body', { node })}</p>
          <ul>
            <li>{t('signature_policy.strict_drops_old_peers')}</li>
            <li>{t('signature_policy.strict_drops_unicasts')}</li>
            <li>{t('signature_policy.strict_drops_large_broadcasts')}</li>
          </ul>
          <p>{t('signature_policy.confirm_strict_cutoff')}</p>
        </>
      ) : (
        <>
          <p>{t('signature_policy.confirm_balanced_body', { node })}</p>
          <p>{t('signature_policy.balanced_warning')}</p>
        </>
      )}
      <p>{t('signature_policy.reboot_note')}</p>
    </TypedConfirmDialog>
  );
};

export default PacketSignaturePolicyConfirmDialog;
