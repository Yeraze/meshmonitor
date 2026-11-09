/**
 * Restore confirmation for a device-config backup (#6285). Shows what the
 * restore will change, from the server's no-secret summary: the radio
 * (current -> backup), the channel slots it overwrites, an identity note, and
 * the reboot note. An unowned (legacy) file needs a second tick.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../shared/automation/ConfirmDialog';
import styles from './BackupRestoreConfirmDialog.module.css';

export type BackupProtocol = 'meshtastic' | 'meshcore';

export interface BackupSummaryData {
  protocol: BackupProtocol;
  name?: string;
  identity?: string;
  radio?: Record<string, string | number>;
  currentRadio?: Record<string, string | number>;
  radioDiffers?: boolean;
  channels: Array<{ idx: number; name: string }>;
  sections: string[];
  identityMismatch?: boolean;
  requiresReboot: boolean;
  legacy: boolean;
}

interface Props {
  filename: string;
  protocol: BackupProtocol;
  summary: BackupSummaryData;
  onConfirm: () => void;
  onCancel: () => void;
}

const fmtRadio = (r: Record<string, string | number>): string =>
  Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ');

const BackupRestoreConfirmDialog: React.FC<Props> = ({ filename, protocol, summary, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  const [legacyAck, setLegacyAck] = useState(false);

  const preview = (
    <>
      {summary.name && (
        <p className={styles.note}>
          {t('backup_management.restore_name', { name: summary.name })}
        </p>
      )}
      {summary.radio && (
        summary.radioDiffers ? (
          <p className={styles.warn} role="alert">
            {t('backup_management.restore_radio_changes', {
              current: summary.currentRadio ? fmtRadio(summary.currentRadio) : '',
              backup: fmtRadio(summary.radio),
            })}
          </p>
        ) : (
          <p className={styles.note}>
            {t('backup_management.restore_radio', { backup: fmtRadio(summary.radio) })}
          </p>
        )
      )}
      {summary.channels.length > 0 && (
        <>
          <p className={styles.note}>{t('backup_management.restore_channels_overwritten')}</p>
          <ul className={styles.list}>
            {summary.channels.map((c) => (
              <li key={c.idx}>
                {t('backup_management.restore_channel_slot', { idx: c.idx, name: c.name || t('backup_management.restore_channel_unnamed') })}
              </li>
            ))}
          </ul>
          <p className={styles.note}>{t('backup_management.restore_channels_others_kept')}</p>
        </>
      )}
      {protocol === 'meshcore' && summary.identityMismatch && (
        <p className={styles.warn} role="alert">
          {t('backup_management.restore_identity_mismatch', { identity: summary.identity ?? '' })}
        </p>
      )}
      {protocol === 'meshcore' && (
        <p className={styles.note}>{t('backup_management.restore_no_identity')}</p>
      )}
      {protocol === 'meshtastic' && summary.requiresReboot && (
        <p className={styles.note}>{t('backup_management.restore_meshtastic_reboot')}</p>
      )}
      {protocol === 'meshcore' && summary.requiresReboot && (
        <p className={styles.note}>{t('backup_management.restore_meshcore_pin_boot')}</p>
      )}
      {summary.legacy && (
        <label className={styles.legacy}>
          <input
            type="checkbox"
            checked={legacyAck}
            onChange={(e) => setLegacyAck(e.target.checked)}
          />
          <span>{t('backup_management.restore_legacy_confirm')}</span>
        </label>
      )}
    </>
  );

  return (
    <ConfirmDialog
      title={t('backup_management.restore_dialog_title')}
      message={t(protocol === 'meshcore' ? 'backup_management.confirm_restore_meshcore' : 'backup_management.confirm_restore_meshtastic', { filename })}
      preview={preview}
      confirmLabel={t('backup_management.restore')}
      cancelLabel={t('common.cancel')}
      confirmDisabled={summary.legacy && !legacyAck}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
};

export default BackupRestoreConfirmDialog;
