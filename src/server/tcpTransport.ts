import { Socket } from 'net';
import { EventEmitter } from 'events';
import type { ITransport } from './transports/transport.js';
import { logger } from '../utils/logger.js';

export interface TcpTransportConfig {
  host: string;
  port: number;
}

export class TcpTransport extends EventEmitter implements ITransport {
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
  private lastMessageEmitted: number = 0;  // Last time a complete frame was successfully parsed
  private staleConnectionTimeout: number = 300000; // 5 minutes default (in milliseconds)
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60000; // Check every minute
  private readonly BUFFER_STALE_TIMEOUT_MS = 30000; // 30s: if buffer has data but no frames parsed, reset it

  // Configurable keepalive heartbeat (issues 2609 / 2616).
  // When `heartbeatIntervalMs > 0`, the transport sends a Meshtastic
  // `ToRadio.heartbeat` on a timer. The firmware replies to every heartbeat
  // with a `FromRadio.queueStatus` (local-only, zero radio cost), which arrives
  // back via `handleIncomingData()` and refreshes `lastDataReceived`. This
  // gives us a real bidirectional liveness signal:
  //   - Quiet (CLIENT_MUTE) nodes stay "alive" because the QueueStatus reply
  //     keeps `lastDataReceived` fresh — fixing the original 2609 cycling.
  //   - Truly dead hosts STOP replying within ~30s, so the stale detector trips
  //     in `heartbeatIntervalMs * 3` instead of waiting for the 5-min idle
  //     timeout or the OS-level TCP keepalive (~12 min).
  // We must NOT update `lastDataReceived` from the heartbeat *send* itself —
  // the kernel buffers writes to dead hosts for many minutes, so a "successful"
  // send proves nothing.
  private heartbeatIntervalMs: number = 0;
  private heartbeatPayloadFactory: (() => Uint8Array | Promise<Uint8Array>) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Configurable TCP timing
  private connectTimeoutMs: number = 10000; // 10 second default
  private reconnectInitialDelayMs: number = 1000; // 1 second default
  private reconnectMaxDelayMs: number = 60000; // 60 second default

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

    if (timeoutMs > 0 && timeoutMs < 60000) {
      logger.warn(`⚠️  MESHTASTIC_STALE_CONNECTION_TIMEOUT is very low: ${timeoutMs}ms (${Math.floor(timeoutMs / 1000)}s). Minimum recommended: 60000ms (1 minute). Connection may reconnect too frequently.`);
    }

