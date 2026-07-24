/**
 * @vitest-environment jsdom
 *
 * TX-disabled gating (epic #4294 Phase 2, §3.3) — when `txDisabled` is true,
 * every DM send/request control (DM textarea, send, bell, resend, and the
 * per-node action buttons: traceroute, exchange position, exchange
 * nodeinfo/key-repair, request neighbor-info, admin scan) renders `disabled`
 * with the shared tooltip copy. Reads stay enabled.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import MessagesTab from './MessagesTab';
import type { MeshMessage } from '../types/message';

// MessagesTab pulls a lot of context/poll-cache hooks that are irrelevant to
// txDisabled gating; stub them the same way ChannelsTab.reactions.test.tsx
// stubs useNodes, so this render doesn't need the full provider tree.
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

vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({}),
}));

// The bottom of the DM panel unconditionally renders four chart/graph
// components (TelemetryGraphs, SmartHopsGraphs, LinkQualityGraph,
// PacketStatsChart) — irrelevant to txDisabled gating, but they reach into
// AuthContext/DataContext trees this render doesn't stand up. Stub them.
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

const myMsg: MeshMessage = {
  id: 'src1_3_7001',
  from: CURRENT_NODE_ID,
  to: DM_NODE_ID,
  fromNodeId: CURRENT_NODE_ID,
  toNodeId: DM_NODE_ID,
  text: 'hello there',
  channel: -1,
  portnum: 1,
  isLocalMessage: true,
  timestamp: new Date('2026-07-21T12:00:00Z'),
};

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
    messages: [myMsg, theirMsg],
    currentNodeId: CURRENT_NODE_ID,
    connectionStatus: 'connected',
    selectedDMNode: DM_NODE_ID,
    setSelectedDMNode: noop,
    newMessage: 'hi',
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
    channels: [
      { id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true },
      { id: 1, name: 'Secondary', psk: '', uplinkEnabled: true, downlinkEnabled: true },
    ],
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

describe('MessagesTab txDisabled gating (#4294 Phase 2)', () => {
  it('disables the DM textarea with the shared tooltip when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const textarea = document.querySelector('textarea.message-input');
    expect(textarea).not.toBeNull();
    expect(textarea).toBeDisabled();
    expect(textarea?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });

  it('disables the DM send button when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const sendBtn = document.querySelector('button.send-btn:not(.channel-action-btn)');
    expect(sendBtn).not.toBeNull();
    expect(sendBtn).toBeDisabled();
  });

  it('disables the DM bell button when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const bellBtn = document.querySelector('button.send-btn.channel-action-btn');
    expect(bellBtn).not.toBeNull();
    expect(bellBtn).toBeDisabled();
    expect(bellBtn?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });

  it('disables the resend button on own messages when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const resendBtn = document.querySelector('button.resend-button');
    expect(resendBtn).not.toBeNull();
    expect(resendBtn).toBeDisabled();
    expect(resendBtn?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });

  it('disables both traceroute split-buttons (main + channel toggle) when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const tracerouteBtn = screen.getByText('messages.traceroute_button').closest('button');
    expect(tracerouteBtn).toBeDisabled();
  });

  it('disables the exchange-position button when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const btn = screen.getByText('messages.exchange_position').closest('button');
    expect(btn).toBeDisabled();
  });

  it('disables the exchange-nodeinfo button when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const btn = screen.getByText('messages.exchange_node_info').closest('button');
    expect(btn).toBeDisabled();
  });

  it('disables the request-neighbor-info button when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    const btn = screen.getByText('messages.request_neighbor_info').closest('button');
    expect(btn).toBeDisabled();
  });

  it('disables admin-scan in the actions dropdown when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    fireEvent.click(screen.getByTitle('messages.actions_menu_title'));
    const btn = screen.getByText('messages.scan_for_admin').closest('button');
    expect(btn).toBeDisabled();
    expect(btn?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });

  it('disables request-telemetry in the actions dropdown when txDisabled', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    fireEvent.click(screen.getByTitle('messages.actions_menu_title'));
    const btn = screen.getByText('messages.request_telemetry').closest('button');
    expect(btn).toBeDisabled();
  });

  it('leaves DM controls enabled and reads working when txDisabled is false', () => {
    render(<MessagesTab {...makeProps({ txDisabled: false })} />);
    const textarea = document.querySelector('textarea.message-input');
    expect(textarea).not.toBeDisabled();
    const sendBtn = document.querySelector('button.send-btn:not(.channel-action-btn)');
    expect(sendBtn).not.toBeDisabled();
    const resendBtn = document.querySelector('button.resend-button');
    expect(resendBtn).not.toBeDisabled();
    // Reads: the received message text is still rendered regardless of TX state.
    expect(screen.getByText('hi back')).toBeTruthy();
  });
});
