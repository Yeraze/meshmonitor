import { Server, Socket } from 'net';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';
import type { MeshCoreNode, TelemetryMode } from './meshcoreManager.js';
import {
  CommandCodes,
  ErrorCodes,
  SUPPORTED_COMPANION_PROTOCOL_VERSION,
  parseAppFrames,
  frameNodeToApp,
  encodeSelfInfo,
  encodeCurrTime,
  encodeDeviceInfo,
  encodeContactsStart,
  encodeEndOfContacts,
  encodeNoMoreMessages,
  encodeOk,
  encodeErr,
  packTelemetryMode,
  pubKeyHexToBytes,
  degreesToFixed,
  mhzToWireFreq,
  khzToWireBw,
  type ParsedCommand,
} from './meshcoreCompanionCodec.js';

/**
 * Minimal surface the virtual node server needs from a MeshCoreManager. Kept as
 * a narrow interface (rather than importing the whole manager) so the server is
 * unit-testable with a fake and so we avoid a runtime import cycle — the manager
 * imports this module to construct the server.
 */
export interface MeshCoreVirtualNodeManager {
  readonly sourceId: string;
  isConnected(): boolean;
  getLocalNode(): MeshCoreNode | null;
}

export interface MeshCoreVirtualNodeServerOptions {
  port: number;
  manager: MeshCoreVirtualNodeManager;
  /** Allow config-mutating commands through to the real node (default false). */
  allowAdminCommands?: boolean;
}

/**
 * Per-source virtual node config persisted in `sources.config.virtualNode` for
 * meshcore sources. Mirrors the Meshtastic `VirtualNodeConfig` shape.
 */
export interface MeshCoreVirtualNodeConfig {
  enabled: boolean;
  port: number;
  allowAdminCommands: boolean;
}

interface ConnectedClient {
  socket: Socket;
  id: string;
  buffer: Buffer;
  connectedAt: Date;
  lastActivity: Date;
}

/**
 * MeshCore Virtual Node Server — Phase 0 (handshake).
 *
 * Acts as the *device end* of the MeshCore companion protocol over TCP, letting
 * the MeshCore mobile app connect to MeshMonitor over WiFi and see the real
 * node (which MeshMonitor already holds the companion slot on) as if it were
 * local. See docs/internal/dev-notes/MESHCORE_VIRTUAL_NODE_DESIGN.md.
 *
 * Phase 0 brings the app to "connected, identity shown, empty mailbox":
 *   AppStart→SelfInfo, GetDeviceTime→CurrTime, DeviceQuery→DeviceInfo,
 *   GetContacts→(empty), SyncNextMessage→NoMoreMessages.
 * Reads are synthesized from the manager's local-node state; nothing is
 * forwarded to the real node yet (that arrives in Phase 2). Structure mirrors
 * src/server/virtualNodeServer.ts (the proven Meshtastic equivalent).
 */
export class MeshCoreVirtualNodeServer extends EventEmitter {
  private readonly options: MeshCoreVirtualNodeServerOptions;
  private readonly allowAdminCommands: boolean;
  private server: Server | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private nextClientId = 1;
  private cleanupTimer: NodeJS.Timeout | null = null;

  private readonly MAX_FRAME_BYTES = 4096;
  private readonly CLIENT_TIMEOUT_MS = 300000; // 5 min inactivity
  private readonly CLEANUP_INTERVAL_MS = 60000;

  constructor(options: MeshCoreVirtualNodeServerOptions) {
    super();
    this.options = options;
    this.allowAdminCommands = options.allowAdminCommands ?? false;
  }

  get sourceId(): string {
    return this.options.manager.sourceId;
  }

