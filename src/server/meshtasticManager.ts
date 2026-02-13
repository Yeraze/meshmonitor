import databaseService, { type DbMessage } from '../services/database.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService, { convertIpv4ConfigToStrings } from './protobufService.js';
import { getProtobufRoot } from './protobufLoader.js';
import { TcpTransport } from './tcpTransport.js';
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
import { messageQueueService } from './messageQueueService.js';
import { normalizeTriggerPatterns } from '../utils/autoResponderUtils.js';
import { isWithinTimeWindow } from './utils/timeWindow.js';
import { isNodeComplete } from '../utils/nodeHelpers.js';
import { PortNum, RoutingError, isPkiError, getRoutingErrorName, CHANNEL_DB_OFFSET, TransportMechanism, MIN_TRACEROUTE_INTERVAL_MS } from './constants/meshtastic.js';
import { createRequire } from 'module';
import * as cron from 'node-cron';
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
};

/**
 * Auto-responder trigger configuration
 */
interface AutoResponderTrigger {
  trigger: string | string[];
  response: string;
  responseType?: 'text' | 'http' | 'script';
  channel?: number | 'dm' | 'none';
  verifyResponse?: boolean;
  multiline?: boolean;
  scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
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

class MeshtasticManager {
  private transport: TcpTransport | null = null;
  private isConnected = false;
  private userDisconnectedState = false;  // Track user-initiated disconnect
  private tracerouteInterval: NodeJS.Timeout | null = null;
  private tracerouteJitterTimeout: NodeJS.Timeout | null = null;
  private tracerouteIntervalMinutes: number = 0;
  private lastTracerouteSentTime: number = 0;
  private localStatsInterval: NodeJS.Timeout | null = null;
  private timeOffsetSamples: number[] = [];
  private timeOffsetInterval: NodeJS.Timeout | null = null;
  private localStatsIntervalMinutes: number = 5;  // Default 5 minutes
  private announceInterval: NodeJS.Timeout | null = null;
  private announceCronJob: cron.ScheduledTask | null = null;
  private timerCronJobs: Map<string, cron.ScheduledTask> = new Map();
  private geofenceNodeState: Map<string, Set<number>> = new Map(); // geofenceId -> set of nodeNums currently inside
  private geofenceWhileInsideTimers: Map<string, NodeJS.Timeout> = new Map(); // geofenceId -> interval timer
  private pendingAutoTraceroutes: Set<number> = new Set(); // Track auto-traceroute targets for logging
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
  // Per-node channel storage for remote nodes
  private remoteNodeChannels: Map<number, Map<number, any>> = new Map();
  // Per-node owner storage for remote nodes
  private remoteNodeOwners: Map<number, any> = new Map();
  // Per-node device metadata storage for remote nodes
  private remoteNodeDeviceMetadata: Map<number, any> = new Map();
  private favoritesSupportCache: boolean | null = null;  // Cache firmware support check result
  private cachedAutoAckRegex: { pattern: string; regex: RegExp } | null = null;  // Cached compiled regex

  // Auto-welcome tracking to prevent race conditions
  private welcomingNodes: Set<number> = new Set();  // Track nodes currently being welcomed

  // Virtual Node Server - Message capture for initialization sequence
  private initConfigCache: Array<{ type: string; data: Uint8Array }> = [];  // Store raw FromRadio messages with type metadata during init
  private isCapturingInitConfig = false;  // Flag to track when we're capturing messages
  private configCaptureComplete = false;  // Flag to track when capture is done
  private onConfigCaptureComplete: (() => void) | null = null;  // Callback for when config capture completes

  constructor() {
    // Initialize message queue service with send callback
    messageQueueService.setSendCallback(async (text: string, destination: number, replyId?: number, channel?: number) => {
      // For channel messages: channel is specified, destination is 0 (undefined in sendTextMessage)
      // For DMs: channel is undefined, destination is the node number
      if (channel !== undefined) {
        // Channel message - send to channel, no specific destination
        return await this.sendTextMessage(text, channel, undefined, replyId);
      } else {
        // DM - use the channel we last heard the target node on
        const targetNode = databaseService.getNode(destination);
        const dmChannel = (targetNode?.channel !== undefined && targetNode?.channel !== null) ? targetNode.channel : 0;
        logger.debug(`📨 Queue DM to ${destination} - Using channel: ${dmChannel}`);
        return await this.sendTextMessage(text, dmChannel, destination, replyId);
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
      const recalculateFlag = databaseService.getSetting('recalculate_estimated_positions');
      if (recalculateFlag !== 'pending') {
        return;
      }

      logger.info('📍 Recalculating estimated positions from historical traceroutes...');

      // Get all traceroutes with route data
      const traceroutes = databaseService.getAllTraceroutesForRecalculation();
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
      databaseService.setSetting('recalculate_estimated_positions', 'completed');
    } catch (error) {
      logger.error('❌ Error recalculating estimated positions:', error);
    }
  }

  /**
   * Get environment configuration (always uses fresh values from getEnvironmentConfig)
   * This ensures .env values are respected even if the manager is instantiated before dotenv loads
   */
  private getConfig(): MeshtasticConfig {
    const env = getEnvironmentConfig();

    // Check for runtime override in settings (set via UI)
    const overrideIp = databaseService.getSetting('meshtasticNodeIpOverride');
    const overridePortStr = databaseService.getSetting('meshtasticTcpPortOverride');
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
  private getScriptConnectionConfig(): MeshtasticConfig {
    const env = getEnvironmentConfig();
    if (env.enableVirtualNode) {
      return {
        nodeIp: '127.0.0.1',
        tcpPort: env.virtualNodePort,
      };
    }
    return this.getConfig();
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

    await databaseService.setSettingAsync('meshtasticNodeIpOverride', ip);
    if (port) {
      await databaseService.setSettingAsync('meshtasticTcpPortOverride', port);
    } else {
      // Clear port override if not specified (use default)
      await databaseService.setSettingAsync('meshtasticTcpPortOverride', '');
    }

    // Disconnect and reconnect with new IP/port
    this.disconnect();
    await this.connect();
  }

  /**
   * Clear the runtime IP/port override and revert to defaults
   */
  async clearNodeIpOverride(): Promise<void> {
    await databaseService.setSettingAsync('meshtasticNodeIpOverride', '');
    await databaseService.setSettingAsync('meshtasticTcpPortOverride', '');
    this.disconnect();
    await this.connect();
  }

  /**
   * Save an array of telemetry metrics to the database
   * Filters out undefined/null/NaN values before inserting
   */
  private saveTelemetryMetrics(
    metricsToSave: Array<{ type: string; value: number | undefined; unit: string }>,
    nodeId: string,
    fromNum: number,
    timestamp: number,
    packetTimestamp: number | undefined
  ): void {
    const now = Date.now();
    for (const metric of metricsToSave) {
      if (metric.value !== undefined && metric.value !== null && !isNaN(Number(metric.value))) {
        databaseService.insertTelemetry({
          nodeId,
          nodeNum: fromNum,
          telemetryType: metric.type,
          timestamp,
          value: Number(metric.value),
          unit: metric.unit,
          createdAt: now,
          packetTimestamp
        });
      }
    }
  }

  async connect(): Promise<boolean> {
    try {
      const config = this.getConfig();
      logger.debug(`Connecting to Meshtastic node at ${config.nodeIp}:${config.tcpPort}...`);

      // Initialize protobuf service first
      await meshtasticProtobufService.initialize();

      // Create TCP transport
      this.transport = new TcpTransport();

      // Configure stale connection timeout from environment
      const env = getEnvironmentConfig();
      this.transport.setStaleConnectionTimeout(env.meshtasticStaleConnectionTimeout);

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
    });

    // Clear localNodeInfo so node will be marked as not responsive until it sends MyNodeInfo
    this.localNodeInfo = null;

    // Notify server event service of connection (handles initial vs reconnect logic)
    await serverEventNotificationService.notifyNodeConnected();

    try {
      // Enable message capture for virtual node server
      // Clear any previous cache and start capturing
      this.initConfigCache = [];
      this.configCaptureComplete = false;
      this.isCapturingInitConfig = true;
      logger.info('📸 Starting init config capture for virtual node server');

      // Send want_config_id to request full node DB and config
      await this.sendWantConfigId();

      logger.debug('⏳ Waiting for configuration data from node...');

      // Note: With TCP, we don't need to poll - messages arrive via events
      // The configuration will come in automatically as the node sends it

      // Explicitly request LoRa config (config type 5) for Configuration tab
      // Give the device a moment to process want_config_id first
      setTimeout(async () => {
        try {
          logger.info('📡 Requesting LoRa config from device...');
          await this.requestConfig(5); // LORA_CONFIG = 5
        } catch (error) {
          logger.error('❌ Failed to request LoRa config:', error);
        }
      }, 2000);

      // Request all module configs for complete device backup capability
      setTimeout(async () => {
        try {
          logger.info('📦 Requesting all module configs for backup...');
          await this.requestAllModuleConfigs();
        } catch (error) {
          logger.error('❌ Failed to request all module configs:', error);
        }
      }, 3000); // Start after LoRa config request

      // Give the node a moment to send initial config, then do basic setup
      setTimeout(async () => {
        // Channel 0 will be created automatically when device config syncs

        // If localNodeInfo wasn't set during configuration, initialize it from database
        if (!this.localNodeInfo) {
          await this.initializeLocalNodeInfoFromDatabase();
        }

        // Start automatic traceroute scheduler
        this.startTracerouteScheduler();

        // Start remote admin discovery scanner
        this.startRemoteAdminScanner();

        // Start automatic time sync scheduler
        this.startTimeSyncScheduler();

        // Start automatic LocalStats collection
        this.startLocalStatsScheduler();

        // Start time-offset telemetry scheduler
        this.startTimeOffsetScheduler();

        // Start automatic announcement scheduler
        this.startAnnounceScheduler();

        // Start timer trigger scheduler
        this.startTimerScheduler();

        // Start geofence engine
        this.initGeofenceEngine();

        // Start auto key repair scheduler
        this.startKeyRepairScheduler();

        logger.debug(`✅ Configuration complete: ${databaseService.getNodeCount()} nodes, ${databaseService.getChannelCount()} channels`);
      }, 5000);

    } catch (error) {
      logger.error('❌ Failed to request configuration:', error);
      this.ensureBasicSetup();
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
    });

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
      await serverEventNotificationService.notifyNodeDisconnected();
    }

    // Only auto-reconnect if not in user-disconnected state
    if (this.userDisconnectedState) {
      logger.debug('User-initiated disconnect active, skipping auto-reconnect');
    } else {
      // Transport will handle automatic reconnection
      logger.debug('Auto-reconnection will be attempted by transport');
    }
  }

  private createDefaultChannels(): void {
    logger.debug('📡 Creating default channel configuration...');

    // Create default channel with ID 0 for messages that use channel 0
    // This is Meshtastic's default channel when no specific channel is configured
    try {
      const existingChannel0 = databaseService.getChannelById(0);
      if (!existingChannel0) {
        // Manually insert channel with ID 0 since it might not come from device
        // Use upsertChannel to properly set role=PRIMARY (1)
        databaseService.upsertChannel({
          id: 0,
          name: 'Primary',
          role: 1  // PRIMARY
        });
        logger.debug('📡 Created Primary channel with ID 0 and role PRIMARY');
      }
    } catch (error) {
      logger.error('❌ Failed to create Primary channel:', error);
    }
  }

