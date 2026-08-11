/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RelayNodeModal from './RelayNodeModal';
import type { MeshMessage } from '../types/message';
import { MessageDeliveryState } from '../types/message';

const baseMessage = (overrides: Partial<MeshMessage> = {}): MeshMessage => ({
  id: 'srcA_305419896_123456',
  from: '!1234abcd',
  to: '!ffffffff',
  fromNodeId: '!1234abcd',
  toNodeId: '!ffffffff',
  text: 'hello mesh',
  channel: 0,
  portnum: 1,
  timestamp: new Date('2026-08-11T12:00:00Z'),
  hopStart: 7,
  hopLimit: 5,
  ...overrides,
});

const noop = () => {};

describe('RelayNodeModal packet detail (#4657)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <RelayNodeModal isOpen={false} onClose={noop} nodes={[]} onNodeClick={noop} message={baseMessage()} />
    );
    expect(container.textContent).toBe('');
  });

  it('shows the packet-detail section for an RF message', () => {
    render(
      <RelayNodeModal
        isOpen={true}
        onClose={noop}
        nodes={[]}
        onNodeClick={noop}
        message={baseMessage({ rxSnr: 9.25, rxRssi: -52 })}
      />
    );

    // Section heading + explicit RF transport (headline ask of the issue)
    expect(screen.getByText('relay_modal.packet_details')).toBeInTheDocument();
    expect(screen.getByText('relay_modal.transport_rf')).toBeInTheDocument();
    // Decoded fields: portnum name, packet id, hop count, signal
    expect(screen.getByText('TEXT_MESSAGE (1)')).toBeInTheDocument();
    expect(screen.getByText(/123456/)).toBeInTheDocument();
    expect(screen.getByText(/^2 /)).toBeInTheDocument(); // hop count = 7 - 5
    expect(screen.getByText('9.25 dB')).toBeInTheDocument();
    expect(screen.getByText('-52 dBm')).toBeInTheDocument();
  });

  it('marks MQTT-sourced messages explicitly and hides the relay list', () => {
    render(
      <RelayNodeModal
        isOpen={true}
        onClose={noop}
        nodes={[]}
        onNodeClick={noop}
        message={baseMessage({ viaMqtt: true, sourcePath: 'mqtt_bridge' })}
      />
    );

    expect(screen.getByText('relay_modal.transport_mqtt')).toBeInTheDocument();
    expect(screen.getByText('relay_modal.ingress_mqtt_bridge')).toBeInTheDocument();
    // No relay byte -> no relay-candidate section
    expect(screen.queryByText('relay_modal.potential_relays')).toBeNull();
  });

  it('renders the relay-candidate section when a relay byte is present', () => {
    render(
      <RelayNodeModal
        isOpen={true}
        onClose={noop}
        relayNode={0x42}
        nodes={[
          {
            nodeNum: 0x11223342,
            nodeId: '!11223342',
            longName: 'Relay One',
            shortName: 'R1',
            heardDirectly: true,
            hopsAway: 0,
          },
        ]}
        onNodeClick={noop}
        message={baseMessage({ relayNode: 0x42 })}
      />
    );

    expect(screen.getByText('relay_modal.packet_details')).toBeInTheDocument();
    expect(screen.getByText('relay_modal.potential_relays')).toBeInTheDocument();
    expect(screen.getByText(/Relay One/)).toBeInTheDocument();
    // Relay byte shown in packet details as 0x42
    expect(screen.getByText('0x42')).toBeInTheDocument();
  });

  it('shows delivery state and want-ack when present', () => {
    render(
      <RelayNodeModal
        isOpen={true}
        onClose={noop}
        nodes={[]}
        onNodeClick={noop}
        message={baseMessage({ wantAck: true, deliveryState: MessageDeliveryState.CONFIRMED })}
      />
    );
    expect(screen.getByText('relay_modal.delivery_confirmed')).toBeInTheDocument();
    expect(screen.getByText('common.yes')).toBeInTheDocument();
  });

  it('preserves the legacy relay-only modal when no message is supplied', () => {
    render(
      <RelayNodeModal
        isOpen={true}
        onClose={noop}
        relayNode={0x42}
        rxTime={new Date('2026-08-11T12:00:00Z')}
        nodes={[]}
        onNodeClick={noop}
      />
    );
    // No packet-detail section, but the legacy relay info + relay list remain
    expect(screen.queryByText('relay_modal.packet_details')).toBeNull();
    expect(screen.getByText('relay_modal.acknowledged:')).toBeInTheDocument();
    expect(screen.getByText('relay_modal.potential_relays')).toBeInTheDocument();
  });

  it('invokes onNodeClick when a relay candidate is clicked', () => {
    const onNodeClick = vi.fn();
    render(
      <RelayNodeModal
        isOpen={true}
        onClose={noop}
        relayNode={0x42}
        nodes={[
          {
            nodeNum: 0x11223342,
            nodeId: '!11223342',
            longName: 'Relay One',
            shortName: 'R1',
            heardDirectly: true,
            hopsAway: 0,
          },
        ]}
        onNodeClick={onNodeClick}
        message={baseMessage({ relayNode: 0x42 })}
      />
    );
    screen.getByText(/Relay One/).click();
    expect(onNodeClick).toHaveBeenCalledWith('!11223342');
  });
});
