import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface NeighborInfoSectionProps {
  neighborInfoEnabled: boolean;
  neighborInfoInterval: number;
  neighborInfoTransmitOverLora: boolean;
  setNeighborInfoEnabled: (value: boolean) => void;
  setNeighborInfoInterval: (value: number) => void;
  setNeighborInfoTransmitOverLora: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NeighborInfoSection: React.FC<NeighborInfoSectionProps> = ({
  neighborInfoEnabled,
  neighborInfoInterval,
  neighborInfoTransmitOverLora,
  setNeighborInfoEnabled,
  setNeighborInfoInterval,
  setNeighborInfoTransmitOverLora,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Track initial values for change detection
  const initialValuesRef = useRef({
    neighborInfoEnabled, neighborInfoInterval, neighborInfoTransmitOverLora
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      neighborInfoEnabled !== initial.neighborInfoEnabled ||
      neighborInfoInterval !== initial.neighborInfoInterval ||
      neighborInfoTransmitOverLora !== initial.neighborInfoTransmitOverLora
    );
  }, [neighborInfoEnabled, neighborInfoInterval, neighborInfoTransmitOverLora]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setNeighborInfoEnabled(initial.neighborInfoEnabled);
    setNeighborInfoInterval(initial.neighborInfoInterval);
    setNeighborInfoTransmitOverLora(initial.neighborInfoTransmitOverLora);
  }, [setNeighborInfoEnabled, setNeighborInfoInterval, setNeighborInfoTransmitOverLora]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      neighborInfoEnabled, neighborInfoInterval, neighborInfoTransmitOverLora
    };
  }, [onSave, neighborInfoEnabled, neighborInfoInterval, neighborInfoTransmitOverLora]);

  // Register with SaveBar
  useSaveBar({
    id: 'neighbor-info',
    sectionName: t('neighbor_info.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

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
        <>
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
          <div className="setting-item">
            <label htmlFor="neighborInfoTransmitOverLora" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="neighborInfoTransmitOverLora"
                type="checkbox"
                checked={neighborInfoTransmitOverLora}
                onChange={(e) => setNeighborInfoTransmitOverLora(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('neighbor_info.transmit_over_lora')}</div>
                <span className="setting-description">{t('neighbor_info.transmit_over_lora_description')}</span>
              </div>
            </label>
          </div>
        </>
      )}
    </div>
  );
};

export default NeighborInfoSection;
