/**
 * @vitest-environment jsdom
 *
 * Regression tests for #2914: per-source `tracerouteIntervalMinutes` was being
 * shadowed by the global prop, so after a save + reload the checkbox snapped
 * back to "off" even while the per-source scheduler kept running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AutoTracerouteSection from './AutoTracerouteSection';
import { SourceProvider } from '../contexts/SourceContext';

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
  ToastContainer: () => null,
}));

const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: any) => mockUseSaveBar(opts),
}));

describe('AutoTracerouteSection — per-source interval reload (#2914)', () => {
  const defaultFilterResponse = {
    enabled: false,
    nodeNums: [],
    filterChannels: [],
    filterRoles: [],
    filterHwModels: [],
    filterNameRegex: '.*',
    filterNodesEnabled: true,
    filterChannelsEnabled: true,
    filterRolesEnabled: true,
    filterHwModelsEnabled: true,
    filterRegexEnabled: true,
    filterLastHeardEnabled: true,
    filterLastHeardHours: 168,
    filterHopsEnabled: false,
    filterHopsMin: 0,
    filterHopsMax: 10,
    expirationHours: 24,
    sortByHops: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockApi(opts: { tracerouteIntervalMinutes?: string | undefined }) {
    mockCsrfFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings/traceroute-nodes')) {
        return Promise.resolve({ ok: true, json: async () => defaultFilterResponse });
      }
      if (url.includes('/api/settings/traceroute-log')) {
        return Promise.resolve({ ok: true, json: async () => ({ log: [] }) });
      }
      if (url.includes('/api/settings')) {
        const body: Record<string, unknown> = {
          tracerouteScheduleEnabled: 'false',
          tracerouteScheduleStart: '00:00',
          tracerouteScheduleEnd: '00:00',
        };
        if (opts.tracerouteIntervalMinutes !== undefined) {
          body.tracerouteIntervalMinutes = opts.tracerouteIntervalMinutes;
        }
        return Promise.resolve({ ok: true, json: async () => body });
      }
      if (url.includes('/api/nodes')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
  }

  it('uses per-source tracerouteIntervalMinutes even when the prop is 0', async () => {
    // Server stored `15` per-source, but the global GET that powers the prop
    // returns nothing → parent passes 0. UI must still hydrate from per-source.
    mockApi({ tracerouteIntervalMinutes: '15' });

    const onIntervalChange = vi.fn();
    render(
      <SourceProvider sourceId="src-1" sourceName="Source 1">
        <AutoTracerouteSection
          intervalMinutes={0}
          baseUrl=""
          onIntervalChange={onIntervalChange}
        />
      </SourceProvider>
    );

    const intervalInput = await screen.findByDisplayValue('15');
    expect((intervalInput as HTMLInputElement).id).toBe('tracerouteInterval');

    // The master "enable" checkbox is the first checkbox in the section header.
    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);

    // No spurious "unsaved changes" — baseline matches the per-source value.
    await waitFor(() => {
      expect(mockUseSaveBar).toHaveBeenCalled();
    });
    const lastCall = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
    expect(lastCall.hasChanges).toBe(false);
  });

  it('falls back to the prop when per-source value is missing', async () => {
    mockApi({ tracerouteIntervalMinutes: undefined });

    render(
      <SourceProvider sourceId="src-1" sourceName="Source 1">
        <AutoTracerouteSection
          intervalMinutes={20}
          baseUrl=""
          onIntervalChange={vi.fn()}
        />
      </SourceProvider>
    );

    const intervalInput = await screen.findByDisplayValue('20');
    expect((intervalInput as HTMLInputElement).id).toBe('tracerouteInterval');

    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });
});

/**
 * Per-filter combine modes and the channel picker (#5230).
 *
 * The feature exists for operators who run one preset per channel and want to
 * scope auto-traceroute to one of them. Two things make that workable and both
 * are easy to regress: the mode really persists as 'and', and the picker shows
 * channel NAMES — `nodes.channel` mixes device slots (0-7) with Channel
 * Database ids (>= 100), so a picker rendering "Ch 102" is unusable for exactly
 * the workflow this serves.
 */
