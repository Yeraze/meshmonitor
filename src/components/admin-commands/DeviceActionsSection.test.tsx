/**
 * @vitest-environment jsdom
 *
 * Shutdown, DFU and factory reset buttons (#5614, #5615): each button's
 * gating, its confirm (plain or typed) and what it sends.
 *
 * `t` returns the locale key in tests, so assertions use keys and test ids.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeviceActionsSection, type DeviceActionsNode, type DeviceActionsSectionProps } from './DeviceActionsSection';

const LOCAL: DeviceActionsNode = { nodeNum: 1, nodeId: '!00000001', shortName: 'BASE', isLocal: true };
const REMOTE: DeviceActionsNode = { nodeNum: 999, nodeId: '!000003e7', shortName: 'HILL', isLocal: false };

function setup(props: Partial<DeviceActionsSectionProps> = {}) {
  const executeCommand = vi.fn().mockResolvedValue({ success: true });
  const utils = render(
    <DeviceActionsSection
      node={LOCAL}
      canShutdown={null}
      disabled={false}
      executeCommand={executeCommand}
      {...props}
    />,
  );
  return { executeCommand, user: userEvent.setup(), ...utils };
}

const button = (id: string) => screen.getByTestId(`device-action-${id}`);
const dialog = () => screen.getByRole('dialog');
const confirmButton = (key: string) =>
  within(dialog()).getByRole('button', { name: `device_actions.${key}.confirm_label` });

describe('DeviceActionsSection', () => {
  describe('layout', () => {
    it('shows all four actions in their own group, each with its note', () => {
      setup();
      const group = screen.getByTestId('device-actions');
      for (const id of ['shutdown', 'enterDfuMode', 'factoryResetConfig', 'factoryResetDevice']) {
        expect(within(group).getByTestId(`device-action-${id}`)).toBeInTheDocument();
      }
      // The DFU hardware warning sits next to the button, always.
      expect(screen.getByText('device_actions.dfu.note')).toBeInTheDocument();
      expect(screen.getByText('device_actions.reset_config.button')).toBeInTheDocument();
      expect(screen.getByText('device_actions.reset_device.button')).toBeInTheDocument();
    });

    it('opens no dialog and sends nothing until a button is pressed', () => {
      const { executeCommand } = setup();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('gating', () => {
    it('local node: every action is enabled', () => {
      setup();
      for (const id of ['shutdown', 'enterDfuMode', 'factoryResetConfig', 'factoryResetDevice']) {
        expect(button(id)).toBeEnabled();
      }
    });

    it('remote node: DFU and both resets are disabled with a note; shutdown stays enabled', () => {
      setup({ node: REMOTE });
      expect(button('shutdown')).toBeEnabled();
      for (const id of ['enterDfuMode', 'factoryResetConfig', 'factoryResetDevice']) {
        expect(button(id)).toBeDisabled();
        expect(screen.getByTestId(`device-action-${id}-blocked`)).toHaveTextContent('device_actions.local_only_note');
      }
    });

    it('canShutdown false: shutdown is disabled with a note', () => {
      setup({ canShutdown: false });
      expect(button('shutdown')).toBeDisabled();
      expect(screen.getByTestId('device-action-shutdown-blocked')).toHaveTextContent(
        'device_actions.shutdown.cannot_note',
      );
      // The rest do not depend on it.
      expect(button('enterDfuMode')).toBeEnabled();
    });

    it.each([[true], [null]])('canShutdown %s: shutdown is enabled with no blocked note', (canShutdown) => {
      setup({ canShutdown });
      expect(button('shutdown')).toBeEnabled();
      expect(screen.queryByTestId('device-action-shutdown-blocked')).not.toBeInTheDocument();
    });

    it('disabled (busy or remote admin off): every action is disabled with the reason as a tooltip', () => {
      setup({ disabled: true, disabledReason: 'TX is off' });
      for (const id of ['shutdown', 'enterDfuMode', 'factoryResetConfig', 'factoryResetDevice']) {
        expect(button(id)).toBeDisabled();
        expect(button(id)).toHaveAttribute('title', 'TX is off');
      }
    });

    it('no node selected: every action is disabled', () => {
      setup({ node: null });
      for (const id of ['shutdown', 'enterDfuMode', 'factoryResetConfig', 'factoryResetDevice']) {
        expect(button(id)).toBeDisabled();
      }
    });
  });

  describe('DFU', () => {
    it('plain confirm: no typed word, sends enterDfuMode once, then says what to expect', async () => {
      const { executeCommand, user } = setup();
      await user.click(button('enterDfuMode'));

      expect(within(dialog()).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(dialog()).getByText('device_actions.dfu.confirm_body')).toBeInTheDocument();
      expect(executeCommand).not.toHaveBeenCalled();

      await user.click(confirmButton('dfu'));
      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(executeCommand).toHaveBeenCalledWith('enterDfuMode', {});
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('device-action-sent')).toHaveTextContent('device_actions.dfu.sent_local');
    });

    it('cancel sends nothing', async () => {
      const { executeCommand, user } = setup();
      await user.click(button('enterDfuMode'));
      await user.click(within(dialog()).getByRole('button', { name: 'common.cancel' }));

      expect(executeCommand).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByTestId('device-action-sent')).not.toBeInTheDocument();
    });
  });

  describe.each([
    ['factoryResetConfig', 'reset_config', false],
    ['factoryResetDevice', 'reset_device', true],
  ] as const)('%s', (command, key, wipesIdentity) => {
    it('says what is wiped, what survives, and that a WiFi/TCP node drops off', async () => {
      const { user } = setup();
      await user.click(button(command));

      const d = within(dialog());
      expect(d.getByText('device_actions.reset_wipes_settings')).toBeInTheDocument();
      expect(d.getByText('device_actions.reset_wipes_channels')).toBeInTheDocument();
      expect(d.getByText('device_actions.reset_wipes_nodedb')).toBeInTheDocument();
      expect(d.getByText('device_actions.reset_wipes_network')).toBeInTheDocument();
      expect(d.getByText(`device_actions.${key}.keeps`)).toBeInTheDocument();
      expect(d.getByText('device_actions.reset_drop_warning')).toBeInTheDocument();
      expect(d.queryByText('device_actions.reset_wipes_identity') !== null).toBe(wipesIdentity);
    });

    it('needs the short name typed before it sends', async () => {
      const { executeCommand, user } = setup();
      await user.click(button(command));

      expect(confirmButton(key)).toBeDisabled();
      await user.type(within(dialog()).getByRole('textbox'), 'WRONG');
      expect(confirmButton(key)).toBeDisabled();
      expect(executeCommand).not.toHaveBeenCalled();

      await user.clear(within(dialog()).getByRole('textbox'));
      await user.type(within(dialog()).getByRole('textbox'), 'BASE');
      await user.click(confirmButton(key));

      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(executeCommand).toHaveBeenCalledWith(command, {});
      expect(screen.getByTestId('device-action-sent')).toHaveTextContent(`device_actions.${key}.sent_local`);
    });
  });

  describe('shutdown', () => {
    it('local node: plain confirm, sends shutdown with the delay', async () => {
      const { executeCommand, user } = setup();
      await user.click(button('shutdown'));

      expect(within(dialog()).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(dialog()).queryByText('device_actions.shutdown.remote_warning')).not.toBeInTheDocument();
      await user.click(confirmButton('shutdown'));

      expect(executeCommand).toHaveBeenCalledWith('shutdown', { seconds: 5 });
      expect(screen.getByTestId('device-action-sent')).toHaveTextContent('device_actions.shutdown.sent_local');
    });

    it('remote node: warns it stays off and needs the short name typed', async () => {
      const { executeCommand, user } = setup({ node: REMOTE });
      await user.click(button('shutdown'));

      expect(within(dialog()).getByText('device_actions.shutdown.remote_warning')).toBeInTheDocument();
      expect(confirmButton('shutdown')).toBeDisabled();
      // The local node's name does not unlock a remote node's dialog.
      await user.type(within(dialog()).getByRole('textbox'), 'BASE');
      expect(confirmButton('shutdown')).toBeDisabled();

      await user.clear(within(dialog()).getByRole('textbox'));
      await user.type(within(dialog()).getByRole('textbox'), 'HILL');
      await user.click(confirmButton('shutdown'));

      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(executeCommand).toHaveBeenCalledWith('shutdown', { seconds: 5 });
      expect(screen.getByTestId('device-action-sent')).toHaveTextContent('device_actions.shutdown.sent_remote');
    });
  });

  it('a node with no short name is confirmed by its node id', async () => {
    const { executeCommand, user } = setup({ node: { ...LOCAL, shortName: '  ' } });
    await user.click(button('factoryResetConfig'));

    await user.type(within(dialog()).getByRole('textbox'), '!00000001');
    await user.click(confirmButton('reset_config'));
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('a failed send shows no "sent" notice and closes the dialog', async () => {
    const executeCommand = vi.fn().mockRejectedValue(new Error('Not connected'));
    const { user } = setup({ executeCommand });
    await user.click(button('enterDfuMode'));
    await user.click(confirmButton('dfu'));

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('device-action-sent')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('drops the notice when another node is selected', async () => {
    const { user, rerender, executeCommand } = setup();
    await user.click(button('enterDfuMode'));
    await user.click(confirmButton('dfu'));
    expect(screen.getByTestId('device-action-sent')).toBeInTheDocument();

    rerender(
      <DeviceActionsSection node={REMOTE} canShutdown={null} disabled={false} executeCommand={executeCommand} />,
    );
    expect(screen.queryByTestId('device-action-sent')).not.toBeInTheDocument();
  });
});
