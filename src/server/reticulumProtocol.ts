/**
 * Wire protocol v1 types for the meshmonitor-rns-bridge <-> Node WebSocket link.
 *
 * Mirrors `bridge/meshmonitor_rns_bridge/protocol.py` exactly (#3960 Phase 1a
 * WP3). The golden fixtures under `bridge/tests/fixtures/*.json` are the
 * single source of truth for this contract — see reticulumBridgeClient.test.ts
 * for the parse-every-fixture guard. If a fixture and this file disagree, the
 * fixture wins (regenerate this file, not the fixture) — see
 * docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md §4.4 / §7 note 3.
 *
 * Envelope shape: `{ v: 1, type: <string>, id?: <string>, ts: <epoch_ms>, ...fields }`.
 */

export const PROTOCOL_VERSION = 1;

// --------------------------------------------------------------------------
// Message types
// --------------------------------------------------------------------------

export const MESSAGE_TYPE = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  ERROR: 'error',
  CONFIGURE: 'configure',
  READY: 'ready',
  ANNOUNCE: 'announce',
  INTERFACE_STATS: 'interface_stats',
  PATH_TABLE: 'path_table',
  GET_STATUS: 'get_status',
  STATUS: 'status',
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

// --------------------------------------------------------------------------
// Failure codes (build spec §4.3 / §4.4)
// --------------------------------------------------------------------------

export const FAILURE_CODE = {
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  AUTH_FAILED: 'AUTH_FAILED',
  CONFIGDIR_UNREADABLE: 'CONFIGDIR_UNREADABLE',
  NO_SHARED_INSTANCE: 'NO_SHARED_INSTANCE',
  RPC_AUTH_FAILED: 'RPC_AUTH_FAILED',
  TCP_PEER_UNREACHABLE: 'TCP_PEER_UNREACHABLE',
  RNS_INIT_FAILED: 'RNS_INIT_FAILED',
  /**
   * Node-side only: the bridge never emits this — it means the WS socket
   * never opened at all (e.g. the sidecar container isn't up yet). Kept here
   * so both sides agree on the full failure-code set (protocol.py mirrors
   * this same comment).
   */
  BRIDGE_UNREACHABLE: 'BRIDGE_UNREACHABLE',
} as const;

export type FailureCode = (typeof FAILURE_CODE)[keyof typeof FAILURE_CODE];

export const FAILURE_CODES: ReadonlySet<FailureCode> = new Set(Object.values(FAILURE_CODE));

/** Failure codes that can originate from RNS instance startup (rns_manager.py). */
export const STARTUP_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  FAILURE_CODE.CONFIGDIR_UNREADABLE,
  FAILURE_CODE.NO_SHARED_INSTANCE,
  FAILURE_CODE.RPC_AUTH_FAILED,
  FAILURE_CODE.TCP_PEER_UNREACHABLE,
  FAILURE_CODE.RNS_INIT_FAILED,
]);

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && FAILURE_CODES.has(value as FailureCode);
}

// --------------------------------------------------------------------------
// Envelope
// --------------------------------------------------------------------------

export interface Envelope {
  v: number;
  type: string;
  id?: string;
  ts: number;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Parse and structurally validate a raw WS message into an `Envelope`.
 * Mirrors `protocol.py`'s `decode()`: validates only the envelope shell
 * (`v`, `type` present, `type` is a string) — per-type required-field
 * validation happens at the call site (mirrors the Python side leaving
 * per-type checks to callers too).
 */
export function decodeEnvelope(raw: string): Envelope {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new ProtocolError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ProtocolError('envelope must be a JSON object');
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== 'string') {
    throw new ProtocolError("envelope missing string 'type'");
  }
  if (!('v' in rec)) {
    throw new ProtocolError("envelope missing 'v'");
  }
  return obj as Envelope;
}

// --------------------------------------------------------------------------
// Client -> bridge messages
// --------------------------------------------------------------------------

