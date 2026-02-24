import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface PinUsage {
  pin: number;
  section: string;
  field: string;
  fieldKey: string;
}

interface GpioPinSummaryProps {
  // Device Config
  buttonGpio: number;
  buzzerGpio: number;
  // Position Config
  rxGpio: number;
  txGpio: number;
  gpsEnGpio: number;
  // External Notification Config
  extNotifOutput: number;
  extNotifOutputVibra: number;
  extNotifOutputBuzzer: number;
  // Canned Message Config
  cannedMsgInputbrokerPinA: number;
  cannedMsgInputbrokerPinB: number;
  cannedMsgInputbrokerPinPress: number;
  // Audio Config
  audioPttPin: number;
  audioI2sWs: number;
  audioI2sSd: number;
  audioI2sDin: number;
  audioI2sSck: number;
  // Detection Sensor Config
  detectionSensorMonitorPin: number;
  // Serial Config
  serialRxd: number;
  serialTxd: number;
}

const GpioPinSummary: React.FC<GpioPinSummaryProps> = (props) => {
  const { t } = useTranslation();

  const pinUsages = useMemo(() => {
    const usages: PinUsage[] = [];

    // Helper to add pin usage if pin is not 0 (0 often means disabled/default)
    const addPin = (pin: number, section: string, field: string, fieldKey: string) => {
      if (pin !== 0) {
        usages.push({ pin, section, field, fieldKey });
      }
    };

    // Device Config
    addPin(props.buttonGpio, t('config.device_config'), t('gpio_summary.button_gpio'), 'buttonGpio');
    addPin(props.buzzerGpio, t('config.device_config'), t('gpio_summary.buzzer_gpio'), 'buzzerGpio');

    // Position Config
    addPin(props.rxGpio, t('config.position_config'), t('gpio_summary.gps_rx'), 'rxGpio');
    addPin(props.txGpio, t('config.position_config'), t('gpio_summary.gps_tx'), 'txGpio');
    addPin(props.gpsEnGpio, t('config.position_config'), t('gpio_summary.gps_enable'), 'gpsEnGpio');

    // External Notification Config
    addPin(props.extNotifOutput, t('extnotif_config.title'), t('gpio_summary.led_output'), 'extNotifOutput');
    addPin(props.extNotifOutputVibra, t('extnotif_config.title'), t('gpio_summary.vibra_output'), 'extNotifOutputVibra');
    addPin(props.extNotifOutputBuzzer, t('extnotif_config.title'), t('gpio_summary.buzzer_output'), 'extNotifOutputBuzzer');

    // Canned Message Config
    addPin(props.cannedMsgInputbrokerPinA, t('cannedmsg_config.title'), t('gpio_summary.encoder_pin_a'), 'cannedMsgInputbrokerPinA');
    addPin(props.cannedMsgInputbrokerPinB, t('cannedmsg_config.title'), t('gpio_summary.encoder_pin_b'), 'cannedMsgInputbrokerPinB');
    addPin(props.cannedMsgInputbrokerPinPress, t('cannedmsg_config.title'), t('gpio_summary.encoder_press'), 'cannedMsgInputbrokerPinPress');

    // Audio Config
    addPin(props.audioPttPin, t('audio_config.title'), t('gpio_summary.ptt_pin'), 'audioPttPin');
    addPin(props.audioI2sWs, t('audio_config.title'), t('gpio_summary.i2s_ws'), 'audioI2sWs');
    addPin(props.audioI2sSd, t('audio_config.title'), t('gpio_summary.i2s_sd'), 'audioI2sSd');
    addPin(props.audioI2sDin, t('audio_config.title'), t('gpio_summary.i2s_din'), 'audioI2sDin');
    addPin(props.audioI2sSck, t('audio_config.title'), t('gpio_summary.i2s_sck'), 'audioI2sSck');

    // Detection Sensor Config
    addPin(props.detectionSensorMonitorPin, t('detectionsensor_config.title'), t('gpio_summary.monitor_pin'), 'detectionSensorMonitorPin');

    // Serial Config
    addPin(props.serialRxd, t('serial_config.title'), t('gpio_summary.serial_rx'), 'serialRxd');
    addPin(props.serialTxd, t('serial_config.title'), t('gpio_summary.serial_tx'), 'serialTxd');

    return usages;
  }, [props, t]);

  // Group by pin number to find conflicts
  const pinGroups = useMemo(() => {
    const groups = new Map<number, PinUsage[]>();

    for (const usage of pinUsages) {
      const existing = groups.get(usage.pin) || [];
      existing.push(usage);
      groups.set(usage.pin, existing);
    }

    // Sort by pin number
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [pinUsages]);

  // Find pins with conflicts (used by more than one field)
  const conflictPins = useMemo(() => {
    return new Set(
      pinGroups
        .filter(([_, usages]) => usages.length > 1)
        .map(([pin]) => pin)
    );
  }, [pinGroups]);

  if (pinUsages.length === 0) {
    return (
      <div style={{
        padding: '1rem',
        backgroundColor: 'var(--ctp-surface0)',
        borderRadius: '8px',
        border: '1px solid var(--ctp-surface2)',
        maxHeight: 'calc(100vh - 2rem)',
        overflowY: 'auto'
      }}>
        <h4 style={{ margin: '0 0 0.5rem 0', color: 'var(--ctp-text)' }}>
          {t('gpio_summary.title')}
        </h4>
        <p style={{ margin: 0, color: 'var(--ctp-subtext0)', fontSize: '0.85rem' }}>
          {t('gpio_summary.no_pins')}
        </p>
      </div>
    );
  }

  return (
    <div style={{
      padding: '1rem',
      backgroundColor: 'var(--ctp-surface0)',
      borderRadius: '8px',
      border: '1px solid var(--ctp-surface2)',
      maxHeight: 'calc(100vh - 2rem)',
      overflowY: 'auto'
    }}>
      <h4 style={{ margin: '0 0 0.5rem 0', color: 'var(--ctp-text)' }}>
        {t('gpio_summary.title')}
      </h4>
      <p style={{ margin: '0 0 1rem 0', color: 'var(--ctp-subtext0)', fontSize: '0.85rem' }}>
        {t('gpio_summary.description')}
      </p>

      {conflictPins.size > 0 && (
        <div style={{
          backgroundColor: 'rgba(255, 68, 68, 0.15)',
          border: '1px solid #ff4444',
          borderRadius: '4px',
          padding: '0.5rem 0.75rem',
          marginBottom: '1rem',
          color: '#ff6b6b',
          fontSize: '0.85rem'
        }}>
          <strong>⚠️ {t('gpio_summary.conflict_warning')}</strong>
        </div>
      )}

      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '0.8rem'
      }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--ctp-surface2)' }}>
            <th style={{ textAlign: 'left', padding: '0.4rem', width: '55px' }}>
              {t('gpio_summary.pin')}
            </th>
            <th style={{ textAlign: 'left', padding: '0.4rem' }}>
              {t('gpio_summary.usage')}
            </th>
          </tr>
        </thead>
        <tbody>
          {pinGroups.map(([pin, usages]) => {
            const isConflict = conflictPins.has(pin);
            const rowStyle: React.CSSProperties = {
              borderBottom: '1px solid var(--ctp-surface1)',
              backgroundColor: isConflict ? 'rgba(255, 68, 68, 0.1)' : 'transparent'
            };
            const cellStyle: React.CSSProperties = {
              padding: '0.4rem',
              color: isConflict ? '#ff6b6b' : 'inherit',
              verticalAlign: 'top'
            };

            return (
              <tr key={pin} style={rowStyle}>
                <td style={{ ...cellStyle, fontFamily: 'monospace', fontWeight: 'bold' }}>
                  {pin}
                  {isConflict && <span style={{ marginLeft: '0.25rem' }}>⚠️</span>}
                </td>
                <td style={cellStyle}>
                  {usages.map((usage, idx) => (
                    <div key={idx} style={{ marginBottom: idx < usages.length - 1 ? '0.25rem' : 0 }}>
                      <span style={{ fontWeight: 500 }}>{usage.field}</span>
                      <br />
                      <span style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
                        {usage.section}
                      </span>
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default GpioPinSummary;
