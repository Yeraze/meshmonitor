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

// Stub the heavy children — we're only exercising the console's own UI.
vi.mock('./MeshCoreRemoteStatsPanel', () => ({
  MeshCoreRemoteStatsPanel: () => null,
}));
vi.mock('./MeshCoreAclManager', () => ({
  MeshCoreAclManager: () => null,
}));
vi.mock('./CliConsoleBody', () => ({
  CliConsoleBody: () => null,
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
