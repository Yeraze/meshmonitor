import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { GPS_MODE_OPTIONS, POSITION_FLAGS } from './constants';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { ConfigSection } from '../shared/config/ConfigSection';

interface PositionConfigSectionProps {
  positionBroadcastSecs: number;
  positionSmartEnabled: boolean;
  fixedPosition: boolean;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
  gpsUpdateInterval: number;
  gpsMode: number;
  broadcastSmartMinimumDistance: number;
  broadcastSmartMinimumIntervalSecs: number;
  positionFlags: number;
  rxGpio: number;
  txGpio: number;
  gpsEnGpio: number;
  setPositionBroadcastSecs: (value: number) => void;
  setPositionSmartEnabled: (value: boolean) => void;
  setFixedPosition: (value: boolean) => void;
  setFixedLatitude: (value: number) => void;
  setFixedLongitude: (value: number) => void;
  setFixedAltitude: (value: number) => void;
  setGpsUpdateInterval: (value: number) => void;
  setGpsMode: (value: number) => void;
  setBroadcastSmartMinimumDistance: (value: number) => void;
  setBroadcastSmartMinimumIntervalSecs: (value: number) => void;
  setPositionFlags: (value: number) => void;
  setRxGpio: (value: number) => void;
  setTxGpio: (value: number) => void;
  setGpsEnGpio: (value: number) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
  /** Bumped when the page reloads config from the node (#5797). */
  configVersion?: number;
}

