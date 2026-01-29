/**
 * Meshtastic Protocol Constants
 *
 * These constants match the Meshtastic protobuf definitions.
 * See: https://github.com/meshtastic/protobufs/
 */

/**
 * Port numbers for different Meshtastic application types.
 * From meshtastic.PortNum enum in portnums.proto
 */
export const PortNum = {
  UNKNOWN_APP: 0,
  TEXT_MESSAGE_APP: 1,
  REMOTE_HARDWARE_APP: 2,
  POSITION_APP: 3,
  NODEINFO_APP: 4,
  ROUTING_APP: 5,
  ADMIN_APP: 6,
  TEXT_MESSAGE_COMPRESSED_APP: 7,
  WAYPOINT_APP: 8,
  AUDIO_APP: 9,
  DETECTION_SENSOR_APP: 10,
  REPLY_APP: 32,
  IP_TUNNEL_APP: 33,
  PAXCOUNTER_APP: 34,
  SERIAL_APP: 64,
  STORE_FORWARD_APP: 65,
  RANGE_TEST_APP: 66,
  TELEMETRY_APP: 67,
  ZPS_APP: 68,
  SIMULATOR_APP: 69,
  TRACEROUTE_APP: 70,
  NEIGHBORINFO_APP: 71,
  ATAK_PLUGIN: 72,
  MAP_REPORT_APP: 73,
  POWERSTRESS_APP: 74,
  PRIVATE_APP: 256,
  ATAK_FORWARDER: 257,
  MAX: 511,
} as const;

export type PortNumType = typeof PortNum[keyof typeof PortNum];

/**
 * Routing error reasons from meshtastic.Routing.Error enum
 * in mesh.proto
 */
export const RoutingError = {
  NONE: 0,
  NO_ROUTE: 1,
  GOT_NAK: 2,
  TIMEOUT: 3,
  NO_INTERFACE: 4,
  MAX_RETRANSMIT: 5,
  NO_CHANNEL: 6,
  TOO_LARGE: 7,
  NO_RESPONSE: 8,
  DUTY_CYCLE_LIMIT: 9,
  BAD_REQUEST: 32,
  NOT_AUTHORIZED: 33,
  PKI_FAILED: 34,
  PKI_UNKNOWN_PUBKEY: 35,
  ADMIN_BAD_SESSION_KEY: 36,
  ADMIN_PUBLIC_KEY_UNAUTHORIZED: 37,
  RATE_LIMIT_EXCEEDED: 38,
} as const;

export type RoutingErrorType = typeof RoutingError[keyof typeof RoutingError];

/**
 * Transport mechanism indicating how a packet arrived.
 * From meshtastic.MeshPacket.TransportMechanism enum in mesh.proto
 */
export const TransportMechanism = {
  /** The node generated the packet itself */
  INTERNAL: 0,
  /** Arrived via the primary LoRa radio */
  LORA: 1,
  /** Arrived via a secondary LoRa radio */
  LORA_ALT1: 2,
  /** Arrived via a tertiary LoRa radio */
  LORA_ALT2: 3,
  /** Arrived via a quaternary LoRa radio */
  LORA_ALT3: 4,
  /** Arrived via an MQTT connection */
  MQTT: 5,
  /** Arrived via Multicast UDP */
  MULTICAST_UDP: 6,
  /** Arrived via API connection */
  API: 7,
} as const;

export type TransportMechanismType = typeof TransportMechanism[keyof typeof TransportMechanism];

/**
 * Get the name of a transport mechanism
 */
export function getTransportMechanismName(mechanism: number): string {
  const entries = Object.entries(TransportMechanism);
  for (const [name, value] of entries) {
    if (value === mechanism) {
      return name;
    }
  }
  return `UNKNOWN_${mechanism}`;
}

/**
 * Check if a transport mechanism indicates the packet came via MQTT
 */
export function isViaMqtt(mechanism: number | undefined): boolean {
  return mechanism === TransportMechanism.MQTT;
}

/**
 * Get the name of a port number
 */
export function getPortNumName(portnum: number): string {
  const entries = Object.entries(PortNum);
  for (const [name, value] of entries) {
    if (value === portnum) {
      return name;
    }
  }
  return `UNKNOWN_${portnum}`;
}

/**
 * Get the name of a routing error
 */
export function getRoutingErrorName(errorCode: number): string {
  const entries = Object.entries(RoutingError);
  for (const [name, value] of entries) {
    if (value === errorCode) {
      return name;
    }
  }
  return `UNKNOWN_${errorCode}`;
}

/**
 * Check if a port number is an internal management port
 * (used for filtering packet logs)
 */
export function isInternalPortNum(portnum: number): boolean {
  return portnum === PortNum.ROUTING_APP || portnum === PortNum.ADMIN_APP;
}

/**
 * Check if a routing error indicates a PKI key mismatch
 */
export function isPkiError(errorReason: number): boolean {
  return errorReason === RoutingError.PKI_FAILED || errorReason === RoutingError.PKI_UNKNOWN_PUBKEY;
}

/**
 * Channel Database Constants
 *
 * These constants are used for server-side decryption of encrypted packets
 * using stored channel configurations.
 */

/**
 * Offset for Channel Database channels.
 * Device channels use indices 0-7, so database channels start at 100
 * to avoid any potential conflicts.
 * Channel number = CHANNEL_DB_OFFSET + channelDatabaseId
 */
export const CHANNEL_DB_OFFSET = 100;

/**
 * Maximum number of packets to process in a single retroactive decryption batch.
 * This can be overridden via environment variable RETROACTIVE_DECRYPTION_BATCH_SIZE.
 */
export const DEFAULT_RETROACTIVE_BATCH_SIZE = 10000;

/**
 * Cache TTL for channel database entries in milliseconds.
 * Default: 1 minute
 */
export const CHANNEL_CACHE_TTL_MS = 60000;

/**
 * Maximum message size in bytes for Meshtastic text messages.
 * This is the payload limit for TEXT_MESSAGE_APP packets.
 * Messages longer than this will be truncated or need to be split.
 */
export const MAX_MESSAGE_BYTES = 200;
