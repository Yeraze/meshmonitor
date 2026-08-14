/**
 * Wire protocol v2 types for the meshmonitor-rns-bridge <-> Node WebSocket link.
 *
 * Mirrors `bridge/meshmonitor_rns_bridge/protocol.py` exactly (#3960 Phase 1a
 * WP3, bumped for Phase 2 WP1). The golden fixtures under
 * `bridge/tests/fixtures/*.json` are the single source of truth for this
 * contract — see reticulumBridgeClient.test.ts for the parse-every-fixture
 * guard. If a fixture and this file disagree, the fixture wins (regenerate
 * this file, not the fixture) — see
 * docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md §4.4 / §7 note 3.
 *
 * Envelope shape: `{ v: 2, type: <string>, id?: <string>, ts: <epoch_ms>, ...fields }`.
 *
 * Bumped 1->2 for Phase 2 (LXMF messaging,
 * docs/internal/dev-notes/RETICULUM_PHASE2_BUILD_SPEC.md §3.1, R4): a
 * strict-equality, fail-closed handshake in ws_server.py/bridge means a v1
 * Node talking to a v2 bridge (or vice versa) gets
 * `PROTOCOL_VERSION_MISMATCH` rather than silently missing the new LXMF
 * event/command types below. Types in this file for the LXMF messages are
 * WP1 wire-contract stubs only (mirroring `protocol.py`'s builders) — WP3
 * adds the actual `reticulumBridgeClient.ts` consumer methods/dispatch.
 *
 * Bumped 2->3 for Phase 3 WP1 (own mode + RNode radio config/device info,
 * docs/internal/dev-notes/RETICULUM_PHASE3_BUILD_SPEC.md §2.B/§2.C,
 * #3960): adds the `'own'` `ReticulumMode` plus the
 * get_radio_config/radio_config, set_radio_config, and
 * get_device_info/device_info command-response pairs. Same fail-closed
 * rationale as the 1->2 bump above. Types here are WP1 wire-contract
 * stubs only (mirroring `protocol.py`'s new builders) — WP4 adds the
 * actual `reticulumBridgeClient.ts` consumer methods/dispatch.
 *
 * Bumped 3->4 for Phase 4 WP2/WP3 (bridge probe + remote status,
 * docs/internal/dev-notes/RETICULUM_PHASE4_BUILD_SPEC.md §2.A, #3960):
 * adds the probe/probe_result and get_remote_status/remote_status
 * command-response pairs (rnprobe-style reachability + RNS's built-in
 * `rnstransport.remote.management` /status and /path queries against a
 * REMOTE Transport Node). Same fail-closed strict-equality rationale as
 * the 1->2/2->3 bumps above: these are net-new command types, not a
 * change to any existing envelope shape, but a v3 Node talking to a v4
 * bridge (or vice versa) should still get `PROTOCOL_VERSION_MISMATCH`
 * rather than silently missing the new types. Neither family is
 * mode-gated (unlike the Phase 3 own-mode radio family above) — both are
 * valid in own/attach/tcp_peer alike, since all three modes hold a live
 * RNS instance.
 */

