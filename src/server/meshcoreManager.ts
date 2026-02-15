/**
 * MeshCore Manager - Core connection and communication layer for MeshCore devices
 *
 * This replaces MeshtasticManager for MeshCore protocol support.
 *
 * MeshCore has two firmware types:
 * - Companion: Full-featured, uses binary protocol via meshcore Python library
 * - Repeater: Lightweight, uses text CLI commands
 *
 * For Companion devices, this manager uses a long-lived Python bridge process
 * (scripts/meshcore-bridge.py) that maintains the serial connection and accepts
 * commands over stdin/stdout JSON protocol.
 *
 * For Repeater devices, direct serial communication is used.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

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
}

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
}

export interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  toPublicKey?: string; // null for broadcast
  text: string;
  timestamp: number;
  rssi?: number;
  snr?: number;
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

// Bridge command response
interface BridgeResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

// Get the directory of this module for finding the bridge script
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * MeshCore Manager class
 * Handles connection and communication with MeshCore devices
 */
class MeshCoreManager extends EventEmitter {
  private config: MeshCoreConfig | null = null;
  private connected: boolean = false;
  private deviceType: MeshCoreDeviceType = MeshCoreDeviceType.UNKNOWN;

  // Repeater: direct serial
  private serialPort: InstanceType<typeof import('serialport').SerialPort> | null = null;
  private parser: InstanceType<typeof import('@serialport/parser-readline').ReadlineParser> | null = null;

