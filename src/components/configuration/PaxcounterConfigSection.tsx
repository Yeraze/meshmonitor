import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { ConfigSection } from '../shared/config/ConfigSection';

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
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
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

  // What the node holds; moves on a successful save (#5797)
  const values = {
    enabled, paxcounterUpdateInterval, wifiThreshold, bleThreshold
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setEnabled(baseline.enabled);
    setPaxcounterUpdateInterval(baseline.paxcounterUpdateInterval);
    setWifiThreshold(baseline.wifiThreshold);
    setBleThreshold(baseline.bleThreshold);
  }, [baseline, setEnabled, setPaxcounterUpdateInterval, setWifiThreshold, setBleThreshold]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'paxcounter-config',
    sectionName: t('paxcounter_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection title={t('paxcounter_config.title')} docsUrl="https://meshtastic.org/docs/configuration/module/paxcounter/" notice={<ModuleAvailabilityNotice />}>

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
            <NumberInput
              id="paxcounterUpdateInterval"
              min={0}
              max={86400}
              value={paxcounterUpdateInterval}
              integer
              onChange={setPaxcounterUpdateInterval}
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
            <NumberInput
              id="paxcounterWifiThreshold"
              min={-127}
              max={0}
              value={wifiThreshold}
              integer
              onChange={setWifiThreshold}
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
            <NumberInput
              id="paxcounterBleThreshold"
              min={-127}
              max={0}
              value={bleThreshold}
              integer
              onChange={setBleThreshold}
              className="setting-input"
              placeholder="-80"
            />
          </div>
        </>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default PaxcounterConfigSection;