export interface HelloMessage extends Envelope {
  type: typeof MESSAGE_TYPE.HELLO;
  protocolVersion: number;
  token: string;
}

export interface TcpPeerConfig {
  host: string;
  port: number;
}

export type ReticulumMode = 'attach' | 'tcp_peer';

export interface ConfigureMessage extends Envelope {
  type: typeof MESSAGE_TYPE.CONFIGURE;
  id?: string;
  mode: ReticulumMode;
  configDir?: string;
  peers?: TcpPeerConfig[];
}

export interface GetStatusMessage extends Envelope {
  type: typeof MESSAGE_TYPE.GET_STATUS;
  id: string;
}

// --------------------------------------------------------------------------
// Bridge -> client messages
// --------------------------------------------------------------------------

export interface WelcomeMessage extends Envelope {
  type: typeof MESSAGE_TYPE.WELCOME;
  protocolVersion: number;
  bridgeVersion: string;
  rnsVersion: string;
}

export interface ErrorMessage extends Envelope {
  type: typeof MESSAGE_TYPE.ERROR;
  id?: string;
  code: FailureCode;
  message?: string;
}

export interface ReadyMessage extends Envelope {
  type: typeof MESSAGE_TYPE.READY;
  id?: string;
}

/**
 * Announce event. Nullable fields are routinely `null` (not omitted) on the
 * wire — the golden fixtures (`announce.json` vs `announce_no_signal.json`)
 * confirm every optional field is always present, just possibly `null`.
 * `rssi`/`snr`/`q` are only populated in `attach` mode (no RF over a
 * loopback `tcp_peer` test rig) — see build-spec wire-protocol fact #2.
 */
export interface AnnounceMessage extends Envelope {
  type: typeof MESSAGE_TYPE.ANNOUNCE;
  destinationHash: string;
  identityHash: string | null;
  appName: string | null;
  aspects: string[] | null;
  displayName: string | null;
  appDataB64: string | null;
  hops: number | null;
  nextHopInterface: string | null;
  rssi: number | null;
  snr: number | null;
  q: number | null;
  isPathResponse: boolean | null;
}

export type InterfaceStatus = 'up' | 'down';

export interface InterfaceStatsEntry {
  name: string;
  type: string | null;
  hash?: string | null;
  mode?: string | null;
  status: InterfaceStatus;
  online: boolean;
  bitrate?: number | null;
  txBytes: number;
  rxBytes: number;
}

export interface InterfaceStatsMessage extends Envelope {
  type: typeof MESSAGE_TYPE.INTERFACE_STATS;
  interfaces: InterfaceStatsEntry[];
}

export interface PathTableEntry {
  destinationHash: string;
  via: string;
  hops: number;
  interface: string;
  expires: number;
}

export interface PathTableMessage extends Envelope {
  type: typeof MESSAGE_TYPE.PATH_TABLE;
  paths: PathTableEntry[];
}

/**
 * Status event. Built from the bridge's free-form `status_message(id, **fields)`
 * builder (protocol.py), so this type carries every field the bridge is known
 * to emit today (`rns_manager.py: RNSManager.status()` for the `get_status`
 * reply; `pollers.py`'s health-monitor broadcast on repeated poll failure).
 * `connected` is the only field guaranteed present on every variant.
 */
export interface StatusMessage extends Envelope {
  type: typeof MESSAGE_TYPE.STATUS;
  id?: string;
  connected: boolean;
  mode?: ReticulumMode | string;
  interfaceCount?: number | null;
  rnsVersion?: string | null;
  /** Present on the health-monitor's failure broadcast (pollers.py on_error). */
  code?: FailureCode;
  message?: string;
}

export type BridgeEventMessage =
  | WelcomeMessage
  | ErrorMessage
  | ReadyMessage
  | AnnounceMessage
  | InterfaceStatsMessage
  | PathTableMessage
  | StatusMessage;
