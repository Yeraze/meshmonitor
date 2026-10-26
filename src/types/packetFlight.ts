/**
 * Live packet traffic on the map (#4835): the `packet:flight` socket event.
 *
 * One event per received packet (per gateway, for MQTT). It names the nodes at
 * each end and nothing of what the packet said: no text, no payload bytes, no
 * decrypted fields, and no positions. The browser resolves positions against
 * the node list it already holds for that map, which the server has already
 * filtered for the viewer, so a node or position the viewer could not see
 * never shows up here as a dot.
 */

export type PacketFlightProtocol = 'meshtastic' | 'mqtt' | 'meshcore';

export interface PacketFlight {
  sourceId: string;
  protocol: PacketFlightProtocol;
  /** Server receive time, epoch ms. */
  receivedAt: number;
  /**
   * The sender. Meshtastic / MQTT: the node number. MeshCore: a full public
   * key (adverts, ANON_REQ) or a one-byte public-key prefix (two hex chars,
   * from a message's src hash); null when the packet does not say.
   */
  from: number | string | null;
  /**
   * The receiver. Meshtastic: the source's local node number. MQTT: the
   * gateway node number. MeshCore: the local companion's (or the Observer's)
   * public key.
   */
  to: number | string | null;
  /**
   * The last relay. Meshtastic / MQTT: the `relay_node` low byte (1-255).
   * MeshCore: the last path hash (hex). Null when unknown.
   */
  relay: number | string | null;
  /** Hops the packet took to reach the receiver; null when unknown. */
  hopsUsed: number | null;
  /** Portnum name (Meshtastic / MQTT) or payload type name (MeshCore). */
  kind: string | null;
  snr?: number | null;
  rssi?: number | null;
  /** Meshtastic TCP only: the node got it over its MQTT uplink, not RF. */
  viaMqtt?: boolean;
}

/** Socket message a client sends to start getting `packet:flight` for some sources. */
export const PACKET_FLIGHTS_SUBSCRIBE = 'packet-flights:subscribe';
/** Socket message a client sends to stop. With no list, it stops every source. */
export const PACKET_FLIGHTS_UNSUBSCRIBE = 'packet-flights:unsubscribe';
/** The event the server sends. */
export const PACKET_FLIGHT_EVENT = 'packet:flight';
