import { Server, Socket } from 'net';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService from './protobufService.js';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

export interface VirtualNodeConfig {
  port: number;
  meshtasticManager: MeshtasticManager;
  allowAdminCommands?: boolean; // Allow admin commands through virtual node (default: false for security)
}

interface ConnectedClient {
  socket: Socket;
  id: string;
  buffer: Buffer;
  connectedAt: Date;
  lastActivity: Date;
}

interface QueuedMessage {
  clientId: string;
  data: Uint8Array;
  timestamp: Date;
}

/**
 * Virtual Node Server
 *
 * Acts as a virtual Meshtastic node, allowing multiple mobile apps to connect
 * simultaneously. Serves cached data from the database and queues outgoing
 * messages to the physical node.
 *
 * Features:
 * - Multi-client TCP server on configurable port
 * - Serves cached node/channel/config data from database
 * - Queues and serializes outbound messages to physical node
 * - Blocks admin commands and config changes (security)
 * - Broadcasts incoming messages to all connected clients
 */
export class VirtualNodeServer extends EventEmitter {
  private config: VirtualNodeConfig;
  private allowAdminCommands: boolean;
  private server: Server | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue = false;
  private nextClientId = 1;
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Protocol constants (same as Meshtastic TCP)
  private readonly START1 = 0x94;
  private readonly START2 = 0xc3;
  private readonly MAX_PACKET_SIZE = 512;
  private readonly QUEUE_MAX_SIZE = 100;

  // Config replay constants
  private readonly LOG_EVERY_N_MESSAGES = 10; // Log progress every N messages during config replay

  // Client timeout and cleanup constants
  private readonly CLIENT_TIMEOUT_MS = 300000; // 5 minutes of inactivity before disconnect
  private readonly CLEANUP_INTERVAL_MS = 60000; // Check for inactive clients every minute

  // Admin portnums to block (security)
  private readonly BLOCKED_PORTNUMS = [
    6,   // ADMIN_APP
    8,   // NODEINFO_APP (can trigger config changes)
  ];

  constructor(config: VirtualNodeConfig) {
    super();
    this.config = config;
    this.allowAdminCommands = config.allowAdminCommands ?? false; // Default to false for security
  }

  /**
   * Check if a connected client is from localhost (container-internal).
   * Localhost clients are trusted (e.g. scripts executed by MeshMonitor itself).
   */
  private isLocalhostClient(client: ConnectedClient): boolean {
    const remoteAddress = client.socket.remoteAddress;
    return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  }

  /**
   * Start the virtual node server
   */
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('Virtual node server already started');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = new Server((socket) => this.handleNewClient(socket));

      this.server.on('error', (error) => {
        logger.error('Virtual node server error:', error);
        this.emit('error', error);
        reject(error);
      });

