/**
 * @vitest-environment jsdom
 *
 * #6586 phase 3: MessagesTab passes the Meshtastic 200-byte limit to the image dialog.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import MessagesTab from './MessagesTab';
import { ComposeDraftContext, createComposeDraftStore } from '../contexts/composeDraftStore';
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

// The bottom of the DM panel unconditionally renders four chart/graph
// components (TelemetryGraphs, SmartHopsGraphs, LinkQualityGraph,
// PacketStatsChart) — irrelevant to txDisabled gating, but they reach into
// AuthContext/DataContext trees this render doesn't stand up. Stub them.
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


vi.mock('./McoImage/compose/McoImageComposeDialog', async () => {
  const React = await import('react');
  return {
    default: (p: { limit: number; onChoose(t: string): void }) =>
      React.createElement(
        'div',
        { role: 'dialog', 'data-limit': String(p.limit) },
        React.createElement('button', { onClick: () => p.onChoose('MCOimg-test-payload') }, 'choose-image'),
      ),
  };
});

const PAYLOAD = 'MCOimg-test-payload';
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


describe('MessagesTab insert image (#6586)', () => {
  it('offers Insert image, passes 200 bytes, and sends exactly the payload', async () => {
    const handleSendDirectMessage = vi.fn(async () => {});
    const store = createComposeDraftStore();
    render(
      <ComposeDraftContext.Provider value={store}>
        <MessagesTab {...makeProps({ handleSendDirectMessage })} />
      </ComposeDraftContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'messages.insert_menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert image|messages.insert_image/ }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('data-limit')).toBe('200');
    fireEvent.click(screen.getByText('choose-image'));
    expect(store.get()).toBe(PAYLOAD);
    fireEvent.click(document.querySelector('button.send-btn:not(.channel-action-btn)') as HTMLElement);
    expect(handleSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it('disables the + button while TX is off', () => {
    render(<MessagesTab {...makeProps({ txDisabled: true })} />);
    expect((screen.getByRole('button', { name: 'messages.insert_menu' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
