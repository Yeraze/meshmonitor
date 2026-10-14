/**
 * @vitest-environment jsdom
 *
 * MeshCoreRemoteConsole — remembered admin sessions (#5785).
 *
 *  - On mount it asks the server for the session (DB only); it never logs
 *    in on its own.
 *  - "Resume session" enables the console with NO login call.
 *  - "Log in again" uses the saved password (or the modal without one).
 *  - "Log out" forgets the session and disables the console.
 *  - While resumed, CliConsoleBody gets a timeout hint; after a fresh login
 *    it does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) => {
    if (typeof fallback === 'string') return fallback;
    return key;
  };
  return createReactI18nextMock(t);
});

vi.mock('./MeshCoreRemoteStatsPanel', () => ({
  MeshCoreRemoteStatsPanel: () => <div data-testid="stats-panel" />,
}));
vi.mock('./MeshCoreAclManager', () => ({
  MeshCoreAclManager: () => <div data-testid="acl-manager" />,
}));
vi.mock('./CliConsoleBody', () => ({
  CliConsoleBody: (props: { disabled?: boolean; timeoutHint?: string }) => (
    <div
      data-testid="cli-console-body"
      data-disabled={String(!!props.disabled)}
      data-timeout-hint={props.timeoutHint ?? ''}
    />
  ),
}));

const PK = 'a'.repeat(64);
const ACTIVE = { active: true, loggedInAt: 1_760_000_000_000, isAdmin: true };

function makeActions(opts: { session?: unknown; stored?: boolean } = {}) {
  return {
    loginRemote: vi.fn(),
    loginRemoteWithSaved: vi.fn().mockResolvedValue({ success: true }),
    getLoginProgress: vi.fn().mockResolvedValue(null),
    cancelLogin: vi.fn(),
    sendCliCommand: vi.fn(),
    getRemoteAdminCapability: vi.fn().mockResolvedValue({
      canRemember: true,
      rotatedCount: 0,
      rotated: [],
      stored: opts.stored === false ? [] : [{ publicKey: PK, name: 'R' }],
    }),
    forgetRemoteCredential: vi.fn().mockResolvedValue(true),
    getRemoteStatus: vi.fn(),
    getRemoteAdminSession: vi.fn().mockResolvedValue(opts.session ?? ACTIVE),
    logoutRemote: vi.fn().mockResolvedValue(true),
  };
}

const body = () => screen.getByTestId('cli-console-body');

describe('MeshCoreRemoteConsole — remembered sessions (#5785)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the session on mount and offers Resume, without logging in', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    expect(await screen.findByText('Resume session')).toBeTruthy();
    expect(screen.getByText('Log in again')).toBeTruthy();
    expect(screen.getByText('Saved session')).toBeTruthy();
    expect(actions.getRemoteAdminSession).toHaveBeenCalledWith(PK);
    expect(actions.loginRemote).not.toHaveBeenCalled();
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled();
    expect(body().getAttribute('data-disabled')).toBe('true');
  });

  it('Resume enables the console with no login call, and arms the timeout hint', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    fireEvent.click(await screen.findByText('Resume session'));
    expect(body().getAttribute('data-disabled')).toBe('false');
    expect(body().getAttribute('data-timeout-hint')).toMatch(/log in again/);
    expect(actions.loginRemote).not.toHaveBeenCalled();
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled();
    // On a resumed session both Log out and Log in again are offered.
    expect(screen.getByText('Log out')).toBeTruthy();
    expect(screen.getByText('Log in again')).toBeTruthy();
  });

  it('Log in again uses the saved password; a fresh login drops the hint', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    fireEvent.click(await screen.findByText('Log in again'));
    await waitFor(() => expect(actions.loginRemoteWithSaved).toHaveBeenCalled());
    await waitFor(() => expect(body().getAttribute('data-disabled')).toBe('false'));
    expect(body().getAttribute('data-timeout-hint')).toBe('');
  });

  it('Log in again opens the password modal when no password is saved', async () => {
    const actions = makeActions({ stored: false });
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    fireEvent.click(await screen.findByText('Log in again'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(actions.loginRemoteWithSaved).not.toHaveBeenCalled();
  });

  it('Log out forgets the session and disables the console', async () => {
    const actions = makeActions();
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    fireEvent.click(await screen.findByText('Resume session'));
    actions.getRemoteAdminSession.mockResolvedValue({ active: false, loggedInAt: null, isAdmin: null, reason: 'none' });
    fireEvent.click(screen.getByText('Log out'));
    await waitFor(() => expect(actions.logoutRemote).toHaveBeenCalledWith(PK));
    await waitFor(() => expect(body().getAttribute('data-disabled')).toBe('true'));
    await waitFor(() => expect(screen.queryByText('Resume session')).toBeNull());
  });

  it('a session recorded by another radio is not offered', async () => {
    const actions = makeActions({ session: { active: false, loggedInAt: 1, isAdmin: true, reason: 'other_radio' } });
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    expect(await screen.findByText('Log in with saved password')).toBeTruthy();
    expect(screen.queryByText('Resume session')).toBeNull();
  });

  it('a failed session lookup just means nothing to resume', async () => {
    const actions = makeActions();
    actions.getRemoteAdminSession.mockRejectedValue(new Error('network'));
    render(<MeshCoreRemoteConsole publicKey={PK} contactName="R" actions={actions as any} />);
    expect(await screen.findByText('Log in with saved password')).toBeTruthy();
    expect(screen.queryByText('Resume session')).toBeNull();
  });
});
