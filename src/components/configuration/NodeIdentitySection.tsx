import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface NodeIdentitySectionProps {
  longName: string;
  shortName: string;
  isUnmessagable: boolean;
  setLongName: (value: string) => void;
  setShortName: (value: string) => void;
  setIsUnmessagable: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NodeIdentitySection: React.FC<NodeIdentitySectionProps> = ({
  longName,
  shortName,
  isUnmessagable,
  setLongName,
  setShortName,
  setIsUnmessagable,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Track initial values for change detection
  const initialValuesRef = useRef({
    longName, shortName, isUnmessagable
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      longName !== initial.longName ||
      shortName !== initial.shortName ||
      isUnmessagable !== initial.isUnmessagable
    );
  }, [longName, shortName, isUnmessagable]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setLongName(initial.longName);
    setShortName(initial.shortName);
    setIsUnmessagable(initial.isUnmessagable);
  }, [setLongName, setShortName, setIsUnmessagable]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      longName, shortName, isUnmessagable
    };
  }, [onSave, longName, shortName, isUnmessagable]);

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
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('node_identity.title')}
        <a
          href="https://meshmonitor.org/features/device#node-identity"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('node_identity.view_docs')}
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="longName">
          {t('node_identity.long_name')}
          <span className="setting-description">{t('node_identity.long_name_description')}</span>
        </label>
        <input
          id="longName"
          type="text"
          maxLength={40}
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
    </div>
  );
};

export default NodeIdentitySection;
