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
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { compileAutoAckRegex } from './utils/autoAckRegex.js';
import { scheduleCron, validateCron, type CronJob } from './utils/cronScheduler.js';
import { replaceMeshCoreAnnounceTokens } from './utils/meshcoreAnnounceTokens.js';
import { runScript, type RunScriptResult } from './utils/scriptRunner.js';
import { MeshCoreNativeBackend, type BridgeShapedEvent } from './meshcoreNativeBackend.js';

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
export interface MeshCoreAutoResponderTrigger {
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
}

/**
 * Operator-defined timer trigger persisted (per source) as a JSON array
 * at the `meshcoreTimerTriggers` setting key. One scheduler entry per
 * row; the runner reads the row by id at fire time so a freshly-saved
 * template applies on the next tick.
 */
export interface MeshCoreTimerTrigger {
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

export interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  /** Display name parsed from the message body (channel messages only — MeshCore
   *  channel packets carry no per-sender identity; the sender prefixes their name). */
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
 * MeshCore Manager class
 * Handles connection and communication with MeshCore devices
 */
class MeshCoreManager extends EventEmitter {
  /**
   * The owning source this manager belongs to. Every write the manager
   * performs into `meshcore_nodes` / `meshcore_messages` is stamped with
   * this id. Required since slice 1 of the multi-source MeshCore refactor
   * (migration 056).
   */
  public readonly sourceId: string;

  private config: MeshCoreConfig | null = null;
  private connected: boolean = false;
  private deviceType: MeshCoreDeviceType = MeshCoreDeviceType.UNKNOWN;

  // Repeater: direct serial
  private serialPort: InstanceType<typeof import('serialport').SerialPort> | null = null;
  private parser: InstanceType<typeof import('@serialport/parser-readline').ReadlineParser> | null = null;

  // Companion: native JS backend (meshcore.js). sendBridgeCommand delegates here.
  private nativeBackend: MeshCoreNativeBackend | null = null;

  // Heartbeat / auto-reconnect state (native-backend only).
  private connectionState: MeshCoreConnectionState = 'disconnected';
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatConsecutiveFailures: number = 0;

  /** Coalescing state for `contact_path_updated` pushes. Multiple pushes
   *  within {@link PATH_REFRESH_DEBOUNCE_MS} collapse to a single
   *  refreshContacts() call so a chatty contact churning its route doesn't
   *  thunder the device. The set tracks which pubkeys had pushes during
   *  the window — purely for logging; the refresh fetches everything. */
  private pathRefreshTimer: NodeJS.Timeout | null = null;
  private pathRefreshPendingKeys: Set<string> = new Set();
  private heartbeatLastSuccessAt: number | null = null;
  private heartbeatProbeInFlight: boolean = false;
  private reconnectAttempts: number = 0;
  private nextReconnectAt: number | null = null;
  private shouldReconnect: boolean = false;

  // Shared state
  private localNode: MeshCoreNode | null = null;
  private contacts: Map<string, MeshCoreContact> = new Map();
  private messages: MeshCoreMessage[] = [];
  private pendingCommands: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();
  private commandId: number = 0;

  // Message limit to prevent unbounded growth
  private static readonly MAX_MESSAGES = 1000;

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

  // Auto-announce scheduler state. One of these holds the recurring
  // trigger: cron job when useSchedule=true, setInterval handle when
  // running on a plain hour interval. lastRunAt is exposed to the UI so
  // operators can confirm the scheduler is actually firing.
  private autoAnnounceTimer: NodeJS.Timeout | null = null;
  private autoAnnounceCron: CronJob | null = null;
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

