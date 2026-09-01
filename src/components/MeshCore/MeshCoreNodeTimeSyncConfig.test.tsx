/**
 * @vitest-environment jsdom
 *
 * Tests for the per-node MeshCore time-sync config panel (#4916): the manual
 * "Sync Clock" button, the enable toggle, the 1-hour interval floor, the
 * missing-credential warning, and receive-only gating.
 *
 * The two behaviours worth guarding beyond the sibling panels' coverage are
 * the interval floor (a sub-floor value must be rejected and the field
 * reverted, not silently sent) and the no-credential warning (without a saved
 * admin password the schedule would fail every cycle with nothing in the UI to
 * explain it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreNodeTimeSyncConfig } from './MeshCoreNodeTimeSyncConfig';

const { csrfFetchMock, hasPermissionMock, showToastMock } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  showToastMock: vi.fn(),
}));

// `t` and the returned object must be STABLE across renders. Real
// react-i18next hands back a stable `t`, and the panel's load effect lists it
// as a dependency — a fresh identity per render would re-fire that effect on
// every render, clearing `error`/`syncMsg` the instant they were set and
// making the assertions below flap.
const stableT = (_key: string, fallback?: string | Record<string, unknown>) =>
  typeof fallback === 'string' ? fallback : _key;
const stableTranslation = { t: stableT };

vi.mock('react-i18next', () => ({
  useTranslation: () => stableTranslation,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const PK = 'a'.repeat(64);

const okResponse = (body: unknown) => ({ ok: true, json: async () => body });
const errResponse = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const renderPanel = (receiveOnly = false) =>
  render(
    <MeshCoreNodeTimeSyncConfig
      baseUrl=""
      sourceId="test-source"
      publicKey={PK}
      receiveOnly={receiveOnly}
    />,
  );

/** Default GET payload: enabled off, 12h interval, credential present. */
function defaultGet(over: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      enabled: false,
      intervalMinutes: 720,
      lastSyncAt: null,
      minIntervalMinutes: 60,
      hasSavedCredential: true,
      ...over,
    },
  };
}

describe('MeshCoreNodeTimeSyncConfig', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation((_url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve(
          okResponse({ success: true, data: { reply: 'OK', elapsedMs: 1200, syncedAt: 1_700_000_000_000 } }),
        );
      }
      if (opts?.method === 'PATCH') {
        const patch = JSON.parse(opts.body ?? '{}');
        return Promise.resolve(
          okResponse({
            success: true,
            data: {
              enabled: patch.enabled ?? false,
              intervalMinutes: patch.intervalMinutes ?? 720,
              lastSyncAt: null,
              minIntervalMinutes: 60,
              hasSavedCredential: true,
            },
          }),
        );
      }
      return Promise.resolve(okResponse(defaultGet()));
    });
  });

  it('renders the sync button once loaded', async () => {
    renderPanel();
    expect(await screen.findByText('Sync Clock')).toBeInTheDocument();
  });

  it('shows the 12-hour default rendered as hours, not raw minutes', async () => {
    renderPanel();
    expect(await screen.findByText('12h')).toBeInTheDocument();
  });

  it('POSTs to the time-sync endpoint and confirms success', async () => {
    renderPanel();
    fireEvent.click(await screen.findByText('Sync Clock'));
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        `/api/sources/test-source/meshcore/nodes/${PK}/time-sync`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText('Clock pushed to repeater.')).toBeInTheDocument();
  });

  it('surfaces a rejected push (repeater clock ahead) as an error, not a success', async () => {
    csrfFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve(
          errResponse(409, {
            success: false,
            code: 'CLOCK_PUSH_REJECTED',
            error: 'Repeater refused the clock push (it may be running ahead of server time): ERR: clock cannot go backwards',
          }),
        );
      }
      return Promise.resolve(okResponse(defaultGet()));
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Sync Clock'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot go backwards/);
  });

  it('names SESSION_SECRET rotation when a sync reports NO_SAVED_CREDENTIAL', async () => {
    // The up-front banner cannot catch this: `hasSavedCredential` only proves
    // the ciphertext blob exists, so a credential invalidated by a rotated
    // SESSION_SECRET shows no warning yet fails every sync. The manual path is
    // where the user finds out, so it must say something actionable.
    csrfFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve(
          errResponse(409, {
            success: false,
            code: 'NO_SAVED_CREDENTIAL',
            error: 'No usable saved admin password for this node. Save one, then retry.',
          }),
        );
      }
      // Note hasSavedCredential: true — the blob is there, it just won't decrypt.
      return Promise.resolve(okResponse(defaultGet({ hasSavedCredential: true })));
    });
    renderPanel();
    // No up-front banner, because the blob exists.
    expect(screen.queryByText(/No admin password is saved/)).toBeNull();

    fireEvent.click(await screen.findByText('Sync Clock'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/SESSION_SECRET/);
  });

  it('warns when no admin password is saved — the schedule would silently no-op', async () => {
    csrfFetchMock.mockImplementation(() =>
      Promise.resolve(okResponse(defaultGet({ hasSavedCredential: false }))),
    );
    renderPanel();
    expect(
      await screen.findByText(/No admin password is saved for this node/),
    ).toBeInTheDocument();
  });

  it('does not warn about credentials when one is saved', async () => {
    renderPanel();
    await screen.findByText('Sync Clock');
    expect(screen.queryByText(/No admin password is saved/)).toBeNull();
  });

  it('PATCHes enabled when the toggle is switched on', async () => {
    renderPanel();
    const toggle = await screen.findByLabelText('Auto time sync');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        `/api/sources/test-source/meshcore/nodes/${PK}/time-sync-config`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: true }) }),
      ),
    );
  });

  it('rejects a sub-floor interval, reverts the field, and never sends it', async () => {
    renderPanel();
    const input = await screen.findByLabelText('Interval (minutes)');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);

    expect(await screen.findByRole('alert')).toHaveTextContent(/between 60 and/);
    // Reverted to the persisted value rather than left holding an invalid one.
    expect((input as HTMLInputElement).value).toBe('720');
    const patchCalls = csrfFetchMock.mock.calls.filter(
      (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
  });

  it('accepts an in-range interval and PATCHes it', async () => {
    renderPanel();
    const input = await screen.findByLabelText('Interval (minutes)');
    fireEvent.change(input, { target: { value: '1440' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        `/api/sources/test-source/meshcore/nodes/${PK}/time-sync-config`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ intervalMinutes: 1440 }) }),
      ),
    );
  });

  it('disables the sync button in receive-only mode', async () => {
    renderPanel(true);
    expect(await screen.findByText('Sync Clock')).toBeDisabled();
  });

  it('disables editing without configuration:write', async () => {
    hasPermissionMock.mockReturnValue(false);
    renderPanel();
    expect(await screen.findByLabelText('Auto time sync')).toBeDisabled();
    // The manual sync mutates the remote clock, so it needs the same
    // permission as an edit — unlike the telemetry/neighbours polls.
    expect(screen.getByText('Sync Clock')).toBeDisabled();
  });
});
