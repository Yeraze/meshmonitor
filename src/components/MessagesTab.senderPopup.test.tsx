/**
 * @vitest-environment jsdom
 *
 * #5645 on the Messages tab:
 *   - the DM list row shows a leading status emoji in its indicator strip
 *   - the short-name chip still toggles pin and nothing else (it is NOT a
 *     popup trigger, and the row click still only selects the conversation)
 *   - the DM thread header name and the thread avatars open the node popup
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

// Needs a QueryClient; not under test here.
vi.mock('./NodeDetailsBlock', () => ({ default: () => null }));
vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./SmartHopsGraphs', () => ({ default: () => null }));
vi.mock('./LinkQualityGraph', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({ default: () => null }));

// The default shared mock: it honours `t(key, 'Fallback {{var}}', vars)`, which
// the status label uses.
vi.mock('react-i18next', async (importOriginal) => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock().useTranslation,
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

const OTHER_ID = '!00000002';

// With a real selected node the thread panel mounts children that call
// useQuery. Give them a client whose queries never run.
function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}


function dmFrom(id: string, text: string): MeshMessage {
  return {
    id: `src1_2_${text.length}`,
    from: id,
    to: CURRENT_NODE_ID,
    fromNodeId: id,
    toNodeId: CURRENT_NODE_ID,
    text,
    channel: -1,
    portnum: 1,
    timestamp: new Date('2026-07-21T12:00:00Z'),
  } as unknown as MeshMessage;
}

describe('MessagesTab status + popup triggers (#5645)', () => {
  beforeEach(() => {
    localStorage.clear();
    // The thread panel's stats widgets fetch on mount; keep them off the network.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the leading status emoji in the DM list row, labelled with the full status', () => {
    const emojiNode = { ...makeNode(2, OTHER_ID, 'Emoji Node', 3000), nodeStatus: '🚗 Driving' } as DeviceInfo;
    const textNode = { ...makeNode(3, '!00000003', 'Text Node', 2000), nodeStatus: 'Driving' } as DeviceInfo;
    const { container } = render(
      <MessagesTab {...makeProps({ processedNodes: [emojiNode, textNode], nodes: [emojiNode, textNode] })} />,
    );
    const rows = Array.from(container.querySelectorAll('.node-item')) as HTMLElement[];
    const emojiRow = rows.find(r => r.textContent?.includes('Emoji Node'))!;
    const textRow = rows.find(r => r.textContent?.includes('Text Node'))!;

    const item = within(emojiRow).getByTestId('status-emoji-indicator');
    expect(item.textContent).toBe('🚗');
    expect(item.getAttribute('aria-label')).toContain('🚗 Driving');
    expect(item.closest('.node-actions')).not.toBeNull();
    expect(within(textRow).queryByTestId('status-emoji-indicator')).toBeNull();
  });

  it('a click on the short-name chip still toggles pin, and opens no popup', () => {
    const node = { ...makeNode(2, OTHER_ID, 'Emoji Node', 3000), nodeStatus: '🚗 Driving' } as DeviceInfo;
    const handleSenderClick = vi.fn();
    const setSelectedDMNode = vi.fn();
    const { container } = render(
      <MessagesTab
        {...makeProps({ processedNodes: [node], nodes: [node], handleSenderClick, setSelectedDMNode, selectedDMNode: '' })}
      />,
    );
    const chip = container.querySelector('.node-item .node-short') as HTMLElement;
    expect(chip).not.toHaveClass('sticky');

    fireEvent.click(chip);
    expect(container.querySelector('.node-item .node-short')).toHaveClass('sticky');
    expect(JSON.parse(localStorage.getItem('meshmonitor-sticky-dm-nodes') || '[]')).toEqual([2]);

    fireEvent.click(container.querySelector('.node-item .node-short') as HTMLElement);
    expect(container.querySelector('.node-item .node-short')).not.toHaveClass('sticky');

    expect(handleSenderClick).not.toHaveBeenCalled();
    // The chip swallows its click, so the row is not selected either.
    expect(setSelectedDMNode).not.toHaveBeenCalled();
  });

  it('a click on the row still selects the conversation and opens no popup', () => {
    const node = { ...makeNode(2, OTHER_ID, 'Emoji Node', 3000), nodeStatus: '🚗 Driving' } as DeviceInfo;
    const handleSenderClick = vi.fn();
    const setSelectedDMNode = vi.fn();
    const { container } = render(
      <MessagesTab
        {...makeProps({ processedNodes: [node], nodes: [node], handleSenderClick, setSelectedDMNode, selectedDMNode: '' })}
      />,
    );
    fireEvent.click(container.querySelector('.node-item .node-longname') as HTMLElement);
    expect(setSelectedDMNode).toHaveBeenCalledWith(OTHER_ID);
    expect(handleSenderClick).not.toHaveBeenCalled();
  });

  it('the DM thread header name opens the popup', () => {
    const node = makeNode(2, OTHER_ID, 'Other Node', 3000);
    const handleSenderClick = vi.fn();
    const { container } = render(
      <MessagesTab {...makeProps({ processedNodes: [node], nodes: [node], handleSenderClick })} />,
    );
    const header = container.querySelector('.dm-header-top h3') as HTMLElement;
    const button = within(header).getByRole('button');
    fireEvent.click(button);
    expect(handleSenderClick).toHaveBeenCalledTimes(1);
    expect(handleSenderClick.mock.calls[0][0]).toBe(OTHER_ID);
    expect(handleSenderClick.mock.calls[0][1].type).toBe('click');
  });

  it('the DM thread avatar is keyboard reachable and carries the status badge', () => {
    const node = { ...makeNode(2, OTHER_ID, 'Other Node', 3000), nodeStatus: '💤 Sleeping' } as DeviceInfo;
    const handleSenderClick = vi.fn();
    const { container } = render(
      <MessagesTab
        {...makeProps({
          processedNodes: [node],
          nodes: [node],
          messages: [dmFrom(OTHER_ID, 'hello there')],
          handleSenderClick,
        })}
      />,
    );
    const dot = container.querySelector('.message-bubble-container .sender-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('tabindex', '0');
    expect(within(dot).getByTestId('sender-avatar-status-badge').textContent).toBe('💤');

    fireEvent.keyDown(dot, { key: ' ' });
    fireEvent.click(dot);
    expect(handleSenderClick).toHaveBeenCalledTimes(2);
    expect(handleSenderClick.mock.calls[0][0]).toBe(OTHER_ID);
    expect(screen.getAllByTestId('sender-avatar-status-badge').length).toBeGreaterThan(0);
  });
});