  async start(): Promise<void> {
    if (this.server) {
      logger.warn(`[MeshCore VN ${this.sourceId}] already started`);
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = new Server((socket) => this.handleNewClient(socket));

      this.server.on('error', (error) => {
        logger.error(`[MeshCore VN ${this.sourceId}] server error:`, error);
        this.emit('error', error);
        reject(error);
      });

      this.server.listen(this.options.port, () => {
        logger.info(`🌐 [MeshCore VN ${this.sourceId}] listening on port ${this.options.port}`);
        this.cleanupTimer = setInterval(() => this.cleanupInactiveClients(), this.CLEANUP_INTERVAL_MS);
        this.emit('listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const client of this.clients.values()) {
      client.socket.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      this.server?.close(() => {
        logger.info(`🛑 [MeshCore VN ${this.sourceId}] stopped`);
        this.server = null;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /** Actual listening port (useful when started on port 0 in tests). */
  getListeningPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  isAdminCommandsAllowed(): boolean {
    return this.allowAdminCommands;
  }

  // ───────────────────────── client lifecycle ─────────────────────────

  private handleNewClient(socket: Socket): void {
    const clientId = `mcvn-${this.nextClientId++}`;
    const now = new Date();
    this.clients.set(clientId, { socket, id: clientId, buffer: Buffer.alloc(0), connectedAt: now, lastActivity: now });
    logger.info(`📱 [MeshCore VN ${this.sourceId}] client connected: ${clientId} (${this.clients.size} total)`);

    databaseService.auditLogAsync(
      null,
      'meshcore_virtual_node_connect',
      'meshcore_virtual_node',
      JSON.stringify({ clientId, sourceId: this.sourceId, ip: socket.remoteAddress || 'unknown' }),
      socket.remoteAddress || null,
    ).catch((error) => logger.error(`[MeshCore VN ${this.sourceId}] audit log (connect) failed:`, error));

    socket.on('data', (data: Buffer) => this.handleClientData(clientId, data));
    socket.on('close', () => this.handleClientDisconnect(clientId));
    socket.on('error', (error) => {
      logger.error(`[MeshCore VN ${this.sourceId}] client ${clientId} error:`, error.message);
      this.handleClientDisconnect(clientId);
    });

    this.emit('client-connected', clientId);
  }

  private handleClientDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    logger.info(`📱 [MeshCore VN ${this.sourceId}] client disconnected: ${clientId} (${this.clients.size} remaining)`);

    databaseService.auditLogAsync(
      null,
      'meshcore_virtual_node_disconnect',
      'meshcore_virtual_node',
      JSON.stringify({ clientId, sourceId: this.sourceId, ip: client.socket.remoteAddress || 'unknown' }),
      client.socket.remoteAddress || null,
    ).catch((error) => logger.error(`[MeshCore VN ${this.sourceId}] audit log (disconnect) failed:`, error));

    this.emit('client-disconnected', clientId);
  }

  private handleClientData(clientId: string, data: Buffer): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastActivity = new Date();
    client.buffer = Buffer.concat([client.buffer, data]);

    // Guard against an unbounded buffer from a misbehaving / non-protocol peer.
    if (client.buffer.length > this.MAX_FRAME_BYTES * 4) {
      logger.warn(`[MeshCore VN ${this.sourceId}] ${clientId} buffer overflow, dropping`);
      client.socket.destroy();
      return;
    }

    const { commands, rest } = parseAppFrames(client.buffer);
    client.buffer = rest;
    for (const command of commands) {
      this.dispatchCommand(clientId, command);
    }
  }

  // ───────────────────────── command dispatch ─────────────────────────

  private dispatchCommand(clientId: string, command: ParsedCommand): void {
    try {
      switch (command.code) {
        case CommandCodes.AppStart:
          this.handleAppStart(clientId, command);
          break;
        case CommandCodes.GetDeviceTime:
          this.send(clientId, encodeCurrTime(Math.floor(Date.now() / 1000)));
          break;
        case CommandCodes.SetDeviceTime:
          // Phase 0: accept but no-op (the real node keeps its own clock).
          this.send(clientId, encodeOk());
          break;
        case CommandCodes.DeviceQuery:
          this.handleDeviceQuery(clientId);
          break;
        case CommandCodes.GetContacts:
          // Phase 0: advertise an empty contact list. Phase 1 fills this in.
          this.send(clientId, encodeContactsStart(0));
          this.send(clientId, encodeEndOfContacts(0));
          break;
        case CommandCodes.SyncNextMessage:
          // Phase 0: mailbox always empty. Phase 1 drains mirrored messages.
          this.send(clientId, encodeNoMoreMessages());
          break;
        default:
          logger.debug(`[MeshCore VN ${this.sourceId}] unsupported command ${command.code} from ${clientId} (phase 0)`);
          this.send(clientId, encodeErr(ErrorCodes.UnsupportedCmd));
          break;
      }
    } catch (error) {
      logger.error(`[MeshCore VN ${this.sourceId}] error handling command ${command.code} from ${clientId}:`, error);
    }
  }

  private handleAppStart(clientId: string, command: ParsedCommand): void {
    const localNode = this.options.manager.getLocalNode();
    if (!localNode || !this.options.manager.isConnected()) {
      logger.warn(`[MeshCore VN ${this.sourceId}] AppStart from ${clientId} but local node not ready — replying BadState`);
      this.send(clientId, encodeErr(ErrorCodes.BadState));
      return;
    }

    logger.info(
      `[MeshCore VN ${this.sourceId}] AppStart from ${clientId}` +
        `${command.appName ? ` (app "${command.appName}")` : ''} → SelfInfo for "${localNode.name}"`,
    );
    this.send(clientId, encodeSelfInfo(this.buildSelfInfo(localNode)));
  }

  private handleDeviceQuery(clientId: string): void {
    const localNode = this.options.manager.getLocalNode();
    this.send(clientId, encodeDeviceInfo({
      firmwareVer: localNode?.firmwareVer ?? SUPPORTED_COMPANION_PROTOCOL_VERSION,
      firmwareBuildDate: localNode?.firmwareBuild ?? '',
      manufacturerModel: localNode?.model || 'MeshMonitor Virtual Node',
    }));
  }

  /** Map MeshMonitor's local-node record to the SelfInfo wire structure. */
  private buildSelfInfo(node: MeshCoreNode): Parameters<typeof encodeSelfInfo>[0] {
    return {
      type: node.advType ?? 1,
      txPower: node.txPower ?? 0,
      maxTxPower: node.maxTxPower ?? 0,
      publicKey: pubKeyHexToBytes(node.publicKey),
      advLat: degreesToFixed(node.latitude),
      advLon: degreesToFixed(node.longitude),
      multiAcks: 0,
      advLocPolicy: node.advLocPolicy ?? 0,
      telemetryMode: packTelemetryMode(
        this.telemetryModeToWire(node.telemetryModeBase),
        this.telemetryModeToWire(node.telemetryModeLoc),
        this.telemetryModeToWire(node.telemetryModeEnv),
      ),
      manualAddContacts: 0,
      radioFreq: mhzToWireFreq(node.radioFreq),
      radioBw: khzToWireBw(node.radioBw),
      radioSf: node.radioSf ?? 0,
      radioCr: node.radioCr ?? 0,
      name: node.name ?? '',
    };
  }

  /** Map MeshMonitor's string telemetry mode back to the wire's 2-bit value. */
  private telemetryModeToWire(mode?: TelemetryMode): number {
    switch (mode) {
      case 'device': return 1;
      case 'always': return 2;
      default: return 0; // 'never' / undefined
    }
  }

  // ───────────────────────── io ─────────────────────────

  private send(clientId: string, payload: Uint8Array): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.destroyed || !client.socket.writable) return;
    client.socket.write(frameNodeToApp(payload), (error) => {
      if (error) logger.error(`[MeshCore VN ${this.sourceId}] failed to send to ${clientId}:`, error.message);
    });
  }

  private cleanupInactiveClients(): void {
    const now = Date.now();
    for (const [clientId, client] of this.clients.entries()) {
      if (now - client.lastActivity.getTime() > this.CLIENT_TIMEOUT_MS) {
        logger.info(`[MeshCore VN ${this.sourceId}] ${clientId} inactive, disconnecting`);
        client.socket.destroy();
        this.handleClientDisconnect(clientId);
      }
    }
  }
}
