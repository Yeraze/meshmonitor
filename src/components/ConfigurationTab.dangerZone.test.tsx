/**
 * @vitest-environment jsdom
 *
 * Device Configuration danger zone (#5830): reboot and purge sit last on the
 * page, confirm in in-app dialogs (purge needs a typed word), never through
 * window.confirm, and the whole page is read-only without configuration:write
 * on this source.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  getCurrentConfig: vi.fn(),
  rebootDevice: vi.fn(),
  purgeNodeDb: vi.fn(),
  canWrite: true,
  isAdmin: true,
  hasPermission: vi.fn(),
  sectionCanWrite: [] as Array<boolean | undefined>,
}));

// Each section is a probe that records the canWrite it was handed; how a
// section renders under canWrite={false} is ConfigSection's fieldset, tested
// in ConfigSection.test.tsx.
const { probe } = vi.hoisted(() => ({
  probe: (p: { canWrite?: boolean }) => {
    h.sectionCanWrite.push(p.canWrite);
    return null;
  },
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
    rebootDevice: h.rebootDevice,
    purgeNodeDb: h.purgeNodeDb,
  },
}));

vi.mock('./configuration/NodeIdentitySection', () => ({ default: probe }));
vi.mock('./configuration/DeviceConfigSection', () => ({ default: probe }));
vi.mock('./configuration/LoRaConfigSection', () => ({ default: probe }));
vi.mock('./configuration/PositionConfigSection', () => ({ default: probe }));
vi.mock('./configuration/MQTTConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/NeighborInfoSection', () => ({ default: probe }));
vi.mock('./configuration/NetworkConfigSection', () => ({ default: probe }));
vi.mock('./configuration/PowerConfigSection', () => ({ default: probe }));
vi.mock('./configuration/DisplayConfigSection', () => ({ default: probe }));
vi.mock('./configuration/TelemetryConfigSection', () => ({ default: probe }));
vi.mock('./configuration/ExternalNotificationConfigSection', () => ({ default: probe }));
vi.mock('./configuration/StoreForwardConfigSection', () => ({ default: probe }));
vi.mock('./configuration/RangeTestConfigSection', () => ({ default: probe }));
vi.mock('./configuration/CannedMessageConfigSection', () => ({ default: probe }));
vi.mock('./configuration/AudioConfigSection', () => ({ default: probe }));
vi.mock('./configuration/RemoteHardwareConfigSection', () => ({ default: probe }));
vi.mock('./configuration/DetectionSensorConfigSection', () => ({ default: probe }));
vi.mock('./configuration/PaxcounterConfigSection', () => ({ default: probe }));
vi.mock('./configuration/StatusMessageConfigSection', () => ({ default: probe }));
vi.mock('./configuration/StatusMessageReapplyOption', () => ({ default: () => null }));
vi.mock('./configuration/TrafficManagementConfigSection', () => ({ default: probe }));
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: probe }));
vi.mock('./configuration/TAKConfigSection', () => ({ default: probe }));
vi.mock('./configuration/SerialConfigSection', () => ({ default: probe }));
vi.mock('./configuration/AmbientLightingConfigSection', () => ({ default: probe }));
vi.mock('./configuration/SecurityConfigSection', () => ({ default: probe }));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({ default: () => null }));
vi.mock('./configuration/FirmwareUpdateSection', () => ({ default: () => null }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { user: { isAdmin: h.isAdmin } }, hasPermission: h.hasPermission }),
}));
vi.mock('../hooks/useHealth', () => ({ useHealth: () => ({ data: undefined }) }));
vi.mock('./configuration/ChannelsConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/GpioPinSummary', () => ({ default: () => null }));
vi.mock('./configuration/BackupManagementSection', () => ({
  default: () => <div data-testid="backup-probe" />,
}));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./SectionNav', () => ({ default: () => null }));

import ConfigurationTab from './ConfigurationTab';

let confirmSpy: ReturnType<typeof vi.spyOn>;

async function renderTab() {
  h.getCurrentConfig.mockResolvedValue({
    localNodeInfo: { longName: 'Node', shortName: 'N', firmwareVersion: '2.7.9' },
    deviceConfig: { lora: { usePreset: true, modemPreset: 0, region: 1, hopLimit: 3 } },
    moduleConfig: {},
  });
  render(<ConfigurationTab nodes={[]} channels={[]} />);
  await waitFor(() => expect(screen.getByTestId('danger-zone')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  h.canWrite = true;
  h.isAdmin = true;
  h.sectionCanWrite = [];
  h.hasPermission.mockImplementation((resource: string, action: string) =>
    resource === 'configuration' && action === 'write' ? h.canWrite : true,
  );
  h.rebootDevice.mockResolvedValue({ success: true });
  h.purgeNodeDb.mockResolvedValue({ success: true });
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe('ConfigurationTab danger zone (#5830)', () => {
  it('renders the danger zone last, after every other section', async () => {
    await renderTab();
    const danger = document.getElementById('config-danger');
    expect(danger).toBeTruthy();
    const backup = screen.getByTestId('backup-probe');
    expect(backup.compareDocumentPosition(danger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const ids = Array.from(document.querySelectorAll('[id^="config-"]')).map((el) => el.id);
    expect(ids[ids.length - 1]).toBe('config-danger');
    // Reload config stays at the top, ahead of the sections.
    expect(ids[0]).toBe('config-import-export');
    expect(screen.getByText('config.reload_config')).toBeTruthy();
  });

  it('reboot opens an in-app dialog and sends only on Confirm', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('config-reboot-button'));
    const dialog = await screen.findByRole('dialog');
    expect(h.rebootDevice).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText('config.reboot_device'));
    await waitFor(() => expect(h.rebootDevice).toHaveBeenCalledTimes(1));
    expect(h.rebootDevice).toHaveBeenCalledWith(5, 'source-1');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the reboot dialog sends nothing', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('config-reboot-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.rebootDevice).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('purge needs the typed word before it sends', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('config-purge-button'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /config\.purge_node_db/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'purge' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(h.purgeNodeDb).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'PURGE' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.purgeNodeDb).toHaveBeenCalledWith(0, 'source-1'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the purge dialog sends nothing', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('config-purge-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.purgeNodeDb).not.toHaveBeenCalled();
  });

  it('links to Admin Commands for shutdown and factory reset', async () => {
    await renderTab();
    const note = screen.getByTestId('danger-admin-commands-link');
    const link = within(note).getByRole('link');
    expect(link.getAttribute('href')).toBe('/source/source-1/admin');
  });

  it('hides the Admin Commands link from a non-admin, who cannot open that page', async () => {
    h.isAdmin = false;
    await renderTab();
    expect(screen.queryByTestId('danger-admin-commands-link')).toBeNull();
  });

  it('checks configuration:write on this source', async () => {
    await renderTab();
    expect(h.hasPermission).toHaveBeenCalledWith('configuration', 'write', { sourceId: 'source-1' });
  });

  it('with configuration:write, every section is writable', async () => {
    await renderTab();
    expect(h.sectionCanWrite.length).toBeGreaterThan(0);
    expect(h.sectionCanWrite.every((v) => v === true)).toBe(true);
  });

  it('without configuration:write, sections, import and danger buttons are disabled', async () => {
    h.canWrite = false;
    await renderTab();
    expect(h.sectionCanWrite.length).toBeGreaterThan(0);
    expect(h.sectionCanWrite.every((v) => v === false)).toBe(true);
    expect((screen.getByTestId('config-reboot-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('config-purge-button') as HTMLButtonElement).disabled).toBe(true);
    const importButton = screen.getByText('config.import_config').closest('button') as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    // Read-only actions stay usable.
    const exportButton = screen.getByText('config.export_config').closest('button') as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    const reloadButton = screen.getByText('config.reload_config').closest('button') as HTMLButtonElement;
    expect(reloadButton.disabled).toBe(false);

    fireEvent.click(screen.getByTestId('config-reboot-button'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.rebootDevice).not.toHaveBeenCalled();
  });
});
