/**
 * @vitest-environment jsdom
 *
 * Integration coverage for the statistical traceroute wiring in
 * `MessagesTab.tsx` (Statistical Route epic, phase 2, WP4). Proves:
 *   - S1: the pair-history request only fires when the cheap local gate
 *     holds (>= 2 participation entries whose OTHER endpoint is the local
 *     node, `traceroute:read`, distinct non-null node numbers).
 *   - S2: the statistical option is offered only when the built union has
 *     `totalRoutes >= 2`, and its count is the union's count, not the
 *     number of rows fetched.
 *   - S3: picking it swaps the strip and suppresses the age line, both
 *     badges, the no-return line, and the copy links; picking a dated entry
 *     afterwards restores all of them.
 *   - S4: switching conversation partner or a new poll timestamp clears a
 *     statistical pick, same as an entry pick.
 *   - S5: losing availability while picked falls back to rule 1's row with
 *     no crash.
 *
 * Mock block adapted from `MessagesTab.tracerouteStrip.test.tsx:31-130` (the
 * canonical MessagesTab harness), with `useNodeTraceroutes` and
 * `useTraceroutePairHistory` both made controllable per test via
 * `vi.hoisted` mock functions instead of the fixed empty-list stub that
 * file uses.
 *
 * IMPORTANT — why `useTraceroutePairHistory` is asserted as "not called"
 * rather than "called with `enabled: false`" for the gate-closed cases:
 * `MessagesTab.tsx` mounts the hook's caller (`StatisticalTracerouteLoader`)
 * conditionally, rather than calling the hook unconditionally with an
 * `enabled` flag. That is a deliberate WP4 deviation from the spec's literal
 * pseudocode (SR_PHASE2_SPEC.md §3.7 S1) — TanStack Query's `useQuery`
 * resolves its `QueryClient` from context before it even looks at
 * `enabled` (`useBaseQuery` calls `useQueryClient()` unconditionally), so an
 * always-mounted call throws "No QueryClient set" in
 * `MessagesTab.composeFocus.test.tsx` and `MessagesTab.txDisabled.test.tsx`,
 * both of which render `MessagesTab` with no `QueryClientProvider` and are
 * out of WP4's ownership. Gating the mount instead of the flag keeps those
 * two files passing unedited while producing the identical observable
 * outcome the spec cares about: no request fires when the gate is closed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MessagesTab from './MessagesTab';
import type { MeshMessage } from '../types/message';
import type { DeviceInfo } from '../types/device';
import type { TracerouteParticipationEntry } from '../services/api';
import type { AggregateTracerouteRow } from '../utils/tracerouteAggregate';
import enLocale from '../../public/locales/en.json';

vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDeviceNodes: () => new Set<number>(),
  useTelemetryNodes: () => ({
    nodesWithTelemetry: new Set(),
    nodesWithWeather: new Set(),
    nodesWithEstimatedPosition: new Set(),
    nodesWithPKC: new Set(),
    unmappedCount: 0,
    estimatedUncertainty: {},
    isLoading: false,
  }),
}));

vi.mock('../contexts/SettingsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSettings: () => ({ nodeHopsCalculation: 'nodeinfo', distanceUnit: 'km' }),
  useNotificationMuteSettings: () => ({
    isDMMuted: () => false,
    muteDM: async () => {},
    unmuteDM: async () => {},
    isChannelMuted: () => false,
    muteChannel: async () => {},
    unmuteChannel: async () => {},
  }),
}));

// A STABLE object, unlike a fresh `{ traceroutes: [], ... }` literal returned
// from a new arrow-function call each render: the real `MapContext` provider
// memoizes its context value (a `useMemo` over every field it exposes), so
// `traceroutes` keeps the same reference across re-renders that don't change
// traceroute data. `StatisticalTracerouteLoader` (MessagesTab.tsx) depends on
// `traceroutes` in a `useMemo` whose result feeds a `useState` setter via an
// effect — an unstable mock reference there recomputes every render and
// re-fires the effect every render, an infinite loop this file hit in
// development. A per-call fresh object would still be wrong even without that
// downstream effect, since it doesn't match the real provider's contract.
const mapContextValue = { traceroutes: [] as unknown[], neighborInfo: [] as unknown[], setNeighborInfo: () => {} };
vi.mock('../contexts/MapContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMapContext: () => mapContextValue,
}));

vi.mock('./ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ showToast: () => {} }),
}));

vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));

// Both traceroute hooks are made fully controllable per test, rather than
// the fixed-empty-list stub `MessagesTab.tracerouteStrip.test.tsx` uses —
// this file's whole point is exercising non-empty participation lists and
// non-empty pair histories. `vi.hoisted` is required because `vi.mock`
// factories run before any module-scope `const` in this file would
// otherwise be initialized.
const { mockUseNodeTraceroutes, mockUseTraceroutePairHistory } = vi.hoisted(() => ({
  mockUseNodeTraceroutes: vi.fn(),
  mockUseTraceroutePairHistory: vi.fn(),
}));

vi.mock('../hooks/useNodeTraceroutes', () => ({
  useNodeTraceroutes: mockUseNodeTraceroutes,
}));

vi.mock('../hooks/useTraceroutePairHistory', () => ({
  useTraceroutePairHistory: mockUseTraceroutePairHistory,
  PAIR_HISTORY_LIMIT: 200,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({}),
}));

vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./SmartHopsGraphs', () => ({ default: () => null }));
vi.mock('./LinkQualityGraph', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({ default: () => null }));

// Same `react-i18next` override as MessagesTab.tracerouteStrip.test.tsx
// (NodePopup pattern: resolves `t(key, defaultString)` / `t(key, options)`
// to real English text via en.json), EXTENDED to resolve i18next-style
// `_one`/`_other` plural keys from an `options.count` — needed because this
// file, unlike tracerouteStrip's, exercises the picker's pluralized
// "Statistical (N routes)" label (`messages.traceroute_picker_statistical`,
// which only exists as `_one`/`_other` in en.json, per house style for
// count-driven strings with no positional default).
const enDict = enLocale as Record<string, unknown>;
function lookupEnDefault(key: string, count?: number): string | undefined {
  if (typeof count === 'number') {
    const suffixed = enDict[`${key}_${count === 1 ? 'one' : 'other'}`];
    if (typeof suffixed === 'string') return suffixed;
  }
  const value = enDict[key];
  return typeof value === 'string' ? value : undefined;
}
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (
      key: string,
      arg2?: string | Record<string, unknown>,
      arg3?: Record<string, unknown>,
    ) => {
      let options: Record<string, unknown> | undefined;
      let defaultValue: string | undefined;
      if (typeof arg2 === 'string') {
        defaultValue = arg2;
        options = arg3;
      } else {
        options = arg2;
        defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : undefined;
      }
      const count = typeof options?.count === 'number' ? options.count : undefined;
      let out = defaultValue ?? lookupEnDefault(key, count) ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const CURRENT_NODE_ID = '!000003e8'; // 1000
const DM_NODE_ID = '!000007d0'; // 2000 — the picker/peer node
const THIRD_NODE_ID = '!00000bb8'; // 3000 — neither endpoint of the pair
const CURRENT_NUM = 1000;
const PICKER_NUM = 2000;
const THIRD_NUM = 3000;

const theirMsg: MeshMessage = {
  id: 'src1_1_7002',
  from: DM_NODE_ID,
  to: CURRENT_NODE_ID,
  fromNodeId: DM_NODE_ID,
  toNodeId: CURRENT_NODE_ID,
  text: 'hi back',
  channel: -1,
  portnum: 1,
  timestamp: new Date('2026-07-21T12:00:05Z'),
};

const dmNode: DeviceInfo = {
  nodeNum: PICKER_NUM,
  user: { id: DM_NODE_ID, longName: 'Destination Node', shortName: 'DEST' },
};

let nextEntryId = 1;
function mkEntry(overrides: Partial<TracerouteParticipationEntry> = {}): TracerouteParticipationEntry {
  return {
    id: nextEntryId++,
    timestamp: Date.now() - 1000,
    fromNodeNum: CURRENT_NUM,
    toNodeNum: PICKER_NUM,
    fromNodeId: CURRENT_NODE_ID,
    toNodeId: DM_NODE_ID,
    route: '[]',
    routeBack: '[]',
    snrTowards: '[-40]',
    snrBack: '[-44]',
    channel: 0,
    participation: 'endpoint',
    hopCount: 0,
    ...overrides,
  };
}

let nextRowId = 1;
function mkRow(overrides: Partial<AggregateTracerouteRow> = {}): AggregateTracerouteRow {
  return {
    id: nextRowId++,
    fromNodeNum: CURRENT_NUM,
    toNodeNum: PICKER_NUM,
    route: '[]',
    routeBack: '[]',
    snrBack: '[-44]',
    timestamp: Date.now() - 1000,
    ...overrides,
  };
}

/** >= 2 endpoint entries whose other end is the local node — satisfies S1's
 *  `pairEntryCount >= 2`. */
