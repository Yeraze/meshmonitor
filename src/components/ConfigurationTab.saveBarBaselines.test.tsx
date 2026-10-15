/**
 * @vitest-environment jsdom
 *
 * Local Device Configuration: what the SaveBar thinks is "unsaved" (#5797).
 *
 * Each section compares its fields with a baseline, the values the node is
 * known to hold. These tests drive the real sections through ConfigurationTab
 * and pin when that baseline moves:
 *   - a save that went through clears the section;
 *   - a save that failed leaves it dirty, and Dismiss goes back to the node's values;
 *   - saving one section does not move another section's baseline;
 *   - Reload config re-baselines to what the node reported;
 *   - NeighborInfo records the interval it actually sent (raised to 14400 s).
 *
 * The API is mocked; no network, no device writes.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SaveBarProvider, useSaveBarContext } from '../contexts/SaveBarContext';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  getCurrentConfig: vi.fn(),
  refreshNodes: vi.fn(),
  setNodeOwner: vi.fn(),
  setDeviceConfig: vi.fn(),
  setNeighborInfoConfig: vi.fn(),
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
    refreshNodes: h.refreshNodes,
    setNodeOwner: h.setNodeOwner,
    setDeviceConfig: h.setDeviceConfig,
    setNeighborInfoConfig: h.setNeighborInfoConfig,
  },
}));

// NodeIdentity, Device and NeighborInfo stay real; the rest are stubbed out.
vi.mock('./configuration/LoRaConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PositionConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MQTTConfigSection', () => ({ default: () => null }));
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

/**
 * Stands in for the SaveBar: shows each section's dirty flag and drives its
 * Save / Dismiss the way SaveBar.tsx does (Save is blocked while invalid).
 */
const SaveBarProbe: React.FC = () => {
  const { sections } = useSaveBarContext();
  return (
    <div>
      {[...sections.values()].map(s => (
        <div key={s.id}>
          <span data-testid={`dirty-${s.id}`}>{String(s.hasChanges)}</span>
          <button
            data-testid={`save-${s.id}`}
            onClick={() => { if (!s.invalid) void s.onSave(); }}
          >save</button>
          <button data-testid={`dismiss-${s.id}`} onClick={() => s.onDismiss()}>dismiss</button>
        </div>
      ))}
    </div>
  );
};

const LOADED = {
  localNodeInfo: { longName: 'Alpha Node', shortName: 'ALP', isUnmessagable: false, isLicensed: false },
  deviceConfig: {
    device: { role: 0, nodeInfoBroadcastSecs: 10800, tzdef: 'UTC0', rebroadcastMode: 0, ledHeartbeatDisabled: false },
  },
  moduleConfig: {
    // Interval under the 14400 s floor; Save raises it.
    neighborInfo: { enabled: true, updateInterval: 900, transmitOverLora: false },
  },
};

const dirty = (id: string) => screen.getByTestId(`dirty-${id}`).textContent;
const longName = () => (screen.getByLabelText(/node_identity\.long_name/) as HTMLInputElement);

async function renderLoaded() {
  render(
    <SaveBarProvider>
      <ConfigurationTab nodes={[]} channels={[]} />
      <SaveBarProbe />
    </SaveBarProvider>
  );
  await waitFor(() => expect(longName().value).toBe('Alpha Node'));
  await waitFor(() => expect(dirty('node-identity')).toBe('false'));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getCurrentConfig.mockResolvedValue(LOADED);
  h.refreshNodes.mockResolvedValue(undefined);
  h.setNodeOwner.mockResolvedValue({ success: true });
  h.setDeviceConfig.mockResolvedValue({ success: true });
  h.setNeighborInfoConfig.mockResolvedValue({ success: true });
});