describe('AutoTracerouteSection — filter combine modes (#5230)', () => {
  const filterResponse = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    nodeNums: [],
    filterChannels: [],
    filterRoles: [],
    filterHwModels: [],
    filterNameRegex: '.*',
    filterNodesEnabled: true,
    filterChannelsEnabled: true,
    filterRolesEnabled: true,
    filterHwModelsEnabled: true,
    filterRegexEnabled: true,
    filterLastHeardEnabled: false,
    filterLastHeardHours: 168,
    filterHopsEnabled: false,
    filterHopsMin: 0,
    filterHopsMax: 10,
    expirationHours: 24,
    sortByHops: false,
    ...over,
  });

  const NODES = [
    { nodeNum: 1, nodeId: '!00000001', longName: 'A', channel: 163, hopsAway: 1 },
    { nodeNum: 2, nodeId: '!00000002', longName: 'B', channel: 102, hopsAway: 1 },
    { nodeNum: 3, nodeId: '!00000003', longName: 'C', hopsAway: 1 }, // no channel
  ];

  function mockApi(over: Record<string, unknown> = {}) {
    mockCsrfFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/api/settings/traceroute-nodes')) {
        if (init?.method === 'POST') {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        }
        return Promise.resolve({ ok: true, json: async () => filterResponse(over) });
      }
      if (url.includes('/api/settings/traceroute-log')) {
        return Promise.resolve({ ok: true, json: async () => ({ log: [] }) });
      }
      if (url.includes('/api/channel-database')) {
        // The real endpoint always returns the { success, count, data } envelope.
        return Promise.resolve({ ok: true, json: async () => ({ success: true, count: 2, data: [{ id: 63, name: 'LongTurbo' }, { id: 2, name: 'LongFast' }] }) });
      }
      if (url.includes('/api/channels')) {
        return Promise.resolve({ ok: true, json: async () => [{ id: 0, name: 'Primary' }] });
      }
      if (url.includes('/api/settings')) {
        return Promise.resolve({ ok: true, json: async () => ({ tracerouteScheduleEnabled: 'false' }) });
      }
      if (url.includes('/api/nodes')) {
        return Promise.resolve({ ok: true, json: async () => NODES });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
  }

  const renderSection = () => render(
    <SourceProvider sourceId="src-1" sourceName="Source 1">
      <AutoTracerouteSection intervalMinutes={15} baseUrl="" onIntervalChange={vi.fn()} />
    </SourceProvider>
  );

  /** The filter sections start collapsed; the picker only mounts when open. */
  async function expandChannels() {
    const header = await screen.findByText('automation.auto_traceroute.filter_by_channel');
    fireEvent.click(header);
  }

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('defaults every filter to OR, preserving pre-#5230 behaviour', async () => {
    mockApi();
    renderSection();

    const group = await screen.findByTestId('traceroute-mode-channels');
    const [or, and] = Array.from(group.querySelectorAll('button'));
    expect(or.getAttribute('aria-pressed')).toBe('true');
    expect(and.getAttribute('aria-pressed')).toBe('false');
  });

  it('hydrates a stored and mode', async () => {
    mockApi({ filterChannelsMode: 'and' });
    renderSection();

    const group = await screen.findByTestId('traceroute-mode-channels');
    const and = Array.from(group.querySelectorAll('button'))[1];
    await waitFor(() => expect(and.getAttribute('aria-pressed')).toBe('true'));
  });

  it('reads an unrecognised stored mode as OR rather than failing', async () => {
    // Mirrors the server-side parse. A junk value must not leave the toggle in
    // a third state the user cannot reason about.
    mockApi({ filterChannelsMode: 'AND' });
    renderSection();

    const group = await screen.findByTestId('traceroute-mode-channels');
    const [or] = Array.from(group.querySelectorAll('button'));
    await waitFor(() => expect(or.getAttribute('aria-pressed')).toBe('true'));
  });

  it('gives every one of the five filters its own mode toggle', async () => {
    mockApi();
    renderSection();
    for (const id of ['nodes', 'channels', 'roles', 'hwmodels', 'regex']) {
      expect(await screen.findByTestId(`traceroute-mode-${id}`)).toBeTruthy();
    }
  });

  it('names channels instead of printing raw ids', async () => {
    // 163 = CHANNEL_DB_OFFSET + 63 → "LongTurbo"; 102 → "LongFast". Without the
    // lookup these render as "Ch 163"/"Ch 102", which is the id space leaking
    // into the UI.
    mockApi();
    const { container } = renderSection();
    await expandChannels();

    await waitFor(() => expect(container.textContent).toContain('LongTurbo'));
    expect(container.textContent).toContain('LongFast');
    expect(container.textContent).not.toContain('Ch 163');
  });

  it('warns how many nodes an AND channel scope excludes', async () => {
    // One of the three fixture nodes has no channel. Under AND it silently
    // drops out of the pool; the count makes that visible.
    mockApi({ filterChannelsMode: 'and', filterChannels: [163] });
    renderSection();
    await expandChannels();

    // `t()` echoes the key in this harness, so the interpolated count is not
    // visible here — what is worth pinning is the condition that renders it.
    expect(await screen.findByTestId('traceroute-channel-unknown-warning')).toBeTruthy();
  });

  it('shows no exclusion warning when every node has a known channel', async () => {
    // Guards the `nodesWithoutChannel > 0` half of the condition: a warning that
    // always shows under AND would train users to ignore it.
    mockCsrfFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/api/settings/traceroute-nodes')) {
        if (init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        return Promise.resolve({ ok: true, json: async () => filterResponse({ filterChannelsMode: 'and', filterChannels: [163] }) });
      }
      if (url.includes('/api/settings/traceroute-log')) return Promise.resolve({ ok: true, json: async () => ({ log: [] }) });
      if (url.includes('/api/channel-database')) return Promise.resolve({ ok: true, json: async () => ({ success: true, count: 1, data: [{ id: 63, name: 'LongTurbo' }] }) });
      if (url.includes('/api/channels')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url.includes('/api/settings')) return Promise.resolve({ ok: true, json: async () => ({ tracerouteScheduleEnabled: 'false' }) });
      if (url.includes('/api/nodes')) {
        return Promise.resolve({ ok: true, json: async () => NODES.filter(n => n.channel !== undefined) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    renderSection();
    await expandChannels();

    await screen.findByTestId('traceroute-mode-channels');
    expect(screen.queryByTestId('traceroute-channel-unknown-warning')).toBeNull();
  });

  it('does not let the default .* regex neutralise the other OR filters', async () => {
    // `filterRegexEnabled` defaults true and the pattern defaults to `.*`. The
    // old preview counted that as a match-all OR member, so every other OR
    // filter was swallowed: picking a channel showed the WHOLE mesh as matching
    // while the scheduler traced only that channel. The backend never treats
    // `.*` as an active filter — the preview must agree, or users tune against
    // a number that is not what will happen.
    mockApi({ filterChannels: [163], filterNameRegex: '.*', filterRegexEnabled: true });
    renderSection();

    // Node 1 is on channel 163; nodes 2 and 3 are not.
    expect(await screen.findByTestId('traceroute-match-1')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('traceroute-match-2')).toBeNull();
      expect(screen.queryByTestId('traceroute-match-3')).toBeNull();
    });
  });

  it('still applies a real regex pattern in the union', async () => {
    // The counterpart: a non-default pattern IS an active filter, so it widens
    // the OR group as before.
    mockApi({ filterChannels: [163], filterNameRegex: '^B$', filterRegexEnabled: true });
    renderSection();

    expect(await screen.findByTestId('traceroute-match-1')).toBeTruthy();
    expect(await screen.findByTestId('traceroute-match-2')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('traceroute-match-3')).toBeNull());
  });

  it('shows no exclusion warning while the channel filter is OR', async () => {
    mockApi({ filterChannels: [163] });
    renderSection();
    await expandChannels();

    await screen.findByTestId('traceroute-mode-channels');
    expect(screen.queryByTestId('traceroute-channel-unknown-warning')).toBeNull();
  });
});
