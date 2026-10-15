/**
 * @vitest-environment jsdom
 *
 * MeshCore danger zone (#5830): last on the page, reboot confirms in an
 * in-app dialog, key import needs a typed word, and window.confirm is never
 * used. useMeshCore sends `confirm: true` for the server's
 * DANGER_CONFIRM_REQUIRED check, so these dialogs are the only guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import type { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

const VALID_KEY = 'ab'.repeat(64);

function makeActions(overrides: Partial<MeshCoreActions> = {}): MeshCoreActions {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    setDeviceName: vi.fn().mockResolvedValue(true),
    setRadioParams: vi.fn().mockResolvedValue(true),
    setCoords: vi.fn().mockResolvedValue(true),
    setAdvertLocPolicy: vi.fn().mockResolvedValue(true),
    setTelemetryModeBase: vi.fn().mockResolvedValue(true),
    setTelemetryModeLoc: vi.fn().mockResolvedValue(true),
    setTelemetryModeEnv: vi.fn().mockResolvedValue(true),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    getDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    setDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    getDefaultScope: vi.fn().mockResolvedValue(''),
    setDefaultScope: vi.fn().mockResolvedValue(''),
    discoverRegions: vi.fn().mockResolvedValue(null),
    discoverNodes: vi.fn().mockResolvedValue(null),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
    addSavedRegion: vi.fn().mockResolvedValue(null),
    rebootDevice: vi.fn().mockResolvedValue(true),
    exportPrivateKey: vi.fn().mockResolvedValue(null),
    importPrivateKey: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as MeshCoreActions;
}

const status: ConnectionStatus = {
  connected: true,
  deviceType: 1,
  deviceTypeName: 'companion',
  config: null,
  localNode: {
    publicKey: 'pk',
    name: 'Radio One',
    advType: 1,
    telemetryModeBase: 'always',
    telemetryModeLoc: 'device',
    telemetryModeEnv: 'never',
  },
};

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

function openImport() {
  fireEvent.click(screen.getByText('meshcore.config.import_key_button'));
  fireEvent.change(screen.getByLabelText('meshcore.config.import_key_input'), {
    target: { value: VALID_KEY },
  });
  fireEvent.click(screen.getByText('meshcore.config.import_key_confirm_button'));
}

describe('MeshCore danger zone (#5830)', () => {
  it('is the last section on the page', () => {
    const { container } = render(<MeshCoreConfigurationView status={status} actions={makeActions()} />);
    const zone = document.getElementById('meshcore-device-management');
    expect(zone).toBeTruthy();
    const headers = container.querySelectorAll('.automation-section-header');
    expect(headers[headers.length - 1]).toBe(zone);
  });

  it('reboot opens an in-app dialog and sends only on Confirm', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status} actions={actions} />);
    fireEvent.click(screen.getByTestId('meshcore-reboot-button'));
    const dialog = await screen.findByRole('dialog');
    expect(actions.rebootDevice).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText('meshcore.config.reboot_button'));
    await waitFor(() => expect(actions.rebootDevice).toHaveBeenCalledWith({ confirm: true }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the reboot dialog sends nothing', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status} actions={actions} />);
    fireEvent.click(screen.getByTestId('meshcore-reboot-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(actions.rebootDevice).not.toHaveBeenCalled();
  });

  it('key import needs the typed word before it sends', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status} actions={actions} />);
    openImport();
    const dialog = await screen.findByRole('dialog');
    expect(actions.importPrivateKey).not.toHaveBeenCalled();

    const confirm = within(dialog).getByRole('button', { name: 'meshcore.config.import_key_confirm_button' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'import' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(actions.importPrivateKey).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'IMPORT' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(actions.importPrivateKey).toHaveBeenCalledWith(VALID_KEY, { confirm: true }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the key import dialog sends nothing', async () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status} actions={actions} />);
    openImport();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(actions.importPrivateKey).not.toHaveBeenCalled();
  });

  it('an invalid key never reaches the dialog', () => {
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={status} actions={actions} />);
    fireEvent.click(screen.getByText('meshcore.config.import_key_button'));
    fireEvent.change(screen.getByLabelText('meshcore.config.import_key_input'), {
      target: { value: 'nothex' },
    });
    fireEvent.click(screen.getByText('meshcore.config.import_key_confirm_button'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('meshcore.config.import_key_invalid');
    expect(actions.importPrivateKey).not.toHaveBeenCalled();
  });
});