describe('ConfigurationTab SaveBar baselines (#5797)', () => {
  it('a successful save clears the section', async () => {
    await renderLoaded();

    fireEvent.change(longName(), { target: { value: 'Bravo Node' } });
    await waitFor(() => expect(dirty('node-identity')).toBe('true'));

    fireEvent.click(screen.getByTestId('save-node-identity'));

    await waitFor(() => expect(h.setNodeOwner).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(dirty('node-identity')).toBe('false'));
    expect(longName().value).toBe('Bravo Node');
  });

  it('a failed save stays dirty, and Dismiss goes back to the node values', async () => {
    h.setNodeOwner.mockRejectedValue(new Error('radio said no'));
    await renderLoaded();

    fireEvent.change(longName(), { target: { value: 'Bravo Node' } });
    fireEvent.click(screen.getByTestId('save-node-identity'));

    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining('radio said no'), 'error'));
    expect(dirty('node-identity')).toBe('true');

    fireEvent.click(screen.getByTestId('dismiss-node-identity'));
    await waitFor(() => expect(longName().value).toBe('Alpha Node'));
    expect(dirty('node-identity')).toBe('false');
  });

  it('saving another section does not turn unsaved Device edits into the baseline', async () => {
    await renderLoaded();
    const led = screen.getByLabelText(/device_config\.led_heartbeat_disabled/) as HTMLInputElement;

    fireEvent.click(led);
    await waitFor(() => expect(dirty('device-config')).toBe('true'));

    // Save Node Identity: the page-wide isSaving goes true, then false.
    fireEvent.change(longName(), { target: { value: 'Bravo Node' } });
    fireEvent.click(screen.getByTestId('save-node-identity'));
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(expect.anything(), 'success'));

    // Device still holds an unsaved edit, and Dismiss reverts it.
    expect(dirty('device-config')).toBe('true');
    expect(h.setDeviceConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('dismiss-device-config'));
    await waitFor(() => expect(led.checked).toBe(false));
    expect(dirty('device-config')).toBe('false');
  });

  it('a failed Device save keeps the edit pending', async () => {
    h.setDeviceConfig.mockRejectedValue(new Error('timeout'));
    await renderLoaded();
    const led = screen.getByLabelText(/device_config\.led_heartbeat_disabled/) as HTMLInputElement;

    fireEvent.click(led);
    fireEvent.click(screen.getByTestId('save-device-config'));
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining('timeout'), 'error'));

    expect(dirty('device-config')).toBe('true');
    fireEvent.click(screen.getByTestId('dismiss-device-config'));
    await waitFor(() => expect(led.checked).toBe(false));
  });

  it('Reload config re-baselines to what the node reported', async () => {
    await renderLoaded();
    h.getCurrentConfig.mockResolvedValue({
      ...LOADED,
      localNodeInfo: { ...LOADED.localNodeInfo, longName: 'Renamed Elsewhere' },
      deviceConfig: { device: { ...LOADED.deviceConfig.device, ledHeartbeatDisabled: true } },
    });

    fireEvent.click(screen.getByText(/config\.reload_config/));
    await waitFor(() => expect(longName().value).toBe('Renamed Elsewhere'), { timeout: 5000 });

    expect(dirty('node-identity')).toBe('false');
    expect(dirty('device-config')).toBe('false');

    // Dismiss after a new edit goes back to the reloaded value, not the old one.
    fireEvent.change(longName(), { target: { value: 'Typo' } });
    fireEvent.click(screen.getByTestId('dismiss-node-identity'));
    await waitFor(() => expect(longName().value).toBe('Renamed Elsewhere'));
  });

  it('NeighborInfo: the interval raised to 14400 s on save is the new baseline', async () => {
    await renderLoaded();

    // Turning the module off hides the (out-of-range) interval field, so the
    // save is allowed and the handler raises 900 to 14400.
    fireEvent.click(document.getElementById('neighborInfoEnabled') as HTMLInputElement);
    await waitFor(() => expect(dirty('neighbor-info')).toBe('true'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-neighbor-info'));
    });

    await waitFor(() => expect(h.setNeighborInfoConfig).toHaveBeenCalledTimes(1));
    expect(h.setNeighborInfoConfig.mock.calls[0][0]).toMatchObject({ enabled: false, updateInterval: 14400 });
    await waitFor(() => expect(dirty('neighbor-info')).toBe('false'));
  });

  it('a save makes exactly one device write', async () => {
    await renderLoaded();

    fireEvent.change(longName(), { target: { value: 'Bravo Node' } });
    fireEvent.click(screen.getByTestId('save-node-identity'));
    await waitFor(() => expect(dirty('node-identity')).toBe('false'));

    // Re-baselining must never fire a save on its own.
    await new Promise(r => setTimeout(r, 50));
    expect(h.setNodeOwner).toHaveBeenCalledTimes(1);
    expect(h.setDeviceConfig).not.toHaveBeenCalled();
    expect(h.setNeighborInfoConfig).not.toHaveBeenCalled();
  });
});
