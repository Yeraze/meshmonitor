/**
 * @vitest-environment jsdom
 *
 * CoverageReport (#5277, Phase 1 WP4; gaps/summary/grid/export/deep-link
 * wired in P4a WP4, COVERAGE_P4_SPEC.md §2a.7). `useCoverageData` hooks and
 * `CoverageMap` (Leaflet-heavy, tested separately in CoverageMap.test.tsx)
 * are mocked so this file focuses on CoverageReport's own filter wiring:
 * default params, sender/hops changes refetching with the right args, the
 * truncation banner, the empty state, the guidance toggle, the metric
 * toggle reaching CoverageMap, and the P4a additions (sender search, view
 * toggle, deep-link seeding). The P4a pure analysis functions
 * (`coverageGaps`/`coverageSummary`/`coverageGrid`, WP1) and the summary
 * panel / chart / export buttons (WP3) are mocked too — WP1 and WP3 land in
 * separate worktrees and merge before this WP, so their real modules do not
 * exist in this isolated worktree; the mocks here stand in for both.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ distanceUnit: 'km' }),
}));

const useCoverageReceivers = vi.fn();
const useCoverageSenders = vi.fn();
const useCoverageReceptions = vi.fn();

vi.mock('../../hooks/useCoverageData', () => ({
  useCoverageReceivers: (...args: unknown[]) => useCoverageReceivers(...args),
  useCoverageSenders: (...args: unknown[]) => useCoverageSenders(...args),
  useCoverageReceptions: (...args: unknown[]) => useCoverageReceptions(...args),
}));

vi.mock('./CoverageMap', () => ({
  CoverageMap: ({ fixes, receivers, metric, fitKey, gaps, view, gridCells }: any) => (
    <div
      data-testid="coverage-map-stub"
      data-fit-key={fitKey}
      data-gaps-length={gaps ? gaps.length : 'undefined'}
      data-grid-cells-length={gridCells ? gridCells.length : 'undefined'}
    >
      fixes:{fixes.length} receivers:{receivers.length} metric:{metric} view:{view}
    </div>
  ),
}));

// WP1 pure analysis utils — do not exist as real files in this isolated
// worktree (they merge from a separate WP1 worktree before WP4). Minimal
// fakes that are enough for CoverageReport's own wiring assertions;
// WP1 owns the real behavioural tests (coverageGaps.test.ts etc).
const detectCoverageGaps = vi.fn((fixes: any[]) => ({
  intervalSec: 30,
  intervalSource: 'default',
  gaps: [],
  breaks: 0,
  heard: fixes.length,
  expected: fixes.length,
}));
const summarizeCoverage = vi.fn((items: any[]) => ({
  fixesHeard: items.length,
  receptions: items.length,
  bestSnr: null,
  worstSnr: null,
  bestRssi: null,
  worstRssi: null,
  receivers: [],
  distancePoints: [],
}));
const binFixesToGrid = vi.fn(() => []);

vi.mock('../../utils/coverageGaps', () => ({
  detectCoverageGaps: (...args: unknown[]) => (detectCoverageGaps as any)(...args),
}));
vi.mock('../../utils/coverageSummary', () => ({
  summarizeCoverage: (...args: unknown[]) => (summarizeCoverage as any)(...args),
}));
vi.mock('../../utils/coverageGrid', () => ({
  binFixesToGrid: (...args: unknown[]) => (binFixesToGrid as any)(...args),
}));

// WP3 components — same isolated-worktree situation as the WP1 utils above.
vi.mock('./CoverageSummaryPanel', () => ({
  CoverageSummaryPanel: ({ summary, gapResult, truncated }: any) => (
    <div data-testid="coverage-summary-panel-stub">
      fixesHeard:{summary?.fixesHeard} gapResult:{gapResult ? 'set' : 'null'} truncated:{String(truncated)}
    </div>
  ),
}));
vi.mock('./CoverageDistanceChart', () => ({
  CoverageDistanceChart: ({ points }: any) => (
    <div data-testid="coverage-distance-chart-stub">points:{points?.length ?? 0}</div>
  ),
}));
vi.mock('./CoverageExportButtons', () => ({
  CoverageExportButtons: ({ disabled, items }: any) => (
    <div data-testid="coverage-export-buttons-stub">
      disabled:{String(disabled)} items:{items?.length ?? 0}
    </div>
  ),
}));

import CoverageReport from './CoverageReport';

const RECEIVERS = [
  {
    sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!aaaaaaaa', receiverNodeNum: 1, longName: 'Receiver One', shortName: 'R1',
    latitude: 26.1, longitude: -80.2, lastReceivedAt: 1, receptionCount: 5,
  },
  {
    sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!cccccccc', receiverNodeNum: 3, longName: 'Receiver Two', shortName: 'R2',
    latitude: 26.3, longitude: -80.4, lastReceivedAt: 1, receptionCount: 5,
  },
];

const SENDERS = [
  { senderId: '!bbbbbbbb', senderNodeNum: 2, longName: 'Sender One', shortName: 'S1', fixCount: 4, lastReceivedAt: 1 },
];

function makeReception(id: number) {
  return {
    id, sourceId: 'src-a', protocol: 'meshtastic', receiverKind: 'local',
    receiverId: '!aaaaaaaa', receiverNodeNum: 1, receiverLatitude: 26.1, receiverLongitude: -80.2,
    senderId: '!bbbbbbbb', senderNodeNum: 2, packetKey: String(id), packetId: id, pathKey: 'r0:h0',
    latitude: 26.15, longitude: -80.25, altitude: null, precisionBits: null, snr: 5, rssi: -80,
    hopStart: 0, hopLimit: 0, hopsAway: 0, relayNode: 0, transportMechanism: null, channel: 0,
    rxTime: 1_700_000_000, receivedAt: 1_700_000_000_000 + id,
  };
}

const NOW = 1_700_000_000_000;

beforeEach(() => {
  // A spy on Date.now (not vi.useFakeTimers) — real timers stay real, which
  // userEvent's internal async waits need (#5277 P4a WP4: several tests
  // below drive the sender SearchableSelect through real userEvent clicks/
  // typing, which hang under fake timers unless every internal wait is
  // manually advanced). The component itself only ever reads Date.now(),
  // never a timer, so this is enough to make the default 24h window
  // deterministic.
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  detectCoverageGaps.mockClear();
  summarizeCoverage.mockClear();
  binFixesToGrid.mockClear();

  useCoverageReceivers.mockReturnValue({
    data: { receivers: RECEIVERS, retentionDays: 7, mqttSources: [] },
    isLoading: false,
    refetch: vi.fn(),
  });
  useCoverageSenders.mockReturnValue({
    data: { senders: SENDERS, truncated: false },
    isLoading: false,
    refetch: vi.fn(),
  });
  useCoverageReceptions.mockReturnValue({
    data: { items: [makeReception(1), makeReception(2)], truncated: false },
    isLoading: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function lastReceptionsFilters() {
  const calls = useCoverageReceptions.mock.calls;
  return calls[calls.length - 1][0];
}

function renderReport(props: React.ComponentProps<typeof CoverageReport> = {}) {
  return render(
    <MemoryRouter>
      <CoverageReport {...props} />
    </MemoryRouter>,
  );
}

/** Opens the CoverageReceiverFilter panel (composite-keyed picker, #5277 P2 WP4). */
function openReceiverPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Receivers:|All receivers/ }));
}

