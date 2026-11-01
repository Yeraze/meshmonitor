/**
 * @vitest-environment jsdom
 *
 * MessagesTab unread-conversation dropdown tests.
 *
 * #6115: conversations with unread DMs sort to the top of the conversation
 *        list (desktop list + mobile <select>), newest message first, ahead of
 *        favorites and filter ordering.
 * #6116: the mobile native <select> option order stays frozen while the picker
 *        is focused/open, despite a data poll that would reorder it, then
 *        settles to the live order on blur.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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
    selectedDMNode: null,
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

function dmMessage(id: string, fromNodeId: string, when: string): MeshMessage {
  return {
    id,
    from: fromNodeId,
    to: CURRENT_NODE_ID,
    fromNodeId,
    toNodeId: CURRENT_NODE_ID,
    text: 'hi',
    channel: -1,
    portnum: 1,
    timestamp: new Date(when),
  } as unknown as MeshMessage;
}

function desktopOrder(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.node-longname')).map((el) => el.textContent);
}

function mobileOptionValues(container: HTMLElement): string[] {
  const select = container.querySelector('.node-dropdown-select') as HTMLSelectElement;
  return Array.from(select.querySelectorAll('option'))
    .map((o) => (o as HTMLOptionElement).value)
    .filter((v) => v !== '');
}

describe('MessagesTab unread-first conversation ordering (#6115)', () => {
  it('sorts unread DMs to the top, newest first, ahead of favorites', () => {
    // A read favorite with the newest message overall.
    const fav = makeNode(10, '!0000000a', 'Fav Read', 9000, true);
    // Two unread non-favorites; unreadNew is newer than unreadOld.
    const unreadOld = makeNode(20, '!0000000b', 'Unread Old', 2000, false);
    const unreadNew = makeNode(30, '!0000000c', 'Unread New', 2500, false);
    // A plain non-favorite with no messages.
    const plain = makeNode(40, '!0000000d', 'Plain', 1000, false);

    const messages: MeshMessage[] = [
      dmMessage('m-fav', '!0000000a', '2026-07-21T14:00:00Z'), // newest, but read
      dmMessage('m-old', '!0000000b', '2026-07-21T12:00:00Z'),
      dmMessage('m-new', '!0000000c', '2026-07-21T13:00:00Z'),
    ];

    const { container } = render(
      <MessagesTab
        {...makeProps({
          processedNodes: [fav, unreadOld, unreadNew, plain],
          nodes: [fav, unreadOld, unreadNew, plain],
          messages,
          unreadCountsData: { directMessages: { '!0000000b': 1, '!0000000c': 2 } } as never,
        })}
      />,
    );

    expect(desktopOrder(container)).toEqual([
      'Unread New', // newest unread first
      'Unread Old', // older unread next
      'Fav Read', // favorite (read) below all unread
      'Plain', // no-message non-favorite last
    ]);

    // The mobile dropdown is built from the same sorted list, so it agrees.
    expect(mobileOptionValues(container)).toEqual([
      '!0000000c',
      '!0000000b',
      '!0000000a',
      '!0000000d',
    ]);
  });

  it('keeps unread DMs on top even under a hops-based filter', () => {
    // Under the 'hops' filter every node passes membership but the list is
    // ordered by hops instead of message time. A favorite would normally lead;
    // the unread non-favorite must still override that ordering.
    const favRead = makeNode(10, '!0000000a', 'Fav Read', 9000, true);
    const unread = makeNode(20, '!0000000b', 'Unread', 500, false);

    const { container } = render(
      <MessagesTab
        {...makeProps({
          processedNodes: [favRead, unread],
          nodes: [favRead, unread],
          messages: [dmMessage('m-u', '!0000000b', '2026-07-21T10:00:00Z')],
          dmFilter: 'hops' as never,
          unreadCountsData: { directMessages: { '!0000000b': 1 } } as never,
        })}
      />,
    );

    expect(desktopOrder(container)[0]).toBe('Unread');
  });
});

describe('MessagesTab mobile dropdown is stable while focused (#6116)', () => {
  it('freezes option order while the <select> is focused despite a poll, then settles on blur', () => {
    // Two non-favorites, no messages. Default order is by lastHeard desc: X then Y.
    const nodeX = makeNode(10, '!000000a1', 'Node X', 5000, false);
    const nodeY = makeNode(20, '!000000a2', 'Node Y', 1000, false);

    const baseProps = makeProps({
      processedNodes: [nodeX, nodeY],
      nodes: [nodeX, nodeY],
    });

    const { container, rerender } = render(<MessagesTab {...baseProps} />);

    // Baseline order: X before Y.
    expect(mobileOptionValues(container)).toEqual(['!000000a1', '!000000a2']);

    // User opens the native picker.
    const select = container.querySelector('.node-dropdown-select') as HTMLSelectElement;
    fireEvent.focus(select);

    // A poll arrives: Y now has an unread DM, which (via #6115) would move Y to
    // the top. While focused, the frozen snapshot must keep the old order.
    const polledProps = makeProps({
      processedNodes: [nodeX, nodeY],
      nodes: [nodeX, nodeY],
      messages: [dmMessage('m-y', '!000000a2', '2026-07-21T15:00:00Z')],
      unreadCountsData: { directMessages: { '!000000a2': 1 } } as never,
    });
    rerender(<MessagesTab {...polledProps} />);

    // Order is still frozen (X, Y) even though the live data would reorder.
    expect(mobileOptionValues(container)).toEqual(['!000000a1', '!000000a2']);

    // Closing the picker settles to the live order (Y unread -> top).
    fireEvent.blur(select);
    expect(mobileOptionValues(container)).toEqual(['!000000a2', '!000000a1']);
  });
});
