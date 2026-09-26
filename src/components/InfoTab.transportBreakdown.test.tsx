/**
 * InfoTab transport breakdown UI (#5101 WP5).
 *
 * Covers: the "Heard via" node breakdown (with its overlap note), the
 * message-count breakdown sourced from `apiService.getMessageCounts` (not
 * `messages.length`) including the UDP split, hiding both breakdowns + the
 * packet-distribution transport selector on an MQTT-only source, the shared
 * transport selector driving both distribution fetches, the header/buttons
 * staying on screen when the selected transport slice is empty, the
 * per-transport route-segment records (labelled RF/UDP/MQTT, empty classes
 * hidden, MQTT-only sources render one unlabelled record), the per-transport
 * Clear Record flow re-fetching rather than clearing local state, and the
 * traceroute:read / traceroute:write permission gates on the two cards and
 * the Clear Record button (#5101 P2 follow-up: route-segment endpoints moved
 * from `info` to per-source `traceroute` permissions), (#5101 Phase 3 WP2)
 * the device-counter caption under Network Statistics Packets TX/RX and
 * under Radio Statistics, and (#5101 Phase 3 WP5) mounting the
 * TransportSeriesGraphs section for a connected node and hiding it for
 * MQTT-only sources.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import InfoTab from './InfoTab';
import type { DeviceInfo } from '../types/device';
import type { MeshMessage } from '../types/message';
import type { PacketDistributionStats } from '../types/packet';
import type { MessageCounts, RouteSegmentRecords, RouteSegmentView } from '../services/api';
import type { NodeTransportClass } from '../utils/nodeTransport';

// `vi.hoisted` is required because `vi.mock` factories run before any
// module-scope `const` in this file would otherwise be initialized.
const { mockUseSource, mockHasPermission, mockGetMessageCounts, mockGetPacketDistributionStats, mockApiService } = vi.hoisted(() => {
  const mockGetMessageCounts = vi.fn();
  // Grants everything by default so the existing (pre-permission-gate) tests
  // don't need to know about the traceroute permission; tests that exercise
  // the gate override this per-test.
  const mockHasPermission = vi.fn((_resource: string, _action: string) => true);
  return {
    mockUseSource: vi.fn(),
    mockHasPermission,
    mockGetMessageCounts,
    mockGetPacketDistributionStats: vi.fn(),
    mockApiService: {
      getVirtualNodeStatus: vi.fn().mockResolvedValue(null),
      getServerInfo: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue([]),
      getLongestActiveRouteSegment: vi.fn().mockResolvedValue(null),
      getRecordHolderRouteSegment: vi.fn().mockResolvedValue(null),
      getSecurityKeys: vi.fn().mockResolvedValue(null),
      getMessageCounts: (...args: unknown[]) => mockGetMessageCounts(...args),
      clearRecordHolderSegment: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => mockUseSource(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: mockHasPermission }),
}));

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [] }),
}));

vi.mock('../services/api', () => ({
  default: mockApiService,
}));

vi.mock('../services/packetApi', () => ({
  getPacketDistributionStats: (...args: unknown[]) => mockGetPacketDistributionStats(...args),
}));

vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('./TelemetryGraphs', () => ({ default: () => null }));
vi.mock('./PacketRateGraphs', () => ({ default: () => null }));
vi.mock('./TransportSeriesGraphs', () => ({ default: () => <div data-testid="transport-series-section" /> }));
vi.mock('./survey/NetworkSurveyPanel', () => ({ default: () => null }));
vi.mock('./PacketStatsChart', () => ({
  default: () => null,
  DISTRIBUTION_COLORS: Array.from({ length: 11 }, (_, i) => `#color${i}`),
}));

const disabledDistribution: PacketDistributionStats = {
  enabled: false,
  total: 0,
  byDevice: [],
  byType: [],
};

const baseProps = {
  connectionStatus: 'connected' as const,
  nodeAddress: '192.168.1.1',
  deviceInfo: {},
  deviceConfig: null,
  channels: [],
  messages: [],
  channelMessages: {},
  currentNodeId: '',
  temperatureUnit: 'C' as const,
  telemetryHours: 24,
  baseUrl: '',
  getAvailableChannels: () => [],
  isAuthenticated: false,
};

function makeNode(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    nodeNum: 1,
    user: { id: '!1', longName: 'Node 1', shortName: 'N1' },
    lastHeard: 1000,
    ...overrides,
  } as unknown as DeviceInfo;
}

function makeMessage(id: string): MeshMessage {
  return {
    id,
    from: '!1',
    to: '^all',
    fromNodeId: '!1',
    toNodeId: '^all',
    text: 'hi',
    channel: 0,
    timestamp: new Date(),
  };
}

function makeSegmentView(cls: NodeTransportClass, overrides: Partial<RouteSegmentView> = {}): RouteSegmentView {
  const mechanism = cls === 'rf' ? 1 : cls === 'udp' ? 6 : 5;
  return {
    id: 1,
    fromNodeNum: 1,
    toNodeNum: 2,
    fromNodeId: '!1',
    toNodeId: '!2',
    fromNodeName: `Node-${cls}-A`,
    toNodeName: `Node-${cls}-B`,
    distanceKm: 10,
    timestamp: 1700000000000,
    isRecordHolder: true,
    transportMechanism: mechanism,
    transport: cls,
    ...overrides,
  };
}

/** Builds a RouteSegmentRecords fixture. The top-level (legacy) fields come
 * from whichever class is passed first among rf/udp/mqtt, matching the
 * server's "largest distanceKm" rule closely enough for these UI tests. */
