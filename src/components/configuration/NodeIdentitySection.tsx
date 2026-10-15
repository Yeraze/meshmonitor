import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { ConfigSection } from '../shared/config/ConfigSection';

interface NodeIdentitySectionProps {
  /** Bumped when the page reloads config from the node (#5797). */
  configVersion?: number;
  longName: string;
  shortName: string;
  isUnmessagable: boolean;
  isLicensed: boolean;
  setLongName: (value: string) => void;
  setShortName: (value: string) => void;
  setIsUnmessagable: (value: boolean) => void;
  setIsLicensed: (value: boolean) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const NodeIdentitySection: React.FC<NodeIdentitySectionProps> = ({
  configVersion,
  longName,
  shortName,
  isUnmessagable,
  isLicensed,
  setLongName,
  setShortName,
  setIsUnmessagable,
  setIsLicensed,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // What the node holds; moves on a successful save or a reload (#5797)
  const values = { longName, shortName, isUnmessagable, isLicensed };
  const { baseline, hasChanges, commit } = useSectionBaseline(values, { reseedKey: configVersion });

  // Reset to saved values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLongName(baseline.longName);
    setShortName(baseline.shortName);
    setIsUnmessagable(baseline.isUnmessagable);
    setIsLicensed(baseline.isLicensed);
  }, [baseline, setLongName, setShortName, setIsUnmessagable, setIsLicensed]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  useSaveBar({
    id: 'node-identity',
    sectionName: t('node_identity.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <ConfigSection title={t('node_identity.title')} docsUrl="https://meshmonitor.org/features/device#node-identity">
      <div className="setting-item">
        <label htmlFor="longName">
          {t('node_identity.long_name')}
          <span className="setting-description">{t('node_identity.long_name_description')}</span>
        </label>
        <input
          id="longName"
          type="text"
          maxLength={39}
          value={longName}
          onChange={(e) => setLongName(e.target.value)}
          className="setting-input"
          placeholder={t('node_identity.long_name_placeholder')}
        />
      </div>
      <div className="setting-item">
        <label htmlFor="shortName">
          {t('node_identity.short_name')}
          <span className="setting-description">{t('node_identity.short_name_description')}</span>
        </label>
        <input
          id="shortName"
          type="text"
          maxLength={4}
          value={shortName}
          onChange={(e) => setShortName(e.target.value)}
          className="setting-input"
          placeholder={t('node_identity.short_name_placeholder')}
        />
      </div>
      <div className="setting-item">
        <label htmlFor="isUnmessagable" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="isUnmessagable"
            type="checkbox"
            checked={isUnmessagable}
            onChange={(e) => setIsUnmessagable(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('node_identity.unmessageable')}</div>
            <span className="setting-description">{t('node_identity.unmessageable_description')}</span>
          </div>
        </label>
      </div>
      <div className="setting-item">
        <label htmlFor="isLicensed" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="isLicensed"
            type="checkbox"
            checked={isLicensed}
            onChange={(e) => setIsLicensed(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('node_identity.is_licensed')}</div>
            <span className="setting-description">{t('node_identity.is_licensed_description')}</span>
          </div>
        </label>
      </div>
    </ConfigSection>
  );
};

export default NodeIdentitySection;
