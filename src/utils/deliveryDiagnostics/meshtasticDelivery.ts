/**
 * Pure "Delivery Details" description builder for own-sent Meshtastic
 * messages (#4816 Phase 1). No React, no i18n — returns locale KEYS plus
 * already-formatted literal values so this stays unit-testable and the
 * consuming modal is the only place that calls `t()`.
 */

import { MeshMessage } from '../../types/message.js';
import { getMeshtasticDeliveryState } from './status.js';
import type { DeliveryDescription, DeliverySection, DeliveryTone } from './types.js';

/**
 * DM vs broadcast/channel convention used throughout the frontend
 * (see `MessagesTab.tsx` `getDMMessages` and the acknowledgment branch in
 * `transformDbMessageToMeshMessage`): `channel === -1` means the message
 * targets a specific destination node (a DM), not a broadcast channel.
 */
export function isMeshtasticDirectMessage(msg: Pick<MeshMessage, 'channel'>): boolean {
  return msg.channel === -1;
}

function formatRelayByte(relayNode: number | undefined): string | null {
  if (relayNode === undefined || relayNode === null) return null;
  return `0x${relayNode.toString(16)}`;
}

export function describeMeshtasticDelivery(msg: MeshMessage): DeliveryDescription {
  const state = getMeshtasticDeliveryState(msg);
  const dm = isMeshtasticDirectMessage(msg);

  let statusKey: string;
  let tone: DeliveryTone;
  let meaningKey: string;

  switch (state) {
    case 'failed':
      statusKey = 'delivery_details.mt_status.not_confirmed';
      tone = 'error';
      meaningKey = 'delivery_details.mt_meaning.not_confirmed';
      break;
    case 'confirmed':
      statusKey = 'delivery_details.mt_status.confirmed_destination';
      tone = 'success';
      meaningKey = 'delivery_details.mt_meaning.confirmed_destination';
      break;
    case 'delivered':
      if (dm) {
        statusKey = 'delivery_details.mt_status.delivered_radio';
        meaningKey = 'delivery_details.mt_meaning.delivered_radio';
      } else {
        statusKey = 'delivery_details.mt_status.ack_by_mesh';
        meaningKey = 'delivery_details.mt_meaning.ack_by_mesh';
      }
      tone = 'success';
      break;
    case 'pending':
      statusKey = 'delivery_details.mt_status.pending';
      tone = 'pending';
      meaningKey = 'delivery_details.mt_meaning.pending';
      break;
    case 'timeout':
    default:
      statusKey = 'delivery_details.mt_status.timeout';
      tone = 'warning';
      meaningKey = 'delivery_details.mt_meaning.timeout';
      break;
  }

  const hasHopData = msg.hopStart !== undefined && msg.hopLimit !== undefined;
  const hopsUsed = hasHopData ? (msg.hopStart as number) - (msg.hopLimit as number) : null;
  const isRelayed = hasHopData ? msg.hopStart !== msg.hopLimit : null;

  const statusSection: DeliverySection = {
    titleKey: 'delivery_details.section.status',
    fields: [
      // Exact protocol routing-result code is not persisted this phase
      // (Phase 2 will add the numeric routing-error name map) — always
      // Unknown, never guessed.
      {
        labelKey: 'delivery_details.field.protocol_result',
        value: null,
        provenance: 'unknown',
        noteKey: 'delivery_details.note.protocol_result_deferred',
      },
    ],
  };

  const identitySection: DeliverySection = {
    titleKey: 'delivery_details.section.identity',
    fields: [
      // Meshtastic uses the packet ID as the ACK request ID, so "Message ID"
      // and "Request ID" are the same value — collapsed into one row rather
      // than showing the identical number twice under two labels.
      {
        labelKey: 'delivery_details.field.message_request_id',
        value: msg.requestId !== undefined ? String(msg.requestId) : null,
        provenance: 'reported',
        noteKey:
          msg.requestId !== undefined ? 'delivery_details.note.packet_is_request_id' : undefined,
      },
      {
        labelKey: 'delivery_details.field.ack_from_node',
        value: msg.ackFromNode !== undefined ? String(msg.ackFromNode) : null,
        provenance: 'reported',
      },
    ],
  };

  const routeSection: DeliverySection = {
    titleKey: 'delivery_details.section.route',
    fields: [
      {
        labelKey: 'delivery_details.field.route_type',
        value: null,
        valueKey:
          isRelayed === null
            ? undefined
            : isRelayed
            ? 'delivery_details.value.relayed'
            : 'delivery_details.value.direct',
        provenance: 'inferred',
      },
      {
        labelKey: 'delivery_details.field.hop_start',
        value: msg.hopStart !== undefined ? String(msg.hopStart) : null,
        provenance: 'reported',
      },
      {
        labelKey: 'delivery_details.field.hop_limit',
        value: msg.hopLimit !== undefined ? String(msg.hopLimit) : null,
        provenance: 'reported',
      },
      {
        labelKey: 'delivery_details.field.hops_used',
        value: hopsUsed !== null ? `~${hopsUsed}` : null,
        provenance: 'inferred',
      },
      {
        labelKey: 'delivery_details.field.last_relay',
        value: formatRelayByte(msg.relayNode),
        provenance: 'reported',
        noteKey: msg.relayNode !== undefined ? 'delivery_details.value.last_byte_only' : undefined,
      },
    ],
  };

  const signalSection: DeliverySection = {
    titleKey: 'delivery_details.section.signal',
    fields: [
      {
        labelKey: 'delivery_details.field.snr',
        value: msg.rxSnr !== undefined ? `${msg.rxSnr} dB` : null,
        provenance: 'reported',
      },
      {
        labelKey: 'delivery_details.field.rssi',
        value: msg.rxRssi !== undefined ? `${msg.rxRssi} dBm` : null,
        provenance: 'reported',
      },
    ],
  };

  const transportSection: DeliverySection = {
    titleKey: 'delivery_details.section.transport',
    fields: [
      {
        labelKey: 'delivery_details.field.path',
        value: null,
        valueKey: msg.viaMqtt ? 'delivery_details.value.mqtt_bridge' : 'delivery_details.value.rf',
        provenance: 'observed',
      },
      // Store & Forward attribution is not plumbed to the frontend this
      // phase (3-layer plumb: services interface + transform + type) —
      // always Unknown.
      {
        labelKey: 'delivery_details.field.store_forward',
        value: null,
        provenance: 'unknown',
        noteKey: 'delivery_details.value.unknown_not_available',
      },
      {
        labelKey: 'delivery_details.field.xeddsa_signed',
        value: null,
        valueKey:
          msg.xeddsaSigned === undefined
            ? undefined
            : msg.xeddsaSigned
            ? 'delivery_details.value.yes'
            : 'delivery_details.value.no',
        provenance: 'reported',
      },
      {
        labelKey: 'delivery_details.field.want_ack',
        value: null,
        valueKey:
          msg.wantAck === undefined
            ? undefined
            : msg.wantAck
            ? 'delivery_details.value.yes'
            : 'delivery_details.value.no',
        provenance: 'reported',
      },
    ],
  };

  return {
    protocol: 'meshtastic',
    statusKey,
    tone,
    meaningKey,
    sections: [statusSection, identitySection, routeSection, signalSection, transportSection],
  };
}
