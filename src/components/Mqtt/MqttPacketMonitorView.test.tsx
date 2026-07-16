/**
 * @vitest-environment jsdom
 *
 * Tests for the MQTT Packet Monitor view: initial load + envelope unwrap,
 * enable banner + capture toggle, Clear permission gating, gateway filter
 * wiring, and pause skipping the poll tick.
 *
 * See docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE2_SPEC.md §5.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { MqttGroupedPacket, MqttGateway } from './mqttPacketTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

let hasPermissionImpl: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (resource: string, action: string) => hasPermissionImpl(resource, action) }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

let nodesFixture: Array<{ nodeNum: number; user?: { longName?: string; shortName?: string } }> = [];
vi.mock('../../hooks/useServerData', () => ({
  useNodes: () => ({ nodes: nodesFixture, isLoading: false, error: null }),
}));

import MqttPacketMonitorView from './MqttPacketMonitorView';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const basePacket = (overrides: Partial<MqttGroupedPacket> = {}): MqttGroupedPacket => ({
  packetId: 1001,
  fromNode: 111111111,
  fromNodeId: '!069f76f7',
  toNode: 0xffffffff,
  toNodeId: '!ffffffff',
  channel: 0,
  channelId: 'LongFast',
  portnum: 1,
  portnumName: 'TEXT_MESSAGE_APP',
  encrypted: 0,
  ingestOutcome: 'ingested',
  payloadSize: 12,
  payloadPreview: 'hello world',
  gatewayCount: 2,
  receptionCount: 3,
  firstHeard: 1700000000000,
  lastHeard: 1700000005000,
  ...overrides,
});

const baseGateway = (overrides: Partial<MqttGateway> = {}): MqttGateway => ({
  gatewayId: '!aabbccdd',
  gatewayNodeNum: 2864434397,
  receptionCount: 5,
  lastHeard: 1700000005000,
  ...overrides,
});

const packetsEnvelope = (packets: MqttGroupedPacket[], extra: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    packets,
    total: packets.length,
    offset: 0,
    limit: 5000,
    enabled: true,
    maxCount: 5000,
    maxAgeHours: 24,
    ...extra,
  },
});

const gatewaysEnvelope = (gateways: MqttGateway[]) => ({
  success: true,
  data: { gateways },
});

/** Route the mock csrfFetch by URL shape: gateways vs. packets list. */
function installFetchRouter(opts: {
  packets?: MqttGroupedPacket[];
  gateways?: MqttGateway[];
  enabled?: boolean;
} = {}) {
  const { packets = [], gateways = [], enabled = true } = opts;
  csrfFetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/gateways')) {
      return jsonResponse(gatewaysEnvelope(gateways));
    }
    return jsonResponse(packetsEnvelope(packets, { enabled }));
  });
}