export const PROTOCOL_VERSION = 4;

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
  // Phase 2 (LXMF messaging, build spec §3.1) -- events (bridge -> Node).
  LXMF_MESSAGE: 'lxmf_message',
  DELIVERY_STATE: 'delivery_state',
  // Phase 3 (Sideband FIELD_TELEMETRY decode, build spec §2.A/§2.C, #3960
  // WP2/WP4) -- event (bridge -> Node). A DEDICATED event type (R3) so
  // telemetry-only Sideband packets never create a chat row on the Node
  // side (see reticulumManager.ts's handleTelemetry, which never touches
  // reticulum_messages).
  TELEMETRY: 'telemetry',
  // Phase 2 -- commands (Node -> bridge).
  SEND_LXMF: 'send_lxmf',
  ANNOUNCE_SELF: 'announce_self',
  SET_DISPLAY_NAME: 'set_display_name',
  SYNC_PROPAGATION: 'sync_propagation',
  SET_PROPAGATION_NODE: 'set_propagation_node',
  GET_IDENTITY: 'get_identity',
  IMPORT_IDENTITY: 'import_identity',
  // Phase 3 (own mode + RNode radio config/device info, build spec §2.C) --
  // commands (Node -> bridge) and their responses (bridge -> Node). Only
  // meaningful when the source's mode is 'own'; attach/tcp_peer reject
  // these with OWN_MODE_REQUIRED.
  GET_RADIO_CONFIG: 'get_radio_config',
  RADIO_CONFIG: 'radio_config',
  SET_RADIO_CONFIG: 'set_radio_config',
  GET_DEVICE_INFO: 'get_device_info',
  DEVICE_INFO: 'device_info',
  // Phase 4 (bridge probe + remote status, build spec §2.A, #3960 WP2/WP3)
  // -- commands (Node -> bridge) and their responses (bridge -> Node).
  // Unlike the own-mode radio family above, NOT mode-gated: valid in
  // own/attach/tcp_peer alike, since all three modes hold a live RNS
  // instance.
  PROBE: 'probe',
  PROBE_RESULT: 'probe_result',
  GET_REMOTE_STATUS: 'get_remote_status',
  REMOTE_STATUS: 'remote_status',
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
  /**
   * Phase 2: generic exception-wrapped failure for any of the LXMF command
   * handlers (send_lxmf/announce_self/set_display_name/sync_propagation/
   * set_propagation_node/get_identity/import_identity) — mirrors
   * protocol.py's `LXMF_COMMAND_FAILED`.
   */
  LXMF_COMMAND_FAILED: 'LXMF_COMMAND_FAILED',
  /**
   * Phase 3 (own mode, build spec §2.B): get_radio_config/set_radio_config/
   * get_device_info sent to a source that isn't running in `'own'` mode
   * (no local RNodeInterface to read/configure) — a TYPED error, distinct
   * from the generic exception-wrapped `RNODE_COMMAND_FAILED` below, so
   * the frontend can tell "wrong mode" apart from "the radio call itself
   * failed" — mirrors protocol.py's `OWN_MODE_REQUIRED`.
   */
  OWN_MODE_REQUIRED: 'OWN_MODE_REQUIRED',
  /**
   * Phase 3: own mode's RNode device path is missing, unreadable, or the
   * RNodeInterface failed to come online — can originate from RNS
   * instance startup (rns_manager.py's `_start_own()`), same as the other
   * `STARTUP_FAILURE_CODES` below.
   */
  RNODE_DEVICE_UNAVAILABLE: 'RNODE_DEVICE_UNAVAILABLE',
  /**
   * Phase 3: generic exception-wrapped failure for get_radio_config/
   * set_radio_config/get_device_info once own-mode-required has already
   * been ruled out — mirrors protocol.py's `RNODE_COMMAND_FAILED`.
   */
  RNODE_COMMAND_FAILED: 'RNODE_COMMAND_FAILED',
  /**
   * Phase 4 (bridge probe + remote status, build spec §2.B, #3960 WP2):
   * generic exception-wrapped failure for the `probe` command (rnprobe-style
   * reachability) — a clean "no path / no proof within timeout" is NOT this
   * code, it's a normal `probe_result` response with `ok: false`; this is
   * reserved for anything that actually raises (malformed destinationHash,
   * an unexpected RNS-layer exception) — mirrors protocol.py's `PROBE_FAILED`.
   */
  PROBE_FAILED: 'PROBE_FAILED',
  /**
   * Phase 4: same "exception-wrapped -> error" contract as `PROBE_FAILED`,
   * for the `get_remote_status` command once `REMOTE_MANAGEMENT_DENIED`
   * (below) has already been ruled out — mirrors protocol.py's
   * `REMOTE_STATUS_FAILED`.
   */
  REMOTE_STATUS_FAILED: 'REMOTE_STATUS_FAILED',
  /**
   * Phase 4: TYPED error, distinct from `REMOTE_STATUS_FAILED` — the
   * remote's `rnstransport.remote.management` link established (so the
   * target is alive and reachable) but its /status and /path requests both
   * failed to conclude, which RNS's ALLOW_LIST request-handler gate makes
   * indistinguishable from "our identity isn't in their
   * remote_management_allowed allowlist" (RNS never sends an explicit
   * denial on the wire) — mirrors protocol.py's `REMOTE_MANAGEMENT_DENIED`.
   */
  REMOTE_MANAGEMENT_DENIED: 'REMOTE_MANAGEMENT_DENIED',
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
  FAILURE_CODE.RNODE_DEVICE_UNAVAILABLE,
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

