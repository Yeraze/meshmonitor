import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { UiIcon } from '../icons';
import styles from './RangeTestConfigSection.module.css';

interface RangeTestConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  sender: number;
  setSender: (value: number) => void;
  save: boolean;
  setSave: (value: boolean) => void;
  /**
   * True when the connected node's firmware no longer carries the Range Test
   * module — it was removed in Meshtastic 2.8 (#5031). The section stays
   * visible with an explanatory notice rather than disappearing, so users don't
   * conclude MeshMonitor broke. Defaults to false, which is also what an
   * unknown firmware version resolves to: fail open to the old behaviour.
   */
  isDisabled?: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const RangeTestConfigSection: React.FC<RangeTestConfigSectionProps> = ({
  enabled,
  setEnabled,
  sender,
  setSender,
  save,
  setSave,
  isDisabled = false,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Track initial values for change detection
  const initialValuesRef = useRef({
    enabled, sender, save
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      sender !== initial.sender ||
      save !== initial.save
    );
  }, [enabled, sender, save]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setSender(initial.sender);
    setSave(initial.save);
  }, [setEnabled, setSender, setSave]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, sender, save
    };
  }, [onSave, enabled, sender, save]);

  // Register with SaveBar. A removed module must never offer a save — the
  // firmware would drop the admin message silently.
  useSaveBar({
    id: 'rangetest-config',
    sectionName: t('rangetest_config.title'),
    hasChanges: hasChanges && !isDisabled,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('rangetest_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/range-test/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('rangetest_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {isDisabled && (
        <div className={styles.removedNotice} role="status">
          <span className={styles.removedNoticeIcon}><UiIcon name="alert" /></span>
          <span>
            {t(
              'rangetest_config.removed_in_28',
              'Range Test was removed in Meshtastic 2.8 and is not available on this firmware. These settings cannot be changed.'
            )}
          </span>
        </div>
      )}

      <div className={isDisabled ? styles.disabledControls : undefined}>
        {/* Enable Module */}
        <div className="setting-item">
          <label htmlFor="rangetestEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              id="rangetestEnabled"
              type="checkbox"
              checked={enabled}
              disabled={isDisabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ marginTop: '0.2rem', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('rangetest_config.enabled')}</div>
              <span className="setting-description">{t('rangetest_config.enabled_description')}</span>
            </div>
          </label>
        </div>

        {enabled && (
          <>
            {/* Sender Interval */}
            <div className="setting-item">
              <label htmlFor="rangetestSender">
                {t('rangetest_config.sender')}
                <span className="setting-description">{t('rangetest_config.sender_description')}</span>
              </label>
              <input
                id="rangetestSender"
                type="number"
                min="0"
                max="65535"
                value={sender}
                disabled={isDisabled}
                onChange={(e) => setSender(parseInt(e.target.value) || 0)}
                className="setting-input"
                placeholder="0"
              />
            </div>

            {/* Save Results */}
            <div className="setting-item">
              <label htmlFor="rangetestSave" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  id="rangetestSave"
                  type="checkbox"
                  checked={save}
                  disabled={isDisabled}
                  onChange={(e) => setSave(e.target.checked)}
                  style={{ marginTop: '0.2rem', flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('rangetest_config.save')}</div>
                  <span className="setting-description">{t('rangetest_config.save_description')}</span>
                </div>
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default RangeTestConfigSection;
