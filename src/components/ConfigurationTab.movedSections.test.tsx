/**
 * @vitest-environment jsdom
 *
 * Where ConfigurationTab (Meshtastic Device Configuration) puts the sections
 * the #5683 follow-up moved:
 *
 *   Firmware update   moved IN from Settings. Same gate (an admin, OTA
 *                     enabled). It must stay mounted while the device config
 *                     reloads: an update reboots the node, and the section
 *                     holds the running update's wizard.
 *   PKI DM decryption moved OUT to Settings. A pointer stays on the old
 *                     anchor. A viewer who cannot open Settings keeps the
 *                     section here, since its routes check `configuration`.
 *   Backup            stays (the maintainer's call: backups OF the device).
 *
 * All sibling config sections are stubbed, as in
 * ConfigurationTab.txDisabled.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  isAdmin: true,
  firmwareOtaEnabled: true as boolean | undefined,
  grants: new Set<string>(),
  firmwareMounts: 0,
  firmwareUnmounts: 0,
  pkiProps: [] as unknown[],
  navItems: [] as Array<{ id: string }>,
  getCurrentConfig: null as unknown as () => Promise<unknown>,
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
    getCurrentConfig: () => h.getCurrentConfig(),
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
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TAKConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SerialConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AmbientLightingConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SecurityConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({
  default: (props: Record<string, unknown>) => {
    h.pkiProps.push(props);
    return <div data-testid="pki-dm-section" />;
  },
}));
// A marker that counts its mounts: the real section holds a running update's
// wizard, so it must not be unmounted while the config reloads.
vi.mock('./configuration/FirmwareUpdateSection', async () => {
  const { useEffect } = await import('react');
  const FirmwareMarker = ({ baseUrl, sectionId }: { baseUrl: string; sectionId?: string }) => {
    useEffect(() => {
      h.firmwareMounts += 1;
      return () => { h.firmwareUnmounts += 1; };
    }, []);
    return <div data-testid="firmware-update-section" data-base-url={baseUrl} data-section-id={sectionId ?? 'default'} />;
  };
  return { default: FirmwareMarker };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { user: { isAdmin: h.isAdmin } },
    hasPermission: (resource: string, action: string) => h.grants.has(`${resource}:${action}`),
  }),
}));
vi.mock('../hooks/useHealth', () => ({
  useHealth: () => ({ data: h.firmwareOtaEnabled === undefined ? undefined : { firmwareOtaEnabled: h.firmwareOtaEnabled } }),
}));
vi.mock('./configuration/ChannelsConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/GpioPinSummary', () => ({ default: () => null }));
vi.mock('./configuration/BackupManagementSection', () => ({ default: () => <div data-testid="backup-section" /> }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./SectionNav', () => ({
  default: ({ items }: { items: Array<{ id: string }> }) => {
    h.navItems = items;
    return <nav data-testid="section-nav" />;
  },
}));

import ConfigurationTab from './ConfigurationTab';

const ALL = ['settings:read', 'configuration:read', 'configuration:write'];

function renderTab(refreshTrigger = 0) {
  const ui = (trigger: number) => (
    <MemoryRouter>
      <ConfigurationTab baseUrl="/mm" nodes={[]} channels={[]} refreshTrigger={trigger} />
    </MemoryRouter>
  );
  const view = render(ui(refreshTrigger));
  return { ...view, reload: (trigger: number) => view.rerender(ui(trigger)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAdmin = true;
  h.firmwareOtaEnabled = true;
  h.grants = new Set(ALL);
  h.firmwareMounts = 0;
  h.firmwareUnmounts = 0;
  h.pkiProps = [];
  h.navItems = [];
  h.getCurrentConfig = () => Promise.resolve({});
});

describe('ConfigurationTab: Firmware update moved in from Settings', () => {
  it('renders the section for an admin with OTA enabled, with a nav chip', async () => {
    renderTab();
    await screen.findByTestId('backup-section');
    const section = screen.getByTestId('firmware-update-section');
    expect(section.getAttribute('data-base-url')).toBe('/mm');
    // The section's own default anchor is the one the nav chip names.
    expect(section.getAttribute('data-section-id')).toBe('default');
    expect(h.navItems.map((item) => item.id)).toContain('config-firmware');
  });

  it('places it after Backup, in the page, not in the danger box at the top', async () => {
    renderTab();
    const backup = await screen.findByTestId('backup-section');
    const firmware = screen.getByTestId('firmware-update-section');
    expect(backup.compareDocumentPosition(firmware) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firmware.closest('.danger-zone')).toBeNull();
  });

  it('is absent for a non-admin, as it was on Settings', async () => {
    h.isAdmin = false;
    renderTab();
    await screen.findByTestId('backup-section');
    expect(screen.queryByTestId('firmware-update-section')).toBeNull();
    expect(h.navItems.map((item) => item.id)).not.toContain('config-firmware');
  });

  it.each([false, undefined])('is absent when OTA is %s, as it was on Settings', async (ota) => {
    h.firmwareOtaEnabled = ota;
    renderTab();
    await screen.findByTestId('backup-section');
    expect(screen.queryByTestId('firmware-update-section')).toBeNull();
    expect(h.navItems.map((item) => item.id)).not.toContain('config-firmware');
  });

  it('is on the page while the config is still loading', () => {
    h.getCurrentConfig = () => new Promise(() => {});
    renderTab();
    expect(screen.getByText('config.loading')).toBeInTheDocument();
    expect(screen.queryByTestId('backup-section')).toBeNull();
    expect(screen.getByTestId('firmware-update-section')).toBeInTheDocument();
  });

  it('stays mounted through a config reload: a running update keeps its wizard', async () => {
    let finishReload: (value: unknown) => void = () => {};
    const view = renderTab(0);
    await screen.findByTestId('backup-section');
    expect(h.firmwareMounts).toBe(1);

    // An OTA update reboots the node; App bumps refreshTrigger on reconnect.
    h.getCurrentConfig = () => new Promise((resolve) => { finishReload = resolve; });
    view.reload(1);
    await waitFor(() => expect(screen.getByText('config.loading')).toBeInTheDocument());
    expect(screen.getByTestId('firmware-update-section')).toBeInTheDocument();
    expect(h.firmwareUnmounts).toBe(0);

    finishReload({});
    await screen.findByTestId('backup-section');
    expect(h.firmwareMounts).toBe(1);
    expect(h.firmwareUnmounts).toBe(0);
  });
});

describe('ConfigurationTab: PKI DM decryption moved out to Settings', () => {
  it('leaves a pointer on the old anchor, linked to the Settings section', async () => {
    renderTab();
    const note = await screen.findByTestId('pki-dm-moved');
    expect(note.id).toBe('config-pki-dm');
    expect(note).toHaveTextContent('PKI direct message decryption moved to Settings.');
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href'))
      .toBe('/source/1/settings#settings-pki-dm');
    expect(screen.queryByTestId('pki-dm-section')).toBeNull();
  });

  it('keeps the section here for a viewer who cannot open Settings', async () => {
    h.grants = new Set(['configuration:read', 'configuration:write']);
    renderTab();
    await screen.findByTestId('backup-section');
    expect(screen.getByTestId('pki-dm-section')).toBeInTheDocument();
    expect(h.pkiProps.at(-1)).toMatchObject({ canWrite: true });
    expect(screen.queryByTestId('pki-dm-moved')).toBeNull();
  });

  it('there too the switch needs configuration:write', async () => {
    h.grants = new Set(['configuration:read']);
    renderTab();
    await screen.findByTestId('backup-section');
    expect(h.pkiProps.at(-1)).toMatchObject({ canWrite: false });
  });
});

describe('ConfigurationTab: Backup stays', () => {
  it('keeps the backup list and schedule on Device Configuration', async () => {
    renderTab();
    expect(await screen.findByTestId('backup-section')).toBeInTheDocument();
    expect(h.navItems.map((item) => item.id)).toContain('config-backup');
  });
});
