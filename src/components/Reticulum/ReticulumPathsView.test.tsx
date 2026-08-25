/**
 * @vitest-environment jsdom
 *
 * ReticulumPathsView (#3960 Phase 4 WP4).
 *
 * Covers: path-table rendering (destination/via/interface/hops/age),
 * humanized age via `formatRelativeTime`, the empty state, the per-row
 * "Probe" action (gated on `nodes:write`, calls the hook's `probe` helper,
 * renders an inline ok/fail result keyed to `probeResult.destinationHash`),
 * and the remote-fleet panel (free-text hash entry + on-demand "Query",
 * rendering the interface/link/path-count summary or the failure reason).
 */
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReticulumPathsView } from './ReticulumPathsView';
import type { ReticulumPathRow, ReticulumProbeResult, ReticulumRemoteStatus } from '../../types/reticulum';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>, maybeOptions?: Record<string, unknown>) => {
      const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key;
      const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
      if (!options) return fallback;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_match: string, k: string) => String(options[k] ?? ''));
    },
  }),
}));

const hasPermissionMock = vi.fn(() => true);
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

function makePath(overrides: Partial<ReticulumPathRow> = {}): ReticulumPathRow {
  return {
    sourceId: 'src-rns',
    destinationHash: 'aabbccdd11223344',
    viaHash: 'ffeeddcc55667788',
    hops: 2,
    interfaceName: 'TCPServer',
    expiresAt: 9999999999999,
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  hasPermissionMock.mockClear();
  hasPermissionMock.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderView(props: Partial<ComponentProps<typeof ReticulumPathsView>> = {}) {
  return render(
    <ReticulumPathsView
      paths={[]}
      probeResult={null}
      probingHash={null}
      onProbe={vi.fn().mockResolvedValue(null)}
      remoteStatus={null}
      remoteStatusLoading={false}
      onQueryRemoteStatus={vi.fn().mockResolvedValue(null)}
      {...props}
    />,
  );
}

describe('ReticulumPathsView', () => {
  it('renders the empty state when there are no paths', () => {
    renderView({ paths: [] });
    expect(screen.getByText('No paths reported yet.')).toBeInTheDocument();
  });

  it('renders the loading state while the first poll is in flight', () => {
    renderView({ paths: [], loading: true });
    expect(screen.getByText('Loading paths…')).toBeInTheDocument();
  });

  it('renders one row per path with destination, via, interface, and hops', () => {
    const path = makePath({ destinationHash: 'aabbccdd11223344', viaHash: 'ffeeddcc55667788', interfaceName: 'TCPServer', hops: 3 });
    renderView({ paths: [path] });

    const row = screen.getByTestId('reticulum-path-row-aabbccdd11223344');
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('aabbccdd1122'); // truncated hash
    expect(row).toHaveTextContent('ffeeddcc5566'); // truncated via hash
    expect(row).toHaveTextContent('TCPServer');
    expect(row).toHaveTextContent('3');
  });

  it('renders a dash for a null via/interface/hops', () => {
    const path = makePath({ viaHash: null, interfaceName: null, hops: null });
    renderView({ paths: [path] });
    const row = screen.getByTestId(`reticulum-path-row-${path.destinationHash}`);
    // Three separate '—' cells (via, interface, hops).
    expect(row.textContent?.match(/—/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('humanizes the age from updatedAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    const path = makePath({ updatedAt: new Date('2026-01-01T00:05:00.000Z').getTime() });
    renderView({ paths: [path] });
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
  });

  it('shows the Probe button and column when the user has nodes:write', () => {
    renderView({ paths: [makePath()] });
    expect(screen.getByRole('button', { name: /probe/i })).toBeInTheDocument();
  });

  it('hides the Probe button and column without nodes:write', () => {
    hasPermissionMock.mockImplementation((resource: string, action: string) => !(resource === 'nodes' && action === 'write'));
    renderView({ paths: [makePath()] });
    expect(screen.queryByRole('button', { name: /probe/i })).not.toBeInTheDocument();
  });

  it('calls onProbe with the row destination hash when Probe is clicked', () => {
    const onProbe = vi.fn().mockResolvedValue(null);
    const path = makePath({ destinationHash: 'destHash1' });
    renderView({ paths: [path], onProbe });

    fireEvent.click(screen.getByRole('button', { name: /probe/i }));
    expect(onProbe).toHaveBeenCalledWith('destHash1');
  });

  it('shows a "Probing…" disabled state for the row currently probing', () => {
    const path = makePath({ destinationHash: 'destHash1' });
    renderView({ paths: [path], probingHash: 'destHash1' });

    const btn = screen.getByRole('button', { name: /probing/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders an ok probe result inline on the matching row', () => {
    const path = makePath({ destinationHash: 'destHash1' });
    const result: ReticulumProbeResult = { destinationHash: 'destHash1', ok: true, rttMs: 42, hops: 1, error: null };
    renderView({ paths: [path], probeResult: result });

    const cell = screen.getByTestId('reticulum-path-probe-result-destHash1');
    expect(cell).toHaveTextContent('42');
    expect(cell).toHaveTextContent('1');
  });

  it('renders a failed probe result inline with the error reason', () => {
    const path = makePath({ destinationHash: 'destHash1' });
    const result: ReticulumProbeResult = { destinationHash: 'destHash1', ok: false, rttMs: null, hops: null, error: 'no proof received' };
    renderView({ paths: [path], probeResult: result });

    const cell = screen.getByTestId('reticulum-path-probe-result-destHash1');
    expect(cell).toHaveTextContent('no proof received');
  });

  it('does not render a probe result on a row that was not probed', () => {
    const pathA = makePath({ destinationHash: 'destHashA' });
    const pathB = makePath({ destinationHash: 'destHashB' });
    const result: ReticulumProbeResult = { destinationHash: 'destHashA', ok: true, rttMs: 10, hops: 1, error: null };
    renderView({ paths: [pathA, pathB], probeResult: result });

    expect(screen.getByTestId('reticulum-path-probe-result-destHashA')).toBeInTheDocument();
    expect(screen.queryByTestId('reticulum-path-probe-result-destHashB')).not.toBeInTheDocument();
  });

  describe('remote-status panel', () => {
    it('disables the Query button until a hash is entered', () => {
      renderView();
      const queryBtn = screen.getByRole('button', { name: /query/i }) as HTMLButtonElement;
      expect(queryBtn.disabled).toBe(true);

      fireEvent.change(screen.getByPlaceholderText('Destination hash…'), { target: { value: 'remoteHashA' } });
      expect(queryBtn.disabled).toBe(false);
    });

    it('calls onQueryRemoteStatus with the trimmed hash', () => {
      const onQueryRemoteStatus = vi.fn().mockResolvedValue(null);
      renderView({ onQueryRemoteStatus });

      fireEvent.change(screen.getByPlaceholderText('Destination hash…'), { target: { value: '  remoteHashA  ' } });
      fireEvent.click(screen.getByRole('button', { name: /query/i }));

      expect(onQueryRemoteStatus).toHaveBeenCalledWith('remoteHashA');
    });

    it('shows a loading label and disables the button while querying', () => {
      renderView({ remoteStatusLoading: true });
      const queryBtn = screen.getByRole('button', { name: /querying/i }) as HTMLButtonElement;
      expect(queryBtn.disabled).toBe(true);
    });

    it('renders the interface/link/path-count summary for an ok remote status', () => {
      const status: ReticulumRemoteStatus = {
        destinationHash: 'remoteHashA',
        ok: true,
        status: { interfaces: [{ name: 'if0', type: 'TCP', status: 'up', online: true, txBytes: 0, rxBytes: 0 }], linkCount: 2 },
        path: [{ destinationHash: 'x', via: 'y', hops: 1, interface: 'if0', expires: 1 }],
        error: null,
      };
      renderView({ remoteStatus: status });

      const result = screen.getByTestId('reticulum-remote-status-result');
      expect(result).toHaveTextContent('1 interface(s)');
      expect(result).toHaveTextContent('2 link(s)');
      expect(result).toHaveTextContent('1 known path(s)');
    });

    it('renders the error reason for a failed remote status', () => {
      const status: ReticulumRemoteStatus = {
        destinationHash: 'remoteHashA',
        ok: false,
        status: null,
        path: null,
        error: 'link establishment timed out',
      };
      renderView({ remoteStatus: status });

      expect(screen.getByTestId('reticulum-remote-status-result')).toHaveTextContent('link establishment timed out');
    });
  });
});
