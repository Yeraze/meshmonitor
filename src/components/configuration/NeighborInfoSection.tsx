import React from 'react';
import { useTranslation } from 'react-i18next';

interface NeighborInfoSectionProps {
  neighborInfoEnabled: boolean;
  neighborInfoInterval: number;
  setNeighborInfoEnabled: (value: boolean) => void;
  setNeighborInfoInterval: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NeighborInfoSection: React.FC<NeighborInfoSectionProps> = ({
  neighborInfoEnabled,
  neighborInfoInterval,
  setNeighborInfoEnabled,
  setNeighborInfoInterval,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('neighbor_info.title')}
        <a
          href="https://meshmonitor.org/features/device#neighbor-info"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('neighbor_info.view_docs')}
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="neighborInfoEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="neighborInfoEnabled"
            type="checkbox"
            checked={neighborInfoEnabled}
            onChange={(e) => setNeighborInfoEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('neighbor_info.enable')}</div>
            <span className="setting-description">{t('neighbor_info.enable_description')}</span>
          </div>
        </label>
      </div>
      {neighborInfoEnabled && (
        <div className="setting-item">
          <label htmlFor="neighborInfoInterval">
            {t('neighbor_info.interval')}
            <span className="setting-description">{t('neighbor_info.interval_description')}</span>
          </label>
          <input
            id="neighborInfoInterval"
            type="number"
            min="14400"
            max="86400"
            value={neighborInfoInterval}
            onChange={(e) => setNeighborInfoInterval(parseInt(e.target.value))}
            className="setting-input"
          />
        </div>
      )}
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('neighbor_info.save_button')}
      </button>
    </div>
  );
};

export default NeighborInfoSection;