function makeRecords(byTransport: Partial<Record<NodeTransportClass, RouteSegmentView | null>>): RouteSegmentRecords {
  const merged: Record<NodeTransportClass, RouteSegmentView | null> = { rf: null, udp: null, mqtt: null, ...byTransport };
  const top = merged.rf ?? merged.udp ?? merged.mqtt;
  if (!top) throw new Error('makeRecords requires at least one non-null entry');
  return { ...top, byTransport: merged };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiService.getVirtualNodeStatus.mockResolvedValue(null);
  mockApiService.getServerInfo.mockResolvedValue(null);
  mockApiService.get.mockResolvedValue([]);
  mockApiService.getLongestActiveRouteSegment.mockResolvedValue(null);
  mockApiService.getRecordHolderRouteSegment.mockResolvedValue(null);
  mockApiService.getSecurityKeys.mockResolvedValue(null);
  mockApiService.clearRecordHolderSegment.mockResolvedValue(undefined);
  mockGetMessageCounts.mockResolvedValue(null);
  mockGetPacketDistributionStats.mockResolvedValue(disabledDistribution);
  mockUseSource.mockReturnValue({ sourceId: 'source-a', sourceName: 'Source A', sourceType: 'meshtastic_tcp' });
  mockHasPermission.mockReset();
  mockHasPermission.mockImplementation(() => true);
});

describe('InfoTab node transport breakdown (#5101)', () => {
  it('renders the "heard via" breakdown with an overlap note when a node was heard on more than one transport', async () => {
    const nodes = [makeNode({ nodeNum: 1, transportLastRf: 1000, transportLastMqtt: 1000 } as Partial<DeviceInfo>)];
    render(<InfoTab {...baseProps} nodes={nodes} />);

    const breakdown = await screen.findByTestId('info-nodes-transport');
    expect(breakdown.textContent).toContain('info.heard_via');
    expect(breakdown.textContent).toContain('info.transport_overlap_note');
  });

  it('omits the node breakdown when there are no nodes', () => {
    render(<InfoTab {...baseProps} nodes={[]} />);
    expect(screen.queryByTestId('info-nodes-transport')).not.toBeInTheDocument();
  });
});

