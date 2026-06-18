import { Server, Socket } from 'net';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';
import type { MeshCoreNode, TelemetryMode, MeshCoreContact, MeshCoreMessage } from './meshcoreManager.js';
import databaseServiceDefault from '../services/database.js';
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
  encodeContact,
  encodeEndOfContacts,
  encodeChannelInfo,
  encodeBatteryVoltage,
  encodeContactMsgRecv,
  encodeChannelMsgRecv,
  encodeMsgWaitingPush,
  encodeSent,
  encodeNoMoreMessages,
  encodeOk,
  encodeErr,
  packTelemetryMode,
  pubKeyHexToBytes,
  hexToBytes,
  degreesToFixed,
  toEpochSeconds,
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
  getContacts(): MeshCoreContact[];
  /** Send a text message to the real node: channel (by index) or DM (full key). */
  sendMessage(text: string, toPublicKey?: string, channelIdx?: number): Promise<boolean>;
  /** EventEmitter surface — the manager emits 'message' with a MeshCoreMessage. */
  on(event: 'message', listener: (msg: MeshCoreMessage) => void): unknown;
  off(event: 'message', listener: (msg: MeshCoreMessage) => void): unknown;
}

/** Reverse map of command codes → names, for human-readable command logging. */
const COMMAND_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(CommandCodes).map(([name, code]) => [code, name]),
);

/** Minimal channels-repo surface the server needs (subset of DbChannel). */
interface ChannelRow {
  id: number;
  name: string;
  psk?: string; // base64-encoded 16-byte secret
}
interface ChannelsDb {
  channels: { getAllChannels(sourceId?: string): Promise<ChannelRow[]> };
}

export interface MeshCoreVirtualNodeServerOptions {
  port: number;
  manager: MeshCoreVirtualNodeManager;
  /** Allow config-mutating commands through to the real node (default false). */
  allowAdminCommands?: boolean;
  /** Injectable channels source; defaults to the real DatabaseService facade. */
  databaseService?: ChannelsDb;
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
  /**
   * Per-client inbound message queue. Seeded empty at connect (mirroring a
   * freshly-synced device) and filled with LIVE messages as they arrive, so
   * the app's local history isn't duplicated on every reconnect. Drained one
   * at a time by SyncNextMessage.
   */
  pendingMessages: MeshCoreMessage[];
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
  private readonly db: ChannelsDb;
  private server: Server | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private nextClientId = 1;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly onManagerMessage = (msg: MeshCoreMessage) => this.handleIncomingMessage(msg);

  private readonly MAX_FRAME_BYTES = 4096;
  private readonly CLIENT_TIMEOUT_MS = 300000; // 5 min inactivity
  private readonly CLEANUP_INTERVAL_MS = 60000;

