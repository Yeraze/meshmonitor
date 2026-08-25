/**
 * @vitest-environment jsdom
 *
 * ReticulumInterfacesView (#3960 Phase 1b WP4).
 *
 * Covers: card rendering from `ReticulumInterfaceRow[]` (R1 fields only —
 * no airtime/channel-load/noise-floor/battery), online/offline chip states,
 * humanized tx/rx byte totals, the client-derived tx/rx-rate indicator
 * (pending on the first sample, computed once a second sample lands), and
 * a Dashboard-mount smoke test asserting the exact prop set mirrors
 * `MeshCoreTelemetryView`'s mount of the shared `Dashboard` component.
 */
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReticulumInterfacesView } from './ReticulumInterfacesView';
import type { ReticulumInterfaceRow } from '../../types/reticulum';

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
  useSettings: () => ({
    temperatureUnit: 'C',
    telemetryVisualizationHours: 48,
    favoriteTelemetryStorageDays: 7,
  }),
}));

// Capture the props Dashboard is mounted with instead of rendering the real
// (heavy) component — mirrors the "mount smoke" style used for
// MeshCoreTelemetryView elsewhere in the MeshCore surface.
const dashboardMountSpy = vi.fn();
vi.mock('../Dashboard/Dashboard', () => ({
  default: (props: Record<string, unknown>) => {
    dashboardMountSpy(props);
    return <div data-testid="dashboard-mock" />;
  },
}));

function makeInterface(overrides: Partial<ReticulumInterfaceRow> = {}): ReticulumInterfaceRow {
  return {
    sourceId: 'src-rns',
    interfaceName: 'RNodeInterface',
    interfaceType: 'RNodeInterface',
    interfaceHash: 'abc123',
    mode: 'full',
    status: 'up',
    online: true,
    bitrate: 128000,
    txBytes: 2048,
    rxBytes: 1024,
    lastSeenAt: 1700000000000,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

beforeEach(() => {
  hasPermissionMock.mockClear();
  dashboardMountSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderView(props: Partial<ComponentProps<typeof ReticulumInterfacesView>> = {}) {
  return render(
    <ReticulumInterfacesView
      interfaces={[]}
      baseUrl="/meshmonitor"
      sourceId="src-rns"
      {...props}
    />,
  );
}

describe('ReticulumInterfacesView', () => {
  it('renders the empty state when there are no interfaces', () => {
    renderView({ interfaces: [] });
    expect(screen.getByText('No interfaces reported yet.')).toBeInTheDocument();
  });

  it('renders the loading state while the first poll is in flight', () => {
    renderView({ interfaces: [], loading: true });
    expect(screen.getByText('Loading interfaces…')).toBeInTheDocument();
  });

  it('renders one card per interface with name, type, bitrate, and humanized tx/rx totals', () => {
    const iface = makeInterface({
      interfaceName: 'TCPInterface',
      interfaceType: 'TCPClientInterface',
      bitrate: 128000,
      txBytes: 2048,
      rxBytes: 1536 * 1024,
    });
    renderView({ interfaces: [iface] });

    const card = screen.getByTestId('reticulum-interface-card-TCPInterface');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('TCPInterface')).toBeInTheDocument();
    expect(screen.getByText('TCPClientInterface')).toBeInTheDocument();
    // 2048 B -> "2.00 KB"; 1536*1024 B -> "1.50 MB"
    expect(screen.getByText('2.00 KB')).toBeInTheDocument();
    expect(screen.getByText('1.50 MB')).toBeInTheDocument();
  });

  it('shows an online chip for an online interface and an offline chip for an offline one', () => {
    renderView({
      interfaces: [
        makeInterface({ interfaceName: 'IfaceUp', online: true, status: 'up' }),
        makeInterface({ interfaceName: 'IfaceDown', online: false, status: 'down' }),
      ],
    });

    expect(screen.getByTestId('reticulum-interface-chip-IfaceUp')).toHaveTextContent('Online');
    expect(screen.getByTestId('reticulum-interface-chip-IfaceDown')).toHaveTextContent('Offline');
  });

  it('falls back to an "Unknown type" label when interfaceType is null', () => {
    renderView({ interfaces: [makeInterface({ interfaceType: null })] });
    expect(screen.getByText('Unknown type')).toBeInTheDocument();
  });

  it('does NOT render Phase-3-only gauges (airtime, channel load, noise floor, battery)', () => {
    renderView({ interfaces: [makeInterface()] });
    // R1 descope check — these labels must never appear in 1b.
    ['airtime', 'channel load', 'noise floor', 'battery'].forEach((label) => {
      expect(screen.queryByText(new RegExp(label, 'i'))).not.toBeInTheDocument();
    });
  });

  it('shows "rate pending" on the first sample and a computed tx/rx rate once a second sample arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const first = makeInterface({ interfaceName: 'RNodeInterface', txBytes: 1000, rxBytes: 500 });
    const { rerender } = renderView({ interfaces: [first] });

    expect(screen.getByTestId('reticulum-interface-rate-RNodeInterface')).toHaveTextContent('Rate pending next poll…');

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    const second = makeInterface({ interfaceName: 'RNodeInterface', txBytes: 6000, rxBytes: 1500 });
    rerender(
      <ReticulumInterfacesView interfaces={[second]} baseUrl="/meshmonitor" sourceId="src-rns" />,
    );

    // (6000-1000)B / 5s = 1000 B/s; (1500-500)B / 5s = 200 B/s.
    const rateRow = screen.getByTestId('reticulum-interface-rate-RNodeInterface');
    expect(rateRow).toHaveTextContent('1000 B/s');
    expect(rateRow).toHaveTextContent('200 B/s');
  });

  it('mounts the shared Dashboard with the reticulum data source, mirroring MeshCoreTelemetryView\'s prop set', async () => {
    const { reticulumDashboardSource } = await import('../Dashboard/dataSources');
    renderView({ interfaces: [makeInterface()], baseUrl: '/meshmonitor' });

    expect(screen.getByTestId('dashboard-mock')).toBeInTheDocument();
    // Called at least once (a follow-up render from the rate-derivation
    // effect re-invokes children since the Dashboard mock, unlike the real
    // memoized component, isn't itself memoized) — assert on the props
    // Dashboard was actually mounted with, not the call count.
    expect(dashboardMountSpy).toHaveBeenCalled();
    const props = dashboardMountSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(props.baseUrl).toBe('/meshmonitor');
    expect(props.dataSource).toBe(reticulumDashboardSource);
    expect(props.temperatureUnit).toBe('C');
    expect(props.telemetryHours).toBe(48);
    expect(props.favoriteTelemetryStorageDays).toBe(7);
    expect(props.canEdit).toBe(true);
  });

  it('gates Dashboard canEdit on the dashboard:write permission, like MeshCoreTelemetryView', () => {
    hasPermissionMock.mockImplementation((resource: string, action: string) => !(resource === 'dashboard' && action === 'write'));
    renderView({ interfaces: [makeInterface()] });
    const props = dashboardMountSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(props.canEdit).toBe(false);
  });
});
