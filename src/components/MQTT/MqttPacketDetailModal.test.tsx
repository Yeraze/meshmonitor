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
import { render, screen, fireEvent, within } from '@testing-library/react';
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
  bitfield: 1,
  okToMqttViolation: 0,
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
  bitfield: 1,
  okToMqttViolation: 0,
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

  // #4114 Phase 2 WP3 — packet-level ok_to_mqtt row + per-gateway attribution.
  it('renders the packet-level ok_to_mqtt row as a violation', () => {
    const nodeName = vi.fn(() => null);
    render(
      <MqttPacketDetailModal
        packet={basePacket({ okToMqttViolation: 1, bitfield: 0 })}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    const badge = screen.getByText('violation');
    expect(badge.className).toContain('mqpm-badge-violation');
    expect(badge.getAttribute('title')).toBe(
      'At least one gateway relayed this packet to MQTT although the sender did not opt in (ok_to_mqtt = 0). Open the packet to see which gateway.'
    );
  });

  it("renders 'allowed' when the sender opted in", () => {
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

    const el = screen.getByText('allowed');
    expect(el.className).toContain('mqpm-oktomqtt-ok');
  });

  it("renders 'unknown' when the bitfield is null", () => {
    const nodeName = vi.fn(() => null);
    render(
      <MqttPacketDetailModal
        packet={basePacket({ bitfield: null })}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    const el = screen.getByText('unknown');
    expect(el.className).toContain('mqpm-oktomqtt-unknown');
    expect(el.getAttribute('title')).toBe(
      'The ok_to_mqtt bit could not be read for this reception — the payload was not decryptable, or the packet was captured before violation detection was added.'
    );
  });

  it("renders 'opted out' when the bit is clear but no violation was recorded", () => {
    const nodeName = vi.fn(() => null);
    render(
      <MqttPacketDetailModal
        packet={basePacket({ bitfield: 0, okToMqttViolation: 0 })}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    const el = screen.getByText('opted out');
    expect(el.className).toContain('mqpm-oktomqtt-optedout');
  });

  it('the per-gateway column attributes the violating gateway among clean ones', async () => {
    csrfFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          receptions: [
            baseReception({ gatewayId: '!aaaaaaaa', gatewayNodeNum: 1, bitfield: 0, okToMqttViolation: 1 }),
            baseReception({ gatewayId: '!bbbbbbbb', gatewayNodeNum: 2, bitfield: 1, okToMqttViolation: 0 }),
            baseReception({ gatewayId: '!cccccccc', gatewayNodeNum: 3, bitfield: null, okToMqttViolation: 0 }),
            baseReception({ gatewayId: '!dddddddd', gatewayNodeNum: 4, bitfield: 0, okToMqttViolation: 0 }),
          ],
        },
      })
    );
    const nodeName = vi.fn((n: number | null) => {
      if (n === 1) return 'Gateway A';
      if (n === 2) return 'Gateway B';
      if (n === 3) return 'Gateway C';
      if (n === 4) return 'Gateway D';
      return null;
    });

    const { container } = render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    await screen.findByText('Gateway A');

    const rowA = within(screen.getByText('Gateway A').closest('tr')!);
    expect(rowA.getByText('violation')).toBeTruthy();
    expect(rowA.queryByText('allowed')).toBeNull();
    expect(rowA.queryByText('unknown')).toBeNull();

    const rowB = within(screen.getByText('Gateway B').closest('tr')!);
    expect(rowB.getByText('allowed')).toBeTruthy();
    expect(rowB.queryByText('violation')).toBeNull();

    const rowC = within(screen.getByText('Gateway C').closest('tr')!);
    expect(rowC.getByText('unknown')).toBeTruthy();
    expect(rowC.queryByText('violation')).toBeNull();

    const rowDEl = screen.getByText('Gateway D').closest('tr')!;
    const rowD = within(rowDEl);
    expect(rowD.getByText('opted out')).toBeTruthy();
    expect(rowD.queryByText('violation')).toBeNull();
    expect(rowDEl.querySelector('.mqpm-badge-violation')).toBeNull();

    expect(container.querySelectorAll('.mqpm-recv-table .mqpm-badge-violation').length).toBe(1);
  });

  it('the per-gateway violation marker uses the gateway-scoped tooltip', async () => {
    csrfFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          receptions: [
            baseReception({ gatewayId: '!aaaaaaaa', gatewayNodeNum: 1, bitfield: 0, okToMqttViolation: 1 }),
            baseReception({ gatewayId: '!bbbbbbbb', gatewayNodeNum: 2, bitfield: 1, okToMqttViolation: 0 }),
            baseReception({ gatewayId: '!cccccccc', gatewayNodeNum: 3, bitfield: null, okToMqttViolation: 0 }),
          ],
        },
      })
    );
    const nodeName = vi.fn((n: number | null) => {
      if (n === 1) return 'Gateway A';
      if (n === 2) return 'Gateway B';
      if (n === 3) return 'Gateway C';
      return null;
    });

    const { container } = render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    await screen.findByText('Gateway A');

    const badge = container.querySelector('.mqpm-recv-table .mqpm-badge-violation');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('title')).toBe(
      'This gateway relayed the packet to MQTT although the sender did not opt in (ok_to_mqtt = 0).'
    );
  });

  it('the receptions table renders the ok_to_mqtt header', async () => {
    csrfFetch.mockResolvedValue(
      jsonResponse({ success: true, data: { receptions: [baseReception()] } })
    );
    const nodeName = vi.fn(() => null);

    const { container } = render(
      <MqttPacketDetailModal
        packet={basePacket()}
        prefix={prefix}
        csrfFetch={csrfFetch as any}
        nodeName={nodeName}
        onClose={vi.fn()}
      />
    );

    await screen.findByText('!aabbccdd');

    const headers = container.querySelectorAll('.mqpm-recv-table th');
    expect(headers.length).toBe(7);
    expect(screen.getByText('ok_to_mqtt', { selector: 'th' })).toBeTruthy();
  });
});
