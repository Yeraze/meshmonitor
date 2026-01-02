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
