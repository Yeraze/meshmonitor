/**
 * @vitest-environment jsdom
 *
 * A connected Repeater on the config page (#6255 P9): the settings form
 * mounts, the advert-location checkbox is gone, the danger zone shows the
 * Repeater capabilities, and an admin-password change raises the stale
 * credentials hint.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: () => true,
    authStatus: { authenticated: true, user: { isAdmin: true } },
  }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import type { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

const SNAPSHOT = {
  values: { advertInterval: 120, floodAdvertInterval: 24, floodMax: 8, repeat: true, af: 1, rxDelay: 0, txDelay: 0.5, directTxDelay: 0.3, allowReadOnly: false },
  guestPasswordSet: false,
  capabilities: { reboot: true, powerOff: false, keyExport: true, keyImport: true, factoryReset: false },
  firmware: { version: 'v1.14.0' },
};

function makeActions(over: Partial<MeshCoreActions> = {}): MeshCoreActions {
  return {
    getRepeaterSettings: vi.fn().mockResolvedValue(SNAPSHOT),
    saveRepeaterSettings: vi.fn().mockResolvedValue({ results: { adminPassword: { ok: true, changed: true } }, drifted: false }),
    syncDeviceTime: vi.fn().mockResolvedValue(true),
    rebootDevice: vi.fn().mockResolvedValue(true),
    exportPrivateKey: vi.fn().mockResolvedValue(null),
    importPrivateKey: vi.fn().mockResolvedValue(true),
    factoryReset: vi.fn().mockResolvedValue(true),
    clearError: vi.fn(),
    ...over,
  } as unknown as MeshCoreActions;
}

const status = (connected = true): ConnectionStatus => ({
  connected,
  deviceType: 2,
  deviceTypeName: 'repeater',
  config: null,
  localNode: { publicKey: 'pk', name: 'Hill', advType: 2, radioSf: 10, radioBw: 250, radioCr: 5, ver: 'v1.14.0' },
}) as ConnectionStatus;

describe('MeshCoreConfigurationView on a Repeater', () => {
  it('mounts the form, hides the advert-location checkbox, shows the Repeater danger zone', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status()} actions={actions} />);
    expect(await screen.findByTestId('repeater-save')).toBeTruthy();
    expect(actions.getRepeaterSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('meshcore.config.advert_loc_policy')).toBeNull();
    expect(screen.getByTestId('meshcore-reboot-button')).toBeTruthy();
    expect(screen.getByTestId('meshcore-import-key-button')).toBeTruthy();
    expect(screen.queryByTestId('meshcore-power-off-button')).toBeNull(); // fw 1.14: capability off
    expect(screen.queryByTestId('meshcore-factory-reset-button')).toBeNull();
  });

  it('reads nothing while disconnected', () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status(false)} actions={actions} />);
    expect(actions.getRepeaterSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('repeater-save')).toBeNull();
  });

  it('Sync clock calls syncDeviceTime', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status()} actions={actions} />);
    fireEvent.click(await screen.findByTestId('repeater-sync-clock'));
    await waitFor(() => expect(actions.syncDeviceTime).toHaveBeenCalled());
  });

  it('raises the stale remote-admin credentials hint after an admin password change', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status()} actions={actions} />);
    await screen.findByTestId('repeater-save');
    expect(screen.queryByTestId('repeater-stale-credentials')).toBeNull();
    fireEvent.change(document.getElementById('mc-rep-admin-password')!, { target: { value: 'newpass' } });
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(actions.saveRepeaterSettings).toHaveBeenCalledWith({ adminPassword: 'newpass' }));
    expect(await screen.findByTestId('repeater-stale-credentials')).toBeTruthy();
    // The settings are re-read after a save.
    await waitFor(() => expect(actions.getRepeaterSettings).toHaveBeenCalledTimes(2));
  });
});
