/**
 * @vitest-environment jsdom
 *
 * Tests for the manual telemetry-poll buttons (#3674) on the per-node
 * MeshCore telemetry config panel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';

const { csrfFetchMock, hasPermissionMock } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  hasPermissionMock: vi.fn(),
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

const PK = 'a'.repeat(64);

const okResponse = (body: unknown) => ({ ok: true, json: async () => body });

const renderPanel = () =>
  render(<MeshCoreNodeTelemetryConfig baseUrl="" sourceId="test-source" publicKey={PK} />);

describe('MeshCoreNodeTelemetryConfig — manual poll buttons', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    csrfFetchMock.mockReset().mockImplementation((_url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'POST') {
        const type = JSON.parse(opts.body ?? '{}').type;
        return Promise.resolve(okResponse({ success: true, data: { type, written: 16, sources: ['status:16'] } }));
      }
      // Initial telemetry-config GET on mount.
      return Promise.resolve(
        okResponse({ success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }),
      );
    });
  });

  it('renders both poll buttons once loaded', async () => {
    renderPanel();
    expect(await screen.findByText('Poll Status')).toBeInTheDocument();
    expect(screen.getByText('Poll Environment (LPP)')).toBeInTheDocument();
  });

  it('POSTs { type: "status" } and shows the written-row count', async () => {
    renderPanel();
    const btn = await screen.findByText('Poll Status');
    fireEvent.click(btn);

    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        '/api/sources/test-source/meshcore/nodes/' + PK + '/telemetry/poll',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ type: 'status' }) }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/Wrote 16 telemetry row/)).toBeInTheDocument());
  });

  it('POSTs { type: "lpp" } for the environment button', async () => {
    renderPanel();
    const btn = await screen.findByText('Poll Environment (LPP)');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(csrfFetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/telemetry/poll'),
        expect.objectContaining({ body: JSON.stringify({ type: 'lpp' }) }),
      ),
    );
  });

  it('surfaces a 429 throttle error from the backend', async () => {
    csrfFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          json: async () => ({ success: false, error: 'Too soon since last mesh transmission; retry in 42s' }),
        });
      }
      return Promise.resolve(
        okResponse({ success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }),
      );
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Poll Status'));
    await waitFor(() =>
      expect(screen.getByText(/Too soon since last mesh transmission/)).toBeInTheDocument(),
    );
  });

  it('disables the poll buttons without nodes:read permission', async () => {
    hasPermissionMock.mockImplementation((resource: string) => resource !== 'nodes');
    renderPanel();
    const btn = await screen.findByText('Poll Status');
    expect(btn.closest('button')).toBeDisabled();
  });
});
