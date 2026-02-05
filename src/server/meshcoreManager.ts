/**
 * MeshCore Manager - Core connection and communication layer for MeshCore devices
 *
 * This replaces MeshtasticManager for MeshCore protocol support.
 *
 * MeshCore has two firmware types:
 * - Companion: Full-featured, uses binary protocol via meshcore Python library
 * - Repeater: Lightweight, uses text CLI commands
 *
 * This manager uses Python child processes to interact with the meshcore library
 * for Companion devices, and direct serial for Repeater devices.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
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

/**
 * MeshCore Manager class
 * Handles connection and communication with MeshCore devices
 */
class MeshCoreManager extends EventEmitter {
  private config: MeshCoreConfig | null = null;
  private connected: boolean = false;
  private deviceType: MeshCoreDeviceType = MeshCoreDeviceType.UNKNOWN;
  private serialPort: InstanceType<typeof import('serialport').SerialPort> | null = null;
  private parser: InstanceType<typeof import('@serialport/parser-readline').ReadlineParser> | null = null;
  private localNode: MeshCoreNode | null = null;
  private contacts: Map<string, MeshCoreContact> = new Map();
  private messages: MeshCoreMessage[] = [];
  private pythonProcess: ChildProcess | null = null;
  private pendingCommands: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();
  private commandId: number = 0;

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
        // Load serialport dynamically
        const serialAvailable = await loadSerialPort();
        if (!serialAvailable) {
          logger.error('[MeshCore] Serial port support not available. Install serialport package.');
          return false;
        }
        await this.connectSerial();
      } else if (this.config.connectionType === ConnectionType.TCP) {
        await this.connectTcp();
      }

      // Detect device type and get initial info
      await this.detectDeviceType();
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

    if (this.serialPort?.isOpen) {
      this.serialPort.close();
    }
    this.serialPort = null;
    this.parser = null;

    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }

    // Clear pending commands
    for (const [_id, cmd] of this.pendingCommands) {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Disconnected'));
    }
    this.pendingCommands.clear();

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
    // Note: Could use getEnvironmentConfig() for more complex config in the future

    // Check for serial port config
    const serialPort = process.env.MESHCORE_SERIAL_PORT;
    if (serialPort) {
      return {
        connectionType: ConnectionType.SERIAL,
        serialPort,
        baudRate: parseInt(process.env.MESHCORE_BAUD_RATE || '115200', 10),
      };
    }

    // Check for TCP config
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

  /**
   * Connect via serial port
   */
  private async connectSerial(): Promise<void> {
    if (!this.config?.serialPort) {
      throw new Error('Serial port not configured');
    }

    if (!SerialPort || !ReadlineParser) {
      throw new Error('Serial port support not loaded');
    }

    // Capture non-null values for use in closure
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
   * Connect via TCP (for serial-bridge or network devices)
   */
  private async connectTcp(): Promise<void> {
    // For TCP, we'll use the Python library which handles TCP connections
    // This is a placeholder - actual implementation uses Python subprocess
    logger.info(`[MeshCore] TCP connection to ${this.config?.tcpHost}:${this.config?.tcpPort}`);
    // TCP will be handled through the Python bridge
  }

  /**
   * Detect the device type (Companion vs Repeater)
   */
  private async detectDeviceType(): Promise<void> {
    // Try Repeater CLI first (simpler)
    try {
      const response = await this.sendRepeaterCommand('ver', 2000);
      if (response && response.includes('MeshCore')) {
        this.deviceType = MeshCoreDeviceType.REPEATER;
        logger.info('[MeshCore] Detected Repeater firmware');
        return;
      }
    } catch {
      // Not a repeater, try Companion
    }

    // Assume Companion if not Repeater
    this.deviceType = MeshCoreDeviceType.COMPANION;
    logger.info('[MeshCore] Assuming Companion firmware');
  }

  /**
   * Handle incoming serial data
   */
  private handleSerialData(data: string): void {
    logger.debug(`[MeshCore] RX: ${data}`);

    // Check if this is a response to a pending command
    // Repeater responses are simple text
    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      // Emit as raw data for command handlers
      this.emit('serial_data', data);
    }

    // Check for incoming messages
    if (data.startsWith('MSG:')) {
      this.handleIncomingMessage(data);
    }
  }

  /**
   * Handle incoming message
   */
  private handleIncomingMessage(data: string): void {
    // Parse message format: MSG:<from_key>:<text>
    const match = data.match(/^MSG:([a-f0-9]+):(.+)$/i);
    if (match) {
      const message: MeshCoreMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        fromPublicKey: match[1],
        text: match[2],
        timestamp: Date.now(),
      };
      this.messages.push(message);
      this.emit('message', message);
      logger.info(`[MeshCore] Message from ${match[1].substring(0, 8)}...: ${match[2]}`);
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
        // Check for command completion (prompt or specific response)
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

  /**
   * Execute a Python meshcore command for Companion devices
   * SECURITY: Data is passed via stdin as JSON to prevent command injection
   */
  private async executePythonCommand(script: string, inputData?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const python = spawn('python3', ['-c', script]);
      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout);
            resolve(result);
          } catch {
            resolve(stdout.trim());
          }
        } else {
          reject(new Error(`Python error: ${stderr}`));
        }
      });

      python.on('error', (err) => {
        reject(err);
      });

      // SECURITY: Pass data via stdin as JSON instead of string interpolation
      if (inputData) {
        python.stdin.write(JSON.stringify(inputData));
        python.stdin.end();
      }
    });
  }

  /**
   * Validate and sanitize serial port path
   * SECURITY: Prevent path traversal and injection
   */
  private sanitizeSerialPort(port: string): string {
    // Allow only valid serial port patterns
    const validPatterns = [
      /^\/dev\/tty[A-Za-z0-9]+$/,      // Linux: /dev/ttyUSB0, /dev/ttyACM0
      /^\/dev\/[a-zA-Z][a-zA-Z0-9_-]*$/,  // Linux symlinks: /dev/wio-meshcore, /dev/techo-meshtastic
      /^\/dev\/cu\.[A-Za-z0-9_-]+$/,   // macOS: /dev/cu.usbmodem*
      /^COM\d+$/i,                      // Windows: COM1, COM2, etc.
      /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/, // TCP: IP:port
    ];

    const isValid = validPatterns.some(pattern => pattern.test(port));
    if (!isValid) {
      throw new Error(`Invalid serial port format: ${port}`);
    }
    return port;
  }

  /**
   * Refresh local node information
   */
  async refreshLocalNode(): Promise<MeshCoreNode | null> {
    if (!this.connected && !this.serialPort?.isOpen) {
      return null;
    }

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      // Use CLI commands for Repeater
      try {
        const nameResponse = await this.sendRepeaterCommand('get name');
        const radioResponse = await this.sendRepeaterCommand('get radio');

        // Parse responses
        const nameMatch = nameResponse.match(/name:\s*(.+)/i);
        const radioMatch = radioResponse.match(/(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+),\s*(\d+)/);

        this.localNode = {
          publicKey: 'repeater', // Repeaters don't expose public key easily
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
      // Use Python for Companion
      // SECURITY: Serial port passed via stdin to prevent injection
      const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    info = mc.self_info
    await mc.disconnect()
    print(json.dumps(info))

asyncio.run(main())
`;
      try {
        const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
        const info = await this.executePythonCommand(script, { serial_port: serialPort });
        // Extract latitude/longitude, filtering out 0,0 (no GPS)
        const lat = info.adv_lat && info.adv_lat !== 0 ? info.adv_lat : undefined;
        const lon = info.adv_lon && info.adv_lon !== 0 ? info.adv_lon : undefined;
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
          latitude: lat,
          longitude: lon,
        };
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
      // Repeaters don't have a contacts API
      return this.contacts;
    }

    // SECURITY: Serial port passed via stdin to prevent injection
    const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    await mc.commands.get_contacts()
    contacts = []
    for key, contact in mc.contacts.items():
        # Try to get position data - MeshCore uses adv_lat/adv_lon
        lat = contact.get('adv_lat') or contact.get('latitude') or contact.get('lat')
        lon = contact.get('adv_lon') or contact.get('longitude') or contact.get('lon')
        # Filter out 0,0 positions (no GPS data)
        if lat == 0.0:
            lat = None
        if lon == 0.0:
            lon = None
        contacts.append({
            'public_key': key,
            'adv_name': contact.get('adv_name', ''),
            'name': contact.get('name', ''),
            'rssi': contact.get('rssi'),
            'snr': contact.get('snr'),
            'adv_type': contact.get('type'),
            'latitude': lat,
            'longitude': lon,
        })
    await mc.disconnect()
    print(json.dumps(contacts))

asyncio.run(main())
`;

    try {
      const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
      const contactsList = await this.executePythonCommand(script, { serial_port: serialPort });
      this.contacts.clear();
      for (const c of contactsList) {
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
      // Repeaters can't send messages directly
      logger.warn('[MeshCore] Repeaters cannot send messages');
      return false;
    }

    // SECURITY: All user input passed via stdin as JSON to prevent command injection
    const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    if input_data.get('to_public_key'):
        await mc.commands.send_msg(input_data['to_public_key'], input_data['text'])
    else:
        await mc.commands.send_chan_msg(0, input_data['text'])
    await mc.disconnect()
    print('OK')

asyncio.run(main())
`;

    try {
      const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
      await this.executePythonCommand(script, {
        serial_port: serialPort,
        text: text,
        to_public_key: toPublicKey || null,
      });
      logger.info(`[MeshCore] Message sent: ${text.substring(0, 50)}...`);

      // Store the sent message
      const sentMessage: MeshCoreMessage = {
        id: `sent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        fromPublicKey: this.localNode?.publicKey || 'local',
        toPublicKey: toPublicKey || undefined,
        text: text,
        timestamp: Date.now(),
      };
      this.messages.push(sentMessage);
      this.emit('message', sentMessage);

      return true;
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
      // SECURITY: Serial port passed via stdin to prevent injection
      const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    await mc.commands.send_advert()
    await mc.disconnect()
    print('OK')

asyncio.run(main())
`;
      try {
        const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
        await this.executePythonCommand(script, { serial_port: serialPort });
        logger.info('[MeshCore] Advert sent (Companion)');
        return true;
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

    // SECURITY: All user input passed via stdin as JSON to prevent command injection
    const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    await mc.commands.send_login(input_data['public_key'], input_data['password'])
    await mc.disconnect()
    print('OK')

asyncio.run(main())
`;

    try {
      const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
      await this.executePythonCommand(script, {
        serial_port: serialPort,
        public_key: publicKey,
        password: password,
      });
      logger.info(`[MeshCore] Logged into node ${publicKey.substring(0, 8)}...`);
      return true;
    } catch (error) {
      logger.error('[MeshCore] Login failed:', error);
      return false;
    }
  }

  /**
   * Request status from a remote node (requires prior login)
   */
  async requestNodeStatus(publicKey: string): Promise<MeshCoreStatus | null> {
    if (this.deviceType !== MeshCoreDeviceType.COMPANION) {
      return null;
    }

    // SECURITY: All user input passed via stdin as JSON to prevent command injection
    const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    status = await mc.commands.req_status_sync(input_data['public_key'], timeout=10)
    await mc.disconnect()
    print(json.dumps(status if status else {}))

asyncio.run(main())
`;

    try {
      const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
      const status = await this.executePythonCommand(script, {
        serial_port: serialPort,
        public_key: publicKey,
      });
      return {
        batteryMv: status.bat_mv,
        uptimeSecs: status.up_secs,
        txPower: status.tx_power,
        radioFreq: status.radio_freq,
        radioBw: status.radio_bw,
        radioSf: status.radio_sf,
        radioCr: status.radio_cr,
      };
    } catch (error) {
      logger.error('[MeshCore] Status request failed:', error);
      return null;
    }
  }

  /**
   * Sanitize name input to prevent injection
   * SECURITY: Only allow alphanumeric, spaces, hyphens, underscores
   */
  private sanitizeName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9\s\-_]/g, '').substring(0, 32);
    if (sanitized.length === 0) {
      throw new Error('Invalid name: must contain alphanumeric characters');
    }
    return sanitized;
  }

  /**
   * Set device name (Repeater only via CLI)
   */
  async setName(name: string): Promise<boolean> {
    // SECURITY: Sanitize name to prevent injection
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
      // SECURITY: All user input passed via stdin as JSON to prevent command injection
      const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    await mc.commands.set_name(input_data['name'])
    await mc.disconnect()
    print('OK')

asyncio.run(main())
`;
      try {
        const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
        await this.executePythonCommand(script, {
          serial_port: serialPort,
          name: safeName,
        });
        if (this.localNode) {
          this.localNode.name = safeName;
        }
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to set name:', error);
        return false;
      }
    }
  }

  /**
   * Validate radio parameters
   * SECURITY: Ensure numeric values are within valid ranges
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

  /**
   * Set radio parameters
   */
  async setRadio(freq: number, bw: number, sf: number, cr: number): Promise<boolean> {
    // SECURITY: Validate numeric parameters
    this.validateRadioParams(freq, bw, sf, cr);

    if (this.deviceType === MeshCoreDeviceType.REPEATER) {
      try {
        // Safe: validated numbers only
        await this.sendRepeaterCommand(`set radio ${freq},${bw},${sf},${cr}`);
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to set radio:', error);
        return false;
      }
    } else {
      // SECURITY: All parameters passed via stdin as JSON
      const script = `
import asyncio
import json
import sys
from meshcore import MeshCore, SerialConnection

async def main():
    input_data = json.loads(sys.stdin.read())
    cx = SerialConnection(input_data['serial_port'], baudrate=115200)
    mc = MeshCore(cx)
    await mc.connect()
    await mc.commands.set_radio(input_data['freq'], input_data['bw'], input_data['sf'], input_data['cr'])
    await mc.disconnect()
    print('OK')

asyncio.run(main())
`;
      try {
        const serialPort = this.sanitizeSerialPort(this.config?.serialPort || '');
        await this.executePythonCommand(script, {
          serial_port: serialPort,
          freq: freq,
          bw: bw,
          sf: sf,
          cr: cr,
        });
        return true;
      } catch (error) {
        logger.error('[MeshCore] Failed to set radio:', error);
        return false;
      }
    }
  }

  // ============ Getters ============

  /**
   * Get connection status
   */
  getConnectionStatus(): { connected: boolean; deviceType: MeshCoreDeviceType; config: MeshCoreConfig | null } {
    return {
      connected: this.connected,
      deviceType: this.deviceType,
      config: this.config,
    };
  }

  /**
   * Get local node info
   */
  getLocalNode(): MeshCoreNode | null {
    return this.localNode;
  }

  /**
   * Get all contacts
   */
  getContacts(): MeshCoreContact[] {
    return Array.from(this.contacts.values());
  }

  /**
   * Get all nodes (local + contacts)
   */
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
      });
    }

    return nodes;
  }

  /**
   * Get recent messages
   */
  getRecentMessages(limit: number = 50): MeshCoreMessage[] {
    return this.messages.slice(-limit);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}

// Export singleton instance
const meshcoreManager = new MeshCoreManager();
export default meshcoreManager;
export { MeshCoreManager };
