/**
 * MeshCoreMultiAcksSection — multi-ACK on/off for a Companion (P8a #6257).
 *
 * With multi-ACKs on, each received DM sends one extra ACK along its return
 * path. That costs airtime on a shared channel, so the warning sits next to
 * the toggle. The value is 0 or 1; the server rejects anything else and needs
 * Companion firmware v7 or later (`COMPANION_CMD_FIRMWARE_MIN`).
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreActions } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { ConfigSection } from '../shared/config/ConfigSection';
import { UiIcon } from '../icons';
import styles from './MeshCoreDeviceSettingSections.module.css';

/** Mirrors MeshCoreManager.COMPANION_CMD_FIRMWARE_MIN on the server. */
export const COMPANION_CMD_FIRMWARE_MIN = 7;

export interface MeshCoreMultiAcksSectionProps {
  connected: boolean;
  loading?: boolean;
  actions: Pick<MeshCoreActions, 'setMultiAcks'>;
  canWriteConfig: boolean;
  /** SelfInfo `multiAcks` (0 or 1), when the device reports it. */
  multiAcks?: number;
  /** `localNode.firmwareVer`; unknown lets the server decide. */
  firmwareVer?: number;
}

export const MeshCoreMultiAcksSection: React.FC<MeshCoreMultiAcksSectionProps> = ({
  connected,
  loading = false,
  actions,
  canWriteConfig,
  multiAcks,
  firmwareVer,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [saved, setSaved] = useState(multiAcks === 1);
  const [draft, setDraft] = useState(multiAcks === 1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSaved(multiAcks === 1);
    setDraft(multiAcks === 1);
  }, [multiAcks]);

  const unsupported = typeof firmwareVer === 'number' && firmwareVer < COMPANION_CMD_FIRMWARE_MIN;
  const unsupportedReason = unsupported
    ? t('meshcore.multi_acks.unsupported', 'Needs Companion firmware version {{min}} or later.', { min: COMPANION_CMD_FIRMWARE_MIN })
    : undefined;
  const disabled = !canWriteConfig || !connected || loading || saving || unsupported;

  const handleSave = async () => {
    setSaving(true);
    try {
      const ok = await actions.setMultiAcks(draft ? 1 : 0);
      if (!ok) {
        showToast(t('meshcore.multi_acks.save_failed', 'Failed to change multi-ACKs'), 'error');
        setDraft(saved);
        return;
      }
      setSaved(draft);
      showToast(t('meshcore.multi_acks.saved', 'Multi-ACKs saved'), 'success');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="meshcore-multi-acks">
      <ConfigSection
        title={t('meshcore.multi_acks.title', 'Multi-ACKs')}
        description={t('meshcore.multi_acks.hint', 'Send an extra ACK for each direct message this device receives, so the sender is more likely to see a delivery.')}
        canWrite={canWriteConfig}
        collapsible
      >
        <div className={styles.row} title={unsupportedReason}>
          <label>
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              disabled={disabled}
            />{' '}
            {t('meshcore.multi_acks.toggle', 'Send extra ACKs')}
          </label>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={disabled || draft === saved}
            aria-label={t('meshcore.multi_acks.save', 'Save multi-ACKs')}
          >
            {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
        <p className={styles.warning} role="note">
          <UiIcon name="alert" size={14} />{' '}
          {t('meshcore.multi_acks.warning', 'Each received DM sends one extra ACK along its return path, about one extra transmission per hop per DM.')}
        </p>
        {unsupportedReason && <p className={styles.smallHint}>{unsupportedReason}</p>}
      </ConfigSection>
    </div>
  );
};

export default MeshCoreMultiAcksSection;
