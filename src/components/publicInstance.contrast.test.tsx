/**
 * @vitest-environment jsdom
 *
 * Public-instance mode (#5156), side by side: what a signed-in user sees vs
 * what a signed-out viewer sees of the SAME data.
 *
 * The signed-in payload is a fixture shaped like `/api/poll` JSON. The
 * signed-out payload is that fixture run through the real
 * `redactPublicPayload` with every toggle on, so this test follows the
 * redactor. Each view renders once from each payload, the signed-out one
 * inside an AuthContext that says "anonymous, public mode on".
 *
 * Clock: pinned to 14:40:00 UTC. The node was heard 5 minutes ago (14:35) and
 * the messages were sent at 14:37. Floored to the hour, both read 14:00.
 */
process.env.TZ = 'UTC';

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import MessagesTab from './MessagesTab';
import NodeDetailsBlock from './NodeDetailsBlock';
import { NodeListName, NodeListTime } from './nodes/NodeListRowText';
import { PublicInstanceNotice } from './PublicInstanceNotice';
import { ChannelMessageRow } from './messages/ChannelMessageRow';
import type { MessageRowActions, MessageRowNames } from './messages/DmMessageRow';
import { AuthContext } from '../contexts/authContextObject';
import type { AuthContextType, AuthStatus } from '../contexts/AuthContext';
import { redactPublicPayload } from '../server/utils/publicInstanceRedactor';
import { getUserDisplayName } from '../utils/nodeHelpers';
import type { RedactionConfig } from '../utils/publicInstanceMode';
import type { MeshMessage } from '../types/message';
import type { DeviceInfo } from '../types/device';

vi.mock('./LinkPreview', () => ({ default: () => null }));

vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
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
  useNodeListStyle: () => 'monochrome',
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

// MessagesTab's own details pane is covered by the NodeDetailsBlock cases below.
vi.mock('./NodeIdentityChangeNotice', () => ({ NodeIdentityChangeNotice: () => null, default: () => null }));
vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./SmartHopsGraphs', () => ({ default: () => null }));
vi.mock('./LinkQualityGraph', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({ default: () => null }));
vi.mock('./NodeDetailsBlock.css', () => ({}));
vi.mock('./AssetTrackingSection', () => ({ default: () => null, AssetTrackingSection: () => null }));

vi.mock('react-i18next', async (importOriginal) => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  // Real copy for the public-instance keys, defaultValue otherwise.
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (key === 'public_instance.hidden_message') return 'Message hidden on this public view';
    if (key === 'public_instance.notice') return 'Public view: positions are approximate and some details are hidden.';
    return (opts && typeof opts === 'object' && 'defaultValue' in opts
      ? (opts.defaultValue as string)
      : undefined) ?? key;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock(t).useTranslation,
  };
});

// ---------------------------------------------------------------------------
// Fixture: the signed-in payload, shaped like /api/poll, plus its redacted twin
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-16T14:40:00Z');
const LONG_NAME = 'Sentinel Longname Alpha';
const SHORT_NAME = 'SNA';
const BODY = 'Exact sentinel body 7f3a';
const PUBLIC_KEY = 'q83vEjRWeJC7yg6jNEAuhP2m5kTzSx1bYwUo0nLdA9c=';
const ME = '!cccccccc';
const ALPHA = '!aaaaaaaa';

const lastHeardS = Math.floor(NOW.getTime() / 1000) - 5 * 60; // 14:35
const sentMs = Date.parse('2026-11-16T14:37:00Z');

const pollFixture = {
  nodes: [
    {
      nodeNum: 0xaaaaaaaa,
      nodeId: ALPHA,
      user: { id: ALPHA, longName: LONG_NAME, shortName: SHORT_NAME, hwModel: 0, role: 'CLIENT', publicKey: PUBLIC_KEY },
      position: { latitude: 40.7128001, longitude: -74.0060002, altitude: 12 },
      positionPrecisionBits: 32,
      lastHeard: lastHeardS,
    },
    {
      nodeNum: 0xcccccccc,
      nodeId: ME,
      user: { id: ME, longName: 'Sentinel Local Beta', shortName: 'SNB', hwModel: 0, role: 'CLIENT' },
      positionPrecisionBits: 32,
      lastHeard: lastHeardS,
    },
  ],
  messages: [
    {
      id: 'src1_2863311530_7001', from: ALPHA, to: ME, fromNodeId: ALPHA, toNodeId: ME,
      fromNodeNum: 0xaaaaaaaa, text: BODY, channel: -1, portnum: 1, timestamp: sentMs, rxTime: sentMs,
    },
    {
      id: 'src1_2863311530_7002', from: ALPHA, to: '!ffffffff', fromNodeId: ALPHA, toNodeId: '!ffffffff',
      fromNodeNum: 0xaaaaaaaa, text: BODY, channel: 0, portnum: 1, timestamp: sentMs, rxTime: sentMs,
    },
  ],
};

