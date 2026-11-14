/**
 * @vitest-environment jsdom
 *
 * #6181: LoRaConfig.transparent_mode is shown read-only, with a warning when
 * the device reports it on. MeshMonitor offers no way to change it.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: () => {},
}));

import LoRaConfigSection from './LoRaConfigSection';

const baseProps = {
  usePreset: true,
  modemPreset: 0,
  bandwidth: 250,
  spreadFactor: 11,
  codingRate: 5,
  frequencyOffset: 0,
  overrideFrequency: 0,
  region: 1,
  hopLimit: 3,
  txPower: 30,
  channelNum: 0,
  femLnaMode: 0,
  sx126xRxBoostedGain: false,
  ignoreMqtt: false,
  configOkToMqtt: false,
  txEnabled: true,
  overrideDutyCycle: false,
  paFanDisabled: false,
  setUsePreset: vi.fn(),
  setModemPreset: vi.fn(),
  setBandwidth: vi.fn(),
  setSpreadFactor: vi.fn(),
  setCodingRate: vi.fn(),
  setFrequencyOffset: vi.fn(),
  setOverrideFrequency: vi.fn(),
  setRegion: vi.fn(),
  setHopLimit: vi.fn(),
  setTxPower: vi.fn(),
  setChannelNum: vi.fn(),
  setFemLnaMode: vi.fn(),
  setSx126xRxBoostedGain: vi.fn(),
  setIgnoreMqtt: vi.fn(),
  setConfigOkToMqtt: vi.fn(),
  setTxEnabled: vi.fn(),
  setOverrideDutyCycle: vi.fn(),
  setPaFanDisabled: vi.fn(),
  isSaving: false,
  onSave: vi.fn(async () => true),
};

describe('LoRaConfigSection — transparent mode (#6181)', () => {
  it('shows a checked, disabled checkbox and the warning when on', () => {
    render(<LoRaConfigSection {...baseProps} transparentMode />);
    const box = screen.getByRole('checkbox', { name: /transparent_mode/i }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getByTestId('lora-transparent-mode-warning').textContent).toContain('banners.transparent_mode');
  });

  it('shows an unchecked, disabled checkbox and no warning when off or omitted', () => {
    const { unmount } = render(<LoRaConfigSection {...baseProps} transparentMode={false} />);
    const box = screen.getByRole('checkbox', { name: /transparent_mode/i }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(screen.queryByTestId('lora-transparent-mode-warning')).toBeNull();
    unmount();

    render(<LoRaConfigSection {...baseProps} />);
    expect(screen.queryByTestId('lora-transparent-mode-warning')).toBeNull();
  });
});
