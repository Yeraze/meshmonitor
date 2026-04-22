import databaseService, { type DbMessage } from '../services/database.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService, { convertIpv4ConfigToStrings } from './protobufService.js';
import { getProtobufRoot } from './protobufLoader.js';
import { TcpTransport } from './tcpTransport.js';
import { VirtualNodeServer, type VirtualNodeConfig } from './virtualNodeServer.js';
import type { ITransport } from './transports/transport.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { calculateDistance } from '../utils/distance.js';
import { isPointInGeofence, distanceToGeofenceCenter } from '../utils/geometry.js';
import { formatTime, formatDate } from '../utils/datetime.js';
import { logger } from '../utils/logger.js';
import { calculateLoRaFrequency } from '../utils/loraFrequency.js';
import { getEnvironmentConfig } from './config/environment.js';
import { notificationService } from './services/notificationService.js';
import { serverEventNotificationService } from './services/serverEventNotificationService.js';
import packetLogService from './services/packetLogService.js';
import { channelDecryptionService } from './services/channelDecryptionService.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';
import { MessageQueueService } from './messageQueueService.js';
import { normalizeTriggerPatterns, normalizeTriggerChannels } from '../utils/autoResponderUtils.js';
import { isWithinTimeWindow } from './utils/timeWindow.js';
import { isNodeComplete } from '../utils/nodeHelpers.js';
import { migrateAutomationChannels } from './utils/automationChannelMigration.js';
import { detectChannelMoves } from './utils/channelMoveDetection.js';
import { applyHomoglyphOptimization } from '../utils/homoglyph.js';
import { PortNum, RoutingError, isPkiError, getRoutingErrorName, CHANNEL_DB_OFFSET, TransportMechanism, isViaMqtt, MIN_TRACEROUTE_INTERVAL_MS, StoreForwardRequestResponse, getStoreForwardRequestResponseName } from './constants/meshtastic.js';
import { normalizeChannelRole } from './constants/channelRole.js';
import { isAutoFavoriteEligible } from './constants/autoFavorite.js';
import { createRequire } from 'module';
import { validateCron, scheduleCron, type CronJob } from './utils/cronScheduler.js';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

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

/**
 * Determines if a packet should be excluded from the packet log.
 * Internal packets (ADMIN_APP and ROUTING_APP) to/from the local node are excluded
 * since they are management traffic, not actual mesh traffic.
 *
 * @param fromNum - Source node number
 * @param toNum - Destination node number (null for broadcast)
 * @param portnum - Port number indicating packet type
 * @param localNodeNum - The local node's number (null if not connected)
 * @returns true if the packet should be excluded from logging
 */
export function shouldExcludeFromPacketLog(
  fromNum: number,
  toNum: number | null,
  portnum: number,
  localNodeNum: number | null
): boolean {
  // If we don't know the local node, can't determine if it's local traffic
  if (!localNodeNum) return false;

  // Check if packet is to/from the local node
  const isLocalPacket = fromNum === localNodeNum || toNum === localNodeNum;

  // Check if it's an internal portnum (ROUTING_APP or ADMIN_APP)
  const isInternalPortnum = portnum === PortNum.ROUTING_APP || portnum === PortNum.ADMIN_APP;

  return isLocalPacket && isInternalPortnum;
}

/**
 * Determines if a packet is a "phantom" internal state update from the local device.
 * These are packets the Meshtastic device sends to TCP clients to report its internal
 * state, but they are NOT actual RF transmissions. They should not be logged as "TX"
 * packets because they clutter the packet log and don't represent actual mesh traffic.
 *
 * Phantom packets are identified by:
 * - from_node === localNodeNum (originated from local device)
 * - transport_mechanism === INTERNAL (0) or undefined
 * - hop_start === 0 or undefined (hasn't traveled any hops)
 *
 * @param fromNum - Source node number
 * @param localNodeNum - The local node's number (null if not connected)
 * @param transportMechanism - Transport mechanism from the packet (0 = INTERNAL)
 * @param hopStart - Hop start value from the packet
 * @returns true if the packet is a phantom internal state update
 */
export function isPhantomInternalPacket(
  fromNum: number,
  localNodeNum: number | null,
  transportMechanism: number | undefined,
  hopStart: number | undefined
): boolean {
  // If we don't know the local node, can't determine if it's local traffic
  if (!localNodeNum) return false;

  // Must be from the local node
  if (fromNum !== localNodeNum) return false;

  // Transport mechanism must be INTERNAL (0) or undefined
  // Note: TransportMechanism.INTERNAL === 0
  const isInternalTransport = transportMechanism === undefined || transportMechanism === 0;
  if (!isInternalTransport) return false;

  // Hop start must be 0 or undefined (hasn't traveled any hops)
  const hasNotTraveled = hopStart === undefined || hopStart === 0;
  if (!hasNotTraveled) return false;

  return true;
}

type TextMessage = {
  id: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum: 1; // TEXT_MESSAGE_APP
  requestId?: number; // For Virtual Node messages, preserve packet ID for ACK matching
  timestamp: number;
  rxTime: number;
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
};

/**
 * Auto-responder trigger configuration
 */
interface AutoResponderTrigger {
  trigger: string | string[];
  response: string;
  responseType?: 'text' | 'http' | 'script' | 'traceroute';
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
  timer: ReturnType<typeof setInterval> | null;
  pendingRequestId: number | null;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
  startTime: number;
  lastPingSentAt: number;
  results: Array<{ pingNum: number; status: 'ack' | 'nak' | 'timeout'; durationMs?: number; sentAt: number }>;
}

class MeshtasticManager implements ISourceManager {
  public sourceId: string;
  private sourceConfigOverride: { host?: string; port?: number; heartbeatIntervalSeconds?: number } | null = null;
  private virtualNodeServer?: VirtualNodeServer;
  private transport: ITransport | null = null;
  private isConnected = false;
  private userDisconnectedState = false;  // Track user-initiated disconnect
  private tracerouteInterval: NodeJS.Timeout | null = null;
  private tracerouteJitterTimeout: NodeJS.Timeout | null = null;
  private distanceDeleteInterval: NodeJS.Timeout | null = null;
  // Reconnect flood prevention timing (#2474)
  private static readonly SCHEDULER_STAGGER_MS = 5000;  // Delay between each scheduler start
  private static readonly CONFIG_COMPLETE_FALLBACK_MS = 120000;  // Fallback if configComplete never arrives

