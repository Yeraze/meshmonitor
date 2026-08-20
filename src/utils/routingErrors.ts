// Friendly RoutingError names, mirroring the meshtastic.Routing.Error enum
// (src/server/constants/meshtastic.ts). Kept as a plain frontend map so the
// Delivery Details popup can name a routing-error code without importing
// server code — the backend persists the numeric `routingErrorCode` on the
// message row, but naming it is a display concern owned by the frontend
// (#4816 Phase 2).
export const ROUTING_ERROR_NAMES: Record<number, string> = {
  0: 'NONE',
  1: 'NO_ROUTE',
  2: 'GOT_NAK',
  3: 'TIMEOUT',
  4: 'NO_INTERFACE',
  5: 'MAX_RETRANSMIT',
  6: 'NO_CHANNEL',
  7: 'TOO_LARGE',
  8: 'NO_RESPONSE',
  9: 'DUTY_CYCLE_LIMIT',
  32: 'BAD_REQUEST',
  33: 'NOT_AUTHORIZED',
  34: 'PKI_FAILED',
  35: 'PKI_UNKNOWN_PUBKEY',
  36: 'ADMIN_BAD_SESSION_KEY',
  37: 'ADMIN_PUBLIC_KEY_UNAUTHORIZED',
  38: 'RATE_LIMIT_EXCEEDED',
  39: 'PKI_SEND_FAIL_PUBLIC_KEY',
};

/** Human-readable name for a RoutingError code (e.g. 5 -> "MAX_RETRANSMIT"). */
export const getRoutingErrorName = (code: number): string => {
  return ROUTING_ERROR_NAMES[code] ?? `UNKNOWN_${code}`;
};
