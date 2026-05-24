/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the per-source MQTT Bridge detail page. Verifies tab
 * navigation, settings loading (upstream, subscriptions, filters), and
 * the topic-rewrite placeholder rendered ahead of PR B (#3166).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url.endsWith('/api/sources/bridge-1')) {
      return new Response(
        JSON.stringify({
          id: 'bridge-1',
          name: 'TX Bridge',
          type: 'mqtt_bridge',
          config: {
            brokerSourceId: 'broker-1',
            upstream: { url: 'mqtt://mqtt.meshtastic.org', username: 'meshdev' },
            subscriptions: ['msh/US/TX/#'],
            downlinkFilters: {
              topics: { block: ['msh/CA/#'] },
              geo: { minLat: 29.5, maxLat: 30.2, minLng: -95.8, maxLng: -95.0 },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/sources')) {
      // List used for populating the parent-broker dropdown
      return new Response(
        JSON.stringify([
          { id: 'broker-1', name: 'Local Broker', type: 'mqtt_broker' },
          { id: 'bridge-1', name: 'TX Bridge', type: 'mqtt_bridge' },
        ]),
        { status: 200 },
      );
    }
    if (url.includes('/api/sources/bridge-1/status')) {
      return new Response(JSON.stringify({ connected: true, upstreamConnected: true }), { status: 200 });
    }
    if (url.includes('/api/sources/bridge-1/')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

vi.mock('../contexts/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSettings: () => ({
    mapTileset: 'osm',
    customTilesets: [],
    defaultMapCenterLat: 30,
    defaultMapCenterLon: -90,
    maxNodeAgeHours: 24,
  }),
}));

vi.mock('../contexts/MapContext', () => ({
  MapProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMapContext: () => ({}),
}));

vi.mock('../components/ToastContainer', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ showToast: vi.fn(), toasts: [] }),
}));

vi.mock('../components/LoginModal', () => ({ default: () => null }));
vi.mock('../components/UserMenu', () => ({ default: () => null }));

vi.mock('../components/Dashboard/DashboardMap', () => ({
  default: (props: { sourceId?: string | null }) => (
    <div data-testid="dashboard-map">map for {props.sourceId ?? 'no-source'}</div>
  ),
}));

const sourceContext = { sourceId: 'bridge-1' as string | null, sourceName: 'TX Bridge' as string | null };
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => sourceContext,
}));

const authValue: { authStatus: any; hasPermission: (r: string, a: string) => boolean } = {
  authStatus: { authenticated: true, user: { isAdmin: true } },
  hasPermission: () => true,
};
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authValue,
}));

vi.mock('../contexts/CsrfContext', () => ({
  useCsrf: () => ({ getToken: () => 'csrf-token' }),
}));

import MqttBridgeSourcePage from './MqttBridgeSourcePage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/source/bridge-1/']}>
        <MqttBridgeSourcePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MqttBridgeSourcePage', () => {
  it('renders Map and Settings tabs', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Map' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-map')).toBeInTheDocument();
    });
  });

  it('loads bridge config into Settings fields', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Upstream URL')).toHaveValue('mqtt://mqtt.meshtastic.org');
    });
    expect(screen.getByLabelText('Username')).toHaveValue('meshdev');
    expect(screen.getByLabelText('Upstream topics')).toHaveValue('msh/US/TX/#');
  });

  it('renders topic-rewrite fields for attached bridges (#3166)', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    // Two from/to pairs (downlink + uplink) — at least one each.
    await waitFor(() => {
      expect(screen.getAllByLabelText('From prefix').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getAllByLabelText('To prefix').length).toBeGreaterThanOrEqual(2);
  });

  it('hides the surface when connection:read is denied', async () => {
    authValue.hasPermission = () => false;
    renderPage();
    expect(
      await screen.findByText('You do not have permission to view this source.'),
    ).toBeInTheDocument();
  });

  it('shows the standalone-warning when no parent broker is configured (#3166)', async () => {
    authValue.hasPermission = () => true;
    // Override the GET to return a standalone bridge.
    const originalMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    (globalThis.fetch as ReturnType<typeof vi.fn>) = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/sources/bridge-1')) {
        return new Response(
          JSON.stringify({
            id: 'bridge-1',
            name: 'Standalone',
            type: 'mqtt_bridge',
            config: {
              upstream: { url: 'mqtt://x.example.com' },
              subscriptions: ['msh/#'],
            },
          }),
          { status: 200 },
        );
      }
      return originalMock(input, init);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(
      await screen.findByText(/Topic rewriting requires a parent broker/),
    ).toBeInTheDocument();
    // Rewrite inputs must NOT render in the standalone case.
    expect(screen.queryByLabelText('From prefix')).toBeNull();
  });
});
