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
  // Set once disconnect() has been called. A destroyed transport must never
  // reconnect again — even if a straggler 'close' handler or racing timer
  // calls scheduleReconnect() after teardown. This is the transport-level
  // half of the #3270 orphan-flap fix: once the manager lets go of a
  // transport it can no longer reach, the transport must not resurrect itself.
  // Re-armed to false by the public connect() (an explicit fresh intent).
  private destroyed = false;
  private config: TcpTransportConfig | null = null;

  // Stale connection detection
  private lastDataReceived: number = 0;
  private lastMessageEmitted: number = 0;  // Last time a complete frame was successfully parsed
  private staleConnectionTimeout: number = 300000; // 5 minutes default (in milliseconds)
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60000; // Check every minute

  // Initial-config-sync stall detection (#5122).
  //
  // A reporter watched a node go silent mid-sync and stay that way: no data, no
  // error, no FIN. MeshMonitor's own state read `isConnected=true,
  // configuring=true` for 70+ seconds with zero reconnect attempts, because the
  // only liveness guard is the idle watchdog below — 5 minutes by default, polled
  // once a minute. A sync that stalls is not an idle link: it will never recover
  // on its own, and every second spent waiting is a sync that has to restart
  // from scratch anyway. So while the manager says a sync is running, silence is
  // policed on a much tighter budget.
  private configSyncActive = false;
  private readonly CONFIG_SYNC_STALL_MS = 60000; // 60s of total silence mid-sync
  private readonly CONFIG_SYNC_CHECK_INTERVAL_MS = 15000; // poll 4x faster while syncing
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

  // The in-flight connect timeout, hoisted out of doConnect()'s closure.
  //
  // It used to be a bare local, which meant nothing outside that closure could
  // cancel it. Every path that reclaims a socket calls removeAllListeners()
  // first, so the 'connect'/'error'/'close' handlers that clear the timer are
  // gone by the time the socket dies — leaving a live timer whose callback
  // reads `this.socket`, i.e. whatever socket is current when it eventually
  // fires. On a transport that connects again, that is a healthy, connected
  // socket being destroyed by a stale timer, with no warning logged and an
  // auto-reconnect scheduled right after: exactly the silent client-initiated
  // FIN reported in #5122. Tracking it on the instance lets every teardown
  // path cancel it.
  private connectTimeout: NodeJS.Timeout | null = null;

  // Configurable TCP timing
  private connectTimeoutMs: number = 10000; // 10 second default
  private reconnectInitialDelayMs: number = 1000; // 1 second default
  private reconnectMaxDelayMs: number = 60000; // 60 second default

  // Startup-grace fast reconnect (#3122 follow-up). During the first
  // `startupGraceMs` after this transport is created, scheduleReconnect uses
  // `startupGraceFastDelayMs` instead of the exponential backoff. The reporter
  // observed that a large/fragile TCP node usually closes the *first* config
  // sync session but recovers cleanly on the next attempt — a short fast
  // delay during startup shortens that user-visible "stuck reconnecting" gap
  // without changing steady-state backoff once the session stabilizes.
  private startupGraceUntil: number = 0;
  private startupGraceFastDelayMs: number = 0;

  /**
   * Fast-retry ramp after the link drops mid-config-sync (#5122).
   *
   * The reporter's packet captures show a node that goes silent for ~10s
   * partway through a ~190-node NodeDB dump, flushes a backlog, then closes
   * its own side. The retry then completes the full sync in about 2 seconds —
   * so the recovery is cheap, and it was the 60s reconnect delay, not the
   * failure itself, that made the mesh feel unusable.
   *
   * Retrying fast forever would be the wrong answer though: every reconnect
   * makes the node re-dump its entire NodeDB, which is the very work that is
   * stalling. So this ramps. One quick attempt catches the common case; if
   * that also dies mid-sync, back off rather than hammer a node that has
   * already told us twice it cannot finish.
   *
   * Only a *mid-sync* loss arms this. A node that is simply unreachable never
   * starts a sync, so it keeps the ordinary backoff instead of collecting a
   * SYN every three seconds.
   */
  private static readonly SYNC_LOSS_RETRY_LADDER_MS = [3_000, 10_000, 30_000];
  /** How many rungs of the ladder this transport has spent. Reset on a sync that completes. */
  private syncLossRetryStep = 0;
  /** Set by `noteConfigSyncLoss()`, consumed by the next `scheduleReconnect()`. */
  private syncLossRetryPending = false;

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
   * Mark the initial config sync as running or finished (#5122).
   *
   * Re-arms the health check so the faster sync-phase cadence takes effect
   * immediately rather than at the next minute boundary.
   */
  setConfigSyncActive(active: boolean): void {
    if (this.configSyncActive === active) return;
    this.configSyncActive = active;
    logger.debug(`⏱️  Config-sync stall detection ${active ? 'armed' : 'disarmed'}`);
    if (this.isConnected && this.healthCheckInterval) {
      this.startHealthCheck();
    }
  }

  /**
   * The link dropped while the initial config sync was still running (#5122).
   *
   * Arms one rung of the fast-retry ramp for the reconnect that is about to be
   * scheduled. Deliberately separate from `setConfigSyncActive(false)`, which
   * fires on a *successful* sync too — only a loss should shorten the wait.
   */
  noteConfigSyncLoss(): void {
    this.syncLossRetryPending = true;
  }

  /**
   * A config sync ran to completion — spend the ladder back to the top (#5122).
   *
   * Without this, a source that recovers on the first fast retry and then hits
   * an unrelated mid-sync loss hours later would start from whatever rung it
   * left off on. The ladder is meant to measure consecutive failures, not
   * lifetime ones.
   */
  resetConfigSyncLossRetries(): void {
    this.syncLossRetryStep = 0;
    this.syncLossRetryPending = false;
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
   * Enable a startup-grace fast-reconnect window (#3122 follow-up).
   *
   * For the next `graceMs` from now, reconnect attempts use `fastDelayMs`
   * instead of the exponential backoff. After the window expires, normal
   * backoff resumes automatically. Intended for passive-mode TCP sources
   * where the first session often closes mid-sync but the second session
   * works — without the grace, the user sees a multi-second backoff gap
   * before the recovery attempt.
   *
   * Pass graceMs=0 to disable (the default).
   */
  setStartupGraceReconnect(graceMs: number, fastDelayMs: number): void {
    if (graceMs <= 0) {
      this.startupGraceUntil = 0;
      this.startupGraceFastDelayMs = 0;
      logger.debug('⏱️  Startup-grace reconnect: disabled');
      return;
    }
    this.startupGraceUntil = Date.now() + graceMs;
    this.startupGraceFastDelayMs = fastDelayMs;
    logger.debug(`⏱️  Startup-grace reconnect: ${fastDelayMs}ms delay for next ${graceMs / 1000}s`);
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
    // A fresh explicit connect re-arms a previously torn-down transport.
    this.destroyed = false;

    return this.doConnect();
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  /**
   * Close the current socket and say who did it.
   *
   * Every teardown path has to strip the socket's listeners first, otherwise
   * the 'close' handler treats a deliberate teardown as a lost link and
   * schedules a reconnect. The side effect was that these paths closed the
   * socket in complete silence — no log line, no event — which is why a report
   * like #5122 (a client-initiated FIN with nothing in the application log)
   * could not be attributed to any particular mechanism. Routing all of them
   * through here means every FIN we send has a reason next to it.
   */
  private teardownSocket(reason: string): void {
    this.clearConnectTimeout();
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    // `wasConnected` separates "we hung up on a live link" (which a reader of
    // the log will want to correlate with a FIN in a packet capture) from
    // reclaiming a socket that never came up.
    const wasConnected = this.isConnected;
    try {
      socket.removeAllListeners();
      socket.destroy();
    } catch { /* ignore */ }
    if (wasConnected) {
      logger.info(`🔌 Closing the live TCP connection to ${this.config?.host}:${this.config?.port} — ${reason}`);
    } else {
      logger.debug(`🔌 Discarded a TCP socket that was not connected — ${reason}`);
    }
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        reject(new Error('No configuration set'));
        return;
      }

      // A torn-down transport must never open another socket (#3270).
      if (this.destroyed) {
        reject(new Error('Transport has been disconnected'));
        return;
      }

      // Reclaim any pre-existing socket before opening a new one. Without this
      // a single transport could leak two live sockets at the daemon — the
      // 2:1 "Force close previous TCP connection" fingerprint from #3270.
      this.teardownSocket('reclaimed before a new connect attempt');

      this.isConnecting = true;
      logger.debug(`📡 Connecting to TCP ${this.config.host}:${this.config.port}...`);

      this.socket = new Socket();

      // Set socket options
      this.socket.setKeepAlive(true, 300000); // Keep alive every 5 minutes (app-layer health check handles dead connections)
      this.socket.setNoDelay(true); // Disable Nagle's algorithm for low latency

      // Connection timeout. Bound to THIS attempt's socket, not to whatever
      // `this.socket` happens to be when it fires — a stale timer must never
      // be able to destroy a later, healthy connection (#5122). It is also
      // cancelled by every teardown path, so it cannot outlive its socket.
      const attemptSocket = this.socket;
      this.clearConnectTimeout();
      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null;
        if (this.socket !== attemptSocket) {
          // The attempt this timer belongs to is long gone. Firing here would
          // tear down an unrelated socket.
          logger.debug('⏱️  Ignoring a connect timeout from a superseded attempt');
          return;
        }
        if (!this.isConnecting) {
          // Already connected (or already torn down) — nothing to time out.
          return;
        }
        logger.warn(`⏱️  TCP connect to ${this.config?.host}:${this.config?.port} timed out after ${this.connectTimeoutMs}ms — destroying the socket`);
        attemptSocket.destroy();
        reject(new Error('Connection timeout'));
      }, this.connectTimeoutMs);

      this.socket.once('connect', () => {
        this.clearConnectTimeout();
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
        this.clearConnectTimeout();
        logger.error('❌ TCP socket error:', error.message);
        this.emit('error', error);

        if (this.isConnecting) {
          reject(error);
        }
      });

      this.socket.on('close', () => {
        this.clearConnectTimeout();
        this.isConnecting = false;
        const wasConnected = this.isConnected;
        this.isConnected = false;

        // Stop heartbeat on disconnect; it will be restarted on the next connect
        this.stopHeartbeat();

        if (wasConnected) {
          logger.debug('🔌 TCP connection closed');
          this.emit('disconnect');
        }

        // Attempt reconnection if enabled (will retry forever with exponential backoff up to 60s).
        // Never reconnect once the transport has been torn down (#3270).
        if (this.shouldReconnect && !this.destroyed) {
          this.scheduleReconnect();
        }
      });

      this.socket.connect(this.config.port, this.config.host);
    });
  }

  private scheduleReconnect(): void {
    // Guard against resurrection: a transport torn down via disconnect() must
    // not schedule another connect, no matter who calls this (#3270).
    if (this.destroyed) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;

    // Startup-grace fast reconnect (#3122): if we're still inside the grace
    // window, use the fast delay regardless of attempt count. Outside the
    // window, fall back to exponential backoff.
    const inGrace = this.startupGraceUntil > 0 && Date.now() < this.startupGraceUntil;

    // A mid-sync loss (#5122) is the most specific signal we have about WHY the
    // link went down, so its ramp wins over the startup grace window when both
    // apply. The grace window stays in charge of every other early disconnect.
    const ladder = TcpTransport.SYNC_LOSS_RETRY_LADDER_MS;
    const useSyncLossLadder = this.syncLossRetryPending && this.syncLossRetryStep < ladder.length;
    // Consume the flag either way: it describes the disconnect that just
    // happened, not a standing preference, so it must not leak into the next one.
    this.syncLossRetryPending = false;

    let delay: number;
    let label: string;
    if (useSyncLossLadder) {
      delay = ladder[this.syncLossRetryStep];
      this.syncLossRetryStep++;
      label = `, sync-loss retry ${this.syncLossRetryStep}/${ladder.length}`;
    } else if (inGrace) {
      delay = this.startupGraceFastDelayMs;
      label = ', startup-grace';
    } else {
      delay = Math.min(
        Math.pow(2, this.reconnectAttempts - 1) * this.reconnectInitialDelayMs,
        this.reconnectMaxDelayMs,
      );
      label = '';
    }

    logger.debug(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}${label})...`);

    this.reconnectTimeout = setTimeout(() => {
      this.doConnect().catch((error) => {
        logger.error('Reconnection failed:', error.message);
      });
    }, delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    // Mark torn-down so any late scheduleReconnect()/'close' straggler can't
    // resurrect this transport into a zombie auto-reconnect loop (#3270).
    this.destroyed = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Stop stale connection monitoring
    this.stopHealthCheck();
    // Stop keepalive heartbeat
    this.stopHeartbeat();

    this.teardownSocket('transport.disconnect() was called');

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

    const socket = this.socket;
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error('Socket is null'));
        return;
      }

      // A true return from socket.write() only means that the writable buffer
      // remains below its high-water mark. It does NOT mean that the write
      // completed successfully. Resolving on that boolean caused an async
      // EPIPE from the write callback to be ignored because the Promise had
      // already fulfilled, so the manager could report a restarted
      // meshtasticd as connected after its first protocol write had failed.
      //
      // Completion requires both the write callback and, when backpressure is
      // reported, the drain event. Capturing the socket also prevents a later
      // reconnect from moving the drain listener onto a different generation.
      let settled = false;
      let writeReturned = false;
      let writeCompleted = false;
      let drainCompleted = false;
      let waitingForDrain = false;

      const cleanup = () => {
        if (waitingForDrain) socket.off('drain', onDrain);
      };

      const maybeResolve = () => {
        if (settled || !writeReturned || !writeCompleted || !drainCompleted) return;
        settled = true;
        cleanup();
        logger.debug(`📤 Sent ${data.length} bytes`);
        resolve();
      };

      const onDrain = () => {
        drainCompleted = true;
        logger.debug('📤 TCP drain — write buffer cleared');
        maybeResolve();
      };

      const canContinue = socket.write(packet, (error) => {
        if (error) {
          if (settled) return;
          settled = true;
          cleanup();
          logger.error('❌ Failed to send data:', error.message);
          reject(error);
          return;
        }
        writeCompleted = true;
        maybeResolve();
      });

      writeReturned = true;
      if (settled) return;

      drainCompleted = canContinue;
      if (!canContinue) {
        waitingForDrain = true;
        logger.debug(`📤 Queued ${data.length} bytes (waiting for drain)`);
        socket.once('drain', onDrain);
      }
      maybeResolve();
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
    const baseInterval = this.heartbeatIntervalMs > 0
      ? Math.max(5000, Math.floor(this.heartbeatIntervalMs / 2))
      : this.HEALTH_CHECK_INTERVAL_MS;
    // A 60s stall budget polled once a minute would take up to two minutes to
    // notice. Poll faster while syncing so detection lands close to the budget.
    const checkInterval = this.configSyncActive
      ? Math.min(baseInterval, this.CONFIG_SYNC_CHECK_INTERVAL_MS)
      : baseInterval;

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

    // Sync-phase stall (#5122). Checked BEFORE the general idle test because its
    // budget is much tighter — 60s versus the 5-minute default — and because a
    // stalled sync is a distinct failure: the link is open and healthy-looking,
    // the peer has simply stopped talking part-way through the NodeDB stream and
    // will never resume. Reconnecting is the only way out.
    if (this.configSyncActive && timeSinceLastData > this.CONFIG_SYNC_STALL_MS) {
      logger.warn(
        `⚠️  Config sync stalled: no data received for ${Math.floor(timeSinceLastData / 1000)}s ` +
        `while the initial sync was still running (budget: ${this.CONFIG_SYNC_STALL_MS / 1000}s). Forcing reconnection...`,
      );
      this.emit('stale-connection', { timeSinceLastData, timeout: this.CONFIG_SYNC_STALL_MS, phase: 'config-sync' });
      if (this.socket) {
        this.socket.destroy();
      }
      return;
    }

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