const ALL_ON: RedactionConfig = {
  enabled: true,
  hideLongNames: true,
  hidePublicKeys: true,
  roundTimestamps: true,
  hideMessageText: true,
};

type Poll = typeof pollFixture;
const signedInPoll: Poll = pollFixture;
// The real server redactor, every toggle on.
const anonymousPoll = redactPublicPayload(pollFixture, ALL_ON) as Poll;

/** Messages the way useMessagingView turns wire JSON into rows. */
function toMessages(poll: Poll): MeshMessage[] {
  return poll.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })) as unknown as MeshMessage[];
}

function authValue(authenticated: boolean): AuthContextType {
  const authStatus = {
    authenticated,
    user: null,
    permissions: { global: {}, bySource: {} },
    channelDbPermissions: {},
    oidcEnabled: false,
    localAuthDisabled: false,
    anonymousDisabled: false,
    customTitle: null,
    customLogoUrl: null,
    // The server adds this only to anonymous replies.
    ...(authenticated ? {} : { publicInstance: ALL_ON }),
  } as unknown as AuthStatus;
  return { authStatus, loading: false } as unknown as AuthContextType;
}

function withAuth(authenticated: boolean, ui: React.ReactElement) {
  return render(<AuthContext.Provider value={authValue(authenticated)}>{ui}</AuthContext.Provider>);
}

