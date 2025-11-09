import { Socket } from 'net';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

export interface TcpTransportConfig {
  host: string;
  port: number;
}

export class TcpTransport extends EventEmitter {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnected = false;
  private isConnecting = false;
  private shouldReconnect = true;
  private config: TcpTransportConfig | null = null;

  // Stale connection detection
  private lastDataReceived: number = 0;
  private staleConnectionTimeout: number = 300000; // 5 minutes default (in milliseconds)
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60000; // Check every minute

  // Protocol constants
  private readonly START1 = 0x94;
  private readonly START2 = 0xc3;
  private readonly MAX_PACKET_SIZE = 512;

  /**
   * Set the stale connection timeout in milliseconds
   * @param timeoutMs Timeout in milliseconds (0 to disable)
   */
  setStaleConnectionTimeout(timeoutMs: number): void {
    this.staleConnectionTimeout = timeoutMs;
    logger.debug(`⏱️  Stale connection timeout set to ${timeoutMs}ms (${Math.floor(timeoutMs / 1000 / 60)} minutes)`);
  }

  async connect(host: string, port: number = 4403): Promise<void> {
    if (this.isConnecting || this.isConnected) {
      logger.debug('Already connected or connecting');
      return;
    }

    this.config = { host, port };
    this.shouldReconnect = true;

    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        reject(new Error('No configuration set'));
        return;
      }

      this.isConnecting = true;
      logger.debug(`📡 Connecting to TCP ${this.config.host}:${this.config.port}...`);

      this.socket = new Socket();

      // Set socket options
      this.socket.setKeepAlive(true, 60000); // Keep alive every 60 seconds
      this.socket.setNoDelay(true); // Disable Nagle's algorithm for low latency

