/**
 * @vitest-environment jsdom
 *
 * #6452: the FEM LNA dropdown shows AUTO (3) as selected, and shows a value
 * newer than its list as "Unknown (N)" rather than the first option, so a save
 * sends the node's value back unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

describe('LoRaConfigSection — FEM LNA mode (#6452)', () => {
  const select = () => document.getElementById('femLnaMode') as HTMLSelectElement;

  it('shows AUTO (3) as the selected option', () => {
    render(<LoRaConfigSection {...baseProps} femLnaMode={3} />);
    expect(select().value).toBe('3');
    expect(select().selectedOptions[0].textContent).toMatch(/AUTO/);
  });

  it('shows an unknown value as "Unknown (N)" and selects it', () => {
    render(<LoRaConfigSection {...baseProps} femLnaMode={7} />);
    expect(select().value).toBe('7');
    expect(select().selectedOptions[0].textContent).toMatch(/Unknown \(7\)/);
    expect(screen.getAllByRole('option', { name: /Unknown/ })).toHaveLength(1);
  });

  it('lists no Unknown option for a known value', () => {
    render(<LoRaConfigSection {...baseProps} femLnaMode={1} />);
    expect(screen.queryByRole('option', { name: /Unknown/ })).toBeNull();
  });

  it('picking AUTO reports 3', () => {
    const setFemLnaMode = vi.fn();
    render(<LoRaConfigSection {...baseProps} femLnaMode={0} setFemLnaMode={setFemLnaMode} />);
    fireEvent.change(select(), { target: { value: '3' } });
    expect(setFemLnaMode).toHaveBeenCalledWith(3);
  });
});
