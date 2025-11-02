import { Server, Socket } from 'net';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

export interface VirtualNodeConfig {
  port: number;
  meshtasticManager: MeshtasticManager;
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
  private readonly CONFIG_COMPLETE_MAX_SIZE = 10; // ConfigComplete messages are typically small (< 10 bytes)
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
        const isSelfAddressed = toRadio.packet.from === toRadio.packet.to;

        if (portnum && this.BLOCKED_PORTNUMS.includes(portnum)) {
          // Allow self-addressed admin commands (device querying itself)
          if (isSelfAddressed) {
            logger.debug(`Virtual node: Allowing self-addressed admin command from ${clientId} (portnum ${portnum})`);
            // Allow this message to be queued and forwarded
          } else {
            // Block admin commands to other devices
            logger.warn(`Virtual node: Blocked admin command from ${clientId} (portnum ${portnum})`);
            logger.warn(`Virtual node: Blocked packet details:`, JSON.stringify({
              from: toRadio.packet.from,
              to: toRadio.packet.to,
              wantAck: toRadio.packet.wantAck,
              portnum: portnum,
              decoded: toRadio.packet.decoded,
            }, null, 2));
            // Silently drop the message
            return;
          }
        }

        // Process the packet locally so it appears in the web UI
        // Create a FromRadio message wrapping this MeshPacket
        try {
          const fromRadioMessage = await meshtasticProtobufService.createFromRadioWithPacket(toRadio.packet);
          if (fromRadioMessage) {
            logger.info(`Virtual node: Processing outgoing message locally from ${clientId} (portnum: ${portnum})`);
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
        logger.info(`Virtual node: Queueing message from ${clientId} (portnum: ${portnum})`);
        this.queueMessage(clientId, payload);
      } else if (toRadio.wantConfigId) {
        // Client is requesting config with a specific ID
        logger.info(`Virtual node: Client ${clientId} requesting config with ID ${toRadio.wantConfigId}`);
        await this.sendInitialConfig(clientId, toRadio.wantConfigId);
      } else {
        // Forward other message types (heartbeats, etc.) to physical node
        logger.info(`Virtual node: Forwarding other message type from ${clientId} to physical node`);
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
   * Send initial config data to a client
   */
  private async sendInitialConfig(clientId: string, configId?: number): Promise<void> {
    logger.info(`Virtual node: Starting to send initial config to ${clientId}${configId ? ` (ID: ${configId})` : ''}`);
    try {
      // Get cached init config from meshtasticManager
      const cachedMessages = this.config.meshtasticManager.getCachedInitConfig();

      if (cachedMessages.length === 0) {
        logger.warn(`Virtual node: No cached init config available yet, cannot send config to ${clientId}`);
        logger.warn(`Virtual node: Waiting for physical node to complete initialization...`);
        return;
      }

      logger.info(`Virtual node: Replaying ${cachedMessages.length} cached init messages to ${clientId}`);

      // Replay all cached messages EXCEPT the last ConfigComplete
      // We'll create a fresh ConfigComplete with the client's requested ID
      let sentCount = 0;

      for (let i = 0; i < cachedMessages.length; i++) {
        const message = cachedMessages[i];

        // Check if this is the last message and it's a ConfigComplete
        // We identify ConfigComplete by checking if it's the last message and small
        const isLikelyConfigComplete = (i === cachedMessages.length - 1) && (message.length < this.CONFIG_COMPLETE_MAX_SIZE);

        if (isLikelyConfigComplete) {
          logger.debug(`Virtual node: Skipping cached ConfigComplete, will send custom one`);
          continue;
        }

        // Check if client is still connected
        const client = this.clients.get(clientId);
        if (!client || client.socket.destroyed) {
          logger.warn(`Virtual node: Client ${clientId} disconnected during config replay (sent ${sentCount}/${cachedMessages.length})`);
          return;
        }

        // Send the cached message directly
        await this.sendToClient(clientId, message);
        sentCount++;

        if (sentCount % this.LOG_EVERY_N_MESSAGES === 0 || i < 5) {
          logger.debug(`Virtual node: Replayed message ${sentCount}/${cachedMessages.length} (${message.length} bytes)`);
        }
      }

      logger.info(`Virtual node: Replayed ${sentCount} cached messages to ${clientId}`);

      // Send custom ConfigComplete with client's requested ID
      const useConfigId = configId || 1;
      logger.info(`Virtual node: Sending ConfigComplete to ${clientId} with ID ${useConfigId}...`);
      const configComplete = await meshtasticProtobufService.createConfigComplete(useConfigId);
      if (configComplete) {
        await this.sendToClient(clientId, configComplete);
        logger.info(`Virtual node: ✓ ConfigComplete sent to ${clientId} (ID: ${useConfigId}) - Initial config fully sent!`);
      } else {
        logger.error(`Virtual node: Failed to create ConfigComplete message`);
      }
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