describe('MqttPacketMonitorView', () => {
  const baseUrl = '';
  const sourceId = 'source-abc';

  beforeEach(() => {
    csrfFetchMock.mockReset();
    hasPermissionImpl = () => true;
    nodesFixture = [];
    localStorage.clear();
    // shouldAdvanceTime lets real-time polling (e.g. Testing Library's
    // waitFor/findBy) progress while we still control the 5s poll interval
    // with vi.advanceTimersByTime — mirrors ToastContainer.test.tsx.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders grouped rows from the wrapped {success,data} envelope (regression guard)', async () => {
    installFetchRouter({ packets: [basePacket()] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    // A component that read body.packets directly (the MeshCore mistake)
    // would never render this row.
    await screen.findByText('hello world');
    expect(screen.getByText('TEXT_MESSAGE_APP')).toBeTruthy();
  });

  it('shows the header count', async () => {
    installFetchRouter({ packets: [basePacket(), basePacket({ packetId: 1002, lastHeard: 1700000006000 })] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    await waitFor(() => {
      expect(document.querySelector('.mqpm-count')?.textContent).toBe('2');
    });
  });

  it('shows the enable banner when capture is disabled and POSTs the setting when enabled', async () => {
    installFetchRouter({ packets: [], enabled: false });
    csrfFetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        return jsonResponse({ success: true });
      }
      if (url.includes('/gateways')) {
        return jsonResponse(gatewaysEnvelope([]));
      }
      return jsonResponse(packetsEnvelope([], { enabled: false }));
    });
    hasPermissionImpl = (resource) => resource === 'settings';

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    const enableButton = await screen.findByText('Enable capture');
    fireEvent.click(enableButton);

    await waitFor(() => {
      const postCall = csrfFetchMock.mock.calls.find(
        ([, options]) => (options as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const [url, options] = postCall!;
      expect(url).toBe(`${baseUrl}/api/settings`);
      expect(JSON.parse((options as RequestInit).body as string)).toEqual({ mqtt_packet_log_enabled: '1' });
    });
  });

  it('hides the Clear button without packetmonitor:write', async () => {
    installFetchRouter({ packets: [basePacket()] });
    hasPermissionImpl = (resource) => resource !== 'packetmonitor';

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    await screen.findByText('hello world');
    expect(screen.queryByTitle('Clear')).toBeNull();
  });

  it('clears the log with packetmonitor:write (confirm + DELETE)', async () => {
    installFetchRouter({ packets: [basePacket()] });
    hasPermissionImpl = () => true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    csrfFetchMock.mockImplementationOnce(async () => jsonResponse({ success: true, data: { deleted: 1 } }));

    fireEvent.click(screen.getByTitle('Clear'));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      const deleteCall = csrfFetchMock.mock.calls.find(
        ([, options]) => (options as RequestInit | undefined)?.method === 'DELETE'
      );
      expect(deleteCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText('hello world')).toBeNull();
    });

    confirmSpy.mockRestore();
  });

  it('does not clear when the confirm dialog is dismissed', async () => {
    installFetchRouter({ packets: [basePacket()] });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    fireEvent.click(screen.getByTitle('Clear'));

    expect(confirmSpy).toHaveBeenCalled();
    const deleteCall = csrfFetchMock.mock.calls.find(
      ([, options]) => (options as RequestInit | undefined)?.method === 'DELETE'
    );
    expect(deleteCall).toBeUndefined();

    confirmSpy.mockRestore();
  });

  it('selecting a gateway in the dropdown adds gateways=<id> to the next request URL', async () => {
    installFetchRouter({ packets: [basePacket()], gateways: [baseGateway()] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    // Open the filter panel, then the gateway dropdown.
    fireEvent.click(screen.getByTitle('Filters'));
    fireEvent.click(screen.getByRole('button', { name: /Gateways/ }));

    const checkbox = await screen.findByRole('checkbox', { name: /!aabbccdd/ });
    csrfFetchMock.mockClear();
    fireEvent.click(checkbox);

    await waitFor(() => {
      const packetsCall = csrfFetchMock.mock.calls.find(([url]) => {
        const parsed = new URL(url as string, 'http://localhost');
        return parsed.searchParams.get('gateways') === '!aabbccdd';
      });
      expect(packetsCall).toBeTruthy();
    });
  });

  it('refreshes the gateway list when the dropdown is opened', async () => {
    installFetchRouter({ packets: [basePacket()], gateways: [baseGateway()] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    fireEvent.click(screen.getByTitle('Filters'));
    csrfFetchMock.mockClear();

    // Opening the dropdown (closed -> open) must refetch /gateways so the
    // list is fresh at the moment of use (regression: mount-only loading
    // left the panel permanently stale/empty on live sources).
    fireEvent.click(screen.getByRole('button', { name: /Gateways/ }));

    await waitFor(() => {
      const gatewaysCall = csrfFetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/gateways')
      );
      expect(gatewaysCall).toBeTruthy();
    });

    // Closing the dropdown (open -> closed) must NOT refetch.
    csrfFetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Gateways/ }));
    const gatewaysCallAfterClose = csrfFetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/gateways')
    );
    expect(gatewaysCallAfterClose).toBeUndefined();
  });

  it('Refresh reloads both the packet list and the gateway list', async () => {
    installFetchRouter({ packets: [basePacket()], gateways: [baseGateway()] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    csrfFetchMock.mockClear();
    fireEvent.click(screen.getByTitle('Refresh'));

    await waitFor(() => {
      const urls = csrfFetchMock.mock.calls.map(([url]) => url as string);
      expect(urls.some(u => u.includes('/gateways'))).toBe(true);
      expect(urls.some(u => u.includes('/mqtt/packets?'))).toBe(true);
    });
  });

  it('skips the poll tick while paused', async () => {
    installFetchRouter({ packets: [basePacket()] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    fireEvent.click(screen.getByTitle('Pause'));

    const callCountAfterInitialLoad = csrfFetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(15000);
    });

    expect(csrfFetchMock.mock.calls.length).toBe(callCountAfterInitialLoad);
  });

  it('polls again on the next tick while not paused', async () => {
    installFetchRouter({ packets: [basePacket()] });

    render(<MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);
    await screen.findByText('hello world');

    const callCountAfterInitialLoad = csrfFetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    await waitFor(() => {
      expect(csrfFetchMock.mock.calls.length).toBeGreaterThan(callCountAfterInitialLoad);
    });
  });
});