  constructor(options: MeshCoreVirtualNodeServerOptions) {
    super();
    this.options = options;
    this.allowAdminCommands = options.allowAdminCommands ?? false;
    this.db = options.databaseService ?? (databaseServiceDefault as unknown as ChannelsDb);
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
        // Relay live incoming mesh messages to connected app clients.
        this.options.manager.on('message', this.onManagerMessage);
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

    this.options.manager.off('message', this.onManagerMessage);

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
    this.clients.set(clientId, {
      socket,
      id: clientId,
      buffer: Buffer.alloc(0),
      connectedAt: now,
      lastActivity: now,
      pendingMessages: [],
    });
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
    // Phase-0 visibility: log every inbound command (name + raw bytes) so we
    // can observe exactly what the MeshCore app requests and in what order.
    // TODO(phase1): drop to debug once the command surface is implemented.
    logger.info(
      `[MeshCore VN ${this.sourceId}] ◀ cmd ${command.code} (${COMMAND_NAMES[command.code] ?? 'unknown'}) ` +
        `from ${clientId} [${command.payload.length}B]`,
    );
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
          this.handleGetContacts(clientId);
          break;
        case CommandCodes.GetChannel:
          void this.handleGetChannel(clientId, command.channelIdx ?? 0);
          break;
        case CommandCodes.GetBatteryVoltage:
          this.handleGetBatteryVoltage(clientId);
          break;
        case CommandCodes.SyncNextMessage:
          this.handleSyncNextMessage(clientId);
          break;
        case CommandCodes.SendChannelTxtMsg:
          void this.handleSendChannelTxtMsg(clientId, command);
          break;
        case CommandCodes.SendTxtMsg:
          void this.handleSendTxtMsg(clientId, command);
          break;
        case CommandCodes.SetFloodScope:
          // Read-only phase: acknowledge but don't apply (avoids the app
          // treating an Err as a fatal handshake failure). Phase 3 forwards it.
          this.send(clientId, encodeOk());
          break;
        default:
          logger.debug(`[MeshCore VN ${this.sourceId}] unsupported command ${command.code} from ${clientId}`);
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

  /** GetContacts → ContactsStart(N) · N×Contact · EndOfContacts. */
  private handleGetContacts(clientId: string): void {
    const contacts = this.options.manager.getContacts();
    this.send(clientId, encodeContactsStart(contacts.length));
    let mostRecentLastMod = 0;
    for (const c of contacts) {
      const lastAdvert = toEpochSeconds(c.lastAdvert ?? c.lastSeen);
      const lastMod = toEpochSeconds(c.lastSeen ?? c.lastAdvert);
      mostRecentLastMod = Math.max(mostRecentLastMod, lastMod);
      this.send(clientId, encodeContact({
        publicKey: pubKeyHexToBytes(c.publicKey),
        type: c.advType ?? 1,
        flags: 0,
        // OUT_PATH_UNKNOWN (-1) when no cached route, else the hop count.
        outPathLen: c.pathLen == null ? -1 : c.pathLen,
        outPath: c.outPath ? hexToBytes(c.outPath) : Buffer.alloc(0),
        advName: c.advName || c.name || '',
        lastAdvert,
        advLat: degreesToFixed(c.latitude),
        advLon: degreesToFixed(c.longitude),
        lastMod,
      }));
    }
    this.send(clientId, encodeEndOfContacts(mostRecentLastMod));
    logger.info(`[MeshCore VN ${this.sourceId}] ▶ ${contacts.length} contacts to ${clientId}`);
  }

  /** GetChannel(idx) → ChannelInfo from the synced channel list, or Err(NotFound). */
  private async handleGetChannel(clientId: string, channelIdx: number): Promise<void> {
    try {
      const channels = await this.db.channels.getAllChannels(this.sourceId);
      const row = channels.find((ch) => ch.id === channelIdx);
      if (!row) {
        // Tells the app it has reached the end of the configured slots.
        this.send(clientId, encodeErr(ErrorCodes.NotFound));
        return;
      }
      const secret = row.psk ? Buffer.from(row.psk, 'base64') : Buffer.alloc(16);
      this.send(clientId, encodeChannelInfo(channelIdx, row.name || '', secret));
      logger.info(`[MeshCore VN ${this.sourceId}] ▶ channel ${channelIdx} ("${row.name}") to ${clientId}`);
    } catch (err) {
      logger.error(`[MeshCore VN ${this.sourceId}] GetChannel ${channelIdx} failed: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.NotFound));
    }
  }

  /** GetBatteryVoltage → BatteryVoltage from the local node's last telemetry. */
  private handleGetBatteryVoltage(clientId: string): void {
    const mv = this.options.manager.getLocalNode()?.batteryMv ?? 0;
    this.send(clientId, encodeBatteryVoltage(mv));
  }

  /** SyncNextMessage → next queued incoming message, or NoMoreMessages. */
  private handleSyncNextMessage(clientId: string): void {
    const client = this.clients.get(clientId);
    const msg = client?.pendingMessages.shift();
    if (!msg) {
      this.send(clientId, encodeNoMoreMessages());
      return;
    }
    this.send(clientId, this.encodeIncomingMessage(msg));
  }

  /** Default delivery-timeout hint (ms) returned in Sent responses. */
  private readonly SEND_EST_TIMEOUT_MS = 8000;

  /** SendChannelTxtMsg → forward to the real node on the given channel, reply Sent. */
  private async handleSendChannelTxtMsg(clientId: string, cmd: ParsedCommand): Promise<void> {
    const text = cmd.text ?? '';
    const channelIdx = cmd.channelIdx ?? 0;
    try {
      const ok = await this.options.manager.sendMessage(text, undefined, channelIdx);
      if (ok) {
        logger.info(`[MeshCore VN ${this.sourceId}] ▶ forwarded channel ${channelIdx} msg from ${clientId} (${text.length} chars)`);
        // Channel sends have no per-message ACK → no expectedAckCrc.
        this.send(clientId, encodeSent(0, 0, this.SEND_EST_TIMEOUT_MS));
      } else {
        logger.warn(`[MeshCore VN ${this.sourceId}] channel send from ${clientId} failed at the node`);
        this.send(clientId, encodeErr(ErrorCodes.BadState));
      }
    } catch (err) {
      logger.error(`[MeshCore VN ${this.sourceId}] channel send from ${clientId} threw: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.BadState));
    }
  }

