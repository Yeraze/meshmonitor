/**
 * Meshtastic Protocol Constants
 *
 * These constants match the Meshtastic protobuf definitions.
 * See: https://github.com/meshtastic/protobufs/
 */

import { MODEM_PRESET_CHANNEL_NAMES } from '../../utils/loraFrequency.js';

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
  REMOTE_SHELL_APP: 13,
  REPLY_APP: 32,
  IP_TUNNEL_APP: 33,
  PAXCOUNTER_APP: 34,
  STORE_FORWARD_PLUSPLUS_APP: 35,
  NODE_STATUS_APP: 36,
  MESH_BEACON_APP: 37, // MeshBeacon periodic broadcast (firmware 2.8+)
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
  ATAK_PLUGIN_V2: 78,
  GROUPALARM_APP: 112,
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
 * Decide what transport to stamp on a node row from a packet that arrived over
 * the locally-connected radio's TCP/serial link (#4240).
 *
 * MUST always return a value. Returning undefined for "firmware didn't say"
 * caused the caller to omit the key from the upsert, which made `upsertNode`
 * carry the node's PREVIOUS value forward — so classification was sticky, not
 * "most-recent wins" as intended. One packet ever heard via an MQTT bridge
 * stamped a node MQTT permanently, and since the map's Show MQTT toggle
 * defaults to off, that node disappeared for good: immune to favoriting,
 * un-hiding, and fresh position exchanges.
 *
 * Note protobuf.js yields `null` (not 0) for an unset scalar, so "absent" and
 * "explicitly INTERNAL (0)" are genuinely indistinguishable on the wire — which
 * is why an explicit numeric value is always preferred when present.
 *
 * The LoRa fallback is sound only for this link: packets reaching it came off
 * our own radio. A node our radio hears solely over its MQTT uplink still
 * carries the legacy `viaMqtt` flag and stays classified MQTT, so MQTT-only
 * nodes remain hidden by default as intended (#3112). MQTT-bridge *sources*
 * stamp `TransportMechanism.MQTT` explicitly elsewhere and are unaffected.
 */
export function resolveRadioPacketTransport(packet: {
  transportMechanism?: number | null;
  viaMqtt?: boolean | null;
}): number {
  if (typeof packet.transportMechanism === 'number') return packet.transportMechanism;
  return packet.viaMqtt === true ? TransportMechanism.MQTT : TransportMechanism.LORA;
}

/**
 * Config.LoRaConfig.FEM_LNA_Mode — FEM (Front-End Module) LNA (Low Noise Amplifier) mode.
 * Added in Meshtastic firmware v2.7.20 (meshtastic/firmware#9809). Surfaced from
 * meshtastic/protobufs config.proto `enum FEM_LNA_Mode` (field `fem_lna_mode = 106`).
 * The zero value (DISABLED) is a real selectable mode, so proto3 elision must default to it.
 */
export const FemLnaMode = {
  /** FEM_LNA is present but disabled */
  DISABLED: 0,
  /** FEM_LNA is present and enabled */
  ENABLED: 1,
  /** FEM_LNA is not present on the device */
  NOT_PRESENT: 2,
} as const;

export type FemLnaModeType = typeof FemLnaMode[keyof typeof FemLnaMode];

/**
 * Get the name of a FEM LNA mode value.
 */
export function getFemLnaModeName(mode: number): string {
  const entries = Object.entries(FemLnaMode);
  for (const [name, value] of entries) {
    if (value === mode) {
      return name;
    }
  }
  return 'UNKNOWN';
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
 * Modem preset → channel-name map (Meshtastic firmware spec).
 *
 * When a device's channel slot has an empty name AND it's running on a
 * `modem_preset`, the firmware derives the on-wire channel name from the
 * preset's pascal-case label (no spaces) — `LONG_FAST` → `LongFast` etc.
 * That derived name is used both for the channel hash AND for the
 * `ServiceEnvelope.channelId` field when publishing to MQTT.
 *
 * Reference: firmware `meshtastic/firmware`, see `Channels.cpp::getName`.
 *
 * NOTE: the values here are the firmware-spec names (no spaces) — distinct
 * from the user-friendly "Long Fast" labels we render elsewhere. Anything
 * touching channel hashes or MQTT topic naming must use these.
 */
// Canonical copy lives in src/utils/loraFrequency.ts (single source of truth
// for firmware-derived default channel names — verified against firmware
// DisplayFormatters.cpp). Re-exported here for existing server consumers.
export { MODEM_PRESET_CHANNEL_NAMES };

/** Returns the firmware-derived channel name for a modem preset, or null. */
export function modemPresetChannelName(modemPreset: number | undefined | null): string | null {
  if (typeof modemPreset !== 'number') return null;
  return MODEM_PRESET_CHANNEL_NAMES[modemPreset] ?? null;
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
 * Maximum valid Meshtastic node number.
 *
 * `nodeNum` is a 32-bit unsigned integer in the Meshtastic protocol — values
 * outside `[0, 0xFFFFFFFF]` cannot represent a real node, and pushing them into
 * a PostgreSQL `bigint` column triggers a query error (issue #3186). Use
 * {@link isValidNodeNum} as a guard before any DB op or routing decision.
 *
 * `0xFFFFFFFF` itself is the broadcast address.
 */
export const MAX_NODE_NUM = 0xFFFFFFFF; // 4,294,967,295

/**
 * Returns true if `n` is a safe-integer in the 32-bit unsigned `nodeNum` range.
 *
 * Rejects NaN, Infinity, negatives, non-integers (the floating-point values
 * `parseInt(longHexString, 16)` can produce when the input is longer than 8
 * hex chars — e.g. a 64-char public key — overflow into ~1e+76, which still
 * passes `Number.isFinite` but cannot fit in any DB column).
 */
export function isValidNodeNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_NODE_NUM;
}

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
