/**
 * Import a MeshCore One contact-share token (#6370).
 *
 * Opened from the contact icon next to a `<PUBKEYHEX:type:name>` token in a
 * message, or from the Nodes view Import dialog. Shows the name, type and
 * public key, then writes the contact to the companion radio's own contact
 * list (a local serial/TCP write, nothing goes on the air).
 *
 * When the radio's list is full the server answers CONTACT_TABLE_FULL_CONFIRM;
 * the modal asks in place and retries with `confirmFull`. Favourites are never
 * replaced (the server enforces it).
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { UiIcon } from '../icons';
import type { AddContactToDeviceResponse } from './hooks/useMeshCore';
import { meshcoreRoleIconName, meshcoreRoleLabelKey, MESHCORE_DEVICE_TYPE_LABELS } from './meshcoreRole';
import type { MeshCoreContactToken } from '../../utils/meshcoreContactToken';
import styles from './MeshCoreContactToken.module.css';

export interface MeshCoreContactTokenModalProps {
  /** The parsed token; null closes the modal. */
  token: MeshCoreContactToken | null;
  /** The token text as it appeared, sent to the server as-is. */
  raw: string;
  onClose: () => void;
  /** Writes the token to the radio. Unset: Import is not offered. */
  onImport?: (raw: string, confirmFull: boolean) => Promise<AddContactToDeviceResponse>;
  /** False disables Import; `disabledReason` says why. */
  canImport: boolean;
  disabledReason?: string;
  /** The source's own public key (lower-case hex), to spot a self token. */
  selfPublicKey?: string;
  /** Name MeshMonitor already shows for this key, when it knows the node. */
  knownName?: string | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'confirmFull'; message: string }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

export const MeshCoreContactTokenModal: React.FC<MeshCoreContactTokenModalProps> = ({
  token,
  raw,
  onClose,
  onImport,
  canImport,
  disabledReason,
  selfPublicKey,
  knownName,
}) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // A new token starts fresh.
  useEffect(() => {
    setPhase({ kind: 'idle' });
  }, [raw]);

  if (!token) return null;

  const isSelf = !!selfPublicKey && selfPublicKey.toLowerCase() === token.publicKey;
  const busy = phase.kind === 'busy';
  const roleIcon = meshcoreRoleIconName(token.type);
  const typeLabel = t(meshcoreRoleLabelKey(token.type), MESHCORE_DEVICE_TYPE_LABELS[token.type]);

  const reason = isSelf
    ? t('meshcore.contact_token.self', "This is your radio's own contact.")
    : !onImport || !canImport
      ? (disabledReason ?? t('meshcore.contact_token.import_unavailable', 'Importing needs a connected Companion radio and permission to edit nodes.'))
      : null;

  const runImport = async (confirmFull: boolean) => {
    if (!onImport || busy) return;
    setPhase({ kind: 'busy' });
    const result = await onImport(raw, confirmFull);
    if (!result.success && result.code === 'CONTACT_TABLE_FULL_CONFIRM') {
      setPhase({
        kind: 'confirmFull',
        message: result.error ?? t(
          'meshcore.not_on_device.full_confirm',
          "The radio's contact list is full. Adding may replace the oldest non-favourite contact.",
        ),
      });
      return;
    }
    if (!result.success) {
      setPhase({
        kind: 'error',
        message: result.error || t('meshcore.contact_token.import_failed', 'Could not import the contact.'),
      });
      return;
    }
    if (result.status === 'already_on_device') {
      setPhase({ kind: 'done', message: t('meshcore.contact_token.already_on_radio', 'This contact is already in the radio. Nothing was changed.') });
      return;
    }
    const evicted = result.evicted?.length ?? 0;
    setPhase({
      kind: 'done',
      message: evicted > 0
        ? t('meshcore.not_on_device.added_with_eviction', {
            count: evicted,
            defaultValue: 'Added. The radio replaced {{count}} older non-favourite contact(s) to make room.',
          })
        : t('meshcore.contact_token.imported', 'Imported to the radio.'),
    });
  };

  return (
    <Modal
      isOpen
      onClose={() => { if (!busy) onClose(); }}
      title={t('meshcore.contact_token.title', 'Import contact')}
    >
      <dl className={styles.details}>
        <dt>{t('meshcore.contact_token.name', 'Name')}</dt>
        <dd>
          {token.name}
          {knownName && knownName !== token.name && (
            <span className={styles.knownAs}>
              {' '}{t('meshcore.contact_token.known_as', '(known here as {{name}})', { name: knownName })}
            </span>
          )}
        </dd>
        <dt>{t('meshcore.contact_token.type', 'Type')}</dt>
        <dd className={styles.typeRow}>
          {roleIcon && <UiIcon name={roleIcon} size={14} />}
          {typeLabel}
        </dd>
        <dt>{t('meshcore.contact_token.public_key', 'Public key')}</dt>
        <dd className={styles.publicKey}>{token.publicKey.toUpperCase()}</dd>
      </dl>

      {phase.kind === 'confirmFull' && (
        <p className={styles.notice} role="alert">
          {phase.message}{' '}
          {t('meshcore.not_on_device.full_confirm_question', 'Favourites are never replaced. Add anyway?')}
        </p>
      )}
      {phase.kind === 'error' && <p className={styles.error} role="alert">{phase.message}</p>}
      {phase.kind === 'done' && <p className={styles.success} role="status">{phase.message}</p>}
      {reason && phase.kind !== 'done' && <p className={styles.hint}>{reason}</p>}
      {!reason && phase.kind === 'idle' && (
        <p className={styles.hint}>
          {t('meshcore.contact_token.import_hint', 'Adds this contact to the radio. Nothing is sent over the air.')}
        </p>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onClose} disabled={busy}>
          {phase.kind === 'done' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
        </button>
        {phase.kind !== 'done' && (
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => void runImport(phase.kind === 'confirmFull')}
            disabled={!!reason || busy}
            title={reason ?? undefined}
          >
            {busy
              ? t('meshcore.contact_token.importing', 'Importing…')
              : phase.kind === 'confirmFull'
                ? t('meshcore.contact_token.import_anyway', 'Import anyway')
                : t('meshcore.contact_token.import', 'Import')}
          </button>
        )}
      </div>
    </Modal>
  );
};

export default MeshCoreContactTokenModal;
