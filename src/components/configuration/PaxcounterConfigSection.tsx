import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface PaxcounterConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  paxcounterUpdateInterval: number;
  setPaxcounterUpdateInterval: (value: number) => void;
  wifiThreshold: number;
  setWifiThreshold: (value: number) => void;
  bleThreshold: number;
  setBleThreshold: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const PaxcounterConfigSection: React.FC<PaxcounterConfigSectionProps> = ({
  enabled,
  setEnabled,
  paxcounterUpdateInterval,
  setPaxcounterUpdateInterval,
  wifiThreshold,
  setWifiThreshold,
  bleThreshold,
  setBleThreshold,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Track initial values for change detection
  const initialValuesRef = useRef({
    enabled, paxcounterUpdateInterval, wifiThreshold, bleThreshold
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      paxcounterUpdateInterval !== initial.paxcounterUpdateInterval ||
      wifiThreshold !== initial.wifiThreshold ||
      bleThreshold !== initial.bleThreshold
    );
  }, [enabled, paxcounterUpdateInterval, wifiThreshold, bleThreshold]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setPaxcounterUpdateInterval(initial.paxcounterUpdateInterval);
    setWifiThreshold(initial.wifiThreshold);
    setBleThreshold(initial.bleThreshold);
  }, [setEnabled, setPaxcounterUpdateInterval, setWifiThreshold, setBleThreshold]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, paxcounterUpdateInterval, wifiThreshold, bleThreshold
    };
  }, [onSave, enabled, paxcounterUpdateInterval, wifiThreshold, bleThreshold]);

  // Register with SaveBar
  useSaveBar({
    id: 'paxcounter-config',
    sectionName: t('paxcounter_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('paxcounter_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/paxcounter/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('paxcounter_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="paxcounterEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="paxcounterEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('paxcounter_config.enabled')}</div>
            <span className="setting-description">{t('paxcounter_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Update Interval */}
          <div className="setting-item">
            <label htmlFor="paxcounterUpdateInterval">
              {t('paxcounter_config.update_interval')}
              <span className="setting-description">{t('paxcounter_config.update_interval_description')}</span>
            </label>
            <input
              id="paxcounterUpdateInterval"
              type="number"
              min="0"
              max="86400"
              value={paxcounterUpdateInterval}
              onChange={(e) => setPaxcounterUpdateInterval(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="900"
            />
          </div>

          {/* WiFi Threshold */}
          <div className="setting-item">
            <label htmlFor="paxcounterWifiThreshold">
              {t('paxcounter_config.wifi_threshold')}
              <span className="setting-description">{t('paxcounter_config.wifi_threshold_description')}</span>
            </label>
            <input
              id="paxcounterWifiThreshold"
              type="number"
              min="-127"
              max="0"
              value={wifiThreshold}
              onChange={(e) => setWifiThreshold(parseInt(e.target.value) || -80)}
              className="setting-input"
              placeholder="-80"
            />
          </div>

          {/* BLE Threshold */}
          <div className="setting-item">
            <label htmlFor="paxcounterBleThreshold">
              {t('paxcounter_config.ble_threshold')}
              <span className="setting-description">{t('paxcounter_config.ble_threshold_description')}</span>
            </label>
            <input
              id="paxcounterBleThreshold"
              type="number"
              min="-127"
              max="0"
              value={bleThreshold}
              onChange={(e) => setBleThreshold(parseInt(e.target.value) || -80)}
              className="setting-input"
              placeholder="-80"
            />
          </div>
        </>
      )}
    </div>
  );
};

export default PaxcounterConfigSection;
