/**
 * @vitest-environment jsdom
 *
 * TX-disabled Phase 2 WP2 (#4294): after a successful LoRa config save,
 * ConfigurationTab must invalidate the ['txStatus'] query so the global banner
 * and every gated control refresh promptly instead of waiting for the 30s poll.
 *
 * All sibling *ConfigSection components are stubbed — this test exercises only
 * ConfigurationTab's own wiring (handleSaveLoRaConfig -> apiService.setLoRaConfig
 * -> queryClient.invalidateQueries), not the child sections' internals (those
 * have their own test files).
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

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
  default: ({ onSave }: { onSave: () => Promise<void> }) => (
    <button data-testid="lora-save" onClick={() => void onSave()}>Save LoRa</button>
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConfigurationTab — TX status freshness invalidation', () => {
  it('invalidates the txStatus query after a successful LoRa config save', async () => {
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    const saveButton = await screen.findByTestId('lora-save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['txStatus'] });
    });
  });
});
