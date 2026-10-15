import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { ConfigSection } from '../shared/config/ConfigSection';

interface RemoteHardwareConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  allowUndefinedPinAccess: boolean;
  setAllowUndefinedPinAccess: (value: boolean) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
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

  // What the node holds; moves on a successful save (#5797)
  const values = {
    enabled, allowUndefinedPinAccess
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setEnabled(baseline.enabled);
    setAllowUndefinedPinAccess(baseline.allowUndefinedPinAccess);
  }, [baseline, setEnabled, setAllowUndefinedPinAccess]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

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
    <ConfigSection title={t('remotehw_config.title')} docsUrl="https://meshtastic.org/docs/configuration/module/remote-hardware/" notice={<ModuleAvailabilityNotice />}>

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
            backgroundColor: 'var(--color-surface)',
            borderRadius: '4px',
            marginTop: '0.5rem'
          }}>
            <span style={{ color: 'var(--color-warning)' }}>
              {t('remotehw_config.pins_note')}
            </span>
          </div>
        </>
      )}
    </ConfigSection>
  );
};

export default RemoteHardwareConfigSection;