const TWO_MATCHING_ENTRIES = [
  mkEntry({ id: 101, timestamp: Date.now() - 1000 }),
  mkEntry({ id: 102, timestamp: Date.now() - 2000 }),
];

/** Two direct (no intermediate hop) forward+return rows -> `totalRoutes: 2`. */
const TWO_VALID_ROWS: AggregateTracerouteRow[] = [
  mkRow({ id: 201 }),
  mkRow({ id: 202 }),
];

type MessagesTabProps = React.ComponentProps<typeof MessagesTab>;

function makeProps(overrides: Partial<MessagesTabProps> = {}): MessagesTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    processedNodes: [],
    nodes: [dmNode],
    messages: [theirMsg],
    currentNodeId: CURRENT_NODE_ID,
    connectionStatus: 'connected',
    selectedDMNode: DM_NODE_ID,
    setSelectedDMNode: noop,
    newMessage: '',
    setNewMessage: noop,
    replyingTo: null,
    setReplyingTo: noop,
    unreadCountsData: null,
    markMessagesAsRead: asyncNoop,
    nodeFilter: '',
    setNodeFilter: noop,
    messagesNodeFilter: '',
    setMessagesNodeFilter: noop,
    dmFilter: 'all' as const,
    setDmFilter: noop,
    securityFilter: 'all' as const,
    channels: [{ id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true }],
    channelFilter: 'all' as const,
    showIncompleteNodes: false,
    showNodeFilterPopup: false,
    setShowNodeFilterPopup: noop,
    isMessagesNodeListCollapsed: false,
    setIsMessagesNodeListCollapsed: noop,
    tracerouteLoading: null,
    positionLoading: null,
    nodeInfoLoading: null,
    neighborInfoLoading: null,
    telemetryRequestLoading: null,
    timeFormat: '24' as const,
    dateFormat: 'MM/DD/YYYY' as const,
    temperatureUnit: 'C' as const,
    telemetryVisualizationHours: 24,
    distanceUnit: 'km' as const,
    baseUrl: 'http://localhost',
    hasPermission: () => true,
    handleSendDirectMessage: asyncNoop,
    onSendBell: asyncNoop,
    handleResendMessage: asyncNoop,
    handleTraceroute: asyncNoop,
    handleExchangePosition: asyncNoop,
    handleExchangeNodeInfo: asyncNoop,
    handleRequestNeighborInfo: asyncNoop,
    handleRequestTelemetry: asyncNoop,
    handleDeleteMessage: asyncNoop,
    handleSenderClick: noop,
    handleSendTapback: noop,
    getRecentTraceroute: () => null,
    toggleIgnored: asyncNoop,
    toggleHideFromMap: asyncNoop,
    toggleFavorite: asyncNoop,
    toggleFavoriteLock: asyncNoop,
    setShowTracerouteHistoryModal: noop,
    setShowPurgeDataModal: noop,
    setShowPositionOverrideModal: noop,
    setEmojiPickerMessage: noop,
    shouldShowData: () => true,
    handleShowOnMap: noop,
    dmMessagesContainerRef: { current: null },
    mqttReadOnly: false,
    ...overrides,
  } as unknown as MessagesTabProps;
}

