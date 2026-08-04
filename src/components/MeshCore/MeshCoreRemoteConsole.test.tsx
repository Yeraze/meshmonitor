/**
 * @vitest-environment jsdom
 *
 * Tests for MeshCoreRemoteConsole's credential handling.
 *
 * The console must NEVER auto-login (that spends radio airtime the user
 * didn't ask for). On mount it only fetches the credential *capability* (a
 * local server lookup) so it can show a "Saved password" indicator; the saved
 * password is used only when the user explicitly clicks the login button.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

// Stub the heavy children — we're only exercising the console's own UI. Each
// stub reflects the props relevant to receive-only gating as data attributes
// so tests can assert what was threaded through without rendering the real
// (much heavier) child.
vi.mock('./MeshCoreRemoteStatsPanel', () => ({
  MeshCoreRemoteStatsPanel: (props: { receiveOnly?: boolean }) => (
    <div data-testid="stats-panel" data-receive-only={String(!!props.receiveOnly)} />
  ),
}));
vi.mock('./MeshCoreAclManager', () => ({
  MeshCoreAclManager: (props: { disabled?: boolean }) => (
    <div data-testid="acl-manager" data-disabled={String(!!props.disabled)} />
  ),
}));
vi.mock('./CliConsoleBody', () => ({
  CliConsoleBody: (props: { disabled?: boolean; disabledPlaceholder?: string }) => (
    <div
      data-testid="cli-console-body"
      data-disabled={String(!!props.disabled)}
      data-disabled-placeholder={props.disabledPlaceholder ?? ''}
    />
  ),
}));

const PK = 'a'.repeat(64);

function makeActions(overrides?: Partial<Record<string, ReturnType<typeof vi.fn>>>) {
  return {
    loginRemote: vi.fn(),
    loginRemoteWithSaved: vi.fn().mockResolvedValue({ success: true }),
    sendCliCommand: vi.fn(),
    getRemoteAdminCapability: vi.fn().mockResolvedValue({
      canRemember: true,
      rotatedCount: 0,
      rotated: [],
      stored: [{ publicKey: PK, name: 'Stored Repeater' }],
    }),
    forgetRemoteCredential: vi.fn(),
    getRemoteStatus: vi.fn(),
    ...overrides,
  };
}

describe('MeshCoreRemoteConsole credential handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT auto-login on mount (no radio airtime), but fetches capability', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} />);

    // Capability is fetched (local lookup) so the UI can reflect saved state…
    await waitFor(() => expect(actions.getRemoteAdminCapability).toHaveBeenCalled());
    // …but the saved password is never used automatically.
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled();
  });

  it('shows a "Saved password" indicator when a credential is stored', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} />);

    // Chip text is "✓ Saved password" — match the substring.
    await waitFor(() => expect(screen.getByText(/Saved password/)).toBeInTheDocument());
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled();
  });

  it('logs in with the saved password only when the user clicks the button', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} />);

    const btn = await screen.findByText('Log in with saved password');
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled(); // not yet

    fireEvent.click(btn);

    await waitFor(() => expect(actions.loginRemoteWithSaved).toHaveBeenCalledTimes(1));
    expect(actions.loginRemoteWithSaved).toHaveBeenCalledWith(PK);
  });

  it('shows the plain "Log in" button (no saved indicator) when nothing is stored', async () => {
    const actions = makeActions({
      getRemoteAdminCapability: vi.fn().mockResolvedValue({
        canRemember: true,
        rotatedCount: 0,
        rotated: [],
        stored: [],
      }),
    });
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} />);

    await waitFor(() => expect(actions.getRemoteAdminCapability).toHaveBeenCalled());
    expect(screen.queryByText('Saved password')).not.toBeInTheDocument();
    expect(screen.queryByText('Log in with saved password')).not.toBeInTheDocument();
  });
});

describe('MeshCoreRemoteConsole receive-only mode (#4547 Phase 2 WP3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables "Log in with saved password" + "Use a different password" with a tooltip when a credential is stored', async () => {
    const actions = makeActions();
    render(
      <MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} receiveOnly />,
    );

    const savedBtn = await screen.findByText('Log in with saved password');
    const differentBtn = screen.getByText('Use a different password');
    expect(savedBtn.closest('button')).toBeDisabled();
    expect(savedBtn.closest('button')).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
    expect(differentBtn.closest('button')).toBeDisabled();

    fireEvent.click(savedBtn);
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled();
  });

  it('disables the plain "Log in to {name}" opener when nothing is stored', async () => {
    const actions = makeActions({
      getRemoteAdminCapability: vi.fn().mockResolvedValue({
        canRemember: true,
        rotatedCount: 0,
        rotated: [],
        stored: [],
      }),
    });
    render(
      <MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} receiveOnly />,
    );

    const openBtn = await screen.findByText('Log in to {{name}}');
    expect(openBtn.closest('button')).toBeDisabled();
    expect(openBtn.closest('button')).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
  });

  it('threads disabled (and the placeholder) into CliConsoleBody even before login', async () => {
    // CliConsoleBody is unconditionally rendered (its own `disabled` prop
    // covers both !loggedIn and receiveOnly), so this doesn't require
    // driving the console into a logged-in state first.
    const actions = makeActions();
    render(
      <MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} receiveOnly />,
    );
    await waitFor(() => expect(actions.getRemoteAdminCapability).toHaveBeenCalled());
    expect(screen.getByTestId('cli-console-body')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('cli-console-body')).toHaveAttribute(
      'data-disabled-placeholder', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.',
    );
  });

  it('leaves the login buttons enabled and untitled when receiveOnly is false', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={actions as any} />);

    const savedBtn = await screen.findByText('Log in with saved password');
    expect(savedBtn.closest('button')).not.toBeDisabled();
    expect(savedBtn.closest('button')).not.toHaveAttribute('title');
  });
});
