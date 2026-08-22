/**
 * @vitest-environment jsdom
 *
 * Tests for the per-node MeshCore neighbours-retrieval config panel (#4618):
 * the manual "Poll Neighbours" button, the enable toggle, and the
 * receive-only gating (mirrors MeshCoreNodeTelemetryConfig).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreNodeNeighboursConfig } from './MeshCoreNodeNeighboursConfig';

const { csrfFetchMock, hasPermissionMock, showToastMock } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : _key,
  }),
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

const renderPanel = (receiveOnly = false) =>
  render(<MeshCoreNodeNeighboursConfig baseUrl="" sourceId="test-source" publicKey={PK} receiveOnly={receiveOnly} />);

describe('MeshCoreNodeNeighboursConfig — poll + config', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation((_url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve(okResponse({ success: true, data: { total: 3, written: 2 } }));
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

  it('POSTs to the neighbours/poll endpoint and shows the stored count', async () => {
    renderPanel();
    fireEvent.click(await screen.findByText('Poll Neighbours'));
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        '/api/sources/test-source/meshcore/nodes/' + PK + '/neighbours/poll',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/Stored 2 neighbour/)).toBeInTheDocument());
  });

  it('PATCHes neighbours-config when the enable checkbox is toggled', async () => {
    renderPanel();
    await screen.findByText('Poll Neighbours');
    fireEvent.click(screen.getByRole('checkbox'));
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
    expect(screen.getByRole('checkbox')).not.toBeDisabled();
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
    renderPanel(false);
    fireEvent.click(await screen.findByText('Poll Neighbours'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      'Receive-only mode is on for this MeshCore source — nothing was sent.', 'warning',
    ));
    expect(screen.queryByText('Transmit is disabled')).not.toBeInTheDocument();
  });
});
