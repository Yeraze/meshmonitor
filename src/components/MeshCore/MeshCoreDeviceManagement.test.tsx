/**
 * @vitest-environment jsdom
 *
 * Shared danger zone (#6255 P9 S5): capabilities decide the buttons; power-off
 * and key restore are admin-only and need the device name typed.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MeshCoreDeviceManagement } from './MeshCoreDeviceManagement';
import { companionCapabilities } from './deviceManagementCapabilities';

const KEY = 'ab'.repeat(64);
const REPEATER_CAPS = { reboot: true, powerOff: true, keyExport: true, keyImport: true, factoryReset: false };

function setup(over: Partial<React.ComponentProps<typeof MeshCoreDeviceManagement>> = {}) {
  const actions = {
    rebootDevice: vi.fn().mockResolvedValue(true),
    exportPrivateKey: vi.fn().mockResolvedValue(KEY),
    importPrivateKey: vi.fn().mockResolvedValue(true),
    factoryReset: vi.fn().mockResolvedValue(true),
    powerOffDevice: vi.fn().mockResolvedValue(true),
  };
  render(
    <MeshCoreDeviceManagement
      actions={actions}
      deviceName="Hill Repeater"
      publicKey="abcdef0123456789"
      capabilities={REPEATER_CAPS}
      isAdmin
      isCompanion={false}
      overNetwork={false}
      {...over}
    />,
  );
  return actions;
}

describe('MeshCoreDeviceManagement', () => {
  it('Repeater: no factory reset; reboot, power-off, backup and restore are there', () => {
    setup();
    expect(screen.getByTestId('meshcore-reboot-button')).toBeTruthy();
    expect(screen.getByTestId('meshcore-power-off-button')).toBeTruthy();
    expect(screen.getByTestId('meshcore-import-key-button')).toBeTruthy();
    expect(screen.getByText('meshcore.config.export_key_button')).toBeTruthy();
    expect(screen.queryByTestId('meshcore-factory-reset-button')).toBeNull();
  });

  it('hides power-off and restore from a non-admin', () => {
    setup({ isAdmin: false });
    expect(screen.queryByTestId('meshcore-power-off-button')).toBeNull();
    expect(screen.queryByTestId('meshcore-import-key-button')).toBeNull();
    expect(screen.getByTestId('meshcore-reboot-button')).toBeTruthy();
  });

  it('hides actions the firmware lacks', () => {
    setup({ capabilities: { ...REPEATER_CAPS, powerOff: false, keyImport: false, keyExport: false } });
    expect(screen.queryByTestId('meshcore-power-off-button')).toBeNull();
    expect(screen.queryByTestId('meshcore-import-key-button')).toBeNull();
    expect(screen.queryByText('meshcore.config.export_key_button')).toBeNull();
  });

  it('power-off sends only after the device name is typed', async () => {
    const actions = setup();
    fireEvent.click(screen.getByTestId('meshcore-power-off-button'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'device_actions.shutdown.confirm_label' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'hill repeater' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Hill Repeater' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(actions.powerOffDevice).toHaveBeenCalledWith({ confirm: true }));
  });

  it('key restore needs the device name, on a Repeater and a Companion', async () => {
    for (const isCompanion of [false, true]) {
      document.body.innerHTML = '';
      const actions = setup({ isCompanion, capabilities: isCompanion ? companionCapabilities(8) : REPEATER_CAPS });
      fireEvent.click(screen.getByTestId('meshcore-import-key-button'));
      fireEvent.change(screen.getByLabelText('meshcore.config.import_key_input'), { target: { value: KEY } });
      fireEvent.click(screen.getByText('meshcore.config.import_key_confirm_button'));
      const dialog = await screen.findByRole('dialog');
      const confirm = within(dialog).getByRole('button', { name: 'meshcore.config.import_key_confirm_button' }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'IMPORT' } });
      expect(confirm.disabled).toBe(true);
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Hill Repeater' } });
      fireEvent.click(confirm);
      await waitFor(() => expect(actions.importPrivateKey).toHaveBeenCalledWith(KEY, { confirm: true }));
    }
  });

  it('Companion power-off needs protocol 14 or later', () => {
    expect(companionCapabilities(13).powerOff).toBe(false);
    expect(companionCapabilities(14).powerOff).toBe(true);
    expect(companionCapabilities(undefined).powerOff).toBe(false);
  });

  it('shows the exported key only after Backup is pressed', async () => {
    const actions = setup();
    expect(screen.queryByText(KEY)).toBeNull();
    fireEvent.click(screen.getByText('meshcore.config.export_key_button'));
    expect(await screen.findByText(KEY)).toBeTruthy();
    expect(actions.exportPrivateKey).toHaveBeenCalled();
  });
});
