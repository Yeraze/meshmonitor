/**
 * @vitest-environment jsdom
 *
 * Tests for the MQTT packet detail modal: renders the stored packet fields,
 * fetches + renders the per-gateway receptions table (unwrapping the
 * `{ success, data }` envelope), skips the fetch entirely for packetId
 * 0/null groups, and closes on Escape/overlay click.
 *
 * See docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE2_SPEC.md §5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MqttPacketDetailModal from './MqttPacketDetailModal';
import type { MqttGroupedPacket, MqttReception } from './mqttPacketTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const basePacket = (overrides: Partial<MqttGroupedPacket> = {}): MqttGroupedPacket => ({
  packetId: 12345,
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
  gatewayCount: 4,
  receptionCount: 6,
  firstHeard: 1700000000000,
  lastHeard: 1700000005000,
  ...overrides,
});

const baseReception = (overrides: Partial<MqttReception> = {}): MqttReception => ({
  gatewayId: '!aabbccdd',
  gatewayNodeNum: 2864434397,
  timestamp: 1700000005000,
  rxTime: 1700000004000,
  rxSnr: 7.25,
  rxRssi: -68,
  hopLimit: 3,
  hopStart: 5,
  ...overrides,
});

describe('MqttPacketDetailModal', () => {
  const prefix = 'http://localhost/api/sources/abc/mqtt/packets';
  let csrfFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    csrfFetch = vi.fn();
  });

  it('renders packet fields using the injected nodeName resolver', () => {
    const nodeName = vi.fn((n: number | null) => (n === 111111111 ? 'Base Station' : null));
    render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/Base Station/)).toBeTruthy();
    expect(screen.getByText('LongFast (#0)')).toBeTruthy();
    expect(screen.getByText('TEXT_MESSAGE_APP (1)')).toBeTruthy();
    expect(screen.getByText('No')).toBeTruthy(); // Encrypted: No
    expect(screen.getByText('ingested')).toBeTruthy(); // outcome, not badge-styled
  });

  it('shows the encrypted outcome badge when encrypted with no decoded portnum', () => {
    const nodeName = vi.fn(() => null);
    render(
      <MqttPacketDetailModal
        packet={basePacket({ encrypted: 1, portnumName: null, portnum: null, ingestOutcome: 'encrypted' })}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Yes')).toBeTruthy(); // Encrypted: Yes
    const badge = screen.getByText('encrypted');
    expect(badge.className).toContain('mqpm-badge-encrypted');
  });

  it('fetches and renders receptions (gateway name, RSSI, SNR, computed hops)', async () => {
    csrfFetch.mockResolvedValue(
      jsonResponse({ success: true, data: { receptions: [baseReception()] } })
    );
    const nodeName = vi.fn((n: number | null) => (n === 2864434397 ? 'Gateway One' : null));

    render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    // Assert the fetch targeted the receptions endpoint with the right params.
    expect(csrfFetch).toHaveBeenCalledWith(
      `${prefix}/receptions?packetId=12345&fromNode=111111111`
    );

    const table = await screen.findByText('Gateway One');
    expect(table).toBeTruthy();
    expect(screen.getByText('-68')).toBeTruthy(); // RSSI
    expect(screen.getByText('7.25')).toBeTruthy(); // SNR toFixed(2)
    expect(screen.getByText('2')).toBeTruthy(); // hops = hopStart(5) - hopLimit(3)
  });

  it('falls back to the gateway hex id when no node name resolves', async () => {
    csrfFetch.mockResolvedValue(
      jsonResponse({ success: true, data: { receptions: [baseReception({ gatewayNodeNum: null })] } })
    );
    const nodeName = vi.fn(() => null);

    render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText('!aabbccdd')).toBeTruthy();
  });

  it.each([0, null])('renders the no-receptions note and never calls csrfFetch when packetId is %s', async (packetId) => {
    const nodeName = vi.fn(() => null);
    render(
      <MqttPacketDetailModal
        packet={basePacket({ packetId: packetId as number | null })}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText('Per-gateway receptions are unavailable for packets without a packet ID.')
    ).toBeTruthy();
    expect(csrfFetch).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape keydown', () => {
    const onClose = vi.fn();
    const nodeName = vi.fn(() => null);
    render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the overlay (outer modal element) is clicked', () => {
    const onClose = vi.fn();
    const nodeName = vi.fn(() => null);
    const { container } = render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={onClose}
      />
    );

    const overlay = container.querySelector('.mqpm-modal');
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking inside the modal content', () => {
    const onClose = vi.fn();
    const nodeName = vi.fn(() => null);
    const { container } = render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={onClose}
      />
    );

    const content = container.querySelector('.mqpm-modal-content');
    expect(content).toBeTruthy();
    fireEvent.click(content as Element);
    expect(onClose).not.toHaveBeenCalled();
  });
});