const PositionConfigSection: React.FC<PositionConfigSectionProps> = ({
  configVersion,
  positionBroadcastSecs,
  positionSmartEnabled,
  fixedPosition,
  fixedLatitude,
  fixedLongitude,
  fixedAltitude,
  gpsUpdateInterval,
  gpsMode,
  broadcastSmartMinimumDistance,
  broadcastSmartMinimumIntervalSecs,
  positionFlags,
  rxGpio,
  txGpio,
  gpsEnGpio,
  setPositionBroadcastSecs,
  setPositionSmartEnabled,
  setFixedPosition,
  setFixedLatitude,
  setFixedLongitude,
  setFixedAltitude,
  setGpsUpdateInterval,
  setGpsMode,
  setBroadcastSmartMinimumDistance,
  setBroadcastSmartMinimumIntervalSecs,
  setPositionFlags,
  setRxGpio,
  setTxGpio,
  setGpsEnGpio,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // What the node holds; moves on a successful save or a reload (#5797).
  // Reload config does not refresh the fixed position, so its baseline stays.
  const values = {
    positionBroadcastSecs, positionSmartEnabled, fixedPosition, fixedLatitude,
    fixedLongitude, fixedAltitude, gpsUpdateInterval, gpsMode,
    broadcastSmartMinimumDistance, broadcastSmartMinimumIntervalSecs,
    positionFlags, rxGpio, txGpio, gpsEnGpio
  };
  const { baseline, hasChanges: differsFromBaseline, commit } = useSectionBaseline(values, {
    reseedKey: configVersion,
    keepOnReseed: ['fixedLatitude', 'fixedLongitude', 'fixedAltitude']
  });

  // Track whether data has been loaded from server (use state to trigger re-render)
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // Update the baseline when position data is loaded from the server.
  // This is detected by lat/long changing from default (0) to real values.
  useEffect(() => {
    if (isDataLoaded) return; // Already loaded

    const latChanged = baseline.fixedLatitude === 0 && fixedLatitude !== 0;
    const lonChanged = baseline.fixedLongitude === 0 && fixedLongitude !== 0;

    if (latChanged || lonChanged) {
      commit(values);
      setIsDataLoaded(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- #5797 values and baseline derive from these fields
  }, [isDataLoaded, fixedLatitude, fixedLongitude, positionBroadcastSecs, positionSmartEnabled, fixedPosition,
      fixedAltitude, gpsUpdateInterval, gpsMode, broadcastSmartMinimumDistance,
      broadcastSmartMinimumIntervalSecs, positionFlags, rxGpio, txGpio, gpsEnGpio]);

  // Don't report changes until the position has been loaded from the server
  const stillLoading = !isDataLoaded && baseline.fixedLatitude === 0 && baseline.fixedLongitude === 0 &&
                       (fixedLatitude !== 0 || fixedLongitude !== 0);
  const hasChanges = !stillLoading && differsFromBaseline;

  // Reset to saved values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setPositionBroadcastSecs(baseline.positionBroadcastSecs);
    setPositionSmartEnabled(baseline.positionSmartEnabled);
    setFixedPosition(baseline.fixedPosition);
    setFixedLatitude(baseline.fixedLatitude);
    setFixedLongitude(baseline.fixedLongitude);
    setFixedAltitude(baseline.fixedAltitude);
    setGpsUpdateInterval(baseline.gpsUpdateInterval);
    setGpsMode(baseline.gpsMode);
    setBroadcastSmartMinimumDistance(baseline.broadcastSmartMinimumDistance);
    setBroadcastSmartMinimumIntervalSecs(baseline.broadcastSmartMinimumIntervalSecs);
    setPositionFlags(baseline.positionFlags);
    setRxGpio(baseline.rxGpio);
    setTxGpio(baseline.txGpio);
    setGpsEnGpio(baseline.gpsEnGpio);
  }, [baseline, setPositionBroadcastSecs, setPositionSmartEnabled, setFixedPosition, setFixedLatitude,
      setFixedLongitude, setFixedAltitude, setGpsUpdateInterval, setGpsMode,
      setBroadcastSmartMinimumDistance, setBroadcastSmartMinimumIntervalSecs,
      setPositionFlags, setRxGpio, setTxGpio, setGpsEnGpio]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'position-config',
    sectionName: t('position_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  // Helper to toggle a flag bit
  const toggleFlag = (flagValue: number) => {
    if (positionFlags & flagValue) {
      setPositionFlags(positionFlags & ~flagValue);
    } else {
      setPositionFlags(positionFlags | flagValue);
    }
  };

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection title={t('position_config.title')} docsUrl="https://meshmonitor.org/features/device#position-configuration">
      <div className="setting-item">
        <label htmlFor="positionBroadcastSecs">
          {t('position_config.broadcast_interval')}
          <span className="setting-description">{t('position_config.broadcast_interval_description')}</span>
        </label>
        <NumberInput
          id="positionBroadcastSecs"
          min={32}
          alsoValid={[0]}
          zeroHint={t('zero_hint.position_broadcast')}
          max={4294967295}
          integer
          value={positionBroadcastSecs}
          onChange={setPositionBroadcastSecs}
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
                {t('position_config.latitude_description')} • <a href="https://www.latlong.net/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>{t('position_config.find_coordinates')}</a>
              </span>
            </label>
            <NumberInput
              id="fixedLatitude"
              step={0.000001}
              min={-90}
              max={90}
              value={fixedLatitude}
              onChange={setFixedLatitude}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="fixedLongitude">
              {t('position_config.longitude')}
              <span className="setting-description">{t('position_config.longitude_description')}</span>
            </label>
            <NumberInput
              id="fixedLongitude"
              step={0.000001}
              min={-180}
              max={180}
              value={fixedLongitude}
              onChange={setFixedLongitude}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="fixedAltitude">
              {t('position_config.altitude')}
              <span className="setting-description">{t('position_config.altitude_description')}</span>
            </label>
            <NumberInput
              id="fixedAltitude"
              step={1}
              integer
              value={fixedAltitude}
              onChange={setFixedAltitude}
              className="setting-input"
            />
          </div>
        </>
      )}
      {/* GPS Mode */}
      <div className="setting-item">
        <label htmlFor="gpsMode">
          {t('position_config.gps_mode')}
          <span className="setting-description">{t('position_config.gps_mode_description')}</span>
        </label>
        <select
          id="gpsMode"
          value={gpsMode}
          onChange={(e) => setGpsMode(parseInt(e.target.value))}
          className="setting-input"
        >
          {GPS_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.name} - {option.description}
            </option>
          ))}
        </select>
      </div>

      {/* GPS Update Interval */}
      <div className="setting-item">
        <label htmlFor="gpsUpdateInterval">
          {t('position_config.gps_update_interval')}
          <span className="setting-description">{t('position_config.gps_update_interval_description')}</span>
        </label>
        <NumberInput
          id="gpsUpdateInterval"
          min={0}
          max={4294967295}
          integer
          value={gpsUpdateInterval}
          onChange={setGpsUpdateInterval}
          className="setting-input"
        />
      </div>

      {/* Smart Broadcast Settings - show when smart broadcast is enabled */}
      {positionSmartEnabled && (
        <div style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--color-surface-active)',
          marginTop: '0.5rem',
          marginBottom: '1rem'
        }}>
          {/* Minimum Distance */}
          <div className="setting-item">
            <label htmlFor="broadcastSmartMinimumDistance">
              {t('position_config.smart_min_distance')}
              <span className="setting-description">{t('position_config.smart_min_distance_description')}</span>
            </label>
            <NumberInput
              id="broadcastSmartMinimumDistance"
              min={0}
              max={4294967295}
              integer
              value={broadcastSmartMinimumDistance}
              onChange={setBroadcastSmartMinimumDistance}
              className="setting-input"
              style={{ width: '150px' }}
            />
          </div>

          {/* Minimum Interval */}
          <div className="setting-item">
            <label htmlFor="broadcastSmartMinimumIntervalSecs">
              {t('position_config.smart_min_interval')}
              <span className="setting-description">{t('position_config.smart_min_interval_description')}</span>
            </label>
            <NumberInput
              id="broadcastSmartMinimumIntervalSecs"
              min={0}
              max={4294967295}
              integer
              value={broadcastSmartMinimumIntervalSecs}
              onChange={setBroadcastSmartMinimumIntervalSecs}
              className="setting-input"
              style={{ width: '150px' }}
            />
          </div>
        </div>
      )}

      {/* Position Flags */}
      <div className="setting-item">
        <label>
          {t('position_config.position_flags')}
          <span className="setting-description">{t('position_config.position_flags_description')}</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
          {POSITION_FLAGS.map((flag) => (
            <label key={flag.value} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={(positionFlags & flag.value) !== 0}
                onChange={() => toggleFlag(flag.value)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold' }}>{flag.name}</div>
                <span className="setting-description">{flag.description}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Advanced Section Toggle */}
      <div className="setting-item">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="advanced-toggle-btn"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-surface-active)',
            color: 'var(--color-text-subtle)',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          <span><UiIcon name={showAdvanced ? 'chevronDown' : 'forward'} /></span>
          {t('position_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--color-surface-active)'
        }}>
          {/* RX GPIO */}
          <div className="setting-item">
            <label htmlFor="rxGpio">
              {t('position_config.rx_gpio')}
              <span className="setting-description">{t('position_config.rx_gpio_description')}</span>
            </label>
            <NumberInput
              id="rxGpio"
              min={0}
              max={255}
              integer
              value={rxGpio}
              onChange={setRxGpio}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* TX GPIO */}
          <div className="setting-item">
            <label htmlFor="txGpio">
              {t('position_config.tx_gpio')}
              <span className="setting-description">{t('position_config.tx_gpio_description')}</span>
            </label>
            <NumberInput
              id="txGpio"
              min={0}
              max={255}
              integer
              value={txGpio}
              onChange={setTxGpio}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* GPS Enable GPIO */}
          <div className="setting-item">
            <label htmlFor="gpsEnGpio">
              {t('position_config.gps_en_gpio')}
              <span className="setting-description">{t('position_config.gps_en_gpio_description')}</span>
            </label>
            <NumberInput
              id="gpsEnGpio"
              min={0}
              max={255}
              integer
              value={gpsEnGpio}
              onChange={setGpsEnGpio}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>
        </div>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default PositionConfigSection;
