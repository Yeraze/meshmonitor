/**
 * @vitest-environment jsdom
 *
 * #5919: "Reload Config on Device" re-reads every channel slot from the node,
 * and the server re-saves each one, but the channel list on the page comes
 * from the poll cache. With the WebSocket up that cache refetches only every
 * 30 s and no channel event is pushed, so a slot renamed on the radio kept its
 * stale "Channel N" name until the next poll. The reload must refetch the
 * source's poll query itself.
 *
 * All sibling *ConfigSection components are stubbed; this exercises only
 * ConfigurationTab's reload wiring.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  refreshNodes: vi.fn(),
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
  useSource: () => ({ sourceId: 'src-a', sourceName: 'test-source' }),
}));

vi.mock('../services/api', () => ({
  default: {
    getCurrentConfig: vi.fn().mockResolvedValue({}),
    getSecurityKeys: vi.fn().mockResolvedValue({}),
    refreshNodes: h.refreshNodes,
  },
}));

// Stub every sibling config section as a no-op.
vi.mock('./configuration/NodeIdentitySection', () => ({ default: () => null }));
vi.mock('./configuration/DeviceConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/LoRaConfigSection', () => ({ default: () => null }));
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
// Firmware update lives on this page since the #5683 follow-up; it needs an
// admin and OTA enabled, which this suite does not grant.
// ConfigurationTab.movedSections.test.tsx covers its placement.
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

beforeEach(() => {
  vi.clearAllMocks();
  h.refreshNodes.mockResolvedValue({ success: true });
});

describe('ConfigurationTab — Reload Config refreshes channels (#5919)', () => {
  it("refetches the source's poll query after asking the node to resend its config", async () => {
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: /reload_config/i }));

    await waitFor(() => {
      expect(h.refreshNodes).toHaveBeenCalledWith('src-a');
    });
    await waitFor(
      () => {
        expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['poll', 'src-a'] });
      },
      { timeout: 5000 },
    );
    // The refetch comes after the node was asked, never before it.
    expect(h.refreshNodes.mock.invocationCallOrder[0]).toBeLessThan(
      h.invalidateQueries.mock.invocationCallOrder[0],
    );
  });

  it('does not refetch the poll when the reload request fails', async () => {
    h.refreshNodes.mockRejectedValueOnce(new Error('not connected'));
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: /reload_config/i }));

    await waitFor(() => {
      expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining('not connected'), 'error');
    });
    expect(h.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['poll', 'src-a'] });
  });
});
