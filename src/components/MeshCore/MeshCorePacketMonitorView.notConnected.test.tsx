/**
 * @vitest-environment jsdom
 *
 * #4173 review N5: a source with no running manager shows the shared
 * "not connected" empty state, not "HTTP 404".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: null } }),
}));
vi.mock('../../hooks/useInfiniteVirtualRows', () => ({
  useInfiniteVirtualRows: (o: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * 36, key: index })),
    getTotalSize: () => o.count * 36,
  }),
}));

import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';

const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const notConnected = () => new Response(
  JSON.stringify({ success: false, error: 'No MeshCore manager for source mc-1', code: 'SOURCE_NOT_CONNECTED' }),
  { status: 404, headers: { 'content-type': 'application/json' } },
);

describe('MeshCorePacketMonitorView — source not connected (#4173 N5)', () => {
  beforeEach(() => {
    csrfFetchMock.mockReset();
  });

  it('shows the not-connected state instead of the raw HTTP status', async () => {
    csrfFetchMock.mockImplementation(async () => notConnected());
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" />);
    expect(await screen.findByTestId('source-not-connected')).toBeInTheDocument();
    expect(screen.queryByText('HTTP 404')).not.toBeInTheDocument();
  });

  it('still shows other load errors as text', async () => {
    csrfFetchMock.mockImplementation(async () => new Response('oops', { status: 500 }));
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" />);
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
    expect(screen.queryByTestId('source-not-connected')).not.toBeInTheDocument();
  });
});
