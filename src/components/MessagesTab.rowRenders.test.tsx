/**
 * @vitest-environment jsdom
 *
 * DM message rows are memoized (perf P3-2). Each poll rebuilds every message
 * from fresh JSON (new objects, new Dates) and a new node list, so before the
 * change a poll redrew every row of the open conversation. A poll that adds
 * one message must now render exactly one row.
 *
 * Rows are counted through LinkPreview, which every text row renders once.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import MessagesTab from './MessagesTab';
import type { MeshMessage } from '../types/message';
import type { DeviceInfo } from '../types/device';

const linkPreviewRenders: string[] = [];
vi.mock('./LinkPreview', () => ({
  default: ({ text }: { text: string }) => {
    linkPreviewRenders.push(text);
    return null;
  },
}));

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
  useSettings: () => ({ nodeHopsCalculation: 'actual', distanceUnit: 'km' }),
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

// This file renders MessagesTab without a QueryClientProvider. The
// traceroute participation picker (epic phase 2, WP2) added an unconditional
// useNodeTraceroutes -> useQuery call, which throws "No QueryClient set"
// without one — stub the hook to a deterministic empty list, mirroring
// MessagesTab.tracerouteStrip.test.tsx.
vi.mock('../hooks/useNodeTraceroutes', () => ({
  useNodeTraceroutes: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
}));

// Statistical Route epic phase 2, WP4: the traceroute box now also calls
// useTraceroutePairHistory unconditionally (with an `enabled` flag) — same
// "no QueryClientProvider in this file" problem as useNodeTraceroutes above,
// same fix.
vi.mock('../hooks/useTraceroutePairHistory', () => ({
  useTraceroutePairHistory: () => ({ rows: undefined, isLoading: false, error: null }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({}),
}));

// The selected node's details pane reads the poll cache (needs a QueryClient);
// it is not under test here.
vi.mock('./NodeDetailsBlock', () => ({ default: () => null }));
vi.mock('./NodeIdentityChangeNotice', () => ({ NodeIdentityChangeNotice: () => null, default: () => null }));
vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./SmartHopsGraphs', () => ({ default: () => null }));
vi.mock('./LinkQualityGraph', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({ default: () => null }));

vi.mock('react-i18next', async (importOriginal) => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, opts?: Record<string, unknown>) =>
    (opts && typeof opts === 'object' && 'defaultValue' in opts
      ? (opts.defaultValue as string)
      : undefined) ?? key;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock(t).useTranslation,
  };
});

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

const theirMsg: MeshMessage = {
  id: 'src1_1_7000',
  from: DM_NODE_ID,
  to: CURRENT_NODE_ID,
  fromNodeId: DM_NODE_ID,
  toNodeId: CURRENT_NODE_ID,
  text: 'hello',
  channel: -1,
  portnum: 1,
  timestamp: new Date('2026-07-21T12:00:00Z'),
};

type MessagesTabProps = React.ComponentProps<typeof MessagesTab>;

function makeProps(overrides: Partial<MessagesTabProps> = {}): MessagesTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    processedNodes: [],
    nodes: [],
    messages: [theirMsg],
    currentNodeId: CURRENT_NODE_ID,
    connectionStatus: 'connected',
    selectedDMNode: DM_NODE_ID,
    setSelectedDMNode: noop,
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

function dm(n: number): MeshMessage {
  const mine = n % 2 === 0;
  return {
    id: `src1_1_${7000 + n}`,
    from: mine ? CURRENT_NODE_ID : DM_NODE_ID,
    to: mine ? DM_NODE_ID : CURRENT_NODE_ID,
    fromNodeId: mine ? CURRENT_NODE_ID : DM_NODE_ID,
    toNodeId: mine ? DM_NODE_ID : CURRENT_NODE_ID,
    text: `dm ${n}`,
    channel: -1,
    portnum: 1,
    timestamp: new Date(Date.UTC(2026, 6, 21, 12, 0, n)),
    deliveryState: mine ? ('delivered' as MeshMessage['deliveryState']) : undefined,
  };
}

function nodes(lastHeard: number): DeviceInfo[] {
  return [
    { nodeNum: 0xaaaaaaaa, user: { id: DM_NODE_ID, longName: 'Alice', shortName: 'ALC', hwModel: 0 }, lastHeard } as unknown as DeviceInfo,
    { nodeNum: 0xcccccccc, user: { id: CURRENT_NODE_ID, longName: 'Me', shortName: 'ME', hwModel: 0 }, lastHeard } as unknown as DeviceInfo,
  ];
}

/** What a poll does: same content, all-new objects and Dates. */
function repoll(list: MeshMessage[]): MeshMessage[] {
  return list.map(m => ({ ...m, timestamp: new Date(m.timestamp.getTime()) }));
}

beforeEach(() => {
  linkPreviewRenders.length = 0;
});

describe('MessagesTab memoized DM rows', () => {
  it('a poll that adds one message renders one row', () => {
    const first = [dm(1), dm(2), dm(3), dm(4)];
    const { rerender } = render(<MessagesTab {...makeProps({ messages: first, nodes: nodes(100), processedNodes: nodes(100) })} />);
    expect(linkPreviewRenders.filter(t => t.startsWith('dm '))).toHaveLength(4);

    linkPreviewRenders.length = 0;
    rerender(<MessagesTab {...makeProps({ messages: [...repoll(first), dm(5)], nodes: nodes(200), processedNodes: nodes(200) })} />);
    expect(linkPreviewRenders).toEqual(['dm 5']);
  });

  it('a poll that changes nothing renders no row', () => {
    const first = [dm(1), dm(2), dm(3)];
    const { rerender } = render(<MessagesTab {...makeProps({ messages: first, nodes: nodes(100), processedNodes: nodes(100) })} />);
    linkPreviewRenders.length = 0;
    rerender(<MessagesTab {...makeProps({ messages: repoll(first), nodes: nodes(300), processedNodes: nodes(300) })} />);
    expect(linkPreviewRenders).toEqual([]);
  });

  it('redraws the one row whose delivery state changed', () => {
    const first = [dm(1), dm(2), dm(3)];
    const { rerender } = render(<MessagesTab {...makeProps({ messages: first, nodes: nodes(100), processedNodes: nodes(100) })} />);
    linkPreviewRenders.length = 0;
    const next = repoll(first);
    next[1] = { ...next[1], deliveryState: 'confirmed' as MeshMessage['deliveryState'] };
    rerender(<MessagesTab {...makeProps({ messages: next, nodes: nodes(100), processedNodes: nodes(100) })} />);
    expect(linkPreviewRenders).toEqual(['dm 2']);
  });
});
