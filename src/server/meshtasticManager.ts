import databaseService, { type DbMessage } from '../services/database.js';
import meshtasticProtobufService, { formatTakPreview } from './meshtasticProtobufService.js';
import protobufService, { convertIpv4ConfigToStrings } from './protobufService.js';
import { getProtobufRoot, type MeshBeaconPayload } from './protobufLoader.js';
import { TcpTransport } from './tcpTransport.js';
import { VirtualNodeServer, type VirtualNodeConfig } from './virtualNodeServer.js';
import type { ITransport } from './transports/transport.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { calculateDistance } from '../utils/distance.js';
import { shouldDiscardPosition } from '../utils/nullIsland.js';
import { getDiscardInvalidPositions } from '../utils/positionIngestConfig.js';
import { isPointInGeofence, distanceToGeofenceCenter } from '../utils/geometry.js';
import { formatTime, formatDate } from '../utils/datetime.js';
import { logger } from '../utils/logger.js';
import { transportColumnForPacket } from '../utils/nodeTransport.js';
import { getEnvironmentConfig } from './config/environment.js';
import { notificationService } from './services/notificationService.js';
import { deadDropService, nodeIdHex } from './services/deadDropService.js';
import { serverEventNotificationService } from './services/serverEventNotificationService.js';
import packetLogService from './services/packetLogService.js';
import { channelDecryptionService } from './services/channelDecryptionService.js';
import { pkiDecryptionService } from './services/pkiDecryptionService.js';
import { getSourcePkiKeyStore, isPkiDmDecryptionGloballyEnabled } from './services/sourcePkiKeyStore.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import {
  ToastThrottle,
  shouldSuppressToast,
  parseProtectedCapRefusal,
  sanitizeNotificationMessage,
  type ParsedClientNotification,
} from './services/clientNotificationPolicy.js';
import { waypointService } from './services/waypointService.js';
// import type only — cannot use a static runtime import here because of a circular
// dependency chain: meshtasticManager → distanceDeleteScheduler →
// autoDeleteByDistanceService → resolveSourceManager → meshtasticManager.
// The class is loaded lazily via dynamic import() inside startDistanceDeleteScheduler().
import type { DistanceDeleteScheduler } from './services/distanceDeleteScheduler.js';
import { MessageQueueService } from './messageQueueService.js';
import { resolveAutoWelcomeDelaySeconds } from './autoWelcomeDelay.js';
import { TxDisabledError } from './errors/txDisabledError.js';
import { resolveAutoAckPreSendDelaySeconds } from './autoAckDelay.js';
import { normalizeTriggerPatterns, normalizeTriggerChannels } from '../utils/autoResponderUtils.js';
import { matchAutoResponderPattern } from './utils/autoResponderMatcher.js';
import { isWithinTimeWindow } from './utils/timeWindow.js';
import { compileUserRegex } from '../utils/safeRegex.js';
import { shouldGateAutomations, averageStrongestNeighborUtilization, DEFAULT_AIRTIME_CUTOFF_THRESHOLD, DEFAULT_AIRTIME_CUTOFF_SOURCE, NEIGHBOR_UTIL_SAMPLE_COUNT, type AirtimeCutoffSource, type NeighborUtilContributor } from './utils/airtimeCutoff.js';
import { resolveLastHopName } from './utils/lastHop.js';
import { resolveLastHeardSec } from './utils/replayGuard.js';
import { autoAckIsZeroHop, autoAckCellKey, resolveAutoAckReplyRouting } from './utils/autoAckDecision.js';
import { scriptDependencyEnv } from './utils/scriptRunner.js';
import { canonicalMessageTime, plausibleRxTime } from './utils/messageTime.js';
import { canonicalTelemetryType, canonicalTelemetryUnit } from './utils/telemetryKeys.js';
import { isNodeComplete } from '../utils/nodeHelpers.js';
import { getEffectiveDbNodePosition } from './utils/nodeEnhancer.js';
import { migrateAutomationChannels } from './utils/automationChannelMigration.js';
import { detectChannelMoves } from './utils/channelMoveDetection.js';
import { detectLocalNodeSpoof, SentPacketIdCache, type SpoofDetectionResult } from './utils/spoofDetection.js';
import { applyHomoglyphOptimization } from '../utils/homoglyph.js';
import { PortNum, RoutingError, isPkiError, getRoutingErrorName, CHANNEL_DB_OFFSET, TransportMechanism, resolveRadioPacketTransport, isViaMqtt, MIN_TRACEROUTE_INTERVAL_MS, StoreForwardRequestResponse, getStoreForwardRequestResponseName } from './constants/meshtastic.js';
import { normalizeChannelRole } from './constants/channelRole.js';
import { createRequire } from 'module';
import { validateCron, scheduleCron, type CronJob } from './utils/cronScheduler.js';
import {
  shouldExcludeFromPacketLog,
  isPhantomInternalPacket,
  peekServiceEnvelopePacketId,
  recordMqttEcho,
  matchesMqttEcho,
} from './services/mqttProxyBridge.js';
import { NodeDbMaintenanceService } from './services/nodeDbMaintenanceService.js';
import { AutoAnnounceService } from './services/autoAnnounceService.js';
import { AdminTransactionService } from './services/adminTransactionService.js';
import { FavoritesService } from './services/favoritesService.js';
import { DeviceAdminService } from './services/deviceAdminService.js';
import { RemoteAdminService } from './services/remoteAdminService.js';
import { ConnState, dispatch, type SmContext } from './meshtastic/connectionStateMachine.js';
import fs from 'fs';
import path from 'path';
import * as net from 'net';

const POST_RESET_COOLDOWN_MS = 5000;
const TCP_READY_TIMEOUT_MS = 15000;
const TCP_READY_INTERVAL_MS = 500;
const TCP_READY_CONNECT_TIMEOUT_MS = 1500;
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

// Auto-responder timeouts are split so the HTTP path can stay snappy
// (mesh consumers wait synchronously for the trigger to fire) while
// scripts get a longer budget for legitimate work. Keep both ≤ the
// 30s rate-limit so a slow backend can't fully consume the budget.
const HTTP_AUTO_RESPONDER_TIMEOUT_MS = 5_000;
const SCRIPT_AUTO_RESPONDER_TIMEOUT_MS = 30_000;
// Minimum gap between local "re-ignore" admin pushes for the same node (#2601),
// so a device that can't durably hold the ignore doesn't trigger a command storm.
const IGNORE_REAPPLY_COOLDOWN_MS = 60_000;
// Window for the {NODECOUNT}/{DIRECTCOUNT} template tokens, matching the
// Sources panel's per-source "active" badge (issue #3388). The badge counts
// nodes heard in the last 2h (getActiveNodeCount default, issue #2883); the
// tokens previously used the much wider `maxNodeAgeHours` setting, so the
// sent message disagreed with what the UI showed for the same gateway.
const ACTIVE_NODE_TOKEN_WINDOW_SECONDS = 7200;
const ACTIVE_NODE_TOKEN_WINDOW_DAYS = ACTIVE_NODE_TOKEN_WINDOW_SECONDS / 86_400;

/** Parsed auto-responder payload: list of messages to send, plus the
 * raw decoded JSON object (or `{}` if the payload was plain text) so
 * callers can read optional fields like `private`. */
export interface AutoResponderParsed {
  json: Record<string, unknown>;
  responses: string[];
}

/**
 * Parse an auto-responder response payload (script stdout or HTTP
 * body) into a normalized `{ json, responses }` shape.
 *
 * Accepted formats:
 *   { "responses": ["…", "…"] }    multi-message JSON
 *   { "response": "…" }             single-message JSON
 *   "plain text"                    only when jsonExpected=false
 *
 * `jsonExpected=true` (script path) requires JSON output with one of
 * the two recognised fields; anything else logs an error and returns
 * no messages. `jsonExpected=false` (HTTP / text path) keeps the raw
 * body as a single response when the input either fails to parse OR
 * parses to a JSON object that doesn't carry `response`/`responses`
 * — preserves pre-PR behaviour for third-party endpoints that happen
 * to return JSON shaped differently from MeshMonitor's convention.
 *
 * Exported so unit tests can exercise the matrix of inputs without
 * standing up a MeshtasticManager.
 */
export function parseAutoResponderResponse(
  rawResp: string,
  jsonExpected: boolean,
): AutoResponderParsed {
  let jsonResp: unknown;
  try {
    jsonResp = JSON.parse(rawResp);
  } catch (_) {
    if (jsonExpected) {
      logger.error(`❌ Auto responder output is not valid JSON: ${rawResp.substring(0, 100)}`);
      return { json: {}, responses: [] };
    }
    return { json: {}, responses: [rawResp] };
  }

  // Narrow to a record so we can index by field name without `any`.
  const obj = (jsonResp !== null && typeof jsonResp === 'object')
    ? (jsonResp as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  // Multiple responses format: { "responses": ["msg1", "msg2", ...] }
  if (Array.isArray(obj.responses)) {
    const arr = obj.responses;
    const responses = arr.filter((r): r is string => typeof r === 'string');
    const dropped = arr.length - responses.length;
    if (dropped > 0) {
      logger.warn(`⚠️  Auto responder 'responses' array dropped ${dropped} non-string entr${dropped === 1 ? 'y' : 'ies'}`);
    }
    if (responses.length === 0) {
      logger.error(`❌ Auto responder output 'responses' array contains no valid strings`);
    } else {
      logger.debug(`📥 Auto responder returned ${responses.length} response(s)`);
    }
    return { json: obj, responses };
  }

  // Single response format: { "response": "msg" }
  if (typeof obj.response === 'string') {
    logger.debug(`📥 Auto responder output: ${obj.response.substring(0, 50)}…`);
    return { json: obj, responses: [obj.response] };
  }

  // JSON parsed but no recognised field. For the script path this is
  // a hard error. For HTTP/text we fall back to the raw body so
  // existing webhooks that return e.g. {"status":"ok"} keep behaving
  // as they did before this refactor (truncate-and-send).
  if (jsonExpected) {
    logger.error(`❌ Auto responder output missing valid 'response' or 'responses' field`);
    return { json: {}, responses: [] };
  }
  logger.debug(`📥 Auto responder JSON body has no 'response'/'responses' field; using raw body as single message`);
  return { json: obj, responses: [rawResp] };
}

export interface MeshtasticConfig {
  nodeIp: string;
  tcpPort: number;
}

export interface ProcessingContext {
  skipVirtualNodeBroadcast?: boolean;
  virtualNodeRequestId?: number; // Packet ID from Virtual Node client for ACK matching
  decryptedBy?: 'node' | 'server' | null; // How the packet was decrypted
  decryptedChannelId?: number; // Channel Database entry ID for server-decrypted messages
  viaStoreForward?: boolean; // Message was received via Store & Forward replay
}

// CHANNEL_DB_OFFSET is imported from './constants/meshtastic.js'
// Re-export for consumers who import from meshtasticManager
export { CHANNEL_DB_OFFSET } from './constants/meshtastic.js';

/**
 * Link Quality scoring constants.
 * Link Quality is a 0-10 score tracking the reliability of message routing to a node.
 */
export const LINK_QUALITY = {
  /** Maximum quality score */
  MAX: 10,
  /** Minimum quality score (0 = dead link) */
  MIN: 0,
  /** Base value for initial calculation (LQ = BASE - hops) */
  INITIAL_BASE: 8,
  /** Default quality when hop count is unknown */
  DEFAULT_QUALITY: 5,
  /** Default hop count when unknown */
  DEFAULT_HOPS: 3,
  /** Bonus for stable/improved message delivery */
  STABLE_MESSAGE_BONUS: 1,
  /** Penalty for degraded routing (hops increased by 2+) */
  DEGRADED_PATH_PENALTY: -1,
  /** Penalty for failed traceroute */
  TRACEROUTE_FAIL_PENALTY: -2,
  /** Penalty for PKI/encryption error */
  PKI_ERROR_PENALTY: -5,
  /** Traceroute timeout in milliseconds (5 minutes) */
  TRACEROUTE_TIMEOUT_MS: 5 * 60 * 1000,
} as const;

export interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    role?: string;
  };
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
    uptimeSeconds?: number;
  };
  hopsAway?: number;
  lastHeard?: number;
  snr?: number;
  rssi?: number;
  mobile?: number; // Database field: 0 = not mobile, 1 = mobile (moved >100m)
  // Position precision fields
  positionGpsAccuracy?: number; // GPS accuracy in meters
  // Position override fields
  positionOverrideEnabled?: boolean;
  latitudeOverride?: number;
  longitudeOverride?: number;
  altitudeOverride?: number;
  positionOverrideIsPrivate?: boolean;
  positionIsOverride?: boolean;
  hideFromMap?: boolean;
  isStoreForwardServer?: boolean;
}

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  fromNodeId: string;  // For consistency with database
  toNodeId: string;    // For consistency with database
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
  rxSnr?: number;
  rxRssi?: number;
}

type TextMessage = {
  id: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum: number; // PortNum — 1 (TEXT_MESSAGE_APP) for text, 72 (ATAK_PLUGIN) for ATAK GeoChat
  requestId?: number; // For Virtual Node messages, preserve packet ID for ACK matching
  timestamp: number;
  rxTime?: number;
  hopStart?: number;
  hopLimit?: number;
  relayNode?: number; // Last byte of the node that relayed this message
  replyId?: number;
  emoji?: number;
  viaMqtt: boolean; // Capture whether message was received via MQTT bridge
  rxSnr?: number; // SNR of received packet
  rxRssi?: number; // RSSI of received packet
  wantAck?: boolean; // Expect ACK for Virtual Node messages
  deliveryState?: string; // Track delivery for Virtual Node messages
  ackFailed?: boolean; // Whether ACK failed
  routingErrorReceived?: boolean; // Whether a routing error was received
  ackFromNode?: number; // Node that sent the ACK
  createdAt: number;
  decryptedBy?: 'node' | 'server' | null; // Decryption source - 'server' means read-only
  viaStoreForward?: boolean; // Message received via Store & Forward replay
  sourceIp?: string | null; // Per-message ingress attribution (client IP for HTTP injects)
  sourcePath?: 'http_api' | 'tcp_radio' | 'mqtt_bridge' | 'system' | null;
  spoofSuspected?: boolean; // #2584 — claims from == our local node but arrived over RF
};

/**
 * Auto-responder trigger configuration
 */
interface AutoResponderTrigger {
  trigger: string | string[];
  response: string;
  responseType?: 'text' | 'http' | 'script' | 'traceroute' | 'mailbox';
  channel?: number | 'dm' | 'none';
  verifyResponse?: boolean;
  multiline?: boolean;
  scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
  cooldownSeconds?: number; // Per-node cooldown in seconds (0 = disabled, default)
}

/**
 * Geofence trigger configuration
 */
interface GeofenceTriggerConfig {
  id: string;
  name: string;
  enabled: boolean;
  shape: { type: 'circle'; center: { lat: number; lng: number }; radiusKm: number }
       | { type: 'polygon'; vertices: Array<{ lat: number; lng: number }> };
  event: 'entry' | 'exit' | 'while_inside';
  whileInsideIntervalMinutes?: number;
  cooldownMinutes?: number; // Minimum time between triggers per node (0 = no cooldown)
  nodeFilter: { type: 'all' } | { type: 'selected'; nodeNums: number[] };
  responseType: 'text' | 'script';
  response?: string;
  scriptPath?: string;
  scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
  channel: number | 'dm' | 'none';
  verifyResponse?: boolean; // Enable retry logic (3 attempts) for DM messages
  lastRun?: number;
  lastResult?: 'success' | 'error';
  lastError?: string;
}

interface AutoPingSession {
  requestedBy: number;      // nodeNum of the user who requested
  channel: number;           // channel the DM came on
  totalPings: number;
  completedPings: number;
  successfulPings: number;
  failedPings: number;
  intervalMs: number;
  timeoutMs: number;        // per-ping ack timeout, resolved once at session start
  timer: ReturnType<typeof setInterval> | null;
  sending: boolean;         // true while a send is in-flight (closes the check-then-act race)
  pendingRequestId: number | null;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
  startTime: number;
  lastPingSentAt: number;
  results: Array<{ pingNum: number; status: 'ack' | 'nak' | 'timeout'; durationMs?: number; sentAt: number }>;
}

/**
 * Bidirectional bridge config between this Meshtastic source and an embedded
 * mqtt_broker source (issue #3003 follow-up). When `enabled`, MeshMonitor
 * forwards FromRadio.mqttClientProxyMessage payloads to the linked broker and
 * injects broker messages back as ToRadio.mqttClientProxyMessage. Works for
 * devices that have `mqtt.proxy_to_client_enabled = true` set in firmware.
 */
export interface MeshtasticMqttLink {
  enabled?: boolean;
  mqttBrokerSourceId?: string;
}

/**
 * A telemetry want_response "sequence" we sent and are still awaiting a reply
 * for. Tracked so we can detect + auto-retry the firmware NeighborInfo-hijack
 * (issue #4210 / meshtastic/firmware#11071). The original request AND each
 * auto-retry share one object; `packetIds` holds every packet id (original +
 * retries) so a telemetry reply matching ANY of them resolves the whole
 * sequence. The pending map keys every one of those packet ids to this object.
 */
interface PendingTelemetryRequest {
  destination: number;
  channel: number;
  telemetryType?: 'device' | 'environment' | 'airQuality' | 'power';
  sentAt: number;         // when the ORIGINAL request was sent (drives TTL)
  retried: boolean;       // the hijack auto-retry sequence has already started (loop-guard)
  resolved: boolean;      // a telemetry reply arrived for some request in this sequence
  packetIds: Set<number>; // every packet id belonging to this logical request
  retryTimers: Array<ReturnType<typeof setTimeout>>;
}

class MeshtasticManager implements ISourceManager {
  public sourceId: string;
  private sourceConfigOverride: { host?: string; port?: number; heartbeatIntervalSeconds?: number; mqttLink?: MeshtasticMqttLink; passiveMode?: boolean; passiveResyncStaleMs?: number } | null = null;
  // Passive Mode (issue #3122) — for large/fragile TCP nodes:
  //   * preserve cached node/config state across reconnects
  //   * skip post-config outbound bursts (LoRa config, all-module-configs, time sync, admin scanner)
  //   * rate-limit want_config_id so reconnects don't trigger a full NodeDB resync
  //   * fast initial reconnect for the first post-sync drop
  private passiveMode = false;
  private lastDisconnectAt: number | null = null;
  // Per-source override of PASSIVE_RESYNC_STALE_MS. null means "use the
  // class default". The reporter (#3122 follow-up) asked for this as an
  // advanced setting so operators can tune the window for their specific
  // node — e.g. a node whose config rarely changes might prefer 24h, while
  // a node with frequent remote channel rekeys might prefer 1h.
  private passiveResyncStaleMs: number | null = null;
  // Cap full-config syncs in passive mode. First connect is always full; after
  // that only re-sync if cache is empty or older than this threshold. 4h matches
  // the reporter's recommendation in #3122 — long enough to ride out repeated
  // transient closes on a large infrastructure node, short enough that genuine
  // config drift self-corrects without a manual refresh.
  private static readonly PASSIVE_RESYNC_STALE_MS = 4 * 60 * 60 * 1000; // 4 hours
  // Bounds for the per-source override. Below the floor we'd be effectively
  // resyncing on every flap; above the ceiling we'd never resync. Values
  // outside this range fall back to the default.
  private static readonly PASSIVE_RESYNC_STALE_MIN_MS = 60_000; // 1 minute
  private static readonly PASSIVE_RESYNC_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  // Startup-grace fast reconnect for passive-mode sources (#3122 follow-up).
  // The reporter observed that a large infrastructure node usually closes
  // the *first* config-sync session but recovers cleanly on the next attempt;
  // a brief grace window with a 3s delay shortens the user-visible
  // "stuck reconnecting" gap during startup without changing the steady-state
  // backoff once the session stabilizes.
  private static readonly STARTUP_GRACE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
  private static readonly STARTUP_GRACE_FAST_DELAY_MS = 3_000; // 3 seconds

  // Manual resync (#3122 follow-up) — operator-initiated full config refresh:
  //   * forces ONE want_config_id regardless of staleness window
  //   * single-flight: only one resync at a time per source
  //   * cooldown (30s) between resyncs to prevent rapid-fire button mashing
  //     from overwhelming a fragile node
  //   * watchdog (120s) clears the in-flight flag if config never arrives,
  //     so a stuck sync can't disable the button forever
  //   * post-resync reconnect: if the node closes the socket during/after
  //     the forced sync, recovery reuses the cached config and does NOT
  //     auto-retry the sync (would just recreate the failure loop)
  private static readonly MANUAL_RESYNC_COOLDOWN_MS = 30_000;
  private static readonly MANUAL_RESYNC_WATCHDOG_MS = 120_000;
  private manualResyncInFlight = false;
  private manualResyncLastAt: number | null = null;
  private manualResyncWatchdog: NodeJS.Timeout | null = null;
  // Latches across the next disconnect/reconnect so recovery skips the
  // auto re-sync the new connection would otherwise trigger.
  private suppressNextAutoSync = false;
  // mqttLink runtime state — set up in start()/reconfigureMqttLink().
  // The link target can be either an mqtt_broker (devices connect to the
  // embedded broker that we then bridge) or an mqtt_bridge (we forward
  // straight upstream through the bridge's MQTT client). Both expose
  // `publish()` and emit `local-packet`, so they share this code path
  // (issue #3134).
  private mqttLink: MeshtasticMqttLink | null = null;
  private mqttLinkBroker:
    | import('./mqttBrokerManager.js').MqttBrokerManager
    | import('./mqttBridgeManager.js').MqttBridgeManager
    | null = null;
  private mqttLinkBrokerListener: ((p: import('./mqttBrokerManager.js').MqttBrokerLocalPacket) => void) | null = null;
  private mqttLinkRegistryStartedListener: ((m: ISourceManager) => void) | null = null;
  private mqttLinkRegistryStoppedListener: ((m: ISourceManager) => void) | null = null;
  private mqttLinkEchoDeviceToBroker: Array<{ topic: string; packetId: number; expiresAt: number }> = [];
  private mqttLinkEchoBrokerToDevice: Array<{ topic: string; packetId: number; expiresAt: number }> = [];
  private postResetCooldownUntil: number = 0;
  private virtualNodeServer?: VirtualNodeServer;
  private transport: ITransport | null = null;
  // Single-flight latch for connect(): holds the in-flight attempt so a
  // concurrent connect() joins it instead of building a second (orphan)
  // transport (#3270). Cleared in a finally when the attempt settles.
  private connectInFlight: Promise<boolean> | null = null;
  // Connection-lifecycle state machine (#3962 Phase 4.2b, task42b_spec.md).
  // `#state` is the single source of truth for link-state; `isConnected` and
  // `userDisconnectedState` below are DERIVED getters over it (§2.1/§3.3 —
  // amended §0.3: only these two booleans derive from ConnState; the two
  // config-capture flags stay independent auxiliary fields, see their
  // declarations near `initConfigCache`).
  //
  // C1 (this checkpoint) wires `#state` writes at the *existing* mutation
  // points mechanically via these accessors — every call site that used to
  // write `this.isConnected = <bool>` / `this.userDisconnectedState = <bool>`
  // (internal manager code AND test fixtures that seed state directly) keeps
  // compiling and behaving byte-identically, because the setters below
  // translate a legacy boolean write into the equivalent `#state` update.
  // C2 replaces the internal writes with real `dispatch(...)` calls; these
  // accessors remain afterward as the compatibility surface for the ~30
  // existing test call sites that seed state via direct field assignment.
  #state: ConnState = ConnState.Disconnected;

  private get isConnected(): boolean {
    return this.#state === ConnState.ConfigSync || this.#state === ConnState.Connected;
  }

  private set isConnected(value: boolean) {
    if (value) {
      // A direct "true" write always means "connected" for the purposes of
      // the 41 `isConnected` readers (none of them distinguish ConfigSync
      // vs Connected — that distinction only matters to the independent
      // config-capture flags). Preserve ConfigSync if we're already mid
      // handshake so a later `isCapturingInitConfig`-driven write isn't
      // clobbered by an unrelated `isConnected = true` seed.
      if (this.#state !== ConnState.ConfigSync) {
        this.#state = ConnState.Connected;
      }
    } else if (this.#state !== ConnState.UserDisconnected) {
      // Never regress out of UserDisconnected via a plain "isConnected =
      // false" write — that write is independent of userDisconnectedState
      // in the legacy boolean model (e.g. handleDisconnected() always sets
      // isConnected=false, including when a user-initiated disconnect's
      // transport.disconnect() call loops back through it).
      this.#state = ConnState.Disconnected;
    }
  }

  private get userDisconnectedState(): boolean {
    return this.#state === ConnState.UserDisconnected;
  }

  private set userDisconnectedState(value: boolean) {
    if (value) {
      this.#state = ConnState.UserDisconnected;
    } else if (this.#state === ConnState.UserDisconnected) {
      this.#state = ConnState.Disconnected;
    }
  }

  // ── Connection-lifecycle state-machine helpers (#3962 Phase 4.2b C2) ──
  // `connect`/`doConnectInternal`/`handleConnected`/`handleDisconnected`/
  // `requestManualResync`/`userDisconnect`/`userReconnect` (and the
  // `configComplete` protobuf-dispatch case) build an `SmContext` from live
  // fields, call `dispatch(#state, event, ctx)`, set `#state`, then execute
  // the returned actions in place at their original call-site position —
  // NOT via one generic action interpreter shared byte-for-byte across every
  // call site. The reducer's action vocabulary is intentionally reused
  // across transitions that mean genuinely different things in the manager
  // (e.g. `clearDeviceCaches` clears different fields on a fresh connect vs.
  // a disconnect), so a single generic switch can't express all of them
  // without guessing context; executing them inline, at the same code
  // position the equivalent write used to occupy, preserves exact
  // side-effect ordering for the pinned tests while still making `dispatch`
  // the single source of truth for `#state`.

  /** Build an `SmContext` snapshot from live fields; callers override only
   *  the handful of fields they alone can compute synchronously. */
  private buildSmContext(overrides: Partial<SmContext> = {}): SmContext {
    return {
      passive: this.passiveMode,
      vnEnabled: this.virtualNodeServer !== undefined,
      cachesFresh: false,
      suppressNext: this.suppressNextAutoSync,
      postResetActive: this.postResetCooldownUntil > 0,
      transportPresent: this.transport !== null,
      transportIdentityMatches: true,
      ...overrides,
    };
  }

  // The four capture-flag actions (task42b_spec.md §0.3/§3.2 legend) — the
  // ONLY writers of `configCaptureComplete` / `isCapturingInitConfig`.
  // Buffer resets (`initConfigCache`, `preConfigChannelSnapshot`) stay as
  // separate, explicit statements at each call site — pre-refactor code
  // never bundled them into these two booleans either.
  private startConfigCapture(): void {
    this.isCapturingInitConfig = true;
    this.configCaptureComplete = false;
  }
  private completeConfigCapture(): void {
    this.isCapturingInitConfig = false;
    this.configCaptureComplete = true;
  }
  private clearConfigCapture(): void {
    this.isCapturingInitConfig = false;
    this.configCaptureComplete = false;
  }
  private preserveConfigCapture(): void {
    // no-op on both flags — #3122 passive/no-VN disconnect keeps the cached
    // snapshot valid even though the link just went down.
  }

  /** Extracted verbatim from the old inline `doConnectInternal` teardown
   *  block — the `teardownPrevTransport` action's implementation. */
  private teardownExistingTransport(injectedTransport?: ITransport): void {
    if (this.transport && this.transport !== injectedTransport) {
      logger.debug('🔌 Tearing down existing transport before reconnect (prevents orphaned-transport flap #3270)');
      try {
        this.transport.removeAllListeners();
        this.transport.disconnect();
      } catch (teardownErr) {
        const msg = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        logger.debug(`Ignoring error tearing down previous transport: ${msg}`);
      }
      this.transport = null;
    }
  }

  private cancelConfigCompleteFallbackTimer(): void {
    if (this.configCompleteFallbackTimer) {
      clearTimeout(this.configCompleteFallbackTimer);
      this.configCompleteFallbackTimer = null;
    }
  }

  /** The `armFallbackTimer` action's implementation. Promoted from an inline
   *  `setTimeout` closure (#3962 Phase 4.2b C2) so every exit from
   *  `ConfigSync` can cancel it — the inline version never cancelled itself
   *  and leaked one timer per (re)connect attempt for the life of the
   *  process. Fires the `CONFIG_FALLBACK` transition if `configComplete`
   *  never arrives. */
  private armConfigCompleteFallbackTimer(): void {
    this.cancelConfigCompleteFallbackTimer();
    this.configCompleteFallbackTimer = setTimeout(() => {
      this.configCompleteFallbackTimer = null;
      if (!this.configCaptureComplete && this.isConnected) {
        logger.warn(`⚠️ configComplete not received after ${MeshtasticManager.CONFIG_COMPLETE_FALLBACK_MS / 1000}s — starting schedulers via fallback`);
        const { next, actions } = dispatch(this.#state, 'CONFIG_FALLBACK', this.buildSmContext());
        this.#state = next;
        for (const action of actions) {
          if (action.kind === 'completeConfigCapture') {
            this.completeConfigCapture();
          } else if (action.kind === 'runOnConfigCaptureComplete') {
            if (this.onConfigCaptureComplete) {
              try { this.onConfigCaptureComplete(); } catch (e) { logger.error('❌ Error in fallback config complete:', e); }
            }
          }
        }
        this.assertStateConsistent();
      }
    }, MeshtasticManager.CONFIG_COMPLETE_FALLBACK_MS);
  }

  /**
   * Dev/test-only invariant guard (task42b_spec.md §4 C2): the two
   * *derived* booleans must always agree with `#state`. Intentionally does
   * NOT check `configCaptureComplete`/`isCapturingInitConfig` — the
   * passive-no-VN disconnect case legally decouples them (#3122).
   */
  private assertStateConsistent(): void {
    if (process.env.NODE_ENV === 'production') return;
    const expectedConnected = this.#state === ConnState.ConfigSync || this.#state === ConnState.Connected;
    const expectedUserDisconnected = this.#state === ConnState.UserDisconnected;
    if (this.isConnected !== expectedConnected || this.userDisconnectedState !== expectedUserDisconnected) {
      throw new Error(
        `[assertStateConsistent] derived-boolean/state mismatch: state=${this.#state} isConnected=${this.isConnected} (expected ${expectedConnected}) userDisconnectedState=${this.userDisconnectedState} (expected ${expectedUserDisconnected})`
      );
    }
  }

  private tracerouteInterval: NodeJS.Timeout | null = null;
  private tracerouteJitterTimeout: NodeJS.Timeout | null = null;
  // null until startDistanceDeleteScheduler() is first called (lazy-loaded to
  // avoid the meshtasticManager → distanceDeleteScheduler circular import).
  private distanceDeleteScheduler: DistanceDeleteScheduler | null = null;
  // Reconnect flood prevention timing (#2474)
  private static readonly SCHEDULER_STAGGER_MS = 5000;  // Delay between each scheduler start
  private static readonly CONFIG_COMPLETE_FALLBACK_MS = 120000;  // Fallback if configComplete never arrives
  // Handle for the fallback timer above, promoted from an inline `setTimeout`
  // closure (#3962 Phase 4.2b C2) — see `armConfigCompleteFallbackTimer`.
  private configCompleteFallbackTimer: NodeJS.Timeout | null = null;

  private tracerouteIntervalMinutes: number = 0;
  private lastTracerouteSentTime: number = 0;
  // Airtime cutoff: pause all transmitting automations when the local node's
  // Channel Utilization exceeds this percent. 0 disables the feature.
  private automationAirtimeCutoffThreshold: number = DEFAULT_AIRTIME_CUTOFF_THRESHOLD;
  // Most recent Channel Utilization (%) self-reported by the local node, or null
  // if no device telemetry has been seen yet.
  private localChannelUtilization: number | null = null;
  // issue #4210 / meshtastic/firmware#11071: a remote node with neighbor_info
  // enabled hijacks our TELEMETRY_APP want_response with a promiscuous NeighborInfo
  // reply (its request_id == our request's packet id). The hijack arms the node's
  // 3-minute NeighborInfo cooldown, so an immediate retry of the same request
  // returns real telemetry (hardware-verified A/B). We track outstanding telemetry
  // requests here (keyed by packet id) so the inbound-NeighborInfo path can
  // auto-retry once. Per-manager (never global) so replies stay on the same source.
  private pendingTelemetryRequests = new Map<number, PendingTelemetryRequest>();
  // TTL comfortably covers the full ~70s two-retry schedule plus margin.
  private static readonly TELEMETRY_REQUEST_TTL_MS = 3 * 60 * 1000;
  private static readonly TELEMETRY_REQUEST_MAX_PENDING = 256;
  // Auto-retry schedule after a NeighborInfo hijack (issue #4210), two spaced
  // retries inside the firmware's 3-min NeighborInfo cooldown. LoRa is
  // half-duplex AND the hijacking NeighborInfo is want_ack'd, so the node keeps
  // RETRANSMITTING it for ~10-30s; a retry that lands during that window is
  // dropped. Hardware delay-sweep: a 5s retry recovered 0/4, a ~38s retry cleanly
  // recovered real telemetry. Retry #1 at 30s (safely past the want_ack
  // retransmission window); retry #2 at 70s from the hijack (RF-loss backstop,
  // still well inside the 3-min cooldown). The frontend telemetry loading state
  // is 30s, so a recovery on retry #1 is essentially invisible to users.
  private static readonly TELEMETRY_HIJACK_RETRY_DELAY_MS = 30000;
  private static readonly TELEMETRY_HIJACK_RETRY_2_DELAY_MS = 70000;
  // Outstanding auto-retry timers, so they can be cancelled on disconnect/teardown.
  private telemetryRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  // Where the cutoff reads ChUtil from: the local node, or the averaged
  // strongest-RSSI 0-hop infrastructure neighbours.
  private automationAirtimeCutoffSource: AirtimeCutoffSource = DEFAULT_AIRTIME_CUTOFF_SOURCE;
  // Short-lived cache for the neighbour-averaged ChUtil so the per-fire gate
  // doesn't hit the database on every automation in `neighbors` mode.
  private neighborUtilCache: { value: number | null; sampleCount: number; contributors: NeighborUtilContributor[]; at: number } | null = null;
  private static readonly NEIGHBOR_UTIL_TTL_MS = 30000;
  // Throttle the "automations gated" log so a busy mesh doesn't spam.
  private lastAirtimeGateLogTime: number = 0;
  private localStatsInterval: NodeJS.Timeout | null = null;
  private timeOffsetSamples: number[] = [];
  private timeOffsetInterval: NodeJS.Timeout | null = null;
  private localStatsIntervalMinutes: number = 15;  // Default 5 minutes
  private timerCronJobs: Map<string, CronJob> = new Map();
  private geofenceNodeState: Map<string, Set<number>> = new Map(); // geofenceId -> set of nodeNums currently inside
  private geofenceWhileInsideTimers: Map<string, NodeJS.Timeout> = new Map(); // geofenceId -> interval timer
  private geofenceCooldowns: Map<string, number> = new Map(); // "triggerId:nodeNum" -> firedAt timestamp
  private pendingAutoTraceroutes: Set<number> = new Set(); // Track auto-traceroute targets for logging
  private pendingAutoresponderTraceroutes: Map<number, {
    replyToNodeNum: number;
    isDM: boolean;
    replyChannel: number;
    packetId?: number;
    timeoutHandle: NodeJS.Timeout;
  }> = new Map(); // Track user-initiated traceroutes from the autoresponder
  private pendingTracerouteTimestamps: Map<number, number> = new Map(); // Track when traceroutes were initiated for timeout detection

  // Remote LocalStats automation (issue #3398) — periodically request local_stats
  // from remote nodes selected by list/role/favorite/regex. Round-robins one
  // target per tick (least-recently-polled) to stay gentle on shared airtime.
  private remoteLocalStatsInterval: NodeJS.Timeout | null = null;
  private remoteLocalStatsJitterTimeout: NodeJS.Timeout | null = null;
  private remoteLocalStatsIntervalMinutes: number = 0;
  private lastRemoteLocalStatsSentTime: number = 0;
  private remoteLocalStatsLastSentAt: Map<number, number> = new Map();
  private nodeLinkQuality: Map<number, { quality: number; lastHops: number }> = new Map(); // Track link quality per node
  private ignoreReapplyCooldown: Map<number, number> = new Map(); // nodeNum -> last local re-ignore push timestamp (#2601), coalesces bursts
  private remoteAdminScannerInterval: NodeJS.Timeout | null = null;
  private remoteAdminScannerIntervalMinutes: number = 0; // 0 = disabled
  private pendingRemoteAdminScans: Set<number> = new Set(); // Track nodes being scanned
  private timeSyncInterval: NodeJS.Timeout | null = null;
  private timeSyncIntervalMinutes: number = 0; // 0 = disabled
  private pendingTimeSyncs: Set<number> = new Set(); // Track nodes being synced
  private keyRepairInterval: NodeJS.Timeout | null = null;
  private keyRepairEnabled: boolean = false;
  private keyRepairIntervalMinutes: number = 5;  // Default 5 minutes
  private keyRepairMaxExchanges: number = 3;     // Default 3 attempts
  private keyRepairAutoPurge: boolean = false;   // Default: don't auto-purge
  private keyRepairImmediatePurge: boolean = false; // Default: don't immediately purge on detection
  private serverStartTime: number = Date.now();
  // Bounded concurrency for inbound packet processing. Prevents pool
  // starvation during NodeInfo/config-sync bursts (#2780): each handler does
  // many serial DB awaits, and the transport emits packets without awaiting,
  // so unbounded concurrency × serial pool checkouts would saturate pg-pool.
  // Limit is read from PACKET_CONCURRENCY_LIMIT env var once (default 4).
  private packetConcurrencyLimit: number = (() => {
    const raw = process.env.PACKET_CONCURRENCY_LIMIT;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
  })();
  private packetActiveCount: number = 0;
  private packetWaiters: Array<() => void> = [];
  private localNodeInfo: {
    nodeNum: number;
    nodeId: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    firmwareVersion?: string;
    rebootCount?: number;
    isLocked?: boolean;  // Flag to prevent overwrites after initial setup
    // Capability flags from the connected node's DeviceMetadata. Used to detect
    // a "bridged" node — a serial/BLE-only device fronted by a TCP proxy — which
    // cannot serve an OTA endpoint. Undefined until DeviceMetadata is received.
    hasWifi?: boolean;
    hasEthernet?: boolean;
    hasBluetooth?: boolean;
    // #3684: User capability flags from the local node's NodeInfo, surfaced to the
    // frontend Config tab via getCurrentConfig().localNodeInfo.
    isUnmessagable?: boolean;
    isLicensed?: boolean;
  } | null = null;
  private actualDeviceConfig: any = null;  // Store actual device config (local node)
  private actualModuleConfig: any = null;  // Store actual module config (local node)
  private sessionPasskey: Uint8Array | null = null;  // Session passkey for local node (backward compatibility)
  private sessionPasskeyExpiry: number | null = null;  // Expiry time for local node (expires after 300 seconds)
  // Per-node session passkey storage for remote admin commands
  private remoteSessionPasskeys: Map<number, { 
    passkey: Uint8Array; 
    expiry: number 
  }> = new Map();
  // Per-node config storage for remote nodes
  private remoteNodeConfigs: Map<number, {
    deviceConfig: any;
    moduleConfig: any;
    lastUpdated: number;
  }> = new Map();
  // Track pending module config requests so empty Proto3 responses can be mapped to the correct key
  private pendingModuleConfigRequests: Map<number, string> = new Map();
  // Track whether module configs have ever been fetched this process lifetime (skip on reconnect)
  private moduleConfigsEverFetched: boolean = false;
  // Per-node channel storage for remote nodes
  private remoteNodeChannels: Map<number, Map<number, any>> = new Map();
  // Per-node owner storage for remote nodes
  private remoteNodeOwners: Map<number, any> = new Map();
  // Per-node device metadata storage for remote nodes
  private remoteNodeDeviceMetadata: Map<number, any> = new Map();
  // Pending admin-command ACK waiters moved to AdminTransactionService
  // (#3962 Phase 4.2a PR4 §4d) — see that file for the map + correlation
  // logic. The manager's `processRoutingErrorMessage` dispatch code calls
  // back into it via `this.adminTransactionService.hasPending`/
  // `.resolveByRequestId` rather than touching a map here.
  // Cache the favorites-support check, keyed by the firmware version it was
  // computed from. Keying by version means the cache self-invalidates when the
  // firmware version changes or is populated late (e.g. via a NodeInfo rebuild
  // that doesn't go through processDeviceMetadata), so a `false` computed while
  // the version was unknown can never get stuck. See supportsFavorites().
  private favoritesSupportCache: { version: string; result: boolean } | null = null;
  private cachedAutoAckRegex: { pattern: string; regex: RegExp } | null = null;  // Cached compiled regex

  private autoAckCooldowns: Map<number, number> = new Map(); // nodeNum -> lastResponseTimestamp
  private autoAckProcessedPackets: Set<number> = new Set(); // packetIds already auto-acked (dedup guard)
  private autoResponderCooldowns: Map<string, number> = new Map(); // "triggerIndex:nodeNum" -> lastResponseTimestamp
  private autoResponderProcessedPackets: Set<number> = new Set(); // packetIds already auto-responded (dedup guard)

  // Dedupe/throttle for device ClientNotifications surfaced as toasts, so
  // recurring warnings (duty-cycle, etc.) don't spam the UI. See handleClientNotification.
  private clientNotificationThrottle = new ToastThrottle();

  // Ring buffer of packet ids we recently originated, used to recognise our own
  // packets when overheard/echoed/replayed so they aren't flagged as local-node
  // spoofs (#2584). See assessLocalSpoof().
  private sentPacketIds = new SentPacketIdCache();

  // Auto-ping session tracking
  private autoPingSessions: Map<number, AutoPingSession> = new Map(); // keyed by requester nodeNum

  // Auto-welcome tracking to prevent race conditions
  private welcomingNodes: Set<number> = new Set();  // Track nodes currently being welcomed
  // Kept on the manager (not moved to FavoritesService) — pinned test
  // `meshtasticManager.autoFavorite.perSource.test.ts` resets this field
  // directly (`manager.autoFavoritingNodes = new Set()`) between cases; see
  // favoritesService.ts's header comment for the full rationale.
  private autoFavoritingNodes = new Set<number>();  // Track nodes currently being auto-favorited
  private deviceNodeNums: Set<number> = new Set();  // Nodes in the connected radio's local database
  // autoFavoriteSweepRunning moved to FavoritesService (#3962 Phase 4.2a PR4 §4c) — no pinned test reaches into it.
  private rebootMergeInProgress = false;  // Guard against broadcasts during node identity merge
  private lastHeapPurgeAt: number | null = null;  // Timestamp of last auto heap purge

  // Virtual Node Server - Message capture for initialization sequence
  private initConfigCache: Array<{ type: string; data: Uint8Array }> = [];  // Store raw FromRadio messages with type metadata during init
  private isCapturingInitConfig = false;  // Flag to track when we're capturing messages
  private configCaptureComplete = false;  // Flag to track when capture is done
  private onConfigCaptureComplete: (() => void) | null = null;  // Callback for when config capture completes
  private externalConfigCaptureCallback: (() => void) | null = null;  // External callback (e.g., virtual node server init)
  private channel0Exists = false;  // Cache for channel 0 existence check to avoid repeated DB queries
  private preConfigChannelSnapshot: { id: number; psk?: string | null; name?: string | null }[] = [];  // Channel state before config sync

  // Phase C: lazily-cached human-readable source name for notifications
  private cachedSourceName: string | null = null;

  /**
   * Lazily resolve the human-readable source name from the database.
   * Cached after first lookup. Falls back to the sourceId if the source row is missing.
   */
  private async getSourceName(): Promise<string> {
    if (this.cachedSourceName !== null) return this.cachedSourceName;
    try {
      const source = await databaseService.sources.getSource(this.sourceId);
      this.cachedSourceName = source?.name ?? this.sourceId;
    } catch (err) {
      logger.debug(`Could not resolve source name for ${this.sourceId}:`, err);
      this.cachedSourceName = this.sourceId;
    }
    return this.cachedSourceName;
  }

  get sourceType(): 'meshtastic_tcp' {
    return 'meshtastic_tcp';
  }

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      logger.error(`Source ${this.sourceId} initial connect failed (auto-reconnect will retry):`, err);
    }
    try {
      await this.virtualNodeServer?.start();
    } catch (err) {
      logger.error(`Failed to start VirtualNodeServer for source ${this.sourceId}:`, err);
    }
    // Wire up the MQTT proxy bridge if this source has an mqttLink. Attempted
    // after connect(); note the transport may not yet be ready if the initial
    // connect failed above — injected ToRadio sends are try/catch-guarded and
    // the background reconnect will re-establish the transport.
    if (this.mqttLink?.enabled && this.mqttLink.mqttBrokerSourceId) {
      this.setupMqttLink();
    }
  }

  async stop(): Promise<void> {
    this.teardownMqttLink();
    try {
      await this.virtualNodeServer?.stop();
    } catch (err) {
      logger.error(`Failed to stop VirtualNodeServer for source ${this.sourceId}:`, err);
    }
    this.disconnect();
  }

  /**
   * Apply a new mqttLink config without restarting the upstream transport.
   * Called from sourceRoutes.ts when the user toggles or repoints the link
   * via the UI.
   */
  async reconfigureMqttLink(link: MeshtasticMqttLink | undefined): Promise<void> {
    this.teardownMqttLink();
    this.mqttLink = link ?? null;
    if (this.sourceConfigOverride) {
      this.sourceConfigOverride.mqttLink = link;
    }
    if (this.mqttLink?.enabled && this.mqttLink.mqttBrokerSourceId) {
      this.setupMqttLink();
    }
  }

  private setupMqttLink(): void {
    const targetId = this.mqttLink?.mqttBrokerSourceId;
    if (!targetId) return;

    const attach = (mgr: ISourceManager) => {
      // Either an embedded broker (devices publish to it locally) or a
      // standalone bridge (we go straight to the upstream broker). Both
      // expose `on('local-packet')` and `publish()`.
      if (mgr.sourceType !== 'mqtt_broker' && mgr.sourceType !== 'mqtt_bridge') return;
      this.mqttLinkBroker = mgr as
        | import('./mqttBrokerManager.js').MqttBrokerManager
        | import('./mqttBridgeManager.js').MqttBridgeManager;
      const listener = (p: import('./mqttBrokerManager.js').MqttBrokerLocalPacket) => {
        void this.handleLinkedBrokerLocalPacket(p);
      };
      this.mqttLinkBrokerListener = listener;
      this.mqttLinkBroker.on('local-packet', listener);
      logger.info(`MQTT link attached: source ${this.sourceId} ↔ ${mgr.sourceType} ${targetId}`);
    };

    const existing = sourceManagerRegistry.getManager(targetId);
    if (existing) {
      attach(existing);
      return;
    }
    // Defer until the target source starts.
    this.mqttLinkRegistryStartedListener = (m: ISourceManager) => {
      if (m.sourceId === targetId) attach(m);
    };
    sourceManagerRegistry.on('manager-started', this.mqttLinkRegistryStartedListener);

    this.mqttLinkRegistryStoppedListener = (m: ISourceManager) => {
      if (m.sourceId === targetId) {
        logger.warn(`MQTT link target ${targetId} stopped — detaching from source ${this.sourceId}`);
        this.detachMqttLinkBroker();
      }
    };
    sourceManagerRegistry.on('manager-stopped', this.mqttLinkRegistryStoppedListener);
  }

  private teardownMqttLink(): void {
    this.detachMqttLinkBroker();
    if (this.mqttLinkRegistryStartedListener) {
      sourceManagerRegistry.off('manager-started', this.mqttLinkRegistryStartedListener);
      this.mqttLinkRegistryStartedListener = null;
    }
    if (this.mqttLinkRegistryStoppedListener) {
      sourceManagerRegistry.off('manager-stopped', this.mqttLinkRegistryStoppedListener);
      this.mqttLinkRegistryStoppedListener = null;
    }
    this.mqttLinkEchoDeviceToBroker.length = 0;
    this.mqttLinkEchoBrokerToDevice.length = 0;
  }

  private detachMqttLinkBroker(): void {
    if (this.mqttLinkBroker && this.mqttLinkBrokerListener) {
      this.mqttLinkBroker.off('local-packet', this.mqttLinkBrokerListener);
    }
    this.mqttLinkBroker = null;
    this.mqttLinkBrokerListener = null;
  }

  /**
   * Inbound from the device: it sent a FromRadio.mqttClientProxyMessage,
   * which means firmware is asking us (its TCP client) to publish this
   * payload to the broker. Forward the raw bytes to the linked broker.
   */
  private async handleDeviceMqttProxyMessage(msg: { topic: string; data: Uint8Array; text?: string; retained: boolean }): Promise<void> {
    logger.debug(
      `📨 [${this.sourceId}] FromRadio.mqttClientProxyMessage topic=${msg.topic} dataLen=${msg.data?.length ?? 0} retained=${msg.retained} link=${this.mqttLinkBroker ? this.mqttLink?.mqttBrokerSourceId : 'none'}`,
    );
    if (!this.mqttLinkBroker) return;
    if (!msg.topic || msg.data.length === 0) return;
    const packetId = peekServiceEnvelopePacketId(msg.data);
    // Suppress echo from the OPPOSITE direction's history.
    if (packetId !== null && matchesMqttEcho(this.mqttLinkEchoBrokerToDevice, msg.topic, packetId)) return;
    // Record the echo BEFORE publishing. Aedes' 'publish' event fires
    // synchronously inside aedes.publish() (the await only resolves after
    // the broadcast callback), and the broker's 'local-packet' event chain
    // re-enters this manager via handleLinkedBrokerLocalPacket → echo check.
    // If we record after the await, the check finds an empty cache and the
    // same packet bounces straight back to the device as a ToRadio.
    recordMqttEcho(this.mqttLinkEchoDeviceToBroker, msg.topic, packetId);
    try {
      await this.mqttLinkBroker.publish(msg.topic, Buffer.from(msg.data), msg.retained);
    } catch (err) {
      logger.warn(`MQTT link: failed to forward device publish to broker: ${(err as Error).message}`);
    }
  }

  /**
   * Outbound to the device: the linked broker received a publish from
   * elsewhere (another device, an upstream bridge). Inject it back to
   * the device as ToRadio.mqttClientProxyMessage.
   */
  private async handleLinkedBrokerLocalPacket(p: import('./mqttBrokerManager.js').MqttBrokerLocalPacket): Promise<void> {
    if (!this.isConnected || !this.transport) return;
    const packetId = p.envelope.packet?.id !== undefined ? (p.envelope.packet.id >>> 0) : null;
    // Skip the echo of our OWN device's just-forwarded publish.
    if (packetId !== null && matchesMqttEcho(this.mqttLinkEchoDeviceToBroker, p.topic, packetId)) return;
    const bytes = meshtasticProtobufService.encodeToRadioMqttClientProxyMessage({
      topic: p.topic,
      data: p.payload,
      retained: p.retained,
    });
    if (!bytes) return;
    // Record echo BEFORE transport.send, same reasoning as the symmetric
    // path in handleDeviceMqttProxyMessage. (For broker → device the timing
    // window is wider — the device must process+republish before the cache
    // gets stale — but we keep the pattern consistent.)
    recordMqttEcho(this.mqttLinkEchoBrokerToDevice, p.topic, packetId);
    try {
      await this.transport.send(bytes);
    } catch (err) {
      logger.warn(`MQTT link: failed to inject broker message to device: ${(err as Error).message}`);
    }
  }

  async reconfigureVirtualNode(config: VirtualNodeConfig | undefined): Promise<void> {
    if (this.virtualNodeServer) {
      try {
        await this.virtualNodeServer.stop();
      } catch (err) {
        logger.error(`Failed to stop VirtualNodeServer during reconfigure for ${this.sourceId}:`, err);
      }
      this.virtualNodeServer = undefined;
    }
    if (config?.enabled) {
      this.virtualNodeServer = new VirtualNodeServer({
        port: config.port,
        allowAdminCommands: config.allowAdminCommands,
        meshtasticManager: this,
      });
      try {
        await this.virtualNodeServer.start();
      } catch (err) {
        logger.error(`Failed to start VirtualNodeServer during reconfigure for ${this.sourceId}:`, err);
      }
    }
    if (this.sourceConfigOverride) {
      (this.sourceConfigOverride as any).virtualNode = config;
    }
  }

  getStatus(): SourceStatus {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceId,
      sourceType: this.sourceType,
      connected: this.isConnected,
      nodeNum: this.localNodeInfo?.nodeNum,
      nodeId: this.localNodeInfo?.nodeId,
    };
  }

  // Per-source message queue — each MeshtasticManager instance gets its own queue
  // so the sendCallback routes to THIS source's device. A singleton queue would
  // overwrite its callback on every new manager constructor, causing all auto-acks
  // to route through whichever source was constructed last (the source of the
  // 4.0-alpha NO_CHANNEL auto-ack regression).
  // Constructed in the constructor body (not here) — field initializers run
  // before `this.sourceId` is assigned, and MessageQueueService needs it for
  // per-source `autoAckMaxAttempts` reads (#4266).
  public readonly messageQueue: MessageQueueService;

  // NodeDB maintenance (purge/refresh/remove-node + DB-row→DeviceInfo mapping) —
  // extracted to a service (#3962 Phase 4.2a PR2 §4f). Injected with `this` via
  // constructor (import-cycle-safe: the service only `import type`s MeshtasticManager).
  private readonly nodeDbMaintenanceService: NodeDbMaintenanceService;

  // Auto-announce scheduler + send — extracted to a service (#3962 Phase 4.2a
  // PR3 §4b). Same injection pattern as nodeDbMaintenanceService above.
  private readonly autoAnnounceService: AutoAnnounceService;

  // Admin-command ACK correlation — extracted to a service (#3962 Phase 4.2a
  // PR4 §4d). Same injection pattern as the services above.
  private readonly adminTransactionService: AdminTransactionService;

  // Favorites management — extracted to a service (#3962 Phase 4.2a PR4 §4c).
  // Depends on adminTransactionService (constructed first, passed in below).
  private readonly favoritesService: FavoritesService;

  // Local device-config setters + edit-session flow, and the pure
  // buildDeviceConfigFromActual marshalling — extracted to a service
  // (#3962 Phase 4.2a PR5 §4e). Same injection pattern as the services above.
  private readonly deviceAdminService: DeviceAdminService;

  // Remote-admin fetch flows (config/channel/owner/device-metadata over the
  // mesh) + module-config request/refresh/reset — extracted to a sibling
  // service (#3962 Phase 4.2a PR5 §4e, optional split). Independent of
  // deviceAdminService; neither depends on the other.
  private readonly remoteAdminService: RemoteAdminService;

  constructor(sourceId: string = 'default', sourceConfig?: { host?: string; port?: number; heartbeatIntervalSeconds?: number; virtualNode?: VirtualNodeConfig; mqttLink?: MeshtasticMqttLink; passiveMode?: boolean; passiveResyncStaleMs?: number | null }) {
    this.sourceId = sourceId;
    this.messageQueue = new MessageQueueService(this.sourceId);
    this.nodeDbMaintenanceService = new NodeDbMaintenanceService(this);
    this.autoAnnounceService = new AutoAnnounceService(this);
    this.adminTransactionService = new AdminTransactionService(this);
    this.favoritesService = new FavoritesService(this, this.adminTransactionService);
    this.deviceAdminService = new DeviceAdminService(this);
    this.remoteAdminService = new RemoteAdminService(this);
    if (sourceConfig) {
      this.sourceConfigOverride = {
        host: sourceConfig.host,
        port: sourceConfig.port,
        heartbeatIntervalSeconds: sourceConfig.heartbeatIntervalSeconds,
        mqttLink: sourceConfig.mqttLink,
        passiveMode: sourceConfig.passiveMode === true,
        passiveResyncStaleMs:
          typeof sourceConfig.passiveResyncStaleMs === 'number'
            ? sourceConfig.passiveResyncStaleMs
            : undefined,
      };
      this.passiveMode = sourceConfig.passiveMode === true;
      this.passiveResyncStaleMs =
        typeof sourceConfig.passiveResyncStaleMs === 'number'
          ? sourceConfig.passiveResyncStaleMs
          : null;
      if (sourceConfig.mqttLink) this.mqttLink = sourceConfig.mqttLink;
    }
    if (sourceConfig?.virtualNode?.enabled) {
      this.virtualNodeServer = new VirtualNodeServer({
        port: sourceConfig.virtualNode.port,
        allowAdminCommands: sourceConfig.virtualNode.allowAdminCommands,
        meshtasticManager: this,
      });
    }
    // Initialize message queue service with send callback
    this.messageQueue.setSendCallback(async (text: string, destination: number, replyId?: number, channel?: number, emoji?: number) => {
      // For channel messages: channel is specified, destination is 0 (undefined in sendTextMessage)
      // For DMs: channel is undefined, destination is the node number
      if (channel !== undefined) {
        // Channel message - send to channel, no specific destination
        return await this.sendTextMessage(text, channel, undefined, replyId, emoji);
      } else {
        // DM - use the channel we last heard the target node on.
        // Source-scoped lookup — composite PK (nodeNum, sourceId) requires it
        // and prevents us from accidentally using a peer source's channel.
        const targetNode = await databaseService.nodes.getNode(destination, this.sourceId);
        const dmChannel = (targetNode?.channel !== undefined && targetNode?.channel !== null) ? targetNode.channel : 0;
        logger.debug(`📨 Queue DM to ${destination} - Using channel: ${dmChannel}`);
        return await this.sendTextMessage(text, dmChannel, destination, replyId, emoji);
      }
    });

    // Position estimation runs as a global, scheduled batch job
    // (positionEstimationScheduler), not per-source at connect time. See #3271.
  }

  /**
   * Get environment configuration (always uses fresh values from getEnvironmentConfig)
   * This ensures .env values are respected even if the manager is instantiated before dotenv loads.
   * Per-source config (set via source record) takes priority over env vars and DB overrides.
   */
  /**
   * Build an encoded ToRadio Heartbeat packet (issue 2609).
   *
   * Meshtastic firmware treats an incoming Heartbeat in `ToRadio` as a
   * no-op "client is still alive" marker — the device does not generate a
   * response. MeshMonitor sends this periodically to keep quiet nodes
   * (CLIENT_MUTE) from getting reconnected by the stale-data health check.
   * The transport resets `lastDataReceived` on a successful write, so the
   * heartbeat also doubles as the liveness signal for that detector.
   */
  private encodeHeartbeatToRadio(): Uint8Array {
    const root = getProtobufRoot();
    if (!root) {
      throw new Error('Protobuf definitions not loaded — cannot build heartbeat');
    }
    const ToRadio = root.lookupType('meshtastic.ToRadio');
    const Heartbeat = root.lookupType('meshtastic.Heartbeat');
    const heartbeat = Heartbeat.create({});
    const toRadio = ToRadio.create({ heartbeat });
    return ToRadio.encode(toRadio).finish();
  }

  private async getConfig(): Promise<MeshtasticConfig> {
    // Per-source config takes priority (set when this manager was created from a
    // source record via the constructor). A configured
    // source MUST resolve to its own host — even on a reconnect that fires before
    // anything else is ready — and must never fall through to the env default
    // ('192.168.1.100'), which would surface the wrong address in the connection
    // status (#3611). The presence of sourceConfigOverride is the signal that
    // this manager belongs to a configured source; only the truly unconfigured
    // legacy singleton (no override at all) is allowed to use the env/runtime
    // default below.
    if (this.sourceConfigOverride) {
      return {
        nodeIp: this.sourceConfigOverride.host ?? getEnvironmentConfig().meshtasticNodeIp,
        tcpPort: this.sourceConfigOverride.port ?? 4403,
      };
    }

    const env = getEnvironmentConfig();

    // Check for runtime override in settings (set via UI) — only for the default/legacy manager
    const overrideIp = await databaseService.settings.getSetting('meshtasticNodeIpOverride');
    const overridePortStr = await databaseService.settings.getSetting('meshtasticTcpPortOverride');
    const overridePort = overridePortStr ? parseInt(overridePortStr, 10) : null;

    return {
      nodeIp: overrideIp || env.meshtasticNodeIp,
      tcpPort: (overridePort && !isNaN(overridePort)) ? overridePort : env.meshtasticTcpPort
    };
  }

  /**
   * Get connection config for scripts. When Virtual Node is enabled, returns
   * localhost + virtual node port so scripts connect through the Virtual Node
   * instead of opening a second TCP connection to the physical node (which would
   * kill MeshMonitor's connection). Falls back to getConfig() when Virtual Node
   * is disabled.
   */
  private async getScriptConnectionConfig(): Promise<MeshtasticConfig> {
    return await this.getConfig();
  }

  /**
   * Set a runtime IP (and optionally port) override and reconnect
   * Accepts formats: "192.168.1.100", "192.168.1.100:4403", "hostname", "hostname:4403"
   * This setting is temporary and will reset when the container restarts
   */
  async setNodeIpOverride(address: string): Promise<void> {
    // Parse IP and optional port from address
    let ip = address;
    let port: string | null = null;

    // Check for port suffix (handle both IPv4 and hostname with port)
    const portMatch = address.match(/^(.+):(\d+)$/);
    if (portMatch) {
      ip = portMatch[1];
      port = portMatch[2];
    }

    await databaseService.settings.setSetting('meshtasticNodeIpOverride', ip);
    if (port) {
      await databaseService.settings.setSetting('meshtasticTcpPortOverride', port);
    } else {
      // Clear port override if not specified (use default)
      await databaseService.settings.setSetting('meshtasticTcpPortOverride', '');
    }

    // Disconnect and reconnect with new IP/port
    this.disconnect();
    await this.connect();
  }

  /**
   * Clear the runtime IP/port override and revert to defaults
   */
  async clearNodeIpOverride(): Promise<void> {
    await databaseService.settings.setSetting('meshtasticNodeIpOverride', '');
    await databaseService.settings.setSetting('meshtasticTcpPortOverride', '');
    this.disconnect();
    await this.connect();
  }

  /**
   * Save an array of telemetry metrics to the database
   * Filters out undefined/null/NaN values before inserting
   */
  private async saveTelemetryMetrics(
    metricsToSave: Array<{ type: string; value: number | undefined; unit: string }>,
    nodeId: string,
    fromNum: number,
    timestamp: number,
    packetTimestamp: number | undefined,
    packetId?: number
  ): Promise<void> {
    const now = Date.now();
    for (const metric of metricsToSave) {
      if (metric.value !== undefined && metric.value !== null && !isNaN(Number(metric.value))) {
        await databaseService.telemetry.insertTelemetry({
          nodeId,
          nodeNum: fromNum,
          telemetryType: metric.type,
          timestamp,
          value: Number(metric.value),
          unit: metric.unit,
          createdAt: now,
          packetTimestamp,
          packetId
        }, this.sourceId);
      }
    }
  }

  /**
   * Normalize a decoded protobuf metrics sub-message (device / environment /
   * airQuality / power) into the canonical `{ type, value, unit }` rows that
   * {@link saveTelemetryMetrics} persists.
   *
   * This iterates the *actual* fields the decoder produced rather than reading a
   * hand-maintained list of camelCase property names. That matters because of
   * the protobuf.js underscore-before-digit quirk (#3483): fields like
   * `particles_03um` / `rainfall_1h` stay snake_case on the decoded message, so
   * a fixed `metrics.particles03um` read returns undefined and silently drops
   * the data. {@link canonicalTelemetryType} runs each decoded leaf through the
   * same digit-aware `snakeToCamel` the MQTT path uses, so a new
   * underscore-before-digit field is picked up automatically once its unit is
   * added to `CANONICAL_TELEMETRY_UNITS` — no per-field fallback to maintain.
   *
   * Only numeric leaves with a known canonical unit are stored: this skips
   * repeated/message fields (protobuf.js exposes e.g. `oneWireTemperature` as an
   * own `[]`), Long/object values, and leaves we don't track (unit === undefined).
   */
  private buildCanonicalMetrics(
    group: 'device' | 'environment' | 'airQuality' | 'power' | 'localStats' | 'host' | 'trafficManagement',
    metrics: Record<string, unknown>
  ): Array<{ type: string; value: number; unit: string }> {
    const rows: Array<{ type: string; value: number; unit: string }> = [];
    for (const [leaf, raw] of Object.entries(metrics)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const type = canonicalTelemetryType(group, leaf);
      const unit = canonicalTelemetryUnit(type);
      if (unit === undefined) continue;
      rows.push({ type, value: raw, unit });
    }
    return rows;
  }

  /**
   * Connect to the node, serialized so overlapping callers never build two
   * transports.
   *
   * #3270 follow-up: connect() has several `await`s (getConfig, protobuf init,
   * the up-to-10s transport.connect) before it assigns `this.transport`. The
   * legacy singleton is hit by routes that call connect() whenever
   * `isConnected` is false (e.g. refreshNodeDatabase). If a second connect()
   * lands during the first one's handshake window, both pass the
   * teardown-existing-transport check (this.transport is still null/stale) and
   * each constructs a TcpTransport. The first then becomes an unreferenced
   * orphan that auto-reconnects forever — the residual flap the #3276 teardown
   * cannot reach because it only tears down the transport currently in
   * `this.transport`. A single-flight latch makes a concurrent connect() join
   * the in-flight attempt instead of racing it.
   */
  async connect(injectedTransport?: ITransport): Promise<boolean> {
    if (this.connectInFlight) {
      logger.debug('connect() already in progress — joining the in-flight attempt (prevents orphaned-transport flap #3270)');
      return this.connectInFlight;
    }
    this.connectInFlight = this.doConnectInternal(injectedTransport)
      .finally(() => { this.connectInFlight = null; });
    return this.connectInFlight;
  }

  private async doConnectInternal(injectedTransport?: ITransport): Promise<boolean> {
    try {
      const config = await this.getConfig();
      logger.debug(`Connecting to Meshtastic node at ${config.nodeIp}:${config.tcpPort}...`);

      // #3962 Phase 4.2b C2: CONNECT_REQUESTED — teardown-prev-transport
      // (#3270, `teardownExistingTransport` below is the `teardownPrevTransport`
      // action's implementation, extracted verbatim from the old inline
      // block) if different from an injected transport; routes to Probing
      // first when a post-reset cooldown is pending, else straight to
      // Connecting.
      const requestCtx = this.buildSmContext({ postResetActive: this.postResetCooldownUntil > 0 });
      const { next: afterRequest, actions: requestActions } = dispatch(this.#state, 'CONNECT_REQUESTED', requestCtx);
      this.#state = afterRequest;
      for (const action of requestActions) {
        if (action.kind === 'teardownPrevTransport') this.teardownExistingTransport(injectedTransport);
      }
      this.assertStateConsistent();

      // Initialize protobuf service first
      await meshtasticProtobufService.initialize();

      // Use injected transport or create a new TcpTransport with environment config
      if (injectedTransport) {
        this.transport = injectedTransport;
      } else {
        const tcpTransport = new TcpTransport();
        const env = getEnvironmentConfig();
        tcpTransport.setStaleConnectionTimeout(env.meshtasticStaleConnectionTimeout);
        tcpTransport.setConnectTimeout(env.meshtasticConnectTimeoutMs);
        tcpTransport.setReconnectTiming(env.meshtasticReconnectInitialDelayMs, env.meshtasticReconnectMaxDelayMs);
        // Passive-mode sources get a startup-grace fast-reconnect window
        // (#3122). On large/fragile TCP nodes the first session often closes
        // mid-sync but the second works — a 3s delay for the first 2min
        // shortens the user-visible "stuck reconnecting" gap without
        // changing steady-state backoff once the session stabilizes.
        if (this.passiveMode) {
          tcpTransport.setStartupGraceReconnect(
            MeshtasticManager.STARTUP_GRACE_WINDOW_MS,
            MeshtasticManager.STARTUP_GRACE_FAST_DELAY_MS,
          );
        }

        // Optional per-source keepalive heartbeat (issue 2609). When configured,
        // we periodically send a Meshtastic Heartbeat ToRadio to the device so
        // quiet nodes (CLIENT_MUTE) don't look idle to the stale-connection
        // detector. Default 0 = disabled, preserves prior behavior.
        const heartbeatSeconds = this.sourceConfigOverride?.heartbeatIntervalSeconds ?? 0;
        if (heartbeatSeconds > 0) {
          tcpTransport.setHeartbeatInterval(
            heartbeatSeconds * 1000,
            () => this.encodeHeartbeatToRadio()
          );
          logger.info(`💓 Heartbeat enabled for source ${this.sourceId}: every ${heartbeatSeconds}s`);
        }

        this.transport = tcpTransport;
      }

      // Setup event handlers
      this.transport.on('connect', () => {
        this.handleConnected().catch((error) => {
          logger.error('Error in handleConnected:', error);
        });
      });

      this.transport.on('message', (data: Uint8Array) => {
        void this.processIncomingData(data);
      });

      this.transport.on('disconnect', () => {
        this.handleDisconnected().catch((error) => {
          logger.error('Error in handleDisconnected:', error);
        });
      });

      this.transport.on('error', (error: Error) => {
        logger.error('❌ TCP transport error:', error.message);
      });

      // Only honor cooldown + probe when handleConnected has flagged a
      // post-OTA half-open recovery (Probing, entered above by
      // CONNECT_REQUESTED when postResetCooldownUntil > 0). On cold/normal
      // connects we skip both so the 15s TCP probe doesn't eat the caller's
      // connection budget.
      if (this.#state === ConnState.Probing) {
        // Honor post-reset cooldown — after a transient post-OTA half-open
        // connect we deliberately wait before re-attempting so the node's
        // WiFi stack can finish settling and we don't loop on the same race.
        const cooldownRemaining = this.postResetCooldownUntil - Date.now();
        if (cooldownRemaining > 0) {
          logger.debug(`⏸️ Post-reset cooldown active, waiting ${cooldownRemaining}ms before reconnect`);
          await new Promise((r) => setTimeout(r, cooldownRemaining));
        }

        // Best-effort TCP-readiness probe — confirm the node is actually
        // accepting sockets before we hand off to the @meshtastic/js transport.
        try {
          await this.waitForTcpReady(config.nodeIp, config.tcpPort);
        } catch (probeErr) {
          const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          logger.warn(`⚠️ TCP readiness probe to ${config.nodeIp}:${config.tcpPort} failed (${msg}) — proceeding anyway`);
        }

        // #3962 Phase 4.2b C2: PROBE_DONE — Probing -> Connecting, clears
        // postResetCooldownUntil. 'connectTransport' is a no-op marker here —
        // the actual `transport.connect()` call is the unconditional
        // statement immediately below, for both the Probing and
        // non-Probing paths.
        const { next: afterProbe, actions: probeActions } = dispatch(this.#state, 'PROBE_DONE', requestCtx);
        this.#state = afterProbe;
        for (const action of probeActions) {
          if (action.kind === 'clearPostResetCooldown') this.postResetCooldownUntil = 0;
        }
        this.assertStateConsistent();
      }

      // Connect to node
      // Note: isConnected will be set to true in handleConnected() callback
      // when the connection is actually established
      await this.transport.connect(config.nodeIp, config.tcpPort);

      return true;
    } catch (error) {
      // No SmEvent models a synchronous connect-attempt failure (getConfig/
      // protobuf-init/transport.connect throwing) — task42b_spec.md §3.2 has
      // no such row. The `isConnected` write-shim's false-branch already
      // implements exactly the right semantics here ("go to Disconnected
      // unless already UserDisconnected"), so it's kept as-is rather than
      // inventing a new transition for an untabulated edge case.
      this.isConnected = false;
      logger.error('Failed to connect to Meshtastic node:', error);
      throw error;
    }
  }

  /**
   * Poll the node's TCP port until it accepts a connection, or the overall
   * deadline elapses. Used after an OTA reboot (or any transient half-open
   * connect) to avoid racing the @meshtastic/js transport against a node
   * whose WiFi stack hasn't finished coming up yet.
   */
  private async waitForTcpReady(host: string, port: number): Promise<void> {
    const deadline = Date.now() + TCP_READY_TIMEOUT_MS;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      const attemptStart = Date.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect({ host, port });
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch { /* ignore */ }
            if (err) reject(err); else resolve();
          };
          const timer = setTimeout(() => finish(new Error('TCP readiness probe timeout')), TCP_READY_CONNECT_TIMEOUT_MS);
          socket.once('connect', () => { clearTimeout(timer); finish(); });
          socket.once('error', (err) => { clearTimeout(timer); finish(err); });
        });
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const elapsed = Date.now() - attemptStart;
        const wait = Math.max(0, TCP_READY_INTERVAL_MS - elapsed);
        if (Date.now() + wait >= deadline) break;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr ?? new Error(`TCP readiness probe to ${host}:${port} exceeded ${TCP_READY_TIMEOUT_MS}ms`);
  }

  private async handleConnected(): Promise<void> {
    logger.debug('TCP connection established, requesting configuration...');
    // Capture the transport reference we connected with. Several awaits below
    // (notifyNodeConnected, channel snapshot, sendWantConfigId) yield the
    // event loop, during which a parallel disconnect/reconnect cycle can
    // null or replace `this.transport`. When that happens, `sendWantConfigId`
    // throws "Transport not initialized" and the connect-error path treats
    // it as a transient post-connect reset, producing a 3×/min reconnect
    // loop on otherwise-healthy TCP sessions (#3247). Holding the original
    // reference lets the catch block tell "transport went away under me"
    // (silent bail — the new connect already in flight will retry) apart
    // from a genuine transport-layer send failure.
    const transportAtConnect = this.transport;
    if (!transportAtConnect) {
      logger.debug('🟡 [connect-race] handleConnected fired with no transport — skipping handshake (#3247)');
      return;
    }

    // Passive Mode (issue #3122): if we already have a cached snapshot of the
    // node and config, skip the destabilizing post-reconnect full sync.
    // First connect (or a stale cache older than the effective window) still
    // does the full handshake so we don't drift permanently out of date.
    // The window is per-source-configurable via passiveResyncStaleMs and
    // falls back to PASSIVE_RESYNC_STALE_MS (4h) when unset.
    //
    // #3962 Phase 4.2b C2 (task42b_spec.md §0.3 case 2): this skip/full
    // decision only reads synchronously-available fields, so it's computed
    // here, BEFORE the state write, and folded into ONE atomic
    // TRANSPORT_CONNECTED dispatch below — no intermediate "connected but
    // undecided" window between setting isConnected and picking a target.
    const passiveResyncFresh =
      this.passiveMode &&
      this.localNodeInfo !== null &&
      this.actualDeviceConfig !== null &&
      this.lastDisconnectAt !== null &&
      Date.now() - this.lastDisconnectAt < this.effectivePassiveResyncStaleMs();

    // suppressNextAutoSync latches a one-shot skip across a disconnect/reconnect
    // cycle, used by manual-resync recovery: if the operator's forced sync caused
    // the node to close the socket, we don't want the reconnect to immediately
    // retry the same sync and reproduce the failure loop (#3122 follow-up).
    const consumeSuppressFlag = this.suppressNextAutoSync;
    const skipFullSync = passiveResyncFresh || consumeSuppressFlag;

    const { next } = dispatch(
      this.#state,
      'TRANSPORT_CONNECTED',
      this.buildSmContext({ cachesFresh: passiveResyncFresh, suppressNext: consumeSuppressFlag })
    );
    this.#state = next;

    // Emit WebSocket event for connection status change
    dataEventEmitter.emitConnectionStatus({
      connected: true,
      reason: 'TCP connection established'
    }, this.sourceId);

    if (consumeSuppressFlag) {
      // 'consumeSuppressNext' action
      this.suppressNextAutoSync = false;
      logger.warn('🟡 [manual-resync recovery] Skipping want_config_id on this reconnect — the previous manual resync did not complete cleanly; cached config will be reused');
    }

    // Keep cached localNodeInfo when we're skipping the sync — dependent code
    // would otherwise briefly mark the node un-responsive between connect events.
    if (!skipFullSync) {
      // Clear localNodeInfo so node will be marked as not responsive until it sends MyNodeInfo
      // ('clearDeviceCaches' action, localNodeInfo portion)
      this.localNodeInfo = null;
    }

    // Notify server event service of connection (handles initial vs reconnect logic)
    await serverEventNotificationService.notifyNodeConnected(this.sourceId, await this.getSourceName());

    try {
      if (skipFullSync) {
        // Skip the want_config_id handshake. Mesh traffic (received packets)
        // continues to flow without it, and we already have a recent config
        // snapshot. This is the core stability fix for large TCP nodes that
        // close the socket under sync pressure (#3122). Mark capture complete
        // so the post-config scheduler logic still runs (with passive-mode
        // skips applied below).
        const reason = consumeSuppressFlag
          ? '🟡 [manual-resync recovery] Skipping want_config_id — using cached config'
          : '🟢 [passive] Skipping want_config_id on reconnect — using cached config from last session';
        logger.debug(reason);
        // 'completeConfigCapture' action — skip path marks the cached
        // snapshot current without a fresh sync.
        this.completeConfigCapture();
        // A manual-resync recovery should also clear the in-flight latch so the
        // operator's button re-enables (the original sync never reached
        // configComplete, so the normal onConfigCaptureComplete handler
        // wouldn't have fired). Use 'recovery' so the watchdog cancels cleanly.
        // ('clearManualResync' action, reason: 'recovery')
        if (consumeSuppressFlag) {
          this.clearManualResyncInFlight('recovery');
        }
        // Run the scheduler callback as if config had just completed. The
        // callback itself honors passiveMode and will skip the outbound burst.
        // ('runOnConfigCaptureComplete' action)
        if (this.onConfigCaptureComplete) {
          try { this.onConfigCaptureComplete(); } catch (e) { logger.error('❌ Error in passive-mode config-capture callback:', e); }
        }
        this.assertStateConsistent();
        return;
      }

      // Enable message capture for virtual node server
      // Clear any previous cache and start capturing
      // ('clearDeviceCaches' + 'startConfigCapture' actions)
      this.initConfigCache = [];
      this.startConfigCapture();
      this.deviceNodeNums.clear();
      this.channel0Exists = false;  // Reset channel 0 cache on reconnect

      // Snapshot channel state before config sync for migration detection (#2425)
      try {
        this.preConfigChannelSnapshot = (await databaseService.channels.getAllChannels(this.sourceId))
          .map(ch => ({ id: ch.id, psk: ch.psk, name: ch.name }));
        logger.debug(`📸 Snapshotted ${this.preConfigChannelSnapshot.length} channels before config sync`);
      } catch {
        this.preConfigChannelSnapshot = [];
      }

      logger.debug('📸 Starting init config capture for virtual node server');

      // Send want_config_id to request full node DB and config.
      // If the node resets the socket between our 'connect' event and this
      // first send (common right after an OTA reboot), transport.send throws
      // "Not connected to TCP server". Treat that as a transient half-open
      // connect and force-clean state so the reconnect path starts fresh
      // — otherwise isConnected stays true while the transport is gone and
      // every later operation fails with the same error.
      try {
        // 'sendWantConfig' action
        await this.sendWantConfigId();
      } catch (sendErr) {
        const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        // If `this.transport` was nulled or replaced while we were awaiting
        // earlier init work, the failing send was against a stale generation
        // of the handler — the actual TCP session is unaffected and a new
        // connect cycle is already in flight (or the source is being shut
        // down). Tearing down here would create the 3×/min reconnect loop
        // documented in #3247, so bail out quietly instead.
        //
        // #3962 Phase 4.2b C2: HANDSHAKE_SEND_FAILED. The identity mismatch
        // branch is the reducer's silent bail (#3247) — no state mutation, no
        // flag write, no emit; the genuine-failure branch transitions
        // ConfigSync -> Disconnected via the returned actions.
        const transportIdentityMatches = this.transport === transportAtConnect;
        const { next: failNext, actions: failActions } = dispatch(
          this.#state,
          'HANDSHAKE_SEND_FAILED',
          this.buildSmContext({ transportIdentityMatches })
        );
        this.#state = failNext;
        if (!transportIdentityMatches) {
          logger.debug(`🟡 [connect-race] sendWantConfigId aborted — transport replaced during handshake (${msg}) (#3247)`);
          this.assertStateConsistent();
          return;
        }
        // Genuine transport-layer failure (e.g. tcpTransport.send throwing
        // "Not connected to TCP server" because the node closed the socket
        // mid-OTA-reboot). The existing post-reset cooldown path is correct
        // for this case.
        logger.warn(`⚠️ Initial sendWantConfigId failed (${msg}) — treating as transient post-connect reset, clearing state for clean reconnect`);
        for (const action of failActions) {
          switch (action.kind) {
            case 'setPostResetCooldown':
              this.postResetCooldownUntil = Date.now() + POST_RESET_COOLDOWN_MS;
              break;
            case 'disconnectTransport':
              try { await this.transport?.disconnect(); } catch { /* ignore */ }
              break;
            case 'emitStatus':
              dataEventEmitter.emitConnectionStatus({
                connected: false,
                reason: `Transport reset immediately after connect: ${msg}`,
              }, this.sourceId);
              break;
            default:
              break;
          }
        }
        // A genuine post-connect reset never got far enough to arm the
        // fallback timer for THIS attempt, but a still-pending timer from an
        // earlier attempt would otherwise survive into the next connect cycle.
        this.cancelConfigCompleteFallbackTimer();
        this.assertStateConsistent();
        this.handleDisconnected().catch((e) => logger.error('Error in handleDisconnected (post-connect-reset cleanup):', e));
        return;
      }

      logger.debug('⏳ Waiting for configuration data from node...');

      // Note: With TCP, we don't need to poll - messages arrive via events
      // The configuration will come in automatically as the node sends it

      // Register a one-time callback to start schedulers AFTER the device
      // finishes sending its config (configComplete event). This prevents
      // flooding the device with outbound requests while it's still streaming
      // config data — the root cause of ECONNRESET on WiFi devices (#2474).
      // Replace (not chain) the config capture callback on each reconnect.
      // Chaining would accumulate scheduler starts across reconnects, causing
      // duplicate cron jobs (e.g., 4 reconnects = 4x auto-welcome messages).
      this.onConfigCaptureComplete = () => {
        // Manual resync completed successfully — clear the in-flight latch and
        // cancel the watchdog so the operator's button re-enables (after cooldown).
        this.clearManualResyncInFlight('configComplete');

        // Call external callback (e.g., virtual node server init) — registered once, safe to call on every reconnect
        if (this.externalConfigCaptureCallback) {
          try { this.externalConfigCaptureCallback(); } catch (e) { logger.error('❌ Error in external config capture callback:', e); }
        }

        // If localNodeInfo wasn't set during configuration, initialize it from database
        if (!this.localNodeInfo) {
          this.initializeLocalNodeInfoFromDatabase().catch(e =>
            logger.error('❌ Error initializing local node info:', e));
        }

        // Auto-extract the local node's PKI private key (if the operator enabled
        // PKI DM decryption for this source) so DMs to this node can be decrypted
        // server-side and surfaced in the unified view (#3441).
        this.maybeExtractAndStorePkiKey().catch(e =>
          logger.warn(`[MeshtasticManager:${this.sourceId}] PKI key extraction failed: ${(e as Error).message}`));

        // Stagger scheduler starts to avoid overwhelming the device (#2474)
        // Each scheduler gets its own delay so outbound requests are spread out
        const S = MeshtasticManager.SCHEDULER_STAGGER_MS;
        // Passive Mode (#3122): on large/fragile TCP nodes, the staggered
        // outbound bursts of admin/config/time-sync traffic correlate with
        // remote-initiated socket closes. Skip the device-bound outbound
        // schedulers; keep local/receive-only ones (geofence, local stats,
        // time-offset learning, announce, timer, key repair, distance delete,
        // auto-favorite sweep) running.
        const passive = this.passiveMode;
        setTimeout(() => this.startTracerouteScheduler(), S * 1);
        if (passive) {
          logger.debug('🟢 [passive] Skipping remote admin scanner — outbound queries to device');
        } else {
          setTimeout(() => this.startRemoteAdminScanner().catch(e =>
            logger.error('❌ Error starting remote admin scanner:', e)), S * 2);
        }
        if (passive) {
          logger.debug('🟢 [passive] Skipping time sync scheduler — outbound time corrections to device');
        } else {
          setTimeout(() => this.startTimeSyncScheduler().catch(e =>
            logger.error('❌ Error starting time sync scheduler:', e)), S * 3);
        }
        setTimeout(() => this.startLocalStatsScheduler(), S * 4);
        setTimeout(() => this.startTimeOffsetScheduler(), S * 5);
        setTimeout(() => this.startAnnounceScheduler().catch(e =>
          logger.error('❌ Error starting announce scheduler:', e)), S * 6);
        setTimeout(() => this.startTimerScheduler().catch(e =>
          logger.error('❌ Error starting timer scheduler:', e)), S * 7);

        // Load the airtime cutoff settings (local values, no outbound traffic)
        this.loadAirtimeCutoffSettings().catch(e =>
          logger.error('❌ Error loading airtime cutoff settings:', e));

        // Start geofence engine (no outbound traffic, safe immediately)
        this.initGeofenceEngine().catch(e =>
          logger.error('❌ Error initializing geofence engine:', e));

        // Start auto key repair scheduler
        setTimeout(() => this.startKeyRepairScheduler(), S * 8);

        // Start auto-delete-by-distance scheduler (per-source)
        setTimeout(() => this.startDistanceDeleteScheduler().catch(e =>
          logger.error('❌ Error starting distance delete scheduler:', e)), S * 9);

        // Start remote LocalStats request scheduler (per-source, issue #3398).
        // Outbound to the mesh, so skip in passive mode like other device-bound queries.
        if (passive) {
          logger.debug('🟢 [passive] Skipping remote LocalStats scheduler — outbound queries to mesh');
        } else {
          setTimeout(() => this.startRemoteLocalStatsScheduler(), S * 10);
        }

        // Request LoRa config (config type 5) for Configuration tab — deferred
        // until after configComplete so we don't flood the device mid-exchange.
        // This is safe for serial-bridge connections that reject mid-exchange admin msgs.
        if (passive) {
          logger.debug('🟢 [passive] Skipping LoRa config request — outbound to device');
        } else {
          setTimeout(async () => {
            try {
              logger.debug('📡 Requesting LoRa config from device...');
              await this.requestConfig(5); // LORA_CONFIG = 5
            } catch (error) {
              logger.error('❌ Failed to request LoRa config:', error);
            }
          }, S * 9);
        }

        // Request all module configs for complete device backup capability (skip on reconnect)
        if (passive) {
          logger.debug('🟢 [passive] Skipping all-module-configs request — outbound to device');
        } else if (!this.moduleConfigsEverFetched) {
          setTimeout(async () => {
            try {
              logger.debug('📦 Requesting all module configs for backup...');
              await this.requestAllModuleConfigs();
              this.moduleConfigsEverFetched = true;
            } catch (error) {
              logger.error('❌ Failed to request all module configs:', error);
            }
          }, S * 10);
        } else {
          logger.debug('📦 Skipping module config request on reconnect (already fetched this session)');
        }

        // Auto-favorite staleness sweep - runs every 60 minutes
        setInterval(() => {
          this.autoFavoriteSweep().catch(error => {
            logger.error('❌ Error in auto-favorite sweep interval:', error);
          });
        }, 60 * 60 * 1000);

        // Run initial sweep after all schedulers have started
        setTimeout(() => {
          this.autoFavoriteSweep().catch(error => {
            logger.error('❌ Error in initial auto-favorite sweep:', error);
          });
        }, S * 11);

        logger.debug(`✅ Config capture complete — schedulers will start over the next ${(S * 11) / 1000} seconds`);
      };

      // Fallback: if configComplete never arrives (device disconnects mid-config),
      // start schedulers after the fallback timeout anyway.
      // 'armFallbackTimer' action.
      this.armConfigCompleteFallbackTimer();

      this.assertStateConsistent();
    } catch (error) {
      logger.error('❌ Failed to request configuration:', error);
      await this.ensureBasicSetup();
    }
  }

  private async handleDisconnected(): Promise<void> {
    logger.debug('TCP connection lost');

    // #3962 Phase 4.2b C2: TRANSPORT_DISCONNECTED. A transport-level
    // disconnect that fires after an operator-initiated userDisconnect()
    // must not regress UserDisconnected back to the auto-reconnecting
    // Disconnected state — the pure reducer's TRANSPORT_DISCONNECTED case
    // doesn't branch on the incoming state at all (task42b_spec.md §3.2 has
    // no such row), so — same pattern as the manual-resync guards living in
    // the manager rather than the reducer (§5) — that invariant is enforced
    // here. The cache-clearing/notify actions still run either way, matching
    // pre-refactor behavior (only the resulting state and the notify call
    // were ever gated on it).
    const alreadyUserDisconnected = this.#state === ConnState.UserDisconnected;
    const ctx = this.buildSmContext({ vnEnabled: this.virtualNodeServer !== undefined });
    const { next, actions } = dispatch(this.#state, 'TRANSPORT_DISCONNECTED', ctx);
    this.#state = alreadyUserDisconnected ? ConnState.UserDisconnected : next;

    // 'recordLastDisconnect' action
    this.lastDisconnectAt = Date.now();

    // Emit WebSocket event for connection status change. Captured from
    // localNodeInfo now, before any cache-clearing action below may null it
    // (matches pre-refactor ordering — the emit used to fire before the
    // passive/non-passive branch).
    dataEventEmitter.emitConnectionStatus({
      connected: false,
      nodeNum: this.localNodeInfo?.nodeNum,
      nodeId: this.localNodeInfo?.nodeId,
      reason: 'TCP connection lost'
    }, this.sourceId);

    // Passive Mode (issue #3122): preserve cached node/config state so a brief
    // remote-initiated close on a large TCP node doesn't kick off another full
    // NodeDB resync. Virtual Node needs fresh replay data, so still clear the
    // init capture buffer when VN is enabled.
    for (const action of actions) {
      switch (action.kind) {
        case 'clearDeviceCaches':
          // Clear localNodeInfo so node will be marked as not responsive.
          // Clear device/module config cache on disconnect — ensures fresh
          // config is fetched on reconnect (prevents stale data after reboot).
          this.localNodeInfo = null;
          this.actualDeviceConfig = null;
          this.actualModuleConfig = null;
          logger.debug('📸 Cleared device and module config cache on disconnect');
          break;
        case 'clearConfigCapture':
          // Clear init config cache — will be repopulated on reconnect. This
          // ensures virtual node clients get fresh data if a different node
          // reconnects.
          this.initConfigCache = [];
          this.clearConfigCapture();
          logger.debug(this.passiveMode
            ? '📸 [passive] VN enabled — cleared init config cache, kept device/module config'
            : '📸 Cleared init config cache on disconnect');
          break;
        case 'preserveConfigCapture':
          this.preserveConfigCapture();
          logger.debug('📸 [passive] Preserved localNodeInfo + device/module/init config cache across disconnect');
          break;
        default:
          break;
      }
    }

    // Always invalidated on disconnect (all three branches) — keyed on the
    // live connection, not one of the two capture flags, so it isn't a named
    // SmAction (task42b_spec.md §2.2/§2.5).
    this.favoritesSupportCache = null;

    // Notify server event service of disconnection
    // Skip notification if this is a user-initiated disconnect (already notified in userDisconnect())
    if (!alreadyUserDisconnected) {
      await serverEventNotificationService.notifyNodeDisconnected(this.sourceId, await this.getSourceName());
    }

    // Only auto-reconnect if not in user-disconnected state
    if (alreadyUserDisconnected) {
      logger.debug('User-initiated disconnect active, skipping auto-reconnect');
    } else {
      // Transport will handle automatic reconnection
      logger.debug('Auto-reconnection will be attempted by transport');
    }

    // Cancel any pending config-complete fallback timer — a disconnect mid
    // ConfigSync must not let a stale timer fire schedulers later (#3962
    // Phase 4.2b C2 leak fix).
    this.cancelConfigCompleteFallbackTimer();
    this.assertStateConsistent();
  }

  private async createDefaultChannels(): Promise<void> {
    logger.debug('📡 Creating default channel configuration...');

    // Create default channel with ID 0 for messages that use channel 0
    // This is Meshtastic's default channel when no specific channel is configured
    try {
      const existingChannel0 = await databaseService.channels.getChannelById(0, this.sourceId);
      if (!existingChannel0) {
        // Manually insert channel with ID 0 since it might not come from device
        // Use upsertChannel to properly set role=PRIMARY (1)
        await databaseService.channels.upsertChannel({
          id: 0,
          name: 'Primary',
          role: 1  // PRIMARY
        }, this.sourceId);
        logger.debug('📡 Created Primary channel with ID 0 and role PRIMARY');
      }
    } catch (error) {
      logger.error('❌ Failed to create Primary channel:', error);
    }
  }

  /**
   * Persist (or clear) the per-source modem preset used as the slot-0
   * display-name fallback (`lora.preset.<sourceId>` → `computeChannelDisplayName`
   * / `unifiedChannelDisplayName`).
   *
   * Only persist when the node is ACTUALLY running on a preset
   * (`usePreset === true`). With a custom LoRa config (`usePreset === false`) the
   * `modemPreset` field is meaningless and sits at its proto3 default of 0
   * (= LONG_FAST), so persisting it would mislabel a blank-named primary channel
   * as "LongFast" even though the node isn't using that preset (#3644). In that
   * case delete any stale preset so slot 0 falls back to "Primary".
   *
   * `usePreset` is normalized to a real boolean by the proto3-defaults pass
   * before this runs (proto3 elides `false`).
   */
  private async persistModemPreset(lora: { usePreset?: boolean; modemPreset?: number } | undefined): Promise<void> {
    if (!this.sourceId || !lora) return;
    const presetKey = `lora.preset.${this.sourceId}`;
    try {
      if (lora.usePreset === true && typeof lora.modemPreset === 'number') {
        await databaseService.settings.setSetting(presetKey, String(lora.modemPreset));
      } else {
        await databaseService.settings.deleteSetting(presetKey);
      }
    } catch (err) {
      logger.debug(`Failed to persist ${presetKey}:`, err);
    }
  }

  private async ensureBasicSetup(): Promise<void> {
    logger.debug('🔧 Ensuring basic setup is complete...');

    // Ensure we have at least a Primary channel
    const channelCount = await databaseService.channels.getChannelCount(this.sourceId);
    if (channelCount === 0) {
      await this.createDefaultChannels();
    }

    // Note: Don't create fake nodes - they will be discovered naturally through mesh traffic
    logger.debug('✅ Basic setup ensured');
  }

  /**
   * Log an outgoing packet to the packet monitor
   * @param portnum The portnum (e.g., 1 for TEXT_MESSAGE, 6 for ADMIN, 70 for TRACEROUTE)
   * @param destination The destination node number
   * @param channel The channel number
   * @param payloadPreview Human-readable preview of what was sent
   * @param metadata Additional metadata object
   */
  // public: called by AdminTransactionService (#3962 Phase 4.2a PR4 §4d) in
  // addition to many unmoved call sites within this class — widened rather
  // than narrowly wrapped since it's general manager infrastructure, not
  // admin-ack-specific state.
  async logOutgoingPacket(
    portnum: number,
    destination: number,
    channel: number,
    payloadPreview: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (!await packetLogService.isEnabled()) return;

    const localNodeNum = this.localNodeInfo?.nodeNum;
    if (!localNodeNum) return;

    const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
    const toNodeId = destination === 0xffffffff
      ? 'broadcast'
      : `!${destination.toString(16).padStart(8, '0')}`;

    void packetLogService.logPacket({
      timestamp: Date.now(),
      from_node: localNodeNum,
      from_node_id: localNodeId,
      to_node: destination,
      to_node_id: toNodeId,
      channel: channel,
      portnum: portnum,
      portnum_name: meshtasticProtobufService.getPortNumName(portnum),
      encrypted: false,  // Outgoing packets are logged before encryption
      payload_preview: payloadPreview,
      metadata: JSON.stringify({ ...metadata, direction: 'tx' }),
      direction: 'tx',
      transport_mechanism: TransportMechanism.INTERNAL,  // Outgoing packets are sent via direct connection
      sourceId: this.sourceId,
    });
  }

  // public: called by NodeDbMaintenanceService.refreshNodeDatabase (#3962 Phase 4.2a PR2 §4f)
  async sendWantConfigId(): Promise<void> {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }

    try {
      logger.debug('Sending want_config_id to trigger configuration data...');

      // Use the new protobuf service to create a proper want_config_id message
      const wantConfigMessage = meshtasticProtobufService.createWantConfigRequest();

      await this.transport.send(wantConfigMessage);
      logger.debug('Successfully sent want_config_id request');
    } catch (error) {
      logger.error('Error sending want_config_id:', error);
      throw error;
    }
  }

  disconnect(): void {
    this.isConnected = false;
    // Cancel any pending config-complete fallback timer (#3962 Phase 4.2b C2
    // leak fix) — this method isn't routed through dispatch(), but it's
    // still an exit from ConfigSync/Connected and must not leave a stale
    // timer armed.
    this.cancelConfigCompleteFallbackTimer();

    if (this.transport) {
      this.transport.disconnect();
      this.transport = null;
    }

    if (this.tracerouteJitterTimeout) {
      clearTimeout(this.tracerouteJitterTimeout);
      this.tracerouteJitterTimeout = null;
    }

    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
    }

    if (this.remoteLocalStatsJitterTimeout) {
      clearTimeout(this.remoteLocalStatsJitterTimeout);
      this.remoteLocalStatsJitterTimeout = null;
    }

    if (this.remoteLocalStatsInterval) {
      clearInterval(this.remoteLocalStatsInterval);
      this.remoteLocalStatsInterval = null;
    }

    if (this.remoteAdminScannerInterval) {
      clearInterval(this.remoteAdminScannerInterval);
      this.remoteAdminScannerInterval = null;
    }

    if (this.timeSyncInterval) {
      clearInterval(this.timeSyncInterval);
      this.timeSyncInterval = null;
    }

    // Stop auto-delete-by-distance scheduler
    this.stopDistanceDeleteScheduler();

    // Stop announce scheduler (#3962 Phase 4.2a PR3 §5b — disconnect() used to
    // omit this; only userDisconnect() stopped it, so an unexpected disconnect
    // left the scheduler ticking, self-guarded but latent. handleConnected()
    // re-arms it via startAnnounceScheduler() on (re)connect, so stopping here
    // is safe.)
    this.autoAnnounceService.stop();

    // Stop LocalStats collection
    this.stopLocalStatsScheduler();

    // Stop time-offset telemetry collection
    this.stopTimeOffsetScheduler();
    this.timeOffsetSamples = [];

    // Clear per-packet dedup sets (no longer relevant after disconnect)
    this.autoAckProcessedPackets.clear();
    this.autoResponderProcessedPackets.clear();

    // Cancel any scheduled telemetry hijack auto-retries (issue #4210) — a retry
    // fired after disconnect would throw; drop the pending map too.
    for (const timer of this.telemetryRetryTimers) {
      clearTimeout(timer);
    }
    this.telemetryRetryTimers.clear();
    this.pendingTelemetryRequests.clear();

    logger.debug('Disconnected from Meshtastic node');
  }

  /**
   * Register a callback to be called when config capture is complete
   * This is used to initialize the virtual node server after connection is ready
   */
  public registerConfigCaptureCompleteCallback(callback: () => void): void {
    this.externalConfigCaptureCallback = callback;
  }

  private startTracerouteScheduler(): void {
    // Clear any pending jitter timeout to prevent leaked timers
    if (this.tracerouteJitterTimeout) {
      clearTimeout(this.tracerouteJitterTimeout);
      this.tracerouteJitterTimeout = null;
    }

    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
    }

    // If interval is 0, traceroute is disabled
    if (this.tracerouteIntervalMinutes === 0) {
      logger.debug('🗺️ Automatic traceroute is disabled');
      return;
    }

    const intervalMs = this.tracerouteIntervalMinutes * 60 * 1000;

    // Add random initial jitter (0 to min of interval or 5 minutes) to prevent network bursts
    // when multiple MeshMonitor instances start at similar times with the same interval.
    // Only the first execution is delayed; subsequent runs use the regular interval.
    const maxJitterMs = Math.min(intervalMs, 5 * 60 * 1000); // Cap at 5 minutes
    const initialJitterMs = Math.random() * maxJitterMs;
    const jitterSeconds = Math.round(initialJitterMs / 1000);

    logger.debug(`🗺️ Starting traceroute scheduler with ${this.tracerouteIntervalMinutes} minute interval (initial jitter: ${jitterSeconds}s)`);

    // The traceroute execution logic
    const executeTraceroute = async () => {
      // Check time window schedule (per-source — written by AutoTracerouteSection
      // via /api/settings?sourceId=, so must be read with getSettingForSource).
      const scheduleEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'tracerouteScheduleEnabled');
      if (scheduleEnabled === 'true') {
        const start = await databaseService.settings.getSettingForSource(this.sourceId, 'tracerouteScheduleStart') || '00:00';
        const end = await databaseService.settings.getSettingForSource(this.sourceId, 'tracerouteScheduleEnd') || '00:00';
        if (!isWithinTimeWindow(start, end)) {
          logger.debug(`🗺️ Auto-traceroute: Skipping - outside schedule window (${start}-${end})`);
          return;
        }
      }

      // Airtime cutoff: skip auto-traceroute while the mesh is congested
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      if (this.isConnected && this.localNodeInfo) {
        try {
          // Enforce minimum interval between traceroute sends (Meshtastic firmware rate limit)
          const timeSinceLastSend = Date.now() - this.lastTracerouteSentTime;
          if (this.lastTracerouteSentTime > 0 && timeSinceLastSend < MIN_TRACEROUTE_INTERVAL_MS) {
            logger.debug(`🗺️ Auto-traceroute: Skipping - only ${Math.round(timeSinceLastSend / 1000)}s since last send (minimum ${MIN_TRACEROUTE_INTERVAL_MS / 1000}s)`);
            return;
          }

          // Use async version which supports PostgreSQL/MySQL; scope to this source
          const targetNode = await databaseService.getNodeNeedingTracerouteAsync(this.localNodeInfo.nodeNum, this.sourceId);
          if (targetNode) {
            const channel = targetNode.channel ?? 0; // Use node's channel, default to 0
            const targetName = targetNode.longName || targetNode.nodeId;
            logger.debug(`🗺️ Auto-traceroute: Sending traceroute to ${targetName} (${targetNode.nodeId}) on channel ${channel}`);

            // Log the auto-traceroute attempt to database
            await databaseService.logAutoTracerouteAttemptAsync(targetNode.nodeNum, targetName, this.sourceId);
            this.pendingAutoTraceroutes.add(targetNode.nodeNum);
            this.pendingTracerouteTimestamps.set(targetNode.nodeNum, Date.now());

            this.lastTracerouteSentTime = Date.now();
            await this.sendTraceroute(targetNode.nodeNum, channel);

            // Check for timed-out traceroutes (> 5 minutes old)
            this.checkTracerouteTimeouts();
          } else {
            logger.debug('🗺️ Auto-traceroute: No nodes available for traceroute');
          }
        } catch (error) {
          logger.error('❌ Error in auto-traceroute:', error);
        }
      } else {
        logger.debug('🗺️ Auto-traceroute: Skipping - not connected or no local node info');
      }
    };

    // Delay first execution by jitter, then start regular interval
    this.tracerouteJitterTimeout = setTimeout(() => {
      this.tracerouteJitterTimeout = null;
      // Execute first traceroute
      executeTraceroute().catch(err => logger.error('Auto-traceroute scheduler error:', err));

      // Start regular interval (no jitter on subsequent runs)
      this.tracerouteInterval = setInterval(executeTraceroute, intervalMs);
    }, initialJitterMs);
  }

  /** Start this source's per-source auto-delete-by-distance scheduler (#3901).
   *
   * The DistanceDeleteScheduler is created lazily on the first call to break the
   * static import cycle:
   *   meshtasticManager → distanceDeleteScheduler → autoDeleteByDistanceService
   *   → resolveSourceManager → meshtasticManager
   * Subsequent calls re-arm the same instance (DistanceDeleteScheduler.start()
   * calls stop() internally before re-scheduling, so restarts are safe).
   */
  public async startDistanceDeleteScheduler(): Promise<void> {
    if (!this.distanceDeleteScheduler) {
      const { DistanceDeleteScheduler: Scheduler } = await import('./services/distanceDeleteScheduler.js');
      this.distanceDeleteScheduler = new Scheduler(this.sourceId);
    }
    await this.distanceDeleteScheduler.start();
  }

  /** Stop this source's per-source auto-delete-by-distance scheduler (#3901). */
  public stopDistanceDeleteScheduler(): void {
    this.distanceDeleteScheduler?.stop();
  }

  setTracerouteInterval(minutes: number): void {
    if (minutes < 0 || minutes > 60) {
      throw new Error('Traceroute interval must be between 0 and 60 minutes (0 = disabled)');
    }
    this.tracerouteIntervalMinutes = minutes;

    if (minutes === 0) {
      logger.debug('🗺️ Traceroute interval set to 0 (disabled)');
    } else {
      logger.debug(`🗺️ Traceroute interval updated to ${minutes} minutes`);
    }

    if (this.isConnected) {
      this.startTracerouteScheduler();
    }
  }

  /**
   * Update the remote LocalStats request interval (minutes; 0 = disabled) and
   * restart the scheduler if connected. Issue #3398.
   */
  setRemoteLocalStatsInterval(minutes: number): void {
    if (minutes < 0 || minutes > 1440) {
      throw new Error('Remote LocalStats interval must be between 0 and 1440 minutes (0 = disabled)');
    }
    this.remoteLocalStatsIntervalMinutes = minutes;
    logger.debug(
      minutes === 0
        ? '📊 Remote LocalStats interval set to 0 (disabled)'
        : `📊 Remote LocalStats interval updated to ${minutes} minutes`
    );
    if (this.isConnected) {
      this.startRemoteLocalStatsScheduler();
    }
  }

  /**
   * Start (or restart) the per-source remote LocalStats request scheduler.
   * Mirrors startTracerouteScheduler: per-source interval, startup jitter,
   * schedule-window + airtime gating, and a minimum-interval rate limit. Each
   * tick polls ONE target (the least-recently-polled match) to keep airtime use
   * low while still cycling through the whole matched set over time. Issue #3398.
   */
  private startRemoteLocalStatsScheduler(): void {
    if (this.remoteLocalStatsJitterTimeout) {
      clearTimeout(this.remoteLocalStatsJitterTimeout);
      this.remoteLocalStatsJitterTimeout = null;
    }
    if (this.remoteLocalStatsInterval) {
      clearInterval(this.remoteLocalStatsInterval);
      this.remoteLocalStatsInterval = null;
    }

    if (this.remoteLocalStatsIntervalMinutes === 0) {
      logger.debug('📊 Remote LocalStats automation is disabled');
      return;
    }

    const intervalMs = this.remoteLocalStatsIntervalMinutes * 60 * 1000;
    // Firmware doesn't rate-limit telemetry replies, so we self-limit: never send
    // two requests less than this apart (also guards against rapid restarts).
    const MIN_REMOTE_LOCALSTATS_INTERVAL_MS = 30 * 1000;

    const maxJitterMs = Math.min(intervalMs, 5 * 60 * 1000);
    const initialJitterMs = Math.random() * maxJitterMs;
    logger.debug(`📊 Starting remote LocalStats scheduler with ${this.remoteLocalStatsIntervalMinutes} minute interval (initial jitter: ${Math.round(initialJitterMs / 1000)}s)`);

    const executeRemoteLocalStats = async () => {
      // Per-source schedule window (written by AutoLocalStatsSection via
      // /api/settings?sourceId=, so read with getSettingForSource).
      const scheduleEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteLocalStatsScheduleEnabled');
      if (scheduleEnabled === 'true') {
        const start = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteLocalStatsScheduleStart') || '00:00';
        const end = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteLocalStatsScheduleEnd') || '00:00';
        if (!isWithinTimeWindow(start, end)) {
          logger.debug(`📊 Remote LocalStats: Skipping - outside schedule window (${start}-${end})`);
          return;
        }
      }

      // Skip while the mesh is congested.
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      if (!this.isConnected || !this.localNodeInfo) {
        logger.debug('📊 Remote LocalStats: Skipping - not connected or no local node info');
        return;
      }

      try {
        const timeSinceLastSend = Date.now() - this.lastRemoteLocalStatsSentTime;
        if (this.lastRemoteLocalStatsSentTime > 0 && timeSinceLastSend < MIN_REMOTE_LOCALSTATS_INTERVAL_MS) {
          logger.debug(`📊 Remote LocalStats: Skipping - only ${Math.round(timeSinceLastSend / 1000)}s since last send`);
          return;
        }

        const candidates = await databaseService.getNodesNeedingRemoteLocalStatsAsync(this.localNodeInfo.nodeNum, this.sourceId);
        if (candidates.length === 0) {
          logger.debug('📊 Remote LocalStats: No matching target nodes');
          return;
        }

        // Round-robin: pick the least-recently-polled candidate (never-polled = 0).
        let target = candidates[0];
        let oldest = this.remoteLocalStatsLastSentAt.get(Number(target.nodeNum)) ?? 0;
        for (const node of candidates) {
          const last = this.remoteLocalStatsLastSentAt.get(Number(node.nodeNum)) ?? 0;
          if (last < oldest) { oldest = last; target = node; }
        }

        const channel = target.channel ?? 0;
        // Size the hop limit to the node's observed distance (+2 margin); the
        // firmware default of 3 silently drops requests to farther nodes.
        const hopLimit = Math.min(7, (target.hopsAway ?? 1) + 2);
        const targetName = target.longName || target.nodeId;
        logger.debug(`📊 Remote LocalStats: Requesting local_stats from ${targetName} (${target.nodeId}) on channel ${channel}, hopLimit ${hopLimit}`);

        this.remoteLocalStatsLastSentAt.set(Number(target.nodeNum), Date.now());
        this.lastRemoteLocalStatsSentTime = Date.now();
        await this.requestRemoteLocalStats(target.nodeNum, channel, hopLimit);
      } catch (error) {
        logger.error('❌ Error in remote LocalStats automation:', error);
      }
    };

    this.remoteLocalStatsJitterTimeout = setTimeout(() => {
      this.remoteLocalStatsJitterTimeout = null;
      executeRemoteLocalStats().catch(err => logger.error('Remote LocalStats scheduler error:', err));
      this.remoteLocalStatsInterval = setInterval(executeRemoteLocalStats, intervalMs);
    }, initialJitterMs);
  }

  /**
   * Set the airtime cutoff threshold (percent Channel Utilization).
   * When the effective ChUtil exceeds this value, all transmitting automations
   * are paused. 0 disables the feature.
   * @param threshold Cutoff percent (0-100; 0 = disabled)
   */
  setAutomationAirtimeCutoffThreshold(threshold: number): void {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error('Airtime cutoff threshold must be between 0 and 100 (0 = disabled)');
    }
    this.automationAirtimeCutoffThreshold = threshold;
    if (threshold === 0) {
      logger.debug('📡 Airtime cutoff disabled (threshold 0)');
    } else {
      logger.debug(`📡 Airtime cutoff threshold set to ${threshold}% Channel Utilization`);
    }
  }

  /**
   * Set the airtime cutoff measurement source ('local' or 'neighbors').
   */
  setAutomationAirtimeCutoffSource(source: string): void {
    const normalized: AirtimeCutoffSource = source === 'neighbors' ? 'neighbors' : 'local';
    this.automationAirtimeCutoffSource = normalized;
    this.neighborUtilCache = null; // force a fresh computation on the next check
    logger.debug(`📡 Airtime cutoff source set to '${normalized}' for ${this.sourceId}`);
  }

  /**
   * Load the persisted airtime cutoff settings (threshold + source) for this
   * source. Falls back to defaults when unset or invalid.
   */
  private async loadAirtimeCutoffSettings(): Promise<void> {
    try {
      const saved = await databaseService.settings.getSettingForSource(this.sourceId, 'automationAirtimeCutoffThreshold');
      const parsed = saved != null ? parseInt(saved, 10) : NaN;
      this.automationAirtimeCutoffThreshold =
        Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_AIRTIME_CUTOFF_THRESHOLD;

      const savedSource = await databaseService.settings.getSettingForSource(this.sourceId, 'automationAirtimeCutoffSource');
      this.automationAirtimeCutoffSource = savedSource === 'neighbors' ? 'neighbors' : DEFAULT_AIRTIME_CUTOFF_SOURCE;
      this.neighborUtilCache = null;

      logger.debug(
        `📡 Airtime cutoff for ${this.sourceId}: ${this.automationAirtimeCutoffThreshold}% ` +
          `(source: ${this.automationAirtimeCutoffSource})` +
          (this.automationAirtimeCutoffThreshold === 0 ? ' (disabled)' : '')
      );
    } catch (error) {
      logger.error(`Failed to load airtime cutoff settings for ${this.sourceId}:`, error);
      this.automationAirtimeCutoffThreshold = DEFAULT_AIRTIME_CUTOFF_THRESHOLD;
      this.automationAirtimeCutoffSource = DEFAULT_AIRTIME_CUTOFF_SOURCE;
    }
  }

  /**
   * Compute the Channel Utilization the cutoff should compare against, honoring
   * the configured source. In 'neighbors' mode the value is the average ChUtil
   * of the strongest-RSSI 0-hop infrastructure neighbours, cached briefly so the
   * per-fire gate doesn't query the database on every automation.
   */
  private async getEffectiveChannelUtilization(): Promise<{ value: number | null; sampleCount: number; contributors: NeighborUtilContributor[] }> {
    if (this.automationAirtimeCutoffSource !== 'neighbors') {
      return {
        value: this.localChannelUtilization,
        sampleCount: this.localChannelUtilization == null ? 0 : 1,
        contributors: [],
      };
    }

    const now = Date.now();
    if (this.neighborUtilCache && now - this.neighborUtilCache.at < MeshtasticManager.NEIGHBOR_UTIL_TTL_MS) {
      return {
        value: this.neighborUtilCache.value,
        sampleCount: this.neighborUtilCache.sampleCount,
        contributors: this.neighborUtilCache.contributors,
      };
    }

    let result: { value: number | null; sampleCount: number; contributors: NeighborUtilContributor[] } = { value: null, sampleCount: 0, contributors: [] };
    try {
      const localNodeNum = this.localNodeInfo?.nodeNum;
      const nodes = await databaseService.nodes.getActiveNodes(1, this.sourceId);
      const candidates = nodes
        .filter((n: any) => Number(n.nodeNum) !== localNodeNum)
        .map((n: any) => ({
          nodeNum: n.nodeNum,
          nodeId: n.nodeId,
          longName: n.longName,
          shortName: n.shortName,
          role: n.role,
          hopsAway: n.hopsAway,
          rssi: n.rssi,
          channelUtilization: n.channelUtilization,
        }));
      result = averageStrongestNeighborUtilization(candidates, NEIGHBOR_UTIL_SAMPLE_COUNT);
    } catch (error) {
      logger.error(`Failed to compute neighbour airtime utilization for ${this.sourceId}:`, error);
    }

    this.neighborUtilCache = { value: result.value, sampleCount: result.sampleCount, contributors: result.contributors, at: now };
    return result;
  }

  /**
   * Whether automations are currently gated (paused) because the effective
   * Channel Utilization exceeds the configured cutoff threshold. Logs (throttled)
   * the first time gating engages. Fail-open: never gates when the feature is
   * disabled or no utilization reading is available.
   */
  async isAutomationAirtimeGated(): Promise<boolean> {
    const { value } = await this.getEffectiveChannelUtilization();
    const gated = shouldGateAutomations(value, this.automationAirtimeCutoffThreshold);
    if (gated) {
      const now = Date.now();
      if (now - this.lastAirtimeGateLogTime > 60000) {
        this.lastAirtimeGateLogTime = now;
        const sourceLabel = this.automationAirtimeCutoffSource === 'neighbors' ? 'neighbour-averaged' : 'local';
        logger.debug(
          `⏸️  Automations paused on ${this.sourceId}: ${sourceLabel} Channel Utilization ${value}% exceeds cutoff ${this.automationAirtimeCutoffThreshold}%`
        );
      }
    }
    return gated;
  }

  /**
   * Current airtime-cutoff status for this source: the configured threshold and
   * measurement source, the effective Channel Utilization (or null if unknown),
   * the number of neighbours sampled (neighbours mode), and whether automations
   * are currently gated. Used by the Automation page banner.
   */
  async getAirtimeCutoffStatus(): Promise<{
    threshold: number;
    source: AirtimeCutoffSource;
    channelUtilization: number | null;
    sampleCount: number;
    contributors: NeighborUtilContributor[];
    gated: boolean;
  }> {
    const { value, sampleCount, contributors } = await this.getEffectiveChannelUtilization();
    return {
      threshold: this.automationAirtimeCutoffThreshold,
      source: this.automationAirtimeCutoffSource,
      channelUtilization: value,
      sampleCount,
      contributors,
      gated: shouldGateAutomations(value, this.automationAirtimeCutoffThreshold),
    };
  }

  /**
   * Set the remote admin scanner interval
   * @param minutes Interval in minutes (0 = disabled, 1-60)
   */
  setRemoteAdminScannerInterval(minutes: number): void {
    if (minutes < 0 || minutes > 60) {
      throw new Error('Remote admin scanner interval must be between 0 and 60 minutes (0 = disabled)');
    }
    this.remoteAdminScannerIntervalMinutes = minutes;

    if (minutes === 0) {
      logger.debug('🔑 Remote admin scanner set to 0 (disabled)');
    } else {
      logger.debug(`🔑 Remote admin scanner interval updated to ${minutes} minutes`);
    }

    if (this.isConnected) {
      this.startRemoteAdminScanner().catch(err => logger.error('Error starting remote admin scanner:', err));
    }
  }

  /**
   * Start the remote admin scanner scheduler
   * Periodically checks nodes for remote admin capability
   */
  private async startRemoteAdminScanner(): Promise<void> {
    if (this.remoteAdminScannerInterval) {
      clearInterval(this.remoteAdminScannerInterval);
      this.remoteAdminScannerInterval = null;
    }

    // Load setting from database if not already set
    if (this.remoteAdminScannerIntervalMinutes === 0) {
      const savedInterval = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteAdminScannerIntervalMinutes');
      if (savedInterval) {
        this.remoteAdminScannerIntervalMinutes = parseInt(savedInterval, 10) || 0;
      }
    }

    // If interval is 0, scanner is disabled
    if (this.remoteAdminScannerIntervalMinutes === 0) {
      logger.debug('🔑 Remote admin scanner is disabled');
      return;
    }

    const intervalMs = this.remoteAdminScannerIntervalMinutes * 60 * 1000;
    logger.debug(`🔑 Starting remote admin scanner with ${this.remoteAdminScannerIntervalMinutes} minute interval`);

    this.remoteAdminScannerInterval = setInterval(async () => {
      // Check time window schedule
      const scheduleEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteAdminScheduleEnabled');
      if (scheduleEnabled === 'true') {
        const start = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteAdminScheduleStart') || '00:00';
        const end = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteAdminScheduleEnd') || '00:00';
        if (!isWithinTimeWindow(start, end)) {
          logger.debug(`🔑 Remote admin scanner: Skipping - outside schedule window (${start}-${end})`);
          return;
        }
      }

      // Airtime cutoff: skip remote admin scanning while the mesh is congested
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      if (this.isConnected && this.localNodeInfo) {
        try {
          await this.scanNextNodeForRemoteAdmin();
        } catch (error) {
          logger.error('❌ Error in remote admin scanner:', error);
        }
      } else {
        logger.debug('🔑 Remote admin scanner: Skipping - not connected or no local node info');
      }
    }, intervalMs);
  }

  /**
   * Set the auto time sync interval in minutes
   * @param minutes Interval in minutes (15-1440), 0 to disable
   */
  setTimeSyncInterval(minutes: number): void {
    if (minutes !== 0 && (minutes < 15 || minutes > 1440)) {
      throw new Error('Time sync interval must be 0 (disabled) or between 15 and 1440 minutes');
    }
    this.timeSyncIntervalMinutes = minutes;

    if (minutes === 0) {
      logger.debug('🕐 Time sync scheduler set to 0 (disabled)');
    } else {
      logger.debug(`🕐 Time sync scheduler interval updated to ${minutes} minutes`);
    }

    if (this.isConnected) {
      this.startTimeSyncScheduler().catch(err => {
        logger.error('Error starting time sync scheduler:', err);
      });
    }
  }

  /**
   * Start the automatic time sync scheduler
   */
  private async startTimeSyncScheduler(): Promise<void> {
    if (this.timeSyncInterval) {
      clearInterval(this.timeSyncInterval);
      this.timeSyncInterval = null;
    }

    // Per-source reads: when saved via /api/settings/time-sync-nodes?sourceId=,
    // these live at source:<id>:autoTimeSync* and fall back to global keys.
    const enabledStr = await databaseService.settings.getSettingForSource(this.sourceId, 'autoTimeSyncEnabled');
    const isEnabled = enabledStr === 'true';

    // Load settings from database if not already set
    if (this.timeSyncIntervalMinutes === 0) {
      if (isEnabled) {
        const intervalStr = await databaseService.settings.getSettingForSource(this.sourceId, 'autoTimeSyncIntervalMinutes');
        const parsed = intervalStr ? parseInt(intervalStr, 10) : NaN;
        this.timeSyncIntervalMinutes = isNaN(parsed) ? 15 : parsed;
      }
    }

    // If interval is 0 or time sync is disabled, scheduler is disabled
    if (this.timeSyncIntervalMinutes === 0 || !isEnabled) {
      logger.debug(`🕐 Time sync scheduler is disabled for source ${this.sourceId}`);
      return;
    }

    const intervalMs = this.timeSyncIntervalMinutes * 60 * 1000;
    logger.debug(`🕐 Starting time sync scheduler for source ${this.sourceId} with ${this.timeSyncIntervalMinutes} minute interval`);

    this.timeSyncInterval = setInterval(async () => {
      if (this.isConnected && this.localNodeInfo) {
        try {
          await this.syncNextNodeTime();
        } catch (error) {
          logger.error('❌ Error in time sync scheduler:', error);
        }
      } else {
        logger.debug('🕐 Time sync scheduler: Skipping - not connected or no local node info');
      }
    }, intervalMs);
  }

  /**
   * Sync the next eligible node's time
   */
  private async syncNextNodeTime(): Promise<void> {
    if (!this.localNodeInfo) {
      logger.debug('🕐 Time sync: No local node info');
      return;
    }

    // Airtime cutoff: skip time sync while the mesh is congested
    if (await this.isAutomationAirtimeGated()) {
      return;
    }

    const targetNode = await databaseService.getNodeNeedingTimeSyncAsync(this.sourceId);
    if (!targetNode) {
      logger.debug('🕐 Time sync: No nodes available for syncing');
      return;
    }

    // Skip if already being synced
    if (this.pendingTimeSyncs.has(targetNode.nodeNum)) {
      logger.debug(`🕐 Time sync: Node ${targetNode.nodeNum} already being synced`);
      return;
    }

    const targetName = targetNode.longName || targetNode.nodeId;
    logger.debug(`🕐 Time sync: Syncing time to ${targetName} (${targetNode.nodeId})`);

    this.pendingTimeSyncs.add(targetNode.nodeNum);

    try {
      await this.sendSetTimeCommand(targetNode.nodeNum);
      await databaseService.nodes.updateNodeTimeSyncAsync(targetNode.nodeNum, Date.now(), this.sourceId);
      logger.debug(`🕐 Time sync: Successfully synced time to ${targetName}`);
    } catch (error) {
      logger.error(`🕐 Time sync: Failed to sync time to ${targetName}:`, error);
    } finally {
      this.pendingTimeSyncs.delete(targetNode.nodeNum);
    }
  }

  /**
   * Scan the next eligible node for remote admin capability
   */
  private async scanNextNodeForRemoteAdmin(): Promise<void> {
    if (!this.localNodeInfo) {
      logger.debug('🔑 Remote admin scan: No local node info');
      return;
    }

    const targetNode = await databaseService.getNodeNeedingRemoteAdminCheckAsync(this.localNodeInfo.nodeNum, this.sourceId);
    if (!targetNode) {
      logger.debug('🔑 Remote admin scan: No nodes available for scanning');
      return;
    }

    // Skip if already being scanned
    if (this.pendingRemoteAdminScans.has(targetNode.nodeNum)) {
      logger.debug(`🔑 Remote admin scan: Node ${targetNode.nodeNum} already being scanned`);
      return;
    }

    const targetName = targetNode.longName || targetNode.nodeId;
    logger.debug(`🔑 Remote admin scan: Checking ${targetName} (${targetNode.nodeId}) for admin capability`);

    await this.scanNodeForRemoteAdmin(targetNode.nodeNum);
  }

  /**
   * Scan a specific node for remote admin capability
   * @param nodeNum The node number to scan
   * @returns Object with hasRemoteAdmin flag and metadata if successful
   */
  async scanNodeForRemoteAdmin(nodeNum: number): Promise<{ hasRemoteAdmin: boolean; metadata: any | null }> {
    // Track that we're scanning this node
    this.pendingRemoteAdminScans.add(nodeNum);

    try {
      // Try to get device metadata via admin
      const metadata = await this.requestRemoteDeviceMetadata(nodeNum);

      if (metadata) {
        // Success - node has remote admin capability
        logger.info(`🔑 Remote admin scan: Node ${nodeNum} has remote admin access`);
        await databaseService.updateNodeRemoteAdminStatusAsync(nodeNum, true, JSON.stringify(metadata), this.sourceId);
        return { hasRemoteAdmin: true, metadata };
      } else {
        // Timeout or failure - node doesn't have admin access (or is unreachable)
        logger.debug(`🔑 Remote admin scan: Node ${nodeNum} does not have remote admin access`);
        await databaseService.updateNodeRemoteAdminStatusAsync(nodeNum, false, null, this.sourceId);
        return { hasRemoteAdmin: false, metadata: null };
      }
    } catch (error) {
      // Error - likely no admin access
      logger.debug(`🔑 Remote admin scan: Node ${nodeNum} scan failed - no admin access`);
      logger.debug(`🔑 Remote admin scan error details:`, error);
      await databaseService.updateNodeRemoteAdminStatusAsync(nodeNum, false, null, this.sourceId);
      return { hasRemoteAdmin: false, metadata: null };
    } finally {
      this.pendingRemoteAdminScans.delete(nodeNum);
    }
  }

  /**
   * Start the auto key repair scheduler
   * Periodically checks for nodes with key mismatches and attempts to repair them
   */
  private startKeyRepairScheduler(): void {
    if (this.keyRepairInterval) {
      clearInterval(this.keyRepairInterval);
      this.keyRepairInterval = null;
    }

    // If disabled, don't start the scheduler
    if (!this.keyRepairEnabled) {
      logger.debug('🔐 Auto key repair is disabled');
      return;
    }

    const intervalMs = this.keyRepairIntervalMinutes * 60 * 1000;
    logger.debug(`🔐 Starting key repair scheduler with ${this.keyRepairIntervalMinutes} minute interval`);

    this.keyRepairInterval = setInterval(async () => {
      if (this.isConnected && this.localNodeInfo) {
        await this.processKeyRepairs();
      } else {
        logger.debug('🔐 Key repair: Skipping - not connected or no local node info');
      }
    }, intervalMs);
  }

  /**
   * Process pending key repairs for nodes with key mismatches
   */
  private async processKeyRepairs(): Promise<void> {
    if (this.rebootMergeInProgress) {
      logger.debug('🔐 Key repair: skipping - reboot merge in progress');
      return;
    }

    // Airtime cutoff: skip key repair (NodeInfo exchanges) while the mesh is congested
    if (await this.isAutomationAirtimeGated()) {
      return;
    }

    try {
      const nodesNeedingRepair = await databaseService.getNodesNeedingKeyRepairAsync();

      // Pre-fetch repair log for immediate purge skip check
      const recentRepairLog = this.keyRepairImmediatePurge ? await databaseService.getKeyRepairLogAsync(50) : [];

      for (const node of nodesNeedingRepair) {
        // When immediate purge is enabled, skip nodes whose most recent log action is 'purge'
        // Those nodes were already purged at detection time and await device sync resolution.
        if (this.keyRepairImmediatePurge) {
          const lastAction = recentRepairLog.find(e => e.nodeNum === node.nodeNum);
          if (lastAction?.action === 'purge') {
            logger.debug(`🔐 Key repair: skipping ${node.nodeNum} — already immediately purged, awaiting device sync`);
            continue;
          }
        }

        // Never attempt key repair on the local node
        if (this.localNodeInfo && node.nodeNum === this.localNodeInfo.nodeNum) {
          logger.debug(`🔐 Key repair: skipping local node ${node.nodeNum}`);
          continue;
        }

        // Skip ghost-suppressed nodes (recently merged/deleted after reboot)
        if (await databaseService.isNodeSuppressedAsync(node.nodeNum)) {
          logger.debug(`🔐 Key repair: skipping ghost-suppressed node ${node.nodeNum}`);
          continue;
        }

        const now = Date.now();
        const intervalMs = this.keyRepairIntervalMinutes * 60 * 1000;

        // Check if enough time has passed since last attempt
        if (node.lastAttemptTime && (now - node.lastAttemptTime) < intervalMs) {
          continue; // Skip - not enough time has passed
        }

        const nodeName = node.longName || node.shortName || node.nodeId;

        // Check if we've exhausted our attempts
        if (node.attemptCount >= this.keyRepairMaxExchanges) {
          logger.info(`🔐 Key repair: Node ${nodeName} exhausted ${this.keyRepairMaxExchanges} attempts`);

          if (this.keyRepairAutoPurge) {
            // Auto-purge the node from device database
            logger.info(`🔐 Key repair: Auto-purging node ${nodeName} from device database`);
            try {
              await this.sendRemoveNode(node.nodeNum);
              void databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'purge', true, null, null, this.sourceId);
              logger.info(`🔐 Key repair: Purged node ${nodeName}, sending final node info exchange`);

              // Send one more node info exchange after purge — use channel, not DM
              // (keys are mismatched so PKI-encrypted DMs would fail)
              const purgedNodeData = await databaseService.nodes.getNode(node.nodeNum);
              await this.sendNodeInfoRequest(node.nodeNum, purgedNodeData?.channel ?? 0);
              void databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'exchange', null, null, null, this.sourceId);
            } catch (error) {
              logger.error(`🔐 Key repair: Failed to purge node ${nodeName}:`, error);
              void databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'purge', false, null, null, this.sourceId);
            }
          }

          // Mark as exhausted
          await databaseService.setKeyRepairStateAsync(node.nodeNum, { exhausted: true });
          void databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'exhausted', null, null, null, this.sourceId);
          continue;
        }

        // Send node info exchange — use node's channel, not DM
        // (keys are mismatched so PKI-encrypted DMs would fail)
        const repairNodeData = await databaseService.nodes.getNode(node.nodeNum);
        const repairChannel = repairNodeData?.channel ?? 0;
        logger.debug(`🔐 Key repair: Sending node info exchange to ${nodeName} on channel ${repairChannel} (attempt ${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`);
        try {
          await this.sendNodeInfoRequest(node.nodeNum, repairChannel);

          // Update repair state
          await databaseService.setKeyRepairStateAsync(node.nodeNum, {
            attemptCount: node.attemptCount + 1,
            lastAttemptTime: now,
            startedAt: node.startedAt ?? now
          });

          void databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, `exchange (${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`, null, null, null, this.sourceId);
        } catch (error) {
          logger.error(`🔐 Key repair: Failed to send node info to ${nodeName}:`, error);
          void databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, `exchange (${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`, false, null, null, this.sourceId);
        }
      }
    } catch (error) {
      logger.error('🔐 Key repair: Error processing repairs:', error);
    }
  }

  /**
   * Configure auto key repair settings
   */
  setKeyRepairSettings(settings: {
    enabled?: boolean;
    intervalMinutes?: number;
    maxExchanges?: number;
    autoPurge?: boolean;
    immediatePurge?: boolean;
  }): void {
    if (settings.enabled !== undefined) {
      this.keyRepairEnabled = settings.enabled;
    }
    if (settings.intervalMinutes !== undefined) {
      if (settings.intervalMinutes < 1 || settings.intervalMinutes > 60) {
        throw new Error('Key repair interval must be between 1 and 60 minutes');
      }
      this.keyRepairIntervalMinutes = settings.intervalMinutes;
    }
    if (settings.maxExchanges !== undefined) {
      if (settings.maxExchanges < 1 || settings.maxExchanges > 10) {
        throw new Error('Max exchanges must be between 1 and 10');
      }
      this.keyRepairMaxExchanges = settings.maxExchanges;
    }
    if (settings.autoPurge !== undefined) {
      this.keyRepairAutoPurge = settings.autoPurge;
    }
    if (settings.immediatePurge !== undefined) {
      this.keyRepairImmediatePurge = settings.immediatePurge;
    }

    logger.debug(`🔐 Key repair settings updated: enabled=${this.keyRepairEnabled}, interval=${this.keyRepairIntervalMinutes}min, maxExchanges=${this.keyRepairMaxExchanges}, autoPurge=${this.keyRepairAutoPurge}, immediatePurge=${this.keyRepairImmediatePurge}`);

    // Restart scheduler if connected
    if (this.isConnected) {
      this.startKeyRepairScheduler();
    }
  }

  /**
   * Start periodic LocalStats collection from the local node
   * Requests LocalStats at the configured interval to track mesh health metrics
   */
  private startLocalStatsScheduler(): void {
    if (this.localStatsInterval) {
      clearInterval(this.localStatsInterval);
      this.localStatsInterval = null;
    }

    // If interval is 0, collection is disabled
    if (this.localStatsIntervalMinutes === 0) {
      logger.debug('📊 LocalStats collection is disabled');
      return;
    }

    const intervalMs = this.localStatsIntervalMinutes * 60 * 1000;
    logger.debug(`📊 Starting LocalStats scheduler with ${this.localStatsIntervalMinutes} minute interval`);

    // Delay the first request by 30 seconds to let the node settle after connect
    setTimeout(() => {
      if (this.isConnected && this.localNodeInfo) {
        this.requestLocalStats().catch(error => {
          logger.error('❌ Error requesting initial LocalStats:', error);
        });
        this.saveSystemNodeMetrics().catch(error => {
          logger.error('❌ Error saving initial system node metrics:', error);
        });
      }
    }, 30000);

    this.localStatsInterval = setInterval(async () => {
      if (this.isConnected && this.localNodeInfo) {
        try {
          await this.requestLocalStats();
          // Save MeshMonitor's system node metrics alongside LocalStats
          await this.saveSystemNodeMetrics();
        } catch (error) {
          logger.error('❌ Error in auto-LocalStats collection:', error);
        }
      } else {
        logger.debug('📊 Auto-LocalStats: Skipping - not connected or no local node info');
      }
    }, intervalMs);
  }

  /**
   * Stop LocalStats collection scheduler
   */
  private stopLocalStatsScheduler(): void {
    if (this.localStatsInterval) {
      clearInterval(this.localStatsInterval);
      this.localStatsInterval = null;
      logger.debug('📊 LocalStats scheduler stopped');
    }
  }

  private startTimeOffsetScheduler(): void {
    if (this.timeOffsetInterval) {
      clearInterval(this.timeOffsetInterval);
      this.timeOffsetInterval = null;
    }

    const intervalMs = 5 * 60 * 1000; // 5 minutes
    logger.debug('⏱️ Starting time-offset scheduler (5-minute interval)');

    this.timeOffsetInterval = setInterval(async () => {
      await this.flushTimeOffsetTelemetry();
    }, intervalMs);
  }

  private stopTimeOffsetScheduler(): void {
    if (this.timeOffsetInterval) {
      clearInterval(this.timeOffsetInterval);
      this.timeOffsetInterval = null;
      logger.debug('⏱️ Time-offset scheduler stopped');
    }
  }

  private async flushTimeOffsetTelemetry(): Promise<void> {
    if (this.timeOffsetSamples.length === 0 || !this.localNodeInfo) {
      return;
    }

    const sum = this.timeOffsetSamples.reduce((a, b) => a + b, 0);
    const avg = sum / this.timeOffsetSamples.length;
    const sampleCount = this.timeOffsetSamples.length;
    this.timeOffsetSamples = [];

    const now = Date.now();
    try {
      await databaseService.insertTelemetryAsync({
        nodeId: this.localNodeInfo.nodeId,
        nodeNum: this.localNodeInfo.nodeNum,
        telemetryType: 'timeOffset',
        timestamp: now,
        value: Math.round(avg * 100) / 100,
        unit: 's',
        createdAt: now,
      }, this.sourceId);
      logger.debug(`⏱️ Saved time-offset telemetry: avg=${avg.toFixed(2)}s (${sampleCount} samples)`);
    } catch (error) {
      logger.error('❌ Error saving time-offset telemetry:', error);
    }
  }

  /**
   * Set LocalStats collection interval
   */
  setLocalStatsInterval(minutes: number): void {
    if (minutes < 0 || minutes > 60) {
      throw new Error('LocalStats interval must be between 0 and 60 minutes (0 = disabled)');
    }
    this.localStatsIntervalMinutes = minutes;

    if (minutes === 0) {
      logger.debug('📊 LocalStats interval set to 0 (disabled)');
    } else {
      logger.debug(`📊 LocalStats interval updated to ${minutes} minutes`);
    }

    // Restart scheduler with new interval if connected
    if (this.isConnected) {
      this.startLocalStatsScheduler();
    }
  }

  /**
   * Save MeshMonitor's system node metrics as telemetry
   * This allows graphing the system's active node count over time
   */
  private async saveSystemNodeMetrics(): Promise<void> {
    if (!this.localNodeInfo?.nodeId || !this.localNodeInfo?.nodeNum) {
      logger.debug('📊 Cannot save system node metrics: no local node info');
      return;
    }

    try {
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      // Scope to this source so systemNodeCount telemetry reflects only nodes visible
      // to this manager, not a cross-source union.
      const nodes = await databaseService.nodes.getActiveNodes(maxNodeAgeDays, this.sourceId);
      const nodeCount = nodes.length;
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      const now = Date.now();

      // Save as telemetry so it can be graphed over time
      await databaseService.insertTelemetryAsync({
        nodeId: this.localNodeInfo.nodeId,
        nodeNum: this.localNodeInfo.nodeNum,
        telemetryType: 'systemNodeCount',
        timestamp: now,
        value: nodeCount,
        createdAt: now,
      }, this.sourceId);
      await databaseService.insertTelemetryAsync({
        nodeId: this.localNodeInfo.nodeId,
        nodeNum: this.localNodeInfo.nodeNum,
        telemetryType: 'systemDirectNodeCount',
        timestamp: now,
        value: directCount,
        createdAt: now,
      }, this.sourceId);

      logger.debug(`📊 Saved system node metrics: ${nodeCount} active nodes, ${directCount} direct nodes`);
    } catch (error) {
      logger.error('❌ Error saving system node metrics:', error);
    }
  }

  /**
   * Thin delegate — arming logic lives in `AutoAnnounceService`
   * (#3962 Phase 4.2a PR3 §4b).
   */
  private async startAnnounceScheduler(): Promise<void> {
    return this.autoAnnounceService.startAnnounceScheduler();
  }

  /** Thin delegate — see `AutoAnnounceService.setAnnounceInterval`. */
  setAnnounceInterval(hours: number): void {
    this.autoAnnounceService.setAnnounceInterval(hours);
  }

  /** Thin delegate — see `AutoAnnounceService.restartAnnounceScheduler`. */
  restartAnnounceScheduler(): void {
    this.autoAnnounceService.restartAnnounceScheduler();
  }

  /**
   * Start timer trigger schedulers based on saved settings
   */
  private async startTimerScheduler(): Promise<void> {
    // Stop all existing timer cron jobs
    this.timerCronJobs.forEach((job, id) => {
      job.stop();
      logger.debug(`⏱️ Stopped timer cron job: ${id}`);
    });
    this.timerCronJobs.clear();

    // Load timer triggers from settings
    const timerTriggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'timerTriggers');
    if (!timerTriggersJson) {
      logger.debug('⏱️ No timer triggers configured');
      return;
    }

    let timerTriggers: Array<{
      id: string;
      name: string;
      cronExpression: string;
      responseType?: 'script' | 'text'; // 'script' (default) or 'text' message
      scriptPath?: string; // Path to script in /data/scripts/ (when responseType is 'script')
      scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
      response?: string; // Text message with expansion tokens (when responseType is 'text')
      channel?: number; // Channel index (0-7) to send output to
      enabled: boolean;
      lastRun?: number;
      lastResult?: 'success' | 'error';
      lastError?: string;
    }>;

    try {
      timerTriggers = JSON.parse(timerTriggersJson);
    } catch (e) {
      logger.error('⏱️ Failed to parse timerTriggers setting:', e);
      return;
    }

    // Auto-assign IDs to triggers missing them
    for (let i = 0; i < timerTriggers.length; i++) {
      if (!timerTriggers[i].id) {
        timerTriggers[i].id = `timer-${i}`;
      }
    }

    // Schedule each enabled timer
    for (const trigger of timerTriggers) {
      if (!trigger.enabled) {
        logger.debug(`⏱️ Timer "${trigger.name}" is disabled, skipping`);
        continue;
      }

      // Validate cron expression
      if (!validateCron(trigger.cronExpression)) {
        logger.error(`⏱️ Invalid cron expression for timer "${trigger.name}": ${trigger.cronExpression}`);
        continue;
      }

      // Schedule the cron job
      const job = scheduleCron(trigger.cronExpression, async () => {
        logger.debug(`⏱️ Timer "${trigger.name}" triggered (cron: ${trigger.cronExpression})`);
        // Airtime cutoff: skip timer automations while the mesh is congested
        if (await this.isAutomationAirtimeGated()) {
          return;
        }
        const responseType = trigger.responseType || 'script'; // Default to script for backward compatibility
        if (responseType === 'text' && trigger.response?.trim()) {
          await this.executeTimerTextMessage(trigger.id, trigger.name, trigger.response, trigger.channel ?? 0);
        } else if (trigger.scriptPath) {
          await this.executeTimerScript(trigger.id, trigger.name, trigger.scriptPath, trigger.channel ?? 0, trigger.scriptArgs);
        } else {
          logger.error(`⏱️ Timer "${trigger.name}" has no valid response configured`);
          await this.updateTimerTriggerResult(trigger.id, 'error', 'No response configured');
        }
      });

      this.timerCronJobs.set(trigger.id, job);
      logger.debug(`⏱️ Scheduled timer "${trigger.name}" with cron: ${trigger.cronExpression}`);
    }

    logger.debug(`⏱️ Timer scheduler started with ${this.timerCronJobs.size} active timer(s)`);
  }

  /**
   * Restart timer scheduler (called when settings change)
   */
  restartTimerScheduler(): void {
    logger.debug('⏱️ Restarting timer scheduler due to settings change');
    this.startTimerScheduler().catch(err => logger.error('Error restarting timer scheduler:', err));
  }

  // ─── Geofence Engine ───────────────────────────────────────────────────

  /**
   * Initialize the geofence engine. Loads triggers from settings,
   * computes initial inside/outside state from current node positions
   * (without firing events), and sets up "while inside" interval timers.
   */
  private async initGeofenceEngine(): Promise<void> {
    // Clear existing state and timers
    this.geofenceWhileInsideTimers.forEach(timer => clearInterval(timer));
    this.geofenceWhileInsideTimers.clear();
    this.geofenceNodeState.clear();

    // Load persisted cooldowns from database (async, populate in background)
    this.loadGeofenceCooldowns();

    const triggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'geofenceTriggers');
    if (!triggersJson) {
      logger.debug('📍 No geofence triggers configured');
      return;
    }

    let triggers: GeofenceTriggerConfig[];
    try {
      triggers = JSON.parse(triggersJson);
    } catch (e) {
      logger.error('📍 Failed to parse geofenceTriggers setting:', e);
      return;
    }

    // Auto-assign IDs to triggers missing them (prevents shared state when id is undefined)
    for (let i = 0; i < triggers.length; i++) {
      if (!triggers[i].id) {
        triggers[i].id = `geofence-${i}`;
      }
    }

    const enabledTriggers = triggers.filter(t => t.enabled);
    if (enabledTriggers.length === 0) {
      logger.debug('📍 No enabled geofence triggers');
      return;
    }

    // Compute initial state from current node positions (no events fired).
    // Scope to this manager's source so a two-source deployment doesn't mix node
    // positions from a different mesh into this geofence engine's state.
    // Use effective position so a user-set override is what the geofence engine
    // tests against (issue #2847).
    const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
    for (const trigger of enabledTriggers) {
      const insideSet = new Set<number>();
      for (const node of allNodes) {
        const eff = getEffectiveDbNodePosition(node);
        if (eff.latitude == null || eff.longitude == null) continue;
        const nodeNum = Number(node.nodeNum);

        // Check node filter
        if (trigger.nodeFilter.type === 'selected' &&
            !trigger.nodeFilter.nodeNums.includes(nodeNum)) {
          continue;
        }

        if (isPointInGeofence(eff.latitude, eff.longitude, trigger.shape)) {
          insideSet.add(nodeNum);
        }
      }
      this.geofenceNodeState.set(trigger.id, insideSet);
      logger.debug(`📍 Geofence "${trigger.name}": ${insideSet.size} node(s) initially inside`);

      // Set up "while inside" interval timer
      if (trigger.event === 'while_inside' && trigger.whileInsideIntervalMinutes && trigger.whileInsideIntervalMinutes >= 1) {
        const intervalMs = trigger.whileInsideIntervalMinutes * 60 * 1000;
        const timer = setInterval(() => {
          this.executeWhileInsideGeofenceTrigger(trigger).catch(err => logger.error(`Error executing while-inside geofence trigger "${trigger.name}":`, err));
        }, intervalMs);
        this.geofenceWhileInsideTimers.set(trigger.id, timer);
        logger.debug(`📍 Geofence "${trigger.name}": while_inside timer set for every ${trigger.whileInsideIntervalMinutes} minute(s)`);
      }
    }

    logger.debug(`📍 Geofence engine started with ${enabledTriggers.length} active trigger(s)`);
  }

  /**
   * Check if a geofence trigger is still in cooldown for a specific node.
   * Uses in-memory map for fast synchronous lookups.
   * Returns true if the trigger should be suppressed.
   */
  private isGeofenceCooldownActive(triggerId: string, nodeNum: number, cooldownMinutes?: number): boolean {
    if (!cooldownMinutes || cooldownMinutes <= 0) return false;

    const key = `${triggerId}:${nodeNum}`;
    const firedAt = this.geofenceCooldowns.get(key);
    if (firedAt === undefined) return false;

    const cooldownMs = cooldownMinutes * 60 * 1000;
    return (Date.now() - firedAt) < cooldownMs;
  }

  /**
   * Load persisted geofence cooldowns from the database into the in-memory map.
   */
  private loadGeofenceCooldowns(): void {
    databaseService.getAllGeofenceCooldownsAsync().then((rows) => {
      for (const row of rows) {
        const key = `${row.triggerId}:${row.nodeNum}`;
        this.geofenceCooldowns.set(key, row.firedAt);
      }
      if (rows.length > 0) {
        logger.debug(`📍 Loaded ${rows.length} geofence cooldown entries from database`);
      }
    }).catch((error) => {
      logger.warn('📍 Failed to load geofence cooldowns from database:', error);
    });
  }

  /**
   * Record a geofence cooldown timestamp for a specific trigger+node pair.
   * Updates both in-memory map and database for persistence across restarts.
   */
  private recordGeofenceCooldown(triggerId: string, nodeNum: number): void {
    const now = Date.now();
    const key = `${triggerId}:${nodeNum}`;
    this.geofenceCooldowns.set(key, now);

    // Persist to database asynchronously (fire and forget)
    databaseService.setGeofenceCooldownAsync(triggerId, nodeNum, now).catch((error) => {
      logger.warn(`📍 Failed to persist geofence cooldown for trigger ${triggerId}, node ${nodeNum}:`, error);
    });
  }

  /**
   * Check all geofence triggers for a node that just reported a new position.
   * Fires entry/exit events based on state transitions.
   */
  private async checkGeofencesForNode(nodeNum: number, lat: number, lng: number): Promise<void> {
    const triggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'geofenceTriggers');
    if (!triggersJson) return;

    let triggers: GeofenceTriggerConfig[];
    try {
      triggers = JSON.parse(triggersJson);
    } catch {
      return;
    }

    for (const trigger of triggers) {
      if (!trigger.enabled) continue;

      // Check node filter
      if (trigger.nodeFilter.type === 'selected' &&
          !trigger.nodeFilter.nodeNums.includes(nodeNum)) {
        continue;
      }

      const isInside = isPointInGeofence(lat, lng, trigger.shape);
      const stateSet = this.geofenceNodeState.get(trigger.id) || new Set<number>();
      const wasInside = stateSet.has(nodeNum);

      if (isInside && !wasInside) {
        // Node entered geofence
        stateSet.add(nodeNum);
        this.geofenceNodeState.set(trigger.id, stateSet);
        if (trigger.event === 'entry' || trigger.event === 'while_inside') {
          if (!this.isGeofenceCooldownActive(trigger.id, nodeNum, trigger.cooldownMinutes)) {
            logger.debug(`📍 Geofence "${trigger.name}": node ${nodeNum} entered`);
            void this.executeGeofenceTrigger(trigger, nodeNum, lat, lng, 'entry');
          } else {
            logger.debug(`📍 Geofence "${trigger.name}": cooldown active for node ${nodeNum}, skipping entry`);
          }
        }
      } else if (!isInside && wasInside) {
        // Node exited geofence
        stateSet.delete(nodeNum);
        this.geofenceNodeState.set(trigger.id, stateSet);
        if (trigger.event === 'exit') {
          if (!this.isGeofenceCooldownActive(trigger.id, nodeNum, trigger.cooldownMinutes)) {
            logger.debug(`📍 Geofence "${trigger.name}": node ${nodeNum} exited`);
            void this.executeGeofenceTrigger(trigger, nodeNum, lat, lng, 'exit');
          } else {
            logger.debug(`📍 Geofence "${trigger.name}": cooldown active for node ${nodeNum}, skipping exit`);
          }
        }
      }
      // If isInside && wasInside — no state change, while_inside handled by timer
      // If !isInside && !wasInside — no state change
    }
  }

  /**
   * Execute a geofence trigger for a specific node and event.
   */
  private async executeGeofenceTrigger(
    trigger: GeofenceTriggerConfig,
    nodeNum: number,
    lat: number,
    lng: number,
    eventType: 'entry' | 'exit' | 'while_inside'
  ): Promise<void> {
    try {
      // Airtime cutoff: skip geofence automations while the mesh is congested
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      if (trigger.responseType === 'text' && trigger.response?.trim()) {
        const expanded = await this.replaceGeofenceTokens(trigger.response, trigger, nodeNum, lat, lng, eventType);
        const truncated = this.truncateMessageForMeshtastic(expanded, 200);

        const isDM = trigger.channel === 'dm';
        // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
        const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
        logger.debug(`📍 Geofence "${trigger.name}" sending text to ${isDM ? `DM (node ${nodeNum})` : `channel ${trigger.channel}`}${trigger.verifyResponse ? ' (with verification)' : ''}`);
        this.messageQueue.enqueue(
          truncated,
          isDM ? nodeNum : 0,
          undefined,
          () => logger.debug(`✅ Geofence "${trigger.name}" message delivered to ${isDM ? `DM (node ${nodeNum})` : `channel ${trigger.channel}`}`),
          (reason: string) => logger.warn(`❌ Geofence "${trigger.name}" message failed: ${reason}`),
          isDM ? undefined : trigger.channel as number,
          maxAttempts
        );

        await this.updateGeofenceTriggerResult(trigger.id, 'success');
        this.recordGeofenceCooldown(trigger.id, nodeNum);
      } else if (trigger.responseType === 'script' && trigger.scriptPath) {
        await this.executeGeofenceScript(trigger, nodeNum, lat, lng, eventType);
        this.recordGeofenceCooldown(trigger.id, nodeNum);
      } else {
        logger.error(`📍 Geofence "${trigger.name}" has no valid response configured`);
        await this.updateGeofenceTriggerResult(trigger.id, 'error', 'No response configured');
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      logger.error(`📍 Geofence "${trigger.name}" trigger failed: ${errorMessage}`);
      await this.updateGeofenceTriggerResult(trigger.id, 'error', errorMessage);
    }
  }

  /**
   * Execute a geofence trigger script.
   */
  private async executeGeofenceScript(
    trigger: GeofenceTriggerConfig,
    nodeNum: number,
    lat: number,
    lng: number,
    eventType: string
  ): Promise<void> {
    const scriptPath = trigger.scriptPath!;

    // Validate script path
    if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
      logger.error(`📍 Invalid script path for geofence "${trigger.name}": ${scriptPath}`);
      await this.updateGeofenceTriggerResult(trigger.id, 'error', 'Invalid script path');
      return;
    }

    const resolvedPath = this.resolveScriptPath(scriptPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      logger.error(`📍 Script file not found for geofence "${trigger.name}": ${scriptPath}`);
      await this.updateGeofenceTriggerResult(trigger.id, 'error', 'Script file not found');
      return;
    }

    const ext = scriptPath.split('.').pop()?.toLowerCase();
    let interpreter: string;
    const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';

    switch (ext) {
      case 'js': case 'mjs': interpreter = useSystemBin ? 'node' : '/usr/local/bin/node'; break;
      case 'py': interpreter = useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3'; break;
      case 'sh': interpreter = useSystemBin ? 'sh' : '/bin/sh'; break;
      default:
        await this.updateGeofenceTriggerResult(trigger.id, 'error', `Unsupported script extension: ${ext}`);
        return;
    }

    const startTime = Date.now();
    logger.debug(`📍 Executing geofence script: "${trigger.name}" (${eventType}) -> ${scriptPath}`);

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const node = await databaseService.nodes.getNode(nodeNum, this.sourceId);
      const dist = distanceToGeofenceCenter(lat, lng, trigger.shape);
      const config = await this.getScriptConnectionConfig();

      const scriptEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        GEOFENCE_NAME: trigger.name,
        GEOFENCE_ID: trigger.id,
        GEOFENCE_EVENT: eventType,
        NODE_NUM: String(nodeNum),
        NODE_ID: nodeId,
        NODE_LAT: String(lat),
        NODE_LON: String(lng),
        DISTANCE_TO_CENTER: dist.toFixed(2),
        MESHTASTIC_IP: config.nodeIp,
        MESHTASTIC_PORT: String(config.tcpPort),
      };

      if (node?.longName) scriptEnv.NODE_LONG_NAME = node.longName;
      if (node?.shortName) scriptEnv.NODE_SHORT_NAME = node.shortName;

      // Add MeshMonitor node location
      const localNodeInfo = this.getLocalNodeInfo();
      if (localNodeInfo) {
        const mmNode = await databaseService.nodes.getNode(localNodeInfo.nodeNum, this.sourceId);
        if (mmNode?.latitude != null && mmNode?.longitude != null) {
          scriptEnv.MM_LAT = String(mmNode.latitude);
          scriptEnv.MM_LON = String(mmNode.longitude);
        }
      }

      // Expand tokens in script args if provided
      let scriptArgsList: string[] = [];
      if (trigger.scriptArgs) {
        const expandedArgs = await this.replaceGeofenceTokens(
          trigger.scriptArgs, trigger, nodeNum, lat, lng, eventType
        );
        scriptArgsList = this.parseScriptArgs(expandedArgs);
        logger.debug(`📍 Geofence script args expanded: ${trigger.scriptArgs} -> ${JSON.stringify(scriptArgsList)}`);
      }

      const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath, ...scriptArgsList], {
        timeout: 30000,
        env: { ...scriptEnv, ...scriptDependencyEnv(ext, scriptEnv) },
        maxBuffer: 1024 * 1024,
      });

      if (stderr) logger.warn(`📍 Geofence script "${trigger.name}" stderr: ${stderr}`);

      // Parse JSON output and send messages (same format as timer scripts)
      if (stdout && stdout.trim()) {
        let scriptOutput;
        try {
          scriptOutput = JSON.parse(stdout.trim());
        } catch {
          await this.updateGeofenceTriggerResult(trigger.id, 'success');
          return;
        }

        let scriptResponses: string[];
        if (scriptOutput.responses && Array.isArray(scriptOutput.responses)) {
          scriptResponses = scriptOutput.responses.filter((r: any) => typeof r === 'string');
        } else if (scriptOutput.response && typeof scriptOutput.response === 'string') {
          scriptResponses = [scriptOutput.response];
        } else {
          await this.updateGeofenceTriggerResult(trigger.id, 'success');
          return;
        }

        // Skip sending if channel is 'none' (script handles its own output)
        if (trigger.channel !== 'none') {
          const isDM = trigger.channel === 'dm';
          // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
          const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
          for (const resp of scriptResponses) {
            const truncated = this.truncateMessageForMeshtastic(resp, 200);
            this.messageQueue.enqueue(
              truncated,
              isDM ? nodeNum : 0,
              undefined,
              () => logger.debug(`✅ Geofence "${trigger.name}" script response delivered`),
              (reason: string) => logger.warn(`❌ Geofence "${trigger.name}" script response failed: ${reason}`),
              isDM ? undefined : trigger.channel as number,
              maxAttempts
            );
          }
        } else {
          logger.debug(`📍 Geofence "${trigger.name}" script executed (channel=none, no mesh output)`);
        }
      }

      const duration = Date.now() - startTime;
      logger.debug(`📍 Geofence "${trigger.name}" script completed successfully in ${duration}ms`);
      await this.updateGeofenceTriggerResult(trigger.id, 'success');
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || 'Unknown error';
      logger.error(`📍 Geofence "${trigger.name}" script failed after ${duration}ms: ${errorMessage}`);
      if (error.stderr) logger.error(`📍 Geofence script stderr: ${error.stderr}`);
      if (error.stdout) logger.warn(`📍 Geofence script stdout before failure: ${error.stdout.substring(0, 200)}`);
      await this.updateGeofenceTriggerResult(trigger.id, 'error', errorMessage);
    }
  }

  /**
   * Called by interval timer for "while inside" geofence triggers.
   * Iterates nodes currently in the geofence and fires the trigger for each.
   */
  private async executeWhileInsideGeofenceTrigger(trigger: GeofenceTriggerConfig): Promise<void> {
    const stateSet = this.geofenceNodeState.get(trigger.id);
    if (!stateSet || stateSet.size === 0) return;

    for (const nodeNum of stateSet) {
      const node = await databaseService.nodes.getNode(nodeNum, this.sourceId);
      // Honor a user-set override so the geofence reads the same coordinates
      // surfaced everywhere else (issue #2847).
      const eff = getEffectiveDbNodePosition(node);
      if (!node || eff.latitude == null || eff.longitude == null) continue;

      // Re-validate position is still inside
      if (!isPointInGeofence(eff.latitude, eff.longitude, trigger.shape)) {
        stateSet.delete(nodeNum);
        logger.debug(`📍 Geofence "${trigger.name}": node ${nodeNum} no longer inside (stale position)`);
        continue;
      }

      if (this.isGeofenceCooldownActive(trigger.id, nodeNum, trigger.cooldownMinutes)) {
        logger.debug(`📍 Geofence "${trigger.name}": cooldown active for node ${nodeNum}, skipping while_inside`);
        continue;
      }

      logger.debug(`📍 Geofence "${trigger.name}": while_inside tick for node ${nodeNum}`);
      void this.executeGeofenceTrigger(trigger, nodeNum, eff.latitude, eff.longitude, 'while_inside');
    }
  }

  /**
   * Replace geofence-specific tokens in a message template.
   */
  private async replaceGeofenceTokens(
    message: string,
    trigger: GeofenceTriggerConfig,
    nodeNum: number,
    lat: number,
    lng: number,
    eventType: string
  ): Promise<string> {
    // Start with standard announcement tokens
    let result = await this.replaceAnnouncementTokens(message);

    const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
    const node = await databaseService.nodes.getNode(nodeNum, this.sourceId);
    const dist = distanceToGeofenceCenter(lat, lng, trigger.shape);

    const config = await this.getConfig();

    result = result.replace(/{GEOFENCE_NAME}/g, trigger.name);
    result = result.replace(/{NODE_LAT}/g, String(lat));
    result = result.replace(/{NODE_LON}/g, String(lng));
    result = result.replace(/{NODE_ID}/g, nodeId);
    result = result.replace(/{NODE_NUM}/g, String(nodeNum));
    result = result.replace(/{LONG_NAME}/g, node?.longName || nodeId);
    result = result.replace(/{SHORT_NAME}/g, node?.shortName || nodeId);
    result = result.replace(/{DISTANCE_TO_CENTER}/g, dist.toFixed(2));
    result = result.replace(/{EVENT}/g, eventType);
    result = result.replace(/{IP}/g, config.nodeIp);

    return result;
  }

  /**
   * Update the result/status of a geofence trigger in settings.
   */
  private async updateGeofenceTriggerResult(triggerId: string, result: 'success' | 'error', errorMessage?: string): Promise<void> {
    try {
      const triggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'geofenceTriggers');
      if (!triggersJson) return;

      const triggers = JSON.parse(triggersJson);
      const trigger = triggers.find((t: any) => t.id === triggerId);

      if (trigger) {
        trigger.lastRun = Date.now();
        trigger.lastResult = result;
        if (result === 'error' && errorMessage) {
          trigger.lastError = errorMessage;
        } else {
          delete trigger.lastError;
        }

        await databaseService.settings.setSetting('geofenceTriggers', JSON.stringify(triggers));
        logger.debug(`📍 Updated geofence trigger ${triggerId} result: ${result}`);
      }
    } catch (e) {
      logger.error('📍 Failed to update geofence trigger result:', e);
    }
  }

  /**
   * Restart the geofence engine (called when settings change).
   */
  restartGeofenceEngine(): void {
    logger.debug('📍 Restarting geofence engine due to settings change');
    this.initGeofenceEngine().catch(err => logger.error('Error restarting geofence engine:', err));
  }

  /**
   * Execute a timer trigger script and send output to specified channel
   */
  private async executeTimerScript(triggerId: string, triggerName: string, scriptPath: string, channel: number | 'none', scriptArgs?: string): Promise<void> {
    const startTime = Date.now();

    // Validate script path
    if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
      logger.error(`⏱️ Invalid script path for timer "${triggerName}": ${scriptPath}`);
      await this.updateTimerTriggerResult(triggerId, 'error', 'Invalid script path');
      return;
    }

    // Resolve script path
    const resolvedPath = this.resolveScriptPath(scriptPath);
    if (!resolvedPath) {
      logger.error(`⏱️ Failed to resolve script path for timer "${triggerName}": ${scriptPath}`);
      await this.updateTimerTriggerResult(triggerId, 'error', 'Failed to resolve script path');
      return;
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      logger.error(`⏱️ Script file not found for timer "${triggerName}": ${resolvedPath}`);
      await this.updateTimerTriggerResult(triggerId, 'error', 'Script file not found');
      return;
    }

    logger.debug(`⏱️ Executing timer script: ${scriptPath} -> ${resolvedPath}`);

    // Determine interpreter based on file extension
    const ext = scriptPath.split('.').pop()?.toLowerCase();
    let interpreter: string;
    const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';

    switch (ext) {
      case 'js':
      case 'mjs':
        interpreter = useSystemBin ? 'node' : '/usr/local/bin/node';
        break;
      case 'py':
        interpreter = useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3';
        break;
      case 'sh':
        interpreter = useSystemBin ? 'sh' : '/bin/sh';
        break;
      default:
        logger.error(`⏱️ Unsupported script extension for timer "${triggerName}": ${ext}`);
        await this.updateTimerTriggerResult(triggerId, 'error', `Unsupported script extension: ${ext}`);
        return;
    }

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      // Prepare environment variables for timer scripts
      const config = await this.getScriptConnectionConfig();
      const scriptEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        TIMER_NAME: triggerName,
        TIMER_ID: triggerId,
        TIMER_SCRIPT: scriptPath,
        MESHTASTIC_IP: config.nodeIp,
        MESHTASTIC_PORT: String(config.tcpPort),
      };

      // Add MeshMonitor node location if available
      const localNodeInfo = this.getLocalNodeInfo();
      if (localNodeInfo) {
        const mmNode = await databaseService.nodes.getNode(localNodeInfo.nodeNum, this.sourceId);
        if (mmNode?.latitude != null && mmNode?.longitude != null) {
          scriptEnv.MM_LAT = String(mmNode.latitude);
          scriptEnv.MM_LON = String(mmNode.longitude);
        }
      }

      // Expand tokens in script args if provided
      let scriptArgsList: string[] = [];
      if (scriptArgs) {
        const expandedArgs = await this.replaceAnnouncementTokens(scriptArgs);
        scriptArgsList = this.parseScriptArgs(expandedArgs);
        logger.debug(`⏱️ Timer script args expanded: ${scriptArgs} -> ${JSON.stringify(scriptArgsList)}`);
      }

      // Execute script with 30-second timeout (longer than auto-responder for scheduled tasks)
      const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath, ...scriptArgsList], {
        timeout: 30000,
        env: { ...scriptEnv, ...scriptDependencyEnv(ext, scriptEnv) },
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      if (stderr) {
        logger.warn(`⏱️ Timer script "${triggerName}" stderr: ${stderr}`);
      }

      const duration = Date.now() - startTime;
      logger.debug(`⏱️ Timer "${triggerName}" completed successfully in ${duration}ms`);

      // Parse JSON output and send messages to channel
      if (stdout && stdout.trim()) {
        logger.debug(`⏱️ Timer script stdout: ${stdout.substring(0, 200)}${stdout.length > 200 ? '...' : ''}`);

        // Try to parse as JSON (same format as Auto-Responder scripts)
        let scriptOutput;
        try {
          scriptOutput = JSON.parse(stdout.trim());
        } catch (parseError) {
          logger.debug(`⏱️ Timer script output is not JSON, ignoring: ${stdout.substring(0, 100)}`);
          await this.updateTimerTriggerResult(triggerId, 'success');
          return;
        }

        // Support both single response and multiple responses
        let scriptResponses: string[];
        if (scriptOutput.responses && Array.isArray(scriptOutput.responses)) {
          // Multiple responses format: { "responses": ["msg1", "msg2", "msg3"] }
          scriptResponses = scriptOutput.responses.filter((r: any) => typeof r === 'string');
          if (scriptResponses.length === 0) {
            logger.warn(`⏱️ Timer script 'responses' array contains no valid strings`);
            await this.updateTimerTriggerResult(triggerId, 'success');
            return;
          }
          logger.debug(`⏱️ Timer script returned ${scriptResponses.length} responses`);
        } else if (scriptOutput.response && typeof scriptOutput.response === 'string') {
          // Single response format: { "response": "msg" }
          scriptResponses = [scriptOutput.response];
          logger.debug(`⏱️ Timer script response: ${scriptOutput.response.substring(0, 50)}...`);
        } else {
          logger.debug(`⏱️ Timer script output has no 'response' or 'responses' field, ignoring`);
          await this.updateTimerTriggerResult(triggerId, 'success');
          return;
        }

        // Skip sending if channel is 'none' (script handles its own output)
        if (channel !== 'none') {
          // Send each response to the specified channel
          logger.debug(`⏱️ Enqueueing ${scriptResponses.length} timer response(s) to channel ${channel}`);

          scriptResponses.forEach((resp, index) => {
            const truncated = this.truncateMessageForMeshtastic(resp, 200);

            this.messageQueue.enqueue(
              truncated,
              0, // destination: 0 for channel broadcast
              undefined, // no reply-to packet ID for timer messages
              () => {
                logger.debug(`✅ Timer response ${index + 1}/${scriptResponses.length} delivered to channel ${channel}`);
              },
              (reason: string) => {
                logger.warn(`❌ Timer response ${index + 1}/${scriptResponses.length} failed to channel ${channel}: ${reason}`);
              },
              channel // channel number
            );
          });
        } else {
          logger.debug(`⏱️ Timer "${triggerName}" script executed (channel=none, no mesh output)`);
        }
      }

      await this.updateTimerTriggerResult(triggerId, 'success');

    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || 'Unknown error';
      logger.error(`⏱️ Timer "${triggerName}" failed after ${duration}ms: ${errorMessage}`);
      if (error.stderr) logger.error(`⏱️ Timer script stderr: ${error.stderr}`);
      if (error.stdout) logger.warn(`⏱️ Timer script stdout before failure: ${error.stdout.substring(0, 200)}`);
      await this.updateTimerTriggerResult(triggerId, 'error', errorMessage);
    }
  }

  /**
   * Execute a timer trigger text message and send to specified channel
   * Uses the same token expansion as auto-announce
   */
  private async executeTimerTextMessage(triggerId: string, triggerName: string, message: string, channel: number): Promise<void> {
    try {
      logger.debug(`⏱️ Executing timer text message: "${triggerName}"`);

      // Replace tokens using the same method as auto-announce
      const expandedMessage = await this.replaceAnnouncementTokens(message);
      const truncated = this.truncateMessageForMeshtastic(expandedMessage, 200);

      logger.debug(`⏱️ Timer "${triggerName}" sending to channel ${channel}: ${truncated.substring(0, 50)}${truncated.length > 50 ? '...' : ''}`);

      this.messageQueue.enqueue(
        truncated,
        0, // destination: 0 for channel broadcast
        undefined, // no reply-to packet ID for timer messages
        () => {
          logger.debug(`✅ Timer "${triggerName}" message delivered to channel ${channel}`);
        },
        (reason: string) => {
          logger.warn(`❌ Timer "${triggerName}" message failed to channel ${channel}: ${reason}`);
        },
        channel // channel number
      );

      await this.updateTimerTriggerResult(triggerId, 'success');

    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      logger.error(`⏱️ Timer "${triggerName}" text message failed: ${errorMessage}`);
      await this.updateTimerTriggerResult(triggerId, 'error', errorMessage);
    }
  }

  /**
   * Update timer trigger result in settings
   */
  private async updateTimerTriggerResult(triggerId: string, result: 'success' | 'error', errorMessage?: string): Promise<void> {
    try {
      const timerTriggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'timerTriggers');
      if (!timerTriggersJson) return;

      const timerTriggers = JSON.parse(timerTriggersJson);
      const trigger = timerTriggers.find((t: any) => t.id === triggerId);

      if (trigger) {
        trigger.lastRun = Date.now();
        trigger.lastResult = result;
        if (result === 'error' && errorMessage) {
          trigger.lastError = errorMessage;
        } else {
          delete trigger.lastError;
        }

        // Write back to the SAME per-source key we read from above. Using the
        // un-namespaced global setter here (the original bug) copied this
        // source's trigger list into the global `timerTriggers` key on every
        // fire; that global value then bled into other sources via the settings
        // GET-merge, so a timer configured for one source ran on all of them.
        // getSettingForSource / setSourceSetting deliberately do NOT fall back
        // to global (see #2839), so read and write must both be source-scoped.
        await databaseService.settings.setSourceSetting(this.sourceId, 'timerTriggers', JSON.stringify(timerTriggers));
        logger.debug(`⏱️ Updated timer trigger ${triggerId} result: ${result}`);
      }
    } catch (e) {
      logger.error('⏱️ Failed to update timer trigger result:', e);
    }
  }

  /**
   * Acquire a slot in the packet-processing semaphore. Resolves immediately
   * if capacity is available; otherwise queues until a prior handler finishes.
   * Pairs with releasePacketSlot() in a try/finally — see processIncomingData.
   */
  private acquirePacketSlot(): Promise<void> {
    if (this.packetActiveCount < this.packetConcurrencyLimit) {
      this.packetActiveCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.packetWaiters.push(() => {
        this.packetActiveCount++;
        resolve();
      });
    });
  }

  private releasePacketSlot(): void {
    this.packetActiveCount--;
    const next = this.packetWaiters.shift();
    if (next) next();
  }

  public async processIncomingData(data: Uint8Array, context?: ProcessingContext): Promise<void> {
    await this.acquirePacketSlot();
    try {
      await this._processIncomingDataImpl(data, context);
    } finally {
      this.releasePacketSlot();
    }
  }

  private async _processIncomingDataImpl(data: Uint8Array, context?: ProcessingContext): Promise<void> {
    try {
      if (data.length === 0) {
        return;
      }

      logger.debug(`📦 Processing single FromRadio message (${data.length} bytes)...`);

      // Parse the message to determine its type before deciding whether to broadcast.
      // We parse first so we can filter out 'channel' type messages from the broadcast.
      const parsed = meshtasticProtobufService.parseIncomingData(data);

      // Broadcast to virtual node clients if virtual node server is enabled (unless explicitly skipped).
      // Skip broadcasting 'channel' and 'configComplete' type FromRadio messages — these should
      // only reach clients through the controlled sendInitialConfig() flow.
      // - 'channel': Broadcasting raw FromRadio.channel messages during physical node reconnection
      //   causes Android/iOS clients to receive unsolicited channel updates with empty name fields,
      //   which the Meshtastic app displays as placeholder text "Channel Name" (fixes #1567).
      // - 'configComplete': Broadcasting raw configComplete during physical node reconnection or
      //   refreshNodeDatabase() causes clients to receive an unsolicited end-of-config signal.
      //   Since no channels preceded it (they're filtered above), the Meshtastic app interprets
      //   this as "config done with zero channels" and clears its channel list.
      // If parsing failed, still broadcast the raw data (clients may understand it even if
      // the server can't parse it).
      const shouldBroadcast = !context?.skipVirtualNodeBroadcast &&
        (!parsed || (parsed.type !== 'channel' && parsed.type !== 'configComplete'));
      if (shouldBroadcast) {
        const virtualNodeServer = this.virtualNodeServer;
        if (virtualNodeServer) {
          try {
            await virtualNodeServer.broadcastToClients(data);
            logger.debug(`📡 Broadcasted ${parsed?.type || 'unparsed'} to virtual node clients (${data.length} bytes)`);
          } catch (error) {
            logger.error('Virtual node: Failed to broadcast message to clients:', error);
          }
        }
      }

      if (!parsed) {
        logger.warn('⚠️ Failed to parse message');
        return;
      }

      logger.debug(`📦 Parsed message type: ${parsed.type}`);

      // Capture raw message bytes with type metadata if we're in capture mode (after parsing to get type)
      if (this.isCapturingInitConfig && !this.configCaptureComplete) {
        // Store a copy of the raw message bytes along with the message type
        const messageCopy = new Uint8Array(data);
        this.initConfigCache.push({ type: parsed.type, data: messageCopy });
        logger.debug(`📸 Captured init message #${this.initConfigCache.length} (type: ${parsed.type}, ${data.length} bytes)`);
      }

      // Process the message
      switch (parsed.type) {
        case 'fromRadio':
          logger.debug('⚠️ Generic FromRadio message (no specific field set)');
          break;
        case 'mqttClientProxyMessage':
          await this.handleDeviceMqttProxyMessage(parsed.data);
          break;
        case 'clientNotification':
          await this.handleClientNotification(parsed.data as ParsedClientNotification);
          break;
        case 'meshPacket':
          await this.processMeshPacket(parsed.data, context);
          break;
        case 'myInfo':
          await this.processMyNodeInfo(parsed.data);
          break;
        case 'nodeInfo':
          await this.processNodeInfoProtobuf(parsed.data);
          break;
        case 'metadata':
          await this.processDeviceMetadata(parsed.data);
          break;
        case 'config':
          logger.debug('⚙️ Received Config with keys:', Object.keys(parsed.data));
          logger.debug('⚙️ Received Config:', JSON.stringify(parsed.data, null, 2));

          // Proto3 omits fields with default values (false for bool, 0 for numeric)
          // We need to ensure these fields exist with proper defaults
          if (parsed.data.lora) {
            logger.debug(`📊 Raw LoRa config from device:`, JSON.stringify(parsed.data.lora, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.lora.usePreset === undefined) {
              parsed.data.lora.usePreset = false;
              logger.debug('📊 Set usePreset to false (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.sx126xRxBoostedGain === undefined) {
              parsed.data.lora.sx126xRxBoostedGain = false;
              logger.debug('📊 Set sx126xRxBoostedGain to false (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.ignoreMqtt === undefined) {
              parsed.data.lora.ignoreMqtt = false;
              logger.debug('📊 Set ignoreMqtt to false (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.configOkToMqtt === undefined) {
              parsed.data.lora.configOkToMqtt = false;
              logger.debug('📊 Set configOkToMqtt to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.lora.frequencyOffset === undefined) {
              parsed.data.lora.frequencyOffset = 0;
              logger.debug('📊 Set frequencyOffset to 0 (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.overrideFrequency === undefined) {
              parsed.data.lora.overrideFrequency = 0;
              logger.debug('📊 Set overrideFrequency to 0 (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.modemPreset === undefined) {
              parsed.data.lora.modemPreset = 0;
              logger.debug('📊 Set modemPreset to 0 (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.channelNum === undefined) {
              parsed.data.lora.channelNum = 0;
              logger.debug('📊 Set channelNum to 0 (was undefined - Proto3 default)');
            }
            // femLnaMode (FEM_LNA_Mode enum) — zero value DISABLED is a real mode, so
            // proto3 elision must default to 0, NOT to a non-zero fallback (see #3594).
            if (parsed.data.lora.femLnaMode === undefined) {
              parsed.data.lora.femLnaMode = 0;
              logger.debug('📊 Set femLnaMode to 0 (DISABLED - was undefined, Proto3 default)');
            }

            // Persist the per-source modem preset used as the slot-0
            // display-name fallback — only when the node actually runs on a
            // preset. See persistModemPreset (#3644).
            await this.persistModemPreset(parsed.data.lora);
          }

          // Apply Proto3 defaults to device config
          if (parsed.data.device) {
            logger.debug(`📊 Raw Device config from device:`, JSON.stringify(parsed.data.device, null, 2));

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.device.nodeInfoBroadcastSecs === undefined) {
              parsed.data.device.nodeInfoBroadcastSecs = 0;
              logger.debug('📊 Set nodeInfoBroadcastSecs to 0 (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to position config
          if (parsed.data.position) {
            logger.debug(`📊 Raw Position config from device:`, JSON.stringify(parsed.data.position, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.position.positionBroadcastSmartEnabled === undefined) {
              parsed.data.position.positionBroadcastSmartEnabled = false;
              logger.debug('📊 Set positionBroadcastSmartEnabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.position.fixedPosition === undefined) {
              parsed.data.position.fixedPosition = false;
              logger.debug('📊 Set fixedPosition to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.position.positionBroadcastSecs === undefined) {
              parsed.data.position.positionBroadcastSecs = 0;
              logger.debug('📊 Set positionBroadcastSecs to 0 (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to position config
          if (parsed.data.position) {
            logger.debug(`📊 Raw Position config from device:`, JSON.stringify(parsed.data.position, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.position.positionBroadcastSmartEnabled === undefined) {
              parsed.data.position.positionBroadcastSmartEnabled = false;
              logger.debug('📊 Set positionBroadcastSmartEnabled to false (was undefined - Proto3 default)');
            }

            if (parsed.data.position.fixedPosition === undefined) {
              parsed.data.position.fixedPosition = false;
              logger.debug('📊 Set fixedPosition to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.position.positionBroadcastSecs === undefined) {
              parsed.data.position.positionBroadcastSecs = 0;
              logger.debug('📊 Set positionBroadcastSecs to 0 (was undefined - Proto3 default)');
            }

            logger.debug(`📊 Position config after Proto3 defaults: positionBroadcastSecs=${parsed.data.position.positionBroadcastSecs}, positionBroadcastSmartEnabled=${parsed.data.position.positionBroadcastSmartEnabled}, fixedPosition=${parsed.data.position.fixedPosition}`);
          }

          // Merge the actual device configuration (don't overwrite).
          // Block-scoped (no-case-declarations): this `case` clause has no
          // braces of its own, so `const` here needs an explicit block.
          {
            const prevTxEnabled = this.actualDeviceConfig?.lora?.txEnabled !== false;
            this.actualDeviceConfig = { ...this.actualDeviceConfig, ...parsed.data };
            const nextTxEnabled = this.actualDeviceConfig?.lora?.txEnabled !== false;
            if (prevTxEnabled !== nextTxEnabled) {
              logger.info(nextTxEnabled
                ? `📡 [${this.sourceId}] TX re-enabled — autonomous senders resume`
                : `🚫 [${this.sourceId}] TX disabled — pausing autonomous senders (node is now receive-only)`);
            }
          }
          logger.debug('📊 Merged actualDeviceConfig now has keys:', Object.keys(this.actualDeviceConfig));
          logger.debug('📊 actualDeviceConfig.lora present:', !!this.actualDeviceConfig?.lora);
          if (parsed.data.lora) {
            logger.debug(`📊 Received LoRa config - hopLimit=${parsed.data.lora.hopLimit}, usePreset=${this.actualDeviceConfig.lora.usePreset}, frequencyOffset=${this.actualDeviceConfig.lora.frequencyOffset}`);
          }
          logger.debug(`📊 Current actualDeviceConfig.lora.hopLimit=${this.actualDeviceConfig?.lora?.hopLimit}`);
          logger.debug('📊 Merged actualDeviceConfig now has:', Object.keys(this.actualDeviceConfig));

          // Extract local node's public key from security config and save to database
          if (parsed.data.security && parsed.data.security.publicKey) {
            const publicKeyBytes = parsed.data.security.publicKey;
            if (publicKeyBytes && publicKeyBytes.length > 0) {
              const publicKeyBase64 = Buffer.from(publicKeyBytes).toString('base64');
              logger.debug(`🔐 Received local node public key from security config: ${publicKeyBase64.substring(0, 20)}...`);

              // Get local node info to update database
              const localNodeNum = this.localNodeInfo?.nodeNum;
              const localNodeId = this.localNodeInfo?.nodeId;
              if (localNodeNum && localNodeId) {
                // Import and check for low-entropy key
                import('../services/lowEntropyKeyService.js').then(async ({ checkLowEntropyKey }) => {
                  const isLowEntropy = checkLowEntropyKey(publicKeyBase64, 'base64');
                  const updateData: any = {
                    nodeNum: localNodeNum,
                    nodeId: localNodeId,
                    publicKey: publicKeyBase64,
                    hasPKC: true
                  };

                  if (isLowEntropy) {
                    updateData.keyIsLowEntropy = true;
                    updateData.keySecurityIssueDetails = 'Known low-entropy key detected - this key is compromised and should be regenerated';
                    logger.warn(`⚠️ Low-entropy key detected for local node ${localNodeId}!`);
                  } else {
                    updateData.keyIsLowEntropy = false;
                    updateData.keySecurityIssueDetails = null;
                  }

                  await databaseService.upsertNodeAsync(updateData, this.sourceId);
                  logger.debug(`💾 Saved local node public key to database for ${localNodeId}`);
                }).catch(async (err) => {
                  // If low entropy check fails, still save the key
                  await databaseService.upsertNodeAsync({
                    nodeNum: localNodeNum,
                    nodeId: localNodeId,
                    publicKey: publicKeyBase64,
                    hasPKC: true
                  }, this.sourceId);
                  logger.warn(`⚠️ Could not check low-entropy key status:`, err);
                  logger.debug(`💾 Saved local node public key to database for ${localNodeId}`);
                });
              } else {
                logger.warn(`⚠️ Received security config with public key but local node info not yet available`);
              }
            }
          }
          break;
        case 'moduleConfig':
          logger.debug('⚙️ Received Module Config with keys:', Object.keys(parsed.data));
          logger.debug('⚙️ Received Module Config:', JSON.stringify(parsed.data, null, 2));

          // Apply Proto3 defaults to MQTT config
          if (parsed.data.mqtt) {
            logger.debug(`📊 Raw MQTT config from device:`, JSON.stringify(parsed.data.mqtt, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.mqtt.enabled === undefined) {
              parsed.data.mqtt.enabled = false;
              logger.debug('📊 Set mqtt.enabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.mqtt.encryptionEnabled === undefined) {
              parsed.data.mqtt.encryptionEnabled = false;
              logger.debug('📊 Set mqtt.encryptionEnabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.mqtt.jsonEnabled === undefined) {
              parsed.data.mqtt.jsonEnabled = false;
              logger.debug('📊 Set mqtt.jsonEnabled to false (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to NeighborInfo config
          if (parsed.data.neighborInfo) {
            logger.debug(`📊 Raw NeighborInfo config from device:`, JSON.stringify(parsed.data.neighborInfo, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.neighborInfo.enabled === undefined) {
              parsed.data.neighborInfo.enabled = false;
              logger.debug('📊 Set neighborInfo.enabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.neighborInfo.transmitOverLora === undefined) {
              parsed.data.neighborInfo.transmitOverLora = false;
              logger.debug('📊 Set neighborInfo.transmitOverLora to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.neighborInfo.updateInterval === undefined) {
              parsed.data.neighborInfo.updateInterval = 0;
              logger.debug('📊 Set neighborInfo.updateInterval to 0 (was undefined - Proto3 default)');
            }
          }

          // Merge the actual module configuration (don't overwrite)
          this.actualModuleConfig = { ...this.actualModuleConfig, ...parsed.data };
          logger.debug('📊 Merged actualModuleConfig now has keys:', Object.keys(this.actualModuleConfig));
          break;
        case 'channel':
          await this.processChannelProtobuf(parsed.data);
          break;
        case 'configComplete':
          logger.debug('✅ Config complete received, ID:', parsed.data.configCompleteId);

          // configComplete is direct evidence the local device just finished talking to us —
          // refresh its lastHeard so freshness filters (e.g., neighbor-info) don't treat a
          // quiet-but-connected local node as stale (#3025). Best-effort: silently swallow
          // errors so a DB hiccup never blocks config-capture completion.
          if (this.localNodeInfo?.nodeNum) {
            const localNodeNum = this.localNodeInfo.nodeNum;
            const localNodeId = this.localNodeInfo.nodeId;
            try {
              await databaseService.upsertNodeAsync({
                nodeNum: localNodeNum,
                nodeId: localNodeId,
                lastHeard: Date.now() / 1000,
              }, this.sourceId);
            } catch (err) {
              logger.debug('⚠️ Could not refresh local node lastHeard on configComplete:', err);
            }
          }

          // Stop capturing init messages.
          // #3962 Phase 4.2b C2: CONFIG_COMPLETE — ConfigSync -> Connected.
          // Out-of-scope guard (task42b_spec.md §9): this dispatch case fires
          // the CONFIG_COMPLETE event into the SM, but its body (lastHeard
          // refresh above, #2425 migration, callback) is unchanged.
          if (this.isCapturingInitConfig && !this.configCaptureComplete) {
            const { next, actions } = dispatch(this.#state, 'CONFIG_COMPLETE', this.buildSmContext());
            this.#state = next;
            logger.debug(`📸 Init config capture complete! Captured ${this.initConfigCache.length} messages for virtual node replay`);

            for (const action of actions) {
              switch (action.kind) {
                case 'completeConfigCapture':
                  this.completeConfigCapture();
                  break;
                case 'detectChannelMigration':
                  // Detect channel moves/swaps from external sources (#2425)
                  await this.detectAndMigrateChannelChanges();
                  break;
                case 'clearManualResync':
                  this.clearManualResyncInFlight(action.reason);
                  break;
                case 'runOnConfigCaptureComplete':
                  // Call registered callback if present
                  if (this.onConfigCaptureComplete) {
                    try {
                      this.onConfigCaptureComplete();
                    } catch (error) {
                      logger.error('❌ Error in config capture complete callback:', error);
                    }
                  }
                  break;
                case 'cancelFallbackTimer':
                  this.cancelConfigCompleteFallbackTimer();
                  break;
                default:
                  break;
              }
            }
            this.assertStateConsistent();
          }
          break;
        default:
          logger.debug(`⚠️ Unhandled message type: ${parsed.type}`);
          break;
      }

      logger.debug(`✅ Processed message type: ${parsed.type}`);
    } catch (error) {
      logger.error('❌ Error processing incoming data:', error);
    }
  }


  /**
   * Process MyNodeInfo protobuf message
   */
  /**
   * Decode Meshtastic minAppVersion to version string
   * Format is Mmmss where M = 1 + major version
   * Example: 30200 = 2.2.0 (M=3 -> major=2, mm=02, ss=00)
   */
  private decodeMinAppVersion(minAppVersion: number): string {
    const versionStr = minAppVersion.toString().padStart(5, '0');
    const major = parseInt(versionStr[0]) - 1;
    const minor = parseInt(versionStr.substring(1, 3));
    const patch = parseInt(versionStr.substring(3, 5));
    return `${major}.${minor}.${patch}`;
  }

  /**
   * Initialize localNodeInfo from database when MyNodeInfo wasn't received
   */
  private async initializeLocalNodeInfoFromDatabase(): Promise<void> {
    try {
      logger.debug('📱 Checking for local node info in database...');

      // Try to load previously saved local node info from settings
      // Check scoped key first, then legacy global key (backward compat for existing sessions)
      let savedNodeNum = await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeNum'));
      let savedNodeId = await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeId'));
      if (!savedNodeNum || !savedNodeId) {
        savedNodeNum = await databaseService.settings.getSetting('localNodeNum');
        savedNodeId = await databaseService.settings.getSetting('localNodeId');
      }

      if (savedNodeNum && savedNodeId) {
        const nodeNum = parseInt(savedNodeNum);
        logger.debug(`📱 Found saved local node info: ${savedNodeId} (${nodeNum})`);

        // Try to get full node info from database. Scope to this manager's own
        // sourceId so we pick the right row in multi-source deployments — node
        // rows with the same nodeNum exist for every source since migration 029
        // made (nodeNum, sourceId) the composite PK, and a source-agnostic
        // lookup may return a stale row whose firmwareVersion is NULL.
        const node = await databaseService.nodes.getNode(nodeNum, this.sourceId);
        if (node) {
          this.localNodeInfo = {
            nodeNum: nodeNum,
            nodeId: savedNodeId,
            longName: node.longName || 'Unknown',
            shortName: node.shortName || 'UNK',
            hwModel: node.hwModel || undefined,
            firmwareVersion: (node as any).firmwareVersion || null,
            rebootCount: (node as any).rebootCount !== undefined ? (node as any).rebootCount : undefined,
            isLocked: false // Allow updates if MyNodeInfo arrives later
          } as any;
          logger.debug(`✅ Restored local node info from settings: ${savedNodeId}, rebootCount: ${(node as any).rebootCount}`);
        } else {
          // Create minimal local node info
          this.localNodeInfo = {
            nodeNum: nodeNum,
            nodeId: savedNodeId,
            longName: 'Unknown',
            shortName: 'UNK',
            isLocked: false
          } as any;
          logger.debug(`✅ Restored minimal local node info from settings: ${savedNodeId}`);
        }
      } else {
        logger.debug('⚠️ No MyNodeInfo received yet, waiting for device to send local node identification');
      }
    } catch (error) {
      logger.error('❌ Failed to check local node info:', error);
    }
  }

  private async processMyNodeInfo(myNodeInfo: any): Promise<void> {
    logger.debug('📱 Processing MyNodeInfo for local device');
    logger.debug('📱 MyNodeInfo contents:', JSON.stringify(myNodeInfo, null, 2));

    // If we already have locked local node info, don't overwrite it
    if (this.localNodeInfo?.isLocked) {
      logger.debug('📱 Local node info already locked, skipping update');
      return;
    }

    // Log minAppVersion for debugging but don't use it as firmware version
    if (myNodeInfo.minAppVersion) {
      const minVersion = `v${this.decodeMinAppVersion(myNodeInfo.minAppVersion)}`;
      logger.debug(`📱 Minimum app version required: ${minVersion}`);
    }

    const nodeNum = Number(myNodeInfo.myNodeNum);
    const nodeId = `!${myNodeInfo.myNodeNum.toString(16).padStart(8, '0')}`;

    // Extract device_id (stable hardware identifier, 16 bytes) if available
    const deviceId = myNodeInfo.deviceId && myNodeInfo.deviceId.length > 0
      ? Buffer.from(myNodeInfo.deviceId).toString('hex')
      : null;

    // Check for node ID mismatch with previously stored values
    const previousNodeNum = await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeNum'));
    const previousNodeId = await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeId'));
    if (previousNodeNum && previousNodeId) {
      const prevNum = parseInt(previousNodeNum);
      if (prevNum !== nodeNum) {
        const storedDeviceId = await databaseService.settings.getSetting(this.localNodeSettingKey('localDeviceId'));

        if (deviceId && storedDeviceId && deviceId === storedDeviceId) {
          // Same physical device rebooted with a different nodeNum.
          // Accept the new nodeNum, merge old node metadata into it, and delete the old ghost.
          // The firmware is already broadcasting on the new nodeNum, so we must match it.
          this.rebootMergeInProgress = true;
          logger.info(`📱 Reboot detected for same device (device_id: ${deviceId}), accepting new nodeNum ${nodeId} (${nodeNum}) and merging from old ${previousNodeId} (${prevNum})`);

          // Fetch old node data to merge
          const oldNode = await databaseService.nodes.getNode(prevNum);

          // Check if new nodeNum already exists as a known mesh peer (edge case)
          const newNode = await databaseService.nodes.getNode(nodeNum);

          // Upsert new node with merged metadata — new node's existing data takes priority,
          // falls back to old node's data for missing fields
          await databaseService.upsertNodeAsync({
            nodeNum: nodeNum,
            nodeId: nodeId,
            longName: newNode?.longName || oldNode?.longName || undefined,
            shortName: newNode?.shortName || oldNode?.shortName || undefined,
            hwModel: newNode?.hwModel || oldNode?.hwModel || myNodeInfo.hwModel || 0,
            firmwareVersion: (newNode as any)?.firmwareVersion || (oldNode as any)?.firmwareVersion || undefined,
            macaddr: (newNode as any)?.macaddr || (oldNode as any)?.macaddr || undefined,
            publicKey: (newNode as any)?.publicKey || (oldNode as any)?.publicKey || undefined,
            latitude: newNode?.latitude || oldNode?.latitude || undefined,
            longitude: newNode?.longitude || oldNode?.longitude || undefined,
            altitude: newNode?.altitude || oldNode?.altitude || undefined,
            isFavorite: newNode?.isFavorite || oldNode?.isFavorite || false,
            favoriteLocked: newNode?.favoriteLocked || oldNode?.favoriteLocked || false,
            isIgnored: newNode?.isIgnored || oldNode?.isIgnored || false,
            hasRemoteAdmin: true, // Local node always has admin
            rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
            // Receiving MyNodeInfo over the active link is direct evidence we just heard
            // from the local device — stamp lastHeard so downstream consumers (e.g.,
            // neighbor-info filters, activity displays) don't treat the local node as stale
            // when no broadcast traffic has happened to flow through processMeshPacket yet (#3025).
            lastHeard: Date.now() / 1000,
          }, this.sourceId);

          // Delete old ghost node (cascades messages, traceroutes, neighbors, telemetry)
          await databaseService.deleteNodeAsync(prevNum, this.sourceId);
          logger.debug(`🗑️ Deleted old ghost node ${previousNodeId} (${prevNum})`);

          // Suppress ghost resurrection — incoming mesh traffic may still reference the old nodeNum
          await databaseService.suppressGhostNodeAsync(prevNum);

          // Update settings to new nodeNum/nodeId — localDeviceId stays the same
          await databaseService.settings.setSetting(this.localNodeSettingKey('localNodeNum'), nodeNum.toString());
          await databaseService.settings.setSetting(this.localNodeSettingKey('localNodeId'), nodeId);

          // Clear init config cache to force VN clients to get fresh config with correct identity
          this.initConfigCache = [];
          logger.debug(`📸 Cleared init config cache due to same-device reboot merge`);

          // Set localNodeInfo with new nodeNum and merged metadata
          const mergedLongName = newNode?.longName || oldNode?.longName || null;
          this.localNodeInfo = {
            nodeNum: nodeNum,
            nodeId: nodeId,
            longName: mergedLongName,
            shortName: newNode?.shortName || oldNode?.shortName || null,
            hwModel: newNode?.hwModel || oldNode?.hwModel || myNodeInfo.hwModel || undefined,
            firmwareVersion: (newNode as any)?.firmwareVersion || (oldNode as any)?.firmwareVersion || null,
            rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
            isLocked: !!(mergedLongName && mergedLongName !== 'Local Device'),
          } as any;

          // Schedule deferred sendRemoveNode to clean up old nodeNum from physical device's NodeDB
          const prevNumToRemove = prevNum;
          setTimeout(async () => {
            try {
              await this.sendRemoveNode(prevNumToRemove);
              logger.debug(`✅ Removed old nodeNum ${previousNodeId} (${prevNumToRemove}) from device NodeDB after reboot merge`);
            } catch (err) {
              logger.warn(`⚠️ Could not remove old nodeNum ${previousNodeId} (${prevNumToRemove}) from device NodeDB (non-fatal):`, err);
            }
          }, 5000);

          this.rebootMergeInProgress = false;
          return;
        } else {
          // Different device connected (or no device_id available for comparison)
          logger.info(`⚠️ NODE ID CHANGE DETECTED: Physical node changed from ${previousNodeId} (${prevNum}) to ${nodeId} (${nodeNum})`);
          logger.info(`⚠️ This can happen if: (1) The physical node was factory reset, (2) A different physical node was connected, or (3) The node's ID was reconfigured`);
          logger.info(`⚠️ Virtual node clients may briefly show the old node ID until they reconnect`);
          // Clear the init config cache to force fresh data for virtual node clients
          this.initConfigCache = [];
          logger.debug(`📸 Cleared init config cache due to node ID change`);

          // Update stored device_id if new device provides one
          if (deviceId) {
            await databaseService.settings.setSetting(this.localNodeSettingKey('localDeviceId'), deviceId);
          }
        }
      }
    }

    // Store device_id on first encounter or when it wasn't previously stored
    if (deviceId) {
      const storedDeviceId = await databaseService.settings.getSetting(this.localNodeSettingKey('localDeviceId'));
      if (!storedDeviceId) {
        await databaseService.settings.setSetting(this.localNodeSettingKey('localDeviceId'), deviceId);
        logger.debug(`💾 Stored device_id: ${deviceId}`);
      }
    }

    // Save local node info to settings for persistence
    await databaseService.settings.setSetting(this.localNodeSettingKey('localNodeNum'), nodeNum.toString());
    await databaseService.settings.setSetting(this.localNodeSettingKey('localNodeId'), nodeId);
    logger.debug(`💾 Saved local node info to settings: ${nodeId} (${nodeNum})`);

    // Check if we already have this node with actual names in the database.
    // Scoped to this manager's sourceId so we pick this source's row rather
    // than an unrelated source's row for the same nodeNum.
    const existingNode = await databaseService.nodes.getNode(nodeNum, this.sourceId);

    // Clear any erroneous security flags on the local node — we can't have a key mismatch with ourselves
    if (existingNode?.keyMismatchDetected || existingNode?.keySecurityIssueDetails) {
      logger.debug(`🔐 Clearing erroneous security flags on local node ${nodeId}`);
      await databaseService.upsertNodeAsync({
        nodeNum,
        nodeId,
        keyMismatchDetected: false,
        keySecurityIssueDetails: null,
        lastHeard: Date.now() / 1000, // we just received MyNodeInfo (#3025)
      }, this.sourceId);
      dataEventEmitter.emitNodeUpdate(nodeNum, { keyMismatchDetected: false, keySecurityIssueDetails: undefined }, this.sourceId);
    }

    if (existingNode && existingNode.longName && existingNode.longName !== 'Local Device') {
      // We already have real node info, use it and lock it
      this.localNodeInfo = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        longName: existingNode.longName,
        shortName: existingNode.shortName || 'LOCAL',
        hwModel: existingNode.hwModel || undefined,
        firmwareVersion: (existingNode as any).firmwareVersion || null,
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
        isLocked: true  // Lock it to prevent overwrites
      } as any;

      // Update rebootCount and ensure hasRemoteAdmin is set for local node.
      // Also refresh lastHeard — we just received MyNodeInfo, which is direct evidence
      // we heard from the local device. Without this, a local node whose stored lastHeard
      // is stale (no inbound packets via processMeshPacket since startup) would have its
      // own NeighborInfo links silently dropped by the freshness filter in
      // sourceRoutes.ts / server.ts (#3025).
      await databaseService.upsertNodeAsync({
        nodeNum: nodeNum,
        nodeId: nodeId,
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
        hasRemoteAdmin: true, // Local node always has remote admin access
        lastHeard: Date.now() / 1000,
      }, this.sourceId);
      logger.debug(`📱 Updated local device: ${existingNode.longName} (${nodeId}), rebootCount: ${myNodeInfo.rebootCount}, hasRemoteAdmin: true`);

      logger.debug(`📱 Using existing node info for local device: ${existingNode.longName} (${nodeId}) - LOCKED, rebootCount: ${myNodeInfo.rebootCount}`);
    } else {
      // We don't have real node info yet, store basic info and wait for NodeInfo
      const nodeData = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        hwModel: myNodeInfo.hwModel || 0,
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
        hasRemoteAdmin: true,  // Local node always has remote admin access
        lastHeard: Date.now() / 1000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // Store minimal local node info - actual names will come from NodeInfo
      this.localNodeInfo = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        longName: null,  // Will be set when NodeInfo is received
        shortName: null,  // Will be set when NodeInfo is received
        hwModel: myNodeInfo.hwModel || undefined,
        firmwareVersion: null, // Will be set when DeviceMetadata is received
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
        isLocked: false  // Not locked yet, waiting for complete info
      } as any;

      await databaseService.upsertNodeAsync(nodeData, this.sourceId);
      logger.debug(`📱 Stored basic local node info with rebootCount: ${myNodeInfo.rebootCount}, waiting for NodeInfo for names (${nodeId})`);
    }
    // Note: Local node's public key is extracted from security config when received
  }

  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string; hwModel?: number; firmwareVersion?: string; rebootCount?: number; isLocked?: boolean; hasWifi?: boolean; hasEthernet?: boolean; hasBluetooth?: boolean } | null {
    return this.localNodeInfo;
  }

  /**
   * Whether the connected local node is reached through a bridge/proxy rather
   * than being a native IP node. A serial/BLE-only device (e.g. an nRF52-class
   * board) fronted by a TCP proxy (meshtasticd, mesh-bridge, …) reports no
   * native WiFi and no Ethernet in its DeviceMetadata, yet we reach it over a
   * TCP socket — so it physically cannot serve an OTA HTTP endpoint. Features
   * that require direct device IP access (OTA firmware update) must be disabled
   * for such nodes. Returns false until DeviceMetadata has been received
   * (capability flags undefined => unknown => treated as not bridged).
   */
  isLocalNodeBridged(): boolean {
    const info = this.localNodeInfo;
    if (!info) return false;
    if (info.hasWifi === undefined || info.hasEthernet === undefined) return false;
    return info.hasWifi === false && info.hasEthernet === false;
  }

  /** Returns source-scoped settings keys for local node identity persistence.
   *  Each source manager stores its own localNodeNum/localNodeId so managers
   *  don't clobber each other's values when running side-by-side.
   *  public: also called by FavoritesService (#3962 Phase 4.2a PR4 §4c). */
  localNodeSettingKey(base: string): string {
    return this.sourceId && this.sourceId !== 'default' ? `${base}_${this.sourceId}` : base;
  }

  /**
   * Assess whether an incoming packet is impersonating this source's local node
   * (#2584). A packet whose `from` equals our local node number but which
   * arrived over RF (rx metadata / travelled hops) and was not recently sent by
   * us is a spoof candidate. Used to (a) keep the packet-log direction honest
   * and (b) flag suspect messages. Cheap and side-effect-free.
   */
  private assessLocalSpoof(meshPacket: any): SpoofDetectionResult {
    const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
    const packetId = meshPacket.id ?? null;
    return detectLocalNodeSpoof({
      fromNum,
      localNodeNum: this.localNodeInfo?.nodeNum ?? null,
      transportMechanism: meshPacket.transportMechanism,
      hopStart: meshPacket.hopStart ?? (meshPacket as any).hop_start ?? null,
      hopLimit: meshPacket.hopLimit ?? (meshPacket as any).hop_limit ?? null,
      rxSnr: meshPacket.rxSnr ?? (meshPacket as any).rx_snr ?? null,
      rxRssi: meshPacket.rxRssi ?? (meshPacket as any).rx_rssi ?? null,
      viaMqtt: meshPacket.viaMqtt === true || isViaMqtt(meshPacket.transportMechanism),
      packetId,
      wasRecentlySentByUs: this.sentPacketIds.has(packetId),
    });
  }

  /**
   * Get cached remote node config
   * @param nodeNum The remote node number
   * @returns The cached config for the remote node, or null if not available
   */
  getRemoteNodeConfig(nodeNum: number): { deviceConfig: any; moduleConfig: any; lastUpdated: number } | null {
    return this.remoteNodeConfigs.get(nodeNum) || null;
  }

  /**
   * Get the actual device configuration received from the node
   * Used for backup/export functionality
   */
  getActualDeviceConfig(): any {
    return this.actualDeviceConfig;
  }

  /**
   * Update cached device config section after a successful admin command
   * This keeps the cache in sync until the device sends updated config on reconnect
   */
  updateCachedDeviceConfig(section: string, values: Record<string, any>): void {
    if (!this.actualDeviceConfig) {
      this.actualDeviceConfig = {};
    }
    this.actualDeviceConfig[section] = {
      ...this.actualDeviceConfig[section],
      ...values
    };
    logger.debug(`📊 Updated cached device config section '${section}':`, Object.keys(values));
  }

  /**
   * Get the actual module configuration received from the node
   * Used for backup/export functionality
   */
  getActualModuleConfig(): any {
    return this.actualModuleConfig;
  }

  /**
   * Get the local node's security keys (public and private)
   * Private key is only available for the local node from the security config
   * Returns base64-encoded keys
   */
  /**
   * When PKI DM decryption is enabled for this source, extract the local node's
   * private key from the device's security config and persist it encrypted so
   * incoming PKI DMs can be decrypted server-side (#3441). No-op when the
   * setting is off, the device didn't expose a private key, or SESSION_SECRET is
   * auto-generated (the store refuses to persist an unrecoverable key).
   */
  async maybeExtractAndStorePkiKey(): Promise<void> {
    // Global master switch gates everything (#3441).
    if (!(await isPkiDmDecryptionGloballyEnabled())) return;
    const enabled = await databaseService.settings.getSettingForSource(this.sourceId, 'pkiDmDecryptionEnabled');
    if (enabled !== 'true') return;
    const { publicKey, privateKey } = this.getSecurityKeys();
    if (!privateKey) {
      logger.debug(`[MeshtasticManager:${this.sourceId}] PKI DM decryption enabled but device exposed no private key`);
      return;
    }
    const priv = Buffer.from(privateKey, 'base64');
    if (priv.length !== 32) {
      logger.warn(`[MeshtasticManager:${this.sourceId}] Device private key is ${priv.length} bytes (expected 32); skipping`);
      return;
    }
    const store = getSourcePkiKeyStore();
    if (!store.capability.canStore) {
      logger.warn(`[MeshtasticManager:${this.sourceId}] Cannot persist PKI key: ${store.capability.reason}`);
      return;
    }
    // Record the local node identity so a DM addressed to this node can be
    // decrypted by this key regardless of which source received the packet.
    const nodeNum = this.localNodeInfo?.nodeNum ?? null;
    await store.store(this.sourceId, nodeNum, priv, publicKey);
    logger.debug(`🔑 [MeshtasticManager:${this.sourceId}] Stored local PKI private key (node ${nodeNum}) for DM decryption`);
  }

  /**
   * Try to PKI-decrypt a unicast direct message addressed to node `toNum`, using
   * that node's stored private key (held by whichever source owns it) and the
   * sender's public key from this source's node table. Returns the decoded
   * {portnum, payload} on success, or null when there's no key for the
   * destination, no sender public key, or the MAC doesn't verify.
   */
  private async tryPkiDecryptDirectMessage(
    encrypted: Uint8Array,
    packetId: number,
    fromNum: number,
    toNum: number,
  ): Promise<{ portnum: number; payload: Uint8Array } | null> {
    // Global master switch (cached, cheap) — when off, do nothing. This keeps
    // the hot path free of DB reads on instances not using the feature.
    if (!(await isPkiDmDecryptionGloballyEnabled())) return null;
    // Destination node's private key — the row's presence is also the operator's
    // per-source opt-in (it's only stored when pkiDmDecryptionEnabled).
    const loaded = await getSourcePkiKeyStore().loadByNodeNum(toNum);
    if (loaded.kind !== 'ok') return null;

    // Sender's public key, learned from its NodeInfo broadcast (base64).
    const senderNode = await databaseService.nodes.getNode(fromNum, this.sourceId);
    const senderPubB64 = (senderNode as any)?.publicKey;
    if (!senderPubB64) return null;
    const senderPub = Buffer.from(senderPubB64, 'base64');
    if (senderPub.length !== 32) return null;

    const result = pkiDecryptionService.tryDecryptDirectMessage(
      loaded.privateKey,
      senderPub,
      packetId,
      fromNum,
      encrypted,
    );
    if (!result.success || result.portnum === undefined) return null;
    return { portnum: result.portnum, payload: result.payload ?? new Uint8Array() };
  }

  getSecurityKeys(): { publicKey: string | null; privateKey: string | null } {
    const security = this.actualDeviceConfig?.security;
    let publicKey: string | null = null;
    let privateKey: string | null = null;

    if (security) {
      // Convert Uint8Array to base64 if present
      if (security.publicKey && security.publicKey.length > 0) {
        publicKey = Buffer.from(security.publicKey).toString('base64');
      }
      if (security.privateKey && security.privateKey.length > 0) {
        privateKey = Buffer.from(security.privateKey).toString('base64');
      }
    }

    return { publicKey, privateKey };
  }

  /**
   * Get the current device configuration
   */
  getCurrentConfig(): { deviceConfig: any; moduleConfig: any; localNodeInfo: any; supportedModules: { statusmessage: boolean; trafficManagement: boolean } } {
    logger.debug(`[CONFIG] getCurrentConfig called - hopLimit=${this.actualDeviceConfig?.lora?.hopLimit}`);

    // Apply Proto3 defaults to device config if it exists
    let deviceConfig = this.actualDeviceConfig || {};
    if (deviceConfig.device) {
      const deviceConfigWithDefaults = {
        ...deviceConfig.device,
        // IMPORTANT: Proto3 omits numeric 0 values from JSON serialization
        nodeInfoBroadcastSecs: deviceConfig.device.nodeInfoBroadcastSecs !== undefined ? deviceConfig.device.nodeInfoBroadcastSecs : 0
      };

      deviceConfig = {
        ...deviceConfig,
        device: deviceConfigWithDefaults
      };
    }

    // Apply Proto3 defaults to lora config if it exists
    if (deviceConfig.lora) {
      const loraConfigWithDefaults = {
        ...deviceConfig.lora,
        // IMPORTANT: Proto3 omits boolean false and numeric 0 values from JSON serialization
        // but they're still accessible as properties. Explicitly include them.
        usePreset: deviceConfig.lora.usePreset !== undefined ? deviceConfig.lora.usePreset : false,
        sx126xRxBoostedGain: deviceConfig.lora.sx126xRxBoostedGain !== undefined ? deviceConfig.lora.sx126xRxBoostedGain : false,
        ignoreMqtt: deviceConfig.lora.ignoreMqtt !== undefined ? deviceConfig.lora.ignoreMqtt : false,
        configOkToMqtt: deviceConfig.lora.configOkToMqtt !== undefined ? deviceConfig.lora.configOkToMqtt : false,
        frequencyOffset: deviceConfig.lora.frequencyOffset !== undefined ? deviceConfig.lora.frequencyOffset : 0,
        overrideFrequency: deviceConfig.lora.overrideFrequency !== undefined ? deviceConfig.lora.overrideFrequency : 0,
        modemPreset: deviceConfig.lora.modemPreset !== undefined ? deviceConfig.lora.modemPreset : 0,
        channelNum: deviceConfig.lora.channelNum !== undefined ? deviceConfig.lora.channelNum : 0,
        // FEM_LNA_Mode enum: default to 0 (DISABLED), the proto3 zero value (firmware ≥ v2.7.20)
        femLnaMode: deviceConfig.lora.femLnaMode !== undefined ? deviceConfig.lora.femLnaMode : 0
      };

      deviceConfig = {
        ...deviceConfig,
        lora: loraConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning lora config with usePreset=${loraConfigWithDefaults.usePreset}, sx126xRxBoostedGain=${loraConfigWithDefaults.sx126xRxBoostedGain}, ignoreMqtt=${loraConfigWithDefaults.ignoreMqtt}, configOkToMqtt=${loraConfigWithDefaults.configOkToMqtt}`);
    }

    // Apply Proto3 defaults to position config if it exists
    if (deviceConfig.position) {
      const positionConfigWithDefaults = {
        ...deviceConfig.position,
        // IMPORTANT: Proto3 omits boolean false and numeric 0 values from JSON serialization
        // Explicitly include them to ensure frontend receives all values
        positionBroadcastSecs: deviceConfig.position.positionBroadcastSecs !== undefined ? deviceConfig.position.positionBroadcastSecs : 0,
        positionBroadcastSmartEnabled: deviceConfig.position.positionBroadcastSmartEnabled !== undefined ? deviceConfig.position.positionBroadcastSmartEnabled : false,
        fixedPosition: deviceConfig.position.fixedPosition !== undefined ? deviceConfig.position.fixedPosition : false
      };

      deviceConfig = {
        ...deviceConfig,
        position: positionConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning position config with positionBroadcastSecs=${positionConfigWithDefaults.positionBroadcastSecs}, positionBroadcastSmartEnabled=${positionConfigWithDefaults.positionBroadcastSmartEnabled}, fixedPosition=${positionConfigWithDefaults.fixedPosition}`);
    }

    // Apply Proto3 defaults to security config if it exists
    if (deviceConfig.security) {
      const securityConfigWithDefaults = {
        ...deviceConfig.security,
        // IMPORTANT: Proto3 omits boolean false values from JSON serialization
        isManaged: deviceConfig.security.isManaged !== undefined ? deviceConfig.security.isManaged : false,
        serialEnabled: deviceConfig.security.serialEnabled !== undefined ? deviceConfig.security.serialEnabled : false,
        debugLogApiEnabled: deviceConfig.security.debugLogApiEnabled !== undefined ? deviceConfig.security.debugLogApiEnabled : false,
        adminChannelEnabled: deviceConfig.security.adminChannelEnabled !== undefined ? deviceConfig.security.adminChannelEnabled : false
      };

      deviceConfig = {
        ...deviceConfig,
        security: securityConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning security config with isManaged=${securityConfigWithDefaults.isManaged}, serialEnabled=${securityConfigWithDefaults.serialEnabled}, debugLogApiEnabled=${securityConfigWithDefaults.debugLogApiEnabled}, adminChannelEnabled=${securityConfigWithDefaults.adminChannelEnabled}`);
    }

    // Apply Proto3 defaults to module config if it exists
    let moduleConfig = this.actualModuleConfig || {};

    // Apply Proto3 defaults to MQTT module config
    if (moduleConfig.mqtt) {
      const mqttConfigWithDefaults = {
        ...moduleConfig.mqtt,
        // IMPORTANT: Proto3 omits boolean false values from JSON serialization
        enabled: moduleConfig.mqtt.enabled !== undefined ? moduleConfig.mqtt.enabled : false,
        encryptionEnabled: moduleConfig.mqtt.encryptionEnabled !== undefined ? moduleConfig.mqtt.encryptionEnabled : false,
        jsonEnabled: moduleConfig.mqtt.jsonEnabled !== undefined ? moduleConfig.mqtt.jsonEnabled : false,
        tlsEnabled: moduleConfig.mqtt.tlsEnabled !== undefined ? moduleConfig.mqtt.tlsEnabled : false,
        proxyToClientEnabled: moduleConfig.mqtt.proxyToClientEnabled !== undefined ? moduleConfig.mqtt.proxyToClientEnabled : false,
        mapReportingEnabled: moduleConfig.mqtt.mapReportingEnabled !== undefined ? moduleConfig.mqtt.mapReportingEnabled : false
      };

      moduleConfig = {
        ...moduleConfig,
        mqtt: mqttConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning MQTT config with enabled=${mqttConfigWithDefaults.enabled}, encryptionEnabled=${mqttConfigWithDefaults.encryptionEnabled}, jsonEnabled=${mqttConfigWithDefaults.jsonEnabled}`);
    }

    // Apply Proto3 defaults to NeighborInfo module config
    if (moduleConfig.neighborInfo) {
      const neighborInfoConfigWithDefaults = {
        ...moduleConfig.neighborInfo,
        // IMPORTANT: Proto3 omits boolean false and numeric 0 values from JSON serialization
        enabled: moduleConfig.neighborInfo.enabled !== undefined ? moduleConfig.neighborInfo.enabled : false,
        updateInterval: moduleConfig.neighborInfo.updateInterval !== undefined ? moduleConfig.neighborInfo.updateInterval : 0,
        transmitOverLora: moduleConfig.neighborInfo.transmitOverLora !== undefined ? moduleConfig.neighborInfo.transmitOverLora : false
      };

      moduleConfig = {
        ...moduleConfig,
        neighborInfo: neighborInfoConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning NeighborInfo config with enabled=${neighborInfoConfigWithDefaults.enabled}, updateInterval=${neighborInfoConfigWithDefaults.updateInterval}, transmitOverLora=${neighborInfoConfigWithDefaults.transmitOverLora}`);
    }

    // Apply Proto3 defaults to Telemetry module config
    if (moduleConfig.telemetry) {
      const telemetryConfigWithDefaults = {
        ...moduleConfig.telemetry,
        // IMPORTANT: Proto3 omits boolean false and numeric 0 values from JSON serialization
        deviceUpdateInterval: moduleConfig.telemetry.deviceUpdateInterval !== undefined ? moduleConfig.telemetry.deviceUpdateInterval : 0,
        deviceTelemetryEnabled: moduleConfig.telemetry.deviceTelemetryEnabled !== undefined ? moduleConfig.telemetry.deviceTelemetryEnabled : false,
        environmentUpdateInterval: moduleConfig.telemetry.environmentUpdateInterval !== undefined ? moduleConfig.telemetry.environmentUpdateInterval : 0,
        environmentMeasurementEnabled: moduleConfig.telemetry.environmentMeasurementEnabled !== undefined ? moduleConfig.telemetry.environmentMeasurementEnabled : false,
        environmentScreenEnabled: moduleConfig.telemetry.environmentScreenEnabled !== undefined ? moduleConfig.telemetry.environmentScreenEnabled : false,
        environmentDisplayFahrenheit: moduleConfig.telemetry.environmentDisplayFahrenheit !== undefined ? moduleConfig.telemetry.environmentDisplayFahrenheit : false,
        airQualityEnabled: moduleConfig.telemetry.airQualityEnabled !== undefined ? moduleConfig.telemetry.airQualityEnabled : false,
        airQualityInterval: moduleConfig.telemetry.airQualityInterval !== undefined ? moduleConfig.telemetry.airQualityInterval : 0,
        powerMeasurementEnabled: moduleConfig.telemetry.powerMeasurementEnabled !== undefined ? moduleConfig.telemetry.powerMeasurementEnabled : false,
        powerUpdateInterval: moduleConfig.telemetry.powerUpdateInterval !== undefined ? moduleConfig.telemetry.powerUpdateInterval : 0,
        powerScreenEnabled: moduleConfig.telemetry.powerScreenEnabled !== undefined ? moduleConfig.telemetry.powerScreenEnabled : false,
        healthMeasurementEnabled: moduleConfig.telemetry.healthMeasurementEnabled !== undefined ? moduleConfig.telemetry.healthMeasurementEnabled : false,
        healthUpdateInterval: moduleConfig.telemetry.healthUpdateInterval !== undefined ? moduleConfig.telemetry.healthUpdateInterval : 0,
        healthScreenEnabled: moduleConfig.telemetry.healthScreenEnabled !== undefined ? moduleConfig.telemetry.healthScreenEnabled : false
      };

      moduleConfig = {
        ...moduleConfig,
        telemetry: telemetryConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning Telemetry config with deviceTelemetryEnabled=${telemetryConfigWithDefaults.deviceTelemetryEnabled}, healthMeasurementEnabled=${telemetryConfigWithDefaults.healthMeasurementEnabled}`);
    }

    // Convert network config IP addresses from uint32 to string format for frontend
    if (deviceConfig.network) {
      const networkConfigWithConvertedIps = {
        ...deviceConfig.network,
        // Convert ipv4Config IP addresses from uint32 (protobuf fixed32) to dotted-decimal strings
        ipv4Config: deviceConfig.network.ipv4Config
          ? convertIpv4ConfigToStrings(deviceConfig.network.ipv4Config)
          : undefined
      };

      deviceConfig = {
        ...deviceConfig,
        network: networkConfigWithConvertedIps
      };

      logger.debug(`[CONFIG] Converted network config IP addresses to strings`);
    }

    // Apply Proto3 defaults to StatusMessage module config
    if (moduleConfig.statusmessage) {
      const statusMessageConfigWithDefaults = {
        ...moduleConfig.statusmessage,
        nodeStatus: moduleConfig.statusmessage.nodeStatus !== undefined ? moduleConfig.statusmessage.nodeStatus : ''
      };

      moduleConfig = {
        ...moduleConfig,
        statusmessage: statusMessageConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning StatusMessage config with nodeStatus="${statusMessageConfigWithDefaults.nodeStatus}"`);
    }

    // Apply Proto3 defaults to TrafficManagement module config (v2.7.22 schema)
    if (moduleConfig.trafficManagement) {
      const tm = moduleConfig.trafficManagement;
      const trafficManagementConfigWithDefaults = {
        ...tm,
        enabled: tm.enabled !== undefined ? tm.enabled : false,
        positionDedupEnabled: tm.positionDedupEnabled !== undefined ? tm.positionDedupEnabled : false,
        positionPrecisionBits: tm.positionPrecisionBits !== undefined ? tm.positionPrecisionBits : 0,
        positionMinIntervalSecs: tm.positionMinIntervalSecs !== undefined ? tm.positionMinIntervalSecs : 0,
        nodeinfoDirectResponse: tm.nodeinfoDirectResponse !== undefined ? tm.nodeinfoDirectResponse : false,
        nodeinfoDirectResponseMaxHops: tm.nodeinfoDirectResponseMaxHops !== undefined ? tm.nodeinfoDirectResponseMaxHops : 0,
        rateLimitEnabled: tm.rateLimitEnabled !== undefined ? tm.rateLimitEnabled : false,
        rateLimitWindowSecs: tm.rateLimitWindowSecs !== undefined ? tm.rateLimitWindowSecs : 0,
        rateLimitMaxPackets: tm.rateLimitMaxPackets !== undefined ? tm.rateLimitMaxPackets : 0,
        dropUnknownEnabled: tm.dropUnknownEnabled !== undefined ? tm.dropUnknownEnabled : false,
        unknownPacketThreshold: tm.unknownPacketThreshold !== undefined ? tm.unknownPacketThreshold : 0,
        exhaustHopTelemetry: tm.exhaustHopTelemetry !== undefined ? tm.exhaustHopTelemetry : false,
        exhaustHopPosition: tm.exhaustHopPosition !== undefined ? tm.exhaustHopPosition : false,
        routerPreserveHops: tm.routerPreserveHops !== undefined ? tm.routerPreserveHops : false
      };

      moduleConfig = {
        ...moduleConfig,
        trafficManagement: trafficManagementConfigWithDefaults
      };

      logger.debug(`[CONFIG] Returning TrafficManagement config with enabled=${trafficManagementConfigWithDefaults.enabled}`);
    }

    return {
      deviceConfig,
      moduleConfig,
      localNodeInfo: this.localNodeInfo,
      supportedModules: {
        // Gate on firmware version, NOT on presence of the decoded config
        // sub-message. Proto3 omits an all-default sub-message, so a fully
        // supported module whose config is untouched (the common case) would
        // otherwise report as unsupported. See firmwareVersionAtLeast().
        statusmessage: this.supportsStatusMessage(),
        trafficManagement: this.supportsTrafficManagement()
      }
    };
  }

  /**
   * Process DeviceMetadata protobuf message
   */
  private async processDeviceMetadata(metadata: any): Promise<void> {
    logger.debug('📱 Processing DeviceMetadata:', JSON.stringify(metadata, null, 2));
    logger.debug('📱 Firmware version:', metadata.firmwareVersion);

    // Capture the node's transport-capability flags (proto3 bools decode to a
    // concrete true/false). These drive isLocalNodeBridged() — a serial/BLE-only
    // node fronted by a TCP proxy reports both false and cannot do OTA updates.
    // Captured independently of firmwareVersion so detection works even if the
    // firmware string is momentarily empty.
    if (this.localNodeInfo) {
      this.localNodeInfo.hasWifi = metadata.hasWifi === true;
      this.localNodeInfo.hasEthernet = metadata.hasEthernet === true;
      this.localNodeInfo.hasBluetooth = metadata.hasBluetooth === true;
      if (this.isLocalNodeBridged()) {
        logger.debug('🌉 Connected node reports no native WiFi/Ethernet — treating as a bridged node (OTA firmware update disabled)');
      }
    }

    // Update local node info with firmware version (always allowed, even if locked)
    if (this.localNodeInfo && metadata.firmwareVersion) {
      // Only update firmware version, don't touch other fields
      this.localNodeInfo.firmwareVersion = metadata.firmwareVersion;
      // Clear favorites support cache since firmware version changed
      this.favoritesSupportCache = null;
      logger.debug(`📱 Updated firmware version: ${metadata.firmwareVersion}`);

      // Update the database with the firmware version
      if (this.localNodeInfo.nodeNum) {
        const nodeData = {
          nodeNum: this.localNodeInfo.nodeNum,
          nodeId: this.localNodeInfo.nodeId,
          firmwareVersion: metadata.firmwareVersion
        };
        await databaseService.upsertNodeAsync(nodeData, this.sourceId);
        logger.debug(`📱 Saved firmware version to database for node ${this.localNodeInfo.nodeId}`);
      }
    } else {
      logger.debug('⚠️ Cannot update firmware - localNodeInfo not initialized yet');
    }
  }

  /**
   * Process Channel protobuf message
   */
  private async processChannelProtobuf(channel: any): Promise<void> {
    logger.debug('📡 Processing Channel protobuf', {
      index: channel.index,
      role: channel.role,
      name: channel.settings?.name,
      hasPsk: !!channel.settings?.psk,
      uplinkEnabled: channel.settings?.uplinkEnabled,
      downlinkEnabled: channel.settings?.downlinkEnabled,
      positionPrecision: channel.settings?.moduleSettings?.positionPrecision,
      hasModuleSettings: !!channel.settings?.moduleSettings
    });

    if (channel.settings) {
      // Only save channels that are actually configured and useful
      // Use the device-provided name if non-empty; otherwise fall back to a
      // generic label for secondary channels (1-7).  Firmware sends an empty
      // string for channels without a custom name (the "MediumFast" preset
      // name is NOT in the channel name field).  Storing "" caused unnamed
      // secondary channels to lose their display name on fresh databases
      // (#2619).  Channel 0 keeps "" so the primary channel name comes from
      // device config, not a generic fallback.
      const channelName = channel.settings.name || (channel.index === 0 ? '' : `Channel ${channel.index}`);
      const displayName = channelName || `Channel ${channel.index}`; // For logging only
      const hasValidConfig = channel.settings.name !== undefined ||
                            channel.settings.psk ||
                            channel.role === 0 || // DISABLED role (explicitly set)
                            channel.role === 1 || // PRIMARY role
                            channel.role === 2 || // SECONDARY role
                            channel.index === 0;   // Always include channel 0

      if (hasValidConfig) {
        try {
          // Convert PSK buffer to base64 string if it exists
          let pskString: string | undefined;
          if (channel.settings.psk && channel.settings.psk.length > 0) {
            try {
              pskString = Buffer.from(channel.settings.psk).toString('base64');
            } catch (pskError) {
              logger.warn(`⚠️  Failed to convert PSK to base64 for channel ${channel.index} (${displayName}):`, pskError);
              pskString = undefined;
            }
          }

          // Extract position precision from module settings if available
          const positionPrecision = channel.settings.moduleSettings?.positionPrecision;

          // Defensive channel role validation.
          // Rules:
          // 1. Channel 0 must be PRIMARY (role=1), never DISABLED (role=0)
          // 2. Channels 1-7 must be SECONDARY (role=2) or DISABLED (role=0), never PRIMARY (role=1)
          // 3. Proto3 default-value elision (#2666): firmware strips role=DISABLED on the
          //    wire, so an empty secondary slot arrives with role=undefined. Treat "no
          //    role + no name + no PSK" as DISABLED so `?? existingChannel.role` in
          //    upsertChannel doesn't preserve the stale SECONDARY role forever.
          const channelRole = normalizeChannelRole(channel);

          if (channel.index === 0 && channel.role === 0) {
            logger.warn(`⚠️  Channel 0 received with role=DISABLED (0), overriding to PRIMARY (1)`);
          }

          if (channel.index > 0 && channel.role === 1) {
            logger.warn(`⚠️  Channel ${channel.index} received with role=PRIMARY (1), overriding to SECONDARY (2)`);
            logger.warn(`⚠️  Only Channel 0 can be PRIMARY - all other channels must be SECONDARY or DISABLED`);
          }

          if (channelRole === 0 && channel.role === undefined && channel.index > 0) {
            logger.debug(`📡 Channel ${channel.index} arrived empty — normalizing role to DISABLED(0) (#2666)`);
          }

          logger.debug(`📡 Saving channel ${channel.index} (${displayName}) - role: ${channelRole}`);

          await databaseService.channels.upsertChannel({
            id: channel.index,
            name: channelName,
            psk: pskString,
            role: channelRole,
            // proto3 elides boolean `false` on the wire (it's the zero value), so a
            // disabled uplink/downlink arrives as undefined when the device streams
            // its channel config on reconnect. `uplink_enabled`/`downlink_enabled`
            // both default to false in the Meshtastic ChannelSettings proto, so the
            // correct reconstruction of an absent value is `false`, not `true`.
            // Defaulting to `true` here silently re-enabled a user-disabled downlink
            // after a container restart (#3594).
            uplinkEnabled: channel.settings.uplinkEnabled ?? false,
            downlinkEnabled: channel.settings.downlinkEnabled ?? false,
            positionPrecision: positionPrecision !== undefined ? positionPrecision : undefined
          }, this.sourceId);
          logger.debug(`📡 Saved channel: ${displayName} (role: ${channel.role}, index: ${channel.index}, psk: ${pskString ? 'set' : 'none'}, uplink: ${channel.settings.uplinkEnabled}, downlink: ${channel.settings.downlinkEnabled}, positionPrecision: ${positionPrecision})`);
        } catch (error) {
          logger.error('❌ Failed to save channel:', error);
        }
      } else {
        logger.debug(`📡 Skipping empty/unused channel ${channel.index}`);
      }
    }
  }

  /**
   * Process Config protobuf message
   */
  // Configuration messages don't typically need database storage
  // They contain device settings like LoRa parameters, GPS settings, etc.

  /**
   * Process MeshPacket protobuf message
   */
  private async processMeshPacket(meshPacket: any, context?: ProcessingContext): Promise<void> {
    logger.debug(`🔄 Processing MeshPacket: ID=${meshPacket.id}, from=${meshPacket.from}, to=${meshPacket.to}`);

    // Track decryption metadata for packet logging
    let decryptedBy: 'node' | 'server' | null = null;
    let decryptedChannelId: number | null = null;

    // Server-side decryption: Try to decrypt encrypted packets using database channels
    if (!meshPacket.decoded && meshPacket.encrypted && channelDecryptionService.isEnabled()) {
      const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
      const packetId = meshPacket.id ?? 0;

      try {
        const decryptionResult = await channelDecryptionService.tryDecrypt(
          meshPacket.encrypted,
          packetId,
          fromNum,
          meshPacket.channel
        );

        if (decryptionResult.success) {
          // Create synthetic decoded field with decrypted data
          meshPacket.decoded = {
            portnum: decryptionResult.portnum,
            payload: decryptionResult.payload,
          };
          decryptedBy = 'server';
          decryptedChannelId = decryptionResult.channelDatabaseId ?? null;
          logger.trace(
            `🔓 Server decrypted packet ${packetId} from ${fromNum} using channel "${decryptionResult.channelName}" (portnum=${decryptionResult.portnum})`
          );
        }
      } catch (err) {
        logger.debug(`Server decryption attempt failed for packet ${packetId}:`, err);
      }
    } else if (meshPacket.decoded) {
      // Packet was decrypted by the node
      decryptedBy = 'node';
    }

    // PKI direct-message decryption (#3441): if the packet is STILL encrypted and
    // is a unicast addressed to a node whose private key MeshMonitor holds, decrypt
    // it server-side. This surfaces DMs that the receiving radio didn't decode —
    // primarily PKI DMs relayed (still encrypted) through MQTT bridge/broker
    // sources, addressed to one of our nodes connected on another source.
    if (!meshPacket.decoded && meshPacket.encrypted) {
      const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
      const toNum = meshPacket.to ? Number(meshPacket.to) : 0;
      const isUnicast = toNum > 0 && toNum !== 0xffffffff;
      if (isUnicast && fromNum > 0) {
        try {
          const pki = await this.tryPkiDecryptDirectMessage(meshPacket.encrypted, meshPacket.id ?? 0, fromNum, toNum);
          if (pki) {
            meshPacket.decoded = { portnum: pki.portnum, payload: pki.payload };
            decryptedBy = 'server';
            logger.debug(`🔓🔑 Server PKI-decrypted DM ${meshPacket.id} from ${fromNum} to ${toNum} (portnum=${pki.portnum})`);
          }
        } catch (err) {
          logger.debug(`PKI decryption attempt failed for packet ${meshPacket.id}:`, err);
        }
      }
    }

    // Log packet to packet log (if enabled)
    try {
      if (await packetLogService.isEnabled()) {
        const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
        const toNum = meshPacket.to ? Number(meshPacket.to) : null;
        const fromNodeId = fromNum ? `!${fromNum.toString(16).padStart(8, '0')}` : null;
        const toNodeId = toNum ? `!${toNum.toString(16).padStart(8, '0')}` : null;

        // Check if packet is encrypted — a packet is encrypted when neither the node nor the
        // server successfully decoded it. Using `decryptedBy` (set above) is more reliable than
        // checking `decoded.payload` because server-side decryption can succeed while returning
        // an undefined payload (e.g. a packet whose inner Data.payload bytes are absent), and
        // we don't want to re-label those as encrypted after a successful decrypt.
        const isEncrypted = decryptedBy === null;
        const portnum = meshPacket.decoded?.portnum ?? 0;
        const portnumName = meshtasticProtobufService.getPortNumName(portnum);

        // Skip logging for local internal packets (ADMIN_APP and ROUTING_APP)
        // These are management packets between MeshMonitor and the local node, not actual mesh traffic
        // Also skip "phantom" internal state updates from the device that aren't actual RF transmissions
        if (shouldExcludeFromPacketLog(fromNum, toNum, portnum, this.localNodeInfo?.nodeNum ?? null) ||
            isPhantomInternalPacket(fromNum, this.localNodeInfo?.nodeNum ?? null, meshPacket.transportMechanism, meshPacket.hopStart)) {
          // Skip logging - these are internal packets, not actual mesh traffic
        } else {

        // Generate payload preview and store decoded payload
        let payloadPreview = null;
        let decodedPayload: any = null;
        if (isEncrypted) {
          payloadPreview = '🔒 <ENCRYPTED>';
        } else if (meshPacket.decoded?.payload) {
          try {
            decodedPayload = meshtasticProtobufService.processPayload(portnum, meshPacket.decoded.payload);
            const processedPayload = decodedPayload;
            if (portnum === PortNum.TEXT_MESSAGE_APP && typeof processedPayload === 'string') {
              // TEXT_MESSAGE - show first 100 chars
              payloadPreview = processedPayload.substring(0, 100);
            } else if (portnum === PortNum.POSITION_APP) {
              // POSITION - show coordinates (if available)
              const pos = processedPayload as any;
              if (pos.latitudeI !== undefined || pos.longitudeI !== undefined || pos.latitude_i !== undefined || pos.longitude_i !== undefined) {
                const lat = pos.latitudeI || pos.latitude_i || 0;
                const lon = pos.longitudeI || pos.longitude_i || 0;
                const latDeg = (lat / 1e7).toFixed(5);
                const lonDeg = (lon / 1e7).toFixed(5);
                payloadPreview = `[Position: ${latDeg}°, ${lonDeg}°]`;
              } else {
                payloadPreview = '[Position update]';
              }
            } else if (portnum === PortNum.NODEINFO_APP) {
              // NODEINFO - show node name (if available)
              const nodeInfo = processedPayload as any;
              const longName = nodeInfo.longName || nodeInfo.long_name;
              const shortName = nodeInfo.shortName || nodeInfo.short_name;
              if (longName || shortName) {
                payloadPreview = `[NodeInfo: ${longName || shortName}]`;
              } else {
                payloadPreview = '[NodeInfo update]';
              }
            } else if (portnum === PortNum.TELEMETRY_APP) {
              // TELEMETRY - show telemetry type
              const telemetry = processedPayload as any;
              let telemetryType = 'Unknown';
              if (telemetry.deviceMetrics || telemetry.device_metrics) {
                telemetryType = 'Device';
              } else if (telemetry.environmentMetrics || telemetry.environment_metrics) {
                telemetryType = 'Environment';
              } else if (telemetry.airQualityMetrics || telemetry.air_quality_metrics) {
                telemetryType = 'Air Quality';
              } else if (telemetry.powerMetrics || telemetry.power_metrics) {
                telemetryType = 'Power';
              } else if (telemetry.localStats || telemetry.local_stats) {
                telemetryType = 'Local Stats';
              } else if (telemetry.healthMetrics || telemetry.health_metrics) {
                telemetryType = 'Health';
              } else if (telemetry.hostMetrics || telemetry.host_metrics) {
                telemetryType = 'Host';
              } else if (telemetry.trafficManagementStats || telemetry.traffic_management_stats) {
                telemetryType = 'TrafficManagement';
              }
              payloadPreview = `[Telemetry: ${telemetryType}]`;
            } else if (portnum === PortNum.PAXCOUNTER_APP) {
              // PAXCOUNTER - show WiFi and BLE counts
              const pax = processedPayload as any;
              payloadPreview = `[Paxcounter: WiFi=${pax.wifi || 0}, BLE=${pax.ble || 0}]`;
            } else if (portnum === PortNum.TRACEROUTE_APP) {
              // TRACEROUTE
              payloadPreview = '[Traceroute]';
            } else if (portnum === PortNum.WAYPOINT_APP) {
              // WAYPOINT
              const wp = processedPayload as any;
              const wpExpire = Number(wp?.expire ?? 0);
              const nowSec = Math.floor(Date.now() / 1000);
              if (wpExpire > 0 && wpExpire <= nowSec) {
                payloadPreview = `[Waypoint delete: id=${wp.id}]`;
              } else {
                payloadPreview = `[Waypoint: id=${wp?.id ?? '?'} ${wp?.name ?? ''}]`.trim();
              }
            } else if (portnum === PortNum.NEIGHBORINFO_APP) {
              // NEIGHBORINFO
              payloadPreview = '[NeighborInfo]';
            } else if (portnum === PortNum.MESH_BEACON_APP) {
              // MESH_BEACON (firmware 2.8+) - show beacon text and what's offered
              const beacon = processedPayload as MeshBeaconPayload;
              const text = typeof beacon?.message === 'string' ? beacon.message.substring(0, 60) : '';
              const offers: string[] = [];
              const offerChannelName = beacon?.offerChannel?.name || beacon?.offer_channel?.name;
              if (offerChannelName) offers.push(`channel "${offerChannelName}"`);
              const offerPreset = beacon?.offerPreset ?? beacon?.offer_preset;
              if (offerPreset !== undefined && offerPreset !== null) offers.push(`preset ${offerPreset}`);
              const offerSuffix = offers.length > 0 ? ` (offers ${offers.join(', ')})` : '';
              payloadPreview = `[MeshBeacon: "${text}"${offerSuffix}]`;
            } else if (portnum === PortNum.STORE_FORWARD_APP) {
              // STORE & FORWARD - show request/response type and relevant details
              const sf = processedPayload as any;
              const rrVal = sf.rr ?? sf.requestResponse ?? 0;
              const rrName = getStoreForwardRequestResponseName(rrVal);
              if (rrVal === StoreForwardRequestResponse.ROUTER_TEXT_DIRECT || rrVal === StoreForwardRequestResponse.ROUTER_TEXT_BROADCAST) {
                const textBytes = sf.text;
                const preview = textBytes ? new TextDecoder('utf-8').decode(textBytes instanceof Uint8Array ? textBytes : new Uint8Array(textBytes)).substring(0, 60) : '';
                payloadPreview = `[S&F ${rrName}: "${preview}"]`;
              } else if (rrVal === StoreForwardRequestResponse.ROUTER_HEARTBEAT) {
                payloadPreview = `[S&F Heartbeat: period=${sf.heartbeat?.period ?? 0}s]`;
              } else if (rrVal === StoreForwardRequestResponse.ROUTER_STATS) {
                payloadPreview = `[S&F Stats: saved=${sf.stats?.messagesSaved ?? 0}/${sf.stats?.messagesMax ?? 0}]`;
              } else if (rrVal === StoreForwardRequestResponse.ROUTER_HISTORY) {
                payloadPreview = `[S&F History: ${sf.history?.historyMessages ?? 0} msgs]`;
              } else {
                payloadPreview = `[S&F ${rrName}]`;
              }
            } else if (portnum === PortNum.ATAK_PLUGIN) {
              payloadPreview = formatTakPreview(
                processedPayload, meshPacket.decoded.payload.length);
              // decodedPayload keeps the decoded TAKPacket object → renders as JSON in the detail view.
            } else if (portnum === PortNum.ATAK_PLUGIN_V2) {
              payloadPreview = `[ATAK V2 (not decoded), ${meshPacket.decoded.payload.length} bytes]`;
              decodedPayload = null; // suppress raw-Uint8Array dump into metadata.decoded_payload
            } else if (portnum === PortNum.ATAK_FORWARDER) {
              payloadPreview = `[ATAK Forwarder (not decoded), ${meshPacket.decoded.payload.length} bytes]`;
              decodedPayload = null;
            } else {
              payloadPreview = `[${portnumName}]`;
            }
          } catch (error) {
            payloadPreview = `[${portnumName}]`;
          }
        }

        // Build metadata JSON
        const metadata: any = {
          id: meshPacket.id,
          rx_time: meshPacket.rxTime,
          rx_snr: meshPacket.rxSnr,
          rx_rssi: meshPacket.rxRssi,
          hop_limit: meshPacket.hopLimit,
          hop_start: meshPacket.hopStart,
          want_ack: meshPacket.wantAck,
          priority: meshPacket.priority,
          transport_mechanism: meshPacket.transportMechanism
        };

        // XEdDSA flag has its own packet_log column; only mirror it into the
        // metadata blob when actually signed (like encrypted_payload) so every
        // pre-2.8 packet doesn't carry a redundant undefined field. (#3923)
        if (meshPacket.xeddsaSigned) {
          metadata.xeddsa_signed = true;
        }

        // Include encrypted payload bytes if packet is encrypted
        if (isEncrypted && meshPacket.encrypted) {
          // Convert Uint8Array to hex string for storage
          metadata.encrypted_payload = Buffer.from(meshPacket.encrypted).toString('hex');
        }

        // Include decoded payload for non-encrypted packets
        // Use loose equality to exclude both null and undefined
        if (decodedPayload != null) {
          metadata.decoded_payload = decodedPayload;
        }

        // Impersonation check (#2584): a packet claiming from == our local node
        // that reaches here (phantom-internal packets were already filtered out
        // above) arrived over the air, so it is a reception, not our own 'tx'.
        const spoof = this.assessLocalSpoof(meshPacket);

        void packetLogService.logPacket({
          packet_id: meshPacket.id ?? undefined,
          timestamp: Date.now(), // Use server time in ms for consistent ordering (rxTime preserved in metadata.rx_time)
          from_node: fromNum,
          from_node_id: fromNodeId ?? undefined,
          to_node: toNum ?? undefined,
          to_node_id: toNodeId ?? undefined,
          channel: meshPacket.channel ?? undefined,
          portnum: portnum,
          portnum_name: portnumName,
          encrypted: isEncrypted,
          snr: meshPacket.rxSnr ?? undefined,
          rssi: meshPacket.rxRssi ?? undefined,
          hop_limit: meshPacket.hopLimit ?? undefined,
          hop_start: meshPacket.hopStart ?? undefined,
          relay_node: meshPacket.relayNode ?? undefined,
          payload_size: meshPacket.decoded?.payload?.length ?? meshPacket.encrypted?.length ?? undefined,
          want_ack: meshPacket.wantAck ?? false,
          priority: meshPacket.priority ?? undefined,
          payload_preview: payloadPreview ?? undefined,
          metadata: JSON.stringify(metadata),
          // Firmware 2.8 XEdDSA signature-verified flag (#3923); undefined
          // (pre-2.8 firmware) stays NULL = unknown.
          xeddsa_signed: meshPacket.xeddsaSigned ?? undefined,
          // 'tx' ONLY for genuine local transmissions (internal, fresh, no RX
          // metadata). A spoofed packet claiming our node number is a reception.
          direction: spoof.isGenuineLocalTx ? 'tx' : 'rx',
          spoof_suspected: spoof.spoofSuspected || undefined,
          decrypted_by: decryptedBy ?? undefined,
          decrypted_channel_id: decryptedChannelId ?? undefined,
          // Note: ?? (nullish coalescing) correctly preserves 0 (INTERNAL), only defaults on null/undefined
          transport_mechanism: meshPacket.transportMechanism ?? TransportMechanism.LORA,
          sourceId: this.sourceId,
        });
        } // end else (not internal packet)
      }
    } catch (error) {
      logger.error('❌ Failed to log packet:', error);
    }

    // Extract node information if available
    // Note: Only update technical fields (SNR/RSSI/lastHeard/channel), not names
    // Names should only come from NODEINFO packets
    if (meshPacket.from && meshPacket.from !== BigInt(0)) {
      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;

      // Check if node exists first
      const existingNode = await databaseService.nodes.getNode(fromNum);

      // Only update the node's channel from firmware-decoded packets (decryptedBy === 'node').
      // Server-decrypted packets still have the raw channel hash in meshPacket.channel, not
      // a valid channel index (0-7), so storing it would corrupt the node's channel field.
      const channelFromPacket = (decryptedBy === 'node' && meshPacket.channel !== undefined)
        ? meshPacket.channel
        : undefined;

      // Stamp the per-packet transport mechanism onto the node row
      // (most-recent wins). Feeds the map's Show RF / UDP / MQTT toggles
      // — see migration 066 and the TransportMechanism enum in
      // src/server/constants/meshtastic.ts. The field is proto3
      // (default 0 = INTERNAL when unset), so only record values that
      // came across the wire as actual numbers.
      // #4240: always resolves to a value. `transportMechanism` remains
      // last-wins ("most recently heard via"), but map visibility now keys off
      // `transportFlags`, which ORs bits so an MQTT echo of RF traffic cannot
      // erase the node's RF reachability. See resolveRadioPacketTransport.
      const txMech = resolveRadioPacketTransport(meshPacket);
      // Stamp only the column for THIS packet's transport; the repository
      // carries the other two forward untouched.
      const txColumn = transportColumnForPacket(txMech, meshPacket.viaMqtt);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Use server time for lastHeard — rxTime from the device clock is unreliable.
        // Replay guard: a packet whose rxTime is far in the past is a replayed/
        // retained frame (e.g. an MQTT bridge re-injecting an offline node's old
        // telemetry). Omit lastHeard for those so upsertNode preserves the node's
        // existing value instead of resurrecting a dead node. See replayGuard.ts.
        lastHeard: resolveLastHeardSec(
          meshPacket.rxTime != null ? Number(meshPacket.rxTime) : undefined,
          Date.now(),
        ),
        // Update channel from every firmware-decoded packet so outbound messages (DMs,
        // traceroutes, position requests) use the channel the node is actually communicating
        // on. Previously only set from NodeInfo, which could get stuck on a secondary channel.
        ...(channelFromPacket !== undefined && { channel: channelFromPacket }),
        // Always set now (see txMech above) — an omitted key would let
        // upsertNode carry the stale value forward, which is the #4240 bug.
        transportMechanism: txMech,
        // Reuse the same resolved lastHeard so "last seen over RF" and
        // "last heard" cannot disagree (incl. the replay-guard omission case,
        // where an undefined lastHeard leaves the stamp untouched too).
        [txColumn]: resolveLastHeardSec(
          meshPacket.rxTime != null ? Number(meshPacket.rxTime) : undefined,
          Date.now(),
        ),
      };

      // Only set default name if this is a brand new node
      if (!existingNode) {
        nodeData.longName = `Node ${nodeId}`;
        nodeData.shortName = nodeId.slice(-4);
      }

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr != null && meshPacket.rxSnr !== -128) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi != null && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }
      await databaseService.upsertNodeAsync(nodeData, this.sourceId);

      // Capture server-vs-node clock offset for time-offset telemetry
      if (meshPacket.rxTime && Number(meshPacket.rxTime) > 1600000000) {
        const offset = Date.now() / 1000 - Number(meshPacket.rxTime);
        if (Math.abs(offset) < 86400) {
          this.timeOffsetSamples.push(offset);
        }
      }

      // Track message hops (hopStart - hopLimit) for "All messages" hop calculation mode.
      // hop_start is a proto3 uint32 scalar (not optional), so an unset field decodes as 0
      // — indistinguishable from "really started at 0". Require hopStart > 0 so we don't
      // record bogus 0-hop telemetry for packets where the sender never populated hop_start
      // (older firmware, some MQTT-bridged paths, transports that strip the LoRa header bits).
      const hopStart = meshPacket.hopStart ?? meshPacket.hop_start;
      const hopLimit = meshPacket.hopLimit ?? meshPacket.hop_limit;
      if (hopStart !== undefined && hopStart !== null && hopStart > 0 &&
          hopLimit !== undefined && hopLimit !== null &&
          hopStart >= hopLimit) {
        const messageHops = hopStart - hopLimit;
        await databaseService.nodes.updateNodeMessageHops(fromNum, messageHops, this.sourceId);

        // Store hop count as telemetry for Smart Hops tracking
        await databaseService.telemetry.insertTelemetry({
          nodeId: nodeId,
          nodeNum: fromNum,
          telemetryType: 'messageHops',
          timestamp: Date.now(),
          value: messageHops,
          unit: 'hops',
          createdAt: Date.now(),
          packetId: meshPacket.id ? Number(meshPacket.id) : undefined,
        }, this.sourceId);

        // Update Link Quality based on hop count comparison (skip local node — our own echoed packets aren't meaningful)
        if (!this.localNodeInfo || fromNum !== this.localNodeInfo.nodeNum) {
          this.updateLinkQualityForMessage(fromNum, messageHops);
        }
      }
    }

    // Process decoded payload if present
    if (meshPacket.decoded) {
      const portnum = meshPacket.decoded.portnum;
      // Normalize portnum to handle both string and number enum values
      const normalizedPortNum = meshtasticProtobufService.normalizePortNum(portnum);
      const payload = meshPacket.decoded.payload;

      logger.debug(`📨 Processing payload: portnum=${normalizedPortNum} (${meshtasticProtobufService.getPortNumName(portnum)}), payload size=${payload?.length || 0}`);

      if (payload && payload.length > 0 && normalizedPortNum !== undefined) {
        // Use the unified protobuf service to process the payload
        const processedPayload = meshtasticProtobufService.processPayload(normalizedPortNum, payload);

        switch (normalizedPortNum) {
          case PortNum.TEXT_MESSAGE_APP:
            // Pass decryptedBy and decryptedChannelId in context so messages can track their decryption source
            await this.processTextMessageProtobuf(meshPacket, processedPayload as string, {
              ...context,
              decryptedBy,
              decryptedChannelId: decryptedChannelId ?? undefined,
            });
            break;
          case PortNum.POSITION_APP:
            // Thread the decryption context so the position's channel resolves
            // from the channel it was decrypted on (issue #3682), matching the
            // TEXT_MESSAGE_APP path — not the raw meshPacket.channel hash.
            await this.processPositionMessageProtobuf(meshPacket, processedPayload as any, {
              ...context,
              decryptedBy,
              decryptedChannelId: decryptedChannelId ?? undefined,
            });
            break;
          case PortNum.NODEINFO_APP:
            await this.processNodeInfoMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case PortNum.PAXCOUNTER_APP:
            await this.processPaxcounterMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case PortNum.TELEMETRY_APP:
            await this.processTelemetryMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case PortNum.ROUTING_APP:
            await this.processRoutingErrorMessage(meshPacket, processedPayload as any);
            break;
          case PortNum.ADMIN_APP:
            await this.processAdminMessage(processedPayload as Uint8Array, meshPacket);
            break;
          case PortNum.NEIGHBORINFO_APP:
            await this.processNeighborInfoProtobuf(meshPacket, processedPayload as any);
            break;
          case PortNum.TRACEROUTE_APP:
            await this.processTracerouteMessage(meshPacket, processedPayload as any);
            break;
          case PortNum.STORE_FORWARD_APP:
            await this.processStoreForwardMessage(meshPacket, processedPayload as any, {
              ...context,
              decryptedBy,
              decryptedChannelId: decryptedChannelId ?? undefined,
            });
            break;
          case PortNum.WAYPOINT_APP:
            await this.processWaypointMessage(meshPacket, processedPayload as any);
            break;
          case PortNum.ATAK_PLUGIN:
            // ATAK TAKPacket (RX-only, Phase 1): GeoChat variant persists as
            // a Messages row; PLI/detail/compressed/receipts are
            // preview-only (Packet Monitor) this phase — see processTakPacket.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 decoded protobuf oneof shape (TAKPacket | raw Uint8Array); no generated TS type for protobufjs decode() output here
            await this.processTakPacket(meshPacket, processedPayload as any, {
              ...context,
              decryptedBy,
              decryptedChannelId: decryptedChannelId ?? undefined,
            });
            break;
          case PortNum.MESH_BEACON_APP: {
            // MeshBeacon (firmware 2.8+, #3854): decoded and captured in the
            // Packet Monitor (preview + full decoded payload in metadata).
            // Deliberately NOT stored as a message yet — whether beacons get a
            // dedicated view/message type is an open design question on #3854,
            // deferred until real-world 2.8 beacon traffic exists to learn from.
            const beacon = processedPayload as MeshBeaconPayload;
            logger.debug(`📡 MeshBeacon from ${meshPacket.from}: "${typeof beacon?.message === 'string' ? beacon.message : ''}" (offerChannel=${beacon?.offerChannel?.name ?? 'none'})`);
            break;
          }
          default:
            logger.debug(`🤷 Unhandled portnum: ${normalizedPortNum} (${meshtasticProtobufService.getPortNumName(portnum)})`);
        }
      }
      // Preserve the 'from' and 'to' node order for virtual node traceroute requests.
      // This ensures subsequent responses correctly correlate with this request
      // to update route and signal characteristics in the database.
      else if (normalizedPortNum === PortNum.TRACEROUTE_APP) {
        const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
        const toNum = meshPacket.to ? Number(meshPacket.to) : 0;
        const localNodeNum = this.localNodeInfo?.nodeNum;
        
        // Skip only when this is MeshMonitor's own auto-traceroute —
        // sendTraceroute() already called recordTracerouteRequestAsync() internally.
        // VN-client packets also have fromNum === localNodeNum but were never
        // pre-recorded; they arrive as incoming packets with a virtualNodeRequestId.
        const isFromLocalNode = fromNum === localNodeNum;
        const isVirtualNodePacket = !!context?.virtualNodeRequestId;

        if (!isFromLocalNode || isVirtualNodePacket) {
          await databaseService.recordTracerouteRequestAsync(fromNum, toNum, this.sourceId ?? undefined);
        }
      }
    }

  }

  /**
   * Rebuild a NodeInfo FromRadio message for `nodeNum` from the database and
   * broadcast it to this source's virtual-node clients. Used by REST handlers
   * (favorite/ignore toggles) so VN clients see updated node metadata
   * immediately. No-op if VN is not enabled for this source.
   */
  /**
   * Handle a FromRadio.ClientNotification — a message the connected node sends
   * about its own operation (duty-cycle limits, config errors, duplicate-key
   * warnings, and — on firmware 2.8 — favorite/ignore protected-node-cap
   * refusals). Two responsibilities:
   *   1. Reconcile optimistic favorite/ignore state when the device refuses at
   *      the protected-node cap: the device set NO flag, so revert ours.
   *   2. Surface the message to the UI as a toast, applying the suppression +
   *      dedupe policy so recurring/structured noise doesn't spam users.
   * See clientNotificationPolicy.ts for the rules and the 2.7.x background.
   */
  private async handleClientNotification(data: ParsedClientNotification): Promise<void> {
    // `message` is device-controlled — sanitize before logging or forwarding it.
    const message = sanitizeNotificationMessage(data.message ?? '');
    logger.debug(`🔔 [${this.sourceId}] Device notification (level ${data.level}): ${message}`);

    // (1) Reconcile a protected-node-cap refusal (firmware 2.8+). Runs
    // independently of the toast policy below. `this.sourceId` is always set
    // (constructor default 'default'), so no null-guard is needed here.
    const refusal = parseProtectedCapRefusal(message);
    if (refusal) {
      try {
        if (refusal.verb === 'favorite') {
          await databaseService.nodes.setNodeFavorite(refusal.nodeNum, false, this.sourceId);
          dataEventEmitter.emitNodeUpdate(refusal.nodeNum, { isFavorite: false }, this.sourceId);
        } else {
          await databaseService.setNodeIgnoredAsync(refusal.nodeNum, false, this.sourceId);
          dataEventEmitter.emitNodeUpdate(refusal.nodeNum, { isIgnored: false }, this.sourceId);
        }
        logger.warn(
          `🔔 [${this.sourceId}] Reverted ${refusal.verb} for node !${refusal.nodeNum
            .toString(16)
            .padStart(8, '0')} — device refused (protected-node cap full)`,
        );
      } catch (err) {
        // Revert failed — local state may now diverge from the device. We still
        // fall through and surface the warning below so the user sees the refusal.
        logger.error(`Failed to reconcile ${refusal.verb} cap refusal:`, err);
      }
    }

    // (2) Toast surfacing policy: drop noise, then dedupe recurring messages
    // per source so e.g. a per-packet duty-cycle warning toasts once per window.
    if (shouldSuppressToast({ ...data, message })) return;
    const throttleKey = `${this.sourceId}::${message}`;
    if (!this.clientNotificationThrottle.shouldEmit(throttleKey, Date.now())) return;

    dataEventEmitter.emitClientNotification(
      { level: data.level, message, replyId: data.replyId, time: data.time },
      this.sourceId,
    );
  }

  async broadcastNodeInfoUpdate(nodeNum: number): Promise<void> {
    if (!this.virtualNodeServer) return;
    try {
      const node = await databaseService.nodes.getNode(nodeNum);
      if (!node) return;
      // Honor a user-set position override when broadcasting NodeInfo so the
      // mesh sees the same coordinates the user has asserted as authoritative
      // (issue #2847).
      const effPos = getEffectiveDbNodePosition(node);
      const nodeInfoMessage = await meshtasticProtobufService.createNodeInfo({
        nodeNum: node.nodeNum,
        user: {
          id: node.nodeId,
          longName: node.longName || 'Unknown',
          shortName: node.shortName || '????',
          hwModel: node.hwModel || 0,
          role: node.role ?? undefined,
          publicKey: node.publicKey ?? undefined,
        },
        position:
          effPos.latitude != null && effPos.longitude != null
            ? {
                latitude: effPos.latitude,
                longitude: effPos.longitude,
                altitude: effPos.altitude ?? 0,
                time: node.lastHeard || Math.floor(Date.now() / 1000),
              }
            : undefined,
        deviceMetrics:
          node.batteryLevel != null ||
          node.voltage != null ||
          node.channelUtilization != null ||
          node.airUtilTx != null
            ? {
                batteryLevel: node.batteryLevel ?? undefined,
                voltage: node.voltage ?? undefined,
                channelUtilization: node.channelUtilization ?? undefined,
                airUtilTx: node.airUtilTx ?? undefined,
              }
            : undefined,
        snr: node.snr ?? undefined,
        lastHeard: node.lastHeard ?? undefined,
        hopsAway: node.hopsAway ?? undefined,
        isFavorite: (node as any).isFavorite ?? undefined,
        isIgnored: (node as any).isIgnored ?? undefined,
      });
      if (nodeInfoMessage) {
        await this.virtualNodeServer.broadcastToClients(nodeInfoMessage);
        logger.debug(`✅ Broadcasted NodeInfo update to virtual-node clients for node ${nodeNum} (source ${this.sourceId})`);
      }
    } catch (error) {
      logger.error(`⚠️ Failed to broadcast NodeInfo update for node ${nodeNum} (source ${this.sourceId}):`, error);
    }
  }

  /**
   * Ensure the `from` node row exists, and — when `toNum` is the broadcast
   * address (4294967295 / 0xFFFFFFFF) — ensure the `!ffffffff` pseudo-node
   * row exists too. Shared by processTextMessageProtobuf and processTakPacket
   * (ATAK GeoChat) so both message paths get identical endpoint bookkeeping.
   */
  private async ensureMessageEndpointNodes(fromNum: number, toNum: number): Promise<void> {
    // Ensure the from node exists in the database
    const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
    const existingFromNode = await databaseService.nodes.getNode(fromNum);
    if (!existingFromNode) {
      // Create a basic node entry if it doesn't exist
      const basicNodeData = {
        nodeNum: fromNum,
        nodeId: fromNodeId,
        longName: `Node ${fromNodeId}`,
        shortName: fromNodeId.slice(-4),
        lastHeard: Date.now() / 1000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await databaseService.upsertNodeAsync(basicNodeData, this.sourceId);
      logger.debug(`📝 Created basic node entry for ${fromNodeId}`);
    }

    if (toNum === 4294967295) {
      // For broadcast messages, we need a `!ffffffff` row in the nodes
      // table because messages.toNodeNum has a NOT NULL FK to nodes.nodeNum.
      // BUT: do NOT stamp `lastHeard` on this synthetic row. Stamping it
      // causes getActiveNodes() to return it, which the virtual node server
      // then ships to connected Meshtastic apps as a real node — see
      // issue #2602 (zombie nodes on the map). The broadcast pseudo-node
      // is not a real radio peer; it must never appear in the activity-
      // filtered node list.
      const broadcastNodeNum = 4294967295;
      const existingBroadcastNode = await databaseService.nodes.getNode(broadcastNodeNum);
      if (!existingBroadcastNode) {
        const broadcastNodeData = {
          nodeNum: broadcastNodeNum,
          nodeId: '!ffffffff',
          longName: 'Broadcast',
          shortName: 'BCAST',
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        await databaseService.upsertNodeAsync(broadcastNodeData, this.sourceId);
        logger.debug(`📝 Created broadcast node entry (no lastHeard — pseudo-node)`);
      }
    }
  }

  /**
   * Process text message using protobuf types
   */
  private async processTextMessageProtobuf(meshPacket: any, messageText: string, context?: ProcessingContext): Promise<void> {
    try {
      logger.debug(`💬 Text message: "${messageText}"`);

      if (messageText && messageText.length > 0 && messageText.length < 500) {
        const fromNum = Number(meshPacket.from);
        const toNum = Number(meshPacket.to);

        // Ensure the from node (and, for broadcast, the !ffffffff pseudo-node) exist.
        const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
        await this.ensureMessageEndpointNodes(fromNum, toNum);

        // Handle broadcast address (4294967295 = 0xFFFFFFFF)
        const actualToNum = toNum;
        const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

        // Determine if this is a direct message or a channel message
        // Direct messages (not broadcast) should use channel -1
        const isDirectMessage = toNum !== 4294967295;
        // For server-decrypted messages, use Channel Database ID + offset as the channel number
        // This allows frontend to look up the channel name from Channel Database entries
        let channelIndex: number;
        if (isDirectMessage) {
          channelIndex = -1;
        } else if (context?.decryptedBy === 'server' && context?.decryptedChannelId !== undefined) {
          // Check if the database channel's PSK matches a device channel — if so, prefer the device channel
          // This prevents database channels from "shadowing" device channels with the same key (#2375, #2413)
          const dbChannel = await databaseService.channelDatabase.getByIdAsync(context.decryptedChannelId);
          const deviceChannels = await databaseService.channels.getAllChannels(this.sourceId);
          // Match by BOTH psk AND name. Channels share PSK by default — Meshtastic
          // ships with the sentinel `AQ==` (single byte 0x01) on every preset
          // slot. Matching on PSK alone would route every default-PSK packet to
          // whatever slot scans first (typically slot 0 = primary), no matter
          // which named slot actually originated the packet. The on-wire channel
          // hash is `xorHash(name) ^ xorHash(psk)`, so name participates in the
          // identity — two slots with the same PSK but different names are
          // genuinely different channels and must not be conflated.
          const dbName = (dbChannel?.name ?? '').trim();
          const matchingDeviceChannel = dbChannel?.psk
            ? deviceChannels.find(dc =>
                dc.psk === dbChannel.psk
                && (dc.name ?? '').trim() === dbName
                && dc.role !== 0,
              )
            : null;

          if (matchingDeviceChannel) {
            // Device channel has the same PSK — use device channel slot instead of database channel
            channelIndex = matchingDeviceChannel.id;
            logger.debug(`📡 Server-decrypted message matches device channel ${matchingDeviceChannel.id} ("${matchingDeviceChannel.name}") — using device channel instead of database channel`);
          } else {
            // No matching device channel — use Channel Database ID + offset
            channelIndex = CHANNEL_DB_OFFSET + context.decryptedChannelId;
          }
        } else {
          channelIndex = meshPacket.channel !== undefined ? meshPacket.channel : 0;
        }

        // Ensure channel 0 exists if this message uses it (cached to avoid
        // repeated DB queries during config capture — up to 241 messages) (#2474)
        if (!isDirectMessage && channelIndex === 0 && !this.channel0Exists) {
          const channel0 = await databaseService.channels.getChannelById(0, this.sourceId);
          if (!channel0) {
            logger.debug('📡 Creating channel 0 for message (name will be set when device config syncs)');
            // Create with role=1 (Primary) as channel 0 is always the primary channel in Meshtastic
            await databaseService.channels.upsertChannel({ id: 0, name: '', role: 1 }, this.sourceId);
          }
          this.channel0Exists = true;
        }

        // Extract replyId and emoji from decoded Data message
        // Note: reply_id field was added in Meshtastic firmware 2.0+
        // The field is present in protobufs v2.7.11+ but may not be properly set by all app versions
        const decodedData = meshPacket.decoded as any;

        const decodedReplyId = decodedData.replyId ?? decodedData.reply_id;
        const replyId = (decodedReplyId !== undefined && decodedReplyId !== null && decodedReplyId > 0) ? decodedReplyId : undefined;
        const decodedEmoji = (meshPacket.decoded as any)?.emoji;
        const emoji = (decodedEmoji !== undefined && decodedEmoji > 0) ? decodedEmoji : undefined;

        // Extract hop fields - check both camelCase and snake_case
        // Note: hopStart is the INITIAL hop limit when message was sent, hopLimit is current remaining hops
        const hopStart = (meshPacket as any).hopStart ?? (meshPacket as any).hop_start ?? null;
        const hopLimit = (meshPacket as any).hopLimit ?? (meshPacket as any).hop_limit ?? null;

        const message: TextMessage = {
          // Prefix with sourceId so multiple sources receiving the same mesh
          // packet each get their own row (the messages PK is `id` only, not
          // composite with sourceId — without the prefix, the second source's
          // insert gets deduped away, skipping the `if (wasInserted)` branch
          // and starving checkAutoAcknowledge / auto-responder on that source).
          id: `${this.sourceId}_${fromNum}_${meshPacket.id || Date.now()}`,
          fromNodeNum: fromNum,
          toNodeNum: actualToNum,
          fromNodeId: fromNodeId,
          toNodeId: toNodeId,
          text: messageText,
          channel: channelIndex,
          portnum: PortNum.TEXT_MESSAGE_APP,
          // Server receipt time, always — matches the MQTT ingestion path
          // (mqttIngestion.ts) and the telemetry convention (raw device time
          // preserved separately, never used as the canonical `timestamp`).
          // Previously this mirrored `rxTime`, so a node with an unsynced RTC
          // (reporting seconds-since-boot instead of epoch seconds) stored an
          // implausible ~1970 value as `timestamp` too, defeating the display
          // fallback in canonicalMessageTime() (#4206).
          timestamp: Date.now(),
          // undefined (not Date.now()) when the device didn't report a time —
          // matches the MQTT ingestion convention so `rxTime` never conflates
          // "no device time" with "server time" (review follow-up on #4206).
          // Also filtered through plausibleRxTime so an unsynced-RTC node's
          // boot-uptime value never lands in the DB, matching the MQTT path
          // (mqttIngestion.ts) rather than relying solely on the display-time
          // fallback in canonicalMessageTime().
          rxTime: plausibleRxTime(meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : undefined) ?? undefined,
          hopStart: hopStart,
          hopLimit: hopLimit,
          relayNode: meshPacket.relayNode ?? undefined, // Last byte of the node that relayed this message
          replyId: replyId && replyId > 0 ? replyId : undefined,
          emoji: emoji,
          viaMqtt: meshPacket.viaMqtt === true || isViaMqtt(meshPacket.transportMechanism), // Capture whether message was received via MQTT bridge
          rxSnr: meshPacket.rxSnr ?? (meshPacket as any).rx_snr, // SNR of received packet
          rxRssi: meshPacket.rxRssi ?? (meshPacket as any).rx_rssi, // RSSI of received packet
          requestId: context?.virtualNodeRequestId, // For Virtual Node messages, preserve packet ID for ACK matching
          wantAck: context?.virtualNodeRequestId ? true : undefined, // Expect ACK for Virtual Node messages
          deliveryState: context?.virtualNodeRequestId ? 'pending' : undefined, // Track delivery for Virtual Node messages
          createdAt: Date.now(),
          decryptedBy: context?.decryptedBy ?? null, // Track decryption source - 'server' means read-only
          viaStoreForward: context?.viaStoreForward === true ? true : undefined, // Message received via Store & Forward replay
          // Inbound radio path — message arrived from a meshtastic node over TCP.
          // MQTT-bridged inbound packets are flagged via viaMqtt above; we still
          // attribute the row's ingress to 'tcp_radio' because it arrived via
          // this manager's TCP transport (the MQTT bridge path is handled in
          // mqttIngestion.ts and uses 'mqtt_bridge').
          sourceIp: null,
          sourcePath: 'tcp_radio',
          // #2584 — flag messages that claim to be from our own node but
          // arrived over RF (and weren't recently sent by us).
          spoofSuspected: this.assessLocalSpoof(meshPacket).spoofSuspected || undefined,
        };
        const wasInserted = await databaseService.messages.insertMessage(message, this.sourceId);

        if (wasInserted) {
          // Emit WebSocket event for real-time updates
          dataEventEmitter.emitNewMessage(message as any, this.sourceId);

          if (isDirectMessage) {
            logger.debug(`💾 Saved direct message from ${message.fromNodeId} to ${message.toNodeId}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
          } else {
            logger.debug(`💾 Saved channel message from ${message.fromNodeId} on channel ${channelIndex}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
          }

          // Dual-channel insertion for server-decrypted messages (#2375, #2413)
          // Messages should appear in BOTH the device channel and database channel views
          if (!isDirectMessage && context?.decryptedBy === 'server' && context?.decryptedChannelId !== undefined) {
            if (channelIndex < CHANNEL_DB_OFFSET) {
              // Primary went to device channel — also insert into database channel
              const dbChannelIndex = CHANNEL_DB_OFFSET + context.decryptedChannelId;
              const dbCopy: TextMessage = {
                ...message,
                id: `${message.id}_dbchan`,
                channel: dbChannelIndex,
                decryptedBy: 'server',
              };
              const dbInserted = await databaseService.messages.insertMessage(dbCopy, this.sourceId);
              if (dbInserted) {
                dataEventEmitter.emitNewMessage(dbCopy as any, this.sourceId);
                logger.debug(`💾 Also saved to database channel ${dbChannelIndex}`);
              }
            } else if (meshPacket.channel !== undefined) {
              // Primary went to database channel — also insert into radio channel if it exists
              const radioChannelIndex = meshPacket.channel;
              const radioChannel = await databaseService.channels.getChannelById(radioChannelIndex, this.sourceId);
              if (radioChannel) {
                const radioCopy: TextMessage = {
                  ...message,
                  id: `${message.id}_radio`,
                  channel: radioChannelIndex,
                  decryptedBy: 'server',
                };
                const radioInserted = await databaseService.messages.insertMessage(radioCopy, this.sourceId);
                if (radioInserted) {
                  dataEventEmitter.emitNewMessage(radioCopy as any, this.sourceId);
                  logger.debug(`💾 Also saved to radio channel ${radioChannelIndex} ("${radioChannel.name}")`);
                }
              }
            }
          }

          // Send push notification for new message
          await this.sendMessagePushNotification(message, messageText, isDirectMessage);

          // Auto-acknowledge matching messages
          await this.checkAutoAcknowledge(message, messageText, channelIndex, isDirectMessage, fromNum, meshPacket.id, meshPacket.rxSnr, meshPacket.rxRssi);

          // Check for auto-ping DM command (before auto-responder so it takes priority)
          if (await this.handleAutoPingCommand(message, isDirectMessage)) return;

          // Auto-respond to matching messages
          await this.checkAutoResponder(message, isDirectMessage, meshPacket.id);
        } else {
          logger.debug(`⏭️ Skipped duplicate message ${message.id} (echo from device)`);
        }
      }
    } catch (error) {
      logger.error('❌ Error processing text message:', error);
    }
  }

  /**
   * Process a decoded ATAK TAKPacket (PortNum 72 / ATAK_PLUGIN).
   *
   * Phase 1 (RX-only): only the GeoChat variant becomes a Messages row — PLI
   * (position) and `detail` (opaque bytes) are preview-only via the Packet
   * Monitor (see meshtasticProtobufService.formatTakPreview) until Phase 2
   * adds an ATAK contact table. GeoChat receipts (delivery/read acks) and
   * compressed (unishox2, out of scope) chat text are deliberately not
   * persisted either — see the edge-case table in ATAK_COT_PHASE1_SPEC.md §4.
   *
   * Reuses the text-message persistence pattern (ensureMessageEndpointNodes,
   * identical row-id format, insertMessage, emitNewMessage, push
   * notification) but — unlike processTextMessageProtobuf — deliberately
   * does NOT call checkAutoAcknowledge / handleAutoPingCommand /
   * checkAutoResponder: this is RX-only, and a plain-text auto-reply would
   * go out as a normal Meshtastic TEXT_MESSAGE_APP that the ATAK plugin
   * (which only ingests portnum 72) can't consume.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 meshPacket/tak are untyped protobuf-decoded shapes (no generated TS type for protobufjs decode() output), matching processTextMessageProtobuf's existing convention
  private async processTakPacket(meshPacket: any, tak: any, context?: ProcessingContext): Promise<void> {
    try {
      // Decode failed upstream (processPayload's outer try/catch returns the
      // raw Uint8Array) or the shape is otherwise unusable — nothing to persist.
      if (!tak || typeof tak !== 'object' || tak instanceof Uint8Array) return;

      // Only the GeoChat oneof variant becomes a message. PLI → Phase 2
      // (contacts); detail → preview-only (Packet Monitor).
      const chat = tak.chat;
      if (!chat) return;

      // Compressed strings are unishox2-encoded (out of scope this phase) —
      // don't persist garbage/undecoded text.
      if (tak.isCompressed ?? tak.is_compressed) return;

      // Receipts (delivered/read acks) must NOT surface as chat messages.
      const receiptType = Number(chat.receiptType ?? chat.receipt_type ?? 0);
      const receiptForUid = chat.receiptForUid ?? chat.receipt_for_uid;
      if (receiptType !== 0 || receiptForUid) return;

      const rawMsg = typeof chat.message === 'string' ? chat.message.trim() : '';
      if (!rawMsg) return;

      // Presentation: no callsign column on the messages table, so the ATAK
      // callsign is prefixed into `text` for provenance (spec §3).
      const callsign = tak.contact?.callsign ?? tak.contact?.deviceCallsign ?? tak.contact?.device_callsign;
      const toCallsign = chat.toCallsign ?? chat.to_callsign;
      const tag = callsign
        ? (toCallsign ? `[ATAK ${callsign}→${toCallsign}]` : `[ATAK ${callsign}]`)
        : '[ATAK]';
      const messageText = `${tag} ${rawMsg}`;

      // Routing/channel: use the Meshtastic envelope, NOT the ATAK UID
      // fields — chat.to / chat.toCallsign are ATAK UID strings, not
      // Meshtastic nodeNums, and there is no UID→node map until Phase 2.
      const fromNum = Number(meshPacket.from);
      const toNum = Number(meshPacket.to);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;
      const isDirectMessage = toNum !== 4294967295;
      const channelIndex = isDirectMessage ? -1 : (meshPacket.channel !== undefined ? meshPacket.channel : 0);

      // Ensure the from node (and, for broadcast, the !ffffffff pseudo-node) exist.
      await this.ensureMessageEndpointNodes(fromNum, toNum);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 camelCase/snake_case dual-access on an untyped protobuf-decoded meshPacket, matching processTextMessageProtobuf's existing convention
      const hopStart = (meshPacket as any).hopStart ?? (meshPacket as any).hop_start ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 camelCase/snake_case dual-access on an untyped protobuf-decoded meshPacket, matching processTextMessageProtobuf's existing convention
      const hopLimit = (meshPacket as any).hopLimit ?? (meshPacket as any).hop_limit ?? null;

      const message: TextMessage = {
        // Same format as processTextMessageProtobuf — load-bearing for
        // cross-source dedup in /api/unified/messages.
        id: `${this.sourceId}_${fromNum}_${meshPacket.id || Date.now()}`,
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId,
        toNodeId,
        text: messageText,
        channel: channelIndex,
        portnum: PortNum.ATAK_PLUGIN,
        timestamp: Date.now(),
        rxTime: plausibleRxTime(meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : undefined) ?? undefined,
        hopStart,
        hopLimit,
        relayNode: meshPacket.relayNode ?? undefined,
        viaMqtt: meshPacket.viaMqtt === true || isViaMqtt(meshPacket.transportMechanism),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 snake_case fallback on an untyped protobuf-decoded meshPacket, matching processTextMessageProtobuf's existing convention
        rxSnr: meshPacket.rxSnr ?? (meshPacket as any).rx_snr,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 snake_case fallback on an untyped protobuf-decoded meshPacket, matching processTextMessageProtobuf's existing convention
        rxRssi: meshPacket.rxRssi ?? (meshPacket as any).rx_rssi,
        createdAt: Date.now(),
        decryptedBy: context?.decryptedBy ?? null,
        sourceIp: null,
        sourcePath: 'tcp_radio',
        spoofSuspected: this.assessLocalSpoof(meshPacket).spoofSuspected || undefined,
      };

      const wasInserted = await databaseService.messages.insertMessage(message, this.sourceId);

      if (wasInserted) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 TextMessage/DbMessage shape mismatch on emit, matching processTextMessageProtobuf's existing convention
        dataEventEmitter.emitNewMessage(message as any, this.sourceId);
        if (isDirectMessage) {
          logger.debug(`💾 Saved ATAK GeoChat DM from ${message.fromNodeId} to ${message.toNodeId}: "${messageText.substring(0, 30)}..."`);
        } else {
          logger.debug(`💾 Saved ATAK GeoChat from ${message.fromNodeId} on channel ${channelIndex}: "${messageText.substring(0, 30)}..."`);
        }

        // GeoChat is a real message — send the same push notification as text.
        await this.sendMessagePushNotification(message, messageText, isDirectMessage);

        // Deliberately NO checkAutoAcknowledge / handleAutoPingCommand /
        // checkAutoResponder — RX-only (see method doc comment above).
      } else {
        logger.debug(`⏭️ Skipped duplicate ATAK GeoChat ${message.id} (echo from device)`);
      }
    } catch (error) {
      logger.error('❌ Error processing ATAK TAKPacket:', error);
    }
  }

  /**
   * Process a Store & Forward message (PortNum 65).
   * Handles replayed text, heartbeats, stats, history headers, and control messages.
   */
  private async processStoreForwardMessage(meshPacket: any, decoded: any, context?: ProcessingContext): Promise<void> {
    try {
      const rr = decoded.rr ?? decoded.requestResponse ?? 0;
      const rrName = getStoreForwardRequestResponseName(rr);
      const fromNum = Number(meshPacket.from);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;

      switch (rr) {
        case StoreForwardRequestResponse.ROUTER_TEXT_DIRECT:
        case StoreForwardRequestResponse.ROUTER_TEXT_BROADCAST: {
          // S&F server is replaying a stored text message.
          // MeshPacket.from = original sender (firmware preserves it).
          // decoded.text contains the original message bytes.
          const textBytes = decoded.text;
          if (!textBytes || textBytes.length === 0) {
            logger.debug(`📦 S&F ${rrName} from ${fromNodeId} — empty text, skipping`);
            break;
          }

          const messageText = new TextDecoder('utf-8').decode(
            textBytes instanceof Uint8Array ? textBytes : new Uint8Array(textBytes)
          );
          logger.debug(`📦 S&F ${rrName} from ${fromNodeId}: "${messageText.substring(0, 50)}"`);

          // Dedup: check if we already have this message from the original transmission.
          // The firmware preserves the original packet ID in meshPacket.id.
          const packetId = meshPacket.id;
          if (packetId) {
            const existingId = `${this.sourceId}_${fromNum}_${packetId}`;
            const existing = await databaseService.messages.getMessage(existingId);
            if (existing) {
              logger.debug(`📦 S&F replay is duplicate of existing message ${existingId}, skipping insertion`);
              break;
            }
          }

          // Feed through the standard text message pipeline.
          // The message will be stored with the original sender attribution.
          await this.processTextMessageProtobuf(meshPacket, messageText, {
            ...context,
            viaStoreForward: true,
          });
          break;
        }

        case StoreForwardRequestResponse.ROUTER_HEARTBEAT: {
          const period = decoded.heartbeat?.period ?? 0;
          const secondary = decoded.heartbeat?.secondary ?? 0;
          logger.debug(`📦 S&F heartbeat from ${fromNodeId}: period=${period}s, secondary=${secondary}`);

          // Mark this node as a Store & Forward server
          await databaseService.upsertNodeAsync({
            nodeNum: fromNum,
            nodeId: fromNodeId,
            isStoreForwardServer: true,
            lastHeard: Date.now() / 1000,
            updatedAt: Date.now(),
          }, this.sourceId);
          break;
        }

        case StoreForwardRequestResponse.ROUTER_STATS: {
          const stats = decoded.stats;
          if (stats) {
            logger.debug(`📦 S&F stats from ${fromNodeId}: total=${stats.messagesTotal ?? 0}, saved=${stats.messagesSaved ?? 0}, max=${stats.messagesMax ?? 0}, uptime=${stats.upTime ?? 0}s`);
          }
          break;
        }

        case StoreForwardRequestResponse.ROUTER_HISTORY: {
          const history = decoded.history;
          if (history) {
            logger.debug(`📦 S&F history from ${fromNodeId}: ${history.historyMessages ?? 0} messages, window=${history.window ?? 0}min`);
          }
          break;
        }

        default:
          logger.debug(`📦 S&F ${rrName} (rr=${rr}) from ${fromNodeId}`);
          break;
      }
    } catch (error) {
      logger.error('❌ Error processing Store & Forward message:', error);
    }
  }

  /**
   * Validate position coordinates.
   *
   * When the fix is position-precision obscured (both POSITION_APP and NodeInfo
   * embedded positions carry `precision_bits`), pass `precisionBits` so a
   * re-centered (0,0) fix — which arrives as `(offset, offset)` and would
   * otherwise clear the Null Island box — is still rejected (issue #3763
   * follow-up). Callers without precision omit it, preserving prior behavior.
   */
  private isValidPosition(latitude: number, longitude: number, precisionBits?: number | null): boolean {
    // Check for valid numbers
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return false;
    }
    if (!isFinite(latitude) || !isFinite(longitude)) {
      return false;
    }
    if (isNaN(latitude) || isNaN(longitude)) {
      return false;
    }

    // Check ranges
    if (latitude < -90 || latitude > 90) {
      return false;
    }
    if (longitude < -180 || longitude > 180) {
      return false;
    }

    // Reject "Null Island" (0,0) — the GPS default before a fix, with no real
    // mesh infrastructure there (issue #3763). This gate fronts both the
    // POSITION_APP path and the NodeInfo position exchange, so a bogus (0,0)
    // never reaches the node row or the position-history telemetry.
    // When precisionBits is supplied the check backs out the firmware's
    // position-precision re-centering offset first, so an obscured (0,0) fix
    // (which arrives as e.g. (0.0131, 0.0131) at 14 bits) is still caught.
    // The (0,0) discard is gated on the global `discardInvalidPositions` setting;
    // out-of-range junk is already rejected by the range checks above regardless.
    if (shouldDiscardPosition(latitude, longitude, precisionBits, getDiscardInvalidPositions())) {
      return false;
    }

    return true;
  }

  /**
   * Resolve the broadcast channel slot/index for a packet from its decryption
   * context, falling back to the raw `meshPacket.channel` only when there is no
   * server-decryption context.
   *
   * IMPORTANT: `meshPacket.channel` is the on-wire LoRa channel *hash*
   * (`xorHash(name) ^ xorHash(psk)`), NOT a channel slot index. For packets
   * decrypted server-side via a Channel Database entry it is meaningless as a
   * slot identifier (e.g. it surfaces as "channel 39" in the UI — issue #3682).
   * This mirrors exactly the channel resolution that the TEXT_MESSAGE_APP path
   * performs in {@link processTextMessageProtobuf} so every packet type shows a
   * consistent channel. Only broadcast (non-DM) packets call this.
   */
  private async resolveBroadcastChannelIndex(
    meshPacket: any,
    context?: ProcessingContext,
  ): Promise<number> {
    if (context?.decryptedBy === 'server' && context?.decryptedChannelId !== undefined) {
      // Check if the database channel's PSK matches a device channel — if so, prefer the device channel
      // This prevents database channels from "shadowing" device channels with the same key (#2375, #2413)
      const dbChannel = await databaseService.channelDatabase.getByIdAsync(context.decryptedChannelId);
      const deviceChannels = await databaseService.channels.getAllChannels(this.sourceId);
      // Match by BOTH psk AND name (see processTextMessageProtobuf for the
      // detailed rationale — the on-wire hash includes the name, so two slots
      // sharing the default PSK but differing in name are distinct channels).
      const dbName = (dbChannel?.name ?? '').trim();
      const matchingDeviceChannel = dbChannel?.psk
        ? deviceChannels.find(dc =>
            dc.psk === dbChannel.psk
            && (dc.name ?? '').trim() === dbName
            && dc.role !== 0,
          )
        : null;

      if (matchingDeviceChannel) {
        logger.debug(`📡 Server-decrypted packet matches device channel ${matchingDeviceChannel.id} ("${matchingDeviceChannel.name}") — using device channel instead of database channel`);
        return matchingDeviceChannel.id;
      }
      return CHANNEL_DB_OFFSET + context.decryptedChannelId;
    }
    // No server-decryption context: unencrypted/primary/node-decrypted packet.
    // The raw meshPacket.channel here IS a usable slot index (the device
    // populates it for firmware-decoded packets), so preserve existing behavior.
    return meshPacket.channel !== undefined ? meshPacket.channel : 0;
  }

  /**
   * Process position message using protobuf types
   */
  private async processPositionMessageProtobuf(meshPacket: any, position: any, context?: ProcessingContext): Promise<void> {
    try {
      logger.debug(`🗺️ Position message: lat=${position.latitudeI}, lng=${position.longitudeI}`);

      if (position.latitudeI && position.longitudeI) {
        // Convert coordinates from integer format to decimal degrees
        const coords = meshtasticProtobufService.convertCoordinates(position.latitudeI, position.longitudeI);

        // precision_bits is set by the sending node's firmware to reflect ITS own channel
        // precision setting. We must NOT fall back to the local channel's positionPrecision —
        // that record reflects this MeshMonitor instance's channel config, not the remote
        // node's, and using it caused accuracy boxes to all match the local node (issue #3030).
        // It is read here (before validation) so the Null Island check can back out the
        // firmware's precision re-centering offset for obscured (0,0) fixes (issue #3763).
        const precisionBits = position.precisionBits ?? position.precision_bits ?? undefined;

        // Meshtastic Position.location_source (LocSource enum): 0=UNSET, 1=MANUAL,
        // 2=INTERNAL GPS, 3=EXTERNAL GPS. Decoded off the wire but previously
        // dropped before storage (issue #4176). Surfaced in the node popups.
        const locationSource = position.locationSource ?? position.location_source ?? undefined;

        // Validate coordinates
        if (!this.isValidPosition(coords.latitude, coords.longitude, precisionBits)) {
          logger.warn(`⚠️ Invalid position coordinates: lat=${coords.latitude}, lon=${coords.longitude}. Skipping position update.`);
          return;
        }

        const fromNum = Number(meshPacket.from);
        const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
        // Use server receive time instead of packet time to avoid issues with nodes having incorrect time offsets
        const now = Date.now();
        const timestamp = now; // Store in milliseconds (Unix timestamp in ms)
        // Preserve the original packet timestamp for analysis (may be inaccurate if node has wrong time)
        const packetTimestamp = position.time ? Number(position.time) * 1000 : undefined;
        const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;

        // Resolve the channel slot from the decryption context — NOT the raw
        // meshPacket.channel, which is the on-wire LoRa hash (e.g. "channel 39")
        // for packets decrypted server-side on a secondary channel (issue #3682).
        // This mirrors the TEXT_MESSAGE_APP path so positions show the same
        // channel as text messages on the same channel. Falls back to the raw
        // meshPacket.channel only for unencrypted/primary packets.
        // (precisionBits is extracted above, before position validation.)
        const channelIndex = await this.resolveBroadcastChannelIndex(meshPacket, context);
        const gpsAccuracy = position.gpsAccuracy ?? position.gps_accuracy ?? undefined;
        const hdop = position.HDOP ?? position.hdop ?? undefined;

        // Check if this position is a response to a position exchange request
        // Position exchange uses wantResponse=true, which means the position response IS the acknowledgment
        // Look for a pending "Position exchange requested" message to this node
        const localNodeInfo = this.getLocalNodeInfo();
        if (localNodeInfo) {
          const localNodeId = `!${localNodeInfo.nodeNum.toString(16).padStart(8, '0')}`;
          const pendingMessages = await databaseService.messages.getDirectMessages(localNodeId, nodeId, 100, 0, this.sourceId) as DbMessage[]; // scoped to this manager's source (leak fix)
          const pendingExchangeRequest = pendingMessages.find((msg: DbMessage) =>
            msg.text === 'Position exchange requested' &&
            msg.fromNodeNum === localNodeInfo.nodeNum &&
            msg.toNodeNum === fromNum &&
            msg.requestId != null // Must have a requestId
          );

          if (pendingExchangeRequest && pendingExchangeRequest.requestId != null) {
            // Mark the position exchange request as delivered
            await databaseService.messages.updateMessageDeliveryState(pendingExchangeRequest.requestId!, 'delivered');
            logger.debug(`📍 Position exchange acknowledged: Received position from ${nodeId}, marking request message as delivered`);
          }
        }

        // Track PKI encryption
        await this.trackPKIEncryption(meshPacket, fromNum);

        // Lookup existing node for position-override check below. We always accept the
        // newest position packet — older "smart upgrade/downgrade" logic that held onto
        // a stored higher-precision value for up to 12 hours prevented legitimate
        // precision changes from showing up (issue #3030). The latest packet is now
        // authoritative for both lat/lon and precisionBits.
        const existingNode = await databaseService.nodes.getNode(fromNum);

        // Receive SNR + hop metadata of the packet this fix arrived in (#3492).
        // Stored on the always-present lat/lon rows; the position-history API
        // surfaces them per fix for the hover tooltip. "Directly heard" (so SNR
        // is meaningful) is hopStart === hopLimit, i.e. zero hops decremented.
        // -128 is the firmware "no SNR" sentinel; normalize it (and only it) to
        // undefined so a legitimate 0.0 dB direct-hear SNR is still recorded
        // (issue #3590). A node heard directly often reports an SNR at or near
        // 0 dB, which the old truthiness check (`snr && snr !== 0`) silently
        // dropped.
        const rawPosRxSnr = meshPacket.rxSnr ?? (meshPacket as any).rx_snr ?? undefined;
        const posRxSnr = (rawPosRxSnr != null && rawPosRxSnr !== -128) ? rawPosRxSnr : undefined;
        const posHopStart = meshPacket.hopStart ?? (meshPacket as any).hop_start ?? undefined;
        const posHopLimit = meshPacket.hopLimit ?? (meshPacket as any).hop_limit ?? undefined;

        // Always save position to telemetry table for historical tracking
        // This ensures position history is complete regardless of precision changes
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'latitude',
          timestamp, value: coords.latitude, unit: '°', createdAt: now, packetTimestamp, packetId,
          channel: channelIndex, precisionBits, gpsAccuracy,
          rxSnr: posRxSnr, hopStart: posHopStart, hopLimit: posHopLimit
        }, this.sourceId);
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'longitude',
          timestamp, value: coords.longitude, unit: '°', createdAt: now, packetTimestamp, packetId,
          channel: channelIndex, precisionBits, gpsAccuracy,
          rxSnr: posRxSnr, hopStart: posHopStart, hopLimit: posHopLimit
        }, this.sourceId);
        if (position.altitude !== undefined && position.altitude !== null) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'altitude',
            timestamp, value: position.altitude, unit: 'm', createdAt: now, packetTimestamp, packetId,
            channel: channelIndex
          }, this.sourceId);
        }

        // Store satellites in view for GPS accuracy tracking
        const satsInView = position.satsInView ?? position.sats_in_view;
        if (satsInView !== undefined && satsInView > 0) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'sats_in_view',
            timestamp, value: satsInView, unit: 'sats', createdAt: now, packetTimestamp, packetId,
            channel: channelIndex
          }, this.sourceId);
        }

        // Store ground speed if available. The firmware emits ground_speed in
        // km/h (TinyGPS++ .kmph()), not m/s as the proto comment claims (#3797).
        const groundSpeed = position.groundSpeed ?? position.ground_speed;
        if (groundSpeed !== undefined && groundSpeed > 0) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ground_speed',
            timestamp, value: groundSpeed, unit: 'km/h', createdAt: now, packetTimestamp, packetId,
            channel: channelIndex
          }, this.sourceId);
        }

        // Store ground track/heading if available (in 1/100 degrees, convert to degrees)
        const groundTrack = position.groundTrack ?? position.ground_track;
        if (groundTrack !== undefined && groundTrack > 0) {
          // groundTrack is in 1/100 degrees per protobuf spec, convert to degrees
          const headingDegrees = groundTrack / 100;
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ground_track',
            timestamp, value: headingDegrees, unit: '°', createdAt: now, packetTimestamp, packetId,
            channel: channelIndex
          }, this.sourceId);
        }

        // Skip overwriting the local node's position from mesh broadcast packets when fixedPosition is enabled.
        // When fixedPosition=true, the position is set explicitly by the user (via config or CLI).
        // The device's firmware may broadcast stale position data before the new fixed position takes effect,
        // which would otherwise overwrite the correct position in the database.
        const isLocalNode = this.localNodeInfo && fromNum === this.localNodeInfo.nodeNum;
        const hasFixedPositionEnabled = this.actualDeviceConfig?.position?.fixedPosition === true;
        if (isLocalNode && hasFixedPositionEnabled) {
          logger.debug(`🗺️ Skipping position update for local node ${nodeId}: fixedPosition is enabled, position should only be set via config. Received: ${coords.latitude}, ${coords.longitude}`);
          // Still update lastHeard and technical fields, just not lat/lon/alt
          const technicalData: any = {
            nodeNum: fromNum,
            nodeId: nodeId,
            lastHeard: Date.now() / 1000,
          };
          // -128 is the firmware "no SNR" sentinel; accept 0 dB (issue #3590).
          if (meshPacket.rxSnr != null && meshPacket.rxSnr !== -128) {
            technicalData.snr = meshPacket.rxSnr;
          }
          if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
            technicalData.rssi = meshPacket.rxRssi;
          }
          await databaseService.upsertNodeAsync(technicalData, this.sourceId);
        } else {
          const nodeData: any = {
            nodeNum: fromNum,
            nodeId: nodeId,
            latitude: coords.latitude,
            longitude: coords.longitude,
            altitude: position.altitude,
            // Cap lastHeard at current time to prevent stale timestamps from node clock issues
            lastHeard: Date.now() / 1000,
            positionChannel: channelIndex,
            positionPrecisionBits: precisionBits,
            positionGpsAccuracy: gpsAccuracy,
            positionHdop: hdop,
            positionTimestamp: now,
            positionLocationSource: locationSource
          };

          // Only include SNR/RSSI if they have valid values. -128 is the
          // firmware "no SNR" sentinel; accept a legitimate 0 dB so direct
          // hears update the node's last-known SNR (issue #3590).
          if (meshPacket.rxSnr != null && meshPacket.rxSnr !== -128) {
            nodeData.snr = meshPacket.rxSnr;
          }
          if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
            nodeData.rssi = meshPacket.rxRssi;
          }

          // Save position to nodes table (current position)
          await databaseService.upsertNodeAsync(nodeData, this.sourceId);

          // Emit node update event to notify frontend via WebSocket. When a
          // user-set override is active for this node, strip the GPS coords
          // from the payload so clients (which rebuild node.position from these
          // fields) don't overwrite the override on the map (issue #2847).
          const hasPositionOverride = existingNode?.positionOverrideEnabled === true
            && existingNode?.latitudeOverride != null
            && existingNode?.longitudeOverride != null;
          if (hasPositionOverride) {
            const { latitude: _lat, longitude: _lng, altitude: _alt, ...emitData } = nodeData;
            void _lat; void _lng; void _alt;
            dataEventEmitter.emitNodeUpdate(fromNum, emitData, this.sourceId);
          } else {
            dataEventEmitter.emitNodeUpdate(fromNum, nodeData, this.sourceId);
          }

          // Update mobility detection for this node (fire and forget)
          databaseService.updateNodeMobilityAsync(nodeId).catch(err =>
            logger.error(`Failed to update mobility for ${nodeId}:`, err)
          );

          // Check geofence triggers for this node's new position. Skip when
          // a user-set override is in effect — the override is the authoritative
          // location for that node and doesn't change with incoming packets, so
          // device GPS shouldn't drive geofence transitions (issue #2847).
          if (existingNode?.positionOverrideEnabled !== true) {
            this.checkGeofencesForNode(fromNum, coords.latitude, coords.longitude).catch(err => logger.error('Error checking geofences:', err));
          }

          logger.debug(`🗺️ Updated node position: ${nodeId} -> ${coords.latitude}, ${coords.longitude} (precision: ${precisionBits ?? 'unknown'} bits, channel: ${channelIndex})`);
        }
      }
    } catch (error) {
      logger.error('❌ Error processing position message:', error);
    }
  }

  /**
   * Legacy position message processing (for backward compatibility)
   */

  /**
   * Track PKI encryption status for a node
   */
  private async trackPKIEncryption(meshPacket: any, nodeNum: number): Promise<void> {
    if (meshPacket.pkiEncrypted || meshPacket.pki_encrypted) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      await databaseService.upsertNodeAsync({
        nodeNum,
        nodeId,
        lastPKIPacket: Date.now()
      }, this.sourceId);
      logger.debug(`🔐 PKI-encrypted packet received from ${nodeId}`);
    }
  }

  /**
   * Process user message (node info) using protobuf types
   */
  private async processNodeInfoMessageProtobuf(meshPacket: any, user: any): Promise<void> {
    try {
      logger.debug(`👤 User message for: ${user.longName}`);

      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const timestamp = Date.now();

      // Skip processing for local node echoes - the device echoes our own NodeInfo broadcasts
      // back via TCP, which would overwrite local node data with stale info or trigger false
      // key mismatch detection. Local node identity is managed via processMyNodeInfo().
      if (this.localNodeInfo && fromNum === this.localNodeInfo.nodeNum) {
        logger.debug(`👤 Skipping NodeInfo processing for local node ${nodeId} (echo of own broadcast)`);
        return;
      }

      // Track that this node is in the radio's database - receiving NodeInfo over the mesh
      // means the radio has the node's identity (and typically its public key for DMs)
      this.deviceNodeNums.add(fromNum);

      const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;
      // Channel is now updated centrally in the packet processing pipeline (processPacket),
      // so we don't set it here to avoid redundant writes and keep a single source of truth.
      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        longName: user.longName,
        shortName: user.shortName,
        hwModel: user.hwModel,
        role: user.role,
        hopsAway: meshPacket.hopsAway,
        // Use server time for lastHeard — rxTime from the device clock is unreliable.
        // Replay guard (see replayGuard.ts): omit lastHeard for replayed/retained
        // frames so a stale NodeInfo can't resurrect an offline node.
        lastHeard: resolveLastHeardSec(
          meshPacket.rxTime != null ? Number(meshPacket.rxTime) : undefined,
          Date.now(),
        ),
      };

      // Capture public key if present
      if (user.publicKey && user.publicKey.length > 0) {
        // Convert Uint8Array to base64 for storage
        nodeData.publicKey = Buffer.from(user.publicKey).toString('base64');
        nodeData.hasPKC = true;
        logger.debug(`🔐 Received NodeInfo with public key for ${nodeId} (${user.longName}): ${nodeData.publicKey.substring(0, 20)}... (${user.publicKey.length} bytes)`);

        // Check for key security issues
        const { checkLowEntropyKey } = await import('../services/lowEntropyKeyService.js');
        const isLowEntropy = checkLowEntropyKey(nodeData.publicKey, 'base64');

        if (isLowEntropy) {
          nodeData.keyIsLowEntropy = true;
          nodeData.keySecurityIssueDetails = 'Known low-entropy key detected - this key is compromised and should be regenerated';
          logger.warn(`⚠️ Low-entropy key detected for node ${nodeId} (${user.longName})!`);
        } else {
          // Explicitly clear the flag when key is NOT low-entropy
          // This ensures that if a node regenerates their key, the flag is cleared immediately
          nodeData.keyIsLowEntropy = false;
          nodeData.keySecurityIssueDetails = null;
        }

        // Check if this node had a key mismatch that is now fixed
        const existingNode = await databaseService.nodes.getNode(fromNum);

        // --- Proactive key mismatch detection ---
        let newMismatchDetected = false;

        // Detect key mismatch: incoming mesh key differs from stored key
        if (existingNode && existingNode.publicKey && nodeData.publicKey && existingNode.publicKey !== nodeData.publicKey) {
          const oldFragment = existingNode.publicKey.substring(0, 8);
          const newFragment = nodeData.publicKey.substring(0, 8);

          if (!existingNode.keyMismatchDetected) {
            // First mismatch — flag it
            logger.warn(`🔐 Key mismatch detected for node ${nodeId} (${user.longName}): stored=${oldFragment}... mesh=${newFragment}...`);

            nodeData.keyMismatchDetected = true;
            nodeData.lastMeshReceivedKey = nodeData.publicKey;
            nodeData.keySecurityIssueDetails = `Key mismatch: node broadcast key ${newFragment}... but device has ${oldFragment}...`;
            newMismatchDetected = true;

            const nodeName = user.longName || user.shortName || nodeId;
            databaseService.logKeyRepairAttemptAsync(
              fromNum, nodeName, 'mismatch', null, oldFragment, newFragment, this.sourceId
            ).catch(err => logger.error('Error logging mismatch:', err));

            dataEventEmitter.emitNodeUpdate(fromNum, {
              keyMismatchDetected: true,
              keySecurityIssueDetails: nodeData.keySecurityIssueDetails
            }, this.sourceId);

            // Immediate purge if enabled
            if (this.keyRepairEnabled && this.keyRepairImmediatePurge) {
              try {
                logger.info(`🔐 Immediate purge: removing node ${nodeName} from device database`);
                await this.sendRemoveNode(fromNum);
                databaseService.logKeyRepairAttemptAsync(
                  fromNum, nodeName, 'purge', true, oldFragment, newFragment, this.sourceId
                ).catch(err => logger.error('Error logging purge:', err));

                // Request fresh NodeInfo exchange — use channel, not DM
                // (keys are mismatched so PKI-encrypted DMs would fail)
                const nodeChannel = meshPacket.channel ?? 0;
                await this.sendNodeInfoRequest(fromNum, nodeChannel);
              } catch (error) {
                logger.error(`🔐 Immediate purge failed for ${nodeName}:`, error);
                databaseService.logKeyRepairAttemptAsync(
                  fromNum, nodeName, 'purge', false, oldFragment, newFragment, this.sourceId
                ).catch(err => logger.error('Error logging purge failure:', err));
              }
            }
          } else {
            // Already flagged from prior detection — update lastMeshReceivedKey with latest key
            nodeData.lastMeshReceivedKey = nodeData.publicKey;
            newMismatchDetected = true; // prevent existing block from clearing the flag
          }
        }

        // Clear mismatch flag when keys now match (post-purge resolution)
        // or when a new key arrives (PKI-error-based resolution)
        if (!newMismatchDetected) {
          if (existingNode && existingNode.keyMismatchDetected) {
            const oldKey = existingNode.publicKey;
            const newKey = nodeData.publicKey;

            if (oldKey !== newKey) {
              // Key has changed - the mismatch is fixed via new key
              logger.debug(`🔐 Key mismatch RESOLVED for node ${nodeId} (${user.longName}) - received new key`);
            } else {
              // Keys now match - the mismatch was fixed (e.g., device re-synced after purge)
              logger.debug(`🔐 Key mismatch RESOLVED for node ${nodeId} (${user.longName}) - keys now match`);
            }

            nodeData.keyMismatchDetected = false;
            nodeData.lastMeshReceivedKey = null;
            // Don't clear keySecurityIssueDetails if there's a low-entropy issue
            if (!isLowEntropy) {
              nodeData.keySecurityIssueDetails = null;
            }

            // Clear the repair state and log success
            void databaseService.clearKeyRepairStateAsync(fromNum);
            const nodeName = user.longName || user.shortName || nodeId;
            void databaseService.logKeyRepairAttemptAsync(fromNum, nodeName, 'fixed', true, null, null, this.sourceId);

            // Emit update to UI
            dataEventEmitter.emitNodeUpdate(fromNum, {
              keyMismatchDetected: false,
              keySecurityIssueDetails: isLowEntropy ? nodeData.keySecurityIssueDetails : undefined
            }, this.sourceId);
          }
        }
      }

      // Track if this packet was PKI encrypted (using the helper method)
      await this.trackPKIEncryption(meshPacket, fromNum);

      // Only include SNR/RSSI if they have valid values.
      // Use the firmware-sentinel check (-128 = "no SNR") rather than a truthiness
      // guard, so a legitimate 0 dB SNR from a directly-heard node is not dropped (#3590).
      if (meshPacket.rxSnr != null && meshPacket.rxSnr !== -128) {
        nodeData.snr = meshPacket.rxSnr;

        // Save SNR as telemetry if it has changed OR if 10+ minutes have passed
        // This ensures we have historical data for stable links
        const latestSnrTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'snr_local');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveSnr = !latestSnrTelemetry ||
                              latestSnrTelemetry.value !== meshPacket.rxSnr ||
                              (timestamp - latestSnrTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveSnr) {
          await databaseService.telemetry.insertTelemetry({
            nodeId,
            nodeNum: fromNum,
            telemetryType: 'snr_local',
            timestamp,
            value: meshPacket.rxSnr,
            unit: 'dB',
            createdAt: timestamp,
            packetId
          }, this.sourceId);
          const reason = !latestSnrTelemetry ? 'initial' :
                        latestSnrTelemetry.value !== meshPacket.rxSnr ? 'changed' : 'periodic';
          logger.debug(`📊 Saved local SNR telemetry: ${meshPacket.rxSnr} dB (${reason}, previous: ${latestSnrTelemetry?.value || 'N/A'})`);
        }
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;

        // Save RSSI as telemetry if it has changed OR if 10+ minutes have passed
        // This ensures we have historical data for stable links
        const latestRssiTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'rssi');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveRssi = !latestRssiTelemetry ||
                               latestRssiTelemetry.value !== meshPacket.rxRssi ||
                               (timestamp - latestRssiTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveRssi) {
          await databaseService.telemetry.insertTelemetry({
            nodeId,
            nodeNum: fromNum,
            telemetryType: 'rssi',
            timestamp,
            value: meshPacket.rxRssi,
            unit: 'dBm',
            createdAt: timestamp,
            packetId
          }, this.sourceId);
          const reason = !latestRssiTelemetry ? 'initial' :
                        latestRssiTelemetry.value !== meshPacket.rxRssi ? 'changed' : 'periodic';
          logger.debug(`📊 Saved RSSI telemetry: ${meshPacket.rxRssi} dBm (${reason}, previous: ${latestRssiTelemetry?.value || 'N/A'})`);
        }
      }

      logger.debug(`🔍 Saving node with role=${user.role}, hopsAway=${meshPacket.hopsAway}`);
      await databaseService.upsertNodeAsync(nodeData, this.sourceId);
      logger.debug(`👤 Updated user info: ${user.longName || nodeId}`);

      // Check if we should send auto-welcome message
      await this.checkAutoWelcome(fromNum, nodeId);

      // Check if we should auto-favorite this node
      await this.checkAutoFavorite(fromNum, nodeId);
    } catch (error) {
      logger.error('❌ Error processing user message:', error);
    }
  }

  /**
   * Legacy node info message processing (for backward compatibility)
   */

  /**
   * Process telemetry message using protobuf types
   */
  private async processTelemetryMessageProtobuf(meshPacket: any, telemetry: any): Promise<void> {
    try {
      logger.debug('📊 Processing telemetry message');

      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      // Use server receive time instead of packet time to avoid issues with nodes having incorrect time offsets
      const now = Date.now();
      const timestamp = now; // Store in milliseconds (Unix timestamp in ms)
      // Preserve the original packet timestamp for analysis (may be inaccurate if node has wrong time)
      const packetTimestamp = telemetry.time ? Number(telemetry.time) * 1000 : undefined;
      const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;

      // A real telemetry reply means our want_response was NOT hijacked — clear
      // any matching pending request so no auto-retry fires (issue #4210). The
      // reply's request_id echoes the original telemetry request's packet id.
      const replyRequestId = meshPacket.decoded?.requestId ? Number(meshPacket.decoded.requestId) : 0;
      if (replyRequestId) {
        this.resolvePendingTelemetryRequest(replyRequestId);
      }

      // Track PKI encryption
      await this.trackPKIEncryption(meshPacket, fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Cap lastHeard at current time to prevent stale timestamps from node clock issues
        lastHeard: Date.now() / 1000
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr != null && meshPacket.rxSnr !== -128) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi != null && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      // Handle different telemetry types
      // Note: The protobuf decoder puts variant fields directly on the telemetry object
      if (telemetry.deviceMetrics) {
        const deviceMetrics = telemetry.deviceMetrics;
        logger.debug(`📊 Device telemetry: battery=${deviceMetrics.batteryLevel}%, voltage=${deviceMetrics.voltage}V`);

        // These four are copied onto nodeData (the node-row "latest value" snapshot
        // persisted via upsertNode below), which is a separate concern from the
        // per-reading telemetry history rows that buildCanonicalMetrics extracts —
        // hence the apparent duplication.
        nodeData.batteryLevel = deviceMetrics.batteryLevel;
        nodeData.voltage = deviceMetrics.voltage;
        nodeData.channelUtilization = deviceMetrics.channelUtilization;
        nodeData.airUtilTx = deviceMetrics.airUtilTx;

        // Airtime cutoff: cache the local node's Channel Utilization so the
        // automation gate can consult it cheaply (no per-fire DB read).
        if (
          fromNum === this.localNodeInfo?.nodeNum &&
          deviceMetrics.channelUtilization !== undefined &&
          deviceMetrics.channelUtilization !== null &&
          !isNaN(deviceMetrics.channelUtilization)
        ) {
          this.localChannelUtilization = deviceMetrics.channelUtilization;
        }

        // Save all telemetry values from actual TELEMETRY_APP packets (no
        // deduplication). Normalized through the shared canonical-key path so
        // both serial and MQTT ingest write identical telemetryType/unit values.
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('device', deviceMetrics),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
      } else if (telemetry.environmentMetrics) {
        const envMetrics = telemetry.environmentMetrics;
        logger.debug(`🌡️ Environment telemetry: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);

        // Save all Environment metrics to telemetry table. buildCanonicalMetrics
        // iterates the decoded fields and normalizes each through the shared
        // canonical-key map, so the underscore-before-digit quirk (rainfall_1h /
        // rainfall_24h) and the leaf renames (relativeHumidity→humidity,
        // barometricPressure→pressure, voltage→envVoltage, current→envCurrent)
        // are handled centrally rather than with per-field fallbacks here.
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('environment', envMetrics),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
      } else if (telemetry.powerMetrics) {
        const powerMetrics = telemetry.powerMetrics;

        // Build debug string showing all available channels
        const channelInfo = [];
        for (let ch = 1; ch <= 8; ch++) {
          const voltageKey = `ch${ch}Voltage` as keyof typeof powerMetrics;
          const currentKey = `ch${ch}Current` as keyof typeof powerMetrics;
          if (powerMetrics[voltageKey] !== undefined || powerMetrics[currentKey] !== undefined) {
            channelInfo.push(`ch${ch}: ${powerMetrics[voltageKey] || 0}V/${powerMetrics[currentKey] || 0}mA`);
          }
        }
        logger.debug(`⚡ Power telemetry: ${channelInfo.join(', ')}`);

        // Save all 8 channels' voltage/current through the shared canonical path
        // (ch1Voltage … ch8Current, units V / mA from CANONICAL_TELEMETRY_UNITS).
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('power', powerMetrics),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
      } else if (telemetry.airQualityMetrics) {
        const aqMetrics = telemetry.airQualityMetrics;
        logger.debug(`🌬️ Air Quality telemetry: PM2.5=${aqMetrics.pm25Standard}µg/m³, CO2=${aqMetrics.co2}ppm`);

        // Save all AirQuality metrics to telemetry table. The particle counts
        // (particles_03um … particles_100um) hit the protobuf.js
        // underscore-before-digit quirk and stay snake_case on the decoded
        // message; buildCanonicalMetrics normalizes each decoded leaf through the
        // shared digit-aware map, so they're captured without per-field
        // `?? particles_NNum` fallbacks (and new particle bins are picked up
        // automatically once their unit is added to CANONICAL_TELEMETRY_UNITS).
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('airQuality', aqMetrics),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
      } else if (telemetry.localStats) {
        const localStats = telemetry.localStats;
        logger.debug(`📊 LocalStats telemetry: uptime=${localStats.uptimeSeconds}s, heap_free=${localStats.heapFreeBytes}B`);

        // Save all LocalStats metrics to telemetry table. localStats joins
        // STRIP_GROUPS so each leaf is stored under its bare canonical name
        // (uptimeSeconds, heapFreeBytes, noiseFloor …) — identical to the prior
        // hand-maintained list (#3515). Noise floor (dBm) was added to LocalStats
        // in Meshtastic firmware 2.7.25 (#3396).
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('localStats', localStats),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
        await this.checkAutoHeapManagement(localStats.heapFreeBytes, fromNum);
      } else if (telemetry.hostMetrics) {
        const hostMetrics = telemetry.hostMetrics;
        logger.debug(`🖥️ HostMetrics telemetry: uptime=${hostMetrics.uptimeSeconds}s, freemem=${hostMetrics.freememBytes}B`);

        // Save all HostMetrics to telemetry table. The 'host' group is prefixed
        // (uptimeSeconds → hostUptimeSeconds, load1 → hostLoad1) via PREFIX_GROUPS
        // — identical to the prior hand-maintained list (#3515).
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('host', hostMetrics),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
      } else if (telemetry.trafficManagementStats) {
        const tmStats = telemetry.trafficManagementStats;
        logger.debug(`🚦 TrafficManagementStats: inspected=${tmStats.packetsInspected}, dedup=${tmStats.positionDedupDrops}, rateLimit=${tmStats.rateLimitDrops}`);

        // The 'trafficManagement' group is prefixed (packetsInspected →
        // tmPacketsInspected) via PREFIX_GROUPS — identical to the prior
        // hand-maintained list (#3515).
        await this.saveTelemetryMetrics(
          this.buildCanonicalMetrics('trafficManagement', tmStats),
          nodeId, fromNum, timestamp, packetTimestamp, packetId
        );
      }

      await databaseService.upsertNodeAsync(nodeData, this.sourceId);
      logger.debug(`📊 Updated node telemetry and saved to telemetry table: ${nodeId}`);
    } catch (error) {
      logger.error('❌ Error processing telemetry message:', error);
    }
  }

  /**
   * Process paxcounter message
   * Paxcounter counts nearby WiFi and BLE devices
   */
  private async processPaxcounterMessageProtobuf(meshPacket: any, paxcount: any): Promise<void> {
    try {
      logger.debug('📊 Processing paxcounter message');

      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      // Use server receive time instead of packet time to avoid issues with nodes having incorrect time offsets
      const now = Date.now();
      const timestamp = now; // Store in milliseconds (Unix timestamp in ms)
      const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;

      // Track PKI encryption
      await this.trackPKIEncryption(meshPacket, fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Cap lastHeard at current time to prevent stale timestamps from node clock issues
        lastHeard: Date.now() / 1000
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr != null && meshPacket.rxSnr !== -128) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi != null && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      logger.debug(`📡 Paxcounter: wifi=${paxcount.wifi}, ble=${paxcount.ble}, uptime=${paxcount.uptime}`);

      // Save paxcounter metrics as telemetry
      if (paxcount.wifi !== undefined && paxcount.wifi !== null && !isNaN(paxcount.wifi)) {
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'paxcounterWifi',
          timestamp, value: paxcount.wifi, unit: 'devices', createdAt: now, packetId
        }, this.sourceId);
      }
      if (paxcount.ble !== undefined && paxcount.ble !== null && !isNaN(paxcount.ble)) {
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'paxcounterBle',
          timestamp, value: paxcount.ble, unit: 'devices', createdAt: now, packetId
        }, this.sourceId);
      }
      if (paxcount.uptime !== undefined && paxcount.uptime !== null && !isNaN(paxcount.uptime)) {
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'paxcounterUptime',
          timestamp, value: paxcount.uptime, unit: 's', createdAt: now, packetId
        }, this.sourceId);
      }

      await databaseService.upsertNodeAsync(nodeData, this.sourceId);
      logger.debug(`📡 Updated node with paxcounter data: ${nodeId}`);
    } catch (error) {
      logger.error('❌ Error processing paxcounter message:', error);
    }
  }

  /**
   * Process traceroute message
   */
  private async processTracerouteMessage(meshPacket: any, routeDiscovery: any): Promise<void> {
    try {
      const fromNum = Number(meshPacket.from);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const toNum = Number(meshPacket.to);
      const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

      // Determine whether this is a traceroute RESPONSE (requestId ≠ 0) or a
      // traceroute REQUEST (requestId = 0, the initiating packet).
      const tracerouteRequestId = Number(meshPacket.decoded?.requestId ?? 0);
      const isTracerouteResponse = tracerouteRequestId !== 0;

      if (!isTracerouteResponse) {
        // This is an incoming traceroute REQUEST addressed to our local node —
        // another node is discovering the path to us. Our firmware will
        // immediately send a response; we record THAT response when it arrives
        // (below). Processing the request here would save a record with the
        // wrong from/to orientation and an empty routeBack, which previously
        // caused a fictitious direct-connection line on the map. (Issue #3622)
        logger.debug(`🗺️ Skipping traceroute REQUEST from ${fromNodeId} to ${toNodeId} — will record when our response is processed`);
        return;
      }

      // When another node traceroutes us, we see our OWN outgoing response via
      // TCP before relay nodes have populated routeBack. Save the record so the
      // traceroute is visible, but skip route-segment creation — segments from
      // an empty routeBack would draw a fictitious direct line on the map.
      // (Issues #1140, #3622)
      const isLocalNodeResponse = this.localNodeInfo != null && fromNum === this.localNodeInfo.nodeNum;
      if (isLocalNodeResponse) {
        logger.debug(`🗺️ Outgoing traceroute response from local node ${fromNodeId} — will record without segments`);
      }

      logger.debug(`🗺️ Traceroute response from ${fromNodeId}:`, JSON.stringify(routeDiscovery, null, 2));

      // Ensure from node exists in database (don't overwrite existing names)
      const existingFromNode = await databaseService.nodes.getNode(fromNum);
      if (!existingFromNode) {
        await databaseService.upsertNodeAsync({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.slice(-4),
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      } else {
        // Just update lastHeard, don't touch the name
        await databaseService.upsertNodeAsync({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      }

      // Ensure to node exists in database (don't overwrite existing names)
      const existingToNode = await databaseService.nodes.getNode(toNum);
      if (!existingToNode) {
        await databaseService.upsertNodeAsync({
          nodeNum: toNum,
          nodeId: toNodeId,
          longName: `Node ${toNodeId}`,
          shortName: toNodeId.slice(-4),
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      } else {
        // Just update lastHeard, don't touch the name
        await databaseService.upsertNodeAsync({
          nodeNum: toNum,
          nodeId: toNodeId,
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      }

      // Build the route string
      const BROADCAST_ADDR = 4294967295;

      // Filter function to remove invalid/reserved node numbers from route arrays
      // These values cause issues when displayed and don't represent real nodes:
      // - 0-3: Reserved per Meshtastic protocol
      // - 255 (0xff): Reserved for broadcast in some contexts
      // - 65535 (0xffff): Invalid placeholder value reported by users (Issue #1128)
      //
      // NOTE: BROADCAST_ADDR (0xffffffff) is intentionally kept — the firmware
      // inserts it as a placeholder when a REPEATER or CLIENT_HIDDEN/relay-role
      // node refuses to add its own nodeNum to the route. Dropping it loses
      // the knowledge that a hop occurred; we render it as "Unknown" instead.
      const isValidRouteNode = (nodeNum: number): boolean => {
        if (nodeNum <= 3) return false;  // Reserved
        if (nodeNum === 255) return false;  // 0xff reserved
        if (nodeNum === 65535) return false;  // 0xffff invalid placeholder
        return true;
      };

      const rawRoute = routeDiscovery.route || [];
      const rawRouteBack = routeDiscovery.routeBack || [];
      const rawSnrTowards = routeDiscovery.snrTowards || [];
      const rawSnrBack = routeDiscovery.snrBack || [];

      // Filter route arrays and keep corresponding SNR values in sync
      const route: number[] = [];
      const snrTowards: number[] = [];
      rawRoute.forEach((nodeNum: number, index: number) => {
        if (isValidRouteNode(nodeNum)) {
          route.push(nodeNum);
          if (rawSnrTowards[index] !== undefined) {
            snrTowards.push(rawSnrTowards[index]);
          }
        }
      });

      const routeBack: number[] = [];
      const snrBack: number[] = [];
      rawRouteBack.forEach((nodeNum: number, index: number) => {
        if (isValidRouteNode(nodeNum)) {
          routeBack.push(nodeNum);
          if (rawSnrBack[index] !== undefined) {
            snrBack.push(rawSnrBack[index]);
          }
        }
      });

      // Add the final hop SNR values (from last intermediate to destination)
      // These are stored at index [route.length] in the original arrays
      if (rawSnrTowards.length > rawRoute.length) {
        snrTowards.push(rawSnrTowards[rawRoute.length]);
      }
      if (rawSnrBack.length > rawRouteBack.length) {
        snrBack.push(rawSnrBack[rawRouteBack.length]);
      }

      // Log if we filtered any invalid nodes
      if (route.length !== rawRoute.length || routeBack.length !== rawRouteBack.length) {
        logger.warn(`🗺️ Filtered invalid node numbers from traceroute: route ${rawRoute.length}→${route.length}, routeBack ${rawRouteBack.length}→${routeBack.length}`);
        logger.debug(`🗺️ Raw route: ${JSON.stringify(rawRoute)}, Filtered: ${JSON.stringify(route)}`);
        logger.debug(`🗺️ Raw routeBack: ${JSON.stringify(rawRouteBack)}, Filtered: ${JSON.stringify(routeBack)}`);
      }

      // Traceroute intermediate hops are nodes that relayed traffic on our
      // behalf but the local node never directly received a packet from them.
      //
      // Issue 2610 originally stamped a fresh `lastHeard` on these so the
      // stale-node filter would surface them on the dashboard. Issue 2602
      // showed that this same stamping leaked them to virtual node clients
      // via `sendNodeInfosFromDb`, where the connected Meshtastic app would
      // show them on the map and then fail to delete them because they do
      // not exist in the physical node's NodeDB.
      //
      // Resolution: keep the stub row so future lookups resolve a name, but
      // do NOT touch `lastHeard` — we have not directly heard from the hop.
      // `gt(lastHeard, cutoff)` excludes rows with NULL lastHeard, so the
      // node stays out of both the dashboard and the VN until a real packet
      // arrives. from/to are already handled above; skip them here to avoid
      // a redundant upsert.
      const intermediateHops = new Set<number>();
      for (const hopNum of route) intermediateHops.add(hopNum);
      for (const hopNum of routeBack) intermediateHops.add(hopNum);
      intermediateHops.delete(fromNum);
      intermediateHops.delete(toNum);
      // BROADCAST_ADDR is a firmware placeholder for a relay-role hop that
      // refused to self-identify. It is not a real node — do not create a
      // stub row for it.
      intermediateHops.delete(BROADCAST_ADDR);
      for (const hopNum of intermediateHops) {
        const hopId = `!${hopNum.toString(16).padStart(8, '0')}`;
        const existing = await databaseService.nodes.getNode(hopNum, this.sourceId ?? undefined);
        if (existing) {
          // Known node — leave it alone. Real packets from this node will
          // continue to update lastHeard via the normal processMeshPacket
          // path; we must not stamp it from a relay event.
          continue;
        }
        // Unknown hop — create a stub row with a placeholder name so future
        // lookups resolve. Real NodeInfo will overwrite the placeholder
        // fields and stamp a real lastHeard at that time.
        await databaseService.upsertNodeAsync({
          nodeNum: hopNum,
          nodeId: hopId,
          longName: `Node ${hopId}`,
          shortName: hopId.slice(-4),
        }, this.sourceId);
      }

      // All node lookups in traceroute processing are scoped to this
      // manager's source so name/position data matches the mesh the
      // traceroute came from — otherwise a second source's stale row could
      // corrupt the rendered route text and the persisted routePositions
      // snapshot.
      const tracerouteScopeSourceId = this.sourceId ?? undefined;
      const fromNode = await databaseService.nodes.getNode(fromNum, tracerouteScopeSourceId);
      const fromName = fromNode?.longName || fromNodeId;

      // Get distance unit from settings (default to km)
      const distanceUnit = (await databaseService.settings.getSetting('distanceUnit') || 'km') as 'km' | 'mi';

      let routeText = `📍 Traceroute to ${fromName} (${fromNodeId})\n\n`;
      let totalDistanceKm = 0;

      // Helper function to calculate and format distance
      const calcDistance = async (node1Num: number, node2Num: number): Promise<string | null> => {
        const n1 = await databaseService.nodes.getNode(node1Num, tracerouteScopeSourceId);
        const n2 = await databaseService.nodes.getNode(node2Num, tracerouteScopeSourceId);
        if (n1?.latitude && n1?.longitude && n2?.latitude && n2?.longitude) {
          const distKm = calculateDistance(n1.latitude, n1.longitude, n2.latitude, n2.longitude);
          totalDistanceKm += distKm;
          if (distanceUnit === 'mi') {
            const distMi = distKm * 0.621371;
            return `${distMi.toFixed(1)} mi`;
          }
          return `${distKm.toFixed(1)} km`;
        }
        return null;
      };

      // Handle direct connection (0 hops)
      if (route.length === 0 && snrTowards.length > 0) {
        const snr = (snrTowards[0] / 4).toFixed(1);
        const toNode = await databaseService.nodes.getNode(toNum, tracerouteScopeSourceId);
        const toName = toNode?.longName || toNodeId;
        const dist = await calcDistance(toNum, fromNum);
        routeText += `Forward path:\n`;
        routeText += `  1. ${toName} (${toNodeId})\n`;
        if (dist) {
          routeText += `  2. ${fromName} (${fromNodeId}) - SNR: ${snr}dB, Distance: ${dist}\n`;
        } else {
          routeText += `  2. ${fromName} (${fromNodeId}) - SNR: ${snr}dB\n`;
        }
      } else if (route.length > 0) {
        const toNode = await databaseService.nodes.getNode(toNum, tracerouteScopeSourceId);
        const toName = toNode?.longName || toNodeId;
        routeText += `Forward path (${route.length + 2} nodes):\n`;

        // Start with source node
        routeText += `  1. ${toName} (${toNodeId})\n`;

        // Build full path to calculate distances
        const fullPath = [toNum, ...route, fromNum];

        // Show intermediate hops
        for (let index = 0; index < route.length; index++) {
          const nodeNum = route[index];
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const node = await databaseService.nodes.getNode(nodeNum, tracerouteScopeSourceId);
          const nodeName = nodeNum === BROADCAST_ADDR ? '(unknown)' : (node?.longName || nodeId);
          const rawSnr = snrTowards[index];
          const snr = rawSnr === undefined ? 'N/A' : rawSnr === -128 ? '?' : `${(rawSnr / 4).toFixed(1)}dB`;
          const dist = await calcDistance(fullPath[index], nodeNum);
          if (dist) {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}, Distance: ${dist}\n`;
          } else {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}\n`;
          }
        }

        // Show destination with final hop SNR and distance
        const finalSnrIndex = route.length;
        const prevNodeNum = route.length > 0 ? route[route.length - 1] : toNum;
        const finalDist = await calcDistance(prevNodeNum, fromNum);
        if (snrTowards[finalSnrIndex] !== undefined) {
          const finalSnr = (snrTowards[finalSnrIndex] / 4).toFixed(1);
          if (finalDist) {
            routeText += `  ${route.length + 2}. ${fromName} (${fromNodeId}) - SNR: ${finalSnr}dB, Distance: ${finalDist}\n`;
          } else {
            routeText += `  ${route.length + 2}. ${fromName} (${fromNodeId}) - SNR: ${finalSnr}dB\n`;
          }
        } else {
          if (finalDist) {
            routeText += `  ${route.length + 2}. ${fromName} (${fromNodeId}) - Distance: ${finalDist}\n`;
          } else {
            routeText += `  ${route.length + 2}. ${fromName} (${fromNodeId})\n`;
          }
        }
      }

      // Track total distance for return path separately
      let returnTotalDistanceKm = 0;
      const calcDistanceReturn = async (node1Num: number, node2Num: number): Promise<string | null> => {
        const n1 = await databaseService.nodes.getNode(node1Num, tracerouteScopeSourceId);
        const n2 = await databaseService.nodes.getNode(node2Num, tracerouteScopeSourceId);
        if (n1?.latitude && n1?.longitude && n2?.latitude && n2?.longitude) {
          const distKm = calculateDistance(n1.latitude, n1.longitude, n2.latitude, n2.longitude);
          returnTotalDistanceKm += distKm;
          if (distanceUnit === 'mi') {
            const distMi = distKm * 0.621371;
            return `${distMi.toFixed(1)} mi`;
          }
          return `${distKm.toFixed(1)} km`;
        }
        return null;
      };

      if (routeBack.length === 0 && snrBack.length > 0) {
        const snr = (snrBack[0] / 4).toFixed(1);
        const toNode = await databaseService.nodes.getNode(toNum, tracerouteScopeSourceId);
        const toName = toNode?.longName || toNodeId;
        const dist = await calcDistanceReturn(fromNum, toNum);
        routeText += `\nReturn path:\n`;
        routeText += `  1. ${fromName} (${fromNodeId})\n`;
        if (dist) {
          routeText += `  2. ${toName} (${toNodeId}) - SNR: ${snr}dB, Distance: ${dist}\n`;
        } else {
          routeText += `  2. ${toName} (${toNodeId}) - SNR: ${snr}dB\n`;
        }
      } else if (routeBack.length > 0) {
        const toNode = await databaseService.nodes.getNode(toNum, tracerouteScopeSourceId);
        const toName = toNode?.longName || toNodeId;
        routeText += `\nReturn path (${routeBack.length + 2} nodes):\n`;

        // Start with source (destination of forward path)
        routeText += `  1. ${fromName} (${fromNodeId})\n`;

        // Build full return path
        const fullReturnPath = [fromNum, ...routeBack, toNum];

        // Show intermediate hops
        for (let index = 0; index < routeBack.length; index++) {
          const nodeNum = routeBack[index];
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const node = await databaseService.nodes.getNode(nodeNum, tracerouteScopeSourceId);
          const nodeName = nodeNum === BROADCAST_ADDR ? '(unknown)' : (node?.longName || nodeId);
          const rawSnr = snrBack[index];
          const snr = rawSnr === undefined ? 'N/A' : rawSnr === -128 ? '?' : `${(rawSnr / 4).toFixed(1)}dB`;
          const dist = await calcDistanceReturn(fullReturnPath[index], nodeNum);
          if (dist) {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}, Distance: ${dist}\n`;
          } else {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}\n`;
          }
        }

        // Show final destination with SNR and distance
        const finalSnrIndex = routeBack.length;
        const prevNodeNum = routeBack.length > 0 ? routeBack[routeBack.length - 1] : fromNum;
        const finalDist = await calcDistanceReturn(prevNodeNum, toNum);
        if (snrBack[finalSnrIndex] !== undefined) {
          const finalSnr = (snrBack[finalSnrIndex] / 4).toFixed(1);
          if (finalDist) {
            routeText += `  ${routeBack.length + 2}. ${toName} (${toNodeId}) - SNR: ${finalSnr}dB, Distance: ${finalDist}\n`;
          } else {
            routeText += `  ${routeBack.length + 2}. ${toName} (${toNodeId}) - SNR: ${finalSnr}dB\n`;
          }
        } else {
          if (finalDist) {
            routeText += `  ${routeBack.length + 2}. ${toName} (${toNodeId}) - Distance: ${finalDist}\n`;
          } else {
            routeText += `  ${routeBack.length + 2}. ${toName} (${toNodeId})\n`;
          }
        }
      }

      // Add total distance summary
      if (totalDistanceKm > 0) {
        if (distanceUnit === 'mi') {
          const totalMi = totalDistanceKm * 0.621371;
          routeText += `\n📏 Total Forward Distance: ${totalMi.toFixed(1)} mi`;
        } else {
          routeText += `\n📏 Total Forward Distance: ${totalDistanceKm.toFixed(1)} km`;
        }
      }
      if (returnTotalDistanceKm > 0) {
        if (distanceUnit === 'mi') {
          const totalMi = returnTotalDistanceKm * 0.621371;
          routeText += ` | Return: ${totalMi.toFixed(1)} mi\n`;
        } else {
          routeText += ` | Return: ${returnTotalDistanceKm.toFixed(1)} km\n`;
        }
      } else if (totalDistanceKm > 0) {
        routeText += `\n`;
      }

      // Traceroute responses are direct messages, not channel messages
      const isDirectMessage = toNum !== 4294967295;
      const channelIndex = isDirectMessage ? -1 : (meshPacket.channel !== undefined ? meshPacket.channel : 0);
      // A node with a wrong/ahead RTC reports an `rxTime` in the future. We just
      // received the packet, so the traceroute can't have happened later than
      // now — cap the device time at `Date.now()` so "last traced" never renders
      // a negative "X minutes ago" (#2768). A legitimately slightly-past rxTime
      // still passes through. (lastHeard/telemetry already use server time for
      // the same reason — see replayGuard.ts.)
      const timestamp = meshPacket.rxTime
        ? Math.min(Number(meshPacket.rxTime) * 1000, Date.now())
        : Date.now();

      // Save as a special message in the database
      // Use meshPacket.id for deduplication (same as text messages)
      const message = {
        // Prefix with sourceId so each source stores its own copy (see
        // text-message insert above for the dedup-vs-PK rationale).
        id: `traceroute_${this.sourceId}_${fromNum}_${meshPacket.id || Date.now()}`,
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        text: routeText,
        channel: channelIndex,
        portnum: PortNum.TRACEROUTE_APP,
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: Date.now(),
        // Inbound traceroute response from a meshtastic node over TCP.
        sourceIp: null,
        sourcePath: 'tcp_radio' as const,
      };

      const wasInserted = await databaseService.messages.insertMessage(message, this.sourceId);

      // Emit WebSocket event for traceroute message only if actually new
      if (wasInserted) {
        dataEventEmitter.emitNewMessage(message as any, this.sourceId);
      }

      logger.debug(`💾 Saved traceroute result from ${fromNodeId} (channel: ${channelIndex})`);

      // Build position snapshot for all nodes in the traceroute path (Issue #1862)
      // This captures where each node was at traceroute time so historical traceroutes
      // render correctly even when nodes move
      const routePositions: Record<number, { lat: number; lng: number; alt?: number }> = {};
      const allPathNodes = [toNum, ...route, fromNum];
      const allBackNodes = routeBack || [];
      const allUniqueNodes = [...new Set([...allPathNodes, ...allBackNodes])];

      for (const nodeNum of allUniqueNodes) {
        const node = await databaseService.nodes.getNode(nodeNum, tracerouteScopeSourceId);
        // Snapshot the effective position so historical traceroute renders
        // anchor on the user-set override when one is configured (issue #2847).
        const eff = getEffectiveDbNodePosition(node);
        if (eff.latitude != null && eff.longitude != null) {
          routePositions[nodeNum] = {
            lat: eff.latitude,
            lng: eff.longitude,
            ...(eff.altitude != null ? { alt: eff.altitude } : {}),
          };
        }
      }

      // Save to traceroutes table (save raw data including broadcast addresses)
      // Store traceroute data exactly as Meshtastic provides it (no transformations)
      // fromNodeNum = responder (remote), toNodeNum = requester (local)
      // route = intermediate hops from requester toward responder
      // routeBack = intermediate hops from responder toward requester
      const tracerouteRecord = {
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        route: JSON.stringify(route),
        routeBack: JSON.stringify(routeBack),
        snrTowards: JSON.stringify(snrTowards),
        snrBack: JSON.stringify(snrBack),
        routePositions: JSON.stringify(routePositions),
        channel: channelIndex >= 0 ? channelIndex : null,
        packetId: meshPacket.id != null ? Number(meshPacket.id) : null,
        timestamp: timestamp,
        createdAt: Date.now()
      };

      // Use DatabaseService.insertTracerouteAsync() (not repo directly) for deduplication:
      // It checks for pending traceroute requests and updates them instead of inserting duplicates
      await databaseService.insertTracerouteAsync(tracerouteRecord, this.sourceId ?? undefined);

      // Store traceroute hop count as telemetry for Smart Hops tracking
      // Hop count is route.length + 1 (intermediate hops + final hop to destination)
      const tracerouteHops = route.length + 1;
      await databaseService.telemetry.insertTelemetry({
        nodeId: fromNodeId,
        nodeNum: fromNum,
        telemetryType: 'messageHops',
        timestamp: Date.now(),
        value: tracerouteHops,
        unit: 'hops',
        createdAt: Date.now(),
        packetId: meshPacket.id ? Number(meshPacket.id) : undefined,
      }, this.sourceId);

      // Emit WebSocket event for traceroute completion
      dataEventEmitter.emitTracerouteComplete(tracerouteRecord as any, this.sourceId);

      logger.debug(`💾 Saved traceroute record to traceroutes table`);

      // If this was an auto-traceroute, mark it as successful in the log
      if (this.pendingAutoTraceroutes.has(fromNum)) {
        await databaseService.updateAutoTracerouteResultByNodeAsync(fromNum, true);
        this.pendingAutoTraceroutes.delete(fromNum);
        this.pendingTracerouteTimestamps.delete(fromNum); // Clear timeout tracking
        logger.debug(`🗺️ Auto-traceroute to ${fromNodeId} marked as successful`);
      }

      // If this was an autoresponder-initiated traceroute, send a compact reply
      if (this.pendingAutoresponderTraceroutes.has(fromNum)) {
        const pending = this.pendingAutoresponderTraceroutes.get(fromNum)!;
        clearTimeout(pending.timeoutHandle);
        this.pendingAutoresponderTraceroutes.delete(fromNum);

        // Build compact route string using short names (must fit within 200 bytes)
        const fromNode = await databaseService.nodes.getNode(fromNum, tracerouteScopeSourceId);
        const fromShort = fromNode?.shortName || fromNodeId.slice(-4);
        const localShort = this.localNodeInfo?.shortName || 'ME';

        let compactPath = localShort;
        for (const hopNum of route) {
          const hopNode = await databaseService.nodes.getNode(hopNum, tracerouteScopeSourceId);
          compactPath += '>' + (hopNode?.shortName || `!${hopNum.toString(16).slice(-4)}`);
        }
        compactPath += '>' + fromShort;

        const hopCount = route.length + 1;
        const compactMsg = `Trace to ${fromShort}: ${compactPath} (${hopCount} hop${hopCount !== 1 ? 's' : ''})`;

        this.messageQueue.enqueue(
          this.truncateMessageForMeshtastic(compactMsg, 200),
          pending.isDM ? pending.replyToNodeNum : 0,
          undefined,
          () => { logger.debug(`✅ Autoresponder traceroute result reply delivered`); },
          (reason: string) => { logger.warn(`❌ Autoresponder traceroute result reply failed: ${reason}`); },
          pending.isDM ? undefined : pending.replyChannel,
          1
        );
        logger.debug(`🔍 Autoresponder traceroute result for ${fromNodeId} replied to !${pending.replyToNodeNum.toString(16).padStart(8, '0')}`);
      }

      // Send notification for successful traceroute
      this.getSourceName()
        .then(sourceName => notificationService.notifyTraceroute(fromNodeId, toNodeId, routeText, this.sourceId, sourceName))
        .catch(err => logger.error('Failed to send traceroute notification:', err));

      // Calculate and store route segment distances, and estimate positions for nodes without GPS.
      // Guard: skip segment creation when the return path has not been populated yet. Two conditions
      // cover this:
      //   1. isLocalNodeResponse — our own outgoing response seen before relay nodes fill routeBack.
      //   2. routeBack and snrBack both empty — catches the same state even when localNodeInfo is
      //      null (e.g. connection not yet fully initialized), closing a pre-existing race window.
      // Either condition is sufficient; both are checked for defence-in-depth. (Issues #1140, #3622)
      const isEmptyReturnPath = routeBack.length === 0 && snrBack.length === 0;
      if (!isLocalNodeResponse && isEmptyReturnPath) {
        logger.debug(`🗺️ Skipping segment creation — empty return path from remote node ${fromNodeId} (old firmware or unresolved path)`);
      }
      if (!isLocalNodeResponse && !isEmptyReturnPath) try {
        // Build the full route path: toNode (requester) -> route intermediates -> fromNode (responder)
        // route contains intermediate hops from requester toward responder
        // So the full path is: requester -> route[0] -> route[1] -> ... -> route[N-1] -> responder
        const fullRoute = [toNum, ...route, fromNum];

        // Calculate distance for each consecutive pair of nodes
        for (let i = 0; i < fullRoute.length - 1; i++) {
          const node1Num = fullRoute[i];
          const node2Num = fullRoute[i + 1];

          // Scope node lookups to this manager's source so route segment
          // positions are computed from the correct per-source copy of each
          // node — otherwise a second source's stale position could produce
          // bogus distances for segments belonging to this source's traceroute.
          const node1 = await databaseService.nodes.getNode(node1Num, this.sourceId ?? undefined);
          const node2 = await databaseService.nodes.getNode(node2Num, this.sourceId ?? undefined);

          // Only calculate if both nodes have position data
          if (node1?.latitude && node1?.longitude && node2?.latitude && node2?.longitude) {
            const distanceKm = calculateDistance(
              node1.latitude,
              node1.longitude,
              node2.latitude,
              node2.longitude
            );

            const node1Id = `!${node1Num.toString(16).padStart(8, '0')}`;
            const node2Id = `!${node2Num.toString(16).padStart(8, '0')}`;

            // Store the segment with position snapshot (Issue #1862)
            const segment = {
              fromNodeNum: node1Num,
              toNodeNum: node2Num,
              fromNodeId: node1Id,
              toNodeId: node2Id,
              distanceKm: distanceKm,
              isRecordHolder: false,
              fromLatitude: node1.latitude,
              fromLongitude: node1.longitude,
              toLatitude: node2.latitude,
              toLongitude: node2.longitude,
              timestamp: timestamp,
              createdAt: Date.now()
            };

            await databaseService.traceroutes.insertRouteSegment(segment, this.sourceId ?? undefined);

            // Check if this is a new record holder (per-source)
            await databaseService.updateRecordHolderSegmentAsync(segment, this.sourceId ?? undefined);

            logger.debug(`📏 Stored route segment: ${node1Id} -> ${node2Id}, distance: ${distanceKm.toFixed(2)} km`);
          }
        }

        // Position estimation no longer happens here. It runs as a global,
        // scheduled batch job (positionEstimationScheduler) that pools traceroute
        // + neighbor observations across ALL Meshtastic sources (incl. MQTT).
        // See issue #3271. This handler just persists the traceroute the batch
        // job reads (done above via insertTraceroute/updateTracerouteResponse).
      } catch (error) {
        logger.error('❌ Error calculating route segment distances:', error);
      }
    } catch (error) {
      logger.error('❌ Error processing traceroute message:', error);
    }
  }

  /**
   * Process routing error messages to track message delivery failures
   */
  private async processRoutingErrorMessage(meshPacket: any, routing: any): Promise<void> {
    try {
      const fromNum = Number(meshPacket.from);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const errorReason = routing.error_reason || routing.errorReason;
      // Use decoded.requestId which contains the ID of the original message that was ACK'd/failed
      const requestId = meshPacket.decoded?.requestId;

      const errorName = getRoutingErrorName(errorReason);

      // Resolve any pending admin-command ACK waiter (issue #2608 follow-up).
      // Admin packets set want_response, so the destination node returns a
      // Routing ACK with request_id === our sent packet id. Consume it here so
      // it doesn't fall through to message-delivery handling (admin commands
      // aren't stored in the messages table).
      if (requestId && this.adminTransactionService.hasPending(requestId)) {
        if (this.adminTransactionService.resolveByRequestId(requestId, fromNum, errorReason)) {
          return;
        }
      }

      // Check if this routing update is for an auto-ping session. Pass the
      // emitting node + error_reason through so the handler can distinguish a
      // real end-to-end ACK (from the destination) from the local transmit ACK
      // and from a delivery-failure NAK — see handleAutoPingResponse.
      if (requestId) {
        // errorReason is 0 (NONE) on success; non-zero — or absent — is a failure.
        const reason = typeof errorReason === 'number' ? errorReason : 1;
        this.handleAutoPingResponse(requestId, fromNum, reason);
      }

      // Handle successful ACKs (error_reason = 0 means success)
      if (errorReason === 0 && requestId) {
        // Look up the original message to check if this ACK is from the intended recipient
        const originalMessage = await databaseService.getMessageByRequestIdAsync(requestId);

        if (originalMessage) {
          const targetNodeId = originalMessage.toNodeId;
          const localNodeId = this.localNodeInfo?.nodeId ?? await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeId'));
          const isDM = originalMessage.channel === -1;

          // ACK from our own radio - message transmitted to mesh
          if (fromNodeId === localNodeId) {
            logger.debug(`📡 ACK from our own radio ${fromNodeId} for requestId ${requestId} - message transmitted to mesh`);
            const updated = await databaseService.messages.updateMessageDeliveryState(requestId, 'delivered');
            if (updated) {
              logger.debug(`💾 Marked message ${requestId} as delivered (transmitted)`);
              // Update message timestamps to node time so outgoing messages sort correctly
              // relative to incoming messages (which use node rxTime)
              const ackRxTime = Number(meshPacket.rxTime);
              if (ackRxTime > 0) {
                await databaseService.messages.updateMessageTimestamps(requestId, ackRxTime * 1000);
                logger.debug(`🕐 Updated message ${requestId} timestamps to node time: ${ackRxTime}`);
              }
              // Emit WebSocket event for real-time delivery status update
              dataEventEmitter.emitRoutingUpdate({ requestId, status: 'ack' }, this.sourceId);
            }
            return;
          }

          // ACK from target node - message confirmed received by recipient (only for DMs)
          if (fromNodeId === targetNodeId && isDM) {
            logger.debug(`✅ ACK received from TARGET node ${fromNodeId} for requestId ${requestId} - message confirmed`);
            const updated = await databaseService.messages.updateMessageDeliveryState(requestId, 'confirmed');
            if (updated) {
              logger.debug(`💾 Marked message ${requestId} as confirmed (received by target)`);
              // Emit WebSocket event for real-time delivery status update
              dataEventEmitter.emitRoutingUpdate({ requestId, status: 'ack' }, this.sourceId);
            }
            // Notify message queue service of successful ACK
            this.messageQueue.handleAck(requestId);
          } else if (fromNodeId === targetNodeId && !isDM) {
            logger.debug(`📢 ACK from ${fromNodeId} for channel message ${requestId} (already marked as delivered)`);
          } else {
            logger.warn(`⚠️  ACK from ${fromNodeId} but message was sent to ${targetNodeId} - ignoring (intermediate node)`);
          }
        } else {
          logger.debug(`⚠️  Could not find original message with requestId ${requestId}`);
        }
        return;
      }

      // Handle actual routing errors
      logger.warn(`📮 Routing error from ${fromNodeId}: ${errorName} (${errorReason}), requestId: ${requestId}`);
      logger.debug('Routing error details:', {
        from: fromNodeId,
        to: meshPacket.to ? `!${Number(meshPacket.to).toString(16).padStart(8, '0')}` : 'unknown',
        errorReason: errorName,
        requestId: requestId,
        route: routing.route || []
      });

      // Look up the original message once for all error handling
      const originalMessage = requestId ? await databaseService.getMessageByRequestIdAsync(requestId) : null;
      if (!originalMessage) {
        // No message record found — could be a NodeInfo/telemetry/position request that
        // isn't stored in the messages table. Still check for key mismatch errors using
        // the packet's destination field.
        const localNodeId = this.localNodeInfo?.nodeId ?? await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeId'));
        const toNum = meshPacket.to ? Number(meshPacket.to) : null;

        if (toNum && toNum !== 0xFFFFFFFF) {
          const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

          // PKI errors from our local node (couldn't encrypt to target)
          // Skip if target is our own node — can't have a key mismatch with ourselves
          if (isPkiError(errorReason) && fromNodeId === localNodeId && toNodeId !== localNodeId) {
            const errorDescription = errorReason === RoutingError.PKI_FAILED
              ? 'PKI encryption failed — your radio\'s stored key for this node may be outdated. Click "Exchange Node Info" to re-sync keys with the radio.'
              : 'Your radio does not have this node\'s public key (even though MeshMonitor does). Click "Exchange Node Info" to push the key to your radio, or purge the node to force a fresh key exchange.';

            logger.warn(`🔐 PKI error on request for node ${toNodeId}: ${errorDescription}`);

            await databaseService.upsertNodeAsync({
              nodeNum: toNum,
              nodeId: toNodeId,
              keyMismatchDetected: true,
              keySecurityIssueDetails: errorDescription
            }, this.sourceId);
            dataEventEmitter.emitNodeUpdate(toNum, { keyMismatchDetected: true, keySecurityIssueDetails: errorDescription }, this.sourceId);
            this.handlePkiError(toNum);
          }

          // NO_CHANNEL from the target node (it couldn't decrypt our request)
          // Skip if the target is our own local node — we can't have a key mismatch with ourselves
          if (errorReason === RoutingError.NO_CHANNEL && fromNodeId === toNodeId && toNodeId !== localNodeId) {
            const existingNode = await databaseService.nodes.getNode(toNum);
            if (!existingNode?.keyMismatchDetected) {
              const errorDescription = 'NO_CHANNEL error on request - target node rejected the message. ' +
                'Possible key or channel mismatch. Use "Exchange Node Info" or purge node data to refresh keys.';

              logger.warn(`🔐 NO_CHANNEL on request detected for node ${toNodeId}: ${errorDescription}`);

              await databaseService.upsertNodeAsync({
                nodeNum: toNum,
                nodeId: toNodeId,
                keyMismatchDetected: true,
                keySecurityIssueDetails: errorDescription
              }, this.sourceId);
              dataEventEmitter.emitNodeUpdate(toNum, { keyMismatchDetected: true, keySecurityIssueDetails: errorDescription }, this.sourceId);
            }
          }
        }

        logger.debug(`⚠️  Routing error for requestId ${requestId} (no message record - likely a request packet)`);
        return;
      }

      const targetNodeId = originalMessage.toNodeId;
      const localNodeId = this.localNodeInfo?.nodeId ?? await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeId'));
      const isDM = originalMessage.channel === -1;

      // Detect PKI/encryption errors and flag the target node
      // Only flag if the error is from our local radio (we couldn't encrypt to target)
      // Skip if target is our own node — can't have a key mismatch with ourselves
      if (isPkiError(errorReason) && fromNodeId === localNodeId && targetNodeId !== localNodeId) {
        if (originalMessage.toNodeNum) {
          const targetNodeNum = originalMessage.toNodeNum;

          const errorDescription = errorReason === RoutingError.PKI_FAILED
            ? 'PKI encryption failed — your radio\'s stored key for this node may be outdated. Click "Exchange Node Info" to re-sync keys with the radio.'
            : 'Your radio does not have this node\'s public key (even though MeshMonitor does). Click "Exchange Node Info" to push the key to your radio, or purge the node to force a fresh key exchange.';

          logger.warn(`🔐 PKI error detected for node ${targetNodeId}: ${errorDescription}`);

          await databaseService.upsertNodeAsync({
            nodeNum: targetNodeNum,
            nodeId: targetNodeId,
            keyMismatchDetected: true,
            keySecurityIssueDetails: errorDescription
          }, this.sourceId);

          dataEventEmitter.emitNodeUpdate(targetNodeNum, { keyMismatchDetected: true, keySecurityIssueDetails: errorDescription }, this.sourceId);
          this.handlePkiError(targetNodeNum);
        }
      }

      // Detect NO_CHANNEL errors on DMs from the target node — this can indicate a
      // key/channel mismatch where the firmware used the wrong encryption context.
      // Flag it for Auto Key Management to attempt repair via NodeInfo exchange.
      if (errorReason === RoutingError.NO_CHANNEL && isDM && fromNodeId === targetNodeId && targetNodeId !== localNodeId) {
        if (originalMessage.toNodeNum) {
          const targetNodeNum = originalMessage.toNodeNum;
          const errorDescription = 'NO_CHANNEL error on DM - target node rejected the message. ' +
            'Possible key or channel mismatch. Use "Exchange Node Info" or purge node data to refresh keys.';

          logger.warn(`🔐 NO_CHANNEL on DM detected for node ${targetNodeId}: ${errorDescription}`);

          // Flag the node with the key security issue (if not already flagged)
          const existingNode = await databaseService.nodes.getNode(targetNodeNum);
          if (!existingNode?.keyMismatchDetected) {
            await databaseService.upsertNodeAsync({
              nodeNum: targetNodeNum,
              nodeId: targetNodeId,
              keyMismatchDetected: true,
              keySecurityIssueDetails: errorDescription
            }, this.sourceId);

            // Emit event to notify UI of the key issue
            dataEventEmitter.emitNodeUpdate(targetNodeNum, { keyMismatchDetected: true, keySecurityIssueDetails: errorDescription }, this.sourceId);
          }
        }
      }

      // For DMs, only mark as failed if the routing error comes from the target node
      // Intermediate nodes may report errors (e.g., NO_CHANNEL) but the message might have
      // reached the target via a different route
      if (isDM && fromNodeId !== targetNodeId) {
        logger.debug(`⚠️  Ignoring routing error from intermediate node ${fromNodeId} for DM to ${targetNodeId}`);
        return;
      }

      // Update message in database to mark delivery as failed
      logger.debug(`❌ Marking message ${requestId} as failed due to routing error from ${isDM ? 'target' : 'mesh'}: ${errorName}`);
      await databaseService.messages.updateMessageDeliveryState(requestId, 'failed');
      // Emit WebSocket event for real-time delivery failure update
      dataEventEmitter.emitRoutingUpdate({ requestId, status: 'nak', errorReason: errorName }, this.sourceId);
      // Notify message queue service of failure
      this.messageQueue.handleFailure(requestId, errorName);
    } catch (error) {
      logger.error('❌ Error processing routing error message:', error);
    }
  }

  /**
   * Process an inbound Waypoint protobuf message. Delegates the storage,
   * tombstone (expire=0), and event emission rules to `waypointService` so
   * the same path is used for all transports (TCP/MQTT/etc.).
   */
  private async processWaypointMessage(meshPacket: any, decoded: any): Promise<void> {
    try {
      const fromNum = Number(meshPacket.from ?? 0);
      await waypointService.upsertFromMesh(this.sourceId, fromNum, decoded);
    } catch (error) {
      logger.error('Error processing waypoint message:', error);
    }
  }

  /**
   * Broadcast a waypoint over the mesh as a WAYPOINT_APP packet. Mirrors the
   * pattern used by `sendPositionRequest` — build the protobuf, send via the
   * active transport, fan out to virtual node clients, log to the packet
   * monitor. Caller is responsible for persisting the local row first.
   *
   * Returns the packet id assigned by the protobuf service, or 0 if not
   * connected / encoding failed.
   */
  async broadcastWaypoint(waypoint: {
    id: number;
    latitude: number;
    longitude: number;
    expire: number;
    lockedTo?: number;
    name?: string;
    description?: string;
    icon?: number;
  }, options: { destination?: number; channel?: number } = {}): Promise<number> {
    if (!this.isConnected || !this.transport) {
      logger.warn(`[meshtasticManager] broadcastWaypoint skipped: not connected (source ${this.sourceId})`);
      return 0;
    }
    try {
      const { data, packetId } = meshtasticProtobufService.createWaypointMessage(waypoint, options);
      if (data.length === 0) return 0;

      await this.transport.send(data);

      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(data);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing waypoint:', error);
        }
      }

      const destination = options.destination ?? 0xffffffff;
      const channel = options.channel ?? 0;
      await this.logOutgoingPacket(
        PortNum.WAYPOINT_APP,
        destination,
        channel,
        `Waypoint id=${waypoint.id} ${waypoint.name ?? ''}`.trim(),
        { destination, packetId, waypointId: waypoint.id, expire: waypoint.expire },
      );

      logger.debug(`📍 Waypoint broadcast id=${waypoint.id} (${waypoint.name ?? ''}) packetId=${packetId}`);
      return packetId;
    } catch (error) {
      logger.error('Error broadcasting waypoint:', error);
      return 0;
    }
  }

  /**
   * Send a WAYPOINT_APP delete tombstone (`expire=1`, a non-zero past epoch)
   * for the given id, matching the Meshtastic-Apple delete convention.
   * `expire=0` means "no expiration" and would NOT be treated as a delete by
   * other clients.
   */
  async broadcastWaypointDelete(
    waypointId: number,
    options: { destination?: number; channel?: number } = {},
  ): Promise<number> {
    return this.broadcastWaypoint(
      { id: waypointId, latitude: 0, longitude: 0, expire: 1 },
      options,
    );
  }

  /**
   * Process NeighborInfo protobuf message
   */
  private async processNeighborInfoProtobuf(meshPacket: any, neighborInfo: any): Promise<void> {
    try {
      const fromNum = Number(meshPacket.from);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;

      logger.debug(`🏠 Neighbor info received from ${fromNodeId}:`, neighborInfo);

      // issue #4210 / meshtastic/firmware#11071: if this NeighborInfo is actually
      // the firmware's promiscuous hijack of a telemetry want_response we sent
      // (matched by request_id), auto-retry the telemetry request once. The
      // NeighborInfo is still valid neighbor data, so processing continues below.
      await this.maybeRetryHijackedTelemetry(meshPacket);

      // MQTT-sourced neighbor info IS persisted (issue #3271): the global, batch
      // position estimator pools the MQTT neighbor graph for extra resolution.
      // Rows carry their sourceId, so source-scoped views remain correct.

      // Get the sender node to determine their hopsAway
      let senderNode = await databaseService.nodes.getNode(fromNum);

      // Ensure sender node exists in database
      if (!senderNode) {
        await databaseService.upsertNodeAsync({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.slice(-4),
          lastHeard: Date.now() / 1000
        }, this.sourceId);
        senderNode = await databaseService.nodes.getNode(fromNum);
      }

      const senderHopsAway = senderNode?.hopsAway || 0;
      const nowMs = Date.now();

      // Process each neighbor in the list
      if (neighborInfo.neighbors && Array.isArray(neighborInfo.neighbors)) {
        logger.debug(`📡 Processing ${neighborInfo.neighbors.length} neighbors from ${fromNodeId}`);

        // Validate and collect neighbor node numbers upfront
        const validNeighbors: Array<{ nodeNum: number; snr: number | null; lastRxTime: number | null }> = [];
        for (const neighbor of neighborInfo.neighbors) {
          const neighborNodeNum = Number(neighbor.nodeId);
          if (isNaN(neighborNodeNum) || neighborNodeNum <= 0) {
            logger.warn(`⚠️ Skipping invalid neighbor nodeId from ${fromNodeId}: ${neighbor.nodeId}`);
            continue;
          }
          validNeighbors.push({
            nodeNum: neighborNodeNum,
            snr: neighbor.snr != null ? Number(neighbor.snr) : null,
            lastRxTime: neighbor.lastRxTime != null ? Number(neighbor.lastRxTime) : null,
          });
        }

        if (validNeighbors.length === 0) return;

        // Batch-fetch all neighbor nodes in a single query to avoid N+1
        const neighborNums = validNeighbors.map(n => n.nodeNum);
        const existingNodes = await databaseService.nodes.getNodesByNums(neighborNums);

        // Create placeholder nodes for any neighbors not yet in the database.
        //
        // Issue #2602: do NOT stamp `lastHeard` here. We have not directly heard
        // from this neighbor — only the reporter has. Stamping a fresh timestamp
        // creates a "zombie" row that passes the activity filter in
        // `getActiveNodes` and gets exposed to virtual node clients via
        // `sendNodeInfosFromDb`, where it shows up on the connected Meshtastic
        // app's map. The user then cannot delete the node from the app because
        // it does not exist in the physical node's NodeDB. Leaving lastHeard
        // NULL means `gt(lastHeard, cutoff)` evaluates to NULL → row excluded
        // from VN exposure until we actually receive a packet from the node.
        for (const vn of validNeighbors) {
          if (!existingNodes.has(vn.nodeNum)) {
            const neighborNodeId = `!${vn.nodeNum.toString(16).padStart(8, '0')}`;
            await databaseService.upsertNodeAsync({
              nodeNum: vn.nodeNum,
              nodeId: neighborNodeId,
              longName: `Node ${neighborNodeId}`,
              shortName: neighborNodeId.slice(-4),
              hopsAway: senderHopsAway + 1,
            }, this.sourceId);
            logger.debug(`➕ Created new node ${neighborNodeId} with hopsAway=${senderHopsAway + 1} (no lastHeard — indirectly discovered)`);
          }
        }

        // Delete old neighbors then batch-insert new ones — scoped to this source so
        // a NeighborInfo packet from one source doesn't wipe another source's rows.
        await databaseService.neighbors.deleteNeighborInfoForNode(fromNum, this.sourceId);

        const records = validNeighbors.map(vn => ({
          nodeNum: fromNum,
          neighborNodeNum: vn.nodeNum,
          snr: vn.snr,
          lastRxTime: vn.lastRxTime,
          timestamp: nowMs,
          createdAt: nowMs,
        }));

        await databaseService.neighbors.insertNeighborInfoBatch(records, this.sourceId);

        for (const vn of validNeighbors) {
          const neighborNodeId = `!${vn.nodeNum.toString(16).padStart(8, '0')}`;
          logger.debug(`🔗 Saved neighbor: ${fromNodeId} -> ${neighborNodeId}, SNR: ${vn.snr ?? 'N/A'}`);
        }
      }
    } catch (error) {
      logger.error('❌ Error processing neighbor info message:', error);
    }
  }

  /**
   * Legacy telemetry message processing (for backward compatibility)
   */

  /**
   * Process NodeInfo protobuf message directly
   */
  private async processNodeInfoProtobuf(nodeInfo: any): Promise<void> {
    try {
      logger.debug(`🏠 Processing NodeInfo for node ${nodeInfo.num}`);

      const nodeNum = Number(nodeInfo.num);
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;

      // Track that this node exists in the radio's local database
      this.deviceNodeNums.add(nodeNum);

      // Check if node already exists to determine if we should set isFavorite
      const existingNode = await databaseService.nodes.getNode(nodeNum);

      // Determine lastHeard value carefully to avoid incorrectly updating timestamps
      // during config sync. Only update lastHeard if:
      // 1. The device provides a valid lastHeard value, AND
      // 2. Either the node is new OR the incoming value is newer than existing
      // This fixes #1706 where config sync was resetting lastHeard for all nodes
      let lastHeardValue: number | undefined = undefined;
      if (nodeInfo.lastHeard && nodeInfo.lastHeard > 0) {
        // Device provided a valid lastHeard - cap at current time to prevent future timestamps
        const incomingLastHeard = Math.min(Number(nodeInfo.lastHeard), Date.now() / 1000);
        if (!existingNode || !existingNode.lastHeard || incomingLastHeard > existingNode.lastHeard) {
          lastHeardValue = incomingLastHeard;
        }
        // If existing node has a more recent lastHeard, keep it (don't include in nodeData)
      }
      // If device didn't provide lastHeard, don't update it at all - preserve existing value

      // Channel is authoritatively managed by processMeshPacket from live RX packets.
      // Device NodeDB sync can carry stale values (firmware's NodeDB::updateUser only
      // refreshes `channel` on NODEINFO_APP packets, and proto3 uint32 default 0 is
      // indistinguishable from "unset" on wire) so we only SEED channel for nodes that
      // don't already have one — never overwrite an existing value from device sync.
      // See: https://github.com/Yeraze/meshmonitor/issues — peer channel stuck at 0.
      const shouldSeedChannel =
        nodeInfo.channel !== undefined &&
        (!existingNode || existingNode.channel == null);

      const nodeData: any = {
        nodeNum: Number(nodeInfo.num),
        nodeId: nodeId,
        ...(lastHeardValue !== undefined && { lastHeard: lastHeardValue }),
        snr: nodeInfo.snr,
        // Note: NodeInfo protobuf doesn't include RSSI, only MeshPacket does
        // RSSI will be updated from mesh packet if available
        hopsAway: nodeInfo.hopsAway !== undefined ? nodeInfo.hopsAway : undefined,
        ...(shouldSeedChannel && { channel: nodeInfo.channel }),
      };

      // Debug logging for channel extraction
      if (nodeInfo.channel !== undefined) {
        if (shouldSeedChannel) {
          logger.debug(`📡 NodeInfo for ${nodeId}: seeding channel=${nodeInfo.channel} (new or unset)`);
        } else {
          logger.debug(`📡 NodeInfo for ${nodeId}: ignoring device-sync channel=${nodeInfo.channel} (existing=${existingNode?.channel}, managed by live packets)`);
        }
      } else {
        logger.debug(`📡 NodeInfo for ${nodeId}: no channel field present`);
      }

      // Always sync isFavorite from device to keep in sync with changes made while offline
      // This ensures favorites are updated when reconnecting (fixes #213).
      // Exception: if favoriteLocked is set, the DB value wins and we re-push our
      // locked flag to the device so it converges to what the user has pinned.
      if (nodeInfo.isFavorite !== undefined) {
        if (existingNode?.favoriteLocked) {
          if (existingNode.isFavorite !== nodeInfo.isFavorite) {
            logger.debug(`🔒 Node ${nodeId} favoriteLocked — preserving DB isFavorite=${existingNode.isFavorite}, re-syncing to device (device reported ${nodeInfo.isFavorite})`);
            nodeData.isFavorite = existingNode.isFavorite;
            // Re-push the locked favorite state to the connected device
            void (async () => {
              try {
                if (existingNode.isFavorite) {
                  await this.sendFavoriteNode(nodeNum);
                } else {
                  await this.sendRemoveFavoriteNode(nodeNum);
                }
              } catch (err) {
                logger.warn(`⚠️ Failed to re-sync locked favorite for node ${nodeId}:`, err);
              }
            })();
          }
        } else {
          nodeData.isFavorite = nodeInfo.isFavorite;
          if (existingNode && existingNode.isFavorite !== nodeInfo.isFavorite) {
            logger.debug(`⭐ Updating favorite status for node ${nodeId} from ${existingNode.isFavorite} to ${nodeInfo.isFavorite}`);
          }
        }
      }

      // Always sync isIgnored from device to keep in sync with changes made while offline
      // This ensures ignored nodes are updated when reconnecting.
      //
      // Exception (#2601): our per-source ignore list is authoritative. A device's
      // on-board ignore list is small, so when its node database fills up it drops
      // ignores and reports the node as un-ignored. If the node is still on our
      // blocklist, keep it ignored AND re-push the ignore to the LOCAL connected
      // node — this is a local admin command (no destination), so it never touches
      // the mesh. Mirrors the favoriteLocked re-sync above.
      if (nodeInfo.isIgnored !== undefined) {
        const onBlocklist = databaseService.ignoredNodes.isIgnoredCached(nodeNum, this.sourceId);
        if (onBlocklist && !nodeInfo.isIgnored) {
          nodeData.isIgnored = true;
          // Coalesce bursts: a thrashing device that can't durably hold the ignore
          // would otherwise trigger a local admin command on every NodeInfo.
          const now = Date.now();
          const lastPush = this.ignoreReapplyCooldown.get(nodeNum) ?? 0;
          if (now - lastPush >= IGNORE_REAPPLY_COOLDOWN_MS) {
            this.ignoreReapplyCooldown.set(nodeNum, now);
            logger.debug(`🚫 Node ${nodeId} on persistent ignore list but device reports un-ignored — re-applying on local device (#2601)`);
            void (async () => {
              try {
                await this.sendIgnoredNode(nodeNum); // no destination = local node, no mesh traffic
              } catch (err) {
                if (err instanceof Error && err.message === 'FIRMWARE_NOT_SUPPORTED') {
                  logger.debug(`Device firmware does not support ignored nodes (requires >= 2.7.0); DB flag re-applied only for ${nodeId}`);
                } else {
                  logger.warn(`⚠️ Failed to re-apply ignore on local device for node ${nodeId}:`, err);
                }
              }
            })();
          } else {
            logger.debug(`🚫 Node ${nodeId} re-ignore suppressed by cooldown; DB flag kept ignored`);
          }
        } else {
          nodeData.isIgnored = nodeInfo.isIgnored;
          if (existingNode && existingNode.isIgnored !== nodeInfo.isIgnored) {
            logger.debug(`🚫 Updating ignored status for node ${nodeId} from ${existingNode.isIgnored} to ${nodeInfo.isIgnored}`);
          }
        }
      }

      // Add user information if available
      if (nodeInfo.user) {
        nodeData.longName = nodeInfo.user.longName;
        nodeData.shortName = nodeInfo.user.shortName;
        nodeData.hwModel = nodeInfo.user.hwModel;
        nodeData.role = nodeInfo.user.role;
        // #3684: persist User capability flags so the Config tab "Unmessageable"
        // checkbox reflects the local node's actual setting (is_unmessagable is an
        // optional proto field → default false; is_licensed is a required bool).
        nodeData.isUnmessagable = nodeInfo.user.isUnmessagable ?? false;
        nodeData.isLicensed = nodeInfo.user.isLicensed ?? false;

        // Capture public key if present (important for local node)
        if (nodeInfo.user.publicKey && nodeInfo.user.publicKey.length > 0) {
          // Convert Uint8Array to base64 for storage
          const deviceSyncKey = Buffer.from(nodeInfo.user.publicKey).toString('base64');

          // Device sync keys should NOT overwrite mesh-received keys for remote nodes.
          // The connected device's internal nodeDb may have stale/incorrect cached keys,
          // while mesh-received keys (from processNodeInfoMessageProtobuf) come directly
          // from the node itself and are authoritative. The local node's own key from
          // device sync IS authoritative since the device knows its own key.
          const isLocalNode = this.localNodeInfo?.nodeNum === Number(nodeInfo.num);

          // --- Check if device sync resolves a key mismatch ---
          let mismatchResolved = false;

          if (existingNode?.keyMismatchDetected && existingNode.lastMeshReceivedKey) {
            if (deviceSyncKey === existingNode.lastMeshReceivedKey) {
              // Device now has the same key as the mesh broadcast — mismatch resolved!
              logger.debug(`🔐 Key mismatch RESOLVED via device sync for ${nodeId}: device key matches mesh key`);
              nodeData.keyMismatchDetected = false;
              nodeData.lastMeshReceivedKey = null;
              nodeData.publicKey = deviceSyncKey;
              nodeData.hasPKC = true;
              mismatchResolved = true;

              const nodeName = nodeInfo.user?.longName || nodeInfo.user?.shortName || nodeId;
              databaseService.clearKeyRepairStateAsync(Number(nodeInfo.num)).catch(err =>
                logger.error('Error clearing repair state:', err)
              );
              databaseService.logKeyRepairAttemptAsync(
                Number(nodeInfo.num), nodeName, 'fixed', true, null, null, this.sourceId
              ).catch(err => logger.error('Error logging fix:', err));

              dataEventEmitter.emitNodeUpdate(Number(nodeInfo.num), {
                keyMismatchDetected: false,
                keySecurityIssueDetails: undefined
              }, this.sourceId);
            }
          }

          // Existing stale-key skip logic — only run if mismatch was NOT just resolved
          if (!mismatchResolved) {
            if (!isLocalNode && existingNode?.publicKey && existingNode.publicKey !== deviceSyncKey) {
              // Device has a different key than what we have from mesh — don't overwrite
              logger.debug(
                `🔐 Device sync: Skipping stale public key for ${nodeId} ` +
                `(device: ${deviceSyncKey.substring(0, 16)}..., ` +
                `stored: ${existingNode.publicKey.substring(0, 16)}...)`
              );
              // Still set hasPKC since the node does have a key
              nodeData.hasPKC = true;
            } else {
              nodeData.publicKey = deviceSyncKey;
              nodeData.hasPKC = true;
              logger.debug(`🔐 Captured public key for ${nodeId}: ${deviceSyncKey.substring(0, 16)}...`);
            }
          }

          // Check for key security issues (use stored key if we skipped device key)
          const keyToCheck = nodeData.publicKey || existingNode?.publicKey;
          if (keyToCheck) {
            const { checkLowEntropyKey } = await import('../services/lowEntropyKeyService.js');
            const isLowEntropy = checkLowEntropyKey(keyToCheck, 'base64');

            if (isLowEntropy) {
              nodeData.keyIsLowEntropy = true;
              nodeData.keySecurityIssueDetails = 'Known low-entropy key detected - this key is compromised and should be regenerated';
              logger.warn(`⚠️ Low-entropy key detected for node ${nodeId}!`);
            } else {
              // Explicitly clear the flag when key is NOT low-entropy
              // This ensures that if a node regenerates their key, the flag is cleared immediately
              nodeData.keyIsLowEntropy = false;
              nodeData.keySecurityIssueDetails = null;
            }
          }
        }
      }

      // viaMqtt is at the top level of NodeInfo, not inside user
      if (nodeInfo.viaMqtt !== undefined) {
        nodeData.viaMqtt = nodeInfo.viaMqtt;
      }

      // Add position information if available
      let positionTelemetryData: { timestamp: number; latitude: number; longitude: number; altitude?: number; precisionBits?: number; channel?: number; groundSpeed?: number; groundTrack?: number } | null = null;
      if (nodeInfo.position && (nodeInfo.position.latitudeI || nodeInfo.position.longitudeI)) {
        const coords = meshtasticProtobufService.convertCoordinates(
          nodeInfo.position.latitudeI,
          nodeInfo.position.longitudeI
        );

        // Extract position precision if present in NodeInfo's embedded Position.
        // The protobuf decoder normalizes a missing precision_bits field to 0, so we
        // treat 0 as "absent" here and leave any existing positionPrecisionBits intact.
        // We must NOT fall back to the local channel's positionPrecision — that record
        // reflects this MeshMonitor instance's channel config, not the remote node's,
        // and was causing every node's accuracy box to track the local node (issue #3030).
        // Read before validation so the Null Island check can back out the firmware's
        // precision re-centering offset for an obscured (0,0) fix (issue #3763), matching
        // the POSITION_APP path — otherwise a true-(0,0) node that only sends NodeInfo
        // (no POSITION_APP) would slip past the box as (offset, offset).
        const precisionBits = nodeInfo.position.precisionBits ?? nodeInfo.position.precision_bits;

        // Meshtastic Position.location_source (LocSource enum) — see POSITION_APP
        // path for the value map. Persisted for the node popups (issue #4176).
        const locationSource = nodeInfo.position.locationSource ?? nodeInfo.position.location_source;

        // Validate coordinates before saving
        if (this.isValidPosition(coords.latitude, coords.longitude, precisionBits)) {
          const channelIndex = nodeInfo.channel !== undefined ? nodeInfo.channel : 0;

          // Guard against precision downgrade (issue #3513): only update lat/lon from NodeInfo
          // if the incoming position is not lower precision than what's already stored.
          // NodeInfo positions may arrive reduced by the sending node's channel positionPrecision
          // setting (firmware applies grid-snapping before broadcast). POSITION_APP packets are
          // the authoritative source; NodeInfo should not silently downgrade them.
          // We only skip when BOTH sides carry explicit non-zero precision info AND the incoming
          // is clearly lower — if either side is unknown (0/null), we accept the update.
          const storedPrecisionBits = existingNode?.positionPrecisionBits;
          const shouldUpdateLatLon =
            existingNode?.latitude == null || existingNode?.longitude == null || // no existing position
            !precisionBits ||        // incoming precision unknown (0 = not set), accept
            !storedPrecisionBits ||  // stored precision unknown, accept
            precisionBits >= storedPrecisionBits; // incoming is same or better precision

          if (shouldUpdateLatLon) {
            nodeData.latitude = coords.latitude;
            nodeData.longitude = coords.longitude;
            nodeData.altitude = nodeInfo.position.altitude;
            // Only update precision metadata when we actually accept the lat/lon. Updating
            // positionPrecisionBits even on a rejected downgrade would lower the stored
            // value and make the guard one-shot — the next packet at the same low precision
            // would pass the ">= stored" check and overwrite the coordinates.
            if (precisionBits !== undefined && precisionBits !== 0) {
              nodeData.positionPrecisionBits = precisionBits;
              nodeData.positionChannel = channelIndex;
              nodeData.positionTimestamp = Date.now();
            }
            // location_source is meaningful independent of precision bits, so
            // record it whenever the node reports one (#4176).
            if (locationSource !== undefined && locationSource !== 0) {
              nodeData.positionLocationSource = locationSource;
            }
          } else {
            logger.debug(
              `🗺️ Skipping NodeInfo lat/lon update for ${nodeId}: ` +
              `incoming precision (${precisionBits} bits) < stored (${storedPrecisionBits} bits)`
            );
            // Altitude is not grid-snapped by the firmware's positionPrecision setting,
            // so update it independently even when lat/lon is being skipped.
            if (nodeInfo.position.altitude !== undefined && nodeInfo.position.altitude !== null) {
              nodeData.altitude = nodeInfo.position.altitude;
            }
          }

          // Always record position telemetry for history (regardless of whether the
          // current-position columns were updated), using the actual incoming coordinates.
          const timestamp = nodeInfo.position.time ? Number(nodeInfo.position.time) * 1000 : Date.now();
          positionTelemetryData = {
            timestamp,
            latitude: coords.latitude,
            longitude: coords.longitude,
            altitude: nodeInfo.position.altitude,
            precisionBits,
            channel: channelIndex,
            groundSpeed: nodeInfo.position.groundSpeed ?? nodeInfo.position.ground_speed,
            groundTrack: nodeInfo.position.groundTrack ?? nodeInfo.position.ground_track
          };
        } else {
          logger.warn(`⚠️ Invalid position coordinates for node ${nodeId}: lat=${coords.latitude}, lon=${coords.longitude}. Skipping position save.`);
        }
      }

      // Process device telemetry from NodeInfo if available
      // This allows the local node's telemetry to be captured, since TCP clients
      // only receive TELEMETRY_APP packets from OTHER nodes via mesh, not from the local node
      let deviceMetricsTelemetryData: any = null;
      if (nodeInfo.deviceMetrics) {
        const deviceMetrics = nodeInfo.deviceMetrics;
        const timestamp = nodeInfo.lastHeard ? Number(nodeInfo.lastHeard) * 1000 : Date.now();

        logger.debug(`📊 Processing device telemetry from NodeInfo: battery=${deviceMetrics.batteryLevel}%, voltage=${deviceMetrics.voltage}V`);

        // Store device metrics to be inserted after node is created
        deviceMetricsTelemetryData = {
          timestamp,
          batteryLevel: deviceMetrics.batteryLevel,
          voltage: deviceMetrics.voltage,
          channelUtilization: deviceMetrics.channelUtilization,
          airUtilTx: deviceMetrics.airUtilTx,
          uptimeSeconds: deviceMetrics.uptimeSeconds
        };
      }

      // If this is the local node, always update localNodeInfo with names from NodeInfo.
      // NodeInfo is the authoritative source for node identity — names may have been changed
      // outside MeshMonitor (e.g., via Meshtastic app), so we must accept the device's truth
      // regardless of isLocked state. isLocked only prevents processMyNodeInfo (which doesn't
      // carry names) from overwriting with incomplete data.
      if (this.localNodeInfo && this.localNodeInfo.nodeNum === Number(nodeInfo.num)) {
        if (nodeInfo.user && nodeInfo.user.longName && nodeInfo.user.shortName) {
          const nameChanged = this.localNodeInfo.longName !== nodeInfo.user.longName ||
            this.localNodeInfo.shortName !== nodeInfo.user.shortName;
          if (nameChanged) {
            logger.debug(`📱 Local node name updated: "${this.localNodeInfo.longName}" → "${nodeInfo.user.longName}" (${nodeInfo.user.shortName})`);
          }
          this.localNodeInfo.longName = nodeInfo.user.longName;
          this.localNodeInfo.shortName = nodeInfo.user.shortName;
          this.localNodeInfo.isLocked = true;  // Lock it now that we have complete info
          logger.debug(`📱 Local node: ${nodeInfo.user.longName} (${nodeInfo.user.shortName}) - LOCKED`);
        }
        // #3684: surface the local node's User capability flags to the Config tab.
        // Updated independently of the names guard since is_unmessagable can change
        // without a name change. is_unmessagable is an optional proto field.
        if (nodeInfo.user) {
          this.localNodeInfo.isUnmessagable = nodeInfo.user.isUnmessagable ?? false;
          this.localNodeInfo.isLicensed = nodeInfo.user.isLicensed ?? false;
        }
      }

      // Upsert node first to ensure it exists before inserting telemetry
      await databaseService.upsertNodeAsync(nodeData, this.sourceId);

      // Emit WebSocket event for node update
      dataEventEmitter.emitNodeUpdate(Number(nodeInfo.num), nodeData, this.sourceId);

      logger.debug(`🏠 Updated node info: ${nodeData.longName || nodeId}`);

      // Collect all telemetry rows into one batch to minimize pool acquires.
      // Before the fix for #2780 each of these was a separate await → separate
      // pool checkout; a single NodeInfo with position + deviceMetrics + SNR
      // could take ~11 checkouts and drain the pool under config-sync bursts.
      const telemetryBatch: Array<any> = [];
      const nodeNumForTelemetry = Number(nodeInfo.num);

      // Position telemetry (requires node row to already exist — upsert above guarantees that)
      if (positionTelemetryData) {
        const now = Date.now();
        telemetryBatch.push({
          nodeId, nodeNum: nodeNumForTelemetry, telemetryType: 'latitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.latitude, unit: '°', createdAt: now,
          channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
        });
        telemetryBatch.push({
          nodeId, nodeNum: nodeNumForTelemetry, telemetryType: 'longitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.longitude, unit: '°', createdAt: now,
          channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
        });
        if (positionTelemetryData.altitude !== undefined && positionTelemetryData.altitude !== null) {
          telemetryBatch.push({
            nodeId, nodeNum: nodeNumForTelemetry, telemetryType: 'altitude',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.altitude, unit: 'm', createdAt: now,
            channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
          });
        }
        if (positionTelemetryData.groundSpeed !== undefined && positionTelemetryData.groundSpeed > 0) {
          telemetryBatch.push({
            nodeId, nodeNum: nodeNumForTelemetry, telemetryType: 'ground_speed',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.groundSpeed, unit: 'km/h', createdAt: now,
            channel: positionTelemetryData.channel
          });
        }
        if (positionTelemetryData.groundTrack !== undefined && positionTelemetryData.groundTrack > 0) {
          const headingDegrees = positionTelemetryData.groundTrack / 100;
          telemetryBatch.push({
            nodeId, nodeNum: nodeNumForTelemetry, telemetryType: 'ground_track',
            timestamp: positionTelemetryData.timestamp, value: headingDegrees, unit: '°', createdAt: now,
            channel: positionTelemetryData.channel
          });
        }
      }

      // Device metrics telemetry
      if (deviceMetricsTelemetryData) {
        const now = Date.now();
        const dm = deviceMetricsTelemetryData;
        const maybePush = (type: string, value: any, unit: string) => {
          if (value !== undefined && value !== null && !isNaN(value)) {
            telemetryBatch.push({
              nodeId, nodeNum: nodeNumForTelemetry, telemetryType: type,
              timestamp: dm.timestamp, value, unit, createdAt: now
            });
          }
        };
        maybePush('batteryLevel', dm.batteryLevel, '%');
        maybePush('voltage', dm.voltage, 'V');
        maybePush('channelUtilization', dm.channelUtilization, '%');
        maybePush('airUtilTx', dm.airUtilTx, '%');
        maybePush('uptimeSeconds', dm.uptimeSeconds, 's');
      }

      // SNR telemetry — preserve "save only if changed OR ≥10 min" throttle.
      // This must remain conditional on the existing latest row to avoid DB bloat.
      if (nodeInfo.snr != null && nodeInfo.snr !== -128) {
        const timestamp = nodeInfo.lastHeard ? Number(nodeInfo.lastHeard) * 1000 : Date.now();
        const now = Date.now();
        const latestSnrTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'snr_remote');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveSnr = !latestSnrTelemetry ||
                              latestSnrTelemetry.value !== nodeInfo.snr ||
                              (now - latestSnrTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveSnr) {
          telemetryBatch.push({
            nodeId,
            nodeNum: nodeNumForTelemetry,
            telemetryType: 'snr_remote',
            timestamp,
            value: nodeInfo.snr,
            unit: 'dB',
            createdAt: now
          });
          const reason = !latestSnrTelemetry ? 'initial' :
                        latestSnrTelemetry.value !== nodeInfo.snr ? 'changed' : 'periodic';
          logger.debug(`📊 Saved remote SNR telemetry from NodeInfo: ${nodeInfo.snr} dB (${reason}, previous: ${latestSnrTelemetry?.value || 'N/A'})`);
        }
      }

      if (telemetryBatch.length > 0) {
        await databaseService.telemetry.insertTelemetryBatch(telemetryBatch, this.sourceId);
      }

      // Update mobility detection once position was persisted (fire and forget)
      if (positionTelemetryData) {
        databaseService.updateNodeMobilityAsync(nodeId).catch(err =>
          logger.error(`Failed to update mobility for ${nodeId}:`, err)
        );
      }
    } catch (error) {
      logger.error('❌ Error processing NodeInfo protobuf:', error);
    }
  }


  /**
   * Current transmit state for THIS source, read from the in-memory device config.
   * Defaults to true when config hasn't arrived yet (fail-open: don't block sends
   * before we know the radio's state). No DB access — safe to call per packet.
   */
  isTxEnabled(): boolean {
    return this.actualDeviceConfig?.lora?.txEnabled !== false;
  }

  // Configuration retrieval methods
  async getDeviceConfig(): Promise<any> {
    // Return config data from what we've received via TCP stream
    logger.debug('🔍 getDeviceConfig called - actualDeviceConfig.lora present:', !!this.actualDeviceConfig?.lora);
    logger.debug('🔍 getDeviceConfig called - actualModuleConfig present:', !!this.actualModuleConfig);

    if (this.actualDeviceConfig?.lora || this.actualModuleConfig) {
      logger.debug('Using actualDeviceConfig:', JSON.stringify(this.actualDeviceConfig, null, 2));
      logger.debug('✅ Returning device config from actualDeviceConfig');
      return await this.deviceAdminService.buildDeviceConfigFromActual();
    }

    logger.debug('⚠️ No device config available yet - returning null');
    logger.debug('No device config available yet');
    return null;
  }

  async sendTextMessage(text: string, channel: number = 0, destination?: number, replyId?: number, emoji?: number, userId?: number, attribution?: { sourceIp?: string | null; sourcePath?: 'http_api' | 'tcp_radio' | 'mqtt_bridge' | 'system' | null }): Promise<number> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.isTxEnabled()) {
      throw new TxDisabledError();
    }

    try {
      // Apply homoglyph optimization if enabled (replace Cyrillic look-alikes with Latin to save bytes)
      if (await databaseService.settings.getSetting('homoglyphEnabled') === 'true') {
        text = applyHomoglyphOptimization(text);
      }

      // For DMs, check if the target node has a public key — if so, request PKI encryption.
      // The firmware handles the actual crypto, but for serial/TCP connections it only
      // PKI-encrypts when the packet explicitly has pkiEncrypted=true.
      //
      // Skip PKI when keyMismatchDetected is set: the key-repair flow may have purged
      // the node from the firmware's NodeDB (sendRemoveNode in processKeyRepairs / immediate
      // purge), so the firmware no longer has a key to encrypt with. Our DB column still
      // holds the (now-stale) key, but trusting it would cause the firmware to silently
      // drop the outbound DM. Fall back to channel encryption until a fresh NodeInfo
      // exchange resolves the mismatch.
      let pkiEncrypted = false;
      if (destination) {
        try {
          const targetNode = await databaseService.nodes.getNode(destination, this.sourceId);
          if (targetNode?.publicKey && !targetNode.keyMismatchDetected) {
            pkiEncrypted = true;
            logger.debug(`🔐 DM to !${destination.toString(16).padStart(8, '0')} — requesting PKI encryption (node has public key)`);
            try {
              await this.pushContactToRadio(targetNode);
            } catch {
              // Non-fatal — radio may already have the contact, or the send failed
              // transiently. On failure deviceNodeNums is left untouched (the add only
              // runs after a successful send), so the UI's "not in device DB" warning
              // correctly lingers until a later push or NodeInfo confirms the contact.
            }
          } else if (targetNode?.publicKey && targetNode.keyMismatchDetected) {
            logger.debug(`🔐 DM to !${destination.toString(16).padStart(8, '0')} — skipping PKI (key mismatch active; firmware may lack key after purge), falling back to channel encryption`);
          }
        } catch {
          // If lookup fails, send without PKI — firmware will use channel encryption
        }
      }

      const { data: textMessageData, messageId } = meshtasticProtobufService.createTextMessage(text, destination, channel, replyId, emoji, pkiEncrypted);

      // Remember our own packet id so that if this message is overheard
      // rebroadcast, echoed by MQTT, or replayed by store-and-forward, it isn't
      // mistaken for a local-node spoof (#2584).
      this.sentPacketIds.record(messageId);

      await this.transport.send(textMessageData);

      // Log message sending at INFO level for production visibility
      const destinationInfo = destination ? `node !${destination.toString(16).padStart(8, '0')}` : `channel ${channel}`;
      logger.debug(`📤 Sent message to ${destinationInfo}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (ID: ${messageId})`);
      logger.debug('Message sent successfully:', text, 'with ID:', messageId);

      // Log outgoing message to packet monitor
      await this.logOutgoingPacket(
        1, // TEXT_MESSAGE_APP
        destination || 0xffffffff,
        channel,
        `"${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        { messageId, replyId, emoji }
      );

      // Save sent message to database for UI display
      // Prefer this.localNodeInfo (populated from MyNodeInfo), fall back to source-scoped settings,
      // then fall back to legacy global key (single-source compatibility or pre-existing sessions)
      let localNodeNum: string | null = this.localNodeInfo?.nodeNum?.toString() ?? null;
      let localNodeId: string | null = this.localNodeInfo?.nodeId ?? null;

      if (!localNodeNum || !localNodeId) {
        localNodeNum = await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeNum'));
        localNodeId = await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeId'));
        if (localNodeNum && localNodeId) {
          logger.debug(`Using source-scoped settings as fallback: ${localNodeId}`);
        } else {
          // Legacy fallback: global key (single-source installs or pre-existing sessions)
          localNodeNum = await databaseService.settings.getSetting('localNodeNum');
          localNodeId = await databaseService.settings.getSetting('localNodeId');
          if (localNodeNum && localNodeId) {
            logger.debug(`Using legacy global settings as fallback: ${localNodeId}`);
          }
        }
      }

      if (localNodeNum && localNodeId) {
        const toNodeId = destination ? `!${destination.toString(16).padStart(8, '0')}` : 'broadcast';

        // Prefix with sourceId so each source's outbound sends are uniquely
        // keyed even if two sources share a local node number (see inbound
        // text-message insert for the dedup-vs-PK rationale).
        const messageId_str = `${this.sourceId}_${localNodeNum}_${messageId}`;
        const message = {
          id: messageId_str,
          fromNodeNum: parseInt(localNodeNum),
          toNodeNum: destination || 0xffffffff,
          fromNodeId: localNodeId,
          toNodeId: toNodeId,
          text: text,
          // Use channel -1 for direct messages, otherwise use the actual channel
          channel: destination ? -1 : channel,
          portnum: PortNum.TEXT_MESSAGE_APP,
          timestamp: Date.now(),
          rxTime: Date.now(),
          hopStart: undefined,
          hopLimit: undefined,
          replyId: replyId || undefined,
          emoji: emoji || undefined,
          requestId: messageId, // Save requestId for routing error matching
          wantAck: true, // Request acknowledgment for this message
          deliveryState: 'pending', // Initial delivery state
          createdAt: Date.now(),
          // Default attribution to 'system' when not provided (e.g. internal
          // ping/welcome/etc. callers); HTTP route passes 'http_api' + req.ip.
          sourceIp: attribution?.sourceIp ?? null,
          sourcePath: attribution?.sourcePath ?? 'system'
        };

        await databaseService.messages.insertMessage(message, this.sourceId);

        // Emit WebSocket event for real-time updates (sent message)
        dataEventEmitter.emitNewMessage(message as any, this.sourceId);

        logger.debug(`💾 Saved sent message to database: "${text.substring(0, 30)}..."`);

        // Automatically mark sent messages as read for the sending user
        if (userId !== undefined) {
          databaseService.markMessageAsReadAsync(messageId_str, userId).catch(err => {
            logger.debug('Failed to mark message as read:', err);
          });
          logger.debug(`✅ Automatically marked sent message as read for user ${userId}`);
        }
      }

      // Broadcast outgoing text message to virtual node clients as a proper FromRadio
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer && localNodeNum) {
        try {
          const fromRadioData = await meshtasticProtobufService.createFromRadioTextMessage({
            fromNodeNum: parseInt(localNodeNum),
            toNodeNum: destination || 0xffffffff,
            text: text,
            channel: destination ? -1 : channel,
            timestamp: Date.now(),
            requestId: messageId,
            replyId: replyId || null,
            emoji: emoji || null,
          });
          if (fromRadioData) {
            await virtualNodeServer.broadcastToClients(fromRadioData);
            logger.debug(`📡 Broadcasted outgoing text message to virtual node clients`);
          }
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing text message:', error);
        }
      }

      return messageId;
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }

  async sendTraceroute(destination: number, channel: number = 0): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.isTxEnabled()) {
      throw new TxDisabledError();
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      const tracerouteData = meshtasticProtobufService.createTracerouteMessage(destination, channel);

      logger.debug(`🔍 Traceroute packet created: ${tracerouteData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}`);

      await this.transport.send(tracerouteData);

      // Broadcast the outgoing traceroute packet to virtual node clients (including packet monitor)
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(tracerouteData);
          logger.debug(`📡 Broadcasted outgoing traceroute to virtual node clients (${tracerouteData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing traceroute:', error);
        }
      }

      await databaseService.recordTracerouteRequestAsync(this.localNodeInfo.nodeNum, destination, this.sourceId ?? undefined);
      logger.debug(`📤 Traceroute request sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing traceroute to packet monitor
      await this.logOutgoingPacket(
        70, // TRACEROUTE_APP
        destination,
        channel,
        `Traceroute request to !${destination.toString(16).padStart(8, '0')}`,
        { destination }
      );
    } catch (error) {
      logger.error('Error sending traceroute:', error);
      throw error;
    }
  }

  /**
   * Send a position request to a specific node
   * This will request the destination node to send back its position
   */
  async sendPositionRequest(destination: number, channel: number = 0): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.isTxEnabled()) {
      throw new TxDisabledError();
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      // Check if the local node has a valid position source
      // GpsMode enum: 0 = DISABLED, 1 = ENABLED, 2 = NOT_PRESENT
      const positionConfig = this.actualDeviceConfig?.position;
      const hasFixedPosition = positionConfig?.fixedPosition === true;
      const hasGpsEnabled = positionConfig?.gpsMode === 1; // GpsMode.ENABLED
      const hasValidPositionSource = hasFixedPosition || hasGpsEnabled;

      let localPosition: { latitude: number; longitude: number; altitude?: number | null } | undefined;

      // Only include position data if the node has a valid position source
      if (hasValidPositionSource) {
        const localNode = await databaseService.nodes.getNode(this.localNodeInfo.nodeNum);
        localPosition = (localNode?.latitude && localNode?.longitude) ? {
          latitude: localNode.latitude,
          longitude: localNode.longitude,
          altitude: localNode.altitude
        } : undefined;
      }

      logger.debug(`📍 Position exchange: fixedPosition=${hasFixedPosition}, gpsMode=${positionConfig?.gpsMode}, hasValidPositionSource=${hasValidPositionSource}, willSendPosition=${!!localPosition}`);

      const { data: positionRequestData, packetId, requestId } = meshtasticProtobufService.createPositionRequestMessage(
        destination,
        channel,
        localPosition
      );

      logger.debug(`📍 Position exchange packet created: ${positionRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}, position=${localPosition ? `${localPosition.latitude},${localPosition.longitude}` : 'none'}`);

      await this.transport.send(positionRequestData);

      // Broadcast to virtual node clients (including packet monitor)
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(positionRequestData);
          logger.debug(`📡 Broadcasted outgoing position exchange to virtual node clients (${positionRequestData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing position exchange:', error);
        }
      }

      logger.debug(`📤 Position exchange sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing position exchange to packet monitor
      await this.logOutgoingPacket(
        3, // POSITION_APP
        destination,
        channel,
        `Position exchange with !${destination.toString(16).padStart(8, '0')}`,
        { destination, packetId, requestId }
      );

      return { packetId, requestId };
    } catch (error) {
      logger.error('Error sending position exchange:', error);
      throw error;
    }
  }

  /**
   * Send a NodeInfo request to a specific node (Exchange Node Info)
   * This will request the destination node to send back its user information
   * Similar to "Exchange Node Info" feature in mobile apps - triggers key exchange
   */
  async sendNodeInfoRequest(destination: number, channel: number = 0): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.isTxEnabled()) {
      throw new TxDisabledError();
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      // Get local node's user info from database for exchange
      // NOTE: We intentionally do NOT include publicKey here. The device's own firmware
      // handles key distribution via its native NodeInfo broadcasts. If MeshMonitor's
      // database has a stale key (e.g. after firmware update or NVS corruption), broadcasting
      // it would cause other mesh nodes to store the wrong key, making the node appear as
      // a new/untrusted identity. See issue #2275.
      const localNode = await databaseService.nodes.getNode(this.localNodeInfo.nodeNum);
      const localUserInfo = localNode ? {
        id: this.localNodeInfo.nodeId,
        longName: localNode.longName || 'Unknown',
        shortName: localNode.shortName || '????',
        hwModel: localNode.hwModel ?? undefined,
        role: localNode.role ?? undefined,
      } : undefined;

      const { data: nodeInfoRequestData, packetId, requestId } = meshtasticProtobufService.createNodeInfoRequestMessage(
        destination,
        channel,
        localUserInfo
      );

      logger.debug(`📇 NodeInfo exchange packet created: ${nodeInfoRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}, userInfo=${localUserInfo ? localUserInfo.longName : 'none'}`);

      await this.transport.send(nodeInfoRequestData);

      // Broadcast to virtual node clients (including packet monitor)
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(nodeInfoRequestData);
          logger.debug(`📡 Broadcasted outgoing NodeInfo exchange to virtual node clients (${nodeInfoRequestData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing NodeInfo exchange:', error);
        }
      }

      logger.debug(`📤 NodeInfo exchange sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing NodeInfo exchange to packet monitor
      await this.logOutgoingPacket(
        4, // NODEINFO_APP
        destination,
        channel,
        `NodeInfo exchange with !${destination.toString(16).padStart(8, '0')}`,
        { destination, packetId, requestId }
      );

      return { packetId, requestId };
    } catch (error) {
      logger.error('Error sending NodeInfo exchange:', error);
      throw error;
    }
  }

  /**
   * Request neighbor info from a remote node
   * The target node must have NeighborInfo module enabled (broadcast interval can be 0)
   * Firmware rate-limits responses to one every 3 minutes
   */
  async sendNeighborInfoRequest(destination: number, channel: number = 0): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.isTxEnabled()) {
      throw new TxDisabledError();
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      const { data: neighborInfoRequestData, packetId, requestId } = meshtasticProtobufService.createNeighborInfoRequestMessage(
        destination,
        channel
      );

      logger.debug(`🏠 NeighborInfo request packet created: ${neighborInfoRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}`);

      await this.transport.send(neighborInfoRequestData);

      // Broadcast to virtual node clients (including packet monitor)
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(neighborInfoRequestData);
          logger.debug(`📡 Broadcasted outgoing NeighborInfo request to virtual node clients (${neighborInfoRequestData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing NeighborInfo request:', error);
        }
      }

      logger.debug(`📤 NeighborInfo request sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing NeighborInfo request to packet monitor
      await this.logOutgoingPacket(
        71, // NEIGHBORINFO_APP
        destination,
        channel,
        `NeighborInfo request to !${destination.toString(16).padStart(8, '0')}`,
        { destination, packetId, requestId }
      );

      return { packetId, requestId };
    } catch (error) {
      logger.error('Error sending NeighborInfo request:', error);
      throw error;
    }
  }

  /**
   * Forget a telemetry sequence entirely: cancel its outstanding retry timers
   * and remove every packet-id key that points to it from the pending map.
   */
  private forgetTelemetrySequence(entry: PendingTelemetryRequest): void {
    for (const timer of entry.retryTimers) {
      clearTimeout(timer);
      this.telemetryRetryTimers.delete(timer);
    }
    entry.retryTimers = [];
    for (const pid of entry.packetIds) {
      this.pendingTelemetryRequests.delete(pid);
    }
  }

  /**
   * Prune expired pending telemetry sequences (by original sentAt) and bound
   * the map size. Map iteration order is insertion order, so the first keys are
   * the oldest.
   */
  private pruneExpiredTelemetryRequests(now: number): void {
    for (const [, entry] of this.pendingTelemetryRequests) {
      if (now - entry.sentAt > MeshtasticManager.TELEMETRY_REQUEST_TTL_MS) {
        this.forgetTelemetrySequence(entry);
      }
    }
    while (this.pendingTelemetryRequests.size > MeshtasticManager.TELEMETRY_REQUEST_MAX_PENDING) {
      const oldestKey = this.pendingTelemetryRequests.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.pendingTelemetryRequests.get(oldestKey);
      if (oldest) this.forgetTelemetrySequence(oldest);
      else this.pendingTelemetryRequests.delete(oldestKey);
    }
  }

  /**
   * Record a NEW outgoing telemetry want_response so a firmware NeighborInfo
   * hijack of its reply can be detected and auto-retried (issue #4210). Only
   * original (non-retry) sends start a sequence; auto-retries are linked onto
   * the existing sequence by {@link maybeRetryHijackedTelemetry}.
   */
  private recordPendingTelemetryRequest(
    packetId: number,
    destination: number,
    channel: number,
    telemetryType: 'device' | 'environment' | 'airQuality' | 'power' | undefined
  ): void {
    if (!packetId) return;
    const now = Date.now();
    this.pendingTelemetryRequests.set(packetId, {
      destination,
      channel,
      telemetryType,
      sentAt: now,
      retried: false,
      resolved: false,
      packetIds: new Set([packetId]),
      retryTimers: [],
    });
    this.pruneExpiredTelemetryRequests(now);
  }

  /**
   * A telemetry reply arrived — resolve the matching sequence (matched by the
   * reply's request_id against any of its packet ids), cancel any outstanding
   * retry timers, and drop it so no further (unnecessary) retries fire.
   */
  private resolvePendingTelemetryRequest(requestId: number): void {
    if (!requestId) return;
    const entry = this.pendingTelemetryRequests.get(requestId);
    if (!entry) return;
    entry.resolved = true;
    this.forgetTelemetrySequence(entry);
    logger.debug(`📊 Telemetry reply resolved pending request ${requestId} (cancelled any pending retries)`);
  }

  /**
   * Detect the firmware NeighborInfo-hijack of a telemetry want_response
   * (issue #4210 / meshtastic/firmware#11071) and kick off the two-retry
   * recovery sequence (30s + 70s) at most once. The inbound NeighborInfo is
   * still valid neighbor data and is processed/stored normally by the caller —
   * this only handles the retry scheduling.
   */
  private async maybeRetryHijackedTelemetry(meshPacket: { decoded?: { requestId?: number | null } }): Promise<void> {
    const requestId = meshPacket?.decoded?.requestId ? Number(meshPacket.decoded.requestId) : 0;
    if (!requestId) return;

    const now = Date.now();
    this.pruneExpiredTelemetryRequests(now); // drops the entry if it has expired
    const entry = this.pendingTelemetryRequests.get(requestId);
    if (!entry) return;

    if (entry.retried) {
      // The recovery sequence is already running (or this is a duplicate
      // hijack NeighborInfo). Loop-guard: do not start a second sequence.
      return;
    }

    // Mark retried FIRST (before scheduling) so a second hijack arriving during
    // the retry window is ignored by the guard above — the sequence runs once.
    entry.retried = true;
    const destLabel = `!${entry.destination.toString(16).padStart(8, '0')}`;
    const s1 = Math.round(MeshtasticManager.TELEMETRY_HIJACK_RETRY_DELAY_MS / 1000);
    const s2 = Math.round(MeshtasticManager.TELEMETRY_HIJACK_RETRY_2_DELAY_MS / 1000);
    logger.info(`📊 Telemetry request ${requestId} (${entry.telemetryType ?? 'device'}) to ${destLabel} was hijacked by a promiscuous NeighborInfo reply (firmware #11071); scheduling auto-retries at ${s1}s and ${s2}s (the node keeps retransmitting the want_ack'd NeighborInfo for ~10-30s, so an instant/5s retry is dropped — hardware-verified that ~30s+ recovers telemetry)`);

    this.scheduleTelemetryRetry(entry, 1);
  }

  /**
   * Schedule one attempt of the hijack-recovery sequence. Attempt 1 fires at
   * TELEMETRY_HIJACK_RETRY_DELAY_MS (30s) from the hijack; attempt 2 fires at
   * TELEMETRY_HIJACK_RETRY_2_DELAY_MS (70s) from the hijack, i.e. the delta
   * after attempt 1.
   */
  private scheduleTelemetryRetry(entry: PendingTelemetryRequest, attempt: 1 | 2): void {
    const delay = attempt === 1
      ? MeshtasticManager.TELEMETRY_HIJACK_RETRY_DELAY_MS
      : MeshtasticManager.TELEMETRY_HIJACK_RETRY_2_DELAY_MS - MeshtasticManager.TELEMETRY_HIJACK_RETRY_DELAY_MS;

    const timer = setTimeout(() => {
      entry.retryTimers = entry.retryTimers.filter((t) => t !== timer);
      this.telemetryRetryTimers.delete(timer);
      this.fireTelemetryRetry(entry, attempt);
    }, delay);
    // Do not keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
    entry.retryTimers.push(timer);
    this.telemetryRetryTimers.add(timer);
  }

  /**
   * Fire one auto-retry attempt: only send if the sequence is still unresolved
   * (no telemetry reply has cleared it) and the manager is still connected.
   * After a successful attempt-1 send, schedule attempt 2.
   */
  private fireTelemetryRetry(entry: PendingTelemetryRequest, attempt: 1 | 2): void {
    const destLabel = `!${entry.destination.toString(16).padStart(8, '0')}`;
    if (entry.resolved) {
      logger.debug(`📊 Skipping telemetry auto-retry #${attempt} to ${destLabel} — telemetry already received`);
      return;
    }
    if (!this.isConnected || !this.transport) {
      logger.debug(`📊 Skipping telemetry auto-retry #${attempt} to ${destLabel} — manager no longer connected`);
      return;
    }

    const atSeconds = attempt === 1
      ? Math.round(MeshtasticManager.TELEMETRY_HIJACK_RETRY_DELAY_MS / 1000)
      : Math.round(MeshtasticManager.TELEMETRY_HIJACK_RETRY_2_DELAY_MS / 1000);
    logger.info(`📊 Auto-retry #${attempt} (${atSeconds}s after hijack) of telemetry request to ${destLabel} (firmware #11071 NeighborInfo hijack recovery)`);

    this.sendTelemetryRequest(entry.destination, entry.channel, entry.telemetryType, { isAutoRetry: true })
      .then(({ packetId }) => {
        // Link this retry's packet id so its telemetry reply resolves the
        // sequence (and cancels a later retry). Skip if resolved meanwhile.
        if (!entry.resolved && packetId) {
          entry.packetIds.add(packetId);
          this.pendingTelemetryRequests.set(packetId, entry);
        }
      })
      .catch((error) => {
        logger.warn(`Failed to auto-retry hijacked telemetry request to ${destLabel}:`, error);
      });

    if (attempt === 1) {
      this.scheduleTelemetryRetry(entry, 2);
    }
  }

  /**
   * Send a telemetry request to a remote node
   * This sends an empty telemetry packet with wantResponse=true to request telemetry data
   */
  async sendTelemetryRequest(
    destination: number,
    channel: number = 0,
    telemetryType?: 'device' | 'environment' | 'airQuality' | 'power',
    options?: { isAutoRetry?: boolean }
  ): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.isTxEnabled()) {
      throw new TxDisabledError();
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      const { data: telemetryRequestData, packetId, requestId } = meshtasticProtobufService.createTelemetryRequestMessage(
        destination,
        channel,
        telemetryType
      );

      const typeLabel = telemetryType || 'device';
      logger.debug(`📊 Telemetry request packet created: ${telemetryRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, type=${typeLabel}, packetId=${packetId}, requestId=${requestId}`);

      await this.transport.send(telemetryRequestData);

      // Broadcast to virtual node clients (including packet monitor)
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(telemetryRequestData);
          logger.debug(`📡 Broadcasted outgoing Telemetry request to virtual node clients (${telemetryRequestData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing Telemetry request:', error);
        }
      }

      logger.debug(`📤 Telemetry request (${typeLabel}) sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing Telemetry request to packet monitor
      await this.logOutgoingPacket(
        67, // TELEMETRY_APP
        destination,
        channel,
        `Telemetry request (${typeLabel}) to !${destination.toString(16).padStart(8, '0')}`,
        { destination, telemetryType: typeLabel, packetId, requestId }
      );

      // Track this outstanding request so the firmware NeighborInfo-hijack
      // (issue #4210) can be detected + auto-retried. Firmware echoes the
      // request's MeshPacket id back as the reply's request_id, so key by packetId.
      // Auto-retry sends are NOT recorded as new sequences — they are linked onto
      // the existing sequence by maybeRetryHijackedTelemetry so a reply to a
      // retry resolves (and stops) the whole sequence.
      if (!options?.isAutoRetry) {
        this.recordPendingTelemetryRequest(packetId, destination, channel, telemetryType);
      }

      return { packetId, requestId };
    } catch (error) {
      logger.error('Error sending Telemetry request:', error);
      throw error;
    }
  }

  /**
   * Broadcast NodeInfo to all nodes on a specific channel
   * Uses the broadcast address (0xFFFFFFFF) to send to all nodes
   * wantAck is set to false to reduce mesh traffic
   */
  async broadcastNodeInfoToChannel(channel: number): Promise<{ packetId: number; requestId: number }> {
    const BROADCAST_ADDR = 0xFFFFFFFF;
    logger.debug(`📢 Broadcasting NodeInfo on channel ${channel}`);
    return this.sendNodeInfoRequest(BROADCAST_ADDR, channel);
  }

  /**
   * Broadcast NodeInfo to multiple channels with delays between each
   * Used by auto-announce feature to broadcast on secondary channels
   */
  async broadcastNodeInfoToChannels(channels: number[], delaySeconds: number): Promise<void> {
    if (this.rebootMergeInProgress) {
      logger.debug('📢 Skipping NodeInfo broadcast - reboot merge in progress');
      return;
    }

    if (!this.isConnected || !this.transport) {
      logger.warn('📢 Cannot broadcast NodeInfo - not connected');
      return;
    }

    if (channels.length === 0) {
      logger.debug('📢 No channels selected for NodeInfo broadcast');
      return;
    }

    logger.debug(`📢 Starting NodeInfo broadcast to ${channels.length} channel(s) with ${delaySeconds}s delay`);

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      try {
        await this.broadcastNodeInfoToChannel(channel);
        logger.debug(`📢 NodeInfo broadcast sent to channel ${channel} (${i + 1}/${channels.length})`);

        // Wait between broadcasts (except after the last one)
        if (i < channels.length - 1) {
          logger.debug(`📢 Waiting ${delaySeconds}s before next channel broadcast...`);
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        }
      } catch (error) {
        logger.error(`❌ Failed to broadcast NodeInfo on channel ${channel}:`, error);
        // Continue with next channel even if one fails
      }
    }

    logger.debug(`📢 NodeInfo broadcast complete for all ${channels.length} channel(s)`);
  }

  /**
   * Request LocalStats from the local node
   * This requests mesh statistics from the directly connected device
   */
  async requestLocalStats(): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      const { data: telemetryRequestData, packetId, requestId } =
        meshtasticProtobufService.createTelemetryRequestMessage(
          this.localNodeInfo.nodeNum,
          0 // Channel 0 for local node communication
        );

      logger.debug(`📊 LocalStats request packet created: ${telemetryRequestData.length} bytes for local node ${this.localNodeInfo.nodeId}, packetId=${packetId}, requestId=${requestId}`);

      await this.transport.send(telemetryRequestData);

      // Broadcast to virtual node clients (including packet monitor)
      const virtualNodeServer = this.virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(telemetryRequestData);
          logger.debug(`📡 Broadcasted outgoing LocalStats request to virtual node clients (${telemetryRequestData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing LocalStats request:', error);
        }
      }

      logger.debug(`📤 LocalStats request sent to local node ${this.localNodeInfo.nodeId}`);
      return { packetId, requestId };
    } catch (error) {
      logger.error('Error requesting LocalStats:', error);
      throw error;
    }
  }

  /**
   * Request local_stats telemetry from a REMOTE node (issue #3398).
   *
   * Unlike requestLocalStats() (gateway-only), this targets an arbitrary node and
   * explicitly requests the `local_stats` variant — the firmware reply echoes the
   * requested variant, so a generic request would return DeviceMetrics instead.
   * Sent as a unicast on the node's channel (shared PSK), NOT a PKI DM: unicast
   * bypasses the firmware's multi-hop-broadcast role gate (so REPEATER/CLIENT nodes
   * answer too) and channel routing avoids stale-key fragility. The reply is
   * persisted by the existing telemetry handler.
   */
  async requestRemoteLocalStats(destination: number, channel: number = 0, hopLimit: number = 3): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    const { data: telemetryRequestData, packetId, requestId } =
      meshtasticProtobufService.createTelemetryRequestMessage(
        destination,
        channel,
        'localStats',
        hopLimit
      );

    if (telemetryRequestData.length === 0) {
      throw new Error('Failed to build remote LocalStats request');
    }

    await this.transport.send(telemetryRequestData);

    // Broadcast to virtual node clients (including packet monitor) for visibility.
    const virtualNodeServer = this.virtualNodeServer;
    if (virtualNodeServer) {
      try {
        await virtualNodeServer.broadcastToClients(telemetryRequestData);
      } catch (error) {
        logger.error('Virtual node: Failed to broadcast outgoing remote LocalStats request:', error);
      }
    }

    logger.debug(`📤 Remote LocalStats request sent to ${destination.toString(16)} (packetId=${packetId}, requestId=${requestId})`);
    return { packetId, requestId };
  }

  /**
   * Send raw ToRadio message to the physical node
   * Used by virtual node server to forward messages from mobile clients
   */
  async sendRawMessage(data: Uint8Array): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      await this.transport.send(data);
      logger.debug(`📤 Raw message forwarded to physical node (${data.length} bytes)`);
    } catch (error) {
      logger.error('Error sending raw message:', error);
      throw error;
    }
  }

  /**
   * Get cached initialization config messages for virtual node server
   * Returns the raw FromRadio messages with type metadata captured during our connection to the physical node
   * These can be replayed to virtual node clients for faster initialization
   * Dynamic types (myInfo, nodeInfo) should be rebuilt from database for freshness
   */
  getCachedInitConfig(): Array<{ type: string; data: Uint8Array }> {
    if (!this.configCaptureComplete) {
      logger.warn('⚠️ Init config capture not yet complete, returning partial cache');
    }
    return [...this.initConfigCache]; // Return a copy
  }

  /**
   * Check if init config capture is complete
   */
  isInitConfigCaptureComplete(): boolean {
    return this.configCaptureComplete;
  }

  /**
   * Check if message matches auto-acknowledge pattern and send automated reply
   */
  /**
   * Send notifications for new message (Web Push + Apprise)
   */
  private async sendMessagePushNotification(message: any, messageText: string, isDirectMessage: boolean): Promise<void> {
    try {
      // Skip if no notification services are available
      const serviceStatus = notificationService.getServiceStatus();
      if (!serviceStatus.anyAvailable) {
        return;
      }

      // Skip non-chat messages (telemetry, traceroutes, etc.). ATAK GeoChat
      // (PortNum.ATAK_PLUGIN) is a real chat message too — see processTakPacket —
      // and gets a push notification the same as a text message (spec §7.3).
      if (message.portnum !== PortNum.TEXT_MESSAGE_APP && message.portnum !== PortNum.ATAK_PLUGIN) {
        return;
      }

      // Skip messages from our own locally connected node
      const localNodeNum = this.localNodeInfo?.nodeNum?.toString() ?? await databaseService.settings.getSetting(this.localNodeSettingKey('localNodeNum'));
      if (localNodeNum && parseInt(localNodeNum) === message.fromNodeNum) {
        logger.debug('⏭️  Skipping push notification for message from local node');
        return;
      }

      // Get sender info
      const fromNode = await databaseService.nodes.getNode(message.fromNodeNum);
      const senderName = fromNode?.longName || fromNode?.shortName || `Node ${message.fromNodeNum}`;

      // Determine notification title and body
      let title: string;
      let body: string;

      if (isDirectMessage) {
        title = `Direct Message from ${senderName}`;
        body = messageText.length > 100 ? messageText.substring(0, 97) + '...' : messageText;
      } else {
        // Get channel name
        const channel = await databaseService.channels.getChannelById(message.channel, this.sourceId);
        const channelName = channel?.name || `Channel ${message.channel}`;
        title = `${senderName} in ${channelName}`;
        body = messageText.length > 100 ? messageText.substring(0, 97) + '...' : messageText;
      }

      // Build navigation data for push notification click handling
      const navigationData = isDirectMessage
        ? {
            type: 'dm' as const,
            messageId: message.id,
            senderNodeId: fromNode?.nodeId || message.fromNodeId,
          }
        : {
            type: 'channel' as const,
            channelId: message.channel,
            messageId: message.id,
          };

      // Phase B: resolve source name for prefixing
      const source = await databaseService.sources.getSource(this.sourceId);
      const sourceName = source?.name || this.sourceId;

      // Send notifications (Web Push + Apprise) with filtering to all subscribed users
      const result = await notificationService.broadcast({
        title,
        body,
        data: navigationData,
        sourceId: this.sourceId,
        sourceName,
      }, {
        messageText,
        channelId: message.channel,
        isDirectMessage,
        viaMqtt: message.viaMqtt === true,
        sourceId: this.sourceId,
        sourceName,
      });

      logger.debug(
        `📤 Sent notifications: ${result.total.sent} delivered, ${result.total.failed} failed, ${result.total.filtered} filtered ` +
        `(Push: ${result.webPush.sent}/${result.webPush.failed}/${result.webPush.filtered}, ` +
        `Apprise: ${result.apprise.sent}/${result.apprise.failed}/${result.apprise.filtered})`
      );
    } catch (error) {
      logger.error('❌ Error sending message push notification:', error);
      // Don't throw - push notification failures shouldn't break message processing
    }
  }

  private async checkAutoAcknowledge(message: any, messageText: string, channelIndex: number, isDirectMessage: boolean, fromNum: number, packetId?: number, rxSnr?: number, rxRssi?: number): Promise<void> {
    try {
      // Per-packet dedup guard: prevent duplicate auto-ack responses for the same
      // mesh packet. This can happen when the transport delivers the same packet
      // twice (e.g. LoRa + MQTT proxy, serial retransmission) and the non-awaited
      // processIncomingData handler processes them concurrently (#2642).
      if (packetId != null) {
        if (this.autoAckProcessedPackets.has(packetId)) {
          logger.debug(`⏭️ Skipping auto-acknowledge for packet ${packetId}: already processed`);
          return;
        }
        this.autoAckProcessedPackets.add(packetId);
        // Prevent unbounded memory growth — trim to last 500 entries
        if (this.autoAckProcessedPackets.size > 1000) {
          const entries = Array.from(this.autoAckProcessedPackets);
          this.autoAckProcessedPackets = new Set(entries.slice(-500));
        }
      }

      // All auto-ack settings are per-source: each MeshtasticManager instance
      // has its own sourceId and the UI writes to `source:{sourceId}:autoAck*`
      // keys. Reading from the global namespace here would resolve to stale or
      // missing values (e.g. `autoAckChannels` is never written globally, so
      // the channel allowlist would always be empty → every channel message
      // gets rejected — exactly the "outside senders ignored" symptom).
      const settings = databaseService.settings;
      const sourceId = this.sourceId;

      // Get auto-acknowledge settings from database (per-source)
      const autoAckEnabled = await settings.getSettingForSource(sourceId, 'autoAckEnabled');
      const autoAckRegex = await settings.getSettingForSource(sourceId, 'autoAckRegex');

      // Skip if auto-acknowledge is disabled
      if (autoAckEnabled !== 'true') {
        return;
      }

      // Airtime cutoff: skip while the mesh is congested
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      // Check channel-specific settings
      const autoAckChannels = await settings.getSettingForSource(sourceId, 'autoAckChannels');
      const autoAckIgnoredNodes = await settings.getSettingForSource(sourceId, 'autoAckIgnoredNodes');

      // Parse enabled channels (comma-separated list of channel indices)
      const enabledChannels = autoAckChannels
        ? autoAckChannels.split(',').map(c => parseInt(c.trim())).filter(n => !isNaN(n))
        : [];

      // Parse optional node ignore list. Supports canonical !xxxxxxxx entries.
      const ignoredNodeNums = new Set<number>();
      if (autoAckIgnoredNodes) {
        const ignoredNodeIds = autoAckIgnoredNodes
          .split(/[\s,]+/)
          .map(token => token.trim().toLowerCase())
          .filter(Boolean);

        for (const nodeId of ignoredNodeIds) {
          const normalizedNodeId = nodeId.startsWith('!') ? nodeId.slice(1) : nodeId;
          if (/^[0-9a-f]{8}$/.test(normalizedNodeId)) {
            ignoredNodeNums.add(parseInt(normalizedNodeId, 16));
          }
        }
      }

      // Channel allowlist gate. Direct messages have no separate "DM enabled"
      // master anymore — they're gated later by the Direct matrix cells (a DM
      // only acks if its DirectZeroHop/DirectMultiHop cell enables reply or
      // tapback). Channel messages must still be on an allowlisted channel.
      if (!isDirectMessage) {
        const enabledChannelsSet = new Set(enabledChannels);
        if (!enabledChannelsSet.has(channelIndex)) {
          logger.debug(`⏭️  Skipping auto-acknowledge for channel ${channelIndex} (not in enabled channels)`);
          return;
        }
      }

      // Skip messages from our own locally connected node
      const localNodeNum = this.localNodeInfo?.nodeNum?.toString() ?? await settings.getSetting(this.localNodeSettingKey('localNodeNum'));
      if (localNodeNum && parseInt(localNodeNum) === fromNum) {
        logger.debug('⏭️  Skipping auto-acknowledge for message from local node');
        return;
      }

      if (ignoredNodeNums.has(fromNum)) {
        logger.debug(`⏭️  Skipping auto-acknowledge for ignored node !${fromNum.toString(16).padStart(8, '0')}`);
        return;
      }

      // Skip auto-acknowledge for incomplete nodes (nodes we haven't received full NODEINFO from)
      // This prevents sending automated messages to nodes that may not be on the same secure channel
      const autoAckSkipIncompleteNodes = await settings.getSettingForSource(sourceId, 'autoAckSkipIncompleteNodes');
      if (autoAckSkipIncompleteNodes === 'true') {
        // Must scope getNode() by sourceId: under the composite (nodeNum,sourceId)
        // PK an unscoped lookup can return a different source's row or nothing.
        const fromNode = await databaseService.nodes.getNode(fromNum, sourceId);
        if (fromNode && !isNodeComplete(fromNode)) {
          logger.debug(`⏭️  Skipping auto-acknowledge for incomplete node ${fromNode.nodeId || fromNum} (missing proper name or hwModel)`);
          return;
        }
      }

      // Per-node cooldown rate limiting
      const cooldownSetting = await settings.getSettingForSource(sourceId, 'autoAckCooldownSeconds');
      const cooldownSeconds = cooldownSetting ? parseInt(cooldownSetting, 10) : 60;
      if (cooldownSeconds > 0) {
        const lastResponse = this.autoAckCooldowns.get(fromNum);
        if (lastResponse && Date.now() - lastResponse < cooldownSeconds * 1000) {
          logger.debug(`⏭️  Skipping auto-acknowledge for node ${fromNum}: cooldown active (${cooldownSeconds}s)`);
          return;
        }
      }

      // Use default regex if not set
      const regexPattern = autoAckRegex || '^(test|ping)';

      // Use cached regex if pattern hasn't changed, otherwise compile and cache
      let regex: RegExp;
      if (this.cachedAutoAckRegex && this.cachedAutoAckRegex.pattern === regexPattern) {
        regex = this.cachedAutoAckRegex.regex;
      } else {
        try {
          regex = compileUserRegex(regexPattern, 'i');
          this.cachedAutoAckRegex = { pattern: regexPattern, regex };
        } catch (error) {
          logger.error('❌ Invalid auto-acknowledge regex pattern:', regexPattern, error);
          return;
        }
      }

      // Test if message matches the pattern (case-insensitive by default)
      const matches = regex.test(messageText);

      if (!matches) {
        return;
      }

      // Calculate hop count (hopStart - hopLimit gives hops traveled)
      // Only calculate if both values are valid and hopStart >= hopLimit
      const hopsTraveled =
        message.hopStart !== null &&
        message.hopStart !== undefined &&
        message.hopLimit !== null &&
        message.hopLimit !== undefined &&
        message.hopStart >= message.hopLimit
          ? message.hopStart - message.hopLimit
          : 0;

      // 2x2 matrix (discussion #3564): {Channel,Direct} × {ZeroHop,MultiHop}.
      // Message type comes from isDirectMessage (DM vs channel); hop distance
      // from hopsTraveled. MQTT-relayed packets are never "zero hop" even at 0
      // hops — they traversed the internet, not a direct RF link, so RF metrics
      // (SNR/RSSI) and the 0-hop notion don't apply.
      const isZeroHop = autoAckIsZeroHop(hopsTraveled, message.viaMqtt);
      const cellKey = autoAckCellKey(isDirectMessage, isZeroHop);

      // Per-cell toggles. Unset reads as OFF — the matrix is opt-in per cell;
      // migration 093 backfills explicit values for pre-existing configs so they
      // keep their behavior.
      const cellReplyEnabled =
        (await settings.getSettingForSource(sourceId, `${cellKey}ReplyEnabled`)) === 'true';
      const cellTapbackEnabled =
        (await settings.getSettingForSource(sourceId, `${cellKey}TapbackEnabled`)) === 'true';
      const cellReplyDmEnabled =
        (await settings.getSettingForSource(sourceId, `${cellKey}ReplyDmEnabled`)) === 'true';

      // If neither reply nor tapback is enabled for this cell, skip
      if (!cellReplyEnabled && !cellTapbackEnabled) {
        logger.debug(`⏭️ Skipping auto-acknowledge: ${cellKey} has neither reply nor tapback enabled`);
        return;
      }

      // "Respond via DM" applies to the message reply only — tapback reactions
      // sent as DMs are unreliable on Meshtastic, so tapbacks always go back the
      // way the trigger arrived (see resolveAutoAckReplyRouting for reply routing).

      // Pre-send delay (#3876): optionally wait before queuing the ack so a
      // repeater can finish its own TX (a zero-hop reply sent too early is
      // dropped). This handler is awaited in the packet path, so we DEFER the
      // enqueue via setTimeout rather than blocking — matching the
      // autoWelcomeDelay pattern. 0 = enqueue immediately (default).
      const preSendDelaySeconds = resolveAutoAckPreSendDelaySeconds(
        await settings.getSettingForSource(sourceId, 'autoAckPreSendDelaySeconds'),
      );
      const dispatchAck = (enqueue: () => void): void => {
        if (preSendDelaySeconds > 0) {
          setTimeout(enqueue, preSendDelaySeconds * 1000);
        } else {
          enqueue();
        }
      };

      // --- Tapback (hop-count emoji reaction) ---
      // Delivered the same way the trigger arrived: DM→DM, channel→channel.
      // Note: packetId can be 0 (valid unsigned integer), so check explicitly.
      if (cellTapbackEnabled && packetId != null) {
        // Hop count emojis: *️⃣ for 0 (direct), 1️⃣-7️⃣ for 1-7+ hops
        const HOP_COUNT_EMOJIS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
        const hopEmoji = HOP_COUNT_EMOJIS[Math.min(hopsTraveled, 7)];
        const tapbackTarget = isDirectMessage
          ? `!${fromNum.toString(16).padStart(8, '0')}`
          : `channel ${channelIndex}`;

        logger.debug(`🤖 Auto-acknowledging with tapback ${hopEmoji} (${hopsTraveled} hops) to ${tapbackTarget}`);

        // Route tapback through message queue for rate limiting (after the
        // optional pre-send delay).
        dispatchAck(() => this.messageQueue.enqueue(
          hopEmoji,
          isDirectMessage ? fromNum : 0, // destination: node number for DM, 0 for channel
          packetId, // replyId - react to the original message
          () => {
            logger.debug(`✅ Auto-acknowledge tapback ${hopEmoji} delivered to ${tapbackTarget}`);
          },
          (reason: string) => {
            logger.warn(`❌ Auto-acknowledge tapback failed to ${tapbackTarget}: ${reason}`);
          },
          isDirectMessage ? undefined : channelIndex, // channel
          1, // maxAttempts - tapbacks are best-effort, don't retry
          1 // emoji flag = 1 for tapback/reaction
        ));
      }

      // --- Message reply ---
      if (cellReplyEnabled) {
        // Get auto-acknowledge message template (per-source)
        // Use the direct message template for 0 hops if available, otherwise fall back to standard template
        const autoAckMessageDirect = await settings.getSettingForSource(sourceId, 'autoAckMessageDirect') || '';
        const autoAckMessageStandard = await settings.getSettingForSource(sourceId, 'autoAckMessage') || '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
        const autoAckMessage = (hopsTraveled === 0 && autoAckMessageDirect)
          ? autoAckMessageDirect
          : autoAckMessageStandard;

        // Format timestamp according to user preferences
        const timestamp = new Date(message.timestamp);

        // Date/time formatting is a presentation preference — global setting.
        const dateFormat = await settings.getSetting('dateFormat') || 'MM/DD/YYYY';
        const timeFormat = await settings.getSetting('timeFormat') || '24';

        // Use formatDate and formatTime utilities to respect user preferences
        const receivedDate = formatDate(timestamp, dateFormat as 'MM/DD/YYYY' | 'DD/MM/YYYY');
        const receivedTime = formatTime(timestamp, timeFormat as '12' | '24');

        // Replace tokens in the message template
        const ackText = await this.replaceAcknowledgementTokens(autoAckMessage, message.fromNodeId, fromNum, hopsTraveled, receivedDate, receivedTime, channelIndex, isDirectMessage, rxSnr, rxRssi, message.viaMqtt, false, message.relayNode);

        // Route the reply (on-channel vs DM, and whether it can be threaded).
        const { replyViaDm, replyDest, replyChannel, replyId } = resolveAutoAckReplyRouting({
          isDirectMessage, cellReplyDmEnabled, channelIndex, fromNum, packetId,
        });
        const replyTarget = replyViaDm
          ? `!${fromNum.toString(16).padStart(8, '0')}`
          : `channel ${channelIndex}`;

        logger.debug(`🤖 Auto-acknowledging message from ${message.fromNodeId}: "${messageText}" with "${ackText}"${replyViaDm ? ' (via DM)' : ''}`);

        // Use message queue to send auto-acknowledge with rate limiting and
        // retry logic (after the optional pre-send delay).
        dispatchAck(() => this.messageQueue.enqueue(
          ackText,
          replyDest, // destination: node number for DM, 0 for channel
          replyId, // replyId
          () => {
            logger.debug(`✅ Auto-acknowledge message delivered to ${replyTarget}`);
          },
          (reason: string) => {
            logger.warn(`❌ Auto-acknowledge message failed to ${replyTarget}: ${reason}`);
          },
          replyChannel // channel: undefined for DM, channel number for channel
        ));
      }

      // Record cooldown timestamp after successful response
      this.autoAckCooldowns.set(fromNum, Date.now());
    } catch (error) {
      logger.error('❌ Error in auto-acknowledge:', error);
    }
  }

  /**
   * Check if message matches auto-responder triggers and respond accordingly
   */
  /**
   * Resolves a script path from the stored format (/data/scripts/...) to the actual file system path.
   * In production, honors DATA_DIR env var (set by desktop sidecar) and falls back to /data.
   */
  private resolveScriptPath(scriptPath: string): string | null {
    // Validate script path (security check)
    if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
      logger.error(`🚫 Invalid script path: ${scriptPath}`);
      return null;
    }

    const env = getEnvironmentConfig();

    let scriptsDir: string;

    if (env.isDevelopment) {
      const projectRoot = path.resolve(process.cwd());
      scriptsDir = path.join(projectRoot, 'data', 'scripts');
    } else {
      scriptsDir = path.join(process.env.DATA_DIR || '/data', 'scripts');
    }

    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
      logger.debug(`📁 Created scripts directory: ${scriptsDir}`);
    }

    const filename = path.basename(scriptPath);
    const resolvedPath = path.join(scriptsDir, filename);
    
    // Additional security: ensure resolved path is within scripts directory
    const normalizedResolved = path.normalize(resolvedPath);
    const normalizedScriptsDir = path.normalize(scriptsDir);
    
    if (!normalizedResolved.startsWith(normalizedScriptsDir)) {
      logger.error(`🚫 Script path resolves outside scripts directory: ${scriptPath}`);
      return null;
    }
    
    logger.debug(`📂 Resolved script path: ${scriptPath} -> ${normalizedResolved} (exists: ${fs.existsSync(normalizedResolved)})`);
    
    return normalizedResolved;
  }

  // ==========================================
  // Auto-Ping Methods
  // ==========================================

  /**
   * Handle auto-ping DM commands: "ping N" to start, "ping stop" to cancel
   * Returns true if the command was handled, false otherwise
   */
  async handleAutoPingCommand(message: TextMessage, isDirectMessage: boolean): Promise<boolean> {
    // Only handle DMs
    if (!isDirectMessage) return false;

    const text = (message.text || '').trim().toLowerCase();

    // Check if this matches a ping command
    const pingStartMatch = text.match(/^ping\s+(\d+)$/);
    const pingStopMatch = text.match(/^ping\s+stop$/);

    if (!pingStartMatch && !pingStopMatch) return false;

    // Check if auto-ping is enabled (per-source override beats global)
    const autoPingEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingEnabled');
    if (autoPingEnabled !== 'true') {
      logger.debug('⏭️  Auto-ping command received but feature is disabled');
      return false;
    }

    // Airtime cutoff: skip auto-ping while the mesh is congested
    if (await this.isAutomationAirtimeGated()) {
      return false;
    }

    const fromNum = message.fromNodeNum;
    const channelIndex = message.channel ?? 0;

    if (pingStopMatch) {
      // Handle "ping stop"
      const session = this.autoPingSessions.get(fromNum);
      if (session) {
        logger.debug(`🛑 Auto-ping stop requested by !${fromNum.toString(16).padStart(8, '0')}`);
        this.stopAutoPingSession(fromNum, 'cancelled');
      } else {
        await this.sendTextMessage('No active ping session to stop.', 0, fromNum);
        this.messageQueue.recordExternalSend();
      }
      return true;
    }

    if (pingStartMatch) {
      const count = parseInt(pingStartMatch[1], 10);
      const maxPings = parseInt((await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingMaxPings')) || '20', 10);
      const intervalSeconds = parseInt((await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingIntervalSeconds')) || '30', 10);
      // Resolve the ack timeout once here rather than per-ping: it lets us arm
      // pendingRequestId + pendingTimeout synchronously after each send (no await
      // between), closing the window where a fast response could be missed.
      const timeoutSeconds = parseInt((await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingTimeoutSeconds')) || '60', 10);

      // Validate count
      if (count <= 0) {
        await this.sendTextMessage('Ping count must be at least 1.', 0, fromNum);
        this.messageQueue.recordExternalSend();
        return true;
      }

      const actualCount = Math.min(count, maxPings);

      // Check for existing session
      if (this.autoPingSessions.has(fromNum)) {
        await this.sendTextMessage(`You already have an active ping session. Send "ping stop" to cancel it first.`, 0, fromNum);
        this.messageQueue.recordExternalSend();
        return true;
      }

      // Create session
      const session: AutoPingSession = {
        requestedBy: fromNum,
        channel: channelIndex,
        totalPings: actualCount,
        completedPings: 0,
        successfulPings: 0,
        failedPings: 0,
        intervalMs: intervalSeconds * 1000,
        timeoutMs: timeoutSeconds * 1000,
        timer: null,
        sending: false,
        pendingRequestId: null,
        pendingTimeout: null,
        startTime: Date.now(),
        lastPingSentAt: 0,
        results: [],
      };

      this.autoPingSessions.set(fromNum, session);

      const cappedMsg = count > maxPings ? ` (capped to ${maxPings})` : '';
      await this.sendTextMessage(
        `Starting ${actualCount} pings every ${intervalSeconds}s${cappedMsg}. Send "ping stop" to cancel.`,
        0, fromNum
      );
      this.messageQueue.recordExternalSend();

      logger.debug(`📡 Auto-ping session started for !${fromNum.toString(16).padStart(8, '0')}: ${actualCount} pings every ${intervalSeconds}s`);

      // Emit session started event
      await this.emitAutoPingUpdate(session, 'started');

      // Start pinging
      this.startAutoPingSession(session);

      return true;
    }

    return false;
  }

  /**
   * Start the auto-ping session — waits one full interval before the first ping
   */
  private startAutoPingSession(session: AutoPingSession): void {
    session.timer = setInterval(() => {
      void this.sendNextAutoPing(session);
    }, session.intervalMs);
  }

  /**
   * Send the next ping in the auto-ping session
   */
  private async sendNextAutoPing(session: AutoPingSession): Promise<void> {
    // Check if session is complete — send summary as the final message
    if (session.completedPings >= session.totalPings) {
      void this.finalizeAutoPingSession(session.requestedBy);
      return;
    }

    // Don't send another ping if one is still pending OR a send is in-flight.
    // `sending` is set synchronously below before the first await, so a second
    // interval tick that fires during sendTextMessage() can't slip past this
    // guard and launch a duplicate ping (the check-then-act race that produced
    // orphaned pings whose acks never matched).
    if (session.pendingRequestId !== null || session.sending) {
      return;
    }
    session.sending = true;

    try {
      const pingNum = session.completedPings + 1;
      const pingMessage = `Ping ${pingNum}/${session.totalPings}`;

      const requestId = await this.sendTextMessage(pingMessage, 0, session.requestedBy);
      this.messageQueue.recordExternalSend();
      // Arm pendingRequestId and the ack timeout synchronously (timeoutMs was
      // resolved at session start) so a fast response can't arrive between the
      // two and leave an orphaned timeout that double-counts the ping.
      session.pendingRequestId = requestId;
      session.lastPingSentAt = Date.now();
      session.pendingTimeout = setTimeout(() => {
        this.handleAutoPingTimeout(session);
      }, session.timeoutMs);

      logger.debug(`📡 Auto-ping ${pingNum}/${session.totalPings} sent to !${session.requestedBy.toString(16).padStart(8, '0')} (requestId: ${requestId})`);
    } catch (error) {
      logger.error(`❌ Auto-ping failed to send to !${session.requestedBy.toString(16).padStart(8, '0')}:`, error);
      // Record as failed
      session.results.push({
        pingNum: session.completedPings + 1,
        status: 'timeout',
        sentAt: Date.now(),
      });
      session.completedPings++;
      session.failedPings++;
      await this.emitAutoPingUpdate(session, 'ping_result');

      // Session completion is handled by the next interval tick
    } finally {
      session.sending = false;
    }
  }

  /**
   * Handle a Routing (ACK/NAK) packet for a pending auto-ping.
   *
   * A want_ack DM produces TWO Routing packets with the SAME request_id, both
   * with error_reason=NONE, differing only by `from` (confirmed against firmware):
   *   1. an implicit transmit ACK from OUR OWN local node (it overheard the
   *      rebroadcast) — arrives first, only proves the packet entered the mesh;
   *   2. the real end-to-end ACK from the DESTINATION — arrives second, or never.
   * A genuine delivery failure is a NAK (non-zero error_reason, e.g.
   * MAX_RETRANSMIT) emitted by the originating (local) node.
   *
   * Matching on request_id alone latched the transmit ACK first and reported a
   * false success with a bogus (transmit-only) duration, dropping the real ACK
   * and any later failure NAK. So we now resolve a ping ONLY on:
   *   - error_reason != 0  → NAK (delivery failed), or
   *   - error_reason == 0 AND from == the destination (the requester) → real ACK.
   * Any other request_id match (error_reason 0 from our local node or a relay)
   * is a transmit/relay confirmation and is ignored so the session keeps waiting.
   *
   * @param requestId   the original sent packet id the Routing packet references
   * @param fromNum     the node that emitted this Routing packet
   * @param errorReason Routing.Error value (0 = NONE/success)
   */
  handleAutoPingResponse(requestId: number, fromNum: number, errorReason: number): void {
    // Find session with matching pendingRequestId
    for (const [nodeNum, session] of this.autoPingSessions) {
      if (session.pendingRequestId !== requestId) continue;

      const isFailure = errorReason !== 0;
      const isDestinationAck = errorReason === 0 && fromNum === session.requestedBy;

      // Not a terminal signal for this ping (transmit-only self-ack or a relay's
      // NONE) — leave the ping pending so the real ack / failure / timeout wins.
      if (!isFailure && !isDestinationAck) {
        return;
      }

      const status: 'ack' | 'nak' = isDestinationAck ? 'ack' : 'nak';

      // Clear the timeout
      if (session.pendingTimeout) {
        clearTimeout(session.pendingTimeout);
        session.pendingTimeout = null;
      }

      const durationMs = Date.now() - session.lastPingSentAt;
      session.results.push({
        pingNum: session.completedPings + 1,
        status,
        durationMs,
        sentAt: session.lastPingSentAt,
      });

      session.completedPings++;
      if (status === 'ack') {
        session.successfulPings++;
      } else {
        session.failedPings++;
      }
      session.pendingRequestId = null;

      logger.debug(`📡 Auto-ping ${session.completedPings}/${session.totalPings} ${status.toUpperCase()} from !${nodeNum.toString(16).padStart(8, '0')} (${durationMs}ms)`);

      this.emitAutoPingUpdate(session, 'ping_result').catch(err => logger.error('Error emitting auto-ping update:', err));

      // Session completion is handled by the next interval tick in sendNextAutoPing
      return;
    }
  }

  /**
   * Handle a timeout for a pending auto-ping (no response received in time)
   */
  private handleAutoPingTimeout(session: AutoPingSession): void {
    if (session.pendingRequestId === null) return;

    session.results.push({
      pingNum: session.completedPings + 1,
      status: 'timeout',
      sentAt: session.lastPingSentAt,
    });

    session.completedPings++;
    session.failedPings++;
    session.pendingRequestId = null;
    session.pendingTimeout = null;

    logger.debug(`⏰ Auto-ping ${session.completedPings}/${session.totalPings} TIMEOUT for !${session.requestedBy.toString(16).padStart(8, '0')}`);

    this.emitAutoPingUpdate(session, 'ping_result').catch(err => logger.error('Error emitting auto-ping update:', err));

    // Session completion is handled by the next interval tick in sendNextAutoPing
  }

  /**
   * Finalize an auto-ping session (all pings completed)
   */
  private async finalizeAutoPingSession(requestedBy: number): Promise<void> {
    const session = this.autoPingSessions.get(requestedBy);
    if (!session) return;

    // Remove from map immediately to prevent double-finalize
    this.autoPingSessions.delete(requestedBy);

    // Clear timers
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    if (session.pendingTimeout) {
      clearTimeout(session.pendingTimeout);
      session.pendingTimeout = null;
    }

    // Build summary with statistics
    const ackDurations = session.results
      .filter(r => r.status === 'ack' && r.durationMs)
      .map(r => r.durationMs!);
    const timeouts = session.results.filter(r => r.status === 'timeout').length;
    const naks = session.results.filter(r => r.status === 'nak').length;

    let summary = `Auto-ping done: ${session.successfulPings}/${session.totalPings} ok`;
    if (ackDurations.length > 0) {
      const min = Math.min(...ackDurations);
      const max = Math.max(...ackDurations);
      const avg = Math.round(ackDurations.reduce((a, b) => a + b, 0) / ackDurations.length);
      summary += `\nMin/Avg/Max: ${min}/${avg}/${max}ms`;
    }
    if (timeouts > 0) {
      summary += `\nTimeouts: ${timeouts}`;
    }
    if (naks > 0) {
      summary += `\nFailed: ${naks}`;
    }

    try {
      await this.sendTextMessage(summary, 0, requestedBy);
      this.messageQueue.recordExternalSend();
    } catch (error) {
      logger.error(`❌ Failed to send auto-ping summary to !${requestedBy.toString(16).padStart(8, '0')}:`, error);
    }

    await this.emitAutoPingUpdate(session, 'completed');

    logger.debug(`✅ Auto-ping session completed for !${requestedBy.toString(16).padStart(8, '0')}: ${session.successfulPings}/${session.totalPings} successful`);
  }

  /**
   * Stop an auto-ping session (user cancelled or force-stopped from UI)
   */
  stopAutoPingSession(requestedBy: number, reason: 'cancelled' | 'force_stopped' = 'cancelled'): void {
    const session = this.autoPingSessions.get(requestedBy);
    if (!session) return;

    // Clear timers
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    if (session.pendingTimeout) {
      clearTimeout(session.pendingTimeout);
      session.pendingTimeout = null;
    }

    const summary = `Auto-ping ${reason}: ${session.successfulPings}/${session.completedPings} successful out of ${session.totalPings} planned.`;

    this.sendTextMessage(summary, 0, requestedBy).then(() => {
      this.messageQueue.recordExternalSend();
    }).catch(error => {
      logger.error(`❌ Failed to send auto-ping cancellation to !${requestedBy.toString(16).padStart(8, '0')}:`, error);
    });

    this.emitAutoPingUpdate(session, 'cancelled').catch(err => logger.error('Error emitting auto-ping cancellation:', err));
    this.autoPingSessions.delete(requestedBy);

    logger.debug(`🛑 Auto-ping session ${reason} for !${requestedBy.toString(16).padStart(8, '0')}`);
  }

  /**
   * Get all active auto-ping sessions (for API)
   */
  async getAutoPingSessions(): Promise<Array<{
    requestedBy: number;
    requestedByName: string;
    totalPings: number;
    completedPings: number;
    successfulPings: number;
    failedPings: number;
    startTime: number;
    results: AutoPingSession['results'];
  }>> {
    const sessions: Array<any> = [];
    for (const [nodeNum, session] of this.autoPingSessions) {
      const node = await databaseService.nodes.getNode(nodeNum);
      sessions.push({
        requestedBy: nodeNum,
        requestedByName: node?.longName || node?.shortName || `!${nodeNum.toString(16).padStart(8, '0')}`,
        totalPings: session.totalPings,
        completedPings: session.completedPings,
        successfulPings: session.successfulPings,
        failedPings: session.failedPings,
        startTime: session.startTime,
        results: session.results,
      });
    }
    return sessions;
  }

  /**
   * Emit an auto-ping update via WebSocket
   */
  private async emitAutoPingUpdate(session: AutoPingSession, status: 'started' | 'ping_result' | 'completed' | 'cancelled'): Promise<void> {
    const node = await databaseService.nodes.getNode(session.requestedBy);
    dataEventEmitter.emitAutoPingUpdate({
      requestedBy: session.requestedBy,
      requestedByName: node?.longName || node?.shortName || `!${session.requestedBy.toString(16).padStart(8, '0')}`,
      totalPings: session.totalPings,
      completedPings: session.completedPings,
      successfulPings: session.successfulPings,
      failedPings: session.failedPings,
      startTime: session.startTime,
      status,
      results: session.results,
    }, this.sourceId);
  }

  private async checkAutoResponder(message: TextMessage, isDirectMessage: boolean, packetId?: number): Promise<void> {
    try {
      // Per-packet dedup guard: same rationale as checkAutoAcknowledge (#2642)
      if (packetId != null) {
        if (this.autoResponderProcessedPackets.has(packetId)) {
          logger.debug(`⏭️ Skipping auto-responder for packet ${packetId}: already processed`);
          return;
        }
        this.autoResponderProcessedPackets.add(packetId);
        if (this.autoResponderProcessedPackets.size > 1000) {
          const entries = Array.from(this.autoResponderProcessedPackets);
          this.autoResponderProcessedPackets = new Set(entries.slice(-500));
        }
      }

      // All auto-responder settings are written per-source by AutoResponderSection
      // via /api/settings?sourceId=, so they live under `source:{sourceId}:*`.
      // Reading them globally here would return empty/missing values and the
      // handler would silently match nothing — the 4.0 regression symptom.
      const settings = databaseService.settings;
      const sourceId = this.sourceId;

      // Get auto-responder settings from database (per-source)
      const autoResponderEnabled = await settings.getSettingForSource(sourceId, 'autoResponderEnabled');

      // Skip if auto-responder is disabled
      if (autoResponderEnabled !== 'true') {
        return;
      }

      // Airtime cutoff: skip while the mesh is congested
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      // Skip messages from our own locally connected node
      const localNodeNum = this.localNodeInfo?.nodeNum?.toString() ?? await settings.getSetting(this.localNodeSettingKey('localNodeNum'));
      if (localNodeNum && parseInt(localNodeNum) === message.fromNodeNum) {
        logger.debug('⏭️  Skipping auto-responder for message from local node');
        return;
      }

      // Skip auto-responder for incomplete nodes (nodes we haven't received full NODEINFO from)
      // This prevents sending automated messages to nodes that may not be on the same secure channel
      const autoResponderSkipIncompleteNodes = await settings.getSettingForSource(sourceId, 'autoResponderSkipIncompleteNodes');
      if (autoResponderSkipIncompleteNodes === 'true') {
        // Scope by sourceId: composite-PK nodes table needs it.
        const fromNode = await databaseService.nodes.getNode(message.fromNodeNum, sourceId);
        if (fromNode && !isNodeComplete(fromNode)) {
          logger.debug(`⏭️  Skipping auto-responder for incomplete node ${fromNode.nodeId || message.fromNodeNum} (missing proper name or hwModel)`);
          return;
        }
      }

      // Get triggers array (per-source)
      const autoResponderTriggersStr = await settings.getSettingForSource(sourceId, 'autoResponderTriggers');
      if (!autoResponderTriggersStr) {
        logger.debug('⏭️  No auto-responder triggers configured');
        return;
      }

      let triggers: AutoResponderTrigger[];
      try {
        triggers = JSON.parse(autoResponderTriggersStr);
      } catch (error) {
        logger.error('❌ Failed to parse autoResponderTriggers:', error);
        return;
      }

      if (!Array.isArray(triggers) || triggers.length === 0) {
        return;
      }

      logger.debug(`🤖 Auto-responder checking message on ${isDirectMessage ? 'DM' : `channel ${message.channel}`}: "${message.text}"`);

      // Try to match message against triggers
      for (let triggerIdx = 0; triggerIdx < triggers.length; triggerIdx++) {
        const trigger = triggers[triggerIdx];
        // Normalize trigger channels (handles legacy single channel and new multi-channel array format)
        const triggerChannels = normalizeTriggerChannels(trigger);

        logger.debug(`🤖 Checking trigger "${trigger.trigger}" (channels: ${triggerChannels.join('+')}) against message on ${isDirectMessage ? 'DM' : `channel ${message.channel}`}`);

        // Check if this trigger applies to the current message's channel
        if (isDirectMessage) {
          // For DMs, only match triggers that include 'dm' in their channels
          if (!triggerChannels.includes('dm')) {
            logger.debug(`⏭️  Skipping trigger "${trigger.trigger}" - not configured for DM (channels: ${triggerChannels.join('+')})`);
            continue;
          }
        } else {
          // For channel messages, only match triggers that include this channel number
          if (!triggerChannels.includes(message.channel)) {
            logger.debug(`⏭️  Skipping trigger "${trigger.trigger}" - not configured for channel ${message.channel} (channels: ${triggerChannels.join('+')})`);
            continue;
          }
        }

        // Handle both string and array types for trigger.trigger
        const patterns = normalizeTriggerPatterns(trigger.trigger);
        let matchedPattern: string | null = null;
        let extractedParams: Record<string, string> = {};

        // Try each pattern until one matches
        for (const origPatternStr of patterns) {
          const m = matchAutoResponderPattern(origPatternStr, message.text);
          if (m.matched) { extractedParams = m.params; matchedPattern = origPatternStr; break; }
        }

        if (matchedPattern) {
          // Per-node cooldown rate limiting. Mailbox is inherently interactive
          // (e.g. `inbox` then `inbox play` within a couple seconds share one
          // trigger), so it bypasses the per-node cooldown — otherwise the
          // recommended cooldown would silently swallow follow-up commands.
          const cooldownSeconds = trigger.responseType === 'mailbox' ? 0 : (trigger.cooldownSeconds || 0);
          if (cooldownSeconds > 0) {
            const cooldownKey = `${triggerIdx}:${message.fromNodeNum}`;
            const lastResponse = this.autoResponderCooldowns.get(cooldownKey);
            if (lastResponse && Date.now() - lastResponse < cooldownSeconds * 1000) {
              logger.debug(`⏭️  Skipping auto-responder trigger ${triggerIdx} for node ${message.fromNodeNum}: cooldown active (${cooldownSeconds}s)`);
              continue; // Try next trigger
            }
          }

          logger.debug(`🤖 Auto-responder triggered by: "${message.text}" matching pattern: "${matchedPattern}" (from trigger: "${trigger.trigger}")`);

          let responseText: string;

          // Calculate values for Auto Acknowledge tokens (Issue #1159)
          const nodeId = `!${message.fromNodeNum.toString(16).padStart(8, '0')}`;
          const hopsTraveled =
            message.hopStart !== null &&
            message.hopStart !== undefined &&
            message.hopLimit !== null &&
            message.hopLimit !== undefined &&
            message.hopStart >= message.hopLimit
              ? message.hopStart - message.hopLimit
              : 0;
          const timestamp = new Date();
          // dateFormat/timeFormat are global presentation preferences.
          const dateFormat = await settings.getSetting('dateFormat') || 'MM/DD/YYYY';
          const timeFormat = await settings.getSetting('timeFormat') || '24';
          const receivedDate = formatDate(timestamp, dateFormat as 'MM/DD/YYYY' | 'DD/MM/YYYY');
          const receivedTime = formatTime(timestamp, timeFormat as '12' | '24');

          if (trigger.responseType === 'http') {
            // HTTP URL trigger - fetch from URL
            let url = trigger.response;

            // Replace parameters in URL
            Object.entries(extractedParams).forEach(([key, value]) => {
              url = url.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(value));
            });

            // Replace acknowledgement/announcement tokens in URL (URI-encoded) - Issue #1865
            url = await this.replaceAcknowledgementTokens(
              url, nodeId, message.fromNodeNum, hopsTraveled,
              receivedDate, receivedTime, message.channel, isDirectMessage,
              message.rxSnr, message.rxRssi, message.viaMqtt, true, message.relayNode
            );

            logger.debug(`🌐 Fetching HTTP response from: ${url}`);

            try {
              // Fetch with HTTP auto-responder timeout (5s). Kept shorter
              // than the script timeout so mesh-trigger latency stays
              // bounded even if the backend is slow.
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), HTTP_AUTO_RESPONDER_TIMEOUT_MS);

              const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                  'User-Agent': 'MeshMonitor/2.0',
                }
              });

              clearTimeout(timeout);

              // Only respond if status is 200
              if (response.status !== 200) {
                logger.debug(`⏭️  HTTP response status ${response.status}, not responding`);
                return;
              }

              responseText = await response.text();
              logger.debug(`📥 HTTP response received: ${responseText.substring(0, 50)}...`);

              // Replace Auto Acknowledge tokens in HTTP response (Issue #1159)
              responseText = await this.replaceAcknowledgementTokens(responseText, nodeId, message.fromNodeNum, hopsTraveled, receivedDate, receivedTime, message.channel, isDirectMessage, message.rxSnr, message.rxRssi, message.viaMqtt, false, message.relayNode);
            } catch (error: any) {
              if (error.name === 'AbortError') {
                logger.debug('⏭️  HTTP request timed out after 5 seconds');
              } else {
                logger.debug('⏭️  HTTP request failed:', error.message);
              }
              return;
            }

          } else if (trigger.responseType === 'script') {
            // Script execution
            const scriptPath = trigger.response;

            // Validate script path (security check)
            if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
              logger.error(`🚫 Invalid script path: ${scriptPath}`);
              return;
            }

            // Resolve script path (handles dev vs production)
            const resolvedPath = this.resolveScriptPath(scriptPath);
            if (!resolvedPath) {
              logger.error(`🚫 Failed to resolve script path: ${scriptPath}`);
              return;
            }

            // Check if file exists
            if (!fs.existsSync(resolvedPath)) {
              logger.error(`🚫 Script file not found: ${resolvedPath}`);
              logger.error(`   Working directory: ${process.cwd()}`);
              logger.error(`   Scripts should be in: ${path.dirname(resolvedPath)}`);
              return;
            }

            const scriptStartTime = Date.now();
            const triggerPattern = Array.isArray(trigger.trigger) ? trigger.trigger[0] : trigger.trigger;
            logger.debug(`🔧 Executing auto-responder script for pattern "${triggerPattern}" -> ${scriptPath}`);

            // Determine interpreter based on file extension
            const ext = scriptPath.split('.').pop()?.toLowerCase();
            let interpreter: string;

            // In development or desktop, use system interpreters from PATH
            // In Docker production, use absolute paths to bundled binaries
            const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';

            switch (ext) {
              case 'js':
              case 'mjs':
                interpreter = useSystemBin ? 'node' : '/usr/local/bin/node';
                break;
              case 'py':
                interpreter = useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3';
                break;
              case 'sh':
                interpreter = useSystemBin ? 'sh' : '/bin/sh';
                break;
              default:
                logger.error(`🚫 Unsupported script extension: ${ext}`);
                return;
            }

            try {
              const { execFile } = await import('child_process');
              const { promisify } = await import('util');
              const execFileAsync = promisify(execFile);

              const scriptEnv = await this.createScriptEnvVariables(message, matchedPattern, extractedParams, trigger, packetId, {
                nodeId, hopsTraveled, isDirectMessage
              });

              // Expand tokens in script args if provided
              let scriptArgsList: string[] = [];
              if (trigger.scriptArgs) {
                const expandedArgs = await this.replaceAcknowledgementTokens(
                  trigger.scriptArgs, nodeId, message.fromNodeNum, hopsTraveled,
                  receivedDate, receivedTime, message.channel, isDirectMessage,
                  message.rxSnr, message.rxRssi, message.viaMqtt, false, message.relayNode
                );
                scriptArgsList = this.parseScriptArgs(expandedArgs);
                logger.debug(`🤖 Script args expanded: ${trigger.scriptArgs} -> ${JSON.stringify(scriptArgsList)}`);
              }

              // Execute script with the script-side auto-responder timeout (30s)
              // Use resolvedPath (actual file path) instead of scriptPath (API format)
              const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath, ...scriptArgsList], {
                timeout: SCRIPT_AUTO_RESPONDER_TIMEOUT_MS,
                env: { ...scriptEnv, ...scriptDependencyEnv(ext, scriptEnv) },
                maxBuffer: 1024 * 1024, // 1MB max output
              });

              if (stderr) {
                logger.warn(`🔧 Auto-responder script for "${triggerPattern}" stderr: ${stderr}`);
              }

              // Support both single response and multiple responses
              const scriptResp = this.parseAutoResponderResponse(stdout.trim(), true);
              if (scriptResp.responses.length === 0) {
                return;
              }

              // For scripts with multiple responses, send each one
              const scriptTriggerChannels = normalizeTriggerChannels(trigger);

              // Skip sending if channel is 'none' (script handles its own output)
              if (scriptTriggerChannels.includes('none')) {
                const scriptDuration = Date.now() - scriptStartTime;
                logger.debug(`🔧 Auto-responder script for "${triggerPattern}" completed in ${scriptDuration}ms (channel=none, no mesh output)`);

                // Record cooldown timestamp
                const triggerCooldownNone = trigger.cooldownSeconds || 0;
                if (triggerCooldownNone > 0) {
                  this.autoResponderCooldowns.set(`${triggerIdx}:${message.fromNodeNum}`, Date.now());
                }

                return;
              }

              // Respond on the channel the message came from, unless the script
              // explicitly overrides the target via the "private" field:
              //   - "private": true  -> force DM reply to the sender
              //   - "private": false -> force channel reply even if the trigger was a DM
              let isDM = isDirectMessage;
              if (typeof scriptResp.json.private === 'boolean') {
                isDM = scriptResp.json.private;
              }
              // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
              const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
              const target = isDM ? `!${message.fromNodeNum.toString(16).padStart(8, '0')}` : `channel ${message.channel}`;
              logger.debug(`🤖 Enqueueing ${scriptResp.responses.length} script response(s) to ${target}${trigger.verifyResponse ? ' (with verification)' : ''}`);

              scriptResp.responses.forEach((resp, index) => {
                const truncated = this.truncateMessageForMeshtastic(resp, 200);
                const isFirstMessage = index === 0;

                this.messageQueue.enqueue(
                  truncated,
                  isDM ? message.fromNodeNum : 0, // destination: node number for DM, 0 for channel
                  isFirstMessage ? packetId : undefined, // Reply to original message for first response
                  () => {
                    logger.debug(`✅ Script response ${index + 1}/${scriptResp.responses.length} delivered to ${target}`);
                  },
                  (reason: string) => {
                    logger.warn(`❌ Script response ${index + 1}/${scriptResp.responses.length} failed to ${target}: ${reason}`);
                  },
                  isDM ? undefined : message.channel as number, // channel: undefined for DM, channel number for channel
                  maxAttempts
                );
              });

              // Script responses queued
              const scriptDuration = Date.now() - scriptStartTime;
              logger.debug(`🔧 Auto-responder script for "${triggerPattern}" completed in ${scriptDuration}ms, ${scriptResp.responses.length} response(s) queued to ${target}`);

              // Record cooldown timestamp
              const triggerCooldownScript = trigger.cooldownSeconds || 0;
              if (triggerCooldownScript > 0) {
                this.autoResponderCooldowns.set(`${triggerIdx}:${message.fromNodeNum}`, Date.now());
              }

              return;

            } catch (error: any) {
              const scriptDuration = Date.now() - scriptStartTime;
              if (error.killed && error.signal === 'SIGTERM') {
                logger.error(`🔧 Auto-responder script for "${triggerPattern}" timed out after ${scriptDuration}ms (10s limit)`);
              } else if (error.code === 'ENOENT') {
                logger.error(`🔧 Auto-responder script for "${triggerPattern}" not found: ${scriptPath}`);
              } else {
                logger.error(`🔧 Auto-responder script for "${triggerPattern}" failed after ${scriptDuration}ms: ${error.message}`);
              }
              if (error.stderr) logger.error(`🔧 Script stderr: ${error.stderr}`);
              if (error.stdout) logger.warn(`🔧 Script stdout before failure: ${error.stdout.substring(0, 200)}`);
              return;
            }

          } else if (trigger.responseType === 'traceroute') {
            // Traceroute trigger - resolve target node and send traceroute
            let resolvedTarget = trigger.response;
            Object.entries(extractedParams).forEach(([key, value]) => {
              resolvedTarget = resolvedTarget.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
            });
            resolvedTarget = resolvedTarget.trim();

            // Look up target node by long name, short name, or node ID.
            // Scope to this manager's source so another source's node list can't
            // resolve a name that doesn't exist on this mesh.
            const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
            const searchLower = resolvedTarget.toLowerCase();
            const targetNode = allNodes.find(n => {
              const nid = n.nodeId?.toLowerCase() || '';
              return (n.longName?.toLowerCase() === searchLower) ||
                     (n.shortName?.toLowerCase() === searchLower) ||
                     (nid === searchLower) ||
                     (nid === `!${searchLower}`) ||
                     (n.nodeNum.toString() === resolvedTarget);
            });

            if (!targetNode) {
              const errMsg = `Unknown node: ${resolvedTarget.substring(0, 20)}`;
              this.messageQueue.enqueue(
                this.truncateMessageForMeshtastic(errMsg, 200),
                isDirectMessage ? message.fromNodeNum : 0,
                packetId,
                () => { logger.debug('✅ Traceroute unknown-node reply delivered'); },
                (reason: string) => { logger.warn(`❌ Traceroute unknown-node reply failed: ${reason}`); },
                isDirectMessage ? undefined : message.channel as number,
                1
              );
              return;
            }

            const targetNodeNum = targetNode.nodeNum;
            const targetName = targetNode.longName || targetNode.nodeId || targetNode.nodeNum.toString();

            // Deduplicate: if a traceroute to this node is already pending, tell the user
            if (this.pendingAutoresponderTraceroutes.has(targetNodeNum)) {
              const dupMsg = `Traceroute to ${targetName.substring(0, 15)} already queued`;
              this.messageQueue.enqueue(
                this.truncateMessageForMeshtastic(dupMsg, 200),
                isDirectMessage ? message.fromNodeNum : 0,
                packetId,
                () => {},
                () => {},
                isDirectMessage ? undefined : message.channel as number,
                1
              );
              return;
            }

            // Send immediate ACK to the requesting node
            const ackMsg = `Tracerouting to ${targetName.substring(0, 15)}...`;
            this.messageQueue.enqueue(
              this.truncateMessageForMeshtastic(ackMsg, 200),
              isDirectMessage ? message.fromNodeNum : 0,
              packetId,
              () => { logger.debug(`✅ Traceroute ACK delivered to ${nodeId}`); },
              (reason: string) => { logger.warn(`❌ Traceroute ACK failed to ${nodeId}: ${reason}`); },
              isDirectMessage ? undefined : message.channel as number,
              1
            );

            // Set up 75-second timeout to reply if no response arrives
            const TRACEROUTE_TIMEOUT_MS = 75000;
            const timeoutHandle = setTimeout(() => {
              const pending = this.pendingAutoresponderTraceroutes.get(targetNodeNum);
              if (!pending) return;
              this.pendingAutoresponderTraceroutes.delete(targetNodeNum);
              const timeoutMsg = `${targetName.substring(0, 15)} did not respond within timeout`;
              this.messageQueue.enqueue(
                this.truncateMessageForMeshtastic(timeoutMsg, 200),
                pending.isDM ? pending.replyToNodeNum : 0,
                undefined,
                () => { logger.debug('✅ Traceroute timeout reply delivered'); },
                (reason: string) => { logger.warn(`❌ Traceroute timeout reply failed: ${reason}`); },
                pending.isDM ? undefined : pending.replyChannel,
                1
              );
            }, TRACEROUTE_TIMEOUT_MS);

            // Register the pending traceroute so the result handler can reply
            this.pendingAutoresponderTraceroutes.set(targetNodeNum, {
              replyToNodeNum: message.fromNodeNum,
              isDM: isDirectMessage,
              replyChannel: isDirectMessage ? -1 : (message.channel as number),
              packetId,
              timeoutHandle,
            });

            // Send the actual traceroute packet
            try {
              const channel = targetNode.channel ?? 0;
              await this.sendTraceroute(targetNodeNum, channel);
              logger.debug(`🔍 Auto-responder traceroute to ${targetName} (${targetNode.nodeId}) initiated by ${nodeId}`);

              // Record cooldown timestamp
              const triggerCooldownTrace = trigger.cooldownSeconds || 0;
              if (triggerCooldownTrace > 0) {
                this.autoResponderCooldowns.set(`${triggerIdx}:${message.fromNodeNum}`, Date.now());
              }
            } catch (error: any) {
              logger.error(`❌ Auto-responder traceroute to ${targetName} failed: ${error.message}`);
              clearTimeout(timeoutHandle);
              this.pendingAutoresponderTraceroutes.delete(targetNodeNum);
              const errMsg = `Failed to traceroute: ${error.message?.substring(0, 30)}`;
              this.messageQueue.enqueue(
                this.truncateMessageForMeshtastic(errMsg, 200),
                isDirectMessage ? message.fromNodeNum : 0,
                undefined,
                () => {},
                () => {},
                isDirectMessage ? undefined : message.channel as number,
                1
              );
            }
            return;

          } else if (trigger.responseType === 'mailbox') {
            // Dead Drop / Mailbox — async message store ("mesh voicemail").
            // Parse + execute the command and DM the resulting lines back to
            // the sender. Wrapped in try/catch like the script branch so a
            // repo/DB throw logs and continues instead of aborting the rest of
            // this packet's processing. Mailbox bypasses the per-node cooldown
            // (see the cooldown gate above), so nothing is set here.
            const mailboxStart = Date.now();
            const mailboxTarget = nodeIdHex(message.fromNodeNum);
            try {
              const fromNode = await databaseService.nodes.getNode(message.fromNodeNum, this.sourceId);
              const mailboxResult = await deadDropService.handleCommand({
                sourceId: this.sourceId,
                text: message.text,
                isDirect: isDirectMessage,
                senderNodeNum: message.fromNodeNum,
                senderShortName: fromNode?.shortName || '',
                senderLongName: fromNode?.longName || '',
              });
              const mailboxResponses = mailboxResult.responses;
              if (mailboxResponses.length === 0) {
                return;
              }

              // index -> messageId: mark a message played only when its body
              // line is confirmed delivered, so a dropped DM leaves it pending.
              const playOnDelivery = new Map<number, number>();
              for (const p of mailboxResult.playOnDelivery ?? []) playOnDelivery.set(p.index, p.messageId);

              const mailboxMaxAttempts = trigger.verifyResponse ? 3 : 1;
              logger.debug(`📬 Enqueueing ${mailboxResponses.length} mailbox response(s) to ${mailboxTarget}`);

              mailboxResponses.forEach((resp, index) => {
                const truncated = this.truncateMessageForMeshtastic(resp, 200);
                const isFirstMessage = index === 0;
                this.messageQueue.enqueue(
                  truncated,
                  message.fromNodeNum, // destination: always DM the sender
                  isFirstMessage ? packetId : undefined, // reply to original for first response
                  () => {
                    logger.debug(`✅ Mailbox response ${index + 1}/${mailboxResponses.length} delivered to ${mailboxTarget}`);
                    const playId = playOnDelivery.get(index);
                    if (playId !== undefined) {
                      deadDropService.markDelivered(this.sourceId, playId)
                        .catch(err => logger.warn(`📬 Failed to mark mailbox message ${playId} played:`, err));
                    }
                  },
                  (reason: string) => {
                    logger.warn(`❌ Mailbox response ${index + 1}/${mailboxResponses.length} failed to ${mailboxTarget}: ${reason}`);
                  },
                  undefined, // channel undefined => DM
                  mailboxMaxAttempts
                );
              });

              const mailboxDuration = Date.now() - mailboxStart;
              logger.debug(`📬 Auto-responder mailbox completed in ${mailboxDuration}ms, ${mailboxResponses.length} response(s) queued to ${mailboxTarget}`);
            } catch (error: any) {
              logger.error(`📬 Auto-responder mailbox failed for ${mailboxTarget}: ${error?.message || error}`);
            }

            return;

          } else {
            // Text trigger - use static response
            responseText = trigger.response;

            // Replace parameters in text
            Object.entries(extractedParams).forEach(([key, value]) => {
              responseText = responseText.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
            });

            // Replace Auto Acknowledge tokens in text response (Issue #1159)
            responseText = await this.replaceAcknowledgementTokens(responseText, nodeId, message.fromNodeNum, hopsTraveled, receivedDate, receivedTime, message.channel, isDirectMessage, message.rxSnr, message.rxRssi, message.viaMqtt, false, message.relayNode);
          }

          const multilineEnabled = trigger.multiline || false;
          const responseValue = this.parseAutoResponderResponse(responseText, false);
          if (responseValue.responses.length === 0) {
            // parseAutoResponderResponse already logged the reason
            return;
          }
          if (multilineEnabled && responseValue.responses.length === 1) {
            // Split into multiple messages if enabled — only safe when
            // the parsed payload was a single response. Multi-response
            // JSON intentionally bypasses splitting (see Multiple
            // Responses Support in docs/features/automation.md).
            responseValue.responses = this.splitMessageForMeshtastic(responseValue.responses[0], 200);
            if (responseValue.responses.length > 1) {
              logger.debug(`📝 Split response into ${responseValue.responses.length} messages`);
            }
          } else {
            // Truncate each response and only log when truncation actually changed bytes.
            responseValue.responses = responseValue.responses.map((oldVal, i) => {
              const newVal = this.truncateMessageForMeshtastic(oldVal, 200);
              if (newVal.length !== oldVal.length) {
                logger.debug(`✂️  Response ${i + 1} truncated from ${oldVal.length} to ${newVal.length} characters`);
              }
              return newVal;
            });
          }

          // Enqueue all messages for delivery with retry logic
          // Respond on the channel the message came from.
          // HTTP and text triggers honor an optional `"private": true`
          // field in their JSON payload to force DM routing (same
          // behaviour as the script path).
          let isDM = isDirectMessage;
          if (typeof responseValue.json.private === 'boolean') {
            isDM = responseValue.json.private;
          }
          // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
          const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
          const target = isDM ? `!${message.fromNodeNum.toString(16).padStart(8, '0')}` : `channel ${message.channel}`;
          logger.debug(`🤖 Enqueueing ${responseValue.responses.length} auto-response message(s) to ${target}${trigger.verifyResponse ? ' (with verification)' : ''}`);

          responseValue.responses.forEach((msg, index) => {
            const isFirstMessage = index === 0;
            this.messageQueue.enqueue(
              msg,
              isDM ? message.fromNodeNum : 0, // destination: node number for DM, 0 for channel
              isFirstMessage ? packetId : undefined, // Reply to original message for first response
              () => {
                logger.debug(`✅ Auto-response ${index + 1}/${responseValue.responses.length} delivered to ${target}`);
              },
              (reason: string) => {
                logger.warn(`❌ Auto-response ${index + 1}/${responseValue.responses.length} failed to ${target}: ${reason}`);
              },
              isDM ? undefined : message.channel as number, // channel: undefined for DM, channel number for channel
              maxAttempts
            );
          });

          // Record cooldown timestamp
          const triggerCooldownText = trigger.cooldownSeconds || 0;
          if (triggerCooldownText > 0) {
            this.autoResponderCooldowns.set(`${triggerIdx}:${message.fromNodeNum}`, Date.now());
          }

          // Only respond to first matching trigger
          return;
        }
      }

    } catch (error) {
      logger.error('❌ Error in auto-responder:', error);
    }
  }

  private parseAutoResponderResponse(rawResp: string, jsonExpected: boolean): AutoResponderParsed {
    return parseAutoResponderResponse(rawResp, jsonExpected);
  }

  /**
   * Prepare environment variables for auto-responder scripts
   *
   * Environment variables provided:
   * - MESSAGE: The message text
   * - FROM_NODE: Sender's node number
   * - PACKET_ID: The packet ID (empty string if undefined)
   * - TRIGGER: The matched trigger pattern(s)
   * - MATCHED_PATTERN: The specific pattern that matched
   * - MESHTASTIC_IP: IP address of the connected Meshtastic node
   * - MESHTASTIC_PORT: TCP port of the connected Meshtastic node
   * - FROM_SHORT_NAME, FROM_LONG_NAME: Sender's node names
   * - FROM_LAT, FROM_LON: Sender's location (if available)
   * - MM_LAT, MM_LON: MeshMonitor node location (if available)
   * - MSG_*: All message fields (e.g., MSG_rxSnr, MSG_rxRssi, MSG_hopStart, MSG_hopLimit, MSG_viaMqtt, etc.)
   * - PARAM_*: Extracted parameters from trigger pattern
   */
  private async createScriptEnvVariables(
    message: TextMessage,
    matchedPattern: string,
    extractedParams: Record<string, string>,
    trigger: AutoResponderTrigger,
    packetId?: number,
    context?: { nodeId: string; hopsTraveled: number; isDirectMessage: boolean }
  ) {
    const config = await this.getScriptConnectionConfig();
    const scriptEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      MESSAGE: message.text,
      FROM_NODE: String(message.fromNodeNum),
      PACKET_ID: packetId !== undefined ? String(packetId) : '',
      TRIGGER: Array.isArray(trigger.trigger) ? trigger.trigger.join(', ') : trigger.trigger,
      MATCHED_PATTERN: matchedPattern || '',
      MESHTASTIC_IP: config.nodeIp,
      MESHTASTIC_PORT: String(config.tcpPort),
    };

    // Add token-matching environment variables (Issue #2314)
    // These match the {TOKEN} names from the auto responder documentation
    if (context) {
      scriptEnv.NODE_ID = context.nodeId;
      scriptEnv.HOPS = String(context.hopsTraveled);
      scriptEnv.IS_DIRECT = String(context.isDirectMessage);
    }
    if (message.rxSnr !== undefined) scriptEnv.SNR = String(message.rxSnr);
    if (message.rxRssi !== undefined) scriptEnv.RSSI = String(message.rxRssi);
    scriptEnv.CHANNEL = String(message.channel);
    scriptEnv.VIA_MQTT = String(message.viaMqtt);

    // Add sender node information environment variables (scoped to this source)
    const fromNode = await databaseService.nodes.getNode(message.fromNodeNum, this.sourceId);
    if (fromNode) {
      // Add node names (Issue #1099)
      if (fromNode.shortName) {
        scriptEnv.FROM_SHORT_NAME = fromNode.shortName;
        scriptEnv.SHORT_NAME = fromNode.shortName;
      }
      if (fromNode.longName) {
        scriptEnv.FROM_LONG_NAME = fromNode.longName;
        scriptEnv.LONG_NAME = fromNode.longName;
      }
      if (fromNode.firmwareVersion) {
        scriptEnv.VERSION = fromNode.firmwareVersion;
      }
      // Add location (FROM_LAT, FROM_LON)
      if (fromNode.latitude != null && fromNode.longitude != null) {
        scriptEnv.FROM_LAT = String(fromNode.latitude);
        scriptEnv.FROM_LON = String(fromNode.longitude);
      }
    }

    // Add NODECOUNT - nodes heard in the last 2h (scoped to this source so
    // auto-responder scripts see the count for their own source, not a
    // cross-source union). Matches the Sources panel "active" badge (#3388).
    const activeNodeCount = await databaseService.nodes.getActiveNodeCount(this.sourceId, ACTIVE_NODE_TOKEN_WINDOW_SECONDS);
    scriptEnv.NODECOUNT = String(activeNodeCount);

    // Add location environment variables for the MeshMonitor node (MM_LAT, MM_LON)
    const localNodeInfo = this.getLocalNodeInfo();
    if (localNodeInfo) {
      const mmNode = await databaseService.nodes.getNode(localNodeInfo.nodeNum, this.sourceId);
      if (mmNode?.latitude != null && mmNode?.longitude != null) {
        scriptEnv.MM_LAT = String(mmNode.latitude);
        scriptEnv.MM_LON = String(mmNode.longitude);
      }
    }

    // Add all message data as MSG_* environment variables
    Object.entries(message).forEach(([key, value]) => {
      scriptEnv[`MSG_${key}`] = String(value);
    });

    // Add extracted parameters as PARAM_* environment variables
    Object.entries(extractedParams).forEach(([key, value]) => {
      scriptEnv[`PARAM_${key}`] = value;
    });

    return scriptEnv;
  }

  /**
   * Split message into chunks that fit within Meshtastic's character limit
   * Tries to split on line breaks first, then spaces/punctuation, then anywhere
   */
  /**
   * Split message into chunks that fit within Meshtastic's character limit.
   * This is used by auto-responders and can be used by the API for long messages.
   * Tries to split on line breaks first, then spaces/punctuation, then anywhere.
   * @param text The text to split
   * @param maxChars Maximum bytes per message (default 200 for Meshtastic)
   * @returns Array of message chunks
   */
  public splitMessageForMeshtastic(text: string, maxChars: number): string[] {
    const encoder = new TextEncoder();
    const messages: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      const bytes = encoder.encode(remaining);

      if (bytes.length <= maxChars) {
        // Remaining text fits in one message
        messages.push(remaining);
        break;
      }

      // Need to split - find best break point
      let chunk = remaining;

      // Binary search to find max length that fits
      let low = 0;
      let high = remaining.length;
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (encoder.encode(remaining.substring(0, mid)).length <= maxChars) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }

      chunk = remaining.substring(0, low);

      // Try to find a good break point
      let breakPoint = -1;

      // 1. Try to break on line break
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline > chunk.length * 0.5) { // Only if we're using at least 50% of the space
        breakPoint = lastNewline + 1;
      }

      // 2. Try to break on sentence ending (., !, ?)
      if (breakPoint === -1) {
        const sentenceEnders = ['. ', '! ', '? '];
        for (const ender of sentenceEnders) {
          const lastEnder = chunk.lastIndexOf(ender);
          if (lastEnder > chunk.length * 0.5) {
            breakPoint = lastEnder + ender.length;
            break;
          }
        }
      }

      // 3. Try to break on comma, semicolon, or colon
      if (breakPoint === -1) {
        const punctuation = [', ', '; ', ': ', ' - '];
        for (const punct of punctuation) {
          const lastPunct = chunk.lastIndexOf(punct);
          if (lastPunct > chunk.length * 0.5) {
            breakPoint = lastPunct + punct.length;
            break;
          }
        }
      }

      // 4. Try to break on space
      if (breakPoint === -1) {
        const lastSpace = chunk.lastIndexOf(' ');
        if (lastSpace > chunk.length * 0.3) { // Only if we're using at least 30% of the space
          breakPoint = lastSpace + 1;
        }
      }

      // 5. Try to break on hyphen
      if (breakPoint === -1) {
        const lastHyphen = chunk.lastIndexOf('-');
        if (lastHyphen > chunk.length * 0.3) {
          breakPoint = lastHyphen + 1;
        }
      }

      // 6. If no good break point, just split at max length
      if (breakPoint === -1 || breakPoint === 0) {
        breakPoint = chunk.length;
      }

      messages.push(remaining.substring(0, breakPoint).trimEnd());
      remaining = remaining.substring(breakPoint).trimStart();
    }

    return messages;
  }

  /**
   * Truncate message to fit within Meshtastic's character limit
   * accounting for emoji which count as multiple bytes
   */
  private truncateMessageForMeshtastic(text: string, maxChars: number): string {
    // Meshtastic counts UTF-8 bytes, not characters
    // Most emoji are 4 bytes, some symbols are 3 bytes
    // We need to count actual byte length

    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);

    if (bytes.length <= maxChars) {
      return text;
    }

    // Truncate by removing characters until we're under the limit
    let truncated = text;
    while (encoder.encode(truncated).length > maxChars && truncated.length > 0) {
      truncated = truncated.substring(0, truncated.length - 1);
    }

    // Add ellipsis if we truncated
    if (truncated.length < text.length) {
      // Make sure ellipsis fits
      const ellipsis = '...';
      while (encoder.encode(truncated + ellipsis).length > maxChars && truncated.length > 0) {
        truncated = truncated.substring(0, truncated.length - 1);
      }
      truncated += ellipsis;
    }

    return truncated;
  }

  private async checkAutoWelcome(nodeNum: number, nodeId: string): Promise<void> {
    // RACE CONDITION PROTECTION: Check and lock synchronously before any await
    // to prevent interleaving of parallel calls in async context
    if (this.welcomingNodes.has(nodeNum)) {
      logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - already being welcomed in parallel`);
      return;
    }
    this.welcomingNodes.add(nodeNum);

    // When true, a scheduled (deferred) send owns the welcomingNodes lock, so
    // the finally below must NOT release it — the deferred send releases it
    // when it fires (#3439).
    let deferred = false;

    try {
      // All auto-welcome settings are per-source (written by AutoWelcomeSection
      // via /api/settings?sourceId=).
      const settings = databaseService.settings;
      const sourceId = this.sourceId;

      // Get auto-welcome settings from database
      const autoWelcomeEnabled = await settings.getSettingForSource(sourceId, 'autoWelcomeEnabled');

      // Skip if auto-welcome is disabled
      if (autoWelcomeEnabled !== 'true') {
        return;
      }

      // Airtime cutoff: skip while the mesh is congested
      if (await this.isAutomationAirtimeGated()) {
        return;
      }

      // Skip messages from our own locally connected node
      const localNodeNum = await settings.getSetting(this.localNodeSettingKey('localNodeNum'));
      if (localNodeNum && parseInt(localNodeNum) === nodeNum) {
        logger.debug('⏭️  Skipping auto-welcome for local node');
        return;
      }

      // Check if we've already welcomed this node (scoped to this source)
      const node = await databaseService.nodes.getNode(nodeNum, sourceId);
      if (!node) {
        logger.debug('⏭️  Node not found in database for auto-welcome check');
        return;
      }

      // Skip if node has already been welcomed (nodes should only be welcomed once)
      // Use explicit null/undefined check to handle edge case where welcomedAt might be 0
      if (node.welcomedAt !== null && node.welcomedAt !== undefined) {
        logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - already welcomed at ${new Date(node.welcomedAt).toISOString()}`);
        return;
      }

      // Log diagnostic info for nodes being considered for welcome
      logger.debug(`👋 Auto-welcome check for ${nodeId}: welcomedAt=${node.welcomedAt} (${typeof node.welcomedAt}), longName=${node.longName}, createdAt=${node.createdAt ? new Date(node.createdAt).toISOString() : 'null'}`);

      // Check all conditions BEFORE acquiring the lock
      // This allows subsequent calls to re-evaluate conditions if they change
      // Check if we should wait for name (per-source)
      const autoWelcomeWaitForName = await settings.getSettingForSource(sourceId, 'autoWelcomeWaitForName');
      if (autoWelcomeWaitForName === 'true') {
        // Check if node has a proper name (not default "Node !xxxxxxxx")
        if (!node.longName || node.longName.startsWith('Node !')) {
          logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - waiting for proper name (current: ${node.longName})`);
          return;
        }
        if (!node.shortName || node.shortName === nodeId.slice(-4)) {
          logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - waiting for proper short name (current: ${node.shortName})`);
          return;
        }
      }

      // Check if node exceeds maximum hop count (per-source)
      const autoWelcomeMaxHops = await settings.getSettingForSource(sourceId, 'autoWelcomeMaxHops');
      const maxHops = autoWelcomeMaxHops ? parseInt(autoWelcomeMaxHops) : 5; // Default to 5 hops
      if (node.hopsAway != null && node.hopsAway > maxHops) {
        logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - too far away (${node.hopsAway} hops > ${maxHops} max)`);
        return;
      }

      // Pre-send delay (#3439): after a nodeDB reset, many nodes broadcast
      // NodeInfo at once and a DM sent immediately can land while the target's
      // radio is still finishing its own startup TX burst (not receive-ready),
      // failing at zero hops with no retry (maxAttempts=1). Defer the send so
      // the node can settle into receive mode. The welcomingNodes lock acquired
      // at method entry is held across the wait (deferred=true keeps the finally
      // from releasing it), so duplicate NodeInfo packets during the window are
      // skipped at method entry. setTimeout returns immediately, so this never
      // blocks the packet-processing pipeline.
      const delaySeconds = resolveAutoWelcomeDelaySeconds(
        await settings.getSettingForSource(sourceId, 'autoWelcomeDelay'),
      );
      if (delaySeconds > 0) {
        deferred = true;
        logger.debug(`👋 Deferring auto-welcome for ${nodeId} by ${delaySeconds}s to let the node settle into receive mode`);
        setTimeout(() => { void this.deferredAutoWelcome(nodeNum, nodeId); }, delaySeconds * 1000);
        return;
      }

      // No delay configured: send immediately.
      await this.sendAutoWelcome(nodeNum, nodeId);
    } catch (error) {
      logger.error('❌ Error in auto-welcome:', error);
    } finally {
      // Release the lock unless a deferred send now owns it (it will release on fire).
      if (!deferred) {
        this.welcomingNodes.delete(nodeNum);
      }
    }
  }

  /**
   * Fire a deferred auto-welcome after the pre-send delay (#3439). Re-checks
   * that the node still exists and hasn't been welcomed during the wait, then
   * sends. Always releases the welcomingNodes lock the deferral was holding.
   */
  private async deferredAutoWelcome(nodeNum: number, nodeId: string): Promise<void> {
    try {
      const node = await databaseService.nodes.getNode(nodeNum, this.sourceId);
      if (!node) {
        logger.debug(`⏭️  Auto-welcome for ${nodeId} skipped — node no longer in database after delay`);
        return;
      }
      if (node.welcomedAt !== null && node.welcomedAt !== undefined) {
        logger.debug(`⏭️  Auto-welcome for ${nodeId} skipped — welcomed during the pre-send delay`);
        return;
      }
      await this.sendAutoWelcome(nodeNum, nodeId);
    } catch (error) {
      logger.error('❌ Error in deferred auto-welcome:', error);
    } finally {
      this.welcomingNodes.delete(nodeNum);
    }
  }

  /**
   * Build and enqueue the auto-welcome message for a node and mark it welcomed.
   * The caller (checkAutoWelcome / deferredAutoWelcome) owns the welcomingNodes
   * lock and releases it; this method does not manage the lock.
   */
  private async sendAutoWelcome(nodeNum: number, nodeId: string): Promise<void> {
    const settings = databaseService.settings;
    const sourceId = this.sourceId;
    const node = await databaseService.nodes.getNode(nodeNum, sourceId);

    // Get welcome message template (per-source)
    const autoWelcomeMessage = await settings.getSettingForSource(sourceId, 'autoWelcomeMessage') || 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';

    // Replace tokens in the message template
    const welcomeText = await this.replaceWelcomeTokens(autoWelcomeMessage, nodeNum, nodeId);

    // Get target (DM or channel, per-source)
    const autoWelcomeTarget = await settings.getSettingForSource(sourceId, 'autoWelcomeTarget') || '0';

    let destination: number | undefined;
    let channel: number;

    if (autoWelcomeTarget === 'dm') {
      // Send as direct message
      destination = nodeNum;
      channel = 0;
    } else {
      // Send to channel
      destination = undefined;
      channel = parseInt(autoWelcomeTarget);
    }

    logger.debug(`👋 Sending auto-welcome to ${nodeId} (${node?.longName}): "${welcomeText}" ${autoWelcomeTarget === 'dm' ? '(via DM)' : `(channel ${channel})`}`);

    // Route through message queue for rate limiting
    // For DMs, send only once (maxAttempts=1) — the local radio ACK confirms
    // transmission to the mesh; remote ACKs from the destination node are unreliable
    // and waiting for them causes the queue to retry, sending the message multiple times.
    this.messageQueue.enqueue(
      welcomeText,
      destination ?? 0, // destination: node number for DM, 0 for channel
      undefined, // replyId
      () => {
        logger.debug(`✅ Auto-welcome transmitted for ${nodeId}`);
      },
      (reason: string) => {
        logger.warn(`❌ Auto-welcome send failed for ${nodeId}: ${reason}`);
      },
      destination ? undefined : channel, // channel: undefined for DM, channel number for channel
      1 // maxAttemptsOverride: send once, don't retry on missing remote ACK
    );

    // Mark node as welcomed immediately after enqueue — the local radio ACK is
    // sufficient confirmation that the message was transmitted to the mesh.
    // Previously this was inside the onSuccess callback which only fires on remote
    // ACK, causing welcomedAt to never be set and the node to be re-welcomed repeatedly.
    const wasMarked = await databaseService.nodes.markNodeAsWelcomedIfNotAlready(nodeNum, nodeId, this.sourceId);
    if (wasMarked) {
      logger.debug(`✅ Node ${nodeId} welcomed and marked in database`);
    } else {
      logger.warn(`⚠️  Node ${nodeId} was already marked as welcomed by another process`);
    }
  }

  private async checkAutoFavorite(nodeNum: number, nodeId: string): Promise<void> {
    return this.favoritesService.checkAutoFavorite(nodeNum, nodeId);
  }

  private async autoFavoriteSweep(): Promise<void> {
    return this.favoritesService.autoFavoriteSweep();
  }

  /**
   * Check if auto heap management should be triggered and purge oldest nodes if heap is low.
   * Called after each LocalStats telemetry packet from the local node.
   */
  private async checkAutoHeapManagement(heapFreeBytes: number | undefined, fromNum: number): Promise<void> {
    const enabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoHeapManagementEnabled');
    if (enabled !== 'true') return;

    const thresholdStr = await databaseService.settings.getSettingForSource(this.sourceId, 'autoHeapManagementThresholdBytes');
    const threshold = parseInt(thresholdStr || '20000');

    if (heapFreeBytes === undefined || heapFreeBytes >= threshold) return;

    // Cooldown: skip if a purge happened within the last 30 minutes
    const cooldownMs = 30 * 60 * 1000;
    if (this.lastHeapPurgeAt !== null && (Date.now() - this.lastHeapPurgeAt) < cooldownMs) {
      logger.debug(`🧹 Auto heap management: skipping purge (cooldown active, last purge ${Math.round((Date.now() - this.lastHeapPurgeAt) / 60000)}m ago)`);
      return;
    }

    try {
      // Get all nodes ordered by lastHeard ascending (oldest first), excluding local node.
      // Scoped to this source so auto heap management only considers candidates on this
      // manager's source — otherwise a two-source deployment could purge Source B's nodes
      // when Source A is under heap pressure.
      const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
      const localNodeNum = this.localNodeInfo?.nodeNum ?? fromNum;
      const candidates = allNodes
        .filter(n => Number(n.nodeNum) !== localNodeNum)
        .sort((a, b) => (a.lastHeard ?? 0) - (b.lastHeard ?? 0))
        .slice(0, 10);

      if (candidates.length === 0) {
        logger.warn('🧹 Auto heap management: no candidate nodes to purge');
        return;
      }

      logger.debug(`🧹 Auto heap management triggered: heap=${heapFreeBytes}B free (threshold=${threshold}B), purging ${candidates.length} oldest nodes`);

      for (const node of candidates) {
        await this.sendRemoveNode(Number(node.nodeNum));
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      await databaseService.auditLogAsync(
        null,
        'auto_heap_management_purge',
        'nodes',
        `Auto heap management: purged ${candidates.length} nodes (heap was ${heapFreeBytes} bytes free, threshold ${threshold} bytes)`,
        'system'
      );

      // Wait 3 seconds then reboot the local node
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.sendRebootCommand(this.localNodeInfo!.nodeNum, 10);

      this.lastHeapPurgeAt = Date.now();
    } catch (error) {
      logger.error('❌ Error in auto heap management:', error);
    }
  }

  private async replaceWelcomeTokens(message: string, nodeNum: number, _nodeId: string): Promise<string> {
    let result = message;

    // Get node info (scoped to this source — the same nodeNum can have a row
    // per source, and createdAt differs per source)
    const node = await databaseService.nodes.getNode(nodeNum, this.sourceId);

    // {LONG_NAME} - Node long name
    if (result.includes('{LONG_NAME}')) {
      const longName = node?.longName || 'Unknown';
      result = result.replace(/{LONG_NAME}/g, longName);
    }

    // {SHORT_NAME} - Node short name
    if (result.includes('{SHORT_NAME}')) {
      const shortName = node?.shortName || '????';
      result = result.replace(/{SHORT_NAME}/g, shortName);
    }

    // {VERSION} - Firmware version
    if (result.includes('{VERSION}')) {
      const version = node?.firmwareVersion || 'unknown';
      result = result.replace(/{VERSION}/g, version);
    }

    // {DURATION} - Time since first seen (using createdAt)
    if (result.includes('{DURATION}')) {
      if (node?.createdAt) {
        const durationMs = Date.now() - node.createdAt;
        const duration = this.formatDuration(durationMs);
        result = result.replace(/{DURATION}/g, duration);
      } else {
        result = result.replace(/{DURATION}/g, 'just now');
      }
    }

    // {FEATURES} - Enabled features as emojis
    if (result.includes('{FEATURES}')) {
      const features: string[] = [];

      // Check traceroute
      const tracerouteInterval = await databaseService.settings.getSettingForSource(this.sourceId, 'tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }

      // Check auto-ack
      const autoAckEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }

      // Check auto-announce
      const autoAnnounceEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }

      // Check auto-welcome
      const autoWelcomeEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoWelcomeEnabled');
      if (autoWelcomeEnabled === 'true') {
        features.push('👋');
      }

      // Check auto-ping
      const autoPingEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingEnabled');
      if (autoPingEnabled === 'true') {
        features.push('🏓');
      }

      // Check auto-key management
      const autoKeyManagementEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoKeyManagementEnabled');
      if (autoKeyManagementEnabled === 'true') {
        features.push('🔑');
      }

      // Check auto-responder
      const autoResponderEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoResponderEnabled');
      if (autoResponderEnabled === 'true') {
        features.push('💬');
      }

      // Check timed triggers (any enabled trigger)
      const timerTriggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'timerTriggers');
      if (timerTriggersJson) {
        try {
          const triggers = JSON.parse(timerTriggersJson);
          if (Array.isArray(triggers) && triggers.some((t: any) => t.enabled)) {
            features.push('⏱️');
          }
        } catch { /* ignore parse errors */ }
      }

      // Check geofence triggers (any enabled trigger)
      const geofenceTriggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'geofenceTriggers');
      if (geofenceTriggersJson) {
        try {
          const triggers = JSON.parse(geofenceTriggersJson);
          if (Array.isArray(triggers) && triggers.some((t: any) => t.enabled)) {
            features.push('📍');
          }
        } catch { /* ignore parse errors */ }
      }

      // Check remote admin scan
      const remoteAdminInterval = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteAdminScannerIntervalMinutes');
      if (remoteAdminInterval && parseInt(remoteAdminInterval) > 0) {
        features.push('🔍');
      }

      // Check auto time sync
      const autoTimeSyncEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoTimeSyncEnabled');
      if (autoTimeSyncEnabled === 'true') {
        features.push('🕐');
      }

      result = result.replace(/{FEATURES}/g, features.join(' '));
    }

    // {NODECOUNT} - Nodes heard in the last 2h, matching the Sources panel
    // "active" badge (scoped to this source) (#3388)
    if (result.includes('{NODECOUNT}')) {
      const activeNodeCount = await databaseService.nodes.getActiveNodeCount(this.sourceId, ACTIVE_NODE_TOKEN_WINDOW_SECONDS);
      result = result.replace(/{NODECOUNT}/g, activeNodeCount.toString());
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) among nodes heard in the last 2h (scoped to this source) (#3388)
    if (result.includes('{DIRECTCOUNT}')) {
      const nodes = await databaseService.nodes.getActiveNodes(ACTIVE_NODE_TOKEN_WINDOW_DAYS, this.sourceId);
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      result = result.replace(/{DIRECTCOUNT}/g, directCount.toString());
    }

    // {TOTALNODES} - Total nodes (all nodes ever seen, regardless of when last heard, scoped to this source)
    if (result.includes('{TOTALNODES}')) {
      const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
      result = result.replace(/{TOTALNODES}/g, allNodes.length.toString());
    }

    // {ONLINENODES} - Online nodes as reported by the connected Meshtastic device (from LocalStats)
    if (result.includes('{ONLINENODES}')) {
      let onlineNodes = 0;
      if (this.localNodeInfo?.nodeId) {
        try {
          const telemetry = await databaseService.getLatestTelemetryForTypeAsync(this.localNodeInfo.nodeId, 'numOnlineNodes');
          if (telemetry?.value !== undefined && telemetry.value !== null) {
            onlineNodes = Math.floor(telemetry.value);
          }
        } catch (error) {
          logger.error('❌ Error fetching numOnlineNodes telemetry:', error);
        }
      }
      result = result.replace(/{ONLINENODES}/g, onlineNodes.toString());
    }

    return result;
  }

  /** Thin delegate — see `AutoAnnounceService.sendAutoAnnouncement`. */
  async sendAutoAnnouncement(triggeredByAutomation = false): Promise<void> {
    return this.autoAnnounceService.sendAutoAnnouncement(triggeredByAutomation);
  }

  /**
   * Parse a shell-style arguments string into an array
   * Handles single quotes, double quotes, and unquoted tokens
   * Example: `--ip 192.168.1.1 --dest '!ab1234' --set "lora.region US"`
   * Returns: ['--ip', '192.168.1.1', '--dest', '!ab1234', '--set', 'lora.region US']
   */
  private parseScriptArgs(argsString: string): string[] {
    const args: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      } else if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      args.push(current);
    }
    return args;
  }

  /**
   * Visibility widened from `private` to (default) `public` so `AutoAnnounceService`
   * (#3962 Phase 4.2a PR3 §4b) can call back into it via the injected `mgr`
   * reference. Body/location unmoved — still shared by
   * `replaceAcknowledgementTokens`/`replaceWelcomeTokens`/`replaceGeofenceTokens`
   * and the auto-responder's timer text path, all of which call it internally.
   */
  async replaceAnnouncementTokens(message: string, urlEncode: boolean = false): Promise<string> {
    // Defensive coercion: callers come from settings/DB and protobuf paths where the static type
    // is `string` but the runtime value isn't always proven to be one. CodeQL flagged every
    // `result.includes('{TOKEN}')` below as type-confusion-through-parameter-tampering without this.
    let result: string = typeof message === 'string' ? message : String(message);
    const encode = (v: string) => urlEncode ? encodeURIComponent(v) : v;

    // {VERSION} - MeshMonitor version
    if (result.includes('{VERSION}')) {
      result = result.replace(/{VERSION}/g, encode(packageJson.version));
    }

    // {DURATION} - Uptime
    if (result.includes('{DURATION}')) {
      const uptimeMs = Date.now() - this.serverStartTime;
      const duration = this.formatDuration(uptimeMs);
      result = result.replace(/{DURATION}/g, encode(duration));
    }

    // {FEATURES} - Enabled features as emojis
    if (result.includes('{FEATURES}')) {
      const features: string[] = [];

      // Check traceroute
      const tracerouteInterval = await databaseService.settings.getSettingForSource(this.sourceId, 'tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }

      // Check auto-ack
      const autoAckEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }

      // Check auto-announce
      const autoAnnounceEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }

      // Check auto-welcome
      const autoWelcomeEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoWelcomeEnabled');
      if (autoWelcomeEnabled === 'true') {
        features.push('👋');
      }

      // Check auto-ping
      const autoPingEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingEnabled');
      if (autoPingEnabled === 'true') {
        features.push('🏓');
      }

      // Check auto-key management
      const autoKeyManagementEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoKeyManagementEnabled');
      if (autoKeyManagementEnabled === 'true') {
        features.push('🔑');
      }

      // Check auto-responder
      const autoResponderEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoResponderEnabled');
      if (autoResponderEnabled === 'true') {
        features.push('💬');
      }

      // Check timed triggers (any enabled trigger)
      const timerTriggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'timerTriggers');
      if (timerTriggersJson) {
        try {
          const triggers = JSON.parse(timerTriggersJson);
          if (Array.isArray(triggers) && triggers.some((t: any) => t.enabled)) {
            features.push('⏱️');
          }
        } catch { /* ignore parse errors */ }
      }

      // Check geofence triggers (any enabled trigger)
      const geofenceTriggersJson = await databaseService.settings.getSettingForSource(this.sourceId, 'geofenceTriggers');
      if (geofenceTriggersJson) {
        try {
          const triggers = JSON.parse(geofenceTriggersJson);
          if (Array.isArray(triggers) && triggers.some((t: any) => t.enabled)) {
            features.push('📍');
          }
        } catch { /* ignore parse errors */ }
      }

      // Check remote admin scan
      const remoteAdminInterval = await databaseService.settings.getSettingForSource(this.sourceId, 'remoteAdminScannerIntervalMinutes');
      if (remoteAdminInterval && parseInt(remoteAdminInterval) > 0) {
        features.push('🔍');
      }

      // Check auto time sync
      const autoTimeSyncEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoTimeSyncEnabled');
      if (autoTimeSyncEnabled === 'true') {
        features.push('🕐');
      }

      result = result.replace(/{FEATURES}/g, encode(features.join(' ')));
    }

    // {NODECOUNT} - Nodes heard in the last 2h, matching the Sources panel "active" badge (#3388)
    if (result.includes('{NODECOUNT}')) {
      const activeNodeCount = await databaseService.nodes.getActiveNodeCount(this.sourceId, ACTIVE_NODE_TOKEN_WINDOW_SECONDS);
      logger.debug(`📢 Token replacement - NODECOUNT: ${activeNodeCount} active nodes (last 2h)`);
      result = result.replace(/{NODECOUNT}/g, encode(activeNodeCount.toString()));
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) among nodes heard in the last 2h (scoped to this source) (#3388)
    if (result.includes('{DIRECTCOUNT}')) {
      const nodes = await databaseService.nodes.getActiveNodes(ACTIVE_NODE_TOKEN_WINDOW_DAYS, this.sourceId);
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      logger.debug(`📢 Token replacement - DIRECTCOUNT: ${directCount} direct nodes out of ${nodes.length} active nodes (last 2h)`);
      result = result.replace(/{DIRECTCOUNT}/g, encode(directCount.toString()));
    }

    // {TOTALNODES} - Total nodes (all nodes ever seen, regardless of when last heard, scoped to this source)
    if (result.includes('{TOTALNODES}')) {
      const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
      logger.debug(`📢 Token replacement - TOTALNODES: ${allNodes.length} total nodes`);
      result = result.replace(/{TOTALNODES}/g, encode(allNodes.length.toString()));
    }

    // {ONLINENODES} - Online nodes as reported by the connected Meshtastic device (from LocalStats)
    if (result.includes('{ONLINENODES}')) {
      let onlineNodes = 0;
      if (this.localNodeInfo?.nodeId) {
        try {
          const telemetry = await databaseService.getLatestTelemetryForTypeAsync(this.localNodeInfo.nodeId, 'numOnlineNodes');
          if (telemetry?.value !== undefined && telemetry.value !== null) {
            onlineNodes = Math.floor(telemetry.value);
          }
        } catch (error) {
          logger.error('❌ Error fetching numOnlineNodes telemetry:', error);
        }
      }
      logger.debug(`📢 Token replacement - ONLINENODES: ${onlineNodes} online nodes (from device LocalStats)`);
      result = result.replace(/{ONLINENODES}/g, encode(onlineNodes.toString()));
    }

    // {IP} - Meshtastic node IP address
    if (result.includes('{IP}')) {
      const config = await this.getConfig();
      result = result.replace(/{IP}/g, encode(config.nodeIp));
    }

    // {PORT} - Meshtastic node TCP port
    if (result.includes('{PORT}')) {
      const config = await this.getConfig();
      result = result.replace(/{PORT}/g, encode(String(config.tcpPort)));
    }

    // {DATE} / {TIME} - Current date/time when the announcement is sent, formatted
    // per the global dateFormat/timeFormat presentation preferences (issue #3382).
    if (result.includes('{DATE}') || result.includes('{TIME}')) {
      const now = new Date();
      const dateFormat = await databaseService.settings.getSetting('dateFormat') || 'MM/DD/YYYY';
      const timeFormat = await databaseService.settings.getSetting('timeFormat') || '24';
      if (result.includes('{DATE}')) {
        result = result.replace(/{DATE}/g, encode(formatDate(now, dateFormat as 'MM/DD/YYYY' | 'DD/MM/YYYY')));
      }
      if (result.includes('{TIME}')) {
        result = result.replace(/{TIME}/g, encode(formatTime(now, timeFormat as '12' | '24')));
      }
    }

    return result;
  }

  /**
   * Thin delegate — see `AutoAnnounceService.previewAnnouncementMessage`.
   * Used by the preview API endpoint.
   */
  public async previewAnnouncementMessage(message: string): Promise<string> {
    return this.autoAnnounceService.previewAnnouncementMessage(message);
  }

  /**
   * Resolve the {LAST_HOP} relay node value to a display name (short name →
   * hex byte → 'unknown'), matching the Packet Monitor. Issue #3318.
   */
  private async getLastHopName(relayNode?: number | null): Promise<string> {
    if (relayNode == null || relayNode === 0) return 'unknown';
    try {
      const nodes = await databaseService.nodes.getActiveNodes(7, this.sourceId);
      return resolveLastHopName(relayNode, nodes.map((n: any) => ({
        nodeNum: Number(n.nodeNum),
        shortName: n.shortName,
        role: n.role,
        hopsAway: n.hopsAway,
        lastHeard: n.lastHeard,
      })));
    } catch (error) {
      logger.error('Failed to resolve {LAST_HOP} relay name:', error);
      // Fall back to the hex byte rather than leaking the raw token.
      return resolveLastHopName(relayNode, []);
    }
  }

  private async replaceAcknowledgementTokens(message: string, nodeId: string, fromNum: number, numberHops: number, date: string, time: string, channelIndex: number, isDirectMessage: boolean, rxSnr?: number, rxRssi?: number, viaMqtt?: boolean, urlEncode: boolean = false, relayNode?: number | null): Promise<string> {
    // Start with base announcement tokens (includes {IP}, {PORT}, {VERSION}, {DURATION}, {FEATURES}, {NODECOUNT}, {DIRECTCOUNT})
    let result = await this.replaceAnnouncementTokens(message, urlEncode);
    const encode = (v: string) => urlEncode ? encodeURIComponent(v) : v;

    // {NODE_ID} - Sender node ID
    if (result.includes('{NODE_ID}')) {
      result = result.replace(/{NODE_ID}/g, encode(nodeId));
    }

    // {LONG_NAME} - Sender node long name
    if (result.includes('{LONG_NAME}')) {
      // Scope by sourceId: under the composite (nodeNum, sourceId) PK an
      // unscoped lookup returns the first row across ANY source, which can be a
      // different source's node (or nothing), making the token resolve to
      // 'Unknown' even when this source has the name on record (#3384).
      const node = await databaseService.nodes.getNode(fromNum, this.sourceId);
      const longName = node?.longName || 'Unknown';
      result = result.replace(/{LONG_NAME}/g, encode(longName));
    }

    // {SHORT_NAME} - Sender node short name
    if (result.includes('{SHORT_NAME}')) {
      // Scope by sourceId — see {LONG_NAME} above (#3384).
      const node = await databaseService.nodes.getNode(fromNum, this.sourceId);
      const shortName = node?.shortName || '????';
      result = result.replace(/{SHORT_NAME}/g, encode(shortName));
    }

    // {NUMBER_HOPS} and {HOPS} - Number of hops
    if (result.includes('{NUMBER_HOPS}')) {
      result = result.replace(/{NUMBER_HOPS}/g, encode(numberHops.toString()));
    }
    if (result.includes('{HOPS}')) {
      result = result.replace(/{HOPS}/g, encode(numberHops.toString()));
    }

    // {RABBIT_HOPS} - Rabbit emojis equal to hop count (or 🎯 for direct/0 hops)
    if (result.includes('{RABBIT_HOPS}')) {
      // Ensure numberHops is valid (>= 0) to prevent String.repeat() errors
      const validHops = Math.max(0, numberHops);
      const rabbitEmojis = validHops === 0 ? '🎯' : '🐇'.repeat(validHops);
      result = result.replace(/{RABBIT_HOPS}/g, encode(rabbitEmojis));
    }

    // {DATE} - Date
    if (result.includes('{DATE}')) {
      result = result.replace(/{DATE}/g, encode(date));
    }

    // {TIME} - Time
    if (result.includes('{TIME}')) {
      result = result.replace(/{TIME}/g, encode(time));
    }

    // Note: {VERSION}, {DURATION}, {FEATURES}, {NODECOUNT}, {DIRECTCOUNT}, {IP}, {PORT}
    // are now handled by replaceAnnouncementTokens which is called at the start of this function

    // {SNR} - Signal-to-Noise Ratio
    if (result.includes('{SNR}')) {
      const snrValue = (rxSnr !== undefined && rxSnr !== null && rxSnr !== 0)
        ? rxSnr.toFixed(1)
        : 'N/A';
      result = result.replace(/{SNR}/g, encode(snrValue));
    }

    // {RSSI} - Received Signal Strength Indicator
    if (result.includes('{RSSI}')) {
      const rssiValue = (rxRssi !== undefined && rxRssi !== null && rxRssi !== 0)
        ? rxRssi.toString()
        : 'N/A';
      result = result.replace(/{RSSI}/g, encode(rssiValue));
    }

    // {CHANNEL} - Channel name (or index if no name or DM)
    if (result.includes('{CHANNEL}')) {
      let channelName: string;
      if (isDirectMessage) {
        channelName = 'DM';
      } else {
        const channel = await databaseService.channels.getChannelById(channelIndex, this.sourceId);
        // Use channel name if available and not empty, otherwise fall back to channel number
        channelName = (channel?.name && channel.name.trim()) ? channel.name.trim() : channelIndex.toString();
      }
      result = result.replace(/{CHANNEL}/g, encode(channelName));
    }

    // {TRANSPORT} - Transport type (LoRa or MQTT)
    if (result.includes('{TRANSPORT}')) {
      const transport = viaMqtt === true ? 'MQTT' : 'LoRa';
      result = result.replace(/{TRANSPORT}/g, encode(transport));
    }

    // {LAST_HOP} - Short name of the last relay node (hex byte / 'unknown' fallback)
    if (result.includes('{LAST_HOP}')) {
      const lastHop = await this.getLastHopName(relayNode);
      result = result.replace(/{LAST_HOP}/g, encode(lastHop));
    }

    return result;
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      const remainingHours = hours % 24;
      return `${days}d${remainingHours > 0 ? ` ${remainingHours}h` : ''}`;
    } else if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ''}`;
    } else if (minutes > 0) {
      return `${minutes}m`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Process incoming admin messages and extract session passkey
   * Extracts session passkeys from ALL admin responses (per research findings)
   */
  private async processAdminMessage(payload: Uint8Array, meshPacket: any): Promise<void> {
    try {
      const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
      logger.debug(`⚙️ Processing ADMIN_APP message from node ${fromNum}, payload size: ${payload.length}`);
      const adminMsg = protobufService.decodeAdminMessage(payload);
      if (!adminMsg) {
        logger.error('⚙️ Failed to decode admin message');
        return;
      }

      logger.debug('⚙️ Decoded admin message keys:', Object.keys(adminMsg));
      logger.debug('⚙️ Decoded admin message has getConfigResponse:', !!adminMsg.getConfigResponse);
      if (adminMsg.getConfigResponse) {
        logger.debug('⚙️ getConfigResponse type:', typeof adminMsg.getConfigResponse);
        logger.debug('⚙️ getConfigResponse keys:', Object.keys(adminMsg.getConfigResponse || {}));
      }

      // Extract session passkey from ALL admin responses (per research findings)
      if (adminMsg.sessionPasskey && adminMsg.sessionPasskey.length > 0) {
        const localNodeNum = this.localNodeInfo?.nodeNum || 0;
        
        if (fromNum === localNodeNum || fromNum === 0) {
          // Local node - store in legacy location for backward compatibility
          this.sessionPasskey = new Uint8Array(adminMsg.sessionPasskey);
          this.sessionPasskeyExpiry = Date.now() + (290 * 1000); // 290 seconds (10 second buffer before 300s expiry)
          logger.debug('🔑 Session passkey received from local node and stored (expires in 290 seconds)');
        } else {
          // Remote node - store per-node
          this.remoteSessionPasskeys.set(fromNum, {
            passkey: new Uint8Array(adminMsg.sessionPasskey),
            expiry: Date.now() + (290 * 1000) // 290 seconds
          });
          logger.debug(`🔑 Session passkey received from remote node ${fromNum} and stored (expires in 290 seconds)`);
        }
      }

      // Process config responses from remote nodes
      const localNodeNum = this.localNodeInfo?.nodeNum || 0;
      const isRemoteNode = fromNum !== 0 && fromNum !== localNodeNum;

      if (adminMsg.getConfigResponse) {
        logger.debug(`⚙️ Received GetConfigResponse from node ${fromNum}`);
        logger.debug('⚙️ GetConfigResponse structure:', JSON.stringify(Object.keys(adminMsg.getConfigResponse || {})));
        logger.debug('⚙️ GetConfigResponse position field present:', !!adminMsg.getConfigResponse.position);
        if (isRemoteNode) {
          // Store config for remote node
          // getConfigResponse is a Config object containing device, lora, position, etc.
          if (!this.remoteNodeConfigs.has(fromNum)) {
            this.remoteNodeConfigs.set(fromNum, {
              deviceConfig: {},
              moduleConfig: {},
              lastUpdated: Date.now()
            });
          }
          const nodeConfig = this.remoteNodeConfigs.get(fromNum)!;
          // getConfigResponse is a Config object with device, lora, position, security, bluetooth, etc. fields
          // Merge ALL fields from the response into existing deviceConfig to preserve other config types
          const configResponse = adminMsg.getConfigResponse;
          if (configResponse) {
            // Merge all config fields that exist in the response
            // This includes: device, lora, position, security, bluetooth, network, display, power, etc.
            Object.keys(configResponse).forEach((key) => {
              // Skip internal protobuf fields
              if (key !== 'payloadVariant' && configResponse[key] !== undefined) {
                nodeConfig.deviceConfig[key] = configResponse[key];
              }
            });
          }
          nodeConfig.lastUpdated = Date.now();
          logger.debug(`📊 Stored config response from remote node ${fromNum}, keys:`, Object.keys(nodeConfig.deviceConfig));
          logger.debug(`📊 Position config stored:`, !!nodeConfig.deviceConfig.position);
          if (nodeConfig.deviceConfig.position) {
            logger.debug(`📊 Position config details:`, JSON.stringify(Object.keys(nodeConfig.deviceConfig.position)));
          }
        }
      }

      if (adminMsg.getModuleConfigResponse) {
        logger.debug('⚙️ Received GetModuleConfigResponse from node', fromNum);
        logger.debug('⚙️ GetModuleConfigResponse structure:', JSON.stringify(Object.keys(adminMsg.getModuleConfigResponse || {})));
        if (isRemoteNode) {
          // Store module config for remote node
          // getModuleConfigResponse is a ModuleConfig object containing mqtt, neighborInfo, etc.
          if (!this.remoteNodeConfigs.has(fromNum)) {
            this.remoteNodeConfigs.set(fromNum, {
              deviceConfig: {},
              moduleConfig: {},
              lastUpdated: Date.now()
            });
          }
          const nodeConfig = this.remoteNodeConfigs.get(fromNum)!;
          // getModuleConfigResponse is a ModuleConfig object with mqtt, neighborInfo, etc. fields
          // Merge individual fields instead of replacing entire object (like we do for deviceConfig)
          const moduleConfigResponse = adminMsg.getModuleConfigResponse;
          if (moduleConfigResponse) {
            // Merge all module config fields that exist in the response
            const responseKeys = Object.keys(moduleConfigResponse).filter(k => k !== 'payloadVariant' && moduleConfigResponse[k] !== undefined);
            responseKeys.forEach((key) => {
              nodeConfig.moduleConfig[key] = moduleConfigResponse[key];
            });

            // Proto3 omits all-default fields, so an empty getModuleConfigResponse means
            // the node responded with a config where all values are defaults.
            // Use the pending request tracker to store an empty config under the correct key.
            if (responseKeys.length === 0) {
              const pendingKey = this.pendingModuleConfigRequests.get(fromNum);
              if (pendingKey) {
                logger.debug(`📊 Empty module config response from node ${fromNum}, storing defaults for '${pendingKey}'`);
                nodeConfig.moduleConfig[pendingKey] = {};
                this.pendingModuleConfigRequests.delete(fromNum);
              }
            }
          }
          nodeConfig.lastUpdated = Date.now();
          logger.debug(`📊 Stored module config response from remote node ${fromNum}, keys:`, Object.keys(nodeConfig.moduleConfig));
        } else {
          // Local node: merge the explicit module-config response into
          // actualModuleConfig. Without this, an explicit refresh
          // (requestModuleConfig / refreshModuleConfigs) is dropped — only the
          // initial wantConfig stream ever populated the local config.
          if (!this.actualModuleConfig) {
            this.actualModuleConfig = {};
          }
          const moduleConfigResponse = adminMsg.getModuleConfigResponse;
          if (moduleConfigResponse) {
            const responseKeys = Object.keys(moduleConfigResponse).filter(k => k !== 'payloadVariant' && moduleConfigResponse[k] !== undefined);
            responseKeys.forEach((key) => {
              this.actualModuleConfig[key] = moduleConfigResponse[key];
            });

            // Proto3 omits all-default fields, so an empty response means the
            // module exists but every value is default. Record it under the
            // pending request's key so support detection and the config UI see it.
            if (responseKeys.length === 0) {
              const localNodeKey = this.localNodeInfo?.nodeNum ?? fromNum;
              const pendingKey = this.pendingModuleConfigRequests.get(localNodeKey)
                ?? this.pendingModuleConfigRequests.get(fromNum);
              if (pendingKey) {
                logger.debug(`📊 Empty local module config response, storing defaults for '${pendingKey}'`);
                if (this.actualModuleConfig[pendingKey] === undefined) {
                  this.actualModuleConfig[pendingKey] = {};
                }
                this.pendingModuleConfigRequests.delete(localNodeKey);
                this.pendingModuleConfigRequests.delete(fromNum);
              }
            }
          }
          logger.debug(`📊 Merged local module config response, actualModuleConfig keys:`, Object.keys(this.actualModuleConfig));
        }
      }

      // Process channel responses from remote nodes
      if (adminMsg.getChannelResponse) {
        logger.debug('⚙️ Received GetChannelResponse from node', fromNum);
        if (isRemoteNode) {
          // Store channel for remote node
          if (!this.remoteNodeChannels.has(fromNum)) {
            this.remoteNodeChannels.set(fromNum, new Map());
          }
          const nodeChannels = this.remoteNodeChannels.get(fromNum)!;
          // getChannelResponse contains the channel data
          const channel = adminMsg.getChannelResponse;
          // The channel.index in the response is 0-based (0-7) per protobuf definition
          // The request uses index + 1 (1-based, 1-8), but the response Channel.index is 0-based
          const storedIndex = channel.index;
          if (storedIndex === undefined || storedIndex === null) {
            logger.warn(`⚠️ Channel response from node ${fromNum} missing index field`);
            // Skip storing this channel but continue processing other admin message types
          } else if (storedIndex < 0 || storedIndex > 7) {
            // Validate the index is in the valid range (0-7)
            logger.warn(`⚠️ Channel index ${storedIndex} from node ${fromNum} is out of valid range (0-7), skipping`);
            // Skip storing this channel but continue processing other admin message types
          } else {
            // Use the index directly - it's already 0-based
            nodeChannels.set(storedIndex, channel);
            logger.debug(`📊 Stored channel ${storedIndex} (from response index ${channel.index}) from remote node ${fromNum}`, {
              hasSettings: !!channel.settings,
              name: channel.settings?.name,
              role: channel.role,
              channelKeys: Object.keys(channel),
              settingsKeys: channel.settings ? Object.keys(channel.settings) : [],
              fullChannel: JSON.stringify(channel, null, 2)
            });
          }
        }
      }

      // Process owner responses from both local and remote nodes
      if (adminMsg.getOwnerResponse) {
        logger.debug('⚙️ Received GetOwnerResponse from node', fromNum);
        // Store owner response (both local and remote nodes go into remoteNodeOwners for simplicity)
        this.remoteNodeOwners.set(fromNum, adminMsg.getOwnerResponse);
        logger.debug(`📊 Stored owner response from node ${fromNum}`, {
          longName: adminMsg.getOwnerResponse.longName,
          shortName: adminMsg.getOwnerResponse.shortName,
          isUnmessagable: adminMsg.getOwnerResponse.isUnmessagable,
          hasPublicKey: !!(adminMsg.getOwnerResponse.publicKey && adminMsg.getOwnerResponse.publicKey.length > 0)
        });
      }
      if (adminMsg.getDeviceMetadataResponse) {
        logger.debug('⚙️ Received GetDeviceMetadataResponse from node', fromNum);
        // Store device metadata response for retrieval
        this.remoteNodeDeviceMetadata.set(fromNum, adminMsg.getDeviceMetadataResponse);
        logger.debug(`📊 Stored device metadata from node ${fromNum}`, {
          firmwareVersion: adminMsg.getDeviceMetadataResponse.firmwareVersion,
          hwModel: adminMsg.getDeviceMetadataResponse.hwModel,
          role: adminMsg.getDeviceMetadataResponse.role,
          hasWifi: adminMsg.getDeviceMetadataResponse.hasWifi,
          hasBluetooth: adminMsg.getDeviceMetadataResponse.hasBluetooth,
          hasEthernet: adminMsg.getDeviceMetadataResponse.hasEthernet
        });
      }
    } catch (error) {
      logger.error('❌ Error processing admin message:', error);
    }
  }

  /**
   * Check if current session passkey is valid (for local node)
   */
  private isSessionPasskeyValid(): boolean {
    if (!this.sessionPasskey || !this.sessionPasskeyExpiry) {
      return false;
    }
    return Date.now() < this.sessionPasskeyExpiry;
  }

  /**
   * Get session passkey for a specific node (local or remote)
   * @param nodeNum Node number (0 or local node num for local, other for remote)
   * @returns Session passkey if valid, null otherwise
   */
  getSessionPasskey(nodeNum: number): Uint8Array | null {
    const localNodeNum = this.localNodeInfo?.nodeNum || 0;
    
    if (nodeNum === 0 || nodeNum === localNodeNum) {
      // Local node - use legacy storage
      if (this.isSessionPasskeyValid()) {
        return this.sessionPasskey;
      }
      return null;
    } else {
      // Remote node - check per-node storage
      const stored = this.remoteSessionPasskeys.get(nodeNum);
      if (stored && Date.now() < stored.expiry) {
        return stored.passkey;
      }
      // Clean up expired entry
      if (stored) {
        this.remoteSessionPasskeys.delete(nodeNum);
      }
      return null;
    }
  }

  /**
   * Check if session passkey is valid for a specific node
   * @param nodeNum Node number
   * @returns true if valid session passkey exists
   */
  isSessionPasskeyValidForNode(nodeNum: number): boolean {
    return this.getSessionPasskey(nodeNum) !== null;
  }

  /**
   * Get session passkey status for a node
   * @param nodeNum Node number
   * @returns Status object with hasPasskey, expiresAt timestamp, and remainingSeconds
   */
  getSessionPasskeyStatus(nodeNum: number): { hasPasskey: boolean; expiresAt: number | null; remainingSeconds: number | null } {
    const localNodeNum = this.localNodeInfo?.nodeNum || 0;

    if (nodeNum === 0 || nodeNum === localNodeNum) {
      // Local node
      if (this.sessionPasskey && this.sessionPasskeyExpiry && Date.now() < this.sessionPasskeyExpiry) {
        const remainingSeconds = Math.max(0, Math.floor((this.sessionPasskeyExpiry - Date.now()) / 1000));
        return { hasPasskey: true, expiresAt: this.sessionPasskeyExpiry, remainingSeconds };
      }
      return { hasPasskey: false, expiresAt: null, remainingSeconds: null };
    } else {
      // Remote node
      const stored = this.remoteSessionPasskeys.get(nodeNum);
      if (stored && Date.now() < stored.expiry) {
        const remainingSeconds = Math.max(0, Math.floor((stored.expiry - Date.now()) / 1000));
        return { hasPasskey: true, expiresAt: stored.expiry, remainingSeconds };
      }
      return { hasPasskey: false, expiresAt: null, remainingSeconds: null };
    }
  }

  /**
   * Request session passkey from the device (local node)
   */
  async requestSessionPasskey(): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      const getSessionKeyRequest = protobufService.createGetSessionKeyRequest();
      const adminPacket = protobufService.createAdminPacket(getSessionKeyRequest, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum); // send to local node

      await this.transport.send(adminPacket);
      logger.debug('🔑 Requested session passkey from device (via SESSIONKEY_CONFIG)');

      // Wait for the response (admin messages can take time)
      // Increased from 3s to 5s to allow for slower serial connections
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check if we received the passkey
      if (!this.isSessionPasskeyValid()) {
        logger.debug('⚠️ No session passkey response received from device');
      }
    } catch (error) {
      logger.error('❌ Error requesting session passkey:', error);
      throw error;
    }
  }

  /**
   * Request session passkey from a remote node
   * Uses getDeviceMetadataRequest (per research findings - Android pattern)
   * @param destinationNodeNum The node number to request session passkey from
   * @returns Session passkey if received, null otherwise
   */
  async requestRemoteSessionPasskey(destinationNodeNum: number): Promise<Uint8Array | null> {
    return this.remoteAdminService.requestRemoteSessionPasskey(destinationNodeNum);
  }

  /**
   * Parse firmware version string into major.minor.patch
   */
  // public: shared with FavoritesService.supportsFavorites() (#3962 Phase
  // 4.2a PR4 §4c) as well as the unmoved firmwareVersionAtLeast() below.
  parseFirmwareVersion(versionString: string): { major: number; minor: number; patch: number } | null {
    // Firmware version format: "2.7.11.ee68575" or "2.7.11"
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10)
    };
  }

  /**
   * Check whether the local device firmware version is at least the given
   * major.minor.patch. Returns false if the firmware version is unknown or
   * unparseable.
   *
   * Used to gate module-config feature support (e.g. Traffic Management,
   * StatusMessage). Module support MUST NOT be inferred from the presence of a
   * decoded config sub-message: Proto3 omits a sub-message whose every field is
   * default, so an all-default (but fully supported) module reports as missing.
   */
  private firmwareVersionAtLeast(major: number, minor: number, patch: number): boolean {
    if (!this.localNodeInfo?.firmwareVersion) {
      return false;
    }
    const version = this.parseFirmwareVersion(this.localNodeInfo.firmwareVersion);
    if (!version) {
      return false;
    }
    if (version.major !== major) return version.major > major;
    if (version.minor !== minor) return version.minor > minor;
    return version.patch >= patch;
  }

  /**
   * Check if the local device firmware supports the StatusMessage module.
   *
   * The AdminModule set-config handler for `statusmessage` first shipped in
   * firmware 2.7.20 (verified against the meshtastic/firmware tags — it is
   * absent in 2.7.19 and earlier). Gating at 2.7.19 was off by one: a 2.7.19
   * node would accept the admin message but silently not persist it.
   */
  supportsStatusMessage(): boolean {
    return this.firmwareVersionAtLeast(2, 7, 20);
  }

  /**
   * Check if the local device firmware supports the Traffic Management module.
   *
   * The module and its AdminModule set-config handler landed only on the
   * meshtastic/firmware `develop` branch via PR #9358 (merged 2026-03-11) and
   * are NOT in any release through the latest pre-release, 2.7.25 — verified:
   * `TrafficManagementModule.cpp` doesn't exist at the v2.7.25 tag and
   * `AdminModule.cpp` has no `traffic_management` case there. On such firmware
   * the admin message decodes but is silently dropped (it never persists),
   * which is what made saves appear to "succeed" but not stick (issue #3491).
   *
   * Gating at 2.7.22 (the previous value) wrongly advertised it as editable on
   * 2.7.22–2.7.25. Since no release ships it yet, gate above the latest release:
   * develop/preview builds (which already contain PR #9358) report a version
   * newer than 2.7.25, and the first stable release to include it will be
   * >= 2.7.26. Re-pin to the exact release once it is tagged.
   */
  supportsTrafficManagement(): boolean {
    return this.firmwareVersionAtLeast(2, 7, 26);
  }

  /**
   * Check if the local device firmware supports favorites feature (>= 2.7.0)
   * Result is cached to avoid redundant parsing and version comparisons
   */
  supportsFavorites(): boolean {
    return this.favoritesService.supportsFavorites();
  }

  /**
   * Send admin message to set a node as favorite on the device
   */
  async sendFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    return this.favoritesService.sendFavoriteNode(nodeNum, destinationNodeNum);
  }

  /**
   * Send admin message to remove a node from favorites on the device
   */
  async sendRemoveFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    return this.favoritesService.sendRemoveFavoriteNode(nodeNum, destinationNodeNum);
  }

  /**
   * Send admin message to set a node as ignored on the device
   */
  async sendIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support (ignored nodes use same version as favorites)
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    const localNodeNum = this.localNodeInfo?.nodeNum || 0;
    const destNode = destinationNodeNum || localNodeNum;
    const isRemote = destNode !== localNodeNum && destNode !== 0;

    try {
      let sessionPasskey: Uint8Array = new Uint8Array();
      if (isRemote) {
        const cached = this.getSessionPasskey(destNode);
        if (cached) {
          sessionPasskey = cached;
        } else {
          const requested = await this.requestRemoteSessionPasskey(destNode);
          if (!requested) throw new Error(`Failed to obtain session passkey for remote node ${destNode}`);
          sessionPasskey = requested;
        }
      }

      const setIgnoredMsg = protobufService.createSetIgnoredNodeMessage(nodeNum, sessionPasskey);
      await this.sendAdminCommand(setIgnoredMsg, destNode);
      logger.debug(`🚫 Sent set_ignored_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) to ${isRemote ? 'remote' : 'local'} node ${destNode}`);
    } catch (error) {
      logger.error('❌ Error sending ignored node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to remove a node from ignored list on the device
   */
  async sendRemoveIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support (ignored nodes use same version as favorites)
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    const localNodeNum = this.localNodeInfo?.nodeNum || 0;
    const destNode = destinationNodeNum || localNodeNum;
    const isRemote = destNode !== localNodeNum && destNode !== 0;

    try {
      let sessionPasskey: Uint8Array = new Uint8Array();
      if (isRemote) {
        const cached = this.getSessionPasskey(destNode);
        if (cached) {
          sessionPasskey = cached;
        } else {
          const requested = await this.requestRemoteSessionPasskey(destNode);
          if (!requested) throw new Error(`Failed to obtain session passkey for remote node ${destNode}`);
          sessionPasskey = requested;
        }
      }

      const removeIgnoredMsg = protobufService.createRemoveIgnoredNodeMessage(nodeNum, sessionPasskey);
      await this.sendAdminCommand(removeIgnoredMsg, destNode);
      logger.debug(`✅ Sent remove_ignored_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) to ${isRemote ? 'remote' : 'local'} node ${destNode}`);
    } catch (error) {
      logger.error('❌ Error sending remove ignored node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to remove a node from the device NodeDB
   * This sends the remove_by_nodenum admin command to completely delete a node from the device
   */
  async sendRemoveNode(nodeNum: number): Promise<void> {
    return this.nodeDbMaintenanceService.sendRemoveNode(nodeNum);
  }

  private async pushContactToRadio(targetNode: { nodeNum: number; nodeId: string; longName?: string | null; shortName?: string | null; publicKey?: string | null; hwModel?: number | null }): Promise<void> {
    if (!this.isConnected || !this.transport || !this.localNodeInfo?.nodeNum) {
      return;
    }
    if (!targetNode.publicKey || !targetNode.nodeId || !targetNode.longName || !targetNode.shortName) {
      return;
    }

    const localNodeNum = this.localNodeInfo.nodeNum;
    const addContactMsg = protobufService.createAddContactMessage(
      targetNode.nodeNum,
      targetNode.nodeId,
      targetNode.longName,
      targetNode.shortName,
      targetNode.publicKey,
      targetNode.hwModel ?? undefined,
    );
    const adminPacket = protobufService.createAdminPacket(addContactMsg, localNodeNum, localNodeNum);
    await this.transport.send(adminPacket);
    // The contact (incl. public key) is now in the radio's NodeDB, so messaging is
    // restored. Track it locally so the UI's "not in device DB" warning clears on the
    // next poll without waiting for the radio to independently re-report the node.
    this.deviceNodeNums.add(targetNode.nodeNum);
    logger.debug(`📇 Pushed contact for !${targetNode.nodeNum.toString(16).padStart(8, '0')} to radio NodeDB before PKI DM`);
  }

  /**
   * Request specific config from the device
   * @param configType Config type to request (0=DEVICE_CONFIG, 5=LORA_CONFIG, etc.)
   */
  async requestConfig(configType: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Requesting config type ${configType} from device`);
      const getConfigMsg = protobufService.createGetConfigRequest(configType);
      const adminPacket = protobufService.createAdminPacket(getConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug(`⚙️ Sent get_config_request for config type ${configType}`);
    } catch (error) {
      logger.error('❌ Error requesting config:', error);
      throw error;
    }
  }

  /**
   * Request specific module config from the device
   * @param configType Module config type to request (0=MQTT_CONFIG, 9=NEIGHBORINFO_CONFIG, etc.)
   */
  async requestModuleConfig(configType: number): Promise<void> {
    return this.remoteAdminService.requestModuleConfig(configType);
  }

  /**
   * Request config from a remote node
   * @param destinationNodeNum The remote node number
   * @param configType The config type to request (DEVICE_CONFIG=0, LORA_CONFIG=5, etc.)
   * @param isModuleConfig Whether this is a module config request (false for device configs)
   * @returns The config data if received, null otherwise
   */
  async requestRemoteConfig(destinationNodeNum: number, configType: number, isModuleConfig: boolean = false): Promise<any> {
    return this.remoteAdminService.requestRemoteConfig(destinationNodeNum, configType, isModuleConfig);
  }

  /**
   * Request a specific channel from a remote node
   * @param destinationNodeNum The remote node number
   * @param channelIndex The channel index (0-7)
   * @returns The channel data if received, null otherwise
   */
  async requestRemoteChannel(destinationNodeNum: number, channelIndex: number): Promise<any> {
    return this.remoteAdminService.requestRemoteChannel(destinationNodeNum, channelIndex);
  }

  /**
   * Request owner information from a remote node
   * @param destinationNodeNum The remote node number
   * @returns The owner data if received, null otherwise
   */
  async requestRemoteOwner(destinationNodeNum: number): Promise<any> {
    return this.remoteAdminService.requestRemoteOwner(destinationNodeNum);
  }

  /**
   * Request device metadata from a remote node
   * Returns firmware version, hardware model, capabilities, role, etc.
   */
  async requestRemoteDeviceMetadata(destinationNodeNum: number): Promise<any> {
    return this.remoteAdminService.requestRemoteDeviceMetadata(destinationNodeNum);
  }

  /**
   * Send reboot command to a node (local or remote)
   * @param destinationNodeNum The target node number (0 or local node num for local)
   * @param seconds Number of seconds before reboot (default: 5, use negative to cancel)
   */
  async sendRebootCommand(destinationNodeNum: number, seconds: number = 10): Promise<void> {
    return this.remoteAdminService.sendRebootCommand(destinationNodeNum, seconds);
  }

  /**
   * Send set time command to a node (local or remote)
   * Sets the node's time to the current server time
   * @param destinationNodeNum The target node number (0 or local node num for local)
   */
  async sendSetTimeCommand(destinationNodeNum: number): Promise<void> {
    return this.remoteAdminService.sendSetTimeCommand(destinationNodeNum);
  }

  /**
   * Request all module configurations from the device for complete backup
   * This requests all 13 module config types defined in the protobufs
   */
  async requestAllModuleConfigs(): Promise<void> {
    return this.remoteAdminService.requestAllModuleConfigs();
  }

  /**
   * Reset module config cache so the next connect() will re-fetch all configs.
   * Called after OTA firmware updates to ensure fresh config data.
   */
  resetModuleConfigCache(): void {
    return this.remoteAdminService.resetModuleConfigCache();
  }

  /**
   * Force refresh of module configs (resets the cache flag and re-fetches).
   * Useful for Configuration tab refresh button or API use.
   */
  async refreshModuleConfigs(): Promise<void> {
    return this.remoteAdminService.refreshModuleConfigs();
  }

  /**
   * Send an admin command to a node (local or remote)
   * The admin message should already be built with session passkey if needed
   * @param adminMessagePayload The encoded admin message (should already include session passkey for remote nodes)
   * @param destinationNodeNum Destination node number (0 or local node num for local, other for remote)
   * @returns Promise that resolves when command is sent
   */
  async sendAdminCommand(adminMessagePayload: Uint8Array, destinationNodeNum: number): Promise<void> {
    return this.adminTransactionService.sendAdminCommand(adminMessagePayload, destinationNodeNum);
  }

  /**
   * Send an admin command and wait for the destination node's routing ACK.
   * `acked` is true only on error_reason=NONE from the destination; `errorReason`
   * carries the routing error on rejection (e.g. ADMIN_BAD_SESSION_KEY);
   * `timedOut` is true if no ACK arrived within timeoutMs.
   */
  async sendAdminCommandAwaitAck(
    adminMessagePayload: Uint8Array,
    destinationNodeNum: number,
    timeoutMs: number = 30000
  ): Promise<{ packetId: number; acked: boolean; errorReason: number | null; timedOut: boolean }> {
    return this.adminTransactionService.sendAdminCommandAwaitAck(adminMessagePayload, destinationNodeNum, timeoutMs);
  }

  /**
   * Send a set_favorite_node admin command and wait for its ACK. Handles the
   * remote session-passkey handshake exactly like sendFavoriteNode.
   */
  async sendFavoriteNodeAwaitAck(
    nodeNum: number,
    destinationNodeNum?: number,
    timeoutMs: number = 30000
  ): Promise<{ acked: boolean; errorReason: number | null; timedOut: boolean }> {
    return this.favoritesService.sendFavoriteNodeAwaitAck(nodeNum, destinationNodeNum, timeoutMs);
  }

  /**
   * Reboot the connected Meshtastic device
   * @param seconds Number of seconds to wait before rebooting
   */
  async rebootDevice(seconds: number = 10): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Sending reboot command: device will reboot in ${seconds} seconds`);
      // NOTE: Session passkeys are only required for REMOTE admin operations (admin messages sent to other nodes via mesh).
      // For local TCP connections to the device itself, no session passkey is needed.
      const rebootMsg = protobufService.createRebootMessage(seconds);
      const adminPacket = protobufService.createAdminPacket(rebootMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent reboot admin message (local operation, no session passkey required)');
    } catch (error) {
      logger.error('❌ Error sending reboot command:', error);
      throw error;
    }
  }

  /**
   * Purge the node database on the connected Meshtastic device
   * @param seconds Number of seconds to wait before purging (typically 0 for immediate)
   */
  async purgeNodeDb(seconds: number = 0): Promise<void> {
    return this.nodeDbMaintenanceService.purgeNodeDb(seconds);
  }

  /**
   * Set device configuration (role, broadcast intervals, etc.)
   */
  async setDeviceConfig(config: any): Promise<void> {
    return this.deviceAdminService.setDeviceConfig(config);
  }

  /**
   * Set LoRa configuration (preset, region, etc.)
   */
  async setLoRaConfig(config: any): Promise<void> {
    return this.deviceAdminService.setLoRaConfig(config);
  }

  /**
   * Set network configuration (NTP server, etc.)
   */
  async setNetworkConfig(config: any): Promise<void> {
    return this.deviceAdminService.setNetworkConfig(config);
  }

  /**
   * Set channel configuration
   * @param channelIndex The channel index (0-7)
   * @param config Channel configuration
   */
  async setChannelConfig(channelIndex: number, config: {
    name?: string;
    psk?: string;
    role?: number;
    uplinkEnabled?: boolean;
    downlinkEnabled?: boolean;
    positionPrecision?: number;
  }): Promise<void> {
    return this.deviceAdminService.setChannelConfig(channelIndex, config);
  }

  /**
   * Set position configuration (broadcast intervals, etc.)
   */
  async setPositionConfig(config: any): Promise<void> {
    return this.deviceAdminService.setPositionConfig(config);
  }

  /**
   * Set MQTT module configuration
   */
  async setMQTTConfig(config: any): Promise<void> {
    return this.deviceAdminService.setMQTTConfig(config);
  }

  /**
   * Set NeighborInfo module configuration
   */
  async setNeighborInfoConfig(config: any): Promise<void> {
    return this.deviceAdminService.setNeighborInfoConfig(config);
  }

  /**
   * Set power configuration
   */
  async setPowerConfig(config: any): Promise<void> {
    return this.deviceAdminService.setPowerConfig(config);
  }

  /**
   * Set display configuration
   */
  async setDisplayConfig(config: any): Promise<void> {
    return this.deviceAdminService.setDisplayConfig(config);
  }

  /**
   * Set telemetry module configuration
   */
  async setTelemetryConfig(config: any): Promise<void> {
    return this.deviceAdminService.setTelemetryConfig(config);
  }

  /**
   * Set generic module configuration
   * Handles: extnotif, storeforward, rangetest, cannedmsg, audio,
   * remotehardware, detectionsensor, paxcounter, serial, ambientlighting
   */
  async setGenericModuleConfig(moduleType: string, config: any): Promise<void> {
    return this.deviceAdminService.setGenericModuleConfig(moduleType, config);
  }

  /**
   * Set node owner (long name and short name)
   */
  async setNodeOwner(longName: string, shortName: string, isUnmessagable?: boolean, isLicensed?: boolean): Promise<void> {
    return this.deviceAdminService.setNodeOwner(longName, shortName, isUnmessagable, isLicensed);
  }

  /**
   * Begin edit settings transaction to batch configuration changes
   */
  async beginEditSettings(): Promise<void> {
    return this.deviceAdminService.beginEditSettings();
  }

  /**
   * Commit edit settings to persist configuration changes
   */
  async commitEditSettings(): Promise<void> {
    return this.deviceAdminService.commitEditSettings();
  }

  async getConnectionStatus(): Promise<{ connected: boolean; nodeResponsive: boolean; configuring: boolean; nodeIp: string; userDisconnected?: boolean }> {
    // Node is responsive if we have localNodeInfo (received MyNodeInfo from device)
    const nodeResponsive = this.localNodeInfo !== null;
    // Node is configuring if connected but initial config capture not complete
    const configuring = this.isConnected && !this.configCaptureComplete;
    logger.debug(`🔍 getConnectionStatus called: isConnected=${this.isConnected}, nodeResponsive=${nodeResponsive}, configuring=${configuring}, userDisconnected=${this.userDisconnectedState}`);
    return {
      connected: this.isConnected,
      nodeResponsive,
      configuring,
      nodeIp: (await this.getConfig()).nodeIp,
      userDisconnected: this.userDisconnectedState
    };
  }

  // Get node numbers that exist in the connected radio's local database
  getDeviceNodeNums(): number[] {
    return Array.from(this.deviceNodeNums);
  }

  /**
   * Detect channel moves/swaps after config sync and migrate messages + permissions.
   * Compares pre-config snapshot against current DB state to find channels that moved slots.
   * Called after configComplete when the device has finished sending its channel config. (#2425)
   */
  private async detectAndMigrateChannelChanges(): Promise<void> {
    if (this.preConfigChannelSnapshot.length === 0) return;

    try {
      const afterSnapshot = (await databaseService.channels.getAllChannels(this.sourceId))
        .map(ch => ({ id: ch.id, psk: ch.psk, name: ch.name }));

      // Detect moves by comparing PSK + name (both must match to confirm identity)
      const moves = detectChannelMoves(this.preConfigChannelSnapshot, afterSnapshot);

      // Detect new channels (no matching PSK+name in before snapshot)
      const newChannels: number[] = [];
      for (const newCh of afterSnapshot) {
        if (!newCh.psk || newCh.psk === '') continue;
        const existed = this.preConfigChannelSnapshot.find(ch =>
          ch.psk === newCh.psk && (ch.name || '') === (newCh.name || '')
        );
        if (!existed) {
          newChannels.push(newCh.id);
        }
      }

      if (moves.length === 0 && newChannels.length === 0) {
        logger.debug('📡 No channel changes detected on config sync');
        return;
      }

      logger.info(`📡 Channel changes detected on startup config sync:`);
      if (moves.length > 0) {
        logger.debug(`  Moves: ${moves.map(m => `slot ${m.from}→${m.to}`).join(', ')}`);
      }
      if (newChannels.length > 0) {
        logger.debug(`  New channels: slots ${newChannels.join(', ')}`);
      }

      // 1. Migrate messages for moved channels
      if (moves.length > 0) {
        try {
          await databaseService.messages.migrateMessagesForChannelMoves(moves);
          logger.info(`📦 Message migration complete for ${moves.length} channel move(s)`);
        } catch (error) {
          logger.error('📦 Failed to migrate messages on startup:', error);
        }
      }

      // 2. Migrate user permissions for moved channels
      if (moves.length > 0) {
        try {
          await databaseService.auth.migratePermissionsForChannelMoves(moves);
          logger.info(`🔑 Permission migration complete for ${moves.length} channel move(s)`);
        } catch (error) {
          logger.error('🔑 Failed to migrate permissions on startup:', error);
        }
      }

      // 3. Migrate automation channel references (auto-responder, timer, geofence triggers, auto-ack)
      if (moves.length > 0) {
        try {
          await migrateAutomationChannels(
            moves,
            (key) => databaseService.settings.getSetting(key),
            (key, value) => databaseService.settings.setSetting(key, value)
          );
        } catch (error) {
          logger.error('🔄 Failed to migrate automation channels on startup:', error);
        }
      }

      // 4. Set new/unknown channels to no permissions for non-admin users
      if (newChannels.length > 0) {
        logger.info(`🔑 New channels detected (${newChannels.join(', ')}) — non-admin users will have no access until granted`);
        // New channels naturally have no permissions since no permission rows exist
        // No action needed — absence of permission = no access
      }

      // 5. Audit log the changes
      try {
        const details: string[] = [];
        if (moves.length > 0) {
          details.push(`Channel moves: ${moves.map(m => `slot ${m.from}→${m.to}`).join(', ')}`);
          details.push(`Messages, permissions, and automations migrated`);
        }
        if (newChannels.length > 0) {
          details.push(`New channels on slots: ${newChannels.join(', ')} (default: no user permissions)`);
        }
        await databaseService.auditLogAsync(
          null, // system operation — no user context at startup
          'channel_migration_on_startup',
          'channels',
          details.join('. '),
          'system'
        );
      } catch (error) {
        logger.error('Failed to write audit log for channel migration:', error);
      }
    } catch (error) {
      logger.error('📡 Error detecting channel changes on startup:', error);
    } finally {
      this.preConfigChannelSnapshot = [];
    }
  }

  // Check if a node exists in the connected radio's local database
  isNodeInDeviceDb(nodeNum: number): boolean {
    return this.deviceNodeNums.has(nodeNum);
  }

  // ── Narrow accessors for NodeDbMaintenanceService (#3962 Phase 4.2a PR2 §4f) ──
  // These exist only to bridge previously-private state to the extracted
  // service without widening the fields themselves or touching the
  // protobuf-dispatch code that also reads/writes them.

  /** Bare `isConnected` flag — matches the pre-extraction `refreshNodeDatabase` guard. */
  isDeviceConnected(): boolean {
    return this.isConnected;
  }

  /** `isConnected && transport !== null` — matches the pre-extraction combined
   *  guard used by `purgeNodeDb`/`sendRemoveNode` before building an admin packet. */
  isTransportReady(): boolean {
    return this.isConnected && this.transport !== null;
  }

  /** Send a pre-built admin packet over the current transport (local, not remote-mesh). */
  async sendLocalAdminPacket(adminPacket: Uint8Array): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }
    await this.transport.send(adminPacket);
  }

  /** Drop a node from the connected radio's local-database tracking set. */
  removeDeviceNodeNum(nodeNum: number): void {
    this.deviceNodeNums.delete(nodeNum);
  }

  // ── Narrow accessor for AutoAnnounceService (#3962 Phase 4.2a PR3 §4b) ──
  // Bridges the private `rebootMergeInProgress` guard without widening the
  // field itself — same rationale as the NodeDbMaintenanceService block above.
  /** `true` while a post-reboot NodeDB merge is suppressing broadcasts. */
  isRebootMergeInProgress(): boolean {
    return this.rebootMergeInProgress;
  }

  // ── Narrow accessors for FavoritesService (#3962 Phase 4.2a PR4 §4c) ──
  // favoritesSupportCache/autoFavoritingNodes stay on the manager (pinned
  // tests reach into them directly — see favoritesService.ts's header
  // comment for the full rationale); these bridge them to the service
  // without widening the fields themselves.

  /** Read the version-keyed favorites-support cache. */
  getFavoritesSupportCache(): { version: string; result: boolean } | null {
    return this.favoritesSupportCache;
  }

  /** Write (or clear, with `null`) the favorites-support cache. */
  setFavoritesSupportCache(value: { version: string; result: boolean } | null): void {
    this.favoritesSupportCache = value;
  }

  /** Whether an auto-favorite operation is already in flight for this node. */
  isAutoFavoritingNode(nodeNum: number): boolean {
    return this.autoFavoritingNodes.has(nodeNum);
  }

  /** Mark a node as having an auto-favorite operation in flight. */
  addAutoFavoritingNode(nodeNum: number): void {
    this.autoFavoritingNodes.add(nodeNum);
  }

  /** Clear the in-flight marker for a node's auto-favorite operation. */
  removeAutoFavoritingNode(nodeNum: number): void {
    this.autoFavoritingNodes.delete(nodeNum);
  }

  // ── Narrow accessors for DeviceAdminService (#3962 Phase 4.2a PR5 §4e) ──
  // Bridge previously-private state without widening the fields themselves.

  /** `{nodeIp, tcpPort}` off the private `getConfig()` — all `buildDeviceConfigFromActual` needs from it. */
  async getConnectionAddress(): Promise<{ nodeIp: string; tcpPort: number }> {
    const config = await this.getConfig();
    return { nodeIp: config.nodeIp, tcpPort: config.tcpPort };
  }

  /**
   * Update cached module config section after a successful admin command.
   * Mirrors `updateCachedDeviceConfig` above but for `actualModuleConfig`.
   */
  updateCachedModuleConfig(section: string, values: Record<string, any>): void {
    if (!this.actualModuleConfig) {
      this.actualModuleConfig = {};
    }
    this.actualModuleConfig[section] = {
      ...this.actualModuleConfig[section],
      ...values
    };
  }

  // ── Narrow accessors for RemoteAdminService (#3962 Phase 4.2a PR5 §4e) ──
  // remoteNodeConfigs/remoteNodeChannels/remoteNodeOwners/remoteNodeDeviceMetadata/
  // pendingModuleConfigRequests/moduleConfigsEverFetched/actualModuleConfig stay
  // on the manager because protobuf dispatch (`processAdminMessage`, out of
  // scope per spec §10) writes them directly on packet receipt — the same
  // "written on one side, read on the other" split `adminTransactionService.ts`
  // documents for `pendingAdminAcks`. These bridge bidirectionally without
  // widening the fields themselves; several return the SAME live Map/entry
  // reference the manager holds (same trick the pre-existing
  // `getRemoteNodeConfig` accessor above already uses) so in-place mutation
  // (`.delete()`, nested-key `delete`) keeps working exactly as before.

  /** Record which module-config key a pending request (local or remote) should resolve to. */
  setPendingModuleConfigRequest(nodeNum: number, key: string): void {
    this.pendingModuleConfigRequests.set(nodeNum, key);
  }

  /** Live per-node remote-channel map (channelIndex → channel), or undefined if none cached yet. */
  getRemoteNodeChannelsMap(nodeNum: number): Map<number, any> | undefined {
    return this.remoteNodeChannels.get(nodeNum);
  }

  /** Live remote-node-owner cache (nodeNum → owner response). */
  getRemoteNodeOwnersMap(): Map<number, any> {
    return this.remoteNodeOwners;
  }

  /** Live remote-node-device-metadata cache (nodeNum → metadata response). */
  getRemoteNodeDeviceMetadataMap(): Map<number, any> {
    return this.remoteNodeDeviceMetadata;
  }

  /** Reset both module-config cache fields — matches the pre-extraction `resetModuleConfigCache` body. */
  resetModuleConfigState(): void {
    this.moduleConfigsEverFetched = false;
    this.actualModuleConfig = null;
  }

  /** Write the module-configs-ever-fetched flag. */
  setModuleConfigsEverFetched(value: boolean): void {
    this.moduleConfigsEverFetched = value;
  }

  // Async version that fetches uptimes in a single bulk query - works with all DB backends
  async getAllNodesAsync(sourceId?: string): Promise<DeviceInfo[]> {
    return this.nodeDbMaintenanceService.getAllNodesAsync(sourceId);
  }

  async getRecentMessages(limit: number = 50, sourceId?: string): Promise<MeshMessage[]> {
    // Exclude traceroute responses: the UI filters them out of message lists
    // anyway (they render from the `traceroutes` table), so including them
    // here only wastes slots in the fixed-size window and evicts real DMs
    // (issue #2741).
    const dbMessages = await databaseService.messages.getMessages(limit, 0, sourceId, [PortNum.TRACEROUTE_APP]);
    return dbMessages.map(msg => ({
      id: msg.id,
      from: msg.fromNodeId,
      to: msg.toNodeId,
      fromNodeId: msg.fromNodeId,
      toNodeId: msg.toNodeId,
      text: msg.text,
      channel: msg.channel,
      portnum: msg.portnum ?? undefined,
      timestamp: new Date(canonicalMessageTime(msg)),
      hopStart: msg.hopStart ?? undefined,
      hopLimit: msg.hopLimit ?? undefined,
      relayNode: msg.relayNode ?? undefined,
      replyId: msg.replyId ?? undefined,
      emoji: msg.emoji ?? undefined,
      viaMqtt: Boolean(msg.viaMqtt),
      rxSnr: msg.rxSnr ?? undefined,
      rxRssi: msg.rxRssi ?? undefined,
      // Include delivery tracking fields
      requestId: (msg as any).requestId,
      wantAck: Boolean((msg as any).wantAck),
      ackFailed: Boolean((msg as any).ackFailed),
      routingErrorReceived: Boolean((msg as any).routingErrorReceived),
      deliveryState: (msg as any).deliveryState,
      // Acknowledged status depends on message type and delivery state:
      // - DMs: only 'confirmed' counts (received by target)
      // - Channel messages: 'delivered' counts (transmitted to mesh)
      // - undefined/failed: not acknowledged
      acknowledged: msg.channel === -1
        ? ((msg as any).deliveryState === 'confirmed' ? true : undefined)
        : ((msg as any).deliveryState === 'delivered' || (msg as any).deliveryState === 'confirmed' ? true : undefined)
    }));
  }

  /**
   * Operator-initiated manual resync (#3122 follow-up).
   *
   * Sends a single want_config_id regardless of passive-mode staleness. Mostly
   * useful for passive-mode sources where the automatic reconnect path skips
   * resync while the cached config is "fresh" — the operator may know the node
   * config actually changed (e.g. a remote channel rekey) and want to refresh.
   *
   * Guards:
   *   * **single-flight** — only one resync in flight per source
   *   * **cooldown** — MANUAL_RESYNC_COOLDOWN_MS (30s) since last attempt
   *   * **watchdog** — MANUAL_RESYNC_WATCHDOG_MS (120s) max in-flight; if
   *     the stream never reaches configComplete, the flag self-clears so the
   *     button doesn't get stuck disabled
   *   * **recovery latch** — sets suppressNextAutoSync so a node-side close
   *     during/after the forced sync doesn't immediately re-trigger another
   *     full sync on reconnect (which would just reproduce the failure loop)
   *
   * Returns the post-call state — caller (HTTP route) can surface inFlight +
   * cooldownExpiresAt to the UI so the button renders the right state.
   */
  async requestManualResync(): Promise<{
    started: boolean;
    inFlight: boolean;
    cooldownExpiresAt: number;
    reason?: 'cooldown' | 'in-flight' | 'not-connected' | 'send-failed';
  }> {
    const now = Date.now();
    const cooldownExpiresAt =
      this.manualResyncLastAt !== null
        ? this.manualResyncLastAt + MeshtasticManager.MANUAL_RESYNC_COOLDOWN_MS
        : 0;

    if (this.manualResyncInFlight) {
      logger.debug('🟡 [manual-resync] Rejected — already in flight');
      return { started: false, inFlight: true, cooldownExpiresAt, reason: 'in-flight' };
    }
    if (now < cooldownExpiresAt) {
      logger.debug(`🟡 [manual-resync] Rejected — cooldown until ${new Date(cooldownExpiresAt).toISOString()}`);
      return { started: false, inFlight: false, cooldownExpiresAt, reason: 'cooldown' };
    }
    if (!this.isConnected) {
      logger.debug('🟡 [manual-resync] Rejected — not connected');
      return { started: false, inFlight: false, cooldownExpiresAt, reason: 'not-connected' };
    }

    logger.info('🟡 [manual-resync] Operator-initiated resync — sending want_config_id');

    // #3962 Phase 4.2b C2: MANUAL_RESYNC_REQUESTED — Connected -> ConfigSync
    // (origin=manual). Guards above are kept in the manager (task42b_spec.md
    // §5); the reducer covers only the state flip + capture-flag/watchdog
    // actions.
    const { next } = dispatch(this.#state, 'MANUAL_RESYNC_REQUESTED', this.buildSmContext());
    this.#state = next;

    this.manualResyncInFlight = true;
    this.manualResyncLastAt = now;
    // Latch the suppress flag BEFORE sending so a same-tick disconnect (which
    // can happen on a fragile node) is observed by handleDisconnected → reconnect
    // before this method returns. ('latchSuppressNext' action)
    this.suppressNextAutoSync = true;
    // Mark config capture as resuming so streamed FromRadio entries refresh
    // the cached snapshot rather than being dropped as "already complete".
    // ('startConfigCapture' action)
    this.startConfigCapture();

    // 'armResyncWatchdog' action: clear in-flight if the stream never lands.
    if (this.manualResyncWatchdog) clearTimeout(this.manualResyncWatchdog);
    this.manualResyncWatchdog = setTimeout(() => {
      if (this.manualResyncInFlight) {
        logger.warn(`⚠️ [manual-resync] Watchdog fired after ${MeshtasticManager.MANUAL_RESYNC_WATCHDOG_MS / 1000}s — clearing in-flight latch`);
        this.clearManualResyncInFlight('watchdog');
      }
    }, MeshtasticManager.MANUAL_RESYNC_WATCHDOG_MS);

    try {
      // 'sendWantConfig' action
      await this.sendWantConfigId();
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      logger.warn(`⚠️ [manual-resync] sendWantConfigId failed: ${msg}`);
      // Send-time failure means the request never reached the node. No
      // SmEvent models this path (task42b_spec.md §5: manual-resync guards
      // stay in the manager, not the reducer) — clean up the in-flight/
      // suppress latches directly so the operator can retry (subject to
      // cooldown). State and the capture flags are left exactly as
      // MANUAL_RESYNC_REQUESTED set them, matching pre-refactor behavior.
      this.clearManualResyncInFlight('send-failed');
      this.suppressNextAutoSync = false;
      return { started: false, inFlight: false, cooldownExpiresAt: now + MeshtasticManager.MANUAL_RESYNC_COOLDOWN_MS, reason: 'send-failed' };
    }

    this.assertStateConsistent();
    return {
      started: true,
      inFlight: true,
      cooldownExpiresAt: now + MeshtasticManager.MANUAL_RESYNC_COOLDOWN_MS,
    };
  }

  /**
   * Returns a serializable snapshot of manual-resync state for the HTTP layer.
   * Surfaced to the UI so the Resync button can render disabled/enabled state
   * and a countdown until the cooldown expires.
   */
  getManualResyncState(): { inFlight: boolean; cooldownExpiresAt: number } {
    const cooldownExpiresAt =
      this.manualResyncLastAt !== null
        ? this.manualResyncLastAt + MeshtasticManager.MANUAL_RESYNC_COOLDOWN_MS
        : 0;
    return { inFlight: this.manualResyncInFlight, cooldownExpiresAt };
  }

  /**
   * Idempotent helper used by configComplete + recovery + watchdog + send-failed
   * paths. Always cancels the outstanding watchdog so a stale timer can't fire
   * later and flip the latch back off after a new resync started.
   */
  private clearManualResyncInFlight(_reason: 'configComplete' | 'recovery' | 'watchdog' | 'send-failed'): void {
    this.manualResyncInFlight = false;
    if (this.manualResyncWatchdog) {
      clearTimeout(this.manualResyncWatchdog);
      this.manualResyncWatchdog = null;
    }
  }

  /**
   * Resolve the effective passive-resync staleness window for this source.
   *
   * Returns the per-source `passiveResyncStaleMs` override when it lies within
   * [MIN, MAX] bounds; otherwise falls back to the class default. Bounds-
   * checking prevents foot-guns from a value like 0 (would resync on every
   * flap) or a value so large it disables resync entirely. The route layer
   * also validates input, but this is the authoritative gate.
   */
  private effectivePassiveResyncStaleMs(): number {
    const override = this.passiveResyncStaleMs;
    if (
      typeof override === 'number' &&
      Number.isFinite(override) &&
      override >= MeshtasticManager.PASSIVE_RESYNC_STALE_MIN_MS &&
      override <= MeshtasticManager.PASSIVE_RESYNC_STALE_MAX_MS
    ) {
      return override;
    }
    return MeshtasticManager.PASSIVE_RESYNC_STALE_MS;
  }

  // Public method to trigger manual refresh of node database
  async refreshNodeDatabase(): Promise<void> {
    return this.nodeDbMaintenanceService.refreshNodeDatabase();
  }

  /**
   * User-initiated disconnect from the node
   * Prevents auto-reconnection until userReconnect() is called
   */
  async userDisconnect(): Promise<void> {
    logger.debug('🔌 User-initiated disconnect requested');

    // #3962 Phase 4.2b C2: USER_DISCONNECT — any -> UserDisconnected.
    // Capture flags are left untouched (terminal transition, matches the
    // pre-refactor L1854/L12949 behavior — task42b_spec.md §3.2).
    const { next } = dispatch(this.#state, 'USER_DISCONNECT', this.buildSmContext());
    this.#state = next;

    // Notify about disconnect before actually disconnecting
    // This ensures users get notified even for user-initiated disconnects
    // ('notifyDisconnected' action)
    await serverEventNotificationService.notifyNodeDisconnected(this.sourceId, await this.getSourceName());

    // 'disconnectTransport' action
    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch (error) {
        logger.error('Error disconnecting transport:', error);
      }
    }

    // 'stopSchedulers' action (below, through the cron-job clear)
    // Clear any active intervals and pending jitter timeouts
    if (this.tracerouteJitterTimeout) {
      clearTimeout(this.tracerouteJitterTimeout);
      this.tracerouteJitterTimeout = null;
    }

    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
    }

    if (this.remoteLocalStatsJitterTimeout) {
      clearTimeout(this.remoteLocalStatsJitterTimeout);
      this.remoteLocalStatsJitterTimeout = null;
    }

    if (this.remoteLocalStatsInterval) {
      clearInterval(this.remoteLocalStatsInterval);
      this.remoteLocalStatsInterval = null;
    }

    this.distanceDeleteScheduler?.stop();

    if (this.remoteAdminScannerInterval) {
      clearInterval(this.remoteAdminScannerInterval);
      this.remoteAdminScannerInterval = null;
    }

    if (this.timeSyncInterval) {
      clearInterval(this.timeSyncInterval);
      this.timeSyncInterval = null;
    }

    // Stop announce scheduler if active (idempotent — no-op if not armed)
    this.autoAnnounceService.stop();

    // Stop all timer cron jobs
    this.timerCronJobs.forEach((job, id) => {
      job.stop();
      logger.debug(`⏱️ Stopped timer cron job: ${id}`);
    });
    this.timerCronJobs.clear();

    // Cancel any pending config-complete fallback timer (#3962 Phase 4.2b C2
    // leak fix) — an operator disconnect mid-ConfigSync must not leave one
    // armed.
    this.cancelConfigCompleteFallbackTimer();
    this.assertStateConsistent();
    logger.debug('✅ User disconnect completed');
  }

  /**
   * User-initiated reconnect to the node
   * Clears the user disconnect state and attempts to reconnect
   */
  async userReconnect(): Promise<boolean> {
    logger.debug('🔌 User-initiated reconnect requested');

    // #3962 Phase 4.2b C2: USER_RECONNECT — UserDisconnected -> Connecting.
    // The 'connectTransport' action is the `this.connect()` call immediately
    // below — not executed via a generic loop since it's the method's own
    // control flow/return value, not a fire-and-forget side effect.
    const { next } = dispatch(this.#state, 'USER_RECONNECT', this.buildSmContext());
    this.#state = next;
    this.assertStateConsistent();

    try {
      const success = await this.connect();
      if (success) {
        logger.debug('✅ User reconnect successful');
      } else {
        logger.debug('⚠️ User reconnect failed');
      }
      return success;
    } catch (error) {
      logger.error('❌ User reconnect error:', error);
      return false;
    }
  }

  /**
   * Check if currently in user-disconnected state
   */
  isUserDisconnected(): boolean {
    return this.userDisconnectedState;
  }

  // ============================================================
  // Link Quality Management
  // ============================================================

  /**
   * Get or initialize link quality for a node.
   * Initial LQ = 8 - hops (clamped to 1-7 based on initial hop count)
   * Range: 0 (dead) to 10 (excellent)
   */
  private getNodeLinkQuality(nodeNum: number, currentHops: number): { quality: number; lastHops: number } {
    let lqData = this.nodeLinkQuality.get(nodeNum);

    if (!lqData) {
      // Initialize: LQ = INITIAL_BASE - hops (so 1-hop = 7, 7-hop = 1)
      const initialQuality = Math.max(1, Math.min(LINK_QUALITY.INITIAL_BASE - 1, LINK_QUALITY.INITIAL_BASE - currentHops));
      lqData = { quality: initialQuality, lastHops: currentHops };
      this.nodeLinkQuality.set(nodeNum, lqData);

      // Store initial LQ as telemetry
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      this.storeLinkQualityTelemetry(nodeNum, nodeId, initialQuality).catch(err => logger.error('Error storing link quality telemetry:', err));

      logger.debug(`📊 Link Quality initialized for ${nodeId}: ${initialQuality} (${currentHops} hops)`);
    }

    return lqData;
  }

  /**
   * Update link quality for a node based on an event.
   * Clamps result to MIN-MAX range (0-10).
   */
  private updateLinkQuality(nodeNum: number, adjustment: number, reason: string): void {
    const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
    let lqData = this.nodeLinkQuality.get(nodeNum);

    if (!lqData) {
      // Initialize with default if not exists
      lqData = { quality: LINK_QUALITY.DEFAULT_QUALITY, lastHops: LINK_QUALITY.DEFAULT_HOPS };
      this.nodeLinkQuality.set(nodeNum, lqData);
    }

    const oldQuality = lqData.quality;
    lqData.quality = Math.max(LINK_QUALITY.MIN, Math.min(LINK_QUALITY.MAX, lqData.quality + adjustment));

    if (lqData.quality !== oldQuality) {
      this.nodeLinkQuality.set(nodeNum, lqData);
      this.storeLinkQualityTelemetry(nodeNum, nodeId, lqData.quality).catch(err => logger.error('Error storing link quality telemetry:', err));
      logger.debug(`📊 Link Quality for ${nodeId}: ${oldQuality} -> ${lqData.quality} (${adjustment >= 0 ? '+' : ''}${adjustment}, ${reason})`);
    }
  }

  /**
   * Update link quality based on message hop count comparison.
   * - If hops <= previous: STABLE_MESSAGE_BONUS (+1)
   * - If hops = previous + 1: no change
   * - If hops >= previous + 2: DEGRADED_PATH_PENALTY (-1)
   */
  private updateLinkQualityForMessage(nodeNum: number, currentHops: number): void {
    const lqData = this.getNodeLinkQuality(nodeNum, currentHops);
    const hopDiff = currentHops - lqData.lastHops;

    // Update lastHops for next comparison
    lqData.lastHops = currentHops;
    this.nodeLinkQuality.set(nodeNum, lqData);

    if (hopDiff <= 0) {
      // Stable or improved
      this.updateLinkQuality(nodeNum, LINK_QUALITY.STABLE_MESSAGE_BONUS, `stable message (${currentHops} hops)`);
    } else if (hopDiff === 1) {
      // Increased by 1 - no change
      logger.debug(`📊 Link Quality unchanged for node ${nodeNum.toString(16)}: hops increased by 1`);
    } else {
      // Increased by 2 or more
      this.updateLinkQuality(nodeNum, LINK_QUALITY.DEGRADED_PATH_PENALTY, `degraded path (+${hopDiff} hops)`);
    }
  }

  /**
   * Store link quality as telemetry for graphing.
   */
  private async storeLinkQualityTelemetry(nodeNum: number, nodeId: string, quality: number): Promise<void> {
    await databaseService.telemetry.insertTelemetry({
      nodeId: nodeId,
      nodeNum: nodeNum,
      telemetryType: 'linkQuality',
      timestamp: Date.now(),
      value: quality,
      unit: 'quality',
      createdAt: Date.now(),
    }, this.sourceId);
  }

  /**
   * Handle failed traceroute - penalize link quality.
   * Penalty: TRACEROUTE_FAIL_PENALTY (-2)
   */
  private handleTracerouteFailure(nodeNum: number): void {
    this.updateLinkQuality(nodeNum, LINK_QUALITY.TRACEROUTE_FAIL_PENALTY, 'failed traceroute');
  }

  /**
   * Handle PKI error - penalize link quality.
   * Penalty: PKI_ERROR_PENALTY (-5)
   */
  private handlePkiError(nodeNum: number): void {
    this.updateLinkQuality(nodeNum, LINK_QUALITY.PKI_ERROR_PENALTY, 'PKI error');
  }

  /**
   * Check for timed-out traceroutes and penalize link quality.
   * Timeout: TRACEROUTE_TIMEOUT_MS (5 minutes)
   * Called periodically from the traceroute scheduler.
   */
  private checkTracerouteTimeouts(): void {
    const now = Date.now();

    for (const [nodeNum, timestamp] of this.pendingTracerouteTimestamps.entries()) {
      if (now - timestamp > LINK_QUALITY.TRACEROUTE_TIMEOUT_MS) {
        // Traceroute timed out
        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
        logger.debug(`🗺️ Auto-traceroute to ${nodeId} timed out after 5 minutes`);

        // Mark as failed in database
        databaseService.updateAutoTracerouteResultByNodeAsync(nodeNum, false)
          .catch(err => logger.error('Failed to update auto-traceroute result:', err));

        // Clean up tracking
        this.pendingAutoTraceroutes.delete(nodeNum);
        this.pendingTracerouteTimestamps.delete(nodeNum);

        // Penalize link quality for failed traceroute (-2)
        this.handleTracerouteFailure(nodeNum);
      }
    }
  }
}

// Export the class for testing purposes (allows creating isolated test instances)
export { MeshtasticManager };

/**
 * Eager fallback instance. Used ONLY when no meshtastic_tcp source is registered
 * in the sourceManagerRegistry (S4: env-IP-only fallback connect, or early module
 * access before bootstrapSources runs). Never added to the registry itself.
 *
 * Exported so server.ts can pass the concrete instance as `deps.fallbackManager`
 * to bootstrapSources for the S4 env-IP fallback connect path.
 * WP3: no longer registered as the primary; all tcp sources use makeMeshtastic().
 */
export const fallbackManager = new MeshtasticManager();