      // Connection timeout
      const connectTimeout = setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
          reject(new Error('Connection timeout'));
        }
      }, 10000); // 10 second timeout

      this.socket.once('connect', () => {
        clearTimeout(connectTimeout);
        this.isConnecting = false;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.buffer = Buffer.alloc(0); // Reset buffer on new connection

        // Initialize last data received timestamp
        this.lastDataReceived = Date.now();

        // Start stale connection monitoring
        this.startHealthCheck();

        logger.debug(`✅ TCP connected to ${this.config?.host}:${this.config?.port}`);
        this.emit('connect');
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleIncomingData(data);
      });

      this.socket.on('error', (error: Error) => {
        clearTimeout(connectTimeout);
        logger.error('❌ TCP socket error:', error.message);
        this.emit('error', error);

        if (this.isConnecting) {
          reject(error);
        }
      });

      this.socket.on('close', () => {
        clearTimeout(connectTimeout);
        this.isConnecting = false;
        const wasConnected = this.isConnected;
        this.isConnected = false;

        if (wasConnected) {
          logger.debug('🔌 TCP connection closed');
          this.emit('disconnect');
        }

        // Attempt reconnection if enabled (will retry forever with exponential backoff up to 60s)
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.socket.connect(this.config.port, this.config.host);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped at 60s)
    const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 60000);

    logger.debug(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimeout = setTimeout(() => {
      this.doConnect().catch((error) => {
        logger.error('Reconnection failed:', error.message);
      });
    }, delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Stop stale connection monitoring
    this.stopHealthCheck();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.buffer = Buffer.alloc(0);

    logger.debug('🛑 TCP transport disconnected');
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.isConnected || !this.socket) {
      throw new Error('Not connected to TCP server');
    }

    // Meshtastic TCP protocol: 4-byte header + protobuf payload
    // Header: [START1, START2, LENGTH_MSB, LENGTH_LSB]
    const length = data.length;
    const header = Buffer.from([
      this.START1,
      this.START2,
      (length >> 8) & 0xff, // MSB
      length & 0xff          // LSB
    ]);

    const packet = Buffer.concat([header, Buffer.from(data)]);

    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket is null'));
        return;
      }

      this.socket.write(packet, (error) => {
        if (error) {
          logger.error('❌ Failed to send data:', error.message);
          reject(error);
        } else {
          logger.debug(`📤 Sent ${data.length} bytes`);
          resolve();
        }
      });
    });
  }

  private handleIncomingData(data: Buffer): void {
    // Update last data received timestamp
    this.lastDataReceived = Date.now();

    // Append new data to buffer
    this.buffer = Buffer.concat([this.buffer, data]);

    // Process all complete frames in buffer
    while (this.buffer.length >= 4) {
      // Look for frame start
      const startIndex = this.findFrameStart();

      if (startIndex === -1) {
        // No valid frame start found, log as debug output and clear buffer
        if (this.buffer.length > 0) {
          const debugOutput = this.buffer.toString('utf8', 0, Math.min(this.buffer.length, 100));
          if (debugOutput.trim().length > 0) {
            logger.debug('🐛 Debug output:', debugOutput);
          }
        }
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Remove any data before the frame start
      if (startIndex > 0) {
        const debugOutput = this.buffer.toString('utf8', 0, startIndex);
        if (debugOutput.trim().length > 0) {
          logger.debug('🐛 Debug output:', debugOutput);
        }
        this.buffer = this.buffer.subarray(startIndex);
      }

      // Need at least 4 bytes for header
      if (this.buffer.length < 4) {
        break;
      }

      // Read length from header
      const lengthMSB = this.buffer[2];
      const lengthLSB = this.buffer[3];
      const payloadLength = (lengthMSB << 8) | lengthLSB;

      // Validate payload length
      if (payloadLength > this.MAX_PACKET_SIZE) {
        logger.warn(`⚠️ Invalid payload length ${payloadLength}, searching for next frame`);
        // Skip this header and look for next frame
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      // Wait for complete frame
      const frameLength = 4 + payloadLength;
      if (this.buffer.length < frameLength) {
        // Incomplete frame, wait for more data
        break;
      }

      // Extract payload
      const payload = this.buffer.subarray(4, frameLength);

      logger.debug(`📥 Received frame: ${payloadLength} bytes`);

      // Emit the message
      this.emit('message', new Uint8Array(payload));

      // Remove processed frame from buffer
      this.buffer = this.buffer.subarray(frameLength);
    }
  }

  private findFrameStart(): number {
    // Look for START1 followed by START2
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === this.START1 && this.buffer[i + 1] === this.START2) {
        return i;
      }
    }
    return -1;
  }

  getConnectionState(): boolean {
    return this.isConnected;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Start periodic health check for stale connections
   */
  private startHealthCheck(): void {
    // Don't start if timeout is disabled
    if (this.staleConnectionTimeout === 0) {
      logger.debug('⏱️  Stale connection detection disabled (timeout = 0)');
      return;
    }

    // Stop any existing interval
    this.stopHealthCheck();

    // Start periodic check
    this.healthCheckInterval = setInterval(() => {
      this.checkConnection();
    }, this.HEALTH_CHECK_INTERVAL_MS);

    logger.debug(`⏱️  Stale connection monitoring started (timeout: ${Math.floor(this.staleConnectionTimeout / 1000 / 60)} minutes, check interval: ${this.HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop periodic health check
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.debug('⏱️  Stale connection monitoring stopped');
    }
  }

  /**
   * Check if connection has become stale (no data received for too long)
   */
  private checkConnection(): void {
    if (!this.isConnected) {
      return; // Not connected, nothing to check
    }

    if (this.staleConnectionTimeout === 0) {
      return; // Timeout disabled
    }

    const now = Date.now();
    const timeSinceLastData = now - this.lastDataReceived;

    if (timeSinceLastData > this.staleConnectionTimeout) {
      const minutesSinceLastData = Math.floor(timeSinceLastData / 1000 / 60);
      const timeoutMinutes = Math.floor(this.staleConnectionTimeout / 1000 / 60);

      logger.warn(`⚠️  Stale connection detected: No data received for ${minutesSinceLastData} minutes (timeout: ${timeoutMinutes} minutes). Forcing reconnection...`);

      // Emit a custom event for stale connection
      this.emit('stale-connection', { timeSinceLastData, timeout: this.staleConnectionTimeout });

      // Force reconnection by destroying the socket
      if (this.socket) {
        this.socket.destroy();
      }
    } else {
      // Log periodic health check status at debug level
      const minutesSinceLastData = Math.floor(timeSinceLastData / 1000 / 60);
      logger.debug(`💓 Connection health check: Last data received ${minutesSinceLastData} minute(s) ago`);
    }
  }
}
