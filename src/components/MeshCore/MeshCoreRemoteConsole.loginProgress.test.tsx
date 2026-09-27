/**
 * @vitest-environment jsdom
 *
 * MeshCoreRemoteConsole login progress and cancel (#5400).
 *
 * A login can now take 30 s or more, so the console shows live progress
 * with a Cancel that stays enabled, says why a login failed (no reply after
 * N attempts vs. refused), and never flips to "Session active" after the
 * user cancelled, even if a reply raced the cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ''));
    },
  }),
}));
vi.mock('./MeshCoreRemoteStatsPanel', () => ({ MeshCoreRemoteStatsPanel: () => <div data-testid="stats-panel" /> }));
vi.mock('./MeshCoreAclManager', () => ({ MeshCoreAclManager: () => <div /> }));
vi.mock('./CliConsoleBody', () => ({ CliConsoleBody: () => <div /> }));

const PK = 'a'.repeat(64);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    loginRemote: vi.fn(),
    loginRemoteWithSaved: vi.fn(),
    getLoginProgress: vi.fn().mockResolvedValue(null),
    cancelLogin: vi.fn().mockResolvedValue(true),
    sendCliCommand: vi.fn(),
    getRemoteAdminCapability: vi.fn().mockResolvedValue({
      canRemember: true,
      rotatedCount: 0,
      rotated: [],
      stored: [{ publicKey: PK, name: 'Rpt' }],
    }),
    forgetRemoteCredential: vi.fn(),
    getRemoteStatus: vi.fn(),
    ...overrides,
  };
}

async function renderConsole(actions: ReturnType<typeof makeActions>) {
  render(<MeshCoreRemoteConsole publicKey={PK} contactName="Hilltop" actions={actions as any} />);
  return screen.findByRole('button', { name: 'Log in with saved password' });
}

describe('MeshCoreRemoteConsole login progress (#5400)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows progress with an enabled Cancel while the saved-password login runs', async () => {
    const login = deferred<{ success: boolean }>();
    const actions = makeActions({ loginRemoteWithSaved: vi.fn(() => login.promise) });
    fireEvent.click(await renderConsole(actions));

    const progress = await screen.findByTestId('meshcore-login-progress');
    expect(progress.textContent).toContain('Sending login');
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Use a different password' }) as HTMLButtonElement).disabled).toBe(true);

    login.resolve({ success: true });
    await screen.findByText('Session active');
    expect(screen.queryByTestId('meshcore-login-progress')).toBeNull();
  });

  it('Cancel stops the login and a reply that raced it does not log in', async () => {
    const login = deferred<{ success: boolean }>();
    const actions = makeActions({ loginRemoteWithSaved: vi.fn(() => login.promise) });
    fireEvent.click(await renderConsole(actions));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    const requestId = actions.loginRemoteWithSaved.mock.calls[0][1].requestId;
    await waitFor(() => expect(actions.cancelLogin).toHaveBeenCalledWith(requestId));

    login.resolve({ success: true }); // late reply
    await waitFor(() => expect(screen.queryByTestId('meshcore-login-progress')).toBeNull());
    expect(screen.queryByText('Session active')).toBeNull();
  });

  it('explains a login that got no reply after every attempt', async () => {
    const actions = makeActions({
      loginRemoteWithSaved: vi.fn().mockResolvedValue({ success: false, reason: 'no_reply', attempts: 3, code: 'REMOTE_LOGIN_NO_REPLY' }),
    });
    fireEvent.click(await renderConsole(actions));
    expect(await screen.findByText('No reply from Hilltop after 3 attempts')).toBeTruthy();
  });

  it('says plainly when the node refused the password', async () => {
    const actions = makeActions({
      loginRemoteWithSaved: vi.fn().mockResolvedValue({ success: false, reason: 'rejected', code: 'STORED_CREDENTIAL_REJECTED' }),
    });
    fireEvent.click(await renderConsole(actions));
    expect(await screen.findByText('Hilltop refused the password')).toBeTruthy();
  });

  it('modal Cancel stays enabled mid-login, cancels, closes, and saves nothing', async () => {
    const login = deferred<{ success: boolean; persisted?: boolean }>();
    const actions = makeActions({ loginRemote: vi.fn(() => login.promise) });
    fireEvent.click(await renderConsole(actions).then(() => screen.getByRole('button', { name: 'Use a different password' })));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('input[type="password"]')!, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await screen.findByTestId('meshcore-login-progress');
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' }) as HTMLButtonElement[];
    expect(cancelButtons.every((b) => !b.disabled)).toBe(true);
    fireEvent.click(cancelButtons[cancelButtons.length - 1]); // the modal's own Cancel

    await waitFor(() => expect(actions.cancelLogin).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();

    login.resolve({ success: false });
    await waitFor(() => expect(screen.queryByTestId('meshcore-login-progress')).toBeNull());
    expect(screen.queryByText('Session active')).toBeNull();
  });
});