/**
 * `'own'` added in Phase 3 WP1 (build spec §2.B, #3960): the bridge owns
 * the RNode radio directly via a local RNodeInterface, rather than
 * attaching to someone else's rnsd (`'attach'`) or a remote
 * TCPServerInterface (`'tcp_peer'`).
 */
export type ReticulumMode = 'attach' | 'tcp_peer' | 'own';

export interface ConfigureMessage extends Envelope {
  type: typeof MESSAGE_TYPE.CONFIGURE;
  id?: string;
  mode: ReticulumMode;
  configDir?: string;
  peers?: TcpPeerConfig[];
  /**
   * Phase 3 own-mode fields (build spec §2.C: "device path + initial
   * params"). `device` is the RNode's serial path (e.g. `/dev/ttyUSB0`);
   * the radio-param fields below are the INITIAL values applied at
   * interface construction — all optional, only meaningful when
   * `mode === 'own'`. WP4 wires the actual config-form consumer.
   */
  device?: string;
  frequency?: number;
  bandwidth?: number;
  spreadingFactor?: number;
  codingRate?: number;
  txPower?: number;
  stAlock?: number;
  ltAlock?: number;
}

export interface GetStatusMessage extends Envelope {
  type: typeof MESSAGE_TYPE.GET_STATUS;
  id: string;
}

// --------------------------------------------------------------------------
// Phase 2 (LXMF messaging): client -> bridge commands (build spec §3.5)
// --------------------------------------------------------------------------

/**
 * Matches migration 143's `method` column + protocol.py's `_WIRE_METHOD_TO_LXMF`.
 * Kept as its own type (not imported from `types/reticulum.ts`) because this
 * file is wire-protocol-only and has no dependency on the DB/frontend type
 * modules — but its value set MUST match `ReticulumMessageMethod`
 * (`src/types/reticulum.ts`, canonical definition, re-exported by
 * `src/db/repositories/reticulum.ts`). Update both together.
 */
export type LxmfMethod = 'opportunistic' | 'direct' | 'propagated' | 'paper';

export interface SendLxmfMessage extends Envelope {
  type: typeof MESSAGE_TYPE.SEND_LXMF;
  id?: string;
  to: string;
  title?: string;
  content?: string;
  fields?: Record<string, unknown>;
  method?: LxmfMethod;
  propagationNode?: string;
}

export interface AnnounceSelfMessage extends Envelope {
  type: typeof MESSAGE_TYPE.ANNOUNCE_SELF;
  id?: string;
}

export interface SetDisplayNameMessage extends Envelope {
  type: typeof MESSAGE_TYPE.SET_DISPLAY_NAME;
  id?: string;
  displayName: string;
}

export interface SyncPropagationMessage extends Envelope {
  type: typeof MESSAGE_TYPE.SYNC_PROPAGATION;
  id?: string;
}

export interface SetPropagationNodeMessage extends Envelope {
  type: typeof MESSAGE_TYPE.SET_PROPAGATION_NODE;
  id?: string;
  destinationHash: string;
}

/**
 * Bridge-internal-only (R2/R5): the bridge's reply carries PUBLIC info only
 * (destinationHash/identityHash/displayName via a `status`-shaped envelope —
 * see StatusMessage below). There is deliberately NO Node HTTP route that
 * exposes or accepts a private key — WP4 must not add one.
 */
export interface GetIdentityMessage extends Envelope {
  type: typeof MESSAGE_TYPE.GET_IDENTITY;
  id?: string;
}

/**
 * Bridge-internal-only (R2): the private key travels over this trusted,
 * token-authenticated bridge<->Node WS link, never over a Node HTTP route.
 */
