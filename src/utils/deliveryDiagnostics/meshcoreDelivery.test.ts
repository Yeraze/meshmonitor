import { describe, it, expect } from 'vitest';
import { describeMeshCoreDelivery } from './meshcoreDelivery';
import type { MeshCoreMessage } from '../../components/MeshCore/hooks/useMeshCore';
import type { DeliveryDescription, DiagField } from './types';

function baseMessage(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'mc-1',
    fromPublicKey: 'abc123',
    text: 'hello',
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function findField(description: DeliveryDescription, labelKey: string): DiagField | undefined {
  for (const section of description.sections) {
    const field = section.fields.find(f => f.labelKey === labelKey);
    if (field) return field;
  }
  return undefined;
}

describe('describeMeshCoreDelivery', () => {
  it('delivered: reports PACKET_ACK (0x82) and observed round trip time', () => {
    const result = describeMeshCoreDelivery(
      baseMessage({ deliveryStatus: 'delivered', roundTripMs: 842 })
    );
    expect(result.protocol).toBe('meshcore');
    expect(result.statusKey).toBe('delivery_details.mc_status.delivered');
    expect(result.tone).toBe('success');

    const protocolResult = findField(result, 'delivery_details.field.protocol_result');
    expect(protocolResult?.value).toBe('PACKET_ACK (0x82)');
    expect(protocolResult?.provenance).toBe('reported');

    const rtt = findField(result, 'delivery_details.field.round_trip');
    expect(rtt?.value).toBe('842 ms');
    expect(rtt?.provenance).toBe('observed');
  });

  it('failed: uses the honest "no ACK does not mean not received" meaning key', () => {
    const result = describeMeshCoreDelivery(baseMessage({ deliveryStatus: 'failed' }));
    expect(result.statusKey).toBe('delivery_details.mc_status.not_confirmed');
    expect(result.tone).toBe('error');
    expect(result.meaningKey).toBe('delivery_details.mc_meaning.not_confirmed');

    const protocolResult = findField(result, 'delivery_details.field.protocol_result');
    expect(protocolResult?.value).toBeNull();
    expect(protocolResult?.provenance).toBe('unknown');
  });

  it('sent: awaiting-confirmation status', () => {
    const result = describeMeshCoreDelivery(baseMessage({ deliveryStatus: 'sent' }));
    expect(result.statusKey).toBe('delivery_details.mc_status.sent_awaiting');
    expect(result.tone).toBe('pending');
  });

  it('sending: in-flight status', () => {
    const result = describeMeshCoreDelivery(baseMessage({ deliveryStatus: 'sending' }));
    expect(result.statusKey).toBe('delivery_details.mc_status.sending');
    expect(result.tone).toBe('pending');
  });

  it('undefined deliveryStatus maps to unknown status', () => {
    const result = describeMeshCoreDelivery(baseMessage({ deliveryStatus: undefined }));
    expect(result.statusKey).toBe('delivery_details.mc_status.unknown');
    expect(result.tone).toBe('warning');
  });

  it('hopCount 0 reports a Direct route', () => {
    const result = describeMeshCoreDelivery(baseMessage({ hopCount: 0 }));
    const field = findField(result, 'delivery_details.field.route_type');
    expect(field?.valueKey).toBe('delivery_details.value.direct');
    expect(field?.provenance).toBe('reported');
  });

  it('hopCount > 0 reports a Relayed route', () => {
    const result = describeMeshCoreDelivery(baseMessage({ hopCount: 3 }));
    const field = findField(result, 'delivery_details.field.route_type');
    expect(field?.valueKey).toBe('delivery_details.value.relayed');
    expect(findField(result, 'delivery_details.field.hops')?.value).toBe('3');
  });

  it('hopCount null/undefined leaves the route type unresolved', () => {
    const result = describeMeshCoreDelivery(baseMessage({ hopCount: null }));
    const field = findField(result, 'delivery_details.field.route_type');
    expect(field?.valueKey).toBeUndefined();
    expect(field?.value).toBeNull();
  });

  it('passes heardBy through unchanged', () => {
    const heardBy = [
      { hash: 'a3', name: 'Repeater One', snr: 4.5 },
      { hash: '7f', name: null, snr: null },
    ];
    const result = describeMeshCoreDelivery(baseMessage({ heardBy }));
    expect(result.heardBy).toEqual(heardBy);
  });

  it('heardBy is undefined when the message carries none', () => {
    const result = describeMeshCoreDelivery(baseMessage({}));
    expect(result.heardBy).toBeUndefined();
  });

  it('formats expectedAckCrc as hex', () => {
    const result = describeMeshCoreDelivery(baseMessage({ expectedAckCrc: 0xdeadbeef }));
    const field = findField(result, 'delivery_details.field.expected_ack_crc');
    expect(field?.value).toBe('0xdeadbeef');
    expect(field?.provenance).toBe('reported');
  });

  it('expectedAckCrc is null when absent (e.g. channel sends)', () => {
    const result = describeMeshCoreDelivery(baseMessage({}));
    const field = findField(result, 'delivery_details.field.expected_ack_crc');
    expect(field?.value).toBeNull();
  });

  it('scope falls back to resolved scopeName when present', () => {
    const result = describeMeshCoreDelivery(baseMessage({ scopeCode: 5, scopeName: 'West Region' }));
    const field = findField(result, 'delivery_details.field.scope');
    expect(field?.value).toBe('West Region');
    expect(field?.provenance).toBe('reported');
  });

  it('scope falls back to raw hex code when scopeName is unresolved', () => {
    const result = describeMeshCoreDelivery(baseMessage({ scopeCode: 5, scopeName: null }));
    const field = findField(result, 'delivery_details.field.scope');
    expect(field?.value).toBe('#5');
  });

  it('scopeCode 0 is a known "Unscoped" fact, not missing data', () => {
    const result = describeMeshCoreDelivery(baseMessage({ scopeCode: 0 }));
    const field = findField(result, 'delivery_details.field.scope');
    expect(field?.valueKey).toBe('delivery_details.value.unscoped');
    expect(field?.provenance).toBe('reported');
  });

  it('scope is unknown when scopeCode is null/undefined', () => {
    const result = describeMeshCoreDelivery(baseMessage({ scopeCode: null, scopeName: null }));
    const field = findField(result, 'delivery_details.field.scope');
    expect(field?.value).toBeNull();
    expect(field?.provenance).toBe('unknown');
  });
});
