/**
 * @vitest-environment jsdom
 *
 * Regression tests for MeshCoreRemoteConsole's auto-login flow.
 *
 * The auto-login `useEffect` depends on `actions`, and `useMeshCore`
 * rebuilds the `actions` object on every poll refresh (every few
 * seconds). Without an attempted-for-key guard, the effect re-fires
 * on every poll and pushes a fresh "Logged in with saved password"
 * line into the transcript each time — visible as continuous log
 * spam in the Remote Administration console.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { MeshCoreRemoteConsole } from './MeshCoreRemoteConsole';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

// Stub the heavy children — we're only exercising the auto-login effect
// and its interaction with the `actions` prop identity.
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
  const loginRemoteWithSaved = vi.fn().mockResolvedValue({ success: true });
  return {
    loginRemote: vi.fn(),
    loginRemoteWithSaved,
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

describe('MeshCoreRemoteConsole auto-login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attempts auto-login exactly once across multiple actions-identity changes for the same contact', async () => {
    // Shared mock instance so re-renders see the same call counter even
    // though the wrapping `actions` object identity changes each time.
    const sharedLoginWithSaved = vi.fn().mockResolvedValue({ success: true });

    const buildActions = () => ({
      ...makeActions(),
      loginRemoteWithSaved: sharedLoginWithSaved,
    });

    const { rerender } = render(
      <MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={buildActions()} />,
    );

    // Wait for the first auto-login attempt to resolve.
    await waitFor(() => expect(sharedLoginWithSaved).toHaveBeenCalledTimes(1));

    // Simulate several poll refreshes — useMeshCore would hand down a new
    // `actions` object each time. Without the guard the effect re-fires
    // and `loginRemoteWithSaved` is called once per re-render.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        rerender(
          <MeshCoreRemoteConsole publicKey={PK} contactName="Repeater" actions={buildActions()} />,
        );
      });
    }

    // Still exactly one auto-login attempt.
    expect(sharedLoginWithSaved).toHaveBeenCalledTimes(1);
  });

  it('re-attempts auto-login after the targeted contact changes', async () => {
    const sharedLoginWithSaved = vi.fn().mockResolvedValue({ success: true });
    const PK2 = 'b'.repeat(64);

    const buildActionsFor = (key: string) => ({
      ...makeActions({
        getRemoteAdminCapability: vi.fn().mockResolvedValue({
          canRemember: true,
          rotatedCount: 0,
          rotated: [],
          stored: [{ publicKey: key, name: 'Stored' }],
        }),
      }),
      loginRemoteWithSaved: sharedLoginWithSaved,
    });

    const { rerender } = render(
      <MeshCoreRemoteConsole publicKey={PK} contactName="Repeater A" actions={buildActionsFor(PK)} />,
    );
    await waitFor(() => expect(sharedLoginWithSaved).toHaveBeenCalledWith(PK));

    await act(async () => {
      rerender(
        <MeshCoreRemoteConsole publicKey={PK2} contactName="Repeater B" actions={buildActionsFor(PK2)} />,
      );
    });
    await waitFor(() => expect(sharedLoginWithSaved).toHaveBeenCalledWith(PK2));
    expect(sharedLoginWithSaved).toHaveBeenCalledTimes(2);
  });
});