export interface ImportIdentityMessage extends Envelope {
  type: typeof MESSAGE_TYPE.IMPORT_IDENTITY;
  id?: string;
  privateKeyB64: string;
}

export type LxmfCommandMessage =
  | SendLxmfMessage
  | AnnounceSelfMessage
  | SetDisplayNameMessage
  | SyncPropagationMessage
  | SetPropagationNodeMessage
  | GetIdentityMessage
  | ImportIdentityMessage;

// --------------------------------------------------------------------------
// Phase 3 (own mode + RNode radio config/device info): client -> bridge
// commands (build spec §2.C). Only meaningful when mode === 'own' —
// attach/tcp_peer reject these with OWN_MODE_REQUIRED (see ErrorMessage).
// Wire-contract stubs only (mirroring protocol.py's new builders) — WP4
// adds the actual reticulumBridgeClient.ts consumer methods/dispatch.
// --------------------------------------------------------------------------

export interface GetRadioConfigMessage extends Envelope {
  type: typeof MESSAGE_TYPE.GET_RADIO_CONFIG;
  id?: string;
}

/**
 * Partial radio-config write (build spec §2.C: "partial allowed") — any
 * subset of `RadioConfigMessage`'s fields; omitted keys mean "leave this
 * parameter unchanged".
 */
export interface SetRadioConfigMessage extends Envelope {
  type: typeof MESSAGE_TYPE.SET_RADIO_CONFIG;
  id?: string;
  frequency?: number;
  bandwidth?: number;
  spreadingFactor?: number;
  codingRate?: number;
  txPower?: number;
  stAlock?: number;
  ltAlock?: number;
  radioState?: boolean;
}

export interface GetDeviceInfoMessage extends Envelope {
  type: typeof MESSAGE_TYPE.GET_DEVICE_INFO;
  id?: string;
}

export type RadioCommandMessage = GetRadioConfigMessage | SetRadioConfigMessage | GetDeviceInfoMessage;

// --------------------------------------------------------------------------
// Phase 4 (bridge probe + remote status): client -> bridge commands (build
// spec §2.A/§2.B/§2.C, #3960 WP2/WP3). Neither family is mode-gated (unlike
// the Phase 3 own-mode radio family above) — see build spec §2.B/§2.C.
// --------------------------------------------------------------------------

export interface ProbeMessage extends Envelope {
  type: typeof MESSAGE_TYPE.PROBE;
  id?: string;
  destinationHash: string;
  timeoutS?: number;
}

export interface GetRemoteStatusMessage extends Envelope {
  type: typeof MESSAGE_TYPE.GET_REMOTE_STATUS;
  id?: string;
  destinationHash: string;
  timeoutS?: number;
}

export type RemoteCommandMessage = ProbeMessage | GetRemoteStatusMessage;

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
  /**
   * Phase 2 (build spec §3.4): the source's PUBLIC LXMF destination hash,
   * present once the LXMF router has started alongside RNS itself — absent
   * entirely (not null) on a `ready` that isn't a `configure` ack, or if
   * LXMF startup itself failed but RNS attach still succeeded.
   */
  destinationHash?: string;
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
  /**
   * Phase 2: present on a `get_status` reply once LXMF has started (build
   * spec §3.4), AND this is the reused shape of the `get_identity` command's
   * reply (ws_server.py's `_handle_get_identity` — PUBLIC info only, R2/R5;
   * there is no private-key field anywhere on this type).
   */
  destinationHash?: string;
  identityHash?: string;
  displayName?: string | null;
}

// --------------------------------------------------------------------------
// Phase 2 (LXMF messaging): bridge -> client events (build spec §3.3)
// --------------------------------------------------------------------------

/**
 * An inbound (or reflected outbound) LXMF message. Nullable fields mirror
 * the announce/signal-field precedent above — always present on the wire,
 * just possibly `null`. `fields` is already sanitized by the bridge
 * (rns_manager.py's `_sanitize_lxmf_fields`, R3): attachment fields carry
 * metadata only, never raw bytes.
 */