  private ensureBasicSetup(): void {
    logger.debug('🔧 Ensuring basic setup is complete...');

    // Ensure we have at least a Primary channel
    const channelCount = databaseService.getChannelCount();
    if (channelCount === 0) {
      this.createDefaultChannels();
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
  private logOutgoingPacket(
    portnum: number,
    destination: number,
    channel: number,
    payloadPreview: string,
    metadata: Record<string, unknown> = {}
  ): void {
    if (!packetLogService.isEnabled()) return;

    const localNodeNum = this.localNodeInfo?.nodeNum;
    if (!localNodeNum) return;

    const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
    const toNodeId = destination === 0xffffffff
      ? 'broadcast'
      : `!${destination.toString(16).padStart(8, '0')}`;

    packetLogService.logPacket({
      timestamp: Math.floor(Date.now() / 1000),
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

    // Stop LocalStats collection
    this.stopLocalStatsScheduler();

    // Stop time-offset telemetry collection
    this.stopTimeOffsetScheduler();
    this.timeOffsetSamples = [];

    logger.debug('Disconnected from Meshtastic node');
  }

  /**
   * Register a callback to be called when config capture is complete
   * This is used to initialize the virtual node server after connection is ready
   */
  public registerConfigCaptureCompleteCallback(callback: () => void): void {
    this.onConfigCaptureComplete = callback;
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
      // Check time window schedule
      const scheduleEnabled = databaseService.getSetting('tracerouteScheduleEnabled');
      if (scheduleEnabled === 'true') {
        const start = databaseService.getSetting('tracerouteScheduleStart') || '00:00';
        const end = databaseService.getSetting('tracerouteScheduleEnd') || '00:00';
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

          // Use async version which supports PostgreSQL/MySQL
          const targetNode = await databaseService.getNodeNeedingTracerouteAsync(this.localNodeInfo.nodeNum);
          if (targetNode) {
            const channel = targetNode.channel ?? 0; // Use node's channel, default to 0
            const targetName = targetNode.longName || targetNode.nodeId;
            logger.info(`🗺️ Auto-traceroute: Sending traceroute to ${targetName} (${targetNode.nodeId}) on channel ${channel}`);

            // Log the auto-traceroute attempt to database
            await databaseService.logAutoTracerouteAttemptAsync(targetNode.nodeNum, targetName);
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
      this.startRemoteAdminScanner();
    }
  }

  /**
   * Start the remote admin scanner scheduler
   * Periodically checks nodes for remote admin capability
   */
  private startRemoteAdminScanner(): void {
    if (this.remoteAdminScannerInterval) {
      clearInterval(this.remoteAdminScannerInterval);
      this.remoteAdminScannerInterval = null;
    }

    // Load setting from database if not already set
    if (this.remoteAdminScannerIntervalMinutes === 0) {
      const savedInterval = databaseService.getSetting('remoteAdminScannerIntervalMinutes');
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
      const scheduleEnabled = databaseService.getSetting('remoteAdminScheduleEnabled');
      if (scheduleEnabled === 'true') {
        const start = databaseService.getSetting('remoteAdminScheduleStart') || '00:00';
        const end = databaseService.getSetting('remoteAdminScheduleEnd') || '00:00';
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
      this.startTimeSyncScheduler();
    }
  }

  /**
   * Start the automatic time sync scheduler
   */
  private startTimeSyncScheduler(): void {
    if (this.timeSyncInterval) {
      clearInterval(this.timeSyncInterval);
      this.timeSyncInterval = null;
    }

    // Load settings from database if not already set
    if (this.timeSyncIntervalMinutes === 0) {
      if (databaseService.isAutoTimeSyncEnabled()) {
        this.timeSyncIntervalMinutes = databaseService.getAutoTimeSyncIntervalMinutes();
      }
    }

    // If interval is 0 or time sync is disabled, scheduler is disabled
    if (this.timeSyncIntervalMinutes === 0 || !databaseService.isAutoTimeSyncEnabled()) {
      logger.info('🕐 Time sync scheduler is disabled');
      return;
    }

    const intervalMs = this.timeSyncIntervalMinutes * 60 * 1000;
    logger.info(`🕐 Starting time sync scheduler with ${this.timeSyncIntervalMinutes} minute interval`);

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

    const targetNode = await databaseService.getNodeNeedingTimeSyncAsync();
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
      await databaseService.updateNodeTimeSyncAsync(targetNode.nodeNum, Date.now());
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

    const targetNode = await databaseService.getNodeNeedingRemoteAdminCheckAsync(this.localNodeInfo.nodeNum);
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
        await databaseService.updateNodeRemoteAdminStatusAsync(nodeNum, true, JSON.stringify(metadata));
        return { hasRemoteAdmin: true, metadata };
      } else {
        // Timeout or failure - node doesn't have admin access (or is unreachable)
        logger.debug(`🔑 Remote admin scan: Node ${nodeNum} does not have remote admin access`);
        await databaseService.updateNodeRemoteAdminStatusAsync(nodeNum, false, null);
        return { hasRemoteAdmin: false, metadata: null };
      }
    } catch (error) {
      // Error - likely no admin access
      logger.info(`🔑 Remote admin scan: Node ${nodeNum} scan failed - no admin access`);
      logger.debug(`🔑 Remote admin scan error details:`, error);
      await databaseService.updateNodeRemoteAdminStatusAsync(nodeNum, false, null);
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
    try {
      const nodesNeedingRepair = databaseService.getNodesNeedingKeyRepair();

      for (const node of nodesNeedingRepair) {
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
              databaseService.logKeyRepairAttempt(node.nodeNum, nodeName, 'purge', true);
              logger.info(`🔐 Key repair: Purged node ${nodeName}, sending final node info exchange`);

              // Send one more node info exchange after purge
              await this.sendNodeInfoRequest(node.nodeNum, 0);
              databaseService.logKeyRepairAttempt(node.nodeNum, nodeName, 'exchange', null);
            } catch (error) {
              logger.error(`🔐 Key repair: Failed to purge node ${nodeName}:`, error);
              databaseService.logKeyRepairAttempt(node.nodeNum, nodeName, 'purge', false);
            }
          }

          // Mark as exhausted
          databaseService.setKeyRepairState(node.nodeNum, { exhausted: true });
          databaseService.logKeyRepairAttempt(node.nodeNum, nodeName, 'exhausted', null);
          continue;
        }

        // Send node info exchange
        logger.info(`🔐 Key repair: Sending node info exchange to ${nodeName} (attempt ${node.attemptCount + 1}/${this.keyRepairMaxExchanges})`);
        try {
          await this.sendNodeInfoRequest(node.nodeNum, 0);

          // Update repair state
          databaseService.setKeyRepairState(node.nodeNum, {
            attemptCount: node.attemptCount + 1,
            lastAttemptTime: now,
            startedAt: node.startedAt ?? now
          });

          databaseService.logKeyRepairAttempt(node.nodeNum, nodeName, 'exchange', null);
        } catch (error) {
          logger.error(`🔐 Key repair: Failed to send node info to ${nodeName}:`, error);
          databaseService.logKeyRepairAttempt(node.nodeNum, nodeName, 'exchange', false);
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

    logger.debug(`🔐 Key repair settings updated: enabled=${this.keyRepairEnabled}, interval=${this.keyRepairIntervalMinutes}min, maxExchanges=${this.keyRepairMaxExchanges}, autoPurge=${this.keyRepairAutoPurge}`);

    // Restart scheduler if connected
    if (this.isConnected) {
      this.startKeyRepairScheduler();
    }
  }

  /**
   * Start periodic LocalStats collection from the local node
   * Requests LocalStats every 5 minutes to track mesh health metrics
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

    // Request immediately on start
    if (this.isConnected && this.localNodeInfo) {
      this.requestLocalStats().catch(error => {
        logger.error('❌ Error requesting initial LocalStats:', error);
      });
      // Also save system node metrics on initial request
      this.saveSystemNodeMetrics().catch(error => {
        logger.error('❌ Error saving initial system node metrics:', error);
      });
    }

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
      });
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
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
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
      });
      await databaseService.insertTelemetryAsync({
        nodeId: this.localNodeInfo.nodeId,
        nodeNum: this.localNodeInfo.nodeNum,
        telemetryType: 'systemDirectNodeCount',
        timestamp: now,
        value: directCount,
        createdAt: now,
      });

      logger.debug(`📊 Saved system node metrics: ${nodeCount} active nodes, ${directCount} direct nodes`);
    } catch (error) {
      logger.error('❌ Error saving system node metrics:', error);
    }
  }

  private startAnnounceScheduler(): void {
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
    const autoAnnounceEnabled = databaseService.getSetting('autoAnnounceEnabled');
    if (autoAnnounceEnabled !== 'true') {
      logger.debug('📢 Auto-announce is disabled');
      return;
    }

    // Check if we should use scheduled sends (cron) or interval
    const useSchedule = databaseService.getSetting('autoAnnounceUseSchedule') === 'true';

    if (useSchedule) {
      const scheduleExpression = databaseService.getSetting('autoAnnounceSchedule') || '0 */6 * * *';
      logger.debug(`📢 Starting announce scheduler with cron expression: ${scheduleExpression}`);

      // Validate and schedule the cron job
      if (cron.validate(scheduleExpression)) {
        this.announceCronJob = cron.schedule(scheduleExpression, async () => {
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
      // Use interval-based scheduling
      const intervalHours = parseInt(databaseService.getSetting('autoAnnounceIntervalHours') || '6');
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

    // Check if announce-on-start is enabled (applies to both cron and interval modes)
    const announceOnStart = databaseService.getSetting('autoAnnounceOnStart');
    if (announceOnStart === 'true') {
      // Check spam protection: don't send if announced within last hour
      const lastAnnouncementTime = databaseService.getSetting('lastAnnouncementTime');
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      if (lastAnnouncementTime) {
        const timeSinceLastAnnouncement = now - parseInt(lastAnnouncementTime);
        if (timeSinceLastAnnouncement < oneHour) {
          const minutesRemaining = Math.ceil((oneHour - timeSinceLastAnnouncement) / 60000);
          logger.debug(`📢 Skipping startup announcement - last announcement was ${Math.floor(timeSinceLastAnnouncement / 60000)} minutes ago (spam protection: ${minutesRemaining} minutes remaining)`);
        } else {
          logger.debug('📢 Sending startup announcement');
          // Send announcement after a short delay to ensure connection is stable
          setTimeout(async () => {
            if (this.isConnected) {
              try {
                await this.sendAutoAnnouncement();
              } catch (error) {
                logger.error('❌ Error in startup announcement:', error);
              }
            }
          }, 5000);
        }
      } else {
        // No previous announcement, send one
        logger.debug('📢 Sending first startup announcement');
        setTimeout(async () => {
          if (this.isConnected) {
            try {
              await this.sendAutoAnnouncement();
            } catch (error) {
              logger.error('❌ Error in startup announcement:', error);
            }
          }
        }, 5000);
      }
    }
  }

  setAnnounceInterval(hours: number): void {
    if (hours < 3 || hours > 24) {
      throw new Error('Announce interval must be between 3 and 24 hours');
    }

    logger.debug(`📢 Announce interval updated to ${hours} hours`);

    if (this.isConnected) {
      this.startAnnounceScheduler();
    }
  }

  restartAnnounceScheduler(): void {
    logger.debug('📢 Restarting announce scheduler due to settings change');

    if (this.isConnected) {
      this.startAnnounceScheduler();
    }
  }

  /**
   * Start timer trigger schedulers based on saved settings
   */
  private startTimerScheduler(): void {
    // Stop all existing timer cron jobs
    this.timerCronJobs.forEach((job, id) => {
      job.stop();
      logger.debug(`⏱️ Stopped timer cron job: ${id}`);
    });
    this.timerCronJobs.clear();

    // Load timer triggers from settings
    const timerTriggersJson = databaseService.getSetting('timerTriggers');
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

    // Schedule each enabled timer
    for (const trigger of timerTriggers) {
      if (!trigger.enabled) {
        logger.debug(`⏱️ Timer "${trigger.name}" is disabled, skipping`);
        continue;
      }

      // Validate cron expression
      if (!cron.validate(trigger.cronExpression)) {
        logger.error(`⏱️ Invalid cron expression for timer "${trigger.name}": ${trigger.cronExpression}`);
        continue;
      }

      // Schedule the cron job
      const job = cron.schedule(trigger.cronExpression, async () => {
        logger.info(`⏱️ Timer "${trigger.name}" triggered (cron: ${trigger.cronExpression})`);
        const responseType = trigger.responseType || 'script'; // Default to script for backward compatibility
        if (responseType === 'text' && trigger.response?.trim()) {
          await this.executeTimerTextMessage(trigger.id, trigger.name, trigger.response, trigger.channel ?? 0);
        } else if (trigger.scriptPath) {
          await this.executeTimerScript(trigger.id, trigger.name, trigger.scriptPath, trigger.channel ?? 0, trigger.scriptArgs);
        } else {
          logger.error(`⏱️ Timer "${trigger.name}" has no valid response configured`);
          this.updateTimerTriggerResult(trigger.id, 'error', 'No response configured');
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
    this.startTimerScheduler();
  }

  // ─── Geofence Engine ───────────────────────────────────────────────────

  /**
   * Initialize the geofence engine. Loads triggers from settings,
   * computes initial inside/outside state from current node positions
   * (without firing events), and sets up "while inside" interval timers.
   */
  private initGeofenceEngine(): void {
    // Clear existing state and timers
    this.geofenceWhileInsideTimers.forEach(timer => clearInterval(timer));
    this.geofenceWhileInsideTimers.clear();
    this.geofenceNodeState.clear();

    const triggersJson = databaseService.getSetting('geofenceTriggers');
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

    const enabledTriggers = triggers.filter(t => t.enabled);
    if (enabledTriggers.length === 0) {
      logger.debug('📍 No enabled geofence triggers');
      return;
    }

    // Compute initial state from current node positions (no events fired)
    const allNodes = databaseService.getAllNodes ? databaseService.getAllNodes() : [];
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
          this.executeWhileInsideGeofenceTrigger(trigger);
        }, intervalMs);
        this.geofenceWhileInsideTimers.set(trigger.id, timer);
        logger.info(`📍 Geofence "${trigger.name}": while_inside timer set for every ${trigger.whileInsideIntervalMinutes} minute(s)`);
      }
    }

    logger.info(`📍 Geofence engine started with ${enabledTriggers.length} active trigger(s)`);
  }

  /**
   * Check all geofence triggers for a node that just reported a new position.
   * Fires entry/exit events based on state transitions.
   */
  private checkGeofencesForNode(nodeNum: number, lat: number, lng: number): void {
    const triggersJson = databaseService.getSetting('geofenceTriggers');
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
          logger.info(`📍 Geofence "${trigger.name}": node ${nodeNum} entered`);
          this.executeGeofenceTrigger(trigger, nodeNum, lat, lng, 'entry');
        }
      } else if (!isInside && wasInside) {
        // Node exited geofence
        stateSet.delete(nodeNum);
        this.geofenceNodeState.set(trigger.id, stateSet);
        if (trigger.event === 'exit') {
          logger.info(`📍 Geofence "${trigger.name}": node ${nodeNum} exited`);
          this.executeGeofenceTrigger(trigger, nodeNum, lat, lng, 'exit');
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
        messageQueueService.enqueue(
          truncated,
          isDM ? nodeNum : 0,
          undefined,
          () => logger.info(`✅ Geofence "${trigger.name}" message delivered to ${isDM ? `DM (node ${nodeNum})` : `channel ${trigger.channel}`}`),
          (reason: string) => logger.warn(`❌ Geofence "${trigger.name}" message failed: ${reason}`),
          isDM ? undefined : trigger.channel as number,
          maxAttempts
        );

        this.updateGeofenceTriggerResult(trigger.id, 'success');
      } else if (trigger.responseType === 'script' && trigger.scriptPath) {
        await this.executeGeofenceScript(trigger, nodeNum, lat, lng, eventType);
      } else {
        logger.error(`📍 Geofence "${trigger.name}" has no valid response configured`);
        this.updateGeofenceTriggerResult(trigger.id, 'error', 'No response configured');
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      logger.error(`📍 Geofence "${trigger.name}" trigger failed: ${errorMessage}`);
      this.updateGeofenceTriggerResult(trigger.id, 'error', errorMessage);
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
      this.updateGeofenceTriggerResult(trigger.id, 'error', 'Invalid script path');
      return;
    }

    const resolvedPath = this.resolveScriptPath(scriptPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      logger.error(`📍 Script file not found for geofence "${trigger.name}": ${scriptPath}`);
      this.updateGeofenceTriggerResult(trigger.id, 'error', 'Script file not found');
      return;
    }

    const ext = scriptPath.split('.').pop()?.toLowerCase();
    let interpreter: string;
    const isDev = process.env.NODE_ENV !== 'production';

    switch (ext) {
      case 'js': case 'mjs': interpreter = isDev ? 'node' : '/usr/local/bin/node'; break;
      case 'py': interpreter = isDev ? 'python' : '/usr/bin/python3'; break;
      case 'sh': interpreter = isDev ? 'sh' : '/bin/sh'; break;
      default:
        this.updateGeofenceTriggerResult(trigger.id, 'error', `Unsupported script extension: ${ext}`);
        return;
    }

    const startTime = Date.now();
    logger.info(`📍 Executing geofence script: "${trigger.name}" (${eventType}) -> ${scriptPath}`);

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const node = databaseService.getNode(nodeNum);
      const dist = distanceToGeofenceCenter(lat, lng, trigger.shape);
      const config = this.getScriptConnectionConfig();

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
        const mmNode = databaseService.getNode(localNodeInfo.nodeNum);
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
          this.updateGeofenceTriggerResult(trigger.id, 'success');
          return;
        }

        let scriptResponses: string[];
        if (scriptOutput.responses && Array.isArray(scriptOutput.responses)) {
          scriptResponses = scriptOutput.responses.filter((r: any) => typeof r === 'string');
        } else if (scriptOutput.response && typeof scriptOutput.response === 'string') {
          scriptResponses = [scriptOutput.response];
        } else {
          this.updateGeofenceTriggerResult(trigger.id, 'success');
          return;
        }

        // Skip sending if channel is 'none' (script handles its own output)
        if (trigger.channel !== 'none') {
          const isDM = trigger.channel === 'dm';
          // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
          const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
          for (const resp of scriptResponses) {
            const truncated = this.truncateMessageForMeshtastic(resp, 200);
            messageQueueService.enqueue(
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
      this.updateGeofenceTriggerResult(trigger.id, 'success');
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || 'Unknown error';
      logger.error(`📍 Geofence "${trigger.name}" script failed after ${duration}ms: ${errorMessage}`);
      if (error.stderr) logger.error(`📍 Geofence script stderr: ${error.stderr}`);
      if (error.stdout) logger.warn(`📍 Geofence script stdout before failure: ${error.stdout.substring(0, 200)}`);
      this.updateGeofenceTriggerResult(trigger.id, 'error', errorMessage);
    }
  }

  /**
   * Called by interval timer for "while inside" geofence triggers.
   * Iterates nodes currently in the geofence and fires the trigger for each.
   */
  private executeWhileInsideGeofenceTrigger(trigger: GeofenceTriggerConfig): void {
    const stateSet = this.geofenceNodeState.get(trigger.id);
    if (!stateSet || stateSet.size === 0) return;

    for (const nodeNum of stateSet) {
      const node = databaseService.getNode(nodeNum);
      if (!node || node.latitude == null || node.longitude == null) continue;

      // Re-validate position is still inside
      if (!isPointInGeofence(node.latitude, node.longitude, trigger.shape)) {
        stateSet.delete(nodeNum);
        logger.debug(`📍 Geofence "${trigger.name}": node ${nodeNum} no longer inside (stale position)`);
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
    const node = databaseService.getNode(nodeNum);
    const dist = distanceToGeofenceCenter(lat, lng, trigger.shape);

    const config = this.getConfig();

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
  private updateGeofenceTriggerResult(triggerId: string, result: 'success' | 'error', errorMessage?: string): void {
    try {
      const triggersJson = databaseService.getSetting('geofenceTriggers');
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

        databaseService.setSetting('geofenceTriggers', JSON.stringify(triggers));
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
    this.initGeofenceEngine();
  }

  /**
   * Execute a timer trigger script and send output to specified channel
   */
  private async executeTimerScript(triggerId: string, triggerName: string, scriptPath: string, channel: number | 'none', scriptArgs?: string): Promise<void> {
    const startTime = Date.now();

    // Validate script path
    if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
      logger.error(`⏱️ Invalid script path for timer "${triggerName}": ${scriptPath}`);
      this.updateTimerTriggerResult(triggerId, 'error', 'Invalid script path');
      return;
    }

    // Resolve script path
    const resolvedPath = this.resolveScriptPath(scriptPath);
    if (!resolvedPath) {
      logger.error(`⏱️ Failed to resolve script path for timer "${triggerName}": ${scriptPath}`);
      this.updateTimerTriggerResult(triggerId, 'error', 'Failed to resolve script path');
      return;
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      logger.error(`⏱️ Script file not found for timer "${triggerName}": ${resolvedPath}`);
      this.updateTimerTriggerResult(triggerId, 'error', 'Script file not found');
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
        interpreter = isDev ? 'python' : '/usr/bin/python3';
        break;
      case 'sh':
        interpreter = isDev ? 'sh' : '/bin/sh';
        break;
      default:
        logger.error(`⏱️ Unsupported script extension for timer "${triggerName}": ${ext}`);
        this.updateTimerTriggerResult(triggerId, 'error', `Unsupported script extension: ${ext}`);
        return;
    }

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      // Prepare environment variables for timer scripts
      const config = this.getScriptConnectionConfig();
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
        const mmNode = databaseService.getNode(localNodeInfo.nodeNum);
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
          this.updateTimerTriggerResult(triggerId, 'success');
          return;
        }

        // Support both single response and multiple responses
        let scriptResponses: string[];
        if (scriptOutput.responses && Array.isArray(scriptOutput.responses)) {
          // Multiple responses format: { "responses": ["msg1", "msg2", "msg3"] }
          scriptResponses = scriptOutput.responses.filter((r: any) => typeof r === 'string');
          if (scriptResponses.length === 0) {
            logger.warn(`⏱️ Timer script 'responses' array contains no valid strings`);
            this.updateTimerTriggerResult(triggerId, 'success');
            return;
          }
          logger.debug(`⏱️ Timer script returned ${scriptResponses.length} responses`);
        } else if (scriptOutput.response && typeof scriptOutput.response === 'string') {
          // Single response format: { "response": "msg" }
          scriptResponses = [scriptOutput.response];
          logger.debug(`⏱️ Timer script response: ${scriptOutput.response.substring(0, 50)}...`);
        } else {
          logger.debug(`⏱️ Timer script output has no 'response' or 'responses' field, ignoring`);
          this.updateTimerTriggerResult(triggerId, 'success');
          return;
        }

        // Skip sending if channel is 'none' (script handles its own output)
        if (channel !== 'none') {
          // Send each response to the specified channel
          logger.info(`⏱️ Enqueueing ${scriptResponses.length} timer response(s) to channel ${channel}`);

          scriptResponses.forEach((resp, index) => {
            const truncated = this.truncateMessageForMeshtastic(resp, 200);

            messageQueueService.enqueue(
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

      this.updateTimerTriggerResult(triggerId, 'success');

    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || 'Unknown error';
      logger.error(`⏱️ Timer "${triggerName}" failed after ${duration}ms: ${errorMessage}`);
      if (error.stderr) logger.error(`⏱️ Timer script stderr: ${error.stderr}`);
      if (error.stdout) logger.warn(`⏱️ Timer script stdout before failure: ${error.stdout.substring(0, 200)}`);
      this.updateTimerTriggerResult(triggerId, 'error', errorMessage);
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

      messageQueueService.enqueue(
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

      this.updateTimerTriggerResult(triggerId, 'success');

    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      logger.error(`⏱️ Timer "${triggerName}" text message failed: ${errorMessage}`);
      this.updateTimerTriggerResult(triggerId, 'error', errorMessage);
    }
  }

  /**
   * Update timer trigger result in settings
   */
  private updateTimerTriggerResult(triggerId: string, result: 'success' | 'error', errorMessage?: string): void {
    try {
      const timerTriggersJson = databaseService.getSetting('timerTriggers');
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

        databaseService.setSetting('timerTriggers', JSON.stringify(timerTriggers));
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
      // Skip broadcasting 'channel' type FromRadio messages — these should only reach clients
      // through the controlled sendInitialConfig() flow. Broadcasting raw FromRadio.channel
      // messages during physical node reconnection causes Android/iOS clients to receive
      // unsolicited channel updates with empty name fields, which the Meshtastic app displays
      // as the placeholder text "Channel Name" (fixes #1567).
      // If parsing failed, still broadcast the raw data (clients may understand it even if
      // the server can't parse it).
      const shouldBroadcast = !context?.skipVirtualNodeBroadcast &&
        (!parsed || parsed.type !== 'channel');
      if (shouldBroadcast) {
        const virtualNodeServer = (global as any).virtualNodeServer;
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
                import('../services/lowEntropyKeyService.js').then(({ checkLowEntropyKey }) => {
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
                    updateData.keySecurityIssueDetails = undefined;
                  }

                  databaseService.upsertNode(updateData);
                  logger.info(`💾 Saved local node public key to database for ${localNodeId}`);
                }).catch((err) => {
                  // If low entropy check fails, still save the key
                  databaseService.upsertNode({
                    nodeNum: localNodeNum,
                    nodeId: localNodeId,
                    publicKey: publicKeyBase64,
                    hasPKC: true
                  });
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
      const savedNodeNum = databaseService.getSetting('localNodeNum');
      const savedNodeId = databaseService.getSetting('localNodeId');

      if (savedNodeNum && savedNodeId) {
        const nodeNum = parseInt(savedNodeNum);
        logger.debug(`📱 Found saved local node info: ${savedNodeId} (${nodeNum})`);

        // Try to get full node info from database
        const node = databaseService.getNode(nodeNum);
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

    // Check for node ID mismatch with previously stored values
    const previousNodeNum = databaseService.getSetting('localNodeNum');
    const previousNodeId = databaseService.getSetting('localNodeId');
    if (previousNodeNum && previousNodeId) {
      const prevNum = parseInt(previousNodeNum);
      if (prevNum !== nodeNum) {
        logger.warn(`⚠️ NODE ID CHANGE DETECTED: Physical node changed from ${previousNodeId} (${prevNum}) to ${nodeId} (${nodeNum})`);
        logger.warn(`⚠️ This can happen if: (1) The physical node was factory reset, (2) A different physical node was connected, or (3) The node's ID was reconfigured`);
        logger.warn(`⚠️ Virtual node clients may briefly show the old node ID until they reconnect`);
        // Clear the init config cache to force fresh data for virtual node clients
        this.initConfigCache = [];
        logger.info(`📸 Cleared init config cache due to node ID change`);
      }
    }

    // Save local node info to settings for persistence
    databaseService.setSetting('localNodeNum', nodeNum.toString());
    databaseService.setSetting('localNodeId', nodeId);
    logger.debug(`💾 Saved local node info to settings: ${nodeId} (${nodeNum})`);

    // Check if we already have this node with actual names in the database
    const existingNode = databaseService.getNode(nodeNum);

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
      databaseService.upsertNode({
        nodeNum: nodeNum,
        nodeId: nodeId,
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
        hasRemoteAdmin: true  // Local node always has remote admin access
      });
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

      databaseService.upsertNode(nodeData);
      logger.debug(`📱 Stored basic local node info with rebootCount: ${myNodeInfo.rebootCount}, waiting for NodeInfo for names (${nodeId})`);
    }
    // Note: Local node's public key is extracted from security config when received
  }

  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string; hwModel?: number; firmwareVersion?: string; rebootCount?: number; isLocked?: boolean } | null {
    return this.localNodeInfo;
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
  getCurrentConfig(): { deviceConfig: any; moduleConfig: any; localNodeInfo: any } {
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

    return {
      deviceConfig,
      moduleConfig,
      localNodeInfo: this.localNodeInfo
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
        databaseService.upsertNode(nodeData);
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
      // Preserve the actual name from device (including empty strings for Channel 0)
      const channelName = channel.settings.name !== undefined ? channel.settings.name : `Channel ${channel.index}`;
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
          if (channel.settings.psk) {
            try {
              pskString = Buffer.from(channel.settings.psk).toString('base64');
            } catch (pskError) {
              logger.warn(`⚠️  Failed to convert PSK to base64 for channel ${channel.index} (${displayName}):`, pskError);
              pskString = undefined;
            }
          }

          // Extract position precision from module settings if available
          const positionPrecision = channel.settings.moduleSettings?.positionPrecision;

          // Defensive channel role validation:
          // 1. Channel 0 must be PRIMARY (role=1), never DISABLED (role=0)
          // 2. Channels 1-7 must be SECONDARY (role=2) or DISABLED (role=0), never PRIMARY (role=1)
          // A mesh network MUST have exactly ONE PRIMARY channel, and Channel 0 is conventionally PRIMARY
          let channelRole = channel.role !== undefined ? channel.role : undefined;
          if (channel.index === 0 && channel.role === 0) {
            logger.warn(`⚠️  Channel 0 received with role=DISABLED (0), overriding to PRIMARY (1)`);
            channelRole = 1;  // PRIMARY
          }

          if (channel.index > 0 && channel.role === 1) {
            logger.warn(`⚠️  Channel ${channel.index} received with role=PRIMARY (1), overriding to SECONDARY (2)`);
            logger.warn(`⚠️  Only Channel 0 can be PRIMARY - all other channels must be SECONDARY or DISABLED`);
            channelRole = 2;  // SECONDARY
          }

          logger.info(`📡 Saving channel ${channel.index} (${displayName}) - role: ${channelRole}, positionPrecision: ${positionPrecision}`);
          logger.info(`📡 Database will store name as: "${channelName}" (length: ${channelName.length})`);

          databaseService.upsertChannel({
            id: channel.index,
            name: channelName,
            psk: pskString,
            role: channelRole,
            uplinkEnabled: channel.settings.uplinkEnabled ?? true,
            downlinkEnabled: channel.settings.downlinkEnabled ?? true,
            positionPrecision: positionPrecision !== undefined ? positionPrecision : undefined
          });
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
      if (packetLogService.isEnabled()) {
        const fromNum = meshPacket.from ? Number(meshPacket.from) : 0;
        const toNum = meshPacket.to ? Number(meshPacket.to) : null;
        const fromNodeId = fromNum ? `!${fromNum.toString(16).padStart(8, '0')}` : null;
        const toNodeId = toNum ? `!${toNum.toString(16).padStart(8, '0')}` : null;

        // Check if packet is encrypted (no decoded field or empty payload)
        const isEncrypted = !meshPacket.decoded || !meshPacket.decoded.payload;
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
          timestamp: meshPacket.rxTime ? Number(meshPacket.rxTime) : Math.floor(Date.now() / 1000),
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
          payload_size: meshPacket.decoded?.payload?.length ?? undefined,
          want_ack: meshPacket.wantAck ?? false,
          priority: meshPacket.priority ?? undefined,
          payload_preview: payloadPreview ?? undefined,
          metadata: JSON.stringify(metadata),
          direction: fromNum === this.localNodeInfo?.nodeNum ? 'tx' : 'rx',
          decrypted_by: decryptedBy ?? undefined,
          decrypted_channel_id: decryptedChannelId ?? undefined,
          // Note: ?? (nullish coalescing) correctly preserves 0 (INTERNAL), only defaults on null/undefined
          transport_mechanism: meshPacket.transportMechanism ?? TransportMechanism.LORA,
        });
        } // end else (not internal packet)
      }
    } catch (error) {
      logger.error('❌ Failed to log packet:', error);
    }

    // Extract node information if available
    // Note: Only update technical fields (SNR/RSSI/lastHeard), not names
    // Names should only come from NODEINFO packets
    if (meshPacket.from && meshPacket.from !== BigInt(0)) {
      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;

      // Check if node exists first
      const existingNode = databaseService.getNode(fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Cap lastHeard at current time to prevent stale timestamps from node clock issues
        lastHeard: Math.min(meshPacket.rxTime ? Number(meshPacket.rxTime) : Date.now() / 1000, Date.now() / 1000)
      };

      // Only set default name if this is a brand new node
      if (!existingNode) {
        nodeData.longName = `Node ${nodeId}`;
        nodeData.shortName = nodeId.substring(1, 5);
      }

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }
      databaseService.upsertNode(nodeData);

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
        databaseService.updateNodeMessageHops(fromNum, messageHops);

        // Store hop count as telemetry for Smart Hops tracking
        databaseService.insertTelemetry({
          nodeId: nodeId,
          nodeNum: fromNum,
          telemetryType: 'messageHops',
          timestamp: Date.now(),
          value: messageHops,
          unit: 'hops',
          createdAt: Date.now(),
        });

        // Update Link Quality based on hop count comparison
        this.updateLinkQualityForMessage(fromNum, messageHops);
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
          default:
            logger.debug(`🤷 Unhandled portnum: ${normalizedPortNum} (${meshtasticProtobufService.getPortNumName(portnum)})`);
        }
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

        // Ensure the from node exists in the database
        const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
        const existingFromNode = databaseService.getNode(fromNum);
        if (!existingFromNode) {
          // Create a basic node entry if it doesn't exist
          const basicNodeData = {
            nodeNum: fromNum,
            nodeId: fromNodeId,
            longName: `Node ${fromNodeId}`,
            shortName: fromNodeId.substring(1, 5),
            lastHeard: Date.now() / 1000,
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          databaseService.upsertNode(basicNodeData);
          logger.debug(`📝 Created basic node entry for ${fromNodeId}`);
        }

        // Handle broadcast address (4294967295 = 0xFFFFFFFF)
        let actualToNum = toNum;
        const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

        if (toNum === 4294967295) {
          // For broadcast messages, use a special broadcast node
          const broadcastNodeNum = 4294967295;
          const existingBroadcastNode = databaseService.getNode(broadcastNodeNum);
          if (!existingBroadcastNode) {
            const broadcastNodeData = {
              nodeNum: broadcastNodeNum,
              nodeId: '!ffffffff',
              longName: 'Broadcast',
              shortName: 'BCAST',
              lastHeard: Date.now() / 1000,
              createdAt: Date.now(),
              updatedAt: Date.now()
            };
            databaseService.upsertNode(broadcastNodeData);
            logger.debug(`📝 Created broadcast node entry`);
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
          // Use Channel Database ID + offset for server-decrypted messages
          channelIndex = CHANNEL_DB_OFFSET + context.decryptedChannelId;
        } else {
          channelIndex = meshPacket.channel !== undefined ? meshPacket.channel : 0;
        }

        // Ensure channel 0 exists if this message uses it
        if (!isDirectMessage && channelIndex === 0) {
          const channel0 = databaseService.getChannelById(0);
          if (!channel0) {
            logger.debug('📡 Creating channel 0 for message (name will be set when device config syncs)');
            // Create with role=1 (Primary) as channel 0 is always the primary channel in Meshtastic
            databaseService.upsertChannel({ id: 0, name: '', role: 1 });
          }
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
          id: `${fromNum}_${meshPacket.id || Date.now()}`,
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
          viaMqtt: meshPacket.viaMqtt === true, // Capture whether message was received via MQTT bridge
          rxSnr: meshPacket.rxSnr ?? (meshPacket as any).rx_snr, // SNR of received packet
          rxRssi: meshPacket.rxRssi ?? (meshPacket as any).rx_rssi, // RSSI of received packet
          requestId: context?.virtualNodeRequestId, // For Virtual Node messages, preserve packet ID for ACK matching
          wantAck: context?.virtualNodeRequestId ? true : undefined, // Expect ACK for Virtual Node messages
          deliveryState: context?.virtualNodeRequestId ? 'pending' : undefined, // Track delivery for Virtual Node messages
          createdAt: Date.now(),
          decryptedBy: context?.decryptedBy ?? null, // Track decryption source - 'server' means read-only
        };
        databaseService.insertMessage(message);

        // Emit WebSocket event for real-time updates
        dataEventEmitter.emitNewMessage(message as any);

        if (isDirectMessage) {
          logger.debug(`💾 Saved direct message from ${message.fromNodeId} to ${message.toNodeId}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
        } else {
          logger.debug(`💾 Saved channel message from ${message.fromNodeId} on channel ${channelIndex}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
        }

        // Send push notification for new message
        await this.sendMessagePushNotification(message, messageText, isDirectMessage);

        // Auto-acknowledge matching messages
        await this.checkAutoAcknowledge(message, messageText, channelIndex, isDirectMessage, fromNum, meshPacket.id, meshPacket.rxSnr, meshPacket.rxRssi);

        // Auto-respond to matching messages
        await this.checkAutoResponder(message, isDirectMessage, meshPacket.id);
      }
    } catch (error) {
      logger.error('❌ Error processing text message:', error);
    }
  }

  /**
   * Legacy text message processing (for backward compatibility)
   */

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

        // Extract position precision metadata
        const channelIndex = meshPacket.channel !== undefined ? meshPacket.channel : 0;
        // Use precision_bits from packet if available, otherwise fall back to channel's positionPrecision
        // Also fall back if precisionBits is 0 (which means no precision was set)
        let precisionBits = position.precisionBits ?? position.precision_bits ?? undefined;
        if (precisionBits === undefined || precisionBits === 0) {
          const channel = databaseService.getChannelById(channelIndex);
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
          const pendingMessages = databaseService.getDirectMessages(localNodeId, nodeId, 100);
          const pendingExchangeRequest = pendingMessages.find((msg: DbMessage) =>
            msg.text === 'Position exchange requested' &&
            msg.fromNodeNum === localNodeInfo.nodeNum &&
            msg.toNodeNum === fromNum &&
            msg.requestId !== undefined // Must have a requestId
          );

          if (pendingExchangeRequest && pendingExchangeRequest.requestId !== undefined) {
            // Mark the position exchange request as delivered
            databaseService.updateMessageDeliveryState(pendingExchangeRequest.requestId, 'delivered');
            logger.info(`📍 Position exchange acknowledged: Received position from ${nodeId}, marking request message as delivered`);
          }
        }

        // Track PKI encryption
        this.trackPKIEncryption(meshPacket, fromNum);

        // Determine if we should update position based on precision upgrade/downgrade logic
        const existingNode = databaseService.getNode(fromNum);
        let shouldUpdatePosition = true;

        if (existingNode && existingNode.positionPrecisionBits !== undefined && precisionBits !== undefined) {
          const existingPrecision = existingNode.positionPrecisionBits;
          const newPrecision = precisionBits;
          const existingPositionAge = existingNode.positionTimestamp ? (now - existingNode.positionTimestamp) : Infinity;
          const twelveHoursMs = 12 * 60 * 60 * 1000;

          // Smart upgrade/downgrade logic:
          // - Always upgrade to higher precision
          // - Only downgrade if existing position is >12 hours old
          if (newPrecision < existingPrecision && existingPositionAge < twelveHoursMs) {
            shouldUpdatePosition = false;
            logger.debug(`🗺️ Skipping position update for ${nodeId}: New precision (${newPrecision}) < existing (${existingPrecision}) and existing position is recent (${Math.round(existingPositionAge / 1000 / 60)}min old)`);
          } else if (newPrecision > existingPrecision) {
            logger.debug(`🗺️ Upgrading position precision for ${nodeId}: ${existingPrecision} -> ${newPrecision} bits (channel ${channelIndex})`);
          } else if (existingPositionAge >= twelveHoursMs) {
            logger.debug(`🗺️ Updating stale position for ${nodeId}: existing is ${Math.round(existingPositionAge / 1000 / 60 / 60)}h old`);
          }
        }

        // Always save position to telemetry table for historical tracking
        // This ensures position history is complete regardless of precision changes
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'latitude',
          timestamp, value: coords.latitude, unit: '°', createdAt: now, packetTimestamp,
          channel: channelIndex, precisionBits, gpsAccuracy
        });
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'longitude',
          timestamp, value: coords.longitude, unit: '°', createdAt: now, packetTimestamp,
          channel: channelIndex, precisionBits, gpsAccuracy
        });
        if (position.altitude !== undefined && position.altitude !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'altitude',
            timestamp, value: position.altitude, unit: 'm', createdAt: now, packetTimestamp,
            channel: channelIndex
          });
        }

        // Store satellites in view for GPS accuracy tracking
        const satsInView = position.satsInView ?? position.sats_in_view;
        if (satsInView !== undefined && satsInView > 0) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'sats_in_view',
            timestamp, value: satsInView, unit: 'sats', createdAt: now, packetTimestamp,
            channel: channelIndex
          });
        }

        // Store ground speed if available (in m/s)
        const groundSpeed = position.groundSpeed ?? position.ground_speed;
        if (groundSpeed !== undefined && groundSpeed > 0) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ground_speed',
            timestamp, value: groundSpeed, unit: 'm/s', createdAt: now, packetTimestamp,
            channel: channelIndex
          });
        }

        // Store ground track/heading if available (in 1/100 degrees, convert to degrees)
        const groundTrack = position.groundTrack ?? position.ground_track;
        if (groundTrack !== undefined && groundTrack > 0) {
          // groundTrack is in 1/100 degrees per protobuf spec, convert to degrees
          const headingDegrees = groundTrack / 100;
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ground_track',
            timestamp, value: headingDegrees, unit: '°', createdAt: now, packetTimestamp,
            channel: channelIndex
          });
        }

