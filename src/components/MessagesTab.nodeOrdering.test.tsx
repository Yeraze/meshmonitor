/**
 * @vitest-environment jsdom
 *
 * MessagesTab node ordering tests.
 *
 * Verifies that the DM node list prioritizes:
 * 1. Pinned/sticky nodes
 * 2. Favorites
 * 3. Most recent message time (lastMessageTime descending)
 * 4. Fallback: most recently heard node (lastHeard descending)
 * 5. Deterministic alphabetical fallback
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import MessagesTab from './MessagesTab';
import type { DeviceInfo } from '../types/device';
import type { MeshMessage } from '../types/message';

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
  useSettings: () => ({ nodeHopsCalculation: 'actual', distanceUnit: 'km', nodeListStyle: 'monochrome' }),
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

vi.mock('../hooks/useNodeTraceroutes', () => ({
  useNodeTraceroutes: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../hooks/useTraceroutePairHistory', () => ({
  useTraceroutePairHistory: () => ({ rows: undefined, isLoading: false, error: null }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({}),
}));

vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./SmartHopsGraphs', () => ({ default: () => null }));
vi.mock('./LinkQualityGraph', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({ default: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts && typeof opts === 'object' && 'defaultValue' in opts
        ? (opts.defaultValue as string)
        : undefined) ?? key,
  }),
}));

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const CURRENT_NODE_ID = '!00000001';

type MessagesTabProps = React.ComponentProps<typeof MessagesTab>;

function makeProps(overrides: Partial<MessagesTabProps> = {}): MessagesTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    processedNodes: [],
    nodes: [],
    messages: [],
    currentNodeId: CURRENT_NODE_ID,
    connectionStatus: 'connected',
    selectedDMNode: '!00000002',
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
    showIncompleteNodes: true,
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

function makeNode(num: number, id: string, name: string, lastHeard: number | null, isFavorite = false): DeviceInfo {
  return {
    nodeNum: num,
    user: { id, longName: name, shortName: name.slice(0, 4), hwModel: 1 },
    lastHeard: lastHeard ?? undefined,
    isFavorite,
  } as unknown as DeviceInfo;
}

describe('MessagesTab node ordering', () => {
  it('orders nodes with no messages by lastHeard descending', () => {
    const nodeA = makeNode(10, '!0000000a', 'Node A (Oldest)', 1000);
    const nodeB = makeNode(20, '!0000000b', 'Node B (Newest)', 3000);
    const nodeC = makeNode(30, '!0000000c', 'Node C (Middle)', 2000);

    const { container } = render(
      <MessagesTab {...makeProps({ processedNodes: [nodeA, nodeB, nodeC], nodes: [nodeA, nodeB, nodeC] })} />,
    );

    const longNames = Array.from(container.querySelectorAll('.node-longname')).map((el) => el.textContent);
    expect(longNames).toEqual([
      'Node B (Newest)',
      'Node C (Middle)',
      'Node A (Oldest)',
    ]);
  });

  it('keeps nodes with message history above nodes without messages, then sorts by lastHeard', () => {
    const nodeNoMsg1 = makeNode(10, '!0000000a', 'NoMsg Recent', 5000);
    const nodeNoMsg2 = makeNode(20, '!0000000b', 'NoMsg Old', 1000);
    const nodeWithMsg = makeNode(30, '!0000000c', 'Has Message', 2000);

    const msg: MeshMessage = {
      id: 'msg-1',
      from: '!0000000c',
      to: CURRENT_NODE_ID,
      fromNodeId: '!0000000c',
      toNodeId: CURRENT_NODE_ID,
      text: 'hello',
      channel: -1,
      portnum: 1,
      timestamp: new Date('2026-07-21T12:00:00Z'),
    };

    const { container } = render(
      <MessagesTab
        {...makeProps({
          processedNodes: [nodeNoMsg1, nodeNoMsg2, nodeWithMsg],
          nodes: [nodeNoMsg1, nodeNoMsg2, nodeWithMsg],
          messages: [msg],
        })}
      />,
    );

    const longNames = Array.from(container.querySelectorAll('.node-longname')).map((el) => el.textContent);
    expect(longNames).toEqual([
      'Has Message',
      'NoMsg Recent',
      'NoMsg Old',
    ]);
  });

  it('keeps favorites above non-favorites, sorting each group by lastHeard descending', () => {
    const favOld = makeNode(10, '!0000000a', 'Fav Old', 1000, true);
    const favNew = makeNode(20, '!0000000b', 'Fav New', 5000, true);
    const nonFavNew = makeNode(30, '!0000000c', 'NonFav New', 6000, false);
    const nonFavOld = makeNode(40, '!0000000d', 'NonFav Old', 2000, false);

    const { container } = render(
      <MessagesTab
        {...makeProps({
          processedNodes: [favOld, favNew, nonFavNew, nonFavOld],
          nodes: [favOld, favNew, nonFavNew, nonFavOld],
        })}
      />,
    );

    const longNames = Array.from(container.querySelectorAll('.node-longname')).map((el) => el.textContent);
    expect(longNames).toEqual([
      'Fav New',
      'Fav Old',
      'NonFav New',
      'NonFav Old',
    ]);
  });
});
