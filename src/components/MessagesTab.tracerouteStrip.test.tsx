/**
 * @vitest-environment jsdom
 *
 * Integration coverage for the traceroute visual strip wiring in
 * `MessagesTab.tsx` (#4381 WP4). Proves the swap from the two plain-text
 * `formatTracerouteRoute` lines to `<TracerouteStrip>` left every other
 * behavior in the traceroute box byte-identical:
 *   - the `traceroute('write')` permission gate
 *   - the "last traced X ago" age line
 *   - the pending/failed badges for a null-route row
 *   - the "no response" fallback text (now rendered instead of the strip,
 *     rather than instead of the two text lines)
 *
 * Mock block copied from `MessagesTab.composeFocus.test.tsx` (the canonical
 * MessagesTab test harness). The `react-i18next` override is the NodePopup
 * pattern (`NodePopup.test.tsx`) rather than composeFocus's own — composeFocus
 * only handles the `t(key, { defaultValue })` object shape, but this file
 * also needs the family's `t(key, defaultString)` / `t(key, defaultString,
 * options)` positional-default shapes (used throughout `TracerouteStrip.tsx`
 * and by several calls in this very traceroute box) to resolve to real
 * English text rather than silently falling back to the raw key.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MessagesTab from './MessagesTab';
import type { MeshMessage } from '../types/message';
import type { DeviceInfo } from '../types/device';
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

vi.mock('../contexts/MapContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMapContext: () => ({ traceroutes: [], neighborInfo: [], setNeighborInfo: () => {} }),
}));

vi.mock('./ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ showToast: () => {} }),
}));

vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({}),
}));

vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./SmartHopsGraphs', () => ({ default: () => null }));
vi.mock('./LinkQualityGraph', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({ default: () => null }));

// The global setup.ts mock for react-i18next ignores `options.defaultValue`
// (it only interpolates `{{token}}` placeholders into the raw key), so it
// can't produce real English text for the family's `t(key, defaultValue)` /
// `t(key, defaultValue, options)` calls that TracerouteStrip.tsx (and this
// traceroute box) make. Override locally — mirrors
// src/components/NodePopup/NodePopup.test.tsx — while keeping `importOriginal`
// so `Trans` (used elsewhere in MessagesTab.tsx) stays real. Also falls back
// to the real `en.json` entry (not just the call site's positional default)
// for pre-existing calls like `t('messages.last_traced', { time })` that
// carry no positional default at all, so those age/badge lines render their
// real English text too, not the raw key.
//
// en.json is NOT flat — most keys are dotted strings, but it also has
// genuinely nested objects (e.g. `map: { maximumAge: ... }`), so the whole
// import can't be honestly typed as `Record<string, string>`. Type it as
// `Record<string, unknown>` and narrow per lookup instead: a key that
// resolves to a nested object degrades to the fallback rather than ever
// interpolating `[object Object]` into rendered text.
const enDict = enLocale as Record<string, unknown>;
function lookupEnDefault(key: string): string | undefined {
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
      let out = defaultValue ?? lookupEnDefault(key) ?? key;
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

const CURRENT_NODE_ID = '!cccccccc';
const DM_NODE_ID = '!aaaaaaaa';
const FROM_NUM = 1000; // stand-in for the current node's nodeNum in the fixture row
const TO_NUM = 2000; // stand-in for the DM target's nodeNum in the fixture row

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
  nodeNum: TO_NUM,
  user: { id: DM_NODE_ID, longName: 'Destination Node', shortName: 'DEST' },
};

/** A direct (no intermediate hops) forward+return traceroute — the "happy
 *  path" the strip renders instead of the old two text lines. */
const ROUTED_TRACE = {
  timestamp: Date.now() - 5000,
  route: '[]',
  routeBack: '[]',
  snrTowards: '[-40]',
  snrBack: '[-44]',
  fromNodeNum: FROM_NUM,
  toNodeNum: TO_NUM,
};

const FRESH_NULL_TRACE = {
  timestamp: Date.now(),
  route: null as unknown as string,
  routeBack: null as unknown as string,
  snrTowards: null as unknown as string,
  snrBack: null as unknown as string,
  fromNodeNum: FROM_NUM,
  toNodeNum: TO_NUM,
};

const OLD_NULL_TRACE = {
  ...FRESH_NULL_TRACE,
  timestamp: Date.now() - 5 * 60 * 1000, // 5 minutes ago — past the 1-minute pending window
};

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

