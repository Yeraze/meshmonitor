import { describe, it, expect } from 'vitest';
import { describeMeshtasticDelivery } from './meshtasticDelivery';
import { MeshMessage, MessageDeliveryState } from '../../types/message';
import type { DeliveryDescription, DiagField } from './types';

const NOW = 1_700_000_000_000;

function baseMessage(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: 'source-a_1_100',
    from: '!aaaaaaaa',
    to: '!bbbbbbbb',
    fromNodeId: '!aaaaaaaa',
    toNodeId: '!bbbbbbbb',
    text: 'hello',
    channel: 0,
    timestamp: new Date(NOW),
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

describe('describeMeshtasticDelivery', () => {
  it('maps failed state to statusKey/tone', () => {
    const result = describeMeshtasticDelivery(baseMessage({ ackFailed: true }));
    expect(result.statusKey).toBe('delivery_details.mt_status.not_confirmed');
    expect(result.tone).toBe('error');
    expect(result.protocol).toBe('meshtastic');
  });

  it('maps pending state to statusKey/tone', () => {
    // Stamped at "now" so message age is well under the 30s timeout.
    const result = describeMeshtasticDelivery(baseMessage({ timestamp: new Date() }));
    expect(result.statusKey).toBe('delivery_details.mt_status.pending');
    expect(result.tone).toBe('pending');
  });

  it('maps timeout state to statusKey/tone', () => {
    const result = describeMeshtasticDelivery(
      baseMessage({ timestamp: new Date(Date.now() - 60_000) })
    );
    expect(result.statusKey).toBe('delivery_details.mt_status.timeout');
    expect(result.tone).toBe('warning');
  });

  it('DM confirmed message gets the destination-ack status label', () => {
    const result = describeMeshtasticDelivery(
      baseMessage({ channel: -1, deliveryState: MessageDeliveryState.CONFIRMED })
    );
    expect(result.statusKey).toBe('delivery_details.mt_status.confirmed_destination');
    expect(result.tone).toBe('success');
  });

  it('broadcast delivered message gets the mesh-ack status label', () => {
    const result = describeMeshtasticDelivery(
      baseMessage({ channel: 0, deliveryState: MessageDeliveryState.DELIVERED })
    );
    expect(result.statusKey).toBe('delivery_details.mt_status.ack_by_mesh');
    expect(result.tone).toBe('success');
  });

  it('DM delivered message gets the "delivered by radio" status label (not mesh-ack)', () => {
    const result = describeMeshtasticDelivery(
      baseMessage({ channel: -1, deliveryState: MessageDeliveryState.DELIVERED })
    );
    expect(result.statusKey).toBe('delivery_details.mt_status.delivered_radio');
  });

  it('marks hopsUsed field as inferred and computes hopStart - hopLimit', () => {
    const result = describeMeshtasticDelivery(baseMessage({ hopStart: 5, hopLimit: 2 }));
    const field = findField(result, 'delivery_details.field.hops_used');
    expect(field).toBeDefined();
    expect(field?.provenance).toBe('inferred');
    expect(field?.value).toBe('~3');
  });

  it('hopsUsed is null when hop data is missing', () => {
    const result = describeMeshtasticDelivery(baseMessage({}));
    const field = findField(result, 'delivery_details.field.hops_used');
    expect(field?.value).toBeNull();
    expect(field?.provenance).toBe('inferred');
  });

  it('marks the routing/protocol-result field as unknown with a null value', () => {
    const result = describeMeshtasticDelivery(baseMessage({ ackFailed: true }));
    const field = findField(result, 'delivery_details.field.protocol_result');
    expect(field).toBeDefined();
    expect(field?.provenance).toBe('unknown');
    expect(field?.value).toBeNull();
  });

  it('marks Store & Forward as unknown with a null value', () => {
    const result = describeMeshtasticDelivery(baseMessage({}));
    const field = findField(result, 'delivery_details.field.store_forward');
    expect(field).toBeDefined();
    expect(field?.provenance).toBe('unknown');
    expect(field?.value).toBeNull();
  });

  it('detects a direct route when hopStart === hopLimit', () => {
    const result = describeMeshtasticDelivery(baseMessage({ hopStart: 3, hopLimit: 3 }));
    const field = findField(result, 'delivery_details.field.route_type');
    expect(field?.valueKey).toBe('delivery_details.value.direct');
    expect(field?.provenance).toBe('inferred');
  });

  it('detects a relayed route when hopStart !== hopLimit', () => {
    const result = describeMeshtasticDelivery(baseMessage({ hopStart: 5, hopLimit: 2 }));
    const field = findField(result, 'delivery_details.field.route_type');
    expect(field?.valueKey).toBe('delivery_details.value.relayed');
  });

  it('leaves route type unresolved when hop data is missing', () => {
    const result = describeMeshtasticDelivery(baseMessage({}));
    const field = findField(result, 'delivery_details.field.route_type');
    expect(field?.valueKey).toBeUndefined();
    expect(field?.value).toBeNull();
  });

  it('collapses message/request id into a single field (no duplicate rows)', () => {
    const result = describeMeshtasticDelivery(baseMessage({ requestId: 2847391940 }));
    // The old design rendered separate "Message ID" and "Request ID" rows that
    // always held the identical value; there must now be exactly one id row.
    expect(findField(result, 'delivery_details.field.message_id')).toBeUndefined();
    expect(findField(result, 'delivery_details.field.request_id')).toBeUndefined();
    const field = findField(result, 'delivery_details.field.message_request_id');
    expect(field?.value).toBe('2847391940');
    expect(field?.provenance).toBe('reported');
    expect(field?.noteKey).toBe('delivery_details.note.packet_is_request_id');
  });

  it('leaves the message/request id null (and note-less) when requestId is absent', () => {
    const result = describeMeshtasticDelivery(baseMessage({}));
    const field = findField(result, 'delivery_details.field.message_request_id');
    expect(field?.value).toBeNull();
    expect(field?.noteKey).toBeUndefined();
  });

  it('surfaces ackFromNode as reported when present', () => {
    const result = describeMeshtasticDelivery(baseMessage({ ackFromNode: 305419896 }));
    const field = findField(result, 'delivery_details.field.ack_from_node');
    expect(field?.provenance).toBe('reported');
    expect(field?.value).toBe('305419896');
  });

  it('ackFromNode is null when absent', () => {
    const result = describeMeshtasticDelivery(baseMessage({}));
    const field = findField(result, 'delivery_details.field.ack_from_node');
    expect(field?.value).toBeNull();
    expect(field?.provenance).toBe('reported');
  });

  it('formats last relay as a hex byte with a partial-identity note', () => {
    const result = describeMeshtasticDelivery(baseMessage({ relayNode: 0x4a }));
    const field = findField(result, 'delivery_details.field.last_relay');
    expect(field?.value).toBe('0x4a');
    expect(field?.provenance).toBe('reported');
    expect(field?.noteKey).toBe('delivery_details.value.last_byte_only');
  });

  it('formats SNR and RSSI with units when present', () => {
    const result = describeMeshtasticDelivery(baseMessage({ rxSnr: 4.5, rxRssi: -90 }));
    expect(findField(result, 'delivery_details.field.snr')?.value).toBe('4.5 dB');
    expect(findField(result, 'delivery_details.field.rssi')?.value).toBe('-90 dBm');
  });

  it('reports path as MQTT Bridge when viaMqtt is true, RF otherwise', () => {
    const mqttResult = describeMeshtasticDelivery(baseMessage({ viaMqtt: true }));
    expect(findField(mqttResult, 'delivery_details.field.path')?.valueKey).toBe(
      'delivery_details.value.mqtt_bridge'
    );

    const rfResult = describeMeshtasticDelivery(baseMessage({ viaMqtt: false }));
    expect(findField(rfResult, 'delivery_details.field.path')?.valueKey).toBe('delivery_details.value.rf');
  });

  it('surfaces xeddsaSigned and wantAck as Yes/No when defined', () => {
    const result = describeMeshtasticDelivery(baseMessage({ xeddsaSigned: true, wantAck: false }));
    expect(findField(result, 'delivery_details.field.xeddsa_signed')?.valueKey).toBe(
      'delivery_details.value.yes'
    );
    expect(findField(result, 'delivery_details.field.want_ack')?.valueKey).toBe('delivery_details.value.no');
  });
});
