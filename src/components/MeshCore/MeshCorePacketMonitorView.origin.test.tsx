/**
 * @vitest-environment jsdom
 *
 * #6265: the Packet Monitor From column names the origin node and marks TX/RX.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

let hasPermissionImpl: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => hasPermissionImpl(r, a) }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: null } }),
}));

// jsdom has no layout: render every row.
vi.mock('../../hooks/useInfiniteVirtualRows', () => ({
  useInfiniteVirtualRows: (o: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * 36, key: index })),
    getTotalSize: () => o.count * 36,
  }),
}));

import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
  );

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'ab'.repeat(32); // shares no hash with A
const KEY_C1 = '2f' + '01'.repeat(31);
const KEY_C2 = '2f' + '02'.repeat(31);
const contact = (publicKey: string, name: string) => ({ publicKey, advName: name, name } as never);
const row = (o: Record<string, unknown>) => ({
  id: 1, timestamp: 1_700_000_000_000, payloadType: 4, payloadTypeName: 'ADVERT', routeType: 1,
  hopCount: 0, snr: 1, rssi: -50, payloadSize: 10, pathHops: null, ...o,
});
async function show(packets: unknown[], contacts: unknown[] = []) {
  csrfFetchMock.mockImplementation(async () => jsonResponse({ packets, total: packets.length, enabled: true, maxCount: 1000, maxAgeHours: 24 }));
  render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" contacts={contacts as never} />);
  await waitFor(() => expect(screen.getAllByTestId('mcpm-row').length).toBe(packets.length));
}
describe('MeshCorePacketMonitorView origin column (#6265)', () => {
  beforeEach(() => {
    csrfFetchMock.mockReset();
    hasPermissionImpl = () => true;
  });
  it('names an ADVERT sender from the frame', async () => {
    await show([row({ senderPubKey: KEY_A, srcHash: 'aa', advertName: 'Hilltop' })]);
    expect(screen.getByText('Hilltop')).toBeTruthy();
  });
  it('resolves a bare hash only when exactly one contact owns it', async () => {
    await show([row({ payloadType: 2, payloadTypeName: 'TXT_MSG', srcHash: 'aa' })], [contact(KEY_A, 'Alpha'), contact(KEY_B, 'Bravo')]);
    expect(screen.getByText('Alpha')).toBeTruthy();
  });
  it('leaves an ambiguous hash unnamed', async () => {
    await show([row({ payloadType: 2, payloadTypeName: 'TXT_MSG', srcHash: '2f' })], [contact(KEY_C1, 'One'), contact(KEY_C2, 'Two')]);
    expect(screen.getByText('0x2f?')).toBeTruthy();
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.queryByText('Two')).toBeNull();
  });
  it('shows the bare hash for an unknown sender', async () => {
    await show([row({ payloadType: 2, payloadTypeName: 'TXT_MSG', srcHash: '77' })], [contact(KEY_A, 'Alpha')]);
    expect(screen.getByText('0x77')).toBeTruthy();
  });
  it('shows no name to a viewer without nodes:read', async () => {
    hasPermissionImpl = (r) => r !== 'nodes';
    await show(
      [
        row({ id: 1, senderPubKey: KEY_A, srcHash: 'aa', advertName: 'Hilltop' }),
        row({ id: 2, payloadType: 2, payloadTypeName: 'TXT_MSG', srcHash: 'ab' }),
      ],
      [contact(KEY_B, 'Bravo')],
    );
    expect(screen.queryByText('Hilltop')).toBeNull();
    expect(screen.queryByText('Bravo')).toBeNull();
    expect(screen.getByText('0x' + 'ab')).toBeTruthy();
  });
  it('marks own TX when the observer is the sender, RX otherwise', async () => {
    await show([
      row({ id: 1, senderPubKey: KEY_A, srcHash: 'aa', advertName: 'Hilltop', observerId: KEY_A }),
      row({ id: 2, senderPubKey: KEY_A, srcHash: 'aa', advertName: 'Hilltop', observerId: KEY_B }),
      row({ id: 3, senderPubKey: KEY_A, srcHash: 'aa', advertName: 'Hilltop', observerId: null }),
    ]);
    expect(screen.getAllByTestId('mcpm-dir-tx').length).toBe(1);
    expect(screen.getAllByTestId('mcpm-dir-rx').length).toBe(2);
  });
});
