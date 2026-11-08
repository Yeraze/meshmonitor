/**
 * @vitest-environment jsdom
 *
 * #6262: virtual rows, load-more cursor, filter query string, contact click.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';

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
// jsdom has no layout: render every row and record load-more requests.
const loadMoreSpy = vi.fn();
vi.mock('../../hooks/useInfiniteVirtualRows', () => ({
  useInfiniteVirtualRows: (o: { count: number; hasMore: boolean; loadMore: () => void }) => {
    loadMoreSpy.mockImplementation(o.loadMore);
    const n = o.hasMore ? o.count + 1 : o.count;
    return {
      getVirtualItems: () => Array.from({ length: n }, (_, index) => ({ index, start: index * 36, key: index })),
      getTotalSize: () => n * 36,
    };
  },
}));

import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';

const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const pkt = (id: number, extra: Record<string, unknown> = {}) => ({
  id, timestamp: 1_790_000_000_000 - id, payloadType: 4, routeType: 1, hopCount: 0, snr: 5, rssi: -90, rawHex: '00', ...extra,
});

describe('MeshCorePacketMonitorView paging (#6262)', () => {
  beforeEach(() => {
    csrfFetchMock.mockReset();
  });

  it('loads the next page with the cursor and shows the total', async () => {
    csrfFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('cursor=')) {
        return json({ packets: [pkt(1)], total: 2, hasMore: false, nextCursor: null, enabled: true, maxCount: 1000, maxAgeHours: 24 });
      }
      return json({ packets: [pkt(2)], total: 2, hasMore: true, nextCursor: '1789999999998_2', enabled: true, maxCount: 1000, maxAgeHours: 24 });
    });
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" />);
    await waitFor(() => expect(screen.getAllByTestId('mcpm-row')).toHaveLength(1));
    expect(screen.getByText('2')).toBeInTheDocument(); // total in the header
    loadMoreSpy();
    await waitFor(() => expect(screen.getAllByTestId('mcpm-row')).toHaveLength(2));
    const urls = csrfFetchMock.mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes('cursor=1789999999998_2'))).toBe(true);
  });

  it('sends the payload filter in the query string', async () => {
    csrfFetchMock.mockImplementation(async () => json({ packets: [], total: 0, hasMore: false, enabled: true, maxCount: 1000, maxAgeHours: 24 }));
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle('Filters'));
    fireEvent.change(screen.getByLabelText('Payload'), { target: { value: '4' } });
    await waitFor(() => {
      expect(csrfFetchMock.mock.calls.some(c => (c[0] as string).includes('payload_type=4'))).toBe(true);
    });
  });

  it('calls onNodeClick when the From cell resolves to one contact', async () => {
    const key = 'ab'.repeat(32);
    csrfFetchMock.mockImplementation(async () =>
      json({ packets: [pkt(1, { srcHash: 'ab', senderPubKey: key, advertName: null })], total: 1, hasMore: false, enabled: true, maxCount: 1000, maxAgeHours: 24 }));
    const onNodeClick = vi.fn();
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" contacts={[{ publicKey: key, advName: 'Hilltop' }]} onNodeClick={onNodeClick} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hilltop' }));
    expect(onNodeClick).toHaveBeenCalledWith(key);
  });
});