/** `NodeDetailsBlock` (rendered alongside the traceroute box once a DM node
 *  in `nodes` resolves) reads `useChannels` -> `usePoll` -> a real
 *  `useQuery`, which needs an actual `QueryClientProvider` in the tree —
 *  composeFocus's template avoids this by leaving `nodes` empty. */
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
const noResponseText = () => document.querySelector('.traceroute-info .traceroute-route');

describe('MessagesTab traceroute visual strip wiring (#4381 WP4)', () => {
  it('renders the strip when getRecentTraceroute returns a routed row', () => {
    renderTab(makeProps({ getRecentTraceroute: () => ROUTED_TRACE }));

    expect(tracerouteInfoBox()).not.toBeNull();
    expect(stripGroup()).not.toBeNull();
    expect(stripGroup()?.getAttribute('aria-label')).toBe('Traceroute path');
    // The old two-text-line fallback must NOT also render alongside the strip.
    expect(noResponseText()).toBeNull();
  });

  it('renders nothing when traceroute:write permission is denied', () => {
    renderTab(makeProps({
      getRecentTraceroute: () => ROUTED_TRACE,
      hasPermission: (resource: string, action: string) =>
        !(resource === 'traceroute' && action === 'write'),
    }));

    expect(tracerouteInfoBox()).toBeNull();
  });

  it('still renders the "last traced X ago" age line', () => {
    renderTab(makeProps({ getRecentTraceroute: () => ROUTED_TRACE }));

    const age = ageLine();
    expect(age).not.toBeNull();
    expect(age?.textContent).toContain('Last traced');
    expect(age?.textContent).toContain('ago');
  });

  it('shows the pending badge for a fresh null-route row (less than 1 minute old)', () => {
    renderTab(makeProps({ getRecentTraceroute: () => FRESH_NULL_TRACE }));

    expect(pendingBadge()).not.toBeNull();
    expect(failedBadge()).toBeNull();
  });

  it('shows the failed badge for an old null-route row', () => {
    renderTab(makeProps({ getRecentTraceroute: () => OLD_NULL_TRACE }));

    expect(failedBadge()).not.toBeNull();
    expect(pendingBadge()).toBeNull();
  });

  it('a null-route row renders "No response received" and no strip', () => {
    renderTab(makeProps({ getRecentTraceroute: () => FRESH_NULL_TRACE }));

    expect(stripGroup()).toBeNull();
    expect(noResponseText()?.textContent).toBe('No response received');
  });

  it('wires onOpenNodeDetails: hovering a hop and clicking "More Details" calls setSelectedDMNode with that node\'s user.id', () => {
    // #TRS-phase1 WP1 §8.5 case 26. dmNode (TO_NUM) is the only entry in
    // `nodes`, so it's the only hop the strip can resolve a real userId for
    // — hovering it and clicking the action must reach setSelectedDMNode.
    const setSelectedDMNode = vi.fn();
    renderTab(makeProps({ getRecentTraceroute: () => ROUTED_TRACE, setSelectedDMNode }));

    const box = tracerouteInfoBox() as HTMLElement;
    const glyph = within(box).getByText('DEST').closest('[tabindex]') as HTMLElement;
    expect(glyph).not.toBeNull();
    fireEvent.mouseEnter(glyph);

    const button = screen.getByRole('button', { name: /More Details/ });
    fireEvent.click(button);

    expect(setSelectedDMNode).toHaveBeenCalledWith(DM_NODE_ID);
  });

  it('the strip-driven details load calls setSelectedDMNode ONLY — no accompanying setActiveTab (locks in decision §0.3)', () => {
    // MessagesTab has no `setActiveTab` prop or UIContext dependency at all
    // (unlike NodesTab's `handlePopupDMClick`) — the strip only ever renders
    // on the Messages tab, so there is nothing to switch to. A single call
    // is therefore the complete side-effect surface of the callback.
    const setSelectedDMNode = vi.fn();
    renderTab(makeProps({ getRecentTraceroute: () => ROUTED_TRACE, setSelectedDMNode }));

    const box = tracerouteInfoBox() as HTMLElement;
    const glyph = within(box).getByText('DEST').closest('[tabindex]') as HTMLElement;
    fireEvent.mouseEnter(glyph);
    fireEvent.click(screen.getByRole('button', { name: /More Details/ }));

    expect(setSelectedDMNode).toHaveBeenCalledTimes(1);
  });
});
