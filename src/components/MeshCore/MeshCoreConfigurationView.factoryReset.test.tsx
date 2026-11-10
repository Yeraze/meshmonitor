/**
 * @vitest-environment jsdom
 *
 * MeshCore factory reset (P8a #6257): admin only, connected Companion with
 * firmware >= 7, typed device name before it sends.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

let admin = true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: () => true,
    authStatus: { authenticated: true, user: { isAdmin: admin } },
  }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import type { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

const makeActions = (): MeshCoreActions => ({
  getDefaultPathHashSize: vi.fn().mockResolvedValue(1),
  getDefaultScope: vi.fn().mockResolvedValue(''),
  getSenderNamePolicy: vi.fn().mockResolvedValue({ enabled: false, allowedNames: [] }), setSenderNamePolicy: vi.fn(),
  fetchSavedRegions: vi.fn().mockResolvedValue([]),
  getBlePin: vi.fn().mockResolvedValue(0),
  setBlePin: vi.fn().mockResolvedValue(true),
  setMultiAcks: vi.fn().mockResolvedValue(true),
  factoryReset: vi.fn().mockResolvedValue(true),
  exportPrivateKey: vi.fn().mockResolvedValue(null),
  clearError: vi.fn(),
}) as unknown as MeshCoreActions;

const mk = (over: Partial<ConnectionStatus> = {}, node: Record<string, unknown> = {}): ConnectionStatus => ({
  connected: true,
  deviceType: 1,
  deviceTypeName: 'companion',
  config: { connectionType: 'serial' },
  localNode: { publicKey: 'abcdef0123456789', name: 'Radio One', advType: 1, firmwareVer: 7, ...node },
  ...over,
}) as ConnectionStatus;

describe('MeshCore factory reset', () => {
  it('is hidden for a non-admin', () => {
    admin = false;
    render(<MeshCoreConfigurationView status={mk()} actions={makeActions()} />);
    expect(screen.queryByTestId('meshcore-factory-reset-button')).toBeNull();
  });

  it('is disabled with a reason on firmware before v7', () => {
    admin = true;
    render(<MeshCoreConfigurationView status={mk({}, { firmwareVer: 6 })} actions={makeActions()} />);
    const btn = screen.getByTestId('meshcore-factory-reset-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('meshcore.factory_reset.blocked_firmware');
  });

  it('is absent when disconnected (the danger zone needs a connection)', () => {
    admin = true;
    render(<MeshCoreConfigurationView status={mk({ connected: false })} actions={makeActions()} />);
    expect(screen.queryByTestId('meshcore-factory-reset-button')).toBeNull();
  });

  it('needs the typed device name, then sends confirm:true', async () => {
    admin = true;
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={mk()} actions={actions} />);
    fireEvent.click(screen.getByTestId('meshcore-factory-reset-button'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('device_actions.reset_wipes_heading')).toBeTruthy();
    for (const k of ['settings', 'channels', 'network', 'identity']) {
      expect(within(dialog).getByText(`device_actions.reset_wipes_${k}`)).toBeTruthy();
    }
    expect(within(dialog).getByText('meshcore.factory_reset.wipes_contacts')).toBeTruthy();
    expect(within(dialog).queryByText('meshcore.factory_reset.network_warning')).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'meshcore.factory_reset.confirm_label' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'wrong' } });
    expect(confirm.disabled).toBe(true);
    expect(actions.factoryReset).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Radio One' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(actions.factoryReset).toHaveBeenCalledWith({ confirm: true }));
  });

  it('uses a public-key prefix when the name is empty, and warns on TCP', async () => {
    admin = true;
    const actions = makeActions();
    render(
      <MeshCoreConfigurationView
        status={mk({ config: { connectionType: 'tcp', tcpHost: '10.0.0.5' } }, { name: '' })}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId('meshcore-factory-reset-button'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('meshcore.factory_reset.network_warning')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'abcdef01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'meshcore.factory_reset.confirm_label' }));
    await waitFor(() => expect(actions.factoryReset).toHaveBeenCalled());
  });

  it('the back-up link runs the private-key export', async () => {
    admin = true;
    const actions = makeActions();
    render(<MeshCoreConfigurationView status={mk()} actions={actions} />);
    fireEvent.click(screen.getByTestId('meshcore-factory-reset-button'));
    fireEvent.click(await screen.findByTestId('meshcore-factory-reset-backup'));
    await waitFor(() => expect(actions.exportPrivateKey).toHaveBeenCalled());
    expect(actions.factoryReset).not.toHaveBeenCalled();
  });
});
