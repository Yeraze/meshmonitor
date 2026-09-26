/**
 * @vitest-environment jsdom
 *
 * #5349 — nodes the companion radio doesn't hold in its own contact list.
 *
 *  - MeshCoreNotOnDeviceNotice explains why login/status/CLI can't work and
 *    offers "Add to radio"; a full table asks for confirmation first.
 *  - MeshCoreContactDetailPanel shows the notice only for onDevice === false.
 *  - MeshCoreRemoteConsole disables Log in and the CLI with an explanation.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreNotOnDeviceNotice } from './MeshCoreNotOnDeviceNotice';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback && typeof fallback === 'object' && typeof fallback.defaultValue === 'string') {
        return fallback.defaultValue.replace('{{count}}', String(fallback.count ?? ''));
      }
      return key;
    },
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('./MeshCoreRemoteStatsPanel', () => ({ MeshCoreRemoteStatsPanel: () => null }));
vi.mock('./MeshCoreAclManager', () => ({ MeshCoreAclManager: () => null }));
vi.mock('./CliConsoleBody', () => ({
  CliConsoleBody: (props: { disabled?: boolean; disabledPlaceholder?: string }) => (
    <div
      data-testid="cli-console-body"
      data-disabled={String(!!props.disabled)}
      data-disabled-placeholder={props.disabledPlaceholder ?? ''}
    />
  ),
}));

const PK = '5708bb' + '22'.repeat(29);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MeshCoreNotOnDeviceNotice', () => {
  it('explains the problem and adds the node when there is room', async () => {
    const onAdd = vi.fn().mockResolvedValue({ success: true, status: 'added', evicted: [] });
    render(<MeshCoreNotOnDeviceNotice publicKey={PK} onAddToDevice={onAdd} canAdd />);

    expect(screen.getByText("Not in the radio's contact list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add to radio/ }));

    await waitFor(() => expect(screen.getByText('Added to the radio.')).toBeInTheDocument());
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(PK, false);
  });

  it('asks before adding to a full list, then retries with confirmFull', async () => {
    const onAdd = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        code: 'CONTACT_TABLE_FULL_CONFIRM',
        error: "The radio's contact list is full (100/100).",
      })
      .mockResolvedValueOnce({ success: true, status: 'added', evicted: ['aa'.repeat(32)] });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MeshCoreNotOnDeviceNotice publicKey={PK} onAddToDevice={onAdd} canAdd />);

    fireEvent.click(screen.getByRole('button', { name: /Add to radio/ }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/full \(100\/100\)/);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Favourites are never replaced/);
    expect(onAdd).toHaveBeenLastCalledWith(PK, true);
    await waitFor(() => expect(screen.getByText(/replaced 1 older non-favourite/)).toBeInTheDocument());
  });

  it('does nothing more when the user declines the full-list confirmation', async () => {
    const onAdd = vi.fn().mockResolvedValue({ success: false, code: 'CONTACT_TABLE_FULL_CONFIRM', error: 'full' });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MeshCoreNotOnDeviceNotice publicKey={PK} onAddToDevice={onAdd} canAdd />);

    fireEvent.click(screen.getByRole('button', { name: /Add to radio/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Add to radio/ })).not.toBeDisabled());
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('shows the server error when the add is blocked', async () => {
    const onAdd = vi.fn().mockResolvedValue({
      success: false,
      code: 'FAVORITES_NOT_PROTECTED',
      error: 'Not added: some favourites are not yet protected on the radio.',
    });
    render(<MeshCoreNotOnDeviceNotice publicKey={PK} onAddToDevice={onAdd} canAdd />);

    fireEvent.click(screen.getByRole('button', { name: /Add to radio/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/favourites are not yet protected/);
  });

  it('hides the button without write access', () => {
    render(<MeshCoreNotOnDeviceNotice publicKey={PK} onAddToDevice={vi.fn()} canAdd={false} />);
    expect(screen.getByText("Not in the radio's contact list")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add to radio/ })).toBeNull();
  });
});

describe('MeshCoreContactDetailPanel — not-on-device notice', () => {
  const renderPanel = (onDevice: boolean | undefined) => {
    const contact: MeshCoreContact = { publicKey: PK, advName: 'Rpt B', advType: 2, onDevice };
    return render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onAddToDevice={vi.fn()}
        canWriteNodes
        isCompanion
      />,
    );
  };

  it('shows the notice when the radio does not hold the node', () => {
    renderPanel(false);
    expect(screen.getByTestId('meshcore-not-on-device')).toBeInTheDocument();
  });

  it('hides it when the node is on the radio or its status is unknown', () => {
    const { unmount } = renderPanel(true);
    expect(screen.queryByTestId('meshcore-not-on-device')).toBeNull();
    unmount();
    renderPanel(undefined);
    expect(screen.queryByTestId('meshcore-not-on-device')).toBeNull();
  });
});

describe('MeshCoreRemoteConsole — not on device', () => {
  const actions = () => ({
    loginRemote: vi.fn(),
    loginRemoteWithSaved: vi.fn(),
    sendCliCommand: vi.fn(),
    getRemoteAdminCapability: vi.fn().mockResolvedValue({ canRemember: true, rotatedCount: 0, rotated: [], stored: [] }),
    forgetRemoteCredential: vi.fn(),
    getRemoteStatus: vi.fn(),
  });

  it('disables Log in and the CLI with an explanation', async () => {
    const a = actions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Rpt B" actions={a as any} notOnDevice />);

    const login = await screen.findByRole('button', { name: /Log in to/ });
    expect(login).toBeDisabled();
    expect(login.getAttribute('title')).toMatch(/not in the radio's contact list/);
    expect(screen.getByText(/can't log in to this node/)).toBeInTheDocument();
    const body = screen.getByTestId('cli-console-body');
    expect(body.getAttribute('data-disabled')).toBe('true');
    expect(body.getAttribute('data-disabled-placeholder')).toMatch(/not in the radio's contact list/);
  });

  it('leaves Log in enabled when the node is on the radio', async () => {
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Rpt B" actions={actions() as any} />);
    expect(await screen.findByRole('button', { name: /Log in to/ })).not.toBeDisabled();
  });
});
