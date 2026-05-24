/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the per-source MQTT Broker detail page. Verifies tab
 * navigation (Map default, Settings on click), permission gating, and
 * that the Settings tab loads + submits the source PUT correctly.
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
    if (url.endsWith('/api/sources/broker-1')) {
      // GET single source — return broker config
      return new Response(
        JSON.stringify({
          id: 'broker-1',
          name: 'Test Broker',
          type: 'mqtt_broker',
          config: {
            listener: { port: 1883 },
            auth: { username: 'mm' },
            rootTopic: 'msh',
            zeroHopInjection: false,
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/sources/broker-1/status')) {
      return new Response(
        JSON.stringify({ connected: true, listening: true }),
        { status: 200 },
      );
    }
    if (url.includes('/api/sources/broker-1/nodes')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes('/api/sources/broker-1/')) {
      // /traceroutes, /neighbor-info, /channels — all return empty
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

// DashboardMap is a heavy leaflet component — replace with a marker we can find.
vi.mock('../components/Dashboard/DashboardMap', () => ({
  default: (props: { sourceId?: string | null }) => (
    <div data-testid="dashboard-map">map for {props.sourceId ?? 'no-source'}</div>
  ),
}));

const sourceContext = { sourceId: 'broker-1' as string | null, sourceName: 'Test Broker' as string | null };
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

import MqttBrokerSourcePage from './MqttBrokerSourcePage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/source/broker-1/']}>
        <MqttBrokerSourcePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MqttBrokerSourcePage', () => {
  it('renders Map and Settings tabs with Map as default', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Map' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    // Map content rendered by default
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-map')).toBeInTheDocument();
    });
  });

  it('switches to the Settings tab on click and loads broker config', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Listener port')).toHaveValue(1883);
    });
    expect(screen.getByLabelText('Username')).toHaveValue('mm');
    expect(screen.getByLabelText('Root topic')).toHaveValue('msh');
  });

  it('hides the surface when connection:read is denied', async () => {
    authValue.hasPermission = () => false;
    renderPage();
    expect(
      await screen.findByText('You do not have permission to view this source.'),
    ).toBeInTheDocument();
    // No status poll should have fired.
    expect(fetchCalls.some((c) => c.url.includes('/status'))).toBe(false);
  });

  it('PUTs the broker config on save', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Listener port')).toHaveValue(1883);
    });
    fireEvent.change(screen.getByLabelText('Root topic'), { target: { value: 'msh/US/LA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const putCall = fetchCalls.find(
        (c) => c.init?.method === 'PUT' && c.url.endsWith('/api/sources/broker-1'),
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall!.init!.body as string);
      expect(body.type).toBe('mqtt_broker');
      expect(body.config.rootTopic).toBe('msh/US/LA');
      // Password was left empty — omit from the auth object so server preserves it.
      expect(body.config.auth.password).toBeUndefined();
    });
  });
});
