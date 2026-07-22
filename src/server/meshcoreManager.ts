/**
 * MeshCore Manager - Core connection and communication layer for MeshCore devices
 *
 * This replaces MeshtasticManager for MeshCore protocol support.
 *
 * MeshCore has two firmware types:
 * - Companion: Full-featured, uses the meshcore.js native JS backend
 * - Repeater: Lightweight, uses text CLI commands over direct serial
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { isBogusPosition } from '../utils/nullIsland.js';
import databaseService from '../services/database.js';
import type { MeshcorePathfindingFilterSettings } from '../services/database.js';
import { compileUserRegex } from '../utils/safeRegex.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { compileAutoAckRegex } from './utils/autoAckRegex.js';
import { resolveAutoAckPreSendDelaySeconds, clampPreSendDelaySeconds } from './autoAckDelay.js';
import { scheduleCron, validateCron, type CronJob } from './utils/cronScheduler.js';
import { CronOrIntervalScheduler, type ScheduleMode } from './services/cronOrIntervalScheduler.js';
import { replaceMeshCoreAnnounceTokens } from './utils/meshcoreAnnounceTokens.js';
import { runScript, type RunScriptResult } from './utils/scriptRunner.js';
import { MeshCoreNativeBackend, type BridgeShapedEvent } from './meshcoreNativeBackend.js';
import { resolveMessageScope } from './meshcoreScopeResolve.js';
import {
  MeshCoreVirtualNodeServer,
  type MeshCoreVirtualNodeConfig,
} from './meshcoreVirtualNodeServer.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { notificationService } from './services/notificationService.js';
import { DistanceDeleteScheduler } from './services/distanceDeleteScheduler.js';
import { HeartbeatScheduler } from './services/heartbeatScheduler.js';
import type { DbMeshCorePacket } from '../db/repositories/meshcore.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { decodeMeshCorePacket } from '../utils/meshcorePacketDecode.js';
import { MESHCORE_SECRET_BYTES } from '../utils/meshcoreHelpers.js';
import { parsePathHops, pathHashBytesOf, resolveRouteNames } from '../utils/meshcorePath.js';
import { tryDecodeGroupTextPayload } from './utils/meshcoreGroupEcho.js';

// Dynamic imports for optional serialport dependency
// These are loaded only when MeshCore is enabled to avoid requiring native build tools
let SerialPort: typeof import('serialport').SerialPort | null = null;
let ReadlineParser: typeof import('@serialport/parser-readline').ReadlineParser | null = null;

async function loadSerialPort(): Promise<boolean> {
  if (SerialPort !== null) return true;
  try {
    const serialportModule = await import('serialport');
    const parserModule = await import('@serialport/parser-readline');
    SerialPort = serialportModule.SerialPort;
    ReadlineParser = parserModule.ReadlineParser;
    logger.info('[MeshCore] Serial port support loaded');
    return true;
  } catch (error) {
    logger.warn('[MeshCore] Serial port not available - install serialport package for serial support');
    return false;
  }
}

// Telemetry mode wire values: 0 = never, 1 = device (only added contacts), 2 = always
function parseTelemetryMode(value: unknown): TelemetryMode | undefined {
  if (value === 0) return 'never';
  if (value === 1) return 'device';
  if (value === 2) return 'always';
  return undefined;
}

/**
 * Decode the hop count from the packed MeshCore `pathLen` byte. The wire
 * format packs the hash-size in the top 2 bits and the hop count in the
 * bottom 6 bits. The sentinel value 0xFF means "sent direct" (no flood),
 * which we report as 0 hops. Returns null when no value is available.
 */
function decodePathLenHopCount(pathLen: number | undefined | null): number | null {
  if (pathLen === undefined || pathLen === null) return null;
  if (pathLen === 0xff) return 0;
  return pathLen & 0x3f;
}

/**
 * Render a relay-hash hop list (already-hex strings from LogRxData parsing)
 * into the comma-separated form `replaceAutoAckTokens` expects for
 * {ROUTE}. Returns null when no hops are present.
 */
function formatPathHops(hops: unknown): string | null {
  if (!Array.isArray(hops) || hops.length === 0) return null;
  const filtered = hops.filter((h): h is string => typeof h === 'string' && h.length > 0);
  return filtered.length > 0 ? filtered.join(',') : null;
}

/**
 * Validate-and-extract barrier for a caller-supplied MeshCore public key.
 *
 * Used by code paths that may either target a remote contact (64-char
 * hex pubkey) or fall through to a local CLI variant when no key is
 * supplied. Returning the sanitised value as a NEW variable — rather
 * than just throwing on bad input — gives CodeQL a recognisable
 * sanitiser barrier for the `js/user-controlled-bypass` query: every
 * downstream branch reads `sanitizedKey`, not the original input.
 *
 *  - undefined / null / '' → null  (route to the local variant)
 *  - 64-char hex string    → lowercase normalised form
 *  - anything else         → throws an explanatory Error
 */
function validateMeshCorePubKey(input: string | null | undefined): string | null {
  if (input === undefined || input === null || input === '') return null;
  const normalized = input.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('publicKey must be a 64-char hex string');
  }
  return normalized;
}

/**
 * Decide whether a channel slot reported by the firmware is actually in use.
 * MeshCore Companion firmware doesn't error on unconfigured slots — it
 * returns success with an empty name and a 16-byte all-zero secret. We
 * treat that exact shape as "empty slot" and skip it during DB sync. A slot
 * with EITHER a non-empty name OR a non-zero secret is considered
 * configured (so a user who chose to leave the name blank but generated a
 * real key is preserved).
 */
function isConfiguredMeshCoreChannel(ch: { name: string; secretHex: string }): boolean {
  const nameTrim = (ch.name || '').trim();
  const hasName = nameTrim.length > 0;
  const hasSecret = !!ch.secretHex && /[1-9a-f]/i.test(ch.secretHex);
  return hasName || hasSecret;
}

// MeshCore device types
export enum MeshCoreDeviceType {
  UNKNOWN = 0,
  COMPANION = 1,
  REPEATER = 2,
  ROOM_SERVER = 3,
}

// Human-readable labels for the device types worth surfacing in a
// "new node discovered" notification (UNKNOWN is intentionally omitted so the
// notification simply shows no type rather than "Unknown").
const MESHCORE_DEVICE_TYPE_LABELS: Record<number, string> = {
  [MeshCoreDeviceType.COMPANION]: 'Companion',
  [MeshCoreDeviceType.REPEATER]: 'Repeater',
  [MeshCoreDeviceType.ROOM_SERVER]: 'Room Server',
};

/**
 * Node-type filter bitmasks for active discovery (CTL_TYPE_NODE_DISCOVER_REQ).
 * The wire `filter` byte is a bitmask of `(1 << ADV_TYPE)` — only nodes whose
 * advert type bit is set will respond. ADV_TYPE values (firmware): Chat=1,
 * Repeater=2, Room=3, Sensor=4. See `reference_meshcore_node_discovery_protocol`.
 */
export const MeshCoreDiscoverFilter = {
  /**
   * All node types (Chat | Repeater | Room | Sensor) — the broad "nearby"
   * sweep, matching the mobile app's "Discover Nearby Nodes". In practice
   * only repeaters/room-servers/sensors answer (their firmware self-responds);
   * companion (Chat) devices do not reply to discovery in current MeshCore
   * firmware, so they won't appear here. The Chat bit is still set so they'd
   * be surfaced if a responder ever exists (see MeshCore issue #1027).
   */
  NEARBY: (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4), // 0x1E
  /** Infrastructure only: repeaters + room servers (ADV_TYPE_REPEATER | ADV_TYPE_ROOM). */
  REPEATERS: (1 << 2) | (1 << 3), // 0x0C
  /** Sensors only (ADV_TYPE_SENSOR) — matches the mobile app's "Discover Sensors". */
  SENSORS: 1 << 4, // 0x10
} as const;

export type MeshCoreDiscoverMode = 'nearby' | 'repeaters' | 'sensors';

/** Result of a share-contact request, carrying an actionable reason on failure. */
export interface ShareContactResult {
  ok: boolean;
  error?: string;
}

/**
 * Result of {@link MeshCoreManager.syncDeviceTime}. `reason` distinguishes the
 * pre-flight guard failures (which the route reports as a 409) from an actual
 * device/command failure (`command-failed`, reported as a 502 with `error`).
 */
export type SyncDeviceTimeResult =
  | { ok: true }
  | { ok: false; reason: 'not-companion' | 'disconnected' | 'command-failed'; error?: string };

// Connection types
export enum ConnectionType {
  SERIAL = 'serial',
  TCP = 'tcp',
}

/**
 * Operator-defined auto-responder trigger, persisted per source as a
 * JSON array at the `meshcoreAutoResponderTriggers` setting key. Fires
 * from the manager's incoming-message handler — one regex per row, one
 * text response per match. Intentionally narrower than the Meshtastic
 * AutoResponder (no HTTP/script/traceroute response types) so v1 can
 * land without dragging the script-runner sandbox into the MeshCore
 * surface.
 */
/** Scope/region selection shared by every MeshCore automation that sends a
 *  message (auto-responder, auto-ack, auto-announce, timer triggers) — #3833. */
export type MeshCoreAutomationScopeMode = 'inherit' | 'trigger' | 'unscoped' | 'named';
export interface MeshCoreAutomationScopeConfig {
  /**
   * Region a sent message floods to (the only per-message propagation lever in
   * MeshCore — repeaters only forward a scoped flood for regions they carry).
   * `inherit` (default) = channel scope → source default; `trigger` = the
   * triggering message's own scope; `unscoped` = flood with no region;
   * `named` = the region in `scopeName`.
   */
  scopeMode?: MeshCoreAutomationScopeMode;
  /** Region name when `scopeMode === 'named'`. */
  scopeName?: string;
}

export interface MeshCoreAutoResponderTrigger extends MeshCoreAutomationScopeConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** Case-insensitive regex matched against incoming message text. */
  pattern: string;
  /**
   * Action to take on match. `text` sends `response` rendered against
   * announce tokens; `script` runs `scriptPath` and sends each entry of
   * the script's `wouldSendMessages` output.
   */
  responseType?: 'text' | 'script';
  /** Response template (only consulted for responseType === 'text'). */
  response: string;
  /** Script filename inside /data/scripts (responseType === 'script'). */
  scriptPath?: string;
  /** Whitespace-separated argv passed to the script. Token-expanded. */
  scriptArgs?: string;
  /** Channel indexes the trigger should listen on. Omit/empty = none. */
  channels: number[];
  /** Listen on DMs in addition to channels. */
  listenDMs: boolean;
  /** Always answer as a DM, even when the trigger came from a channel. */
  replyAsDM: boolean;
  /** Per-sender cooldown in seconds. 0 disables. */
  cooldownSeconds: number;
  /**
   * Delay (seconds) to wait after a match before sending the reply, so a
   * relaying repeater can finish its own TX first (#3953, mirrors
   * Auto-Acknowledge's pre-send delay). 0/absent = send immediately; clamped
   * to 0–120. Applies once per fire, to both text and script responses.
   */
  preSendDelaySeconds?: number;
}

/**
 * Operator-defined timer trigger persisted (per source) as a JSON array
 * at the `meshcoreTimerTriggers` setting key. One scheduler entry per
 * row; the runner reads the row by id at fire time so a freshly-saved
 * template applies on the next tick.
 */
export interface MeshCoreTimerTrigger extends MeshCoreAutomationScopeConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** `cron` uses cronExpression; `interval` uses intervalMinutes. */
  scheduleType: 'cron' | 'interval';
  cronExpression?: string;
  intervalMinutes?: number;
  /**
   * `text` sends `response` rendered against announce tokens;
   * `advert` ignores `response`;
   * `script` runs `scriptPath` and routes wouldSendMessages to
   * `destination` (channel or dm).
   */
  responseType: 'text' | 'advert' | 'script';
  response?: string;
  /** Script filename inside /data/scripts (responseType === 'script'). */
  scriptPath?: string;
  /** Whitespace-separated argv passed to the script. Token-expanded. */
  scriptArgs?: string;
  /** Where to send a `text` / `script` response. `channel` requires `channelIndex`; `dm` requires `contactPublicKey`. */
  destination?: 'channel' | 'dm';
  channelIndex?: number;
  contactPublicKey?: string;
  // Last-run telemetry. Written by `runTimerTrigger` so the UI can show
  // "ran 5m ago" without re-querying the device.
  lastRun?: number;
  lastResult?: 'success' | 'error';
  lastError?: string;
}

export interface MeshCoreConfig {
  connectionType: ConnectionType;
  serialPort?: string;
  tcpHost?: string;
  tcpPort?: number;
  baudRate?: number;
  firmwareType?: 'companion' | 'repeater';

  // Heartbeat / auto-reconnect (native-backend only; default off).
  // See docs/internal/meshcore-design/meshcore-heartbeat-proposal.md.
  heartbeatIntervalSeconds?: number;   // 0 = disabled. v1 native default: 0.
  heartbeatTimeoutMs?: number;         // default 5000.
  heartbeatMaxFailures?: number;       // default 3.
  reconnectInitialDelayMs?: number;    // default 1000.
  reconnectMaxDelayMs?: number;        // default 60000.
  reconnectMaxAttempts?: number;       // default 0 (forever).

  // Virtual Node server (opt-in). Exposes this MeshCore node over TCP so the
  // MeshCore mobile app can connect through MeshMonitor over WiFi (issue #3535).
  // See docs/internal/dev-notes/MESHCORE_VIRTUAL_NODE_DESIGN.md.
  virtualNode?: MeshCoreVirtualNodeConfig;
}

export type MeshCoreConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface MeshCoreHeartbeatStatus {
  state: MeshCoreConnectionState;
  consecutiveFailures: number;
  lastSuccessfulProbeAt: number | null;
  nextReconnectAt: number | null;
  reconnectAttempts: number;
}

export type TelemetryMode = 'always' | 'device' | 'never';

export interface MeshCoreNode {
  publicKey: string;
  name: string;
  advType: MeshCoreDeviceType;
  txPower?: number;
  maxTxPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
  lastHeard?: number;
  rssi?: number;
  snr?: number;
  batteryMv?: number;
  uptimeSecs?: number;
  latitude?: number;
  longitude?: number;
  advLocPolicy?: number;
  /** Add contacts only on explicit request (1) vs automatically (0). From SelfInfo. */
  manualAddContacts?: number;
  /**
   * Server-side favorite flag (migration 094). Stored locally only — never
   * pushed to the device. Favorited nodes pin to the top of the node list.
   */
  isFavorite?: boolean;
  telemetryModeBase?: TelemetryMode;
  telemetryModeLoc?: TelemetryMode;
  telemetryModeEnv?: TelemetryMode;
  /** From DeviceQuery — populated by the telemetry poller. In-memory only;
   *  re-derived from the device on each poll cycle (no DB persistence). */
  firmwareVer?: number;
  firmwareBuild?: string;
  model?: string;
  ver?: string;
}

export interface MeshCoreContact {
  publicKey: string;
  advName?: string;
  name?: string;
  lastSeen?: number;
  rssi?: number;
  snr?: number;
  advType?: MeshCoreDeviceType;
  latitude?: number;
  longitude?: number;
  lastAdvert?: number;
  /**
   * Hop count of the cached forwarding route to this contact. `null` /
   * undefined means the firmware's OUT_PATH_UNKNOWN sentinel is set —
   * the next send will be flooded.
   */
  pathLen?: number | null;
  /**
   * Comma-separated hex chain of hop hashes for the cached forwarding
   * route (e.g. "a3,7f,02"). `null` / undefined means OUT_PATH_UNKNOWN.
   */
  outPath?: string | null;
}

/** Sentinel RSSI (dBm) below which a configured `rssiMin` threshold is a no-op. */
export const MC_PF_RSSI_FLOOR = -200;
/** Sentinel SNR (dB) below which a configured `snrMin` threshold is a no-op. */
export const MC_PF_SNR_FLOOR = -100;

/**
 * Pure filter for Auto-Pathfinding target selection (#4024). AND pre-filters
 * (last-heard, hop range, signal) narrow the pool first; OR-union identity
 * filters (contact allowlist, name regex) then select within that pool — a
 * contact passes the OR stage if it matches ANY enabled OR sub-filter. This
 * mirrors `getNodeNeedingTracerouteAsync` (see
 * docs/internal/dev-notes/PATHFINDING_FILTER_SPEC.md §0/§3.1).
 *
 * Exported at module scope (no manager instance needed) so it is unit
 * testable without device IO.
 *
 * Unit note (verified against this file's contact-write sites, NOT as
 * asserted by the original spec draft): `lastSeen` is epoch
 * **milliseconds** — every write site sets it via `Date.now()` or an
 * advert-derived `advertMs` (`refreshContacts()` ~L2584-2597). `lastAdvert`
 * is epoch **seconds**, taken verbatim from the firmware's `last_advert`
 * field. The two are normalized to a common millisecond cutoff below before
 * comparison.
 */
export function filterPathfindingContacts(
  contacts: MeshCoreContact[],
  cfg: MeshcorePathfindingFilterSettings,
  nowMs: number = Date.now(),
): MeshCoreContact[] {
  if (!cfg.enabled) return contacts;

  // ---- AND pre-filters ----
  let pool = contacts;
  if (cfg.lastHeardEnabled) {
    const cutoffMs = nowMs - cfg.lastHeardHours * 3600 * 1000;
    pool = pool.filter(c => {
      // Prefer lastSeen (already ms); fall back to lastAdvert (seconds -> ms).
      const seenMs = c.lastSeen != null
        ? c.lastSeen
        : (c.lastAdvert != null ? c.lastAdvert * 1000 : null);
      return seenMs != null && seenMs >= cutoffMs;
    });
  }
  if (cfg.hopsEnabled) {
    pool = pool.filter(c => {
      if (c.pathLen == null) return false; // unknown route excluded when hop filter on
      return c.pathLen >= cfg.hopsMin && c.pathLen <= cfg.hopsMax;
    });
  }
  if (cfg.signalEnabled) {
    pool = pool.filter(c => {
      const passRssi = cfg.rssiMin <= MC_PF_RSSI_FLOOR || (c.rssi != null && c.rssi >= cfg.rssiMin);
      const passSnr = cfg.snrMin <= MC_PF_SNR_FLOOR || (c.snr != null && c.snr >= cfg.snrMin);
      return passRssi && passSnr;
    });
  }

  // ---- OR-union identity filters ----
  let regex: RegExp | null = null;
  if (cfg.regexEnabled && cfg.nameRegex && cfg.nameRegex !== '.*') {
    try { regex = compileUserRegex(cfg.nameRegex, 'i'); } catch { regex = null; }
  }
  const allow = new Set(cfg.targetKeys);
  const hasAnyOr =
    (cfg.contactsEnabled && allow.size > 0) ||
    (cfg.regexEnabled && (regex !== null || cfg.nameRegex === '.*'));
  if (!hasAnyOr) return pool; // AND-only ⇒ whole pool passes

  return pool.filter(c => {
    if (cfg.contactsEnabled && allow.has(c.publicKey)) return true;
    if (cfg.regexEnabled) {
      const name = c.advName || c.name || '';
      if (cfg.nameRegex === '.*') return true;
      if (regex && regex.test(name)) return true;
    }
    return false;
  });
}

/**
 * Result of a MeshCore send. `ok` mirrors the legacy boolean return of
 * `sendMessage`; for a DM the firmware also assigns an `expectedAckCrc` (the
 * value a later SendConfirmed push will carry) and an `estTimeout` hint, both
 * surfaced via {@link MeshCoreManager.sendMessageWithResult} for the Virtual
 * Node ack bridge (#3869). Channel sends are unacked, so these are undefined.
 */
export interface MeshCoreSendResult {
  ok: boolean;
  expectedAckCrc?: number;
  estTimeout?: number;
}

export interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  /** Sender display name. For channel messages, parsed from the "Name: " prefix
   *  MeshCore devices add to the body (channel packets carry no per-sender identity
   *  on the wire). For DMs and room posts, taken from the resolved contact. */
  fromName?: string;
  toPublicKey?: string; // null for broadcast
  text: string;
  timestamp: number;
  rssi?: number;
  snr?: number;
  /**
   * Owning source. Set by the MeshCoreManager that produced the message;
   * persisted into meshcore_messages.sourceId so the row can be filtered
   * per source.
   */
  sourceId?: string;
  /** 'text' (default, DMs + channel) or 'room_post' (room server posts). */
  messageType?: string;
  /** 4-byte CRC from RESP_CODE_SENT — correlates with PUSH_CODE_SEND_CONFIRMED
   *  to confirm delivery. Only set on outgoing DMs (not channels). */
  expectedAckCrc?: number;
  /** Estimated timeout in ms before the message should be considered failed.
   *  Only set on outgoing DMs. */
  estTimeout?: number;
  /** Repeaters that re-flooded this (outgoing channel) message, inferred by
   *  self-echo correlation (#3700). Best-effort; only set on outgoing channel
   *  messages that were heard re-flooded. `name` is null when the relay hash
   *  couldn't be resolved to a known contact. */
  heardBy?: Array<{ hash: string; name?: string | null; snr?: number | null }>;
  /** Hop count for a received message (from path_len); null = direct / unknown.
   *  Room messages carry no path, so this stays null for them. (#3742) */
  hopCount?: number | null;
  /** Raw packed `path_len` byte as reported by the device for a received message
   *  (0xff = direct). Preserved verbatim so the Virtual Node bridge can forward
   *  the real hop count to a companion instead of always "direct" (#3871). */
  pathLen?: number | null;
  /** Relay-hash chain the message traveled, comma-separated (e.g. "a3,7f,02");
   *  null when no path was reported. (#3742) */
  routePath?: string | null;
  /** Scope/region the message was sent with (#3742 Phase 2). `scopeCode` is the
   *  packet's transport_code_1: 0 = sent unscoped, null = no scope info. */
  scopeCode?: number | null;
  /** Region name resolved from `scopeCode` against this source's known scopes;
   *  null = unscoped, or scoped-but-unknown (then the UI shows `#<code-hex>`). */
  scopeName?: string | null;
}

export interface MeshCoreStatus {
  batteryMv?: number;
  uptimeSecs?: number;

  // Repeater operational stats exposed by SendStatusReq → StatusResponse.
  // Always populated when the remote node is a Repeater or Room Server;
  // typically absent when the target is another Companion since Companion
  // firmware doesn't ship these counters.
  queueLen?: number;
  noiseFloor?: number;
  lastRssi?: number;
  lastSnr?: number;
  packetsRecv?: number;
  packetsSent?: number;
  airTimeSecs?: number;
  sentFlood?: number;
  sentDirect?: number;
  recvFlood?: number;
  recvDirect?: number;
  errors?: number;
  directDups?: number;
  floodDups?: number;

  // Companion-only fields (radio config etc.). Kept on the interface for
  // backwards compatibility with callers that ask Companion targets for status.
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
}

/**
 * A single channel slot on a MeshCore device. The wire model is just
 * { channelIdx, name, secret(16 bytes) } — see meshcore.js connection.js:605.
 * The secret travels as a hex string in our API for human readability;
 * we re-encode to base64 when mirroring into the shared `channels.psk` column.
 */
export interface MeshCoreChannel {
  channelIdx: number;
  name: string;
  /** 32-char lowercase hex (16 bytes). Empty string if the firmware reports an empty slot. */
  secretHex: string;
}

/**
 * Local-node stats fetched over the companion-protocol link. These never
 * touch the air — they read counters/state from the directly-connected node.
 */
export interface MeshCoreStatsCore {
  batteryMv?: number;
  uptimeSecs?: number;
  errors?: number;
  queueLen?: number;
}

export interface MeshCoreStatsRadio {
  noiseFloor?: number;
  lastRssi?: number;
  lastSnr?: number;
  txAirSecs?: number;
  rxAirSecs?: number;
}

export interface MeshCoreStatsPackets {
  recv?: number;
  sent?: number;
  floodTx?: number;
  directTx?: number;
  floodRx?: number;
  directRx?: number;
  recvErrors?: number | null;
}

/**
 * One LPP telemetry record decoded from a remote `req_telemetry_sync`
 * response. `type` is the raw Cayenne-LPP type id (e.g. 116=voltage,
 * 103=temperature, 104=humidity, 115=barometer, 121=altitude, 136=gps).
 * `value` is whatever the encoder produced — a scalar for single-value
 * types, a dict for multi-axis types like gps.
 */
export interface MeshCoreTelemetryRecord {
  channel: number;
  type: number | null;
  value: number | string | Record<string, number> | number[] | null;
}

export interface MeshCoreDeviceInfo {
  firmwareVer?: number;
  firmwareBuild?: string;
  model?: string;
  ver?: string;
  maxContacts?: number;
  maxChannels?: number;
  blePin?: number;
  repeat?: boolean;
  pathHashMode?: number;
}