  private tracerouteIntervalMinutes: number = 0;
  private lastTracerouteSentTime: number = 0;
  private localStatsInterval: NodeJS.Timeout | null = null;
  private timeOffsetSamples: number[] = [];
  private timeOffsetInterval: NodeJS.Timeout | null = null;
  private localStatsIntervalMinutes: number = 15;  // Default 5 minutes
  private announceInterval: NodeJS.Timeout | null = null;
  private announceCronJob: CronJob | null = null;
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
  private nodeLinkQuality: Map<number, { quality: number; lastHops: number }> = new Map(); // Track link quality per node
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
  private localNodeInfo: {
    nodeNum: number;
    nodeId: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    firmwareVersion?: string;
    rebootCount?: number;
    isLocked?: boolean;  // Flag to prevent overwrites after initial setup
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
  private favoritesSupportCache: boolean | null = null;  // Cache firmware support check result
  private cachedAutoAckRegex: { pattern: string; regex: RegExp } | null = null;  // Cached compiled regex

  private autoAckCooldowns: Map<number, number> = new Map(); // nodeNum -> lastResponseTimestamp
  private autoAckProcessedPackets: Set<number> = new Set(); // packetIds already auto-acked (dedup guard)
  private autoResponderCooldowns: Map<string, number> = new Map(); // "triggerIndex:nodeNum" -> lastResponseTimestamp
  private autoResponderProcessedPackets: Set<number> = new Set(); // packetIds already auto-responded (dedup guard)

  // Auto-ping session tracking
  private autoPingSessions: Map<number, AutoPingSession> = new Map(); // keyed by requester nodeNum

  // Auto-welcome tracking to prevent race conditions
  private welcomingNodes: Set<number> = new Set();  // Track nodes currently being welcomed
  private autoFavoritingNodes = new Set<number>();  // Track nodes currently being auto-favorited
  private deviceNodeNums: Set<number> = new Set();  // Nodes in the connected radio's local database
  private autoFavoriteSweepRunning = false;  // Prevent concurrent sweep operations
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

  /**
   * Apply a source config after construction.
   * Used to configure the legacy singleton when sources are loaded from DB at startup.
   */
  configureSource(config: { host?: string; port?: number; heartbeatIntervalSeconds?: number; virtualNode?: VirtualNodeConfig }, sourceId?: string): void {
    this.sourceConfigOverride = {
      host: config.host,
      port: config.port,
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    };
    if (sourceId) this.sourceId = sourceId;
    if (config.virtualNode?.enabled && !this.virtualNodeServer) {
      this.virtualNodeServer = new VirtualNodeServer({
        port: config.virtualNode.port,
        allowAdminCommands: config.virtualNode.allowAdminCommands,
        meshtasticManager: this,
      });
    }
  }

  async start(): Promise<void> {
    await this.connect();
    try {
      await this.virtualNodeServer?.start();
    } catch (err) {
      logger.error(`Failed to start VirtualNodeServer for source ${this.sourceId}:`, err);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.virtualNodeServer?.stop();
    } catch (err) {
      logger.error(`Failed to stop VirtualNodeServer for source ${this.sourceId}:`, err);
    }
    this.disconnect();
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
  public readonly messageQueue: MessageQueueService = new MessageQueueService();

  constructor(sourceId: string = 'default', sourceConfig?: { host?: string; port?: number; heartbeatIntervalSeconds?: number; virtualNode?: VirtualNodeConfig }) {
    this.sourceId = sourceId;
    if (sourceConfig) {
      this.sourceConfigOverride = {
        host: sourceConfig.host,
        port: sourceConfig.port,
        heartbeatIntervalSeconds: sourceConfig.heartbeatIntervalSeconds,
      };
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

    // Check if we need to recalculate estimated positions from historical traceroutes
    this.checkAndRecalculatePositions();
  }

  /**
   * Check if estimated position recalculation is needed and perform it.
   * This is triggered by migration 038 which deletes old estimates and sets a flag.
   */
  private async checkAndRecalculatePositions(): Promise<void> {
    try {
      await databaseService.waitForReady();
      const recalculateFlag = await databaseService.settings.getSetting('recalculate_estimated_positions');
      if (recalculateFlag !== 'pending') {
        return;
      }

      logger.info('📍 Recalculating estimated positions from historical traceroutes...');

      // Get all traceroutes with route data
      const traceroutes = await databaseService.getAllTraceroutesForRecalculationAsync();
      logger.info(`Found ${traceroutes.length} traceroutes to process for position estimation`);

      let processedCount = 0;
      for (const traceroute of traceroutes) {
        try {
          // Parse route array from JSON
          const route = traceroute.route ? JSON.parse(traceroute.route) : [];
          if (!Array.isArray(route) || route.length === 0) {
            continue;
          }

          // Build the full route path: fromNode (requester/origin) -> route intermediates -> toNode (destination)
          const fullRoute = [traceroute.fromNodeNum, ...route, traceroute.toNodeNum];

          // Parse SNR array if available
          let snrArray: number[] | undefined;
          if (traceroute.snrTowards) {
            const snrData = JSON.parse(traceroute.snrTowards);
            if (Array.isArray(snrData) && snrData.length > 0) {
              snrArray = snrData;
            }
          }

          // Process the traceroute for position estimation
          await this.estimateIntermediatePositions(fullRoute, traceroute.timestamp, snrArray);
          processedCount++;
        } catch (err) {
          logger.debug(`Skipping traceroute ${traceroute.id} due to error: ${err}`);
        }
      }

      logger.info(`✅ Processed ${processedCount} traceroutes for position estimation`);

      // Clear the flag
      await databaseService.settings.setSetting('recalculate_estimated_positions', 'completed');
    } catch (error) {
      logger.error('❌ Error recalculating estimated positions:', error);
    }
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
    // Per-source config takes priority (set when this manager was created from a source record)
    if (this.sourceConfigOverride?.host) {
      return {
        nodeIp: this.sourceConfigOverride.host,
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

  async connect(injectedTransport?: ITransport): Promise<boolean> {
    try {
      const config = await this.getConfig();
      logger.debug(`Connecting to Meshtastic node at ${config.nodeIp}:${config.tcpPort}...`);

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
        this.processIncomingData(data);
      });

      this.transport.on('disconnect', () => {
        this.handleDisconnected().catch((error) => {
          logger.error('Error in handleDisconnected:', error);
        });
      });

      this.transport.on('error', (error: Error) => {
        logger.error('❌ TCP transport error:', error.message);
      });

      // Connect to node
      // Note: isConnected will be set to true in handleConnected() callback
      // when the connection is actually established
      await this.transport.connect(config.nodeIp, config.tcpPort);

      return true;
    } catch (error) {
      this.isConnected = false;
      logger.error('Failed to connect to Meshtastic node:', error);
      throw error;
    }
  }

  private async handleConnected(): Promise<void> {
    logger.debug('TCP connection established, requesting configuration...');
    this.isConnected = true;

    // Emit WebSocket event for connection status change
    dataEventEmitter.emitConnectionStatus({
      connected: true,
      reason: 'TCP connection established'
    }, this.sourceId);

    // Clear localNodeInfo so node will be marked as not responsive until it sends MyNodeInfo
    this.localNodeInfo = null;

    // Notify server event service of connection (handles initial vs reconnect logic)
    await serverEventNotificationService.notifyNodeConnected(this.sourceId, await this.getSourceName());

    try {
      // Enable message capture for virtual node server
      // Clear any previous cache and start capturing
      this.initConfigCache = [];
      this.configCaptureComplete = false;
      this.isCapturingInitConfig = true;
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

      logger.info('📸 Starting init config capture for virtual node server');

      // Send want_config_id to request full node DB and config
      await this.sendWantConfigId();

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
        // Call external callback (e.g., virtual node server init) — registered once, safe to call on every reconnect
        if (this.externalConfigCaptureCallback) {
          try { this.externalConfigCaptureCallback(); } catch (e) { logger.error('❌ Error in external config capture callback:', e); }
        }

        // If localNodeInfo wasn't set during configuration, initialize it from database
        if (!this.localNodeInfo) {
          this.initializeLocalNodeInfoFromDatabase().catch(e =>
            logger.error('❌ Error initializing local node info:', e));
        }

        // Stagger scheduler starts to avoid overwhelming the device (#2474)
        // Each scheduler gets its own delay so outbound requests are spread out
        const S = MeshtasticManager.SCHEDULER_STAGGER_MS;
        setTimeout(() => this.startTracerouteScheduler(), S * 1);
        setTimeout(() => this.startRemoteAdminScanner().catch(e =>
          logger.error('❌ Error starting remote admin scanner:', e)), S * 2);
        setTimeout(() => this.startTimeSyncScheduler().catch(e =>
          logger.error('❌ Error starting time sync scheduler:', e)), S * 3);
        setTimeout(() => this.startLocalStatsScheduler(), S * 4);
        setTimeout(() => this.startTimeOffsetScheduler(), S * 5);
        setTimeout(() => this.startAnnounceScheduler().catch(e =>
          logger.error('❌ Error starting announce scheduler:', e)), S * 6);
        setTimeout(() => this.startTimerScheduler().catch(e =>
          logger.error('❌ Error starting timer scheduler:', e)), S * 7);

        // Start geofence engine (no outbound traffic, safe immediately)
        this.initGeofenceEngine().catch(e =>
          logger.error('❌ Error initializing geofence engine:', e));

        // Start auto key repair scheduler
        setTimeout(() => this.startKeyRepairScheduler(), S * 8);

        // Start auto-delete-by-distance scheduler (per-source)
        setTimeout(() => this.startDistanceDeleteScheduler().catch(e =>
          logger.error('❌ Error starting distance delete scheduler:', e)), S * 9);

        // Request LoRa config (config type 5) for Configuration tab — deferred
        // until after configComplete so we don't flood the device mid-exchange.
        // This is safe for serial-bridge connections that reject mid-exchange admin msgs.
        setTimeout(async () => {
          try {
            logger.info('📡 Requesting LoRa config from device...');
            await this.requestConfig(5); // LORA_CONFIG = 5
          } catch (error) {
            logger.error('❌ Failed to request LoRa config:', error);
          }
        }, S * 9);

        // Request all module configs for complete device backup capability (skip on reconnect)
        if (!this.moduleConfigsEverFetched) {
          setTimeout(async () => {
            try {
              logger.info('📦 Requesting all module configs for backup...');
              await this.requestAllModuleConfigs();
              this.moduleConfigsEverFetched = true;
            } catch (error) {
              logger.error('❌ Failed to request all module configs:', error);
            }
          }, S * 10);
        } else {
          logger.info('📦 Skipping module config request on reconnect (already fetched this session)');
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

        logger.info(`✅ Config capture complete — schedulers will start over the next ${(S * 11) / 1000} seconds`);
      };

      // Fallback: if configComplete never arrives (device disconnects mid-config),
      // start schedulers after the fallback timeout anyway
      setTimeout(() => {
        if (!this.configCaptureComplete && this.isConnected) {
          logger.warn(`⚠️ configComplete not received after ${MeshtasticManager.CONFIG_COMPLETE_FALLBACK_MS / 1000}s — starting schedulers via fallback`);
          this.configCaptureComplete = true;
          this.isCapturingInitConfig = false;
          if (this.onConfigCaptureComplete) {
            try { this.onConfigCaptureComplete(); } catch (e) { logger.error('❌ Error in fallback config complete:', e); }
          }
        }
      }, MeshtasticManager.CONFIG_COMPLETE_FALLBACK_MS);

    } catch (error) {
      logger.error('❌ Failed to request configuration:', error);
      await this.ensureBasicSetup();
    }
  }

  private async handleDisconnected(): Promise<void> {
    logger.debug('TCP connection lost');
    this.isConnected = false;

    // Emit WebSocket event for connection status change
    dataEventEmitter.emitConnectionStatus({
      connected: false,
      nodeNum: this.localNodeInfo?.nodeNum,
      nodeId: this.localNodeInfo?.nodeId,
      reason: 'TCP connection lost'
    }, this.sourceId);

    // Clear localNodeInfo so node will be marked as not responsive
    this.localNodeInfo = null;
    // Clear favorites support cache on disconnect
    this.favoritesSupportCache = null;
    // Clear device/module config cache on disconnect
    // This ensures fresh config is fetched on reconnect (prevents stale data after reboot)
    this.actualDeviceConfig = null;
    this.actualModuleConfig = null;
    logger.debug('📸 Cleared device and module config cache on disconnect');
    // Clear init config cache - will be repopulated on reconnect
    // This ensures virtual node clients get fresh data if a different node reconnects
    this.initConfigCache = [];
    this.configCaptureComplete = false;
    logger.debug('📸 Cleared init config cache on disconnect');

    // Notify server event service of disconnection
    // Skip notification if this is a user-initiated disconnect (already notified in userDisconnect())
    if (!this.userDisconnectedState) {
      await serverEventNotificationService.notifyNodeDisconnected(this.sourceId, await this.getSourceName());
    }

    // Only auto-reconnect if not in user-disconnected state
    if (this.userDisconnectedState) {
      logger.debug('User-initiated disconnect active, skipping auto-reconnect');
    } else {
      // Transport will handle automatic reconnection
      logger.debug('Auto-reconnection will be attempted by transport');
    }
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
  private async logOutgoingPacket(
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

    packetLogService.logPacket({
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

  private async sendWantConfigId(): Promise<void> {
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

    // Stop LocalStats collection
    this.stopLocalStatsScheduler();

    // Stop time-offset telemetry collection
    this.stopTimeOffsetScheduler();
    this.timeOffsetSamples = [];

    // Clear per-packet dedup sets (no longer relevant after disconnect)
    this.autoAckProcessedPackets.clear();
    this.autoResponderProcessedPackets.clear();

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
            logger.info(`🗺️ Auto-traceroute: Sending traceroute to ${targetName} (${targetNode.nodeId}) on channel ${channel}`);

            // Log the auto-traceroute attempt to database
            await databaseService.logAutoTracerouteAttemptAsync(targetNode.nodeNum, targetName, this.sourceId);
            this.pendingAutoTraceroutes.add(targetNode.nodeNum);
            this.pendingTracerouteTimestamps.set(targetNode.nodeNum, Date.now());

            this.lastTracerouteSentTime = Date.now();
            await this.sendTraceroute(targetNode.nodeNum, channel);

            // Check for timed-out traceroutes (> 5 minutes old)
            this.checkTracerouteTimeouts();
          } else {
            logger.info('🗺️ Auto-traceroute: No nodes available for traceroute');
          }
        } catch (error) {
          logger.error('❌ Error in auto-traceroute:', error);
        }
      } else {
        logger.info('🗺️ Auto-traceroute: Skipping - not connected or no local node info');
      }
    };

    // Delay first execution by jitter, then start regular interval
    this.tracerouteJitterTimeout = setTimeout(() => {
      this.tracerouteJitterTimeout = null;
      // Execute first traceroute
      executeTraceroute();

      // Start regular interval (no jitter on subsequent runs)
      this.tracerouteInterval = setInterval(executeTraceroute, intervalMs);
    }, initialJitterMs);
  }

  /**
   * Start (or restart) the per-source auto-delete-by-distance scheduler.
   * Reads autoDeleteByDistanceEnabled / autoDeleteByDistanceIntervalHours via
   * getSettingForSource so each source uses its own configuration.
   */
  public async startDistanceDeleteScheduler(): Promise<void> {
    // Clear any existing interval
    if (this.distanceDeleteInterval) {
      clearInterval(this.distanceDeleteInterval);
      this.distanceDeleteInterval = null;
    }

    const enabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoDeleteByDistanceEnabled');
    if (enabled !== 'true') {
      logger.debug(`🗑️ Auto-delete-by-distance disabled for source ${this.sourceId}`);
      return;
    }

    const intervalHoursStr = await databaseService.settings.getSettingForSource(this.sourceId, 'autoDeleteByDistanceIntervalHours');
    const intervalHours = parseInt(intervalHoursStr || '24', 10);
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

    logger.info(`🗑️ Starting auto-delete-by-distance scheduler for source ${this.sourceId} (interval: ${intervalHours}h)`);

    // Initial run after 2 minutes (matches prior singleton behavior)
    setTimeout(() => {
      autoDeleteByDistanceService.runDeleteCycle(this.sourceId).catch(err =>
        logger.error(`❌ Auto-delete-by-distance initial run failed for source ${this.sourceId}:`, err));
    }, 120_000);

    this.distanceDeleteInterval = setInterval(() => {
      autoDeleteByDistanceService.runDeleteCycle(this.sourceId).catch(err =>
        logger.error(`❌ Auto-delete-by-distance run failed for source ${this.sourceId}:`, err));
    }, intervalMs);
  }

  /**
   * Stop the auto-delete-by-distance scheduler for this source.
   */
  public stopDistanceDeleteScheduler(): void {
    if (this.distanceDeleteInterval) {
      clearInterval(this.distanceDeleteInterval);
      this.distanceDeleteInterval = null;
      logger.debug(`⏹️ Auto-delete-by-distance scheduler stopped for source ${this.sourceId}`);
    }
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
      logger.info('🔑 Remote admin scanner is disabled');
      return;
    }

    const intervalMs = this.remoteAdminScannerIntervalMinutes * 60 * 1000;
    logger.info(`🔑 Starting remote admin scanner with ${this.remoteAdminScannerIntervalMinutes} minute interval`);

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
      logger.info(`🕐 Time sync scheduler is disabled for source ${this.sourceId}`);
      return;
    }

    const intervalMs = this.timeSyncIntervalMinutes * 60 * 1000;
    logger.info(`🕐 Starting time sync scheduler for source ${this.sourceId} with ${this.timeSyncIntervalMinutes} minute interval`);

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

    const targetNode = await databaseService.getNodeNeedingTimeSyncAsync(this.sourceId);
    if (!targetNode) {
      logger.info('🕐 Time sync: No nodes available for syncing');
      return;
    }

    // Skip if already being synced
    if (this.pendingTimeSyncs.has(targetNode.nodeNum)) {
      logger.debug(`🕐 Time sync: Node ${targetNode.nodeNum} already being synced`);
      return;
    }

    const targetName = targetNode.longName || targetNode.nodeId;
    logger.info(`🕐 Time sync: Syncing time to ${targetName} (${targetNode.nodeId})`);

    this.pendingTimeSyncs.add(targetNode.nodeNum);

    try {
      await this.sendSetTimeCommand(targetNode.nodeNum);
      await databaseService.nodes.updateNodeTimeSyncAsync(targetNode.nodeNum, Date.now(), this.sourceId);
      logger.info(`🕐 Time sync: Successfully synced time to ${targetName}`);
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
      logger.info('🔑 Remote admin scan: No nodes available for scanning');
      return;
    }

    // Skip if already being scanned
    if (this.pendingRemoteAdminScans.has(targetNode.nodeNum)) {
      logger.debug(`🔑 Remote admin scan: Node ${targetNode.nodeNum} already being scanned`);
      return;
    }

    const targetName = targetNode.longName || targetNode.nodeId;
    logger.info(`🔑 Remote admin scan: Checking ${targetName} (${targetNode.nodeId}) for admin capability`);

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
      logger.info(`🔑 Remote admin scan: Node ${nodeNum} scan failed - no admin access`);
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
              databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'purge', true, null, null, this.sourceId);
              logger.info(`🔐 Key repair: Purged node ${nodeName}, sending final node info exchange`);

              // Send one more node info exchange after purge — use channel, not DM
              // (keys are mismatched so PKI-encrypted DMs would fail)
              const purgedNodeData = await databaseService.nodes.getNode(node.nodeNum);
              await this.sendNodeInfoRequest(node.nodeNum, purgedNodeData?.channel ?? 0);
              databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'exchange', null, null, null, this.sourceId);
            } catch (error) {
              logger.error(`🔐 Key repair: Failed to purge node ${nodeName}:`, error);
              databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'purge', false, null, null, this.sourceId);
            }
          }

          // Mark as exhausted
          await databaseService.setKeyRepairStateAsync(node.nodeNum, { exhausted: true });
          databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, 'exhausted', null, null, null, this.sourceId);
          continue;
        }

        // Send node info exchange — use node's channel, not DM
        // (keys are mismatched so PKI-encrypted DMs would fail)
        const repairNodeData = await databaseService.nodes.getNode(node.nodeNum);
        const repairChannel = repairNodeData?.channel ?? 0;
        logger.info(`🔐 Key repair: Sending node info exchange to ${nodeName} on channel ${repairChannel} (attempt ${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`);
        try {
          await this.sendNodeInfoRequest(node.nodeNum, repairChannel);

          // Update repair state
          await databaseService.setKeyRepairStateAsync(node.nodeNum, {
            attemptCount: node.attemptCount + 1,
            lastAttemptTime: now,
            startedAt: node.startedAt ?? now
          });

          databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, `exchange (${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`, null, null, null, this.sourceId);
        } catch (error) {
          logger.error(`🔐 Key repair: Failed to send node info to ${nodeName}:`, error);
          databaseService.logKeyRepairAttemptAsync(node.nodeNum, nodeName, `exchange (${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`, false, null, null, this.sourceId);
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

  private async startAnnounceScheduler(): Promise<void> {
    // Clear any existing interval or cron job
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    if (this.announceCronJob) {
      this.announceCronJob.stop();
      this.announceCronJob = null;
    }

    // Check if auto-announce is enabled
    const autoAnnounceEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceEnabled');
    if (autoAnnounceEnabled !== 'true') {
      logger.debug('📢 Auto-announce is disabled');
      return;
    }

    // Check if we should use scheduled sends (cron) or interval (per-source — written
    // by AutoAnnounceSection via /api/settings?sourceId=)
    const useSchedule = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceUseSchedule') === 'true';

    if (useSchedule) {
      const scheduleExpression = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceSchedule') || '0 */6 * * *';
      logger.debug(`📢 Starting announce scheduler with cron expression: ${scheduleExpression}`);

      // Validate and schedule the cron job
      if (validateCron(scheduleExpression)) {
        this.announceCronJob = scheduleCron(scheduleExpression, async () => {
          logger.debug(`📢 Cron job triggered (connected: ${this.isConnected})`);
          if (this.isConnected) {
            try {
              await this.sendAutoAnnouncement();
            } catch (error) {
              logger.error('❌ Error in cron auto-announce:', error);
            }
          } else {
            logger.debug('📢 Skipping announcement - not connected to node');
          }
        });

        logger.info(`📢 Announce scheduler started with cron expression: ${scheduleExpression}`);
      } else {
        logger.error(`❌ Invalid cron expression: ${scheduleExpression}`);
        return;
      }
    } else {
      // Use interval-based scheduling (per-source)
      const intervalHours = parseInt(await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceIntervalHours') || '6');
      const intervalMs = intervalHours * 60 * 60 * 1000;

      logger.debug(`📢 Starting announce scheduler with ${intervalHours} hour interval`);

      this.announceInterval = setInterval(async () => {
        logger.debug(`📢 Announce interval triggered (connected: ${this.isConnected})`);
        if (this.isConnected) {
          try {
            await this.sendAutoAnnouncement();
          } catch (error) {
            logger.error('❌ Error in auto-announce:', error);
          }
        } else {
          logger.debug('📢 Skipping announcement - not connected to node');
        }
      }, intervalMs);

      logger.info(`📢 Announce scheduler started - next announcement in ${intervalHours} hours`);
    }

    // Check if announce-on-start is enabled (per-source; applies to both cron and interval modes)
    const announceOnStart = await databaseService.settings.getSettingForSource(this.sourceId, 'autoAnnounceOnStart');
    if (announceOnStart === 'true') {
      // Check spam protection: don't send if announced within last hour
      const lastAnnouncementTime = await databaseService.settings.getSettingForSource(this.sourceId, 'lastAnnouncementTime');
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      if (lastAnnouncementTime) {
        const timeSinceLastAnnouncement = now - parseInt(lastAnnouncementTime);
        if (timeSinceLastAnnouncement < oneHour) {
          const minutesRemaining = Math.ceil((oneHour - timeSinceLastAnnouncement) / 60000);
          logger.debug(`📢 Skipping startup announcement - last announcement was ${Math.floor(timeSinceLastAnnouncement / 60000)} minutes ago (spam protection: ${minutesRemaining} minutes remaining)`);
        } else {
          logger.debug('📢 Sending startup announcement');
          // Delay startup announcement to allow reboot detection and ghost cleanup to complete
          setTimeout(async () => {
            if (this.isConnected) {
              try {
                await this.sendAutoAnnouncement();
              } catch (error) {
                logger.error('❌ Error in startup announcement:', error);
              }
            }
          }, 30000);
        }
      } else {
        // No previous announcement, send one
        logger.debug('📢 Sending first startup announcement');
        // Delay startup announcement to allow reboot detection and ghost cleanup to complete
        setTimeout(async () => {
          if (this.isConnected) {
            try {
              await this.sendAutoAnnouncement();
            } catch (error) {
              logger.error('❌ Error in startup announcement:', error);
            }
          }
        }, 30000);
      }
    }
  }

  setAnnounceInterval(hours: number): void {
    if (hours < 3 || hours > 24) {
      throw new Error('Announce interval must be between 3 and 24 hours');
    }

    logger.debug(`📢 Announce interval updated to ${hours} hours`);

    if (this.isConnected) {
      this.startAnnounceScheduler().catch(err => logger.error('Error starting announce scheduler:', err));
    }
  }

  restartAnnounceScheduler(): void {
    logger.debug('📢 Restarting announce scheduler due to settings change');

    if (this.isConnected) {
      this.startAnnounceScheduler().catch(err => logger.error('Error restarting announce scheduler:', err));
    }
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
        logger.info(`⏱️ Timer "${trigger.name}" triggered (cron: ${trigger.cronExpression})`);
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
      logger.info(`⏱️ Scheduled timer "${trigger.name}" with cron: ${trigger.cronExpression}`);
    }

    logger.info(`⏱️ Timer scheduler started with ${this.timerCronJobs.size} active timer(s)`);
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
    const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
    for (const trigger of enabledTriggers) {
      const insideSet = new Set<number>();
      for (const node of allNodes) {
        if (node.latitude == null || node.longitude == null) continue;
        const nodeNum = Number(node.nodeNum);

        // Check node filter
        if (trigger.nodeFilter.type === 'selected' &&
            !trigger.nodeFilter.nodeNums.includes(nodeNum)) {
          continue;
        }

        if (isPointInGeofence(node.latitude, node.longitude, trigger.shape)) {
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
        logger.info(`📍 Geofence "${trigger.name}": while_inside timer set for every ${trigger.whileInsideIntervalMinutes} minute(s)`);
      }
    }

    logger.info(`📍 Geofence engine started with ${enabledTriggers.length} active trigger(s)`);
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
            logger.info(`📍 Geofence "${trigger.name}": node ${nodeNum} entered`);
            this.executeGeofenceTrigger(trigger, nodeNum, lat, lng, 'entry');
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
            logger.info(`📍 Geofence "${trigger.name}": node ${nodeNum} exited`);
            this.executeGeofenceTrigger(trigger, nodeNum, lat, lng, 'exit');
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
      if (trigger.responseType === 'text' && trigger.response?.trim()) {
        const expanded = await this.replaceGeofenceTokens(trigger.response, trigger, nodeNum, lat, lng, eventType);
        const truncated = this.truncateMessageForMeshtastic(expanded, 200);

        const isDM = trigger.channel === 'dm';
        // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
        const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
        logger.info(`📍 Geofence "${trigger.name}" sending text to ${isDM ? `DM (node ${nodeNum})` : `channel ${trigger.channel}`}${trigger.verifyResponse ? ' (with verification)' : ''}`);
        this.messageQueue.enqueue(
          truncated,
          isDM ? nodeNum : 0,
          undefined,
          () => logger.info(`✅ Geofence "${trigger.name}" message delivered to ${isDM ? `DM (node ${nodeNum})` : `channel ${trigger.channel}`}`),
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
    const isDev = process.env.NODE_ENV !== 'production';

    switch (ext) {
      case 'js': case 'mjs': interpreter = isDev ? 'node' : '/usr/local/bin/node'; break;
      case 'py': interpreter = isDev ? 'python' : '/opt/apprise-venv/bin/python3'; break;
      case 'sh': interpreter = isDev ? 'sh' : '/bin/sh'; break;
      default:
        await this.updateGeofenceTriggerResult(trigger.id, 'error', `Unsupported script extension: ${ext}`);
        return;
    }

    const startTime = Date.now();
    logger.info(`📍 Executing geofence script: "${trigger.name}" (${eventType}) -> ${scriptPath}`);

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
        env: scriptEnv,
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
              () => logger.info(`✅ Geofence "${trigger.name}" script response delivered`),
              (reason: string) => logger.warn(`❌ Geofence "${trigger.name}" script response failed: ${reason}`),
              isDM ? undefined : trigger.channel as number,
              maxAttempts
            );
          }
        } else {
          logger.info(`📍 Geofence "${trigger.name}" script executed (channel=none, no mesh output)`);
        }
      }

      const duration = Date.now() - startTime;
      logger.info(`📍 Geofence "${trigger.name}" script completed successfully in ${duration}ms`);
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
      if (!node || node.latitude == null || node.longitude == null) continue;

      // Re-validate position is still inside
      if (!isPointInGeofence(node.latitude, node.longitude, trigger.shape)) {
        stateSet.delete(nodeNum);
        logger.debug(`📍 Geofence "${trigger.name}": node ${nodeNum} no longer inside (stale position)`);
        continue;
      }

      if (this.isGeofenceCooldownActive(trigger.id, nodeNum, trigger.cooldownMinutes)) {
        logger.debug(`📍 Geofence "${trigger.name}": cooldown active for node ${nodeNum}, skipping while_inside`);
        continue;
      }

      logger.info(`📍 Geofence "${trigger.name}": while_inside tick for node ${nodeNum}`);
      this.executeGeofenceTrigger(trigger, nodeNum, node.latitude, node.longitude, 'while_inside');
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

    logger.info(`⏱️ Executing timer script: ${scriptPath} -> ${resolvedPath}`);

    // Determine interpreter based on file extension
    const ext = scriptPath.split('.').pop()?.toLowerCase();
    let interpreter: string;
    const isDev = process.env.NODE_ENV !== 'production';

    switch (ext) {
      case 'js':
      case 'mjs':
        interpreter = isDev ? 'node' : '/usr/local/bin/node';
        break;
      case 'py':
        interpreter = isDev ? 'python' : '/opt/apprise-venv/bin/python3';
        break;
      case 'sh':
        interpreter = isDev ? 'sh' : '/bin/sh';
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
        env: scriptEnv,
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      if (stderr) {
        logger.warn(`⏱️ Timer script "${triggerName}" stderr: ${stderr}`);
      }

      const duration = Date.now() - startTime;
      logger.info(`⏱️ Timer "${triggerName}" completed successfully in ${duration}ms`);

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
          logger.info(`⏱️ Enqueueing ${scriptResponses.length} timer response(s) to channel ${channel}`);

          scriptResponses.forEach((resp, index) => {
            const truncated = this.truncateMessageForMeshtastic(resp, 200);

            this.messageQueue.enqueue(
              truncated,
              0, // destination: 0 for channel broadcast
              undefined, // no reply-to packet ID for timer messages
              () => {
                logger.info(`✅ Timer response ${index + 1}/${scriptResponses.length} delivered to channel ${channel}`);
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
      logger.info(`⏱️ Executing timer text message: "${triggerName}"`);

      // Replace tokens using the same method as auto-announce
      const expandedMessage = await this.replaceAnnouncementTokens(message);
      const truncated = this.truncateMessageForMeshtastic(expandedMessage, 200);

      logger.info(`⏱️ Timer "${triggerName}" sending to channel ${channel}: ${truncated.substring(0, 50)}${truncated.length > 50 ? '...' : ''}`);

      this.messageQueue.enqueue(
        truncated,
        0, // destination: 0 for channel broadcast
        undefined, // no reply-to packet ID for timer messages
        () => {
          logger.info(`✅ Timer "${triggerName}" message delivered to channel ${channel}`);
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

        await databaseService.settings.setSetting('timerTriggers', JSON.stringify(timerTriggers));
        logger.debug(`⏱️ Updated timer trigger ${triggerId} result: ${result}`);
      }
    } catch (e) {
      logger.error('⏱️ Failed to update timer trigger result:', e);
    }
  }

  public async processIncomingData(data: Uint8Array, context?: ProcessingContext): Promise<void> {
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
          logger.info('⚙️ Received Config with keys:', Object.keys(parsed.data));
          logger.debug('⚙️ Received Config:', JSON.stringify(parsed.data, null, 2));

          // Proto3 omits fields with default values (false for bool, 0 for numeric)
          // We need to ensure these fields exist with proper defaults
          if (parsed.data.lora) {
            logger.info(`📊 Raw LoRa config from device:`, JSON.stringify(parsed.data.lora, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.lora.usePreset === undefined) {
              parsed.data.lora.usePreset = false;
              logger.info('📊 Set usePreset to false (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.sx126xRxBoostedGain === undefined) {
              parsed.data.lora.sx126xRxBoostedGain = false;
              logger.info('📊 Set sx126xRxBoostedGain to false (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.ignoreMqtt === undefined) {
              parsed.data.lora.ignoreMqtt = false;
              logger.info('📊 Set ignoreMqtt to false (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.configOkToMqtt === undefined) {
              parsed.data.lora.configOkToMqtt = false;
              logger.info('📊 Set configOkToMqtt to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.lora.frequencyOffset === undefined) {
              parsed.data.lora.frequencyOffset = 0;
              logger.info('📊 Set frequencyOffset to 0 (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.overrideFrequency === undefined) {
              parsed.data.lora.overrideFrequency = 0;
              logger.info('📊 Set overrideFrequency to 0 (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.modemPreset === undefined) {
              parsed.data.lora.modemPreset = 0;
              logger.info('📊 Set modemPreset to 0 (was undefined - Proto3 default)');
            }
            if (parsed.data.lora.channelNum === undefined) {
              parsed.data.lora.channelNum = 0;
              logger.info('📊 Set channelNum to 0 (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to device config
          if (parsed.data.device) {
            logger.info(`📊 Raw Device config from device:`, JSON.stringify(parsed.data.device, null, 2));

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.device.nodeInfoBroadcastSecs === undefined) {
              parsed.data.device.nodeInfoBroadcastSecs = 0;
              logger.info('📊 Set nodeInfoBroadcastSecs to 0 (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to position config
          if (parsed.data.position) {
            logger.info(`📊 Raw Position config from device:`, JSON.stringify(parsed.data.position, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.position.positionBroadcastSmartEnabled === undefined) {
              parsed.data.position.positionBroadcastSmartEnabled = false;
              logger.info('📊 Set positionBroadcastSmartEnabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.position.fixedPosition === undefined) {
              parsed.data.position.fixedPosition = false;
              logger.info('📊 Set fixedPosition to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.position.positionBroadcastSecs === undefined) {
              parsed.data.position.positionBroadcastSecs = 0;
              logger.info('📊 Set positionBroadcastSecs to 0 (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to position config
          if (parsed.data.position) {
            logger.info(`📊 Raw Position config from device:`, JSON.stringify(parsed.data.position, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.position.positionBroadcastSmartEnabled === undefined) {
              parsed.data.position.positionBroadcastSmartEnabled = false;
              logger.info('📊 Set positionBroadcastSmartEnabled to false (was undefined - Proto3 default)');
            }

            if (parsed.data.position.fixedPosition === undefined) {
              parsed.data.position.fixedPosition = false;
              logger.info('📊 Set fixedPosition to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.position.positionBroadcastSecs === undefined) {
              parsed.data.position.positionBroadcastSecs = 0;
              logger.info('📊 Set positionBroadcastSecs to 0 (was undefined - Proto3 default)');
            }

            logger.info(`📊 Position config after Proto3 defaults: positionBroadcastSecs=${parsed.data.position.positionBroadcastSecs}, positionBroadcastSmartEnabled=${parsed.data.position.positionBroadcastSmartEnabled}, fixedPosition=${parsed.data.position.fixedPosition}`);
          }

          // Merge the actual device configuration (don't overwrite)
          this.actualDeviceConfig = { ...this.actualDeviceConfig, ...parsed.data };
          logger.info('📊 Merged actualDeviceConfig now has keys:', Object.keys(this.actualDeviceConfig));
          logger.info('📊 actualDeviceConfig.lora present:', !!this.actualDeviceConfig?.lora);
          if (parsed.data.lora) {
            logger.info(`📊 Received LoRa config - hopLimit=${parsed.data.lora.hopLimit}, usePreset=${this.actualDeviceConfig.lora.usePreset}, frequencyOffset=${this.actualDeviceConfig.lora.frequencyOffset}`);
          }
          logger.info(`📊 Current actualDeviceConfig.lora.hopLimit=${this.actualDeviceConfig?.lora?.hopLimit}`);
          logger.debug('📊 Merged actualDeviceConfig now has:', Object.keys(this.actualDeviceConfig));

          // Extract local node's public key from security config and save to database
          if (parsed.data.security && parsed.data.security.publicKey) {
            const publicKeyBytes = parsed.data.security.publicKey;
            if (publicKeyBytes && publicKeyBytes.length > 0) {
              const publicKeyBase64 = Buffer.from(publicKeyBytes).toString('base64');
              logger.info(`🔐 Received local node public key from security config: ${publicKeyBase64.substring(0, 20)}...`);

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

                  await databaseService.nodes.upsertNode(updateData, this.sourceId);
                  logger.info(`💾 Saved local node public key to database for ${localNodeId}`);
                }).catch(async (err) => {
                  // If low entropy check fails, still save the key
                  await databaseService.nodes.upsertNode({
                    nodeNum: localNodeNum,
                    nodeId: localNodeId,
                    publicKey: publicKeyBase64,
                    hasPKC: true
                  }, this.sourceId);
                  logger.warn(`⚠️ Could not check low-entropy key status:`, err);
                  logger.info(`💾 Saved local node public key to database for ${localNodeId}`);
                });
              } else {
                logger.warn(`⚠️ Received security config with public key but local node info not yet available`);
              }
            }
          }
          break;
        case 'moduleConfig':
          logger.info('⚙️ Received Module Config with keys:', Object.keys(parsed.data));
          logger.debug('⚙️ Received Module Config:', JSON.stringify(parsed.data, null, 2));

          // Apply Proto3 defaults to MQTT config
          if (parsed.data.mqtt) {
            logger.info(`📊 Raw MQTT config from device:`, JSON.stringify(parsed.data.mqtt, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.mqtt.enabled === undefined) {
              parsed.data.mqtt.enabled = false;
              logger.info('📊 Set mqtt.enabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.mqtt.encryptionEnabled === undefined) {
              parsed.data.mqtt.encryptionEnabled = false;
              logger.info('📊 Set mqtt.encryptionEnabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.mqtt.jsonEnabled === undefined) {
              parsed.data.mqtt.jsonEnabled = false;
              logger.info('📊 Set mqtt.jsonEnabled to false (was undefined - Proto3 default)');
            }
          }

          // Apply Proto3 defaults to NeighborInfo config
          if (parsed.data.neighborInfo) {
            logger.info(`📊 Raw NeighborInfo config from device:`, JSON.stringify(parsed.data.neighborInfo, null, 2));

            // Ensure boolean fields have explicit values (Proto3 omits false)
            if (parsed.data.neighborInfo.enabled === undefined) {
              parsed.data.neighborInfo.enabled = false;
              logger.info('📊 Set neighborInfo.enabled to false (was undefined - Proto3 default)');
            }
            if (parsed.data.neighborInfo.transmitOverLora === undefined) {
              parsed.data.neighborInfo.transmitOverLora = false;
              logger.info('📊 Set neighborInfo.transmitOverLora to false (was undefined - Proto3 default)');
            }

            // Ensure numeric fields have explicit values (Proto3 omits 0)
            if (parsed.data.neighborInfo.updateInterval === undefined) {
              parsed.data.neighborInfo.updateInterval = 0;
              logger.info('📊 Set neighborInfo.updateInterval to 0 (was undefined - Proto3 default)');
            }
          }

          // Merge the actual module configuration (don't overwrite)
          this.actualModuleConfig = { ...this.actualModuleConfig, ...parsed.data };
          logger.info('📊 Merged actualModuleConfig now has keys:', Object.keys(this.actualModuleConfig));
          break;
        case 'channel':
          await this.processChannelProtobuf(parsed.data);
          break;
        case 'configComplete':
          logger.debug('✅ Config complete received, ID:', parsed.data.configCompleteId);

          // Stop capturing init messages
          if (this.isCapturingInitConfig && !this.configCaptureComplete) {
            this.configCaptureComplete = true;
            this.isCapturingInitConfig = false;
            logger.info(`📸 Init config capture complete! Captured ${this.initConfigCache.length} messages for virtual node replay`);

            // Detect channel moves/swaps from external sources (#2425)
            await this.detectAndMigrateChannelChanges();

            // Call registered callback if present
            if (this.onConfigCaptureComplete) {
              try {
                this.onConfigCaptureComplete();
              } catch (error) {
                logger.error('❌ Error in config capture complete callback:', error);
              }
            }
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

        // Try to get full node info from database
        const node = await databaseService.nodes.getNode(nodeNum);
        if (node) {
          this.localNodeInfo = {
            nodeNum: nodeNum,
            nodeId: savedNodeId,
            longName: node.longName || 'Unknown',
            shortName: node.shortName || 'UNK',
            hwModel: node.hwModel || undefined,
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
          await databaseService.nodes.upsertNode({
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
          }, this.sourceId);

          // Delete old ghost node (cascades messages, traceroutes, neighbors, telemetry)
          await databaseService.deleteNodeAsync(prevNum, this.sourceId);
          logger.info(`🗑️ Deleted old ghost node ${previousNodeId} (${prevNum})`);

          // Suppress ghost resurrection — incoming mesh traffic may still reference the old nodeNum
          await databaseService.suppressGhostNodeAsync(prevNum);

          // Update settings to new nodeNum/nodeId — localDeviceId stays the same
          await databaseService.settings.setSetting(this.localNodeSettingKey('localNodeNum'), nodeNum.toString());
          await databaseService.settings.setSetting(this.localNodeSettingKey('localNodeId'), nodeId);

          // Clear init config cache to force VN clients to get fresh config with correct identity
          this.initConfigCache = [];
          logger.info(`📸 Cleared init config cache due to same-device reboot merge`);

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
              logger.info(`✅ Removed old nodeNum ${previousNodeId} (${prevNumToRemove}) from device NodeDB after reboot merge`);
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
          logger.info(`📸 Cleared init config cache due to node ID change`);

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

    // Check if we already have this node with actual names in the database
    const existingNode = await databaseService.nodes.getNode(nodeNum);

    // Clear any erroneous security flags on the local node — we can't have a key mismatch with ourselves
    if (existingNode?.keyMismatchDetected || existingNode?.keySecurityIssueDetails) {
      logger.info(`🔐 Clearing erroneous security flags on local node ${nodeId}`);
      await databaseService.nodes.upsertNode({
        nodeNum,
        nodeId,
        keyMismatchDetected: false,
        keySecurityIssueDetails: null,
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

      // Update rebootCount and ensure hasRemoteAdmin is set for local node
      await databaseService.nodes.upsertNode({
        nodeNum: nodeNum,
        nodeId: nodeId,
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
        hasRemoteAdmin: true  // Local node always has remote admin access
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

      await databaseService.nodes.upsertNode(nodeData, this.sourceId);
      logger.debug(`📱 Stored basic local node info with rebootCount: ${myNodeInfo.rebootCount}, waiting for NodeInfo for names (${nodeId})`);
    }
    // Note: Local node's public key is extracted from security config when received
  }

  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string; hwModel?: number; firmwareVersion?: string; rebootCount?: number; isLocked?: boolean } | null {
    return this.localNodeInfo;
  }

  /** Returns source-scoped settings keys for local node identity persistence.
   *  Each source manager stores its own localNodeNum/localNodeId so managers
   *  don't clobber each other's values when running side-by-side. */
  private localNodeSettingKey(base: string): string {
    return this.sourceId && this.sourceId !== 'default' ? `${base}_${this.sourceId}` : base;
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
    logger.info(`📊 Updated cached device config section '${section}':`, Object.keys(values));
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
    logger.info(`[CONFIG] getCurrentConfig called - hopLimit=${this.actualDeviceConfig?.lora?.hopLimit}`);

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
        channelNum: deviceConfig.lora.channelNum !== undefined ? deviceConfig.lora.channelNum : 0
      };

      deviceConfig = {
        ...deviceConfig,
        lora: loraConfigWithDefaults
      };

      logger.info(`[CONFIG] Returning lora config with usePreset=${loraConfigWithDefaults.usePreset}, sx126xRxBoostedGain=${loraConfigWithDefaults.sx126xRxBoostedGain}, ignoreMqtt=${loraConfigWithDefaults.ignoreMqtt}, configOkToMqtt=${loraConfigWithDefaults.configOkToMqtt}`);
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

      logger.info(`[CONFIG] Returning position config with positionBroadcastSecs=${positionConfigWithDefaults.positionBroadcastSecs}, positionBroadcastSmartEnabled=${positionConfigWithDefaults.positionBroadcastSmartEnabled}, fixedPosition=${positionConfigWithDefaults.fixedPosition}`);
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

      logger.info(`[CONFIG] Returning security config with isManaged=${securityConfigWithDefaults.isManaged}, serialEnabled=${securityConfigWithDefaults.serialEnabled}, debugLogApiEnabled=${securityConfigWithDefaults.debugLogApiEnabled}, adminChannelEnabled=${securityConfigWithDefaults.adminChannelEnabled}`);
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

      logger.info(`[CONFIG] Returning MQTT config with enabled=${mqttConfigWithDefaults.enabled}, encryptionEnabled=${mqttConfigWithDefaults.encryptionEnabled}, jsonEnabled=${mqttConfigWithDefaults.jsonEnabled}`);
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

      logger.info(`[CONFIG] Returning NeighborInfo config with enabled=${neighborInfoConfigWithDefaults.enabled}, updateInterval=${neighborInfoConfigWithDefaults.updateInterval}, transmitOverLora=${neighborInfoConfigWithDefaults.transmitOverLora}`);
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

      logger.info(`[CONFIG] Returning Telemetry config with deviceTelemetryEnabled=${telemetryConfigWithDefaults.deviceTelemetryEnabled}, healthMeasurementEnabled=${telemetryConfigWithDefaults.healthMeasurementEnabled}`);
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

      logger.info(`[CONFIG] Returning StatusMessage config with nodeStatus="${statusMessageConfigWithDefaults.nodeStatus}"`);
    }

    // Apply Proto3 defaults to TrafficManagement module config
    if (moduleConfig.trafficManagement) {
      const trafficManagementConfigWithDefaults = {
        ...moduleConfig.trafficManagement,
        enabled: moduleConfig.trafficManagement.enabled !== undefined ? moduleConfig.trafficManagement.enabled : false,
        positionDedupEnabled: moduleConfig.trafficManagement.positionDedupEnabled !== undefined ? moduleConfig.trafficManagement.positionDedupEnabled : false,
        positionDedupTimeSecs: moduleConfig.trafficManagement.positionDedupTimeSecs !== undefined ? moduleConfig.trafficManagement.positionDedupTimeSecs : 0,
        positionDedupDistanceMeters: moduleConfig.trafficManagement.positionDedupDistanceMeters !== undefined ? moduleConfig.trafficManagement.positionDedupDistanceMeters : 0,
        nodeinfoDirectResponseEnabled: moduleConfig.trafficManagement.nodeinfoDirectResponseEnabled !== undefined ? moduleConfig.trafficManagement.nodeinfoDirectResponseEnabled : false,
        nodeinfoDirectResponseMyNodeOnly: moduleConfig.trafficManagement.nodeinfoDirectResponseMyNodeOnly !== undefined ? moduleConfig.trafficManagement.nodeinfoDirectResponseMyNodeOnly : false,
        rateLimitEnabled: moduleConfig.trafficManagement.rateLimitEnabled !== undefined ? moduleConfig.trafficManagement.rateLimitEnabled : false,
        rateLimitMaxPerNode: moduleConfig.trafficManagement.rateLimitMaxPerNode !== undefined ? moduleConfig.trafficManagement.rateLimitMaxPerNode : 0,
        rateLimitWindowSecs: moduleConfig.trafficManagement.rateLimitWindowSecs !== undefined ? moduleConfig.trafficManagement.rateLimitWindowSecs : 0,
        unknownPacketDropEnabled: moduleConfig.trafficManagement.unknownPacketDropEnabled !== undefined ? moduleConfig.trafficManagement.unknownPacketDropEnabled : false,
        unknownPacketGracePeriodSecs: moduleConfig.trafficManagement.unknownPacketGracePeriodSecs !== undefined ? moduleConfig.trafficManagement.unknownPacketGracePeriodSecs : 0,
        hopExhaustionEnabled: moduleConfig.trafficManagement.hopExhaustionEnabled !== undefined ? moduleConfig.trafficManagement.hopExhaustionEnabled : false,
        hopExhaustionMinHops: moduleConfig.trafficManagement.hopExhaustionMinHops !== undefined ? moduleConfig.trafficManagement.hopExhaustionMinHops : 0,
        hopExhaustionMaxHops: moduleConfig.trafficManagement.hopExhaustionMaxHops !== undefined ? moduleConfig.trafficManagement.hopExhaustionMaxHops : 0
      };

      moduleConfig = {
        ...moduleConfig,
        trafficManagement: trafficManagementConfigWithDefaults
      };

      logger.info(`[CONFIG] Returning TrafficManagement config with enabled=${trafficManagementConfigWithDefaults.enabled}`);
    }

    return {
      deviceConfig,
      moduleConfig,
      localNodeInfo: this.localNodeInfo,
      supportedModules: {
        statusmessage: !!moduleConfig.statusmessage,
        trafficManagement: !!moduleConfig.trafficManagement
      }
    };
  }

  /**
   * Process DeviceMetadata protobuf message
   */
  private async processDeviceMetadata(metadata: any): Promise<void> {
    logger.debug('📱 Processing DeviceMetadata:', JSON.stringify(metadata, null, 2));
    logger.debug('📱 Firmware version:', metadata.firmwareVersion);

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
        await databaseService.nodes.upsertNode(nodeData, this.sourceId);
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
            logger.info(`📡 Channel ${channel.index} arrived empty — normalizing role to DISABLED(0) (#2666)`);
          }

          logger.debug(`📡 Saving channel ${channel.index} (${displayName}) - role: ${channelRole}`);

          await databaseService.channels.upsertChannel({
            id: channel.index,
            name: channelName,
            psk: pskString,
            role: channelRole,
            uplinkEnabled: channel.settings.uplinkEnabled ?? true,
            downlinkEnabled: channel.settings.downlinkEnabled ?? true,
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
          logger.info(
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
              }
              payloadPreview = `[Telemetry: ${telemetryType}]`;
            } else if (portnum === PortNum.PAXCOUNTER_APP) {
              // PAXCOUNTER - show WiFi and BLE counts
              const pax = processedPayload as any;
              payloadPreview = `[Paxcounter: WiFi=${pax.wifi || 0}, BLE=${pax.ble || 0}]`;
            } else if (portnum === PortNum.TRACEROUTE_APP) {
              // TRACEROUTE
              payloadPreview = '[Traceroute]';
            } else if (portnum === PortNum.NEIGHBORINFO_APP) {
              // NEIGHBORINFO
              payloadPreview = '[NeighborInfo]';
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

        packetLogService.logPacket({
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
          direction: fromNum === this.localNodeInfo?.nodeNum ? 'tx' : 'rx',
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

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Use server time for lastHeard — rxTime from the device clock is unreliable
        lastHeard: Date.now() / 1000,
        // Update channel from every firmware-decoded packet so outbound messages (DMs,
        // traceroutes, position requests) use the channel the node is actually communicating
        // on. Previously only set from NodeInfo, which could get stuck on a secondary channel.
        ...(channelFromPacket !== undefined && { channel: channelFromPacket }),
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
      await databaseService.nodes.upsertNode(nodeData, this.sourceId);

      // Capture server-vs-node clock offset for time-offset telemetry
      if (meshPacket.rxTime && Number(meshPacket.rxTime) > 1600000000) {
        const offset = Date.now() / 1000 - Number(meshPacket.rxTime);
        if (Math.abs(offset) < 86400) {
          this.timeOffsetSamples.push(offset);
        }
      }

      // Track message hops (hopStart - hopLimit) for "All messages" hop calculation mode
      const hopStart = meshPacket.hopStart ?? meshPacket.hop_start;
      const hopLimit = meshPacket.hopLimit ?? meshPacket.hop_limit;
      if (hopStart !== undefined && hopStart !== null &&
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
            await this.processPositionMessageProtobuf(meshPacket, processedPayload as any);
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

    // Phase 7: Mirror every accepted inbound MeshPacket to this source's
    // virtual-node clients so VN consumers see live mesh traffic. Broadcast all
    // PortNums — the whole point of a virtual node is to reflect the mesh.
    if (this.virtualNodeServer) {
      try {
        const fromRadioData = await meshtasticProtobufService.createFromRadioWithPacket(meshPacket);
        if (fromRadioData) {
          await this.virtualNodeServer.broadcastToClients(fromRadioData);
        }
      } catch (error) {
        logger.error(`Virtual node: Failed to broadcast inbound packet for source ${this.sourceId}:`, error);
      }
    }
  }

  /**
   * Rebuild a NodeInfo FromRadio message for `nodeNum` from the database and
   * broadcast it to this source's virtual-node clients. Used by REST handlers
   * (favorite/ignore toggles) so VN clients see updated node metadata
   * immediately. No-op if VN is not enabled for this source.
   */
  async broadcastNodeInfoUpdate(nodeNum: number): Promise<void> {
    if (!this.virtualNodeServer) return;
    try {
      const node = await databaseService.nodes.getNode(nodeNum);
      if (!node) return;
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
          node.latitude && node.longitude
            ? {
                latitude: node.latitude,
                longitude: node.longitude,
                altitude: node.altitude || 0,
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
   * Process text message using protobuf types
   */
  private async processTextMessageProtobuf(meshPacket: any, messageText: string, context?: ProcessingContext): Promise<void> {
    try {
      logger.debug(`💬 Text message: "${messageText}"`);

      if (messageText && messageText.length > 0 && messageText.length < 500) {
        const fromNum = Number(meshPacket.from);
        const toNum = Number(meshPacket.to);

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
          await databaseService.nodes.upsertNode(basicNodeData, this.sourceId);
          logger.debug(`📝 Created basic node entry for ${fromNodeId}`);
        }

        // Handle broadcast address (4294967295 = 0xFFFFFFFF)
        let actualToNum = toNum;
        const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

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
            await databaseService.nodes.upsertNode(broadcastNodeData, this.sourceId);
            logger.debug(`📝 Created broadcast node entry (no lastHeard — pseudo-node)`);
          }
        }

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
          const matchingDeviceChannel = dbChannel?.psk
            ? deviceChannels.find(dc => dc.psk === dbChannel.psk && dc.role !== 0)
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
          timestamp: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          rxTime: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
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
          logger.info(`📦 S&F ${rrName} from ${fromNodeId}: "${messageText.substring(0, 50)}"`);

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
          logger.info(`📦 S&F heartbeat from ${fromNodeId}: period=${period}s, secondary=${secondary}`);

          // Mark this node as a Store & Forward server
          await databaseService.nodes.upsertNode({
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
            logger.info(`📦 S&F stats from ${fromNodeId}: total=${stats.messagesTotal ?? 0}, saved=${stats.messagesSaved ?? 0}, max=${stats.messagesMax ?? 0}, uptime=${stats.upTime ?? 0}s`);
          }
          break;
        }

        case StoreForwardRequestResponse.ROUTER_HISTORY: {
          const history = decoded.history;
          if (history) {
            logger.info(`📦 S&F history from ${fromNodeId}: ${history.historyMessages ?? 0} messages, window=${history.window ?? 0}min`);
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
   * Validate position coordinates
   */
  private isValidPosition(latitude: number, longitude: number): boolean {
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

    return true;
  }

  /**
   * Process position message using protobuf types
   */
  private async processPositionMessageProtobuf(meshPacket: any, position: any): Promise<void> {
    try {
      logger.debug(`🗺️ Position message: lat=${position.latitudeI}, lng=${position.longitudeI}`);

      if (position.latitudeI && position.longitudeI) {
        // Convert coordinates from integer format to decimal degrees
        const coords = meshtasticProtobufService.convertCoordinates(position.latitudeI, position.longitudeI);

        // Validate coordinates
        if (!this.isValidPosition(coords.latitude, coords.longitude)) {
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

        // Extract position precision metadata
        const channelIndex = meshPacket.channel !== undefined ? meshPacket.channel : 0;
        // Use precision_bits from packet if available, otherwise fall back to channel's positionPrecision
        // Also fall back if precisionBits is 0 (which means no precision was set)
        let precisionBits = position.precisionBits ?? position.precision_bits ?? undefined;
        if (precisionBits === undefined || precisionBits === 0) {
          const channel = await databaseService.channels.getChannelById(channelIndex, this.sourceId);
          if (channel && channel.positionPrecision !== undefined && channel.positionPrecision !== null && channel.positionPrecision > 0) {
            precisionBits = channel.positionPrecision;
            logger.debug(`🗺️ Using channel ${channelIndex} positionPrecision (${precisionBits}) for position from ${nodeId}`);
          }
        }
        const gpsAccuracy = position.gpsAccuracy ?? position.gps_accuracy ?? undefined;
        const hdop = position.HDOP ?? position.hdop ?? undefined;

        // Check if this position is a response to a position exchange request
        // Position exchange uses wantResponse=true, which means the position response IS the acknowledgment
        // Look for a pending "Position exchange requested" message to this node
        const localNodeInfo = this.getLocalNodeInfo();
        if (localNodeInfo) {
          const localNodeId = `!${localNodeInfo.nodeNum.toString(16).padStart(8, '0')}`;
          const pendingMessages = await databaseService.messages.getDirectMessages(localNodeId, nodeId, 100) as DbMessage[];
          const pendingExchangeRequest = pendingMessages.find((msg: DbMessage) =>
            msg.text === 'Position exchange requested' &&
            msg.fromNodeNum === localNodeInfo.nodeNum &&
            msg.toNodeNum === fromNum &&
            msg.requestId != null // Must have a requestId
          );

          if (pendingExchangeRequest && pendingExchangeRequest.requestId != null) {
            // Mark the position exchange request as delivered
            await databaseService.messages.updateMessageDeliveryState(pendingExchangeRequest.requestId!, 'delivered');
            logger.info(`📍 Position exchange acknowledged: Received position from ${nodeId}, marking request message as delivered`);
          }
        }

        // Track PKI encryption
        await this.trackPKIEncryption(meshPacket, fromNum);

        // Determine if we should update position based on precision upgrade/downgrade logic
        const existingNode = await databaseService.nodes.getNode(fromNum);
        let shouldUpdatePosition = true;

        if (existingNode && existingNode.positionPrecisionBits != null && precisionBits !== undefined) {
          const existingPrecision = existingNode.positionPrecisionBits;
          const newPrecision = precisionBits;
          const existingPositionAge = existingNode.positionTimestamp ? (now - existingNode.positionTimestamp) : Infinity;
          const twelveHoursMs = 12 * 60 * 60 * 1000;
          const tenMinutesMs = 10 * 60 * 1000;

          // Mobile/tracker nodes need more frequent position updates
          const isMobileOrTracker = existingNode.mobile === 1 ||
            existingNode.role === 5 ||   // Tracker
            existingNode.role === 10;    // TAK Tracker

          const staleThresholdMs = isMobileOrTracker ? tenMinutesMs : twelveHoursMs;

          // Smart upgrade/downgrade logic:
          // - Always upgrade to higher precision
          // - Only downgrade if existing position is older than the stale threshold
          //   (10 min for mobile/tracker nodes, 12 hours for stationary)
          if (newPrecision < existingPrecision && existingPositionAge < staleThresholdMs) {
            shouldUpdatePosition = false;
            logger.debug(`🗺️ Skipping position update for ${nodeId}: New precision (${newPrecision}) < existing (${existingPrecision}) and existing position is recent (${Math.round(existingPositionAge / 1000 / 60)}min old, threshold: ${Math.round(staleThresholdMs / 1000 / 60)}min)`);
          } else if (newPrecision > existingPrecision) {
            logger.debug(`🗺️ Upgrading position precision for ${nodeId}: ${existingPrecision} -> ${newPrecision} bits (channel ${channelIndex})`);
          } else if (existingPositionAge >= staleThresholdMs) {
            logger.debug(`🗺️ Updating stale position for ${nodeId}: existing is ${Math.round(existingPositionAge / 1000 / 60)}min old (threshold: ${Math.round(staleThresholdMs / 1000 / 60)}min)`);
          }
        }

        // Always save position to telemetry table for historical tracking
        // This ensures position history is complete regardless of precision changes
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'latitude',
          timestamp, value: coords.latitude, unit: '°', createdAt: now, packetTimestamp, packetId,
          channel: channelIndex, precisionBits, gpsAccuracy
        }, this.sourceId);
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'longitude',
          timestamp, value: coords.longitude, unit: '°', createdAt: now, packetTimestamp, packetId,
          channel: channelIndex, precisionBits, gpsAccuracy
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

        // Store ground speed if available (in m/s)
        const groundSpeed = position.groundSpeed ?? position.ground_speed;
        if (groundSpeed !== undefined && groundSpeed > 0) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ground_speed',
            timestamp, value: groundSpeed, unit: 'm/s', createdAt: now, packetTimestamp, packetId,
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
        if (isLocalNode && hasFixedPositionEnabled && shouldUpdatePosition) {
          logger.info(`🗺️ Skipping position update for local node ${nodeId}: fixedPosition is enabled, position should only be set via config. Received: ${coords.latitude}, ${coords.longitude}`);
          // Still update lastHeard and technical fields, just not lat/lon/alt
          const technicalData: any = {
            nodeNum: fromNum,
            nodeId: nodeId,
            lastHeard: Date.now() / 1000,
          };
          if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
            technicalData.snr = meshPacket.rxSnr;
          }
          if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
            technicalData.rssi = meshPacket.rxRssi;
          }
          await databaseService.nodes.upsertNode(technicalData, this.sourceId);
        } else if (shouldUpdatePosition) {
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
            positionTimestamp: now
          };

          // Only include SNR/RSSI if they have valid values
          if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
            nodeData.snr = meshPacket.rxSnr;
          }
          if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
            nodeData.rssi = meshPacket.rxRssi;
          }

          // Save position to nodes table (current position)
          await databaseService.nodes.upsertNode(nodeData, this.sourceId);

          // Emit node update event to notify frontend via WebSocket
          dataEventEmitter.emitNodeUpdate(fromNum, nodeData, this.sourceId);

          // Update mobility detection for this node (fire and forget)
          databaseService.updateNodeMobilityAsync(nodeId).catch(err =>
            logger.error(`Failed to update mobility for ${nodeId}:`, err)
          );

          // Check geofence triggers for this node's new position
          this.checkGeofencesForNode(fromNum, coords.latitude, coords.longitude).catch(err => logger.error('Error checking geofences:', err));

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
      await databaseService.nodes.upsertNode({
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
        // Use server time for lastHeard — rxTime from the device clock is unreliable
        lastHeard: Date.now() / 1000,
      };

      // Capture public key if present
      if (user.publicKey && user.publicKey.length > 0) {
        // Convert Uint8Array to base64 for storage
        nodeData.publicKey = Buffer.from(user.publicKey).toString('base64');
        nodeData.hasPKC = true;
        logger.info(`🔐 Received NodeInfo with public key for ${nodeId} (${user.longName}): ${nodeData.publicKey.substring(0, 20)}... (${user.publicKey.length} bytes)`);

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
              logger.info(`🔐 Key mismatch RESOLVED for node ${nodeId} (${user.longName}) - received new key`);
            } else {
              // Keys now match - the mismatch was fixed (e.g., device re-synced after purge)
              logger.info(`🔐 Key mismatch RESOLVED for node ${nodeId} (${user.longName}) - keys now match`);
            }

            nodeData.keyMismatchDetected = false;
            nodeData.lastMeshReceivedKey = null;
            // Don't clear keySecurityIssueDetails if there's a low-entropy issue
            if (!isLowEntropy) {
              nodeData.keySecurityIssueDetails = null;
            }

            // Clear the repair state and log success
            databaseService.clearKeyRepairStateAsync(fromNum);
            const nodeName = user.longName || user.shortName || nodeId;
            databaseService.logKeyRepairAttemptAsync(fromNum, nodeName, 'fixed', true, null, null, this.sourceId);

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

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
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
      await databaseService.nodes.upsertNode(nodeData, this.sourceId);
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

        nodeData.batteryLevel = deviceMetrics.batteryLevel;
        nodeData.voltage = deviceMetrics.voltage;
        nodeData.channelUtilization = deviceMetrics.channelUtilization;
        nodeData.airUtilTx = deviceMetrics.airUtilTx;

        // Save all telemetry values from actual TELEMETRY_APP packets (no deduplication)
        if (deviceMetrics.batteryLevel !== undefined && deviceMetrics.batteryLevel !== null && !isNaN(deviceMetrics.batteryLevel)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'batteryLevel',
            timestamp, value: deviceMetrics.batteryLevel, unit: '%', createdAt: now, packetTimestamp, packetId
          }, this.sourceId);
        }
        if (deviceMetrics.voltage !== undefined && deviceMetrics.voltage !== null && !isNaN(deviceMetrics.voltage)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'voltage',
            timestamp, value: deviceMetrics.voltage, unit: 'V', createdAt: now, packetTimestamp, packetId
          }, this.sourceId);
        }
        if (deviceMetrics.channelUtilization !== undefined && deviceMetrics.channelUtilization !== null && !isNaN(deviceMetrics.channelUtilization)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'channelUtilization',
            timestamp, value: deviceMetrics.channelUtilization, unit: '%', createdAt: now, packetTimestamp, packetId
          }, this.sourceId);
        }
        if (deviceMetrics.airUtilTx !== undefined && deviceMetrics.airUtilTx !== null && !isNaN(deviceMetrics.airUtilTx)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'airUtilTx',
            timestamp, value: deviceMetrics.airUtilTx, unit: '%', createdAt: now, packetTimestamp, packetId
          }, this.sourceId);
        }
        if (deviceMetrics.uptimeSeconds !== undefined && deviceMetrics.uptimeSeconds !== null && !isNaN(deviceMetrics.uptimeSeconds)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'uptimeSeconds',
            timestamp, value: deviceMetrics.uptimeSeconds, unit: 's', createdAt: now, packetTimestamp, packetId
          }, this.sourceId);
        }
      } else if (telemetry.environmentMetrics) {
        const envMetrics = telemetry.environmentMetrics;
        logger.debug(`🌡️ Environment telemetry: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);

        // Save all Environment metrics to telemetry table
        await this.saveTelemetryMetrics([
          // Core weather metrics
          { type: 'temperature', value: envMetrics.temperature, unit: '°C' },
          { type: 'humidity', value: envMetrics.relativeHumidity, unit: '%' },
          { type: 'pressure', value: envMetrics.barometricPressure, unit: 'hPa' },
          // Air quality related
          { type: 'gasResistance', value: envMetrics.gasResistance, unit: 'MΩ' },
          { type: 'iaq', value: envMetrics.iaq, unit: 'IAQ' },
          // Light sensors
          { type: 'lux', value: envMetrics.lux, unit: 'lux' },
          { type: 'whiteLux', value: envMetrics.whiteLux, unit: 'lux' },
          { type: 'irLux', value: envMetrics.irLux, unit: 'lux' },
          { type: 'uvLux', value: envMetrics.uvLux, unit: 'lux' },
          // Wind metrics
          { type: 'windDirection', value: envMetrics.windDirection, unit: '°' },
          { type: 'windSpeed', value: envMetrics.windSpeed, unit: 'm/s' },
          { type: 'windGust', value: envMetrics.windGust, unit: 'm/s' },
          { type: 'windLull', value: envMetrics.windLull, unit: 'm/s' },
          // Precipitation
          { type: 'rainfall1h', value: envMetrics.rainfall1h, unit: 'mm' },
          { type: 'rainfall24h', value: envMetrics.rainfall24h, unit: 'mm' },
          // Soil sensors
          { type: 'soilMoisture', value: envMetrics.soilMoisture, unit: '%' },
          { type: 'soilTemperature', value: envMetrics.soilTemperature, unit: '°C' },
          // Other sensors
          { type: 'radiation', value: envMetrics.radiation, unit: 'µR/h' },
          { type: 'distance', value: envMetrics.distance, unit: 'mm' },
          { type: 'weight', value: envMetrics.weight, unit: 'kg' },
          // Deprecated but still supported (use PowerMetrics for new implementations)
          { type: 'envVoltage', value: envMetrics.voltage, unit: 'V' },
          { type: 'envCurrent', value: envMetrics.current, unit: 'A' }
        ], nodeId, fromNum, timestamp, packetTimestamp, packetId);
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

        // Process all 8 power channels
        for (let ch = 1; ch <= 8; ch++) {
          const voltageKey = `ch${ch}Voltage` as keyof typeof powerMetrics;
          const currentKey = `ch${ch}Current` as keyof typeof powerMetrics;

          // Save voltage for this channel
          const voltage = powerMetrics[voltageKey];
          if (voltage !== undefined && voltage !== null && !isNaN(Number(voltage))) {
            await databaseService.telemetry.insertTelemetry({
              nodeId, nodeNum: fromNum, telemetryType: String(voltageKey),
              timestamp, value: Number(voltage), unit: 'V', createdAt: now, packetTimestamp, packetId
            }, this.sourceId);
          }

          // Save current for this channel
          const current = powerMetrics[currentKey];
          if (current !== undefined && current !== null && !isNaN(Number(current))) {
            await databaseService.telemetry.insertTelemetry({
              nodeId, nodeNum: fromNum, telemetryType: String(currentKey),
              timestamp, value: Number(current), unit: 'mA', createdAt: now, packetTimestamp, packetId
            }, this.sourceId);
          }
        }
      } else if (telemetry.airQualityMetrics) {
        const aqMetrics = telemetry.airQualityMetrics;
        logger.debug(`🌬️ Air Quality telemetry: PM2.5=${aqMetrics.pm25Standard}µg/m³, CO2=${aqMetrics.co2}ppm`);

        // Save all AirQuality metrics to telemetry table
        await this.saveTelemetryMetrics([
          // PM Standard measurements (µg/m³)
          { type: 'pm10Standard', value: aqMetrics.pm10Standard, unit: 'µg/m³' },
          { type: 'pm25Standard', value: aqMetrics.pm25Standard, unit: 'µg/m³' },
          { type: 'pm100Standard', value: aqMetrics.pm100Standard, unit: 'µg/m³' },
          // PM Environmental measurements (µg/m³)
          { type: 'pm10Environmental', value: aqMetrics.pm10Environmental, unit: 'µg/m³' },
          { type: 'pm25Environmental', value: aqMetrics.pm25Environmental, unit: 'µg/m³' },
          { type: 'pm100Environmental', value: aqMetrics.pm100Environmental, unit: 'µg/m³' },
          // Particle counts (#/0.1L)
          { type: 'particles03um', value: aqMetrics.particles03um, unit: '#/0.1L' },
          { type: 'particles05um', value: aqMetrics.particles05um, unit: '#/0.1L' },
          { type: 'particles10um', value: aqMetrics.particles10um, unit: '#/0.1L' },
          { type: 'particles25um', value: aqMetrics.particles25um, unit: '#/0.1L' },
          { type: 'particles50um', value: aqMetrics.particles50um, unit: '#/0.1L' },
          { type: 'particles100um', value: aqMetrics.particles100um, unit: '#/0.1L' },
          // CO2 and related
          { type: 'co2', value: aqMetrics.co2, unit: 'ppm' },
          { type: 'co2Temperature', value: aqMetrics.co2Temperature, unit: '°C' },
          { type: 'co2Humidity', value: aqMetrics.co2Humidity, unit: '%' }
        ], nodeId, fromNum, timestamp, packetTimestamp, packetId);
      } else if (telemetry.localStats) {
        const localStats = telemetry.localStats;
        logger.debug(`📊 LocalStats telemetry: uptime=${localStats.uptimeSeconds}s, heap_free=${localStats.heapFreeBytes}B`);

        // Save all LocalStats metrics to telemetry table
        await this.saveTelemetryMetrics([
          { type: 'uptimeSeconds', value: localStats.uptimeSeconds, unit: 's' },
          { type: 'channelUtilization', value: localStats.channelUtilization, unit: '%' },
          { type: 'airUtilTx', value: localStats.airUtilTx, unit: '%' },
          { type: 'numPacketsTx', value: localStats.numPacketsTx, unit: 'packets' },
          { type: 'numPacketsRx', value: localStats.numPacketsRx, unit: 'packets' },
          { type: 'numPacketsRxBad', value: localStats.numPacketsRxBad, unit: 'packets' },
          { type: 'numOnlineNodes', value: localStats.numOnlineNodes, unit: 'nodes' },
          { type: 'numTotalNodes', value: localStats.numTotalNodes, unit: 'nodes' },
          { type: 'numRxDupe', value: localStats.numRxDupe, unit: 'packets' },
          { type: 'numTxRelay', value: localStats.numTxRelay, unit: 'packets' },
          { type: 'numTxRelayCanceled', value: localStats.numTxRelayCanceled, unit: 'packets' },
          { type: 'heapTotalBytes', value: localStats.heapTotalBytes, unit: 'bytes' },
          { type: 'heapFreeBytes', value: localStats.heapFreeBytes, unit: 'bytes' },
          { type: 'numTxDropped', value: localStats.numTxDropped, unit: 'packets' }
        ], nodeId, fromNum, timestamp, packetTimestamp, packetId);
        await this.checkAutoHeapManagement(localStats.heapFreeBytes, fromNum);
      } else if (telemetry.hostMetrics) {
        const hostMetrics = telemetry.hostMetrics;
        logger.debug(`🖥️ HostMetrics telemetry: uptime=${hostMetrics.uptimeSeconds}s, freemem=${hostMetrics.freememBytes}B`);

        // Save all HostMetrics metrics to telemetry table
        await this.saveTelemetryMetrics([
          { type: 'hostUptimeSeconds', value: hostMetrics.uptimeSeconds, unit: 's' },
          { type: 'hostFreememBytes', value: hostMetrics.freememBytes, unit: 'bytes' },
          { type: 'hostDiskfree1Bytes', value: hostMetrics.diskfree1Bytes, unit: 'bytes' },
          { type: 'hostDiskfree2Bytes', value: hostMetrics.diskfree2Bytes, unit: 'bytes' },
          { type: 'hostDiskfree3Bytes', value: hostMetrics.diskfree3Bytes, unit: 'bytes' },
          { type: 'hostLoad1', value: hostMetrics.load1, unit: 'load' },
          { type: 'hostLoad5', value: hostMetrics.load5, unit: 'load' },
          { type: 'hostLoad15', value: hostMetrics.load15, unit: 'load' }
        ], nodeId, fromNum, timestamp, packetTimestamp, packetId);
      }

      await databaseService.nodes.upsertNode(nodeData, this.sourceId);
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

      await databaseService.nodes.upsertNode(nodeData, this.sourceId);
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

      // Skip traceroute responses FROM our local node (Issue #1140)
      // When another node traceroutes us, we capture our own outgoing response.
      // This response only has the forward path (route), not a meaningful return path (routeBack),
      // which causes incorrect "direct line" route segments to be displayed on the map.
      if (this.localNodeInfo && fromNum === this.localNodeInfo.nodeNum) {
        logger.debug(`🗺️ Skipping traceroute response from local node ${fromNodeId} (our response to someone else's request)`);
        return;
      }

      logger.info(`🗺️ Traceroute response from ${fromNodeId}:`, JSON.stringify(routeDiscovery, null, 2));

      // Ensure from node exists in database (don't overwrite existing names)
      const existingFromNode = await databaseService.nodes.getNode(fromNum);
      if (!existingFromNode) {
        await databaseService.nodes.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.slice(-4),
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      } else {
        // Just update lastHeard, don't touch the name
        await databaseService.nodes.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      }

      // Ensure to node exists in database (don't overwrite existing names)
      const existingToNode = await databaseService.nodes.getNode(toNum);
      if (!existingToNode) {
        await databaseService.nodes.upsertNode({
          nodeNum: toNum,
          nodeId: toNodeId,
          longName: `Node ${toNodeId}`,
          shortName: toNodeId.slice(-4),
          lastHeard: Date.now() / 1000
        }, this.sourceId);
      } else {
        // Just update lastHeard, don't touch the name
        await databaseService.nodes.upsertNode({
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
        await databaseService.nodes.upsertNode({
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
          const snr = rawSnr === undefined ? 'N/A' : rawSnr === -128 ? 'MQTT' : `${(rawSnr / 4).toFixed(1)}dB`;
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
          const snr = rawSnr === undefined ? 'N/A' : rawSnr === -128 ? 'MQTT' : `${(rawSnr / 4).toFixed(1)}dB`;
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
      const timestamp = meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now();

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
        createdAt: Date.now()
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
        if (node?.latitude && node?.longitude) {
          routePositions[nodeNum] = {
            lat: node.latitude,
            lng: node.longitude,
            ...(node.altitude ? { alt: node.altitude } : {}),
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
        timestamp: timestamp,
        createdAt: Date.now()
      };

      // Use DatabaseService.insertTraceroute() (not repo directly) for deduplication:
      // It checks for pending traceroute requests and updates them instead of inserting duplicates
      databaseService.insertTraceroute(tracerouteRecord, this.sourceId ?? undefined);

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
          () => { logger.info(`✅ Autoresponder traceroute result reply delivered`); },
          (reason: string) => { logger.warn(`❌ Autoresponder traceroute result reply failed: ${reason}`); },
          pending.isDM ? undefined : pending.replyChannel,
          1
        );
        logger.info(`🔍 Autoresponder traceroute result for ${fromNodeId} replied to !${pending.replyToNodeNum.toString(16).padStart(8, '0')}`);
      }

      // Send notification for successful traceroute
      this.getSourceName()
        .then(sourceName => notificationService.notifyTraceroute(fromNodeId, toNodeId, routeText, this.sourceId, sourceName))
        .catch(err => logger.error('Failed to send traceroute notification:', err));

      // Calculate and store route segment distances, and estimate positions for nodes without GPS
      try {
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

        // Estimate positions for intermediate nodes without GPS
        // Process forward route (responder -> requester) with SNR weighting
        await this.estimateIntermediatePositions(fullRoute, timestamp, snrTowards);

        // Process return route if it exists (requester -> responder) with SNR weighting
        if (routeBack.length > 0) {
          const fullReturnRoute = [toNum, ...routeBack, fromNum];
          await this.estimateIntermediatePositions(fullReturnRoute, timestamp, snrBack);
        }
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

      // Check if this routing update is for an auto-ping session
      if (requestId) {
        if (errorReason === 0) {
          this.handleAutoPingResponse(requestId, 'ack');
        } else {
          this.handleAutoPingResponse(requestId, 'nak');
        }
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
            logger.info(`📡 ACK from our own radio ${fromNodeId} for requestId ${requestId} - message transmitted to mesh`);
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
            logger.info(`✅ ACK received from TARGET node ${fromNodeId} for requestId ${requestId} - message confirmed`);
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

            await databaseService.nodes.upsertNode({
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

              await databaseService.nodes.upsertNode({
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

          await databaseService.nodes.upsertNode({
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
            await databaseService.nodes.upsertNode({
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
      logger.info(`❌ Marking message ${requestId} as failed due to routing error from ${isDM ? 'target' : 'mesh'}: ${errorName}`);
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
   * Estimate positions for nodes in a traceroute path that don't have GPS data
   * by calculating a weighted average between neighbors in the direction of the destination.
   *
   * Route structure: [destination, hop1, hop2, ..., hopN, requester]
   * - Index 0 = destination (traceroute target)
   * - Index N-1 = requester (source of traceroute)
   *
   * For intermediate nodes, we estimate position based on:
   * - Primary anchor: The neighbor toward the destination (lower index)
   * - Secondary anchor: The destination itself OR another known node toward destination
   *
   * This avoids using the requester as an anchor, since the requester may be
   * geographically far from the actual path to the destination.
   *
   * @param routePath - Array of node numbers in the route (full path including endpoints)
   * @param timestamp - Timestamp for the telemetry record
   * @param snrArray - Optional array of SNR values (raw, divide by 4 to get dB) for each hop
   */
  private async estimateIntermediatePositions(routePath: number[], timestamp: number, snrArray?: number[]): Promise<void> {
    // Time decay constant: half-life of 24 hours (in milliseconds)
    // After 24 hours, an old estimate has half the weight of a new one
    const HALF_LIFE_MS = 24 * 60 * 60 * 1000;
    const DECAY_CONSTANT = Math.LN2 / HALF_LIFE_MS;

    try {
      // For each intermediate node (excluding endpoints)
      for (let i = 1; i < routePath.length - 1; i++) {
        const nodeNum = routePath[i];
        const prevNodeNum = routePath[i - 1];
        const nextNodeNum = routePath[i + 1];

        let node = await databaseService.nodes.getNode(nodeNum);
        const prevNode = await databaseService.nodes.getNode(prevNodeNum);
        const nextNode = await databaseService.nodes.getNode(nextNodeNum);

        // Ensure the node exists in the database first (foreign key constraint).
        // Issue #2602: do NOT stamp lastHeard for intermediate hops we've never
        // actually heard from directly. Stamping it here used to make these stub
        // rows pass the activity-time filter used by the Virtual Node Server,
        // leaking "zombie" nodes onto connected Meshtastic clients.
        if (!node) {
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          await databaseService.nodes.upsertNode({
            nodeNum,
            nodeId,
            longName: `Node ${nodeId}`,
            shortName: nodeId.slice(-4)
          }, this.sourceId);
          node = await databaseService.nodes.getNode(nodeNum);
        }

        // Skip if node doesn't exist or has actual GPS position data
        if (!node || (node.latitude && node.longitude)) {
          continue;
        }

        // Use immediate neighbors in the traceroute as anchor points
        // prevNode is the neighbor at index i-1 (toward start of route)
        // nextNode is the neighbor at index i+1 (toward end of route)
        const prevHasPosition = prevNode?.latitude && prevNode?.longitude;
        const nextHasPosition = nextNode?.latitude && nextNode?.longitude;

        // Need both neighbors to have positions for estimation
        if (!prevHasPosition || !nextHasPosition) {
          continue;
        }

        const snrA = snrArray?.[i - 1]; // SNR from prevNode to this node
        const snrB = snrArray?.[i]; // SNR from this node to nextNode

        let newEstimateLat: number;
        let newEstimateLon: number;
        let weightingMethod = 'midpoint';

        // Apply SNR weighting if we have the data
        if (snrA !== undefined && snrB !== undefined) {
          // Convert raw SNR to dB (divide by 4)
          const snrADb = snrA / 4;
          const snrBDb = snrB / 4;

          // Use exponential weighting: 10^(SNR/10) gives relative signal strength
          // Higher SNR = stronger signal = likely closer to that node
          const weightA = Math.pow(10, snrADb / 10);
          const weightB = Math.pow(10, snrBDb / 10);
          const totalWeight = weightA + weightB;

          if (totalWeight > 0) {
            newEstimateLat = (prevNode.latitude! * weightA + nextNode.latitude! * weightB) / totalWeight;
            newEstimateLon = (prevNode.longitude! * weightA + nextNode.longitude! * weightB) / totalWeight;
            weightingMethod = `SNR-weighted (prev: ${snrADb.toFixed(1)}dB, next: ${snrBDb.toFixed(1)}dB)`;
          } else {
            // Fall back to midpoint if weights are invalid
            newEstimateLat = (prevNode.latitude! + nextNode.latitude!) / 2;
            newEstimateLon = (prevNode.longitude! + nextNode.longitude!) / 2;
          }
        } else {
          // Fall back to simple midpoint if no SNR data available
          newEstimateLat = (prevNode.latitude! + nextNode.latitude!) / 2;
          newEstimateLon = (prevNode.longitude! + nextNode.longitude!) / 2;
        }

        // Get previous estimates for time-weighted averaging
        const previousEstimates = await databaseService.getRecentEstimatedPositionsAsync(nodeNum, 10);
        const now = Date.now();

        let finalLat: number;
        let finalLon: number;

        if (previousEstimates.length > 0) {
          // Apply exponential time decay weighting
          // Weight = e^(-decay_constant * age_in_ms)
          // Newer estimates have higher weights
          let totalWeight = 0;
          let weightedLatSum = 0;
          let weightedLonSum = 0;

          // Add previous estimates with time decay
          for (const estimate of previousEstimates) {
            // estimate.timestamp is already in milliseconds (from telemetry table)
            const ageMs = now - estimate.timestamp;
            const weight = Math.exp(-DECAY_CONSTANT * ageMs);
            totalWeight += weight;
            weightedLatSum += estimate.latitude * weight;
            weightedLonSum += estimate.longitude * weight;
          }

          // Add new estimate with weight 1.0 (it's the most recent)
          const newEstimateWeight = 1.0;
          totalWeight += newEstimateWeight;
          weightedLatSum += newEstimateLat * newEstimateWeight;
          weightedLonSum += newEstimateLon * newEstimateWeight;

          // Calculate weighted average
          finalLat = weightedLatSum / totalWeight;
          finalLon = weightedLonSum / totalWeight;
          weightingMethod += `, aggregated from ${previousEstimates.length + 1} traceroutes`;
        } else {
          // No previous estimates, use the new estimate directly
          finalLat = newEstimateLat;
          finalLon = newEstimateLon;
        }

        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;

        // Store estimated position as telemetry with a special type prefix
        await databaseService.telemetry.insertTelemetry({
          nodeId,
          nodeNum,
          telemetryType: 'estimated_latitude',
          timestamp,
          value: finalLat,
          unit: '° (est)',
          createdAt: now
        }, this.sourceId);

        await databaseService.telemetry.insertTelemetry({
          nodeId,
          nodeNum,
          telemetryType: 'estimated_longitude',
          timestamp,
          value: finalLon,
          unit: '° (est)',
          createdAt: now
        }, this.sourceId);

        logger.debug(`📍 Estimated position for ${nodeId} (${node.longName || nodeId}): ${finalLat.toFixed(6)}, ${finalLon.toFixed(6)} (${weightingMethod})`);
      }
    } catch (error) {
      logger.error('❌ Error estimating intermediate positions:', error);
    }
  }

  /**
   * Process NeighborInfo protobuf message
   */
  private async processNeighborInfoProtobuf(meshPacket: any, neighborInfo: any): Promise<void> {
    try {
      const fromNum = Number(meshPacket.from);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;

      logger.info(`🏠 Neighbor info received from ${fromNodeId}:`, neighborInfo);

      // Skip MQTT-sourced neighbor info - it represents remote mesh topology, not local connections
      if (meshPacket.viaMqtt || isViaMqtt(meshPacket.transportMechanism)) {
        logger.debug(`📡 Skipping MQTT-sourced neighbor info from ${fromNodeId}`);
        return;
      }

      // Get the sender node to determine their hopsAway
      let senderNode = await databaseService.nodes.getNode(fromNum);

      // Ensure sender node exists in database
      if (!senderNode) {
        await databaseService.nodes.upsertNode({
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
        logger.info(`📡 Processing ${neighborInfo.neighbors.length} neighbors from ${fromNodeId}`);

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
            await databaseService.nodes.upsertNode({
              nodeNum: vn.nodeNum,
              nodeId: neighborNodeId,
              longName: `Node ${neighborNodeId}`,
              shortName: neighborNodeId.slice(-4),
              hopsAway: senderHopsAway + 1,
            }, this.sourceId);
            logger.info(`➕ Created new node ${neighborNodeId} with hopsAway=${senderHopsAway + 1} (no lastHeard — indirectly discovered)`);
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
            logger.info(`🔒 Node ${nodeId} favoriteLocked — preserving DB isFavorite=${existingNode.isFavorite}, re-syncing to device (device reported ${nodeInfo.isFavorite})`);
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
      // This ensures ignored nodes are updated when reconnecting
      if (nodeInfo.isIgnored !== undefined) {
        nodeData.isIgnored = nodeInfo.isIgnored;
        if (existingNode && existingNode.isIgnored !== nodeInfo.isIgnored) {
          logger.debug(`🚫 Updating ignored status for node ${nodeId} from ${existingNode.isIgnored} to ${nodeInfo.isIgnored}`);
        }
      }

      // Add user information if available
      if (nodeInfo.user) {
        nodeData.longName = nodeInfo.user.longName;
        nodeData.shortName = nodeInfo.user.shortName;
        nodeData.hwModel = nodeInfo.user.hwModel;
        nodeData.role = nodeInfo.user.role;

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
          const existingNode = await databaseService.nodes.getNode(Number(nodeInfo.num));

          // --- Check if device sync resolves a key mismatch ---
          let mismatchResolved = false;

          if (existingNode?.keyMismatchDetected && existingNode.lastMeshReceivedKey) {
            if (deviceSyncKey === existingNode.lastMeshReceivedKey) {
              // Device now has the same key as the mesh broadcast — mismatch resolved!
              logger.info(`🔐 Key mismatch RESOLVED via device sync for ${nodeId}: device key matches mesh key`);
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

        // Validate coordinates before saving
        if (this.isValidPosition(coords.latitude, coords.longitude)) {
          nodeData.latitude = coords.latitude;
          nodeData.longitude = coords.longitude;
          nodeData.altitude = nodeInfo.position.altitude;

          // Extract position precision if available in NodeInfo
          // NodeInfo.position may have precisionBits from the original Position packet
          // Note: precisionBits=0 means "no precision data" and should trigger channel fallback
          let precisionBits = nodeInfo.position.precisionBits ?? nodeInfo.position.precision_bits ?? undefined;
          const channelIndex = nodeInfo.channel !== undefined ? nodeInfo.channel : 0;

          // Fall back to channel's positionPrecision if not in position data
          // Also fall back if precisionBits is 0 (which means no precision was set)
          if (precisionBits === undefined || precisionBits === 0) {
            const channel = await databaseService.channels.getChannelById(channelIndex, this.sourceId);
            if (channel && channel.positionPrecision !== undefined && channel.positionPrecision !== null && channel.positionPrecision > 0) {
              precisionBits = channel.positionPrecision;
              logger.debug(`🗺️ NodeInfo for ${nodeId}: using channel ${channelIndex} positionPrecision (${precisionBits}) as fallback`);
            }
          }

          // Save position precision metadata
          if (precisionBits !== undefined) {
            nodeData.positionPrecisionBits = precisionBits;
            nodeData.positionChannel = channelIndex;
            nodeData.positionTimestamp = Date.now();
          }

          // Store position telemetry data to be inserted after node is created
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
            logger.info(`📱 Local node name updated: "${this.localNodeInfo.longName}" → "${nodeInfo.user.longName}" (${nodeInfo.user.shortName})`);
          }
          this.localNodeInfo.longName = nodeInfo.user.longName;
          this.localNodeInfo.shortName = nodeInfo.user.shortName;
          this.localNodeInfo.isLocked = true;  // Lock it now that we have complete info
          logger.debug(`📱 Local node: ${nodeInfo.user.longName} (${nodeInfo.user.shortName}) - LOCKED`);
        }
      }

      // Upsert node first to ensure it exists before inserting telemetry
      await databaseService.nodes.upsertNode(nodeData, this.sourceId);

      // Emit WebSocket event for node update
      dataEventEmitter.emitNodeUpdate(Number(nodeInfo.num), nodeData, this.sourceId);

      logger.debug(`🏠 Updated node info: ${nodeData.longName || nodeId}`);

      // Now insert position telemetry if we have it (after node exists in database)
      if (positionTelemetryData) {
        const now = Date.now();
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'latitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.latitude, unit: '°', createdAt: now,
          channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
        }, this.sourceId);
        await databaseService.telemetry.insertTelemetry({
          nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'longitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.longitude, unit: '°', createdAt: now,
          channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
        }, this.sourceId);
        if (positionTelemetryData.altitude !== undefined && positionTelemetryData.altitude !== null) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'altitude',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.altitude, unit: 'm', createdAt: now,
            channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
          }, this.sourceId);
        }
        // Store ground speed if available (in m/s)
        if (positionTelemetryData.groundSpeed !== undefined && positionTelemetryData.groundSpeed > 0) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'ground_speed',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.groundSpeed, unit: 'm/s', createdAt: now,
            channel: positionTelemetryData.channel
          }, this.sourceId);
        }
        // Store ground track/heading if available (in 1/100 degrees, convert to degrees)
        if (positionTelemetryData.groundTrack !== undefined && positionTelemetryData.groundTrack > 0) {
          const headingDegrees = positionTelemetryData.groundTrack / 100;
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'ground_track',
            timestamp: positionTelemetryData.timestamp, value: headingDegrees, unit: '°', createdAt: now,
            channel: positionTelemetryData.channel
          }, this.sourceId);
        }

        // Update mobility detection for this node (fire and forget)
        databaseService.updateNodeMobilityAsync(nodeId).catch(err =>
          logger.error(`Failed to update mobility for ${nodeId}:`, err)
        );
      }

      // Insert device metrics telemetry if we have it (after node exists in database)
      if (deviceMetricsTelemetryData) {
        const now = Date.now();

        if (deviceMetricsTelemetryData.batteryLevel !== undefined && deviceMetricsTelemetryData.batteryLevel !== null && !isNaN(deviceMetricsTelemetryData.batteryLevel)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'batteryLevel',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.batteryLevel, unit: '%', createdAt: now
          }, this.sourceId);
        }

        if (deviceMetricsTelemetryData.voltage !== undefined && deviceMetricsTelemetryData.voltage !== null && !isNaN(deviceMetricsTelemetryData.voltage)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'voltage',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.voltage, unit: 'V', createdAt: now
          }, this.sourceId);
        }

        if (deviceMetricsTelemetryData.channelUtilization !== undefined && deviceMetricsTelemetryData.channelUtilization !== null && !isNaN(deviceMetricsTelemetryData.channelUtilization)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'channelUtilization',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.channelUtilization, unit: '%', createdAt: now
          }, this.sourceId);
        }

        if (deviceMetricsTelemetryData.airUtilTx !== undefined && deviceMetricsTelemetryData.airUtilTx !== null && !isNaN(deviceMetricsTelemetryData.airUtilTx)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'airUtilTx',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.airUtilTx, unit: '%', createdAt: now
          }, this.sourceId);
        }

        if (deviceMetricsTelemetryData.uptimeSeconds !== undefined && deviceMetricsTelemetryData.uptimeSeconds !== null && !isNaN(deviceMetricsTelemetryData.uptimeSeconds)) {
          await databaseService.telemetry.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'uptimeSeconds',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.uptimeSeconds, unit: 's', createdAt: now
          }, this.sourceId);
        }
      }

      // Save SNR as telemetry if present in NodeInfo
      if (nodeInfo.snr != null && nodeInfo.snr !== -128) {
        const timestamp = nodeInfo.lastHeard ? Number(nodeInfo.lastHeard) * 1000 : Date.now();
        const now = Date.now();

        // Save SNR telemetry with same logic as packet processing:
        // Save if it has changed OR if 10+ minutes have passed since last save
        const latestSnrTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'snr_remote');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveSnr = !latestSnrTelemetry ||
                              latestSnrTelemetry.value !== nodeInfo.snr ||
                              (now - latestSnrTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveSnr) {
          await databaseService.telemetry.insertTelemetry({
            nodeId,
            nodeNum: Number(nodeInfo.num),
            telemetryType: 'snr_remote',
            timestamp,
            value: nodeInfo.snr,
            unit: 'dB',
            createdAt: now
          }, this.sourceId);
          const reason = !latestSnrTelemetry ? 'initial' :
                        latestSnrTelemetry.value !== nodeInfo.snr ? 'changed' : 'periodic';
          logger.debug(`📊 Saved remote SNR telemetry from NodeInfo: ${nodeInfo.snr} dB (${reason}, previous: ${latestSnrTelemetry?.value || 'N/A'})`);
        }
      }
    } catch (error) {
      logger.error('❌ Error processing NodeInfo protobuf:', error);
    }
  }


  // Configuration retrieval methods
  async getDeviceConfig(): Promise<any> {
    // Return config data from what we've received via TCP stream
    logger.debug('🔍 getDeviceConfig called - actualDeviceConfig.lora present:', !!this.actualDeviceConfig?.lora);
    logger.debug('🔍 getDeviceConfig called - actualModuleConfig present:', !!this.actualModuleConfig);

    if (this.actualDeviceConfig?.lora || this.actualModuleConfig) {
      logger.debug('Using actualDeviceConfig:', JSON.stringify(this.actualDeviceConfig, null, 2));
      logger.debug('✅ Returning device config from actualDeviceConfig');
      return await this.buildDeviceConfigFromActual();
    }

    logger.info('⚠️ No device config available yet - returning null');
    logger.debug('No device config available yet');
    return null;
  }

  /**
   * Calculate LoRa frequency from region and channel number (frequency slot)
   * Delegates to the utility function for better testability
   */
  private calculateLoRaFrequency(region: number, channelNum: number, overrideFrequency: number, frequencyOffset: number, bandwidth: number = 250, channelName?: string, modemPreset?: number): string {
    return calculateLoRaFrequency(region, channelNum, overrideFrequency, frequencyOffset, bandwidth, channelName, modemPreset);
  }

  private async buildDeviceConfigFromActual(): Promise<any> {
    const dbChannels = await databaseService.channels.getAllChannels(this.sourceId);
    const channels = dbChannels.map(ch => ({
      index: ch.id,
      name: ch.name,
      psk: ch.psk ? 'Set' : 'None',
      role: ch.role,
      uplinkEnabled: ch.uplinkEnabled,
      downlinkEnabled: ch.downlinkEnabled,
      positionPrecision: ch.positionPrecision
    }));

    const localNode = this.localNodeInfo as any;

    // Extract actual values from stored config or use sensible defaults
    const loraConfig = this.actualDeviceConfig?.lora || {};
    const mqttConfig = this.actualModuleConfig?.mqtt || {};

    // IMPORTANT: Proto3 may omit boolean false and numeric 0 values from JSON serialization
    // but they're still accessible as properties. We need to explicitly include them.
    const loraConfigWithDefaults = {
      ...loraConfig,
      // Ensure usePreset is explicitly set (Proto3 default is false)
      usePreset: loraConfig.usePreset !== undefined ? loraConfig.usePreset : false,
      // Ensure frequencyOffset is explicitly set (Proto3 default is 0)
      frequencyOffset: loraConfig.frequencyOffset !== undefined ? loraConfig.frequencyOffset : 0,
      // Ensure overrideFrequency is explicitly set (Proto3 default is 0)
      overrideFrequency: loraConfig.overrideFrequency !== undefined ? loraConfig.overrideFrequency : 0,
      // Ensure modemPreset is explicitly set (Proto3 default is 0 = LONG_FAST)
      modemPreset: loraConfig.modemPreset !== undefined ? loraConfig.modemPreset : 0,
      // Ensure channelNum is explicitly set (Proto3 default is 0)
      channelNum: loraConfig.channelNum !== undefined ? loraConfig.channelNum : 0
    };

    // Apply same Proto3 handling to MQTT config
    const mqttConfigWithDefaults = {
      ...mqttConfig,
      // Ensure boolean fields are explicitly set (Proto3 default is false)
      enabled: mqttConfig.enabled !== undefined ? mqttConfig.enabled : false,
      encryptionEnabled: mqttConfig.encryptionEnabled !== undefined ? mqttConfig.encryptionEnabled : false,
      jsonEnabled: mqttConfig.jsonEnabled !== undefined ? mqttConfig.jsonEnabled : false,
      tlsEnabled: mqttConfig.tlsEnabled !== undefined ? mqttConfig.tlsEnabled : false,
      proxyToClientEnabled: mqttConfig.proxyToClientEnabled !== undefined ? mqttConfig.proxyToClientEnabled : false,
      mapReportingEnabled: mqttConfig.mapReportingEnabled !== undefined ? mqttConfig.mapReportingEnabled : false
    };

    logger.debug('🔍 loraConfig being used:', JSON.stringify(loraConfigWithDefaults, null, 2));
    logger.debug('🔍 mqttConfig being used:', JSON.stringify(mqttConfigWithDefaults, null, 2));

    // Map region enum values to strings
    const regionMap: { [key: number]: string } = {
      0: 'UNSET',
      1: 'US',
      2: 'EU_433',
      3: 'EU_868',
      4: 'CN',
      5: 'JP',
      6: 'ANZ',
      7: 'KR',
      8: 'TW',
      9: 'RU',
      10: 'IN',
      11: 'NZ_865',
      12: 'TH',
      13: 'LORA_24',
      14: 'UA_433',
      15: 'UA_868'
    };

    // Map modem preset enum values to strings
    const modemPresetMap: { [key: number]: string } = {
      0: 'Long Fast',
      1: 'Long Slow',
      2: 'Very Long Slow',
      3: 'Medium Slow',
      4: 'Medium Fast',
      5: 'Short Slow',
      6: 'Short Fast',
      7: 'Long Moderate',
      8: 'Short Turbo'
    };

    // Convert enum values to human-readable strings
    const regionValue = typeof loraConfigWithDefaults.region === 'number' ? regionMap[loraConfigWithDefaults.region] || `Unknown (${loraConfigWithDefaults.region})` : loraConfigWithDefaults.region || 'Unknown';
    const modemPresetValue = typeof loraConfigWithDefaults.modemPreset === 'number' ? modemPresetMap[loraConfigWithDefaults.modemPreset] || `Unknown (${loraConfigWithDefaults.modemPreset})` : loraConfigWithDefaults.modemPreset || 'Unknown';

    return {
      basic: {
        nodeAddress: (await this.getConfig()).nodeIp,
        tcpPort: (await this.getConfig()).tcpPort,
        connected: this.isConnected,
        nodeId: localNode?.nodeId || null,
        nodeName: localNode?.longName || null,
        firmwareVersion: localNode?.firmwareVersion || null
      },
      radio: {
        region: regionValue,
        modemPreset: modemPresetValue,
        hopLimit: loraConfigWithDefaults.hopLimit !== undefined ? loraConfigWithDefaults.hopLimit : 'Unknown',
        txPower: loraConfigWithDefaults.txPower !== undefined ? loraConfigWithDefaults.txPower : 'Unknown',
        bandwidth: loraConfigWithDefaults.bandwidth || 'Unknown',
        spreadFactor: loraConfigWithDefaults.spreadFactor || 'Unknown',
        codingRate: loraConfigWithDefaults.codingRate || 'Unknown',
        channelNum: loraConfigWithDefaults.channelNum !== undefined ? loraConfigWithDefaults.channelNum : 'Unknown',
        frequency: this.calculateLoRaFrequency(
          typeof loraConfigWithDefaults.region === 'number' ? loraConfigWithDefaults.region : 0,
          loraConfigWithDefaults.channelNum !== undefined ? loraConfigWithDefaults.channelNum : 0,
          loraConfigWithDefaults.overrideFrequency !== undefined ? loraConfigWithDefaults.overrideFrequency : 0,
          loraConfigWithDefaults.frequencyOffset !== undefined ? loraConfigWithDefaults.frequencyOffset : 0,
          typeof loraConfigWithDefaults.bandwidth === 'number' && loraConfigWithDefaults.bandwidth > 0 ? loraConfigWithDefaults.bandwidth : 250,
          dbChannels.find(ch => ch.id === 0)?.name || undefined,
          typeof loraConfigWithDefaults.modemPreset === 'number' ? loraConfigWithDefaults.modemPreset : undefined
        ),
        txEnabled: loraConfigWithDefaults.txEnabled !== undefined ? loraConfigWithDefaults.txEnabled : 'Unknown',
        sx126xRxBoostedGain: loraConfigWithDefaults.sx126xRxBoostedGain !== undefined ? loraConfigWithDefaults.sx126xRxBoostedGain : 'Unknown',
        configOkToMqtt: loraConfigWithDefaults.configOkToMqtt !== undefined ? loraConfigWithDefaults.configOkToMqtt : 'Unknown'
      },
      mqtt: {
        enabled: mqttConfigWithDefaults.enabled,
        server: mqttConfigWithDefaults.address || 'Not configured',
        username: mqttConfigWithDefaults.username || 'Not set',
        encryption: mqttConfigWithDefaults.encryptionEnabled,
        json: mqttConfigWithDefaults.jsonEnabled,
        tls: mqttConfigWithDefaults.tlsEnabled,
        rootTopic: mqttConfigWithDefaults.root || 'msh'
      },
      channels: channels.length > 0 ? channels : [
        { index: 0, name: 'Primary', psk: 'None', uplinkEnabled: true, downlinkEnabled: true }
      ],
      // Raw LoRa config for export/import functionality - now includes Proto3 defaults
      lora: Object.keys(loraConfigWithDefaults).length > 0 ? loraConfigWithDefaults : undefined
    };
  }

  async sendTextMessage(text: string, channel: number = 0, destination?: number, replyId?: number, emoji?: number, userId?: number): Promise<number> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      // Apply homoglyph optimization if enabled (replace Cyrillic look-alikes with Latin to save bytes)
      if (await databaseService.settings.getSetting('homoglyphEnabled') === 'true') {
        text = applyHomoglyphOptimization(text);
      }

      // For DMs, check if the target node has a public key — if so, request PKI encryption.
      // The firmware handles the actual crypto, but for serial/TCP connections it only
      // PKI-encrypts when the packet explicitly has pkiEncrypted=true.
      let pkiEncrypted = false;
      if (destination) {
        try {
          const targetNode = await databaseService.nodes.getNode(destination, this.sourceId);
          if (targetNode?.publicKey) {
            pkiEncrypted = true;
            logger.debug(`🔐 DM to !${destination.toString(16).padStart(8, '0')} — requesting PKI encryption (node has public key)`);
          }
        } catch {
          // If lookup fails, send without PKI — firmware will use channel encryption
        }
      }

      const { data: textMessageData, messageId } = meshtasticProtobufService.createTextMessage(text, destination, channel, replyId, emoji, pkiEncrypted);

      await this.transport.send(textMessageData);

      // Log message sending at INFO level for production visibility
      const destinationInfo = destination ? `node !${destination.toString(16).padStart(8, '0')}` : `channel ${channel}`;
      logger.info(`📤 Sent message to ${destinationInfo}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (ID: ${messageId})`);
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
          createdAt: Date.now()
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

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      const tracerouteData = meshtasticProtobufService.createTracerouteMessage(destination, channel);

      logger.info(`🔍 Traceroute packet created: ${tracerouteData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}`);

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
      logger.info(`📤 Traceroute request sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

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

      logger.info(`📍 Position exchange: fixedPosition=${hasFixedPosition}, gpsMode=${positionConfig?.gpsMode}, hasValidPositionSource=${hasValidPositionSource}, willSendPosition=${!!localPosition}`);

      const { data: positionRequestData, packetId, requestId } = meshtasticProtobufService.createPositionRequestMessage(
        destination,
        channel,
        localPosition
      );

      logger.info(`📍 Position exchange packet created: ${positionRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}, position=${localPosition ? `${localPosition.latitude},${localPosition.longitude}` : 'none'}`);

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

      logger.info(`📤 Position exchange sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

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

      logger.info(`📇 NodeInfo exchange packet created: ${nodeInfoRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}, userInfo=${localUserInfo ? localUserInfo.longName : 'none'}`);

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

      logger.info(`📤 NodeInfo exchange sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

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

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      const { data: neighborInfoRequestData, packetId, requestId } = meshtasticProtobufService.createNeighborInfoRequestMessage(
        destination,
        channel
      );

      logger.info(`🏠 NeighborInfo request packet created: ${neighborInfoRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}`);

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

      logger.info(`📤 NeighborInfo request sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

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
   * Send a telemetry request to a remote node
   * This sends an empty telemetry packet with wantResponse=true to request telemetry data
   */
  async sendTelemetryRequest(
    destination: number,
    channel: number = 0,
    telemetryType?: 'device' | 'environment' | 'airQuality' | 'power'
  ): Promise<{ packetId: number; requestId: number }> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
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
      logger.info(`📊 Telemetry request packet created: ${telemetryRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, type=${typeLabel}, packetId=${packetId}, requestId=${requestId}`);

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

      logger.info(`📤 Telemetry request (${typeLabel}) sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing Telemetry request to packet monitor
      await this.logOutgoingPacket(
        67, // TELEMETRY_APP
        destination,
        channel,
        `Telemetry request (${typeLabel}) to !${destination.toString(16).padStart(8, '0')}`,
        { destination, telemetryType: typeLabel, packetId, requestId }
      );

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
    logger.info(`📢 Broadcasting NodeInfo on channel ${channel}`);
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

    logger.info(`📢 Starting NodeInfo broadcast to ${channels.length} channel(s) with ${delaySeconds}s delay`);

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      try {
        await this.broadcastNodeInfoToChannel(channel);
        logger.info(`📢 NodeInfo broadcast sent to channel ${channel} (${i + 1}/${channels.length})`);

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

    logger.info(`📢 NodeInfo broadcast complete for all ${channels.length} channel(s)`);
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

      logger.info(`📊 LocalStats request packet created: ${telemetryRequestData.length} bytes for local node ${this.localNodeInfo.nodeId}, packetId=${packetId}, requestId=${requestId}`);

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

      logger.info(`📤 LocalStats request sent to local node ${this.localNodeInfo.nodeId}`);
      return { packetId, requestId };
    } catch (error) {
      logger.error('Error requesting LocalStats:', error);
      throw error;
    }
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

      // Skip non-text messages (telemetry, traceroutes, etc.)
      if (message.portnum !== 1) { // 1 = TEXT_MESSAGE_APP
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

      // Check channel-specific settings
      const autoAckChannels = await settings.getSettingForSource(sourceId, 'autoAckChannels');
      const autoAckDirectMessages = await settings.getSettingForSource(sourceId, 'autoAckDirectMessages');
      const autoAckIgnoredNodes = await settings.getSettingForSource(sourceId, 'autoAckIgnoredNodes');

      // Parse enabled channels (comma-separated list of channel indices)
      const enabledChannels = autoAckChannels
        ? autoAckChannels.split(',').map(c => parseInt(c.trim())).filter(n => !isNaN(n))
        : [];
      const dmEnabled = autoAckDirectMessages === 'true';

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

      // Check if auto-ack is enabled for this channel/DM
      if (isDirectMessage) {
        if (!dmEnabled) {
          logger.debug('⏭️  Skipping auto-acknowledge for direct message (DM auto-ack disabled)');
          return;
        }
      } else {
        // Use Set for O(1) lookup performance
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
          regex = new RegExp(regexPattern, 'i');
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

      // Determine if this is a direct message (0 hops) or multi-hop
      // MQTT-relayed packets are never "direct" even with 0 hops — they traversed
      // the internet, not a direct RF link, so RF metrics (SNR/RSSI) are meaningless
      const isDirect = hopsTraveled === 0 && message.viaMqtt !== true;

      // Check if this message type is enabled
      const typeEnabled = isDirect
        ? await settings.getSettingForSource(sourceId, 'autoAckDirectEnabled') !== 'false'
        : await settings.getSettingForSource(sourceId, 'autoAckMultihopEnabled') !== 'false';

      if (!typeEnabled) {
        logger.debug(`⏭️ Skipping auto-acknowledge: ${isDirect ? 'direct' : 'multihop'} messages disabled`);
        return;
      }

      // Get tapback/reply settings for this message type
      const autoAckTapbackEnabled = isDirect
        ? await settings.getSettingForSource(sourceId, 'autoAckDirectTapbackEnabled') !== 'false'
        : await settings.getSettingForSource(sourceId, 'autoAckMultihopTapbackEnabled') !== 'false';

      const autoAckReplyEnabled = isDirect
        ? await settings.getSettingForSource(sourceId, 'autoAckDirectReplyEnabled') !== 'false'
        : await settings.getSettingForSource(sourceId, 'autoAckMultihopReplyEnabled') !== 'false';

      // If neither tapback nor reply is enabled for this type, skip
      if (!autoAckTapbackEnabled && !autoAckReplyEnabled) {
        logger.debug(`⏭️ Skipping auto-acknowledge: both tapback and reply are disabled for ${isDirect ? 'direct' : 'multihop'} messages`);
        return;
      }

      // Check if we should always use DM
      const autoAckUseDM = await settings.getSettingForSource(sourceId, 'autoAckUseDM');
      const alwaysUseDM = autoAckUseDM === 'true';

      // Format target for logging
      const target = (alwaysUseDM || isDirectMessage)
        ? `!${fromNum.toString(16).padStart(8, '0')}`
        : `channel ${channelIndex}`;

      // Send tapback with hop count emoji if enabled
      // Note: packetId can be 0 (valid unsigned integer), so check for null/undefined explicitly
      if (autoAckTapbackEnabled && packetId != null) {
        // Hop count emojis: *️⃣ for 0 (direct), 1️⃣-7️⃣ for 1-7+ hops
        const HOP_COUNT_EMOJIS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
        const hopEmojiIndex = Math.min(hopsTraveled, 7); // Cap at 7 for 7+ hops
        const hopEmoji = HOP_COUNT_EMOJIS[hopEmojiIndex];

        logger.debug(`🤖 Auto-acknowledging with tapback ${hopEmoji} (${hopsTraveled} hops) to ${target}`);

        // Route tapback through message queue for rate limiting
        this.messageQueue.enqueue(
          hopEmoji,
          isDirectMessage ? fromNum : 0, // destination: node number for DM, 0 for channel
          packetId, // replyId - react to the original message
          () => {
            logger.info(`✅ Auto-acknowledge tapback ${hopEmoji} delivered to ${target}`);
          },
          (reason: string) => {
            logger.warn(`❌ Auto-acknowledge tapback failed to ${target}: ${reason}`);
          },
          isDirectMessage ? undefined : channelIndex, // channel
          1, // maxAttempts - tapbacks are best-effort, don't retry
          1 // emoji flag = 1 for tapback/reaction
        );
      }

      // Send message reply if enabled
      if (autoAckReplyEnabled) {
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
        const ackText = await this.replaceAcknowledgementTokens(autoAckMessage, message.fromNodeId, fromNum, hopsTraveled, receivedDate, receivedTime, channelIndex, isDirectMessage, rxSnr, rxRssi, message.viaMqtt);

        // Don't make it a reply if we're changing channels (DM when triggered by channel message)
        const replyId = (alwaysUseDM && !isDirectMessage) ? undefined : packetId;

        logger.debug(`🤖 Auto-acknowledging message from ${message.fromNodeId}: "${messageText}" with "${ackText}" ${alwaysUseDM ? '(via DM)' : ''}`);

        // Use message queue to send auto-acknowledge with rate limiting and retry logic
        this.messageQueue.enqueue(
          ackText,
          (alwaysUseDM || isDirectMessage) ? fromNum : 0, // destination: node number for DM, 0 for channel
          replyId, // replyId
          () => {
            logger.info(`✅ Auto-acknowledge message delivered to ${target}`);
          },
          (reason: string) => {
            logger.warn(`❌ Auto-acknowledge message failed to ${target}: ${reason}`);
          },
          (alwaysUseDM || isDirectMessage) ? undefined : channelIndex // channel: undefined for DM, channel number for channel
        );
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
   * Handles both development (relative path) and production (absolute path) environments.
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
      // In development, use relative path from project root
      const projectRoot = path.resolve(process.cwd());
      scriptsDir = path.join(projectRoot, 'data', 'scripts');
      
      // Ensure directory exists
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
        logger.debug(`📁 Created scripts directory: ${scriptsDir}`);
      }
    } else {
      // In production, use absolute path
      scriptsDir = '/data/scripts';
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

    const fromNum = message.fromNodeNum;
    const channelIndex = message.channel ?? 0;

    if (pingStopMatch) {
      // Handle "ping stop"
      const session = this.autoPingSessions.get(fromNum);
      if (session) {
        logger.info(`🛑 Auto-ping stop requested by !${fromNum.toString(16).padStart(8, '0')}`);
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
        timer: null,
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

      logger.info(`📡 Auto-ping session started for !${fromNum.toString(16).padStart(8, '0')}: ${actualCount} pings every ${intervalSeconds}s`);

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
      this.sendNextAutoPing(session);
    }, session.intervalMs);
  }

  /**
   * Send the next ping in the auto-ping session
   */
  private async sendNextAutoPing(session: AutoPingSession): Promise<void> {
    // Check if session is complete — send summary as the final message
    if (session.completedPings >= session.totalPings) {
      this.finalizeAutoPingSession(session.requestedBy);
      return;
    }

    // Don't send another ping if one is still pending
    if (session.pendingRequestId !== null) {
      return;
    }

    try {
      const pingNum = session.completedPings + 1;
      const pingMessage = `Ping ${pingNum}/${session.totalPings}`;

      const requestId = await this.sendTextMessage(pingMessage, 0, session.requestedBy);
      this.messageQueue.recordExternalSend();
      session.pendingRequestId = requestId;
      session.lastPingSentAt = Date.now();

      logger.debug(`📡 Auto-ping ${pingNum}/${session.totalPings} sent to !${session.requestedBy.toString(16).padStart(8, '0')} (requestId: ${requestId})`);

      // Set timeout for this ping
      const timeoutSeconds = parseInt((await databaseService.settings.getSettingForSource(this.sourceId, 'autoPingTimeoutSeconds')) || '60', 10);
      session.pendingTimeout = setTimeout(() => {
        this.handleAutoPingTimeout(session);
      }, timeoutSeconds * 1000);
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
    }
  }

  /**
   * Handle an ACK or NAK response for a pending auto-ping
   */
  handleAutoPingResponse(requestId: number, status: 'ack' | 'nak'): void {
    // Find session with matching pendingRequestId
    for (const [nodeNum, session] of this.autoPingSessions) {
      if (session.pendingRequestId === requestId) {
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

        logger.info(`📡 Auto-ping ${session.completedPings}/${session.totalPings} ${status.toUpperCase()} from !${nodeNum.toString(16).padStart(8, '0')} (${durationMs}ms)`);

        this.emitAutoPingUpdate(session, 'ping_result').catch(err => logger.error('Error emitting auto-ping update:', err));

        // Session completion is handled by the next interval tick in sendNextAutoPing
        return;
      }
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

    logger.info(`⏰ Auto-ping ${session.completedPings}/${session.totalPings} TIMEOUT for !${session.requestedBy.toString(16).padStart(8, '0')}`);

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

    logger.info(`✅ Auto-ping session completed for !${requestedBy.toString(16).padStart(8, '0')}: ${session.successfulPings}/${session.totalPings} successful`);
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

    logger.info(`🛑 Auto-ping session ${reason} for !${requestedBy.toString(16).padStart(8, '0')}`);
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

      // Normalize message text through homoglyph mapping so triggers match regardless of
      // whether the sender applied homoglyph optimization (Cyrillic→Latin substitution).
      // This ensures "Москва" and "Mocквa" both match the same trigger pattern.
      const normalizedText = applyHomoglyphOptimization(message.text);

      logger.info(`🤖 Auto-responder checking message on ${isDirectMessage ? 'DM' : `channel ${message.channel}`}: "${message.text}"`);

      // Try to match message against triggers
      for (let triggerIdx = 0; triggerIdx < triggers.length; triggerIdx++) {
        const trigger = triggers[triggerIdx];
        // Normalize trigger channels (handles legacy single channel and new multi-channel array format)
        const triggerChannels = normalizeTriggerChannels(trigger);

        logger.info(`🤖 Checking trigger "${trigger.trigger}" (channels: ${triggerChannels.join('+')}) against message on ${isDirectMessage ? 'DM' : `channel ${message.channel}`}`);

        // Check if this trigger applies to the current message's channel
        if (isDirectMessage) {
          // For DMs, only match triggers that include 'dm' in their channels
          if (!triggerChannels.includes('dm')) {
            logger.info(`⏭️  Skipping trigger "${trigger.trigger}" - not configured for DM (channels: ${triggerChannels.join('+')})`);
            continue;
          }
        } else {
          // For channel messages, only match triggers that include this channel number
          if (!triggerChannels.includes(message.channel)) {
            logger.info(`⏭️  Skipping trigger "${trigger.trigger}" - not configured for channel ${message.channel} (channels: ${triggerChannels.join('+')})`);
            continue;
          }
        }

        // Handle both string and array types for trigger.trigger
        const patterns = normalizeTriggerPatterns(trigger.trigger);
        let matchedPattern: string | null = null;
        let extractedParams: Record<string, string> = {};

        // Try each pattern until one matches
        for (const origPatternStr of patterns) {
          // Normalize trigger pattern through homoglyph mapping to match normalized message text
          const patternStr = applyHomoglyphOptimization(origPatternStr);
          // Extract parameters with optional regex patterns from trigger pattern
          interface ParamSpec {
            name: string;
            pattern?: string;
          }
          const params: ParamSpec[] = [];
          let i = 0;

          while (i < patternStr.length) {
            if (patternStr[i] === '{') {
              const startPos = i + 1;
              let depth = 1;
              let colonPos = -1;
              let endPos = -1;

              // Find the matching closing brace, accounting for nested braces in regex patterns
              for (let j = startPos; j < patternStr.length && depth > 0; j++) {
                if (patternStr[j] === '{') {
                  depth++;
                } else if (patternStr[j] === '}') {
                  depth--;
                  if (depth === 0) {
                    endPos = j;
                  }
                } else if (patternStr[j] === ':' && depth === 1 && colonPos === -1) {
                  colonPos = j;
                }
              }

              if (endPos !== -1) {
                const paramName = colonPos !== -1
                  ? patternStr.substring(startPos, colonPos)
                  : patternStr.substring(startPos, endPos);
                const paramPattern = colonPos !== -1
                  ? patternStr.substring(colonPos + 1, endPos)
                  : undefined;

                if (!params.find(p => p.name === paramName)) {
                  params.push({ name: paramName, pattern: paramPattern });
                }

                i = endPos + 1;
              } else {
                i++;
              }
            } else {
              i++;
            }
          }

          // Build regex pattern from trigger by processing it character by character
          let pattern = '';
          const replacements: Array<{ start: number; end: number; replacement: string }> = [];
          i = 0;

          while (i < patternStr.length) {
            if (patternStr[i] === '{') {
              const startPos = i;
              let depth = 1;
              let endPos = -1;

              // Find the matching closing brace
              for (let j = i + 1; j < patternStr.length && depth > 0; j++) {
                if (patternStr[j] === '{') {
                  depth++;
                } else if (patternStr[j] === '}') {
                  depth--;
                  if (depth === 0) {
                    endPos = j;
                  }
                }
              }

              if (endPos !== -1) {
                const paramIndex = replacements.length;
                if (paramIndex < params.length) {
                  const paramRegex = params[paramIndex].pattern || '[^\\s]+';
                  replacements.push({
                    start: startPos,
                    end: endPos + 1,
                    replacement: `(${paramRegex})`
                  });
                }
                i = endPos + 1;
              } else {
                i++;
              }
            } else {
              i++;
            }
          }

          // Build the final pattern by replacing placeholders
          for (let i = 0; i < patternStr.length; i++) {
            const replacement = replacements.find(r => r.start === i);
            if (replacement) {
              pattern += replacement.replacement;
              i = replacement.end - 1; // -1 because loop will increment
            } else {
              // Escape special regex characters in literal parts
              const char = patternStr[i];
              if (/[.*+?^${}()|[\]\\]/.test(char)) {
                pattern += '\\' + char;
              } else {
                pattern += char;
              }
            }
          }

          const triggerRegex = new RegExp(`^${pattern}$`, 'i');
          const triggerMatch = normalizedText.match(triggerRegex);

          if (triggerMatch) {
            // Extract parameters from original text when possible to preserve full
            // Unicode characters. Homoglyph normalization can mangle Cyrillic words
            // (e.g., "Барнаул" → "Бapнayл") which breaks geocoding APIs.
            // The regex usually matches original text too since param patterns like
            // [^\s]+ accept any non-whitespace character.
            const originalMatch = message.text.match(triggerRegex);

            extractedParams = {};
            params.forEach((param, index) => {
              extractedParams[param.name] = originalMatch?.[index + 1] ?? triggerMatch[index + 1];
            });
            matchedPattern = origPatternStr;
            break; // Found a match, stop trying other patterns
          }
        }

        if (matchedPattern) {
          // Per-node cooldown rate limiting
          const cooldownSeconds = trigger.cooldownSeconds || 0;
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
              message.rxSnr, message.rxRssi, message.viaMqtt, true
            );

            logger.debug(`🌐 Fetching HTTP response from: ${url}`);

            try {
              // Fetch with 5-second timeout
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 5000);

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
              responseText = await this.replaceAcknowledgementTokens(responseText, nodeId, message.fromNodeNum, hopsTraveled, receivedDate, receivedTime, message.channel, isDirectMessage, message.rxSnr, message.rxRssi, message.viaMqtt);
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
            logger.info(`🔧 Executing auto-responder script for pattern "${triggerPattern}" -> ${scriptPath}`);

            // Determine interpreter based on file extension
            const ext = scriptPath.split('.').pop()?.toLowerCase();
            let interpreter: string;

            // In development, use system interpreters (node, python, sh)
            // In production, use absolute paths
            const isDev = process.env.NODE_ENV !== 'production';

            switch (ext) {
              case 'js':
              case 'mjs':
                interpreter = isDev ? 'node' : '/usr/local/bin/node';
                break;
              case 'py':
                interpreter = isDev ? 'python' : '/opt/apprise-venv/bin/python3';
                break;
              case 'sh':
                interpreter = isDev ? 'sh' : '/bin/sh';
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
                  message.rxSnr, message.rxRssi, message.viaMqtt
                );
                scriptArgsList = this.parseScriptArgs(expandedArgs);
                logger.debug(`🤖 Script args expanded: ${trigger.scriptArgs} -> ${JSON.stringify(scriptArgsList)}`);
              }

              // Execute script with 30-second timeout
              // Use resolvedPath (actual file path) instead of scriptPath (API format)
              const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath, ...scriptArgsList], {
                timeout: 30000,
                env: scriptEnv,
                maxBuffer: 1024 * 1024, // 1MB max output
              });

              if (stderr) {
                logger.warn(`🔧 Auto-responder script for "${triggerPattern}" stderr: ${stderr}`);
              }

              // Parse JSON output
              let scriptOutput;
              try {
                scriptOutput = JSON.parse(stdout.trim());
              } catch (parseError) {
                logger.error(`❌ Script output is not valid JSON: ${stdout.substring(0, 100)}`);
                return;
              }

              // Support both single response and multiple responses
              let scriptResponses: string[];
              if (scriptOutput.responses && Array.isArray(scriptOutput.responses)) {
                // Multiple responses format: { "responses": ["msg1", "msg2", "msg3"] }
                scriptResponses = scriptOutput.responses.filter((r: any) => typeof r === 'string');
                if (scriptResponses.length === 0) {
                  logger.error(`❌ Script 'responses' array contains no valid strings`);
                  return;
                }
                logger.debug(`📥 Script returned ${scriptResponses.length} responses`);
              } else if (scriptOutput.response && typeof scriptOutput.response === 'string') {
                // Single response format: { "response": "msg" }
                scriptResponses = [scriptOutput.response];
                logger.debug(`📥 Script response: ${scriptOutput.response.substring(0, 50)}...`);
              } else {
                logger.error(`❌ Script output missing valid 'response' or 'responses' field`);
                return;
              }

              // For scripts with multiple responses, send each one
              const scriptTriggerChannels = normalizeTriggerChannels(trigger);

              // Skip sending if channel is 'none' (script handles its own output)
              if (scriptTriggerChannels.includes('none')) {
                const scriptDuration = Date.now() - scriptStartTime;
                logger.info(`🔧 Auto-responder script for "${triggerPattern}" completed in ${scriptDuration}ms (channel=none, no mesh output)`);

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
              if (typeof scriptOutput.private === 'boolean') {
                isDM = scriptOutput.private;
              }
              // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
              const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
              const target = isDM ? `!${message.fromNodeNum.toString(16).padStart(8, '0')}` : `channel ${message.channel}`;
              logger.debug(`🤖 Enqueueing ${scriptResponses.length} script response(s) to ${target}${trigger.verifyResponse ? ' (with verification)' : ''}`);

              scriptResponses.forEach((resp, index) => {
                const truncated = this.truncateMessageForMeshtastic(resp, 200);
                const isFirstMessage = index === 0;

                this.messageQueue.enqueue(
                  truncated,
                  isDM ? message.fromNodeNum : 0, // destination: node number for DM, 0 for channel
                  isFirstMessage ? packetId : undefined, // Reply to original message for first response
                  () => {
                    logger.info(`✅ Script response ${index + 1}/${scriptResponses.length} delivered to ${target}`);
                  },
                  (reason: string) => {
                    logger.warn(`❌ Script response ${index + 1}/${scriptResponses.length} failed to ${target}: ${reason}`);
                  },
                  isDM ? undefined : message.channel as number, // channel: undefined for DM, channel number for channel
                  maxAttempts
                );
              });

              // Script responses queued
              const scriptDuration = Date.now() - scriptStartTime;
              logger.info(`🔧 Auto-responder script for "${triggerPattern}" completed in ${scriptDuration}ms, ${scriptResponses.length} response(s) queued to ${target}`);

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
                () => { logger.info('✅ Traceroute unknown-node reply delivered'); },
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
              () => { logger.info(`✅ Traceroute ACK delivered to ${nodeId}`); },
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
                () => { logger.info('✅ Traceroute timeout reply delivered'); },
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
              logger.info(`🔍 Auto-responder traceroute to ${targetName} (${targetNode.nodeId}) initiated by ${nodeId}`);

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

          } else {
            // Text trigger - use static response
            responseText = trigger.response;

            // Replace parameters in text
            Object.entries(extractedParams).forEach(([key, value]) => {
              responseText = responseText.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
            });

            // Replace Auto Acknowledge tokens in text response (Issue #1159)
            responseText = await this.replaceAcknowledgementTokens(responseText, nodeId, message.fromNodeNum, hopsTraveled, receivedDate, receivedTime, message.channel, isDirectMessage, message.rxSnr, message.rxRssi, message.viaMqtt);
          }

          // Handle multiline responses or truncate as needed
          const multilineEnabled = trigger.multiline || false;
          let messagesToSend: string[];

          if (multilineEnabled) {
            // Split into multiple messages if enabled
            messagesToSend = this.splitMessageForMeshtastic(responseText, 200);
            if (messagesToSend.length > 1) {
              logger.debug(`📝 Split response into ${messagesToSend.length} messages`);
            }
          } else {
            // Truncate to single message
            const truncated = this.truncateMessageForMeshtastic(responseText, 200);
            if (truncated !== responseText) {
              logger.debug(`✂️  Response truncated from ${responseText.length} to ${truncated.length} characters`);
            }
            messagesToSend = [truncated];
          }

          // Enqueue all messages for delivery with retry logic
          // Respond on the channel the message came from
          const isDM = isDirectMessage;
          // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
          const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
          const target = isDM ? `!${message.fromNodeNum.toString(16).padStart(8, '0')}` : `channel ${message.channel}`;
          logger.debug(`🤖 Enqueueing ${messagesToSend.length} auto-response message(s) to ${target}${trigger.verifyResponse ? ' (with verification)' : ''}`);

          messagesToSend.forEach((msg, index) => {
            const isFirstMessage = index === 0;
            this.messageQueue.enqueue(
              msg,
              isDM ? message.fromNodeNum : 0, // destination: node number for DM, 0 for channel
              isFirstMessage ? packetId : undefined, // Reply to original message for first response
              () => {
                logger.info(`✅ Auto-response ${index + 1}/${messagesToSend.length} delivered to ${target}`);
              },
              (reason: string) => {
                logger.warn(`❌ Auto-response ${index + 1}/${messagesToSend.length} failed to ${target}: ${reason}`);
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

    // Add NODECOUNT - active nodes based on maxNodeAgeHours setting (scoped to this source
    // so auto-responder scripts see the count for their own source, not a cross-source union)
    const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
    const maxNodeAgeDays = maxNodeAgeHours / 24;
    const activeNodes = await databaseService.nodes.getActiveNodes(maxNodeAgeDays, this.sourceId);
    scriptEnv.NODECOUNT = String(activeNodes.length);

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
      logger.info(`👋 Auto-welcome check for ${nodeId}: welcomedAt=${node.welcomedAt} (${typeof node.welcomedAt}), longName=${node.longName}, createdAt=${node.createdAt ? new Date(node.createdAt).toISOString() : 'null'}`);

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

      // Lock was already acquired at method entry; proceed to send welcome
      try {

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

        logger.info(`👋 Sending auto-welcome to ${nodeId} (${node.longName}): "${welcomeText}" ${autoWelcomeTarget === 'dm' ? '(via DM)' : `(channel ${channel})`}`);

        // Route through message queue for rate limiting
        // For DMs, send only once (maxAttempts=1) — the local radio ACK confirms
        // transmission to the mesh; remote ACKs from the destination node are unreliable
        // and waiting for them causes the queue to retry, sending the message multiple times.
        this.messageQueue.enqueue(
          welcomeText,
          destination ?? 0, // destination: node number for DM, 0 for channel
          undefined, // replyId
          () => {
            this.welcomingNodes.delete(nodeNum);
            logger.debug(`🔓 Unlocked auto-welcome tracking for ${nodeId}`);
          },
          (reason: string) => {
            logger.warn(`❌ Auto-welcome send failed for ${nodeId}: ${reason}`);
            this.welcomingNodes.delete(nodeNum);
            logger.debug(`🔓 Unlocked auto-welcome tracking for ${nodeId} (failure case)`);
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
          logger.info(`✅ Node ${nodeId} welcomed and marked in database`);
        } else {
          logger.warn(`⚠️  Node ${nodeId} was already marked as welcomed by another process`);
        }
      } catch (error) {
        // Release lock on error as well
        this.welcomingNodes.delete(nodeNum);
        logger.debug(`🔓 Unlocked auto-welcome tracking for ${nodeId} (error case)`);
        throw error;
      }
    } catch (error) {
      logger.error('❌ Error in auto-welcome:', error);
    } finally {
      // Ensure lock is always released, even on early returns or unexpected errors
      this.welcomingNodes.delete(nodeNum);
    }
  }

  private async checkAutoFavorite(nodeNum: number, nodeId: string): Promise<void> {
    try {
      const autoFavoriteEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoFavoriteEnabled');
      if (autoFavoriteEnabled !== 'true') {
        return;
      }

      if (!this.supportsFavorites()) {
        return;
      }

      // Skip local node
      const localNodeNum = await databaseService.settings.getSetting('localNodeNum');
      if (localNodeNum && parseInt(localNodeNum) === nodeNum) {
        return;
      }

      // Prevent duplicate concurrent operations
      if (this.autoFavoritingNodes.has(nodeNum)) {
        return;
      }

      // Get local node role
      const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : this.localNodeInfo?.nodeNum;
      if (!localNodeNumInt) return;
      const localNode = await databaseService.nodes.getNode(localNodeNumInt);
      if (!localNode) return;

      const targetNode = await databaseService.nodes.getNode(nodeNum);
      if (!targetNode) return;

      // Skip nodes where favoriteLocked is true — user has manually managed this node
      if (targetNode.favoriteLocked) return;

      // Check if already in auto-favorite list (backward compat belt-and-suspenders)
      const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(this.sourceId, 'autoFavoriteNodes') || '[]';
      const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
      if (autoFavoriteNodes.includes(nodeNum)) {
        return; // Already auto-managed
      }

      // Check eligibility
      if (!isAutoFavoriteEligible(localNode.role, targetNode)) {
        return;
      }

      this.autoFavoritingNodes.add(nodeNum);
      try {
        // Mark in DB — favoriteLocked=false since this is auto-managed
        await databaseService.nodes.setNodeFavorite(nodeNum, true, this.sourceId, false);

        // Sync to device
        try {
          await this.sendFavoriteNode(nodeNum);
          logger.info(`⭐ Auto-favorited node ${nodeId} (${targetNode.longName || 'Unknown'}) - 0-hop, role=${targetNode.role}`);
        } catch (error) {
          logger.warn(`⚠️ Auto-favorited node ${nodeId} in DB but device sync failed:`, error);
        }

        // Add to auto-favorite tracking list (per-source)
        autoFavoriteNodes.push(nodeNum);
        await databaseService.settings.setSourceSetting(this.sourceId, 'autoFavoriteNodes', JSON.stringify(autoFavoriteNodes));
      } finally {
        this.autoFavoritingNodes.delete(nodeNum);
      }
    } catch (error) {
      logger.error('❌ Error in auto-favorite check:', error);
    }
  }

  private async autoFavoriteSweep(): Promise<void> {
    if (this.autoFavoriteSweepRunning) return;
    this.autoFavoriteSweepRunning = true;
    try {
      const autoFavoriteEnabled = await databaseService.settings.getSettingForSource(this.sourceId, 'autoFavoriteEnabled');
      const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(this.sourceId, 'autoFavoriteNodes') || '[]';
      const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);

      if (autoFavoriteNodes.length === 0) {
        return;
      }

      // If feature was disabled, clean up all auto-favorited nodes (skip locked ones)
      if (autoFavoriteEnabled !== 'true') {
        logger.info(`🧹 Auto-favorite disabled, cleaning up ${autoFavoriteNodes.length} auto-favorited nodes`);
        for (const nodeNum of autoFavoriteNodes) {
          try {
            const node = await databaseService.nodes.getNode(nodeNum);
            if (node?.favoriteLocked) {
              logger.debug(`Skipping locked node ${nodeNum} during auto-favorite cleanup`);
              continue;
            }
            await databaseService.nodes.setNodeFavorite(nodeNum, false, this.sourceId, false);
            if (this.supportsFavorites() && this.isConnected) {
              await this.sendRemoveFavoriteNode(nodeNum);
            }
          } catch (error) {
            logger.warn(`⚠️ Failed to unfavorite node ${nodeNum} during cleanup:`, error);
          }
        }
        await databaseService.settings.setSourceSetting(this.sourceId, 'autoFavoriteNodes', '[]');
        return;
      }

      if (!this.supportsFavorites()) return;

      const staleHours = parseInt(await databaseService.settings.getSettingForSource(this.sourceId, 'autoFavoriteStaleHours') || '72');
      const staleThreshold = Date.now() / 1000 - (staleHours * 3600);

      // Get local node role for re-evaluation
      const localNodeNum = await databaseService.settings.getSetting('localNodeNum');
      const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : this.localNodeInfo?.nodeNum;
      const localNode = localNodeNumInt ? await databaseService.nodes.getNode(localNodeNumInt) : null;

      const nodesToRemove: number[] = [];

      for (const nodeNum of autoFavoriteNodes) {
        const node = await databaseService.nodes.getNode(nodeNum);
        if (!node) {
          nodesToRemove.push(nodeNum);
          continue;
        }

        // Skip nodes where favoriteLocked is true — user has manually managed this node
        if (node.favoriteLocked) {
          continue;
        }

        let shouldRemove = false;
        let reason = '';

        // Check staleness
        if (node.lastHeard && node.lastHeard < staleThreshold) {
          shouldRemove = true;
          reason = `stale (not heard in ${staleHours}+ hours)`;
        }

        // Check hops changed
        if (!shouldRemove && (node.hopsAway == null || node.hopsAway > 0)) {
          shouldRemove = true;
          reason = `no longer 0-hop (hopsAway=${node.hopsAway})`;
        }

        // Check if received via MQTT (not a true RF neighbor)
        if (!shouldRemove && node.viaMqtt === true) {
          shouldRemove = true;
          reason = 'received via MQTT';
        }

        // Check role eligibility changed (for ROUTER/ROUTER_LATE local)
        if (!shouldRemove && localNode) {
          if (!isAutoFavoriteEligible(localNode.role, { ...node, isFavorite: false })) {
            shouldRemove = true;
            reason = 'no longer eligible (role changed)';
          }
        }

        if (shouldRemove) {
          nodesToRemove.push(nodeNum);
          try {
            await databaseService.nodes.setNodeFavorite(nodeNum, false, this.sourceId, false);
            if (this.isConnected) {
              await this.sendRemoveFavoriteNode(nodeNum);
            }
            const nodeId = node.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;
            logger.info(`☆ Auto-unfavorited node ${nodeId} (${node.longName || 'Unknown'}) - ${reason}`);
          } catch (error) {
            logger.warn(`⚠️ Failed to auto-unfavorite node ${nodeNum}:`, error);
          }
        }
      }

      // Update the tracking list (per-source)
      if (nodesToRemove.length > 0) {
        const removeSet = new Set(nodesToRemove);
        const remaining = autoFavoriteNodes.filter(n => !removeSet.has(n));
        await databaseService.settings.setSourceSetting(this.sourceId, 'autoFavoriteNodes', JSON.stringify(remaining));
        logger.info(`🧹 Auto-favorite sweep: removed ${nodesToRemove.length}, remaining ${remaining.length}`);
      }
    } catch (error) {
      logger.error('❌ Error in auto-favorite sweep:', error);
    } finally {
      this.autoFavoriteSweepRunning = false;
    }
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

      logger.info(`🧹 Auto heap management triggered: heap=${heapFreeBytes}B free (threshold=${threshold}B), purging ${candidates.length} oldest nodes`);

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

    // {NODECOUNT} - Active nodes based on maxNodeAgeHours setting (scoped to this source)
    if (result.includes('{NODECOUNT}')) {
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = await databaseService.nodes.getActiveNodes(maxNodeAgeDays, this.sourceId);
      result = result.replace(/{NODECOUNT}/g, nodes.length.toString());
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) from active nodes (scoped to this source)
    if (result.includes('{DIRECTCOUNT}')) {
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = await databaseService.nodes.getActiveNodes(maxNodeAgeDays, this.sourceId);
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

  async sendAutoAnnouncement(): Promise<void> {
    if (this.rebootMergeInProgress) {
      logger.debug('📢 Skipping auto-announcement - reboot merge in progress');
      return;
    }

    try {
      // All auto-announce settings are per-source (written by AutoAnnounceSection
      // via /api/settings?sourceId=).
      const settings = databaseService.settings;
      const sourceId = this.sourceId;

      const message = await settings.getSettingForSource(sourceId, 'autoAnnounceMessage') || 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';

      // Multi-channel support: read JSON array, fall back to legacy single index
      let channelIndexes: number[];
      const channelIndexesStr = await settings.getSettingForSource(sourceId, 'autoAnnounceChannelIndexes');
      if (channelIndexesStr) {
        try {
          const parsed = JSON.parse(channelIndexesStr);
          channelIndexes = Array.isArray(parsed) ? parsed.filter(n => typeof n === 'number') : [0];
        } catch {
          channelIndexes = [0];
        }
      } else {
        // Legacy migration: read old single channel setting (pre-4.0, global-only)
        const legacyIndex = parseInt(await settings.getSetting('autoAnnounceChannelIndex') || '0');
        channelIndexes = [legacyIndex];
      }

      if (channelIndexes.length === 0) {
        channelIndexes = [0];
      }

      // Replace tokens
      const replacedMessage = await this.replaceAnnouncementTokens(message);

      logger.info(`📢 Sending auto-announcement to ${channelIndexes.length} channel(s) [${channelIndexes.join(',')}]: "${replacedMessage}"`);

      channelIndexes.forEach((channelIdx, i) => {
        this.messageQueue.enqueue(
          replacedMessage,
          0, // destination: 0 for channel broadcast
          undefined, // no reply-to for announcements
          () => {
            logger.info(`\u2705 Auto-announcement ${i + 1}/${channelIndexes.length} delivered to channel ${channelIdx}`);
          },
          (reason: string) => {
            logger.warn(`\u274c Auto-announcement ${i + 1}/${channelIndexes.length} failed on channel ${channelIdx}: ${reason}`);
          },
          channelIdx, // channel number
          1 // single attempt, no retry for broadcasts
        );
      });

      // Update last announcement time (per-source)
      if (this.sourceId) {
        await databaseService.settings.setSourceSetting(this.sourceId, 'lastAnnouncementTime', Date.now().toString());
      } else {
        await databaseService.settings.setSetting('lastAnnouncementTime', Date.now().toString());
      }
      logger.debug('📢 Last announcement time updated');

      // Check if NodeInfo broadcasting is enabled (per-source)
      const nodeInfoEnabled = await settings.getSettingForSource(sourceId, 'autoAnnounceNodeInfoEnabled') === 'true';
      if (nodeInfoEnabled) {
        try {
          const nodeInfoChannelsStr = await settings.getSettingForSource(sourceId, 'autoAnnounceNodeInfoChannels') || '[]';
          const nodeInfoChannels = JSON.parse(nodeInfoChannelsStr) as number[];
          const nodeInfoDelaySeconds = parseInt(await settings.getSettingForSource(sourceId, 'autoAnnounceNodeInfoDelaySeconds') || '30');

          if (nodeInfoChannels.length > 0) {
            logger.info(`📢 NodeInfo broadcasting enabled - will broadcast to ${nodeInfoChannels.length} channel(s)`);
            // Run NodeInfo broadcasting asynchronously (don't block the announcement)
            this.broadcastNodeInfoToChannels(nodeInfoChannels, nodeInfoDelaySeconds).catch(error => {
              logger.error('❌ Error in NodeInfo broadcasting:', error);
            });
          }
        } catch (parseError) {
          logger.error('❌ Error parsing NodeInfo channels setting:', parseError);
        }
      }
    } catch (error) {
      logger.error('❌ Error sending auto-announcement:', error);
    }
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

  private async replaceAnnouncementTokens(message: string, urlEncode: boolean = false): Promise<string> {
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

    // {NODECOUNT} - Active nodes based on maxNodeAgeHours setting
    if (result.includes('{NODECOUNT}')) {
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = await databaseService.nodes.getActiveNodes(maxNodeAgeDays, this.sourceId);
      logger.info(`📢 Token replacement - NODECOUNT: ${nodes.length} active nodes (maxNodeAgeHours: ${maxNodeAgeHours})`);
      result = result.replace(/{NODECOUNT}/g, encode(nodes.length.toString()));
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) from active nodes (scoped to this source)
    if (result.includes('{DIRECTCOUNT}')) {
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = await databaseService.nodes.getActiveNodes(maxNodeAgeDays, this.sourceId);
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      logger.info(`📢 Token replacement - DIRECTCOUNT: ${directCount} direct nodes out of ${nodes.length} active nodes`);
      result = result.replace(/{DIRECTCOUNT}/g, encode(directCount.toString()));
    }

    // {TOTALNODES} - Total nodes (all nodes ever seen, regardless of when last heard, scoped to this source)
    if (result.includes('{TOTALNODES}')) {
      const allNodes = await databaseService.nodes.getAllNodes(this.sourceId);
      logger.info(`📢 Token replacement - TOTALNODES: ${allNodes.length} total nodes`);
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
      logger.info(`📢 Token replacement - ONLINENODES: ${onlineNodes} online nodes (from device LocalStats)`);
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

    return result;
  }

  /**
   * Public wrapper for replaceAnnouncementTokens, used by the preview API endpoint.
   */
  public async previewAnnouncementMessage(message: string): Promise<string> {
    return this.replaceAnnouncementTokens(message);
  }

  private async replaceAcknowledgementTokens(message: string, nodeId: string, fromNum: number, numberHops: number, date: string, time: string, channelIndex: number, isDirectMessage: boolean, rxSnr?: number, rxRssi?: number, viaMqtt?: boolean, urlEncode: boolean = false): Promise<string> {
    // Start with base announcement tokens (includes {IP}, {PORT}, {VERSION}, {DURATION}, {FEATURES}, {NODECOUNT}, {DIRECTCOUNT})
    let result = await this.replaceAnnouncementTokens(message, urlEncode);
    const encode = (v: string) => urlEncode ? encodeURIComponent(v) : v;

    // {NODE_ID} - Sender node ID
    if (result.includes('{NODE_ID}')) {
      result = result.replace(/{NODE_ID}/g, encode(nodeId));
    }

    // {LONG_NAME} - Sender node long name
    if (result.includes('{LONG_NAME}')) {
      const node = await databaseService.nodes.getNode(fromNum);
      const longName = node?.longName || 'Unknown';
      result = result.replace(/{LONG_NAME}/g, encode(longName));
    }

    // {SHORT_NAME} - Sender node short name
    if (result.includes('{SHORT_NAME}')) {
      const node = await databaseService.nodes.getNode(fromNum);
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
      logger.info(`⚙️ Processing ADMIN_APP message from node ${fromNum}, payload size: ${payload.length}`);
      const adminMsg = protobufService.decodeAdminMessage(payload);
      if (!adminMsg) {
        logger.error('⚙️ Failed to decode admin message');
        return;
      }

      logger.info('⚙️ Decoded admin message keys:', Object.keys(adminMsg));
      logger.info('⚙️ Decoded admin message has getConfigResponse:', !!adminMsg.getConfigResponse);
      if (adminMsg.getConfigResponse) {
        logger.info('⚙️ getConfigResponse type:', typeof adminMsg.getConfigResponse);
        logger.info('⚙️ getConfigResponse keys:', Object.keys(adminMsg.getConfigResponse || {}));
      }

      // Extract session passkey from ALL admin responses (per research findings)
      if (adminMsg.sessionPasskey && adminMsg.sessionPasskey.length > 0) {
        const localNodeNum = this.localNodeInfo?.nodeNum || 0;
        
        if (fromNum === localNodeNum || fromNum === 0) {
          // Local node - store in legacy location for backward compatibility
          this.sessionPasskey = new Uint8Array(adminMsg.sessionPasskey);
          this.sessionPasskeyExpiry = Date.now() + (290 * 1000); // 290 seconds (10 second buffer before 300s expiry)
          logger.info('🔑 Session passkey received from local node and stored (expires in 290 seconds)');
        } else {
          // Remote node - store per-node
          this.remoteSessionPasskeys.set(fromNum, {
            passkey: new Uint8Array(adminMsg.sessionPasskey),
            expiry: Date.now() + (290 * 1000) // 290 seconds
          });
          logger.info(`🔑 Session passkey received from remote node ${fromNum} and stored (expires in 290 seconds)`);
        }
      }

      // Process config responses from remote nodes
      const localNodeNum = this.localNodeInfo?.nodeNum || 0;
      const isRemoteNode = fromNum !== 0 && fromNum !== localNodeNum;

      if (adminMsg.getConfigResponse) {
        logger.info(`⚙️ Received GetConfigResponse from node ${fromNum}`);
        logger.info('⚙️ GetConfigResponse structure:', JSON.stringify(Object.keys(adminMsg.getConfigResponse || {})));
        logger.info('⚙️ GetConfigResponse position field present:', !!adminMsg.getConfigResponse.position);
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
          logger.info(`📊 Stored config response from remote node ${fromNum}, keys:`, Object.keys(nodeConfig.deviceConfig));
          logger.info(`📊 Position config stored:`, !!nodeConfig.deviceConfig.position);
          if (nodeConfig.deviceConfig.position) {
            logger.info(`📊 Position config details:`, JSON.stringify(Object.keys(nodeConfig.deviceConfig.position)));
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
                logger.info(`📊 Empty module config response from node ${fromNum}, storing defaults for '${pendingKey}'`);
                nodeConfig.moduleConfig[pendingKey] = {};
                this.pendingModuleConfigRequests.delete(fromNum);
              }
            }
          }
          nodeConfig.lastUpdated = Date.now();
          logger.info(`📊 Stored module config response from remote node ${fromNum}, keys:`, Object.keys(nodeConfig.moduleConfig));
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
          let storedIndex = channel.index;
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
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Use getDeviceMetadataRequest (per research - Android pattern uses this for SESSIONKEY_CONFIG)
      // We'll need to create this message directly using protobufService
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        getDeviceMetadataRequest: true
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.localNodeInfo.nodeNum);

      await this.transport.send(adminPacket);
      logger.info(`🔑 Requested session passkey from remote node ${destinationNodeNum} (via getDeviceMetadataRequest)`);

      // Poll for the response instead of fixed wait
      // This allows early exit if response arrives quickly, and longer total wait time
      const maxWaitTime = 45000; // 45 seconds total
      const pollInterval = 500; // Check every 500ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we received the passkey
        const passkey = this.getSessionPasskey(destinationNodeNum);
        if (passkey) {
          logger.info(`✅ Session passkey received from remote node ${destinationNodeNum} after ${((i + 1) * pollInterval / 1000).toFixed(1)}s`);
          return passkey;
        }
      }

      logger.warn(`⚠️ No session passkey response received from remote node ${destinationNodeNum} after ${maxWaitTime / 1000}s`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting session passkey from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Parse firmware version string into major.minor.patch
   */
  private parseFirmwareVersion(versionString: string): { major: number; minor: number; patch: number } | null {
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
   * Check if the local device firmware supports favorites feature (>= 2.7.0)
   * Result is cached to avoid redundant parsing and version comparisons
   */
  supportsFavorites(): boolean {
    // Return cached result if available
    if (this.favoritesSupportCache !== null) {
      return this.favoritesSupportCache;
    }

    if (!this.localNodeInfo?.firmwareVersion) {
      logger.debug('⚠️ Firmware version unknown, cannot determine favorites support');
      this.favoritesSupportCache = false;
      return false;
    }

    const version = this.parseFirmwareVersion(this.localNodeInfo.firmwareVersion);
    if (!version) {
      logger.debug(`⚠️ Could not parse firmware version: ${this.localNodeInfo.firmwareVersion}`);
      this.favoritesSupportCache = false;
      return false;
    }

    // Favorites feature added in 2.7.0
    const supportsFavorites = version.major > 2 || (version.major === 2 && version.minor >= 7);

    if (!supportsFavorites) {
      logger.debug(`ℹ️ Firmware ${this.localNodeInfo.firmwareVersion} does not support favorites (requires >= 2.7.0)`);
    } else {
      logger.debug(`✅ Firmware ${this.localNodeInfo.firmwareVersion} supports favorites (cached)`);
    }

    // Cache the result
    this.favoritesSupportCache = supportsFavorites;
    return supportsFavorites;
  }

  /**
   * Send admin message to set a node as favorite on the device
   */
  async sendFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support
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

      const setFavoriteMsg = protobufService.createSetFavoriteNodeMessage(nodeNum, sessionPasskey);
      await this.sendAdminCommand(setFavoriteMsg, destNode);
      logger.debug(`⭐ Sent set_favorite_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) to ${isRemote ? 'remote' : 'local'} node ${destNode}`);
    } catch (error) {
      logger.error('❌ Error sending favorite node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to remove a node from favorites on the device
   */
  async sendRemoveFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support
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

      const removeFavoriteMsg = protobufService.createRemoveFavoriteNodeMessage(nodeNum, sessionPasskey);
      await this.sendAdminCommand(removeFavoriteMsg, destNode);
      logger.debug(`☆ Sent remove_favorite_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) to ${isRemote ? 'remote' : 'local'} node ${destNode}`);
    } catch (error) {
      logger.error('❌ Error sending remove favorite node admin message:', error);
      throw error;
    }
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
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      // For local TCP connections, try sending without session passkey first
      // (there's a known bug where session keys don't work properly over TCP)
      logger.info(`🗑️ Attempting to remove node ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) from device NodeDB`);
      const removeNodeMsg = protobufService.createRemoveNodeMessage(nodeNum, new Uint8Array()); // empty passkey
      const adminPacket = protobufService.createAdminPacket(removeNodeMsg, this.localNodeInfo.nodeNum, this.localNodeInfo.nodeNum); // send to local node

      await this.transport.send(adminPacket);
      logger.info(`✅ Sent remove_by_nodenum admin command for node ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')})`);

      // Remove from device node tracking so the UI shows the "not in device DB" warning
      this.deviceNodeNums.delete(nodeNum);
    } catch (error) {
      logger.error('❌ Error sending remove node admin message:', error);
      throw error;
    }
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
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Requesting module config type ${configType} from device`);
      const getModuleConfigMsg = protobufService.createGetModuleConfigRequest(configType);
      const adminPacket = protobufService.createAdminPacket(getModuleConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug(`⚙️ Sent get_module_config_request for config type ${configType}`);
    } catch (error) {
      logger.error('❌ Error requesting module config:', error);
      throw error;
    }
  }

  /**
   * Request config from a remote node
   * @param destinationNodeNum The remote node number
   * @param configType The config type to request (DEVICE_CONFIG=0, LORA_CONFIG=5, etc.)
   * @param isModuleConfig Whether this is a module config request (false for device configs)
   * @returns The config data if received, null otherwise
   */
  async requestRemoteConfig(destinationNodeNum: number, configType: number, isModuleConfig: boolean = false): Promise<any> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.info(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the config request message with session passkey
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsgData: any = {
        sessionPasskey: sessionPasskey
      };

      if (isModuleConfig) {
        adminMsgData.getModuleConfigRequest = configType;
      } else {
        adminMsgData.getConfigRequest = configType;
      }

      const adminMsg = AdminMessage.create(adminMsgData);
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing config for this type before requesting (to ensure fresh data)
      // This must happen BEFORE sending to prevent race conditions where responses arrive
      // and get immediately deleted, causing polling loops to timeout
      // Map config types to their keys
      if (isModuleConfig) {
        const moduleConfigMap: { [key: number]: string } = {
          0: 'mqtt',
          5: 'telemetry',
          9: 'neighborInfo',
          13: 'statusmessage',
          14: 'trafficManagement'
        };
        const configKey = moduleConfigMap[configType];
        if (configKey) {
          const nodeConfig = this.remoteNodeConfigs.get(destinationNodeNum);
          if (nodeConfig?.moduleConfig) {
            delete nodeConfig.moduleConfig[configKey];
          }
        }
      } else {
        const deviceConfigMap: { [key: number]: string } = {
          0: 'device',
          1: 'position',  // POSITION_CONFIG (was incorrectly 6)
          5: 'lora',
          6: 'bluetooth',  // BLUETOOTH_CONFIG (for completeness)
          7: 'security'  // SECURITY_CONFIG
        };
        const configKey = deviceConfigMap[configType];
        if (configKey) {
          const nodeConfig = this.remoteNodeConfigs.get(destinationNodeNum);
          if (nodeConfig?.deviceConfig) {
            delete nodeConfig.deviceConfig[configKey];
          }
        }
      }

      // Track pending module config request so empty Proto3 responses can be mapped
      if (isModuleConfig) {
        const moduleConfigMap: { [key: number]: string } = {
          0: 'mqtt', 5: 'telemetry', 9: 'neighborInfo',
          13: 'statusmessage', 14: 'trafficManagement'
        };
        const pendingKey = moduleConfigMap[configType];
        if (pendingKey) {
          this.pendingModuleConfigRequests.set(destinationNodeNum, pendingKey);
        }
      }

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.localNodeInfo.nodeNum);
      await this.transport.send(adminPacket);
      logger.debug(`📡 Requested ${isModuleConfig ? 'module' : 'device'} config type ${configType} from remote node ${destinationNodeNum}`);

      // Wait for the response (config responses can take time, especially over mesh)
      // Remote nodes may take longer due to mesh routing
      // Poll for the response up to 20 seconds (increased from 10s for multi-hop mesh)
      const maxWaitTime = 20000; // 20 seconds
      const pollInterval = 250; // Check every 250ms
      const maxPolls = maxWaitTime / pollInterval;
      
      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        // Check if we have the config for this remote node
        const nodeConfig = this.remoteNodeConfigs.get(destinationNodeNum);
        if (nodeConfig) {
          if (isModuleConfig) {
            // Map module config types to their keys
            const moduleConfigMap: { [key: number]: string } = {
              0: 'mqtt',
              5: 'telemetry',
              9: 'neighborInfo',
              13: 'statusmessage',
              14: 'trafficManagement'
            };
            const configKey = moduleConfigMap[configType];
            if (configKey && nodeConfig.moduleConfig?.[configKey]) {
              logger.info(`✅ Received ${configKey} config from remote node ${destinationNodeNum}`);
              return nodeConfig.moduleConfig[configKey];
            }
          } else {
            // Map device config types to their keys
            const deviceConfigMap: { [key: number]: string } = {
              0: 'device',
              1: 'position',  // POSITION_CONFIG
              2: 'power',     // POWER_CONFIG
              3: 'network',   // NETWORK_CONFIG
              4: 'display',   // DISPLAY_CONFIG
              5: 'lora',      // LORA_CONFIG
              6: 'bluetooth', // BLUETOOTH_CONFIG
              7: 'security'   // SECURITY_CONFIG
            };
            const configKey = deviceConfigMap[configType];
            if (configKey && nodeConfig.deviceConfig?.[configKey]) {
              logger.debug(`✅ Received ${configKey} config from remote node ${destinationNodeNum}`);
              return nodeConfig.deviceConfig[configKey];
            }
          }
        }
      }

      logger.warn(`⚠️ Config type ${configType} not found in response from remote node ${destinationNodeNum} after waiting ${maxWaitTime}ms`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting config from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request a specific channel from a remote node
   * @param destinationNodeNum The remote node number
   * @param channelIndex The channel index (0-7)
   * @returns The channel data if received, null otherwise
   */
  async requestRemoteChannel(destinationNodeNum: number, channelIndex: number): Promise<any> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.info(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the channel request message with session passkey
      // Note: getChannelRequest uses channelIndex + 1 (per protobuf spec)
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        sessionPasskey: sessionPasskey,
        getChannelRequest: channelIndex + 1  // Protobuf uses index + 1
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing channel for this index before requesting (to ensure fresh data)
      // This must happen BEFORE sending to prevent race conditions where responses arrive
      // and get immediately deleted, causing polling loops to timeout
      const nodeChannels = this.remoteNodeChannels.get(destinationNodeNum);
      if (nodeChannels) {
        nodeChannels.delete(channelIndex);
      }

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.localNodeInfo.nodeNum);
      await this.transport.send(adminPacket);
      logger.debug(`📡 Requested channel ${channelIndex} from remote node ${destinationNodeNum}`);
      
      // Wait for the response
      // Use longer timeout for mesh routing - responses can take longer over mesh
      // Increased from 8s to 16s for multi-hop mesh routing
      const maxWaitTime = 16000; // 16 seconds
      const pollInterval = 300; // Check every 300ms
      const maxPolls = maxWaitTime / pollInterval;
      
      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        // Check if we have the channel for this remote node
        const nodeChannelsCheck = this.remoteNodeChannels.get(destinationNodeNum);
        if (nodeChannelsCheck && nodeChannelsCheck.has(channelIndex)) {
          const channel = nodeChannelsCheck.get(channelIndex);
          logger.debug(`✅ Received channel ${channelIndex} from remote node ${destinationNodeNum}`, {
            hasSettings: !!channel.settings,
            name: channel.settings?.name,
            role: channel.role
          });
          return channel;
        }
      }

      logger.warn(`⚠️ Channel ${channelIndex} not found in response from remote node ${destinationNodeNum} after waiting ${maxWaitTime}ms`);
      // Log what channels we did receive for debugging
      const receivedChannels = this.remoteNodeChannels.get(destinationNodeNum);
      if (receivedChannels) {
        logger.debug(`📊 Received channels for node ${destinationNodeNum}:`, Array.from(receivedChannels.keys()));
      }
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting channel from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request owner information from a remote node
   * @param destinationNodeNum The remote node number
   * @returns The owner data if received, null otherwise
   */
  async requestRemoteOwner(destinationNodeNum: number): Promise<any> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.info(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the owner request message with session passkey
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        sessionPasskey: sessionPasskey,
        getOwnerRequest: true  // getOwnerRequest is a bool
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing owner for this node before requesting (to ensure fresh data)
      // This must happen BEFORE sending to prevent race conditions where responses arrive
      // and get immediately deleted, causing polling loops to timeout
      this.remoteNodeOwners.delete(destinationNodeNum);

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.localNodeInfo.nodeNum);
      await this.transport.send(adminPacket);
      logger.debug(`📡 Requested owner info from remote node ${destinationNodeNum}`);
      
      // Wait for the response
      // Increased from 3s to 10s for multi-hop mesh routing
      const maxWaitTime = 10000; // 10 seconds
      const pollInterval = 250; // Check every 250ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we have the owner for this remote node
        if (this.remoteNodeOwners.has(destinationNodeNum)) {
          const owner = this.remoteNodeOwners.get(destinationNodeNum);
          logger.debug(`✅ Received owner info from remote node ${destinationNodeNum}`);
          return owner;
        }
      }

      logger.warn(`⚠️ Owner info not found in response from remote node ${destinationNodeNum} after waiting ${maxWaitTime / 1000}s`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting owner info from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request device metadata from a remote node
   * Returns firmware version, hardware model, capabilities, role, etc.
   */
  async requestRemoteDeviceMetadata(destinationNodeNum: number): Promise<any> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.info(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the device metadata request message with session passkey
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        sessionPasskey: sessionPasskey,
        getDeviceMetadataRequest: true
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing metadata for this node before requesting (to ensure fresh data)
      this.remoteNodeDeviceMetadata.delete(destinationNodeNum);

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.localNodeInfo.nodeNum);
      await this.transport.send(adminPacket);
      logger.debug(`📡 Requested device metadata from remote node ${destinationNodeNum}`);

      // Wait for the response
      const maxWaitTime = 10000; // 10 seconds
      const pollInterval = 250; // Check every 250ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we have the device metadata for this remote node
        if (this.remoteNodeDeviceMetadata.has(destinationNodeNum)) {
          const metadata = this.remoteNodeDeviceMetadata.get(destinationNodeNum);
          logger.debug(`✅ Received device metadata from remote node ${destinationNodeNum}`);
          return metadata;
        }
      }

      logger.warn(`⚠️ Device metadata not received from remote node ${destinationNodeNum} after waiting ${maxWaitTime / 1000}s`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting device metadata from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Send reboot command to a node (local or remote)
   * @param destinationNodeNum The target node number (0 or local node num for local)
   * @param seconds Number of seconds before reboot (default: 5, use negative to cancel)
   */
  async sendRebootCommand(destinationNodeNum: number, seconds: number = 10): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    const localNodeNum = this.localNodeInfo.nodeNum;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    try {
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      let sessionPasskey: Uint8Array | null = null;

      // For remote nodes, get the session passkey
      if (!isLocalNode) {
        sessionPasskey = this.getSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
          sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
          if (!sessionPasskey) {
            throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
          }
        }
      }

      const adminMsg = AdminMessage.create({
        ...(sessionPasskey && { sessionPasskey }),
        rebootSeconds: seconds
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      const targetNodeNum = isLocalNode ? localNodeNum : destinationNodeNum;
      const adminPacket = protobufService.createAdminPacket(encoded, targetNodeNum, localNodeNum);
      await this.transport.send(adminPacket);

      logger.info(`🔄 Sent reboot command to node ${targetNodeNum} (reboot in ${seconds} seconds)`);
    } catch (error) {
      logger.error(`❌ Error sending reboot command to node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Send set time command to a node (local or remote)
   * Sets the node's time to the current server time
   * @param destinationNodeNum The target node number (0 or local node num for local)
   */
  async sendSetTimeCommand(destinationNodeNum: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node number not available');
    }

    const localNodeNum = this.localNodeInfo.nodeNum;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    try {
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      let sessionPasskey: Uint8Array | null = null;

      // For remote nodes, get the session passkey
      if (!isLocalNode) {
        sessionPasskey = this.getSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
          sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
          if (!sessionPasskey) {
            throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
          }
        }
      }

      // Get current Unix timestamp
      const currentTime = Math.floor(Date.now() / 1000);

      const adminMsg = AdminMessage.create({
        ...(sessionPasskey && { sessionPasskey }),
        setTimeOnly: currentTime
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      const targetNodeNum = isLocalNode ? localNodeNum : destinationNodeNum;
      const adminPacket = protobufService.createAdminPacket(encoded, targetNodeNum, localNodeNum);
      await this.transport.send(adminPacket);

      logger.info(`🕐 Sent set time command to node ${targetNodeNum} (time: ${currentTime} / ${new Date(currentTime * 1000).toISOString()})`);
    } catch (error) {
      logger.error(`❌ Error sending set time command to node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request all module configurations from the device for complete backup
   * This requests all 13 module config types defined in the protobufs
   */
  async requestAllModuleConfigs(): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // All module config types from admin.proto ModuleConfigType enum
    const moduleConfigTypes = [
      0,  // MQTT_CONFIG
      1,  // SERIAL_CONFIG
      2,  // EXTNOTIF_CONFIG
      3,  // STOREFORWARD_CONFIG
      4,  // RANGETEST_CONFIG
      5,  // TELEMETRY_CONFIG
      6,  // CANNEDMSG_CONFIG
      7,  // AUDIO_CONFIG
      8,  // REMOTEHARDWARE_CONFIG
      9,  // NEIGHBORINFO_CONFIG
      10, // AMBIENTLIGHTING_CONFIG
      11, // DETECTIONSENSOR_CONFIG
      12, // PAXCOUNTER_CONFIG
      13, // STATUSMESSAGE_CONFIG
      14  // TRAFFICMANAGEMENT_CONFIG
    ];

    logger.info('📦 Requesting all module configs for complete backup...');

    for (const configType of moduleConfigTypes) {
      try {
        await this.requestModuleConfig(configType);
        // Configurable delay between requests to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, getEnvironmentConfig().meshtasticModuleConfigDelayMs));
      } catch (error) {
        logger.error(`❌ Failed to request module config type ${configType}:`, error);
        // Continue with other configs even if one fails
      }
    }

    logger.info('✅ All module config requests sent');
  }

  /**
   * Reset module config cache so the next connect() will re-fetch all configs.
   * Called after OTA firmware updates to ensure fresh config data.
   */
  resetModuleConfigCache(): void {
    this.moduleConfigsEverFetched = false;
    this.actualModuleConfig = null;
    logger.info('📦 Module config cache reset — will re-fetch on next connect');
  }

  /**
   * Force refresh of module configs (resets the cache flag and re-fetches).
   * Useful for Configuration tab refresh button or API use.
   */
  async refreshModuleConfigs(): Promise<void> {
    this.moduleConfigsEverFetched = false;
    this.actualModuleConfig = null;
    logger.info('📦 Force-refreshing module configs...');
    await this.requestAllModuleConfigs();
    this.moduleConfigsEverFetched = true;
  }

  /**
   * Send an admin command to a node (local or remote)
   * The admin message should already be built with session passkey if needed
   * @param adminMessagePayload The encoded admin message (should already include session passkey for remote nodes)
   * @param destinationNodeNum Destination node number (0 or local node num for local, other for remote)
   * @returns Promise that resolves when command is sent
   */
  async sendAdminCommand(adminMessagePayload: Uint8Array, destinationNodeNum: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.localNodeInfo?.nodeNum) {
      throw new Error('Local node information not available');
    }

    const localNodeNum = this.localNodeInfo.nodeNum;

    try {
      const adminPacket = protobufService.createAdminPacket(
        adminMessagePayload,
        destinationNodeNum,
        localNodeNum
      );

      await this.transport.send(adminPacket);
      logger.debug(`✅ Sent admin command to node ${destinationNodeNum}`);

      // Log outgoing admin command to packet monitor (ONLY for remote admin)
      // Skip logging for local admin (destination == localNodeNum)
      if (destinationNodeNum !== localNodeNum) {
        await this.logOutgoingPacket(
          6, // ADMIN_APP
          destinationNodeNum,
          0, // Admin uses channel 0
          `Remote Admin to !${destinationNodeNum.toString(16).padStart(8, '0')}`,
          { destinationNodeNum, isRemoteAdmin: true }
        );
      }
    } catch (error) {
      logger.error(`❌ Error sending admin command to node ${destinationNodeNum}:`, error);
      throw error;
    }
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
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Sending purge node database command: will purge in ${seconds} seconds`);
      // NOTE: Session passkeys are only required for REMOTE admin operations (admin messages sent to other nodes via mesh).
      // For local TCP connections to the device itself, no session passkey is needed.
      const purgeMsg = protobufService.createPurgeNodeDbMessage(seconds);
      const adminPacket = protobufService.createAdminPacket(purgeMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent purge node database admin message (local operation, no session passkey required)');
    } catch (error) {
      logger.error('❌ Error sending purge node database command:', error);
      throw error;
    }
  }

  /**
   * Set device configuration (role, broadcast intervals, etc.)
   */
  async setDeviceConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending device config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetDeviceConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent set_device_config admin message');
    } catch (error) {
      logger.error('❌ Error sending device config:', error);
      throw error;
    }
  }

  /**
   * Set LoRa configuration (preset, region, etc.)
   */
  async setLoRaConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending LoRa config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetLoRaConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      this.updateCachedDeviceConfig('lora', config);
      logger.debug('⚙️ Sent set_lora_config admin message');
    } catch (error) {
      logger.error('❌ Error sending LoRa config:', error);
      throw error;
    }
  }

  /**
   * Set network configuration (NTP server, etc.)
   */
  async setNetworkConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending network config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetNetworkConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      this.updateCachedDeviceConfig('network', config);
      logger.debug('⚙️ Sent set_network_config admin message');
    } catch (error) {
      logger.error('❌ Error sending network config:', error);
      throw error;
    }
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
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (channelIndex < 0 || channelIndex > 7) {
      throw new Error('Channel index must be between 0 and 7');
    }

    try {
      logger.debug(`⚙️ Sending channel ${channelIndex} config:`, JSON.stringify(config));
      const setChannelMsg = protobufService.createSetChannelMessage(channelIndex, config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setChannelMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug(`⚙️ Sent set_channel admin message for channel ${channelIndex}`);
    } catch (error) {
      logger.error(`❌ Error sending channel ${channelIndex} config:`, error);
      throw error;
    }
  }

  /**
   * Set position configuration (broadcast intervals, etc.)
   */
  async setPositionConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      // Extract position data if provided
      const { latitude, longitude, altitude, ...positionConfig } = config;

      // Per Meshtastic docs: Set fixed position coordinates FIRST, THEN set fixedPosition flag.
      // set_fixed_position automatically sets fixedPosition=true on the device.
      // No delay needed: firmware processes incoming messages sequentially from its receive buffer.
      if (latitude !== undefined && longitude !== undefined) {
        logger.debug(`⚙️ Setting fixed position coordinates: lat=${latitude}, lon=${longitude}, alt=${altitude || 0}`);
        const setPositionMsg = protobufService.createSetFixedPositionMessage(
          latitude,
          longitude,
          altitude || 0,
          new Uint8Array()
        );
        const positionPacket = protobufService.createAdminPacket(setPositionMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

        await this.transport.send(positionPacket);
        logger.debug('⚙️ Sent set_fixed_position admin message');

        // Immediately update the local node's position in the database so it's correct
        // before any stale position broadcast arrives from the device firmware.
        if (this.localNodeInfo) {
          const localNodeNum = this.localNodeInfo.nodeNum;
          const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
          await databaseService.nodes.upsertNode({
            nodeNum: localNodeNum,
            nodeId: localNodeId,
            latitude,
            longitude,
            altitude: altitude || 0,
            positionTimestamp: Date.now(),
          }, this.sourceId);
          logger.info(`⚙️ Updated local node ${localNodeId} position in database: lat=${latitude}, lon=${longitude}`);
        }
      }

      // Then send position configuration (fixedPosition flag, broadcast intervals, etc.)
      logger.debug('⚙️ Sending position config:', JSON.stringify(positionConfig));
      const setConfigMsg = protobufService.createSetPositionConfigMessage(positionConfig, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      this.updateCachedDeviceConfig('position', positionConfig);
      logger.debug('⚙️ Sent set_position_config admin message');
    } catch (error) {
      logger.error('❌ Error sending position config:', error);
      throw error;
    }
  }

  /**
   * Set MQTT module configuration
   */
  async setMQTTConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending MQTT config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetMQTTConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      this.updateCachedDeviceConfig('mqtt', config);
      logger.debug('⚙️ Sent set_mqtt_config admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error sending MQTT config:', error);
      throw error;
    }
  }

  /**
   * Set NeighborInfo module configuration
   */
  async setNeighborInfoConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending NeighborInfo config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetNeighborInfoConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      this.updateCachedDeviceConfig('neighborinfo', config);
      logger.debug('⚙️ Sent set_neighborinfo_config admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error sending NeighborInfo config:', error);
      throw error;
    }
  }

  /**
   * Set power configuration
   */
  async setPowerConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending power config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetDeviceConfigMessageGeneric('power', config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent set_power_config admin message');
    } catch (error) {
      logger.error('❌ Error sending power config:', error);
      throw error;
    }
  }

  /**
   * Set display configuration
   */
  async setDisplayConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending display config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetDeviceConfigMessageGeneric('display', config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent set_display_config admin message');
    } catch (error) {
      logger.error('❌ Error sending display config:', error);
      throw error;
    }
  }

  /**
   * Set telemetry module configuration
   */
  async setTelemetryConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending telemetry config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetModuleConfigMessageGeneric('telemetry', config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent set_telemetry_config admin message');

      // Update local cache with the config that was sent
      if (!this.actualModuleConfig) {
        this.actualModuleConfig = {};
      }
      this.actualModuleConfig.telemetry = { ...this.actualModuleConfig.telemetry, ...config };
      logger.debug('⚙️ Updated actualModuleConfig.telemetry cache');
    } catch (error) {
      logger.error('❌ Error sending telemetry config:', error);
      throw error;
    }
  }

  /**
   * Set generic module configuration
   * Handles: extnotif, storeforward, rangetest, cannedmsg, audio,
   * remotehardware, detectionsensor, paxcounter, serial, ambientlighting
   */
  async setGenericModuleConfig(moduleType: string, config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Sending ${moduleType} config:`, JSON.stringify(config));
      const setConfigMsg = protobufService.createSetModuleConfigMessageGeneric(moduleType, config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug(`⚙️ Sent set_${moduleType}_config admin message`);
    } catch (error) {
      logger.error(`❌ Error sending ${moduleType} config:`, error);
      throw error;
    }
  }

  /**
   * Set node owner (long name and short name)
   */
  async setNodeOwner(longName: string, shortName: string, isUnmessagable?: boolean, isLicensed?: boolean): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Setting node owner: "${longName}" (${shortName}), isUnmessagable: ${isUnmessagable}, isLicensed: ${isLicensed}`);
      const setOwnerMsg = protobufService.createSetOwnerMessage(longName, shortName, isUnmessagable, new Uint8Array(), isLicensed);
      const adminPacket = protobufService.createAdminPacket(setOwnerMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent set_owner admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error setting node owner:', error);
      throw error;
    }
  }

  /**
   * Begin edit settings transaction to batch configuration changes
   */
  async beginEditSettings(): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.info('⚙️ Beginning edit settings transaction');
      const beginMsg = protobufService.createBeginEditSettingsMessage(new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(beginMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.info('⚙️ Sent begin_edit_settings admin message');
    } catch (error) {
      logger.error('❌ Error beginning edit settings:', error);
      throw error;
    }
  }

  /**
   * Commit edit settings to persist configuration changes
   */
  async commitEditSettings(): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.info('⚙️ Committing edit settings to persist configuration');
      const commitMsg = protobufService.createCommitEditSettingsMessage(new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(commitMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.info('⚙️ Sent commit_edit_settings admin message');

      // Wait a moment for device to save to flash
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      logger.error('❌ Error committing edit settings:', error);
      throw error;
    }
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
        logger.info(`  Moves: ${moves.map(m => `slot ${m.from}→${m.to}`).join(', ')}`);
      }
      if (newChannels.length > 0) {
        logger.info(`  New channels: slots ${newChannels.join(', ')}`);
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

  // Async version that fetches uptimes in a single bulk query - works with all DB backends
  async getAllNodesAsync(sourceId?: string): Promise<DeviceInfo[]> {
    const uptimeMap = await databaseService.telemetry.getLatestTelemetryValueForAllNodes('uptimeSeconds');
    const dbNodes = await databaseService.nodes.getAllNodes(sourceId);
    return dbNodes.map(node => this.mapDbNodeToDeviceInfo(node, uptimeMap.get(node.nodeId)));
  }


  // Shared mapping logic for converting a DB node to DeviceInfo
  private mapDbNodeToDeviceInfo(node: any, uptimeSeconds?: number): DeviceInfo {
      const deviceInfo: any = {
        nodeNum: node.nodeNum,
        user: {
          id: node.nodeId,
          longName: node.longName || '',
          shortName: node.shortName || '',
          hwModel: node.hwModel,
          publicKey: node.publicKey
        },
        deviceMetrics: {
          batteryLevel: node.batteryLevel,
          voltage: node.voltage,
          channelUtilization: node.channelUtilization,
          airUtilTx: node.airUtilTx,
          uptimeSeconds
        },
        lastHeard: node.lastHeard,
        snr: node.snr,
        rssi: node.rssi
      };

      // Add role if it exists
      if (node.role !== null && node.role !== undefined) {
        deviceInfo.user.role = node.role.toString();
      }

      // Add hopsAway if it exists
      if (node.hopsAway !== null && node.hopsAway !== undefined) {
        deviceInfo.hopsAway = node.hopsAway;
      }

      // Add lastMessageHops if it exists (for "All messages" hop calculation mode)
      if (node.lastMessageHops !== null && node.lastMessageHops !== undefined) {
        deviceInfo.lastMessageHops = node.lastMessageHops;
      }

      // Add viaMqtt if it exists
      if (node.viaMqtt !== null && node.viaMqtt !== undefined) {
        deviceInfo.viaMqtt = Boolean(node.viaMqtt);
      }

      // Add isStoreForwardServer if it exists
      if (node.isStoreForwardServer !== null && node.isStoreForwardServer !== undefined) {
        deviceInfo.isStoreForwardServer = Boolean(node.isStoreForwardServer);
      }

      // Add isFavorite if it exists
      if (node.isFavorite !== null && node.isFavorite !== undefined) {
        deviceInfo.isFavorite = Boolean(node.isFavorite);
      }

      // Add favoriteLocked if it exists
      if (node.favoriteLocked !== null && node.favoriteLocked !== undefined) {
        deviceInfo.favoriteLocked = Boolean(node.favoriteLocked);
      }

      // Add isIgnored if it exists
      if (node.isIgnored !== null && node.isIgnored !== undefined) {
        deviceInfo.isIgnored = Boolean(node.isIgnored);
      }

      // Add channel if it exists
      if (node.channel !== null && node.channel !== undefined) {
        deviceInfo.channel = node.channel;
      }

      // Add mobile flag if it exists (pre-computed during packet processing)
      if (node.mobile !== null && node.mobile !== undefined) {
        deviceInfo.mobile = node.mobile;
      }

      // Add security fields for low-entropy and duplicate key detection
      if (node.keyIsLowEntropy !== null && node.keyIsLowEntropy !== undefined) {
        deviceInfo.keyIsLowEntropy = Boolean(node.keyIsLowEntropy);
      }
      if (node.duplicateKeyDetected !== null && node.duplicateKeyDetected !== undefined) {
        deviceInfo.duplicateKeyDetected = Boolean(node.duplicateKeyDetected);
      }
      if (node.keySecurityIssueDetails) {
        deviceInfo.keySecurityIssueDetails = node.keySecurityIssueDetails;
      }

      // Add position if coordinates exist
      if (node.latitude && node.longitude) {
        deviceInfo.position = {
          latitude: node.latitude,
          longitude: node.longitude,
          altitude: node.altitude
        };
      }

      // Add position precision fields for accuracy circles
      if (node.positionPrecisionBits !== null && node.positionPrecisionBits !== undefined) {
        deviceInfo.positionPrecisionBits = node.positionPrecisionBits;
      }
      if (node.positionGpsAccuracy !== null && node.positionGpsAccuracy !== undefined) {
        deviceInfo.positionGpsAccuracy = node.positionGpsAccuracy;
      }

      // Add position override fields
      if (node.positionOverrideEnabled !== null && node.positionOverrideEnabled !== undefined) {
        deviceInfo.positionOverrideEnabled = Boolean(node.positionOverrideEnabled);
      }
      if (node.latitudeOverride !== null && node.latitudeOverride !== undefined) {
        deviceInfo.latitudeOverride = node.latitudeOverride;
      }
      if (node.longitudeOverride !== null && node.longitudeOverride !== undefined) {
        deviceInfo.longitudeOverride = node.longitudeOverride;
      }
      if (node.altitudeOverride !== null && node.altitudeOverride !== undefined) {
        deviceInfo.altitudeOverride = node.altitudeOverride;
      }
      if (node.positionOverrideIsPrivate !== null && node.positionOverrideIsPrivate !== undefined) {
        deviceInfo.positionOverrideIsPrivate = Boolean(node.positionOverrideIsPrivate);
      }

      // Add remote admin fields
      if (node.hasRemoteAdmin !== null && node.hasRemoteAdmin !== undefined) {
        deviceInfo.hasRemoteAdmin = Boolean(node.hasRemoteAdmin);
        logger.debug(`🔍 Node ${node.nodeNum} hasRemoteAdmin: ${node.hasRemoteAdmin}`);
      }
      if (node.lastRemoteAdminCheck !== null && node.lastRemoteAdminCheck !== undefined) {
        deviceInfo.lastRemoteAdminCheck = node.lastRemoteAdminCheck;
      }
      if (node.remoteAdminMetadata) {
        deviceInfo.remoteAdminMetadata = node.remoteAdminMetadata;
        logger.debug(`🔍 Node ${node.nodeNum} has remoteAdminMetadata`);
      }

      return deviceInfo;
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
      timestamp: new Date(msg.rxTime ?? msg.timestamp),
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

  // Public method to trigger manual refresh of node database
  async refreshNodeDatabase(): Promise<void> {
    logger.debug('🔄 Manually refreshing node database...');

    if (!this.isConnected) {
      logger.debug('⚠️ Not connected, attempting to reconnect...');
      await this.connect();
    }

    // Clear isLocked so processMyNodeInfo can run (updates hwModel, rebootCount, etc.)
    // and processNodeInfoProtobuf can update localNodeInfo with fresh names.
    // The whole point of a manual refresh is to get fresh data from the device.
    if (this.localNodeInfo) {
      this.localNodeInfo.isLocked = false;
      logger.debug('🔓 Cleared localNodeInfo lock for config refresh');
    }

    // Send want_config_id to trigger node to send updated info
    await this.sendWantConfigId();

    // Also request all module configs to get fresh telemetry, mqtt, etc.
    setTimeout(async () => {
      try {
        logger.info('📦 Requesting fresh module configs...');
        await this.requestAllModuleConfigs();
      } catch (error) {
        logger.error('❌ Failed to request module configs during refresh:', error);
      }
    }, 1000);
  }

  /**
   * User-initiated disconnect from the node
   * Prevents auto-reconnection until userReconnect() is called
   */
  async userDisconnect(): Promise<void> {
    logger.debug('🔌 User-initiated disconnect requested');
    this.userDisconnectedState = true;

    // Notify about disconnect before actually disconnecting
    // This ensures users get notified even for user-initiated disconnects
    await serverEventNotificationService.notifyNodeDisconnected(this.sourceId, await this.getSourceName());

    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch (error) {
        logger.error('Error disconnecting transport:', error);
      }
    }

    this.isConnected = false;

    // Clear any active intervals and pending jitter timeouts
    if (this.tracerouteJitterTimeout) {
      clearTimeout(this.tracerouteJitterTimeout);
      this.tracerouteJitterTimeout = null;
    }

    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
    }

    if (this.distanceDeleteInterval) {
      clearInterval(this.distanceDeleteInterval);
      this.distanceDeleteInterval = null;
    }

    if (this.remoteAdminScannerInterval) {
      clearInterval(this.remoteAdminScannerInterval);
      this.remoteAdminScannerInterval = null;
    }

    if (this.timeSyncInterval) {
      clearInterval(this.timeSyncInterval);
      this.timeSyncInterval = null;
    }

    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    // Stop announce cron job if active
    if (this.announceCronJob) {
      this.announceCronJob.stop();
      this.announceCronJob = null;
      logger.debug('📢 Stopped announce cron job');
    }

    // Stop all timer cron jobs
    this.timerCronJobs.forEach((job, id) => {
      job.stop();
      logger.debug(`⏱️ Stopped timer cron job: ${id}`);
    });
    this.timerCronJobs.clear();

    logger.debug('✅ User disconnect completed');
  }

  /**
   * User-initiated reconnect to the node
   * Clears the user disconnect state and attempts to reconnect
   */
  async userReconnect(): Promise<boolean> {
    logger.debug('🔌 User-initiated reconnect requested');
    this.userDisconnectedState = false;

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
 * @deprecated Use sourceManagerRegistry to manage MeshtasticManager instances.
 * This singleton is kept for backward compatibility with single-source deployments
 * and env-var-only configurations where no source record exists in the database.
 */
export default new MeshtasticManager();