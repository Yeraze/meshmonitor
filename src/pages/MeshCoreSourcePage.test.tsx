/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the slice-4 per-source MeshCore page. Verifies the page
 * targets the nested `/api/sources/:id/meshcore/*` routes and that
 * connection-read permission gates the entire surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// react-i18next: passthrough so we can assert on default fallback text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      // Test-only synthetic fallback so unmatched keys don't render as `undefined`.
      return key;
    },
  }),
}));

// Initial-load helpers — DashboardPage's heavy SettingsContext needs the
// settings endpoint to resolve. Stub fetch to default per URL.
const originalFetch = globalThis.fetch;
let fetchUrls: string[];

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
    if (url.includes('/meshcore/status')) {
      return new Response(
        JSON.stringify({ success: true, data: { connected: false, deviceType: 0, deviceTypeName: 'unknown', config: null, localNode: null } }),
        { status: 200 },
      );
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
  useSettings: () => ({}),
}));

vi.mock('../components/ToastContainer', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

const sourceContext = { sourceId: 'mc-src-1' as string | null, sourceName: 'MC Test' as string | null };
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

import MeshCoreSourcePage from './MeshCoreSourcePage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MeshCoreSourcePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MeshCoreSourcePage', () => {
  it('hits the nested /api/sources/:id/meshcore/status route on mount', async () => {
    authValue.hasPermission = () => true;
    renderPage();
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/sources/mc-src-1/meshcore/status'))).toBe(true);
    });
  });

  it('shows a permission-denied message when connection:read is missing', async () => {
    authValue.hasPermission = () => false;
    renderPage();
    expect(
      await screen.findByText('You do not have permission to view this MeshCore source.'),
    ).toBeInTheDocument();
    // No status request should have been issued.
    expect(fetchUrls.some((u) => u.includes('/meshcore/status'))).toBe(false);
  });
});
