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

  // Protocol constants
  private readonly START1 = 0x94;
  private readonly START2 = 0xc3;
  private readonly MAX_PACKET_SIZE = 512;

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
}