// Bridge-shaped command response. The wire vocabulary ("bridge") is preserved
// from the original Python-bridge era so the manager's command surface didn't
// have to change when the native JS backend took over.
interface BridgeResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Result of a successful remote-node login (#4094). Firmware >= 1.16 reports the
 * remote's admin permission and firmware version level in the LoginSuccess
 * frame; older firmware omits them (fields left `undefined`). A `null` return
 * from `loginToNode` means the login itself did not succeed.
 */
export interface MeshCoreLoginResult {
  /** Whether the remote node granted admin access. Undefined on legacy firmware. */
  isAdmin?: boolean;
  /** Remote node's FIRMWARE_VER_LEVEL; gates version-locked features in the app. */
  firmwareVerLevel?: number;
  /** Remote node's server timestamp echoed in the login response. */
  serverTimestamp?: number;
  /** Granular ACL-permissions byte (firmware v7+). */
  aclPermissions?: number;
}

/**
 * MeshCore Manager class
 * Handles connection and communication with MeshCore devices
 */
class MeshCoreManager extends EventEmitter implements ISourceManager {
  /**
   * The owning source this manager belongs to. Every write the manager
   * performs into `meshcore_nodes` / `meshcore_messages` is stamped with
   * this id. Required since slice 1 of the multi-source MeshCore refactor
   * (migration 056).
   */
  public readonly sourceId: string;

  /** Human-readable name for aggregate status; defaults to sourceId when absent. */
  private sourceName: string;

  /** Config stored by configure() so parameterless start() can connect. */
  private pendingConfig: MeshCoreConfig | null = null;

  private config: MeshCoreConfig | null = null;
  private connected: boolean = false;
  private deviceType: MeshCoreDeviceType = MeshCoreDeviceType.UNKNOWN;
  // Public keys we've already fired a "new node discovered" notification for
  // this session. Guards against re-notifying when a brand-new contact
  // re-advertises before the in-memory contact store reflects it.
  private notifiedNewNodes: Set<string> = new Set();

  // Repeater: direct serial
  private serialPort: InstanceType<typeof import('serialport').SerialPort> | null = null;
  private parser: InstanceType<typeof import('@serialport/parser-readline').ReadlineParser> | null = null;

  // Companion: native JS backend (meshcore.js). sendBridgeCommand delegates here.
  private nativeBackend: MeshCoreNativeBackend | null = null;
  private virtualNodeServer: MeshCoreVirtualNodeServer | null = null;

  // Heartbeat / auto-reconnect state (native-backend only).
  private connectionState: MeshCoreConnectionState = 'disconnected';
  private heartbeatScheduler: HeartbeatScheduler | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatConsecutiveFailures: number = 0;

  /** Coalescing state for `contact_path_updated` pushes. Multiple pushes
   *  within {@link PATH_REFRESH_DEBOUNCE_MS} collapse to a single
   *  refreshContacts() call so a chatty contact churning its route doesn't
   *  thunder the device. The set tracks which pubkeys had pushes during
   *  the window — purely for logging; the refresh fetches everything. */
  private pathRefreshTimer: NodeJS.Timeout | null = null;
  private pathRefreshPendingKeys: Set<string> = new Set();
  /**
   * Keeps the local Companion node's RTC honest. MeshCore stamps every
   * outbound frame (adverts, DMs, and crucially remote-admin `clock sync`
   * commands) with the local node's own clock; if that clock is never set it
   * drifts and poisons those timestamps (issue #3954). We push the server's
   * wall clock on connect and then periodically for the life of the session.
   */
  private deviceTimeSyncTimer: NodeJS.Timeout | null = null;
  private static readonly DEVICE_TIME_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
  private heartbeatLastSuccessAt: number | null = null;
  private reconnectAttempts: number = 0;
  private nextReconnectAt: number | null = null;
  private shouldReconnect: boolean = false;
  /**
   * True while an *intentional* teardown is in progress (disconnect() or
   * teardownTransportOnly()). Closing the native backend makes meshcore.js emit
   * its own 'disconnected' event; this flag lets the manager's handler tell an
   * operator/heartbeat-driven teardown apart from an unexpected socket drop so
   * it doesn't double-tear-down or fight an in-flight reconnect. Reset in
   * connect() once a fresh attempt begins.
   */
  private intentionalTeardown: boolean = false;

  // MeshCore region/scope (#3667). The device holds a SINGLE global flood
  // scope, asserted via the `set_flood_scope` bridge command before a send.
  // `activeFloodScope` caches the region name currently set on the device
  // (`null` = unscoped, `undefined` = unknown/not-yet-asserted) so we skip the
  // extra round-trip when the next send needs the same scope. `sendScopeLock`
  // serialises the set-scope→send pair per source: because the scope is global
  // and stateful, two concurrent sends with different scopes must not interleave.
  private activeFloodScope: string | null | undefined = undefined;
  private sendScopeLock: Promise<unknown> = Promise.resolve();
  // Known scope/region names for this source (#3742 Phase 2): the candidate set
  // a received message's transport code is matched against to resolve its scope
  // name. Sourced from per-channel scopes + the source default scope. Cached so
  // the synchronous inbound-message path resolves with no DB round-trip;
  // refreshed on connect and whenever a scope changes.
  private knownScopes: Set<string> = new Set();

  // Shared state
  private localNode: MeshCoreNode | null = null;
  private contacts: Map<string, MeshCoreContact> = new Map();
  /**
   * Recently-removed contacts (lowercased publicKey → tombstone-expiry ms).
   * When a contact still lives on the companion's saved-contact list, an
   * advert-triggered or reconnect `get_contacts` re-sync would otherwise
   * re-insert the row we just deleted, so a "Remove" appears to do nothing
   * (#3878). While a key is tombstoned we skip re-adding it on sync; the entry
   * self-expires after TOMBSTONE_TTL_MS so a genuinely re-added contact can
   * come back, and is cleared immediately if the user re-adds it.
   */
  private removedContacts: Map<string, number> = new Map();
  private static readonly TOMBSTONE_TTL_MS = 60 * 60 * 1000; // 1 hour
  /**
   * Collector for an in-flight `discoverNodes()` burst. NODE_DISCOVER_RESP
   * pushes arrive asynchronously over a few seconds; `node_discovered` bridge
   * events feed this so the awaiting call can report how many unique nodes
   * responded and how many were not previously known. Null when idle.
   */
  private activeDiscovery: { seen: Set<string>; returned: number; newCount: number } | null = null;
  private messages: MeshCoreMessage[] = [];
  private pendingCommands: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();
  private commandId: number = 0;

  /**
   * Pending outgoing channel sends awaiting self-echo correlation (#3700,
   * #3979). Keyed by message id. Each entry remembers the channel index, send
   * time, and the exact `text` we sent, so an inbound GRP_TXT OTA packet
   * arriving within HEARD_WINDOW_MS can be attributed to the SPECIFIC send whose
   * decrypted plaintext matches — not merely the most recent send. Pruned lazily
   * on each inbound packet and on each new send.
   */
  private pendingChannelSends: Map<string, { channelIdx: number; sentAt: number; text: string }> = new Map();

  /**
   * De-dup guard so a single echoed channel packet is attributed at most ONCE
   * (#3979). Keyed by the GRP_TXT payload hex (channel_hash + MAC + ciphertext)
   * — the MeshCore dedup identity, invariant across re-floods — mapped to the
   * time it was attributed, so entries can be pruned by the heard window.
   */
  private attributedChannelEchoes: Map<string, number> = new Map();

  /**
   * In-flight DM sends awaiting a `SendConfirmed` ack, keyed by the *current*
   * attempt's firmware `expectedAckCrc` (#3977). If the ack doesn't arrive
   * within `estTimeout` (+margin), the send is retried following the official
   * MeshCore app's cadence (MeshCore FAQ §5.3): resend on the current cached
   * path {@link DM_SAME_PATH_RETRIES} times, then reset the path and resend via
   * flood {@link DM_FLOOD_RETRIES} time(s); learn the new path from whichever
   * ACK arrives (firmware auto-emits `contact_path_updated`, persisted by the
   * existing handler). A single logical send is represented by exactly one
   * entry at a time — the map key is re-pointed to each new attempt's CRC and
   * the original message row is *updated* (not duplicated) so the UI shows one
   * bubble that ends `delivered` on any ACK or `failed` only after all attempts
   * are exhausted.
   */
  private pendingDmRetries: Map<
    number,
    {
      messageId: string;
      toPublicKey: string;
      text: string;
      /** Remaining same-path (current cached route) resends. */
      samePathRetriesLeft: number;
      /** Remaining flood (reset-path) resends after same-path exhausts. */
      floodRetriesLeft: number;
      timer: NodeJS.Timeout;
    }
  > = new Map();

  /**
   * In-flight AUTOMATED channel sends awaiting a heard-repeater signal (#3979,
   * Part 2). Keyed by the outgoing message id. A channel/broadcast send is an
   * unacked fire-and-forget flood, so we can't tell delivery from a firmware
   * ACK; instead we lean on the Part 1 echo-attribution (#3987): if NO repeater
   * has been heard re-flooding our packet within {@link CHANNEL_RETRY_WINDOW_MS},
   * the message likely reached no one, so we resend it exactly ONCE.
   *
   * This machine is armed ONLY for automated senders (Automation Engine
   * `action.sendMessage`, Auto-Acknowledge, auto-responder, auto-announce, timer
   * triggers) that pass `autoRetryOnMiss=true` AND only when the global
   * {@link meshcoreChannelRetryEnabled} opt-in setting is on. User-initiated
   * sends never arm it. It is DISTINCT from and non-colliding with the DM
   * ack-retry ({@link pendingDmRetries}): the DM path has `toPublicKey` set and
   * keys on the firmware ACK CRC; the channel path has `channelIdx` set (no
   * `toPublicKey`) and keys on the echo-heard signal — mutually exclusive
   * branches of {@link performScopedSend}. Cleared in bulk on disconnect.
   */
  private pendingChannelRetries: Map<
    string,
    {
      text: string;
      channelIdx: number;
      scopeOverride: string | null | undefined;
      /** Remaining resends. Starts at 1 (one-shot); the resend itself never re-arms. */
      retriesLeft: number;
      timer: NodeJS.Timeout;
    }
  > = new Map();

  // Message limit to prevent unbounded growth
  private static readonly MAX_MESSAGES = 1000;

  /**
   * How long after an automated channel send we wait for a heard-repeater
   * signal before treating the send as a likely miss and resending once
   * (#3979). Matches {@link HEARD_WINDOW_MS} — the echo-attribution window —
   * so the heard-repeater set is fully populated for genuine echoes by the
   * time the timer reads it.
   */
  private static readonly CHANNEL_RETRY_WINDOW_MS = 30_000;

  /**
   * MeshCore GRP_TXT (channel/broadcast text) payload type (0x05). Inbound OTA
   * packets of this type are self-echo candidates for outgoing channel sends.
   */
  private static readonly PAYLOAD_TYPE_GRP_TXT = 0x05;

  /**
   * How long after an outgoing channel send we will attribute an inbound
   * GRP_TXT OTA packet to it as a self-echo (#3700). Bounded so we never
   * credit unrelated later channel chatter. Mirrors the bufferedAt-style
   * staleness window used elsewhere (#3589).
   */
  private static readonly HEARD_WINDOW_MS = 30_000;

  /** Window over which we coalesce `contact_path_updated` pushes into a
   *  single device-side refreshContacts() call. Long enough to absorb a
   *  flurry from one chatty contact churning its route, short enough that
   *  the UI feels live. */
  private static readonly PATH_REFRESH_DEBOUNCE_MS = 1500;

  /**
   * Wall-clock timestamp (ms) of the most recent outbound RF operation
   * for this source. Today only the remote-telemetry scheduler stamps
   * it (after `requestRemoteTelemetry`), but it's intended as the
   * shared throttling primitive for any future scheduled mesh-op on
   * this manager (auto-traceroute, periodic adverts, status sweeps,
   * …). Cross-source: only this manager's value — different sources
   * are different radios.
   */
  private lastMeshTxAt: number = 0;

  // Auto-pathfinding scheduler state
  private autoPathfindingTimer: NodeJS.Timeout | null = null;
  private autoPathfindingJitterTimeout: NodeJS.Timeout | null = null;
  private autoPathfindingLastRunAt: number = 0;

  // Auto-announce scheduler state. announceScheduler holds the recurring
  // trigger (cron or interval) via the shared CronOrIntervalScheduler
  // primitive. lastRunAt is exposed to the UI so operators can confirm the
  // scheduler is actually firing. autoAnnounceAdvertTimer is separate: it is
  // the one-shot delay for the follow-up advert burst and is NOT owned by
  // the scheduler primitive.
  private announceScheduler: CronOrIntervalScheduler | null = null;
  private autoAnnounceLastRunAt: number = 0;
  private autoAnnounceAdvertTimer: NodeJS.Timeout | null = null;

  // Timer-trigger scheduler state. Each configured timer trigger gets
  // either a CronJob (cron mode) or a setInterval handle (interval
  // mode); they're parallel because the UI lets the operator switch
  // modes per-trigger. lastRun is persisted via settings so it survives
  // a process restart and the UI can show "ran 5m ago" reliably.
  private timerTriggerCrons: Map<string, CronJob> = new Map();
  private timerTriggerIntervals: Map<string, NodeJS.Timeout> = new Map();

  // Per-trigger × per-sender cooldown for the auto-responder. Key is
  // `${triggerId}:${pubkeyPrefix}` so two triggers can each answer the
  // same chatty sender without stomping each other's cooldown.
  private autoResponderCooldowns: Map<string, number> = new Map();

  // Auto-acknowledge per-sender cooldown (keyed by sender pubkey prefix).
  // Records the last time we acknowledged a sender so a chatty contact
  // doesn't burn airtime if they spam the trigger phrase.
  private autoAckCooldowns: Map<string, number> = new Map();

  private readonly distanceDeleteScheduler: DistanceDeleteScheduler;

  constructor(sourceId: string, sourceName?: string) {
    super();
    if (!sourceId) {
      throw new Error('MeshCoreManager requires a sourceId');
    }
    this.sourceId = sourceId;
    this.sourceName = sourceName ?? sourceId;
    this.distanceDeleteScheduler = new DistanceDeleteScheduler(sourceId);
    logger.info(`[MeshCore:${sourceId}] Manager initialized`);
  }

  /** ISourceManager: source type discriminant — drives type guards in sourceManagerTypes.ts. */
  get sourceType(): 'meshcore' {
    return 'meshcore';
  }

  /**
   * Store the connection config so parameterless start() can call connect().
   * Call this before addManager() (which invokes start() automatically).
   */
  configure(cfg: MeshCoreConfig): void {
    this.pendingConfig = cfg;
  }

  /**
   * Update the stored display name used by aggregate getAllStatuses() calls.
   * Call from the source-rename handler so getStatus() stays fresh without
   * requiring a full manager restart.
   */
  setSourceName(name: string): void {
    this.sourceName = name;
  }

  /**
   * ISourceManager: parameterless start — delegates to connect() using the
   * config stored by configure(). If no config has been stored, logs a warning
   * and returns without connecting. Swallows connect()'s boolean; logs result.
   */
  async start(): Promise<void> {
    if (!this.pendingConfig) {
      logger.warn(`[MeshCore:${this.sourceId} (${this.sourceName})] start() called but no config stored — call configure() first`);
      return;
    }
    const ok = await this.connect(this.pendingConfig);
    if (ok) {
      logger.info(`[MeshCore:${this.sourceId} (${this.sourceName})] Auto-connected`);
    } else {
      logger.warn(`[MeshCore:${this.sourceId} (${this.sourceName})] Auto-connect failed`);
    }
  }

  /**
   * ISourceManager: parameterless stop — delegates to disconnect().
   * Does NOT remove this manager from any registry; that is the registry's
   * responsibility. This preserves the "manual disconnect keeps manager
   * registered" semantics required by the /disconnect route.
   */
  async stop(): Promise<void> {
    await this.disconnect();
  }

  /** Start this source's per-source auto-delete-by-distance scheduler (#3901). */
  async startDistanceDeleteScheduler(): Promise<void> {
    await this.distanceDeleteScheduler.start();
  }

  /** Stop this source's per-source auto-delete-by-distance scheduler (#3901). */
  stopDistanceDeleteScheduler(): void {
    this.distanceDeleteScheduler.stop();
  }

  /**
   * Connect to a MeshCore device
   */
  async connect(config: MeshCoreConfig): Promise<boolean> {
    if (this.connected) {
      logger.warn('[MeshCore] Already connected, disconnecting first');
      await this.disconnect();
    }

    this.config = config;
    this.pendingConfig = config; // keep staging field in sync with direct connect() calls

    // Pre-seed in-memory message cache from DB so history survives restarts.
    // Reset the array first to avoid duplicates on reconnect within the same
    // process (the previous session's messages are already in DB).
    this.messages = [];
    try {
      const stored = await databaseService.meshcore.getRecentMessages(
        MeshCoreManager.MAX_MESSAGES,
        this.sourceId,
      );
      // DB returns newest-first; reverse to oldest-first for the in-memory array.
      this.messages = stored.reverse().map(dbMsg => ({
        id: dbMsg.id,
        fromPublicKey: dbMsg.fromPublicKey,
        fromName: dbMsg.fromName ?? undefined,
        toPublicKey: dbMsg.toPublicKey ?? undefined,
        text: dbMsg.text,
        timestamp: dbMsg.timestamp,
        rssi: dbMsg.rssi ?? undefined,
        snr: dbMsg.snr ?? undefined,
        sourceId: dbMsg.sourceId ?? undefined,
        hopCount: dbMsg.hopCount ?? null,
        routePath: dbMsg.routePath ?? null,
        scopeCode: dbMsg.scopeCode ?? null,
        scopeName: dbMsg.scopeName ?? null,
      }));
      // Enrich with heardBy so relay info survives server restarts (#3813).
      if (this.messages.length > 0) {
        const heardByMap = await databaseService.meshcore.getHeardRepeatersForMessages(
          this.messages.map(m => m.id),
          this.sourceId,
        );
        this.messages = this.messages.map(m => {
          const heard = heardByMap[m.id];
          return heard && heard.length > 0
            ? { ...m, heardBy: heard.map(r => ({ hash: r.repeaterHash, name: r.repeaterName, snr: r.snr })) }
            : m;
        });
      }
    } catch (loadErr) {
      logger.warn(`[MeshCore:${this.sourceId}] Failed to load messages from DB: ${(loadErr as Error).message}`);
      this.messages = [];
    }

    // Prime the known-scope cache so the first received message can resolve its
    // scope name without a DB round-trip (#3742 Phase 2).
    await this.refreshKnownScopes();

    logger.info(`[MeshCore] Connecting via ${this.config.connectionType}...`);
    this.connectionState = 'connecting';
    // A fresh attempt begins: clear any leftover teardown guard so the new
    // backend's socket-drop events are treated as real (and so a late event
    // from the previous backend, already nulled, stays suppressed).
    this.intentionalTeardown = false;

    try {
      if (this.config.connectionType === ConnectionType.SERIAL && this.config.firmwareType === 'repeater') {
        // Explicit Repeater mode: use direct serial connection
        const serialAvailable = await loadSerialPort();
        if (!serialAvailable) {
          throw new Error('Serial port support not available — install serialport package for Repeater mode');
        }
        await this.connectSerialDirect();
        this.deviceType = MeshCoreDeviceType.REPEATER;
        logger.info('[MeshCore] Using Repeater mode (direct serial)');
      } else {
        // Companion (default) or TCP: use the native JS backend (meshcore.js).
        await this.startNativeBackend();
        this.deviceType = MeshCoreDeviceType.COMPANION;
      }

      // Get initial info
      await this.refreshLocalNode();
      // Pre-seed the in-memory contact list from the DB BEFORE the live
      // get_contacts. On a flaky/slow companion the live refresh can return
      // empty or time out (and refreshContacts deliberately won't wipe on
      // empty), which previously left getContacts() — the source for the DM
      // contact list — nearly empty even though the node list (DB-backed) was
      // full. Seeding first means the DM list mirrors the known contacts when
      // the live sync degrades; a successful refresh then replaces it with the
      // device-authoritative list.
      await this.seedContactsFromDb();
      await this.refreshContacts();
      // Pull the device's channel list and mirror it into the DB. MeshCore has
      // no push event for channel changes, so re-sync is connect-time and
      // after every local write. Failure here is non-fatal.
      if (this.deviceType === MeshCoreDeviceType.COMPANION) {
        try {
          await this.syncChannelsFromDevice();
        } catch (err) {
          logger.warn(`[MeshCore:${this.sourceId}] syncChannelsFromDevice failed: ${(err as Error).message}`);
        }
      }

      this.connected = true;
      // The device's flood scope is unknown right after (re)connect — force the
      // next send to re-assert it (#3667).
      this.activeFloodScope = undefined;
      this.connectionState = 'connected';
      this.heartbeatConsecutiveFailures = 0;
      this.reconnectAttempts = 0;
      this.nextReconnectAt = null;
      // A prior failed attempt (see the catch block below) may have armed
      // shouldReconnect to drive its own retry loop. Reset it here so a
      // successful connect falls back to the heartbeat feature's own opt-in
      // gating for *post-connect* drops, rather than leaving unexpected-
      // disconnect auto-reconnect silently enabled when heartbeat isn't
      // configured for this source.
      this.shouldReconnect = false;
      this.emit('connected', this.localNode);
      // Per-source auto-delete-by-distance (#3901) — scoped to this source's
      // own nodes/settings; only runs while connected.
      this.distanceDeleteScheduler.start().catch((err) =>
        logger.error(`[MeshCore:${this.sourceId}] Failed to start distance-delete scheduler:`, err));
      dataEventEmitter.emitMeshCoreStatusUpdated({ connected: true, node: this.localNode }, this.sourceId);
      if (this.localNode) {
        dataEventEmitter.emitMeshCoreLocalNodeUpdated(this.localNode, this.sourceId);
      }
      logger.info(`[MeshCore] Connected to ${this.localNode?.name || 'unknown device'}`);

      // Start heartbeat only when running on the native backend (i.e. Companion).
      // Repeater uses direct serial and isn't covered by the heartbeat probe.
      if (this.nativeBackend) {
        this.startHeartbeat();
      }

      // Keep the local Companion RTC synced to the server clock so outbound
      // frame timestamps (incl. remote-admin `clock sync`) are accurate (#3954).
      // Safe to call for any device type — it no-ops for non-Companion.
      this.startDeviceTimeSync();

      // Start the Virtual Node server (opt-in) now that the local node identity
      // is known — the server synthesizes SelfInfo from it. Non-fatal on error.
      await this.startVirtualNodeServer();

      // Start auto-pathfinding scheduler if configured for this source.
      this.startAutoPathfinding().catch(err =>
        logger.warn(`[MeshCore:${this.sourceId}] Failed to start auto-pathfinding: ${(err as Error).message}`),
      );

      // Start auto-announce scheduler. Fires once now if announceOnStart is set.
      this.startAutoAnnounce().then(async () => {
        const onStart = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceOnStart')) === 'true';
        const enabled = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceEnabled')) === 'true';
        if (onStart && enabled) {
          // Small delay so the device-side AppStart settles before chat goes out.
          setTimeout(() => {
            void this.runAutoAnnounceCycle('on_start').catch((err: Error) =>
              logger.warn(`[MeshCore:${this.sourceId}] on-start announce failed: ${err.message}`));
          }, 2500);
        }
      }).catch(err =>
        logger.warn(`[MeshCore:${this.sourceId}] Failed to start auto-announce: ${(err as Error).message}`),
      );

      // Arm any operator-defined timer triggers.
      this.startTimerTriggers().catch(err =>
        logger.warn(`[MeshCore:${this.sourceId}] Failed to start timer triggers: ${(err as Error).message}`),
      );

      return true;
    } catch (error) {
      // meshcore.js rejects some promises with `undefined` (no Error object),
      // which left the catch logging "Connection failed: undefined" with no
      // actionable signal. Surface whatever we got, with a sentinel for the
      // empty-rejection case so the next report carries usable diagnostics.
      // See discussion #2604.
      const detail =
        error instanceof Error
          ? error.stack ?? error.message
          : error === undefined || error === null
            ? '<meshcore.js rejected without an Error — likely port open / AppStart timeout / library-internal>'
            : String(error);
      logger.error(`[MeshCore] Connection failed: ${detail}`);
      await this.disconnect();
      // Retry the initial connection attempt with exponential backoff instead
      // of leaving the source stuck disconnected until a manual Connect click
      // (#3918). Unlike Meshtastic TCP — whose transport retries forever by
      // default — MeshCore had no retry path for a failed *first* attempt;
      // the existing reconnect machinery only covered a drop after a
      // successful connect, and only when the opt-in heartbeat feature was
      // configured. disconnect() above reset shouldReconnect to false, so
      // re-arm it here to drive scheduleNextReconnect/attemptReconnect.
      this.shouldReconnect = true;
      this.connectionState = 'reconnecting';
      this.scheduleNextReconnect();
      return false;
    }
  }

  /**
   * Start the Virtual Node TCP server if this source has it enabled. Exposes
   * the connected MeshCore node to the MeshCore mobile app over WiFi (#3535).
   * Idempotent and non-fatal: a bind failure is logged but does not abort the
   * connection.
   */
  private async startVirtualNodeServer(): Promise<void> {
    const vn = this.config?.virtualNode;
    if (!vn?.enabled || this.virtualNodeServer) return;

    try {
      this.virtualNodeServer = new MeshCoreVirtualNodeServer({
        port: vn.port,
        manager: this,
        allowAdminCommands: vn.allowAdminCommands,
      });
      await this.virtualNodeServer.start();
    } catch (err) {
      logger.error(
        `[MeshCore:${this.sourceId}] Failed to start Virtual Node server on port ${vn.port}: ${(err as Error).message}`,
      );
      this.virtualNodeServer = null;
    }
  }

  /** Stop the Virtual Node server if running. Safe to call when not started. */
  private async stopVirtualNodeServer(): Promise<void> {
    if (!this.virtualNodeServer) return;
    try {
      await this.virtualNodeServer.stop();
    } catch (err) {
      logger.debug(`[MeshCore:${this.sourceId}] Virtual Node server stop threw: ${(err as Error).message}`);
    }
    this.virtualNodeServer = null;
  }

  /** Whether the Virtual Node server is currently listening. */
  isVirtualNodeServerRunning(): boolean {
    return this.virtualNodeServer?.isRunning() ?? false;
  }

  /**
   * Disconnect from the device
   */
  async disconnect(): Promise<void> {
    logger.info('[MeshCore] Disconnecting...');

    // Mark this as an intentional teardown so the native backend's own
    // 'disconnected' event (fired when we close the connection below) isn't
    // mistaken for an unexpected link drop. Stays set until the next connect().
    this.intentionalTeardown = true;

    // Clear reconnect intent first so a pending reconnect closure can't
    // stomp the in-progress teardown.
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Stop heartbeat before tearing down the transport so a stray probe
    // doesn't fire mid-teardown.
    this.stopHeartbeat();

    // Stop the per-source auto-delete-by-distance scheduler (#3901).
    this.distanceDeleteScheduler.stop();

    // Cancel any pending path-refresh — refreshContacts() against a torn-
    // down connection would just log an error.
    this.clearPathRefreshTimer();

    // Stop the periodic local-node RTC sync (#3954).
    this.stopDeviceTimeSync();

    // Stop auto-pathfinding scheduler.
    this.stopAutoPathfinding();

    // Stop auto-announce + timer-trigger schedulers.
    this.stopAutoAnnounce();
    this.stopTimerTriggers();

    // Stop the Virtual Node server (if running) before tearing down the link
    // and clearing localNode — it reads localNode to answer AppStart.
    await this.stopVirtualNodeServer();

    // Tear down native backend, if active.
    if (this.nativeBackend) {
      try {
        await this.nativeBackend.disconnect();
      } catch (err) {
        logger.debug(`[MeshCore] Native backend disconnect threw: ${(err as Error).message}`);
      }
      this.nativeBackend = null;
    }

    // Close serial port (for Repeater)
    await this.closeSerialDirect();

    // Clear pending commands
    for (const [_id, cmd] of this.pendingCommands) {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Disconnected'));
    }
    this.pendingCommands.clear();

    // Clear pending DM ack-retry timers (#3977) — a torn-down connection
    // can't reset a path or resend, so don't let a stray timer try.
    for (const [, retry] of this.pendingDmRetries) {
      clearTimeout(retry.timer);
    }
    this.pendingDmRetries.clear();

    // Clear pending channel-send auto-retry timers (#3979) — a torn-down
    // connection can't resend, so don't let a stray timer try.
    for (const [, retry] of this.pendingChannelRetries) {
      clearTimeout(retry.timer);
    }
    this.pendingChannelRetries.clear();

    this.connected = false;
    this.connectionState = 'disconnected';
    this.deviceType = MeshCoreDeviceType.UNKNOWN;
    this.localNode = null;
    this.contacts.clear();
    this.guestLoggedInNodes.clear();
    this.roomLoggedInNodes.clear();

    this.emit('disconnected');
    dataEventEmitter.emitMeshCoreStatusUpdated({ connected: false }, this.sourceId);
    logger.info('[MeshCore] Disconnected');
  }

  // ============ Native Backend (meshcore.js) ============

  /**
   * Start the native JS backend (meshcore.js). Reads the manager's config;
   * supports USB serial and TCP.
   */
  private async startNativeBackend(): Promise<void> {
    if (!this.config) {
      throw new Error('Native backend: no config');
    }

    const backendConfig =
      this.config.connectionType === ConnectionType.TCP
        ? {
            connectionType: 'tcp' as const,
            tcpHost: this.config.tcpHost,
            tcpPort: this.config.tcpPort,
          }
        : {
            connectionType: 'serial' as const,
            serialPort: this.sanitizeSerialPort(this.config.serialPort || ''),
            baudRate: this.config.baudRate || 115200,
          };

    const backend = new MeshCoreNativeBackend(this.sourceId, backendConfig);
    this.nativeBackend = backend;

    // Native backend emits bridge-shaped push events; route them through
    // the manager's existing event handler.
    backend.on('event', (evt: BridgeShapedEvent) => {
      this.handleBridgeEvent(evt);
    });

    // The underlying meshcore.js connection lost its socket/serial link. Capture
    // the backend instance so a late event from a replaced/torn-down backend is
    // ignored — only the current one drives recovery.
    backend.on('disconnected', () => {
      if (this.nativeBackend !== backend) return;
      void this.handleUnexpectedDisconnect();
    });

    logger.info(`[MeshCore:${this.sourceId}] Starting native backend (meshcore.js)`);
    await this.nativeBackend.connect();
    logger.info(`[MeshCore:${this.sourceId}] Native backend ready`);

    // Apply the "be discoverable" preference so we answer inbound discovery
    // requests once connected (opt-in; default off).
    try {
      const discoverable =
        (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreRespondToDiscovery')) === 'true';
      this.nativeBackend.setRespondToDiscovery(discoverable);
      if (discoverable) {
        logger.info(`[MeshCore:${this.sourceId}] Discovery responder enabled (node is discoverable)`);
      }
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] Failed to read meshcoreRespondToDiscovery:`, err);
    }
  }

  /**
   * Send a bridge-shaped command to the native JS backend. Returns the same
   * BridgeResponse shape the manager's call sites already expect.
   */
  private async sendBridgeCommand(cmd: string, params: Record<string, any>, timeout: number = 30000): Promise<BridgeResponse> {
    if (!this.nativeBackend) {
      throw new Error('Native backend not ready');
    }
    return this.nativeBackend.sendCommand(cmd, params, timeout);
  }

  /**
   * Handle unsolicited push events from the native backend (incoming messages,
   * contact updates). sender_timestamp from the MeshCore protocol is Unix
   * epoch in seconds; we convert to milliseconds for JS Date compatibility.
   */
  private handleBridgeEvent(event: { event_type: string; data: any }): void {
    const { event_type, data } = event;

    if (event_type === 'contact_message') {
      const hopCount = decodePathLenHopCount(data.path_len);
      const senderContact = this.resolveContactByPrefix(data.pubkey_prefix);
      // The displayed/stored route is ONLY the per-packet relay-hash chain
      // recovered from LogRxData — the actual hops THIS packet traversed.
      // We deliberately do NOT fall back to the contact's cached outPath here:
      // outPath is the OUTBOUND path from us to the sender, not the inbound
      // route the message took, so showing it would mislead (#3742 review).
      const observedRoute = formatPathHops(data.path_hops);
      // The {ROUTE} auto-ack template keeps the outPath fallback (existing
      // behavior) so an ack can still cite a route when no LogRxData surfaced.
      const ackRoute = observedRoute || senderContact?.outPath || null;
      const scope = resolveMessageScope(data.raw_hex, this.knownScopes);
      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: data.pubkey_prefix,
        fromName: senderContact?.advName ?? senderContact?.name ?? undefined,
        toPublicKey: this.localNode?.publicKey || 'local',
        text: data.text,
        timestamp: data.sender_timestamp ? data.sender_timestamp * 1000 : Date.now(),
        snr: data.snr,
        sourceId: this.sourceId,
        hopCount,
        // Raw packed path_len byte (0xff = direct) so the Virtual Node bridge
        // can forward the real hop count to a companion instead of "direct" (#3871).
        pathLen: data.path_len ?? null,
        routePath: observedRoute,
        scopeCode: scope.scopeCode,
        scopeName: scope.scopeName,
      };
      this.addMessage(message);
      this.emit('message', message);
      dataEventEmitter.emitMeshCoreMessage(message, this.sourceId);
      logger.debug(`[MeshCore:${this.sourceId}] Contact message from ${data.pubkey_prefix} (${data.text.length} chars)`);
      void this.checkAutoAcknowledge(message, true, undefined, hopCount, ackRoute);
      void this.checkAutoResponder(message, true, undefined, hopCount, ackRoute);
    } else if (event_type === 'channel_message') {
      // MeshCore channel packets have no sender field on the wire — the sender's
      // device prefixes "Name: " onto the text body. Split it out so the UI can
      // show the sender and the body separately.
      const rawText: string = data.text ?? '';
      const prefixMatch = rawText.match(/^([^:\n]{1,32}):\s*(.*)$/s);
      const fromName = prefixMatch ? prefixMatch[1].trim() : undefined;
      const body = prefixMatch ? prefixMatch[2] : rawText;
      // Channel messages carry no sender pubkey on the wire, so there
      // is no contact outPath fallback for {ROUTE}. The LogRxData
      // path_hops (when present) is the only source of relay identities.
      const hopCount = decodePathLenHopCount(data.path_len);
      const route = formatPathHops(data.path_hops);
      const scope = resolveMessageScope(data.raw_hex, this.knownScopes);
      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: MeshCoreManager.channelPublicKey(data.channel_idx),
        fromName,
        text: body,
        timestamp: data.sender_timestamp ? data.sender_timestamp * 1000 : Date.now(),
        snr: data.snr,
        sourceId: this.sourceId,
        hopCount,
        // Raw packed path_len byte (0xff = direct) so the Virtual Node bridge
        // can forward the real hop count to a companion instead of "direct" (#3871).
        pathLen: data.path_len ?? null,
        routePath: route,
        scopeCode: scope.scopeCode,
        scopeName: scope.scopeName,
      };
      this.addMessage(message);
      this.emit('message', message);
      dataEventEmitter.emitMeshCoreMessage(message, this.sourceId);
      logger.debug(`[MeshCore] Channel ${data.channel_idx} message (${data.text.length} chars)`);
      void this.checkAutoAcknowledge(message, false, data.channel_idx, hopCount, route);
      void this.checkAutoResponder(message, false, data.channel_idx, hopCount, route);
    } else if (event_type === 'room_message') {
      // Room server post (TXT_TYPE_SIGNED_PLAIN). The room's pubkey prefix
      // identifies which room, and the author prefix identifies the poster.
      const roomPubkeyPrefix: string = data.room_pubkey_prefix;
      const authorPrefixHex: string = data.author_pubkey_prefix;

      const roomContact = this.resolveContactByPrefix(roomPubkeyPrefix);
      const roomFullKey = roomContact?.publicKey ?? roomPubkeyPrefix;
      const authorContact = this.resolveContactByPrefix(authorPrefixHex);
      const authorFullKey = authorContact?.publicKey ?? authorPrefixHex;
      const authorName = authorContact?.advName ?? authorContact?.name ?? undefined;

      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: authorFullKey,
        fromName: authorName,
        toPublicKey: roomFullKey,
        text: data.text,
        timestamp: data.sender_timestamp ? data.sender_timestamp * 1000 : Date.now(),
        snr: data.snr,
        sourceId: this.sourceId,
        messageType: 'room_post',
      };
      this.addMessage(message);
      this.emit('message', message);
      dataEventEmitter.emitMeshCoreMessage(message, this.sourceId);
      // Track newest post timestamp for sync-since and UI display.
      databaseService.meshcore.updateLastRoomPostAt(this.sourceId, roomFullKey, message.timestamp)
        .catch(err => logger.warn(`[MeshCore:${this.sourceId}] Failed to update lastRoomPostAt:`, err));
      logger.debug(`[MeshCore:${this.sourceId}] Room post from ${authorPrefixHex} in room ${roomPubkeyPrefix} (${data.text.length} chars)`);
    } else if (event_type === 'contact_advertised' || event_type === 'contact_added') {
      const publicKey: string = data.public_key;
      if (publicKey) {
        // A live advert means this node is genuinely back — lift any removal
        // tombstone so it syncs normally again (#3878). The reporter's gone
        // room server never adverts, so it stays suppressed.
        this.clearContactTombstone(publicKey);
        // Captured before the set below: a contact we didn't already know about
        // is a genuine new-node discovery. Bulk contact-list sync populates
        // this.contacts directly (not via this event), so a first connect
        // against a device with many saved contacts won't storm notifications.
        const wasKnown = this.contacts.has(publicKey);
        const existing = this.contacts.get(publicKey) ?? { publicKey };
        const updated: MeshCoreContact = {
          ...existing,
          publicKey,
          // `||` not `??`: zero-hop repeaters (and some firmware builds) emit
          // `contact_advertised` with adv_name === "", which `??` would pass
          // through and overwrite the known name with an empty string (#3756).
          advName: data.adv_name || existing.advName,
          advType: data.adv_type ?? existing.advType,
          lastAdvert: data.last_advert ?? existing.lastAdvert,
          latitude: data.latitude ?? existing.latitude,
          longitude: data.longitude ?? existing.longitude,
          lastSeen: Date.now(),
        };
        this.contacts.set(publicKey, updated);
        // Mirror to meshcore_nodes so per-source consumers (telemetry
        // scheduler, REST queries) see the contact's advType. Without
        // this, the table only gets stub rows from setNodeTelemetryConfig
        // and the scheduler can never classify a target as a repeater.
        // See https://github.com/Yeraze/meshmonitor/issues/3092.
        void this.persistContact(updated);
        this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
        dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
        if (!wasKnown) {
          void this.notifyNewNodeDiscovered(updated);
        }
        // A node whose advert didn't carry its name/type — the full record
        // (name, type, position) lives on the device's contact list. Pull it via
        // a debounced refreshContacts() so those fields populate immediately
        // instead of only after a manual disconnect/reconnect (#3646). Coalesced
        // with path-refreshes over the same window.
        //
        // This fires for KNOWN contacts too, not just brand-new ones (#3820):
        // discovery (NODE_DISCOVER_RESP) pre-creates a *nameless* device contact,
        // so the repeater's later zero-hop advert arrives as a pubkey-only 0x80
        // push (the firmware's existing-contact path) carrying no adv_name — even
        // though the firmware has already stored the real name on the device. The
        // old `!wasKnown` gate skipped the re-read for that already-known contact,
        // leaving it "Unknown" until an unrelated refresh (e.g. opening the admin
        // panel) happened to run. A get_contacts re-read pulls the stored name.
        //
        // Safe + zero-airtime: firmware drops nameless adverts (BaseChatMesh), so
        // every contact_advertised event means the device just stored a real name;
        // refreshContacts() is a local debounced get_contacts read, and once the
        // name is pulled `updated.advName` is non-empty so this stops re-firing.
        // NOTE: this relies on discovery storing lastAdvert≈0 so the repeater's
        // next advert isn't replay-dropped firmware-side — if the native backend
        // ever starts passing a non-zero lastAdvert for discovered contacts, the
        // firmware replay guard would suppress that advert and reintroduce #3820.
        if (!updated.advName || updated.advType === undefined) {
          this.schedulePathRefresh(publicKey);
        }
        logger.debug(`[MeshCore] ${event_type} for ${publicKey} (${data.adv_name ?? ''})`);
      }
    } else if (event_type === 'cli_reply') {
      // Remote-admin: a contact message with txtType=CliData. Routed here by
      // the native backend so CLI output never lands in the chat log. We
      // resolve the first pending sendCliCommand whose target pubkey prefix
      // matches the sender — there is no request ID in the MeshCore protocol,
      // so per-pubkey serialization is the only sound correlation strategy.
      const prefix = String(data.pubkey_prefix ?? '').toLowerCase();
      const replyText = String(data.text ?? '');
      const pending = this.pendingCliReplies.get(prefix);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCliReplies.delete(prefix);
        pending.resolve(replyText);
        logger.debug(
          `[MeshCore:${this.sourceId}] CLI reply from ${prefix} (${replyText.length}B, ${Date.now() - pending.sentAt}ms)`,
        );
      } else {
        // No in-flight command for this sender. Most likely a late reply
        // after a client-side timeout; surface for debugging but don't
        // route it into the chat log either.
        logger.debug(
          `[MeshCore:${this.sourceId}] Unmatched CLI reply from ${prefix}: ${replyText.substring(0, 80)}`,
        );
      }
    } else if (event_type === 'send_confirmed') {
      // Ack arrived in time — cancel the auto-retry timer (#3977) so a
      // stale-path resend doesn't fire after the fact.
      const retryPending = this.pendingDmRetries.get(data.ack_code);
      if (retryPending) {
        clearTimeout(retryPending.timer);
        this.pendingDmRetries.delete(data.ack_code);
      }
      this.emit('send_confirmed', {
        sourceId: this.sourceId,
        ackCode: data.ack_code,
        roundTripMs: data.round_trip_ms,
      });
      dataEventEmitter.emitMeshCoreSendConfirmed(
        { ackCode: data.ack_code, roundTripMs: data.round_trip_ms },
        this.sourceId,
      );
      logger.debug(
        `[MeshCore:${this.sourceId}] Send confirmed: RTT=${data.round_trip_ms}ms`,
      );
    } else if (event_type === 'contact_path_updated') {
      const publicKey: string = data.public_key;
      if (publicKey) {
        // The firmware's PUSH_CODE_PATH_UPDATED frame body is just the
        // pubkey — the new path bytes live on the contact record itself,
        // so we have to re-read the contact list to actually learn them.
        // meshcore.js doesn't expose CMD_GET_CONTACT_BY_KEY yet (the only
        // single-contact fetcher in the firmware), so refreshContacts()
        // is what's available. Coalesce pushes in a debounce window so a
        // chatty contact churning its route doesn't thunder the device.
        this.schedulePathRefresh(publicKey);
        logger.debug(`[MeshCore] contact_path_updated for ${publicKey} (refresh scheduled)`);
      }
    } else if (event_type === 'path_discovery_response') {
      // 0x8D push from CMD 52 — carries the actual bidirectional path
      // bytes so we can update the contact directly without a device
      // round-trip. The pubkey_prefix is 6 bytes; resolve to full key.
      const prefix: string = data.pubkey_prefix;
      const outHops: number = data.out_path_len ?? 0;
      const outPathHex: string = data.out_path_hex ?? '';
      const outHashSize: number = data.out_hash_size ?? 1;
      const inHops: number = data.in_path_len ?? 0;
      const inPathHex: string = data.in_path_hex ?? '';

      const contact = this.resolveContactByPrefix(prefix);
      if (!contact) {
        logger.warn(`[MeshCore] path_discovery_response for unknown prefix ${prefix}`);
        return;
      }

      const formatPathHex = (hex: string, hashSize: number): string => {
        if (!hex) return '';
        const bytes: string[] = [];
        for (let i = 0; i < hex.length; i += hashSize * 2) {
          bytes.push(hex.substring(i, i + hashSize * 2));
        }
        return bytes.join(',');
      };

      const outPathFormatted = formatPathHex(outPathHex, outHashSize);
      const updated: MeshCoreContact = {
        ...contact,
        outPath: outPathFormatted || null,
        pathLen: outHops,
        lastSeen: Date.now(),
      };
      this.contacts.set(contact.publicKey, updated);
      void this.persistContact(updated);
      this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
      dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
      logger.debug(
        `[MeshCore] Path discovery response for ${contact.publicKey.substring(0, 16)}…: ` +
        `out=${outHops} hops [${outPathFormatted}], in=${inHops} hops [${formatPathHex(inPathHex, data.in_hash_size ?? 1)}]`,
      );
    } else if (event_type === 'node_discovered') {
      // 0x8E NODE_DISCOVER_RESP from an active discovery burst (CMD 55).
      // The native backend already registered the node on the device; here
      // we mirror it into MeshMonitor's contact store (so it shows up in the
      // UI) and tally the in-flight discovery session for the result toast.
      // A discovery response carries only the key, type, and SNR — name and
      // position arrive later via the normal advert path.
      const publicKey: string = data.public_key;
      if (publicKey) {
        const isNew = !this.contacts.has(publicKey);
        const existing = this.contacts.get(publicKey) ?? { publicKey };
        const updated: MeshCoreContact = {
          ...existing,
          publicKey,
          advType: data.adv_type ?? existing.advType,
          lastSeen: Date.now(),
        };
        this.contacts.set(publicKey, updated);
        void this.persistContact(updated);

        const emitContact = (contact: MeshCoreContact) => {
          this.emit('contacts_updated', { sourceId: this.sourceId, contact });
          dataEventEmitter.emitMeshCoreContactUpdated(contact, this.sourceId);
        };
        if (updated.advName || updated.name) {
          emitContact(updated);
        } else {
          // A re-discovered node (delete → "Discover Repeaters") comes back
          // with no name — discovery responses carry only key+type. But the
          // persisted meshcore_nodes row survives a contact delete, so the
          // server still knows the name. Backfill it from the DB before the
          // first emit, otherwise the UI shows "Unknown" until a later passive
          // advert (or a manual page reload re-reading the snapshot) supplies
          // it. (#3858 follow-up)
          void (async () => {
            let toEmit = updated;
            try {
              const dbNode = await databaseService.meshcore.getNodeByPublicKeyAndSource(
                publicKey,
                this.sourceId,
              );
              if (dbNode?.name) {
                toEmit = { ...updated, advName: dbNode.name };
                this.contacts.set(publicKey, toEmit);
              }
            } catch (err) {
              logger.warn(
                `[MeshCore:${this.sourceId}] discover name backfill failed for ` +
                `${publicKey.substring(0, 16)}…: ${(err as Error).message}`,
              );
            }
            emitContact(toEmit);
          })();
        }

        // A discovery response carries only key+type — name and position aren't
        // included. For a newly-seen node, pull the full contact record
        // (debounced) so those fields populate without a manual reconnect
        // (#3646) rather than waiting on a later passive advert that may not
        // carry them either.
        if (isNew) {
          this.schedulePathRefresh(publicKey);
        }

        // Tally the burst, de-duplicating repeated responses from the same node.
        if (this.activeDiscovery && !this.activeDiscovery.seen.has(publicKey)) {
          this.activeDiscovery.seen.add(publicKey);
          this.activeDiscovery.returned++;
          if (isNew) this.activeDiscovery.newCount++;
        }
        logger.debug(
          `[MeshCore:${this.sourceId}] Discovered node ${publicKey.substring(0, 16)}… ` +
          `(type=${data.adv_type}, snr=${data.snr}, ${isNew ? 'new' : 'known'})`,
        );
      }
    } else if (event_type === 'ota_packet') {
      // Self-echo correlation for channel "heard repeaters" (#3700) runs on the
      // raw OTA data FIRST, independent of the opt-in packet monitor, so it
      // works regardless of the monitor setting.
      void this.correlateChannelEcho(data);
      // Re-emit the raw OTA packet as a plain EventEmitter event so the MeshCore
      // Virtual Node can bridge it to connected apps as a LogRxData(0x88) push
      // (#3963). Deliberately NOT gated on the packet-monitor setting: a feed
      // consumer like Remote-Terminal's channel finder wants every packet even
      // when MeshMonitor's own packet log is off. Fields used downstream:
      // `snr` (dB), `rssi` (dBm), `raw_hex` (whole OTA frame).
      this.emit('ota_packet', data);
      // Full OTA packet metadata for the MeshCore Packet Monitor. Capture is
      // opt-in; gate persistence on the setting so we don't write a row for
      // every received packet unless the user has turned the monitor on.
      void this.handleOtaPacket(data);
    } else {
      logger.debug(`[MeshCore] Unknown push event: ${event_type}`);
    }
  }

  /**
   * Persist and broadcast a parsed OTA packet for the MeshCore Packet
   * Monitor. No-op unless the user has enabled `meshcore_packet_log_enabled`.
   * Best-effort: capture failures must never break the message stream.
   */
  private async handleOtaPacket(data: any): Promise<void> {
    try {
      if (!(await meshcorePacketLogService.isEnabled())) return;

      const now = Date.now();
      const pathHops: string[] = Array.isArray(data.path_hops) ? data.path_hops : [];
      const packet: DbMeshCorePacket = {
        sourceId: this.sourceId,
        timestamp: now,
        payloadType: data.payload_type,
        payloadTypeName: data.payload_type_string ?? null,
        routeType: typeof data.route_type === 'number' ? data.route_type : null,
        routeTypeName: data.route_type_string ?? null,
        pathLenRaw: typeof data.path_len_raw === 'number' ? data.path_len_raw : null,
        hopCount: typeof data.hop_count === 'number' ? data.hop_count : pathHops.length,
        pathHops: pathHops.length > 0 ? pathHops.join(',') : null,
        snr: typeof data.snr === 'number' ? data.snr : null,
        rssi: typeof data.rssi === 'number' ? data.rssi : null,
        payloadSize: typeof data.payload_size === 'number' ? data.payload_size : null,
        rawHex: data.raw_hex ?? null,
        createdAt: now,
      };

      await meshcorePacketLogService.logPacket(packet);
      dataEventEmitter.emitMeshCoreOtaPacket(packet, this.sourceId);
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] Failed to handle OTA packet:`, err);
    }
  }

  /**
   * Register an outgoing channel send as a candidate for self-echo correlation
   * (#3700). Prunes entries older than HEARD_WINDOW_MS so the map never grows
   * unbounded on a chatty channel.
   */
  private registerPendingChannelSend(messageId: string, channelIdx: number, text: string): void {
    const now = Date.now();
    this.prunePendingChannelSends(now);
    this.pendingChannelSends.set(messageId, { channelIdx, sentAt: now, text });
  }

  /** Drop pending channel sends (and stale attribution guards) older than the
   *  heard window. */
  private prunePendingChannelSends(now: number): void {
    for (const [id, entry] of this.pendingChannelSends) {
      if (now - entry.sentAt > MeshCoreManager.HEARD_WINDOW_MS) {
        this.pendingChannelSends.delete(id);
      }
    }
    for (const [key, heardAt] of this.attributedChannelEchoes) {
      if (now - heardAt > MeshCoreManager.HEARD_WINDOW_MS) {
        this.attributedChannelEchoes.delete(key);
      }
    }
  }

  /**
   * Load the 16-byte AES-128 secret for a MeshCore channel slot from the
   * channels repository (base64 `psk`). Returns null when the channel is
   * unknown, has no PSK, or the PSK is not a valid 16-byte key. Never throws —
   * a DB hiccup must not break the packet pipeline.
   */
  private async loadChannelSecret(channelIdx: number): Promise<Uint8Array | null> {
    try {
      const channel = await databaseService.channels.getChannelById(channelIdx, this.sourceId);
      if (!channel?.psk) return null;
      const buf = Buffer.from(channel.psk, 'base64');
      if (buf.length !== MESHCORE_SECRET_BYTES) return null;
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  /**
   * Best-effort channel "heard repeaters" correlation (#3700).
   *
   * When a nearby repeater re-floods one of OUR channel messages, our device
   * hears it as an inbound GRP_TXT OTA packet whose relay-hash chain
   * (`path_hops`) names the repeaters that carried it. We PROVE the echo is ours
   * (#3979): we hold the channel PSK, so we decrypt the echoed payload and
   * require the recovered plaintext to be exactly `"<ourNodeName>: <textWeSent>"`
   * for one of our pending channel sends. This rejects both unrelated
   * third-party chatter on the same channel and cross-attribution between two of
   * our own near-simultaneous sends. Each relay hash is resolved to a known
   * contact name when possible (raw hash otherwise), the max SNR is tracked per
   * repeater, and the merged heard-by set is broadcast. Each echoed packet is
   * attributed at most once (guarded by the invariant payload identity).
   *
   * Failures are swallowed — correlation must never break the packet pipeline.
   */
  private async correlateChannelEcho(data: any): Promise<void> {
    try {
      const now = Date.now();
      this.prunePendingChannelSends(now);

      // Hot-path early-outs: only GRP_TXT frames with at least one pending
      // channel send can ever match — skip the decrypt attempt otherwise.
      if (!data || data.payload_type !== MeshCoreManager.PAYLOAD_TYPE_GRP_TXT) return;
      if (this.pendingChannelSends.size === 0) return;

      // Pre-load the channel secret for every distinct pending channel so the
      // pure matcher can stay synchronous (no DB in the unit-testable core).
      const secretByChannel = new Map<number, Uint8Array | null>();
      for (const [, entry] of this.pendingChannelSends) {
        if (!secretByChannel.has(entry.channelIdx)) {
          secretByChannel.set(entry.channelIdx, await this.loadChannelSecret(entry.channelIdx));
        }
      }

      const match = MeshCoreManager.findEchoMatch(
        data,
        this.pendingChannelSends,
        now,
        MeshCoreManager.HEARD_WINDOW_MS,
        {
          selfName: this.localNode?.name ?? null,
          resolveChannelSecret: (idx) => secretByChannel.get(idx) ?? null,
        },
      );
      if (!match) return;

      // Attribute each distinct echoed packet at most once (#3979).
      if (this.attributedChannelEchoes.has(match.echoKey)) return;
      this.attributedChannelEchoes.set(match.echoKey, now);

      const snr = typeof data.snr === 'number' ? Math.round(data.snr) : null;
      const heardBy: Array<{ hash: string; name?: string | null; snr?: number | null }> = [];

      for (const hash of match.pathHops) {
        const contact = this.resolveContactByPrefix(hash);
        const name = contact?.advName ?? contact?.name ?? null;
        const merged = await databaseService.meshcore.recordHeardRepeater({
          sourceId: this.sourceId,
          messageId: match.messageId,
          repeaterHash: hash,
          repeaterName: name,
          snr,
          heardAt: now,
        });
        heardBy.push({ hash: merged.repeaterHash, name: merged.repeaterName, snr: merged.snr });
      }

      if (heardBy.length === 0) return;

      // Broadcast the current full heard-by set (read back so concurrent
      // echoes for the same message stay consistent).
      const all = await databaseService.meshcore.getHeardRepeatersForMessage(
        match.messageId,
        this.sourceId,
      );
      const fullHeardBy = all.map((r) => ({ hash: r.repeaterHash, name: r.repeaterName, snr: r.snr }));
      // This relay count is surfaced to MeshMonitor's own UI only. It is NOT
      // forwarded to a Virtual Node companion, by protocol necessity (#3871):
      // a channel send is an unacked fire-and-forget flood, so the companion
      // already got `Ok(0)` and closed the send; the count is a MeshMonitor-
      // derived metric that accrues asynchronously (here, up to HEARD_WINDOW_MS
      // later) and the companion protocol has no push frame or message handle to
      // annotate an already-sent channel message with it. The DM ack path
      // (SendConfirmed 0x82) IS bridged because DMs have real delivery semantics.
      dataEventEmitter.emitMeshCoreChannelHeard({ id: match.messageId, heardBy: fullHeardBy }, this.sourceId);

      // Mirror heardBy into the in-memory pool so getRecentMessages() returns
      // correct data after subsequent fetchMessages() calls (#3813).
      const msgIdx = this.messages.findIndex(m => m.id === match.messageId);
      if (msgIdx !== -1) {
        this.messages[msgIdx] = { ...this.messages[msgIdx], heardBy: fullHeardBy };
      }

      logger.debug(
        `[MeshCore:${this.sourceId}] Channel echo: msg=${match.messageId} +${heardBy.length} repeater(s), total=${fullHeardBy.length}`,
      );
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] correlateChannelEcho failed: ${(err as Error).message}`);
    }
  }

  /**
   * Decide whether an inbound OTA packet is a self-echo of a pending channel
   * send (#3700, #3979). Pure (no I/O) so it can be unit-tested directly against
   * real encrypted fixtures. Returns the matched message id, the de-duplicated
   * relay-hash chain, and the echo's invariant payload identity (`echoKey`), or
   * null.
   *
   * A match requires ALL of:
   *  - `payload_type === GRP_TXT`;
   *  - a non-empty `path_hops` relay chain (a direct/zero-hop packet names no
   *    repeaters);
   *  - a known local node name (`selfName`) — needed to confirm self-origin;
   *  - a decodable `raw_hex`; and
   *  - a pending channel send, WITHIN the window, whose channel secret both
   *    MAC-verifies and AES-decrypts the echoed payload to exactly
   *    `"<selfName>: <that send's text>"`.
   *
   * When several pending sends satisfy the exact match (identical text on the
   * same channel), the OLDEST is chosen for deterministic attribution — never
   * "most recent". A third-party message (whose decrypted sender name differs)
   * or a re-flood of a different channel simply never matches.
   */
  static findEchoMatch(
    data: any,
    pendingChannelSends: Map<string, { channelIdx: number; sentAt: number; text: string }>,
    now: number,
    windowMs: number,
    opts: {
      selfName: string | null;
      resolveChannelSecret: (channelIdx: number) => Uint8Array | null;
    },
  ): { messageId: string; channelIdx: number; pathHops: string[]; echoKey: string } | null {
    if (!data || data.payload_type !== MeshCoreManager.PAYLOAD_TYPE_GRP_TXT) return null;

    const rawHops: unknown = data.path_hops;
    if (!Array.isArray(rawHops) || rawHops.length === 0) return null;
    // De-dup while preserving order; normalise to lowercase hex strings.
    const seen = new Set<string>();
    const pathHops: string[] = [];
    for (const h of rawHops) {
      if (typeof h !== 'string' || h.length === 0) continue;
      const hash = h.toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      pathHops.push(hash);
    }
    if (pathHops.length === 0) return null;

    // Without our own node name we can't confirm self-origin — bail rather than
    // risk crediting a third-party message.
    const selfName = opts.selfName;
    if (!selfName) return null;

    // Recover the GRP_TXT payload (`[channel_hash:1][MAC:2][ciphertext]`) from
    // the raw OTA frame; `path_hops` above already gives the relay chain.
    const decoded = decodeMeshCorePacket(typeof data.raw_hex === 'string' ? data.raw_hex : null);
    const payloadHex = decoded?.payload?.hex;
    if (!payloadHex) return null;

    // Try each in-window pending send OLDEST-first so attribution is
    // deterministic (never "most recent").
    const candidates = Array.from(pendingChannelSends.entries())
      .filter(([, entry]) => now - entry.sentAt <= windowMs)
      .sort((a, b) => a[1].sentAt - b[1].sentAt);

    for (const [messageId, entry] of candidates) {
      const secret = opts.resolveChannelSecret(entry.channelIdx);
      if (!secret) continue;
      const plaintext = tryDecodeGroupTextPayload(payloadHex, secret);
      if (!plaintext) continue;
      // Self-origin + exact-text check in one comparison: MeshCore prefixes the
      // sender name, so our own echo decrypts to `"<selfName>: <text>"`.
      if (plaintext.body !== `${selfName}: ${entry.text}`) continue;
      return { messageId, channelIdx: entry.channelIdx, pathHops, echoKey: payloadHex };
    }
    return null;
  }

  /**
   * Mirror an in-memory MeshCoreContact to the `meshcore_nodes` SQL table.
   *
   * Without this the table only ever sees stub rows from
   * `setNodeTelemetryConfig` (publicKey + telemetry flags, advType=null),
   * so the remote-telemetry scheduler can't tell a Repeater from a
   * Companion and routes every target through the LPP-only path —
   * skipping the SendStatusReq + guest-login paths added in #3094. The
   * mirror keeps the table accurate enough for any per-source consumer
   * (scheduler, REST endpoints, future cross-source views) to read the
   * contact's actual device type.
   *
   * Failures are logged but never thrown — a transient DB error on a
   * single advert should not break the contact-event pipeline.
   */
  private async persistContact(contact: MeshCoreContact): Promise<void> {
    try {
      // Don't resurrect a just-removed contact (#3878). persistContact is called
      // from many event handlers (bulk sync, advert pushes, path updates), so
      // guarding here — not only in refreshContacts — closes every re-insert path.
      // The `this.contacts.delete` here is a deliberate belt-and-braces cleanup,
      // not just a DB guard: a caller can race a stale in-memory entry back in
      // between removal and this persist (e.g. a debounced refreshContacts()
      // queued just before the tombstone was set), so we scrub the map too
      // rather than only skipping the DB write.
      if (this.isContactTombstoned(contact.publicKey)) {
        this.contacts.delete(contact.publicKey);
        return;
      }
      // Drop bogus positions before they land in the node row: "Null Island"
      // (0,0) GPS defaults (issue #3763) AND out-of-range junk that MeshCore
      // adverts sometimes carry — e.g. latitude 1853.45, longitude -1598.75 —
      // which would otherwise blow the map's auto-fit bounds out to nothing.
      const bogusPosition = isBogusPosition(contact.latitude, contact.longitude);
      const hasContactPosition = !bogusPosition
        && typeof contact.latitude === 'number'
        && typeof contact.longitude === 'number';
      await databaseService.meshcore.upsertNode(
        {
          publicKey: contact.publicKey,
          // `||` not `??` so an empty advName falls back to name rather than
          // persisting "" into the node row (#3756).
          name: contact.advName || contact.name || null,
          advType: contact.advType ?? null,
          latitude: bogusPosition ? null : (contact.latitude ?? null),
          longitude: bogusPosition ? null : (contact.longitude ?? null),
          // Tag this as the static/advert-cached position (#3908) so
          // upsertNode won't let it clobber an established telemetry GNSS
          // fix. Only tagged when we're actually writing a real coordinate —
          // otherwise omitted so the merge preserves whatever is stored.
          positionSource: hasContactPosition ? 'contact' : undefined,
          rssi: contact.rssi ?? null,
          snr: contact.snr ?? null,
          lastHeard: contact.lastSeen ?? null,
          outPath: contact.outPath ?? null,
          pathLen: contact.pathLen ?? null,
        },
        this.sourceId,
      );
    } catch (err) {
      logger.warn(
        `[MeshCore:${this.sourceId}] persistContact(${contact.publicKey.substring(0, 16)}…) failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Fire a "new node discovered" notification for a newly seen MeshCore
   * contact (callers gate on the contact being genuinely new). No-ops when we
   * have no usable display name yet — the name normally arrives with the
   * advert, so this is rare — or when we've already notified for this public
   * key this session. MeshCore has no Meshtastic-style short name / hardware
   * model / hop count, so the payload carries the display name plus a
   * device-type label (Companion / Repeater / Room Server).
   *
   * Failures are logged but never thrown so the contact-event pipeline keeps
   * running even if notification delivery hiccups.
   */
  private async notifyNewNodeDiscovered(contact: MeshCoreContact): Promise<void> {
    try {
      const publicKey = contact.publicKey;
      if (!publicKey || this.notifiedNewNodes.has(publicKey)) return;
      const displayName = contact.advName ?? contact.name ?? null;
      if (!displayName) return; // defer until we have a meaningful name
      this.notifiedNewNodes.add(publicKey);

      const deviceTypeLabel = contact.advType != null
        ? MESHCORE_DEVICE_TYPE_LABELS[contact.advType] ?? undefined
        : undefined;

      let sourceName: string = this.sourceId;
      try {
        const src = await databaseService.sources.getSource(this.sourceId);
        if (src?.name) sourceName = src.name;
      } catch { /* fall back to id */ }

      await notificationService.notifyNewMeshCoreNode(
        publicKey,
        displayName,
        deviceTypeLabel,
        this.sourceId,
        sourceName,
      );
    } catch (err) {
      logger.warn(
        `[MeshCore:${this.sourceId}] notifyNewNodeDiscovered(${contact.publicKey.substring(0, 16)}…) failed: ${(err as Error).message}`,
      );
    }
  }

  /** Generate a synthetic public key identifier for channel messages */
  private static channelPublicKey(channelIdx: number): string {
    return `channel-${channelIdx}`;
  }

  // ============ Channel CRUD ============

  /**
   * Read the channel list from the device. Channels are returned in the order
   * the firmware reports them (typically ascending channelIdx). Companion mode
   * only — Repeater firmware doesn't expose a channel API over the CLI.
   */
  async listChannels(): Promise<MeshCoreChannel[]> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      return [];
    }
    const response = await this.sendBridgeCommand('get_channels', {});
    if (!response.success) {
      throw new Error(response.error || 'get_channels failed');
    }
    const list: Array<{ channel_idx: number; name: string; secret_hex: string }> =
      Array.isArray(response.data) ? response.data : [];
    return list.map((row) => ({
      channelIdx: row.channel_idx,
      name: row.name ?? '',
      secretHex: row.secret_hex ?? '',
    }));
  }

  /**
   * Write a channel slot on the device. `secretHex` must decode to 16 bytes
   * (AES-128). Re-syncs the DB from the device afterwards so any side-effect
   * (e.g. the firmware normalising the name) is reflected immediately.
   *
   * `scope` (#3667) is a MeshMonitor-owned region tag the device never stores;
   * when provided it is persisted to the DB row AFTER the device re-sync (which
   * preserves but never sets scope). `undefined` leaves any existing scope
   * untouched; `null`/'' clears it. Plain region name, no leading '#'.
   */
  async setChannel(idx: number, name: string, secretHex: string, scope?: string | null): Promise<void> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      throw new Error('setChannel: MeshCore source is not in Companion mode');
    }
    const response = await this.sendBridgeCommand('set_channel', {
      idx,
      name,
      secret_hex: secretHex,
    });
    if (!response.success) {
      throw new Error(response.error || 'set_channel failed');
    }
    await this.syncChannelsFromDevice();
    if (scope !== undefined) {
      await databaseService.channels.updateChannelScope(idx, (scope || '').trim() || null, this.sourceId);
      // A scope change may affect the next send on this channel — force a
      // re-assert rather than trusting the cached device scope.
      this.activeFloodScope = undefined;
      // The known-scope set used to resolve received-message scopes changed.
      void this.refreshKnownScopes();
    }
  }

  /**
   * Delete a channel slot on the device. Re-syncs the DB from the device
   * afterwards so the local mirror reflects the firmware's view.
   */
  async deleteChannel(idx: number): Promise<void> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      throw new Error('deleteChannel: MeshCore source is not in Companion mode');
    }
    const response = await this.sendBridgeCommand('delete_channel', { idx });
    if (!response.success) {
      throw new Error(response.error || 'delete_channel failed');
    }
    await this.syncChannelsFromDevice();
  }

  /**
   * Read the device's channel list and mirror CONFIGURED slots into the
   * shared `channels` table, scoped by this manager's sourceId. The 16-byte
   * AES secret is stored base64-encoded in the existing `psk` column.
   * Meshtastic-only columns (role, uplinkEnabled, downlinkEnabled,
   * positionPrecision) are left null for MeshCore rows.
   *
   * Empty/unconfigured slots are filtered out. MeshCore Companion firmware
   * does NOT error when `GetChannel(idx)` is called on an unused slot — it
   * returns a success response with an empty name and an all-zero 16-byte
   * secret. meshcore.js's `getChannels()` enumerates until the firmware
   * errors, so without this filter the whole slot table (MAX_CHANNELS,
   * typically 40 on Companion builds) leaks into the UI.
   *
   * After syncing the configured slots we also delete any stale DB rows for
   * this source whose idx is no longer reported as configured by the
   * device — so an out-of-band delete via meshcore-cli is reflected on the
   * next sync, and a previous "leaked empty slots" install gets cleaned up.
   *
   * MeshCore has no push event for channel changes, so callers should invoke
   * this on connect and after every local write.
   */
  async syncChannelsFromDevice(): Promise<void> {
    const channels = await this.listChannels();
    const configured = channels.filter(ch => isConfiguredMeshCoreChannel(ch));

    for (const ch of configured) {
      const pskBase64 = ch.secretHex ? Buffer.from(ch.secretHex, 'hex').toString('base64') : null;
      await databaseService.channels.upsertChannel(
        {
          id: ch.channelIdx,
          name: ch.name,
          psk: pskBase64,
          // Meshtastic-only fields explicitly nulled for MeshCore rows
          role: null,
          uplinkEnabled: null,
          downlinkEnabled: null,
          positionPrecision: null,
        },
        this.sourceId,
        { allowBlankName: true },
      );
    }

    // Reconcile: remove DB rows for slots the device no longer treats as
    // configured. This covers (a) out-of-band deletes via meshcore-cli and
    // (b) cleanup of legacy installs that had unconfigured-slot rows from
    // before the filter landed.
    const configuredIdxSet = new Set(configured.map(ch => ch.channelIdx));
    const existing = await databaseService.channels.getAllChannels(this.sourceId);
    let removed = 0;
    for (const row of existing) {
      if (!configuredIdxSet.has(row.id)) {
        await databaseService.channels.deleteChannel(row.id, this.sourceId);
        removed++;
      }
    }

    logger.debug(
      `[MeshCore:${this.sourceId}] Synced ${configured.length} configured channel(s) from device ` +
      `(filtered out ${channels.length - configured.length} empty slot(s)` +
      (removed > 0 ? `, removed ${removed} stale DB row(s))` : ')'),
    );
  }

  // ============ Direct Serial Methods (for Repeater) ============

  /**
   * Connect via serial port directly (for Repeater detection)
   */
  private async connectSerialDirect(): Promise<void> {
    if (!this.config?.serialPort) {
      throw new Error('Serial port not configured');
    }

    if (!SerialPort || !ReadlineParser) {
      throw new Error('Serial port support not loaded');
    }

    const SerialPortClass = SerialPort;
    const ReadlineParserClass = ReadlineParser;

    await new Promise<void>((resolve, reject) => {
      this.serialPort = new SerialPortClass({
        path: this.config!.serialPort!,
        baudRate: this.config!.baudRate || 115200,
      });

      this.parser = this.serialPort.pipe(new ReadlineParserClass({ delimiter: '\n' }));

      this.serialPort.on('open', () => {
        logger.info(`[MeshCore] Serial port opened: ${this.config!.serialPort}`);
        resolve();
      });

      this.serialPort.on('error', (err: Error) => {
        logger.error('[MeshCore] Serial port error:', err);
        reject(err);
      });

      this.parser.on('data', (data: string) => {
        this.handleSerialData(data.trim());
      });
    });

    // Wake up the repeater CLI with a CR and discard any buffered data
    await new Promise<void>((resolve) => {
      this.serialPort!.write('\r');
      setTimeout(() => {
        this.serialPort!.flush(() => resolve());
      }, 500);
    });
  }

  /**
   * Close direct serial connection
   */
  private async closeSerialDirect(): Promise<void> {
    if (this.serialPort?.isOpen) {
      await new Promise<void>((resolve) => {
        this.serialPort!.close(() => resolve());
      });
    }
    this.serialPort = null;
    this.parser = null;
  }

  /**
   * Handle incoming serial data
   */
  private handleSerialData(data: string): void {
    logger.debug(`[MeshCore] RX: ${data}`);

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      this.emit('serial_data', data);
    }

    if (data.startsWith('MSG:')) {
      this.handleIncomingMessage(data);
    }
  }

  /**
   * Handle incoming message
   */
  private handleIncomingMessage(data: string): void {
    const match = data.match(/^MSG:([a-f0-9]+):(.+)$/i);
    if (match) {
      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: match[1],
        text: match[2],
        timestamp: Date.now(),
        sourceId: this.sourceId,
      };
      this.addMessage(message);
      this.emit('message', message);
      dataEventEmitter.emitMeshCoreMessage(message, this.sourceId);
      logger.debug(`[MeshCore] Message from ${match[1].substring(0, 8)}... (${match[2].length} chars)`);
    }
  }

  /**
   * Add message with limit to prevent unbounded growth
   */
  private addMessage(message: MeshCoreMessage): void {
    this.messages.push(message);
    if (this.messages.length > MeshCoreManager.MAX_MESSAGES) {
      this.messages = this.messages.slice(-MeshCoreManager.MAX_MESSAGES);
    }
    databaseService.meshcore.insertMessage(
      {
        id: message.id,
        fromPublicKey: message.fromPublicKey,
        fromName: message.fromName ?? null,
        toPublicKey: message.toPublicKey ?? null,
        text: message.text,
        timestamp: message.timestamp,
        rssi: message.rssi ?? null,
        snr: message.snr ?? null,
        messageType: message.messageType ?? 'text',
        sourceId: this.sourceId,
        hopCount: message.hopCount ?? null,
        routePath: message.routePath ?? null,
        scopeCode: message.scopeCode ?? null,
        scopeName: message.scopeName ?? null,
        createdAt: Date.now(),
      },
      this.sourceId,
    ).catch(err => {
      logger.warn(`[MeshCore:${this.sourceId}] Failed to persist message ${message.id}: ${(err as Error).message}`);
    });
  }

  /**
   * Send a command to Repeater firmware (text CLI).
   * Repeater CLI uses \r as line terminator and echoes the command back.
   * Response lines start with "  -> " prefix.
   */
  private async sendRepeaterCommand(command: string, timeout: number = 5000): Promise<string> {
    if (!this.serialPort?.isOpen) {
      throw new Error('Serial port not open');
    }

    return new Promise((resolve, reject) => {
      const cmdId = `cmd_${++this.commandId}`;
      const lines: string[] = [];
      let echoSeen = false;

      const timeoutHandle = setTimeout(() => {
        this.pendingCommands.delete(cmdId);
        this.removeListener('serial_data', dataHandler);
        // Resolve with whatever we have instead of rejecting on timeout,
        // since the repeater doesn't send an explicit end-of-response marker
        resolve(lines.join('\n').trim());
      }, timeout);

      const dataHandler = (data: string) => {
        // Skip the command echo
        if (!echoSeen && data.replace(/\r/g, '').trim() === command.trim()) {
          echoSeen = true;
          return;
        }

        lines.push(data);
        logger.debug(`[MeshCore] Response line: ${data}`);

        // Check for response terminators
        if (data.includes('-> >') || data.includes('OK') || data.includes('Error') || data.includes('Unknown command')) {
          clearTimeout(timeoutHandle);
          this.pendingCommands.delete(cmdId);
          this.removeListener('serial_data', dataHandler);
          resolve(lines.join('\n').trim());
        }
      };

      this.pendingCommands.set(cmdId, { resolve, reject, timeout: timeoutHandle });
      this.on('serial_data', dataHandler);

      logger.debug(`[MeshCore] TX: ${command}`);
      this.serialPort!.write(command + '\r');
    });
  }

  // ============ Validation Methods ============

  /**
   * Validate and sanitize serial port path
   */
  private sanitizeSerialPort(port: string): string {
    const validPatterns = [
      /^\/dev\/tty[A-Za-z0-9]+$/,
      /^\/dev\/[a-zA-Z][a-zA-Z0-9_-]*$/,
      /^\/dev\/cu\.[A-Za-z0-9_-]+$/,
      /^COM\d+$/i,
      /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
    ];

    const isValid = validPatterns.some(pattern => pattern.test(port));
    if (!isValid) {
      throw new Error(`Invalid serial port format: ${port}`);
    }
    return port;
  }

  /**
   * Sanitize a device-name input.
   *
   * Strips only control characters (C0 + DEL) — this removes CR/LF/tab that
   * would break the line-based repeater serial CLI (`set name <name>`) — while
   * preserving printable Unicode such as parentheses and emoji (#3450). The
   * previous `[^a-zA-Z0-9\s\-_]` allow-list silently deleted those characters on
   * save. The result is capped to the device name field by UTF-8 byte length,
   * truncating on a code-point boundary so a multi-byte character is never split.
   */
  private sanitizeName(name: string): string {
    // Drop only control characters (C0 controls + DEL) by code point — this
    // removes CR/LF/tab that would break the line-based repeater serial CLI —
    // while preserving printable Unicode such as parentheses and emoji (#3450).
    const cleaned = Array.from(name).filter((ch) => { const c = ch.codePointAt(0); return c !== undefined && c > 0x1f && c !== 0x7f; }).join('').trim();
    const sanitized = MeshCoreManager.truncateUtf8Bytes(cleaned, MeshCoreManager.NAME_MAX_BYTES);
    if (sanitized.length === 0) {
      throw new Error('Invalid name: must not be empty');
    }
    return sanitized;
  }

  /** Max device name length, in UTF-8 bytes (MeshCore advert name field). */
  private static readonly NAME_MAX_BYTES = 32;

  /**
   * Truncate `s` so its UTF-8 encoding is at most `maxBytes`, never splitting a
   * multi-byte character. Iterates by code point (so emoji surrogate pairs and
   * astral characters stay intact).
   */
  private static truncateUtf8Bytes(s: string, maxBytes: number): string {
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    let bytes = 0;
    let result = '';
    for (const ch of s) {
      const chBytes = Buffer.byteLength(ch, 'utf8');
      if (bytes + chBytes > maxBytes) break;
      bytes += chBytes;
      result += ch;
    }
    return result;
  }

  /**
   * Validate radio parameters
   */
  private validateRadioParams(freq: number, bw: number, sf: number, cr: number): void {
    if (!Number.isFinite(freq) || freq < 100 || freq > 1000) {
      throw new Error('Invalid frequency: must be between 100-1000 MHz');
    }
    if (!Number.isFinite(bw) || bw < 0 || bw > 1000) {
      throw new Error('Invalid bandwidth');
    }
    if (!Number.isInteger(sf) || sf < 5 || sf > 12) {
      throw new Error('Invalid spreading factor: must be 5-12');
    }
    if (!Number.isInteger(cr) || cr < 5 || cr > 8) {
      throw new Error('Invalid coding rate: must be 5-8');
    }
  }

  // ============ Public API Methods ============

  /**
   * Refresh local node information
   */
  async refreshLocalNode(): Promise<MeshCoreNode | null> {
    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      try {
        const nameResponse = await this.sendRepeaterCommand('get name');
        const radioResponse = await this.sendRepeaterCommand('get radio');

        logger.debug(`[MeshCore] Name response: ${JSON.stringify(nameResponse)}`);
        logger.debug(`[MeshCore] Radio response: ${JSON.stringify(radioResponse)}`);

        // Repeater CLI returns "  -> > DeviceName" format
        const nameMatch = nameResponse.match(/->\s*>\s*(.+)/);
        const radioMatch = radioResponse.match(/(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+),\s*(\d+)/);

        this.localNode = {
          publicKey: 'repeater',
          name: nameMatch ? nameMatch[1].trim() : 'Unknown Repeater',
          advType: MeshCoreDeviceType.REPEATER,
          radioFreq: radioMatch ? parseFloat(radioMatch[1]) : undefined,
          radioBw: radioMatch ? parseFloat(radioMatch[2]) : undefined,
          radioSf: radioMatch ? parseInt(radioMatch[3], 10) : undefined,
          radioCr: radioMatch ? parseInt(radioMatch[4], 10) : undefined,
        };
      } catch (error) {
        logger.error('[MeshCore] Failed to get repeater info:', error);
      }
    } else {
      // Companion: use the native backend
      try {
        const response = await this.sendBridgeCommand('get_self_info', {});
        if (response.success && response.data) {
          const info = response.data;
          this.localNode = {
            publicKey: info.public_key || '',
            name: info.name || 'Unknown',
            advType: info.adv_type || MeshCoreDeviceType.COMPANION,
            txPower: info.tx_power,
            maxTxPower: info.max_tx_power,
            radioFreq: info.radio_freq,
            radioBw: info.radio_bw,
            radioSf: info.radio_sf,
            radioCr: info.radio_cr,
            latitude: info.latitude,
            longitude: info.longitude,
            advLocPolicy: info.adv_loc_policy,
            manualAddContacts: info.manual_add_contacts,
            telemetryModeBase: parseTelemetryMode(info.telemetry_mode_base),
            telemetryModeLoc: parseTelemetryMode(info.telemetry_mode_loc),
            telemetryModeEnv: parseTelemetryMode(info.telemetry_mode_env),
          };
        }
      } catch (error) {
        logger.error('[MeshCore] Failed to get companion info:', error);
      }
    }

    return this.localNode;
  }

  /**
   * Schedule a coalesced contact-list refresh in response to a
   * `contact_path_updated` push (firmware's PUSH_CODE_PATH_UPDATED). The
   * push body carries only the affected pubkey, so we need to re-read the
   * contact record to learn the new path bytes. Multiple pushes inside
   * the {@link PATH_REFRESH_DEBOUNCE_MS} window collapse to a single
   * refreshContacts() call.
   *
   * Cleared on disconnect so a teardown can't fire a refresh against a
   * dead connection.
   */
  private schedulePathRefresh(publicKey: string): void {
    this.pathRefreshPendingKeys.add(publicKey);
    if (this.pathRefreshTimer !== null) {
      return; // already scheduled — the open window will pick this up
    }
    this.pathRefreshTimer = setTimeout(() => {
      this.pathRefreshTimer = null;
      const pending = Array.from(this.pathRefreshPendingKeys);
      this.pathRefreshPendingKeys.clear();
      logger.debug(
        `[MeshCore:${this.sourceId}] Refreshing contacts after ${pending.length} contact push(es) (path/new-node)`,
      );
      void this.refreshContacts()
        .then(() => {
          // refreshContacts() persists to DB but doesn't emit per-row
          // WS events. Emit one update per affected pubkey so the UI
          // flips the Hops/Path cells live without a full snapshot
          // reload. We only emit for pubkeys we know about post-refresh
          // — a path-update push for a contact that's since been
          // removed shouldn't manufacture a fake row.
          for (const key of pending) {
            const fresh = this.contacts.get(key);
            if (fresh) {
              this.emit('contacts_updated', { sourceId: this.sourceId, contact: fresh });
              dataEventEmitter.emitMeshCoreContactUpdated(fresh, this.sourceId);
            }
          }
        })
        .catch((err) => {
          logger.warn(
            `[MeshCore:${this.sourceId}] Path-refresh refreshContacts threw: ${(err as Error).message}`,
          );
        });
    }, MeshCoreManager.PATH_REFRESH_DEBOUNCE_MS);
  }

  /** Test/disconnect hook: cancel any scheduled path-refresh. */
  private clearPathRefreshTimer(): void {
    if (this.pathRefreshTimer !== null) {
      clearTimeout(this.pathRefreshTimer);
      this.pathRefreshTimer = null;
    }
    this.pathRefreshPendingKeys.clear();
  }

  /**
   * Refresh contacts list
   */
  async refreshContacts(): Promise<Map<string, MeshCoreContact>> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      return this.contacts;
    }

    try {
      const response = await this.sendBridgeCommand('get_contacts', {});
      // Only clear-and-replace when the device actually returned contacts. A
      // successful-but-empty `get_contacts` (seen as a transient read on a busy
      // companion, e.g. right after a reconnect or mid path-refresh) must NOT
      // wipe the known list — that would empty getAllNodes() down to just the
      // local node until adverts slowly refill it. Issue: MeshCore node list
      // intermittently collapses to 1 node. (DB rows survive either way; this
      // keeps the in-memory map authoritative too.)
      if (response.success && Array.isArray(response.data) && response.data.length > 0) {
        this.contacts.clear();
        const nowMs = Date.now();
        for (const c of response.data) {
          // Skip contacts the user just removed that still linger on the
          // companion's saved-contact list — re-adding them here is exactly
          // what resurrected deleted rows before (#3878). The tombstone expires
          // (or is cleared by a live advert), so a genuine re-add still syncs.
          if (this.isContactTombstoned(c.public_key)) continue;
          // Preserve the real Last Heard across reconnect (#3645). The companion
          // reports each contact's last advert time (epoch seconds) — use it for
          // lastSeen instead of the reconnect wall-clock, which previously reset
          // every node's Last Heard to "now". Falls back to now only when the
          // device didn't report an advert time. (Guard handles a value already
          // in ms, mirroring MeshCoreContactDetailPanel.)
          const advertSec = typeof c.last_advert === 'number' ? c.last_advert : 0;
          const advertMs = advertSec > 0
            ? (advertSec < 1e12 ? advertSec * 1000 : advertSec)
            : undefined;
          this.contacts.set(c.public_key, {
            publicKey: c.public_key,
            advName: c.adv_name,
            name: c.name,
            rssi: c.rssi,
            snr: c.snr,
            advType: c.adv_type,
            latitude: c.latitude,
            longitude: c.longitude,
            lastAdvert: advertSec > 0 ? advertSec : undefined,
            lastSeen: advertMs ?? nowMs,
            outPath: c.out_path ?? null,
            pathLen: c.path_len ?? null,
          });
        }
        // Mirror every contact to meshcore_nodes so stale stub rows
        // (publicKey-only seeds from setNodeTelemetryConfig) get their
        // advType backfilled on the next refresh. This is what backfills
        // existing deployments without requiring the user to retoggle
        // telemetry-retrieval — see issue #3092.
        await Promise.all(
          Array.from(this.contacts.values()).map((c) => this.persistContact(c)),
        );
        logger.debug(`[MeshCore] Refreshed ${this.contacts.size} contacts`);
      }
    } catch (error) {
      logger.error('[MeshCore] Failed to refresh contacts:', error);
    }

    return this.contacts;
  }

  /**
   * Pre-seed `this.contacts` from the persisted node list (the same DB the
   * node/map view reads) so the DM contact list isn't empty when the live
   * `get_contacts` sync degrades. Existing in-memory entries (e.g. a live
   * advert push that raced ahead) are left untouched. Companion-only — repeater
   * sources don't maintain a companion contact list. Non-fatal on DB error.
   */
  private async seedContactsFromDb(): Promise<void> {
    if (this.deviceType === MeshCoreDeviceType.REPEATER) return;
    try {
      const dbNodes = await databaseService.meshcore.getNodesBySource(this.sourceId);
      let seeded = 0;
      for (const n of dbNodes) {
        if (n.isLocalNode) continue;
        if (this.contacts.has(n.publicKey)) continue;
        this.contacts.set(n.publicKey, {
          publicKey: n.publicKey,
          advName: n.name ?? undefined,
          name: n.name ?? undefined,
          advType: (n.advType ?? undefined) as MeshCoreDeviceType | undefined,
          rssi: n.rssi ?? undefined,
          snr: n.snr ?? undefined,
          latitude: n.latitude ?? undefined,
          longitude: n.longitude ?? undefined,
          lastSeen: n.lastHeard ?? undefined,
          outPath: n.outPath ?? null,
          pathLen: n.pathLen ?? null,
        });
        seeded++;
      }
      if (seeded > 0) {
        logger.debug(`[MeshCore:${this.sourceId}] Seeded ${seeded} contact(s) from DB`);
      }
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] seedContactsFromDb failed: ${(err as Error).message}`);
    }
  }

  /**
   * Send a text message.
   *
   * - `toPublicKey` is set → direct message to that contact.
   * - `toPublicKey` unset and `channelIdx` set → broadcast on that channel.
   * - Both unset → broadcast on channel 0 (the firmware's primary "Public" slot).
   *
   * The locally-stored copy of an outgoing channel message gets its
   * `toPublicKey` stamped with the synthesized `channel-${idx}` pseudonym so
   * the per-channel filter in the frontend can distinguish "I sent this to
   * channel 1" from "I sent this to channel 0" — both used to be indistinguishable
   * when only channel 0 was supported (issue follow-up to MeshCore channels plan).
   */
  async sendMessage(text: string, toPublicKey?: string, channelIdx?: number, scopeOverride?: string | null, autoRetryOnMiss: boolean = false): Promise<boolean> {
    return (await this.sendMessageWithResult(text, toPublicKey, channelIdx, scopeOverride, autoRetryOnMiss)).ok;
  }

  /**
   * Like {@link sendMessage}, but returns the firmware-assigned `expectedAckCrc`
   * and `estTimeout` alongside the boolean. The Virtual Node bridge uses these
   * to tell a connected companion which CRC to expect in its `Sent` response and
   * to forward the later `SendConfirmed` push when the DM is acked (#3869).
   * `sendMessage` delegates here and discards the extra fields.
   */
  async sendMessageWithResult(text: string, toPublicKey?: string, channelIdx?: number, scopeOverride?: string | null, autoRetryOnMiss: boolean = false): Promise<MeshCoreSendResult> {
    if (!this.connected) {
      logger.error('[MeshCore] Not connected');
      return { ok: false };
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn('[MeshCore] Repeaters cannot send messages');
      return { ok: false };
    }

    // Serialise the scope-assert→send pair per source (#3667). The device's
    // flood scope is a single global setting; two concurrent sends with
    // different scopes must not interleave, or a message could ship under the
    // wrong region.
    //
    // `autoRetryOnMiss` (#3979) is a caller opt-in: automated senders pass it so
    // a zero-heard channel send is resent once. It is inert for DM sends and
    // when the global opt-in setting is off. This is NOT an auto-retry itself
    // (isAutoRetry=false) — that flag marks the resend leg only.
    return this.runSerialized(() => this.performScopedSend(text, toPublicKey, channelIdx, scopeOverride, false, autoRetryOnMiss));
  }

  /**
   * Normalise a per-message scope override (#3701): trim, strip a leading '#',
   * keep only letters/digits/hyphens (matching the channel/default scope
   * normalisation). The override is one-off — it is NOT persisted to the
   * channel row; the next normal send re-asserts the channel/default scope.
   *
   * Contract (#3704 review — kept unambiguous and aligned with the send route):
   *  - `undefined` OR `null` ⇒ NO override. The caller resolves the scope
   *    normally via {@link resolveScopeForSend} (channel → default → unscoped).
   *    The route collapses a JSON `null`/absent key to `undefined`, so both
   *    arrive here as "no override"; we treat them identically.
   *  - `''` or whitespace/punctuation-only ⇒ explicit UNSCOPED (returns `null`):
   *    the device flood scope is cleared for this one send.
   *  - a non-empty string ⇒ the normalised plain region name.
   *
   * Normalisation here is intentionally LENIENT (it strips invalid chars rather
   * than rejecting), unlike the persisted `POST /config/default-scope` setting
   * which returns 400. Rationale: the override is a transient one-off send, not
   * stored config, so silently sanitising is lower-risk than failing the send;
   * but we WARN when characters are dropped so the mangling isn't invisible
   * (#3704 review item 2). The send route still rejects non-string types and
   * over-length input up front, so only stray punctuation reaches this strip.
   */
  /**
   * Translate an automation's scope selection (#3833) into the `scopeOverride`
   * value `sendMessage` expects: `undefined` = inherit (channel/source default),
   * `''` = explicit unscoped, a non-empty string = a named region.
   *
   * `trigger` mode replies on the triggering message's own scope — its resolved
   * `scopeName` when known; otherwise `''` (unscoped). "Match the scope" can only
   * faithfully reproduce a scope we can name: the transport code is an HMAC keyed
   * by the region NAME, so without the name we cannot re-derive the code. Every
   * case where the region name is unavailable therefore degrades to unscoped
   * (#3998):
   *   - `scopeCode === 0`   → the trigger was confirmed unscoped.
   *   - `scopeCode == null` → scope resolution couldn't tell (no raw OTA bytes;
   *     `scopeCode`/`scopeName` are only recoverable when the packet was
   *     correlated from a preceding LogRxData event — best-effort, see
   *     meshcoreNativeBackend.ts), so a genuinely unscoped message is common here.
   *   - `scopeCode > 0` but no matching known region → the trigger WAS scoped, but
   *     to a region we can't name (e.g. a flood re-scoped by a repeater whose
   *     region isn't in our known set). We cannot reproduce it, and substituting
   *     the node's own DEFAULT scope is NOT "matching the trigger" — it floods
   *     under an unrelated region the original (unscoped) sender may not hear.
   *     Reply unscoped instead (#3998; previously inherited the default, #3887).
   */
  private static resolveAutomationScopeOverride(
    cfg: MeshCoreAutomationScopeConfig | undefined,
    triggerMsg?: MeshCoreMessage,
  ): string | null | undefined {
    switch (cfg?.scopeMode) {
      case 'unscoped':
        return '';
      case 'named':
        return (cfg.scopeName ?? '').trim() || undefined; // empty named → inherit
      case 'trigger': {
        if (!triggerMsg) return undefined; // no trigger message → inherit
        const name = (triggerMsg.scopeName ?? '').trim();
        if (name) return name; // resolved region name → match it exactly
        // No resolvable region name: confirmed unscoped (scopeCode 0), unresolvable
        // (scopeCode null), OR scoped to a region we can't name (scopeCode > 0, no
        // known match) — none can be reproduced, so reply unscoped rather than
        // substitute the node's unrelated default scope (#3998).
        return '';
      }
      default:
        return undefined; // inherit
    }
  }

  private static normalizeScopeOverride(scope: string | null | undefined): string | null | undefined {
    if (scope === undefined || scope === null) return undefined;
    const stripped = scope.trim().replace(/^#/, '');
    const normalized = stripped.replace(/[^0-9A-Za-z-]/g, '');
    if (normalized !== stripped) {
      logger.warn(
        `[MeshCore] Per-message scope override "${scope}" contained invalid characters; ` +
        `normalised to "${normalized || '(unscoped)'}"`,
      );
    }
    return normalized || null;
  }

  /**
   * Serialise an originated send on the per-source scope lock so the global
   * device flood scope can't be changed by another send mid-flight (#3667).
   * The lock chain continues on both success and failure so one failed send
   * can't wedge the queue.
   */
  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.sendScopeLock.then(fn);
    this.sendScopeLock = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Assert the source default scope on the device (serialised with all other
   * sends) and then run `fn`. For flood-originating traffic that is NOT a
   * channel message — adverts, logins, telemetry/CLI/stats requests
   * (#3667 phase 2). If the scope can't be asserted, `fn` does not run and the
   * error propagates, so nothing leaves un-scoped in a `region denyf *` mesh.
   * (Zero-hop traffic like node discovery is exempt — it is never repeater-
   * forwarded, so scope is irrelevant.)
   */
  private async sendWithDefaultScope<T>(fn: () => Promise<T>): Promise<T> {
    return this.runSerialized(async () => {
      await this.applyFloodScope(await this.resolveScopeForSend());
      return fn();
    });
  }

  /**
   * Resolve the effective MeshCore region/scope for an outbound send (#3667):
   * a channel's own scope overrides the source default scope; otherwise the
   * source default applies; otherwise unscoped. Returns the plain region name
   * (no leading '#') or null for unscoped.
   */
  private async resolveScopeForSend(channelIdx?: number): Promise<string | null> {
    if (channelIdx !== undefined) {
      const channel = await databaseService.channels.getChannelById(channelIdx, this.sourceId);
      const channelScope = (channel?.scope ?? '').trim();
      if (channelScope) return channelScope;
    }
    const def = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreDefaultScope')) ?? '';
    return def.trim() || null;
  }

  /**
   * Ensure the device's global flood scope matches `region` (null = unscoped),
   * sending a `set_flood_scope` bridge command only when it differs from the
   * cached value. On failure the cached scope is invalidated so the next send
   * re-asserts, and the error propagates.
   */
  private async applyFloodScope(region: string | null): Promise<void> {
    if (this.activeFloodScope === region) return;
    try {
      const resp = await this.sendBridgeCommand('set_flood_scope', { region });
      if (!resp.success) {
        throw new Error(resp.error || 'set_flood_scope failed');
      }
      this.activeFloodScope = region;
    } catch (err) {
      this.activeFloodScope = undefined;
      throw err;
    }
  }

  private async performScopedSend(
    text: string,
    toPublicKey?: string,
    channelIdx?: number,
    scopeOverride?: string | null,
    isAutoRetry: boolean = false,
    autoRetryOnMiss: boolean = false,
  ): Promise<MeshCoreSendResult> {
    try {
      const isChannelSend = !toPublicKey && channelIdx !== undefined;

      // Assert the effective region/scope on the device before sending (#3667).
      // DMs are scoped too, by design: MeshCore firmware applies the default
      // scope to DMs/logins/requests that flood (path unknown), so a DM in a
      // `region denyf *` mesh must carry the default scope or it is dropped.
      // When the DM has a known direct path the scope is simply inert. Setting
      // it changes the device's single global scope, but the activeFloodScope
      // cache + re-assert keeps a later channel send correct regardless.
      //
      // A per-message scope override (#3701) wins over the channel/default
      // scope for this one send only — it is NOT persisted, so the next normal
      // send re-asserts the channel/default scope. It still goes through
      // applyFloodScope inside runSerialized, so the scope-assert→send pair
      // stays atomic and the cache + re-assert invariants hold.
      const normalizedOverride = MeshCoreManager.normalizeScopeOverride(scopeOverride);
      const region = normalizedOverride !== undefined
        ? normalizedOverride
        : await this.resolveScopeForSend(isChannelSend ? channelIdx : undefined);
      await this.applyFloodScope(region);

      const response = await this.sendBridgeCommand('send_message', {
        text,
        to: toPublicKey || null,
        channel_idx: isChannelSend ? channelIdx : undefined,
      });

      if (response.success) {
        const ackCrc: number | null = response.data?.expectedAckCrc ?? null;
        const estTimeout: number | null = response.data?.estTimeout ?? null;
        logger.debug(`[MeshCore] Message sent (${text.length} chars) (ackCrc=${ackCrc}, estTimeout=${estTimeout})`);

        const sentToPublicKey = isChannelSend
          ? MeshCoreManager.channelPublicKey(channelIdx!)
          : (toPublicKey || undefined);

        const msgId = `sent-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        const sentMessage: MeshCoreMessage = {
          id: msgId,
          fromPublicKey: this.localNode?.publicKey || 'local',
          // Stamp our own display name so the Unified Messages feed labels
          // self-sent messages by name instead of falling back to the raw
          // public key (#4194). Received channel messages carry the sender
          // name inline via the "Name: " body prefix; our own sends have no
          // such prefix, so without this `fromName` the unified `senderLabel`
          // has nothing but `fromNodeId` (the full pubkey) to show.
          fromName: this.localNode?.name ?? undefined,
          toPublicKey: sentToPublicKey,
          text: text,
          timestamp: Date.now(),
          sourceId: this.sourceId,
          expectedAckCrc: ackCrc ?? undefined,
          estTimeout: estTimeout ?? undefined,
          // Record the region/scope this message was actually sent with (#3814)
          // so the UI can display it on the sent message — useful for diagnosing
          // why a scoped message may not have been received. `region` is the
          // resolved region NAME (channel scope / source default / per-message
          // override) or null when unscoped. We only set `scopeName`; the exact
          // numeric transport code is a payload-dependent HMAC that can't be
          // reconstructed post-send, and the UI gates the scope row on
          // `scopeName` presence (no magic-number sentinel needed). A normal
          // unscoped send leaves `scopeName` null, so it shows no scope row.
          scopeName: region ?? null,
        };
        // An auto-retry resend (#3977) must NOT create a second message row or
        // re-emit a `message` event — that would produce a duplicate bubble in
        // the UI and a duplicate DB row. The retry reuses the ORIGINAL message;
        // `handleDmAckTimeout` updates that message's tracked ack CRC instead.
        if (!isAutoRetry) {
          this.addMessage(sentMessage);
          this.emit('message', sentMessage);
          dataEventEmitter.emitMeshCoreMessage(sentMessage, this.sourceId);

          // Arm the DM ack-timeout retry state machine for the first attempt
          // (#3977). Not for channel sends (unacked). Subsequent attempts are
          // armed directly by `handleDmAckTimeout`, not here.
          if (!isChannelSend && toPublicKey && ackCrc != null && estTimeout != null) {
            this.scheduleDmAckTimeout(
              ackCrc,
              msgId,
              toPublicKey,
              text,
              estTimeout,
              MeshCoreManager.DM_SAME_PATH_RETRIES,
              MeshCoreManager.DM_FLOOD_RETRIES,
            );
          }
        }

        // Register this channel send for self-echo correlation (#3700): a
        // nearby repeater that re-floods our packet will be heard back as an
        // inbound GRP_TXT OTA packet within HEARD_WINDOW_MS, naming the
        // relaying repeaters in its path. DMs are excluded — they already get
        // a real ACK (send-confirmed).
        if (isChannelSend) {
          this.registerPendingChannelSend(msgId, channelIdx!, text);

          // Arm the automated channel-send auto-retry (#3979 Part 2) when the
          // caller opted in AND this is not itself a resend. Gated on the global
          // opt-in setting (default off). A resend (isAutoRetry=true) is
          // re-registered above for echo correlation but never re-armed, so at
          // most ONE retry ever fires per logical send.
          if (autoRetryOnMiss && !isAutoRetry) {
            await this.maybeArmChannelRetry(msgId, text, channelIdx!, scopeOverride);
          }
        }

        return { ok: true, expectedAckCrc: ackCrc ?? undefined, estTimeout: estTimeout ?? undefined };
      } else {
        logger.error('[MeshCore] Send failed:', response.error);
        return { ok: false };
      }
    } catch (error) {
      logger.error('[MeshCore] Failed to send message:', error);
      return { ok: false };
    }
  }

  /**
   * Margin applied to the firmware's `estTimeout` before a DM send is treated
   * as missed (#3977). Absorbs normal jitter; not itself a protocol constant.
   */
  private static readonly DM_ACK_TIMEOUT_MARGIN = 1.2;

  /**
   * Number of DM resends on the *current cached path* before falling back to
   * flood (#3977). Matches the official MeshCore app / firmware default
   * documented in MeshCore FAQ §5.3 ("the message will fail after 3 retries,
   * and the app will reset the path and send the message as flood on the last
   * retry"): 2 same-path retries + {@link DM_FLOOD_RETRIES} flood retry = 3
   * retries total (≈4 transmissions including the initial send).
   */
  private static readonly DM_SAME_PATH_RETRIES = 2;

  /**
   * Number of flood (reset-path) DM resends after the same-path retries are
   * exhausted (#3977). Per MeshCore FAQ §5.3 the app floods on the last retry
   * only, so the default is 1. The flood carries the source's default scope
   * (see {@link performScopedSend}); the recipient's ACK teaches the new path,
   * which the firmware auto-persists via the `contact_path_updated` push.
   */
  private static readonly DM_FLOOD_RETRIES = 1;

  /**
   * Arm (or re-arm) the ack-timeout retry timer for an in-flight DM attempt
   * (#3977). `ackCrc` is the firmware's expected-ack CRC for *this* attempt and
   * `estTimeout` its own timeout estimate; `samePathRetriesLeft` /
   * `floodRetriesLeft` carry the remaining budget forward across attempts.
   * Cleared early by the `send_confirmed` handler when the ack arrives, and in
   * bulk on disconnect. If an entry already exists for this `ackCrc` (the
   * firmware's CRC space is only 16 bits, so a collision between two in-flight
   * DMs is unlikely but possible) its timer is cancelled first so it can't fire
   * later with the wrong pending state.
   */
  private scheduleDmAckTimeout(
    ackCrc: number,
    messageId: string,
    toPublicKey: string,
    text: string,
    estTimeout: number,
    samePathRetriesLeft: number,
    floodRetriesLeft: number,
  ): void {
    const existing = this.pendingDmRetries.get(ackCrc);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.handleDmAckTimeout(ackCrc);
    }, Math.round(estTimeout * MeshCoreManager.DM_ACK_TIMEOUT_MARGIN));
    this.pendingDmRetries.set(ackCrc, {
      messageId,
      toPublicKey,
      text,
      samePathRetriesLeft,
      floodRetriesLeft,
      timer,
    });
  }

  /**
   * No ack arrived for a DM attempt within its estimated timeout (#3977).
   * Drives the official MeshCore retry cadence (FAQ §5.3):
   *   1. While same-path retries remain → resend on the current cached path.
   *   2. Once those exhaust, while flood retries remain → reset the cached path
   *      (same effect as the manual "Reset Path" button) and resend via flood
   *      with the default scope, letting the ACK teach a fresh path.
   *   3. When all retries are exhausted → mark the message failed.
   *
   * The resend reuses the ORIGINAL message (no new bubble / DB row): on success
   * the original message's tracked ack CRC is updated and the retry timer is
   * re-armed against the new CRC. The reset+resend pair runs inside
   * `runSerialized` (the same per-source lock `sendMessageWithResult` uses) so
   * it can't interleave with a concurrent user-initiated send's
   * scope-assert→send pair (#3667). `performScopedSend` is called directly
   * (already serialized by this call) with `isAutoRetry=true` so it neither
   * creates a new message nor re-arms the timer itself.
   */
  private async handleDmAckTimeout(ackCrc: number): Promise<void> {
    const pending = this.pendingDmRetries.get(ackCrc);
    if (!pending) return; // already acked (or manager torn down) — nothing to do
    this.pendingDmRetries.delete(ackCrc);

    if (!this.connected) {
      this.failDmDelivery(pending.messageId, ackCrc);
      return;
    }

    const useFlood = pending.samePathRetriesLeft <= 0;
    if (useFlood && pending.floodRetriesLeft <= 0) {
      // All same-path and flood retries exhausted — give up.
      logger.debug(
        `[MeshCore:${this.sourceId}] DM to ${pending.toPublicKey.substring(0, 16)}… still unacked after ` +
        `all retries; marking failed`,
      );
      this.failDmDelivery(pending.messageId, ackCrc);
      return;
    }

    logger.debug(
      `[MeshCore:${this.sourceId}] No ack for DM to ${pending.toPublicKey.substring(0, 16)}… within timeout; ` +
      `retrying via ${useFlood ? 'flood (reset path)' : 'current path'} ` +
      `(samePathLeft=${pending.samePathRetriesLeft}, floodLeft=${pending.floodRetriesLeft})`,
    );

    await this.runSerialized(async () => {
      if (!this.connected) {
        this.failDmDelivery(pending.messageId, ackCrc);
        return;
      }
      if (useFlood) {
        const reset = await this.resetContactPath(pending.toPublicKey);
        if (!reset) {
          // Can't clear the path → can't flood; nothing more to try.
          this.failDmDelivery(pending.messageId, ackCrc);
          return;
        }
      }
      const result = await this.performScopedSend(
        pending.text,
        pending.toPublicKey,
        undefined,
        undefined,
        true,
      );
      if (!result.ok || result.expectedAckCrc == null || result.estTimeout == null) {
        this.failDmDelivery(pending.messageId, ackCrc);
        return;
      }
      // Re-point tracking to this attempt's CRC and update the single bubble.
      this.updateDmAttempt(pending.messageId, ackCrc, result.expectedAckCrc, result.estTimeout);
      this.scheduleDmAckTimeout(
        result.expectedAckCrc,
        pending.messageId,
        pending.toPublicKey,
        pending.text,
        result.estTimeout,
        useFlood ? pending.samePathRetriesLeft : pending.samePathRetriesLeft - 1,
        useFlood ? pending.floodRetriesLeft - 1 : pending.floodRetriesLeft,
      );
    });
  }

  /**
   * A DM retry attempt was sent (#3977). Update the ORIGINAL message so the UI
   * keeps a single bubble that now tracks the new attempt's ack CRC — a later
   * `send_confirmed` for `newAckCrc` flips it to `delivered`, and the frontend
   * re-arms its own per-message fail timer against the new CRC (clearing the
   * previous one). Keeps the in-memory copy's CRC in sync too, so a reconnect
   * snapshot / a `send_confirmed` correlates against the current attempt.
   */
  private updateDmAttempt(
    messageId: string,
    previousAckCrc: number,
    newAckCrc: number,
    newEstTimeout: number,
  ): void {
    const msg = this.messages.find((m) => m.id === messageId);
    if (msg) {
      msg.expectedAckCrc = newAckCrc;
      msg.estTimeout = newEstTimeout;
    }
    dataEventEmitter.emitMeshCoreMessageUpdated(
      {
        id: messageId,
        previousAckCrc,
        expectedAckCrc: newAckCrc,
        estTimeout: newEstTimeout,
        deliveryStatus: 'sent',
      },
      this.sourceId,
    );
  }

  /**
   * All DM retries for a message are exhausted (or the send couldn't be made) —
   * mark it failed in the UI (#3977). Clears the frontend's fail timer for the
   * last attempt's CRC so the single bubble settles on `failed` deterministically
   * rather than relying on that timer to eventually fire.
   */
  private failDmDelivery(messageId: string, lastAckCrc: number): void {
    dataEventEmitter.emitMeshCoreMessageUpdated(
      { id: messageId, previousAckCrc: lastAckCrc, deliveryStatus: 'failed' },
      this.sourceId,
    );
  }

  /**
   * Arm the automated channel-send auto-retry timer for a just-sent channel
   * message (#3979 Part 2), IFF the global opt-in setting is enabled. Reads the
   * setting here (not at the call site) so the check is co-located with the
   * arming and stays consistent across all automated senders. One entry per
   * outgoing message id; a 30s timer that, on fire, resends once only when zero
   * repeaters were heard.
   */
  private async maybeArmChannelRetry(
    messageId: string,
    text: string,
    channelIdx: number,
    scopeOverride: string | null | undefined,
  ): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await databaseService.settings.getSettingAsBoolean('meshcoreChannelRetryEnabled', false);
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] channel-retry setting read failed: ${(err as Error).message}`);
      return;
    }
    if (!enabled) return;

    const existing = this.pendingChannelRetries.get(messageId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.handleChannelRetryTimeout(messageId);
    }, MeshCoreManager.CHANNEL_RETRY_WINDOW_MS);
    this.pendingChannelRetries.set(messageId, {
      text,
      channelIdx,
      scopeOverride,
      retriesLeft: 1,
      timer,
    });
  }

  /**
   * The channel-send retry window elapsed (#3979 Part 2). If NO repeater was
   * heard re-flooding this message (per the Part 1 echo-attribution, #3987),
   * the send likely reached no one, so resend it exactly ONCE. The resend goes
   * through `performScopedSend` with `isAutoRetry=true` (no new message row / no
   * `message` event / no re-entry onto the data bus, so it can't spawn a fresh
   * automation trigger) and `autoRetryOnMiss=false` (so it re-registers for echo
   * correlation but never arms a second retry — one-shot). Runs inside
   * `runSerialized` so the scope-assert→send pair can't interleave with a
   * concurrent send (#3667).
   */
  private async handleChannelRetryTimeout(messageId: string): Promise<void> {
    const pending = this.pendingChannelRetries.get(messageId);
    if (!pending) return; // already cleared (disconnect) — nothing to do
    this.pendingChannelRetries.delete(messageId);

    if (!this.connected) return; // torn-down connection can't resend

    // Point-in-time read of the heard-repeater set for this message. The echo
    // handler (`correlateChannelEcho`) awaits its DB write before returning, and
    // the retry window equals the echo-attribution window, so any repeater heard
    // for a genuine echo is already persisted by now. A repeater heard AFTER
    // this read (extremely-late echo) at worst yields one accepted duplicate,
    // which the opt-in explicitly tolerates.
    let heardCount: number;
    try {
      const heard = await databaseService.meshcore.getHeardRepeatersForMessage(messageId, this.sourceId);
      heardCount = heard.length;
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] channel-retry heard-count read failed: ${(err as Error).message}`);
      return; // can't confirm a miss → don't risk a needless duplicate
    }

    if (heardCount > 0) {
      logger.debug(
        `[MeshCore:${this.sourceId}] Channel send ${messageId} heard by ${heardCount} repeater(s) within window; no retry`,
      );
      return;
    }
    if (pending.retriesLeft <= 0) return; // defensive: one-shot already spent

    logger.debug(
      `[MeshCore:${this.sourceId}] Channel send ${messageId} heard ZERO repeaters within ` +
      `${MeshCoreManager.CHANNEL_RETRY_WINDOW_MS / 1000}s; resending once (auto-retry #3979)`,
    );

    await this.runSerialized(async () => {
      if (!this.connected) return;
      // isAutoRetry=true: no new bubble / no bus re-entry / no automation re-trigger.
      // autoRetryOnMiss=false: re-register for echo correlation but never re-arm.
      await this.performScopedSend(
        pending.text,
        undefined,
        pending.channelIdx,
        pending.scopeOverride,
        true,
        false,
      );
    });
  }

  /**
   * Send an advert
   */
  async sendAdvert(): Promise<boolean> {
    if (!this.connected) {
      return false;
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      try {
        await this.sendRepeaterCommand('advert');
        logger.debug('[MeshCore] Advert sent (Repeater)');
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to send advert:', error);
        return false;
      }
    } else {
      try {
        // Adverts flood, so they carry the default scope (#3667). Repeaters
        // (handled above) scope via their own `region` config instead.
        const response = await this.sendWithDefaultScope(() => this.sendBridgeCommand('send_advert', {}));
        if (response.success) {
          logger.debug('[MeshCore] Advert sent (Companion)');
          return true;
        }
        return false;
      } catch (error) {
        logger.error('[MeshCore] Failed to send advert:', error);
        return false;
      }
    }
  }

  /**
   * Reset the cached forwarding route ("out_path") for a contact so the
   * next send re-discovers the route via flooding. Wraps the firmware's
   * CMD_RESET_PATH; on success the in-memory contact + meshcore_nodes row
   * are cleared so the UI reflects the new state without waiting for a
   * PathUpdated push.
   *
   * Returns `true` on success, `false` if the device rejected the request
   * (unknown contact, transient backend error) or this isn't a Companion.
   */
  async resetContactPath(publicKey: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Reset-path requires Companion firmware');
      return false;
    }
    if (!this.connected) {
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('reset_path', { public_key: publicKey });
      if (!response.success) {
        logger.warn(`[MeshCore] reset_path failed for ${publicKey}: ${response.error}`);
        return false;
      }
      const existing = this.contacts.get(publicKey);
      if (existing) {
        const updated: MeshCoreContact = {
          ...existing,
          outPath: null,
          pathLen: null,
          lastSeen: Date.now(),
        };
        this.contacts.set(publicKey, updated);
        void this.persistContact(updated);
        this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
        dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
      }
      logger.debug(`[MeshCore] Reset path for ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] resetContactPath threw:', error);
      return false;
    }
  }

  /**
   * Send a path-discovery request (firmware CMD 52) for a contact. This
   * floods a lightweight telemetry request to the contact; when the
   * response arrives, the firmware learns the forwarding route via its
   * normal PATH return mechanism and fires a PathUpdated push. The path
   * update is handled asynchronously by the existing push listener —
   * this method only confirms the flood was accepted by the device.
   */
  async discoverContactPath(publicKey: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Discover-path requires Companion firmware');
      return false;
    }
    if (!this.connected) {
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('discover_path', { public_key: publicKey }, 15000);
      if (!response.success) {
        logger.warn(`[MeshCore] discover_path failed for ${publicKey}: ${response.error}`);
        return false;
      }
      logger.debug(`[MeshCore] Path discovery sent for ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] discoverContactPath threw:', error);
      return false;
    }
  }

  /**
   * Active node discovery ("Discover Nearby Nodes" / "Discover Repeaters").
   * Broadcasts a zero-hop NODE_DISCOVER_REQ (CMD 55) with a node-type filter;
   * nodes in DIRECT radio range whose type matches reply (also zero-hop,
   * rate-limited and jittered by firmware) over the next few seconds. Each
   * responder is auto-added as a contact by the native backend and mirrored
   * here via the `node_discovered` bridge event. Resolves after the collection
   * window with the count of unique responders and how many were new.
   *
   * Companion-only — repeaters/room servers cannot initiate discovery.
   *
   * @param filter  bitmask of (1 << ADV_TYPE); see `MeshCoreDiscoverFilter`.
   * @param windowMs how long to collect responses before resolving (default 8s).
   */
  async discoverNodes(
    filter: number,
    windowMs: number = 8000,
    fetchNames: boolean = false,
  ): Promise<{ returned: number; newCount: number; seen: string[] }> {
    const empty = { returned: 0, newCount: 0, seen: [] as string[] };
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Node discovery requires Companion firmware');
      return empty;
    }
    if (!this.connected) {
      return empty;
    }
    // 32-bit correlation tag so responses can be matched to this request.
    const tag = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.activeDiscovery = { seen: new Set(), returned: 0, newCount: 0 };
    try {
      const response = await this.sendBridgeCommand('discover_nodes', { filter, tag }, 15000);
      if (!response.success) {
        logger.warn(`[MeshCore] discover_nodes failed (filter=0x${filter.toString(16)}): ${response.error}`);
        return empty;
      }
      logger.debug(
        `[MeshCore] Node discovery sent (filter=0x${filter.toString(16)}, tag=${tag}); ` +
        `collecting for ${windowMs}ms`,
      );
      await new Promise<void>(resolve => setTimeout(resolve, windowMs));
      const result = {
        returned: this.activeDiscovery.returned,
        newCount: this.activeDiscovery.newCount,
        // Snapshot the public keys that responded to this sweep (insertion
        // order = arrival order) so callers like discoverRegions() can target
        // only the current 0-hop set (#3743).
        seen: [...this.activeDiscovery.seen],
      };
      logger.debug(`[MeshCore] Node discovery complete: ${result.returned} returned, ${result.newCount} new`);

      // #3820: a NODE_DISCOVER_RESP carries no name, and the device's contact
      // record stays nameless until the repeater adverts — which a zero-hop
      // repeater may do only rarely (observed: >30 min). When the caller opts in
      // (the user-facing "Discover" action), actively pull each discovered
      // repeater/room-server's name now via an unauthenticated ANON_REQ OWNER, so
      // names populate in seconds instead of waiting on an advert. Skipped for
      // the internal region-discovery sweep, which has its own per-repeater pass.
      if (fetchNames) {
        for (const publicKey of result.seen) {
          const contact = this.contacts.get(publicKey);
          const isRepeaterish =
            contact?.advType === MeshCoreDeviceType.REPEATER ||
            contact?.advType === MeshCoreDeviceType.ROOM_SERVER;
          if (isRepeaterish && !contact?.advName) {
            await this.fetchOwnerName(publicKey);
          }
        }
      }

      return result;
    } catch (error) {
      logger.error('[MeshCore] discoverNodes threw:', error);
      return empty;
    } finally {
      this.activeDiscovery = null;
    }
  }

  /**
   * Fetch a repeater/room-server's node name WITHOUT admin login (#3820), via an
   * unauthenticated ANON_REQ OWNER (firmware simple_repeater `handleAnonOwnerReq`
   * returns `node_name\nowner_info`). The firmware OWNER branch only answers a
   * DIRECT-routed request, so — exactly like discoverRegions (#3743) — we install
   * a zero-hop direct out_path first (the discovered node is a direct neighbour).
   * On success the name is written onto the contact and broadcast. Best-effort:
   * any failure (timeout, no reply, non-repeater) is swallowed with a debug log,
   * since the passive advert path (refresh on advert) remains as a fallback.
   */
  async fetchOwnerName(publicKey: string): Promise<string | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    try {
      // Install a zero-hop direct out_path so the ANON_REQ routes direct instead
      // of flooding into the void (firmware drops flooded OWNER reqs). Best-effort
      // and quick; the real success signal is the request_owner reply below.
      const routed = await this.setContactOutPath(publicKey, new Uint8Array(0), 1, 3000);
      if (!routed) {
        logger.debug(`[MeshCore:${this.sourceId}] set_out_path ack not seen for ${publicKey.substring(0, 12)}… (route likely applied); proceeding`);
      }
      const resp = await this.sendBridgeCommand('request_owner', { public_key: publicKey }, 15_000);
      if (!resp.success) {
        logger.debug(`[MeshCore:${this.sourceId}] owner request to ${publicKey.substring(0, 12)}… returned an error: ${resp.error}`);
        return null;
      }
      const name = typeof resp.data?.name === 'string' ? resp.data.name.trim() : '';
      if (!name) return null;
      const existing = this.contacts.get(publicKey) ?? { publicKey };
      const updated: MeshCoreContact = {
        ...existing,
        publicKey,
        advName: name,
        lastSeen: Date.now(),
      };
      this.contacts.set(publicKey, updated);
      void this.persistContact(updated);
      this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
      dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
      logger.debug(`[MeshCore:${this.sourceId}] Owner-name fetched for ${publicKey.substring(0, 16)}…: "${name}" (#3820)`);
      return name;
    } catch (err) {
      logger.debug(`[MeshCore:${this.sourceId}] owner-name fetch failed for ${publicKey.substring(0, 12)}…: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Whether this node currently answers inbound discovery requests (is
   * discoverable by others). Reads the persisted per-source preference.
   */
  async getRespondToDiscovery(): Promise<boolean> {
    return (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreRespondToDiscovery')) === 'true';
  }

  /**
   * Enable/disable answering inbound discovery requests. Persists the per-source
   * preference and applies it to the live backend (companion-only — repeaters
   * already self-respond in firmware).
   */
  async setRespondToDiscovery(enabled: boolean): Promise<void> {
    await databaseService.settings.setSourceSetting(this.sourceId, 'meshcoreRespondToDiscovery', enabled ? 'true' : 'false');
    this.nativeBackend?.setRespondToDiscovery(enabled);
    logger.info(`[MeshCore:${this.sourceId}] Discovery responder ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * The per-source default MeshCore region/scope (#3667). Applied to all
   * originated flood traffic that has no channel-specific scope. Empty string
   * means unscoped (legacy null '*' region).
   */
  async getDefaultScope(): Promise<string> {
    return ((await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreDefaultScope')) ?? '').trim();
  }

  /**
   * Set the per-source default region/scope. Pass '' to clear (unscoped).
   * Stored without a leading '#'. Invalidates the cached device flood scope so
   * the next send re-asserts under the new default.
   */
  async setDefaultScope(scope: string): Promise<string> {
    const normalized = (scope || '').trim().replace(/^#/, '');
    await databaseService.settings.setSourceSetting(this.sourceId, 'meshcoreDefaultScope', normalized);
    this.activeFloodScope = undefined;
    void this.refreshKnownScopes();
    logger.info(`[MeshCore:${this.sourceId}] Default scope set to ${normalized || '(unscoped)'}`);
    return normalized;
  }

  /**
   * Rebuild the {@link knownScopes} cache from this source's per-channel scopes,
   * the default scope, and the global saved-regions catalog (#3742 Phase 2,
   * #3829). Best-effort: a failure leaves the previous cache in place and never
   * breaks the message stream.
   */
  private async refreshKnownScopes(): Promise<void> {
    try {
      const names = new Set<string>();
      const channels = await databaseService.channels.getAllChannels(this.sourceId);
      for (const ch of channels) {
        const s = (ch.scope ?? '').trim();
        if (s) names.add(s);
      }
      const def = (await this.getDefaultScope()).trim();
      if (def) names.add(def);
      // Include the global saved-regions catalog so users who add a region there
      // see it resolved in inbound messages even if it isn't the default scope
      // or a per-channel scope (#3829).
      const savedRegions = await databaseService.savedRegions.getAllAsync();
      for (const region of savedRegions) {
        const s = (region.name ?? '').trim();
        if (s) names.add(s);
      }
      this.knownScopes = names;
    } catch (err) {
      logger.debug(`[MeshCore:${this.sourceId}] refreshKnownScopes failed: ${(err as Error).message}`);
    }
  }

  /**
   * Trigger a scope-cache rebuild on this manager. Call whenever the global
   * saved-regions catalog changes, since those names feed into scope resolution
   * for inbound messages (#3829).
   */
  notifySavedRegionsChanged(): void {
    void this.refreshKnownScopes();
  }

  /**
   * Discover the region/scope names served by nearby repeaters (#3667 phase 3,
   * refined in #3743).
   *
   * Rather than querying every repeater ever seen (including far-away ones that
   * just waste a 20s timeout), this first runs a 0-hop discovery sweep and only
   * queries the repeaters / room-servers that answered it, in arrival order. If
   * the first sweep finds no 0-hop repeaters it retries once (a repeater may
   * have been busy); if the retry is also empty it returns `noZeroHopRepeaters`
   * so the caller can tell the user, rather than silently querying everyone.
   *
   * Region queries are issued sequentially: the firmware's per-request `tag`
   * only arrives on the `Sent` ack, so overlapping requests could cross-match
   * replies. The wildcard `*` (null region) is filtered out — it isn't a
   * selectable scope. Repeaters that don't answer in time are skipped.
   */
  async discoverRegions(): Promise<{
    regions: string[];
    perRepeater: Array<{ publicKey: string; name: string; regions: string[] }>;
    noZeroHopRepeaters?: boolean;
  }> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      return { regions: [], perRepeater: [] };
    }

    // 1. Run a 0-hop discovery sweep and resolve it to the subset of known
    //    repeater/room-server contacts that answered, ordered by arrival.
    //    Repeaters (2) + room servers (3) → filter bitmask 0x0C.
    const REPEATER_FILTER =
      (1 << MeshCoreDeviceType.REPEATER) | (1 << MeshCoreDeviceType.ROOM_SERVER);
    const sweepZeroHopRepeaters = async () => {
      const { seen } = await this.discoverNodes(REPEATER_FILTER, 8000);
      if (seen.length === 0) return [];
      const order = new Map(seen.map((k, i) => [k, i]));
      return [...this.contacts.values()]
        .filter(
          (c) =>
            (c.advType === MeshCoreDeviceType.REPEATER ||
              c.advType === MeshCoreDeviceType.ROOM_SERVER) &&
            order.has(c.publicKey),
        )
        .sort((a, b) => (order.get(a.publicKey)! - order.get(b.publicKey)!));
    };

    // First attempt; on an empty result retry once before giving up (#3743).
    let repeaters = await sweepZeroHopRepeaters();
    if (repeaters.length === 0) {
      logger.debug(`[MeshCore:${this.sourceId}] No 0-hop repeaters on first sweep; retrying once`);
      repeaters = await sweepZeroHopRepeaters();
    }
    if (repeaters.length === 0) {
      logger.debug(`[MeshCore:${this.sourceId}] No 0-hop repeaters found after retry`);
      return { regions: [], perRepeater: [], noZeroHopRepeaters: true };
    }

    const perRepeater: Array<{ publicKey: string; name: string; regions: string[] }> = [];
    const all = new Set<string>();
    for (const r of repeaters) {
      try {
        // v1.15+ repeaters answer a regions ANON_REQ only when it arrives via a
        // DIRECT route — firmware simple_repeater `onAnonDataRecv` gates the
        // REGIONS branch on `packet->isRouteDirect()` and silently drops flooded
        // ones (login is the lone flood-exception, which is why admin CLI works
        // but Discover Regions didn't). The companion floods whenever the contact
        // has no installed `out_path` (`sendAnonReq`: out_path_len == 0xFF). Since
        // the 0-hop discovery sweep above only hears DIRECT-range repeaters, each
        // one here is a direct neighbour — install a zero-hop direct out_path so
        // the request routes direct instead of flooding into the void (#3743).
        // Best-effort and quick: the device applies the CMD_ADD_UPDATE_CONTACT
        // write even when its Ok ack is lost in the post-sweep radio chatter
        // (meshcore.js resolves on Ok, so it reports a timeout while the route
        // is in fact installed). The real success signal is the request_regions
        // reply below, so use a short window and don't alarm on a missed ack.
        const routed = await this.setContactOutPath(r.publicKey, new Uint8Array(0), 1, 3000);
        if (!routed) {
          logger.debug(`[MeshCore:${this.sourceId}] set_out_path ack not seen for ${r.publicKey.substring(0, 12)}… (route still likely applied); proceeding`);
        }
        const resp = await this.sendBridgeCommand('request_regions', { public_key: r.publicKey }, 20_000);
        if (!resp.success) {
          logger.debug(`[MeshCore:${this.sourceId}] regions request to ${r.publicKey.substring(0, 12)}… returned an error: ${resp.error}`);
          continue;
        }
        const regions: string[] = (Array.isArray(resp.data?.regions) ? resp.data.regions : [])
          .map((x: unknown) => String(x).trim())
          .filter((x: string) => x.length > 0 && x !== '*');
        perRepeater.push({ publicKey: r.publicKey, name: r.name || r.advName || r.publicKey.substring(0, 12), regions });
        regions.forEach((x) => all.add(x));
      } catch (err) {
        logger.debug(`[MeshCore:${this.sourceId}] regions request to ${r.publicKey.substring(0, 12)}… failed: ${(err as Error).message}`);
      }
    }
    return { regions: [...all].sort((a, b) => a.localeCompare(b)), perRepeater };
  }

  /**
   * Trace the cached forwarding path to a contact, collecting per-hop SNR.
   * The contact must have a known `outPath`; trace path sends a diagnostic
   * packet along that exact route and each repeater appends its received
   * SNR. Returns the per-hop SNR array plus the final-hop SNR, or `null`
   * on failure (no path, timeout, not Companion).
   */
  async traceContactPath(publicKey: string): Promise<{
    hops: { index: number; snr: number }[];
    lastSnr: number;
  } | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Trace-path requires Companion firmware');
      return null;
    }
    if (!this.connected) {
      return null;
    }
    const contact = this.contacts.get(publicKey);
    if (!contact?.outPath || contact.pathLen == null || contact.pathLen <= 0) {
      logger.warn(`[MeshCore] Trace-path: no known path for ${publicKey.substring(0, 16)}…`);
      return null;
    }
    // Expand each comma-separated hop token into its constituent bytes so
    // multi-byte hops (e.g. "a3f2") yield [0xa3, 0xf2] rather than being
    // truncated to a single byte by parseInt. 1-byte paths are unaffected.
    const pathBytes = Uint8Array.from(
      contact.outPath.split(',').flatMap((h) => {
        const tok = h.trim();
        const bytes: number[] = [];
        for (let i = 0; i + 2 <= tok.length; i += 2) {
          bytes.push(parseInt(tok.slice(i, i + 2), 16));
        }
        return bytes;
      }),
    );
    try {
      const response = await this.sendBridgeCommand('trace_path', {
        path: pathBytes,
      }, 60000);
      if (!response.success) {
        logger.warn(`[MeshCore] trace_path failed for ${publicKey}: ${response.error}`);
        return null;
      }
      const d = response.data ?? {};
      const snrs: number[] = d.pathSnrs ?? [];
      const hops = snrs.map((raw: number, i: number) => ({
        index: i,
        snr: raw / 4,
      }));
      const lastSnr: number = d.lastSnr ?? 0;
      logger.debug(`[MeshCore] Trace path to ${publicKey.substring(0, 16)}…: ${hops.length} hops, lastSnr=${lastSnr}`);
      return { hops, lastSnr };
    } catch (error) {
      logger.error('[MeshCore] traceContactPath threw:', error);
      return null;
    }
  }

  /**
   * Trace an explicit path (raw hop hashes) and return the raw SNR results
   * (issue #3904). Unlike {@link traceContactPath}, which looks up a contact's
   * saved out-path by public key, this takes the path bytes directly — used by
   * the Virtual Node to forward an app's SendTracePath frame, which carries its
   * own path (and its own tag, which the caller echoes back in the push).
   * `lastSnr` is returned already divided by 4 (dB), matching traceContactPath.
   */
  async tracePathRaw(
    path: Uint8Array,
  ): Promise<{ pathSnrs: number[]; lastSnr: number; pathLen: number; flags: number } | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    if (!this.connected) return null;
    if (!path || path.length === 0) return null;
    try {
      // No sendWithDefaultScope wrapper (unlike requestRemoteTelemetryRaw): a
      // trace follows the explicit path it is given rather than flooding on an
      // unknown route, so it does not need the default flood scope asserted
      // first. Mirrors traceContactPath, which also calls the bridge directly.
      const response = await this.sendBridgeCommand('trace_path', { path }, 60_000);
      if (!response.success) {
        logger.warn(`[MeshCore:${this.sourceId}] tracePathRaw failed: ${response.error}`);
        return null;
      }
      this.recordMeshTx();
      const d = response.data ?? {};
      return {
        pathSnrs: Array.isArray(d.pathSnrs) ? (d.pathSnrs as number[]) : [],
        lastSnr: typeof d.lastSnr === 'number' ? d.lastSnr : 0,
        pathLen: typeof d.pathLen === 'number' ? d.pathLen : path.length,
        flags: typeof d.flags === 'number' ? d.flags : 0,
      };
    } catch (error) {
      logger.error('[MeshCore] tracePathRaw threw:', error);
      return null;
    }
  }

  /**
   * Broadcast the device's saved advert for a contact as a zero-hop frame
   * so nearby nodes can add this contact themselves. Wraps the firmware's
   * CMD_SHARE_CONTACT; the device only retransmits — no local state is
   * mutated, so this method does not touch contacts or meshcore_nodes.
   *
   * Returns `{ ok: true }` on success. On failure `ok` is false and `error`
   * carries an actionable reason (not a Companion, disconnected, device
   * rejected, or no response) so the route and UI can surface it instead of a
   * generic string. The underlying meshcore.js call rejects with no argument
   * on a firmware Err, so the descriptive text is manufactured here / in the
   * native backend rather than read from the device.
   */
  async shareContact(publicKey: string): Promise<ShareContactResult> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Share-contact requires Companion firmware');
      return { ok: false, error: 'Share contact requires MeshCore Companion firmware.' };
    }
    if (!this.connected) {
      return { ok: false, error: 'Source is disconnected.' };
    }
    try {
      // Use a short dedicated timeout (not the 30s default) so a firmware that
      // never acks CMD_SHARE_CONTACT fails fast instead of hanging the request.
      const response = await this.sendBridgeCommand('share_contact', { public_key: publicKey }, 10_000);
      if (!response.success) {
        const raw = response.error ?? '';
        const friendly = /timeout/i.test(raw)
          ? 'Device did not respond to share-contact within 10s — the firmware may not support this command.'
          : raw && raw !== 'undefined'
            ? raw
            : 'Device rejected share-contact — the firmware may not support this command.';
        logger.warn(`[MeshCore] share_contact failed for ${publicKey}: ${friendly}`);
        return { ok: false, error: friendly };
      }
      logger.debug(`[MeshCore] Shared contact ${publicKey.substring(0, 16)}…`);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('[MeshCore] shareContact threw:', error);
      return { ok: false, error: `Share contact failed: ${msg}` };
    }
  }

  /**
   * Manually push a forwarding route ("out_path") into the device's
   * contact record. Wraps meshcore.js setContactPath via the
   * `set_out_path` bridge command, which preserves all other contact
   * fields and only mutates outPath + outPathLen.
   *
   * Stale hops silently drop direct sends — this is gated by the
   * advanced settings toggle at the route layer.
   *
   * `outPathBytes` must be 0..64 bytes; an empty array sets path-len 0
   * (zero-hop direct), which is distinct from RESET_PATH's
   * OUT_PATH_UNKNOWN sentinel.
   *
   * On success the in-memory contact + meshcore_nodes row are mirrored
   * so the UI reflects the new state without waiting for a PathUpdated
   * push.
   *
   * Returns `true` on success, `false` if the device rejected the
   * request or this isn't a connected Companion.
   */
  async setContactOutPath(
    publicKey: string,
    outPathBytes: Uint8Array,
    hashBytes: 1 | 2 | 3 = 1,
    timeoutMs: number = 12000,
  ): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Set-out-path requires Companion firmware');
      return false;
    }
    if (!this.connected) {
      return false;
    }
    if (outPathBytes.length > 64) {
      logger.warn(`[MeshCore] Set-out-path rejected: ${outPathBytes.length} > 64 bytes`);
      return false;
    }
    if (outPathBytes.length % hashBytes !== 0) {
      logger.warn(`[MeshCore] Set-out-path rejected: ${outPathBytes.length} bytes not a multiple of hashBytes ${hashBytes}`);
      return false;
    }
    try {
      // 12 s is generous for a single serial write; fail fast so the UI
      // doesn't leave the user stuck waiting for an unresponsive device.
      const response = await this.sendBridgeCommand('set_out_path', {
        public_key: publicKey,
        out_path: outPathBytes,
        hash_bytes: hashBytes,
      }, timeoutMs);
      if (!response.success) {
        // NOTE: matches on meshcore.js's timeout error text — fragile if the
        // library changes its wording; revisit if a structured error code lands.
        const isTimeout = response.error?.includes('timeout');
        if (isTimeout) {
          // meshcore.js resolves CMD_ADD_UPDATE_CONTACT on its Ok ack, which is
          // frequently lost in unrelated radio chatter even though the device
          // applied the write. Treat a timeout as a non-fatal "ack not seen" —
          // not a connectivity error — so it doesn't spam warnings on a path
          // that did install (e.g. region discovery, #3743).
          logger.debug(`[MeshCore] set_out_path ack not seen for ${publicKey} (write likely applied)`);
        } else {
          logger.warn(`[MeshCore] set_out_path rejected for ${publicKey}: ${response.error}`);
        }
        return false;
      }
      // Group the flat byte buffer into hashBytes-wide hop tokens so the
      // mirrored outPath string carries the per-hop width (e.g. "a3f2,7f01"
      // for a 2-byte path) and pathLen reflects hop COUNT, not byte count.
      const hopCount = outPathBytes.length / hashBytes;
      const hopTokens: string[] = [];
      for (let i = 0; i + hashBytes <= outPathBytes.length; i += hashBytes) {
        let tok = '';
        for (let j = 0; j < hashBytes; j++) {
          tok += outPathBytes[i + j].toString(16).padStart(2, '0');
        }
        hopTokens.push(tok);
      }
      const hex = hopTokens.join(',');
      const existing = this.contacts.get(publicKey);
      if (existing) {
        const updated: MeshCoreContact = {
          ...existing,
          outPath: hex,
          pathLen: hopCount,
          lastSeen: Date.now(),
        };
        this.contacts.set(publicKey, updated);
        void this.persistContact(updated);
        this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
        dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
      }
      logger.debug(`[MeshCore] Set out_path (${hopCount} hops, ${hashBytes}-byte) for ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] setContactOutPath threw:', error);
      return false;
    }
  }

  /**
   * Remove a contact from the device's contact list. On success, the
   * in-memory contact map and meshcore_nodes row are cleared. Companion only.
   */
  async removeContact(publicKey: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Remove-contact requires Companion firmware');
      return false;
    }
    if (!this.connected) return false;
    try {
      const response = await this.sendBridgeCommand('remove_contact', { public_key: publicKey });
      if (!response.success) {
        logger.warn(`[MeshCore] remove_contact failed for ${publicKey}: ${response.error}`);
        return false;
      }
      this.contacts.delete(publicKey);
      // Tombstone before the DB delete so an advert-triggered refresh that races
      // in can't re-persist the row we're removing (#3878).
      this.tombstoneContact(publicKey);
      try {
        await databaseService.meshcore.deleteNode(publicKey, this.sourceId);
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] deleteNode after remove_contact failed: ${(err as Error).message}`);
      }
      this.emit('contact_removed', { sourceId: this.sourceId, publicKey });
      dataEventEmitter.emitMeshCoreContactUpdated({ publicKey, removed: true } as any, this.sourceId);
      logger.debug(`[MeshCore] Removed contact ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] removeContact threw:', error);
      return false;
    }
  }

  /** Tombstone a removed contact so `get_contacts` re-sync won't resurrect it (#3878). */
  private tombstoneContact(publicKey: string): void {
    if (!publicKey) return;
    this.removedContacts.set(publicKey.toLowerCase(), Date.now() + MeshCoreManager.TOMBSTONE_TTL_MS);
  }

  /** True while `publicKey` is under an unexpired removal tombstone. Prunes on read. */
  private isContactTombstoned(publicKey: string): boolean {
    const key = publicKey.toLowerCase();
    const expiry = this.removedContacts.get(key);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this.removedContacts.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Clear a removal tombstone — the contact is genuinely back (a live advert
   * from that key, or an explicit user re-add), so it should sync normally.
   */
  private clearContactTombstone(publicKey: string): void {
    if (this.removedContacts.delete(publicKey.toLowerCase())) {
      logger.debug(`[MeshCore:${this.sourceId}] Cleared removal tombstone for ${publicKey.substring(0, 16)}…`);
    }
  }

  /**
   * Forget a contact locally: delete its meshcore_nodes row and in-memory entry
   * and fire a contact-updated push — WITHOUT the device round-trip that
   * {@link removeContact} requires. This is the cleanup fallback for malformed
   * or "ghost" rows (e.g. a room server that landed in the DB twice, once with a
   * truncated public key) that the device's `remove_contact` can't match, so the
   * stale entry can still be removed from MeshMonitor. Works while disconnected
   * and regardless of device type.
   */
  async forgetLocalContact(publicKey: string): Promise<boolean> {
    const hadInMemory = this.contacts.delete(publicKey);
    // Tombstone regardless of the DB outcome: the contact still lives on the
    // companion's saved-contact list, so without this the next advert-triggered
    // or reconnect `get_contacts` re-sync re-inserts the row and the "Remove"
    // appears to do nothing (#3878).
    this.tombstoneContact(publicKey);
    let deletedRow: boolean;
    try {
      deletedRow = await databaseService.meshcore.deleteNode(publicKey, this.sourceId);
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] forgetLocalContact deleteNode failed: ${(err as Error).message}`);
      return false;
    }
    // Success when we removed a stored row or an in-memory entry. A key that
    // matched neither is a genuine no-op — don't fire the removed-contact event
    // in that case, or the UI would flicker (node briefly vanishes on the
    // WebSocket push, then reappears once the next poll finds it unchanged).
    const removed = deletedRow || hadInMemory;
    if (removed) {
      this.emit('contact_removed', { sourceId: this.sourceId, publicKey });
      dataEventEmitter.emitMeshCoreContactUpdated({ publicKey, removed: true } as any, this.sourceId);
    }
    logger.debug(`[MeshCore:${this.sourceId}] Forgot local contact ${publicKey.substring(0, 16)}… (row=${deletedRow}, mem=${hadInMemory})`);
    return removed;
  }

  /**
   * Export a contact as a signed advert blob (for QR/URL/NFC sharing).
   * Pass null publicKey to export the local node's own identity.
   * Returns the raw advert bytes as a number array, or null on failure.
   */
  async exportContact(publicKey: string | null): Promise<number[] | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Export-contact requires Companion firmware');
      return null;
    }
    if (!this.connected) return null;
    try {
      const params: Record<string, unknown> = {};
      if (publicKey) params.public_key = publicKey;
      const response = await this.sendBridgeCommand('export_contact', params);
      if (!response.success) {
        logger.warn(`[MeshCore] export_contact failed: ${response.error}`);
        return null;
      }
      const bytes = response.data?.advert_bytes;
      if (!Array.isArray(bytes)) return null;
      logger.debug(`[MeshCore] Exported contact ${publicKey ? publicKey.substring(0, 16) + '…' : '(self)'} (${bytes.length}B)`);
      return bytes;
    } catch (error) {
      logger.error('[MeshCore] exportContact threw:', error);
      return null;
    }
  }

  /**
   * Import a contact from a signed advert blob. On success, refreshes
   * the contact list so the new contact appears in the UI.
   */
  async importContact(advertBytes: number[]): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Import-contact requires Companion firmware');
      return false;
    }
    if (!this.connected) return false;
    try {
      const response = await this.sendBridgeCommand('import_contact', { advert_bytes: advertBytes });
      if (!response.success) {
        logger.warn(`[MeshCore] import_contact failed: ${response.error}`);
        return false;
      }
      await this.refreshContacts();
      logger.debug(`[MeshCore] Imported contact (${advertBytes.length}B advert)`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] importContact threw:', error);
      return false;
    }
  }

  /**
   * Sync the device's RTC to the server's clock. Companion only.
   *
   * Returns a discriminated result so the caller can tell the guard cases
   * (wrong device type / disconnected) apart from an actual command failure,
   * and surface the real reason. Previously this returned a bare boolean and
   * the route reported every failure as "disconnected or not a Companion
   * device" even when the device had rejected the command (issue #3570).
   */
  async syncDeviceTime(): Promise<SyncDeviceTimeResult> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Sync-device-time requires Companion firmware');
      return { ok: false, reason: 'not-companion' };
    }
    if (!this.connected) return { ok: false, reason: 'disconnected' };
    try {
      const response = await this.sendBridgeCommand('set_device_time', {});
      if (!response.success) {
        // meshcore.js rejects with NO argument on a firmware Err, which can
        // surface as the literal string "undefined" (issue #3570). Manufacture
        // an actionable reason rather than logging/returning "undefined".
        const raw = response.error ?? '';
        const friendly = /timeout/i.test(raw)
          ? 'Device did not respond to the time-sync command — the firmware may not support setting the RTC over this transport.'
          : raw && raw !== 'undefined'
            ? raw
            : 'Device rejected the time-sync command — the firmware may not support setting the RTC over this transport.';
        logger.warn(`[MeshCore:${this.sourceId}] set_device_time failed: ${friendly}`);
        return { ok: false, reason: 'command-failed', error: friendly };
      }
      logger.debug(`[MeshCore:${this.sourceId}] Device time synced to server clock`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[MeshCore] syncDeviceTime threw:', error);
      return { ok: false, reason: 'command-failed', error: message };
    }
  }

  /**
   * Push the server clock to the local Companion RTC now, then keep it fresh on
   * a slow interval for the life of the connection (issue #3954). Companion-only
   * and best-effort: a device that rejects `set_device_time` (or isn't a
   * Companion) is simply left alone. Safe to call repeatedly — it re-arms the
   * single timer rather than stacking them.
   */
  private startDeviceTimeSync(): void {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return;
    this.stopDeviceTimeSync();

    const syncOnce = () => {
      void this.syncDeviceTime().then((result) => {
        if (!result.ok && result.reason === 'command-failed') {
          logger.debug(`[MeshCore:${this.sourceId}] Periodic device-time sync failed: ${result.error}`);
        }
      });
    };

    syncOnce();
    this.deviceTimeSyncTimer = setInterval(syncOnce, MeshCoreManager.DEVICE_TIME_SYNC_INTERVAL_MS);
  }

  private stopDeviceTimeSync(): void {
    if (this.deviceTimeSyncTimer !== null) {
      clearInterval(this.deviceTimeSyncTimer);
      this.deviceTimeSyncTimer = null;
    }
  }

  /**
   * Query the neighbour list from a remote repeater node. Returns an array
   * of neighbour entries with pubkey prefix, last-heard age, and SNR.
   * Requires firmware v1.9.0+ on the target repeater.
   */
  async getNeighbours(publicKey: string, opts?: { count?: number; offset?: number; orderBy?: number }): Promise<{
    total: number;
    neighbours: { publicKeyPrefix: string; heardSecondsAgo: number; snr: number }[];
  } | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    if (!this.connected) return null;
    // Establish a session with the saved password first — repeaters gate the
    // neighbours query behind a guest/admin login, and this binary path (like
    // the CLI `neighbors` path) otherwise fails with no session. Never
    // anonymous-logs-in (see ensureSavedLogin).
    await this.ensureSavedLogin(publicKey);
    try {
      const response = await this.sendBridgeCommand('get_neighbours', {
        public_key: publicKey,
        count: opts?.count ?? 10,
        offset: opts?.offset ?? 0,
        order_by: opts?.orderBy ?? 0,
      }, 30000);
      if (!response.success) {
        logger.warn(`[MeshCore] get_neighbours failed for ${publicKey}: ${response.error}`);
        return null;
      }
      const d = response.data ?? {};
      return {
        total: d.total ?? 0,
        neighbours: (d.neighbours ?? []).map((n: any) => ({
          publicKeyPrefix: n.public_key_prefix,
          heardSecondsAgo: n.heard_seconds_ago,
          snr: n.snr,
        })),
      };
    } catch (error) {
      logger.error('[MeshCore] getNeighbours threw:', error);
      return null;
    }
  }

  /**
   * Reboot the locally connected device. Companion only. This is a
   * destructive operation — the device will disconnect and restart.
   */
  async rebootDevice(): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Reboot requires Companion firmware');
      return false;
    }
    if (!this.connected) return false;
    try {
      const response = await this.sendBridgeCommand('reboot', {}, 10000);
      if (!response.success) {
        logger.warn(`[MeshCore] reboot failed: ${response.error}`);
        return false;
      }
      logger.debug(`[MeshCore:${this.sourceId}] Reboot command sent`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] rebootDevice threw:', error);
      return false;
    }
  }

  /**
   * Export the device's Ed25519 private key for backup. Returns the 64-char
   * hex string, or null on failure. Companion only. SECURITY-SENSITIVE —
   * the caller is responsible for gating access.
   */
  async exportPrivateKey(): Promise<string | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Export private key requires Companion firmware');
      return null;
    }
    if (!this.connected) return null;
    try {
      const response = await this.sendBridgeCommand('export_private_key', {});
      if (!response.success) {
        logger.warn(`[MeshCore] export_private_key failed: ${response.error}`);
        return null;
      }
      const hex = response.data?.private_key;
      if (typeof hex !== 'string') return null;
      logger.debug(`[MeshCore:${this.sourceId}] Private key exported`);
      return hex;
    } catch (error) {
      logger.error('[MeshCore] exportPrivateKey threw:', error);
      return null;
    }
  }

  /**
   * Import an Ed25519 private key onto the device. This replaces the
   * device's identity — all existing contacts will need to re-discover
   * it. Companion only. DESTRUCTIVE + SECURITY-SENSITIVE.
   */
  async importPrivateKey(hexKey: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Import private key requires Companion firmware');
      return false;
    }
    if (!this.connected) return false;
    if (!/^[0-9a-fA-F]{128}$/.test(hexKey)) {
      logger.warn('[MeshCore] importPrivateKey: invalid key format');
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('import_private_key', { private_key: hexKey });
      if (!response.success) {
        logger.warn(`[MeshCore] import_private_key failed: ${response.error}`);
        return false;
      }
      logger.debug(`[MeshCore:${this.sourceId}] Private key imported — device identity changed`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] importPrivateKey threw:', error);
      return false;
    }
  }

  /**
   * Login to a remote node for admin access
   */
  async loginToNode(publicKey: string, password: string): Promise<MeshCoreLoginResult | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Admin login requires Companion firmware');
      return null;
    }

    try {
      // A login request floods when the path to the node is unknown, so it
      // carries the default scope (#3667).
      const response = await this.sendWithDefaultScope(() => this.sendBridgeCommand('login', {
        public_key: publicKey,
        password: password,
      }));

      if (response.success) {
        logger.debug(`[MeshCore] Logged into node ${publicKey.substring(0, 8)}...`);
        // Firmware >= 1.16 reports the remote's admin flag and version level in
        // the LoginSuccess frame (#4094). Surface them for the Virtual Node to
        // relay; on older firmware they are undefined and callers fall back to
        // the legacy guest/no-version behaviour.
        const d = response.data ?? {};
        return {
          isAdmin: typeof d.is_admin === 'number' ? d.is_admin !== 0 : undefined,
          firmwareVerLevel: typeof d.firmware_ver_level === 'number' ? d.firmware_ver_level : undefined,
          serverTimestamp: typeof d.server_timestamp === 'number' ? d.server_timestamp : undefined,
          aclPermissions: typeof d.acl_permissions === 'number' ? d.acl_permissions : undefined,
        };
      }
      return null;
    } catch (error) {
      logger.error('[MeshCore] Login failed:', error);
      return null;
    }
  }

  /**
   * Request status from a remote node
   */
  async requestNodeStatus(publicKey: string): Promise<MeshCoreStatus | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      return null;
    }

    try {
      const response = await this.sendBridgeCommand('get_status', {
        public_key: publicKey,
      }, 15000);

      if (response.success && response.data) {
        const d = response.data;
        return {
          batteryMv: d.bat_mv,
          uptimeSecs: d.up_secs,
          queueLen: d.queue_len,
          noiseFloor: d.noise_floor,
          lastRssi: d.last_rssi,
          lastSnr: d.last_snr,
          packetsRecv: d.packets_recv,
          packetsSent: d.packets_sent,
          airTimeSecs: d.air_time_secs,
          sentFlood: d.sent_flood,
          sentDirect: d.sent_direct,
          recvFlood: d.recv_flood,
          recvDirect: d.recv_direct,
          errors: d.errors,
          directDups: d.direct_dups,
          floodDups: d.flood_dups,
          txPower: d.tx_power,
          radioFreq: d.radio_freq,
          radioBw: d.radio_bw,
          radioSf: d.radio_sf,
          radioCr: d.radio_cr,
        };
      }
      return null;
    } catch (error) {
      logger.error('[MeshCore] Status request failed:', error);
      return null;
    }
  }

  /**
   * In-memory set of remote-node public keys that we've successfully
   * established a guest session with on the currently-open connection.
   * Cleared on disconnect: a fresh TCP/serial reconnect drops any prior
   * MeshCore session, so callers must re-login.
   *
   * Guest login (empty password) is the canonical way to "unlock"
   * `GetTelemetryData` responses on Repeater firmware whose
   * `telemetry_mode_*` is set to `Disabled` for anonymous callers — see
   * https://github.com/Yeraze/meshmonitor/issues/3092.
   */
  private guestLoggedInNodes: Set<string> = new Set();

  /**
   * In-memory map of room server public keys we've successfully logged into.
   * Cleared on disconnect — firmware drops sessions on reconnect.
   */
  private roomLoggedInNodes: Map<string, { loggedIn: boolean; loginTime: number }> = new Map();

  /**
   * Ensure a guest (empty-password) login session exists for `publicKey`.
   * Returns true if already logged in, or if a fresh login attempt
   * succeeded. Safe to call before every binary request to a repeater:
   * the in-memory set short-circuits repeats on the same connection.
   */
  async ensureGuestLogin(publicKey: string): Promise<boolean> {
    if (this.guestLoggedInNodes.has(publicKey)) return true;
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return false;
    if (!this.connected) return false;
    const ok = (await this.loginToNode(publicKey, '')) !== null;
    if (ok) {
      this.guestLoggedInNodes.add(publicKey);
    }
    return ok;
  }

  /**
   * Establish a login session for a remote repeater before a read command,
   * using ONLY the SAVED password for this (source, node). Repeaters gate
   * `neighbors`/`stats` behind a guest (or admin) password; the saved
   * credential is that password.
   *
   * Deliberately does NOT fall back to an empty-password ("anonymous") login:
   * on firmware that requires the guest password, an empty login silently
   * downgrades to anonymous — the command then returns nothing and the only
   * symptom is a CLI timeout. So if no password is saved, or every attempt is
   * dropped, this returns false and the caller proceeds without masquerading
   * as anonymous.
   *
   * Retries a few times (like `loginToRoom`) because the login round-trip is
   * easily dropped on a lossy LoRa link to a distant repeater — a single miss
   * must not be treated as "no session".
   *
   * The decrypted plaintext is used in-process only; it never leaves the
   * server (same invariant as the login-with-saved route).
   */
  async ensureSavedLogin(publicKey: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return false;
    if (!this.connected) return false;

    let cred;
    try {
      const { getMeshCoreCredentialStore } = await import('./services/meshcoreCredentialStore.js');
      cred = await getMeshCoreCredentialStore().load(this.sourceId, publicKey);
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] credential lookup failed for ${publicKey.substring(0, 8)}…: ${(err as Error).message}`);
      return false;
    }
    // No saved password (or unreadable/rotated): do NOT anonymous-login.
    if (cred.kind !== 'ok') return false;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await this.loginToNode(publicKey, cred.password)) return true;
      if (attempt < maxAttempts) {
        logger.debug(`[MeshCore:${this.sourceId}] saved-credential login attempt ${attempt}/${maxAttempts} got no reply for ${publicKey.substring(0, 8)}…, retrying`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    logger.warn(`[MeshCore:${this.sourceId}] saved-credential login failed after ${maxAttempts} attempts for ${publicKey.substring(0, 8)}…`);
    return false;
  }

  // ============ Room Server Support ============

  /**
   * Login to a room server. Uses the same underlying login command but
   * tracks state in roomLoggedInNodes so the UI can show login status.
   */
  async loginToRoom(publicKey: string, password: string): Promise<boolean> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ok = await this.loginToNode(publicKey, password);
      if (ok) {
        this.roomLoggedInNodes.set(publicKey, { loggedIn: true, loginTime: Date.now() });
        return true;
      }
      if (attempt < maxAttempts) {
        logger.warn(`[MeshCore] Room login attempt ${attempt}/${maxAttempts} failed for ${publicKey.substring(0, 8)}…, retrying`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    return false;
  }

  isRoomLoggedIn(publicKey: string): boolean {
    return this.roomLoggedInNodes.get(publicKey)?.loggedIn ?? false;
  }

  getRoomServers(): MeshCoreContact[] {
    const rooms: MeshCoreContact[] = [];
    for (const c of this.contacts.values()) {
      if (c.advType === 3) rooms.push(c);
    }
    return rooms;
  }

  /**
   * Send a post to a room server. The protocol sends a plain DM to the
   * room's pubkey; the room server adds it to the post queue. The locally-
   * stored copy is tagged messageType='room_post' for filtering.
   */
  async sendRoomPost(text: string, roomPublicKey: string): Promise<boolean> {
    if (!this.connected) {
      logger.error('[MeshCore] Not connected');
      return false;
    }
    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn('[MeshCore] Repeaters cannot send messages');
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('send_message', {
        text,
        to: roomPublicKey,
      });
      if (response.success) {
        const sentMessage: MeshCoreMessage = {
          id: `sent-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          fromPublicKey: this.localNode?.publicKey || 'local',
          // Label self-sent room posts by our own name in the Unified feed
          // rather than the raw public key (#4194); see the channel/DM send site.
          fromName: this.localNode?.name ?? undefined,
          toPublicKey: roomPublicKey,
          text,
          timestamp: Date.now(),
          sourceId: this.sourceId,
          messageType: 'room_post',
        };
        this.addMessage(sentMessage);
        this.emit('message', sentMessage);
        dataEventEmitter.emitMeshCoreMessage(sentMessage, this.sourceId);
        return true;
      }
      logger.error('[MeshCore] Room post send failed:', response.error);
      return false;
    } catch (error) {
      logger.error('[MeshCore] Failed to send room post:', error);
      return false;
    }
  }

  /**
   * Find a contact whose publicKey starts with the given hex prefix.
   */
  resolveContactByPrefix(prefix: string): MeshCoreContact | undefined {
    if (!prefix) return undefined;
    const exact = this.contacts.get(prefix);
    if (exact) return exact;
    for (const c of this.contacts.values()) {
      if (c.publicKey.startsWith(prefix)) return c;
    }
    return undefined;
  }

  /**
   * Request and store neighbor data from a MeshCore repeater.
   *
   * @param publicKey — target repeater's 64-char hex key (remote request via
   *   companion bridge). Omit for local repeater (serial CLI).
   * @returns Resolved neighbor entries, or null if the device said "not supported".
   */
  async requestNeighbors(publicKey?: string): Promise<{
    neighbors: Array<{ publicKey: string; name: string | null; snr: number; lastHeardSecs: number }>;
  } | null> {
    const { parseMeshcoreNeighborsResponse } = await import('./utils/parseMeshcoreNeighbors.js');

    // Validate-and-extract: the user-supplied publicKey is either absent
    // (route to local CLI) or must be a 64-char lowercase hex string
    // (route to remote CLI with that target). The validator returns the
    // normalised key as a *new variable* so downstream branching reads
    // the sanitised value rather than the user input — this is what
    // CodeQL recognises as a sanitiser barrier for js/user-controlled-bypass.
    const sanitizedTargetKey = validateMeshCorePubKey(publicKey);

    let reply: string;
    if (sanitizedTargetKey !== null) {
      // Log in with the SAVED password (repeaters gate `neighbors` behind a
      // guest/admin password). Never anonymous-login: an empty-password login
      // downgrades to anonymous and the command returns nothing.
      await this.ensureSavedLogin(sanitizedTargetKey);
      const result = await this.sendCliCommand(sanitizedTargetKey, 'neighbors');
      reply = result.reply;
    } else {
      const result = await this.sendLocalCliCommand('neighbors');
      reply = result.reply;
    }

    const parsed = parseMeshcoreNeighborsResponse(reply);
    if (parsed === null) return null;

    const reporterKey = sanitizedTargetKey ?? this.localNode?.publicKey;
    if (!reporterKey) {
      logger.warn(`[MeshCore:${this.sourceId}] requestNeighbors: no reporter key available`);
      return { neighbors: [] };
    }

    const resolved: Array<{ publicKey: string; name: string | null; snr: number; lastHeardSecs: number }> = [];
    for (const entry of parsed) {
      const contact = this.resolveContactByPrefix(entry.pubkeyPrefix);
      if (!contact) {
        logger.debug(`[MeshCore:${this.sourceId}] neighbor prefix ${entry.pubkeyPrefix} not in contact list, skipping`);
        continue;
      }
      resolved.push({
        publicKey: contact.publicKey,
        name: contact.advName ?? contact.name ?? null,
        snr: entry.snr,
        lastHeardSecs: entry.lastHeardSecondsAgo,
      });
    }

    try {
      await databaseService.meshcore.insertNeighborsBatch(
        this.sourceId,
        reporterKey,
        resolved.map((r) => ({
          neighborPublicKey: r.publicKey,
          snr: r.snr,
          lastHeardSecs: r.lastHeardSecs,
        })),
      );
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] failed to persist neighbors: ${(err as Error).message}`);
    }

    return { neighbors: resolved };
  }

  /**
   * In-flight CLI commands keyed by the target's pubkey *prefix* (first 12
   * hex chars / 6 bytes). MeshCore ContactMsgRecv only carries the 6-byte
   * prefix on the wire, so reply correlation has to match that width.
   *
   * Two distinct contacts colliding on a 6-byte prefix is a 2^-48 event;
   * we tolerate it by serializing per-prefix (next entry below) so the
   * earlier command always resolves first.
   */
  private pendingCliReplies: Map<string, {
    prefixKey: string;
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    sentAt: number;
  }> = new Map();

  /**
   * Per-prefix promise chain so only one CLI command is in flight at a
   * time per remote. MeshCore has no request IDs; serialization is the
   * only way to make reply-routing unambiguous.
   */
  private cliCommandLocks: Map<string, Promise<unknown>> = new Map();

  /**
   * Rewrite the firmware `clock sync` CLI verb into the absolute
   * `time <epoch>` verb, stamped with the server's authoritative wall clock
   * at send time (issue #3954).
   *
   * MeshCore's `clock sync` (CommonCLI.cpp) sets the RTC to the
   * *sender_timestamp* of the incoming command frame — NOT to any live clock:
   *   - over the local serial CLI the firmware hard-codes sender_timestamp=0
   *     (the local-access marker), so `clock sync` is ALWAYS rejected with
   *     "clock cannot go backwards" and the RTC never moves;
   *   - over remote-admin (CliData DM) it uses the *sending* node's RTC, which
   *     MeshMonitor's local companion never keeps synced, so the target
   *     inherits our drift (the reported "~22 minutes behind").
   *
   * The `time <epoch>` verb instead sets the RTC directly from the epoch in the
   * command text (independent of sender_timestamp), so it works over BOTH
   * transports and reflects real current time. The firmware still enforces its
   * own "can't go backwards" guard (secs > curr) — identical to `clock sync` —
   * so this is not a behavioural regression, only a correct time source.
   */
  private rewriteClockSync(command: string): string {
    if (command.trim().toLowerCase() === 'clock sync') {
      return `time ${Math.floor(Date.now() / 1000)}`;
    }
    return command;
  }

  /**
   * Send a CLI command to a remote MeshCore node and await its reply.
   *
   * The command is sent as an encrypted DM with txtType=CliData; the remote
   * runs it through CommonCLI::handleCommand() and replies as another
   * txtType=CliData message. Single-packet only (≈130–180B LoRa MTU); long
   * outputs are truncated at the firmware level.
   *
   * Caller is responsible for having an active admin session — call
   * loginToNode() (or ensureGuestLogin() for read-only ops) first. A guest
   * session is enough for `ver`, `stats`, `neighbors` etc.; mutating
   * commands require admin permission.
   *
   * @throws if the publicKey is malformed, the backend isn't a Companion,
   *         or the remote does not reply within `timeoutMs`.
   */
  async sendCliCommand(
    publicKey: string,
    command: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ reply: string; elapsedMs: number }> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      throw new Error('Remote-admin CLI requires Companion firmware');
    }
    if (!this.connected) {
      throw new Error('MeshCore source not connected');
    }
    const normalizedKey = publicKey.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedKey)) {
      throw new Error('publicKey must be a 64-char hex string');
    }
    const trimmed = this.rewriteClockSync(command.trim());
    if (trimmed.length === 0) {
      throw new Error('CLI command must be non-empty');
    }

    const prefixKey = normalizedKey.substring(0, 12);
    const timeoutMs = opts.timeoutMs ?? 15_000;

    // Chain onto the per-prefix lock so two callers can't have overlapping
    // pending entries for the same target. The chain itself ignores prior
    // rejections — each command is independent.
    const prior = this.cliCommandLocks.get(prefixKey) ?? Promise.resolve();
    const runNext = prior.catch(() => undefined).then(() =>
      this.runCliCommandLocked(normalizedKey, prefixKey, trimmed, timeoutMs),
    );
    this.cliCommandLocks.set(prefixKey, runNext);
    try {
      return await runNext;
    } finally {
      // If this is still the head of the chain, clear the slot so the
      // map doesn't grow without bound. A subsequent caller would have
      // already chained onto `runNext`.
      if (this.cliCommandLocks.get(prefixKey) === runNext) {
        this.cliCommandLocks.delete(prefixKey);
      }
    }
  }

  private runCliCommandLocked(
    fullKey: string,
    prefixKey: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ reply: string; elapsedMs: number }> {
    return new Promise<{ reply: string; elapsedMs: number }>((resolve, reject) => {
      // A stale pending entry should be impossible because of the
      // per-prefix lock, but guard against it: an entry left over from a
      // crashed prior call would silently steal our reply.
      const existing = this.pendingCliReplies.get(prefixKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('Superseded by new CLI command on same prefix'));
        this.pendingCliReplies.delete(prefixKey);
      }

      const sentAt = Date.now();
      const timer = setTimeout(() => {
        this.pendingCliReplies.delete(prefixKey);
        reject(new Error(`CLI command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCliReplies.set(prefixKey, {
        prefixKey,
        resolve: (text: string) => resolve({ reply: text, elapsedMs: Date.now() - sentAt }),
        reject,
        timer,
        sentAt,
      });

      // A CLI command to a remote node floods when its path is unknown, so it
      // carries the default scope (#3667). The scope assertion is serialised
      // with all other sends; if it fails the command rejects rather than
      // leaving un-scoped.
      //
      // Intentionally fire-and-forget (`void` + `.then`/`.catch`) rather than
      // `await`ed: we're already inside the per-prefix `cliCommandLocks` chain,
      // and awaiting the global `sendScopeLock` here would nest the two locks.
      // Keeping it non-awaited means neither lock is held while waiting on the
      // other. A scope-assert failure still surfaces — it rejects via the
      // `.catch` below, which clears the timer and rejects the outer promise.
      void this.sendWithDefaultScope(() => this.sendBridgeCommand('send_cli', { public_key: fullKey, text: command }, timeoutMs))
        .then((resp) => {
          if (!resp.success) {
            clearTimeout(timer);
            this.pendingCliReplies.delete(prefixKey);
            reject(new Error(resp.error || 'send_cli failed'));
          }
          // Success means the firmware accepted the outbound frame; the
          // actual reply still arrives asynchronously via cli_reply.
        })
        .catch((err) => {
          clearTimeout(timer);
          this.pendingCliReplies.delete(prefixKey);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  /**
   * Send a CLI command to the LOCALLY connected MeshCore node.
   *
   * Dispatch depends on the connected firmware:
   *  - Repeater / Room Server: forwards to `sendRepeaterCommand`, which
   *    drives the device's native serial text CLI. Whatever the device
   *    prints comes back as `reply`.
   *  - Companion: there is no native text CLI on the companion-protocol
   *    wire, so we run a small synthetic-CLI interpreter that maps a
   *    handful of read-only verbs (ver, stats, clock, advert) to existing
   *    bridge commands and formats the structured response as text.
   *
   * No password / login flow — the local node is physically connected,
   * so there is no admin ACL to authenticate against. The HTTP route
   * separately gates this on the `configuration:write` permission.
   */
  async sendLocalCliCommand(
    command: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ reply: string; elapsedMs: number }> {
    if (!this.connected) {
      throw new Error('MeshCore source not connected');
    }
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      throw new Error('Command must be non-empty');
    }
    const sentAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? 10_000;

    if (this.deviceType === MeshCoreDeviceType.REPEATER || this.deviceType === MeshCoreDeviceType.ROOM_SERVER) {
      // `clock sync` over the direct serial CLI is a firmware no-op
      // (sender_timestamp=0 → "clock cannot go backwards"); rewrite it to the
      // absolute `time <epoch>` verb so the RTC actually gets set (#3954).
      const reply = await this.sendRepeaterCommand(this.rewriteClockSync(trimmed), timeoutMs);
      return { reply, elapsedMs: Date.now() - sentAt };
    }

    if (this.deviceType === MeshCoreDeviceType.COMPANION) {
      const reply = await this.runSyntheticLocalCli(trimmed);
      return { reply, elapsedMs: Date.now() - sentAt };
    }

    throw new Error('Local CLI not available for this device type');
  }

  /**
   * Synthetic CLI for Companion firmware. Companion devices speak only
   * the binary companion protocol on the wire; this method gives the
   * UI the same "type a command, see structured output" shape as the
   * Repeater path by mapping a small command vocabulary to existing
   * bridge commands and formatting the result as readable text.
   *
   * Unrecognized commands return a usage hint instead of throwing —
   * matches the Repeater path's behavior for the same input.
   */
  private async runSyntheticLocalCli(command: string): Promise<string> {
    const parts = command.split(/\s+/);
    const verb = parts[0]?.toLowerCase() ?? '';
    const arg = parts[1]?.toLowerCase() ?? '';

    if (verb === 'ver' || verb === 'version') {
      const response = await this.sendBridgeCommand('device_query', {});
      if (!response.success) throw new Error(response.error || 'device_query failed');
      const d = response.data || {};
      const lines: string[] = [];
      if (d['fw ver'] !== undefined) lines.push(`Firmware: ${d['fw ver']}`);
      if (d.ver) lines.push(`Version: ${d.ver}`);
      if (d.fw_build) lines.push(`Build: ${d.fw_build}`);
      if (d.model) lines.push(`Model: ${d.model}`);
      return lines.length > 0 ? lines.join('\n') : 'No device info reported';
    }

    if (verb === 'stats') {
      const type = arg === 'radio' || arg === 'packets' ? arg : 'core';
      const response = await this.sendBridgeCommand('get_stats', { type });
      if (!response.success) throw new Error(response.error || 'get_stats failed');
      const d = response.data || {};
      const lines = Object.entries(d)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}: ${v}`);
      return lines.length > 0 ? `[${type}]\n${lines.join('\n')}` : `[${type}] (no data)`;
    }

    if (verb === 'clock' || verb === 'time') {
      const response = await this.sendBridgeCommand('get_device_time', {});
      if (!response.success) throw new Error(response.error || 'get_device_time failed');
      const epoch = response.data?.time;
      if (typeof epoch !== 'number') return 'Device clock unavailable';
      return `${epoch}\n${new Date(epoch * 1000).toISOString()}`;
    }

    if (verb === 'advert') {
      const response = await this.sendBridgeCommand('send_advert', {});
      if (!response.success) throw new Error(response.error || 'send_advert failed');
      return 'Advert sent (flood)';
    }

    if (verb === 'help' || verb === '?') {
      return [
        'Available local commands (Companion):',
        '  ver           — firmware version + model',
        '  stats [core|radio|packets] — local device stats',
        '  clock         — device time',
        '  advert        — broadcast a flood advert',
        '  help          — this list',
      ].join('\n');
    }

    return `Unknown command: ${command}\nType "help" for the list of available commands.`;
  }

  /**
   * Set device name
   */
  async setName(name: string): Promise<boolean> {
    const safeName = this.sanitizeName(name);

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      try {
        await this.sendRepeaterCommand(`set name ${safeName}`);
        if (this.localNode) {
          this.localNode.name = safeName;
        }
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to set name:', error);
        return false;
      }
    } else {
      try {
        const response = await this.sendBridgeCommand('set_name', { name: safeName });
        if (response.success && this.localNode) {
          this.localNode.name = safeName;
        }
        return response.success;
      } catch (error) {
        logger.error('[MeshCore] Failed to set name:', error);
        return false;
      }
    }
  }

  /**
   * Set radio parameters
   */
  async setRadio(freq: number, bw: number, sf: number, cr: number): Promise<boolean> {
    this.validateRadioParams(freq, bw, sf, cr);

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      try {
        await this.sendRepeaterCommand(`set radio ${freq},${bw},${sf},${cr}`);
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to set radio:', error);
        return false;
      }
    } else {
      try {
        const response = await this.sendBridgeCommand('set_radio', { freq, bw, sf, cr });
        if (response.success) {
          if (this.localNode) {
            this.localNode.radioFreq = freq;
            this.localNode.radioBw = bw;
            this.localNode.radioSf = sf;
            this.localNode.radioCr = cr;
          }
          try {
            await this.refreshLocalNode();
          } catch (refreshErr) {
            logger.warn('[MeshCore] refreshLocalNode after set_radio failed:', refreshErr);
          }
        }
        return response.success;
      } catch (error) {
        logger.error('[MeshCore] Failed to set radio:', error);
        return false;
      }
    }
  }

  /**
   * Set TX power (dBm). Range: 1–22.
   */
  async setTxPower(power: number): Promise<boolean> {
    if (!Number.isFinite(power) || power < 1 || power > 22) {
      throw new Error('Invalid TX power: must be between 1 and 22 dBm');
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      try {
        await this.sendRepeaterCommand(`set tx ${power}`);
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to set TX power:', error);
        return false;
      }
    } else {
      try {
        const response = await this.sendBridgeCommand('set_tx_power', { power });
        if (response.success) {
          if (this.localNode) {
            this.localNode.txPower = power;
          }
          try {
            await this.refreshLocalNode();
          } catch (refreshErr) {
            logger.warn('[MeshCore] refreshLocalNode after set_tx_power failed:', refreshErr);
          }
        }
        return response.success;
      } catch (error) {
        logger.error('[MeshCore] Failed to set TX power:', error);
        return false;
      }
    }
  }

  /**
   * Set device coordinates (companion only)
   */
  async setCoords(lat: number, lon: number): Promise<boolean> {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error('Invalid latitude: must be between -90 and 90');
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error('Invalid longitude: must be between -180 and 180');
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn('[MeshCore] set_coords not supported on repeater');
      return false;
    }

    try {
      const response = await this.sendBridgeCommand('set_coords', { lat, lon });
      if (response.success && this.localNode) {
        this.localNode.latitude = lat;
        this.localNode.longitude = lon;
      }
      return response.success;
    } catch (error) {
      logger.error('[MeshCore] Failed to set coords:', error);
      return false;
    }
  }

  /**
   * Set advert location policy (companion only)
   * policy: 0 = do not include location in adverts, 1 = include location
   */
  async setAdvertLocPolicy(policy: number): Promise<boolean> {
    if (policy !== 0 && policy !== 1) {
      throw new Error('Invalid advert location policy: must be 0 or 1');
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn('[MeshCore] set_advert_loc_policy not supported on repeater');
      return false;
    }

    try {
      const response = await this.sendBridgeCommand('set_advert_loc_policy', { policy });
      if (response.success && this.localNode) {
        this.localNode.advLocPolicy = policy;
      }
      return response.success;
    } catch (error) {
      logger.error('[MeshCore] Failed to set advert loc policy:', error);
      return false;
    }
  }

  private isValidTelemetryMode(mode: unknown): mode is TelemetryMode {
    return mode === 'always' || mode === 'device' || mode === 'never';
  }

  private async setTelemetryMode(
    kind: 'base' | 'loc' | 'env',
    mode: TelemetryMode,
  ): Promise<boolean> {
    if (!this.isValidTelemetryMode(mode)) {
      throw new Error('Invalid telemetry mode: must be always, device, or never');
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn(`[MeshCore] set_telemetry_mode_${kind} not supported on repeater`);
      return false;
    }

    try {
      const response = await this.sendBridgeCommand(`set_telemetry_mode_${kind}`, { mode });
      if (response.success && this.localNode) {
        if (kind === 'base') this.localNode.telemetryModeBase = mode;
        else if (kind === 'loc') this.localNode.telemetryModeLoc = mode;
        else if (kind === 'env') this.localNode.telemetryModeEnv = mode;
      }
      return response.success;
    } catch (error) {
      logger.error(`[MeshCore] Failed to set telemetry mode (${kind}):`, error);
      return false;
    }
  }

  /**
   * Set basic telemetry sharing mode (companion only).
   * mode: 'always' = broadcast, 'device' = only respond to added contacts, 'never' = off.
   */
  async setTelemetryModeBase(mode: TelemetryMode): Promise<boolean> {
    return this.setTelemetryMode('base', mode);
  }

  /**
   * Set location telemetry sharing mode (companion only).
   */
  async setTelemetryModeLoc(mode: TelemetryMode): Promise<boolean> {
    return this.setTelemetryMode('loc', mode);
  }

  /**
   * Set environment telemetry sharing mode (companion only).
   */
  async setTelemetryModeEnv(mode: TelemetryMode): Promise<boolean> {
    return this.setTelemetryMode('env', mode);
  }

  /**
   * Set all "other params" atomically in a single SetOtherParams frame
   * (companion only) — manual-add-contacts, the three telemetry-visibility
   * sections, and the advert location policy. Telemetry modes are the raw 2-bit
   * values (0=off, 1=always, 2=on-request); the backend's converter accepts
   * these numeric values directly. Used by the Virtual Node to forward an app's
   * SetOtherParams(38) in one round-trip instead of several piecemeal patches
   * (issue #3904).
   */
  async setOtherParams(params: {
    manualAddContacts: number;
    telemetryModeBase: number;
    telemetryModeLoc: number;
    telemetryModeEnv: number;
    advLocPolicy: number;
  }): Promise<boolean> {
    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn('[MeshCore] set_other_params not supported on repeater');
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('set_other_params', params);
      return response.success;
    } catch (error) {
      logger.error('[MeshCore] Failed to set other params:', error);
      return false;
    }
  }

  // ============ Mesh-op throttle primitive ============

  /**
   * Timestamp (ms) of the last outbound RF op the manager is aware of.
   * Returns 0 if nothing has been recorded yet. Read by the
   * remote-telemetry scheduler before issuing a new request so two
   * scheduled-ops on the same source can't stomp each other.
   */
  getLastMeshTxAt(): number {
    return this.lastMeshTxAt;
  }

  /**
   * Stamp the manager as having just emitted an RF op. Callers that
   * transmit on the air via this manager (today: only the
   * remote-telemetry scheduler) MUST invoke this so the next scheduled
   * op honours the global minimum interval.
   */
  recordMeshTx(when: number = Date.now()): void {
    this.lastMeshTxAt = when;
  }

  // ============ Remote-node telemetry (companion only, RF) ============
  //
  // `requestRemoteTelemetry` puts a binary req-telemetry packet on the
  // air via the locally-connected companion node. The Node-side scheduler
  // is responsible for enforcing the cross-call 60s minimum.

  /**
   * Send a binary telemetry request to a remote node and wait for the
   * LPP-decoded response. Returns null on timeout / error / repeater.
   * The caller is responsible for honouring the global 60s throttle —
   * this method does NOT consult `lastMeshTxAt`. It bumps the field on
   * success so subsequent scheduled ops see it.
   */
  async requestRemoteTelemetry(
    publicKey: string,
    timeoutSecs?: number,
  ): Promise<MeshCoreTelemetryRecord[] | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    if (!this.connected) return null;
    if (!publicKey) return null;

    try {
      const params: Record<string, unknown> = { public_key: publicKey };
      if (typeof timeoutSecs === 'number' && Number.isFinite(timeoutSecs) && timeoutSecs > 0) {
        params.timeout = timeoutSecs;
      }
      // request_telemetry can wait several seconds on the air; widen the
      // command timeout so a slow node doesn't trip the default 30s ceiling
      // on a back-to-back retry. It floods when the path is unknown, so it
      // carries the default scope (#3667).
      const response = await this.sendWithDefaultScope(() => this.sendBridgeCommand('request_telemetry', params, 45_000));
      if (!response.success) {
        // This is the LPP (environment telemetry) path specifically — name it
        // so operators don't confuse it with the separate status/stats request
        // that runs alongside it for repeater-like targets (#3676). An LPP
        // timeout here is common and non-fatal; the status path is unaffected.
        logger.warn(
          `[MeshCore:${this.sourceId}] requestRemoteTelemetry (LPP) (${publicKey.substring(0, 16)}…) failed: ${response.error}`,
        );
        return null;
      }
      this.recordMeshTx();
      const data = response.data;
      const records = Array.isArray(data?.records) ? (data.records as MeshCoreTelemetryRecord[]) : [];
      return records;
    } catch (error) {
      logger.warn(
        `[MeshCore:${this.sourceId}] requestRemoteTelemetry (LPP) (${publicKey.substring(0, 16)}…) threw:`,
        error,
      );
      return null;
    }
  }

  /**
   * Like {@link requestRemoteTelemetry} but returns the RAW Cayenne-LPP bytes
   * from the remote's response instead of decoded records (issue #3904). The
   * Virtual Node relays these verbatim in a TelemetryResponse(0x8B) push so the
   * connecting app decodes them itself. Returns null on failure/timeout.
   */
  async requestRemoteTelemetryRaw(publicKey: string): Promise<Buffer | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    if (!this.connected) return null;
    if (!publicKey) return null;
    try {
      const response = await this.sendWithDefaultScope(() =>
        this.sendBridgeCommand('request_telemetry', { public_key: publicKey }, 45_000),
      );
      if (!response.success) {
        logger.warn(
          `[MeshCore:${this.sourceId}] requestRemoteTelemetryRaw (${publicKey.substring(0, 16)}…) failed: ${response.error}`,
        );
        return null;
      }
      this.recordMeshTx();
      const raw = response.data?.raw;
      if (!Array.isArray(raw)) return null;
      return Buffer.from(raw as number[]);
    } catch (error) {
      logger.warn(
        `[MeshCore:${this.sourceId}] requestRemoteTelemetryRaw (${publicKey.substring(0, 16)}…) threw:`,
        error,
      );
      return null;
    }
  }

  // ============ Local-node stats (companion only, no RF) ============
  //
  // These hit the locally-attached node over USB/BLE/TCP — they read counters
  // and config off the directly-connected node and never transmit on the air.
  // Safe to poll on a fixed interval. Returns null if not a companion, not
  // connected, or the backend call fails.

  async getStatsCore(): Promise<MeshCoreStatsCore | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    try {
      const response = await this.sendBridgeCommand('get_stats', { type: 'core' });
      if (!response.success || !response.data) return null;
      const d = response.data;
      return {
        batteryMv: typeof d.battery_mv === 'number' ? d.battery_mv : undefined,
        uptimeSecs: typeof d.uptime_secs === 'number' ? d.uptime_secs : undefined,
        errors: typeof d.errors === 'number' ? d.errors : undefined,
        queueLen: typeof d.queue_len === 'number' ? d.queue_len : undefined,
      };
    } catch (error) {
      logger.warn(`[MeshCore:${this.sourceId}] getStatsCore failed:`, error);
      return null;
    }
  }

  async getStatsRadio(): Promise<MeshCoreStatsRadio | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    try {
      const response = await this.sendBridgeCommand('get_stats', { type: 'radio' });
      if (!response.success || !response.data) return null;
      const d = response.data;
      return {
        noiseFloor: typeof d.noise_floor === 'number' ? d.noise_floor : undefined,
        lastRssi: typeof d.last_rssi === 'number' ? d.last_rssi : undefined,
        lastSnr: typeof d.last_snr === 'number' ? d.last_snr : undefined,
        txAirSecs: typeof d.tx_air_secs === 'number' ? d.tx_air_secs : undefined,
        rxAirSecs: typeof d.rx_air_secs === 'number' ? d.rx_air_secs : undefined,
      };
    } catch (error) {
      logger.warn(`[MeshCore:${this.sourceId}] getStatsRadio failed:`, error);
      return null;
    }
  }

  async getStatsPackets(): Promise<MeshCoreStatsPackets | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    try {
      const response = await this.sendBridgeCommand('get_stats', { type: 'packets' });
      if (!response.success || !response.data) return null;
      const d = response.data;
      return {
        recv: typeof d.recv === 'number' ? d.recv : undefined,
        sent: typeof d.sent === 'number' ? d.sent : undefined,
        floodTx: typeof d.flood_tx === 'number' ? d.flood_tx : undefined,
        directTx: typeof d.direct_tx === 'number' ? d.direct_tx : undefined,
        floodRx: typeof d.flood_rx === 'number' ? d.flood_rx : undefined,
        directRx: typeof d.direct_rx === 'number' ? d.direct_rx : undefined,
        recvErrors: typeof d.recv_errors === 'number' ? d.recv_errors : null,
      };
    } catch (error) {
      logger.warn(`[MeshCore:${this.sourceId}] getStatsPackets failed:`, error);
      return null;
    }
  }

  /** Read the RTC on the locally-connected node (Unix seconds). */
  async getDeviceTime(): Promise<number | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    try {
      const response = await this.sendBridgeCommand('get_device_time', {});
      if (!response.success || !response.data) return null;
      const t = response.data.time;
      return typeof t === 'number' ? t : null;
    } catch (error) {
      logger.warn(`[MeshCore:${this.sourceId}] getDeviceTime failed:`, error);
      return null;
    }
  }

  /**
   * Stamp DeviceQuery output onto the in-memory localNode. The poller calls
   * this after a successful `deviceQuery()` so consumers of `getLocalNode()`
   * (status endpoint, snapshot endpoint, Info page) immediately see firmware
   * version, build date, and model alongside SelfInfo.
   */
  applyDeviceInfo(info: MeshCoreDeviceInfo): void {
    if (!this.localNode) return;
    if (info.firmwareVer !== undefined) this.localNode.firmwareVer = info.firmwareVer;
    if (info.firmwareBuild !== undefined) this.localNode.firmwareBuild = info.firmwareBuild;
    if (info.model !== undefined) this.localNode.model = info.model;
    if (info.ver !== undefined) this.localNode.ver = info.ver;
    dataEventEmitter.emitMeshCoreLocalNodeUpdated(this.localNode, this.sourceId);
  }

  /** DeviceQuery → DeviceInfo (firmware version, build date, model, etc). */
  async deviceQuery(): Promise<MeshCoreDeviceInfo | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) return null;
    try {
      const response = await this.sendBridgeCommand('device_query', {});
      if (!response.success || !response.data) return null;
      const d = response.data;
      // Wire vocabulary uses "fw ver" (with a space) for the version byte.
      const fwVerRaw = d['fw ver'] ?? d.fw_ver;
      return {
        firmwareVer: typeof fwVerRaw === 'number' ? fwVerRaw : undefined,
        firmwareBuild: typeof d.fw_build === 'string' ? d.fw_build : undefined,
        model: typeof d.model === 'string' ? d.model : undefined,
        ver: typeof d.ver === 'string' ? d.ver : undefined,
        maxContacts: typeof d.max_contacts === 'number' ? d.max_contacts : undefined,
        maxChannels: typeof d.max_channels === 'number' ? d.max_channels : undefined,
        blePin: typeof d.ble_pin === 'number' ? d.ble_pin : undefined,
        repeat: typeof d.repeat === 'boolean' ? d.repeat : undefined,
        pathHashMode: typeof d.path_hash_mode === 'number' ? d.path_hash_mode : undefined,
      };
    } catch (error) {
      logger.warn(`[MeshCore:${this.sourceId}] deviceQuery failed:`, error);
      return null;
    }
  }

  // ============ Getters ============

  getConnectionStatus(): { connected: boolean; deviceType: MeshCoreDeviceType; config: MeshCoreConfig | null } {
    return {
      connected: this.connected,
      deviceType: this.deviceType,
      config: this.config,
    };
  }

  /**
   * Source-registry-compatible status snapshot. Satisfies ISourceManager.getStatus().
   * The optional `sourceName` arg lets narrowed callers pass the live name from DB
   * (e.g. the /status route). When omitted, the stored this.sourceName is used so
   * aggregate getAllStatuses() calls return a meaningful name.
   */
  getStatus(sourceName?: string): SourceStatus {
    return {
      sourceId: this.sourceId,
      sourceName: sourceName ?? this.sourceName,
      sourceType: 'meshcore',
      connected: this.connected,
    };
  }

  /**
   * ISourceManager contract. MeshCore nodes have no meshtastic-style nodeNum,
   * so this returns null rather than fabricate a value. Meshcore-specific code
   * should use getLocalNode() directly on the narrowed MeshCoreManager.
   */
  getLocalNodeInfo(): null {
    return null;
  }

  getLocalNode(): MeshCoreNode | null {
    return this.localNode;
  }

  getContacts(): MeshCoreContact[] {
    return Array.from(this.contacts.values());
  }

  /**
   * Look up a single in-memory contact by full public key. Returns
   * `undefined` if the contact hasn't been seen yet on this connection.
   * Used by routes that need the contact's advType/advName at config
   * time (e.g. telemetry-config seed) so they can backfill the SQL row.
   */
  getContact(publicKey: string): MeshCoreContact | undefined {
    return this.contacts.get(publicKey);
  }

  /**
   * Full node list for this source: durable per-source `meshcore_nodes` rows
   * merged with the live in-memory contact map and the live local node.
   *
   * The DB rows are the base so the list reflects every known node even when
   * `this.contacts` is transiently empty (e.g. right after a reconnect, before
   * `refreshContacts` has refilled it) — previously this returned only the
   * in-memory map, so a momentarily-empty map collapsed the UI to a single
   * node. In-memory contacts overlay the DB rows since they carry the freshest
   * rssi/snr/position; DB-only fields (battery, uptime, radio) are preserved.
   */
  async getAllNodes(): Promise<MeshCoreNode[]> {
    const byKey = new Map<string, MeshCoreNode>();

    try {
      const dbNodes = await databaseService.meshcore.getNodesBySource(this.sourceId);
      for (const n of dbNodes) {
        // The local node's row is intentionally NOT skipped here (even though
        // it's re-added "live" below) — it needs to land in `byKey` so the
        // merge below can pull its DB-only fields (batteryMv, uptimeSecs)
        // forward. It's deduped via the `byKey.delete()` call after the
        // merge, not by exclusion here. Excluding it here previously made
        // the merge a no-op once isLocalNode started being persisted (#3884).
        byKey.set(n.publicKey, {
          publicKey: n.publicKey,
          name: n.name || 'Unknown',
          advType: (n.advType ?? MeshCoreDeviceType.UNKNOWN) as MeshCoreDeviceType,
          lastHeard: n.lastHeard ?? undefined,
          rssi: n.rssi ?? undefined,
          snr: n.snr ?? undefined,
          latitude: n.latitude ?? undefined,
          longitude: n.longitude ?? undefined,
          batteryMv: n.batteryMv ?? undefined,
          uptimeSecs: n.uptimeSecs ?? undefined,
          txPower: n.txPower ?? undefined,
          maxTxPower: n.maxTxPower ?? undefined,
          radioFreq: n.radioFreq ?? undefined,
          radioBw: n.radioBw ?? undefined,
          radioSf: n.radioSf ?? undefined,
          radioCr: n.radioCr ?? undefined,
          isFavorite: n.isFavorite ?? false,
        });
      }
    } catch (err) {
      logger.warn(
        `[MeshCore:${this.sourceId}] getAllNodes: DB read failed, falling back to in-memory contacts: ${(err as Error).message}`,
      );
    }

    // Overlay live in-memory contacts (freshest rssi/snr/position), merging
    // over any persisted row so DB-only fields aren't lost.
    for (const contact of this.contacts.values()) {
      const base = byKey.get(contact.publicKey);
      byKey.set(contact.publicKey, {
        ...base,
        publicKey: contact.publicKey,
        name: contact.advName || contact.name || base?.name || 'Unknown',
        advType: (contact.advType ?? base?.advType ?? MeshCoreDeviceType.UNKNOWN) as MeshCoreDeviceType,
        lastHeard: contact.lastSeen ?? base?.lastHeard,
        rssi: contact.rssi ?? base?.rssi,
        snr: contact.snr ?? base?.snr,
        latitude: contact.latitude ?? base?.latitude,
        longitude: contact.longitude ?? base?.longitude,
      });
    }

    const nodes: MeshCoreNode[] = [];
    if (this.localNode) {
      // this.localNode comes from `get_self_info` (name/radio config only —
      // no battery/uptime), so merge it over the persisted DB row rather than
      // replacing it outright. Without this, the local node's batteryMv from
      // the telemetry poller was silently dropped every time it was
      // overlaid, leaving the companion's own battery permanently blank in
      // the UI even though it was correctly persisted (#3884).
      const persisted = byKey.get(this.localNode.publicKey);
      nodes.push(persisted ? { ...persisted, ...this.localNode } : this.localNode);
      byKey.delete(this.localNode.publicKey);
    }
    nodes.push(...byKey.values());

    // Final guard: never surface a bogus position (out-of-range junk like
    // lat 1853 / lng -1598, or a Null Island default) to the node list / map
    // bounds — no matter whether it came from a live in-memory contact or a
    // stale DB row an unguarded historical write left behind. A bad fix reads
    // as "no position" instead of blowing the map out to nothing (#3763
    // follow-up). The write path (repository upsertNode) keeps new garbage out
    // of the DB; this is the read-side backstop for anything already there.
    for (const n of nodes) {
      if (isBogusPosition(n.latitude ?? null, n.longitude ?? null)) {
        n.latitude = undefined;
        n.longitude = undefined;
      }
    }
    return nodes;
  }

  /**
   * Toggle the server-side favorite flag for a node (issue #3588). MeshCore
   * firmware has no native favorite concept, so this persists locally only
   * and never pushes anything to the device. Favorited nodes pin to the top
   * of the node list.
   */
  async setNodeFavorite(publicKey: string, isFavorite: boolean): Promise<void> {
    await databaseService.meshcore.setNodeFavorite(this.sourceId, publicKey, isFavorite);
  }

  getRecentMessages(limit: number = 50): MeshCoreMessage[] {
    return this.messages.slice(-limit);
  }

  /**
   * Per-channel message backlog, queried straight from the DB so each channel
   * gets its own history independent of the shared in-memory pool and the
   * global recent-tail that {@link getRecentMessages} serves. Returns
   * oldest-first to match the ordering the message stream expects.
   */
  async getChannelMessages(channelIdx: number, limit: number = 100): Promise<MeshCoreMessage[]> {
    const stored = await databaseService.meshcore.getChannelMessages(
      channelIdx,
      limit,
      this.sourceId,
    );
    // Enrich outgoing channel messages with their heard-by repeater set (#3700)
    // in one batched query.
    const heardByMap = await databaseService.meshcore.getHeardRepeatersForMessages(
      stored.map(m => m.id),
      this.sourceId,
    );
    // DB returns newest-first; reverse to oldest-first for the UI.
    return stored.reverse().map(dbMsg => {
      const heard = heardByMap[dbMsg.id];
      return {
        id: dbMsg.id,
        fromPublicKey: dbMsg.fromPublicKey,
        fromName: dbMsg.fromName ?? undefined,
        toPublicKey: dbMsg.toPublicKey ?? undefined,
        text: dbMsg.text,
        timestamp: dbMsg.timestamp,
        rssi: dbMsg.rssi ?? undefined,
        snr: dbMsg.snr ?? undefined,
        sourceId: dbMsg.sourceId ?? undefined,
        heardBy: heard && heard.length > 0
          ? heard.map(r => ({ hash: r.repeaterHash, name: r.repeaterName, snr: r.snr }))
          : undefined,
      };
    });
  }

  /**
   * Total persisted message count per channel index, for the channel-list
   * badges. Accurate per channel (not the capped in-memory pool), so quiet
   * channels don't read as empty next to a busy one.
   */
  async getChannelMessageCounts(channelIndices: number[]): Promise<Record<number, number>> {
    return databaseService.meshcore.getChannelMessageCounts(channelIndices, this.sourceId);
  }

  /**
   * Latest persisted message timestamp per channel index, for the channel-list
   * unread indicator (#3703). Channels with no messages are omitted.
   */
  async getChannelLatestTimestamps(channelIndices: number[]): Promise<Record<number, number>> {
    return databaseService.meshcore.getChannelLatestTimestamps(channelIndices, this.sourceId);
  }

  // ============ Message deletion / purge (#3981) ============
  //
  // Every path deletes from the DB scoped to THIS source, prunes the in-memory
  // pool (so getRecentMessages / the reconnect catch-up don't resurrect a
  // deleted row), and broadcasts a meshcore:messages:deleted event so every
  // connected client prunes its view immediately.

  /**
   * Two keys refer to the same MeshCore peer when either is a prefix of the
   * other — inbound DMs are stored under a pubkey *prefix* while outbound and
   * contacts use the full key. Mirrors the frontend `keysMatch`.
   */
  private static keysMatch(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b) || b.startsWith(a);
  }

  /**
   * Delete a single stored message (#3981). Returns true if a row was deleted.
   */
  async deleteStoredMessage(id: string): Promise<boolean> {
    const deleted = await databaseService.meshcore.deleteMessageForSource(id, this.sourceId);
    if (deleted) {
      this.messages = this.messages.filter(m => m.id !== id);
      dataEventEmitter.emitMeshCoreMessagesDeleted({ ids: [id] }, this.sourceId);
    }
    return deleted;
  }

  /**
   * Clear a whole DM conversation with `publicKey` (#3981). Because inbound and
   * outbound rows key the peer differently (prefix vs full key), the id set is
   * resolved in JS with the same prefix match the frontend uses, then deleted
   * by id. Channel pseudo-messages and room posts are never swept up. Returns
   * the number of rows deleted.
   */
  async purgeConversation(publicKey: string): Promise<number> {
    const rows = await databaseService.meshcore.getMessageEndpointsForSource(this.sourceId);
    const selfKey = this.localNode?.publicKey;
    const ids = rows
      .filter(r => {
        if (r.messageType === 'room_post') return false;
        if (r.fromPublicKey.startsWith('channel-')) return false;
        if (r.toPublicKey && r.toPublicKey.startsWith('channel-')) return false;
        // A row belongs to this conversation when the peer appears on either
        // endpoint. When we know our own key, exclude it so a self-key match
        // doesn't drag in unrelated peers' rows.
        const fromPeer = !MeshCoreManager.keysMatch(r.fromPublicKey, selfKey)
          && MeshCoreManager.keysMatch(r.fromPublicKey, publicKey);
        const toPeer = !MeshCoreManager.keysMatch(r.toPublicKey, selfKey)
          && MeshCoreManager.keysMatch(r.toPublicKey, publicKey);
        return fromPeer || toPeer;
      })
      .map(r => r.id);
    if (ids.length === 0) return 0;
    const count = await databaseService.meshcore.deleteMessagesByIds(ids, this.sourceId);
    if (count > 0) {
      const deleted = new Set(ids);
      this.messages = this.messages.filter(m => !deleted.has(m.id));
      dataEventEmitter.emitMeshCoreMessagesDeleted({ conversationPublicKey: publicKey }, this.sourceId);
    }
    return count;
  }

  /**
   * Clear every message on a channel index (#3981). Returns rows deleted.
   */
  async purgeChannelMessages(channelIdx: number): Promise<number> {
    const count = await databaseService.meshcore.deleteChannelMessagesForSource(channelIdx, this.sourceId);
    if (count > 0) {
      const key = `channel-${channelIdx}`;
      this.messages = this.messages.filter(m => {
        // Mirror channelWhereClause: synthetic channel key on either side, plus
        // the channel-0 legacy broadcast rows (no recipient, non-synthetic sender).
        if (m.fromPublicKey === key || m.toPublicKey === key) return false;
        if (channelIdx === 0 && !m.toPublicKey && !m.fromPublicKey.startsWith('channel-')) return false;
        return true;
      });
      dataEventEmitter.emitMeshCoreMessagesDeleted({ channelIdx }, this.sourceId);
    }
    return count;
  }

  /**
   * Purge every message for this source (#3981). Returns rows deleted.
   */
  async purgeAllMessages(): Promise<number> {
    const count = await databaseService.meshcore.deleteAllMessagesForSource(this.sourceId);
    this.messages = [];
    dataEventEmitter.emitMeshCoreMessagesDeleted({ all: true }, this.sourceId);
    return count;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ============ Heartbeat / auto-reconnect (native-backend only) ============
  //
  // State machine: disconnected → connecting → connected → reconnecting → …
  // Probe is `getDeviceTime()` (cheap RTC read, no RF). N consecutive
  // failures triggers a teardown + exponential-backoff reconnect. See
  // docs/internal/meshcore-design/meshcore-heartbeat-proposal.md for the full design.

  getHeartbeatStatus(): MeshCoreHeartbeatStatus {
    return {
      state: this.connectionState,
      consecutiveFailures: this.heartbeatConsecutiveFailures,
      lastSuccessfulProbeAt: this.heartbeatLastSuccessAt,
      nextReconnectAt: this.nextReconnectAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Start the heartbeat probe loop. Called automatically from connect() when
   * the native backend is in use. Idempotent: if interval is 0 or a scheduler
   * is already running, it's a no-op.
   */
  private startHeartbeat(): void {
    const intervalSecs = this.config?.heartbeatIntervalSeconds ?? 0;
    if (intervalSecs <= 0) {
      // Heartbeat disabled — preserves prior behaviour.
      return;
    }
    if (this.heartbeatScheduler?.running) return;
    this.shouldReconnect = true;
    this.heartbeatScheduler = new HeartbeatScheduler({
      label: `MeshCore:${this.sourceId}`,
      intervalMs: intervalSecs * 1000,
      timeoutMs: this.config?.heartbeatTimeoutMs ?? 5000,
      probe: (t) => this.heartbeatProbe(t),
      isConnected: () => this.connectionState === 'connected' && !!this.nativeBackend,
      onSuccess: (ms) => this.onHeartbeatOk(ms),
      onFailure: (e) => this.recordHeartbeatFailure(e),
    });
    this.heartbeatScheduler.start();
    logger.info(`[MeshCore:${this.sourceId}] Heartbeat started (every ${intervalSecs}s)`);
  }

  private stopHeartbeat(): void {
    this.heartbeatScheduler?.stop();
    this.heartbeatScheduler = null;
  }

  /**
   * Wire-level probe operation: sends a cheap `get_device_time` RTC read to
   * the native backend and returns `true` on success or throws on failure, so
   * the {@link HeartbeatScheduler} can route the result to the appropriate
   * callback without knowing about MeshCore command vocabulary.
   */
  private async heartbeatProbe(timeoutMs: number): Promise<boolean> {
    if (!this.nativeBackend) {
      throw new Error('no native backend');
    }
    const response = await this.nativeBackend.sendCommand('get_device_time', {}, timeoutMs);
    if (response.success) return true;
    throw new Error(response.error ?? 'probe failed');
  }

  /** Called by the scheduler on a successful probe. */
  private onHeartbeatOk(latencyMs: number): void {
    this.heartbeatConsecutiveFailures = 0;
    this.heartbeatLastSuccessAt = Date.now();
    this.emit('heartbeat_ok', { sourceId: this.sourceId, latencyMs });
  }

  private recordHeartbeatFailure(err: Error): void {
    this.heartbeatConsecutiveFailures += 1;
    const max = this.config?.heartbeatMaxFailures ?? 3;
    this.emit('heartbeat_failed', {
      sourceId: this.sourceId,
      consecutiveFailures: this.heartbeatConsecutiveFailures,
      error: err.message,
    });
    if (this.heartbeatConsecutiveFailures >= max) {
      logger.warn(
        `[MeshCore:${this.sourceId}] Heartbeat threshold reached (${this.heartbeatConsecutiveFailures}/${max}); reconnecting`,
      );
      this.beginReconnect();
    }
  }

  private beginReconnect(): void {
    if (this.connectionState === 'reconnecting' || this.connectionState === 'failed') return;
    this.connectionState = 'reconnecting';
    this.stopHeartbeat();
    // Tear down the live transport without clearing shouldReconnect, so the
    // closure that fires after the backoff can re-enter connect().
    void this.teardownTransportOnly().then(() => this.scheduleNextReconnect());
  }

  /**
   * React to a socket/serial-level drop the native backend reported on its own
   * (meshcore.js 'disconnected'), as opposed to a teardown we initiated. Without
   * this, a dropped link left the manager stuck `connected = true`: isConnected()
   * kept returning true, so the Virtual Node server answered AppStart with a
   * stale SelfInfo while real sends silently failed, and — when heartbeat/auto-
   * reconnect is disabled (the default) — nothing ever recovered.
   *
   * When auto-reconnect is enabled (`shouldReconnect`), hand off to the existing
   * backoff machinery. Otherwise just reflect reality: drop to disconnected and
   * stop the VN server so it stops serving a phantom node. The next manual
   * connect() brings everything back.
   */
  private async handleUnexpectedDisconnect(): Promise<void> {
    // Our own disconnect()/teardownTransportOnly() closed the link — expected.
    if (this.intentionalTeardown) return;
    // Already past 'connected' (a teardown/reconnect is in flight) — nothing to do.
    if (this.connectionState !== 'connected') return;

    logger.warn(`[MeshCore:${this.sourceId}] Connection lost (native backend socket closed)`);

    if (this.shouldReconnect) {
      // Heartbeat-style auto-reconnect is enabled: drive the existing teardown +
      // exponential-backoff path (which stops the VN server and reconnects).
      this.beginReconnect();
      return;
    }

    // Auto-reconnect disabled: surface the disconnect so the UI updates and the
    // VN server stops answering with a stale identity. Mirrors disconnect()'s
    // user-visible side effects without clearing the cached node/contacts.
    // Set connectionState first so a re-emitted 'disconnected' from the backend
    // teardown below short-circuits on the `!== 'connected'` guard above.
    this.connected = false;
    this.connectionState = 'disconnected';
    this.stopHeartbeat();
    await this.stopVirtualNodeServer();
    // Release the dead backend. Without this `nativeBackend` keeps pointing at a
    // closed connection, so sendBridgeCommand()'s `!nativeBackend` guard never
    // trips and callers get a confusing write-to-closed error instead of a clean
    // "disconnected" until /connect runs. Nulling it also makes the listener's
    // stale-instance guard reject any late event from this backend.
    if (this.nativeBackend) {
      try {
        await this.nativeBackend.disconnect();
      } catch (err) {
        logger.debug(`[MeshCore:${this.sourceId}] dead-backend cleanup threw: ${(err as Error).message}`);
      }
      this.nativeBackend = null;
    }
    this.emit('disconnected');
    dataEventEmitter.emitMeshCoreStatusUpdated({ connected: false }, this.sourceId);
  }

  /**
   * Tear down the transport without clearing `shouldReconnect`. Mirrors the
   * relevant half of `disconnect()` but preserves reconnect intent.
   */
  private async teardownTransportOnly(): Promise<void> {
    // This is a deliberate teardown (heartbeat-driven reconnect); suppress the
    // native backend's own 'disconnected' event so it doesn't re-enter the
    // unexpected-drop path. connect() clears the flag when the reconnect lands.
    this.intentionalTeardown = true;

    // Stop the Virtual Node server first, same as disconnect() does. Without
    // this, the VN server keeps accepting app connections while isConnected()
    // is false, causing every AppStart to get BadState and the app to loop in
    // "Connecting". The server restarts in connect() once the real node is back.
    await this.stopVirtualNodeServer();

    if (this.nativeBackend) {
      try {
        await this.nativeBackend.disconnect();
      } catch (err) {
        logger.debug(`[MeshCore:${this.sourceId}] Native backend teardown threw: ${(err as Error).message}`);
      }
      this.nativeBackend = null;
    }
    this.connected = false;
    // The MeshCore session on the wire is gone — any guest-login state on
    // the previous connection no longer applies. Local node / contacts
    // cache is intentionally preserved; the next connect() will refresh
    // them.
    this.guestLoggedInNodes.clear();
    // Keep `connectionState = 'reconnecting'`; do not clear the local node /
    // contacts cache — the next connect() will refresh them.
  }

  private scheduleNextReconnect(): void {
    // Idempotent: a retry may already be scheduled by an earlier step in the
    // same failure path — e.g. connect()'s catch block schedules one before
    // returning to attemptReconnect(), which would otherwise schedule a
    // second one on top of it, doubling reconnectAttempts (and the backoff
    // growth it drives) and leaking the first timer (#3918 follow-up).
    if (this.reconnectTimer) return;
    if (!this.shouldReconnect) {
      this.connectionState = 'failed';
      return;
    }
    const maxAttempts = this.config?.reconnectMaxAttempts ?? 0;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.connectionState = 'failed';
      this.emit('reconnect_giveup', { sourceId: this.sourceId });
      logger.warn(`[MeshCore:${this.sourceId}] Reconnect gave up after ${this.reconnectAttempts} attempts`);
      return;
    }

    const initial = this.config?.reconnectInitialDelayMs ?? 1000;
    const cap = this.config?.reconnectMaxDelayMs ?? 60000;
    const delay = Math.min(initial * Math.pow(2, this.reconnectAttempts), cap);
    this.reconnectAttempts += 1;
    this.nextReconnectAt = Date.now() + delay;

    this.emit('reconnecting', {
      sourceId: this.sourceId,
      attempt: this.reconnectAttempts,
      nextDelayMs: delay,
    });
    logger.debug(`[MeshCore:${this.sourceId}] Reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      void this.attemptReconnect();
    }, delay);
  }

  // ============ Auto-Pathfinding Scheduler ============

  async startAutoPathfinding(): Promise<void> {
    this.stopAutoPathfinding();

    const enabledRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoPathfindingEnabled');
    if (enabledRaw !== 'true') {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding disabled`);
      return;
    }

    const pathDiscoveryEnabled = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoPathfindingPathDiscoveryEnabled')) === 'true';
    const neighborsEnabled = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoPathfindingNeighborsEnabled')) === 'true';

    if (!pathDiscoveryEnabled && !neighborsEnabled) {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: both sub-features disabled`);
      return;
    }

    const intervalMinutesRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoPathfindingIntervalMinutes');
    const intervalMinutes = Math.max(3, parseInt(intervalMinutesRaw || '5', 10) || 5);
    const intervalMs = intervalMinutes * 60 * 1000;

    const repeatHoursRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoPathfindingRepeatHours');
    const repeatHours = Math.max(1, parseInt(repeatHoursRaw || '24', 10) || 24);
    const repeatMs = repeatHours * 60 * 60 * 1000;

    const maxJitterMs = Math.min(repeatMs, 5 * 60 * 1000);
    const initialJitterMs = Math.random() * maxJitterMs;

    logger.info(`[MeshCore:${this.sourceId}] Auto-pathfinding: starting (pathDiscovery=${pathDiscoveryEnabled}, neighbors=${neighborsEnabled}, interval=${intervalMinutes}m, repeat=${repeatHours}h, jitter=${Math.round(initialJitterMs / 1000)}s)`);

    const executeRun = async () => {
      if (!this.connected) {
        logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: skipping — not connected`);
        return;
      }

      const contacts = this.getContacts();
      if (contacts.length === 0) {
        logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: no contacts`);
        return;
      }

      // Filter config is re-read fresh every run (not captured at scheduler
      // start) so a config change takes effect on the next tick without
      // requiring a scheduler restart — see PATHFINDING_FILTER_SPEC.md §0/§3.2.
      const filterCfg = await databaseService.getMeshcorePathfindingFilterSettingsAsync(this.sourceId);
      const filtered = filterPathfindingContacts(contacts, filterCfg);
      logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: filter ${contacts.length}→${filtered.length} contacts (enabled=${filterCfg.enabled})`);

      const companions = pathDiscoveryEnabled
        ? filtered.filter(c => c.advType === MeshCoreDeviceType.COMPANION)
        : [];
      const repeaters = neighborsEnabled
        ? filtered.filter(c => c.advType === MeshCoreDeviceType.REPEATER)
        : [];

      const targets = [
        ...companions.map(c => ({ key: c.publicKey, name: c.advName || c.name || c.publicKey.substring(0, 16), op: 'discover_path' as const })),
        ...repeaters.map(c => ({ key: c.publicKey, name: c.advName || c.name || c.publicKey.substring(0, 16), op: 'get_neighbours' as const })),
      ];

      if (targets.length === 0) {
        logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: no eligible targets`);
        return;
      }

      logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: running on ${companions.length} companions + ${repeaters.length} repeaters`);

      for (let i = 0; i < targets.length; i++) {
        if (!this.connected) break;
        const t = targets[i];
        try {
          if (t.op === 'discover_path') {
            const ok = await this.discoverContactPath(t.key);
            logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: discover_path ${t.name} → ${ok ? 'sent' : 'failed'}`);
          } else {
            const result = await this.getNeighbours(t.key);
            if (result && result.neighbours.length > 0) {
              const toStore = result.neighbours
                .map(n => {
                  const contact = this.resolveContactByPrefix(n.publicKeyPrefix);
                  return contact?.publicKey
                    ? { neighborPublicKey: contact.publicKey, snr: n.snr, lastHeardSecs: n.heardSecondsAgo }
                    : null;
                })
                .filter((n): n is NonNullable<typeof n> => n !== null);
              if (toStore.length > 0) {
                databaseService.meshcore.insertNeighborsBatch(this.sourceId, t.key, toStore)
                  .catch((err: Error) => logger.warn(`[MeshCore:${this.sourceId}] Auto-pathfinding: failed to persist neighbours: ${err.message}`));
              }
            }
            logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: get_neighbours ${t.name} → ${result ? result.total + ' neighbours' : 'failed'}`);
          }
        } catch (err) {
          logger.warn(`[MeshCore:${this.sourceId}] Auto-pathfinding: ${t.op} ${t.name} threw: ${(err as Error).message}`);
        }

        if (i < targets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      }

      this.autoPathfindingLastRunAt = Date.now();
      logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: run complete`);
    };

    this.autoPathfindingJitterTimeout = setTimeout(() => {
      this.autoPathfindingJitterTimeout = null;
      executeRun().catch(err => logger.error('[MeshCore] Auto-pathfinding scheduler error:', err));
      this.autoPathfindingTimer = setInterval(executeRun, repeatMs);
    }, initialJitterMs);
  }

  stopAutoPathfinding(): void {
    if (this.autoPathfindingJitterTimeout) {
      clearTimeout(this.autoPathfindingJitterTimeout);
      this.autoPathfindingJitterTimeout = null;
    }
    if (this.autoPathfindingTimer) {
      clearInterval(this.autoPathfindingTimer);
      this.autoPathfindingTimer = null;
    }
  }

  getAutoPathfindingStatus(): { enabled: boolean; lastRunAt: number } {
    return {
      enabled: this.autoPathfindingTimer !== null || this.autoPathfindingJitterTimeout !== null,
      lastRunAt: this.autoPathfindingLastRunAt,
    };
  }

  // ============ Auto-Announce ============
  //
  // Periodic broadcast of an operator-defined status message to one or
  // more MeshCore channels. Mirrors the Meshtastic auto-announce
  // feature, but the firing primitive here is a per-source scheduler
  // (cron OR setInterval) since MeshCore manager instances are 1:N with
  // sources. Both modes call the same runner; the cron path runs from
  // croner with missed-execution recovery, the interval path uses
  // setInterval.

  /**
   * Render a message template against this source's current state.
   * Pulled into an instance method so the announce-preview route can
   * resolve tokens with the right contact list / local node.
   */
  async previewAnnouncementMessage(template: string): Promise<string> {
    return replaceMeshCoreAnnounceTokens(template, this);
  }

  /**
   * (Re)start the auto-announce scheduler based on the current settings
   * for this source. Always stops first so a settings change re-arms
   * the timer cleanly. Safe to call when not yet connected — the runner
   * is a no-op until `connected` is true.
   */
  async startAutoAnnounce(): Promise<void> {
    // stopAutoAnnounce clears both the scheduler and the advert timer.
    this.stopAutoAnnounce();

    const enabledRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceEnabled');
    if (enabledRaw !== 'true') {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-announce disabled`);
      return;
    }

    const useScheduleRaw = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceUseSchedule')) === 'true';
    const schedule = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceSchedule')) || '0 */6 * * *';
    const intervalHoursRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceIntervalHours');
    const intervalHours = Math.max(1, parseInt(intervalHoursRaw || '6', 10) || 6);

    let mode: ScheduleMode;
    if (useScheduleRaw) {
      mode = { kind: 'cron', expression: schedule };
    } else {
      const periodMs = intervalHours * 60 * 60 * 1000;
      mode = { kind: 'interval', intervalMs: periodMs };
    }

    this.announceScheduler = new CronOrIntervalScheduler({
      label: `MeshCore:${this.sourceId}`,
      mode,
      onTick: () => {
        void this.runAutoAnnounceCycle(useScheduleRaw ? 'cron' : 'interval');
      },
    });

    if (!this.announceScheduler.start()) {
      // cron expression was invalid; warning already logged by the scheduler
      logger.warn(`[MeshCore:${this.sourceId}] Auto-announce: invalid cron expression "${schedule}", not scheduling`);
      this.announceScheduler = null;
      return;
    }

    if (useScheduleRaw) {
      logger.info(`[MeshCore:${this.sourceId}] Auto-announce: cron scheduled (${schedule})`);
    } else {
      logger.info(`[MeshCore:${this.sourceId}] Auto-announce: interval scheduled every ${intervalHours}h`);
    }
  }

  /** Cancel the announce scheduler and any pending advert timer. Idempotent. */
  stopAutoAnnounce(): void {
    if (this.announceScheduler) {
      this.announceScheduler.stop();
      this.announceScheduler = null;
    }
    if (this.autoAnnounceAdvertTimer) {
      clearTimeout(this.autoAnnounceAdvertTimer);
      this.autoAnnounceAdvertTimer = null;
    }
  }

  /**
   * Fire one announcement cycle immediately — broadcast the rendered
   * template to every configured channel, optionally followed by an
   * advert. Returns the number of channels successfully transmitted to
   * so the route handler can surface partial failures.
   */
  async runAutoAnnounceCycle(reason: 'cron' | 'interval' | 'on_start' | 'manual'): Promise<{ sent: number; total: number }> {
    if (!this.connected) {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-announce: skipping (${reason}) — not connected`);
      return { sent: 0, total: 0 };
    }
    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-announce: skipping (${reason}) — repeater cannot transmit chat`);
      return { sent: 0, total: 0 };
    }

    const message = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceMessage')) || '';
    if (!message.trim()) {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-announce: skipping (${reason}) — empty template`);
      return { sent: 0, total: 0 };
    }

    const channelsCsv = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceChannelIndexes')) || '';
    const channelIndexes = channelsCsv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n));

    if (channelIndexes.length === 0) {
      logger.debug(`[MeshCore:${this.sourceId}] Auto-announce: skipping (${reason}) — no channels configured`);
      return { sent: 0, total: 0 };
    }

    // Scope/region for the announcement (#3833). No trigger message, so 'trigger'
    // mode degrades to inherit. `undefined` (inherit) preserves prior behavior
    // where the per-channel / source-default scope already applied.
    const scopeOverride = MeshCoreManager.resolveAutomationScopeOverride({
      scopeMode: (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceScopeMode')) as MeshCoreAutomationScopeMode | undefined,
      scopeName: (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceScopeName')) ?? undefined,
    });

    const rendered = await replaceMeshCoreAnnounceTokens(message, this);
    let sent = 0;
    for (const idx of channelIndexes) {
      try {
        // Automated sender → opt into channel-send auto-retry (#3979).
        const ok = await this.sendMessage(rendered, undefined, idx, scopeOverride, true);
        if (ok) sent += 1;
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] Auto-announce: send to channel ${idx} threw: ${(err as Error).message}`);
      }
    }

    this.autoAnnounceLastRunAt = Date.now();
    await databaseService.settings.setSourceSetting(this.sourceId, 'meshcoreAutoAnnounceLastRunAt', String(this.autoAnnounceLastRunAt));
    logger.debug(`[MeshCore:${this.sourceId}] Auto-announce (${reason}): ${sent}/${channelIndexes.length} channels`);

    // Optional advert burst N seconds after the announcement.
    const advertEnabled = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceAdvertEnabled')) === 'true';
    if (advertEnabled) {
      const delayRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoAnnounceAdvertDelaySeconds');
      const delaySec = Math.max(0, Math.min(600, parseInt(delayRaw || '30', 10) || 30));
      if (this.autoAnnounceAdvertTimer) clearTimeout(this.autoAnnounceAdvertTimer);
      this.autoAnnounceAdvertTimer = setTimeout(() => {
        this.autoAnnounceAdvertTimer = null;
        if (!this.connected) return;
        void this.sendAdvert().catch((err: Error) => {
          logger.warn(`[MeshCore:${this.sourceId}] Auto-announce: advert burst failed: ${err.message}`);
        });
      }, delaySec * 1000);
    }

    return { sent, total: channelIndexes.length };
  }

  /** Read-only view for the route handler / UI. */
  getAutoAnnounceStatus(): { enabled: boolean; lastRunAt: number } {
    return {
      enabled: this.announceScheduler?.running ?? false,
      lastRunAt: this.autoAnnounceLastRunAt,
    };
  }

  // ============ Timer Triggers ============
  //
  // Operator-defined recurring jobs. Each trigger persists as an entry
  // in the JSON blob at `meshcoreTimerTriggers` and gets scheduled on
  // start (or whenever settings are saved). A trigger may either:
  //   - send a text message to a channel/contact (with token expansion)
  //   - run an advert
  // Script execution is intentionally not wired here yet — the
  // existing /api/scripts surface is shared with Meshtastic and the
  // sandbox semantics need a follow-up to handle MeshCore context.

  /**
   * Reload all timer-trigger schedules from settings. Idempotent —
   * cancels existing schedules first.
   */
  async startTimerTriggers(): Promise<void> {
    this.stopTimerTriggers();
    const raw = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreTimerTriggers')) || '[]';
    let triggers: MeshCoreTimerTrigger[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) triggers = parsed as MeshCoreTimerTrigger[];
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] Timer triggers: failed to parse JSON: ${(err as Error).message}`);
      return;
    }

    for (const trigger of triggers) {
      if (!trigger || !trigger.id || !trigger.enabled) continue;
      this.armTimerTrigger(trigger);
    }
  }

  /** Cancel every armed timer trigger. */
  stopTimerTriggers(): void {
    for (const job of this.timerTriggerCrons.values()) {
      try { job.stop(); } catch { /* ignore */ }
    }
    this.timerTriggerCrons.clear();
    for (const handle of this.timerTriggerIntervals.values()) {
      clearInterval(handle);
    }
    this.timerTriggerIntervals.clear();
  }

  private armTimerTrigger(trigger: MeshCoreTimerTrigger): void {
    if (trigger.scheduleType === 'interval') {
      const minutes = Math.max(1, Math.min(60 * 24 * 7, trigger.intervalMinutes || 0));
      if (!Number.isFinite(minutes) || minutes <= 0) {
        logger.warn(`[MeshCore:${this.sourceId}] Timer trigger ${trigger.id}: invalid interval, skipping`);
        return;
      }
      const handle = setInterval(() => {
        void this.runTimerTrigger(trigger.id).catch((err: Error) => {
          logger.warn(`[MeshCore:${this.sourceId}] Timer trigger ${trigger.id} run failed: ${err.message}`);
        });
      }, minutes * 60 * 1000);
      this.timerTriggerIntervals.set(trigger.id, handle);
      logger.info(`[MeshCore:${this.sourceId}] Timer trigger "${trigger.name}" (interval ${minutes}m) armed`);
    } else {
      const expr = trigger.cronExpression || '';
      if (!validateCron(expr)) {
        logger.warn(`[MeshCore:${this.sourceId}] Timer trigger ${trigger.id}: invalid cron "${expr}", skipping`);
        return;
      }
      try {
        const job = scheduleCron(expr, () => {
          void this.runTimerTrigger(trigger.id).catch((err: Error) => {
            logger.warn(`[MeshCore:${this.sourceId}] Timer trigger ${trigger.id} run failed: ${err.message}`);
          });
        });
        this.timerTriggerCrons.set(trigger.id, job);
        logger.info(`[MeshCore:${this.sourceId}] Timer trigger "${trigger.name}" (cron ${expr}) armed`);
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] Timer trigger ${trigger.id}: failed to schedule cron: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Execute a single timer trigger by ID (used both by the scheduler
   * callback and by the manual "Test trigger" button). Re-reads the
   * trigger from settings so a freshly-saved template fires on the
   * next tick without a restart.
   */
  async runTimerTrigger(triggerId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.connected) return { ok: false, reason: 'not connected' };
    if (this.deviceType === MeshCoreDeviceType.REPEATER) return { ok: false, reason: 'repeater cannot transmit chat' };

    const raw = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreTimerTriggers')) || '[]';
    let triggers: MeshCoreTimerTrigger[] = [];
    try { triggers = JSON.parse(raw); } catch { triggers = []; }
    const trigger = triggers.find(t => t?.id === triggerId);
    if (!trigger) return { ok: false, reason: 'trigger not found' };

    // Pre-build the dispatch closure so the script + text paths route
    // through identical destination logic. Returns false when the
    // trigger has no destination — the caller surfaces that reason.
    // Scope/region for the timer message (#3833). No trigger message, so
    // 'trigger' mode degrades to inherit (channel/source default).
    const scopeOverride = MeshCoreManager.resolveAutomationScopeOverride(trigger);
    const dispatch = async (text: string): Promise<boolean> => {
      if (trigger.destination === 'dm' && trigger.contactPublicKey) {
        return this.sendMessage(text, trigger.contactPublicKey, undefined, scopeOverride);
      }
      if (typeof trigger.channelIndex === 'number') {
        // Automated sender → opt into channel-send auto-retry (#3979).
        return this.sendMessage(text, undefined, trigger.channelIndex, scopeOverride, true);
      }
      return false;
    };

    let ok = true;
    let reason: string | undefined;
    try {
      if (trigger.responseType === 'advert') {
        ok = await this.sendAdvert();
        if (!ok) reason = 'advert failed';
      } else if (trigger.responseType === 'script') {
        if (!trigger.scriptPath) {
          ok = false;
          reason = 'script trigger missing scriptPath';
        } else if (trigger.destination !== 'dm' && typeof trigger.channelIndex !== 'number') {
          ok = false;
          reason = 'no destination configured';
        } else {
          const env = this.buildMeshCoreTimerScriptEnv(trigger);
          const result = await this.runMeshCoreScript(trigger.scriptPath, trigger.scriptArgs, env, dispatch, `Timer ${trigger.id}`);
          ok = result.success;
          if (!ok) reason = result.error || 'script execution failed';
        }
      } else {
        const body = await replaceMeshCoreAnnounceTokens(trigger.response || '', this);
        if (trigger.destination === 'dm' && trigger.contactPublicKey) {
          ok = await dispatch(body);
          if (!ok) reason = 'DM send failed';
        } else if (typeof trigger.channelIndex === 'number') {
          ok = await dispatch(body);
          if (!ok) reason = 'channel send failed';
        } else {
          ok = false;
          reason = 'no destination configured';
        }
      }
    } catch (err) {
      ok = false;
      reason = (err as Error).message;
    }

    // Persist last-run state back into the trigger row.
    const updated = triggers.map(t => t?.id === triggerId
      ? { ...t, lastRun: Date.now(), lastResult: ok ? 'success' as const : 'error' as const, lastError: ok ? undefined : reason }
      : t);
    await databaseService.settings.setSourceSetting(this.sourceId, 'meshcoreTimerTriggers', JSON.stringify(updated));

    return { ok, reason };
  }

  // ============ Auto-Responder ============
  //
  // Multi-pattern incoming-message reactor. Mirrors the high-level
  // shape of the Meshtastic AutoResponder but intentionally narrower:
  // text responses only, no script/HTTP/traceroute branches in v1.
  // Triggers are read live on each message so a settings save takes
  // effect on the next incoming packet without a restart.

  private autoResponderRegexCache: Map<string, RegExp | null> = new Map();

  /**
   * Build the env map for a script invocation triggered by an incoming
   * message. Variable names are intentionally shared with the
   * Meshtastic side (MESSAGE, FROM_NODE, NODE_ID, CHANNEL, IS_DIRECT,
   * SNR, FROM_LONG_NAME, FROM_SHORT_NAME) so a script that targets
   * common fields runs on both stacks. MeshCore-specific values get
   * MESHCORE_-prefixed names.
   */
  private buildMeshCoreResponderScriptEnv(
    message: MeshCoreMessage,
    isDM: boolean,
    channelIdx: number | undefined,
    trigger: MeshCoreAutoResponderTrigger,
  ): Record<string, string> {
    const env: Record<string, string> = {
      MESSAGE: message.text || '',
      FROM_NODE: message.fromPublicKey || '',
      NODE_ID: message.fromPublicKey ? message.fromPublicKey.substring(0, 16) : '',
      CHANNEL: typeof channelIdx === 'number' ? String(channelIdx) : '',
      IS_DIRECT: String(isDM),
      TRIGGER: trigger.pattern || '',
      MESHCORE_SOURCE_ID: this.sourceId,
      MESHCORE_DEVICE_TYPE: this.deviceType === MeshCoreDeviceType.COMPANION ? 'companion'
                          : this.deviceType === MeshCoreDeviceType.REPEATER ? 'repeater'
                          : this.deviceType === MeshCoreDeviceType.ROOM_SERVER ? 'room_server'
                          : 'unknown',
    };
    if (message.snr !== undefined && message.snr !== null) {
      env.SNR = String(message.snr);
    }
    if (message.fromName) {
      env.FROM_LONG_NAME = message.fromName;
      env.LONG_NAME = message.fromName;
    }
    // Resolve the sender contact to fill in the names — handleBridgeEvent
    // only carries `pubkey_prefix`, so the friendly name lives on the
    // cached contact, not the message itself.
    const contact = this.resolveContactByPrefix(message.fromPublicKey);
    if (contact) {
      if (contact.advName || contact.name) {
        const long = contact.advName || contact.name || '';
        env.FROM_LONG_NAME = long;
        env.LONG_NAME = long;
        env.FROM_SHORT_NAME = long.substring(0, 4);
        env.SHORT_NAME = long.substring(0, 4);
      }
      env.FROM_PUBLIC_KEY = contact.publicKey;
    }
    if (this.localNode?.name) env.NODE_LONG_NAME = this.localNode.name;
    return env;
  }

  /**
   * Build the env map for a script invocation triggered by a timer.
   * Lighter than the responder env — there's no incoming-message
   * context — but keeps TIMER_NAME / TIMER_ID so a timer script can
   * branch on which trigger fired it.
   */
  private buildMeshCoreTimerScriptEnv(trigger: MeshCoreTimerTrigger): Record<string, string> {
    const env: Record<string, string> = {
      TIMER_NAME: trigger.name || '',
      TIMER_ID: trigger.id,
      TIMER_SCRIPT: trigger.scriptPath || '',
      MESHCORE_SOURCE_ID: this.sourceId,
      MESHCORE_DEVICE_TYPE: this.deviceType === MeshCoreDeviceType.COMPANION ? 'companion'
                          : this.deviceType === MeshCoreDeviceType.REPEATER ? 'repeater'
                          : this.deviceType === MeshCoreDeviceType.ROOM_SERVER ? 'room_server'
                          : 'unknown',
    };
    if (typeof trigger.channelIndex === 'number') env.CHANNEL = String(trigger.channelIndex);
    if (this.localNode?.name) env.NODE_LONG_NAME = this.localNode.name;
    return env;
  }

  /** Whitespace-tokenize an argv string. Quoted segments stay intact. */
  private parseScriptArgsString(s: string): string[] {
    if (!s) return [];
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      out.push(m[1] ?? m[2] ?? m[3] ?? '');
    }
    return out;
  }

  /**
   * Common script-execution path used by both auto-responder and timer
   * trigger code. Runs the script, then sends each `wouldSendMessages`
   * entry through the supplied dispatch callback. Errors are logged
   * but never thrown — message-loop callers shouldn't crash on a bad
   * script.
   */
  private async runMeshCoreScript(
    scriptPath: string,
    scriptArgsString: string | undefined,
    env: Record<string, string>,
    dispatch: (text: string) => Promise<boolean>,
    triggerLabel: string,
  ): Promise<RunScriptResult> {
    const expandedArgs = scriptArgsString
      ? await replaceMeshCoreAnnounceTokens(scriptArgsString, this)
      : '';
    const argv = this.parseScriptArgsString(expandedArgs);
    const result = await runScript({ scriptPath, scriptArgs: argv, env });

    if (!result.success) {
      logger.warn(`[MeshCore:${this.sourceId}] ${triggerLabel} script error: ${result.error}${result.stderr ? ` | stderr: ${result.stderr.substring(0, 200)}` : ''}`);
      return result;
    }

    for (const msg of result.wouldSendMessages) {
      const trimmed = (msg || '').trim();
      if (!trimmed) continue;
      try {
        const ok = await dispatch(trimmed);
        if (!ok) {
          logger.warn(`[MeshCore:${this.sourceId}] ${triggerLabel} script: send failed for "${trimmed.substring(0, 50)}"`);
        }
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] ${triggerLabel} script: send threw: ${(err as Error).message}`);
      }
    }
    return result;
  }

  private getAutoResponderRegex(pattern: string): RegExp | null {
    if (this.autoResponderRegexCache.has(pattern)) {
      return this.autoResponderRegexCache.get(pattern)!;
    }
    // Reuse the auto-ack validator so ReDoS-shaped patterns are
    // rejected the same way at both surfaces.
    const compiled = compileAutoAckRegex(pattern).regex;
    this.autoResponderRegexCache.set(pattern, compiled);
    return compiled;
  }

  /**
   * On every incoming MeshCore message, run every enabled trigger's
   * regex; on the first match, render the response template and send
   * it. Subsequent triggers are still checked — multiple matches mean
   * multiple replies, which is the documented behavior.
   */
  private async checkAutoResponder(
    message: MeshCoreMessage,
    isDM: boolean,
    channelIdx: number | undefined,
    hops: number | null = null,
    route: string | null = null,
  ): Promise<void> {
    try {
      const enabledRaw = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoResponderEnabled');
      if (enabledRaw !== 'true') return;

      const raw = (await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoResponderTriggers')) || '[]';
      let triggers: MeshCoreAutoResponderTrigger[] = [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) triggers = parsed as MeshCoreAutoResponderTrigger[];
      } catch {
        return;
      }

      const text = message.text || '';
      if (!text) return;

      // Don't self-reply.
      if (this.localNode && message.fromPublicKey === this.localNode.publicKey) {
        return;
      }

      for (const trigger of triggers) {
        if (!trigger || !trigger.enabled || !trigger.pattern) continue;

        // Channel / DM filter.
        if (isDM && !trigger.listenDMs) continue;
        if (!isDM) {
          if (!Array.isArray(trigger.channels) || trigger.channels.length === 0) continue;
          if (typeof channelIdx !== 'number' || !trigger.channels.includes(channelIdx)) continue;
        }

        const regex = this.getAutoResponderRegex(trigger.pattern);
        if (!regex) {
          logger.warn(`[MeshCore:${this.sourceId}] Auto-responder ${trigger.id}: invalid regex "${trigger.pattern}"`);
          continue;
        }
        if (!regex.test(text)) continue;

        // Cooldown gate.
        const cooldownMs = Math.max(0, Math.min(3600, trigger.cooldownSeconds || 0)) * 1000;
        if (cooldownMs > 0) {
          const cooldownKey = `${trigger.id}:${message.fromPublicKey || 'unknown'}`;
          const last = this.autoResponderCooldowns.get(cooldownKey) || 0;
          if (Date.now() - last < cooldownMs) continue;
          this.autoResponderCooldowns.set(cooldownKey, Date.now());
        }

        // Build the dispatch closure once — it captures where the
        // response should go (DM to sender vs channel) so the script
        // path and text path can share it.
        const senderContact = this.resolveContactByPrefix(message.fromPublicKey);
        // Scope/region for the reply (#3833): inherit / trigger / unscoped / named.
        const scopeOverride = MeshCoreManager.resolveAutomationScopeOverride(trigger, message);
        const dispatch = async (text: string): Promise<boolean> => {
          if (trigger.replyAsDM || isDM) {
            const targetKey = senderContact?.publicKey || message.fromPublicKey;
            return this.sendMessage(text, targetKey, undefined, scopeOverride);
          }
          if (typeof channelIdx === 'number') {
            // Automated sender → opt into channel-send auto-retry (#3979).
            return this.sendMessage(text, undefined, channelIdx, scopeOverride, true);
          }
          return false;
        };

        // Pre-send delay (#3953): give a relaying repeater time to finish its
        // own TX before we reply. Applied once per fire (not per dispatch), so
        // a multi-message script response waits once up front rather than
        // before every send. Mirrors the Auto-Acknowledge pre-send delay.
        const preSendDelaySeconds = clampPreSendDelaySeconds(trigger.preSendDelaySeconds);
        if (preSendDelaySeconds > 0) {
          logger.debug(`[MeshCore:${this.sourceId}] Auto-responder ${trigger.id}: waiting ${preSendDelaySeconds}s before reply`);
          await new Promise((resolve) => setTimeout(resolve, preSendDelaySeconds * 1000));
        }

        if (trigger.responseType === 'script') {
          if (!trigger.scriptPath) {
            logger.warn(`[MeshCore:${this.sourceId}] Auto-responder ${trigger.id}: script trigger missing scriptPath`);
            continue;
          }
          const env = this.buildMeshCoreResponderScriptEnv(message, isDM, channelIdx, trigger);
          await this.runMeshCoreScript(trigger.scriptPath, trigger.scriptArgs, env, dispatch, `Auto-responder ${trigger.id}`);
          continue;
        }

        // Expand both global tokens (version/counts) AND the reply-context
        // tokens (sender/hops/route/snr) so an auto-responder template behaves
        // like an auto-ack template (#3892). senderName comes from the message
        // or the resolved contact.
        const senderName = message.fromName || senderContact?.advName || senderContact?.name || undefined;
        const body = await this.renderReplyTemplate(
          trigger.response || '',
          message.fromPublicKey,
          senderName,
          message.snr,
          message.timestamp,
          hops,
          route,
          message.scopeName,
          message.scopeCode,
        );
        if (!body.trim()) continue;

        try {
          await dispatch(body);
        } catch (err) {
          logger.warn(`[MeshCore:${this.sourceId}] Auto-responder ${trigger.id} send failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] Auto-responder check threw: ${(err as Error).message}`);
    }
  }

  /**
   * Drop the cached compiled-regex Map so a freshly-saved pattern
   * recompiles on the next message. Called by the save route after a
   * triggers update.
   */
  resetAutoResponderRegexCache(): void {
    this.autoResponderRegexCache.clear();
  }

  // ============ Auto-Acknowledge ============
  //
  // Mirrors the Meshtastic auto-acknowledge feature: when an incoming
  // contact_message (DM) or channel_message matches the configured regex,
  // we send a reply. The reply destination is either the same channel,
  // a DM back to the sender, or — if `autoAckUseDM` is set — always a DM
  // regardless of how the message arrived. The reply text supports the
  // same {NODE_ID}/{NODE_NAME}/{DATE}/{TIME}/{SNR}/{VERSION} macros so a
  // single template behaves consistently across both stacks.

  private static readonly AUTO_ACK_DEFAULT_MESSAGE = '🤖 Copy, {NODE_NAME}! {HOPS} hops @ {TIME}';
  private static readonly AUTO_ACK_DEFAULT_REGEX = '^(test|ping)';

  private validateAutoAckRegex(pattern: string): RegExp | null {
    return compileAutoAckRegex(pattern).regex;
  }

  private replaceAutoAckTokens(
    template: string,
    senderPubKey: string,
    senderName: string | undefined,
    snr: number | undefined,
    timestamp: number,
    hops: number | null,
    route: string | null,
    scopeName?: string | null,
    scopeCode?: number | null,
  ): string {
    const date = new Date(timestamp);
    const longName = senderName || `${senderPubKey.substring(0, 8)}…`;
    const shortName = senderName ? senderName.substring(0, 4) : senderPubKey.substring(0, 4);
    const nodeId = `!${senderPubKey.substring(0, 8)}`;
    const snrStr = snr !== undefined && snr !== null ? snr.toFixed(1) : '—';
    const dateStr = date.toLocaleDateString('en-US');
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const hopsStr = hops !== null ? String(hops) : '—';
    // {ROUTE} expands the cached hop-hash chain into a compact
    // arrow-separated list (e.g. "a3→7f→02"). Arrows have no surrounding
    // spaces to save airtime on length-limited MeshCore channels (#3776).
    // Empty / unknown route falls back to "direct" when hop count is 0 or
    // "—" otherwise.
    let routeStr: string;
    if (route && route.length > 0) {
      routeStr = route
        .split(',')
        .map(h => h.trim())
        .filter(Boolean)
        .join('→');
    } else if (hops === 0) {
      routeStr = 'direct';
    } else {
      routeStr = '—';
    }
    // {ROUTE_NAMES} is {ROUTE} with each relay hash resolved to a repeater /
    // room-server name from the contact list (raw hex when unknown; nearest-
    // to-neighbours best guess on hash collisions). {HASH_SIZE} is the per-hop
    // path-hash width in bytes (1–3) the original sender stamped into
    // path_len's top two bits — inferred from the hop hex width.
    const routeHops = parsePathHops(route);
    const hashSizeStr = routeHops.length > 0 ? String(pathHashBytesOf(routeHops)) : '—';
    const routeNamesStr = routeHops.length > 0
      ? resolveRouteNames(routeHops, this.getContacts()).join('→')
      : routeStr;
    // {SCOPE} resolves to the region name when known, "(unscoped)" when the
    // message was explicitly unscoped (scopeCode === 0), or "—" otherwise (#3865).
    let scopeStr: string;
    if (scopeName && scopeName.length > 0) {
      scopeStr = scopeName;
    } else if (scopeCode === 0) {
      scopeStr = '(unscoped)';
    } else {
      scopeStr = '—';
    }

    return template
      .replace(/\{NODE_ID\}/g, nodeId)
      .replace(/\{NODE_NAME\}/g, longName)
      .replace(/\{LONG_NAME\}/g, longName)
      .replace(/\{SHORT_NAME\}/g, shortName)
      .replace(/\{DATE\}/g, dateStr)
      .replace(/\{TIME\}/g, timeStr)
      .replace(/\{SNR\}/g, snrStr)
      .replace(/\{HOPS\}/g, hopsStr)
      .replace(/\{NUMBER_HOPS\}/g, hopsStr)
      .replace(/\{ROUTE_NAMES\}/g, routeNamesStr)
      .replace(/\{ROUTE\}/g, routeStr)
      .replace(/\{HASH_SIZE\}/g, hashSizeStr)
      .replace(/\{SCOPE\}/g, scopeStr);
  }

  /**
   * Render a reply template (Auto-Acknowledge, Auto-Responder). Runs the
   * per-message reply tokens first — {NODE_ID}/{NODE_NAME}/{LONG_NAME}/
   * {SHORT_NAME} resolve to the SENDER, plus {SNR}/{HOPS}/{ROUTE}/{SCOPE}/
   * {DATE}/{TIME} from the triggering packet — then the global tokens
   * ({VERSION}/{DURATION}/{CONTACTCOUNT}/…) fill in anything left. Both reply
   * surfaces share this path so they accept the SAME placeholders (#3892).
   * Order matters: reply tokens claim {NODE_ID}/{NODE_NAME} before the global
   * pass, so a reply cites the sender rather than the local node.
   */
  private async renderReplyTemplate(
    template: string,
    senderPubKey: string,
    senderName: string | undefined,
    snr: number | undefined,
    timestamp: number,
    hops: number | null,
    route: string | null,
    scopeName?: string | null,
    scopeCode?: number | null,
  ): Promise<string> {
    const withReply = this.replaceAutoAckTokens(
      template,
      senderPubKey,
      senderName,
      snr,
      timestamp,
      hops,
      route,
      scopeName,
      scopeCode,
    );
    return replaceMeshCoreAnnounceTokens(withReply, this);
  }

  /**
   * Check an incoming message against the auto-ack configuration and send
   * a reply if it matches.
   *
   * @param message - the just-received message (DM or channel)
   * @param isDirectMessage - true if this arrived as a contact_message (DM)
   * @param channelIdx - channel index when not a DM; undefined for DMs
   */
  private async checkAutoAcknowledge(
    message: MeshCoreMessage,
    isDirectMessage: boolean,
    channelIdx: number | undefined,
    hops: number | null,
    route: string | null,
  ): Promise<void> {
    try {
      const settings = databaseService.settings;
      const sourceId = this.sourceId;

      const enabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckEnabled');
      if (enabled !== 'true') return;

      const regexStr = (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckRegex')) || MeshCoreManager.AUTO_ACK_DEFAULT_REGEX;
      const regex = this.validateAutoAckRegex(regexStr);
      if (!regex) {
        logger.warn(`[MeshCore:${sourceId}] Auto-ack: invalid regex "${regexStr}", skipping`);
        return;
      }

      const text = message.text || '';
      if (!regex.test(text)) return;

      // Channel allowlist / DM gate
      if (isDirectMessage) {
        const dmEnabled = (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckDirectMessages')) === 'true';
        if (!dmEnabled) {
          logger.debug(`[MeshCore:${sourceId}] Auto-ack: DM trigger ignored (DM auto-ack disabled)`);
          return;
        }
      } else {
        const channelsRaw = (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckChannels')) || '';
        const enabledChannels = new Set(
          channelsRaw.split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n)),
        );
        if (channelIdx === undefined || !enabledChannels.has(channelIdx)) {
          logger.debug(`[MeshCore:${sourceId}] Auto-ack: channel ${channelIdx} not in allowlist`);
          return;
        }
      }

      // Per-sender cooldown
      const cooldownRaw = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckCooldownSeconds');
      const cooldownSeconds = Math.max(0, parseInt(cooldownRaw || '0', 10) || 0);
      if (cooldownSeconds > 0) {
        const cooldownKey = isDirectMessage
          ? `dm:${message.fromPublicKey}`
          : `ch${channelIdx}:${message.fromPublicKey}`;
        const last = this.autoAckCooldowns.get(cooldownKey) || 0;
        if (Date.now() - last < cooldownSeconds * 1000) {
          logger.debug(`[MeshCore:${sourceId}] Auto-ack: cooldown active for ${cooldownKey}`);
          return;
        }
        this.autoAckCooldowns.set(cooldownKey, Date.now());
      }

      const useDM = (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckUseDM')) === 'true';
      const template = (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckMessage')) || MeshCoreManager.AUTO_ACK_DEFAULT_MESSAGE;
      // Scope/region for the ack reply (#3833): inherit / trigger / unscoped / named.
      const scopeOverride = MeshCoreManager.resolveAutomationScopeOverride({
        scopeMode: (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeMode')) as MeshCoreAutomationScopeMode | undefined,
        scopeName: (await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeName')) ?? undefined,
      }, message);

      // Resolve sender's display name from contacts when available
      let senderName = message.fromName;
      if (!senderName && !isDirectMessage) {
        // Channel sender is in the prefix-split fromName; nothing to do
      } else if (!senderName && isDirectMessage) {
        const contact = this.resolveContactByPrefix(message.fromPublicKey);
        senderName = contact?.advName ?? contact?.name ?? undefined;
      }

      const replyText = await this.renderReplyTemplate(
        template,
        message.fromPublicKey,
        senderName,
        message.snr,
        message.timestamp,
        hops,
        route,
        message.scopeName,
        message.scopeCode,
      );

      // Pre-send delay (#3876): give a repeater time to finish its own TX
      // before we reply, so a zero-hop ack isn't dropped. 0 = immediate
      // (default). Safe to await — this handler is invoked fire-and-forget.
      const preSendDelaySeconds = resolveAutoAckPreSendDelaySeconds(
        await settings.getSettingForSource(sourceId, 'meshcoreAutoAckPreSendDelaySeconds'),
      );
      if (preSendDelaySeconds > 0) {
        logger.debug(`[MeshCore:${sourceId}] Auto-ack: waiting ${preSendDelaySeconds}s before reply`);
        await new Promise((resolve) => setTimeout(resolve, preSendDelaySeconds * 1000));
      }

      // Decide destination:
      //  - DM trigger or "always DM" → send as DM (need contact pubkey)
      //  - otherwise → reply on the channel it came in on
      const sendAsDM = isDirectMessage || useDM;

      if (sendAsDM) {
        // Need the full contact pubkey to address a DM. The DM event
        // gives us a prefix; resolve via the contact map.
        const contact = this.resolveContactByPrefix(message.fromPublicKey);
        if (!contact) {
          logger.warn(`[MeshCore:${sourceId}] Auto-ack: cannot DM unknown contact ${message.fromPublicKey}`);
          return;
        }
        logger.debug(`[MeshCore:${sourceId}] Auto-ack DM → ${contact.advName ?? contact.publicKey.substring(0, 8)} (${replyText.length} chars)`);
        await this.sendMessage(replyText, contact.publicKey, undefined, scopeOverride);
      } else {
        logger.debug(`[MeshCore:${sourceId}] Auto-ack channel ${channelIdx} (${replyText.length} chars)`);
        // Automated sender → opt into channel-send auto-retry (#3979).
        await this.sendMessage(replyText, undefined, channelIdx, scopeOverride, true);
      }
    } catch (err) {
      logger.error(`[MeshCore:${this.sourceId}] Auto-ack handler threw: ${(err as Error).message}`);
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.shouldReconnect || !this.config) return;
    try {
      const ok = await this.connect(this.config);
      if (!ok && this.shouldReconnect) {
        this.connectionState = 'reconnecting';
        this.scheduleNextReconnect();
      }
    } catch (err) {
      logger.warn(`[MeshCore:${this.sourceId}] Reconnect attempt threw: ${(err as Error).message}`);
      if (this.shouldReconnect) {
        this.connectionState = 'reconnecting';
        this.scheduleNextReconnect();
      }
    }
  }
}

export { MeshCoreManager };
