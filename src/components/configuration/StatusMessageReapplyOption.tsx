/**
 * "Re-apply after a reboot" switch for the Status Message (#5745).
 *
 * A per-source MeshMonitor setting (`statusMessageReapplyAfterReboot`, off by
 * default). Loads and saves through the per-source settings endpoint, on
 * change, independent of the module-config SaveBar.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSource } from '../../contexts/SourceContext';
import apiService from '../../services/api';
import { isReapplyEnabled, STATUS_MESSAGE_REAPPLY_SETTING } from '../../utils/statusMessage';
import styles from './StatusMessageReapplyOption.module.css';

interface Props {
  /** Disable the switch (module unsupported, or no write access). */
  isDisabled?: boolean;
}

const StatusMessageReapplyOption: React.FC<Props> = ({ isDisabled = false }) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!sourceId) return undefined;
    let cancelled = false;
    setEnabled(null);
    void (async () => {
      try {
        const data = await apiService.get<Record<string, string>>(`/api/settings?sourceId=${encodeURIComponent(sourceId)}`);
        if (!cancelled) setEnabled(isReapplyEnabled(data[STATUS_MESSAGE_REAPPLY_SETTING]));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId]);

  const onChange = useCallback(async (next: boolean) => {
    if (!sourceId) return;
    setSaving(true);
    setError(false);
    try {
      await apiService.post(`/api/settings?sourceId=${encodeURIComponent(sourceId)}`, {
        [STATUS_MESSAGE_REAPPLY_SETTING]: next ? 'true' : 'false',
      });
      setEnabled(next);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }, [sourceId]);

  // Legacy single-source views have no source to scope the setting to.
  if (!sourceId) return null;

  return (
    <div className="setting-item">
      {/* Same shape as the other Configuration checkboxes: label and help
          first, then the box, so the shared `.setting-item` rules lay it out. */}
      <label htmlFor="statusMessageReapplyAfterReboot">
        {t('statusmessage_config.reapply_label', 'Re-apply after a reboot')}
        <span className="setting-description">
          {t(
            'statusmessage_config.reapply_help',
            'Some firmware loses the Status Message when the node reboots. With this on, MeshMonitor writes the last status it saved once more when the node reconnects with an empty status. A status cleared from another app would be restored too.',
          )}
        </span>
      </label>
      <input
        id="statusMessageReapplyAfterReboot"
        type="checkbox"
        className="setting-checkbox"
        checked={enabled === true}
        disabled={isDisabled || saving || enabled === null}
        onChange={(e) => { void onChange(e.target.checked); }}
      />
      {error && (
        <span role="alert" className={styles.error}>
          {t('statusmessage_config.reapply_save_failed', 'Could not save this setting.')}
        </span>
      )}
    </div>
  );
};

export default StatusMessageReapplyOption;
