/**
 * @vitest-environment jsdom
 *
 * Tests for the manual telemetry-poll buttons (#3674) on the per-node
 * MeshCore telemetry config panel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';

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
  render(<MeshCoreNodeTelemetryConfig baseUrl="" sourceId="test-source" publicKey={PK} receiveOnly={receiveOnly} />);

describe('MeshCoreNodeTelemetryConfig — manual poll buttons', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
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

describe('MeshCoreNodeTelemetryConfig — receive-only mode (#4547 Phase 2 WP3)', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve(okResponse({ success: true, data: { type: 'status', written: 0 } }));
      }
      return Promise.resolve(
        okResponse({ success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }),
      );
    });
  });

  it('disables both poll buttons with a tooltip; the enable checkbox and interval input stay enabled', async () => {
    renderPanel(true);
    const pollStatus = (await screen.findByText('Poll Status')).closest('button');
    const pollLpp = screen.getByText('Poll Environment (LPP)').closest('button');
    expect(pollStatus).toBeDisabled();
    expect(pollStatus).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
    expect(pollLpp).toBeDisabled();
    expect(pollLpp).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');

    // Negative control: the settings-only controls are NOT gated (interview
    // decision 5 — only immediate-TX controls are disabled).
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeDisabled();
    const intervalInput = screen.getByDisplayValue('60');
    expect(intervalInput).not.toBeDisabled();
  });

  it('does not disable the poll buttons when receiveOnly is false', async () => {
    renderPanel(false);
    const pollStatus = (await screen.findByText('Poll Status')).closest('button');
    expect(pollStatus).not.toBeDisabled();
    expect(pollStatus).not.toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
  });

  it('renders the paused note when receiveOnly', async () => {
    renderPanel(true);
    await screen.findByText('Poll Status');
    expect(screen.getByText(/Paused — receive-only mode/)).toBeInTheDocument();
  });

  it('poll() detects a 409 TX_DISABLED response and toasts instead of setting the inline error', async () => {
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
    // Render enabled so the button is clickable — a direct 409 from the
    // server (e.g. a race with another tab flipping the setting) must still
    // surface the friendly toast rather than a raw error.
    renderPanel(false);
    fireEvent.click(await screen.findByText('Poll Status'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      'Receive-only mode is on for this MeshCore source — nothing was sent.', 'warning',
    ));
    expect(screen.queryByText('Transmit is disabled')).not.toBeInTheDocument();
  });
});
