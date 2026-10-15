/**
 * @vitest-environment jsdom
 *
 * Device Configuration: a save the firmware reboots for tells the parent to
 * expect it (#5823). Meshtastic 2.7.9 and 2.8.1 reboot ~7 s after most config
 * and module saves; the UI used to treat them as reboot-free.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  getCurrentConfig: vi.fn(),
  setMQTTConfig: vi.fn(),
  setPositionConfig: vi.fn(),
  setTelemetryConfig: vi.fn(),
  setNodeOwner: vi.fn(),
  setLoRaConfig: vi.fn(),
  setModuleConfig: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'source-1', sourceName: 'test-source' }) }));
vi.mock('../services/api', () => ({
  default: {
    getCurrentConfig: h.getCurrentConfig,
    getSecurityKeys: vi.fn().mockResolvedValue({}),
    setMQTTConfig: h.setMQTTConfig,
    setPositionConfig: h.setPositionConfig,
    setTelemetryConfig: h.setTelemetryConfig,
    setNodeOwner: h.setNodeOwner,
    setLoRaConfig: h.setLoRaConfig,
    setModuleConfig: h.setModuleConfig,
  },
}));

type SaveProps = { onSave: () => Promise<boolean> };
// Each section is a probe with one Save button; its own rendering is covered
// by its own tests.
vi.mock('./configuration/NodeIdentitySection', () => ({
  default: (p: SaveProps) => <button data-testid="owner-save" onClick={() => void p.onSave()}>Save</button>,
}));
vi.mock('./configuration/DeviceConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/LoRaConfigSection', () => ({
  default: (p: SaveProps) => <button data-testid="lora-save" onClick={() => void p.onSave()}>Save</button>,
}));
vi.mock('./configuration/PositionConfigSection', () => ({
  default: (p: SaveProps) => <button data-testid="position-save" onClick={() => void p.onSave()}>Save</button>,
}));
vi.mock('./configuration/MQTTConfigSection', () => ({
  default: (p: SaveProps) => <button data-testid="mqtt-save" onClick={() => void p.onSave()}>Save</button>,
}));
vi.mock('./configuration/NeighborInfoSection', () => ({ default: () => null }));
vi.mock('./configuration/NetworkConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PowerConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/DisplayConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TelemetryConfigSection', () => ({
  default: (p: SaveProps) => <button data-testid="telemetry-save" onClick={() => void p.onSave()}>Save</button>,
}));
vi.mock('./configuration/ExternalNotificationConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/StoreForwardConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/RangeTestConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/CannedMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AudioConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/RemoteHardwareConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/DetectionSensorConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PaxcounterConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/StatusMessageConfigSection', () => ({
  default: (p: SaveProps) => <button data-testid="statusmessage-save" onClick={() => void p.onSave()}>Save</button>,
}));
vi.mock('./configuration/StatusMessageReapplyOption', () => ({ default: () => null }));
vi.mock('./configuration/TrafficManagementConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TAKConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SerialConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AmbientLightingConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SecurityConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({ default: () => null }));
vi.mock('./configuration/FirmwareUpdateSection', () => ({ default: () => null }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { user: { isAdmin: false } }, hasPermission: () => true }),
}));
vi.mock('../hooks/useHealth', () => ({ useHealth: () => ({ data: undefined }) }));
vi.mock('./configuration/ChannelsConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/GpioPinSummary', () => ({ default: () => null }));
vi.mock('./configuration/BackupManagementSection', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./SectionNav', () => ({ default: () => null }));

import ConfigurationTab from './ConfigurationTab';

const onReboot = vi.fn();

async function renderOn(firmwareVersion: string) {
  h.getCurrentConfig.mockResolvedValue({
    localNodeInfo: { longName: 'Node', shortName: 'N', firmwareVersion },
    deviceConfig: { lora: { usePreset: true, modemPreset: 0, region: 1, hopLimit: 3 } },
    moduleConfig: {},
  });
  render(<ConfigurationTab nodes={[]} channels={[]} onConfigChangeTriggeringReboot={onReboot} />);
  await waitFor(() => expect(h.getCurrentConfig).toHaveBeenCalled());
  // Let the load finish so the firmware version is in state.
  await waitFor(() => expect(screen.getByTestId('mqtt-save')).toBeTruthy());
}

async function clickSave(id: string, setter: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByTestId(id));
  await waitFor(() => expect(setter).toHaveBeenCalledTimes(1));
  // The signal follows the awaited save in the same handler.
  await waitFor(() => expect(h.showToast).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [h.setMQTTConfig, h.setPositionConfig, h.setTelemetryConfig, h.setNodeOwner, h.setLoRaConfig, h.setModuleConfig]) {
    fn.mockResolvedValue({ success: true });
  }
});

describe('ConfigurationTab: expect the reboot a save causes (#5823)', () => {
  it.each([
    ['mqtt-save', 'setMQTTConfig'],
    ['position-save', 'setPositionConfig'],
    ['telemetry-save', 'setTelemetryConfig'],
  ] as const)('a successful %s signals a certain reboot', async (id, setter) => {
    await renderOn('2.7.9.70724be');
    await clickSave(id, h[setter]);
    await waitFor(() => expect(onReboot).toHaveBeenCalledWith('always'));
    expect(onReboot).toHaveBeenCalledTimes(1);
  });

  it('a failed MQTT save does not signal a reboot', async () => {
    h.setMQTTConfig.mockRejectedValue(new Error('node did not answer'));
    await renderOn('2.7.9.70724be');
    await clickSave('mqtt-save', h.setMQTTConfig);
    expect(onReboot).not.toHaveBeenCalled();
  });

  it('an owner save signals a possible reboot', async () => {
    await renderOn('2.8.1.8e6a88d');
    await clickSave('owner-save', h.setNodeOwner);
    await waitFor(() => expect(onReboot).toHaveBeenCalledWith('possible'));
  });

  it('a Status Message save on 2.8 does not signal a reboot', async () => {
    await renderOn('2.8.1.8e6a88d');
    await clickSave('statusmessage-save', h.setModuleConfig);
    expect(h.setModuleConfig.mock.calls[0][0]).toBe('statusmessage');
    expect(onReboot).not.toHaveBeenCalled();
  });

  it('a LoRa save on 2.7 signals a reboot', async () => {
    await renderOn('2.7.9.70724be');
    await clickSave('lora-save', h.setLoRaConfig);
    await waitFor(() => expect(onReboot).toHaveBeenCalledWith('always'));
  });

  it('a LoRa save on 2.8 does not signal a reboot: 2.8 applies it live', async () => {
    await renderOn('2.8.1.8e6a88d');
    await clickSave('lora-save', h.setLoRaConfig);
    expect(onReboot).not.toHaveBeenCalled();
  });
});
