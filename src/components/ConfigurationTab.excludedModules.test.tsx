/**
 * @vitest-environment jsdom
 *
 * Excluded-module gating across a config reload (#5065).
 *
 * `supportedModules` comes from the connected device, so one device's
 * exclusions must never gate another's sections. A reload whose response
 * carries no `supportedModules` has to clear the previous value rather than
 * keep it, because unknown means "fail open, show everything".
 *
 * Sibling *ConfigSection components are stubbed — this exercises only
 * ConfigurationTab's own wiring.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  currentConfig: {} as Record<string, unknown>,
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
    getCurrentConfig: vi.fn(() => Promise.resolve(h.currentConfig)),
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
vi.mock('./configuration/PaxcounterConfigSection', () => ({
  default: () => <div data-testid="paxcounter-controls" />,
}));
vi.mock('./configuration/StatusMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TrafficManagementConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: () => null }));
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

const NOTICE = /not included in this device's firmware build/;

beforeEach(() => {
  vi.clearAllMocks();
  h.currentConfig = {};
});

describe('ConfigurationTab — excluded module gating (#5065)', () => {
  it('leaves every section enabled when the device reports no bitmask', async () => {
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    expect(await screen.findByTestId('paxcounter-controls')).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('notices the section the device excluded, without hiding it', async () => {
    h.currentConfig = { supportedModules: { paxcounter: false, mqtt: true } };
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId('paxcounter-controls')).toBeInTheDocument();
  });

});
