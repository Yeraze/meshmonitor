/**
 * @vitest-environment jsdom
 *
 * Local Device Configuration: what Save sends for the two broadcast intervals.
 *
 * A node reports 0 for an interval left at the firmware default. Save used to
 * raise that 0 to MeshMonitor's floor first (32 s position, 3600 s node-info),
 * so saving any other field in the Position section set a 32-second position
 * broadcast. Pinned here: a stored 0 is sent as 0, an in-range value is sent
 * as typed, and any other value under the floor is still held back.
 *
 * The child sections are stubbed down to the props this test drives; their
 * own field validation is covered in PositionConfigSection.numberInput.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  getCurrentConfig: vi.fn(),
  setDeviceConfig: vi.fn(),
  setPositionConfig: vi.fn(),
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
    setDeviceConfig: h.setDeviceConfig,
    setPositionConfig: h.setPositionConfig,
  },
}));

vi.mock('./configuration/NodeIdentitySection', () => ({ default: () => null }));
vi.mock('./configuration/DeviceConfigSection', () => ({
  default: (p: { nodeInfoBroadcastSecs: number; setNodeInfoBroadcastSecs: (v: number) => void; onSave: () => Promise<void> }) => (
    <div>
      <span data-testid="device-interval">{p.nodeInfoBroadcastSecs}</span>
      <button data-testid="device-set-900" onClick={() => p.setNodeInfoBroadcastSecs(900)}>900</button>
      <button data-testid="device-set-7200" onClick={() => p.setNodeInfoBroadcastSecs(7200)}>7200</button>
      <button data-testid="device-save" onClick={() => void p.onSave()}>Save</button>
    </div>
  ),
}));
vi.mock('./configuration/LoRaConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PositionConfigSection', () => ({
  default: (p: { positionBroadcastSecs: number; setPositionBroadcastSecs: (v: number) => void; onSave: () => Promise<void> }) => (
    <div>
      <span data-testid="position-interval">{p.positionBroadcastSecs}</span>
      <button data-testid="position-set-5" onClick={() => p.setPositionBroadcastSecs(5)}>5</button>
      <button data-testid="position-set-600" onClick={() => p.setPositionBroadcastSecs(600)}>600</button>
      <button data-testid="position-save" onClick={() => void p.onSave()}>Save</button>
    </div>
  ),
}));
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

/** A node whose two intervals were never set: both come back as 0. */
const DEFAULT_NODE = {
  deviceConfig: {
    device: { role: 2, nodeInfoBroadcastSecs: 0, tzdef: 'UTC0', rebroadcastMode: 1 },
    position: { positionBroadcastSecs: 0, positionBroadcastSmartEnabled: true, gpsUpdateInterval: 120, gpsMode: 1 },
  },
};

async function renderLoaded() {
  render(<ConfigurationTab nodes={[]} channels={[]} />);
  await waitFor(() => expect(screen.getByTestId('position-interval').textContent).toBe('0'));
  await waitFor(() => expect(screen.getByTestId('device-interval').textContent).toBe('0'));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getCurrentConfig.mockResolvedValue(DEFAULT_NODE);
  h.setDeviceConfig.mockResolvedValue({ success: true });
  h.setPositionConfig.mockResolvedValue({ success: true });
});

describe('ConfigurationTab: a stored 0 interval', () => {
  it('Position: sends the stored 0 as 0, with the rest of the section as loaded', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('position-save'));

    await waitFor(() => expect(h.setPositionConfig).toHaveBeenCalledTimes(1));
    const [sent, sourceId] = h.setPositionConfig.mock.calls[0];
    expect(sent.positionBroadcastSecs).toBe(0);
    expect(sent).toMatchObject({ positionBroadcastSmartEnabled: true, gpsUpdateInterval: 120, gpsMode: 1 });
    expect(sourceId).toBe('source-1');
    // Not raised, so no "adjusted to the minimum" notice either.
    expect(screen.getByTestId('position-interval').textContent).toBe('0');
    expect(h.showToast).not.toHaveBeenCalledWith(expect.anything(), 'warning');
  });

  it('Position: sends an in-range value as typed', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('position-set-600'));
    fireEvent.click(screen.getByTestId('position-save'));

    await waitFor(() => expect(h.setPositionConfig).toHaveBeenCalledTimes(1));
    expect(h.setPositionConfig.mock.calls[0][0].positionBroadcastSecs).toBe(600);
  });

  it('Position: any other value under 32 s is raised, shown, and not sent', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('position-set-5'));
    fireEvent.click(screen.getByTestId('position-save'));

    await waitFor(() => expect(screen.getByTestId('position-interval').textContent).toBe('32'));
    expect(h.showToast).toHaveBeenCalledWith(expect.anything(), 'warning');
    expect(h.setPositionConfig).not.toHaveBeenCalled();
  });

  it('Device: sends the stored 0 as 0, with the rest of the section as loaded', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('device-save'));

    await waitFor(() => expect(h.setDeviceConfig).toHaveBeenCalledTimes(1));
    const [sent] = h.setDeviceConfig.mock.calls[0];
    expect(sent.nodeInfoBroadcastSecs).toBe(0);
    expect(sent).toMatchObject({ role: 2, tzdef: 'UTC0', rebroadcastMode: 1 });
    expect(screen.getByTestId('device-interval').textContent).toBe('0');
    expect(h.showToast).not.toHaveBeenCalledWith(expect.anything(), 'warning');
  });

  it('Device: sends an in-range value as typed', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('device-set-7200'));
    fireEvent.click(screen.getByTestId('device-save'));

    await waitFor(() => expect(h.setDeviceConfig).toHaveBeenCalledTimes(1));
    expect(h.setDeviceConfig.mock.calls[0][0].nodeInfoBroadcastSecs).toBe(7200);
  });

  it('Device: any other value under 3600 s is raised, shown, and not sent', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('device-set-900'));
    fireEvent.click(screen.getByTestId('device-save'));

    await waitFor(() => expect(screen.getByTestId('device-interval').textContent).toBe('3600'));
    expect(h.showToast).toHaveBeenCalledWith(expect.anything(), 'warning');
    expect(h.setDeviceConfig).not.toHaveBeenCalled();
  });
});