const text = () => document.body.textContent ?? '';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});
afterAll(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Node list
// ---------------------------------------------------------------------------

function NodeListRows({ poll }: { poll: Poll }) {
  return (
    <div>
      {poll.nodes.map((n) => (
        <div key={n.nodeNum} data-testid={`row-${n.nodeNum}`}>
          <NodeListName node={n as unknown as React.ComponentProps<typeof NodeListName>['node']} />
          <NodeListTime lastHeard={n.lastHeard} timeFormat="24" dateFormat="MM/DD/YYYY" />
        </div>
      ))}
    </div>
  );
}

describe('node list rows', () => {
  it('signed-in shows the exact long name and the exact time', () => {
    withAuth(true, <NodeListRows poll={signedInPoll} />);
    const row = screen.getByTestId(`row-${0xaaaaaaaa}`);
    expect(row).toHaveTextContent(LONG_NAME);
    expect(row.querySelector('.node-time')).toHaveTextContent(':35');
    cleanup();
  });

  it('signed-out shows the short name and the hour-level time', () => {
    withAuth(false, <NodeListRows poll={anonymousPoll} />);
    const row = screen.getByTestId(`row-${0xaaaaaaaa}`);
    expect(text()).not.toContain(LONG_NAME);
    expect(row.querySelector('.node-longname')).toHaveTextContent(SHORT_NAME);
    expect(row.querySelector('.node-time')).toHaveTextContent(':00');
    expect(row.querySelector('.node-time')).not.toHaveTextContent(':35');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Node detail
// ---------------------------------------------------------------------------

function detailNode(poll: Poll): DeviceInfo {
  return poll.nodes[0] as unknown as DeviceInfo;
}

describe('node detail', () => {
  it('signed-in shows the exact age and the public key card', () => {
    withAuth(true, <NodeDetailsBlock node={detailNode(signedInPoll)} />);
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    expect(document.querySelector('.node-detail-public-key')).toHaveTextContent(PUBLIC_KEY);
    cleanup();
  });

  it('signed-out shows "within the last hour" and no key card', () => {
    withAuth(false, <NodeDetailsBlock node={detailNode(anonymousPoll)} />);
    expect(screen.getByText('within the last hour')).toBeInTheDocument();
    expect(screen.queryByText('5 minutes ago')).not.toBeInTheDocument();
    expect(document.querySelector('.node-detail-public-key')).toBeNull();
    expect(text()).not.toContain(PUBLIC_KEY);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Messages: DM conversation, node sidebar, channel row
// ---------------------------------------------------------------------------

type MessagesTabProps = React.ComponentProps<typeof MessagesTab>;

function messagesProps(poll: Poll): MessagesTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  const nodes = poll.nodes as unknown as DeviceInfo[];
  return {
    processedNodes: nodes,
    nodes,
    messages: toMessages(poll),
    currentNodeId: ME,
    connectionStatus: 'connected',
    selectedDMNode: ALPHA,
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
  } as unknown as MessagesTabProps;
}

describe('direct messages and the node sidebar', () => {
  it('signed-in shows the long name, the message body and the exact time', () => {
    withAuth(true, <MessagesTab {...messagesProps(signedInPoll)} />);
    expect(text()).toContain(LONG_NAME);
    expect(text()).toContain(BODY);
    expect(screen.queryByTestId('public-hidden-text')).toBeNull();
    expect(text()).toContain(':37');
    expect(screen.queryByTestId('public-instance-notice')).toBeNull();
    cleanup();
  });

  it('signed-out hides the long name and the body, and floors the time to the hour', () => {
    withAuth(false, <MessagesTab {...messagesProps(anonymousPoll)} />);
    expect(text()).not.toContain(LONG_NAME);
    expect(text()).toContain(SHORT_NAME);
    expect(screen.getAllByTestId('public-hidden-text').length).toBeGreaterThan(0);
    expect(text()).not.toContain('Exact sentinel body');
    expect(text()).not.toContain(':37');
    expect(text()).toContain(':00');
    expect(screen.getByTestId('public-instance-notice')).toBeInTheDocument();
    cleanup();
  });
});

describe('channel message row', () => {
  const noop = () => {};
  const actions: MessageRowActions = {
    senderClick: noop, relayClick: noop, resend: noop, reply: noop, emoji: noop,
    translate: noop, dismissTranslation: noop, remove: noop, tapback: noop, showDetails: noop,
  };

  function Row({ poll }: { poll: Poll }) {
    const nodeByNum = new Map(poll.nodes.map((n) => [n.user.id, n]));
    const user = (id: string) => nodeByNum.get(id)?.user;
    const names: MessageRowNames = {
      token: {},
      name: (id: string) => getUserDisplayName(user(id), 0),
      short: (id: string) => user(id)?.shortName ?? '?',
      label: (id: string) => getUserDisplayName(user(id), 0),
    };
    const msg = toMessages(poll)[1];
    return (
      <ChannelMessageRow
        msg={msg}
        isMine={false}
        dateSeparator={null}
        showUnreadDivider={false}
        reactions={[]}
        repliedMessage={null}
        currentNodeId={ME}
        canWrite={false}
        isDeviceChannel
        txDisabled={false}
        canTranslate={false}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        today="2026-11-16"
        meshProtocol="meshtastic"
        mentionOptions={{} as never}
        names={names}
        actions={actions}
      />
    );
  }

  it('signed-in shows the sender long name, the exact body and :37', () => {
    withAuth(true, <Row poll={signedInPoll} />);
    expect(text()).toContain(LONG_NAME);
    expect(text()).toContain(BODY);
    expect(screen.queryByTestId('public-hidden-text')).toBeNull();
    expect(text()).toContain(':37');
    cleanup();
  });

  it('signed-out shows the short name, a hidden-message marker and :00', () => {
    withAuth(false, <Row poll={anonymousPoll} />);
    expect(text()).not.toContain(LONG_NAME);
    expect(text()).toContain(SHORT_NAME);
    expect(screen.getByTestId('public-hidden-text')).toBeInTheDocument();
    expect(text()).not.toContain('Exact sentinel body');
    expect(text()).toContain(':00');
    expect(text()).not.toContain(':37');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Notice and key leak sweep
// ---------------------------------------------------------------------------

describe('notice and key leaks', () => {
  it('the notice shows for the signed-out viewer only', () => {
    withAuth(true, <PublicInstanceNotice />);
    expect(screen.queryByTestId('public-instance-notice')).toBeNull();
    cleanup();
    withAuth(false, <PublicInstanceNotice />);
    expect(screen.getByTestId('public-instance-notice')).toBeInTheDocument();
    cleanup();
  });

  it('the signed-out payload carries no full public key', () => {
    expect(JSON.stringify(anonymousPoll)).not.toContain(PUBLIC_KEY);
    expect(JSON.stringify(signedInPoll)).toContain(PUBLIC_KEY);
  });
});