/** Opens the sender SearchableSelect, types `query`, and clicks the option
 *  matching `optionName` (#5277 P4a WP4, spec §2a.7 — replaced the native
 *  `<select>` this test file used to drive with `fireEvent.change`). */
async function selectSender(user: ReturnType<typeof userEvent.setup>, query: string, optionName: RegExp | string) {
  const combobox = screen.getByRole('combobox', { name: 'Sender' });
  await user.click(combobox);
  if (query) await user.type(combobox, query);
  await user.click(screen.getByRole('option', { name: optionName }));
}

describe('CoverageReport', () => {
  it('defaults to a 24h window, all receivers, no sender, no hops filter', () => {
    renderReport();

    const filters = lastReceptionsFilters();
    expect(filters.sinceMs).toBe(NOW - 24 * 3_600_000);
    expect(filters.untilMs).toBe(NOW);
    expect(filters.receiverFilter).toBeUndefined();
    expect(filters.clientSideFilter).toBeUndefined();
    expect(filters.senderId).toBeUndefined();
    expect(filters.hops).toBeUndefined();
    expect(filters.hopsMode).toBe('exact');
  });

  it('refetches with the chosen sender id when a sender is picked from the SearchableSelect', async () => {
    const user = userEvent.setup({ delay: null });
    renderReport();

    await selectSender(user, 'Sender One', /Sender One/);

    expect(lastReceptionsFilters().senderId).toBe('!bbbbbbbb');
  });

  it('filters the sender list by typed text (SearchableSelect search box)', async () => {
    const user = userEvent.setup({ delay: null });
    renderReport();

    const combobox = screen.getByRole('combobox', { name: 'Sender' });
    await user.click(combobox);
    await user.type(combobox, 'zzz-no-match');

    expect(screen.getByText('No matching senders')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Sender One/ })).not.toBeInTheDocument();
  });

  it('refetches with an exact hops filter, then switches to "up to" mode', () => {
    renderReport();

    fireEvent.change(screen.getByLabelText('Hops'), { target: { value: '2' } });
    expect(lastReceptionsFilters().hops).toBe(2);
    expect(lastReceptionsFilters().hopsMode).toBe('exact');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Up to this many hops' }));
    expect(lastReceptionsFilters().hopsMode).toBe('max');
  });

  it('deselecting a receiver narrows the receiverFilter (composite-keyed); deselecting all shows the selection-required banner', () => {
    renderReport();
    openReceiverPanel();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Receiver Two' }));
    expect(lastReceptionsFilters().receiverFilter).toEqual([
      { sourceId: 'src-a', mode: 'include', receiverIds: ['!aaaaaaaa'] },
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Receiver One' }));
    expect(screen.getByText('Select at least one receiver.')).toBeInTheDocument();
  });

  it('shows the truncation banner when the receptions query reports truncated', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [makeReception(1)], truncated: true },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();

    expect(
      screen.getByText(/Showing the first 1 receptions in this window/),
    ).toBeInTheDocument();
    expect(screen.getByText(/pick a sender to see the rest/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no receptions and nothing is loading', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [], truncated: false },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();

    expect(screen.getByText('No RF receptions in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-map-stub')).not.toBeInTheDocument();
  });

  it('toggles the setup guidance panel', () => {
    renderReport();

    expect(screen.queryByText(/Recommended survey-node settings/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup guidance'));
    expect(screen.getByText(/Recommended survey-node settings/)).toBeInTheDocument();
    expect(screen.getByText(/receiver firmware caveat/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup guidance'));
    expect(screen.queryByText(/Recommended survey-node settings/)).not.toBeInTheDocument();
  });

  it('passes the selected colour metric through to CoverageMap', () => {
    renderReport();

    expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('metric:snr');
    fireEvent.change(screen.getByLabelText('Colour by'), { target: { value: 'rssi' } });
    expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('metric:rssi');
  });

  it('shows the retention note from the receivers query', () => {
    renderReport();
    expect(screen.getByText('Data kept 7 days.')).toBeInTheDocument();
  });

  it('shows the MQTT note when a gateway receiver is present', () => {
    useCoverageReceivers.mockReturnValue({
      data: {
        receivers: [
          { ...RECEIVERS[0], receiverKind: 'mqtt_gateway' },
        ],
        retentionDays: 7,
        mqttSources: [],
      },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();
    expect(screen.getByText(/Gateway receptions come from what each gateway itself reports/)).toBeInTheDocument();
  });

  it('shows the MQTT note when mqttSources is non-empty even with no gateway receivers yet', () => {
    useCoverageReceivers.mockReturnValue({
      data: {
        receivers: RECEIVERS,
        retentionDays: 7,
        mqttSources: [{ sourceId: 'src-mqtt', sourceName: 'MQTT Source', recordingEnabled: true }],
      },
      isLoading: false,
      refetch: vi.fn(),
    });

    renderReport();
    expect(screen.getByText(/Gateway receptions come from what each gateway itself reports/)).toBeInTheDocument();
  });

  it('does not show the MQTT note when there are no gateway receivers and no mqttSources', () => {
    renderReport();
    expect(screen.queryByText(/Gateway receptions come from what each gateway itself reports/)).not.toBeInTheDocument();
  });

  // #5277 P4a WP4 (COVERAGE_P4_SPEC.md §2a.7).
  describe('gaps / summary / grid / export wiring', () => {
    it('gapResult is null with no sender selected, and set once a single sender is chosen', async () => {
      const user = userEvent.setup({ delay: null });
      renderReport();

      expect(detectCoverageGaps).not.toHaveBeenCalled();
      expect(screen.getByTestId('coverage-summary-panel-stub')).toHaveTextContent('gapResult:null');

      await selectSender(user, 'Sender One', /Sender One/);

      expect(detectCoverageGaps).toHaveBeenCalled();
      expect(screen.getByTestId('coverage-summary-panel-stub')).toHaveTextContent('gapResult:set');
    });

    it('always computes the summary panel from all loaded items, sender selected or not', () => {
      renderReport();
      expect(summarizeCoverage).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 })]),
      );
      expect(screen.getByTestId('coverage-summary-panel-stub')).toHaveTextContent('fixesHeard:2');
    });

    it('passes truncated through to the summary panel', () => {
      useCoverageReceptions.mockReturnValue({
        data: { items: [makeReception(1)], truncated: true },
        isLoading: false,
        refetch: vi.fn(),
      });
      renderReport();
      expect(screen.getByTestId('coverage-summary-panel-stub')).toHaveTextContent('truncated:true');
    });

    it('export buttons are disabled with no items, and carry the loaded items otherwise', () => {
      useCoverageReceptions.mockReturnValue({
        data: { items: [], truncated: false },
        isLoading: false,
        refetch: vi.fn(),
      });
      renderReport();
      expect(screen.getByTestId('coverage-export-buttons-stub')).toHaveTextContent('disabled:true');
    });

    it('the view toggle defaults to Dots; switching to Grid shows the cell-size select, calls binFixesToGrid, and leaves fitKey unchanged', () => {
      renderReport();

      expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('view:dots');
      expect(screen.queryByLabelText('Cell size')).not.toBeInTheDocument();
      const fitKeyBefore = screen.getByTestId('coverage-map-stub').getAttribute('data-fit-key');

      fireEvent.click(screen.getByRole('button', { name: 'Grid' }));

      expect(screen.getByTestId('coverage-map-stub')).toHaveTextContent('view:grid');
      expect(binFixesToGrid).toHaveBeenCalled();
      expect(screen.getByLabelText('Cell size')).toBeInTheDocument();
      const fitKeyAfter = screen.getByTestId('coverage-map-stub').getAttribute('data-fit-key');
      // fitKey must NOT change on a view toggle (spec §2a.7 — the map must
      // not re-fit just because the user switched Dots/Grid).
      expect(fitKeyAfter).toBe(fitKeyBefore);
    });

    it('the cell-size select defaults to 250 m and offers 100/250/500/1000', () => {
      renderReport();
      fireEvent.click(screen.getByRole('button', { name: 'Grid' }));

      const select = screen.getByLabelText('Cell size') as HTMLSelectElement;
      expect(select.value).toBe('250');
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['100', '250', '500', '1000']);
    });
  });

  // #5277 P4a WP4 (COVERAGE_P4_SPEC.md §2a.7) — deep-link seeding.
  describe('deep link (initialLink)', () => {
    it('seeds the sender and time-range preset once at mount from initialLink', () => {
      renderReport({ initialLink: { sender: '!bbbbbbbb', range: '6h' } });

      const filters = lastReceptionsFilters();
      expect(filters.senderId).toBe('!bbbbbbbb');
      expect(filters.sinceMs).toBe(NOW - 6 * 3_600_000);
      expect(filters.untilMs).toBe(NOW);
    });

    it('shows a synthetic option, keyed by the formatted id, for a deep-linked sender absent from /senders', async () => {
      const user = userEvent.setup({ delay: null });
      renderReport({ initialLink: { sender: '!deadbeef' } });

      const combobox = screen.getByRole('combobox', { name: 'Sender' });
      // Selected-but-closed state shows the option's own label, which for a
      // synthetic entry is just the formatted id (no name/fix-count known).
      expect(combobox).toHaveValue('!deadbeef');

      await user.click(combobox);
      expect(within(screen.getByRole('listbox')).getByRole('option', { name: '!deadbeef' })).toBeInTheDocument();
    });

    it('does not add a synthetic option when the deep-linked sender IS present in /senders', async () => {
      const user = userEvent.setup({ delay: null });
      renderReport({ initialLink: { sender: '!bbbbbbbb' } });

      const combobox = screen.getByRole('combobox', { name: 'Sender' });
      await user.click(combobox);
      const options = within(screen.getByRole('listbox')).getAllByRole('option');
      // "All" + the one real sender — no duplicate/synthetic entry.
      expect(options).toHaveLength(2);
    });
  });

  // #5277 Phase 3 WP3.
  describe('MeshCore', () => {
    it('the Hops select includes 8 (MeshCore advert flood limit)', () => {
      renderReport();
      const hopsSelect = screen.getByLabelText('Hops') as HTMLSelectElement;
      const values = Array.from(hopsSelect.options).map((o) => o.value);
      expect(values).toContain('8');

      fireEvent.change(hopsSelect, { target: { value: '8' } });
      expect(lastReceptionsFilters().hops).toBe(8);
    });

    it('abbreviates a MeshCore pubkey sender in the sender dropdown', async () => {
      const user = userEvent.setup({ delay: null });
      const PUBKEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      useCoverageSenders.mockReturnValue({
        data: {
          senders: [
            { senderId: PUBKEY, senderNodeNum: null, longName: null, shortName: null, fixCount: 3, lastReceivedAt: 1 },
          ],
          truncated: false,
        },
        isLoading: false,
        refetch: vi.fn(),
      });

      renderReport();
      await user.click(screen.getByRole('combobox', { name: 'Sender' }));
      const option = screen.getByRole('option', { name: /a1b2c3d4…/ });
      expect(option).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: new RegExp(PUBKEY) })).not.toBeInTheDocument();
    });

    it('the setup guidance panel carries the zero-hop, never-flood, MeshMonitor-button, and stored-position warnings plus the airtime figures', () => {
      renderReport();
      fireEvent.click(screen.getByText('Setup guidance'));

      expect(screen.getByText(/Send zero-hop adverts only, one every 60 seconds or slower/)).toBeInTheDocument();
      expect(screen.getByText(/Never flood adverts for a survey/)).toBeInTheDocument();
      expect(screen.getByText(/advert\.zerohop/)).toBeInTheDocument();
      expect(screen.getByText(/own Send advert button floods/)).toBeInTheDocument();
      expect(screen.getByText(/stored advert position, not a live GPS fix/)).toBeInTheDocument();
      expect(screen.getByText('US/Canada 910.525 MHz, SF7 BW62.5 CR5')).toBeInTheDocument();
      expect(screen.getByText('EU/UK narrow, SF8 BW62.5 CR8')).toBeInTheDocument();
      expect(screen.getByText('396 ms')).toBeInTheDocument();
      expect(screen.getByText(/0\.7% of the local channel/)).toBeInTheDocument();
      expect(screen.getByText(/Repeaters' own adverts are recorded automatically/)).toBeInTheDocument();
    });

    it('shows the MeshCore empty-state hint alongside the Meshtastic one', () => {
      useCoverageReceptions.mockReturnValue({
        data: { items: [], truncated: false },
        isLoading: false,
        refetch: vi.fn(),
      });

      renderReport();
      expect(
        screen.getByText('MeshCore companions record signed adverts that carry a position.'),
      ).toBeInTheDocument();
    });
  });
});
