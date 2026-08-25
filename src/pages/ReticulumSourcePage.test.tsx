/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the per-source Reticulum page (#3960 Phase 1b WP2).
 * Mirrors `MeshCoreSourcePage.test.tsx`: verifies the page targets the
 * nested `/api/sources/:id/reticulum/*` routes, that `nodes:read`
 * permission gates the entire surface, and that the connection chip
 * reflects `useReticulum`'s status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// react-i18next: passthrough so we can assert on default fallback text.
// Also interpolates `{{var}}` placeholders against a trailing options object
// (ReticulumPage's status/placeholder strings use the 3-arg
// `t(key, fallback, { var })` form), since a raw-fallback-only mock would
// otherwise leave "{{count}} destinations" un-interpolated in assertions.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const fallbackStr = typeof fallback === 'string' ? fallback : key;
      const vars = typeof fallback === 'object' && fallback !== null ? fallback : options;
      if (vars && typeof vars === 'object') {
        return fallbackStr.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => (
          Object.prototype.hasOwnProperty.call(vars, varName) ? String((vars as Record<string, unknown>)[varName]) : `{{${varName}}}`
        ));
      }
      return fallbackStr;
    },
  }),
}));

// Initial-load helpers — DashboardPage's heavy SettingsContext needs the
// settings endpoint to resolve. Stub fetch to default per URL.
const originalFetch = globalThis.fetch;
let fetchUrls: string[];

function defaultStatusResponse() {
  return new Response(
    JSON.stringify({
      success: true,
      data: { connected: false, interfaceCount: 0, destinationCount: 0 },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  fetchUrls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchUrls.push(url);
    if (url.includes('/api/settings')) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes('/api/auth/csrf-token')) {
      return new Response(JSON.stringify({ token: 't' }), { status: 200 });
    }
    if (url.includes('/reticulum/status')) {
      return defaultStatusResponse();
    }
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSettings: () => ({}),
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../contexts/MapContext', () => ({
  MapProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));

vi.mock('../components/ToastContainer', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../components/LoginModal', () => ({
  default: () => null,
}));

vi.mock('../components/UserMenu', () => ({
  default: () => null,
}));

vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => globalThis.fetch,
}));

// Mock the WebSocket context so we don't open a real Socket.io connection
// during these smoke tests.
vi.mock('../contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWebSocketContext: () => ({
    state: { connected: false, socketId: null, error: null, socket: null },
    enabled: false,
  }),
  useWebSocketConnected: () => false,
}));

const sourceContext = { sourceId: 'rns-src-1' as string | null, sourceName: 'RNS Test' as string | null };
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => sourceContext,
}));

const authValue: { authStatus: any; hasPermission: (r: string, a: string) => boolean } = {
  authStatus: { authenticated: true, user: { isAdmin: false } },
  hasPermission: () => true,
};
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authValue,
}));

import ReticulumSourcePage from './ReticulumSourcePage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReticulumSourcePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReticulumSourcePage', () => {
  it('hits the nested /api/sources/:id/reticulum/status route on mount', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/sources/rns-src-1/reticulum/status'))).toBe(true);
    });
  });

  it('shows a permission-denied message when nodes:read is missing', async () => {
    authValue.hasPermission = () => false;
    renderPage();
    expect(
      await screen.findByText('You do not have permission to view this Reticulum source.'),
    ).toBeInTheDocument();
    // No reticulum requests should have been issued.
    expect(fetchUrls.some((u) => u.includes('/reticulum/status'))).toBe(false);
    expect(fetchUrls.some((u) => u.includes('/reticulum/destinations'))).toBe(false);
    expect(fetchUrls.some((u) => u.includes('/reticulum/interfaces'))).toBe(false);
  });

  it('regression #4828: still shows the sign-in button when logged out and lacking nodes:read', async () => {
    // A logged-out visitor landing directly on a source (e.g. via the
    // default-landing-page setting) must still be able to sign in — the
    // permission-denied message must not black out the whole page.
    authValue.authStatus = { authenticated: false, user: null };
    authValue.hasPermission = () => false;
    renderPage();
    expect(
      await screen.findByText('You do not have permission to view this Reticulum source.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'source.topbar.sign_in' })).toBeInTheDocument();
    authValue.authStatus = { authenticated: true, user: { isAdmin: false } };
  });

  it('shows Disconnected after status returns connected=false', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });
  });

  it('shows Connected after status returns connected=true', async () => {
    authValue.hasPermission = () => true;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchUrls.push(url);
      if (url.includes('/api/settings')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/api/auth/csrf-token')) {
        return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      }
      if (url.includes('/reticulum/status')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { connected: true, mode: 'attach', interfaceCount: 2, destinationCount: 5 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });
  });

  it('mounts ReticulumPage content (destinations view) by default', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    // The destinations view is the default; assert its search box renders
    // (the real ReticulumDestinationsView, not the old placeholder).
    await waitFor(() => {
      expect(screen.getByLabelText('Search destinations…')).toBeInTheDocument();
    });
  });

  it('renders the Settings view without a SaveBarProvider crash', async () => {
    // Regression for #3960: ReticulumSettingsView calls useSaveBar, so the
    // page must wrap the settings slot in a SaveBarProvider — otherwise
    // switching to Settings threw "useSaveBarContext must be used within a
    // SaveBarProvider" and blanked the view (caught in browser validation).
    authValue.hasPermission = () => true;
    renderPage();
    const settingsTab = await screen.findByRole('button', { name: 'Settings' });
    fireEvent.click(settingsTab);
    expect(await screen.findByText('Destination retention cap')).toBeInTheDocument();
  });

  it('mounts ReticulumDmsView (Phase 2 WP5) when the Messages nav item is selected', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    const dmsTab = await screen.findByRole('button', { name: 'Messages' });
    fireEvent.click(dmsTab);
    // The default-fetch mock resolves every unmatched route (incl.
    // /reticulum/messages, the conversations list) with an empty array, so
    // the empty-conversations state is what a real disconnected/no-history
    // source would show.
    expect(await screen.findByTestId('reticulum-dms-view')).toBeInTheDocument();
    expect(await screen.findByTestId('reticulum-dms-empty')).toHaveTextContent('No conversations yet.');
  });

  it('hits the nested /reticulum/messages route when the Messages nav item is selected', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    const dmsTab = await screen.findByRole('button', { name: 'Messages' });
    fireEvent.click(dmsTab);
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/sources/rns-src-1/reticulum/messages'))).toBe(true);
    });
  });
});
