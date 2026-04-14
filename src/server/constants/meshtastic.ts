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
  ALERT_APP: 11,
  KEY_VERIFICATION_APP: 12,
  REPLY_APP: 32,
  IP_TUNNEL_APP: 33,
  PAXCOUNTER_APP: 34,
  STORE_FORWARD_PLUSPLUS_APP: 35,
  NODE_STATUS_APP: 36,
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
  LORAWAN_BRIDGE: 75,
  RETICULUM_TUNNEL_APP: 76,
  CAYENNE_APP: 77,
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
  PKI_SEND_FAIL_PUBLIC_KEY: 39,
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
  return errorReason === RoutingError.PKI_FAILED ||
    errorReason === RoutingError.PKI_UNKNOWN_PUBKEY ||
    errorReason === RoutingError.PKI_SEND_FAIL_PUBLIC_KEY;
}

/**
 * Store & Forward RequestResponse types.
 * From meshtastic.StoreAndForward.RequestResponse enum in storeforward.proto
 * 001-063 = From Router (server), 064-127 = From Client
 */
export const StoreForwardRequestResponse = {
  UNSET: 0,
  ROUTER_ERROR: 1,
  ROUTER_HEARTBEAT: 2,
  ROUTER_PING: 3,
  ROUTER_PONG: 4,
  ROUTER_BUSY: 5,
  ROUTER_HISTORY: 6,
  ROUTER_STATS: 7,
  ROUTER_TEXT_DIRECT: 8,
  ROUTER_TEXT_BROADCAST: 9,
  CLIENT_ERROR: 64,
  CLIENT_HISTORY: 65,
  CLIENT_STATS: 66,
  CLIENT_PING: 67,
  CLIENT_PONG: 68,
  CLIENT_ABORT: 106,
} as const;

export type StoreForwardRequestResponseType = typeof StoreForwardRequestResponse[keyof typeof StoreForwardRequestResponse];

/**
 * Get the name of a Store & Forward RequestResponse type
 */
export function getStoreForwardRequestResponseName(rr: number): string {
  const entries = Object.entries(StoreForwardRequestResponse);
  for (const [name, value] of entries) {
    if (value === rr) {
      return name;
    }
  }
  return `UNKNOWN_${rr}`;
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
 * Minimum interval between traceroute sends in milliseconds.
 * The Meshtastic firmware enforces a 30-second rate limit on traceroute requests.
 */
export const MIN_TRACEROUTE_INTERVAL_MS = 30 * 1000;

/**
 * Maximum message size in bytes for Meshtastic text messages.
 * This is the payload limit for TEXT_MESSAGE_APP packets.
 * Messages longer than this will be truncated or need to be split.
 */
export const MAX_MESSAGE_BYTES = 200;

/**
 * Meshtastic default channel encryption key.
 * This is the well-known key used when PSK is set to shorthand value 1 (AQ== in base64).
 */
export const MESHTASTIC_DEFAULT_KEY = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01
]);

/**
 * Expand a Meshtastic shorthand PSK (1 byte) to a full 16-byte key.
 * Shorthand values:
 *   0 = No crypto (returns null)
 *   1 = Default key
 *   2-10 = Default key with (value-1) added to last byte (simple1-simple9)
 *
 * @param pskBuffer The raw PSK buffer (may be 1 byte shorthand or full 16/32 byte key)
 * @returns Expanded buffer (16 or 32 bytes) or null if no crypto
 */
export function expandShorthandPsk(pskBuffer: Buffer): Buffer | null {
  if (pskBuffer.length === 0) {
    return null; // No crypto
  }

  // Full-length keys pass through unchanged
  if (pskBuffer.length === 16 || pskBuffer.length === 32) {
    return pskBuffer;
  }

  // Shorthand: single byte
  if (pskBuffer.length === 1) {
    const shorthandValue = pskBuffer[0];
    if (shorthandValue === 0) {
      return null; // No crypto
    }

    // Copy the default key
    const key = Buffer.from(MESHTASTIC_DEFAULT_KEY);
    if (shorthandValue >= 2 && shorthandValue <= 10) {
      // simple1-simple9: add (value-1) to last byte
      key[15] = (key[15] + (shorthandValue - 1)) & 0xff;
    }
    return key;
  }

  // Invalid length
  return null;
}
