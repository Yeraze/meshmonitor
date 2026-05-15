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
import { dataEventEmitter } from './services/dataEventEmitter.js';
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

export interface MeshCoreConfig {
  connectionType: ConnectionType;
  serialPort?: string;
  tcpHost?: string;
  tcpPort?: number;
  baudRate?: number;
  firmwareType?: 'companion' | 'repeater';

  // Heartbeat / auto-reconnect (native-backend only; default off).
  // See docs/meshcore-heartbeat-proposal.md.
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
  pathLen?: number;
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
}

export interface MeshCoreStatus {
  batteryMv?: number;
  uptimeSecs?: number;
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
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
  async connect(config?: MeshCoreConfig): Promise<boolean> {
    if (this.connected) {
      logger.warn('[MeshCore] Already connected, disconnecting first');
      await this.disconnect();
    }

    // Use provided config or get from environment
    this.config = config || this.getConfigFromEnv();

    if (!this.config) {
      logger.error('[MeshCore] No configuration provided');
      return false;
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
        // Set MESHCORE_FIRMWARE_TYPE=repeater to use direct serial for Repeater devices.
        await this.startNativeBackend();
        this.deviceType = MeshCoreDeviceType.COMPANION;
      }

      // Get initial info
      await this.refreshLocalNode();
      await this.refreshContacts();

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

      return true;
    } catch (error) {
      logger.error('[MeshCore] Connection failed:', error);
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

    this.emit('disconnected');
    dataEventEmitter.emitMeshCoreStatusUpdated({ connected: false }, this.sourceId);
    logger.info('[MeshCore] Disconnected');
  }

  /**
   * Get configuration from environment variables (public accessor)
   */
  getEnvConfig(): MeshCoreConfig | null {
    return this.getConfigFromEnv();
  }

  /**
   * Get configuration from environment variables
   */
  private getConfigFromEnv(): MeshCoreConfig | null {
    const firmwareTypeRaw = (process.env.MESHCORE_FIRMWARE_TYPE || 'companion').toLowerCase();
    const firmwareType: 'companion' | 'repeater' = firmwareTypeRaw === 'repeater' ? 'repeater' : 'companion';

    const serialPort = process.env.MESHCORE_SERIAL_PORT;
    if (serialPort) {
      return {
        connectionType: ConnectionType.SERIAL,
        serialPort,
        baudRate: parseInt(process.env.MESHCORE_BAUD_RATE || '115200', 10),
        firmwareType,
      };
    }

    const tcpHost = process.env.MESHCORE_TCP_HOST;
    if (tcpHost) {
      return {
        connectionType: ConnectionType.TCP,
        tcpHost,
        tcpPort: parseInt(process.env.MESHCORE_TCP_PORT || '4403', 10),
        firmwareType,
      };
    }

    return null;
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
        this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
        dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
        logger.info(`[MeshCore] ${event_type} for ${publicKey} (${data.adv_name ?? ''})`);
      }
    } else if (event_type === 'contact_path_updated') {
      const publicKey: string = data.public_key;
      if (publicKey) {
        const existing = this.contacts.get(publicKey) ?? { publicKey };
        const updated: MeshCoreContact = {
          ...existing,
          publicKey,
          lastSeen: Date.now(),
        };
        this.contacts.set(publicKey, updated);
        this.emit('contacts_updated', { sourceId: this.sourceId, contact: updated });
        dataEventEmitter.emitMeshCoreContactUpdated(updated, this.sourceId);
        logger.info(`[MeshCore] contact_path_updated for ${publicKey}`);
      }
    } else {
      logger.debug(`[MeshCore] Unknown push event: ${event_type}`);
    }
  }

  /** Generate a synthetic public key identifier for channel messages */
  private static channelPublicKey(channelIdx: number): string {
    return `channel-${channelIdx}`;
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
          });
        }
        logger.info(`[MeshCore] Refreshed ${this.contacts.size} contacts`);
      }
    } catch (error) {
      logger.error('[MeshCore] Failed to refresh contacts:', error);
    }

    return this.contacts;
  }

  /**
   * Send a text message
   */
  async sendMessage(text: string, toPublicKey?: string): Promise<boolean> {
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
        to: toPublicKey || null,
      });

      if (response.success) {
        logger.info(`[MeshCore] Message sent: ${text.substring(0, 50)}...`);

        const sentMessage: MeshCoreMessage = {
          id: `sent-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          fromPublicKey: this.localNode?.publicKey || 'local',
          toPublicKey: toPublicKey || undefined,
          text: text,
          timestamp: Date.now(),
          sourceId: this.sourceId,
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
        return {
          batteryMv: response.data.bat_mv,
          uptimeSecs: response.data.up_secs,
          txPower: response.data.tx_power,
          radioFreq: response.data.radio_freq,
          radioBw: response.data.radio_bw,
          radioSf: response.data.radio_sf,
          radioCr: response.data.radio_cr,
        };
      }
      return null;
    } catch (error) {
      logger.error('[MeshCore] Status request failed:', error);
      return null;
    }
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
  // docs/meshcore-heartbeat-proposal.md for the full design.

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
