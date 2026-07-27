/**
 * @vitest-environment jsdom
 *
 * Tests for the TX-enabled checkbox danger-confirm (#4294, TX-disabled Phase 2 WP2).
 *
 * Disabling TX makes the node invisible to the mesh, so unchecking the box must
 * confirm via window.confirm before committing the change. Re-enabling TX never
 * prompts, and cancelling the confirm must leave the checkbox in its prior state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

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
  onSave: vi.fn(async () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoRaConfigSection — TX-enabled danger-confirm', () => {
  it('confirms before disabling TX, and calls setTxEnabled(false) when accepted', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LoRaConfigSection {...baseProps} txEnabled={true} />);

    const checkbox = screen.getByRole('checkbox', { name: /tx_enabled/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    checkbox.click();

    expect(confirmSpy).toHaveBeenCalledWith('lora_config.tx_disable_confirm');
    expect(baseProps.setTxEnabled).toHaveBeenCalledWith(false);
  });

  it('does not call setTxEnabled when the disable confirm is cancelled', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LoRaConfigSection {...baseProps} txEnabled={true} />);

    const checkbox = screen.getByRole('checkbox', { name: /tx_enabled/i }) as HTMLInputElement;
    checkbox.click();

    expect(confirmSpy).toHaveBeenCalledWith('lora_config.tx_disable_confirm');
    expect(baseProps.setTxEnabled).not.toHaveBeenCalled();
  });

  it('never prompts when re-enabling TX (false -> true)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LoRaConfigSection {...baseProps} txEnabled={false} />);

    const checkbox = screen.getByRole('checkbox', { name: /tx_enabled/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    checkbox.click();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(baseProps.setTxEnabled).toHaveBeenCalledWith(true);
  });
});
