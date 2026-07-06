import { Server, Socket } from 'net';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';
import type { MeshCoreNode, TelemetryMode, MeshCoreContact, MeshCoreMessage } from './meshcoreManager.js';
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
  encodeLogRxData,
  encodeSent,
  encodeSendConfirmed,
  encodeLoginSuccessPush,
  encodeTraceDataPush,
  encodeTelemetryResponsePush,
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
  parseSetAdvertName,
  parseSetRadioParams,
  parseSetTxPower,
  parseSetAdvertLatLon,
  parseSetChannel,
  parseSetOtherParams,
  parseSendLogin,
  parseSendTracePath,
  parseSendTelemetryReq,
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
  /**
   * Send a DM and return the firmware-assigned `expectedAckCrc`/`estTimeout` so
   * the bridge can put the real CRC in the `Sent` response and later correlate
   * the `send_confirmed` push to it (#3869).
   */
  sendMessageWithResult(
    text: string,
    toPublicKey?: string,
    channelIdx?: number,
  ): Promise<{ ok: boolean; expectedAckCrc?: number; estTimeout?: number }>;
  // Config mutations forwarded to the real node when `allowAdminCommands` is on
  // (issue #3904). Units match the manager's own methods: freq MHz, bw kHz,
  // lat/lon decimal degrees. Return false / throw on failure.
  setName(name: string): Promise<boolean>;
  setRadio(freq: number, bw: number, sf: number, cr: number): Promise<boolean>;
  setTxPower(power: number): Promise<boolean>;
  setCoords(lat: number, lon: number): Promise<boolean>;
  setChannel(idx: number, name: string, secretHex: string, scope?: string | null): Promise<void>;
  setOtherParams(params: {
    manualAddContacts: number;
    telemetryModeBase: number;
    telemetryModeLoc: number;
    telemetryModeEnv: number;
    advLocPolicy: number;
  }): Promise<boolean>;
  /** Broadcast a self-advertisement from the physical node (flood). */
  sendAdvert(): Promise<boolean>;
  /**
   * Log in to a remote node with a password (issue #3904). Resolves true when
   * the remote acknowledged the login, false on timeout/failure. An empty
   * password is a valid guest login.
   */
  loginToNode(publicKey: string, password: string): Promise<boolean>;
  /**
   * Trace an explicit path (raw hop hashes) and return the raw SNR results, or
   * null on failure. `lastSnr` is in dB (already /4). Used to relay the app's
   * SendTracePath (issue #3904).
   */
  tracePathRaw(
    path: Uint8Array,
  ): Promise<{ pathSnrs: number[]; lastSnr: number; pathLen: number; flags: number } | null>;
  /**
   * Request LPP telemetry from a remote node and return the RAW Cayenne-LPP
   * bytes (not decoded), or null on failure. Used to relay the app's
   * SendTelemetryReq (issue #3904).
   */
  requestRemoteTelemetryRaw(publicKey: string): Promise<Buffer | null>;
  /** EventEmitter surface — the manager emits 'message' with a MeshCoreMessage. */
  on(event: 'message', listener: (msg: MeshCoreMessage) => void): unknown;
  off(event: 'message', listener: (msg: MeshCoreMessage) => void): unknown;
  /** The manager emits 'send_confirmed' when a sent DM is acked (#3869). */
  on(event: 'send_confirmed', listener: (data: { ackCode: number; roundTripMs: number }) => void): unknown;
  off(event: 'send_confirmed', listener: (data: { ackCode: number; roundTripMs: number }) => void): unknown;
  /**
   * The manager emits 'ota_packet' for every raw OTA packet the node receives
   * (independent of the packet-monitor setting), so the server can bridge it to
   * apps as a LogRxData(0x88) push for packet-feed / channel-finder tools (#3963).
   */
  on(event: 'ota_packet', listener: (data: OtaPacketEvent) => void): unknown;
  off(event: 'ota_packet', listener: (data: OtaPacketEvent) => void): unknown;
}

/**
 * Raw OTA packet the manager surfaces on its 'ota_packet' event. Fields mirror
 * the native backend's bridge payload (snake_case). `raw_hex` is the ENTIRE OTA
 * frame (header + path + payload); `snr` is dB, `rssi` is dBm.
 */
