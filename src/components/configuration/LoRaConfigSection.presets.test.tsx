/**
 * @vitest-environment jsdom
 *
 * LoRa preset picker + custom recipe loader (#5547, #5548).
 *
 * - The preset dropdown is filtered by region AND firmware: 2.8-only presets
 *   are hidden below 2.8, and on 2.8 each region offers only its own list.
 * - A current preset the filter would hide stays selected, with a warning.
 * - An unrecognised preset is shown as unknown, never as LONG_FAST.
 * - The recipe loader only writes BW/SF/CR after an in-page confirm, is
 *   disabled where the region cannot use it, and never touches the slot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: () => {},
}));

import LoRaConfigSection from './LoRaConfigSection';
import { UNKNOWN_MODEM_PRESET } from './constants';

const US = 1;
const EU_868 = 3;
const EU_866 = 29;
const ITU2_2M = 28;

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    usePreset: true,
    modemPreset: 0,
    bandwidth: 250,
    spreadFactor: 11,
    codingRate: 5,
    frequencyOffset: 0,
    overrideFrequency: 0,
    region: US,
    hopLimit: 3,
    txPower: 30,
    channelNum: 7,
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
    ...overrides,
  };
}

/** Opens the custom preset dropdown and returns the preset names it lists. */
function openPresetMenuNames(): string[] {
  fireEvent.click(document.querySelector('.config-custom-dropdown') as HTMLElement);
  const menu = document.querySelector('.config-custom-dropdown-menu') as HTMLElement;
  return Array.from(menu.children).map((row) => (row.firstElementChild as HTMLElement).textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoRaConfigSection preset picker (#5547)', () => {
  it('on firmware 2.8 in an ITU 2m region offers only TINY_FAST / TINY_SLOW (plus the current preset)', () => {
    render(<LoRaConfigSection {...makeProps({ region: ITU2_2M, modemPreset: 14, firmwareVersion: '2.8.1.8e6a88d' })} />);
    expect(openPresetMenuNames()).toEqual(['TINY_FAST', 'TINY_SLOW']);
  });

  it('on firmware 2.8 in US offers the ten standard presets and no LITE/NARROW/TINY', () => {
    render(<LoRaConfigSection {...makeProps({ firmwareVersion: '2.8.0' })} />);
    const names = openPresetMenuNames();
    expect(names).toHaveLength(10);
    expect(names).toContain('MEDIUM_TURBO');
    expect(names.some((n) => /^(LITE|NARROW|TINY)_/.test(n))).toBe(false);
  });

  it('on firmware 2.7 hides every 2.8-only preset, even in a region that would allow them on 2.8', () => {
    render(<LoRaConfigSection {...makeProps({ region: US, firmwareVersion: '2.7.26.54e0d8d' })} />);
    const names = openPresetMenuNames();
    expect(names).not.toContain('MEDIUM_TURBO');
    expect(names.some((n) => /^(LITE|NARROW|TINY)_/.test(n))).toBe(false);
    expect(names).toContain('LONG_TURBO');
  });

  it('keeps a current preset the filter would hide, selected, and warns about it (firmware)', () => {
    render(<LoRaConfigSection {...makeProps({ region: US, modemPreset: 16, firmwareVersion: '2.7.26' })} />);
    expect(screen.getByTestId('lora-preset-warning')).toHaveTextContent('lora_config.preset_illegal_firmware');
    expect(openPresetMenuNames()).toContain('MEDIUM_TURBO');
  });

  it('warns when the current preset is not in the region list on 2.8', () => {
    render(<LoRaConfigSection {...makeProps({ region: EU_866, modemPreset: 0, firmwareVersion: '2.8.1' })} />);
    expect(screen.getByTestId('lora-preset-warning')).toHaveTextContent('lora_config.preset_illegal_region');
    expect(openPresetMenuNames()).toEqual(['LONG_FAST', 'LITE_FAST', 'LITE_SLOW']);
  });

  it('shows no warning for a legal current preset', () => {
    render(<LoRaConfigSection {...makeProps({ region: ITU2_2M, modemPreset: 15, firmwareVersion: '2.8.1' })} />);
    expect(screen.queryByTestId('lora-preset-warning')).toBeNull();
  });

  it('renders TINY_FAST by name, not as LONG_FAST', () => {
    render(<LoRaConfigSection {...makeProps({ region: ITU2_2M, modemPreset: 14, firmwareVersion: '2.8.1' })} />);
    const header = document.querySelector('.config-custom-dropdown') as HTMLElement;
    expect(header).toHaveTextContent('TINY_FAST');
    expect(header).toHaveTextContent('BW: 15.6kHz, SF: 7, CR: 4/5');
    expect(header).not.toHaveTextContent('LONG_FAST');
  });

  it('shows an unrecognised preset as unknown, with a warning, never as LONG_FAST', () => {
    render(
      <LoRaConfigSection
        {...makeProps({ modemPreset: UNKNOWN_MODEM_PRESET, unknownModemPresetName: 'HYPER_FAST' })}
      />,
    );
    const header = document.querySelector('.config-custom-dropdown') as HTMLElement;
    expect(header).toHaveTextContent('lora_config.preset_unknown_name');
    expect(header).not.toHaveTextContent('LONG_FAST');
    expect(screen.getByTestId('lora-preset-warning')).toHaveTextContent('lora_config.preset_unknown_warning');
  });
});

describe('LoRaConfigSection custom recipe loader (#5548)', () => {
  function recipeOption(): HTMLOptionElement {
    const select = screen.getByLabelText(/lora_config\.recipe/) as HTMLSelectElement;
    return Array.from(select.options).find((o) => o.value === 'long-mod-turbo') as HTMLOptionElement;
  }

  it('is only shown with custom parameters', () => {
    render(<LoRaConfigSection {...makeProps({ usePreset: true })} />);
    expect(screen.queryByLabelText(/lora_config\.recipe/)).toBeNull();
  });

  it('asks for confirmation and writes nothing until confirmed', () => {
    const props = makeProps({ usePreset: false, region: US, firmwareVersion: '2.8.1' });
    render(<LoRaConfigSection {...props} />);

    fireEvent.change(screen.getByLabelText(/lora_config\.recipe/), { target: { value: 'long-mod-turbo' } });

    const confirm = screen.getByTestId('lora-recipe-confirm');
    expect(confirm).toHaveTextContent('lora_config.recipe_confirm_mesh');
    expect(confirm).toHaveTextContent('lora_config.recipe_confirm_not_official');
    expect(props.setBandwidth).not.toHaveBeenCalled();
    expect(props.setSpreadFactor).not.toHaveBeenCalled();
    expect(props.setCodingRate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('lora_config.recipe_confirm_apply'));

    expect(props.setBandwidth).toHaveBeenCalledWith(500);
    expect(props.setSpreadFactor).toHaveBeenCalledWith(11);
    expect(props.setCodingRate).toHaveBeenCalledWith(8);
    // Leaves the frequency slot, override frequency and region alone.
    expect(props.setChannelNum).not.toHaveBeenCalled();
    expect(props.setOverrideFrequency).not.toHaveBeenCalled();
    expect(props.setFrequencyOffset).not.toHaveBeenCalled();
    expect(props.setRegion).not.toHaveBeenCalled();
    expect(props.setUsePreset).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lora-recipe-confirm')).toBeNull();
  });

  it('cancelling the confirm changes nothing', () => {
    const props = makeProps({ usePreset: false, region: US });
    render(<LoRaConfigSection {...props} />);
    fireEvent.change(screen.getByLabelText(/lora_config\.recipe/), { target: { value: 'long-mod-turbo' } });
    fireEvent.click(screen.getByText('common.cancel'));

    expect(screen.queryByTestId('lora-recipe-confirm')).toBeNull();
    expect(props.setBandwidth).not.toHaveBeenCalled();
    expect(props.setSpreadFactor).not.toHaveBeenCalled();
    expect(props.setCodingRate).not.toHaveBeenCalled();
  });

  it('is disabled in EU_868, whose band cannot fit 500 kHz, on any firmware', () => {
    for (const firmwareVersion of ['2.7.26', '2.8.1', null]) {
      const { unmount } = render(<LoRaConfigSection {...makeProps({ usePreset: false, region: EU_868, firmwareVersion })} />);
      expect(recipeOption().disabled).toBe(true);
      expect(screen.getByText('lora_config.recipe_some_unavailable')).toBeInTheDocument();
      unmount();
    }
  });

  it('is disabled on 2.8 in a region whose widest preset is narrower than the recipe', () => {
    render(<LoRaConfigSection {...makeProps({ usePreset: false, region: ITU2_2M, firmwareVersion: '2.8.1' })} />);
    expect(recipeOption().disabled).toBe(true);
    expect(recipeOption().textContent).toContain('lora_config.recipe_illegal_region');
  });

  it('a disabled recipe cannot be loaded even if its value is forced', () => {
    const props = makeProps({ usePreset: false, region: EU_868 });
    render(<LoRaConfigSection {...props} />);
    fireEvent.change(screen.getByLabelText(/lora_config\.recipe/), { target: { value: 'long-mod-turbo' } });
    expect(screen.queryByTestId('lora-recipe-confirm')).toBeNull();
    expect(props.setBandwidth).not.toHaveBeenCalled();
  });

  it('loads nothing if the region stops allowing the recipe while the confirm is open', () => {
    const props = makeProps({ usePreset: false, region: US, firmwareVersion: '2.8.1' });
    const { rerender } = render(<LoRaConfigSection {...props} />);
    fireEvent.change(screen.getByLabelText(/lora_config\.recipe/), { target: { value: 'long-mod-turbo' } });
    expect(screen.getByTestId('lora-recipe-confirm')).toBeInTheDocument();

    rerender(<LoRaConfigSection {...props} region={EU_868} />);
    fireEvent.click(screen.getByText('lora_config.recipe_confirm_apply'));

    expect(props.setBandwidth).not.toHaveBeenCalled();
    expect(props.setSpreadFactor).not.toHaveBeenCalled();
    expect(props.setCodingRate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lora-recipe-confirm')).toBeNull();
  });

  it('is enabled in US', () => {
    render(<LoRaConfigSection {...makeProps({ usePreset: false, region: US, firmwareVersion: '2.8.1' })} />);
    expect(recipeOption().disabled).toBe(false);
    expect(screen.queryByText('lora_config.recipe_some_unavailable')).toBeNull();
  });
});