export interface LxmfMessageEvent extends Envelope {
  type: typeof MESSAGE_TYPE.LXMF_MESSAGE;
  id?: string;
  hash: string;
  from: string;
  to: string;
  title: string | null;
  content: string | null;
  fields: Record<string, unknown>;
  method: LxmfMethod | null;
  signatureValidated: boolean;
  ratcheted: boolean;
  rssi: number | null;
  snr: number | null;
  q: number | null;
}

/**
 * Delivery-state transition for an outbound LXM. The bridge maps LXMF's
 * numeric `LXMessage` state constants to this set in exactly one place
 * (rns_manager.py's `_lxmf_state_to_wire`) — GENERATING/OUTBOUND/SENDING all
 * fold into "sending"; REJECTED/CANCELLED/FAILED (and any future/unknown
 * state) all fold into "failed".
 *
 * Also doubles as the `send_lxmf` command's response (id = the request id,
 * state = "sending") — see ws_server.py's `_handle_send_lxmf`.
 */
export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'failed';

export interface DeliveryStateEvent extends Envelope {
  type: typeof MESSAGE_TYPE.DELIVERY_STATE;
  id?: string;
  hash: string;
  state: DeliveryState;
  method?: LxmfMethod | null;
  attempts?: number | null;
}

// --------------------------------------------------------------------------
// Phase 3 (Sideband FIELD_TELEMETRY decode, build spec §2.A/§2.C, #3960
// WP2/WP4): bridge -> client event.
// --------------------------------------------------------------------------

/**
 * A decoded Sideband `SID_LOCATION` sample carried on a `telemetry` event
 * (build spec §2.A/§3). Mirrors `sideband_telemetry.py`'s `_decode_location`
 * output — always fully populated when present (the bridge drops `location`
 * entirely rather than half-fill it on a decode error, see that module's
 * doc), never partially `null`.
 */
export interface TelemetryLocation {
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
  bearing: number;
  accuracy: number;
}

/** One pinned-subset sensor reading inside a `telemetry` event's `sensors` map (build spec §2.A). */
export interface TelemetrySensorReading {
  value: number;
  unit?: string | null;
}

/**
 * A decoded Sideband `LXMF.FIELD_TELEMETRY` payload (build spec §2.A/§2.C,
 * `protocol.py`'s `telemetry_event()`). `sensors` is ALWAYS present (`{}`
 * when the packet carried no pinned-subset sensor, per `decode_field_telemetry`'s
 * contract) so consumers never need a null check before iterating it;
 * `location` is nullable (absent/undecodable `SID_LOCATION`).
 *
 * `ts` deliberately does NOT reuse `Envelope.ts`'s epoch-ms convention: the
 * bridge's `telemetry_event()` builder overwrites the envelope's own
 * creation-time `ts` with the decoded `SID_TIME` value — a Unix
 * epoch-**seconds** int from Sideband's `int(time.time())`, or `null` when
 * `SID_TIME` wasn't present. Callers that need an epoch-ms value (DB
 * `timestamp`/`positionUpdatedAt` columns) must multiply by 1000 — see
 * `reticulumManager.ts`'s `handleTelemetry`. Not extending `Envelope`
 * directly (its `ts: number` is not assignable from `number | null`) —
 * this type intentionally redeclares every `Envelope` field it needs.
 */
export interface TelemetryMessage {
  v: number;
  type: typeof MESSAGE_TYPE.TELEMETRY;
  id?: string;
  ts: number | null;
  sourceHash: string;
  destinationHash: string;
  sensors: Record<string, TelemetrySensorReading>;
  location: TelemetryLocation | null;
}

// --------------------------------------------------------------------------
// Phase 3 (own mode + RNode radio config/device info): bridge -> client
// responses (build spec §2.C). Wire-contract stubs only — WP4 flesheshes
// out the reticulumBridgeClient.ts / DB / route consumers.
// --------------------------------------------------------------------------

/**
 * Radio-config response (build spec §2.C). All fields are nullable — a
 * field the RNode hasn't reported yet, or the airtime locks when unset,
 * are `null` rather than omitted (same convention as `AnnounceMessage`
 * above). Also doubles as `set_radio_config`'s response, echoing the
 * request `id` — mirrors `DeliveryStateEvent` doubling as `send_lxmf`'s
 * response.
 */