describe('InfoTab message transport breakdown (#5101)', () => {
  it('shows the total from apiService.getMessageCounts, not messages.length', async () => {
    const counts: MessageCounts = { sourceId: 'source-a', total: 42, byTransport: { rf: 30, udp: 0, mqtt: 12 } };
    mockGetMessageCounts.mockResolvedValue(counts);

    render(<InfoTab {...baseProps} nodes={[]} messages={[makeMessage('m1'), makeMessage('m2')]} />);

    await waitFor(() => {
      expect(mockGetMessageCounts).toHaveBeenCalledWith('source-a');
    });
    const breakdown = await screen.findByTestId('info-messages-transport');
    expect(breakdown.textContent).toContain('30');
    expect(breakdown.textContent).toContain('12');
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('includes the UDP split in the message breakdown (#5101 P2)', async () => {
    const counts: MessageCounts = { sourceId: 'source-a', total: 15, byTransport: { rf: 5, udp: 4, mqtt: 6 } };
    mockGetMessageCounts.mockResolvedValue(counts);

    render(<InfoTab {...baseProps} nodes={[]} />);

    const breakdown = await screen.findByTestId('info-messages-transport');
    expect(breakdown.textContent).toMatch(/transport\.udp/);
    expect(breakdown.textContent).toContain('4');
  });
});

describe('InfoTab hides transport UI for MQTT-only sources (#5101)', () => {
  it('hides both breakdowns and the packet-distribution transport selector for sourceType mqtt_bridge', async () => {
    mockUseSource.mockReturnValue({ sourceId: 'source-a', sourceName: 'Source A', sourceType: 'mqtt_bridge' });
    mockGetMessageCounts.mockResolvedValue({ sourceId: 'source-a', total: 5, byTransport: { rf: 0, udp: 0, mqtt: 5 } });
    mockGetPacketDistributionStats.mockResolvedValue({
      enabled: true,
      total: 5,
      byDevice: [],
      byType: [{ portnum: 1, portnum_name: 'TEXT_MESSAGE_APP', count: 5 }],
    });
    const nodes = [makeNode({ nodeNum: 1, transportLastMqtt: 1000 } as Partial<DeviceInfo>)];

    render(<InfoTab {...baseProps} nodes={nodes} />);

    await waitFor(() => {
      expect(screen.getByText('info.packet_distribution')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('info-nodes-transport')).not.toBeInTheDocument();
    expect(screen.queryByTestId('info-messages-transport')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dist-transport-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dist-transport-udp')).not.toBeInTheDocument();
  });
});

describe('InfoTab transport-series section (#5101 Phase 3 WP5)', () => {
  it('mounts TransportSeriesGraphs for a connected node on a full-featured source', async () => {
    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="!1" connectionStatus="connected" />);

    expect(await screen.findByTestId('transport-series-section')).toBeInTheDocument();
  });

  it('does not mount TransportSeriesGraphs when there is no current node', async () => {
    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="" connectionStatus="connected" />);

    await waitFor(() => {
      expect(screen.getByText('info.title')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('transport-series-section')).not.toBeInTheDocument();
  });

  it('does not mount TransportSeriesGraphs when disconnected', async () => {
    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="!1" connectionStatus="disconnected" />);

    await waitFor(() => {
      expect(screen.getByText('info.title')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('transport-series-section')).not.toBeInTheDocument();
  });

  it('hides TransportSeriesGraphs for an MQTT-only source even with a current node connected', async () => {
    mockUseSource.mockReturnValue({ sourceId: 'source-a', sourceName: 'Source A', sourceType: 'mqtt_bridge' });

    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="!1" connectionStatus="connected" />);

    await waitFor(() => {
      expect(screen.getByText('info.title')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('transport-series-section')).not.toBeInTheDocument();
  });
});

describe('InfoTab packet distribution transport selector (#5101)', () => {
  it('drives both distribution fetches with the selected transport', async () => {
    mockGetPacketDistributionStats.mockResolvedValue({
      enabled: true,
      total: 10,
      byDevice: [{ from_node: 1, from_node_id: '!1', from_node_longName: 'Node 1', count: 10 }],
      byType: [{ portnum: 4, portnum_name: 'NODEINFO_APP', count: 10 }],
    });

    render(<InfoTab {...baseProps} nodes={[]} />);

    const udpButton = await screen.findByTestId('dist-transport-udp');
    mockGetPacketDistributionStats.mockClear();

    fireEvent.click(udpButton);

    await waitFor(() => {
      const udpCalls = mockGetPacketDistributionStats.mock.calls.filter((c) => c[4] === 'udp');
      expect(udpCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('keeps the header and buttons visible, and shows the empty-transport message, when the selected transport has no packets', async () => {
    mockGetPacketDistributionStats.mockImplementation((..._args: unknown[]) => {
      const transport = _args[4];
      if (transport === 'udp') {
        return Promise.resolve({ enabled: true, total: 0, byDevice: [], byType: [] });
      }
      return Promise.resolve({
        enabled: true,
        total: 10,
        byDevice: [{ from_node: 1, from_node_id: '!1', from_node_longName: 'Node 1', count: 10 }],
        byType: [{ portnum: 4, portnum_name: 'NODEINFO_APP', count: 10 }],
      });
    });

    render(<InfoTab {...baseProps} nodes={[]} />);

    const udpButton = await screen.findByTestId('dist-transport-udp');
    fireEvent.click(udpButton);

    await waitFor(() => {
      expect(screen.getByText('info.no_packets_for_transport')).toBeInTheDocument();
    });
    expect(screen.getByTestId('dist-transport-all')).toBeInTheDocument();
    expect(screen.getByTestId('dist-transport-rf')).toBeInTheDocument();
    expect(screen.getByTestId('dist-transport-mqtt')).toBeInTheDocument();
    expect(screen.getByText('info.packet_distribution')).toBeInTheDocument();
  });
});

describe('InfoTab route-segment records, per transport (#5101 P2)', () => {
  it('renders one labelled record per non-null byTransport class, hiding the empty one', async () => {
    mockApiService.getLongestActiveRouteSegment.mockResolvedValue(
      makeRecords({ rf: makeSegmentView('rf'), mqtt: makeSegmentView('mqtt') })
    );

    render(<InfoTab {...baseProps} nodes={[]} />);

    await screen.findByTestId('route-segment-record-rf');
    expect(screen.getByTestId('route-segment-record-mqtt')).toBeInTheDocument();
    expect(screen.queryByTestId('route-segment-record-udp')).not.toBeInTheDocument();
  });

  it('shows the no-data text when every class is null', async () => {
    mockApiService.getLongestActiveRouteSegment.mockResolvedValue(null);
    mockApiService.getRecordHolderRouteSegment.mockResolvedValue(null);

    render(<InfoTab {...baseProps} nodes={[]} />);

    await waitFor(() => {
      expect(screen.getByText('info.no_active_routes')).toBeInTheDocument();
      expect(screen.getByText('info.no_record_holder')).toBeInTheDocument();
    });
  });

  it('renders a single unlabelled record on an MQTT-only source', async () => {
    mockUseSource.mockReturnValue({ sourceId: 'source-a', sourceName: 'Source A', sourceType: 'mqtt_bridge' });
    mockApiService.getRecordHolderRouteSegment.mockResolvedValue(makeRecords({ mqtt: makeSegmentView('mqtt') }));

    render(<InfoTab {...baseProps} nodes={[]} />);

    const unlabelled = await screen.findByTestId('route-segment-record-unlabelled');
    expect(unlabelled).not.toHaveAttribute('aria-label');
    expect(screen.queryByTestId('route-segment-record-mqtt')).not.toBeInTheDocument();
  });
});

describe('InfoTab per-transport Clear Record flow (#5101 P2)', () => {
  it('clears only the clicked class and re-fetches rather than clearing local state', async () => {
    mockApiService.getRecordHolderRouteSegment
      .mockResolvedValueOnce(makeRecords({ mqtt: makeSegmentView('mqtt') }))
      .mockResolvedValue(makeRecords({ mqtt: makeSegmentView('mqtt') }));

    render(<InfoTab {...baseProps} nodes={[]} isAuthenticated />);

    const mqttRecord = await screen.findByTestId('route-segment-record-mqtt');
    const clearButton = within(mqttRecord).getByRole('button');
    fireEvent.click(clearButton);

    const dialogHeading = await screen.findByText('info.clear_record_title');
    const dialog = dialogHeading.parentElement as HTMLElement;
    expect(within(dialog).getByText(/clear_record_confirm_transport/)).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole('button', { name: 'info.clear_record' });
    const callsBefore = mockApiService.getRecordHolderRouteSegment.mock.calls.length;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockApiService.clearRecordHolderSegment).toHaveBeenCalledWith('source-a', 'mqtt');
    });
    await waitFor(() => {
      expect(mockApiService.getRecordHolderRouteSegment.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});

describe('InfoTab route-segment permission gates (#5101 P2 follow-up)', () => {
  it('hides both route-segment cards and never fetches without traceroute:read', async () => {
    mockHasPermission.mockImplementation((resource: string, action: string) =>
      !(resource === 'traceroute' && action === 'read')
    );

    render(<InfoTab {...baseProps} nodes={[]} isAuthenticated />);

    // Let any pending effects settle before asserting absence.
    await waitFor(() => {
      expect(screen.getByText('info.title')).toBeInTheDocument();
    });

    expect(screen.queryByText('info.longest_route')).not.toBeInTheDocument();
    expect(screen.queryByText('info.record_holder')).not.toBeInTheDocument();
    expect(screen.queryByText('info.no_active_routes')).not.toBeInTheDocument();
    expect(screen.queryByText('info.no_record_holder')).not.toBeInTheDocument();
    expect(mockApiService.getLongestActiveRouteSegment).not.toHaveBeenCalled();
    expect(mockApiService.getRecordHolderRouteSegment).not.toHaveBeenCalled();
  });

  it('shows the cards with traceroute:read but hides Clear Record without traceroute:write', async () => {
    mockHasPermission.mockImplementation((resource: string, action: string) => {
      if (resource === 'traceroute' && action === 'write') return false;
      return true;
    });
    mockApiService.getRecordHolderRouteSegment.mockResolvedValue(makeRecords({ mqtt: makeSegmentView('mqtt') }));

    render(<InfoTab {...baseProps} nodes={[]} isAuthenticated />);

    const mqttRecord = await screen.findByTestId('route-segment-record-mqtt');
    expect(within(mqttRecord).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows Clear Record when traceroute:write is granted', async () => {
    mockApiService.getRecordHolderRouteSegment.mockResolvedValue(makeRecords({ mqtt: makeSegmentView('mqtt') }));

    render(<InfoTab {...baseProps} nodes={[]} isAuthenticated />);

    const mqttRecord = await screen.findByTestId('route-segment-record-mqtt');
    expect(within(mqttRecord).getByRole('button')).toBeInTheDocument();
  });
});

describe('InfoTab device counter captions (#5101 P3 WP2)', () => {
  it('shows the device-counter note under Network Statistics Packets TX/RX', async () => {
    mockApiService.get.mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.includes('/api/telemetry/')) {
        return Promise.resolve([
          { telemetryType: 'numPacketsTx', timestamp: 1000, value: 42 },
          { telemetryType: 'numPacketsRx', timestamp: 1000, value: 37 },
        ]);
      }
      return Promise.resolve([]);
    });

    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="!1" />);

    const note = await screen.findByTestId('info-packets-device-note');
    expect(note).toHaveTextContent('info.device_counters_note');
  });

  it('shows the device-counter note under Radio Statistics', async () => {
    mockApiService.get.mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.includes('/api/telemetry/')) {
        return Promise.resolve([
          { telemetryType: 'numPacketsRx', timestamp: 1000, value: 10 },
          { telemetryType: 'numPacketsRxBad', timestamp: 1000, value: 1 },
          { telemetryType: 'numRxDupe', timestamp: 1000, value: 0 },
          { telemetryType: 'numPacketsTx', timestamp: 1000, value: 8 },
          { telemetryType: 'numTxDropped', timestamp: 1000, value: 0 },
          { telemetryType: 'numTxRelay', timestamp: 1000, value: 2 },
        ]);
      }
      return Promise.resolve([]);
    });

    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="!1" />);

    const note = await screen.findByTestId('info-radio-device-note');
    expect(note).toHaveTextContent('info.device_counters_note');
  });

  it('omits both device-counter notes when local stats have not loaded', async () => {
    render(<InfoTab {...baseProps} nodes={[]} currentNodeId="!1" />);

    await waitFor(() => {
      expect(screen.getByText('info.title')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('info-packets-device-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('info-radio-device-note')).not.toBeInTheDocument();
  });
});

describe('InfoTab never shows device identity on an MQTT-only source (#5367)', () => {
  const foreignDeviceConfig = {
    basic: { nodeId: '!bf85a9d1', nodeName: 'SKYM - AUX - LT', firmwareVersion: '2.8.1.d3b4b34' },
    radio: { region: 'US', modemPreset: 'Long Fast', channelNum: 20 },
  };

  it('shows the no-local-node note and none of a device config it was handed for sourceType mqtt_broker', async () => {
    mockUseSource.mockReturnValue({ sourceId: 'broker-a', sourceName: 'Home Mqtt', sourceType: 'mqtt_broker' });

    render(<InfoTab {...baseProps} nodes={[]} isAuthenticated deviceConfig={foreignDeviceConfig} />);

    expect(await screen.findByTestId('info-no-local-node')).toBeInTheDocument();
    expect(screen.queryByText('!bf85a9d1')).not.toBeInTheDocument();
    expect(screen.queryByText('SKYM - AUX - LT')).not.toBeInTheDocument();
    expect(screen.queryByText('2.8.1.d3b4b34')).not.toBeInTheDocument();
    expect(screen.queryByText('info.lora_config')).not.toBeInTheDocument();
    // The server's Meshtastic node IP is not this source's address.
    expect(screen.queryByText('192.168.1.1')).not.toBeInTheDocument();
    expect(mockApiService.getSecurityKeys).not.toHaveBeenCalled();
  });

  it('still shows the device identity for a meshtastic_tcp source', async () => {
    mockUseSource.mockReturnValue({ sourceId: 'source-a', sourceName: 'Source A', sourceType: 'meshtastic_tcp' });

    render(<InfoTab {...baseProps} nodes={[]} isAuthenticated deviceConfig={foreignDeviceConfig} />);

    expect(await screen.findByText('!bf85a9d1')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    expect(screen.queryByText('info.lora_config')).toBeInTheDocument();
    expect(screen.queryByTestId('info-no-local-node')).not.toBeInTheDocument();
  });
});