        // Only update node's current position if precision check passes
        if (shouldUpdatePosition) {
          const nodeData: any = {
            nodeNum: fromNum,
            nodeId: nodeId,
            latitude: coords.latitude,
            longitude: coords.longitude,
            altitude: position.altitude,
            // Cap lastHeard at current time to prevent stale timestamps from node clock issues
            lastHeard: Math.min(meshPacket.rxTime ? Number(meshPacket.rxTime) : Date.now() / 1000, Date.now() / 1000),
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
          databaseService.upsertNode(nodeData);

          // Emit node update event to notify frontend via WebSocket
          dataEventEmitter.emitNodeUpdate(fromNum, nodeData);

          // Update mobility detection for this node (fire and forget)
          databaseService.updateNodeMobilityAsync(nodeId).catch(err =>
            logger.error(`Failed to update mobility for ${nodeId}:`, err)
          );

          // Check geofence triggers for this node's new position
          this.checkGeofencesForNode(fromNum, coords.latitude, coords.longitude);

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
  private trackPKIEncryption(meshPacket: any, nodeNum: number): void {
    if (meshPacket.pkiEncrypted || meshPacket.pki_encrypted) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      databaseService.upsertNode({
        nodeNum,
        nodeId,
        lastPKIPacket: Date.now()
      });
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
      // Extract channel from mesh packet - this tells us which channel the node was heard on
      const channelIndex = meshPacket.channel !== undefined ? meshPacket.channel : undefined;
      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        longName: user.longName,
        shortName: user.shortName,
        hwModel: user.hwModel,
        role: user.role,
        hopsAway: meshPacket.hopsAway,
        // Cap lastHeard at current time to prevent stale timestamps from node clock issues
        lastHeard: Math.min(meshPacket.rxTime ? Number(meshPacket.rxTime) : timestamp / 1000, Date.now() / 1000),
        channel: channelIndex
      };

      if (channelIndex !== undefined) {
        logger.debug(`📡 NodeInfo message for ${nodeId}: received on channel ${channelIndex}`);
      }

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
          nodeData.keySecurityIssueDetails = undefined;
        }

        // Check if this node had a key mismatch that is now fixed
        const existingNode = databaseService.getNode(fromNum);
        if (existingNode && existingNode.keyMismatchDetected) {
          const oldKey = existingNode.publicKey;
          const newKey = nodeData.publicKey;

          if (oldKey !== newKey) {
            // Key has changed - the mismatch is fixed!
            logger.info(`🔐 Key mismatch RESOLVED for node ${nodeId} (${user.longName}) - received new key`);
            nodeData.keyMismatchDetected = false;
            // Don't clear keySecurityIssueDetails if there's a low-entropy issue
            if (!isLowEntropy) {
              nodeData.keySecurityIssueDetails = undefined;
            }

            // Clear the repair state and log success
            databaseService.clearKeyRepairState(fromNum);
            const nodeName = user.longName || user.shortName || nodeId;
            databaseService.logKeyRepairAttempt(fromNum, nodeName, 'fixed', true);

            // Emit update to UI
            dataEventEmitter.emitNodeUpdate(fromNum, {
              keyMismatchDetected: false,
              keySecurityIssueDetails: isLowEntropy ? nodeData.keySecurityIssueDetails : undefined
            });
          }
        }
      }

      // Track if this packet was PKI encrypted (using the helper method)
      this.trackPKIEncryption(meshPacket, fromNum);

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;

