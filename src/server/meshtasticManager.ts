import databaseService from '../services/database.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService from './protobufService.js';
import { TcpTransport } from './tcpTransport.js';
import { calculateDistance } from '../utils/distance.js';
import { logger } from '../utils/logger.js';
import { getEnvironmentConfig } from './config/environment.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

export interface MeshtasticConfig {
  nodeIp: string;
  tcpPort: number;
}

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
  };
  hopsAway?: number;
  lastHeard?: number;
  snr?: number;
  rssi?: number;
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
}

class MeshtasticManager {
  private config: MeshtasticConfig;
  private transport: TcpTransport | null = null;
  private isConnected = false;
  private userDisconnectedState = false;  // Track user-initiated disconnect
  private tracerouteInterval: NodeJS.Timeout | null = null;
  private tracerouteIntervalMinutes: number = 0;
  private announceInterval: NodeJS.Timeout | null = null;
  private serverStartTime: number = Date.now();
  private localNodeInfo: {
    nodeNum: number;
    nodeId: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    firmwareVersion?: string;
    isLocked?: boolean;  // Flag to prevent overwrites after initial setup
  } | null = null;
  private actualDeviceConfig: any = null;  // Store actual device config
  private actualModuleConfig: any = null;  // Store actual module config
  private sessionPasskey: Uint8Array | null = null;  // Session passkey for admin messages
  private sessionPasskeyExpiry: number | null = null;  // Expiry time (expires after 300 seconds)
  private favoritesSupportCache: boolean | null = null;  // Cache firmware support check result
  private cachedAutoAckRegex: { pattern: string; regex: RegExp } | null = null;  // Cached compiled regex

  constructor() {
    const env = getEnvironmentConfig();
    this.config = {
      nodeIp: env.meshtasticNodeIp,
      tcpPort: env.meshtasticTcpPort
    };
  }

  async connect(): Promise<boolean> {
    try {
      logger.debug(`Connecting to Meshtastic node at ${this.config.nodeIp}:${this.config.tcpPort}...`);

      // Initialize protobuf service first
      await meshtasticProtobufService.initialize();

      // Create TCP transport
      this.transport = new TcpTransport();

      // Setup event handlers
      this.transport.on('connect', () => {
        this.handleConnected();
      });

      this.transport.on('message', (data: Uint8Array) => {
        this.processIncomingData(data);
      });

      this.transport.on('disconnect', () => {
        this.handleDisconnected();
      });

      this.transport.on('error', (error: Error) => {
        logger.error('❌ TCP transport error:', error.message);
      });

      // Connect to node
      // Note: isConnected will be set to true in handleConnected() callback
      // when the connection is actually established
      await this.transport.connect(this.config.nodeIp, this.config.tcpPort);

      return true;
    } catch (error) {
      this.isConnected = false;
      logger.error('Failed to connect to Meshtastic node:', error);
      throw error;
    }
  }

  private async handleConnected(): Promise<void> {
    logger.debug('✅ TCP connection established, requesting configuration...');
    this.isConnected = true;

    try {
      // Send want_config_id to request full node DB and config
      await this.sendWantConfigId();

      logger.debug('⏳ Waiting for configuration data from node...');

      // Note: With TCP, we don't need to poll - messages arrive via events
      // The configuration will come in automatically as the node sends it

      // Give the node a moment to send initial config, then do basic setup
      setTimeout(async () => {
        // Ensure we have a Primary channel
        this.ensurePrimaryChannel();

        // If localNodeInfo wasn't set during configuration, initialize it from database
        if (!this.localNodeInfo) {
          await this.initializeLocalNodeInfoFromDatabase();
        }

        // Start automatic traceroute scheduler
        this.startTracerouteScheduler();

        // Start automatic announcement scheduler
        this.startAnnounceScheduler();

        logger.debug(`✅ Configuration complete: ${databaseService.getNodeCount()} nodes, ${databaseService.getChannelCount()} channels`);
      }, 5000);

    } catch (error) {
      logger.error('❌ Failed to request configuration:', error);
      this.ensureBasicSetup();
    }
  }

  private handleDisconnected(): void {
    logger.debug('🔌 TCP connection lost');
    this.isConnected = false;
    // Clear favorites support cache on disconnect
    this.favoritesSupportCache = null;

    // Only auto-reconnect if not in user-disconnected state
    if (this.userDisconnectedState) {
      logger.debug('⏸️  User-initiated disconnect active, skipping auto-reconnect');
    } else {
      // Transport will handle automatic reconnection
      logger.debug('🔄 Auto-reconnection will be attempted by transport');
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
        const stmt = databaseService.db.prepare(`
          INSERT OR REPLACE INTO channels (id, name, createdAt, updatedAt)
          VALUES (0, 'Primary', ?, ?)
        `);
        const now = Date.now();
        stmt.run(now, now);
        logger.debug('📡 Created Primary channel with ID 0');
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

    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
    }

    logger.debug('Disconnected from Meshtastic node');
  }

