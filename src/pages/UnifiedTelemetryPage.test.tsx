/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UnifiedTelemetryPage from './UnifiedTelemetryPage';

const tempEntry = {
  nodeId: '!abcd1234',
  nodeNum: 1,
  telemetryType: 'temperature',
  value: 25, // Celsius from the device
  unit: '°C',
  timestamp: Date.now(),
  sourceId: 'src1',
  sourceName: 'Source One',
  nodeLongName: 'Test Node',
  nodeShortName: 'TN',
  favorited: false,
  canEditFavorite: false,
};

const seriesLine = (sourceId: string, sourceName: string, favorited = false, canEditFavorite = false) => ({
  sourceId,
  sourceName,
  unit: '°C',
  favorited,
  canEditFavorite,
  points: [{ timestamp: Date.now() - 60_000, value: 20 }],
});

const tempSeries = {
  subjectKey: '!abcd1234',
  nodeName: 'Weather Station',
  type: 'temperature',
  favoriteType: 'temperature',
  category: 'environment',
  observerRelative: false,
  lines: [seriesLine('src1', 'Roof', true, true), seriesLine('src2', 'MQTT')],
};

const batterySeries = {
  ...tempSeries,
  type: 'batteryLevel',
  favoriteType: 'batteryLevel',
  category: 'power',
  lines: [seriesLine('src2', 'MQTT')],
};

interface Mocks {
  entries?: unknown[];
  series?: unknown[];
  settings?: Record<string, string>;
}

type FetchMock = ReturnType<typeof vi.fn>;

