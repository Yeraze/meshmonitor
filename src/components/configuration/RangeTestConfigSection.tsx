import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface RangeTestConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  sender: number;
  setSender: (value: number) => void;
  save: boolean;
  setSave: (value: boolean) => void;
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

  // Register with SaveBar
  useSaveBar({
    id: 'rangetest-config',
    sectionName: t('rangetest_config.title'),
    hasChanges,
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

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="rangetestEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="rangetestEnabled"
            type="checkbox"
            checked={enabled}
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
  );
};

export default RangeTestConfigSection;