        // Save SNR as telemetry if it has changed OR if 10+ minutes have passed
        // This ensures we have historical data for stable links
        const latestSnrTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'snr_local');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveSnr = !latestSnrTelemetry ||
                              latestSnrTelemetry.value !== meshPacket.rxSnr ||
                              (timestamp - latestSnrTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveSnr) {
          databaseService.insertTelemetry({
            nodeId,
            nodeNum: fromNum,
            telemetryType: 'snr_local',
            timestamp,
            value: meshPacket.rxSnr,
            unit: 'dB',
            createdAt: timestamp
          });
          const reason = !latestSnrTelemetry ? 'initial' :
                        latestSnrTelemetry.value !== meshPacket.rxSnr ? 'changed' : 'periodic';
          logger.debug(`📊 Saved local SNR telemetry: ${meshPacket.rxSnr} dB (${reason}, previous: ${latestSnrTelemetry?.value || 'N/A'})`);
        }
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;

        // Save RSSI as telemetry if it has changed OR if 10+ minutes have passed
        // This ensures we have historical data for stable links
        const latestRssiTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'rssi');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveRssi = !latestRssiTelemetry ||
                               latestRssiTelemetry.value !== meshPacket.rxRssi ||
                               (timestamp - latestRssiTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveRssi) {
          databaseService.insertTelemetry({
            nodeId,
            nodeNum: fromNum,
            telemetryType: 'rssi',
            timestamp,
            value: meshPacket.rxRssi,
            unit: 'dBm',
            createdAt: timestamp
          });
          const reason = !latestRssiTelemetry ? 'initial' :
                        latestRssiTelemetry.value !== meshPacket.rxRssi ? 'changed' : 'periodic';
          logger.debug(`📊 Saved RSSI telemetry: ${meshPacket.rxRssi} dBm (${reason}, previous: ${latestRssiTelemetry?.value || 'N/A'})`);
        }
      }

      logger.debug(`🔍 Saving node with role=${user.role}, hopsAway=${meshPacket.hopsAway}`);
      databaseService.upsertNode(nodeData);
      logger.debug(`👤 Updated user info: ${user.longName || nodeId}`);

      // Check if we should send auto-welcome message
      await this.checkAutoWelcome(fromNum, nodeId);
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

      // Track PKI encryption
      this.trackPKIEncryption(meshPacket, fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Cap lastHeard at current time to prevent stale timestamps from node clock issues
        lastHeard: Math.min(meshPacket.rxTime ? Number(meshPacket.rxTime) : Date.now() / 1000, Date.now() / 1000)
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
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
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'batteryLevel',
            timestamp, value: deviceMetrics.batteryLevel, unit: '%', createdAt: now, packetTimestamp
          });
        }
        if (deviceMetrics.voltage !== undefined && deviceMetrics.voltage !== null && !isNaN(deviceMetrics.voltage)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'voltage',
            timestamp, value: deviceMetrics.voltage, unit: 'V', createdAt: now, packetTimestamp
          });
        }
        if (deviceMetrics.channelUtilization !== undefined && deviceMetrics.channelUtilization !== null && !isNaN(deviceMetrics.channelUtilization)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'channelUtilization',
            timestamp, value: deviceMetrics.channelUtilization, unit: '%', createdAt: now, packetTimestamp
          });
        }
        if (deviceMetrics.airUtilTx !== undefined && deviceMetrics.airUtilTx !== null && !isNaN(deviceMetrics.airUtilTx)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'airUtilTx',
            timestamp, value: deviceMetrics.airUtilTx, unit: '%', createdAt: now, packetTimestamp
          });
        }
        if (deviceMetrics.uptimeSeconds !== undefined && deviceMetrics.uptimeSeconds !== null && !isNaN(deviceMetrics.uptimeSeconds)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'uptimeSeconds',
            timestamp, value: deviceMetrics.uptimeSeconds, unit: 's', createdAt: now, packetTimestamp
          });
        }
      } else if (telemetry.environmentMetrics) {
        const envMetrics = telemetry.environmentMetrics;
        logger.debug(`🌡️ Environment telemetry: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);

        // Save all Environment metrics to telemetry table
        this.saveTelemetryMetrics([
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
        ], nodeId, fromNum, timestamp, packetTimestamp);
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
            databaseService.insertTelemetry({
              nodeId, nodeNum: fromNum, telemetryType: String(voltageKey),
              timestamp, value: Number(voltage), unit: 'V', createdAt: now, packetTimestamp
            });
          }

          // Save current for this channel
          const current = powerMetrics[currentKey];
          if (current !== undefined && current !== null && !isNaN(Number(current))) {
            databaseService.insertTelemetry({
              nodeId, nodeNum: fromNum, telemetryType: String(currentKey),
              timestamp, value: Number(current), unit: 'mA', createdAt: now, packetTimestamp
            });
          }
        }
      } else if (telemetry.airQualityMetrics) {
        const aqMetrics = telemetry.airQualityMetrics;
        logger.debug(`🌬️ Air Quality telemetry: PM2.5=${aqMetrics.pm25Standard}µg/m³, CO2=${aqMetrics.co2}ppm`);

        // Save all AirQuality metrics to telemetry table
        this.saveTelemetryMetrics([
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
        ], nodeId, fromNum, timestamp, packetTimestamp);
      } else if (telemetry.localStats) {
        const localStats = telemetry.localStats;
        logger.debug(`📊 LocalStats telemetry: uptime=${localStats.uptimeSeconds}s, heap_free=${localStats.heapFreeBytes}B`);

        // Save all LocalStats metrics to telemetry table
        this.saveTelemetryMetrics([
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
        ], nodeId, fromNum, timestamp, packetTimestamp);
      } else if (telemetry.hostMetrics) {
        const hostMetrics = telemetry.hostMetrics;
        logger.debug(`🖥️ HostMetrics telemetry: uptime=${hostMetrics.uptimeSeconds}s, freemem=${hostMetrics.freememBytes}B`);

        // Save all HostMetrics metrics to telemetry table
        this.saveTelemetryMetrics([
          { type: 'hostUptimeSeconds', value: hostMetrics.uptimeSeconds, unit: 's' },
          { type: 'hostFreememBytes', value: hostMetrics.freememBytes, unit: 'bytes' },
          { type: 'hostDiskfree1Bytes', value: hostMetrics.diskfree1Bytes, unit: 'bytes' },
          { type: 'hostDiskfree2Bytes', value: hostMetrics.diskfree2Bytes, unit: 'bytes' },
          { type: 'hostDiskfree3Bytes', value: hostMetrics.diskfree3Bytes, unit: 'bytes' },
          { type: 'hostLoad1', value: hostMetrics.load1, unit: 'load' },
          { type: 'hostLoad5', value: hostMetrics.load5, unit: 'load' },
          { type: 'hostLoad15', value: hostMetrics.load15, unit: 'load' }
        ], nodeId, fromNum, timestamp, packetTimestamp);
      }

      databaseService.upsertNode(nodeData);
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

      // Track PKI encryption
      this.trackPKIEncryption(meshPacket, fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        // Cap lastHeard at current time to prevent stale timestamps from node clock issues
        lastHeard: Math.min(meshPacket.rxTime ? Number(meshPacket.rxTime) : Date.now() / 1000, Date.now() / 1000)
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      logger.debug(`📡 Paxcounter: wifi=${paxcount.wifi}, ble=${paxcount.ble}, uptime=${paxcount.uptime}`);

      // Save paxcounter metrics as telemetry
      if (paxcount.wifi !== undefined && paxcount.wifi !== null && !isNaN(paxcount.wifi)) {
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'paxcounterWifi',
          timestamp, value: paxcount.wifi, unit: 'devices', createdAt: now
        });
      }
      if (paxcount.ble !== undefined && paxcount.ble !== null && !isNaN(paxcount.ble)) {
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'paxcounterBle',
          timestamp, value: paxcount.ble, unit: 'devices', createdAt: now
        });
      }
      if (paxcount.uptime !== undefined && paxcount.uptime !== null && !isNaN(paxcount.uptime)) {
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'paxcounterUptime',
          timestamp, value: paxcount.uptime, unit: 's', createdAt: now
        });
      }

      databaseService.upsertNode(nodeData);
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
      const existingFromNode = databaseService.getNode(fromNum);
      if (!existingFromNode) {
        databaseService.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.substring(1, 5),
          lastHeard: Date.now() / 1000
        });
      } else {
        // Just update lastHeard, don't touch the name
        databaseService.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          lastHeard: Date.now() / 1000
        });
      }

      // Ensure to node exists in database (don't overwrite existing names)
      const existingToNode = databaseService.getNode(toNum);
      if (!existingToNode) {
        databaseService.upsertNode({
          nodeNum: toNum,
          nodeId: toNodeId,
          longName: `Node ${toNodeId}`,
          shortName: toNodeId.substring(1, 5),
          lastHeard: Date.now() / 1000
        });
      } else {
        // Just update lastHeard, don't touch the name
        databaseService.upsertNode({
          nodeNum: toNum,
          nodeId: toNodeId,
          lastHeard: Date.now() / 1000
        });
      }

      // Build the route string
      const BROADCAST_ADDR = 4294967295;

      // Filter function to remove invalid/reserved node numbers from route arrays
      // These values cause issues when displayed and don't represent real nodes:
      // - 0-3: Reserved per Meshtastic protocol
      // - 255 (0xff): Reserved for broadcast in some contexts
      // - 65535 (0xffff): Invalid placeholder value reported by users (Issue #1128)
      // - 4294967295 (0xffffffff): Broadcast address
      const isValidRouteNode = (nodeNum: number): boolean => {
        if (nodeNum <= 3) return false;  // Reserved
        if (nodeNum === 255) return false;  // 0xff reserved
        if (nodeNum === 65535) return false;  // 0xffff invalid placeholder
        if (nodeNum === BROADCAST_ADDR) return false;  // Broadcast
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

      const fromNode = databaseService.getNode(fromNum);
      const fromName = fromNode?.longName || fromNodeId;

      // Get distance unit from settings (default to km)
      const distanceUnit = (databaseService.getSetting('distanceUnit') || 'km') as 'km' | 'mi';

      let routeText = `📍 Traceroute to ${fromName} (${fromNodeId})\n\n`;
      let totalDistanceKm = 0;

      // Helper function to calculate and format distance
      const calcDistance = (node1Num: number, node2Num: number): string | null => {
        const n1 = databaseService.getNode(node1Num);
        const n2 = databaseService.getNode(node2Num);
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
        const toNode = databaseService.getNode(toNum);
        const toName = toNode?.longName || toNodeId;
        const dist = calcDistance(toNum, fromNum);
        routeText += `Forward path:\n`;
        routeText += `  1. ${toName} (${toNodeId})\n`;
        if (dist) {
          routeText += `  2. ${fromName} (${fromNodeId}) - SNR: ${snr}dB, Distance: ${dist}\n`;
        } else {
          routeText += `  2. ${fromName} (${fromNodeId}) - SNR: ${snr}dB\n`;
        }
      } else if (route.length > 0) {
        const toNode = databaseService.getNode(toNum);
        const toName = toNode?.longName || toNodeId;
        routeText += `Forward path (${route.length + 2} nodes):\n`;

        // Start with source node
        routeText += `  1. ${toName} (${toNodeId})\n`;

        // Build full path to calculate distances
        const fullPath = [toNum, ...route, fromNum];

        // Show intermediate hops
        route.forEach((nodeNum: number, index: number) => {
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const node = databaseService.getNode(nodeNum);
          const nodeName = nodeNum === BROADCAST_ADDR ? '(unknown)' : (node?.longName || nodeId);
          const snr = snrTowards[index] !== undefined ? `${(snrTowards[index] / 4).toFixed(1)}dB` : 'N/A';
          const dist = calcDistance(fullPath[index], nodeNum);
          if (dist) {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}, Distance: ${dist}\n`;
          } else {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}\n`;
          }
        });

        // Show destination with final hop SNR and distance
        const finalSnrIndex = route.length;
        const prevNodeNum = route.length > 0 ? route[route.length - 1] : toNum;
        const finalDist = calcDistance(prevNodeNum, fromNum);
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
      const calcDistanceReturn = (node1Num: number, node2Num: number): string | null => {
        const n1 = databaseService.getNode(node1Num);
        const n2 = databaseService.getNode(node2Num);
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
        const toNode = databaseService.getNode(toNum);
        const toName = toNode?.longName || toNodeId;
        const dist = calcDistanceReturn(fromNum, toNum);
        routeText += `\nReturn path:\n`;
        routeText += `  1. ${fromName} (${fromNodeId})\n`;
        if (dist) {
          routeText += `  2. ${toName} (${toNodeId}) - SNR: ${snr}dB, Distance: ${dist}\n`;
        } else {
          routeText += `  2. ${toName} (${toNodeId}) - SNR: ${snr}dB\n`;
        }
      } else if (routeBack.length > 0) {
        const toNode = databaseService.getNode(toNum);
        const toName = toNode?.longName || toNodeId;
        routeText += `\nReturn path (${routeBack.length + 2} nodes):\n`;

        // Start with source (destination of forward path)
        routeText += `  1. ${fromName} (${fromNodeId})\n`;

        // Build full return path
        const fullReturnPath = [fromNum, ...routeBack, toNum];

        // Show intermediate hops
        routeBack.forEach((nodeNum: number, index: number) => {
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const node = databaseService.getNode(nodeNum);
          const nodeName = nodeNum === BROADCAST_ADDR ? '(unknown)' : (node?.longName || nodeId);
          const snr = snrBack[index] !== undefined ? `${(snrBack[index] / 4).toFixed(1)}dB` : 'N/A';
          const dist = calcDistanceReturn(fullReturnPath[index], nodeNum);
          if (dist) {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}, Distance: ${dist}\n`;
          } else {
            routeText += `  ${index + 2}. ${nodeName} (${nodeId}) - SNR: ${snr}\n`;
          }
        });

        // Show final destination with SNR and distance
        const finalSnrIndex = routeBack.length;
        const prevNodeNum = routeBack.length > 0 ? routeBack[routeBack.length - 1] : fromNum;
        const finalDist = calcDistanceReturn(prevNodeNum, toNum);
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
        id: `traceroute_${fromNum}_${meshPacket.id || Date.now()}`,
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

      databaseService.insertMessage(message);

      // Emit WebSocket event for traceroute message
      dataEventEmitter.emitNewMessage(message as any);

      logger.debug(`💾 Saved traceroute result from ${fromNodeId} (channel: ${channelIndex})`);

      // Build position snapshot for all nodes in the traceroute path (Issue #1862)
      // This captures where each node was at traceroute time so historical traceroutes
      // render correctly even when nodes move
      const routePositions: Record<number, { lat: number; lng: number; alt?: number }> = {};
      const allPathNodes = [toNum, ...route, fromNum];
      const allBackNodes = routeBack || [];
      const allUniqueNodes = [...new Set([...allPathNodes, ...allBackNodes])];

      for (const nodeNum of allUniqueNodes) {
        const node = databaseService.getNode(nodeNum);
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
        timestamp: timestamp,
        createdAt: Date.now()
      };

      databaseService.insertTraceroute(tracerouteRecord);

      // Store traceroute hop count as telemetry for Smart Hops tracking
      // Hop count is route.length + 1 (intermediate hops + final hop to destination)
      const tracerouteHops = route.length + 1;
      databaseService.insertTelemetry({
        nodeId: fromNodeId,
        nodeNum: fromNum,
        telemetryType: 'messageHops',
        timestamp: Date.now(),
        value: tracerouteHops,
        unit: 'hops',
        createdAt: Date.now(),
      });

      // Emit WebSocket event for traceroute completion
      dataEventEmitter.emitTracerouteComplete(tracerouteRecord as any);

      logger.debug(`💾 Saved traceroute record to traceroutes table`);

      // If this was an auto-traceroute, mark it as successful in the log
      if (this.pendingAutoTraceroutes.has(fromNum)) {
        await databaseService.updateAutoTracerouteResultByNodeAsync(fromNum, true);
        this.pendingAutoTraceroutes.delete(fromNum);
        this.pendingTracerouteTimestamps.delete(fromNum); // Clear timeout tracking
        logger.debug(`🗺️ Auto-traceroute to ${fromNodeId} marked as successful`);
      }

      // Send notification for successful traceroute
      notificationService.notifyTraceroute(fromNodeId, toNodeId, routeText)
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

          const node1 = databaseService.getNode(node1Num);
          const node2 = databaseService.getNode(node2Num);

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

            databaseService.insertRouteSegment(segment);

            // Check if this is a new record holder
            databaseService.updateRecordHolderSegment(segment);

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

      // Handle successful ACKs (error_reason = 0 means success)
      if (errorReason === 0 && requestId) {
        // Look up the original message to check if this ACK is from the intended recipient
        const originalMessage = await databaseService.getMessageByRequestIdAsync(requestId);

        if (originalMessage) {
          const targetNodeId = originalMessage.toNodeId;
          const localNodeId = databaseService.getSetting('localNodeId');
          const isDM = originalMessage.channel === -1;

          // ACK from our own radio - message transmitted to mesh
          if (fromNodeId === localNodeId) {
            logger.info(`📡 ACK from our own radio ${fromNodeId} for requestId ${requestId} - message transmitted to mesh`);
            const updated = databaseService.updateMessageDeliveryState(requestId, 'delivered');
            if (updated) {
              logger.debug(`💾 Marked message ${requestId} as delivered (transmitted)`);
              // Update message timestamps to node time so outgoing messages sort correctly
              // relative to incoming messages (which use node rxTime)
              const ackRxTime = Number(meshPacket.rxTime);
              if (ackRxTime > 0) {
                databaseService.updateMessageTimestamps(requestId, ackRxTime * 1000);
                logger.debug(`🕐 Updated message ${requestId} timestamps to node time: ${ackRxTime}`);
              }
              // Emit WebSocket event for real-time delivery status update
              dataEventEmitter.emitRoutingUpdate({ requestId, status: 'ack' });
            }
            return;
          }

          // ACK from target node - message confirmed received by recipient (only for DMs)
          if (fromNodeId === targetNodeId && isDM) {
            logger.info(`✅ ACK received from TARGET node ${fromNodeId} for requestId ${requestId} - message confirmed`);
            const updated = databaseService.updateMessageDeliveryState(requestId, 'confirmed');
            if (updated) {
              logger.debug(`💾 Marked message ${requestId} as confirmed (received by target)`);
              // Emit WebSocket event for real-time delivery status update
              dataEventEmitter.emitRoutingUpdate({ requestId, status: 'ack' });
            }
            // Notify message queue service of successful ACK
            messageQueueService.handleAck(requestId);
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
        // No original message found - this is likely an external routing packet we didn't send
        logger.debug(`⚠️  Routing error for unknown requestId ${requestId} (not our message)`);
        return;
      }

      const targetNodeId = originalMessage.toNodeId;
      const localNodeId = databaseService.getSetting('localNodeId');
      const isDM = originalMessage.channel === -1;

      // Detect PKI/encryption errors and flag the target node
      // Only flag if the error is from our local radio (we couldn't encrypt to target)
      if (isPkiError(errorReason) && fromNodeId === localNodeId) {
        // PKI_FAILED or PKI_UNKNOWN_PUBKEY - indicates key mismatch
        if (originalMessage.toNodeNum) {
          const targetNodeNum = originalMessage.toNodeNum;
          const errorDescription = errorReason === RoutingError.PKI_FAILED
            ? 'PKI encryption failed - possible key mismatch. Use "Exchange Node Info" or purge node data to refresh keys.'
            : 'Remote node missing public key - possible key mismatch. Use "Exchange Node Info" or purge node data to refresh keys.';

          logger.warn(`🔐 PKI error detected for node ${targetNodeId}: ${errorDescription}`);

          // Flag the node with the key security issue
          databaseService.upsertNode({
            nodeNum: targetNodeNum,
            nodeId: targetNodeId,
            keyMismatchDetected: true,
            keySecurityIssueDetails: errorDescription
          });

          // Emit event to notify UI of the key issue
          dataEventEmitter.emitNodeUpdate(targetNodeNum, { keyMismatchDetected: true, keySecurityIssueDetails: errorDescription });

          // Penalize Link Quality for PKI error (-5)
          this.handlePkiError(targetNodeNum);
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
      databaseService.updateMessageDeliveryState(requestId, 'failed');
      // Emit WebSocket event for real-time delivery failure update
      dataEventEmitter.emitRoutingUpdate({ requestId, status: 'nak', errorReason: errorName });
      // Notify message queue service of failure
      messageQueueService.handleFailure(requestId, errorName);
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

        let node = databaseService.getNode(nodeNum);
        const prevNode = databaseService.getNode(prevNodeNum);
        const nextNode = databaseService.getNode(nextNodeNum);

        // Ensure the node exists in the database first (foreign key constraint)
        if (!node) {
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          databaseService.upsertNode({
            nodeNum,
            nodeId,
            longName: `Node ${nodeId}`,
            shortName: nodeId.substring(1, 5),
            lastHeard: Date.now() / 1000
          });
          node = databaseService.getNode(nodeNum);
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
        databaseService.insertTelemetry({
          nodeId,
          nodeNum,
          telemetryType: 'estimated_latitude',
          timestamp,
          value: finalLat,
          unit: '° (est)',
          createdAt: now
        });

        databaseService.insertTelemetry({
          nodeId,
          nodeNum,
          telemetryType: 'estimated_longitude',
          timestamp,
          value: finalLon,
          unit: '° (est)',
          createdAt: now
        });

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

      // Get the sender node to determine their hopsAway
      let senderNode = databaseService.getNode(fromNum);

      // Ensure sender node exists in database
      if (!senderNode) {
        databaseService.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.substring(1, 5),
          lastHeard: Date.now() / 1000
        });
        senderNode = databaseService.getNode(fromNum);
      }

      const senderHopsAway = senderNode?.hopsAway || 0;
      const timestamp = Date.now();

      // Process each neighbor in the list
      if (neighborInfo.neighbors && Array.isArray(neighborInfo.neighbors)) {
        logger.info(`📡 Processing ${neighborInfo.neighbors.length} neighbors from ${fromNodeId}`);

        // Clear old neighbor info for this node before saving new data
        // This ensures stale neighbors are removed when they drop from the mesh
        databaseService.clearNeighborInfoForNode(fromNum);

        for (const neighbor of neighborInfo.neighbors) {
          const neighborNodeNum = Number(neighbor.nodeId);
          const neighborNodeId = `!${neighborNodeNum.toString(16).padStart(8, '0')}`;

          // Check if neighbor node exists, if not create it with hopsAway = sender's hopsAway + 1
          let neighborNode = databaseService.getNode(neighborNodeNum);
          if (!neighborNode) {
            databaseService.upsertNode({
              nodeNum: neighborNodeNum,
              nodeId: neighborNodeId,
              longName: `Node ${neighborNodeId}`,
              shortName: neighborNodeId.substring(1, 5),
              hopsAway: senderHopsAway + 1,
              lastHeard: Date.now() / 1000
            });
            logger.info(`➕ Created new node ${neighborNodeId} with hopsAway=${senderHopsAway + 1}`);
          }

          // Save the neighbor relationship
          databaseService.saveNeighborInfo({
            nodeNum: fromNum,
            neighborNodeNum: neighborNodeNum,
            snr: neighbor.snr ? Number(neighbor.snr) : undefined,
            lastRxTime: neighbor.lastRxTime ? Number(neighbor.lastRxTime) : undefined,
            timestamp: timestamp
          });

          logger.info(`🔗 Saved neighbor: ${fromNodeId} -> ${neighborNodeId}, SNR: ${neighbor.snr || 'N/A'}`);
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

      const nodeId = `!${Number(nodeInfo.num).toString(16).padStart(8, '0')}`;

      // Check if node already exists to determine if we should set isFavorite
      const existingNode = databaseService.getNode(Number(nodeInfo.num));

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

      const nodeData: any = {
        nodeNum: Number(nodeInfo.num),
        nodeId: nodeId,
        ...(lastHeardValue !== undefined && { lastHeard: lastHeardValue }),
        snr: nodeInfo.snr,
        // Note: NodeInfo protobuf doesn't include RSSI, only MeshPacket does
        // RSSI will be updated from mesh packet if available
        hopsAway: nodeInfo.hopsAway !== undefined ? nodeInfo.hopsAway : undefined,
        channel: nodeInfo.channel !== undefined ? nodeInfo.channel : undefined
      };

      // Debug logging for channel extraction
      if (nodeInfo.channel !== undefined) {
        logger.debug(`📡 NodeInfo for ${nodeId}: extracted channel=${nodeInfo.channel}`);
      } else {
        logger.debug(`📡 NodeInfo for ${nodeId}: no channel field present`);
      }

      // Always sync isFavorite from device to keep in sync with changes made while offline
      // This ensures favorites are updated when reconnecting (fixes #213)
      if (nodeInfo.isFavorite !== undefined) {
        nodeData.isFavorite = nodeInfo.isFavorite;
        if (existingNode && existingNode.isFavorite !== nodeInfo.isFavorite) {
          logger.debug(`⭐ Updating favorite status for node ${nodeId} from ${existingNode.isFavorite} to ${nodeInfo.isFavorite}`);
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
          nodeData.publicKey = Buffer.from(nodeInfo.user.publicKey).toString('base64');
          nodeData.hasPKC = true;
          logger.debug(`🔐 Captured public key for ${nodeId}: ${nodeData.publicKey.substring(0, 16)}...`);

          // Check for key security issues
          const { checkLowEntropyKey } = await import('../services/lowEntropyKeyService.js');
          const isLowEntropy = checkLowEntropyKey(nodeData.publicKey, 'base64');

          if (isLowEntropy) {
            nodeData.keyIsLowEntropy = true;
            nodeData.keySecurityIssueDetails = 'Known low-entropy key detected - this key is compromised and should be regenerated';
            logger.warn(`⚠️ Low-entropy key detected for node ${nodeId}!`);
          } else {
            // Explicitly clear the flag when key is NOT low-entropy
            // This ensures that if a node regenerates their key, the flag is cleared immediately
            nodeData.keyIsLowEntropy = false;
            nodeData.keySecurityIssueDetails = undefined;
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
            const channel = databaseService.getChannelById(channelIndex);
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

      // If this is the local node, update localNodeInfo with names (only if not locked)
      if (this.localNodeInfo && this.localNodeInfo.nodeNum === Number(nodeInfo.num) && !this.localNodeInfo.isLocked) {
        logger.debug(`📱 Updating local node info with names from NodeInfo`);
        if (nodeInfo.user && nodeInfo.user.longName && nodeInfo.user.shortName) {
          this.localNodeInfo.longName = nodeInfo.user.longName;
          this.localNodeInfo.shortName = nodeInfo.user.shortName;
          this.localNodeInfo.isLocked = true;  // Lock it now that we have complete info
          logger.debug(`📱 Local node: ${nodeInfo.user.longName} (${nodeInfo.user.shortName}) - LOCKED`);
        }
      }

      // Upsert node first to ensure it exists before inserting telemetry
      databaseService.upsertNode(nodeData);

      // Emit WebSocket event for node update
      dataEventEmitter.emitNodeUpdate(Number(nodeInfo.num), nodeData);

      logger.debug(`🏠 Updated node info: ${nodeData.longName || nodeId}`);

      // Now insert position telemetry if we have it (after node exists in database)
      if (positionTelemetryData) {
        const now = Date.now();
        databaseService.insertTelemetry({
          nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'latitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.latitude, unit: '°', createdAt: now,
          channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
        });
        databaseService.insertTelemetry({
          nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'longitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.longitude, unit: '°', createdAt: now,
          channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
        });
        if (positionTelemetryData.altitude !== undefined && positionTelemetryData.altitude !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'altitude',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.altitude, unit: 'm', createdAt: now,
            channel: positionTelemetryData.channel, precisionBits: positionTelemetryData.precisionBits
          });
        }
        // Store ground speed if available (in m/s)
        if (positionTelemetryData.groundSpeed !== undefined && positionTelemetryData.groundSpeed > 0) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'ground_speed',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.groundSpeed, unit: 'm/s', createdAt: now,
            channel: positionTelemetryData.channel
          });
        }
        // Store ground track/heading if available (in 1/100 degrees, convert to degrees)
        if (positionTelemetryData.groundTrack !== undefined && positionTelemetryData.groundTrack > 0) {
          const headingDegrees = positionTelemetryData.groundTrack / 100;
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'ground_track',
            timestamp: positionTelemetryData.timestamp, value: headingDegrees, unit: '°', createdAt: now,
            channel: positionTelemetryData.channel
          });
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
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'batteryLevel',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.batteryLevel, unit: '%', createdAt: now
          });
        }

        if (deviceMetricsTelemetryData.voltage !== undefined && deviceMetricsTelemetryData.voltage !== null && !isNaN(deviceMetricsTelemetryData.voltage)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'voltage',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.voltage, unit: 'V', createdAt: now
          });
        }

        if (deviceMetricsTelemetryData.channelUtilization !== undefined && deviceMetricsTelemetryData.channelUtilization !== null && !isNaN(deviceMetricsTelemetryData.channelUtilization)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'channelUtilization',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.channelUtilization, unit: '%', createdAt: now
          });
        }

        if (deviceMetricsTelemetryData.airUtilTx !== undefined && deviceMetricsTelemetryData.airUtilTx !== null && !isNaN(deviceMetricsTelemetryData.airUtilTx)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'airUtilTx',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.airUtilTx, unit: '%', createdAt: now
          });
        }

        if (deviceMetricsTelemetryData.uptimeSeconds !== undefined && deviceMetricsTelemetryData.uptimeSeconds !== null && !isNaN(deviceMetricsTelemetryData.uptimeSeconds)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'uptimeSeconds',
            timestamp: deviceMetricsTelemetryData.timestamp, value: deviceMetricsTelemetryData.uptimeSeconds, unit: 's', createdAt: now
          });
        }
      }

      // Save SNR as telemetry if present in NodeInfo
      if (nodeInfo.snr !== undefined && nodeInfo.snr !== null && nodeInfo.snr !== 0) {
        const timestamp = nodeInfo.lastHeard ? Number(nodeInfo.lastHeard) * 1000 : Date.now();
        const now = Date.now();

        // Save SNR telemetry with same logic as packet processing:
        // Save if it has changed OR if 10+ minutes have passed since last save
        const latestSnrTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'snr_remote');
        const tenMinutesMs = 10 * 60 * 1000;
        const shouldSaveSnr = !latestSnrTelemetry ||
                              latestSnrTelemetry.value !== nodeInfo.snr ||
                              (now - latestSnrTelemetry.timestamp) >= tenMinutesMs;

        if (shouldSaveSnr) {
          databaseService.insertTelemetry({
            nodeId,
            nodeNum: Number(nodeInfo.num),
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
    } catch (error) {
      logger.error('❌ Error processing NodeInfo protobuf:', error);
    }
  }

  /**
   * Process User protobuf message directly
   */
  // @ts-ignore - Legacy function kept for backward compatibility
  private async processUserProtobuf(user: any): Promise<void> {
    try {
      logger.debug(`👤 Processing User: ${user.longName}`);

      // Extract node number from user ID if possible
      let nodeNum = 0;
      if (user.id && user.id.startsWith('!')) {
        nodeNum = parseInt(user.id.substring(1), 16);
      }

      if (nodeNum > 0) {
        const nodeData = {
          nodeNum: nodeNum,
          nodeId: user.id,
          longName: user.longName,
          shortName: user.shortName,
          hwModel: user.hwModel,
          lastHeard: Date.now() / 1000
        };

        databaseService.upsertNode(nodeData);
        logger.debug(`👤 Updated user info: ${user.longName}`);
      }
    } catch (error) {
      logger.error('❌ Error processing User protobuf:', error);
    }
  }

  /**
   * Process Position protobuf message directly
   */
  // @ts-ignore - Legacy function kept for backward compatibility
  private async processPositionProtobuf(position: any): Promise<void> {
    try {
      logger.debug(`🗺️ Processing Position: lat=${position.latitudeI}, lng=${position.longitudeI}`);

      if (position.latitudeI && position.longitudeI) {
        const coords = meshtasticProtobufService.convertCoordinates(position.latitudeI, position.longitudeI);
        logger.debug(`🗺️ Position: ${coords.latitude}, ${coords.longitude}`);

        // Note: Without a mesh packet context, we can't determine which node this position belongs to
        // This would need to be handled at a higher level or with additional context
      }
    } catch (error) {
      logger.error('❌ Error processing Position protobuf:', error);
    }
  }

  /**
   * Process Telemetry protobuf message directly
   */
  // @ts-ignore - Legacy function kept for backward compatibility
  private async processTelemetryProtobuf(telemetry: any): Promise<void> {
    try {
      logger.debug('📊 Processing Telemetry protobuf');

      // Note: Without a mesh packet context, we can't determine which node this telemetry belongs to
      // This would need to be handled at a higher level or with additional context

      if (telemetry.variant?.case === 'deviceMetrics' && telemetry.variant.value) {
        const deviceMetrics = telemetry.variant.value;
        logger.debug(`📊 Device metrics: battery=${deviceMetrics.batteryLevel}%, voltage=${deviceMetrics.voltage}V`);
      } else if (telemetry.variant?.case === 'environmentMetrics' && telemetry.variant.value) {
        const envMetrics = telemetry.variant.value;
        logger.debug(`🌡️ Environment metrics: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);
      }
    } catch (error) {
      logger.error('❌ Error processing Telemetry protobuf:', error);
    }
  }


  // @ts-ignore - Legacy function kept for backward compatibility
  private saveNodesFromData(nodeIds: string[], readableText: string[], text: string): void {
    // Extract and save all discovered nodes to database
    const uniqueNodeIds = [...new Set(nodeIds)];
    logger.debug(`Saving ${uniqueNodeIds.length} nodes to database`);

    for (const nodeId of uniqueNodeIds) {
      try {
        const nodeNum = parseInt(nodeId.substring(1), 16);

        // Try to find a name for this node in the readable text using enhanced protobuf parsing
        const possibleName = this.findNameForNodeEnhanced(nodeId, readableText, text);

        const nodeData = {
          nodeNum: nodeNum,
          nodeId: nodeId,
          longName: possibleName.longName || `Node ${nodeId}`,
          shortName: possibleName.shortName || nodeId.substring(1, 5),
          hwModel: possibleName.hwModel || 0,
          lastHeard: Date.now() / 1000,
          snr: possibleName.snr,
          rssi: possibleName.rssi,
          batteryLevel: possibleName.batteryLevel,
          voltage: possibleName.voltage,
          latitude: possibleName.latitude,
          longitude: possibleName.longitude,
          altitude: possibleName.altitude,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        // Save to database immediately
        databaseService.upsertNode(nodeData);
        logger.debug(`Saved node: ${nodeData.longName} (${nodeData.nodeId})`);

      } catch (error) {
        logger.error(`Failed to process node ${nodeId}:`, error);
      }
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractChannelInfo(_data: Uint8Array, text: string, readableMatches: string[] | null): any {
    // Extract channel names from both readableMatches and direct text analysis
    const knownMeshtasticChannels = ['Primary', 'admin', 'gauntlet', 'telemetry', 'Secondary', 'LongFast', 'VeryLong'];
    const foundChannels = new Set<string>();

    // Check readableMatches first
    if (readableMatches) {
      readableMatches.forEach(match => {
        const normalizedMatch = match.trim().toLowerCase();
        knownMeshtasticChannels.forEach(channel => {
          if (channel.toLowerCase() === normalizedMatch) {
            foundChannels.add(channel);
          }
        });
      });
    }

    // Also check direct text for channel names (case-insensitive)
    const textLower = text.toLowerCase();
    knownMeshtasticChannels.forEach(channel => {
      if (textLower.includes(channel.toLowerCase())) {
        foundChannels.add(channel);
      }
    });

    const validChannels = Array.from(foundChannels);

    if (validChannels.length > 0) {
      logger.debug('Found valid Meshtastic channels:', validChannels);
      this.saveChannelsToDatabase(validChannels);

      return {
        type: 'channelConfig',
        data: {
          channels: validChannels,
          message: `Found Meshtastic channels: ${validChannels.join(', ')}`
        }
      };
    }

    // Ensure we always have a Primary channel
    const existingChannels = databaseService.getAllChannels();
    if (existingChannels.length === 0) {
      logger.debug('Creating default Primary channel');
      this.saveChannelsToDatabase(['Primary']);

      return {
        type: 'channelConfig',
        data: {
          channels: ['Primary'],
          message: 'Created default Primary channel'
        }
      };
    }

    return null;
  }

  private saveChannelsToDatabase(channelNames: string[]): void {
    for (let i = 0; i < channelNames.length; i++) {
      const channelName = channelNames[i].trim();
      if (channelName.length > 0) {
        try {
          databaseService.upsertChannel({
            id: i, // Use index as channel ID
            name: channelName
          });
        } catch (error) {
          logger.error(`Failed to save channel ${channelName}:`, error);
        }
      }
    }
  }

  private findNameForNodeEnhanced(nodeId: string, readableText: string[], fullText: string): any {
    // Enhanced protobuf parsing to extract all node information including telemetry
    const result: any = {
      longName: undefined,
      shortName: undefined,
      hwModel: undefined,
      snr: undefined,
      rssi: undefined,
      batteryLevel: undefined,
      voltage: undefined,
      latitude: undefined,
      longitude: undefined,
      altitude: undefined
    };

    // Find the position of this node ID in the binary data
    const nodeIndex = fullText.indexOf(nodeId);
    if (nodeIndex === -1) return result;

    // Extract a larger context around the node ID for detailed parsing
    const contextStart = Math.max(0, nodeIndex - 100);
    const contextEnd = Math.min(fullText.length, nodeIndex + nodeId.length + 200);
    const context = fullText.substring(contextStart, contextEnd);

    // Parse the protobuf structure around this node ID
    try {
      const contextBytes = new TextEncoder().encode(context);
      const parsedData = this.parseNodeProtobufData(contextBytes, nodeId);
      if (parsedData) {
        Object.assign(result, parsedData);
      }
    } catch (error) {
      logger.error(`Error parsing node data for ${nodeId}:`, error);
    }

    // Fallback: Look for readable text patterns near the node ID
    if (!result.longName) {
      // Look for known good names from the readableText array first
      for (const text of readableText) {
        if (this.isValidNodeName(text) && text !== nodeId && text.length >= 3) {
          result.longName = text.trim();
          break;
        }
      }

      // If still no good name, try pattern matching in the context with stricter validation
      if (!result.longName) {
        const afterContext = fullText.substring(nodeIndex + nodeId.length, nodeIndex + nodeId.length + 100);
        const nameMatch = afterContext.match(/([\p{L}\p{S}][\p{L}\p{N}\p{S}\p{P}\s\-_.]{1,30})/gu);

        if (nameMatch && nameMatch[0] && this.isValidNodeName(nameMatch[0]) && nameMatch[0].length >= 3) {
          result.longName = nameMatch[0].trim();
        }
      }

      // Validate shortName length (must be 2-4 characters)
      if (result.shortName && (result.shortName.length < 2 || result.shortName.length > 4)) {
        // Try to create a valid shortName from longName
        if (result.longName && result.longName.length >= 3) {
          result.shortName = result.longName.substring(0, 4).toUpperCase();
        } else {
          delete result.shortName;
        }
      }

      // Generate shortName if we have a longName
      if (result.longName && !result.shortName) {
        // Look for a separate short name in readableText
        for (const text of readableText) {
          if (text !== result.longName && text.length >= 2 && text.length <= 8 &&
              this.isValidNodeName(text) && text !== nodeId) {
            result.shortName = text.trim();
            break;
          }
        }

        // If no separate shortName found, generate from longName
        if (!result.shortName) {
          const alphanumeric = result.longName.replace(/[^\w]/g, '');
          result.shortName = alphanumeric.substring(0, 4) || result.longName.substring(0, 4);
        }
      }
    }

    // Try to extract telemetry data from readable text patterns
    for (const text of readableText) {
      // Look for battery level patterns
      const batteryMatch = text.match(/(\d{1,3})%/);
      if (batteryMatch && !result.batteryLevel) {
        const batteryLevel = parseInt(batteryMatch[1]);
        if (batteryLevel >= 0 && batteryLevel <= 100) {
          result.batteryLevel = batteryLevel;
        }
      }

      // Look for voltage patterns
      const voltageMatch = text.match(/(\d+\.\d+)V/);
      if (voltageMatch && !result.voltage) {
        result.voltage = parseFloat(voltageMatch[1]);
      }

      // Look for coordinate patterns
      const latMatch = text.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
      if (latMatch && !result.latitude) {
        result.latitude = parseFloat(latMatch[1]);
        result.longitude = parseFloat(latMatch[2]);
      }
    }

    return result;
  }

  private parseNodeProtobufData(data: Uint8Array, nodeId: string): any {
    // Enhanced protobuf parsing specifically for node information
    const result: any = {};

    try {
      // First, try to decode the entire data block as a NodeInfo message
      const nodeInfo = protobufService.decodeNodeInfo(data);
      if (nodeInfo && nodeInfo.position) {
        logger.debug(`🗺️ Extracted position from NodeInfo during config parsing for ${nodeId}`);
        const coords = protobufService.convertCoordinates(
          nodeInfo.position.latitude_i,
          nodeInfo.position.longitude_i
        );
        result.latitude = coords.latitude;
        result.longitude = coords.longitude;
        result.altitude = nodeInfo.position.altitude;

        // Also extract other NodeInfo data if available
        if (nodeInfo.user) {
          result.longName = nodeInfo.user.long_name;
          result.shortName = nodeInfo.user.short_name;
          result.hwModel = nodeInfo.user.hw_model;
        }

        // Note: Telemetry data (batteryLevel, voltage, etc.) is NOT extracted from NodeInfo during config parsing
        // It is only saved from actual TELEMETRY_APP packets in processTelemetryMessageProtobuf()

        logger.debug(`📍 Config position data: ${coords.latitude}, ${coords.longitude} for ${nodeId}`);
      }
    } catch (_nodeInfoError) {
      // NodeInfo parsing failed, try manual field parsing as fallback
    }

    try {
      let offset = 0;

      while (offset < data.length - 10) {
        // Look for protobuf field patterns
        const tag = data[offset];
        if (tag === 0) {
          offset++;
          continue;
        }

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNumber > 0 && fieldNumber < 50) {
          offset++;

          if (wireType === 2) { // Length-delimited field (strings, embedded messages)
            if (offset < data.length) {
              const length = data[offset];
              offset++;

              if (offset + length <= data.length && length > 0 && length < 50) {
                const fieldData = data.slice(offset, offset + length);

                try {
                  // Try to decode as UTF-8 string (non-fatal for better emoji support)
                  const str = new TextDecoder('utf-8', { fatal: false }).decode(fieldData);

                  // Debug: log raw bytes for troubleshooting Unicode issues
                  if (fieldData.length <= 10) {
                    const hex = Array.from(fieldData).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    logger.debug(`Field ${fieldNumber} raw bytes for "${str}": [${hex}]`);
                  }

                  // Parse based on actual protobuf field numbers (Meshtastic User message schema)
                  if (fieldNumber === 2) { // longName field
                    if (this.isValidNodeName(str) && str !== nodeId && str.length >= 3) {
                      result.longName = str;
                      logger.debug(`Extracted longName from protobuf field 2: ${str}`);
                    }
                  } else if (fieldNumber === 3) { // shortName field
                    // For shortName, count actual Unicode characters, not bytes
                    const unicodeLength = Array.from(str).length;
                    if (unicodeLength >= 1 && unicodeLength <= 4 && this.isValidNodeName(str)) {
                      result.shortName = str;
                      logger.debug(`Extracted shortName from protobuf field 3: ${str} (${unicodeLength} chars)`);
                    }
                  }
                } catch (e) {
                  // Not valid UTF-8 text, might be binary data
                  // Try to parse as embedded message with telemetry data
                  this.parseEmbeddedTelemetry(fieldData, result);
                }

                offset += length;
              }
            }
          } else if (wireType === 0) { // Varint (numbers)
            let value = 0;
            let shift = 0;
            let hasMore = true;

            while (offset < data.length && hasMore) {
              const byte = data[offset];
              hasMore = (byte & 0x80) !== 0;
              value |= (byte & 0x7F) << shift;
              shift += 7;
              offset++;

              if (!hasMore || shift >= 64) break;
            }

            // Try to identify what this number represents based on field number and value range
            if (fieldNumber === 1 && value > 1000000) {
              // Likely node number
            } else if (fieldNumber === 5 && value >= 0 && value <= 100) {
              // Might be battery level
              result.batteryLevel = value;
            } else if (fieldNumber === 7 && value > 0) {
              // Might be hardware model
              result.hwModel = value;
            }
          } else {
            offset++;
          }
        } else {
          offset++;
        }

        if (offset >= data.length) break;
      }
    } catch (error) {
      // Ignore parsing errors, this is experimental
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  private isValidNodeName(str: string): boolean {
    // Validate that this is a legitimate node name
    if (str.length < 2 || str.length > 30) return false;

    // Must contain at least some Unicode letters or numbers (full Unicode support)
    if (!/[\p{L}\p{N}]/u.test(str)) return false;

    // Reject strings that are mostly control characters (using Unicode categories)
    const controlCharCount = (str.match(/[\p{C}]/gu) || []).length;
    if (controlCharCount > str.length * 0.3) return false;

    // Reject binary null bytes and similar problematic characters
    if (str.includes('\x00') || str.includes('\xFF')) return false;

    // Count printable/displayable characters using Unicode categories
    // Letters, Numbers, Symbols, Punctuation, and some Marks are considered valid
    const validChars = str.match(/[\p{L}\p{N}\p{S}\p{P}\p{M}\s]/gu) || [];
    const validCharRatio = validChars.length / str.length;

    // At least 70% of characters should be valid/printable Unicode characters
    if (validCharRatio < 0.7) return false;

    // Reject strings that are mostly punctuation/symbols without letters/numbers
    const letterNumberCount = (str.match(/[\p{L}\p{N}]/gu) || []).length;
    const letterNumberRatio = letterNumberCount / str.length;
    if (letterNumberRatio < 0.3) return false;

    // Additional validation for common binary/garbage patterns
    // Reject strings with too many identical consecutive characters
    if (/(.)\1{4,}/.test(str)) return false;

    // Reject strings that look like hex dumps or similar patterns
    if (/^[A-F0-9\s]{8,}$/i.test(str) && !/[G-Z]/i.test(str)) return false;

    return true;
  }

  private parseEmbeddedTelemetry(data: Uint8Array, result: any): void {
    // Parse embedded protobuf messages that may contain position data
    logger.debug(`🔍 parseEmbeddedTelemetry called with ${data.length} bytes: [${Array.from(data.slice(0, Math.min(20, data.length))).map(b => b.toString(16).padStart(2, '0')).join(' ')}${data.length > 20 ? '...' : ''}]`);

    // Strategy 1: Look for encoded integer patterns that could be coordinates
    // Meshtastic encodes lat/lng as integers * 10^7
    for (let i = 0; i <= data.length - 4; i++) {
      try {
        // Try to decode as little-endian 32-bit signed integer
        const view = new DataView(data.buffer, data.byteOffset + i, 4);
        const value = view.getInt32(0, true); // little endian

        const isValidLatitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 900000000;
        const isValidLongitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 1800000000;

        if (isValidLatitude) {
          logger.debug(`🌍 Found potential latitude at byte ${i}: ${value / 10000000} (raw: ${value})`);
          if (!result.position) result.position = {};
          result.position.latitude = value / 10000000;
          result.latitude = value / 10000000;
        } else if (isValidLongitude) {
          logger.debug(`🌍 Found potential longitude at byte ${i}: ${value / 10000000} (raw: ${value})`);
          if (!result.position) result.position = {};
          result.position.longitude = value / 10000000;
          result.longitude = value / 10000000;
        }
      } catch (e) {
        // Skip invalid positions
      }
    }

    try {
      let offset = 0;
      while (offset < data.length - 1) {
        if (data[offset] === 0) {
          offset++;
          continue;
        }

        const tag = data[offset];
        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        offset++;

        if (wireType === 0) { // Varint - this is where position data lives!
          let value = 0;
          let shift = 0;
          let hasMore = true;

          while (offset < data.length && hasMore && shift < 64) {
            const byte = data[offset];
            hasMore = (byte & 0x80) !== 0;
            value |= (byte & 0x7F) << shift;
            shift += 7;
            offset++;

            if (!hasMore) break;
          }

          logger.debug(`Embedded Field ${fieldNumber} Varint value: ${value} (0x${value.toString(16)})`);

          // Look for Meshtastic Position message structure
          // latitudeI and longitudeI are typically * 10^7 integers
          const isValidLatitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 900000000; // -90 to +90 degrees
          const isValidLongitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 1800000000; // -180 to +180 degrees

          // Position message: field 1=latitudeI, field 2=longitudeI, field 3=altitude
          if (fieldNumber === 1 && isValidLatitude) {
            logger.debug(`🌍 Found embedded latitude in field ${fieldNumber}: ${value / 10000000}`);
            if (!result.position) result.position = {};
            result.position.latitude = value / 10000000;
            result.latitude = value / 10000000; // Also set flat field for database
          } else if (fieldNumber === 2 && isValidLongitude) {
            logger.debug(`🌍 Found embedded longitude in field ${fieldNumber}: ${value / 10000000}`);
            if (!result.position) result.position = {};
            result.position.longitude = value / 10000000;
            result.longitude = value / 10000000; // Also set flat field for database
          } else if (fieldNumber === 3 && value >= -1000 && value <= 10000) {
            // Altitude in meters
            logger.debug(`🌍 Found embedded altitude in field ${fieldNumber}: ${value}m`);
            if (!result.position) result.position = {};
            result.position.altitude = value;
            result.altitude = value; // Also set flat field for database
          } else if (fieldNumber === 4 && value >= -200 && value <= -20) {
            // RSSI
            result.rssi = value;
          } else if (fieldNumber === 5 && value >= 0 && value <= 100) {
            // Battery level
            result.batteryLevel = value;
          }

        } else if (wireType === 2) { // Length-delimited - could contain nested position message
          if (offset < data.length) {
            const length = data[offset];
            offset++;

            if (offset + length <= data.length && length > 0) {
              const nestedData = data.slice(offset, offset + length);
              logger.debug(`Found nested message in field ${fieldNumber}, length ${length} bytes`);

              // Recursively parse nested messages that might contain position data
              this.parseEmbeddedTelemetry(nestedData, result);

              offset += length;
            }
          }
        } else if (wireType === 5) { // Fixed32 - float values
          if (offset + 4 <= data.length) {
            const floatVal = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, true);

            if (Number.isFinite(floatVal)) {
              // SNR as float (typical range -25 to +15)
              if (floatVal >= -30 && floatVal <= 20 && !result.snr) {
                result.snr = Math.round(floatVal * 100) / 100;
              }
              // Voltage (typical range 3.0V to 5.0V)
              if (floatVal >= 2.5 && floatVal <= 6.0 && !result.voltage) {
                result.voltage = Math.round(floatVal * 100) / 100;
              }
            }

            offset += 4;
          }
        } else {
          // Skip unknown wire types
          offset++;
        }
      }
    } catch (error) {
      // Ignore parsing errors, this is experimental
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractProtobufStructure(data: Uint8Array): any {
    // Try to extract basic protobuf field structure
    // Protobuf uses varint encoding, look for common patterns

    try {
      let offset = 0;
      const fields: any = {};

      while (offset < data.length - 1) {
        // Read potential field tag
        const tag = data[offset];
        if (tag === 0) {
          offset++;
          continue;
        }

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNumber > 0 && fieldNumber < 100) { // Reasonable field numbers
          offset++;

          if (wireType === 0) { // Varint
            let value = 0;
            let shift = 0;
            while (offset < data.length && (data[offset] & 0x80) !== 0) {
              value |= (data[offset] & 0x7F) << shift;
              shift += 7;
              offset++;
            }
            if (offset < data.length) {
              value |= (data[offset] & 0x7F) << shift;
              offset++;
              fields[fieldNumber] = value;
            }
          } else if (wireType === 2) { // Length-delimited
            if (offset < data.length) {
              const length = data[offset];
              offset++;
              if (offset + length <= data.length) {
                const fieldData = data.slice(offset, offset + length);

                // Try to decode as string
                try {
                  const str = new TextDecoder('utf-8', { fatal: true }).decode(fieldData);
                  if (str.length > 0 && /[A-Za-z]/.test(str)) {
                    fields[fieldNumber] = str;
                    logger.debug(`Found string field ${fieldNumber}:`, str);
                  }
                } catch (e) {
                  // Not valid UTF-8, store as bytes
                  fields[fieldNumber] = fieldData;
                }
                offset += length;
              }
            }
          } else {
            // Skip unknown wire types
            offset++;
          }
        } else {
          offset++;
        }
      }

      // If we found some structured data, try to interpret it
      if (Object.keys(fields).length > 0) {
        logger.debug('Extracted protobuf fields:', fields);

        // Look for node-like data
        if (fields[1] && typeof fields[1] === 'string' && fields[1].startsWith('!')) {
          return {
            type: 'nodeInfo',
            data: {
              num: parseInt(fields[1].substring(1), 16),
              user: {
                id: fields[1],
                longName: fields[2] || `Node ${fields[1]}`,
                shortName: fields[3] || (fields[2] ? fields[2].substring(0, 4) : 'UNK')
              },
              lastHeard: Date.now() / 1000
            }
          };
        }

        // Look for message-like data
        for (const [, value] of Object.entries(fields)) {
          if (typeof value === 'string' && value.length > 2 && value.length < 200 &&
              !value.startsWith('!') && /[A-Za-z]/.test(value)) {
            return {
              type: 'packet',
              data: {
                id: `msg_${Date.now()}`,
                from: 0,
                to: 0xFFFFFFFF,
                fromNodeId: 'unknown',
                toNodeId: '!ffffffff',
                text: value,
                channel: 0,
                timestamp: Date.now(),
                rxTime: Date.now(),
                createdAt: Date.now()
              }
            };
          }
        }
      }
    } catch (error) {
      // Ignore protobuf parsing errors, this is experimental
    }

    return null;
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractTextMessage(data: Uint8Array, text: string): any {
    // Look for text message indicators
    if (text.includes('TEXT_MESSAGE_APP') || this.containsReadableText(text)) {
      // Try to extract sender node ID
      const fromNodeMatch = text.match(/!([a-f0-9]{8})/);
      const fromNodeId = fromNodeMatch ? '!' + fromNodeMatch[1] : 'unknown';
      const fromNodeNum = fromNodeMatch ? parseInt(fromNodeMatch[1], 16) : 0;

      // Extract readable text from the message
      const messageText = this.extractMessageText(text, data);

      if (messageText && messageText.length > 0 && messageText.length < 200) {
        return {
          type: 'packet',
          data: {
            id: `${fromNodeId}_${Date.now()}`,
            from: fromNodeNum,
            to: 0xFFFFFFFF, // Broadcast by default
            fromNodeId: fromNodeId,
            toNodeId: '!ffffffff',
            text: messageText,
            channel: 0, // Default channel
            timestamp: Date.now(),
            rxTime: Date.now(),
            createdAt: Date.now()
          }
        };
      }
    }
    return null;
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractNodeInfo(data: Uint8Array, text: string): any {
    // Look for node ID patterns (starts with '!')
    const nodeIdMatch = text.match(/!([a-f0-9]{8})/);
    if (nodeIdMatch) {
      const nodeId = '!' + nodeIdMatch[1];

      // Extract names using improved pattern matching
      const names = this.extractNodeNames(text, nodeId);

      // Try to extract basic telemetry data
      const nodeNum = parseInt(nodeId.substring(1), 16);
      const telemetry = this.extractTelemetryData(data);

      return {
        type: 'nodeInfo',
        data: {
          num: nodeNum,
          user: {
            id: nodeId,
            longName: names.longName || `Node ${nodeNum}`,
            shortName: names.shortName || names.longName.substring(0, 4) || 'UNK',
            hwModel: telemetry.hwModel
          },
          lastHeard: Date.now() / 1000,
          snr: telemetry.snr,
          rssi: telemetry.rssi,
          position: telemetry.position
          // Note: deviceMetrics are NOT included - telemetry is only saved from TELEMETRY_APP packets
        }
      };
    }
    return null;
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractOtherPackets(_data: Uint8Array, _text: string): any {
    // Handle other packet types like telemetry, position, etc.
    return null;
  }

  private containsReadableText(text: string): boolean {
    // Check if the string contains readable text (not just binary gibberish)
    const readableChars = text.match(/[A-Za-z0-9\s.,!?'"]/g);
    const readableRatio = readableChars ? readableChars.length / text.length : 0;
    return readableRatio > 0.3; // At least 30% readable characters
  }

  private extractMessageText(text: string, data: Uint8Array): string {
    // Try multiple approaches to extract the actual message text

    // Method 1: Look for sequences of printable characters
    const printableText = text.match(/[\x20-\x7E]{3,}/g);
    if (printableText) {
      for (const candidate of printableText) {
        if (candidate.length >= 3 &&
            candidate.length <= 200 &&
            !candidate.startsWith('!') &&
            !candidate.match(/^[0-9A-F]{8}$/)) {
          return candidate.trim();
        }
      }
    }

    // Method 2: Look for UTF-8 text after node IDs
    const parts = text.split(/![a-f0-9]{8}/);
    for (const part of parts) {
      const cleanPart = part.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
      if (cleanPart.length >= 3 && cleanPart.length <= 200 && /[A-Za-z]/.test(cleanPart)) {
        return cleanPart;
      }
    }

    // Method 3: Try to find text in different positions of the binary data
    for (let offset = 10; offset < Math.min(data.length - 10, 100); offset++) {
      try {
        const slice = data.slice(offset, Math.min(offset + 50, data.length));
        const testText = new TextDecoder('utf-8', { fatal: true }).decode(slice);
        const cleanTest = testText.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();

        if (cleanTest.length >= 3 && cleanTest.length <= 200 && /[A-Za-z]/.test(cleanTest)) {
          return cleanTest;
        }
      } catch (e) {
        // Invalid UTF-8, continue
      }
    }

    return '';
  }

  private extractNodeNames(text: string, nodeId: string): { longName: string; shortName: string } {
    // Improved name extraction
    let longName = '';
    let shortName = '';

    // Split text around the node ID to get name candidates
    const parts = text.split(nodeId);

    for (const part of parts) {
      // Look for readable name patterns
      const nameMatches = part.match(/([\p{L}\p{N}\p{S}\p{P}\s\-_.]{2,31})/gu);

      if (nameMatches) {
        const validNames = nameMatches.filter(match =>
          match.trim().length >= 2 &&
          match.trim().length <= 30 &&
          /[A-Za-z0-9]/.test(match) && // Must contain alphanumeric
          !match.match(/^[0-9A-F]+$/) && // Not just hex
          !match.startsWith('!') // Not a node ID
        );

        if (validNames.length > 0 && !longName) {
          longName = validNames[0].trim();
        }
        if (validNames.length > 1 && !shortName) {
          shortName = validNames[1].trim();
        }
      }
    }

    // Generate short name if not found
    if (longName && !shortName) {
      shortName = longName.substring(0, 4);
    }

    return { longName, shortName };
  }

  private extractTelemetryData(data: Uint8Array): any {
    // Enhanced telemetry extraction using improved protobuf parsing
    const telemetry: any = {
      hwModel: undefined,
      snr: undefined,
      rssi: undefined,
      position: undefined,
      deviceMetrics: undefined
    };

    // Parse protobuf structure looking for telemetry fields
    let offset = 0;
    while (offset < data.length - 5) {
      try {
        const tag = data[offset];
        if (tag === 0) {
          offset++;
          continue;
        }

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNumber > 0 && fieldNumber < 100) {
          offset++;

          if (wireType === 0) { // Varint (integers)
            let value = 0;
            let shift = 0;
            let hasMore = true;

            while (offset < data.length && hasMore && shift < 64) {
              const byte = data[offset];
              hasMore = (byte & 0x80) !== 0;
              value |= (byte & 0x7F) << shift;
              shift += 7;
              offset++;

              if (!hasMore) break;
            }

            // Debug: Log all Varint values to diagnose position parsing
            if (fieldNumber >= 1 && fieldNumber <= 10) {
              logger.debug(`Field ${fieldNumber} Varint value: ${value} (0x${value.toString(16)})`);
            }

            // Look for position data in various field numbers - Meshtastic Position message
            // latitudeI and longitudeI are typically * 10^7 integers
            const isValidLatitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 900000000; // -90 to +90 degrees
            const isValidLongitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 1800000000; // -180 to +180 degrees

            if (isValidLatitude && (fieldNumber === 1 || fieldNumber === 3 || fieldNumber === 5)) {
              logger.debug(`🌍 Found latitude in field ${fieldNumber}: ${value / 10000000}`);
              if (!telemetry.position) telemetry.position = {};
              telemetry.position.latitude = value / 10000000;
            } else if (isValidLongitude && (fieldNumber === 2 || fieldNumber === 4 || fieldNumber === 6)) {
              logger.debug(`🌍 Found longitude in field ${fieldNumber}: ${value / 10000000}`);
              if (!telemetry.position) telemetry.position = {};
              telemetry.position.longitude = value / 10000000;
            } else if (fieldNumber === 3 && value >= -1000 && value <= 10000) {
              // Could be altitude in meters, or RSSI if negative and in different range
              if (value >= -200 && value <= -20) {
                // Likely RSSI
                telemetry.rssi = value;
              } else if (value >= -1000 && value <= 10000) {
                // Likely altitude
                if (!telemetry.position) telemetry.position = {};
                telemetry.position.altitude = value;
              }
            } else if (fieldNumber === 4 && value >= -30 && value <= 20) {
              // Likely SNR (but as integer * 4 or * 100)
              telemetry.snr = value > 100 ? value / 100 : value / 4;
            } else if (fieldNumber === 5 && value >= 0 && value <= 100) {
              // Likely battery percentage
              if (!telemetry.deviceMetrics) telemetry.deviceMetrics = {};
              telemetry.deviceMetrics.batteryLevel = value;
            } else if (fieldNumber === 7 && value > 0) {
              // Hardware model
              telemetry.hwModel = value;
            }

          } else if (wireType === 1) { // Fixed64 (double)
            if (offset + 8 <= data.length) {
              const value = new DataView(data.buffer, data.byteOffset + offset, 8);
              const doubleVal = value.getFloat64(0, true); // little endian

              // Check for coordinate values
              if (doubleVal >= -180 && doubleVal <= 180 && Math.abs(doubleVal) > 0.001) {
                if (!telemetry.position) telemetry.position = {};
                if (fieldNumber === 1 && doubleVal >= -90 && doubleVal <= 90) {
                  telemetry.position.latitude = doubleVal;
                } else if (fieldNumber === 2 && doubleVal >= -180 && doubleVal <= 180) {
                  telemetry.position.longitude = doubleVal;
                } else if (fieldNumber === 3 && doubleVal >= -1000 && doubleVal <= 10000) {
                  telemetry.position.altitude = doubleVal;
                }
              }

              offset += 8;
            }

          } else if (wireType === 5) { // Fixed32 (float)
            if (offset + 4 <= data.length) {
              const value = new DataView(data.buffer, data.byteOffset + offset, 4);
              const floatVal = value.getFloat32(0, true); // little endian

              if (Number.isFinite(floatVal)) {
                // SNR as float (typical range -25 to +15)
                if (floatVal >= -30 && floatVal <= 20 && !telemetry.snr) {
                  telemetry.snr = Math.round(floatVal * 100) / 100;
                }

                // Voltage (typical range 3.0V to 5.0V)
                if (floatVal >= 2.5 && floatVal <= 6.0) {
                  if (!telemetry.deviceMetrics) telemetry.deviceMetrics = {};
                  if (!telemetry.deviceMetrics.voltage) {
                    telemetry.deviceMetrics.voltage = Math.round(floatVal * 100) / 100;
                  }
                }

                // Channel utilization (0.0 to 1.0)
                if (floatVal >= 0.0 && floatVal <= 1.0) {
                  if (!telemetry.deviceMetrics) telemetry.deviceMetrics = {};
                  if (!telemetry.deviceMetrics.channelUtilization) {
                    telemetry.deviceMetrics.channelUtilization = Math.round(floatVal * 1000) / 1000;
                  }
                }
              }

              offset += 4;
            }

          } else if (wireType === 2) { // Length-delimited (embedded messages, strings)
            if (offset < data.length) {
              const length = data[offset];
              offset++;

              if (offset + length <= data.length && length > 0) {
                const fieldData = data.slice(offset, offset + length);

                // Try to parse as embedded telemetry message
                if (length >= 4) {
                  this.parseEmbeddedTelemetry(fieldData, telemetry);
                }

                offset += length;
              }
            }
          } else {
            offset++;
          }
        } else {
          offset++;
        }
      } catch (error) {
        offset++;
      }
    }

    return telemetry;
  }


  // @ts-ignore - Legacy function kept for backward compatibility
  private async processPacket(packet: any): Promise<void> {
    // Handle the new packet structure from enhanced protobuf parsing
    if (packet.text && packet.text.length > 0) {
      // Ensure nodes exist in database before creating message
      const fromNodeId = packet.fromNodeId || 'unknown';
      const toNodeId = packet.toNodeId || '!ffffffff';
      const fromNodeNum = packet.from || packet.fromNodeNum || 0;
      const toNodeNum = packet.to || packet.toNodeNum || 0xFFFFFFFF;

      // Make sure fromNode exists in database (including unknown nodes)
      const existingFromNode = databaseService.getNode(fromNodeNum);
      if (!existingFromNode) {
        // Create a basic node entry if it doesn't exist
        const nodeData = {
          nodeNum: fromNodeNum,
          nodeId: fromNodeId,
          longName: fromNodeId === 'unknown' ? 'Unknown Node' : fromNodeId,
          shortName: fromNodeId === 'unknown' ? 'UNK' : fromNodeId.substring(1, 5),
          hwModel: 0,
          lastHeard: Date.now() / 1000,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        logger.debug(`Creating missing fromNode: ${fromNodeId} (${fromNodeNum})`);
        logger.debug(`DEBUG nodeData values: nodeNum=${nodeData.nodeNum}, nodeId="${nodeData.nodeId}"`);
        logger.debug(`DEBUG nodeData types: nodeNum type=${typeof nodeData.nodeNum}, nodeId type=${typeof nodeData.nodeId}`);
        logger.debug(`DEBUG validation check: nodeNum undefined? ${nodeData.nodeNum === undefined}, nodeNum null? ${nodeData.nodeNum === null}, nodeId falsy? ${!nodeData.nodeId}`);

        // Force output with console.error to bypass any buffering
        logger.error(`FORCE DEBUG: nodeData:`, JSON.stringify(nodeData));

        databaseService.upsertNode(nodeData);
        logger.debug(`DEBUG: Called upsertNode, checking if node was created...`);
        const checkNode = databaseService.getNode(fromNodeNum);
        logger.debug(`DEBUG: Node exists after upsert:`, checkNode ? 'YES' : 'NO');
      }

      // Make sure toNode exists in database (including broadcast node)
      const existingToNode = databaseService.getNode(toNodeNum);
      if (!existingToNode) {
        const nodeData = {
          nodeNum: toNodeNum,
          nodeId: toNodeId,
          longName: toNodeId === '!ffffffff' ? 'Broadcast' : toNodeId,
          shortName: toNodeId === '!ffffffff' ? 'BCST' : toNodeId.substring(1, 5),
          hwModel: 0,
          lastHeard: Date.now() / 1000,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        logger.debug(`Creating missing toNode: ${toNodeId} (${toNodeNum})`);
        databaseService.upsertNode(nodeData);
      }

      // Determine if this is a direct message or a channel message
      const isDirectMessage = toNodeNum !== 4294967295;
      const channelIndex = isDirectMessage ? -1 : (packet.channel || 0);

      const message = {
        id: packet.id || `${fromNodeId}_${Date.now()}`,
        fromNodeNum: fromNodeNum,
        toNodeNum: toNodeNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        text: packet.text,
        channel: channelIndex,
        portnum: packet.portnum,
        timestamp: packet.timestamp || Date.now(),
        rxTime: packet.rxTime || packet.timestamp || Date.now(),
        createdAt: packet.createdAt || Date.now()
      };

      try {
        databaseService.insertMessage(message);

        // Emit WebSocket event for real-time updates
        dataEventEmitter.emitNewMessage(message as any);

        if (isDirectMessage) {
          logger.debug('Saved direct message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
        } else {
          logger.debug('Saved channel message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
        }

        // Send push notification for new message
        await this.sendMessagePushNotification(message, message.text, isDirectMessage);
      } catch (error) {
        logger.error('Failed to save message:', error);
        logger.error('Message data:', message);
      }
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private async processNodeInfo(nodeInfo: any): Promise<void> {
    // Check existing node to avoid overwriting lastHeard with stale/default values
    const existingNode = databaseService.getNode(Number(nodeInfo.num));

    // Only update lastHeard if device provides a valid value that's newer than existing
    // This fixes #1706 where config sync was resetting lastHeard for all nodes
    let lastHeardValue: number | undefined = undefined;
    if (nodeInfo.lastHeard && nodeInfo.lastHeard > 0) {
      const incomingLastHeard = Math.min(Math.floor(Number(nodeInfo.lastHeard)), Math.floor(Date.now() / 1000));
      if (!existingNode || !existingNode.lastHeard || incomingLastHeard > existingNode.lastHeard) {
        lastHeardValue = incomingLastHeard;
      }
    }

    const nodeData: any = {
      nodeNum: nodeInfo.num,
      nodeId: nodeInfo.user?.id || nodeInfo.num.toString(),
      longName: nodeInfo.user?.longName,
      shortName: nodeInfo.user?.shortName,
      hwModel: nodeInfo.user?.hwModel,
      macaddr: nodeInfo.user?.macaddr,
      latitude: nodeInfo.position?.latitude,
      longitude: nodeInfo.position?.longitude,
      altitude: nodeInfo.position?.altitude,
      // Note: Telemetry data (batteryLevel, voltage, etc.) is NOT saved from NodeInfo packets
      // It is only saved from actual TELEMETRY_APP packets in processTelemetryMessageProtobuf()
      ...(lastHeardValue !== undefined && { lastHeard: lastHeardValue }),
      snr: nodeInfo.snr,
      rssi: nodeInfo.rssi
    };

    try {
      databaseService.upsertNode(nodeData);
      logger.debug('Updated node in database:', nodeData.longName || nodeData.nodeId);
    } catch (error) {
      logger.error('Failed to update node:', error);
    }
  }

  // Configuration retrieval methods
  async getDeviceConfig(): Promise<any> {
    // Return config data from what we've received via TCP stream
    logger.info('🔍 getDeviceConfig called - actualDeviceConfig.lora present:', !!this.actualDeviceConfig?.lora);
    logger.info('🔍 getDeviceConfig called - actualModuleConfig present:', !!this.actualModuleConfig);

    if (this.actualDeviceConfig?.lora || this.actualModuleConfig) {
      logger.debug('Using actualDeviceConfig:', JSON.stringify(this.actualDeviceConfig, null, 2));
      logger.info('✅ Returning device config from actualDeviceConfig');
      return this.buildDeviceConfigFromActual();
    }

    logger.info('⚠️ No device config available yet - returning null');
    logger.debug('No device config available yet');
    return null;
  }

  /**
   * Calculate LoRa frequency from region and channel number (frequency slot)
   * Delegates to the utility function for better testability
   */
  private calculateLoRaFrequency(region: number, channelNum: number, overrideFrequency: number, frequencyOffset: number, bandwidth: number = 250): string {
    return calculateLoRaFrequency(region, channelNum, overrideFrequency, frequencyOffset, bandwidth);
  }

  private buildDeviceConfigFromActual(): any {
    const dbChannels = databaseService.getAllChannels();
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
        nodeAddress: this.getConfig().nodeIp,
        tcpPort: this.getConfig().tcpPort,
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
          typeof loraConfigWithDefaults.bandwidth === 'number' && loraConfigWithDefaults.bandwidth > 0 ? loraConfigWithDefaults.bandwidth : 250
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
      // Use the new protobuf service to create a proper text message
      // Note: PKI encryption is handled automatically by the firmware if it has the recipient's public key
      const { data: textMessageData, messageId } = meshtasticProtobufService.createTextMessage(text, destination, channel, replyId, emoji);

      await this.transport.send(textMessageData);

      // Log message sending at INFO level for production visibility
      const destinationInfo = destination ? `node !${destination.toString(16).padStart(8, '0')}` : `channel ${channel}`;
      logger.info(`📤 Sent message to ${destinationInfo}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (ID: ${messageId})`);
      logger.debug('Message sent successfully:', text, 'with ID:', messageId);

      // Log outgoing message to packet monitor
      this.logOutgoingPacket(
        1, // TEXT_MESSAGE_APP
        destination || 0xffffffff,
        channel,
        `"${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        { messageId, replyId, emoji }
      );

      // Save sent message to database for UI display
      // Try database settings first, then fall back to this.localNodeInfo
      let localNodeNum = databaseService.getSetting('localNodeNum');
      let localNodeId = databaseService.getSetting('localNodeId');

      // Fallback to this.localNodeInfo if settings aren't available
      if (!localNodeNum && this.localNodeInfo) {
        localNodeNum = this.localNodeInfo.nodeNum.toString();
        localNodeId = this.localNodeInfo.nodeId;
        logger.debug(`Using localNodeInfo as fallback: ${localNodeId}`);
      }

      if (localNodeNum && localNodeId) {
        const toNodeId = destination ? `!${destination.toString(16).padStart(8, '0')}` : 'broadcast';

        const messageId_str = `${localNodeNum}_${messageId}`;
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

        databaseService.insertMessage(message);

        // Emit WebSocket event for real-time updates (sent message)
        dataEventEmitter.emitNewMessage(message as any);

        logger.debug(`💾 Saved sent message to database: "${text.substring(0, 30)}..."`);

        // Automatically mark sent messages as read for the sending user
        if (userId !== undefined) {
          databaseService.markMessageAsRead(messageId_str, userId);
          logger.debug(`✅ Automatically marked sent message as read for user ${userId}`);
        }
      }

      // Broadcast outgoing text message to virtual node clients as a proper FromRadio
      const virtualNodeServer = (global as any).virtualNodeServer;
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
      const virtualNodeServer = (global as any).virtualNodeServer;
      if (virtualNodeServer) {
        try {
          await virtualNodeServer.broadcastToClients(tracerouteData);
          logger.debug(`📡 Broadcasted outgoing traceroute to virtual node clients (${tracerouteData.length} bytes)`);
        } catch (error) {
          logger.error('Virtual node: Failed to broadcast outgoing traceroute:', error);
        }
      }

      databaseService.recordTracerouteRequest(this.localNodeInfo.nodeNum, destination);
      logger.info(`📤 Traceroute request sent from ${this.localNodeInfo.nodeId} to !${destination.toString(16).padStart(8, '0')}`);

      // Log outgoing traceroute to packet monitor
      this.logOutgoingPacket(
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
        const localNode = databaseService.getNode(this.localNodeInfo.nodeNum);
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
      const virtualNodeServer = (global as any).virtualNodeServer;
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
      this.logOutgoingPacket(
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
   * Send a NodeInfo request to a specific node (Exchange User Info)
   * This will request the destination node to send back its user information
   * Similar to "Exchange User Info" feature in mobile apps - triggers key exchange
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
      const localNode = databaseService.getNode(this.localNodeInfo.nodeNum);
      // Decode base64 public key to Uint8Array
      let publicKeyBytes: Uint8Array | undefined;
      if (localNode?.publicKey) {
        try {
          publicKeyBytes = new Uint8Array(Buffer.from(localNode.publicKey, 'base64'));
          logger.info(`🔐 Including public key in NodeInfo exchange: ${localNode.publicKey.substring(0, 20)}... (${publicKeyBytes.length} bytes)`);
        } catch (err) {
          logger.warn('⚠️ Failed to decode public key from base64:', err);
        }
      }
      const localUserInfo = localNode ? {
        id: this.localNodeInfo.nodeId,
        longName: localNode.longName || 'Unknown',
        shortName: localNode.shortName || '????',
        hwModel: localNode.hwModel,
        role: localNode.role,
        publicKey: publicKeyBytes
      } : undefined;

      const { data: nodeInfoRequestData, packetId, requestId } = meshtasticProtobufService.createNodeInfoRequestMessage(
        destination,
        channel,
        localUserInfo
      );

      logger.info(`📇 NodeInfo exchange packet created: ${nodeInfoRequestData.length} bytes for dest=${destination} (0x${destination.toString(16)}), channel=${channel}, packetId=${packetId}, requestId=${requestId}, userInfo=${localUserInfo ? localUserInfo.longName : 'none'}`);

      await this.transport.send(nodeInfoRequestData);

      // Broadcast to virtual node clients (including packet monitor)
      const virtualNodeServer = (global as any).virtualNodeServer;
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
      this.logOutgoingPacket(
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
      const virtualNodeServer = (global as any).virtualNodeServer;
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
      this.logOutgoingPacket(
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
      const virtualNodeServer = (global as any).virtualNodeServer;
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
      this.logOutgoingPacket(
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
      const virtualNodeServer = (global as any).virtualNodeServer;
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
      const localNodeNum = databaseService.getSetting('localNodeNum');
      if (localNodeNum && parseInt(localNodeNum) === message.fromNodeNum) {
        logger.debug('⏭️  Skipping push notification for message from local node');
        return;
      }

      // Get sender info
      const fromNode = databaseService.getNode(message.fromNodeNum);
      const senderName = fromNode?.longName || fromNode?.shortName || `Node ${message.fromNodeNum}`;

      // Determine notification title and body
      let title: string;
      let body: string;

      if (isDirectMessage) {
        title = `Direct Message from ${senderName}`;
        body = messageText.length > 100 ? messageText.substring(0, 97) + '...' : messageText;
      } else {
        // Get channel name
        const channel = databaseService.getChannelById(message.channel);
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

      // Send notifications (Web Push + Apprise) with filtering to all subscribed users
      const result = await notificationService.broadcast({
        title,
        body,
        data: navigationData
      }, {
        messageText,
        channelId: message.channel,
        isDirectMessage,
        viaMqtt: message.viaMqtt === true
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
      // Get auto-acknowledge settings from database
      const autoAckEnabled = databaseService.getSetting('autoAckEnabled');
      const autoAckRegex = databaseService.getSetting('autoAckRegex');

      // Skip if auto-acknowledge is disabled
      if (autoAckEnabled !== 'true') {
        return;
      }

      // Check channel-specific settings
      const autoAckChannels = databaseService.getSetting('autoAckChannels');
      const autoAckDirectMessages = databaseService.getSetting('autoAckDirectMessages');

      // Parse enabled channels (comma-separated list of channel indices)
      const enabledChannels = autoAckChannels
        ? autoAckChannels.split(',').map(c => parseInt(c.trim())).filter(n => !isNaN(n))
        : [];
      const dmEnabled = autoAckDirectMessages === 'true';

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
      const localNodeNum = databaseService.getSetting('localNodeNum');
      if (localNodeNum && parseInt(localNodeNum) === fromNum) {
        logger.debug('⏭️  Skipping auto-acknowledge for message from local node');
        return;
      }

      // Skip auto-acknowledge for incomplete nodes (nodes we haven't received full NODEINFO from)
      // This prevents sending automated messages to nodes that may not be on the same secure channel
      const autoAckSkipIncompleteNodes = databaseService.getSetting('autoAckSkipIncompleteNodes');
      if (autoAckSkipIncompleteNodes === 'true') {
        const fromNode = databaseService.getNode(fromNum);
        if (fromNode && !isNodeComplete(fromNode)) {
          logger.debug(`⏭️  Skipping auto-acknowledge for incomplete node ${fromNode.nodeId || fromNum} (missing proper name or hwModel)`);
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
      const isDirect = hopsTraveled === 0;

      // Check if this message type is enabled
      const typeEnabled = isDirect
        ? databaseService.getSetting('autoAckDirectEnabled') !== 'false'
        : databaseService.getSetting('autoAckMultihopEnabled') !== 'false';

      if (!typeEnabled) {
        logger.debug(`⏭️ Skipping auto-acknowledge: ${isDirect ? 'direct' : 'multihop'} messages disabled`);
        return;
      }

      // Get tapback/reply settings for this message type
      const autoAckTapbackEnabled = isDirect
        ? databaseService.getSetting('autoAckDirectTapbackEnabled') !== 'false'
        : databaseService.getSetting('autoAckMultihopTapbackEnabled') !== 'false';

      const autoAckReplyEnabled = isDirect
        ? databaseService.getSetting('autoAckDirectReplyEnabled') !== 'false'
        : databaseService.getSetting('autoAckMultihopReplyEnabled') !== 'false';

      // If neither tapback nor reply is enabled for this type, skip
      if (!autoAckTapbackEnabled && !autoAckReplyEnabled) {
        logger.debug(`⏭️ Skipping auto-acknowledge: both tapback and reply are disabled for ${isDirect ? 'direct' : 'multihop'} messages`);
        return;
      }

      // Check if we should always use DM
      const autoAckUseDM = databaseService.getSetting('autoAckUseDM');
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

        // Tapbacks always reply on the original channel (not affected by alwaysUseDM)
        try {
          await this.sendTextMessage(
            hopEmoji,
            isDirectMessage ? 0 : channelIndex,
            isDirectMessage ? fromNum : undefined,
            packetId, // replyId - react to the original message
            1 // emoji flag = 1 for tapback/reaction
          );
          logger.info(`✅ Auto-acknowledge tapback ${hopEmoji} delivered to ${target}`);
          // Record the send so that the message reply respects the 30s rate limit
          messageQueueService.recordExternalSend();
        } catch (error) {
          logger.warn(`❌ Auto-acknowledge tapback failed to ${target}:`, error);
        }
      }

      // Send message reply if enabled
      if (autoAckReplyEnabled) {
        // Get auto-acknowledge message template
        // Use the direct message template for 0 hops if available, otherwise fall back to standard template
        const autoAckMessageDirect = databaseService.getSetting('autoAckMessageDirect') || '';
        const autoAckMessageStandard = databaseService.getSetting('autoAckMessage') || '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
        const autoAckMessage = (hopsTraveled === 0 && autoAckMessageDirect)
          ? autoAckMessageDirect
          : autoAckMessageStandard;

        // Format timestamp according to user preferences
        const timestamp = new Date(message.timestamp);

        // Get date and time format preferences from settings
        const dateFormat = databaseService.getSetting('dateFormat') || 'MM/DD/YYYY';
        const timeFormat = databaseService.getSetting('timeFormat') || '24';

        // Use formatDate and formatTime utilities to respect user preferences
        const receivedDate = formatDate(timestamp, dateFormat as 'MM/DD/YYYY' | 'DD/MM/YYYY');
        const receivedTime = formatTime(timestamp, timeFormat as '12' | '24');

        // Replace tokens in the message template
        const ackText = await this.replaceAcknowledgementTokens(autoAckMessage, message.fromNodeId, fromNum, hopsTraveled, receivedDate, receivedTime, channelIndex, isDirectMessage, rxSnr, rxRssi, message.viaMqtt);

        // Don't make it a reply if we're changing channels (DM when triggered by channel message)
        const replyId = (alwaysUseDM && !isDirectMessage) ? undefined : packetId;

        logger.debug(`🤖 Auto-acknowledging message from ${message.fromNodeId}: "${messageText}" with "${ackText}" ${alwaysUseDM ? '(via DM)' : ''}`);

        // Use message queue to send auto-acknowledge with rate limiting and retry logic
        messageQueueService.enqueue(
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

  private async checkAutoResponder(message: TextMessage, isDirectMessage: boolean, packetId?: number): Promise<void> {
    try {
      // Get auto-responder settings from database
      const autoResponderEnabled = databaseService.getSetting('autoResponderEnabled');

      // Skip if auto-responder is disabled
      if (autoResponderEnabled !== 'true') {
        return;
      }

      // Skip messages from our own locally connected node
      const localNodeNum = databaseService.getSetting('localNodeNum');
      if (localNodeNum && parseInt(localNodeNum) === message.fromNodeNum) {
        logger.debug('⏭️  Skipping auto-responder for message from local node');
        return;
      }

      // Skip auto-responder for incomplete nodes (nodes we haven't received full NODEINFO from)
      // This prevents sending automated messages to nodes that may not be on the same secure channel
      const autoResponderSkipIncompleteNodes = databaseService.getSetting('autoResponderSkipIncompleteNodes');
      if (autoResponderSkipIncompleteNodes === 'true') {
        const fromNode = databaseService.getNode(message.fromNodeNum);
        if (fromNode && !isNodeComplete(fromNode)) {
          logger.debug(`⏭️  Skipping auto-responder for incomplete node ${fromNode.nodeId || message.fromNodeNum} (missing proper name or hwModel)`);
          return;
        }
      }

      // Get triggers array
      const autoResponderTriggersStr = databaseService.getSetting('autoResponderTriggers');
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

      logger.info(`🤖 Auto-responder checking message on ${isDirectMessage ? 'DM' : `channel ${message.channel}`}: "${message.text}"`);

      // Try to match message against triggers
      for (const trigger of triggers) {
        // Filter trigger by channel - default to 'dm' if not specified for backward compatibility
        const triggerChannel = trigger.channel ?? 'dm';

        logger.info(`🤖 Checking trigger "${trigger.trigger}" (channel: ${triggerChannel}) against message on ${isDirectMessage ? 'DM' : `channel ${message.channel}`}`);

        // Check if this trigger applies to the current message
        if (isDirectMessage) {
          // For DMs, only match triggers configured for DM
          if (triggerChannel !== 'dm') {
            logger.info(`⏭️  Skipping trigger "${trigger.trigger}" - configured for channel ${triggerChannel}, but message is DM`);
            continue;
          }
        } else {
          // For channel messages, only match triggers configured for this specific channel
          if (triggerChannel !== message.channel) {
            logger.info(`⏭️  Skipping trigger "${trigger.trigger}" - configured for ${triggerChannel === 'dm' ? 'DM' : `channel ${triggerChannel}`}, but message is on channel ${message.channel}`);
            continue;
          }
        }

        // Handle both string and array types for trigger.trigger
        const patterns = normalizeTriggerPatterns(trigger.trigger);
        let matchedPattern: string | null = null;
        let extractedParams: Record<string, string> = {};

        // Try each pattern until one matches
        for (const patternStr of patterns) {
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
          const triggerMatch = message.text.match(triggerRegex);

          if (triggerMatch) {
            // Extract parameters
            extractedParams = {};
            params.forEach((param, index) => {
              extractedParams[param.name] = triggerMatch[index + 1];
            });
            matchedPattern = patternStr;
            break; // Found a match, stop trying other patterns
          }
        }

        if (matchedPattern) {
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
          const dateFormat = databaseService.getSetting('dateFormat') || 'MM/DD/YYYY';
          const timeFormat = databaseService.getSetting('timeFormat') || '24';
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
                interpreter = isDev ? 'python' : '/usr/bin/python3';
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

              const scriptEnv = this.createScriptEnvVariables(message, matchedPattern, extractedParams, trigger, packetId);

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

              // Execute script with 10-second timeout
              // Use resolvedPath (actual file path) instead of scriptPath (API format)
              const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath, ...scriptArgsList], {
                timeout: 10000,
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
              const triggerChannel = trigger.channel ?? 'dm';

              // Skip sending if channel is 'none' (script handles its own output)
              if (triggerChannel === 'none') {
                const scriptDuration = Date.now() - scriptStartTime;
                logger.info(`🔧 Auto-responder script for "${triggerPattern}" completed in ${scriptDuration}ms (channel=none, no mesh output)`);
                return;
              }

              const isDM = triggerChannel === 'dm';
              // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
              const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
              const target = isDM ? `!${message.fromNodeNum.toString(16).padStart(8, '0')}` : `channel ${triggerChannel}`;
              logger.debug(`🤖 Enqueueing ${scriptResponses.length} script response(s) to ${target}${trigger.verifyResponse ? ' (with verification)' : ''}`);

              scriptResponses.forEach((resp, index) => {
                const truncated = this.truncateMessageForMeshtastic(resp, 200);
                const isFirstMessage = index === 0;

                messageQueueService.enqueue(
                  truncated,
                  isDM ? message.fromNodeNum : 0, // destination: node number for DM, 0 for channel
                  isFirstMessage ? packetId : undefined, // Reply to original message for first response
                  () => {
                    logger.info(`✅ Script response ${index + 1}/${scriptResponses.length} delivered to ${target}`);
                  },
                  (reason: string) => {
                    logger.warn(`❌ Script response ${index + 1}/${scriptResponses.length} failed to ${target}: ${reason}`);
                  },
                  isDM ? undefined : triggerChannel as number, // channel: undefined for DM, channel number for channel
                  maxAttempts
                );
              });

              // Script responses queued
              const scriptDuration = Date.now() - scriptStartTime;
              logger.info(`🔧 Auto-responder script for "${triggerPattern}" completed in ${scriptDuration}ms, ${scriptResponses.length} response(s) queued to ${target}`);
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
          const triggerChannel = trigger.channel ?? 'dm';
          const isDM = triggerChannel === 'dm';
          // For DMs: use 3 attempts if verifyResponse is enabled, otherwise just 1 attempt
          const maxAttempts = isDM ? (trigger.verifyResponse ? 3 : 1) : 1;
          const target = isDM ? `!${message.fromNodeNum.toString(16).padStart(8, '0')}` : `channel ${triggerChannel}`;
          logger.debug(`🤖 Enqueueing ${messagesToSend.length} auto-response message(s) to ${target}${trigger.verifyResponse ? ' (with verification)' : ''}`);

          messagesToSend.forEach((msg, index) => {
            const isFirstMessage = index === 0;
            messageQueueService.enqueue(
              msg,
              isDM ? message.fromNodeNum : 0, // destination: node number for DM, 0 for channel
              isFirstMessage ? packetId : undefined, // Reply to original message for first response
              () => {
                logger.info(`✅ Auto-response ${index + 1}/${messagesToSend.length} delivered to ${target}`);
              },
              (reason: string) => {
                logger.warn(`❌ Auto-response ${index + 1}/${messagesToSend.length} failed to ${target}: ${reason}`);
              },
              isDM ? undefined : triggerChannel as number, // channel: undefined for DM, channel number for channel
              maxAttempts
            );
          });

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
  private createScriptEnvVariables(message: TextMessage, matchedPattern: string, extractedParams: Record<string, string>, trigger: AutoResponderTrigger, packetId?: number) {
    const config = this.getScriptConnectionConfig();
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

    // Add sender node information environment variables
    const fromNode = databaseService.getNode(message.fromNodeNum);
    if (fromNode) {
      // Add node names (Issue #1099)
      if (fromNode.shortName) {
        scriptEnv.FROM_SHORT_NAME = fromNode.shortName;
      }
      if (fromNode.longName) {
        scriptEnv.FROM_LONG_NAME = fromNode.longName;
      }
      // Add location (FROM_LAT, FROM_LON)
      if (fromNode.latitude != null && fromNode.longitude != null) {
        scriptEnv.FROM_LAT = String(fromNode.latitude);
        scriptEnv.FROM_LON = String(fromNode.longitude);
      }
    }

    // Add location environment variables for the MeshMonitor node (MM_LAT, MM_LON)
    const localNodeInfo = this.getLocalNodeInfo();
    if (localNodeInfo) {
      const mmNode = databaseService.getNode(localNodeInfo.nodeNum);
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
    try {
      // Get auto-welcome settings from database
      const autoWelcomeEnabled = databaseService.getSetting('autoWelcomeEnabled');

      // Skip if auto-welcome is disabled
      if (autoWelcomeEnabled !== 'true') {
        return;
      }

      // Skip messages from our own locally connected node
      const localNodeNum = databaseService.getSetting('localNodeNum');
      if (localNodeNum && parseInt(localNodeNum) === nodeNum) {
        logger.debug('⏭️  Skipping auto-welcome for local node');
        return;
      }

      // RACE CONDITION PROTECTION: Check if we're already welcoming this node
      if (this.welcomingNodes.has(nodeNum)) {
        logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - already being welcomed in parallel`);
        return;
      }

      // Check if we've already welcomed this node
      const node = databaseService.getNode(nodeNum);
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
      // Check if we should wait for name
      const autoWelcomeWaitForName = databaseService.getSetting('autoWelcomeWaitForName');
      if (autoWelcomeWaitForName === 'true') {
        // Check if node has a proper name (not default "Node !xxxxxxxx")
        if (!node.longName || node.longName.startsWith('Node !')) {
          logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - waiting for proper name (current: ${node.longName})`);
          return;
        }
        if (!node.shortName || node.shortName === nodeId.substring(1, 5)) {
          logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - waiting for proper short name (current: ${node.shortName})`);
          return;
        }
      }

      // Check if node exceeds maximum hop count
      const autoWelcomeMaxHops = databaseService.getSetting('autoWelcomeMaxHops');
      const maxHops = autoWelcomeMaxHops ? parseInt(autoWelcomeMaxHops) : 5; // Default to 5 hops
      if (node.hopsAway !== undefined && node.hopsAway > maxHops) {
        logger.debug(`⏭️  Skipping auto-welcome for ${nodeId} - too far away (${node.hopsAway} hops > ${maxHops} max)`);
        return;
      }

      // RACE CONDITION PROTECTION: Mark that we're welcoming this node
      // This prevents duplicate welcomes if multiple packets arrive before database is updated
      // Lock is added AFTER all conditions are satisfied to allow re-evaluation on subsequent calls
      this.welcomingNodes.add(nodeNum);
      logger.debug(`🔒 Locked auto-welcome for ${nodeId} to prevent duplicates`);

      try {

        // Get welcome message template
        const autoWelcomeMessage = databaseService.getSetting('autoWelcomeMessage') || 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';

        // Replace tokens in the message template
        const welcomeText = await this.replaceWelcomeTokens(autoWelcomeMessage, nodeNum, nodeId);

        // Get target (DM or channel)
        const autoWelcomeTarget = databaseService.getSetting('autoWelcomeTarget') || '0';

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

        await this.sendTextMessage(welcomeText, channel, destination);

        // Mark node as welcomed using atomic check-and-set operation
        // This ensures the node is only marked if it hasn't been marked already
        const wasMarked = databaseService.markNodeAsWelcomedIfNotAlready(nodeNum, nodeId);
        if (wasMarked) {
          logger.info(`✅ Node ${nodeId} welcomed successfully and marked in database`);
        } else {
          logger.warn(`⚠️  Node ${nodeId} was already marked as welcomed by another process`);
        }

        // RACE CONDITION PROTECTION: Release lock immediately after atomic database operation
        // The atomic operation completes synchronously, so no delay is needed
        this.welcomingNodes.delete(nodeNum);
        logger.debug(`🔓 Unlocked auto-welcome tracking for ${nodeId}`);
      } catch (error) {
        // Release lock on error as well
        this.welcomingNodes.delete(nodeNum);
        logger.debug(`🔓 Unlocked auto-welcome tracking for ${nodeId} (error case)`);
        throw error;
      }
    } catch (error) {
      logger.error('❌ Error in auto-welcome:', error);
    }
  }

  private async replaceWelcomeTokens(message: string, nodeNum: number, _nodeId: string): Promise<string> {
    let result = message;

    // Get node info
    const node = databaseService.getNode(nodeNum);

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
      const tracerouteInterval = databaseService.getSetting('tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }

      // Check auto-ack
      const autoAckEnabled = databaseService.getSetting('autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }

      // Check auto-announce
      const autoAnnounceEnabled = databaseService.getSetting('autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }

      // Check auto-welcome
      const autoWelcomeEnabled = databaseService.getSetting('autoWelcomeEnabled');
      if (autoWelcomeEnabled === 'true') {
        features.push('👋');
      }

      result = result.replace(/{FEATURES}/g, features.join(' '));
    }

    // {NODECOUNT} - Active nodes based on maxNodeAgeHours setting
    if (result.includes('{NODECOUNT}')) {
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
      result = result.replace(/{NODECOUNT}/g, nodes.length.toString());
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) from active nodes
    if (result.includes('{DIRECTCOUNT}')) {
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      result = result.replace(/{DIRECTCOUNT}/g, directCount.toString());
    }

    // {TOTALNODES} - Total nodes (all nodes ever seen, regardless of when last heard)
    if (result.includes('{TOTALNODES}')) {
      const allNodes = databaseService.getAllNodes();
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
    try {
      const message = databaseService.getSetting('autoAnnounceMessage') || 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';
      const channelIndex = parseInt(databaseService.getSetting('autoAnnounceChannelIndex') || '0');

      // Replace tokens
      const replacedMessage = await this.replaceAnnouncementTokens(message);

      logger.info(`📢 Sending auto-announcement to channel ${channelIndex}: "${replacedMessage}"`);

      await this.sendTextMessage(replacedMessage, channelIndex);

      // Update last announcement time
      databaseService.setSetting('lastAnnouncementTime', Date.now().toString());
      logger.debug('📢 Last announcement time updated');

      // Check if NodeInfo broadcasting is enabled
      const nodeInfoEnabled = databaseService.getSetting('autoAnnounceNodeInfoEnabled') === 'true';
      if (nodeInfoEnabled) {
        try {
          const nodeInfoChannelsStr = databaseService.getSetting('autoAnnounceNodeInfoChannels') || '[]';
          const nodeInfoChannels = JSON.parse(nodeInfoChannelsStr) as number[];
          const nodeInfoDelaySeconds = parseInt(databaseService.getSetting('autoAnnounceNodeInfoDelaySeconds') || '30');

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
    let result = message;
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
      const tracerouteInterval = databaseService.getSetting('tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }

      // Check auto-ack
      const autoAckEnabled = databaseService.getSetting('autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }

      // Check auto-announce
      const autoAnnounceEnabled = databaseService.getSetting('autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }

      // Check auto-welcome
      const autoWelcomeEnabled = databaseService.getSetting('autoWelcomeEnabled');
      if (autoWelcomeEnabled === 'true') {
        features.push('👋');
      }

      result = result.replace(/{FEATURES}/g, encode(features.join(' ')));
    }

    // {NODECOUNT} - Active nodes based on maxNodeAgeHours setting
    if (result.includes('{NODECOUNT}')) {
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
      logger.info(`📢 Token replacement - NODECOUNT: ${nodes.length} active nodes (maxNodeAgeHours: ${maxNodeAgeHours})`);
      result = result.replace(/{NODECOUNT}/g, encode(nodes.length.toString()));
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) from active nodes
    if (result.includes('{DIRECTCOUNT}')) {
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      logger.info(`📢 Token replacement - DIRECTCOUNT: ${directCount} direct nodes out of ${nodes.length} active nodes`);
      result = result.replace(/{DIRECTCOUNT}/g, encode(directCount.toString()));
    }

    // {TOTALNODES} - Total nodes (all nodes ever seen, regardless of when last heard)
    if (result.includes('{TOTALNODES}')) {
      const allNodes = databaseService.getAllNodes();
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
      const config = this.getConfig();
      result = result.replace(/{IP}/g, encode(config.nodeIp));
    }

    // {PORT} - Meshtastic node TCP port
    if (result.includes('{PORT}')) {
      const config = this.getConfig();
      result = result.replace(/{PORT}/g, encode(String(config.tcpPort)));
    }

    return result;
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
      const node = databaseService.getNode(fromNum);
      const longName = node?.longName || 'Unknown';
      result = result.replace(/{LONG_NAME}/g, encode(longName));
    }

    // {SHORT_NAME} - Sender node short name
    if (result.includes('{SHORT_NAME}')) {
      const node = databaseService.getNode(fromNum);
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
        const channel = databaseService.getChannelById(channelIndex);
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
            Object.keys(moduleConfigResponse).forEach((key) => {
              // Skip internal protobuf fields
              if (key !== 'payloadVariant' && moduleConfigResponse[key] !== undefined) {
                nodeConfig.moduleConfig[key] = moduleConfigResponse[key];
              }
            });
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
  async sendFavoriteNode(nodeNum: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    try {
      // For local TCP connections, try sending without session passkey first
      // (there's a known bug where session keys don't work properly over TCP)
      logger.debug('⭐ Attempting to send favorite without session key (local TCP admin)');
      const setFavoriteMsg = protobufService.createSetFavoriteNodeMessage(nodeNum, new Uint8Array()); // empty passkey
      const adminPacket = protobufService.createAdminPacket(setFavoriteMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum); // send to local node

      await this.transport.send(adminPacket);
      logger.debug(`⭐ Sent set_favorite_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')})`);
    } catch (error) {
      logger.error('❌ Error sending favorite node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to remove a node from favorites on the device
   */
  async sendRemoveFavoriteNode(nodeNum: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    try {
      // For local TCP connections, try sending without session passkey first
      // (there's a known bug where session keys don't work properly over TCP)
      logger.debug('☆ Attempting to remove favorite without session key (local TCP admin)');
      const removeFavoriteMsg = protobufService.createRemoveFavoriteNodeMessage(nodeNum, new Uint8Array()); // empty passkey
      const adminPacket = protobufService.createAdminPacket(removeFavoriteMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum); // send to local node

      await this.transport.send(adminPacket);
      logger.debug(`☆ Sent remove_favorite_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')})`);
    } catch (error) {
      logger.error('❌ Error sending remove favorite node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to set a node as ignored on the device
   */
  async sendIgnoredNode(nodeNum: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support (ignored nodes use same version as favorites)
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    try {
      // For local TCP connections, try sending without session passkey first
      // (there's a known bug where session keys don't work properly over TCP)
      logger.debug('🚫 Attempting to set ignored node without session key (local TCP admin)');
      const setIgnoredMsg = protobufService.createSetIgnoredNodeMessage(nodeNum, new Uint8Array()); // empty passkey
      const adminPacket = protobufService.createAdminPacket(setIgnoredMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum); // send to local node

      await this.transport.send(adminPacket);
      logger.debug(`🚫 Sent set_ignored_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')})`);
    } catch (error) {
      logger.error('❌ Error sending ignored node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to remove a node from ignored list on the device
   */
  async sendRemoveIgnoredNode(nodeNum: number): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support (ignored nodes use same version as favorites)
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    try {
      // For local TCP connections, try sending without session passkey first
      // (there's a known bug where session keys don't work properly over TCP)
      logger.debug('✅ Attempting to remove ignored node without session key (local TCP admin)');
      const removeIgnoredMsg = protobufService.createRemoveIgnoredNodeMessage(nodeNum, new Uint8Array()); // empty passkey
      const adminPacket = protobufService.createAdminPacket(removeIgnoredMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum); // send to local node

      await this.transport.send(adminPacket);
      logger.debug(`✅ Sent remove_ignored_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')})`);
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
          13: 'statusmessage'
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
              13: 'statusmessage'
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
  async sendRebootCommand(destinationNodeNum: number, seconds: number = 5): Promise<void> {
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
      13  // STATUSMESSAGE_CONFIG
    ];

    logger.info('📦 Requesting all module configs for complete backup...');

    for (const configType of moduleConfigTypes) {
      try {
        await this.requestModuleConfig(configType);
        // Small delay between requests to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`❌ Failed to request module config type ${configType}:`, error);
        // Continue with other configs even if one fails
      }
    }

    logger.info('✅ All module config requests sent');
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
        this.logOutgoingPacket(
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
  async rebootDevice(seconds: number = 5): Promise<void> {
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
      }

      // Then send position configuration (fixedPosition flag, broadcast intervals, etc.)
      logger.debug('⚙️ Sending position config:', JSON.stringify(positionConfig));
      const setConfigMsg = protobufService.createSetPositionConfigMessage(positionConfig, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
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
  async setNodeOwner(longName: string, shortName: string, isUnmessagable?: boolean): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Setting node owner: "${longName}" (${shortName}), isUnmessagable: ${isUnmessagable}`);
      const setOwnerMsg = protobufService.createSetOwnerMessage(longName, shortName, isUnmessagable, new Uint8Array());
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

  getConnectionStatus(): { connected: boolean; nodeResponsive: boolean; configuring: boolean; nodeIp: string; userDisconnected?: boolean } {
    // Node is responsive if we have localNodeInfo (received MyNodeInfo from device)
    const nodeResponsive = this.localNodeInfo !== null;
    // Node is configuring if connected but initial config capture not complete
    const configuring = this.isConnected && !this.configCaptureComplete;
    logger.debug(`🔍 getConnectionStatus called: isConnected=${this.isConnected}, nodeResponsive=${nodeResponsive}, configuring=${configuring}, userDisconnected=${this.userDisconnectedState}`);
    return {
      connected: this.isConnected,
      nodeResponsive,
      configuring,
      nodeIp: this.getConfig().nodeIp,
      userDisconnected: this.userDisconnectedState
    };
  }

  // Get data from database instead of maintaining in-memory state
  getAllNodes(): DeviceInfo[] {
    const dbNodes = databaseService.getAllNodes();
    return dbNodes.map(node => {
      // Get latest uptime from telemetry
      const uptimeTelemetry = databaseService.getLatestTelemetryForType(node.nodeId, 'uptimeSeconds');

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
          uptimeSeconds: uptimeTelemetry?.value
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

      // Add isFavorite if it exists
      if (node.isFavorite !== null && node.isFavorite !== undefined) {
        deviceInfo.isFavorite = Boolean(node.isFavorite);
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
    });
  }

  getRecentMessages(limit: number = 50): MeshMessage[] {
    const dbMessages = databaseService.getMessages(limit);
    return dbMessages.map(msg => ({
      id: msg.id,
      from: msg.fromNodeId,
      to: msg.toNodeId,
      fromNodeId: msg.fromNodeId,
      toNodeId: msg.toNodeId,
      text: msg.text,
      channel: msg.channel,
      portnum: msg.portnum,
      timestamp: new Date(msg.rxTime ?? msg.timestamp),
      hopStart: msg.hopStart,
      hopLimit: msg.hopLimit,
      relayNode: msg.relayNode,
      replyId: msg.replyId,
      emoji: msg.emoji,
      viaMqtt: Boolean(msg.viaMqtt),
      rxSnr: msg.rxSnr,
      rxRssi: msg.rxRssi,
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
    await serverEventNotificationService.notifyNodeDisconnected();

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
      this.storeLinkQualityTelemetry(nodeNum, nodeId, initialQuality);

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
      this.storeLinkQualityTelemetry(nodeNum, nodeId, lqData.quality);
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
  private storeLinkQualityTelemetry(nodeNum: number, nodeId: string, quality: number): void {
    databaseService.insertTelemetry({
      nodeId: nodeId,
      nodeNum: nodeNum,
      telemetryType: 'linkQuality',
      timestamp: Date.now(),
      value: quality,
      unit: 'quality',
      createdAt: Date.now(),
    });
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

export default new MeshtasticManager();