      this.server.listen(this.config.port, () => {
        logger.info(`🌐 Virtual node server listening on port ${this.config.port}`);

        // Start cleanup timer
        this.cleanupTimer = setInterval(() => {
          this.cleanupInactiveClients();
        }, this.CLEANUP_INTERVAL_MS);

        this.emit('listening');
        resolve();
      });
    });
  }

  /**
   * Stop the virtual node server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Disconnect all clients
    for (const client of this.clients.values()) {
      client.socket.destroy();
    }
    this.clients.clear();

    // Close server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('🛑 Virtual node server stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle new client connection
   */
  private handleNewClient(socket: Socket): void {
    const clientId = `vn-${this.nextClientId++}`;
    const now = new Date();
    const client: ConnectedClient = {
      socket,
      id: clientId,
      buffer: Buffer.alloc(0),
      connectedAt: now,
      lastActivity: now,
    };

    this.clients.set(clientId, client);
    logger.info(`📱 Virtual node client connected: ${clientId} (${this.clients.size} total)`);

    // Audit log the connection
    try {
      databaseService.auditLog(
        null, // system event
        'virtual_node_connect',
        'virtual_node',
        JSON.stringify({ clientId, ip: socket.remoteAddress || 'unknown' }),
        socket.remoteAddress || null
      );
    } catch (error) {
      logger.error('Failed to audit log virtual node connection:', error);
    }

    socket.on('data', (data: Buffer) => this.handleClientData(clientId, data));
    socket.on('close', () => this.handleClientDisconnect(clientId));
    socket.on('error', (error) => {
      logger.error(`Virtual node client ${clientId} error:`, error.message);
      this.handleClientDisconnect(clientId);
    });

    // Client will request config via wantConfigId message
    // We wait for their request instead of sending unsolicited config

    this.emit('client-connected', clientId);
  }

  /**
   * Handle client disconnect
   */
  private handleClientDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.clients.delete(clientId);
      logger.info(`📱 Virtual node client disconnected: ${clientId} (${this.clients.size} remaining)`);

      // Audit log the disconnection
      try {
        databaseService.auditLog(
          null, // system event
          'virtual_node_disconnect',
          'virtual_node',
          JSON.stringify({ clientId, ip: client.socket.remoteAddress || 'unknown' }),
          client.socket.remoteAddress || null
        );
      } catch (error) {
        logger.error('Failed to audit log virtual node disconnection:', error);
      }

      this.emit('client-disconnected', clientId);
    }
  }

  /**
   * Handle data from client
   */
  private handleClientData(clientId: string, data: Buffer): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    // Update last activity timestamp
    client.lastActivity = new Date();

    // Append to client's buffer
    client.buffer = Buffer.concat([client.buffer, data]);

    // Process all complete frames
    while (client.buffer.length >= 4) {
      const result = this.parseFrame(client.buffer);

      if (result.type === 'incomplete') {
        // Wait for more data
        break;
      }

      if (result.type === 'invalid') {
        // Skip invalid data
        client.buffer = result.remaining;
        continue;
      }

      if (result.type === 'complete') {
        // Process the message
        this.handleClientMessage(clientId, result.payload);
        client.buffer = result.remaining;
      }
    }
  }

  /**
   * Parse a frame from the buffer
   */
  private parseFrame(buffer: Buffer):
    | { type: 'incomplete' }
    | { type: 'invalid'; remaining: Buffer }
    | { type: 'complete'; payload: Uint8Array; remaining: Buffer } {

    // Look for frame start
    const startIndex = this.findFrameStart(buffer);

    if (startIndex === -1) {
      // No valid frame start found
      return { type: 'invalid', remaining: Buffer.alloc(0) };
    }

    // Remove data before frame start
    if (startIndex > 0) {
      buffer = buffer.subarray(startIndex);
    }

    // Need at least 4 bytes for header
    if (buffer.length < 4) {
      return { type: 'incomplete' };
    }

    // Read length from header
    const lengthMSB = buffer[2];
    const lengthLSB = buffer[3];
    const payloadLength = (lengthMSB << 8) | lengthLSB;

    // Validate payload length
    if (payloadLength > this.MAX_PACKET_SIZE) {
      logger.warn(`Invalid payload length ${payloadLength}, skipping frame`);
      return { type: 'invalid', remaining: buffer.subarray(1) };
    }

    // Wait for complete frame
    const frameLength = 4 + payloadLength;
    if (buffer.length < frameLength) {
      return { type: 'incomplete' };
    }

    // Extract payload
    const payload = new Uint8Array(buffer.subarray(4, frameLength));
    const remaining = buffer.subarray(frameLength);

    return { type: 'complete', payload, remaining };
  }

  /**
   * Find frame start marker in buffer
   */
  private findFrameStart(buffer: Buffer): number {
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === this.START1 && buffer[i + 1] === this.START2) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Handle parsed message from client
   */
  private async handleClientMessage(clientId: string, payload: Uint8Array): Promise<void> {
    try {
      logger.info(`Virtual node: Received ${payload.length} bytes from ${clientId}`);

      // Parse the ToRadio message
      const toRadio = await meshtasticProtobufService.parseToRadio(payload);

      if (!toRadio) {
        logger.warn(`Virtual node: Unable to parse message from ${clientId}`);
        return;
      }

      logger.info(`Virtual node: Parsed message from ${clientId}:`, JSON.stringify(toRadio, null, 2));

      // Handle different message types
      if (toRadio.packet) {
        // Check if this is a blocked portnum (admin commands)
        const portnum = toRadio.packet.decoded?.portnum;
        // Normalize portnum to handle both string and number enum values
        const normalizedPortNum = meshtasticProtobufService.normalizePortNum(portnum);
        const isSelfAddressed = toRadio.packet.from === toRadio.packet.to;

        // Only enforce blocking if allowAdminCommands is false (default)
        if (!this.allowAdminCommands && normalizedPortNum && this.BLOCKED_PORTNUMS.includes(normalizedPortNum)) {
          // Universal check: block addContact from ALL clients (including localhost)
          // addContact can corrupt the physical node's PKI key store (fixes #1487)
          if (normalizedPortNum === 6) { // ADMIN_APP
            const adminPayloadForContactCheck = toRadio.packet.decoded?.payload;
            if (adminPayloadForContactCheck) {
              try {
                const adminMsg = protobufService.decodeAdminMessage(
                  adminPayloadForContactCheck instanceof Uint8Array ? adminPayloadForContactCheck : new Uint8Array(adminPayloadForContactCheck)
                );
                if (adminMsg && adminMsg.addContact !== undefined && adminMsg.addContact !== null) {
                  logger.warn(`Virtual node: Blocked addContact admin message from ${clientId} - this would corrupt PKI keys on the physical node`);
                  return;
                }
              } catch (decodeError) {
                // If we can't decode, continue with other checks
                logger.debug(`Virtual node: Could not decode admin message for addContact check, continuing`);
              }
            }
          }

          // Localhost bypass: scripts running inside the container connect through
          // the Virtual Node and need admin command access (fixes #1766)
          const client = this.clients.get(clientId);
          if (client && this.isLocalhostClient(client)) {
            logger.info(`Virtual node: Allowing admin command from localhost client ${clientId} (portnum ${normalizedPortNum}/${meshtasticProtobufService.getPortNumName(normalizedPortNum)})`);
            // Fall through to queue the message
          } else if (isSelfAddressed) {
            // Self-addressed blocked portnum - allow through (self-addressed admin
            // queries like getConfig are safe; addContact was already blocked above)
            logger.debug(`Virtual node: Allowing self-addressed command from ${clientId} (portnum ${normalizedPortNum}/${meshtasticProtobufService.getPortNumName(normalizedPortNum)})`);
          } else {
            // Check if this is a favorite/unfavorite command - these should be intercepted
            // and processed locally to update the database (fixes #1000)
            const adminPayload = toRadio.packet.decoded?.payload;
            if (adminPayload && normalizedPortNum === 6) { // ADMIN_APP
              try {
                const adminMsg = protobufService.decodeAdminMessage(
                  adminPayload instanceof Uint8Array ? adminPayload : new Uint8Array(adminPayload)
                );

                if (adminMsg) {
                  // Handle setFavoriteNode
                  if (adminMsg.setFavoriteNode !== undefined && adminMsg.setFavoriteNode !== null) {
                    const targetNodeNum = Number(adminMsg.setFavoriteNode);
                    logger.info(`⭐ Virtual node: Intercepted setFavoriteNode for node ${targetNodeNum} from ${clientId}`);

                    // Update database
                    databaseService.setNodeFavorite(targetNodeNum, true);
                    logger.debug(`✅ Virtual node: Updated database - node ${targetNodeNum} is now favorite`);

                    // Don't block - let the command through to the physical node
                    // Continue to queueMessage below
                  }
                  // Handle removeFavoriteNode
                  else if (adminMsg.removeFavoriteNode !== undefined && adminMsg.removeFavoriteNode !== null) {
                    const targetNodeNum = Number(adminMsg.removeFavoriteNode);
                    logger.info(`☆ Virtual node: Intercepted removeFavoriteNode for node ${targetNodeNum} from ${clientId}`);

                    // Update database
                    databaseService.setNodeFavorite(targetNodeNum, false);
                    logger.debug(`✅ Virtual node: Updated database - node ${targetNodeNum} is no longer favorite`);

                    // Don't block - let the command through to the physical node
                    // Continue to queueMessage below
                  }
                  else {
                    // Other admin commands - block them
                    logger.warn(`Virtual node: Blocked admin command from ${clientId} (portnum ${normalizedPortNum}/${meshtasticProtobufService.getPortNumName(normalizedPortNum)})`);
                    logger.warn(`Virtual node: Blocked packet details:`, JSON.stringify({
                      from: toRadio.packet.from,
                      to: toRadio.packet.to,
                      wantAck: toRadio.packet.wantAck,
                      portnum: normalizedPortNum,
                      portnumName: meshtasticProtobufService.getPortNumName(normalizedPortNum),
                      originalPortnum: portnum,
                      decoded: toRadio.packet.decoded,
                    }, null, 2));
                    // Silently drop the message
                    return;
                  }
                } else {
                  // Couldn't decode admin message - block it to be safe
                  logger.warn(`Virtual node: Blocked undecodable admin command from ${clientId}`);
                  return;
                }
              } catch (decodeError) {
                // Failed to decode admin message - block it to be safe
                logger.warn(`Virtual node: Failed to decode admin message from ${clientId}, blocking:`, decodeError);
                return;
              }
            } else {
              // Non-admin blocked portnum (like NODEINFO_APP) - block it
              logger.warn(`Virtual node: Blocked admin command from ${clientId} (portnum ${normalizedPortNum}/${meshtasticProtobufService.getPortNumName(normalizedPortNum)})`);
              logger.warn(`Virtual node: Blocked packet details:`, JSON.stringify({
                from: toRadio.packet.from,
                to: toRadio.packet.to,
                wantAck: toRadio.packet.wantAck,
                portnum: normalizedPortNum,
                portnumName: meshtasticProtobufService.getPortNumName(normalizedPortNum),
                originalPortnum: portnum,
                decoded: toRadio.packet.decoded,
              }, null, 2));
              // Silently drop the message
              return;
            }
          }
        } else if (this.allowAdminCommands && normalizedPortNum && this.BLOCKED_PORTNUMS.includes(normalizedPortNum)) {
          // Admin commands are explicitly allowed via configuration
          logger.info(`Virtual node: Allowing admin command from ${clientId} (portnum ${normalizedPortNum}/${meshtasticProtobufService.getPortNumName(normalizedPortNum)}) - VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS=true`);
        }

        // Process the packet locally so it appears in the web UI
        // Create a FromRadio message wrapping this MeshPacket
        try {
          // Fix for issue #626: Android clients send packets with from=0
          // We need to populate the from field for local storage so messages
          // are correctly attributed in the UI (otherwise shows as !00000000)

          let overrideFrom: number | undefined = undefined;

          if (!toRadio.packet.from || toRadio.packet.from === 0 || toRadio.packet.from === '0') {
            const localNodeInfo = this.config.meshtasticManager.getLocalNodeInfo();
            if (localNodeInfo) {
              logger.info(`Virtual node: Populating missing 'from' field for local storage with ${localNodeInfo.nodeId} (${localNodeInfo.nodeNum})`);
              overrideFrom = localNodeInfo.nodeNum;
            } else {
              logger.warn(`Virtual node: Cannot populate 'from' field - local node info not available yet`);
            }
          }

          const fromRadioMessage = await meshtasticProtobufService.createFromRadioWithPacket(toRadio.packet, overrideFrom);
          if (fromRadioMessage) {
            logger.info(`Virtual node: Processing outgoing message locally from ${clientId} (portnum: ${normalizedPortNum}/${meshtasticProtobufService.getPortNumName(normalizedPortNum)})`);
            // Process locally through MeshtasticManager to store in database
            // Pass context to prevent broadcast loop and preserve the packet ID as requestId for ACK matching
            // The packet.id is the client-generated message ID that will be returned in ACK packets
            await this.config.meshtasticManager.processIncomingData(fromRadioMessage, {
              skipVirtualNodeBroadcast: true,
              virtualNodeRequestId: toRadio.packet.id // Preserve for ACK matching
            });
            logger.debug(`Virtual node: Stored outgoing message in database with requestId: ${toRadio.packet.id}`);
          }
        } catch (error) {
          logger.error(`Virtual node: Failed to process outgoing message locally:`, error);
          // Continue anyway - we still want to forward to physical node
        }

        // Queue the message to be sent to the physical node
        // Fix for issue #626: Strip PKI encryption from packets with from=0
        // Android clients send PKI-encrypted packets with from=0, which fail validation
        // at the physical node when relayed through the Virtual Node Server proxy.
        // We strip the PKI encryption so these packets can be processed as non-encrypted messages.
        const strippedPayload = await meshtasticProtobufService.stripPKIEncryption(payload);
        logger.info(`Virtual node: Queueing message from ${clientId} (portnum: ${portnum})`);
        this.queueMessage(clientId, strippedPayload);
      } else if (toRadio.wantConfigId) {
        // Client is requesting config with a specific ID
        logger.info(`Virtual node: Client ${clientId} requesting config with ID ${toRadio.wantConfigId}`);
        await this.sendInitialConfig(clientId, toRadio.wantConfigId);
      } else if (toRadio.heartbeat) {
        // Handle heartbeat locally - don't forward to physical node
        // iOS clients expect a response packet within a timeout window or they disconnect
        // Send a QueueStatus response to keep the connection alive
        logger.debug(`Virtual node: Received heartbeat from ${clientId}, sending QueueStatus response`);
        const queueStatusResponse = await meshtasticProtobufService.createQueueStatus({
          res: 0,
          free: 32,
          maxlen: 32,
          meshPacketId: 0,
        });
        if (queueStatusResponse) {
          await this.sendToClient(clientId, queueStatusResponse);
        }
      } else if (toRadio.disconnect) {
        // Handle disconnect request locally - don't forward to physical node
        logger.info(`Virtual node: Client ${clientId} requested disconnect`);
        // The socket close will be handled by the 'close' event handler
      } else {
        // Forward other message types to physical node only if they require it
        // Log the message type for debugging
        const messageType = Object.keys(toRadio).filter(k => k !== 'payloadVariant' && toRadio[k as keyof typeof toRadio] !== undefined);
        logger.info(`Virtual node: Forwarding message type [${messageType.join(', ')}] from ${clientId} to physical node`);
        this.queueMessage(clientId, payload);
      }
    } catch (error) {
      logger.error(`Virtual node: Error handling message from ${clientId}:`, error);
    }
  }

  /**
   * Queue a message to be sent to the physical node
   */
  private queueMessage(clientId: string, data: Uint8Array): void {
    if (this.messageQueue.length >= this.QUEUE_MAX_SIZE) {
      logger.warn(`Virtual node: Message queue full (${this.QUEUE_MAX_SIZE}), dropping message from ${clientId}`);
      return;
    }

    this.messageQueue.push({
      clientId,
      data,
      timestamp: new Date(),
    });

    logger.info(`Virtual node: Queued message from ${clientId} (queue size: ${this.messageQueue.length})`);

    // Start processing queue if not already
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Process queued messages (one at a time)
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (!message) {
        break;
      }

      try {
        // Forward to physical node via MeshtasticManager
        await this.config.meshtasticManager.sendRawMessage(message.data);
        logger.info(`Virtual node: Forwarded message from ${message.clientId} to physical node`);
      } catch (error) {
        logger.error(`Virtual node: Failed to forward message from ${message.clientId}:`, error);
      }

      // Small delay between messages to avoid overwhelming the physical node
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.isProcessingQueue = false;
  }

  /**
   * Send initial config data to a client using hybrid approach:
   * - Rebuild dynamic data (MyNodeInfo, NodeInfo) from database for freshness
   * - Use cached static data (config, channels, metadata) for performance
   */
  private async sendInitialConfig(clientId: string, configId?: number): Promise<void> {
    logger.info(`Virtual node: Starting to send initial config to ${clientId}${configId ? ` (ID: ${configId})` : ''}`);
    try {
      // Check if config capture is complete before sending anything
      // This prevents sending partial/incomplete config when the radio is restarting
      if (!this.config.meshtasticManager.isInitConfigCaptureComplete()) {
        logger.warn(`Virtual node: Config capture not yet complete, cannot send config to ${clientId}`);
        logger.warn(`Virtual node: Physical node may be restarting - client should retry after initialization completes`);
        return;
      }

      // Get cached init config with type metadata from meshtasticManager
      const cachedMessages = this.config.meshtasticManager.getCachedInitConfig();

      if (cachedMessages.length === 0) {
        logger.warn(`Virtual node: No cached init config available yet, cannot send config to ${clientId}`);
        logger.warn(`Virtual node: Waiting for physical node to complete initialization...`);
        return;
      }

      logger.info(`Virtual node: Using hybrid approach - rebuilding dynamic data from database`);
      let sentCount = 0;

      // === STEP 1: Rebuild and send MyNodeInfo from database ===
      const localNodeInfo = this.config.meshtasticManager.getLocalNodeInfo();
      if (localNodeInfo) {
        logger.debug(`Virtual node: Rebuilding MyNodeInfo for local node ${localNodeInfo.nodeId}`);
        const localNode = databaseService.getNode(localNodeInfo.nodeNum);

        // Try to get firmware version from multiple sources (in order of preference):
        // 1. localNodeInfo (populated from DeviceMetadata)
        // 2. database (populated from DeviceMetadata via processDeviceMetadata)
        // 3. fallback to 2.6.0 (more reasonable than 2.0.0)
        let firmwareVersion = (localNodeInfo as any).firmwareVersion;
        if (!firmwareVersion && localNode?.firmwareVersion) {
          firmwareVersion = localNode.firmwareVersion;
          logger.debug(`Virtual node: Using firmware version from database: ${firmwareVersion}`);
        }
        if (!firmwareVersion) {
          firmwareVersion = '2.6.0';
          logger.debug(`Virtual node: Using fallback firmware version: ${firmwareVersion}`);
        }

        // Append MeshMonitor version suffix to firmware version for Virtual Node identification
        const vnFirmwareVersion = `${firmwareVersion}-MM${packageJson.version}`;

        // Log the node ID being sent to help diagnose identity issues
        logger.info(`Virtual node: Sending MyNodeInfo with nodeNum=${localNodeInfo.nodeNum} (${localNodeInfo.nodeId}) fw=${vnFirmwareVersion} to ${clientId}`);

        const myNodeInfoMessage = await meshtasticProtobufService.createMyNodeInfo({
          myNodeNum: localNodeInfo.nodeNum,
          numBands: 13,
          firmwareVersion: vnFirmwareVersion,
          rebootCount: localNode?.rebootCount || 0,
          bitrate: 17.24,
          messageTimeoutMsec: 300000,
          minAppVersion: 20200,
          maxChannels: 8,
        });

        if (myNodeInfoMessage) {
          await this.sendToClient(clientId, myNodeInfoMessage);
          sentCount++;
          logger.debug(`Virtual node: ✓ Sent fresh MyNodeInfo from database`);
        }
      } else {
        logger.warn(`Virtual node: No local node info available, skipping MyNodeInfo - clients may have incorrect identity!`);
      }

      // === STEP 2: Rebuild and send all NodeInfo entries from database ===
      // Apply activity filtering based on maxNodeAgeHours setting
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const maxNodeAgeDays = maxNodeAgeHours / 24;
      const allNodes = databaseService.getActiveNodes(maxNodeAgeDays);
      logger.debug(`Virtual node: Rebuilding ${allNodes.length} active NodeInfo entries from database (maxNodeAgeHours: ${maxNodeAgeHours})`);

      for (const node of allNodes) {
        // Check if client is still connected
        const client = this.clients.get(clientId);
        if (!client || client.socket.destroyed) {
          logger.warn(`Virtual node: Client ${clientId} disconnected during config replay (sent ${sentCount} messages)`);
          return;
        }

        const nodeInfoMessage = await meshtasticProtobufService.createNodeInfo({
          nodeNum: node.nodeNum,
          user: {
            id: node.nodeId,
            longName: node.longName || 'Unknown',
            shortName: node.shortName || '????',
            hwModel: node.hwModel || 0,
            role: node.role,
            publicKey: node.publicKey,
          },
          position: (node.latitude && node.longitude) ? {
            latitude: node.latitude,
            longitude: node.longitude,
            altitude: node.altitude || 0,
            time: node.lastHeard || Math.floor(Date.now() / 1000),
          } : undefined,
          deviceMetrics: (node.batteryLevel !== undefined || node.voltage !== undefined ||
                         node.channelUtilization !== undefined || node.airUtilTx !== undefined) ? {
            batteryLevel: node.batteryLevel,
            voltage: node.voltage,
            channelUtilization: node.channelUtilization,
            airUtilTx: node.airUtilTx,
          } : undefined,
          snr: node.snr,
          lastHeard: node.lastHeard,
          hopsAway: node.hopsAway,
          viaMqtt: node.viaMqtt ? true : false,
          isFavorite: node.isFavorite ? true : false,
        });

        if (nodeInfoMessage) {
          await this.sendToClient(clientId, nodeInfoMessage);
          sentCount++;

          if (sentCount % this.LOG_EVERY_N_MESSAGES === 0) {
            logger.debug(`Virtual node: Rebuilt NodeInfo ${sentCount - 1}/${allNodes.length} (${node.nodeId})`);
          }
        }
      }

      logger.info(`Virtual node: ✓ Sent ${allNodes.length} fresh NodeInfo entries from database`);

      // === STEP 3: Rebuild and send channels from database ===
      // Channels must be rebuilt from DB rather than sent from cache because the
      // physical radio often sends channels with empty name strings. The Android
      // app renders empty channel names as "Channel NAme", effectively wiping the
      // client's channel database on every container restart.
      // Send ALL 8 channel slots (including disabled ones with role=0) to match
      // what a real Meshtastic device does. The app expects to see all slots so it
      // can properly manage its channel list.
      const dbChannels = await databaseService.getAllChannelsAsync();
      let channelCount = 0;
      for (const ch of dbChannels) {
        const client = this.clients.get(clientId);
        if (!client || client.socket.destroyed) {
          logger.warn(`Virtual node: Client ${clientId} disconnected during channel send (sent ${sentCount} messages)`);
          return;
        }

        const channelMessage = await meshtasticProtobufService.createChannel({
          index: ch.id,
          settings: {
            name: ch.name || '',
            psk: ch.psk ? Buffer.from(ch.psk, 'base64') : undefined,
            uplinkEnabled: ch.uplinkEnabled,
            downlinkEnabled: ch.downlinkEnabled,
          },
          role: ch.role ?? (ch.id === 0 ? 1 : 2),
        });

        if (channelMessage) {
          await this.sendToClient(clientId, channelMessage);
          sentCount++;
          channelCount++;
          logger.debug(`Virtual node: Sent rebuilt channel ${ch.id} (${ch.name || 'unnamed'}) role=${ch.role}`);
        }
      }
      logger.info(`Virtual node: ✓ Sent ${channelCount} channels from database (all slots)`);

      // === STEP 4: Send static config data from cache (config, metadata) ===
      let staticCount = 0;
      for (const message of cachedMessages) {
        // Skip dynamic message types (we already rebuilt those from DB)
        if (message.type === 'myInfo' || message.type === 'nodeInfo') {
          continue;
        }

        // Skip channels (rebuilt from DB in step 3)
        if (message.type === 'channel') {
          continue;
        }

        // Skip configComplete (we'll send a fresh one at the end)
        if (message.type === 'configComplete') {
          continue;
        }

        // Check if client is still connected
        const client = this.clients.get(clientId);
        if (!client || client.socket.destroyed) {
          logger.warn(`Virtual node: Client ${clientId} disconnected during config replay (sent ${sentCount} total messages)`);
          return;
        }

        // For metadata messages, rewrite firmware_version to indicate Virtual Node
        let dataToSend = message.data;
        if (message.type === 'metadata') {
          const rewritten = await meshtasticProtobufService.rewriteMetadataFirmwareVersion(
            message.data,
            `-MM${packageJson.version}`
          );
          if (rewritten) {
            dataToSend = rewritten;
          }
        }

        // Send the cached static message (possibly with modified metadata)
        await this.sendToClient(clientId, dataToSend);
        sentCount++;
        staticCount++;

        if (staticCount % this.LOG_EVERY_N_MESSAGES === 0) {
          logger.debug(`Virtual node: Sent cached ${message.type} message (${staticCount} static messages)`);
        }
      }

      logger.info(`Virtual node: ✓ Sent ${staticCount} cached static messages (config, metadata)`);

      // NOTE: Message history replay was removed in v3.2.6 (issue #1608)
      // Sending cached messages on each reconnection caused problems with clients
      // that don't deduplicate messages, leading to duplicate chats and incorrect
      // hop counts. Clients should rely on real-time message forwarding instead.

      // === STEP 5: Send custom ConfigComplete with client's requested ID ===
      const useConfigId = configId || 1;
      logger.info(`Virtual node: Sending ConfigComplete to ${clientId} with ID ${useConfigId}...`);
      const configComplete = await meshtasticProtobufService.createConfigComplete(useConfigId);
      if (configComplete) {
        await this.sendToClient(clientId, configComplete);
        sentCount++;
        logger.info(`Virtual node: ✓ ConfigComplete sent to ${clientId} (ID: ${useConfigId})`);
      } else {
        logger.error(`Virtual node: Failed to create ConfigComplete message`);
      }

      logger.info(`Virtual node: ✅ Initial config fully sent to ${clientId} (${sentCount} total messages - ${allNodes.length} fresh NodeInfo + ${channelCount} fresh channels + ${staticCount} cached static)`);
    } catch (error) {
      logger.error(`Virtual node: Error sending initial config to ${clientId}:`, error);
    }
  }

  /**
   * Send a message to a specific client
   */
  private async sendToClient(clientId: string, data: Uint8Array): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    // Check if socket is still writable
    if (client.socket.destroyed || !client.socket.writable) {
      logger.debug(`Virtual node: Socket ${clientId} not writable, skipping send`);
      return;
    }

    const frame = this.createFrame(data);
    return new Promise((resolve, reject) => {
      client.socket.write(frame, (error) => {
        if (error) {
          logger.error(`Virtual node: Failed to send to ${clientId}:`, error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Broadcast a message to all connected clients
   */
  public async broadcastToClients(data: Uint8Array): Promise<void> {
    const frame = this.createFrame(data);
    const promises: Promise<void>[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      // Skip clients with destroyed sockets
      if (client.socket.destroyed || !client.socket.writable) {
        logger.debug(`Virtual node: Skipping broadcast to ${clientId} (socket not writable)`);
        continue;
      }

      const promise = new Promise<void>((resolve) => {
        try {
          client.socket.write(frame, (error) => {
            if (error) {
              logger.error(`Virtual node: Failed to broadcast to ${clientId}:`, error.message);
            }
            resolve();
          });
        } catch (error) {
          logger.error(`Virtual node: Exception broadcasting to ${clientId}:`, error);
          resolve();
        }
      });
      promises.push(promise);
    }

    await Promise.all(promises);
    if (this.clients.size > 0) {
      logger.debug(`Virtual node: Broadcasted message to ${promises.length}/${this.clients.size} clients`);
    }
  }

  /**
   * Create a framed message (4-byte header + payload)
   */
  private createFrame(data: Uint8Array): Buffer {
    const length = data.length;
    const header = Buffer.from([
      this.START1,
      this.START2,
      (length >> 8) & 0xff, // MSB
      length & 0xff,         // LSB
    ]);
    return Buffer.concat([header, Buffer.from(data)]);
  }

  /**
   * Clean up inactive clients that haven't sent data within the timeout period
   */
  private cleanupInactiveClients(): void {
    const now = Date.now();
    const clientsToRemove: string[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      const inactiveMs = now - client.lastActivity.getTime();
      if (inactiveMs > this.CLIENT_TIMEOUT_MS) {
        logger.info(`Virtual node: Client ${clientId} inactive for ${Math.floor(inactiveMs / 1000)}s, disconnecting`);
        clientsToRemove.push(clientId);
      }
    }

    // Disconnect inactive clients
    for (const clientId of clientsToRemove) {
      const client = this.clients.get(clientId);
      if (client) {
        client.socket.destroy();
        this.handleClientDisconnect(clientId);
      }
    }
  }

  /**
   * Get connected client count
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Re-send initial config to all connected clients.
   * Called after the physical node reconnects and config capture completes,
   * so clients get fresh channel/config data through the proper sendInitialConfig()
   * flow rather than via raw broadcast (which can cause "Channel Name" bug #1567).
   */
  public async refreshAllClients(): Promise<void> {
    const clientIds = Array.from(this.clients.keys());
    if (clientIds.length === 0) {
      logger.debug('Virtual node: No connected clients to refresh');
      return;
    }

    logger.info(`Virtual node: Refreshing config for ${clientIds.length} connected client(s) after physical node reconnection`);
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && !client.socket.destroyed) {
        try {
          await this.sendInitialConfig(clientId);
          logger.info(`Virtual node: Refreshed config for client ${clientId}`);
        } catch (error) {
          logger.error(`Virtual node: Failed to refresh config for client ${clientId}:`, error);
        }
      }
    }
  }

  /**
   * Get queue size
   */
  public getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Get detailed client information
   */
  public getClientDetails(): Array<{
    id: string;
    ip: string;
    connectedAt: Date;
    lastActivity: Date;
  }> {
    const details: Array<{
      id: string;
      ip: string;
      connectedAt: Date;
      lastActivity: Date;
    }> = [];

    for (const [clientId, client] of this.clients.entries()) {
      details.push({
        id: clientId,
        ip: client.socket.remoteAddress || 'unknown',
        connectedAt: client.connectedAt,
        lastActivity: client.lastActivity,
      });
    }

    return details;
  }

  /**
   * Check if server is running
   */
  public isRunning(): boolean {
    return this.server !== null;
  }
}
