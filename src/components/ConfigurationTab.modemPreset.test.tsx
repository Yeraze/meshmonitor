/**
 * @vitest-environment jsdom
 *
 * Modem preset load/save round-trip (#5547).
 *
 * /api/config can carry the preset as an enum NAME (protobufjs toJSON). The
 * tab used to resolve it with `PRESET_MAP[name] || 0`, and PRESET_MAP lacked
 * TINY_FAST / TINY_SLOW, so a TINY_FAST radio loaded as LONG_FAST and saving
 * any LoRa field (a whole-struct replace) pushed LONG_FAST to it.
 *
 * Sibling sections are stubbed; the LoRa section stub exposes the props it is
 * handed plus a save trigger.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
}));

// --- mocks ---------------------------------------------------------------
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: h.invalidateQueries,
  }),
}));

vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 1, sourceName: 'test-source' }),
}));

vi.mock('../services/api', () => ({
  default: {
    getCurrentConfig: vi.fn().mockResolvedValue({}),
    getSecurityKeys: vi.fn().mockResolvedValue({}),
    setLoRaConfig: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// Stub every sibling config section as a no-op — only LoRaConfigSection needs
// a real interactive save trigger for this test.
vi.mock('./configuration/NodeIdentitySection', () => ({ default: () => null }));
vi.mock('./configuration/DeviceConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/LoRaConfigSection', () => ({
  default: (props: { onSave: () => Promise<void>; modemPreset: number; firmwareVersion?: string | null; unknownModemPresetName?: string | null }) => (
    <div>
      <span data-testid="lora-preset">{String(props.modemPreset)}</span>
      <span data-testid="lora-firmware">{String(props.firmwareVersion)}</span>
      <span data-testid="lora-unknown">{String(props.unknownModemPresetName)}</span>
      <button data-testid="lora-save" onClick={() => void props.onSave()}>Save LoRa</button>
    </div>
  ),
}));
vi.mock('./configuration/PositionConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MQTTConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/NeighborInfoSection', () => ({ default: () => null }));
vi.mock('./configuration/NetworkConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PowerConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/DisplayConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TelemetryConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/ExternalNotificationConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/StoreForwardConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/RangeTestConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/CannedMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AudioConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/RemoteHardwareConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/DetectionSensorConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PaxcounterConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/StatusMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TrafficManagementConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TAKConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SerialConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AmbientLightingConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SecurityConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({ default: () => null }));
vi.mock('./configuration/ChannelsConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/GpioPinSummary', () => ({ default: () => null }));
vi.mock('./configuration/BackupManagementSection', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./SectionNav', () => ({ default: () => null }));

import ConfigurationTab from './ConfigurationTab';
import apiService from '../services/api';
import { UNKNOWN_MODEM_PRESET } from './configuration/constants';

const api = apiService as unknown as {
  getCurrentConfig: ReturnType<typeof vi.fn>;
  setLoRaConfig: ReturnType<typeof vi.fn>;
};

function configWithPreset(modemPreset: unknown, usePreset = true) {
  return {
    localNodeInfo: { nodeNum: 1, longName: 'n', shortName: 'n', firmwareVersion: '2.8.1.8e6a88d' },
    deviceConfig: {
      lora: { usePreset, modemPreset, region: 'ITU2_2M', hopLimit: 3, txPower: 30, channelNum: 0 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConfigurationTab modem preset round-trip (#5547)', () => {
  it('loads TINY_FAST by name as 14 and saves 14, never LONG_FAST', async () => {
    api.getCurrentConfig.mockResolvedValue(configWithPreset('TINY_FAST'));
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    await waitFor(() => expect(screen.getByTestId('lora-preset').textContent).toBe('14'));
    expect(screen.getByTestId('lora-firmware').textContent).toBe('2.8.1.8e6a88d');

    fireEvent.click(screen.getByTestId('lora-save'));
    await waitFor(() => expect(api.setLoRaConfig).toHaveBeenCalled());
    const payload = api.setLoRaConfig.mock.calls[0][0];
    expect(payload.modemPreset).toBe(14);
    expect(payload.region).toBe(28);
  });

  it('loads TINY_SLOW as 15', async () => {
    api.getCurrentConfig.mockResolvedValue(configWithPreset('TINY_SLOW'));
    render(<ConfigurationTab nodes={[]} channels={[]} />);
    await waitFor(() => expect(screen.getByTestId('lora-preset').textContent).toBe('15'));
  });

  it('refuses to save an unrecognised preset with presets on, instead of sending LONG_FAST', async () => {
    api.getCurrentConfig.mockResolvedValue(configWithPreset('HYPER_FAST'));
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    await waitFor(() => expect(screen.getByTestId('lora-preset').textContent).toBe(String(UNKNOWN_MODEM_PRESET)));
    expect(screen.getByTestId('lora-unknown').textContent).toBe('HYPER_FAST');

    fireEvent.click(screen.getByTestId('lora-save'));
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith('config.lora_unknown_preset', 'error'));
    expect(api.setLoRaConfig).not.toHaveBeenCalled();
  });

  it('with custom parameters, omits an unrecognised preset so the server keeps the radio value', async () => {
    api.getCurrentConfig.mockResolvedValue(configWithPreset('HYPER_FAST', false));
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    await waitFor(() => expect(screen.getByTestId('lora-unknown').textContent).toBe('HYPER_FAST'));
    fireEvent.click(screen.getByTestId('lora-save'));
    await waitFor(() => expect(api.setLoRaConfig).toHaveBeenCalled());
    const payload = api.setLoRaConfig.mock.calls[0][0];
    expect('modemPreset' in payload).toBe(false);
    expect(payload.usePreset).toBe(false);
  });

  // The firmware gate reads localNodeInfo.firmwareVersion, the field
  // GET /api/config/current (MeshtasticManager.getCurrentConfig) carries. A
  // version under any other key must not be picked up by accident, and a
  // missing one must reach the section as null (unknown -> 2.8 rule).
  it('takes the firmware version from localNodeInfo, and nowhere else', async () => {
    api.getCurrentConfig.mockResolvedValue({
      ...configWithPreset(0),
      localNodeInfo: { nodeNum: 1, longName: 'n', shortName: 'n', firmwareVersion: '2.7.26.54e0d8d' },
      deviceMetadata: { firmwareVersion: '9.9.9' },
    });
    render(<ConfigurationTab nodes={[]} channels={[]} />);
    await waitFor(() => expect(screen.getByTestId('lora-firmware').textContent).toBe('2.7.26.54e0d8d'));
  });

  it('passes null when the local node has not reported a firmware version', async () => {
    api.getCurrentConfig.mockResolvedValue({
      ...configWithPreset(9),
      localNodeInfo: { nodeNum: 1, longName: 'n', shortName: 'n' },
      deviceMetadata: { firmwareVersion: '2.7.26' },
    });
    render(<ConfigurationTab nodes={[]} channels={[]} />);
    await waitFor(() => expect(screen.getByTestId('lora-preset').textContent).toBe('9'));
    expect(screen.getByTestId('lora-firmware').textContent).toBe('null');
  });

  it('passes a numeric preset through unchanged', async () => {
    api.getCurrentConfig.mockResolvedValue(configWithPreset(14));
    render(<ConfigurationTab nodes={[]} channels={[]} />);
    await waitFor(() => expect(screen.getByTestId('lora-preset').textContent).toBe('14'));
  });
});
