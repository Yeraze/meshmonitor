import React from 'react';
import { useTranslation } from 'react-i18next';

interface PositionConfigSectionProps {
  positionBroadcastSecs: number;
  positionSmartEnabled: boolean;
  fixedPosition: boolean;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
  setPositionBroadcastSecs: (value: number) => void;
  setPositionSmartEnabled: (value: boolean) => void;
  setFixedPosition: (value: boolean) => void;
  setFixedLatitude: (value: number) => void;
  setFixedLongitude: (value: number) => void;
  setFixedAltitude: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const PositionConfigSection: React.FC<PositionConfigSectionProps> = ({
  positionBroadcastSecs,
  positionSmartEnabled,
  fixedPosition,
  fixedLatitude,
  fixedLongitude,
  fixedAltitude,
  setPositionBroadcastSecs,
  setPositionSmartEnabled,
  setFixedPosition,
  setFixedLatitude,
  setFixedLongitude,
  setFixedAltitude,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('position_config.title')}
        <a
          href="https://meshmonitor.org/features/device#position-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('position_config.view_docs')}
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="positionBroadcastSecs">
          {t('position_config.broadcast_interval')}
          <span className="setting-description">{t('position_config.broadcast_interval_description')}</span>
        </label>
        <input
          id="positionBroadcastSecs"
          type="number"
          min="32"
          max="4294967295"
          value={positionBroadcastSecs}
          onChange={(e) => setPositionBroadcastSecs(parseInt(e.target.value))}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="positionSmartEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="positionSmartEnabled"
            type="checkbox"
            checked={positionSmartEnabled}
            onChange={(e) => setPositionSmartEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('position_config.smart_broadcast')}</div>
            <span className="setting-description">{t('position_config.smart_broadcast_description')}</span>
          </div>
        </label>
      </div>
      <div className="setting-item">
        <label htmlFor="fixedPosition" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="fixedPosition"
            type="checkbox"
            checked={fixedPosition}
            onChange={(e) => setFixedPosition(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('position_config.fixed_position')}</div>
            <span className="setting-description">{t('position_config.fixed_position_description')}</span>
          </div>
        </label>
      </div>
      {fixedPosition && (
        <>
          <div className="setting-item">
            <label htmlFor="fixedLatitude">
              {t('position_config.latitude')}
              <span className="setting-description">
                {t('position_config.latitude_description')} • <a href="https://gps-coordinates.org/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>{t('position_config.find_coordinates')}</a>
              </span>
            </label>
            <input
              id="fixedLatitude"
              type="number"
              step="0.000001"
              min="-90"
              max="90"
              value={fixedLatitude}
              onChange={(e) => setFixedLatitude(parseFloat(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="fixedLongitude">
              {t('position_config.longitude')}
              <span className="setting-description">{t('position_config.longitude_description')}</span>
            </label>
            <input
              id="fixedLongitude"
              type="number"
              step="0.000001"
              min="-180"
              max="180"
              value={fixedLongitude}
              onChange={(e) => setFixedLongitude(parseFloat(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="fixedAltitude">
              {t('position_config.altitude')}
              <span className="setting-description">{t('position_config.altitude_description')}</span>
            </label>
            <input
              id="fixedAltitude"
              type="number"
              step="1"
              value={fixedAltitude}
              onChange={(e) => setFixedAltitude(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </>
      )}
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('position_config.save_button')}
      </button>
    </div>
  );
};

export default PositionConfigSection;