  constructor(sourceId: string) {
    super();
    if (!sourceId) {
      throw new Error('MeshCoreManager requires a sourceId');
    }
    this.sourceId = sourceId;
    logger.info(`[MeshCore:${sourceId}] Manager initialized`);
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
      }));
    } catch (loadErr) {
      logger.warn(`[MeshCore:${this.sourceId}] Failed to load messages from DB: ${(loadErr as Error).message}`);
      this.messages = [];
    }

    logger.info(`[MeshCore] Connecting via ${this.config.connectionType}...`);
    this.connectionState = 'connecting';

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
      this.connectionState = 'connected';
      this.heartbeatConsecutiveFailures = 0;
      this.reconnectAttempts = 0;
      this.nextReconnectAt = null;
      this.emit('connected', this.localNode);
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
      return false;
    }
  }

  /**
   * Disconnect from the device
   */
  async disconnect(): Promise<void> {
    logger.info('[MeshCore] Disconnecting...');

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

    // Cancel any pending path-refresh — refreshContacts() against a torn-
    // down connection would just log an error.
    this.clearPathRefreshTimer();

    // Stop auto-pathfinding scheduler.
    this.stopAutoPathfinding();

    // Stop auto-announce + timer-trigger schedulers.
    this.stopAutoAnnounce();
    this.stopTimerTriggers();

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

    this.nativeBackend = new MeshCoreNativeBackend(this.sourceId, backendConfig);

    // Native backend emits bridge-shaped push events; route them through
    // the manager's existing event handler.
    this.nativeBackend.on('event', (evt: BridgeShapedEvent) => {
      this.handleBridgeEvent(evt);
    });

    this.nativeBackend.on('disconnected', () => {
      logger.warn(`[MeshCore:${this.sourceId}] Native backend reported disconnect`);
    });

    logger.info(`[MeshCore:${this.sourceId}] Starting native backend (meshcore.js)`);
    await this.nativeBackend.connect();
    logger.info(`[MeshCore:${this.sourceId}] Native backend ready`);
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
      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: data.pubkey_prefix,
        toPublicKey: this.localNode?.publicKey || 'local',
        text: data.text,
        timestamp: data.sender_timestamp ? data.sender_timestamp * 1000 : Date.now(),
        snr: data.snr,
        sourceId: this.sourceId,
      };
      this.addMessage(message);
      this.emit('message', message);
      dataEventEmitter.emitMeshCoreMessage(message, this.sourceId);
      logger.info(`[MeshCore:${this.sourceId}] Contact message from ${data.pubkey_prefix}: ${data.text}`);
      // Prefer the per-packet relay-hash chain recovered from LogRxData
      // (the actual hops THIS packet traversed). Fall back to the
      // sender contact's cached outPath if the native backend didn't
      // surface a LogRxData event for this packet (e.g. mid-buffer race
      // or a backend that doesn't subscribe to raw logging).
      const hopCount = decodePathLenHopCount(data.path_len);
      const senderContact = this.resolveContactByPrefix(data.pubkey_prefix);
      const route = formatPathHops(data.path_hops) || senderContact?.outPath || null;
      void this.checkAutoAcknowledge(message, true, undefined, hopCount, route);
      void this.checkAutoResponder(message, true, undefined);
    } else if (event_type === 'channel_message') {
      // MeshCore channel packets have no sender field on the wire — the sender's
      // device prefixes "Name: " onto the text body. Split it out so the UI can
      // show the sender and the body separately.
      const rawText: string = data.text ?? '';
      const prefixMatch = rawText.match(/^([^:\n]{1,32}):\s*(.*)$/s);
      const fromName = prefixMatch ? prefixMatch[1].trim() : undefined;
      const body = prefixMatch ? prefixMatch[2] : rawText;
      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: MeshCoreManager.channelPublicKey(data.channel_idx),
        fromName,
        text: body,
        timestamp: data.sender_timestamp ? data.sender_timestamp * 1000 : Date.now(),
        snr: data.snr,
        sourceId: this.sourceId,
      };
      this.addMessage(message);
      this.emit('message', message);
      dataEventEmitter.emitMeshCoreMessage(message, this.sourceId);
      logger.info(`[MeshCore] Channel ${data.channel_idx} message: ${data.text}`);
      // Channel messages carry no sender pubkey on the wire, so there
      // is no contact outPath fallback for {ROUTE}. The LogRxData
      // path_hops (when present) is the only source of relay identities.
      const hopCount = decodePathLenHopCount(data.path_len);
      const route = formatPathHops(data.path_hops);
      void this.checkAutoAcknowledge(message, false, data.channel_idx, hopCount, route);
      void this.checkAutoResponder(message, false, data.channel_idx);
    } else if (event_type === 'room_message') {
      // Room server post (TXT_TYPE_SIGNED_PLAIN). The room's pubkey prefix
      // identifies which room, and the author prefix identifies the poster.
      const roomPubkeyPrefix: string = data.room_pubkey_prefix;
      const authorPrefixHex: string = data.author_pubkey_prefix;

      const roomContact = this.resolveContactByPrefix(roomPubkeyPrefix);
      const roomFullKey = roomContact?.publicKey ?? roomPubkeyPrefix;
      const authorContact = this.resolveContactByPrefix(authorPrefixHex);
      const authorName = authorContact?.advName ?? authorContact?.name ?? undefined;

      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        fromPublicKey: authorPrefixHex,
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
      logger.info(`[MeshCore:${this.sourceId}] Room post from ${authorPrefixHex} in room ${roomPubkeyPrefix}: ${data.text.substring(0, 50)}`);
    } else if (event_type === 'contact_advertised' || event_type === 'contact_added') {
      const publicKey: string = data.public_key;
      if (publicKey) {
        const existing = this.contacts.get(publicKey) ?? { publicKey };
        const updated: MeshCoreContact = {
          ...existing,
          publicKey,
          advName: data.adv_name ?? existing.advName,
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
        logger.info(`[MeshCore] ${event_type} for ${publicKey} (${data.adv_name ?? ''})`);
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
        logger.info(`[MeshCore] contact_path_updated for ${publicKey} (refresh scheduled)`);
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
      logger.info(
        `[MeshCore] Path discovery response for ${contact.publicKey.substring(0, 16)}…: ` +
        `out=${outHops} hops [${outPathFormatted}], in=${inHops} hops [${formatPathHex(inPathHex, data.in_hash_size ?? 1)}]`,
      );
    } else {
      logger.debug(`[MeshCore] Unknown push event: ${event_type}`);
    }
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
      await databaseService.meshcore.upsertNode(
        {
          publicKey: contact.publicKey,
          name: contact.advName ?? contact.name ?? null,
          advType: contact.advType ?? null,
          latitude: contact.latitude ?? null,
          longitude: contact.longitude ?? null,
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
   */
  async setChannel(idx: number, name: string, secretHex: string): Promise<void> {
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
      logger.info(`[MeshCore] Message from ${match[1].substring(0, 8)}...: ${match[2]}`);
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
   * Sanitize name input
   */
  private sanitizeName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9\s\-_]/g, '').substring(0, 32);
    if (sanitized.length === 0) {
      throw new Error('Invalid name: must contain alphanumeric characters');
    }
    return sanitized;
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
      logger.info(
        `[MeshCore:${this.sourceId}] Refreshing contacts after ${pending.length} path-update push(es)`,
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
      if (response.success && Array.isArray(response.data)) {
        this.contacts.clear();
        for (const c of response.data) {
          this.contacts.set(c.public_key, {
            publicKey: c.public_key,
            advName: c.adv_name,
            name: c.name,
            rssi: c.rssi,
            snr: c.snr,
            advType: c.adv_type,
            latitude: c.latitude,
            longitude: c.longitude,
            lastSeen: Date.now(),
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
        logger.info(`[MeshCore] Refreshed ${this.contacts.size} contacts`);
      }
    } catch (error) {
      logger.error('[MeshCore] Failed to refresh contacts:', error);
    }

    return this.contacts;
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
  async sendMessage(text: string, toPublicKey?: string, channelIdx?: number): Promise<boolean> {
    if (!this.connected) {
      logger.error('[MeshCore] Not connected');
      return false;
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      logger.warn('[MeshCore] Repeaters cannot send messages');
      return false;
    }

    try {
      const isChannelSend = !toPublicKey && channelIdx !== undefined;
      const response = await this.sendBridgeCommand('send_message', {
        text,
        to: toPublicKey || null,
        channel_idx: isChannelSend ? channelIdx : undefined,
      });

      if (response.success) {
        const ackCrc: number | null = response.data?.expectedAckCrc ?? null;
        const estTimeout: number | null = response.data?.estTimeout ?? null;
        logger.info(`[MeshCore] Message sent: ${text.substring(0, 50)}... (ackCrc=${ackCrc}, estTimeout=${estTimeout})`);

        const sentToPublicKey = isChannelSend
          ? MeshCoreManager.channelPublicKey(channelIdx!)
          : (toPublicKey || undefined);

        const msgId = `sent-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        const sentMessage: MeshCoreMessage = {
          id: msgId,
          fromPublicKey: this.localNode?.publicKey || 'local',
          toPublicKey: sentToPublicKey,
          text: text,
          timestamp: Date.now(),
          sourceId: this.sourceId,
          expectedAckCrc: ackCrc ?? undefined,
          estTimeout: estTimeout ?? undefined,
        };
        this.addMessage(sentMessage);
        this.emit('message', sentMessage);
        dataEventEmitter.emitMeshCoreMessage(sentMessage, this.sourceId);

        return true;
      } else {
        logger.error('[MeshCore] Send failed:', response.error);
        return false;
      }
    } catch (error) {
      logger.error('[MeshCore] Failed to send message:', error);
      return false;
    }
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
        logger.info('[MeshCore] Advert sent (Repeater)');
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to send advert:', error);
        return false;
      }
    } else {
      try {
        const response = await this.sendBridgeCommand('send_advert', {});
        if (response.success) {
          logger.info('[MeshCore] Advert sent (Companion)');
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
      logger.info(`[MeshCore] Reset path for ${publicKey.substring(0, 16)}…`);
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
      logger.info(`[MeshCore] Path discovery sent for ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] discoverContactPath threw:', error);
      return false;
    }
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
    const pathBytes = Uint8Array.from(
      contact.outPath.split(',').map((h) => parseInt(h, 16)),
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
      logger.info(`[MeshCore] Trace path to ${publicKey.substring(0, 16)}…: ${hops.length} hops, lastSnr=${lastSnr}`);
      return { hops, lastSnr };
    } catch (error) {
      logger.error('[MeshCore] traceContactPath threw:', error);
      return null;
    }
  }

  /**
   * Broadcast the device's saved advert for a contact as a zero-hop frame
   * so nearby nodes can add this contact themselves. Wraps the firmware's
   * CMD_SHARE_CONTACT; the device only retransmits — no local state is
   * mutated, so this method does not touch contacts or meshcore_nodes.
   *
   * Returns `true` on success, `false` if the device rejected the request
   * (unknown contact, transient backend error) or this isn't a Companion.
   */
  async shareContact(publicKey: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Share-contact requires Companion firmware');
      return false;
    }
    if (!this.connected) {
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('share_contact', { public_key: publicKey });
      if (!response.success) {
        logger.warn(`[MeshCore] share_contact failed for ${publicKey}: ${response.error}`);
        return false;
      }
      logger.info(`[MeshCore] Shared contact ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] shareContact threw:', error);
      return false;
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
  async setContactOutPath(publicKey: string, outPathBytes: Uint8Array): Promise<boolean> {
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
    try {
      const response = await this.sendBridgeCommand('set_out_path', {
        public_key: publicKey,
        out_path: outPathBytes,
      });
      if (!response.success) {
        logger.warn(`[MeshCore] set_out_path failed for ${publicKey}: ${response.error}`);
        return false;
      }
      const hex = Array.from(outPathBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(',');
      const existing = this.contacts.get(publicKey);
      if (existing) {
        const updated: MeshCoreContact = {
          ...existing,
          outPath: hex,
          pathLen: outPathBytes.length,
          lastSeen: Date.now(),
        };
        this.contacts.set(publicKey, updated);
        void this.persistContact(updated);
        this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
        dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
      }
      logger.info(`[MeshCore] Set out_path (${outPathBytes.length} hops) for ${publicKey.substring(0, 16)}…`);
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
      try {
        await databaseService.meshcore.deleteNode(publicKey, this.sourceId);
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] deleteNode after remove_contact failed: ${(err as Error).message}`);
      }
      this.emit('contact_removed', { sourceId: this.sourceId, publicKey });
      dataEventEmitter.emitMeshCoreContactUpdated({ publicKey, removed: true } as any, this.sourceId);
      logger.info(`[MeshCore] Removed contact ${publicKey.substring(0, 16)}…`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] removeContact threw:', error);
      return false;
    }
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
      logger.info(`[MeshCore] Exported contact ${publicKey ? publicKey.substring(0, 16) + '…' : '(self)'} (${bytes.length}B)`);
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
      logger.info(`[MeshCore] Imported contact (${advertBytes.length}B advert)`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] importContact threw:', error);
      return false;
    }
  }

  /**
   * Sync the device's RTC to the server's clock. Companion only.
   */
  async syncDeviceTime(): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Sync-device-time requires Companion firmware');
      return false;
    }
    if (!this.connected) return false;
    try {
      const response = await this.sendBridgeCommand('set_device_time', {});
      if (!response.success) {
        logger.warn(`[MeshCore] set_device_time failed: ${response.error}`);
        return false;
      }
      logger.info(`[MeshCore:${this.sourceId}] Device time synced to server clock`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] syncDeviceTime threw:', error);
      return false;
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
      logger.info(`[MeshCore:${this.sourceId}] Reboot command sent`);
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
      logger.info(`[MeshCore:${this.sourceId}] Private key exported`);
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
    if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
      logger.warn('[MeshCore] importPrivateKey: invalid key format');
      return false;
    }
    try {
      const response = await this.sendBridgeCommand('import_private_key', { private_key: hexKey });
      if (!response.success) {
        logger.warn(`[MeshCore] import_private_key failed: ${response.error}`);
        return false;
      }
      logger.info(`[MeshCore:${this.sourceId}] Private key imported — device identity changed`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] importPrivateKey threw:', error);
      return false;
    }
  }

  /**
   * Login to a remote node for admin access
   */
  async loginToNode(publicKey: string, password: string): Promise<boolean> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      logger.warn('[MeshCore] Admin login requires Companion firmware');
      return false;
    }

    try {
      const response = await this.sendBridgeCommand('login', {
        public_key: publicKey,
        password: password,
      });

      if (response.success) {
        logger.info(`[MeshCore] Logged into node ${publicKey.substring(0, 8)}...`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('[MeshCore] Login failed:', error);
      return false;
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
    const ok = await this.loginToNode(publicKey, '');
    if (ok) {
      this.guestLoggedInNodes.add(publicKey);
    }
    return ok;
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
      await this.ensureGuestLogin(sanitizedTargetKey);
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
    const trimmed = command.trim();
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

      void this.sendBridgeCommand('send_cli', { public_key: fullKey, text: command }, timeoutMs)
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
      const reply = await this.sendRepeaterCommand(trimmed, timeoutMs);
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
      // on a back-to-back retry.
      const response = await this.sendBridgeCommand('request_telemetry', params, 45_000);
      if (!response.success) {
        logger.warn(
          `[MeshCore:${this.sourceId}] requestRemoteTelemetry(${publicKey.substring(0, 16)}…) failed: ${response.error}`,
        );
        return null;
      }
      this.recordMeshTx();
      const data = response.data;
      const records = Array.isArray(data?.records) ? (data.records as MeshCoreTelemetryRecord[]) : [];
      return records;
    } catch (error) {
      logger.warn(
        `[MeshCore:${this.sourceId}] requestRemoteTelemetry(${publicKey.substring(0, 16)}…) threw:`,
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
   * Source-registry-compatible status snapshot. Lets `/api/sources/:id/status`
   * report meshcore sources via the same shape Meshtastic managers return,
   * even though MeshCoreManager isn't registered in `sourceManagerRegistry`.
   */
  getStatus(sourceName: string): {
    sourceId: string;
    sourceName: string;
    sourceType: 'meshcore';
    connected: boolean;
  } {
    return {
      sourceId: this.sourceId,
      sourceName,
      sourceType: 'meshcore',
      connected: this.connected,
    };
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

  getAllNodes(): MeshCoreNode[] {
    const nodes: MeshCoreNode[] = [];

    if (this.localNode) {
      nodes.push(this.localNode);
    }

    for (const contact of this.contacts.values()) {
      nodes.push({
        publicKey: contact.publicKey,
        name: contact.advName || contact.name || 'Unknown',
        advType: contact.advType || MeshCoreDeviceType.UNKNOWN,
        lastHeard: contact.lastSeen,
        rssi: contact.rssi,
        snr: contact.snr,
        latitude: contact.latitude,
        longitude: contact.longitude,
      });
    }

    return nodes;
  }

  getRecentMessages(limit: number = 50): MeshCoreMessage[] {
    return this.messages.slice(-limit);
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
   * the native backend is in use. Idempotent: if interval is 0 or a timer
   * is already running, it's a no-op.
   */
  private startHeartbeat(): void {
    const intervalSecs = this.config?.heartbeatIntervalSeconds ?? 0;
    if (intervalSecs <= 0) {
      // Heartbeat disabled — preserves prior behaviour.
      return;
    }
    if (this.heartbeatTimer) return;
    this.shouldReconnect = true;
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeatProbe().catch((err) => {
        logger.warn(`[MeshCore:${this.sourceId}] heartbeat probe threw: ${(err as Error).message}`);
      });
    }, intervalSecs * 1000);
    logger.info(`[MeshCore:${this.sourceId}] Heartbeat started (every ${intervalSecs}s)`);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatProbeInFlight = false;
  }

  private async runHeartbeatProbe(): Promise<void> {
    if (this.heartbeatProbeInFlight) return;
    if (this.connectionState !== 'connected') return;
    if (!this.nativeBackend) return;

    this.heartbeatProbeInFlight = true;
    const timeoutMs = this.config?.heartbeatTimeoutMs ?? 5000;
    const probeStartedAt = Date.now();
    try {
      const response = await this.nativeBackend.sendCommand('get_device_time', {}, timeoutMs);
      // Probe arrived after a teardown — drop the result.
      if (this.connectionState !== 'connected') return;

      if (response.success) {
        const latencyMs = Date.now() - probeStartedAt;
        this.heartbeatConsecutiveFailures = 0;
        this.heartbeatLastSuccessAt = Date.now();
        this.emit('heartbeat_ok', { sourceId: this.sourceId, latencyMs });
      } else {
        this.recordHeartbeatFailure(new Error(response.error ?? 'probe failed'));
      }
    } catch (err) {
      if (this.connectionState !== 'connected') return;
      this.recordHeartbeatFailure(err as Error);
    } finally {
      this.heartbeatProbeInFlight = false;
    }
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
   * Tear down the transport without clearing `shouldReconnect`. Mirrors the
   * relevant half of `disconnect()` but preserves reconnect intent.
   */
  private async teardownTransportOnly(): Promise<void> {
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
    logger.info(`[MeshCore:${this.sourceId}] Reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

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

      const companions = pathDiscoveryEnabled
        ? contacts.filter(c => c.advType === MeshCoreDeviceType.COMPANION)
        : [];
      const repeaters = neighborsEnabled
        ? contacts.filter(c => c.advType === MeshCoreDeviceType.REPEATER)
        : [];

      const targets = [
        ...companions.map(c => ({ key: c.publicKey, name: c.advName || c.name || c.publicKey.substring(0, 16), op: 'discover_path' as const })),
        ...repeaters.map(c => ({ key: c.publicKey, name: c.advName || c.name || c.publicKey.substring(0, 16), op: 'get_neighbours' as const })),
      ];

      if (targets.length === 0) {
        logger.debug(`[MeshCore:${this.sourceId}] Auto-pathfinding: no eligible targets`);
        return;
      }

      logger.info(`[MeshCore:${this.sourceId}] Auto-pathfinding: running on ${companions.length} companions + ${repeaters.length} repeaters`);

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
      logger.info(`[MeshCore:${this.sourceId}] Auto-pathfinding: run complete`);
    };

    this.autoPathfindingJitterTimeout = setTimeout(() => {
      this.autoPathfindingJitterTimeout = null;
      executeRun();
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

    if (useScheduleRaw) {
      if (!validateCron(schedule)) {
        logger.warn(`[MeshCore:${this.sourceId}] Auto-announce: invalid cron expression "${schedule}", not scheduling`);
        return;
      }
      try {
        this.autoAnnounceCron = scheduleCron(schedule, () => {
          void this.runAutoAnnounceCycle('cron');
        });
        logger.info(`[MeshCore:${this.sourceId}] Auto-announce: cron scheduled (${schedule})`);
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] Auto-announce: failed to schedule cron "${schedule}": ${(err as Error).message}`);
      }
    } else {
      const periodMs = intervalHours * 60 * 60 * 1000;
      this.autoAnnounceTimer = setInterval(() => {
        void this.runAutoAnnounceCycle('interval');
      }, periodMs);
      logger.info(`[MeshCore:${this.sourceId}] Auto-announce: interval scheduled every ${intervalHours}h`);
    }
  }

  /** Cancel any scheduled auto-announce timers. Idempotent. */
  stopAutoAnnounce(): void {
    if (this.autoAnnounceCron) {
      try { this.autoAnnounceCron.stop(); } catch { /* ignore */ }
      this.autoAnnounceCron = null;
    }
    if (this.autoAnnounceTimer) {
      clearInterval(this.autoAnnounceTimer);
      this.autoAnnounceTimer = null;
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

    const rendered = await replaceMeshCoreAnnounceTokens(message, this);
    let sent = 0;
    for (const idx of channelIndexes) {
      try {
        const ok = await this.sendMessage(rendered, undefined, idx);
        if (ok) sent += 1;
      } catch (err) {
        logger.warn(`[MeshCore:${this.sourceId}] Auto-announce: send to channel ${idx} threw: ${(err as Error).message}`);
      }
    }

    this.autoAnnounceLastRunAt = Date.now();
    await databaseService.settings.setSourceSetting(this.sourceId, 'meshcoreAutoAnnounceLastRunAt', String(this.autoAnnounceLastRunAt));
    logger.info(`[MeshCore:${this.sourceId}] Auto-announce (${reason}): ${sent}/${channelIndexes.length} channels`);

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
      enabled: this.autoAnnounceCron !== null || this.autoAnnounceTimer !== null,
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
    const dispatch = async (text: string): Promise<boolean> => {
      if (trigger.destination === 'dm' && trigger.contactPublicKey) {
        return this.sendMessage(text, trigger.contactPublicKey);
      }
      if (typeof trigger.channelIndex === 'number') {
        return this.sendMessage(text, undefined, trigger.channelIndex);
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
        const dispatch = async (text: string): Promise<boolean> => {
          if (trigger.replyAsDM || isDM) {
            const targetKey = senderContact?.publicKey || message.fromPublicKey;
            return this.sendMessage(text, targetKey);
          }
          if (typeof channelIdx === 'number') {
            return this.sendMessage(text, undefined, channelIdx);
          }
          return false;
        };

        if (trigger.responseType === 'script') {
          if (!trigger.scriptPath) {
            logger.warn(`[MeshCore:${this.sourceId}] Auto-responder ${trigger.id}: script trigger missing scriptPath`);
            continue;
          }
          const env = this.buildMeshCoreResponderScriptEnv(message, isDM, channelIdx, trigger);
          await this.runMeshCoreScript(trigger.scriptPath, trigger.scriptArgs, env, dispatch, `Auto-responder ${trigger.id}`);
          continue;
        }

        const body = await replaceMeshCoreAnnounceTokens(trigger.response || '', this);
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
  ): string {
    const date = new Date(timestamp);
    const longName = senderName || `${senderPubKey.substring(0, 8)}…`;
    const shortName = senderName ? senderName.substring(0, 4) : senderPubKey.substring(0, 4);
    const nodeId = `!${senderPubKey.substring(0, 8)}`;
    const snrStr = snr !== undefined && snr !== null ? snr.toFixed(1) : '—';
    const dateStr = date.toLocaleDateString('en-US');
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const hopsStr = hops !== null ? String(hops) : '—';
    // {ROUTE} expands the cached hop-hash chain into a readable
    // arrow-separated list (e.g. "a3 → 7f → 02"). Empty / unknown
    // route falls back to "direct" when hop count is 0 or "—" otherwise.
    let routeStr: string;
    if (route && route.length > 0) {
      routeStr = route
        .split(',')
        .map(h => h.trim())
        .filter(Boolean)
        .join(' → ');
    } else if (hops === 0) {
      routeStr = 'direct';
    } else {
      routeStr = '—';
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
      .replace(/\{ROUTE\}/g, routeStr)
      .replace(/\{VERSION\}/g, '4.8.0');
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

      // Resolve sender's display name from contacts when available
      let senderName = message.fromName;
      if (!senderName && !isDirectMessage) {
        // Channel sender is in the prefix-split fromName; nothing to do
      } else if (!senderName && isDirectMessage) {
        const contact = this.resolveContactByPrefix(message.fromPublicKey);
        senderName = contact?.advName ?? contact?.name ?? undefined;
      }

      const replyText = this.replaceAutoAckTokens(
        template,
        message.fromPublicKey,
        senderName,
        message.snr,
        message.timestamp,
        hops,
        route,
      );

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
        logger.info(`[MeshCore:${sourceId}] Auto-ack DM → ${contact.advName ?? contact.publicKey.substring(0, 8)}: "${replyText}"`);
        await this.sendMessage(replyText, contact.publicKey);
      } else {
        logger.info(`[MeshCore:${sourceId}] Auto-ack channel ${channelIdx} → "${replyText}"`);
        await this.sendMessage(replyText, undefined, channelIdx);
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
