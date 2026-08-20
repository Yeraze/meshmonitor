/**
 * Pure "Delivery Details" description builder for own-sent MeshCore
 * messages (#4816 Phase 1). No React, no i18n — returns locale KEYS plus
 * already-formatted literal values so this stays unit-testable and the
 * consuming modal is the only place that calls `t()`.
 */

import type { MeshCoreMessage } from '../../components/MeshCore/hooks/useMeshCore.js';
import { getMeshCoreDeliveryState } from './status.js';
import type { DeliveryDescription, DeliverySection, DeliveryTone } from './types.js';

function formatHex(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `0x${value.toString(16)}`;
}

export function describeMeshCoreDelivery(msg: MeshCoreMessage): DeliveryDescription {
  const state = getMeshCoreDeliveryState(msg.deliveryStatus);

  let statusKey: string;
  let tone: DeliveryTone;
  let meaningKey: string;

  switch (state) {
    case 'delivered':
      statusKey = 'delivery_details.mc_status.delivered';
      tone = 'success';
      meaningKey = 'delivery_details.mc_meaning.delivered';
      break;
    case 'sent':
      statusKey = 'delivery_details.mc_status.sent_awaiting';
      tone = 'pending';
      meaningKey = 'delivery_details.mc_meaning.sent_awaiting';
      break;
    case 'failed':
      statusKey = 'delivery_details.mc_status.not_confirmed';
      tone = 'error';
      meaningKey = 'delivery_details.mc_meaning.not_confirmed';
      break;
    case 'sending':
      statusKey = 'delivery_details.mc_status.sending';
      tone = 'pending';
      meaningKey = 'delivery_details.mc_meaning.sending';
      break;
    case 'unknown':
    default:
      statusKey = 'delivery_details.mc_status.unknown';
      tone = 'warning';
      meaningKey = 'delivery_details.mc_meaning.unknown';
      break;
  }

  const hopCount = msg.hopCount ?? null;
  const hasRouteData = hopCount !== null && hopCount !== undefined;

  const statusSection: DeliverySection = {
    titleKey: 'delivery_details.section.status',
    fields: [
      {
        labelKey: 'delivery_details.field.protocol_result',
        // Only the ACK case has a known, named protocol result this phase;
        // the exact PACKET_ERROR code for failures is not persisted
        // per-message (deferred to a later phase) — Unknown, never guessed.
        value: state === 'delivered' ? 'PACKET_ACK (0x82)' : null,
        provenance: state === 'delivered' ? 'reported' : 'unknown',
        noteKey: state === 'delivered' ? undefined : 'delivery_details.note.protocol_result_deferred',
      },
      {
        labelKey: 'delivery_details.field.round_trip',
        value: msg.roundTripMs !== undefined ? `${msg.roundTripMs} ms` : null,
        // We timed the request → confirm ourselves (MeshMonitor observation),
        // not a value the protocol reports on the wire.
        provenance: 'observed',
      },
    ],
  };

  const identitySection: DeliverySection = {
    titleKey: 'delivery_details.section.identity',
    fields: [
      {
        labelKey: 'delivery_details.field.message_id',
        // Our own row id — MeshMonitor's bookkeeping, not a protocol value.
        value: msg.id ?? null,
        provenance: 'observed',
      },
      {
        labelKey: 'delivery_details.field.expected_ack_crc',
        value: formatHex(msg.expectedAckCrc ?? null),
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
        valueKey: !hasRouteData
          ? undefined
          : hopCount === 0
          ? 'delivery_details.value.direct'
          : 'delivery_details.value.relayed',
        provenance: 'reported',
      },
      {
        labelKey: 'delivery_details.field.hops',
        value: hasRouteData ? String(hopCount) : null,
        provenance: 'reported',
      },
      {
        labelKey: 'delivery_details.field.relay_path',
        value: msg.routePath ?? null,
        provenance: 'reported',
        noteKey: msg.routePath ? 'delivery_details.note.relay_path_hashes_only' : undefined,
      },
    ],
  };

  const signalSection: DeliverySection = {
    titleKey: 'delivery_details.section.signal',
    fields: [
      {
        labelKey: 'delivery_details.field.snr',
        value: msg.snr !== undefined ? `${msg.snr} dB` : null,
        provenance: 'reported',
        // SNR on a relayed message describes the last hop, not the sender.
        noteKey:
          msg.snr !== undefined && hasRouteData && hopCount !== 0
            ? 'delivery_details.note.snr_last_hop'
            : undefined,
      },
      {
        labelKey: 'delivery_details.field.rssi',
        value: msg.rssi !== undefined ? `${msg.rssi} dBm` : null,
        provenance: 'reported',
      },
    ],
  };

  const scopeValue = (): { value: string | null; provenance: 'reported' | 'unknown' } => {
    if (msg.scopeName) {
      return { value: msg.scopeName, provenance: 'reported' };
    }
    if (msg.scopeCode !== null && msg.scopeCode !== undefined) {
      // 0 = explicitly sent unscoped — a known fact, not missing data.
      if (msg.scopeCode === 0) {
        return { value: 'delivery_details.value.unscoped', provenance: 'reported' };
      }
      return { value: `#${msg.scopeCode.toString(16)}`, provenance: 'reported' };
    }
    return { value: null, provenance: 'unknown' };
  };
  const scope = scopeValue();
  const isUnscopedLiteral = scope.value === 'delivery_details.value.unscoped';

  const scopeSection: DeliverySection = {
    titleKey: 'delivery_details.section.scope',
    fields: [
      {
        labelKey: 'delivery_details.field.scope',
        value: isUnscopedLiteral ? null : scope.value,
        valueKey: isUnscopedLiteral ? 'delivery_details.value.unscoped' : undefined,
        provenance: scope.provenance,
      },
    ],
  };

  return {
    protocol: 'meshcore',
    statusKey,
    tone,
    meaningKey,
    sections: [statusSection, identitySection, routeSection, signalSection, scopeSection],
    // Observed by MeshMonitor through repeater re-flood correlation (#3700).
    // Passed through verbatim — the modal (WP2) decides whether to render it
    // (omit for DMs, show "no re-flood observed" for channel sends).
    heardBy: msg.heardBy,
  };
}