export interface RadioConfigMessage extends Envelope {
  type: typeof MESSAGE_TYPE.RADIO_CONFIG;
  id?: string;
  frequency: number | null;
  bandwidth: number | null;
  spreadingFactor: number | null;
  codingRate: number | null;
  txPower: number | null;
  stAlock: number | null;
  ltAlock: number | null;
  radioState: boolean | null;
}

export interface DeviceInfoCsma {
  cwBand: number | null;
  cwMin: number | null;
  cwMax: number | null;
}

export interface DeviceInfoPhy {
  symbolTimeMs: number | null;
  symbolRate: number | null;
  preambleSymbols: number | null;
  preambleTimeMs: number | null;
  csmaSlotTimeMs: number | null;
  csmaDifsMs: number | null;
}

/** Device-info response (build spec §2.C): firmware version, MCU/platform,
 * chip temperature, CSMA + PHY params — all device-reported, so any field
 * (and every field of `csma`/`phy`) may still be `null` shortly after own
 * mode starts, before the RNode's first periodic STAT frame arrives. */
export interface DeviceInfoMessage extends Envelope {
  type: typeof MESSAGE_TYPE.DEVICE_INFO;
  id?: string;
  firmwareVersion: string | null;
  mcu: number | null;
  platform: number | null;
  chipTemp: number | null;
  csma: DeviceInfoCsma;
  phy: DeviceInfoPhy;
}

// --------------------------------------------------------------------------
// Phase 4 (bridge probe + remote status): bridge -> client responses (build
// spec §2.A/§2.B/§2.C, #3960 WP2/WP3). Both are ALWAYS id-correlated replies
// to `ProbeMessage`/`GetRemoteStatusMessage` above — never pushed
// unsolicited, unlike `PathTableMessage`.
// --------------------------------------------------------------------------

/**
 * rnprobe-style reachability result (build spec §2.B). `ok: false` is a
 * normal outcome (no path / no proof within timeout), not a failure —
 * `PROBE_FAILED` (an `ErrorMessage`) is reserved for something that
 * actually raised. `rttMs`/`hops` are only meaningful when `ok: true`;
 * `error` carries a short human-readable reason for `ok: false`.
 */
export interface ProbeResultMessage extends Envelope {
  type: typeof MESSAGE_TYPE.PROBE_RESULT;
  id?: string;
  destinationHash: string;
  ok: boolean;
  rttMs: number | null;
  hops: number | null;
  error: string | null;
}

/**
 * A single remote-management `/status` interface entry — same shape as
 * {@link InterfaceStatsEntry} (this bridge's own `interface_stats`), just
 * reported by the REMOTE Transport Node instead.
 */
export interface RemoteStatusPayload {
  interfaces: InterfaceStatsEntry[];
  linkCount: number;
}

/**
 * Remote Transport Node's /status + /path query result (build spec §2.C).
 * `status` is the remote's interface-stats-shaped payload; `path` is the
 * remote's own path table (same row shape as {@link PathTableEntry}).
 * `ok: false` covers no-path/link-establishment-failure/timeout (a normal
 * response, not an error envelope) — outright denial (link established,
 * both requests failed) is instead surfaced as the typed
 * `REMOTE_MANAGEMENT_DENIED` `ErrorMessage`.
 */
export interface RemoteStatusMessage extends Envelope {
  type: typeof MESSAGE_TYPE.REMOTE_STATUS;
  id?: string;
  destinationHash: string;
  ok: boolean;
  status: RemoteStatusPayload | null;
  path: PathTableEntry[] | null;
  error: string | null;
}

export type BridgeEventMessage =
  | WelcomeMessage
  | ErrorMessage
  | ReadyMessage
  | AnnounceMessage
  | InterfaceStatsMessage
  | PathTableMessage
  | StatusMessage
  | LxmfMessageEvent
  | DeliveryStateEvent
  | TelemetryMessage
  | RadioConfigMessage
  | DeviceInfoMessage
  | ProbeResultMessage
  | RemoteStatusMessage;