  /** SendTxtMsg → resolve the 6-byte prefix to a contact, forward a DM, reply Sent. */
  private async handleSendTxtMsg(clientId: string, cmd: ParsedCommand): Promise<void> {
    const text = cmd.text ?? '';
    const prefixHex = (cmd.pubKeyPrefix ?? Buffer.alloc(0)).toString('hex');
    const fullKey = this.resolveContactKey(prefixHex);
    if (!fullKey) {
      logger.warn(`[MeshCore VN ${this.sourceId}] DM from ${clientId} to unknown contact prefix ${prefixHex}`);
      this.send(clientId, encodeErr(ErrorCodes.NotFound));
      return;
    }
    try {
      const ok = await this.options.manager.sendMessage(text, fullKey);
      if (ok) {
        logger.info(`[MeshCore VN ${this.sourceId}] ▶ forwarded DM from ${clientId} to ${prefixHex}… (${text.length} chars)`);
        this.send(clientId, encodeSent(0, 0, this.SEND_EST_TIMEOUT_MS));
      } else {
        logger.warn(`[MeshCore VN ${this.sourceId}] DM from ${clientId} failed at the node`);
        this.send(clientId, encodeErr(ErrorCodes.BadState));
      }
    } catch (err) {
      logger.error(`[MeshCore VN ${this.sourceId}] DM from ${clientId} threw: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.BadState));
    }
  }

  /** Resolve a (≥6-byte) public-key prefix to a full contact key, or null. */
  private resolveContactKey(prefixHex: string): string | undefined {
    if (!prefixHex) return undefined;
    const lc = prefixHex.toLowerCase();
    return this.options.manager.getContacts().find((c) => c.publicKey?.toLowerCase().startsWith(lc))?.publicKey;
  }

  /**
   * Fan a newly-arrived incoming mesh message out to every connected app
   * client: enqueue it and nudge the app with a MsgWaiting push so it drains
   * via SyncNextMessage. Messages our own node originated are skipped so the
   * app doesn't see its/our own sends echoed back.
   */
  private handleIncomingMessage(msg: MeshCoreMessage): void {
    const selfKey = this.options.manager.getLocalNode()?.publicKey?.toLowerCase();
    if (selfKey && msg.fromPublicKey?.toLowerCase() === selfKey) return;

    for (const [clientId, client] of this.clients.entries()) {
      client.pendingMessages.push(msg);
      this.send(clientId, encodeMsgWaitingPush());
    }
  }

  /** Map a stored MeshCoreMessage to the right recv frame (channel vs direct). */
  private encodeIncomingMessage(msg: MeshCoreMessage): Buffer {
    const senderTimestamp = toEpochSeconds(msg.timestamp);
    const channelMatch = /^channel-(\d+)$/.exec(msg.toPublicKey ?? '');
    if (channelMatch) {
      // Channel packets carry the sender's name inline; reconstruct it so the
      // app renders the originator the way the firmware would deliver it.
      const text = msg.fromName ? `${msg.fromName}: ${msg.text}` : msg.text;
      return encodeChannelMsgRecv({
        channelIdx: Number(channelMatch[1]),
        pathLen: 0xff, // delivered direct (we don't track the relay path here)
        txtType: 0,
        senderTimestamp,
        text,
      });
    }
    return encodeContactMsgRecv({
      pubKeyPrefix: hexToBytes(msg.fromPublicKey).subarray(0, 6),
      pathLen: 0xff,
      txtType: 0,
      senderTimestamp,
      text: msg.text,
    });
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
