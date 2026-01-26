import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface RemoteHardwareConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  allowUndefinedPinAccess: boolean;
  setAllowUndefinedPinAccess: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const RemoteHardwareConfigSection: React.FC<RemoteHardwareConfigSectionProps> = ({
  enabled,
  setEnabled,
  allowUndefinedPinAccess,
  setAllowUndefinedPinAccess,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Track initial values for change detection
  const initialValuesRef = useRef({
    enabled, allowUndefinedPinAccess
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      allowUndefinedPinAccess !== initial.allowUndefinedPinAccess
    );
  }, [enabled, allowUndefinedPinAccess]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setAllowUndefinedPinAccess(initial.allowUndefinedPinAccess);
  }, [setEnabled, setAllowUndefinedPinAccess]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, allowUndefinedPinAccess
    };
  }, [onSave, enabled, allowUndefinedPinAccess]);

  // Register with SaveBar
  useSaveBar({
    id: 'remotehw-config',
    sectionName: t('remotehw_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('remotehw_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/remote-hardware/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('remotehw_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="remotehwEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="remotehwEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('remotehw_config.enabled')}</div>
            <span className="setting-description">{t('remotehw_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Allow Undefined Pin Access */}
          <div className="setting-item">
            <label htmlFor="remotehwAllowUndefined" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="remotehwAllowUndefined"
                type="checkbox"
                checked={allowUndefinedPinAccess}
                onChange={(e) => setAllowUndefinedPinAccess(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('remotehw_config.allow_undefined')}</div>
                <span className="setting-description">{t('remotehw_config.allow_undefined_description')}</span>
              </div>
            </label>
          </div>

          <div className="setting-item" style={{
            padding: '0.75rem',
            backgroundColor: 'var(--ctp-surface0)',
            borderRadius: '4px',
            marginTop: '0.5rem'
          }}>
            <span style={{ color: 'var(--ctp-yellow)' }}>
              {t('remotehw_config.pins_note')}
            </span>
          </div>
        </>
      )}
    </div>
  );
};

export default RemoteHardwareConfigSection;
