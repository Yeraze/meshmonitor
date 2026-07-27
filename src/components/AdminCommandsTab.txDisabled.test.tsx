/**
 * @vitest-environment jsdom
 *
 * TX-disabled Phase 2 WP4 (#4294): AdminCommandsTab must gate remote-node
 * admin while TX is disabled on the active source, while leaving local-node
 * admin (incl. the LoRa "Set" that re-enables TX) fully usable.
 *
 * Covered here:
 *  - remote node selected + TX off -> executeCommand's internal guard blocks
 *    the send (no /api/admin/commands call) and shows the remote-admin-notice
 *    toast; the notice banner renders; remote-target buttons render disabled
 *    with the explanatory title.
 *  - local node selected + TX off -> admin stays fully enabled (this is the
 *    path a user re-enables TX from).
 *  - the inline LoRa TX checkbox confirms only on the checked->unchecked
 *    transition (window.confirm), matching the LoRaConfigSection pattern.
 *  - a successful local `setLoRaConfig` save invalidates the ['txStatus']
 *    query so the banner/gating refresh without waiting for the 30s poll.
 *
 * DeviceConfigurationSection/ModuleConfigurationSection/AutoFavoriteManagementSection
 * are stubbed (separate files, out of WP4's scope) — the "remote node" test
 * exercises the executeCommand choke point through the stubbed device-save
 * callback specifically *because* that button's own disabled state lives in
 * a file WP4 doesn't touch, so its only protection is the internal guard.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  apiPost: vi.fn(),
  txStatus: { isTxDisabled: false },
}));

// --- mocks ---------------------------------------------------------------
// `t` MUST be a stable reference across renders: AdminCommandsTab's
// nodeOptionsMemo is a useMemo keyed on `t`, feeding an effect that calls
// setNodeOptions unconditionally -- a fresh `t` identity every render turns
// that into an infinite render loop (defined inline-per-call, as other
// txDisabled test files do, it hung the whole suite with no error).
vi.mock('react-i18next', () => {
  const t = (_key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : _key);
  return { useTranslation: () => ({ t }) };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: h.invalidateQueries,
  }),
}));

vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));

vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'source-1' }));

vi.mock('../hooks/useTxStatus', () => ({ useTxStatus: () => h.txStatus }));

vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    post: h.apiPost,
    exportChannel: vi.fn(),
    importChannel: vi.fn(),
    getAllChannels: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/ModuleConfigurationSection', () => ({ ModuleConfigurationSection: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));
// DeviceConfigurationSection lives in a separate file WP4 doesn't touch, so
// its own "Save" button has no visual remoteAdminBlocked gate — expose only
// the device-save callback so we can prove the executeCommand choke point
// (not a visual disabled attribute) is what actually blocks it.
vi.mock('./admin-commands/DeviceConfigurationSection', () => ({
  DeviceConfigurationSection: ({ onSaveDeviceConfig }: { onSaveDeviceConfig: () => void | Promise<void> }) => (
    <button data-testid="device-save" onClick={() => void onSaveDeviceConfig()}>Save Device Config</button>
  ),
}));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const REMOTE_NODE_ID = '!000000c8';
const localNode = { nodeNum: 100, user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' } };
const remoteNode = { nodeNum: 200, user: { id: REMOTE_NODE_ID, longName: 'Remote Node', shortName: 'REM1' } };

/** Force the relevant CollapsibleSections open so their buttons are in the DOM. */
function expandSections(ids: string[]) {
  const obj: Record<string, boolean> = {};
  ids.forEach((id) => { obj[id] = true; });
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify(obj));
}

/** Select the remote node via the target-node search dropdown. */
function selectRemoteNode() {
  const input = screen.getByPlaceholderText('Local Node');
  fireEvent.focus(input);
  fireEvent.click(screen.getByText('Remote Node'));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.txStatus.isTxDisabled = false;
  h.apiPost.mockResolvedValue({});
});

describe('AdminCommandsTab — remote-node admin gating while TX disabled (#4294)', () => {
  it('renders the remote-admin notice and disables remote-target buttons when a remote node is selected + TX is off', async () => {
    h.txStatus.isTxDisabled = true;
    expandSections(['admin-reboot-purge']);
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    selectRemoteNode();

    await waitFor(() => {
      expect(screen.getByText('tx_disabled.remote_admin_notice')).toBeInTheDocument();
    });

    const rebootButton = screen.getByText('admin_commands.reboot_device').closest('button');
    expect(rebootButton).toBeDisabled();
    expect(rebootButton).toHaveAttribute('title', 'tx_disabled.remote_admin_notice');

    const purgeButton = screen.getByText('admin_commands.purge_node_database').closest('button');
    expect(purgeButton).toBeDisabled();
    expect(purgeButton).toHaveAttribute('title', 'tx_disabled.remote_admin_notice');
  });

  it('executeCommand blocks the send with no network call and shows the notice toast when remote-node admin is blocked', async () => {
    h.txStatus.isTxDisabled = true;
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    selectRemoteNode();

    await waitFor(() => {
      expect(screen.getByText('tx_disabled.remote_admin_notice')).toBeInTheDocument();
    });

    // DeviceConfigurationSection's own save button isn't visually gated (it
    // lives in a different file) -- clicking it must still be blocked by
    // executeCommand's internal guard.
    fireEvent.click(screen.getByTestId('device-save'));

    await waitFor(() => {
      expect(h.showToast).toHaveBeenCalledWith('tx_disabled.remote_admin_notice', 'warning');
    });

    const commandCalls = h.apiPost.mock.calls.filter(([endpoint]) => endpoint === '/api/admin/commands');
    expect(commandCalls).toHaveLength(0);
  });

  it('leaves local-node admin fully enabled when TX is off (the path that re-enables TX)', () => {
    h.txStatus.isTxDisabled = true;
    expandSections(['radio-config', 'admin-lora-config', 'admin-reboot-purge']);
    render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    // No remote node exists in this render, so the local node stays selected.
    expect(screen.queryByText('tx_disabled.remote_admin_notice')).not.toBeInTheDocument();

    const saveLoRaButton = screen.getByText('admin_commands.save_lora_config').closest('button');
    expect(saveLoRaButton).not.toBeDisabled();

    const rebootButton = screen.getByText('admin_commands.reboot_device').closest('button');
    expect(rebootButton).not.toBeDisabled();
  });

  it('confirms before disabling TX via the inline checkbox, and commits when accepted', () => {
    expandSections(['radio-config', 'admin-lora-config']);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const checkbox = screen.getByRole('checkbox', { name: /admin_commands\.tx_enabled/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // useAdminCommandsState defaults txEnabled: true

    fireEvent.click(checkbox);

    expect(confirmSpy).toHaveBeenCalledWith('lora_config.tx_disable_confirm');
    expect(checkbox.checked).toBe(false);
  });

  it('does not disable TX via the inline checkbox when the confirm is cancelled', () => {
    expandSections(['radio-config', 'admin-lora-config']);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const checkbox = screen.getByRole('checkbox', { name: /admin_commands\.tx_enabled/i }) as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(confirmSpy).toHaveBeenCalledWith('lora_config.tx_disable_confirm');
    expect(checkbox.checked).toBe(true);
  });

  it('invalidates the txStatus query after a successful local LoRa config save', async () => {
    expandSections(['radio-config', 'admin-lora-config']);
    render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    fireEvent.click(screen.getByText('admin_commands.save_lora_config'));

    await waitFor(() => {
      expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['txStatus'] });
    });
  });
});
