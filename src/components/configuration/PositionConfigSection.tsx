import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GPS_MODE_OPTIONS, POSITION_FLAGS } from './constants';
import { useSaveBar } from '../../hooks/useSaveBar';

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
  onSave: () => Promise<void>;
}

const PositionConfigSection: React.FC<PositionConfigSectionProps> = ({
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

  // Track initial values for change detection
  const initialValuesRef = useRef({
    positionBroadcastSecs, positionSmartEnabled, fixedPosition, fixedLatitude,
    fixedLongitude, fixedAltitude, gpsUpdateInterval, gpsMode,
    broadcastSmartMinimumDistance, broadcastSmartMinimumIntervalSecs,
    positionFlags, rxGpio, txGpio, gpsEnGpio
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      positionBroadcastSecs !== initial.positionBroadcastSecs ||
      positionSmartEnabled !== initial.positionSmartEnabled ||
      fixedPosition !== initial.fixedPosition ||
      fixedLatitude !== initial.fixedLatitude ||
      fixedLongitude !== initial.fixedLongitude ||
      fixedAltitude !== initial.fixedAltitude ||
      gpsUpdateInterval !== initial.gpsUpdateInterval ||
      gpsMode !== initial.gpsMode ||
      broadcastSmartMinimumDistance !== initial.broadcastSmartMinimumDistance ||
      broadcastSmartMinimumIntervalSecs !== initial.broadcastSmartMinimumIntervalSecs ||
      positionFlags !== initial.positionFlags ||
      rxGpio !== initial.rxGpio ||
      txGpio !== initial.txGpio ||
      gpsEnGpio !== initial.gpsEnGpio
    );
  }, [positionBroadcastSecs, positionSmartEnabled, fixedPosition, fixedLatitude,
      fixedLongitude, fixedAltitude, gpsUpdateInterval, gpsMode,
      broadcastSmartMinimumDistance, broadcastSmartMinimumIntervalSecs,
      positionFlags, rxGpio, txGpio, gpsEnGpio]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setPositionBroadcastSecs(initial.positionBroadcastSecs);
    setPositionSmartEnabled(initial.positionSmartEnabled);
    setFixedPosition(initial.fixedPosition);
    setFixedLatitude(initial.fixedLatitude);
    setFixedLongitude(initial.fixedLongitude);
    setFixedAltitude(initial.fixedAltitude);
    setGpsUpdateInterval(initial.gpsUpdateInterval);
    setGpsMode(initial.gpsMode);
    setBroadcastSmartMinimumDistance(initial.broadcastSmartMinimumDistance);
    setBroadcastSmartMinimumIntervalSecs(initial.broadcastSmartMinimumIntervalSecs);
    setPositionFlags(initial.positionFlags);
    setRxGpio(initial.rxGpio);
    setTxGpio(initial.txGpio);
    setGpsEnGpio(initial.gpsEnGpio);
  }, [setPositionBroadcastSecs, setPositionSmartEnabled, setFixedPosition, setFixedLatitude,
      setFixedLongitude, setFixedAltitude, setGpsUpdateInterval, setGpsMode,
      setBroadcastSmartMinimumDistance, setBroadcastSmartMinimumIntervalSecs,
      setPositionFlags, setRxGpio, setTxGpio, setGpsEnGpio]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      positionBroadcastSecs, positionSmartEnabled, fixedPosition, fixedLatitude,
      fixedLongitude, fixedAltitude, gpsUpdateInterval, gpsMode,
      broadcastSmartMinimumDistance, broadcastSmartMinimumIntervalSecs,
      positionFlags, rxGpio, txGpio, gpsEnGpio
    };
  }, [onSave, positionBroadcastSecs, positionSmartEnabled, fixedPosition, fixedLatitude,
      fixedLongitude, fixedAltitude, gpsUpdateInterval, gpsMode,
      broadcastSmartMinimumDistance, broadcastSmartMinimumIntervalSecs,
      positionFlags, rxGpio, txGpio, gpsEnGpio]);

  // Register with SaveBar
  useSaveBar({
    id: 'position-config',
    sectionName: t('position_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
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
                {t('position_config.latitude_description')} • <a href="https://www.latlong.net/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>{t('position_config.find_coordinates')}</a>
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
        <input
          id="gpsUpdateInterval"
          type="number"
          min="0"
          max="4294967295"
          value={gpsUpdateInterval}
          onChange={(e) => setGpsUpdateInterval(parseInt(e.target.value) || 0)}
          className="setting-input"
        />
      </div>

      {/* Smart Broadcast Settings - show when smart broadcast is enabled */}
      {positionSmartEnabled && (
        <div style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--ctp-surface2)',
          marginTop: '0.5rem',
          marginBottom: '1rem'
        }}>
          {/* Minimum Distance */}
          <div className="setting-item">
            <label htmlFor="broadcastSmartMinimumDistance">
              {t('position_config.smart_min_distance')}
              <span className="setting-description">{t('position_config.smart_min_distance_description')}</span>
            </label>
            <input
              id="broadcastSmartMinimumDistance"
              type="number"
              min="0"
              max="4294967295"
              value={broadcastSmartMinimumDistance}
              onChange={(e) => setBroadcastSmartMinimumDistance(parseInt(e.target.value) || 0)}
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
            <input
              id="broadcastSmartMinimumIntervalSecs"
              type="number"
              min="0"
              max="4294967295"
              value={broadcastSmartMinimumIntervalSecs}
              onChange={(e) => setBroadcastSmartMinimumIntervalSecs(parseInt(e.target.value) || 0)}
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
            border: '1px solid var(--ctp-surface2)',
            color: 'var(--ctp-subtext0)',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          <span>{showAdvanced ? '▼' : '▶'}</span>
          {t('position_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--ctp-surface2)'
        }}>
          {/* RX GPIO */}
          <div className="setting-item">
            <label htmlFor="rxGpio">
              {t('position_config.rx_gpio')}
              <span className="setting-description">{t('position_config.rx_gpio_description')}</span>
            </label>
            <input
              id="rxGpio"
              type="number"
              min="0"
              max="255"
              value={rxGpio}
              onChange={(e) => setRxGpio(parseInt(e.target.value) || 0)}
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
            <input
              id="txGpio"
              type="number"
              min="0"
              max="255"
              value={txGpio}
              onChange={(e) => setTxGpio(parseInt(e.target.value) || 0)}
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
            <input
              id="gpsEnGpio"
              type="number"
              min="0"
              max="255"
              value={gpsEnGpio}
              onChange={(e) => setGpsEnGpio(parseInt(e.target.value) || 0)}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default PositionConfigSection;
