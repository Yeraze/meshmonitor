/**
 * MeshCoreBlePinSection — Bluetooth pairing PIN for a Companion (P8a #6257).
 *
 * `0` means the firmware default; a fixed PIN is 100000-999999. The device
 * keeps the PIN in its prefs and uses it after the next reboot, and only
 * Bluetooth builds pair with it. The PIN is a pairing credential, so the
 * server reads it back only for `configuration:write`. Saved by its own
 * button; the controls are a draft until then.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreActions } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { ConfigSection } from '../shared/config/ConfigSection';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { BluetoothPinField, type BluetoothPinMode } from '../shared/config/BluetoothPinField';
import styles from './MeshCoreDeviceSettingSections.module.css';

const BLE_PIN_RANGE = { min: 100000, max: 999999 } as const;
const MODES: readonly BluetoothPinMode[] = ['default', 'fixed'];

export interface MeshCoreBlePinSectionProps {
  connected: boolean;
  loading?: boolean;
  actions: Pick<MeshCoreActions, 'getBlePin' | 'setBlePin'>;
  /** `configuration:write` on this source. */
  canWriteConfig: boolean;
}

export const MeshCoreBlePinSection: React.FC<MeshCoreBlePinSectionProps> = ({
  connected,
  loading = false,
  actions,
  canWriteConfig,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { getBlePin, setBlePin } = actions;
  const numbers = useNumberInputScope();
  const [savedPin, setSavedPin] = useState(0);
  const [mode, setMode] = useState<BluetoothPinMode>('default');
  const [pin, setPin] = useState<number>(BLE_PIN_RANGE.min);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connected || !canWriteConfig) return;
    let cancelled = false;
    void Promise.resolve(getBlePin?.()).then((value) => {
      if (cancelled || typeof value !== 'number') return;
      setSavedPin(value);
      setMode(value === 0 ? 'default' : 'fixed');
      if (value !== 0) setPin(value);
    });
    return () => { cancelled = true; };
  }, [connected, canWriteConfig, getBlePin]);

  const draftPin = mode === 'default' ? 0 : pin;
  const pinValid = draftPin === 0 || (draftPin >= BLE_PIN_RANGE.min && draftPin <= BLE_PIN_RANGE.max);
  const disabled = !canWriteConfig || !connected || loading || saving;

  const handleSave = async () => {
    if (!pinValid) return;
    setSaving(true);
    try {
      const ok = await setBlePin(draftPin);
      if (!ok) {
        showToast(t('meshcore.ble_pin.save_failed', 'Failed to set the BLE PIN'), 'error');
        return;
      }
      setSavedPin(draftPin);
      showToast(t('meshcore.ble_pin.saved', 'BLE PIN saved. It applies after the device reboots.'), 'success');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="meshcore-ble-pin">
      <ConfigSection
        title={t('meshcore.ble_pin.title', 'Bluetooth PIN')}
        description={t('meshcore.ble_pin.hint', 'The PIN a phone enters to pair with this device over Bluetooth. Default (0) lets the firmware choose.')}
        canWrite={canWriteConfig}
        collapsible
      >
        <NumberInputScope scope={numbers}>
          <BluetoothPinField
            modes={MODES}
            mode={mode}
            onModeChange={setMode}
            pin={pin}
            onPinChange={setPin}
            fixedRange={BLE_PIN_RANGE}
            disabled={disabled}
            fixedPinDescription={t('meshcore.ble_pin.fixed_description', 'Six digits, 100000 to 999999.')}
            note={t('meshcore.ble_pin.note', 'Applies after the device reboots. Bluetooth builds only.')}
          />
          <div className={styles.block}>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={disabled || !pinValid || numbers.invalid || draftPin === savedPin}
              aria-label={t('meshcore.ble_pin.save', 'Save Bluetooth PIN')}
            >
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </NumberInputScope>
      </ConfigSection>
    </div>
  );
};

export default MeshCoreBlePinSection;
