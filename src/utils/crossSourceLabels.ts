/**
 * Display labels for cross-source correlation (#5559 / #5560 / #5561).
 * Pure helpers, shared by the Unified Packet Monitor, the Coverage Report
 * and the map edge layer.
 */
import type { TFunction } from 'i18next';
import type { CrossSourceTransportClass } from '../types/packet.js';

/** Short label for how the receiving source got the copy. */
export function crossSourceTransportLabel(t: TFunction, transport: CrossSourceTransportClass | null | undefined): string {
  switch (transport) {
    case 'rf':
      return t('cross_source.transport_rf', 'RF');
    case 'mqtt_gateway':
      return t('cross_source.transport_mqtt_gateway', 'MQTT gateway (RF)');
    case 'mqtt':
      return t('cross_source.transport_mqtt', 'MQTT');
    case 'udp':
      return t('cross_source.transport_udp', 'UDP');
    default:
      return '';
  }
}