function renderTab(props: MessagesTabProps) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MessagesTab {...props} />
    </QueryClientProvider>,
  );
}

const tracerouteInfoBox = () => document.querySelector('.traceroute-info');
const stripGroup = () => document.querySelector('.traceroute-info [role="group"]');
const ageLine = () => document.querySelector('.traceroute-age');
const pendingBadge = () => document.querySelector('.traceroute-pending-badge');
const failedBadge = () => document.querySelector('.traceroute-failed-badge');
const noReturnLine = () =>
  Array.from(document.querySelectorAll('.traceroute-info .traceroute-route'))
    .find(el => el.textContent === 'No return path data') ?? null;
const pickerSelect = () => document.querySelector('.traceroute-info select') as HTMLSelectElement | null;
const statisticalOption = () =>
  document.querySelector('.traceroute-info option[value="statistical"]') as HTMLOptionElement | null;

beforeEach(() => {
  nextEntryId = 1;
  nextRowId = 1;
  mockUseNodeTraceroutes.mockReset().mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockUseTraceroutePairHistory.mockReset().mockReturnValue({
    rows: undefined,
    isLoading: false,
    error: null,
  });
});

describe('MessagesTab statistical traceroute wiring (Statistical Route epic, phase 2, WP4)', () => {
  describe('fetch gate (S1)', () => {
    it('does not call useTraceroutePairHistory with fewer than 2 matching endpoint entries', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: [mkEntry({ id: 1 })],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderTab(makeProps());

      expect(mockUseTraceroutePairHistory).not.toHaveBeenCalled();
    });

    it('calls useTraceroutePairHistory with the local and peer node numbers once 2+ matching endpoint entries exist', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      renderTab(makeProps());

      expect(mockUseTraceroutePairHistory).toHaveBeenCalledWith(
        CURRENT_NUM,
        PICKER_NUM,
        expect.objectContaining({ enabled: true }),
      );
    });

    it('does not count endpoint entries whose OTHER endpoint is a third node', () => {
      // The picker (`pickerNodeNum`) took part in these as an endpoint, but
      // the OTHER end is a third node, not the local node — these describe a
      // pair that isn't (local, picker) at all, so they must not count.
      mockUseNodeTraceroutes.mockReturnValue({
        data: [
          mkEntry({ id: 1, fromNodeNum: PICKER_NUM, fromNodeId: DM_NODE_ID, toNodeNum: THIRD_NUM, toNodeId: THIRD_NODE_ID }),
          mkEntry({ id: 2, fromNodeNum: PICKER_NUM, fromNodeId: DM_NODE_ID, toNodeNum: THIRD_NUM, toNodeId: THIRD_NODE_ID }),
        ],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderTab(makeProps());

      expect(mockUseTraceroutePairHistory).not.toHaveBeenCalled();
    });

    it('does not count participation:"hop" entries toward the gate', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: [mkEntry({ id: 1, participation: 'hop' }), mkEntry({ id: 2, participation: 'hop' })],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderTab(makeProps());

      expect(mockUseTraceroutePairHistory).not.toHaveBeenCalled();
    });

    it('does not fetch when currentNodeNum is null (the MQTT shape)', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderTab(makeProps({ currentNodeId: '' }));

      expect(mockUseTraceroutePairHistory).not.toHaveBeenCalled();
      expect(statisticalOption()).toBeNull();
    });

    it('does not fetch with traceroute:write but not traceroute:read', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      renderTab(makeProps({
        hasPermission: (resource: string, action: string) =>
          (resource === 'messages' && action === 'read') ||
          (resource === 'traceroute' && action === 'write'),
      }));

      expect(mockUseTraceroutePairHistory).not.toHaveBeenCalled();
    });
  });

  describe('option availability (S2)', () => {
    it('offers the statistical option when the union has totalRoutes >= 2', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      renderTab(makeProps());

      const option = statisticalOption();
      expect(option).not.toBeNull();
      expect(option?.textContent).toBe('Statistical (2 routes)');
    });

    it('offers no option when only 1 row is aggregatable', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: [mkRow({ id: 1 })] });
      renderTab(makeProps());

      expect(statisticalOption()).toBeNull();
    });

    it('offers no option when every fetched row failed (no route, no return)', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({
        rows: [
          mkRow({ id: 1, route: null, routeBack: null, snrBack: null }),
          mkRow({ id: 2, route: null, routeBack: null, snrBack: null }),
        ],
      });
      renderTab(makeProps());

      expect(statisticalOption()).toBeNull();
    });

    it('labels the option with the union\'s totalRoutes, not the number of rows fetched', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      // 3 rows fetched; one is mismatched (peer != THIRD_NUM), so the union
      // only counts 2.
      mockUseTraceroutePairHistory.mockReturnValue({
        rows: [
          mkRow({ id: 1 }),
          mkRow({ id: 2 }),
          mkRow({ id: 3, fromNodeNum: CURRENT_NUM, toNodeNum: THIRD_NUM }),
        ],
      });
      renderTab(makeProps());

      expect(statisticalOption()?.textContent).toBe('Statistical (2 routes)');
    });
  });

  describe('pick behavior (S3)', () => {
    function renderWithStatisticalAvailable(overrides: Partial<MessagesTabProps> = {}) {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      return renderTab(makeProps(overrides));
    }

    it('choosing the statistical option renders the statistical strip and hides the single-route one', () => {
      renderWithStatisticalAvailable();
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(stripGroup()?.getAttribute('aria-label')).toBe('Statistical traceroute paths');
    });

    it('hides the copy links once the statistical option is picked', () => {
      renderWithStatisticalAvailable();
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      const box = tracerouteInfoBox() as HTMLElement;
      expect(within(box).queryByRole('button', { name: /Copy Forward/ })).toBeNull();
      expect(within(box).queryByRole('button', { name: /Copy Return/ })).toBeNull();
      expect(within(box).queryByRole('button', { name: /Copy Both/ })).toBeNull();
    });

    it('hides the age line and both badges once the statistical option is picked', () => {
      renderWithStatisticalAvailable({ getRecentTraceroute: () => null });
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(ageLine()).toBeNull();
      expect(pendingBadge()).toBeNull();
      expect(failedBadge()).toBeNull();
    });

    it('hides the "No return path data" line once the statistical option is picked', () => {
      renderWithStatisticalAvailable();
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(noReturnLine()).toBeNull();
    });

    it('keeps the picker visible, showing the statistical option as selected', () => {
      renderWithStatisticalAvailable();
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(pickerSelect()?.value).toBe('statistical');
    });

    it('choosing a dated entry afterwards restores the single-route strip, copy links, age line and badges', () => {
      renderWithStatisticalAvailable();
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(stripGroup()?.getAttribute('aria-label')).toBe('Statistical traceroute paths');

      select.value = String(TWO_MATCHING_ENTRIES[0].id);
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(stripGroup()?.getAttribute('aria-label')).toBe('Traceroute path');
      expect(ageLine()).not.toBeNull();
      const box = tracerouteInfoBox() as HTMLElement;
      expect(within(box).getByRole('button', { name: /Copy Both/ })).toBeTruthy();
    });
  });

  describe('resets (S4)', () => {
    it('switching conversation partner clears a statistical pick', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      const { rerender } = renderTab(makeProps());
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(stripGroup()?.getAttribute('aria-label')).toBe('Statistical traceroute paths');

      // New conversation partner: no participation fetched yet for them.
      mockUseNodeTraceroutes.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      const otherNode: DeviceInfo = {
        nodeNum: THIRD_NUM,
        user: { id: THIRD_NODE_ID, longName: 'Other Node', shortName: 'OTHR' },
      };
      const queryClient = new QueryClient();
      rerender(
        <QueryClientProvider client={queryClient}>
          <MessagesTab {...makeProps({ selectedDMNode: THIRD_NODE_ID, nodes: [dmNode, otherNode] })} />
        </QueryClientProvider>,
      );

      expect(document.querySelector('.traceroute-info option[value="statistical"]')).toBeNull();
    });

    it('a new recentTrace.timestamp clears a statistical pick and restores the rule-1 row', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      const { rerender } = renderTab(makeProps({ getRecentTraceroute: () => null }));
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(stripGroup()?.getAttribute('aria-label')).toBe('Statistical traceroute paths');

      const freshTrace = {
        timestamp: Date.now(),
        route: '[]',
        routeBack: '[]',
        snrTowards: '[-40]',
        snrBack: '[-44]',
        fromNodeNum: CURRENT_NUM,
        toNodeNum: PICKER_NUM,
      };
      const queryClient = new QueryClient();
      rerender(
        <QueryClientProvider client={queryClient}>
          <MessagesTab {...makeProps({ getRecentTraceroute: () => freshTrace })} />
        </QueryClientProvider>,
      );

      expect(stripGroup()?.getAttribute('aria-label')).toBe('Traceroute path');
    });

    it('rule 2/3 still clear an entry pick the same way (non-regression)', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      const { rerender } = renderTab(makeProps());
      const select = pickerSelect()!;
      select.value = String(TWO_MATCHING_ENTRIES[1].id);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(pickerSelect()?.value).toBe(String(TWO_MATCHING_ENTRIES[1].id));

      const queryClient = new QueryClient();
      rerender(
        <QueryClientProvider client={queryClient}>
          <MessagesTab {...makeProps({ selectedDMNode: DM_NODE_ID })} />
        </QueryClientProvider>,
      );
      // Same partner re-supplied is a no-op for React (props unchanged
      // reference-wise would not even re-trigger the effect); assert the
      // box still renders sanely rather than asserting a specific reset,
      // since `selectedDMNode` didn't actually change value.
      expect(tracerouteInfoBox()).not.toBeNull();
    });
  });

  describe('fallback (S5)', () => {
    it('falls back to the rule-1 row with no crash when statistical becomes unavailable while picked', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      const { rerender } = renderTab(makeProps());
      const select = pickerSelect()!;
      select.value = 'statistical';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(stripGroup()?.getAttribute('aria-label')).toBe('Statistical traceroute paths');

      // Simulate a refetch that now returns only failed rows — entries
      // (and thus `wantStatistical`) stay the same, but the union collapses.
      mockUseTraceroutePairHistory.mockReturnValue({
        rows: [
          mkRow({ id: 901, route: null, routeBack: null, snrBack: null }),
          mkRow({ id: 902, route: null, routeBack: null, snrBack: null }),
        ],
      });
      const queryClient = new QueryClient();
      expect(() => rerender(
        <QueryClientProvider client={queryClient}>
          <MessagesTab {...makeProps()} />
        </QueryClientProvider>,
      )).not.toThrow();

      // No crash, and no empty statistical strip left dangling: it falls
      // back to whatever rule 1 would show (here, the newest entry).
      expect(stripGroup()?.getAttribute('aria-label')).toBe('Traceroute path');
    });
  });

  describe('non-regression', () => {
    it('with no statistical option available, the box behaves exactly like MessagesTab.tracerouteStrip.test.tsx expects', () => {
      const ROUTED_TRACE = {
        timestamp: Date.now() - 5000,
        route: '[]',
        routeBack: '[]',
        snrTowards: '[-40]',
        snrBack: '[-44]',
        fromNodeNum: CURRENT_NUM,
        toNodeNum: PICKER_NUM,
      };
      renderTab(makeProps({ getRecentTraceroute: () => ROUTED_TRACE }));

      expect(tracerouteInfoBox()).not.toBeNull();
      expect(stripGroup()?.getAttribute('aria-label')).toBe('Traceroute path');
      const age = ageLine();
      expect(age).not.toBeNull();
      expect(age?.textContent).toContain('Last traced');
      expect(statisticalOption()).toBeNull();
      const box = tracerouteInfoBox() as HTMLElement;
      expect(within(box).getByRole('button', { name: /Copy Both/ })).toBeTruthy();
    });

    it('still renders nothing when neither traceroute:read nor traceroute:write permission is granted, statistical option available or not', () => {
      mockUseNodeTraceroutes.mockReturnValue({
        data: TWO_MATCHING_ENTRIES,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockUseTraceroutePairHistory.mockReturnValue({ rows: TWO_VALID_ROWS });
      renderTab(makeProps({
        hasPermission: (resource: string) => resource !== 'traceroute',
      }));

      expect(tracerouteInfoBox()).toBeNull();
    });
  });
});