    logger.debug(`⏱️  Stale connection timeout set to ${timeoutMs}ms (${Math.floor(timeoutMs / 1000 / 60)} minute(s))`);
  }

  /**
   * Set the initial TCP connection timeout in milliseconds
   */
  setConnectTimeout(timeoutMs: number): void {
    this.connectTimeoutMs = timeoutMs;
    logger.debug(`⏱️  TCP connect timeout set to ${timeoutMs}ms`);
  }

  /**
   * Set the reconnect backoff parameters in milliseconds
   */
  setReconnectTiming(initialDelayMs: number, maxDelayMs: number): void {
    this.reconnectInitialDelayMs = initialDelayMs;
    this.reconnectMaxDelayMs = maxDelayMs;
    logger.debug(`⏱️  Reconnect timing: initial=${initialDelayMs}ms, max=${maxDelayMs}ms`);
  }

  /**
   * Configure a keepalive heartbeat (issue 2609).
   *
   * When `intervalMs > 0`, the transport will periodically call `getPayload()`
   * and write the returned bytes to the socket. A successful write also marks
   * the connection as having fresh activity (`lastDataReceived`), which
   * prevents the stale-connection detector from reconnecting quiet nodes that
   * receive little inbound mesh traffic.
   *
   * Pass `intervalMs = 0` to disable the heartbeat. Safe to call before or
   * after `connect()`. If called while connected and the interval changes,
   * the existing timer is replaced.
   *
   * @param intervalMs Heartbeat period in milliseconds (0 disables)
   * @param getPayload Factory returning the raw bytes to write each tick.
   *                   Kept as a callback so the transport never needs to know
   *                   about protobufs or any higher-level framing.
   */
  setHeartbeatInterval(
    intervalMs: number,
    getPayload: () => Uint8Array | Promise<Uint8Array>
  ): void {
    this.heartbeatIntervalMs = intervalMs;
    this.heartbeatPayloadFactory = getPayload;

    // Replace any running timer. If disabled, just stop.
    this.stopHeartbeat();
    if (intervalMs > 0 && this.isConnected) {
      this.startHeartbeat();
    }

    if (intervalMs > 0) {
      logger.debug(`💓 Heartbeat configured: every ${Math.floor(intervalMs / 1000)}s`);
    } else {
      logger.debug('💓 Heartbeat disabled');
    }
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
      this.socket.setKeepAlive(true, 300000); // Keep alive every 5 minutes (app-layer health check handles dead connections)
      this.socket.setNoDelay(true); // Disable Nagle's algorithm for low latency

      // Connection timeout
      const connectTimeout = setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
          reject(new Error('Connection timeout'));
        }
      }, this.connectTimeoutMs);

      this.socket.once('connect', () => {
        clearTimeout(connectTimeout);
        this.isConnecting = false;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.buffer = Buffer.alloc(0); // Reset buffer on new connection

        // Initialize timestamps
        this.lastDataReceived = Date.now();
        this.lastMessageEmitted = Date.now();

        // Start stale connection monitoring
        this.startHealthCheck();

        // Start keepalive heartbeat if configured (issue 2609)
        if (this.heartbeatIntervalMs > 0 && this.heartbeatPayloadFactory) {
          this.startHeartbeat();
        }

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

        // Stop heartbeat on disconnect; it will be restarted on the next connect
        this.stopHeartbeat();

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

    // Exponential backoff: initialDelay * 2^(attempts-1), capped at maxDelay
    const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * this.reconnectInitialDelayMs, this.reconnectMaxDelayMs);

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
    // Stop keepalive heartbeat
    this.stopHeartbeat();

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

      // Handle TCP backpressure: if the kernel buffer is full, socket.write()
      // returns false and we must wait for 'drain' before sending more data.
      // Without this, rapid writes overwhelm WiFi-connected devices (#2474).
      const canContinue = this.socket.write(packet, (error) => {
        if (error) {
          logger.error('❌ Failed to send data:', error.message);
          reject(error);
        }
      });

      if (canContinue) {
        logger.debug(`📤 Sent ${data.length} bytes`);
        resolve();
      } else {
        logger.debug(`📤 Sent ${data.length} bytes (waiting for drain)`);
        this.socket.once('drain', () => {
          logger.debug('📤 TCP drain — write buffer cleared');
          resolve();
        });
      }
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

      // Emit the message and track last successful parse
      this.lastMessageEmitted = Date.now();
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
   * Start periodic health check for stale connections.
   *
   * When the heartbeat is active, the firmware sends back a `queueStatus` for
   * every heartbeat we send, so a healthy node refreshes `lastDataReceived` at
   * least every `heartbeatIntervalMs`. We can therefore poll on a much faster
   * cadence and trip the stale detector in `heartbeatIntervalMs * 3` rather
   * than waiting for the default 5-minute idle timeout.
   */
  private startHealthCheck(): void {
    // Don't start if timeout is disabled
    if (this.staleConnectionTimeout === 0 && this.heartbeatIntervalMs === 0) {
      logger.debug('⏱️  Stale connection detection disabled (timeout = 0)');
      return;
    }

    // Stop any existing interval
    this.stopHealthCheck();

    // When heartbeat is active, check at half the heartbeat interval so we
    // detect a missed reply within ~1.5 heartbeat intervals.
    const checkInterval = this.heartbeatIntervalMs > 0
      ? Math.max(5000, Math.floor(this.heartbeatIntervalMs / 2))
      : this.HEALTH_CHECK_INTERVAL_MS;

    this.healthCheckInterval = setInterval(() => {
      this.checkConnection();
    }, checkInterval);

    const effectiveTimeoutMs = this.heartbeatIntervalMs > 0
      ? this.heartbeatIntervalMs * 3
      : this.staleConnectionTimeout;
    logger.debug(`⏱️  Stale connection monitoring started (effective timeout: ${Math.floor(effectiveTimeoutMs / 1000)}s, check interval: ${checkInterval / 1000}s, heartbeat: ${this.heartbeatIntervalMs > 0 ? `${this.heartbeatIntervalMs / 1000}s` : 'off'})`);
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
   * Start the keepalive heartbeat timer. No-op if heartbeat is not configured,
   * the transport is not connected, or a timer is already running (idempotent).
   *
   * Each tick: build the payload via the configured factory, send it, and on
   * success mark `lastDataReceived` so the stale-connection detector treats
   * the successful write as a liveness signal (issue 2609). If the send fails,
   * the socket 'error'/'close' handlers take over and reconnect normally.
   */
  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0 || !this.heartbeatPayloadFactory) {
      return;
    }
    if (this.heartbeatTimer) {
      // Already running — don't stack timers
      return;
    }
    if (!this.isConnected) {
      // Will be started by the 'connect' handler when we're actually online
      return;
    }

    this.heartbeatTimer = setInterval(async () => {
      if (!this.isConnected || !this.heartbeatPayloadFactory) {
        return;
      }
      try {
        const payload = await this.heartbeatPayloadFactory();
        await this.send(payload);
        // DO NOT touch lastDataReceived here. socket.write() to a dead host
        // succeeds for many minutes (kernel buffer), so updating
        // lastDataReceived on send would mask dead hosts. Liveness comes from
        // the firmware's `FromRadio.queueStatus` reply, which is received via
        // handleIncomingData() and refreshes lastDataReceived naturally.
        logger.debug(`💓 Heartbeat sent (${payload.length} bytes)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`💔 Heartbeat send failed: ${msg}`);
      }
    }, this.heartbeatIntervalMs);

    logger.debug(`💓 Heartbeat started: every ${Math.floor(this.heartbeatIntervalMs / 1000)}s`);
  }

  /**
   * Stop the keepalive heartbeat timer. Safe to call when not running.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logger.debug('💓 Heartbeat stopped');
    }
  }

  /**
   * Check if connection has become stale (no data received for too long).
   *
   * If a heartbeat is configured, the effective timeout is `heartbeatIntervalMs * 3`
   * because the firmware replies to every heartbeat with a `FromRadio.queueStatus`.
   * Missing three consecutive replies means the node is dead.
   */
  private checkConnection(): void {
    if (!this.isConnected) {
      return; // Not connected, nothing to check
    }

    // Effective timeout: 3x heartbeat interval when heartbeat is on, otherwise
    // the user-configured idle timeout.
    const effectiveTimeoutMs = this.heartbeatIntervalMs > 0
      ? this.heartbeatIntervalMs * 3
      : this.staleConnectionTimeout;

    if (effectiveTimeoutMs === 0) {
      return; // Timeout disabled
    }

    const now = Date.now();
    const timeSinceLastData = now - this.lastDataReceived;

    if (timeSinceLastData > effectiveTimeoutMs) {
      const secondsSinceLastData = Math.floor(timeSinceLastData / 1000);
      const timeoutSeconds = Math.floor(effectiveTimeoutMs / 1000);

      logger.warn(`⚠️  Stale connection detected: No data received for ${secondsSinceLastData}s (timeout: ${timeoutSeconds}s${this.heartbeatIntervalMs > 0 ? ', heartbeat active' : ''}). Forcing reconnection...`);

      // Emit a custom event for stale connection
      this.emit('stale-connection', { timeSinceLastData, timeout: effectiveTimeoutMs });

      // Force reconnection by destroying the socket
      if (this.socket) {
        this.socket.destroy();
      }
      return;
    }

    // Phantom connection detection: data arrives but no complete frames are parsed.
    // This happens when a corrupted byte shifts frame alignment — the parser waits
    // forever for a "phantom frame" while real data piles up unparsed. The connection
    // looks alive (lastDataReceived updates) but no messages reach the application.
    // Common with USB serial bridges that can inject noise bytes.
    const timeSinceLastMessage = now - this.lastMessageEmitted;
    if (this.buffer.length > 0 && timeSinceLastMessage > this.BUFFER_STALE_TIMEOUT_MS) {
      logger.warn(`⚠️  Stale buffer detected: ${this.buffer.length} bytes buffered but no complete frame parsed for ${Math.floor(timeSinceLastMessage / 1000)}s. Resetting buffer to recover frame alignment.`);
      this.buffer = Buffer.alloc(0);
    } else if (timeSinceLastMessage > this.staleConnectionTimeout) {
      // Data is arriving (lastDataReceived is fresh) but no messages are being parsed
      // even after buffer reset — force reconnect
      logger.warn(`⚠️  Phantom connection detected: Data arriving but no messages parsed for ${Math.floor(timeSinceLastMessage / 1000 / 60)} minute(s). Forcing reconnection...`);
      this.emit('stale-connection', { timeSinceLastData: timeSinceLastMessage, timeout: this.staleConnectionTimeout });
      if (this.socket) {
        this.socket.destroy();
      }
      return;
    }

    // Log periodic health check status at debug level
    const minutesSinceLastData = Math.floor(timeSinceLastData / 1000 / 60);
    logger.debug(`💓 Connection health check: Last data received ${minutesSinceLastData} minute(s) ago, last message parsed ${Math.floor(timeSinceLastMessage / 1000)}s ago`);
  }
}