  // Companion: Python bridge
  private bridgeProcess: ChildProcess | null = null;
  private bridgeReady: boolean = false;
  private bridgeReader: readline.Interface | null = null;
  private pendingBridgeCommands: Map<string, {
    resolve: (value: BridgeResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout
  }> = new Map();

  // Shared state
  private localNode: MeshCoreNode | null = null;
  private contacts: Map<string, MeshCoreContact> = new Map();
  private messages: MeshCoreMessage[] = [];
  private pendingCommands: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();
  private commandId: number = 0;

  // Message limit to prevent unbounded growth
  private static readonly MAX_MESSAGES = 1000;

  constructor() {
    super();
    logger.info('[MeshCore] Manager initialized');
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

    try {
      if (this.config.connectionType === ConnectionType.SERIAL) {
        // Load serialport dynamically for Repeater detection
        const serialAvailable = await loadSerialPort();
        if (!serialAvailable) {
          logger.warn('[MeshCore] Serial port not available, will use Python bridge');
        }

        // First try to detect if it's a Repeater via direct serial
        if (serialAvailable) {
          try {
            await this.connectSerialDirect();
            const isRepeater = await this.detectRepeater();
            if (isRepeater) {
              this.deviceType = MeshCoreDeviceType.REPEATER;
              logger.info('[MeshCore] Detected Repeater firmware');
            } else {
              // Not a repeater, close serial and use Python bridge
              await this.closeSerialDirect();
              await this.startBridge();
              this.deviceType = MeshCoreDeviceType.COMPANION;
            }
          } catch {
            // Serial detection failed, try Python bridge
            await this.startBridge();
            this.deviceType = MeshCoreDeviceType.COMPANION;
          }
        } else {
          // No serial support, use Python bridge
          await this.startBridge();
          this.deviceType = MeshCoreDeviceType.COMPANION;
        }
      } else if (this.config.connectionType === ConnectionType.TCP) {
        // TCP uses Python bridge
        await this.startBridge();
        this.deviceType = MeshCoreDeviceType.COMPANION;
      }

      // Get initial info
      await this.refreshLocalNode();
      await this.refreshContacts();

      this.connected = true;
      this.emit('connected', this.localNode);
      logger.info(`[MeshCore] Connected to ${this.localNode?.name || 'unknown device'}`);

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

    // Stop Python bridge
    if (this.bridgeProcess) {
      try {
        await this.sendBridgeCommand('shutdown', {});
      } catch {
        // Ignore errors during shutdown
      }
      this.bridgeProcess.kill();
      this.bridgeProcess = null;
      this.bridgeReady = false;
    }

    if (this.bridgeReader) {
      this.bridgeReader.close();
      this.bridgeReader = null;
    }

    // Close serial port (for Repeater)
    await this.closeSerialDirect();

    // Clear pending commands
    for (const [_id, cmd] of this.pendingCommands) {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Disconnected'));
    }
    this.pendingCommands.clear();

    for (const [_id, cmd] of this.pendingBridgeCommands) {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Disconnected'));
    }
    this.pendingBridgeCommands.clear();

    this.connected = false;
    this.deviceType = MeshCoreDeviceType.UNKNOWN;
    this.localNode = null;
    this.contacts.clear();

    this.emit('disconnected');
    logger.info('[MeshCore] Disconnected');
  }

  /**
   * Get configuration from environment variables
   */
  private getConfigFromEnv(): MeshCoreConfig | null {
    const serialPort = process.env.MESHCORE_SERIAL_PORT;
    if (serialPort) {
      return {
        connectionType: ConnectionType.SERIAL,
        serialPort,
        baudRate: parseInt(process.env.MESHCORE_BAUD_RATE || '115200', 10),
      };
    }

    const tcpHost = process.env.MESHCORE_TCP_HOST;
    if (tcpHost) {
      return {
        connectionType: ConnectionType.TCP,
        tcpHost,
        tcpPort: parseInt(process.env.MESHCORE_TCP_PORT || '4403', 10),
      };
    }

    return null;
  }

  // ============ Python Bridge Methods ============

  /**
   * Start the Python bridge process
   */
  private async startBridge(): Promise<void> {
    const bridgeScript = path.resolve(__dirname, '../../scripts/meshcore-bridge.py');

    logger.info(`[MeshCore] Starting Python bridge: ${bridgeScript}`);

    const pythonPath = process.env.NODE_ENV !== 'production' ? 'python3' : '/opt/apprise-venv/bin/python3';
    this.bridgeProcess = spawn(pythonPath, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up stdout reader
    this.bridgeReader = readline.createInterface({
      input: this.bridgeProcess.stdout!,
      crlfDelay: Infinity,
    });

    this.bridgeReader.on('line', (line) => {
      this.handleBridgeResponse(line);
    });

    this.bridgeProcess.stderr?.on('data', (data) => {
      logger.error(`[MeshCore Bridge] ${data.toString().trim()}`);
    });

    this.bridgeProcess.on('close', (code) => {
      logger.info(`[MeshCore] Bridge process exited with code ${code}`);
      this.bridgeReady = false;
    });

    this.bridgeProcess.on('error', (err) => {
      logger.error('[MeshCore] Bridge process error:', err);
    });

    // Wait for ready message
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Bridge startup timeout'));
      }, 10000);

      const readyHandler = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            this.bridgeReady = true;
            if (!msg.meshcore_available) {
              logger.warn('[MeshCore] meshcore Python library not installed');
            }
            resolve();
          }
        } catch {
          // Not the ready message
        }
      };

      this.bridgeReader!.once('line', readyHandler);
    });

    // Connect via bridge - supports both serial and TCP
    let connectParams: Record<string, any>;
    if (this.config?.connectionType === ConnectionType.TCP) {
      connectParams = {
        type: 'tcp',
        host: this.config.tcpHost || 'localhost',
        tcp_port: this.config.tcpPort || 4403,
      };
    } else {
      const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
      connectParams = {
        type: 'serial',
        port: serialPort,
        baud: this.config?.baudRate || 115200,
      };
    }
    const response = await this.sendBridgeCommand('connect', connectParams);

    if (!response.success) {
      throw new Error(response.error || 'Bridge connect failed');
    }

    logger.info('[MeshCore] Bridge connected');
  }

  /**
   * Send a command to the Python bridge and wait for response
   */
  private async sendBridgeCommand(cmd: string, params: Record<string, any>, timeout: number = 30000): Promise<BridgeResponse> {
    if (!this.bridgeProcess || !this.bridgeReady) {
      throw new Error('Bridge not ready');
    }

    const id = `${++this.commandId}`;
    const command = JSON.stringify({ id, cmd, ...params });

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingBridgeCommands.delete(id);
        reject(new Error(`Bridge command timeout: ${cmd}`));
      }, timeout);

      this.pendingBridgeCommands.set(id, { resolve, reject, timeout: timeoutHandle });

      this.bridgeProcess!.stdin!.write(command + '\n');
    });
  }

  /**
   * Handle response from Python bridge
   */
  private handleBridgeResponse(line: string): void {
    try {
      const response: BridgeResponse = JSON.parse(line);

      // Check for ready message (already handled in startBridge)
      if ((response as any).type === 'ready') {
        return;
      }

      const pending = this.pendingBridgeCommands.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingBridgeCommands.delete(response.id);
        pending.resolve(response);
      } else {
        logger.debug(`[MeshCore] Unexpected bridge response: ${line}`);
      }
    } catch (error) {
      logger.error(`[MeshCore] Invalid bridge response: ${line}`);
    }
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

    return new Promise((resolve, reject) => {
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
   * Detect if device is a Repeater (text CLI)
   */
  private async detectRepeater(): Promise<boolean> {
    try {
      const response = await this.sendRepeaterCommand('ver', 2000);
      return response.includes('MeshCore');
    } catch {
      return false;
    }
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
      };
      this.addMessage(message);
      this.emit('message', message);
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
   * Send a command to Repeater firmware (text CLI)
   */
  private async sendRepeaterCommand(command: string, timeout: number = 5000): Promise<string> {
    if (!this.serialPort?.isOpen) {
      throw new Error('Serial port not open');
    }

    return new Promise((resolve, reject) => {
      const cmdId = `cmd_${++this.commandId}`;
      let response = '';

      const timeoutHandle = setTimeout(() => {
        this.pendingCommands.delete(cmdId);
        this.removeListener('serial_data', dataHandler);
        reject(new Error(`Command timeout: ${command}`));
      }, timeout);

      const dataHandler = (data: string) => {
        response += data + '\n';
        if (data.includes('>') || data.includes('OK') || data.includes('Error')) {
          clearTimeout(timeoutHandle);
          this.pendingCommands.delete(cmdId);
          this.removeListener('serial_data', dataHandler);
          resolve(response.trim());
        }
      };

      this.pendingCommands.set(cmdId, { resolve, reject, timeout: timeoutHandle });
      this.on('serial_data', dataHandler);

      logger.debug(`[MeshCore] TX: ${command}`);
      this.serialPort!.write(command + '\n');
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

        const nameMatch = nameResponse.match(/name:\s*(.+)/i);
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
      // Use Python bridge for Companion
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
        };
        this.addMessage(sentMessage);
        this.emit('message', sentMessage);

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
        return response.success;
      } catch (error) {
        logger.error('[MeshCore] Failed to set radio:', error);
        return false;
      }
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
}

// Export singleton instance
const meshcoreManager = new MeshCoreManager();
export default meshcoreManager;
export { MeshCoreManager };