function mockApi({ entries = [], series = [], settings = {} }: Mocks): FetchMock {
  const fn = vi.fn((url: string) => {
    const body = (() => {
      if (url.includes('/api/unified/telemetry/series')) return { success: true, data: { series } };
      if (url.includes('/api/unified/telemetry')) return entries;
      if (url.includes('/api/settings')) return settings;
      return {};
    })();
    return Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const calls = (fn: FetchMock, part: string) =>
  fn.mock.calls.filter(([url]) => typeof url === 'string' && url.includes(part));

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/telemetry']}>
        <UnifiedTelemetryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openLatest() {
  fireEvent.click(await screen.findByRole('tab', { name: 'unified.telemetry.view_latest' }));
}

beforeEach(() => {
  localStorage.clear();
  // jsdom implements neither of these — stub so the component can call them.
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('UnifiedTelemetryPage graphs view (default)', () => {
  it('opens on the graphs view and fetches the favorited series only', async () => {
    const fetchMock = mockApi({ series: [tempSeries] });
    renderPage();
    expect(await screen.findByTestId('combined-telemetry-chart')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'unified.telemetry.view_graphs' })).toHaveAttribute('aria-selected', 'true');
    expect(calls(fetchMock, '/api/unified/telemetry/series?hours=24')).toHaveLength(1);
    // The Latest snapshot is not polled while the graphs view is open.
    expect(calls(fetchMock, '/api/unified/telemetry?')).toHaveLength(0);
  });

  it('groups charts into category sections in dashboard order', async () => {
    mockApi({ series: [tempSeries, batterySeries] });
    renderPage();
    await screen.findAllByTestId('combined-telemetry-chart');
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(['telemetry.category.power', 'telemetry.category.environment']);
  });

  it('shows an empty state when nothing is favorited', async () => {
    mockApi({ series: [] });
    renderPage();
    expect(await screen.findByText('unified.telemetry.no_favorites')).toBeInTheDocument();
  });

  it('refetches on a range change and on refresh', async () => {
    const fetchMock = mockApi({ series: [tempSeries] });
    renderPage();
    await screen.findByTestId('combined-telemetry-chart');
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(calls(fetchMock, '/api/unified/telemetry/series?hours=168')).toHaveLength(1));
    expect(localStorage.getItem('unifiedTelemetryHours')).toBe('168');
    fireEvent.click(screen.getByRole('button', { name: 'unified.telemetry.refresh' }));
    await waitFor(() => expect(calls(fetchMock, '/api/unified/telemetry/series?hours=168')).toHaveLength(2));
  });

  it('the source filter keeps only that source\'s lines and drops charts left empty', async () => {
    mockApi({ series: [tempSeries, batterySeries] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('combined-telemetry-chart')).toHaveLength(2));
    fireEvent.change(screen.getByRole('combobox', { name: 'unified.telemetry.filter_source_aria' }), { target: { value: 'src1' } });
    const charts = screen.getAllByTestId('combined-telemetry-chart');
    expect(charts).toHaveLength(1);
    expect(within(charts[0]).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Roof']);
  });

  it('removing a favorite writes only the lists the viewer may edit', async () => {
    const fetchMock = mockApi({
      series: [tempSeries],
      settings: { telemetryFavorites: JSON.stringify([{ nodeId: '!abcd1234', telemetryType: 'temperature' }, { nodeId: '!x', telemetryType: 'voltage' }]) },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'telemetry.remove_favorite' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toContain('/api/settings?sourceId=src1');
    const body = JSON.parse((posts[0][1] as RequestInit).body as string);
    expect(JSON.parse(body.telemetryFavorites)).toEqual([{ nodeId: '!x', telemetryType: 'voltage' }]);
  });

  it('hides the remove-favorite button when no line is editable', async () => {
    mockApi({ series: [batterySeries] });
    renderPage();
    await screen.findByTestId('combined-telemetry-chart');
    expect(screen.queryByRole('button', { name: 'telemetry.remove_favorite' })).toBeNull();
  });
});

describe('UnifiedTelemetryPage Latest tab', () => {
  it('displays Celsius by default', async () => {
    mockApi({ entries: [tempEntry] });
    renderPage();
    await openLatest();
    await waitFor(() => {
      expect(screen.getByText('25.0')).toBeInTheDocument();
    });
    expect(screen.getByText('°C')).toBeInTheDocument();
  });

  it('converts the value and label to Fahrenheit when preference is F', async () => {
    localStorage.setItem('temperatureUnit', 'F');
    mockApi({ entries: [tempEntry] });
    renderPage();
    await openLatest();
    await waitFor(() => {
      // 25°C → 77°F, not "25 °F"
      expect(screen.getByText('77.0')).toBeInTheDocument();
    });
    expect(screen.getByText('°F')).toBeInTheDocument();
    expect(screen.queryByText('25.0')).not.toBeInTheDocument();
  });

  it('polls the snapshot every 60 seconds, not 15', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi({ entries: [tempEntry] });
    renderPage();
    await openLatest();
    await waitFor(() => expect(calls(fetchMock, '/api/unified/telemetry?hours=')).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls(fetchMock, '/api/unified/telemetry?hours=')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(45_000);
    await waitFor(() => expect(calls(fetchMock, '/api/unified/telemetry?hours=')).toHaveLength(2));
  });

  it('stars a reading onto its own source\'s favorites, only where the viewer may edit', async () => {
    const editable = { ...tempEntry, canEditFavorite: true };
    const readOnly = { ...tempEntry, nodeId: '!b', sourceId: 'src2', sourceName: 'Other', nodeLongName: 'Node B' };
    const fetchMock = mockApi({ entries: [editable, readOnly], settings: {} });
    renderPage();
    await openLatest();
    const stars = await screen.findAllByRole('button', { name: 'telemetry.add_favorite' });
    expect(stars).toHaveLength(1);
    fireEvent.click(stars[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'telemetry.remove_favorite' })).toHaveAttribute('aria-pressed', 'true'));
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toContain('/api/settings?sourceId=src1');
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(JSON.parse(body.telemetryFavorites)).toEqual([{ nodeId: '!abcd1234', telemetryType: 'temperature' }]);
  });

  describe('source navigation', () => {
    const srcA = { ...tempEntry, nodeId: '!a', nodeNum: 1, sourceId: 'src1', sourceName: 'RAK4631', nodeLongName: 'Node A' };
    const srcB = { ...tempEntry, nodeId: '!b', nodeNum: 2, sourceId: 'src2', sourceName: 'Heltec_V4', nodeLongName: 'Node B' };

    it('renders source legend entries as jump buttons', async () => {
      mockApi({ entries: [srcA, srcB] });
      renderPage();
      await openLatest();

      const pillA = await screen.findByRole('button', { name: 'RAK4631' });
      const pillB = await screen.findByRole('button', { name: 'Heltec_V4' });
      expect(pillA).toBeEnabled();
      expect(pillB).toBeEnabled();
      // i18n isn't loaded in tests, so the title resolves to the raw key — assert
      // the jump-to-source string was wired up rather than its translated value.
      expect(pillA).toHaveAttribute('title', 'unified.telemetry.jump_to_source');
    });

    it('scrolls to the section when a legend pill is clicked', async () => {
      mockApi({ entries: [srcA, srcB] });
      renderPage();
      await openLatest();

      const pillB = await screen.findByRole('button', { name: 'Heltec_V4' });
      fireEvent.click(pillB);

      expect(window.scrollTo).toHaveBeenCalled();
      expect(pillB).toHaveAttribute('aria-current', 'true');
    });
  });
});
