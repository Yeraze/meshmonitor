/**
 * @vitest-environment jsdom
 *
 * "Send Direct Message" compose focus (#4325).
 *
 * The node list's Send DM button already selected the node and opened the
 * conversation — what it didn't do was leave you able to type, so the button
 * dropped you on a compose box you still had to click into. MessagesTab now
 * honors a `pendingComposeFocus` request.
 *
 * The load-bearing case is the LAST test: the request arrives before the
 * textarea exists (navigating in mounts this tab with the conversation pane
 * rendering afterwards). An effect alone consumed the request against a null
 * ref and the box never got focused — that was the actual bug, and it is why
 * the textarea uses a callback ref.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import MessagesTab from './MessagesTab';
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
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const CURRENT_NODE_ID = '!cccccccc';
const DM_NODE_ID = '!aaaaaaaa';
const OTHER_NODE_ID = '!bbbbbbbb';

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

const textarea = () => document.querySelector('textarea.message-input');

describe('MessagesTab compose focus (#4325)', () => {
  it('focuses the compose box when a request targets the selected node', () => {
    const clearComposeFocus = vi.fn();
    render(<MessagesTab {...makeProps({ pendingComposeFocus: DM_NODE_ID, clearComposeFocus })} />);

    expect(textarea()).not.toBeNull();
    expect(document.activeElement).toBe(textarea());
    expect(clearComposeFocus).toHaveBeenCalled();
  });

  it('does not steal focus when no request is pending', () => {
    const clearComposeFocus = vi.fn();
    render(<MessagesTab {...makeProps({ pendingComposeFocus: null, clearComposeFocus })} />);

    expect(textarea()).not.toBeNull();
    expect(document.activeElement).not.toBe(textarea());
    expect(clearComposeFocus).not.toHaveBeenCalled();
  });

  it('drops a stale request aimed at a different node without focusing', () => {
    const clearComposeFocus = vi.fn();
    render(
      <MessagesTab
        {...makeProps({ pendingComposeFocus: OTHER_NODE_ID, clearComposeFocus })}
      />,
    );

    expect(document.activeElement).not.toBe(textarea());
    // Consumed anyway, so it can't fire later against the wrong conversation.
    expect(clearComposeFocus).toHaveBeenCalled();
  });

  it('still focuses when the compose box mounts after the request arrives', () => {
    // The regression: on the first pass there is no textarea (here modelled via
    // messages:write being absent). A request consumed against the null ref
    // would be lost; it must survive until the box actually mounts.
    const clearComposeFocus = vi.fn();
    const { rerender } = render(
      <MessagesTab
        {...makeProps({
          pendingComposeFocus: DM_NODE_ID,
          clearComposeFocus,
          hasPermission: () => false,
        })}
      />,
    );
    expect(textarea()).toBeNull();
    expect(clearComposeFocus).not.toHaveBeenCalled();

    rerender(
      <MessagesTab
        {...makeProps({
          pendingComposeFocus: DM_NODE_ID,
          clearComposeFocus,
          hasPermission: () => true,
        })}
      />,
    );

    expect(textarea()).not.toBeNull();
    expect(document.activeElement).toBe(textarea());
    expect(clearComposeFocus).toHaveBeenCalled();
  });
});