  private startTracerouteScheduler(): void {
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
    logger.debug(`🗺️ Starting traceroute scheduler with ${this.tracerouteIntervalMinutes} minute interval`);

    this.tracerouteInterval = setInterval(async () => {
      if (this.isConnected && this.localNodeInfo) {
        try {
          const targetNode = databaseService.getNodeNeedingTraceroute(this.localNodeInfo.nodeNum);
          if (targetNode) {
            logger.debug(`🗺️ Auto-traceroute: Sending traceroute to ${targetNode.longName || targetNode.nodeId} (${targetNode.nodeId})`);
            await this.sendTraceroute(targetNode.nodeNum, 0);
          } else {
            logger.debug('🗺️ Auto-traceroute: No nodes available for traceroute');
          }
        } catch (error) {
          logger.error('❌ Error in auto-traceroute:', error);
        }
      }
    }, intervalMs);
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

  private startAnnounceScheduler(): void {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    // Check if auto-announce is enabled
    const autoAnnounceEnabled = databaseService.getSetting('autoAnnounceEnabled');
    if (autoAnnounceEnabled !== 'true') {
      logger.debug('📢 Auto-announce is disabled');
      return;
    }

    const intervalHours = parseInt(databaseService.getSetting('autoAnnounceIntervalHours') || '6');
    const intervalMs = intervalHours * 60 * 60 * 1000;

    logger.debug(`📢 Starting announce scheduler with ${intervalHours} hour interval`);

    // Check if announce-on-start is enabled
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

  setAnnounceInterval(hours: number): void {
    if (hours < 3 || hours > 24) {
      throw new Error('Announce interval must be between 3 and 24 hours');
    }

    logger.debug(`📢 Announce interval updated to ${hours} hours`);

    if (this.isConnected) {
      this.startAnnounceScheduler();
    }
  }

  private async processIncomingData(data: Uint8Array): Promise<void> {
    try {
      if (data.length === 0) {
        return;
      }

      logger.debug(`📦 Processing single FromRadio message (${data.length} bytes)...`);

      // Parse single message (using ?all=false approach)
      const parsed = meshtasticProtobufService.parseIncomingData(data);

      if (!parsed) {
        logger.warn('⚠️ Failed to parse message');
        return;
      }

      logger.debug(`📦 Parsed message type: ${parsed.type}`);

      // Process the message
      switch (parsed.type) {
        case 'fromRadio':
          logger.debug('⚠️ Generic FromRadio message (no specific field set)');
          break;
        case 'meshPacket':
          await this.processMeshPacket(parsed.data);
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
          logger.debug('⚙️ Received Config:', JSON.stringify(parsed.data, null, 2));
          // Merge the actual device configuration (don't overwrite)
          this.actualDeviceConfig = { ...this.actualDeviceConfig, ...parsed.data };
          logger.debug('📊 Merged actualDeviceConfig now has:', Object.keys(this.actualDeviceConfig));
          break;
        case 'moduleConfig':
          logger.debug('⚙️ Received Module Config:', JSON.stringify(parsed.data, null, 2));
          // Merge the actual module configuration (don't overwrite)
          this.actualModuleConfig = { ...this.actualModuleConfig, ...parsed.data };
          break;
        case 'channel':
          await this.processChannelProtobuf(parsed.data);
          break;
        case 'configComplete':
          logger.debug('✅ Config complete received, ID:', parsed.data.configCompleteId);
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
            isLocked: false // Allow updates if MyNodeInfo arrives later
          } as any;
          logger.debug(`✅ Restored local node info from settings: ${savedNodeId}`);
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
        isLocked: true  // Lock it to prevent overwrites
      } as any;

      // Update rebootCount in the database since it changes over time
      if (myNodeInfo.rebootCount !== undefined) {
        databaseService.upsertNode({
          nodeNum: nodeNum,
          nodeId: nodeId,
          rebootCount: myNodeInfo.rebootCount
        });
        logger.debug(`📱 Updated rebootCount to ${myNodeInfo.rebootCount} for local device: ${existingNode.longName} (${nodeId})`);
      }

      logger.debug(`📱 Using existing node info for local device: ${existingNode.longName} (${nodeId}) - LOCKED`);
    } else {
      // We don't have real node info yet, store basic info and wait for NodeInfo
      const nodeData = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        hwModel: myNodeInfo.hwModel || 0,
        rebootCount: myNodeInfo.rebootCount !== undefined ? myNodeInfo.rebootCount : undefined,
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
        isLocked: false  // Not locked yet, waiting for complete info
      } as any;

      databaseService.upsertNode(nodeData);
      logger.debug(`📱 Stored basic local node info with rebootCount: ${myNodeInfo.rebootCount}, waiting for NodeInfo for names (${nodeId})`);
    }
  }

  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string; hwModel?: number } | null {
    return this.localNodeInfo;
  }

  /**
   * Get the current device configuration
   */
  getCurrentConfig(): { deviceConfig: any; moduleConfig: any; localNodeInfo: any } {
    return {
      deviceConfig: this.actualDeviceConfig || {},
      moduleConfig: this.actualModuleConfig || {},
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
      downlinkEnabled: channel.settings?.downlinkEnabled
    });

    if (channel.settings) {
      // Only save channels that are actually configured and useful
      const channelName = channel.settings.name || `Channel ${channel.index}`;
      const hasValidConfig = channel.settings.name ||
                            channel.settings.psk ||
                            channel.role === 1 || // PRIMARY role
                            channel.role === 2 || // SECONDARY role
                            channel.index === 0;   // Always include channel 0

      if (hasValidConfig) {
        try {
          // Convert PSK buffer to base64 string if it exists
          let pskString: string | undefined;
          if (channel.settings.psk) {
            pskString = Buffer.from(channel.settings.psk).toString('base64');
          }

          databaseService.upsertChannel({
            id: channel.index,
            name: channelName,
            psk: pskString,
            uplinkEnabled: channel.settings.uplinkEnabled ?? true,
            downlinkEnabled: channel.settings.downlinkEnabled ?? true
          });
          logger.debug(`📡 Saved channel: ${channelName} (role: ${channel.role}, index: ${channel.index}, psk: ${pskString}, uplink: ${channel.settings.uplinkEnabled}, downlink: ${channel.settings.downlinkEnabled})`);
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
  private async processMeshPacket(meshPacket: any): Promise<void> {
    logger.debug(`🔄 Processing MeshPacket: ID=${meshPacket.id}, from=${meshPacket.from}, to=${meshPacket.to}`);

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
        lastHeard: meshPacket.rxTime ? Number(meshPacket.rxTime) : Date.now() / 1000
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
    }

    // Process decoded payload if present
    if (meshPacket.decoded) {
      const portnum = meshPacket.decoded.portnum;
      const payload = meshPacket.decoded.payload;

      logger.debug(`📨 Processing payload: portnum=${portnum} (${meshtasticProtobufService.getPortNumName(portnum)}), payload size=${payload?.length || 0}`);

      if (payload && payload.length > 0) {
        // Use the unified protobuf service to process the payload
        const processedPayload = meshtasticProtobufService.processPayload(portnum, payload);

        switch (portnum) {
          case 1: // TEXT_MESSAGE_APP
            await this.processTextMessageProtobuf(meshPacket, processedPayload as string);
            break;
          case 3: // POSITION_APP
            await this.processPositionMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case 4: // NODEINFO_APP
            await this.processNodeInfoMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case 67: // TELEMETRY_APP
            await this.processTelemetryMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case 5: // ROUTING_APP
            logger.debug('🗺️ Routing message:', processedPayload);
            break;
          case 6: // ADMIN_APP
            await this.processAdminMessage(processedPayload as Uint8Array);
            break;
          case 71: // NEIGHBORINFO_APP
            await this.processNeighborInfoProtobuf(meshPacket, processedPayload as any);
            break;
          case 70: // TRACEROUTE_APP
            await this.processTracerouteMessage(meshPacket, processedPayload as any);
            break;
          default:
            logger.debug(`🤷 Unhandled portnum: ${portnum} (${meshtasticProtobufService.getPortNumName(portnum)})`);
        }
      }
    }
  }

  /**
   * Process text message using protobuf types
   */
  private async processTextMessageProtobuf(meshPacket: any, messageText: string): Promise<void> {
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
        const channelIndex = isDirectMessage ? -1 : (meshPacket.channel !== undefined ? meshPacket.channel : 0);

        // Ensure channel 0 (Primary) exists if this message uses it
        if (!isDirectMessage && channelIndex === 0) {
          const channel0 = databaseService.getChannelById(0);
          if (!channel0) {
            logger.debug('📡 Creating Primary channel (ID 0) for message with channel=0');
            databaseService.upsertChannel({ id: 0, name: 'Primary' });
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

        const message = {
          id: `${fromNum}_${meshPacket.id || Date.now()}`,
          fromNodeNum: fromNum,
          toNodeNum: actualToNum,
          fromNodeId: fromNodeId,
          toNodeId: toNodeId,
          text: messageText,
          channel: channelIndex,
          portnum: 1, // TEXT_MESSAGE_APP
          timestamp: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          rxTime: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          hopStart: hopStart,
          hopLimit: hopLimit,
          replyId: replyId && replyId > 0 ? replyId : undefined,
          emoji: emoji,
          createdAt: Date.now()
        };
        databaseService.insertMessage(message);
        if (isDirectMessage) {
          logger.debug(`💾 Saved direct message from ${message.fromNodeId} to ${message.toNodeId}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
        } else {
          logger.debug(`💾 Saved channel message from ${message.fromNodeId} on channel ${channelIndex}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
        }

        // Auto-acknowledge matching messages
        await this.checkAutoAcknowledge(message, messageText, channelIndex, isDirectMessage, fromNum, meshPacket.id);
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
        const timestamp = position.time ? Number(position.time) * 1000 : Date.now();
        const now = Date.now();

        // Track PKI encryption
        this.trackPKIEncryption(meshPacket, fromNum);

        const nodeData: any = {
          nodeNum: fromNum,
          nodeId: nodeId,
          latitude: coords.latitude,
          longitude: coords.longitude,
          altitude: position.altitude,
          lastHeard: position.time ? Number(position.time) : Date.now() / 1000
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

        // Save position to telemetry table (historical tracking)
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'latitude',
          timestamp, value: coords.latitude, unit: '°', createdAt: now
        });
        databaseService.insertTelemetry({
          nodeId, nodeNum: fromNum, telemetryType: 'longitude',
          timestamp, value: coords.longitude, unit: '°', createdAt: now
        });
        if (position.altitude !== undefined && position.altitude !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'altitude',
            timestamp, value: position.altitude, unit: 'm', createdAt: now
          });
        }

        logger.debug(`🗺️ Updated node position: ${nodeId} -> ${coords.latitude}, ${coords.longitude}`);
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
      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        longName: user.longName,
        shortName: user.shortName,
        hwModel: user.hwModel,
        role: user.role,
        hopsAway: meshPacket.hopsAway,
        lastHeard: timestamp / 1000
      };

      // Capture public key if present
      if (user.publicKey && user.publicKey.length > 0) {
        // Convert Uint8Array to base64 for storage
        nodeData.publicKey = Buffer.from(user.publicKey).toString('base64');
        nodeData.hasPKC = true;
        logger.debug(`🔐 Captured public key for ${nodeId} (${user.longName}): ${nodeData.publicKey.substring(0, 16)}...`);
      }

      // Track if this packet was PKI encrypted (using the helper method)
      this.trackPKIEncryption(meshPacket, fromNum);

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;

        // Save SNR as telemetry if it has changed from the last value
        const latestSnrTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'snr');
        if (!latestSnrTelemetry || latestSnrTelemetry.value !== meshPacket.rxSnr) {
          databaseService.insertTelemetry({
            nodeId,
            nodeNum: fromNum,
            telemetryType: 'snr',
            timestamp,
            value: meshPacket.rxSnr,
            unit: 'dB',
            createdAt: timestamp
          });
          logger.debug(`📊 Saved SNR telemetry: ${meshPacket.rxSnr} dB (changed from ${latestSnrTelemetry?.value || 'N/A'})`);
        }
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      logger.debug(`🔍 Saving node with role=${user.role}, hopsAway=${meshPacket.hopsAway}`);
      databaseService.upsertNode(nodeData);
      logger.debug(`👤 Updated user info: ${user.longName || nodeId}`);
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
      const timestamp = telemetry.time ? Number(telemetry.time) * 1000 : Date.now();
      const now = Date.now();

      // Track PKI encryption
      this.trackPKIEncryption(meshPacket, fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        lastHeard: telemetry.time ? Number(telemetry.time) : Date.now() / 1000
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
            timestamp, value: deviceMetrics.batteryLevel, unit: '%', createdAt: now
          });
        }
        if (deviceMetrics.voltage !== undefined && deviceMetrics.voltage !== null && !isNaN(deviceMetrics.voltage)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'voltage',
            timestamp, value: deviceMetrics.voltage, unit: 'V', createdAt: now
          });
        }
        if (deviceMetrics.channelUtilization !== undefined && deviceMetrics.channelUtilization !== null && !isNaN(deviceMetrics.channelUtilization)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'channelUtilization',
            timestamp, value: deviceMetrics.channelUtilization, unit: '%', createdAt: now
          });
        }
        if (deviceMetrics.airUtilTx !== undefined && deviceMetrics.airUtilTx !== null && !isNaN(deviceMetrics.airUtilTx)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'airUtilTx',
            timestamp, value: deviceMetrics.airUtilTx, unit: '%', createdAt: now
          });
        }
      } else if (telemetry.environmentMetrics) {
        const envMetrics = telemetry.environmentMetrics;
        logger.debug(`🌡️ Environment telemetry: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);

        if (envMetrics.temperature !== undefined && envMetrics.temperature !== null && !isNaN(envMetrics.temperature)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'temperature',
            timestamp, value: envMetrics.temperature, unit: '°C', createdAt: now
          });
        }
        if (envMetrics.relativeHumidity !== undefined && envMetrics.relativeHumidity !== null && !isNaN(envMetrics.relativeHumidity)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'humidity',
            timestamp, value: envMetrics.relativeHumidity, unit: '%', createdAt: now
          });
        }
        if (envMetrics.barometricPressure !== undefined && envMetrics.barometricPressure !== null && !isNaN(envMetrics.barometricPressure)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'pressure',
            timestamp, value: envMetrics.barometricPressure, unit: 'hPa', createdAt: now
          });
        }
      } else if (telemetry.powerMetrics) {
        const powerMetrics = telemetry.powerMetrics;
        logger.debug(`⚡ Power telemetry: ch1_voltage=${powerMetrics.ch1Voltage}V`);

        if (powerMetrics.ch1Voltage !== undefined && powerMetrics.ch1Voltage !== null && !isNaN(powerMetrics.ch1Voltage)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ch1Voltage',
            timestamp, value: powerMetrics.ch1Voltage, unit: 'V', createdAt: now
          });
        }
        if (powerMetrics.ch1Current !== undefined && powerMetrics.ch1Current !== null && !isNaN(powerMetrics.ch1Current)) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ch1Current',
            timestamp, value: powerMetrics.ch1Current, unit: 'mA', createdAt: now
          });
        }
      }

      databaseService.upsertNode(nodeData);
      logger.debug(`📊 Updated node telemetry and saved to telemetry table: ${nodeId}`);
    } catch (error) {
      logger.error('❌ Error processing telemetry message:', error);
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

      logger.debug(`🗺️ Traceroute response from ${fromNodeId}:`, routeDiscovery);

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
      const route = routeDiscovery.route || [];
      const routeBack = routeDiscovery.routeBack || [];
      const snrTowards = routeDiscovery.snrTowards || [];
      const snrBack = routeDiscovery.snrBack || [];

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
          const nodeName = node?.longName || nodeId;
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
          const nodeName = node?.longName || nodeId;
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
        portnum: 70, // TRACEROUTE_APP
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: Date.now()
      };

      databaseService.insertMessage(message);
      logger.debug(`💾 Saved traceroute result from ${fromNodeId} (channel: ${channelIndex})`);

      // Save to traceroutes table
      const tracerouteRecord = {
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        route: JSON.stringify(route),
        routeBack: JSON.stringify(routeBack),
        snrTowards: JSON.stringify(snrTowards),
        snrBack: JSON.stringify(snrBack),
        timestamp: timestamp,
        createdAt: Date.now()
      };

      databaseService.insertTraceroute(tracerouteRecord);
      logger.debug(`💾 Saved traceroute record to traceroutes table`);

      // Calculate and store route segment distances, and estimate positions for nodes without GPS
      try {
        // Build the full route path: toNode -> intermediates -> fromNode
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

            // Store the segment
            const segment = {
              fromNodeNum: node1Num,
              toNodeNum: node2Num,
              fromNodeId: node1Id,
              toNodeId: node2Id,
              distanceKm: distanceKm,
              isRecordHolder: false,
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
        // Process forward route
        this.estimateIntermediatePositions(fullRoute, timestamp);

        // Process return route if it exists
        if (routeBack.length > 0) {
          const fullReturnRoute = [fromNum, ...routeBack, toNum];
          this.estimateIntermediatePositions(fullReturnRoute, timestamp);
        }
      } catch (error) {
        logger.error('❌ Error calculating route segment distances:', error);
      }
    } catch (error) {
      logger.error('❌ Error processing traceroute message:', error);
    }
  }

  /**
   * Estimate positions for nodes in a traceroute path that don't have GPS data
   * by calculating the median (midpoint) between their neighbors
   */
  private estimateIntermediatePositions(routePath: number[], timestamp: number): void {
    try {
      // For each node in the path (excluding endpoints)
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

        // Only estimate if this node lacks position but both neighbors have position
        if (node && (!node.latitude || !node.longitude) &&
            prevNode?.latitude && prevNode?.longitude &&
            nextNode?.latitude && nextNode?.longitude) {

          // Calculate midpoint (median) between the two neighbors
          const estimatedLat = (prevNode.latitude + nextNode.latitude) / 2;
          const estimatedLon = (prevNode.longitude + nextNode.longitude) / 2;

          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const now = Date.now();

          // Store estimated position as telemetry with a special type prefix
          databaseService.insertTelemetry({
            nodeId,
            nodeNum,
            telemetryType: 'estimated_latitude',
            timestamp,
            value: estimatedLat,
            unit: '° (est)',
            createdAt: now
          });

          databaseService.insertTelemetry({
            nodeId,
            nodeNum,
            telemetryType: 'estimated_longitude',
            timestamp,
            value: estimatedLon,
            unit: '° (est)',
            createdAt: now
          });

          logger.debug(`📍 Estimated position for ${nodeId} (${node.longName || nodeId}): ${estimatedLat.toFixed(6)}, ${estimatedLon.toFixed(6)} (midpoint between neighbors)`);
        }
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

      logger.debug(`🏠 Neighbor info from ${fromNodeId}:`, neighborInfo);

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
        logger.debug(`📡 Processing ${neighborInfo.neighbors.length} neighbors from ${fromNodeId}`);

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
            logger.debug(`➕ Created new node ${neighborNodeId} with hopsAway=${senderHopsAway + 1}`);
          }

          // Save the neighbor relationship
          databaseService.saveNeighborInfo({
            nodeNum: fromNum,
            neighborNodeNum: neighborNodeNum,
            snr: neighbor.snr ? Number(neighbor.snr) : undefined,
            lastRxTime: neighbor.lastRxTime ? Number(neighbor.lastRxTime) : undefined,
            timestamp: timestamp
          });

          logger.debug(`🔗 Saved neighbor: ${fromNodeId} -> ${neighborNodeId}, SNR: ${neighbor.snr || 'N/A'}`);
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

      const nodeData: any = {
        nodeNum: Number(nodeInfo.num),
        nodeId: nodeId,
        lastHeard: nodeInfo.lastHeard ? Number(nodeInfo.lastHeard) : Date.now() / 1000,
        snr: nodeInfo.snr,
        rssi: 0, // Will be updated from mesh packet if available
        hopsAway: nodeInfo.hopsAway !== undefined ? nodeInfo.hopsAway : undefined
      };

      // Only set isFavorite from device for NEW nodes (not updates)
      // This preserves user's local favorite settings while honoring device favorites on fresh install
      if (!existingNode && nodeInfo.isFavorite !== undefined) {
        nodeData.isFavorite = nodeInfo.isFavorite;
      }

      // Add user information if available
      if (nodeInfo.user) {
        nodeData.longName = nodeInfo.user.longName;
        nodeData.shortName = nodeInfo.user.shortName;
        nodeData.hwModel = nodeInfo.user.hwModel;
        nodeData.role = nodeInfo.user.role;
      }

      // Add position information if available
      let positionTelemetryData: { timestamp: number; latitude: number; longitude: number; altitude?: number } | null = null;
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

          // Store position telemetry data to be inserted after node is created
          const timestamp = nodeInfo.position.time ? Number(nodeInfo.position.time) * 1000 : Date.now();
          positionTelemetryData = {
            timestamp,
            latitude: coords.latitude,
            longitude: coords.longitude,
            altitude: nodeInfo.position.altitude
          };
        } else {
          logger.warn(`⚠️ Invalid position coordinates for node ${nodeId}: lat=${coords.latitude}, lon=${coords.longitude}. Skipping position save.`);
        }
      }

      // Note: Device telemetry (batteryLevel, voltage, etc.) is NOT saved from NodeInfo packets
      // It is only saved from actual TELEMETRY_APP packets in processTelemetryMessageProtobuf()
      // However, position data IS saved as telemetry for historical tracking

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
      logger.debug(`🏠 Updated node info: ${nodeData.longName || nodeId}`);

      // Now insert position telemetry if we have it (after node exists in database)
      if (positionTelemetryData) {
        const now = Date.now();
        databaseService.insertTelemetry({
          nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'latitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.latitude, unit: '°', createdAt: now
        });
        databaseService.insertTelemetry({
          nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'longitude',
          timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.longitude, unit: '°', createdAt: now
        });
        if (positionTelemetryData.altitude !== undefined && positionTelemetryData.altitude !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: Number(nodeInfo.num), telemetryType: 'altitude',
            timestamp: positionTelemetryData.timestamp, value: positionTelemetryData.altitude, unit: 'm', createdAt: now
          });
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

  private ensurePrimaryChannel(): void {
    logger.debug('🔍 Checking for Primary channel (ID 0)...');
    const channel0 = databaseService.getChannelById(0);
    logger.debug('🔍 getChannelById(0) result:', channel0);
    if (!channel0) {
      logger.debug('📡 Creating Primary channel (ID 0)');
      databaseService.upsertChannel({
        id: 0,
        name: 'Primary'
      });
      logger.debug('✅ Primary channel created');
    } else {
      logger.debug('✅ Primary channel already exists');
    }
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
        if (isDirectMessage) {
          logger.debug('Saved direct message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
        } else {
          logger.debug('Saved channel message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
        }
      } catch (error) {
        logger.error('Failed to save message:', error);
        logger.error('Message data:', message);
      }
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private async processNodeInfo(nodeInfo: any): Promise<void> {
    const nodeData = {
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
      lastHeard: nodeInfo.lastHeard ? Math.floor(nodeInfo.lastHeard) : Math.floor(Date.now() / 1000),
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
    if (this.actualDeviceConfig?.lora || this.actualModuleConfig) {
      logger.debug('Using actualDeviceConfig:', JSON.stringify(this.actualDeviceConfig, null, 2));
      return this.buildDeviceConfigFromActual();
    }

    logger.debug('No device config available yet');
    return null;
  }

  private buildDeviceConfigFromActual(): any {
    const dbChannels = databaseService.getAllChannels();
    const channels = dbChannels.map(ch => ({
      index: ch.id,
      name: ch.name,
      psk: ch.psk ? 'Set' : 'None',
      uplinkEnabled: ch.uplinkEnabled,
      downlinkEnabled: ch.downlinkEnabled
    }));

    const localNode = this.localNodeInfo as any;

    // Extract actual values from stored config or use sensible defaults
    const loraConfig = this.actualDeviceConfig?.lora || {};
    const mqttConfig = this.actualModuleConfig?.mqtt || {};

    logger.debug('🔍 loraConfig being used:', JSON.stringify(loraConfig, null, 2));
    logger.debug('🔍 mqttConfig being used:', JSON.stringify(mqttConfig, null, 2));

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
    const regionValue = typeof loraConfig.region === 'number' ? regionMap[loraConfig.region] || `Unknown (${loraConfig.region})` : loraConfig.region || 'Unknown';
    const modemPresetValue = typeof loraConfig.modemPreset === 'number' ? modemPresetMap[loraConfig.modemPreset] || `Unknown (${loraConfig.modemPreset})` : loraConfig.modemPreset || 'Unknown';

    return {
      basic: {
        nodeAddress: this.config.nodeIp,
        tcpPort: this.config.tcpPort,
        connected: this.isConnected,
        nodeId: localNode?.nodeId || null,
        nodeName: localNode?.longName || null,
        firmwareVersion: localNode?.firmwareVersion || null
      },
      radio: {
        region: regionValue,
        modemPreset: modemPresetValue,
        hopLimit: loraConfig.hopLimit !== undefined ? loraConfig.hopLimit : 'Unknown',
        txPower: loraConfig.txPower !== undefined ? loraConfig.txPower : 'Unknown',
        bandwidth: loraConfig.bandwidth || 'Unknown',
        spreadFactor: loraConfig.spreadFactor || 'Unknown',
        codingRate: loraConfig.codingRate || 'Unknown',
        channelNum: loraConfig.channelNum !== undefined ? loraConfig.channelNum : 'Unknown',
        frequency: 'Unknown',
        txEnabled: loraConfig.txEnabled !== undefined ? loraConfig.txEnabled : 'Unknown',
        sx126xRxBoostedGain: loraConfig.sx126xRxBoostedGain !== undefined ? loraConfig.sx126xRxBoostedGain : 'Unknown',
        configOkToMqtt: loraConfig.configOkToMqtt !== undefined ? loraConfig.configOkToMqtt : 'Unknown'
      },
      mqtt: {
        enabled: mqttConfig.enabled || false,
        server: mqttConfig.address || 'Not configured',
        username: mqttConfig.username || 'Not set',
        encryption: mqttConfig.encryptionEnabled || false,
        json: mqttConfig.jsonEnabled || false,
        tls: mqttConfig.tlsEnabled || false,
        rootTopic: mqttConfig.root || 'msh'
      },
      channels: channels.length > 0 ? channels : [
        { index: 0, name: 'Primary', psk: 'None', uplinkEnabled: true, downlinkEnabled: true }
      ]
    };
  }


  async sendTextMessage(text: string, channel: number = 0, destination?: number, replyId?: number, emoji?: number): Promise<number> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      // Use the new protobuf service to create a proper text message
      const { data: textMessageData, messageId } = meshtasticProtobufService.createTextMessage(text, destination, channel, replyId, emoji);

      await this.transport.send(textMessageData);

      // Log message sending at INFO level for production visibility
      const destinationInfo = destination ? `node !${destination.toString(16).padStart(8, '0')}` : `channel ${channel}`;
      logger.info(`📤 Sent message to ${destinationInfo}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (ID: ${messageId})`);
      logger.debug('Message sent successfully:', text, 'with ID:', messageId);

      // Save sent message to database for UI display
      const localNodeNum = databaseService.getSetting('localNodeNum');
      const localNodeId = databaseService.getSetting('localNodeId');

      if (localNodeNum && localNodeId) {
        const toNodeId = destination ? `!${destination.toString(16).padStart(8, '0')}` : 'broadcast';

        const message = {
          id: `${localNodeNum}_${messageId}`,
          fromNodeNum: parseInt(localNodeNum),
          toNodeNum: destination || 0xffffffff,
          fromNodeId: localNodeId,
          toNodeId: toNodeId,
          text: text,
          // Use channel -1 for direct messages, otherwise use the actual channel
          channel: destination ? -1 : channel,
          portnum: 1, // TEXT_MESSAGE_APP
          timestamp: Date.now(),
          rxTime: Date.now(),
          hopStart: undefined,
          hopLimit: undefined,
          replyId: replyId || undefined,
          emoji: emoji || undefined,
          createdAt: Date.now()
        };

        databaseService.insertMessage(message);
        logger.debug(`💾 Saved sent message to database: "${text.substring(0, 30)}..."`);
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

    try {
      const tracerouteData = meshtasticProtobufService.createTracerouteMessage(destination, channel);

      await this.transport.send(tracerouteData);

      databaseService.recordTracerouteRequest(destination);
      logger.debug(`Traceroute request sent to node: !${destination.toString(16).padStart(8, '0')}`);
    } catch (error) {
      logger.error('Error sending traceroute:', error);
      throw error;
    }
  }

  /**
   * Check if message matches auto-acknowledge pattern and send automated reply
   */
  private async checkAutoAcknowledge(message: any, messageText: string, channelIndex: number, isDirectMessage: boolean, fromNum: number, packetId?: number): Promise<void> {
    try {
      // Get auto-acknowledge settings from database
      const autoAckEnabled = databaseService.getSetting('autoAckEnabled');
      const autoAckRegex = databaseService.getSetting('autoAckRegex');

      // Skip if auto-acknowledge is disabled
      if (autoAckEnabled !== 'true') {
        return;
      }

      // Skip messages from our own locally connected node
      const localNodeNum = databaseService.getSetting('localNodeNum');
      if (localNodeNum && parseInt(localNodeNum) === fromNum) {
        logger.debug('⏭️  Skipping auto-acknowledge for message from local node');
        return;
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
      const hopsTraveled = message.hopStart !== null && message.hopLimit !== null
        ? message.hopStart - message.hopLimit
        : 0;

      // Format timestamp in local timezone (from TZ environment variable)
      const env = getEnvironmentConfig();
      const receivedTime = new Date(message.timestamp).toLocaleString('en-US', { timeZone: env.timezone });

      // Create auto-acknowledge message with robot emoji
      const ackText = `🤖 Copy, ${hopsTraveled} hops at ${receivedTime}`;

      // Send reply on same channel or as direct message
      const destination = isDirectMessage ? fromNum : undefined;
      const channel = isDirectMessage ? 0 : channelIndex;

      logger.debug(`🤖 Auto-acknowledging message from ${message.fromNodeId}: "${messageText}" with "${ackText}"`);

      await this.sendTextMessage(ackText, channel, destination, packetId);
    } catch (error) {
      logger.error('❌ Error in auto-acknowledge:', error);
    }
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
    } catch (error) {
      logger.error('❌ Error sending auto-announcement:', error);
    }
  }

  private async replaceAnnouncementTokens(message: string): Promise<string> {
    let result = message;

    // {VERSION} - MeshMonitor version
    if (result.includes('{VERSION}')) {
      result = result.replace(/{VERSION}/g, packageJson.version);
    }

    // {DURATION} - Uptime
    if (result.includes('{DURATION}')) {
      const uptimeMs = Date.now() - this.serverStartTime;
      const duration = this.formatDuration(uptimeMs);
      result = result.replace(/{DURATION}/g, duration);
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

      result = result.replace(/{FEATURES}/g, features.join(' '));
    }

    // {NODECOUNT} - Active nodes based on maxNodeAgeHours setting
    if (result.includes('{NODECOUNT}')) {
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
      logger.info(`📢 Token replacement - NODECOUNT: ${nodes.length} active nodes (maxNodeAgeHours: ${maxNodeAgeHours})`);
      result = result.replace(/{NODECOUNT}/g, nodes.length.toString());
    }

    // {DIRECTCOUNT} - Direct nodes (0 hops) from active nodes
    if (result.includes('{DIRECTCOUNT}')) {
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const nodes = databaseService.getActiveNodes(maxNodeAgeDays);
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;
      logger.info(`📢 Token replacement - DIRECTCOUNT: ${directCount} direct nodes out of ${nodes.length} active nodes`);
      result = result.replace(/{DIRECTCOUNT}/g, directCount.toString());
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
   */
  private async processAdminMessage(payload: Uint8Array): Promise<void> {
    try {
      logger.debug('⚙️ Processing ADMIN_APP message, payload size:', payload.length);
      const adminMsg = protobufService.decodeAdminMessage(payload);
      if (!adminMsg) {
        logger.error('⚙️ Failed to decode admin message');
        return;
      }

      logger.debug('⚙️ Decoded admin message keys:', Object.keys(adminMsg));

      // Extract session passkey if present
      if (adminMsg.sessionPasskey && adminMsg.sessionPasskey.length > 0) {
        this.sessionPasskey = new Uint8Array(adminMsg.sessionPasskey);
        this.sessionPasskeyExpiry = Date.now() + (290 * 1000); // 290 seconds (10 second buffer before 300s expiry)
        logger.debug('🔑 Session passkey received and stored (expires in 290 seconds)');
      }

      // Log the response type for debugging
      if (adminMsg.getConfigResponse) {
        logger.debug('⚙️ Received GetConfigResponse (session key)');
      }
      if (adminMsg.getOwnerResponse) {
        logger.debug('⚙️ Received GetOwnerResponse');
      }
    } catch (error) {
      logger.error('❌ Error processing admin message:', error);
    }
  }

  /**
   * Check if current session passkey is valid
   */
  private isSessionPasskeyValid(): boolean {
    if (!this.sessionPasskey || !this.sessionPasskeyExpiry) {
      return false;
    }
    return Date.now() < this.sessionPasskeyExpiry;
  }

  /**
   * Request session passkey from the device
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
      await new Promise(resolve => setTimeout(resolve, 3000));

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
   * Set position configuration (broadcast intervals, etc.)
   */
  async setPositionConfig(config: any): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      // Extract position data if provided
      const { latitude, longitude, altitude, ...positionConfig } = config;

      // Per Meshtastic docs: Set fixed position coordinates FIRST, THEN set fixedPosition flag
      // If lat/long provided, send position update first
      if (latitude !== undefined && longitude !== undefined) {
        logger.debug(`⚙️ Setting fixed position coordinates FIRST: lat=${latitude}, lon=${longitude}, alt=${altitude || 0}`);
        const setPositionMsg = protobufService.createSetFixedPositionMessage(
          latitude,
          longitude,
          altitude || 0,
          new Uint8Array()
        );
        const positionPacket = protobufService.createAdminPacket(setPositionMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

        await this.transport.send(positionPacket);
        logger.debug('⚙️ Sent set_fixed_position admin message');

        // Add delay to ensure device processes the position before the config
        await new Promise(resolve => setTimeout(resolve, 1000));
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
   * Set node owner (long name and short name)
   */
  async setNodeOwner(longName: string, shortName: string): Promise<void> {
    if (!this.isConnected || !this.transport) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Setting node owner: "${longName}" (${shortName})`);
      const setOwnerMsg = protobufService.createSetOwnerMessage(longName, shortName, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setOwnerMsg, this.localNodeInfo?.nodeNum || 0, this.localNodeInfo?.nodeNum);

      await this.transport.send(adminPacket);
      logger.debug('⚙️ Sent set_owner admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error setting node owner:', error);
      throw error;
    }
  }

  getConnectionStatus(): { connected: boolean; nodeIp: string; userDisconnected?: boolean } {
    logger.debug(`🔍 getConnectionStatus called: isConnected=${this.isConnected}, userDisconnected=${this.userDisconnectedState}`);
    return {
      connected: this.isConnected,
      nodeIp: this.config.nodeIp,
      userDisconnected: this.userDisconnectedState
    };
  }

  // Get data from database instead of maintaining in-memory state
  getAllNodes(): DeviceInfo[] {
    const dbNodes = databaseService.getAllNodes();
    if (dbNodes.length > 0) {
      logger.debug('🔍 Sample dbNode from database:', {
        nodeId: dbNodes[0].nodeId,
        longName: dbNodes[0].longName,
        role: dbNodes[0].role,
        hopsAway: dbNodes[0].hopsAway
      });
    }
    return dbNodes.map(node => {
      const deviceInfo: any = {
        nodeNum: node.nodeNum,
        user: {
          id: node.nodeId,
          longName: node.longName || '',
          shortName: node.shortName || '',
          hwModel: node.hwModel
        },
        deviceMetrics: {
          batteryLevel: node.batteryLevel,
          voltage: node.voltage,
          channelUtilization: node.channelUtilization,
          airUtilTx: node.airUtilTx
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

      // Add isFavorite if it exists
      if (node.isFavorite !== null && node.isFavorite !== undefined) {
        deviceInfo.isFavorite = Boolean(node.isFavorite);
      }

      // Add position if coordinates exist
      if (node.latitude && node.longitude) {
        deviceInfo.position = {
          latitude: node.latitude,
          longitude: node.longitude,
          altitude: node.altitude
        };
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
      timestamp: new Date(msg.timestamp),
      hopStart: msg.hopStart,
      hopLimit: msg.hopLimit,
      replyId: msg.replyId,
      emoji: msg.emoji
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
  }

  /**
   * User-initiated disconnect from the node
   * Prevents auto-reconnection until userReconnect() is called
   */
  async userDisconnect(): Promise<void> {
    logger.debug('🔌 User-initiated disconnect requested');
    this.userDisconnectedState = true;

    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch (error) {
        logger.error('Error disconnecting transport:', error);
      }
    }

    this.isConnected = false;

    // Clear any active intervals
    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
    }

    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

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
}

export default new MeshtasticManager();