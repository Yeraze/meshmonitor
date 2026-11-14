/**
 * MQTT consent capture (#5156 part 1).
 *
 * Works out which of the three per-node consent columns (migration 234) one
 * received packet should stamp:
 *
 *  - an MQTT-delivered packet whose `Data.bitfield` we could read stamps
 *    `mqttOkToMqtt` (bit 0) + `mqttOkToMqttAt`. "MQTT-delivered" means the
 *    transport mechanism is MQTT, OR `via_mqtt` is set: LORA + via_mqtt is an
 *    MQTT downlink rebroadcast, which says nothing about local RF exposure.
 *    An unreadable bitfield (absent, pre-2.5 firmware, undecryptable) stamps
 *    nothing, so the last known bit stands and a never-read bit stays NULL.
 *  - a packet heard over RF with `via_mqtt` clear stamps `rfDirectLastHeard`.
 *    Uses `classifyNodeTransport`, so INTERNAL / API / unset mechanisms count
 *    as RF exactly as the map's transport filter does. A replayed frame
 *    (firmware NodeDB replay, store & forward) stamps nothing.
 *  - UDP stamps nothing.
 *
 * Pure: the caller merges the result into its node upsert.
 */
import { classifyNodeTransport, TX_MQTT } from '../../utils/nodeTransport.js';
import { readBitfieldOkToMqtt } from './okToMqtt.js';

export interface MqttConsentStamp {
  mqttOkToMqtt?: boolean;
  mqttOkToMqttAt?: number;
  rfDirectLastHeard?: number;
}

export interface MqttConsentCaptureInput {
  /** Resolved transport mechanism of the packet (see resolveRadioPacketTransport). */
  transportMechanism: number | null | undefined;
  viaMqtt?: boolean | null;
  /** True when the packet reached us through an MQTT path the packet itself does not flag (e.g. an MQTT source). */
  arrivedViaMqtt?: boolean;
  /** Raw `Data.bitfield`, or null/undefined when not on the wire or not decrypted. */
  bitfield?: number | null;
  /** Unix seconds to stamp. Undefined (replay guard) stamps nothing. */
  heardSec: number | undefined;
  /** A replayed frame: never counts as fresh RF evidence. */
  replayed?: boolean;
}

export function isMqttDeliveredPacket(input: Pick<MqttConsentCaptureInput, 'transportMechanism' | 'viaMqtt' | 'arrivedViaMqtt'>): boolean {
  return input.arrivedViaMqtt === true || input.transportMechanism === TX_MQTT || input.viaMqtt === true;
}

export function mqttConsentStamp(input: MqttConsentCaptureInput): MqttConsentStamp {
  if (input.heardSec === undefined) return {};
  if (isMqttDeliveredPacket(input)) {
    const state = readBitfieldOkToMqtt(input.bitfield);
    if (state === 'unknown') return {};
    return { mqttOkToMqtt: state === 'yes', mqttOkToMqttAt: input.heardSec };
  }
  if (input.replayed) return {};
  if (classifyNodeTransport({ transportMechanism: input.transportMechanism, viaMqtt: input.viaMqtt }) === 'rf') {
    return { rfDirectLastHeard: input.heardSec };
  }
  return {};
}
