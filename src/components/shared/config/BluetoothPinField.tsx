/**
 * BluetoothPinField — the pairing-mode select and PIN input (P8a #6257, S5).
 *
 * One field for every source. Meshtastic offers random / fixed / none and a
 * 0–999999 PIN; MeshCore offers default (0, the firmware picks) / fixed and a
 * 100000–999999 PIN. The caller picks the modes and the PIN range through
 * props; this component owns the markup only and saves nothing.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../../common/NumberInput';
import styles from './BluetoothPinField.module.css';

export type BluetoothPinMode = 'random' | 'fixed' | 'none' | 'default';

export interface BluetoothPinFieldProps {
  /** Modes to offer, in menu order. */
  modes: readonly BluetoothPinMode[];
  mode: BluetoothPinMode;
  onModeChange: (mode: BluetoothPinMode) => void;
  /** The PIN shown when `mode` is `fixed`. */
  pin: number;
  onPinChange: (pin: number) => void;
  /** Legal PIN range in fixed mode. */
  fixedRange: { min: number; max: number };
  disabled?: boolean;
  /** Replaces the default fixed-PIN description. */
  fixedPinDescription?: string;
  /** Shown under the field, e.g. "applies after reboot". */
  note?: React.ReactNode;
}

const MODE_LABELS: Record<BluetoothPinMode, { key: string; fallback: string }> = {
  random: { key: 'admin_commands.bluetooth_mode_random_pin', fallback: 'Random PIN' },
  fixed: { key: 'admin_commands.bluetooth_mode_fixed_pin', fallback: 'Fixed PIN' },
  none: { key: 'admin_commands.bluetooth_mode_no_pin', fallback: 'No PIN' },
  default: { key: 'meshcore.ble_pin.mode_default', fallback: 'Firmware default' },
};

export const BluetoothPinField: React.FC<BluetoothPinFieldProps> = ({
  modes,
  mode,
  onModeChange,
  pin,
  onPinChange,
  fixedRange,
  disabled,
  fixedPinDescription,
  note,
}) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="setting-item">
        <label>
          {t('admin_commands.bluetooth_pairing_mode', 'Pairing Mode')}
          <span className="setting-description">{t('admin_commands.bluetooth_pairing_mode_description', 'Determines the pairing strategy for the device')}</span>
        </label>
        <select
          value={modes.indexOf(mode)}
          onChange={(e) => onModeChange(modes[parseInt(e.target.value)])}
          disabled={disabled}
          className="setting-input"
          style={{ width: '100%', maxWidth: '600px' }}
        >
          {modes.map((m, i) => (
            <option key={m} value={i}>{t(MODE_LABELS[m].key, MODE_LABELS[m].fallback)}</option>
          ))}
        </select>
      </div>
      {mode === 'fixed' && (
        <div className="setting-item">
          <label>
            {t('admin_commands.bluetooth_fixed_pin', 'Fixed PIN')}
            <span className="setting-description">
              {fixedPinDescription ?? t('admin_commands.bluetooth_fixed_pin_description', 'PIN code for pairing (required when using Fixed PIN mode)')}
            </span>
          </label>
          <NumberInput
            integer
            min={fixedRange.min}
            max={fixedRange.max}
            value={pin}
            onChange={onPinChange}
            disabled={disabled}
            className="setting-input"
            style={{ width: '100%', maxWidth: '600px' }}
            placeholder="123456"
          />
        </div>
      )}
      {note && <span className={styles.note}>{note}</span>}
    </>
  );
};

export default BluetoothPinField;
