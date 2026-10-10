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

  it('stringifies a numeric row id and nulls a falsy id', () => {
    // Some backends hand back a numeric id; the field type is string | null.
    const numeric = describeMeshCoreDelivery(baseMessage({ id: 12345 as unknown as string }));
    expect(findField(numeric, 'delivery_details.field.message_id')?.value).toBe('12345');

    const empty = describeMeshCoreDelivery(baseMessage({ id: '' }));
    expect(findField(empty, 'delivery_details.field.message_id')?.value).toBeNull();
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

  it('sent: reads "Sent to radio" while the ack is awaited (#5682)', () => {
    const result = describeMeshCoreDelivery(baseMessage({ deliveryStatus: 'sent' }));
    expect(result.statusKey).toBe('delivery_details.mc_status.sent_to_radio');
    expect(result.meaningKey).toBe('delivery_details.mc_meaning.awaiting_ack_dm');
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

  it('our channel send with no relay reads "sent to radio", not unknown (#5682)', () => {
    const result = describeMeshCoreDelivery(baseMessage({ toPublicKey: 'channel-2' }));
    expect(result.statusKey).toBe('delivery_details.mc_status.sent_to_radio');
    expect(result.meaningKey).toBe('delivery_details.mc_meaning.sent_to_radio');
    expect(result.tone).toBe('pending');
  });

  it('our channel send that a repeater relayed reads "relayed" (#5682)', () => {
    const result = describeMeshCoreDelivery(
      baseMessage({ toPublicKey: 'channel-2', heardBy: [{ hash: '7f', name: null, snr: 4 }] }),
    );
    expect(result.statusKey).toBe('delivery_details.mc_status.relayed');
    expect(result.meaningKey).toBe('delivery_details.mc_meaning.relayed');
    expect(result.tone).toBe('success');
  });

  it('a received message stays unknown: it has no delivery state of ours (#5682)', () => {
    expect(describeMeshCoreDelivery(baseMessage({ toPublicKey: 'channel-2' }), 'received').statusKey)
      .toBe('delivery_details.mc_status.unknown');
    expect(describeMeshCoreDelivery(baseMessage({ toPublicKey: 'd'.repeat(64) }), 'received').statusKey)
      .toBe('delivery_details.mc_status.unknown');
    expect(
      describeMeshCoreDelivery(baseMessage({ toPublicKey: 'd'.repeat(64), messageType: 'room_post' }), 'received').statusKey,
    ).toBe('delivery_details.mc_status.unknown');
  });

  describe('our own DMs and room posts (#5682)', () => {
    const PEER = 'd'.repeat(64);
    const dm = (over: Partial<MeshCoreMessage> = {}) => baseMessage({ toPublicKey: PEER, ...over });
    const post = (over: Partial<MeshCoreMessage> = {}) => dm({ messageType: 'room_post', ...over });
    const read = (m: MeshCoreMessage) => {
      const d = describeMeshCoreDelivery(m);
      return [d.statusKey.replace('delivery_details.mc_status.', ''), d.tone, d.meaningKey.replace('delivery_details.mc_meaning.', '')];
    };

    it('DM: every state', () => {
      expect(read(dm())).toEqual(['sent_to_radio', 'pending', 'sent_to_radio_dm']);
      expect(read(dm({ deliveryStatus: 'sent', expectedAckCrc: 7 }))).toEqual(['sent_to_radio', 'pending', 'awaiting_ack_dm']);
      expect(read(dm({ deliveryStatus: 'delivered' }))).toEqual(['delivered', 'success', 'delivered']);
      expect(read(dm({ deliveryStatus: 'failed' }))).toEqual(['not_confirmed', 'error', 'not_confirmed']);
    });

    it('room post: every state, in its own words', () => {
      expect(read(post())).toEqual(['sent_to_radio', 'pending', 'sent_to_radio_room']);
      expect(read(post({ deliveryStatus: 'sent', expectedAckCrc: 7 }))).toEqual(['sent_to_radio', 'pending', 'awaiting_ack_room']);
      expect(read(post({ deliveryStatus: 'delivered' }))).toEqual(['room_received', 'success', 'room_received']);
      expect(read(post({ deliveryStatus: 'failed' }))).toEqual(['not_confirmed', 'error', 'not_confirmed_room']);
    });

    it('never reads "Unknown" and never claims a channel relay', () => {
      for (const m of [dm(), post(), dm({ heardBy: [{ hash: '7f' }] })]) {
        const key = describeMeshCoreDelivery(m).statusKey;
        expect(key).not.toBe('delivery_details.mc_status.unknown');
        expect(key).not.toBe('delivery_details.mc_status.relayed');
      }
    });

    it('every key it can return exists in en.json', async () => {
      const { readFileSync } = await import('node:fs');
      const en = JSON.parse(readFileSync('public/locales/en.json', 'utf8')) as Record<string, string>;
      const states: Array<MeshCoreMessage['deliveryStatus']> = [undefined, 'sent', 'delivered', 'failed'];
      for (const make of [dm, post]) {
        for (const deliveryStatus of states) {
          const d = describeMeshCoreDelivery(make({ deliveryStatus }));
          expect(en[d.statusKey], d.statusKey).toBeTruthy();
          expect(en[d.meaningKey], d.meaningKey).toBeTruthy();
        }
      }
    });
  });

  it('a DM ack state wins over the channel reading', () => {
    expect(describeMeshCoreDelivery(baseMessage({ toPublicKey: 'channel-2', deliveryStatus: 'failed' })).statusKey)
      .toBe('delivery_details.mc_status.not_confirmed');
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
