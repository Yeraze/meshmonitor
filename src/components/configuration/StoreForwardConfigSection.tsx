import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';

interface StoreForwardConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  heartbeat: boolean;
  setHeartbeat: (value: boolean) => void;
  records: number;
  setRecords: (value: number) => void;
  historyReturnMax: number;
  setHistoryReturnMax: (value: number) => void;
  historyReturnWindow: number;
  setHistoryReturnWindow: (value: number) => void;
  isServer: boolean;
  setIsServer: (value: boolean) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const StoreForwardConfigSection: React.FC<StoreForwardConfigSectionProps> = ({
  enabled,
  setEnabled,
  heartbeat,
  setHeartbeat,
  records,
  setRecords,
  historyReturnMax,
  setHistoryReturnMax,
  historyReturnWindow,
  setHistoryReturnWindow,
  isServer,
  setIsServer,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // What the node holds; moves on a successful save (#5797)
  const values = {
    enabled, heartbeat, records, historyReturnMax, historyReturnWindow, isServer
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setEnabled(baseline.enabled);
    setHeartbeat(baseline.heartbeat);
    setRecords(baseline.records);
    setHistoryReturnMax(baseline.historyReturnMax);
    setHistoryReturnWindow(baseline.historyReturnWindow);
    setIsServer(baseline.isServer);
  }, [baseline, setEnabled, setHeartbeat, setRecords, setHistoryReturnMax, setHistoryReturnWindow, setIsServer]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'storeforward-config',
    sectionName: t('storeforward_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('storeforward_config.title')}
        <a
          href="https://meshmonitor.org/features/device#store-and-forward-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('storeforward_config.view_docs')}
        >
          <UiIcon name="help" />
        </a>
      </h3>
      <ModuleAvailabilityNotice />

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="storeforwardEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="storeforwardEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('storeforward_config.enabled')}</div>
            <span className="setting-description">{t('storeforward_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Is Server */}
          <div className="setting-item">
            <label htmlFor="storeforwardIsServer" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="storeforwardIsServer"
                type="checkbox"
                checked={isServer}
                onChange={(e) => setIsServer(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('storeforward_config.is_server')}</div>
                <span className="setting-description">{t('storeforward_config.is_server_description')}</span>
              </div>
            </label>
          </div>

          {/* Heartbeat */}
          <div className="setting-item">
            <label htmlFor="storeforwardHeartbeat" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="storeforwardHeartbeat"
                type="checkbox"
                checked={heartbeat}
                onChange={(e) => setHeartbeat(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('storeforward_config.heartbeat')}</div>
                <span className="setting-description">{t('storeforward_config.heartbeat_description')}</span>
              </div>
            </label>
          </div>

          {/* Records */}
          <div className="setting-item">
            <label htmlFor="storeforwardRecords">
              {t('storeforward_config.records')}
              <span className="setting-description">{t('storeforward_config.records_description')}</span>
            </label>
            <NumberInput
              id="storeforwardRecords"
              min={0}
              max={65535}
              value={records}
              integer
              onChange={setRecords}
              className="setting-input"
              placeholder="0"
            />
          </div>

          {/* History Return Max */}
          <div className="setting-item">
            <label htmlFor="storeforwardHistoryReturnMax">
              {t('storeforward_config.history_return_max')}
              <span className="setting-description">{t('storeforward_config.history_return_max_description')}</span>
            </label>
            <NumberInput
              id="storeforwardHistoryReturnMax"
              min={0}
              max={255}
              value={historyReturnMax}
              integer
              onChange={setHistoryReturnMax}
              className="setting-input"
              placeholder="0"
            />
          </div>

          {/* History Return Window */}
          <div className="setting-item">
            <label htmlFor="storeforwardHistoryReturnWindow">
              {t('storeforward_config.history_return_window')}
              <span className="setting-description">{t('storeforward_config.history_return_window_description')}</span>
            </label>
            <NumberInput
              id="storeforwardHistoryReturnWindow"
              min={0}
              max={86400}
              value={historyReturnWindow}
              integer
              onChange={setHistoryReturnWindow}
              className="setting-input"
              placeholder="0"
            />
          </div>
        </>
      )}
    </div>
    </NumberInputScope>
  );
};

export default StoreForwardConfigSection;