export interface OtaPacketEvent {
  snr?: number | null;
  rssi?: number | null;
  raw_hex?: string | null;
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
  private readonly onManagerSendConfirmed = (data: { ackCode: number; roundTripMs: number }) =>
    this.handleSendConfirmed(data);
  private readonly onManagerOtaPacket = (data: OtaPacketEvent) => this.handleOtaPacket(data);
  /**
   * Pending DM acks: `expectedAckCrc` → clientId of the companion that sent it.
   * Populated when a client sends a DM, consumed when the matching
   * `send_confirmed` arrives so we push the SendConfirmed(0x82) to that client
   * only (#3869). The manager's `send_confirmed` is source-global, so without
   * this map a second companion would see another's confirmation.
   */
  private readonly pendingAcks = new Map<number, string>();

  private readonly MAX_FRAME_BYTES = 4096;
  private readonly CLIENT_TIMEOUT_MS = 300000; // 5 min inactivity
  private readonly CLEANUP_INTERVAL_MS = 60000;

  constructor(options: MeshCoreVirtualNodeServerOptions) {
    super();
    this.options = options;
    this.allowAdminCommands = options.allowAdminCommands ?? false;
    this.db = options.databaseService ?? (databaseService as unknown as ChannelsDb);
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
        // Forward DM delivery acks back to the originating companion (#3869).
        this.options.manager.on('send_confirmed', this.onManagerSendConfirmed);
        // Bridge the raw OTA packet feed to apps as LogRxData(0x88) pushes so
        // packet-feed / channel-finder tools work through the virtual node (#3963).
        this.options.manager.on('ota_packet', this.onManagerOtaPacket);
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
    this.options.manager.off('send_confirmed', this.onManagerSendConfirmed);
    this.options.manager.off('ota_packet', this.onManagerOtaPacket);
    this.pendingAcks.clear();

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
    // Drop any unconfirmed DM acks this client was awaiting so the map doesn't
    // leak entries for acks that will never be claimed (#3869).
    for (const [crc, owner] of this.pendingAcks) {
      if (owner === clientId) this.pendingAcks.delete(crc);
    }
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
    // Per-command trace — useful when debugging app behaviour, but too chatty
    // for production, so keep it at debug.
    logger.debug(
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
        case CommandCodes.SendSelfAdvert:
          // Broadcasting a self-advert is a normal (non-admin) operation on a
          // real node — like sending a message — so it is NOT gated on
          // allowAdminCommands (issue #3904 follow-up). Forward to the physical
          // node and ack; the flood type byte in the payload is ignored since
          // the manager always floods.
          void this.handleSendSelfAdvert(clientId);
          break;
        case CommandCodes.SendLogin:
          // Remote-node authentication (issue #3904). Not gated on
          // allowAdminCommands — logging in is a normal read/unlock step (the
          // real node always accepts it); the *config* commands the app may
          // send afterwards are what the flag gates.
          void this.handleSendLogin(clientId, command);
          break;
        case CommandCodes.SendTracePath:
          // Path trace (issue #3904). Read-only diagnostic — not gated.
          void this.handleSendTracePath(clientId, command);
          break;
        case CommandCodes.SendTelemetryReq:
          // Remote telemetry request (issue #3904). Read-only — not gated.
          void this.handleSendTelemetryReq(clientId, command);
          break;
        // Config-mutating commands (issue #3904): forwarded to the real node
        // only when `allowAdminCommands` is enabled; otherwise the app gets an
        // explicit Err (UnsupportedCmd) instead of a silent hang.
        case CommandCodes.SetAdvertName:
          void this.handleConfigCommand(clientId, command, () => {
            const { name } = parseSetAdvertName(command.payload);
            return this.options.manager.setName(name);
          });
          break;
        case CommandCodes.SetRadioParams:
          void this.handleConfigCommand(clientId, command, () => {
            const { freq, bw, sf, cr } = parseSetRadioParams(command.payload);
            return this.options.manager.setRadio(freq, bw, sf, cr);
          });
          break;
        case CommandCodes.SetTxPower:
          void this.handleConfigCommand(clientId, command, () => {
            const { power } = parseSetTxPower(command.payload);
            return this.options.manager.setTxPower(power);
          });
          break;
        case CommandCodes.SetAdvertLatLon:
          void this.handleConfigCommand(clientId, command, () => {
            const { lat, lon } = parseSetAdvertLatLon(command.payload);
            return this.options.manager.setCoords(lat, lon);
          });
          break;
        case CommandCodes.SetChannel:
          void this.handleConfigCommand(clientId, command, () => {
            const { idx, name, secretHex } = parseSetChannel(command.payload);
            // No scope in the wire frame — pass undefined so the DB scope the
            // user set in MeshMonitor is left untouched (see MESHCORE scope trap).
            return this.options.manager.setChannel(idx, name, secretHex);
          });
          break;
        case CommandCodes.SetOtherParams:
          void this.handleConfigCommand(clientId, command, () =>
            this.options.manager.setOtherParams(parseSetOtherParams(command.payload)),
          );
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

  /**
   * Shared path for config-mutating commands (issue #3904). Gates on
   * `allowAdminCommands`, runs `apply()` (which parses the payload and calls the
   * matching MeshCoreManager method against the real node), and translates the
   * outcome into a companion response:
   *   - admin disabled          → Err(UnsupportedCmd) (explicit, not a silent hang)
   *   - parse failure (throws)  → Err(IllegalArg)
   *   - manager returns false    → Err(BadState)
   *   - manager throws           → Err(BadState)
   *   - success                  → Ok
   * `apply` returns boolean (most setters) or void (setChannel) — void resolves
   * are treated as success.
   */
  private async handleConfigCommand(
    clientId: string,
    command: ParsedCommand,
    apply: () => Promise<boolean | void>,
  ): Promise<void> {
    const name = COMMAND_NAMES[command.code] ?? String(command.code);
    if (!this.allowAdminCommands) {
      logger.debug(
        `[MeshCore VN ${this.sourceId}] ${name} blocked from ${clientId} (allowAdminCommands off)`,
      );
      this.send(clientId, encodeErr(ErrorCodes.UnsupportedCmd));
      return;
    }
    let applied: Promise<boolean | void>;
    try {
      // Payload parsing happens synchronously inside apply() before the manager
      // promise is returned, so a malformed frame throws HERE (→ IllegalArg).
      // Invariant: the parseSet* helpers must stay synchronous, or a parse error
      // would escape this catch and be mis-reported as BadState below.
      applied = apply();
    } catch (parseErr) {
      logger.warn(`[MeshCore VN ${this.sourceId}] ${name} bad payload from ${clientId}: ${(parseErr as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.IllegalArg));
      return;
    }
    try {
      const ok = await applied;
      if (ok === false) {
        logger.warn(`[MeshCore VN ${this.sourceId}] ${name} from ${clientId} not applied by node`);
        this.send(clientId, encodeErr(ErrorCodes.BadState));
        return;
      }
      logger.info(`[MeshCore VN ${this.sourceId}] ${name} from ${clientId} forwarded to node`);
      this.send(clientId, encodeOk());
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] ${name} from ${clientId} failed: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.BadState));
    }
  }

  /**
   * SendSelfAdvert(7): broadcast a self-advertisement from the physical node.
   * Unlike the config setters this is a normal, non-admin operation (a real
   * node accepts it unconditionally), so it is not gated on
   * `allowAdminCommands`. Replies Ok when the node accepted the advert,
   * Err(BadState) if the manager reported failure or threw (issue #3904).
   */
  private async handleSendSelfAdvert(clientId: string): Promise<void> {
    try {
      const ok = await this.options.manager.sendAdvert();
      if (!ok) {
        logger.warn(`[MeshCore VN ${this.sourceId}] SendSelfAdvert from ${clientId} not sent by node`);
        this.send(clientId, encodeErr(ErrorCodes.BadState));
        return;
      }
      logger.info(`[MeshCore VN ${this.sourceId}] SendSelfAdvert from ${clientId} forwarded to node`);
      this.send(clientId, encodeOk());
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendSelfAdvert from ${clientId} failed: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.BadState));
    }
  }

  /** App wait budgets (ms) for round-trip relays before the app gives up. */
  private readonly LOGIN_EST_TIMEOUT_MS = 12000;
  private readonly TRACE_EST_TIMEOUT_MS = 30000;
  private readonly TELEMETRY_EST_TIMEOUT_MS = 30000;

  /**
   * SendLogin(26): authenticate the physical node to a remote node with a
   * password, then relay the result to the app (issue #3904). The app's flow is
   * Sent → LoginSuccess push (correlated by the remote's 6-byte pubkey prefix),
   * so we:
   *   1. reply Sent immediately (arms the app's own timeout via estTimeout),
   *   2. run manager.loginToNode against the real node,
   *   3. on success push LoginSuccess(0x85); on failure emit nothing and let
   *      the app fall back to its estTimeout (mirrors real-node behaviour,
   *      where a failed login simply never produces a success push).
   * Not gated on allowAdminCommands — logging in is a normal unlock step.
   */
  private async handleSendLogin(clientId: string, command: ParsedCommand): Promise<void> {
    let parsed;
    try {
      parsed = parseSendLogin(command.payload);
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendLogin bad payload from ${clientId}: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.IllegalArg));
      return;
    }
    const keyShort = parsed.publicKey.substring(0, 12);
    // Ack first so the app arms its login timeout, then do the round-trip.
    this.send(clientId, encodeSent(0, 0, this.LOGIN_EST_TIMEOUT_MS));
    try {
      const ok = await this.options.manager.loginToNode(parsed.publicKey, parsed.password);
      if (!ok) {
        logger.info(`[MeshCore VN ${this.sourceId}] SendLogin to ${keyShort}… from ${clientId} did not succeed`);
        return;
      }
      const prefix = pubKeyHexToBytes(parsed.publicKey).subarray(0, 6);
      this.send(clientId, encodeLoginSuccessPush(prefix));
      logger.info(`[MeshCore VN ${this.sourceId}] SendLogin to ${keyShort}… from ${clientId} succeeded`);
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendLogin to ${keyShort}… from ${clientId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * SendTracePath(36): trace an explicit path and relay the result (issue
   * #3904). The app's flow is Sent → TraceData push correlated by the `tag`
   * the app itself assigned, so we reply Sent, run the trace against the real
   * node, then echo the app's tag/auth/path back in a TraceData(0x89) push
   * alongside the measured SNRs. On failure we emit nothing (app times out).
   */
  private async handleSendTracePath(clientId: string, command: ParsedCommand): Promise<void> {
    let parsed;
    try {
      parsed = parseSendTracePath(command.payload);
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendTracePath bad payload from ${clientId}: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.IllegalArg));
      return;
    }
    this.send(clientId, encodeSent(0, parsed.tag, this.TRACE_EST_TIMEOUT_MS));
    try {
      const result = await this.options.manager.tracePathRaw(parsed.path);
      if (!result) {
        logger.info(`[MeshCore VN ${this.sourceId}] SendTracePath from ${clientId} got no result`);
        return;
      }
      this.send(clientId, encodeTraceDataPush({
        tag: parsed.tag,
        authCode: parsed.auth,
        flags: parsed.flags,
        pathHashes: parsed.path,
        pathSnrs: result.pathSnrs,
        lastSnr: result.lastSnr,
      }));
      logger.info(`[MeshCore VN ${this.sourceId}] SendTracePath from ${clientId} → ${result.pathSnrs.length} hops, lastSnr=${result.lastSnr}`);
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendTracePath from ${clientId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * SendTelemetryReq(39): request LPP telemetry from a remote node and relay it
   * (issue #3904). The app's flow is Sent → TelemetryResponse push correlated by
   * the remote's 6-byte pubkey prefix, so we reply Sent, fetch the RAW LPP bytes
   * from the real node, then push them verbatim. On failure we emit nothing.
   */
  private async handleSendTelemetryReq(clientId: string, command: ParsedCommand): Promise<void> {
    let parsed;
    try {
      parsed = parseSendTelemetryReq(command.payload);
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendTelemetryReq bad payload from ${clientId}: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.IllegalArg));
      return;
    }
    const keyShort = parsed.publicKey.substring(0, 12);
    this.send(clientId, encodeSent(0, 0, this.TELEMETRY_EST_TIMEOUT_MS));
    try {
      const lpp = await this.options.manager.requestRemoteTelemetryRaw(parsed.publicKey);
      if (!lpp) {
        logger.info(`[MeshCore VN ${this.sourceId}] SendTelemetryReq to ${keyShort}… from ${clientId} got no data`);
        return;
      }
      const prefix = pubKeyHexToBytes(parsed.publicKey).subarray(0, 6);
      this.send(clientId, encodeTelemetryResponsePush(prefix, lpp));
      logger.info(`[MeshCore VN ${this.sourceId}] SendTelemetryReq to ${keyShort}… from ${clientId} → ${lpp.length}B LPP`);
    } catch (err) {
      logger.warn(`[MeshCore VN ${this.sourceId}] SendTelemetryReq to ${keyShort}… from ${clientId} failed: ${(err as Error).message}`);
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
    // Intentionally does NOT gate on isConnected()/localNode (unlike
    // handleAppStart, which replies BadState): the app sends DeviceQuery
    // *before* AppStart, so we must reply even with a cold manager — display
    // fields just fall back to safe defaults below.
    // The DeviceInfo version byte is the *companion protocol* version the app
    // must use to talk to us — NOT the proxied node's firmware version. We only
    // implement v1 frames, so this MUST always be SUPPORTED_COMPANION_PROTOCOL_VERSION.
    //
    // Leaking the real node's `firmwareVer` here (once the manager's background
    // deviceQuery() has cached it) makes the meshcore-flutter app abort the
    // handshake: it sends DeviceQuery *before* AppStart, and on seeing a version
    // it can't reconcile with our v1 wire format it never sends AppStart and
    // drops the socket after ~5s. Before the cache is warm we fell back to v1
    // and the app connected — which is exactly the "works once after restart,
    // then never again" symptom (issue #3705). Build date / model are display
    // strings and stay real so the app shows a faithful identity.
    this.send(clientId, encodeDeviceInfo({
      firmwareVer: SUPPORTED_COMPANION_PROTOCOL_VERSION,
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
    logger.debug(`[MeshCore VN ${this.sourceId}] ▶ ${contacts.length} contacts to ${clientId}`);
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
      logger.debug(`[MeshCore VN ${this.sourceId}] ▶ channel ${channelIdx} ("${row.name}") to ${clientId}`);
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
        // A channel send is a fire-and-forget broadcast — the app's
        // sendChannelTextMessage awaits Ok(0), NOT Sent(6) (which is the
        // DM-with-ack response). Replying Sent here leaves the app's send
        // promise pending forever (the message never shows as sent).
        this.send(clientId, encodeOk());
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
      const result = await this.options.manager.sendMessageWithResult(text, fullKey);
      if (result.ok) {
        logger.info(`[MeshCore VN ${this.sourceId}] ▶ forwarded DM from ${clientId} to ${prefixHex}… (${text.length} chars)`);
        // Carry the firmware's real ack CRC in the Sent response and remember it
        // so the matching send_confirmed pushes a SendConfirmed(0x82) to THIS
        // client — otherwise the app waits for an ack it never gets, retransmits,
        // and marks the DM Failed despite delivery (#3869).
        if (result.expectedAckCrc !== undefined) {
          this.pendingAcks.set(result.expectedAckCrc >>> 0, clientId);
        }
        this.send(
          clientId,
          encodeSent(0, result.expectedAckCrc ?? 0, result.estTimeout ?? this.SEND_EST_TIMEOUT_MS),
        );
      } else {
        logger.warn(`[MeshCore VN ${this.sourceId}] DM from ${clientId} failed at the node`);
        this.send(clientId, encodeErr(ErrorCodes.BadState));
      }
    } catch (err) {
      logger.error(`[MeshCore VN ${this.sourceId}] DM from ${clientId} threw: ${(err as Error).message}`);
      this.send(clientId, encodeErr(ErrorCodes.BadState));
    }
  }

  /**
   * A DM this node sent was acked by the mesh. Push a SendConfirmed(0x82) to the
   * companion that originated it (matched by ack CRC) so the app marks the
   * message delivered instead of retrying to failure (#3869). The manager's
   * `send_confirmed` is source-global, so we act only on a CRC we recorded for a
   * client send; an unknown CRC (e.g. a DM MeshMonitor itself sent, or one whose
   * client has disconnected) is ignored.
   */
  private handleSendConfirmed(data: { ackCode: number; roundTripMs: number }): void {
    const key = data.ackCode >>> 0;
    const clientId = this.pendingAcks.get(key);
    if (clientId === undefined) return;
    this.pendingAcks.delete(key);
    if (!this.clients.has(clientId)) return; // originating client has gone away
    this.send(clientId, encodeSendConfirmed(data.ackCode, data.roundTripMs));
    logger.info(
      `[MeshCore VN ${this.sourceId}] ◀ ack confirmed to ${clientId} (crc=${key}, rtt=${data.roundTripMs}ms)`,
    );
  }

  /**
   * Bridge a raw OTA packet to every connected app as a LogRxData(0x88) push —
   * the diagnostic "packet feed" that channel-finder / packet-cracker tools
   * (e.g. Remote-Terminal-for-MeshCore) consume (#3963). The whole OTA frame is
   * forwarded verbatim; the SNR/RSSI ride the push header. A client with no
   * packet-feed UI simply ignores the frame. Unlike text-message delivery this
   * fans out unconditionally (no self-origin filtering): the feed is meant to
   * mirror everything the radio heard, exactly as a real companion would.
   */
  private handleOtaPacket(data: OtaPacketEvent): void {
    if (this.clients.size === 0) return;
    const raw = hexToBytes(data.raw_hex);
    if (raw.length === 0) return; // nothing to forward (missing/blank raw_hex)
    const frame = encodeLogRxData({ snr: data.snr, rssi: data.rssi, raw });
    for (const clientId of this.clients.keys()) {
      this.send(clientId, frame);
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
    const local = this.options.manager.getLocalNode();
    const selfKey = local?.publicKey?.toLowerCase();
    // Skip DMs our own node originated (echoed back through the manager).
    if (selfKey && msg.fromPublicKey?.toLowerCase() === selfKey) return;
    // Skip our own channel transmissions heard back over the air: channel
    // packets carry no sender key (fromPublicKey is the synthetic `channel-N`),
    // so identify them by the name prefix. The app already shows these
    // optimistically on send — re-delivering would duplicate them.
    if (this.isChannelMessage(msg) && local?.name && msg.fromName === local.name) return;

    for (const [clientId, client] of this.clients.entries()) {
      client.pendingMessages.push(msg);
      this.send(clientId, encodeMsgWaitingPush());
    }
  }

  /** True when the message belongs to a channel (marker in either key field). */
  private isChannelMessage(msg: MeshCoreMessage): boolean {
    return /^channel-\d+$/.test(msg.fromPublicKey ?? '') || /^channel-\d+$/.test(msg.toPublicKey ?? '');
  }

  /** Map a stored MeshCoreMessage to the right recv frame (channel vs direct). */
  private encodeIncomingMessage(msg: MeshCoreMessage): Buffer {
    const senderTimestamp = toEpochSeconds(msg.timestamp);
    // Forward the real packed path_len byte (0xff = direct) so the companion
    // shows the actual hop count instead of always "direct" (#3871). The value
    // is the raw byte the device reported; the app decodes the hop count the
    // same way MeshMonitor does. Falls back to 0xff (direct) when unknown.
    const wirePathLen = msg.pathLen ?? 0xff;
    // The `channel-N` marker lands in toPublicKey for messages we sent and in
    // fromPublicKey for messages we received — check both.
    const channelMatch =
      /^channel-(\d+)$/.exec(msg.toPublicKey ?? '') ?? /^channel-(\d+)$/.exec(msg.fromPublicKey ?? '');
    if (channelMatch) {
      // Channel packets carry the sender's name inline; reconstruct it so the
      // app renders the originator the way the firmware would deliver it.
      const text = msg.fromName ? `${msg.fromName}: ${msg.text}` : msg.text;
      return encodeChannelMsgRecv({
        channelIdx: Number(channelMatch[1]),
        pathLen: wirePathLen,
        txtType: 0,
        senderTimestamp,
        text,
      });
    }
    return encodeContactMsgRecv({
      pubKeyPrefix: hexToBytes(msg.fromPublicKey).subarray(0, 6),
      pathLen: wirePathLen,
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
      manualAddContacts: node.manualAddContacts ?? 0,
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
