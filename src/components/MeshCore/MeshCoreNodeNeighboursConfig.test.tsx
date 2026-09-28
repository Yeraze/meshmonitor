/**
 * @vitest-environment jsdom
 *
 * Tests for the per-node MeshCore neighbours-retrieval config panel (#4618):
 * the manual "Poll Neighbours" button, the enable toggle, and the
 * receive-only gating (mirrors MeshCoreNodeTelemetryConfig).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreNodeNeighboursConfig } from './MeshCoreNodeNeighboursConfig';

const { csrfFetchMock, hasPermissionMock, showToastMock, t } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  showToastMock: vi.fn(),
  t: (_key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) =>
    typeof fallback === 'string'
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars?.[k] ?? ''))
      : _key,
}));

// `t` must keep one identity across renders, as the real react-i18next `t`
// does. The config-load effect lists `t` in its deps, so a fresh `t` per
// render re-ran the load on every render: hundreds of GETs a second, with the
// panel flipping between "Loading…" and the checkbox. A synchronous
// getByRole('checkbox') then failed whenever it landed on a loading frame.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
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

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** A finished paged fetch as the progress endpoint reports it (#5413). */
const doneSnapshot = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'x', publicKey: 'a'.repeat(64), phase: 'done', page: 1, plannedPages: 1, maxPages: 5,
  total: 2, pagesFetched: 1, neighbours: [], waitMs: null, waitRemainingMs: null, cancelRequested: false,
  outcome: 'complete', stored: 'replaced', written: 2, error: null, ...overrides,
});

/**
 * The poll button renders at once, but the config controls (the enable
 * checkbox) appear only after the config GET resolves. Tests that touch them
 * must find them asynchronously, not with a sync getBy after the poll button.
 */
const renderPanel = (receiveOnly = false) => {
  const user = userEvent.setup();
  render(<MeshCoreNodeNeighboursConfig baseUrl="" sourceId="test-source" publicKey={PK} receiveOnly={receiveOnly} />);
  return user;
};

describe('MeshCoreNodeNeighboursConfig — poll + config', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation((_url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve(okResponse({ success: true, data: { requestId: 'x', maxPages: 5 } }));
      }
      if (_url.includes('/neighbours/fetch/')) {
        return Promise.resolve(okResponse({ success: true, data: doneSnapshot() }));
      }
      if (opts?.method === 'PATCH') {
        const patch = JSON.parse(opts.body ?? '{}');
        return Promise.resolve(okResponse({
          success: true,
          data: { enabled: patch.enabled ?? false, intervalMinutes: patch.intervalMinutes ?? 60, lastRequestAt: null },
        }));
      }
      // Initial neighbours-config GET on mount.
      return Promise.resolve(
        okResponse({ success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }),
      );
    });
  });

  it('renders the poll button once loaded', async () => {
    renderPanel();
    expect(await screen.findByText('Poll Neighbours')).toBeInTheDocument();
  });

  it('starts a paged fetch (#5413) and shows the stored count when it completes', async () => {
    const user = renderPanel();
    await user.click(await screen.findByText('Poll Neighbours'));
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        '/api/sources/test-source/meshcore/nodes/' + PK + '/neighbours/fetch',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const startCall = csrfFetchMock.mock.calls.find(([u, o]) => String(u).endsWith('/neighbours/fetch') && o?.method === 'POST');
    const { requestId } = JSON.parse(startCall![1].body);
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        '/api/sources/test-source/meshcore/nodes/' + PK + '/neighbours/fetch/' + requestId,
      ),
    );
    await waitFor(() => expect(screen.getByText(/Stored 2 neighbour/)).toBeInTheDocument());
  });

  it('shows live progress with a countdown and Cancel while pages are pending', async () => {
    let cancelled = false;
    csrfFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.endsWith('/cancel')) {
        cancelled = true;
        return Promise.resolve(okResponse({ success: true }));
      }
      if (opts?.method === 'POST') return Promise.resolve(okResponse({ success: true, data: { requestId: 'x', maxPages: 5 } }));
      if (url.includes('/neighbours/fetch/')) {
        return Promise.resolve(okResponse({
          success: true,
          data: doneSnapshot({
            phase: 'waiting', page: 2, plannedPages: 4, total: 37, pagesFetched: 1,
            neighbours: Array.from({ length: 10 }, (_, i) => ({ publicKeyPrefix: `p${i}`, heardSecondsAgo: 5, snr: 4, name: null, fullPublicKey: null })),
            waitMs: 60_000, waitRemainingMs: 42_000, outcome: null, stored: null, written: null,
            cancelRequested: cancelled,
          }),
        }));
      }
      return Promise.resolve(okResponse({ success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }));
    });
    const user = renderPanel();
    await user.click(await screen.findByText('Poll Neighbours'));
    const status = await screen.findByTestId('meshcore-neighbours-fetch-progress');
    await waitFor(() => expect(status.textContent).toMatch(/Page 2 of 4 · 10 of 37 neighbours · next page in 4\d s/));
    // The button stays locked while the fetch runs; Cancel does not.
    expect(screen.getByText('Polling…').closest('button')).toBeDisabled();
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it('PATCHes neighbours-config when the enable checkbox is toggled', async () => {
    const user = renderPanel();
    await user.click(await screen.findByRole('checkbox'));
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        '/api/sources/test-source/meshcore/nodes/' + PK + '/neighbours-config',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: true }) }),
      ),
    );
  });

  it('disables the poll button without nodes:read permission', async () => {
    hasPermissionMock.mockImplementation((resource: string) => resource !== 'nodes');
    renderPanel();
    const btn = await screen.findByText('Poll Neighbours');
    expect(btn.closest('button')).toBeDisabled();
  });

  it('disables the poll button in receive-only mode; the enable checkbox stays enabled', async () => {
    renderPanel(true);
    const btn = (await screen.findByText('Poll Neighbours')).closest('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
    expect(await screen.findByRole('checkbox')).not.toBeDisabled();
  });

  it('detects a 409 TX_DISABLED response and toasts instead of the inline error', async () => {
    csrfFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ success: false, code: 'TX_DISABLED', error: 'Transmit is disabled' }),
        });
      }
      return Promise.resolve(
        okResponse({ success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }),
      );
    });
    const user = renderPanel(false);
    await user.click(await screen.findByText('Poll Neighbours'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      'Receive-only mode is on for this MeshCore source — nothing was sent.', 'warning',
    ));
    expect(screen.queryByText('Transmit is disabled')).not.toBeInTheDocument();
  });
});
