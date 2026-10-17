/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — remote CLI permission and console for a
 * Companion contact (#5867). Both need fw 1.18.0 on the local radio.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('./MeshCoreRemoteConsole', () => ({
  MeshCoreRemoteConsole: () => <div data-testid="repeater-console" />,
}));

vi.mock('./MeshCoreCompanionRemoteConsole', () => ({
  MeshCoreCompanionRemoteConsole: () => <div data-testid="companion-console" />,
}));

const PK = 'a'.repeat(64);
const companion = (flags = 0x01, extra: Partial<MeshCoreContact> = {}): MeshCoreContact => ({
  publicKey: PK, advName: 'Peer', advType: 1, lastSeen: Date.now() - 60_000, onDevice: true, flags, ...extra,
});
const remoteAdminActions = { sendCliCommand: vi.fn() } as any;

function renderPanel(contact: MeshCoreContact, props: Record<string, unknown> = {}) {
  const onSetRemoteCli = vi.fn().mockResolvedValue(null);
  render(
    <MeshCoreContactDetailPanel
      contact={contact}
      publicKey={PK}
      isCompanion
      localNativeCli
      canWriteConfig
      onSetRemoteCli={onSetRemoteCli}
      canRemoteAdmin
      remoteAdminActions={remoteAdminActions}
      {...props}
    />,
  );
  return { onSetRemoteCli };
}

describe('MeshCoreContactDetailPanel remote CLI (#5867)', () => {
  it('reflects flag 0x10 and sends the new value', async () => {
    const { onSetRemoteCli } = renderPanel(companion(0x11));
    const box = screen.getByRole('checkbox', { name: /run CLI commands/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(onSetRemoteCli).toHaveBeenCalledWith(PK, false));
  });

  it('shows the error the server returns', async () => {
    const { onSetRemoteCli } = renderPanel(companion());
    onSetRemoteCli.mockResolvedValue('Device said no');
    fireEvent.click(screen.getByRole('checkbox', { name: /run CLI commands/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Device said no');
  });

  it('disables the toggle on fw before 1.18.0 and hides the console', () => {
    renderPanel(companion(), { localNativeCli: false });
    expect(screen.getByRole('checkbox', { name: /run CLI commands/ })).toBeDisabled();
    expect(screen.queryByTestId('companion-console')).not.toBeInTheDocument();
  });

  it('disables the toggle when the radio does not hold the contact', () => {
    renderPanel(companion(0x01, { onDevice: false }));
    expect(screen.getByRole('checkbox', { name: /run CLI commands/ })).toBeDisabled();
  });

  it('hides the toggle without configuration:write', () => {
    renderPanel(companion(), { canWriteConfig: false });
    expect(screen.queryByTestId('remote-cli-permission')).not.toBeInTheDocument();
  });

  it('mounts the companion console, not the repeater one, for a companion contact', () => {
    renderPanel(companion());
    expect(screen.getByTestId('companion-console')).toBeInTheDocument();
    expect(screen.queryByTestId('repeater-console')).not.toBeInTheDocument();
  });

  it('shows neither on a repeater contact', () => {
    renderPanel(companion(0x10, { advType: 2 }));
    expect(screen.queryByTestId('remote-cli-permission')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-console')).not.toBeInTheDocument();
    expect(screen.getByTestId('repeater-console')).toBeInTheDocument();
  });
});
