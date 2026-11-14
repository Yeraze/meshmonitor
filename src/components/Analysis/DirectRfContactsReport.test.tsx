/**
 * @vitest-environment jsdom
 *
 * Direct RF Contacts report (#6210): source picker, presets, sorting, CSV.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const get = vi.fn();
const download = vi.fn();

// The spy never rejects (vitest reports a spy-tracked rejection as
// unhandled); a returned Error is thrown by the async wrapper instead.
vi.mock('../../services/api', () => ({
  default: {
    get: async (...a: unknown[]) => {
      const res = await get(...a);
      if (res instanceof Error) throw res;
      return res;
    },
    setBaseUrl: vi.fn(),
  },
}));
vi.mock('../../utils/nodeExport', async (orig) => ({
  ...(await orig<typeof import('../../utils/nodeExport')>()),
  downloadTextFile: (...a: unknown[]) => download(...a),
}));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../icons', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import DirectRfContactsReport from './DirectRfContactsReport';

const SOURCES = [
  { id: 'mt-1', name: 'Home', type: 'meshtastic_tcp' },
  { id: 'mqtt-1', name: 'Broker', type: 'mqtt_broker' },
  { id: 'mc-1', name: 'Companion', type: 'meshcore' },
];

const contact = (o: Record<string, unknown>) => ({
  nodeKey: '!aaaaaaaa', nodeNum: 1, protocol: 'meshtastic', name: 'Alpha', shortName: 'AL',
  firstHeardAt: Date.UTC(2026, 0, 1), lastHeardAt: Date.UTC(2026, 0, 2), receptionCount: 4, daysHeard: 2,
  bestSnr: 6, avgSnr: 4.5, bestRssi: -80, avgRssi: -88, distanceKm: 2.5, ...o,
});

function respond(contacts: unknown[]) {
  get.mockImplementation(async (url: string) => {
    if (url === '/api/sources') return SOURCES;
    const m = /from=(\d+)&to=(\d+)/.exec(url);
    return { success: true, data: { sourceId: 'x', from: Number(m?.[1]), to: Number(m?.[2]), retentionDays: 30, contacts } };
  });
}

beforeEach(() => {
  get.mockReset();
  download.mockReset();
});

describe('DirectRfContactsReport', () => {
  it('offers only Meshtastic TCP and MeshCore sources, and loads the first for 7 days', async () => {
    respond([contact({})]);
    render(<DirectRfContactsReport />);
    const select = await screen.findByTestId('direct-rf-source');
    await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Home', 'Companion']));
    await screen.findByTestId('direct-rf-table');
    const url = get.mock.calls.map((c) => c[0] as string).find((u) => u.includes('/direct-rf-contacts'))!;
    expect(url).toMatch(/^\/api\/sources\/mt-1\/direct-rf-contacts\?from=\d+&to=\d+$/);
    const [, from, to] = /from=(\d+)&to=(\d+)/.exec(url)!.map(Number);
    expect(to - from).toBe(7 * 86_400_000);
  });

  it('switches source and preset', async () => {
    respond([]);
    render(<DirectRfContactsReport />);
    await screen.findByTestId('direct-rf-empty');
    fireEvent.change(screen.getByTestId('direct-rf-source'), { target: { value: 'mc-1' } });
    await waitFor(() => expect(get.mock.calls.some((c) => String(c[0]).startsWith('/api/sources/mc-1/direct-rf-contacts'))).toBe(true));
    fireEvent.click(screen.getByTestId('direct-rf-preset-24h'));
    await waitFor(() => {
      const last = String(get.mock.calls[get.mock.calls.length - 1][0]);
      const [, from, to] = /from=(\d+)&to=(\d+)/.exec(last)!.map(Number);
      expect(to - from).toBe(86_400_000);
    });
  });

  it('renders rows, sorts on a header click, and exports CSV', async () => {
    respond([
      contact({ nodeKey: '!aaaaaaaa', name: 'Alpha', receptionCount: 4, lastHeardAt: Date.UTC(2026, 0, 2) }),
      contact({ nodeKey: '!bbbbbbbb', name: 'Bravo', receptionCount: 9, lastHeardAt: Date.UTC(2026, 0, 1), distanceKm: null }),
    ]);
    render(<DirectRfContactsReport />);
    const table = await screen.findByTestId('direct-rf-table');
    const keys = () => within(table).getAllByRole('row').slice(1).map((r) => r.getAttribute('data-testid'));
    expect(keys()).toEqual(['direct-rf-row-!aaaaaaaa', 'direct-rf-row-!bbbbbbbb']); // last heard, newest first
    fireEvent.click(screen.getByTestId('direct-rf-sort-receptionCount'));
    expect(keys()).toEqual(['direct-rf-row-!bbbbbbbb', 'direct-rf-row-!aaaaaaaa']);
    expect(within(screen.getByTestId('direct-rf-row-!bbbbbbbb')).getAllByRole('cell').at(-1)!.textContent).toBe('—');
    expect(within(screen.getByTestId('direct-rf-row-!aaaaaaaa')).getAllByRole('cell').at(-1)!.textContent).toBe('2.5 km');

    fireEvent.click(screen.getByTestId('direct-rf-export'));
    expect(download).toHaveBeenCalledTimes(1);
    const [name, csv, mime] = download.mock.calls[0];
    expect(name).toMatch(/^direct-rf-contacts_Home_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(mime).toContain('text/csv');
    expect((csv as string).split('\r\n')[1]).toContain('!bbbbbbbb,Bravo');
  });

  it('shows an error instead of an empty table when the request fails', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/api/sources') return SOURCES;
      return new Error('Forbidden');
    });
    render(<DirectRfContactsReport />);
    expect((await screen.findByTestId('direct-rf-error')).textContent).toBe('Forbidden');
    expect(screen.queryByTestId('direct-rf-empty')).toBeNull();
  });

  it('says so when no source can feed the report', async () => {
    get.mockImplementation(async () => [{ id: 'mqtt-1', name: 'Broker', type: 'mqtt_broker' }]);
    render(<DirectRfContactsReport />);
    expect(await screen.findByTestId('direct-rf-no-sources')).toBeTruthy();
  });

  it('waits for both custom dates before loading', async () => {
    respond([]);
    render(<DirectRfContactsReport />);
    await screen.findByTestId('direct-rf-empty');
    const before = get.mock.calls.length;
    fireEvent.click(screen.getByTestId('direct-rf-preset-custom'));
    fireEvent.change(screen.getByTestId('direct-rf-from'), { target: { value: '2026-02-01' } });
    expect(get.mock.calls.length).toBe(before);
    fireEvent.change(screen.getByTestId('direct-rf-to'), { target: { value: '2026-02-03' } });
    await waitFor(() => expect(get.mock.calls.length).toBe(before + 1));
    const last = String(get.mock.calls[get.mock.calls.length - 1][0]);
    expect(last).toContain(`from=${new Date('2026-02-01T00:00:00').getTime()}`);
  });
});
