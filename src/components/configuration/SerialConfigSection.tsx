import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

// Serial baud rate options matching protobuf enum
const SERIAL_BAUD_OPTIONS = [
  { value: 0, name: 'BAUD_DEFAULT', description: 'Default baud rate' },
  { value: 1, name: 'BAUD_110', description: '110 bps' },
  { value: 2, name: 'BAUD_300', description: '300 bps' },
  { value: 3, name: 'BAUD_600', description: '600 bps' },
  { value: 4, name: 'BAUD_1200', description: '1200 bps' },
  { value: 5, name: 'BAUD_2400', description: '2400 bps' },
  { value: 6, name: 'BAUD_4800', description: '4800 bps' },
  { value: 7, name: 'BAUD_9600', description: '9600 bps' },
  { value: 8, name: 'BAUD_19200', description: '19200 bps' },
  { value: 9, name: 'BAUD_38400', description: '38400 bps' },
  { value: 10, name: 'BAUD_57600', description: '57600 bps' },
  { value: 11, name: 'BAUD_115200', description: '115200 bps' },
  { value: 12, name: 'BAUD_230400', description: '230400 bps' },
  { value: 13, name: 'BAUD_460800', description: '460800 bps' },
  { value: 14, name: 'BAUD_576000', description: '576000 bps' },
  { value: 15, name: 'BAUD_921600', description: '921600 bps' }
];

// Serial mode options matching protobuf enum
const SERIAL_MODE_OPTIONS = [
  { value: 0, name: 'DEFAULT', description: 'Default mode' },
  { value: 1, name: 'SIMPLE', description: 'Simple ASCII mode' },
  { value: 2, name: 'PROTO', description: 'Protobuf API mode' },
  { value: 3, name: 'TEXTMSG', description: 'Text message mode' },
  { value: 4, name: 'NMEA', description: 'NMEA GPS mode' },
  { value: 5, name: 'CALTOPO', description: 'CalTopo mode' },
  { value: 6, name: 'WS85', description: 'WS85 weather station' },
  { value: 7, name: 'VE_DIRECT', description: 'VE.Direct (Victron)' },
  { value: 8, name: 'MS_CONFIG', description: 'Config mode' }
];

interface SerialConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  echo: boolean;
  setEcho: (value: boolean) => void;
  rxd: number;
  setRxd: (value: number) => void;
  txd: number;
  setTxd: (value: number) => void;
  baud: number;
  setBaud: (value: number) => void;
  timeout: number;
  setTimeout: (value: number) => void;
  mode: number;
  setMode: (value: number) => void;
  overrideConsoleSerialPort: boolean;
  setOverrideConsoleSerialPort: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const SerialConfigSection: React.FC<SerialConfigSectionProps> = ({
  enabled,
  setEnabled,
  echo,
  setEcho,
  rxd,
  setRxd,
  txd,
  setTxd,
  baud,
  setBaud,
  timeout,
  setTimeout,
  mode,
  setMode,
  overrideConsoleSerialPort,
  setOverrideConsoleSerialPort,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Track initial values for change detection
  const initialValuesRef = useRef({
    enabled, echo, rxd, txd, baud, timeout, mode, overrideConsoleSerialPort
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      echo !== initial.echo ||
      rxd !== initial.rxd ||
      txd !== initial.txd ||
      baud !== initial.baud ||
      timeout !== initial.timeout ||
      mode !== initial.mode ||
      overrideConsoleSerialPort !== initial.overrideConsoleSerialPort
    );
  }, [enabled, echo, rxd, txd, baud, timeout, mode, overrideConsoleSerialPort]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setEcho(initial.echo);
    setRxd(initial.rxd);
    setTxd(initial.txd);
    setBaud(initial.baud);
    setTimeout(initial.timeout);
    setMode(initial.mode);
    setOverrideConsoleSerialPort(initial.overrideConsoleSerialPort);
  }, [setEnabled, setEcho, setRxd, setTxd, setBaud, setTimeout, setMode, setOverrideConsoleSerialPort]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, echo, rxd, txd, baud, timeout, mode, overrideConsoleSerialPort
    };
  }, [onSave, enabled, echo, rxd, txd, baud, timeout, mode, overrideConsoleSerialPort]);

  // Register with SaveBar
  useSaveBar({
    id: 'serial-config',
    sectionName: t('serial_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('serial_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/serial/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('serial_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="serialEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="serialEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('serial_config.enabled')}</div>
            <span className="setting-description">{t('serial_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Mode */}
          <div className="setting-item">
            <label htmlFor="serialMode">
              {t('serial_config.mode')}
              <span className="setting-description">{t('serial_config.mode_description')}</span>
            </label>
            <select
              id="serialMode"
              value={mode}
              onChange={(e) => setMode(parseInt(e.target.value))}
              className="setting-input"
            >
              {SERIAL_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name} - {option.description}
                </option>
              ))}
            </select>
          </div>

          {/* Baud Rate */}
          <div className="setting-item">
            <label htmlFor="serialBaud">
              {t('serial_config.baud')}
              <span className="setting-description">{t('serial_config.baud_description')}</span>
            </label>
            <select
              id="serialBaud"
              value={baud}
              onChange={(e) => setBaud(parseInt(e.target.value))}
              className="setting-input"
            >
              {SERIAL_BAUD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name} - {option.description}
                </option>
              ))}
            </select>
          </div>

          {/* Echo */}
          <div className="setting-item">
            <label htmlFor="serialEcho" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="serialEcho"
                type="checkbox"
                checked={echo}
                onChange={(e) => setEcho(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('serial_config.echo')}</div>
                <span className="setting-description">{t('serial_config.echo_description')}</span>
              </div>
            </label>
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
              {t('serial_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)'
            }}>
              {/* RXD Pin */}
              <div className="setting-item">
                <label htmlFor="serialRxd">
                  {t('serial_config.rxd')}
                  <span className="setting-description">{t('serial_config.rxd_description')}</span>
                </label>
                <input
                  id="serialRxd"
                  type="number"
                  min="0"
                  max="255"
                  value={rxd}
                  onChange={(e) => setRxd(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* TXD Pin */}
              <div className="setting-item">
                <label htmlFor="serialTxd">
                  {t('serial_config.txd')}
                  <span className="setting-description">{t('serial_config.txd_description')}</span>
                </label>
                <input
                  id="serialTxd"
                  type="number"
                  min="0"
                  max="255"
                  value={txd}
                  onChange={(e) => setTxd(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* Timeout */}
              <div className="setting-item">
                <label htmlFor="serialTimeout">
                  {t('serial_config.timeout')}
                  <span className="setting-description">{t('serial_config.timeout_description')}</span>
                </label>
                <input
                  id="serialTimeout"
                  type="number"
                  min="0"
                  max="65535"
                  value={timeout}
                  onChange={(e) => setTimeout(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  placeholder="0"
                />
              </div>

              {/* Override Console Serial Port */}
              <div className="setting-item">
                <label htmlFor="serialOverrideConsole" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="serialOverrideConsole"
                    type="checkbox"
                    checked={overrideConsoleSerialPort}
                    onChange={(e) => setOverrideConsoleSerialPort(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('serial_config.override_console')}</div>
                    <span className="setting-description">{t('serial_config.override_console_description')}</span>
                  </div>
                </label>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SerialConfigSection;
