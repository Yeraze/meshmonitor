/**
 * MeshCoreNativeBackend — native JS implementation of the MeshCore Companion
 * binary protocol, wrapping `meshcore.js`. Exposes the bridge-shaped command
 * surface that `MeshCoreManager` uses, so the manager delegates
 * `sendBridgeCommand` directly to `sendCommand` here.
 *
 * Transports: USB serial and TCP only. No BLE.
 *
 * NB: The "bridge" naming is preserved from the previous Python-bridge era as
 * the wire vocabulary `meshcoreManager.ts` already speaks; there is no
 * subprocess in this path.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

// Lazy meshcore.js import. Hold the module reference so tests can swap it
// out by calling `__setMeshCoreModule(...)`. The default load path is the
// upstream package; a workspace clone can be aliased via package.json.
type AnyConnection = any;

interface MeshCoreJsModule {
  NodeJSSerialConnection: new (path: string) => AnyConnection;
  TCPConnection: new (host: string, port: number) => AnyConnection;
  Constants: {
    ResponseCodes: Record<string, number>;
    PushCodes: Record<string, number>;
    StatsTypes: { Core: number; Radio: number; Packets: number };
    SelfAdvertTypes: { ZeroHop: number; Flood: number };
    BinaryRequestTypes: { GetTelemetryData: number };
    AdvType: { None: number; Chat: number; Repeater: number; Room: number };
  };
  CayenneLpp: { parse: (bytes: Uint8Array | number[]) => Array<{ channel: number; type: number; value: any }> };
}

let meshcoreJsModulePromise: Promise<MeshCoreJsModule> | null = null;
let injectedModule: MeshCoreJsModule | null = null;

async function loadMeshCoreJs(): Promise<MeshCoreJsModule> {
  if (injectedModule) return injectedModule;
  if (!meshcoreJsModulePromise) {
    meshcoreJsModulePromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — package may not yet be installed; resolved at runtime
      const mod = await import('@liamcottle/meshcore.js');
      return mod as unknown as MeshCoreJsModule;
    })();
  }
  return meshcoreJsModulePromise;
}

/** Test hook: inject a mock meshcore.js module. */
export function __setMeshCoreModule(mod: MeshCoreJsModule | null): void {
  injectedModule = mod;
  meshcoreJsModulePromise = null;
}

export interface NativeBackendConfig {
  connectionType: 'serial' | 'tcp';
  serialPort?: string;
  baudRate?: number;
  tcpHost?: string;
  tcpPort?: number;
}

export interface BridgeShapedResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

/** Bridge-shaped event the manager already knows how to handle. */
export interface BridgeShapedEvent {
  type: 'event';
  event_type: string;
  data: any;
}

// ---------------- helpers ----------------

function bytesToHex(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Manager passes telemetry mode as 'never' | 'device' | 'always'; firmware
 *  wants the underlying 2-bit value (0/1/2). Numeric pass-through is allowed
 *  so callers that already have the encoded value work unchanged. */
function telemetryModeStringToNumber(value: unknown): number {
  if (typeof value === 'number') return value & 0b11;
  if (value === 'never') return 0;
  if (value === 'device') return 1;
  if (value === 'always') return 2;
  throw new Error(`Invalid telemetry mode: ${String(value)}`);
}

/** Convert MeshCore int32 lat/lon (fixed point ×1e6) → decimal degrees, or undefined if zero. */
function fixedToDegrees(v: number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 0) return undefined;
  return v / 1e6;
}

// ---------------- backend ----------------

export class MeshCoreNativeBackend extends EventEmitter {
  public readonly sourceId: string;
  private config: NativeBackendConfig;
  private connection: AnyConnection | null = null;
  private constants: MeshCoreJsModule['Constants'] | null = null;
  private cachedSelfInfo: any = null;
  private connected: boolean = false;
  private commandSeq: number = 0;
  private drainInFlight: boolean = false;

  constructor(sourceId: string, config: NativeBackendConfig) {
    super();
    this.sourceId = sourceId;
    this.config = config;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    const mod = await loadMeshCoreJs();
    this.constants = mod.Constants;

    if (this.config.connectionType === 'tcp') {
      if (!this.config.tcpHost || !this.config.tcpPort) {
        throw new Error('TCP host and port required for native TCP transport');
      }
      this.connection = new mod.TCPConnection(this.config.tcpHost, this.config.tcpPort);
    } else {
      if (!this.config.serialPort) {
        throw new Error('Serial port required for native serial transport');
      }
      this.connection = new mod.NodeJSSerialConnection(this.config.serialPort);
    }

    // Wire all push handlers BEFORE connect — meshcore.js may emit immediately.
    this.wirePushEvents();

    await this.connection.connect();

    // meshcore.js onConnected() does NOT send AppStart automatically —
    // we must explicitly request SelfInfo after the transport is open.
    const selfInfo = await this.connection.getSelfInfo(10_000);
    this.cachedSelfInfo = selfInfo;

    // Listen for connection-side disconnect so callers can react.
    this.connection.on('disconnected', () => {
      this.connected = false;
      this.emit('disconnected');
    });

    this.connected = true;
    logger.info(`[MeshCoreNative:${this.sourceId}] Connected`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.connection) {
      try {
        await this.connection.close?.();
      } catch (err) {
        logger.debug(`[MeshCoreNative:${this.sourceId}] close threw: ${(err as Error).message}`);
      }
      this.connection = null;
    }
    this.cachedSelfInfo = null;
  }

  // ---------------- push event wiring ----------------

  private wirePushEvents(): void {
    if (!this.connection || !this.constants) return;
    const { PushCodes, ResponseCodes } = this.constants;

    // ContactMsgRecv → contact_message
    this.connection.on(ResponseCodes.ContactMsgRecv, (msg: any) => {
      this.emitBridgeEvent('contact_message', {
        pubkey_prefix: bytesToHex(msg.pubKeyPrefix),
        text: msg.text,
        sender_timestamp: msg.senderTimestamp,
        snr: undefined,
      });
    });

    // ChannelMsgRecv → channel_message
    this.connection.on(ResponseCodes.ChannelMsgRecv, (msg: any) => {
      this.emitBridgeEvent('channel_message', {
        channel_idx: msg.channelIdx,
        text: msg.text,
        sender_timestamp: msg.senderTimestamp,
        snr: undefined,
      });
    });

    // NewAdvert (manual-add-contacts mode) carries full advert payload →
    // contact_added is the closer match (python bridge uses NEW_CONTACT for
    // this), but the manager treats contact_added and contact_advertised
    // identically.
    this.connection.on(PushCodes.NewAdvert, (advert: any) => {
      this.emitBridgeEvent('contact_added', this.advertToContactData(advert));
    });

    // Advert (auto-add-contacts mode) carries only publicKey.
    this.connection.on(PushCodes.Advert, (advert: any) => {
      this.emitBridgeEvent('contact_advertised', {
        public_key: bytesToHex(advert.publicKey),
      });
    });

    // PathUpdated → contact_path_updated
    this.connection.on(PushCodes.PathUpdated, (push: any) => {
      this.emitBridgeEvent('contact_path_updated', {
        public_key: bytesToHex(push.publicKey),
      });
    });

    // MsgWaiting → drain via syncNextMessage; meshcore.js does NOT auto-drain
    // the way python-meshcore did. Pulling the messages causes ContactMsgRecv
    // / ChannelMsgRecv to fire normally.
    this.connection.on(PushCodes.MsgWaiting, () => {
      this.drainWaitingMessages();
    });
  }

  private advertToContactData(a: any): Record<string, unknown> {
    return {
      public_key: bytesToHex(a.publicKey),
      adv_name: a.advName,
      adv_type: a.type,
      last_advert: a.lastAdvert,
      latitude: fixedToDegrees(a.advLat),
      longitude: fixedToDegrees(a.advLon),
    };
  }

  private async drainWaitingMessages(): Promise<void> {
    if (this.drainInFlight) return;
    this.drainInFlight = true;
    try {
      while (this.connection) {
        const next = await this.connection.syncNextMessage();
        if (!next) break;
      }
    } catch (err) {
      logger.warn(`[MeshCoreNative:${this.sourceId}] drainWaitingMessages threw: ${(err as Error).message}`);
    } finally {
      this.drainInFlight = false;
    }
  }

  private emitBridgeEvent(eventType: string, data: any): void {
    const evt: BridgeShapedEvent = { type: 'event', event_type: eventType, data };
    this.emit('event', evt);
  }

  // ---------------- command dispatch (bridge-shaped) ----------------

  /**
   * Drop-in replacement for `MeshCoreManager.sendBridgeCommand(cmd, params, timeout)`.
   * Returns a BridgeResponse-shaped object so the rest of MeshCoreManager
   * doesn't need to special-case the transport.
   */
  async sendCommand(cmd: string, params: Record<string, unknown>, timeoutMs: number = 30000): Promise<BridgeShapedResponse> {
    const id = `${++this.commandSeq}`;
    try {
      const data = await this.withTimeout(this.dispatch(cmd, params), timeoutMs, cmd);
      return { id, success: true, data };
    } catch (err) {
      return {
        id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let to: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_resolve, reject) => {
          to = setTimeout(() => reject(new Error(`Native command timeout: ${label}`)), timeoutMs);
        }),
      ]);
    } finally {
      if (to) clearTimeout(to);
    }
  }

  private async dispatch(cmd: string, params: Record<string, unknown>): Promise<any> {
    if (!this.connection || !this.constants) {
      throw new Error('Native backend not connected');
    }
    const c = this.connection;
    const K = this.constants;

    switch (cmd) {
      case 'get_self_info':
        return this.selfInfoToBridgeShape();

      case 'get_contacts': {
        const contacts: any[] = await c.getContacts();
        return contacts.map((ct) => ({
          public_key: bytesToHex(ct.publicKey),
          adv_name: ct.advName,
          name: ct.advName,
          adv_type: ct.type,
          latitude: fixedToDegrees(ct.advLat),
          longitude: fixedToDegrees(ct.advLon),
          last_advert: ct.lastAdvert,
        }));
      }

      case 'send_message': {
        const to = params.to as string | null | undefined;
        const text = String(params.text ?? '');
        if (to) {
          // Direct message: locate the full contact pubkey (DM API needs the
          // full 32-byte public key, not the 6-byte prefix the manager passes).
          const fullKey = await this.resolvePublicKey(to);
          if (!fullKey) {
            throw new Error(`Contact not found for public key ${to.substring(0, 12)}…`);
          }
          await c.sendTextMessage(fullKey, text);
          return { sent: true };
        }
        // Broadcast = channel 0
        await c.sendChannelTextMessage(0, text);
        return { sent: true };
      }

      case 'send_advert':
        await c.sendAdvert(K.SelfAdvertTypes.Flood);
        return { sent: true };

      case 'login': {
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Login target not found');
        await c.login(publicKey, String(params.password ?? ''));
        return { ok: true };
      }

      case 'get_status': {
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Status target not found');
        const stats = await c.getStatus(publicKey);
        return {
          bat_mv: stats?.batt_milli_volts,
          up_secs: stats?.total_up_time_secs,
          tx_power: undefined,
          radio_freq: undefined,
          radio_bw: undefined,
          radio_sf: undefined,
          radio_cr: undefined,
        };
      }

      case 'set_name':
        await c.setAdvertName(String(params.name ?? ''));
        // The cached self-info name is now stale; manager refreshes on its own.
        if (this.cachedSelfInfo) this.cachedSelfInfo.name = String(params.name ?? '');
        return { ok: true };

      case 'set_radio':
        await c.setRadioParams(
          Number(params.freq),
          Number(params.bw),
          Number(params.sf),
          Number(params.cr),
        );
        if (this.cachedSelfInfo) {
          this.cachedSelfInfo.radioFreq = Number(params.freq);
          this.cachedSelfInfo.radioBw = Number(params.bw);
          this.cachedSelfInfo.radioSf = Number(params.sf);
          this.cachedSelfInfo.radioCr = Number(params.cr);
        }
        return { ok: true };

      case 'set_coords':
        await c.setAdvertLatLong(Number(params.lat), Number(params.lon));
        if (this.cachedSelfInfo) {
          this.cachedSelfInfo.advLat = Math.round(Number(params.lat) * 1e6);
          this.cachedSelfInfo.advLon = Math.round(Number(params.lon) * 1e6);
        }
        return { ok: true };

      case 'set_advert_loc_policy': {
        const policy = Number(params.policy);
        await c.setAdvertLocPolicy(policy);
        if (this.cachedSelfInfo) {
          (this.cachedSelfInfo as any).advLocPolicy = policy;
        }
        return { ok: true };
      }

      case 'set_telemetry_mode_base':
      case 'set_telemetry_mode_loc':
      case 'set_telemetry_mode_env': {
        const mode = telemetryModeStringToNumber(params.mode);
        if (cmd === 'set_telemetry_mode_base') {
          await c.setTelemetryModeBase(mode);
          if (this.cachedSelfInfo) (this.cachedSelfInfo as any).telemetryModeBase = mode;
        } else if (cmd === 'set_telemetry_mode_loc') {
          await c.setTelemetryModeLoc(mode);
          if (this.cachedSelfInfo) (this.cachedSelfInfo as any).telemetryModeLoc = mode;
        } else {
          await c.setTelemetryModeEnv(mode);
          if (this.cachedSelfInfo) (this.cachedSelfInfo as any).telemetryModeEnv = mode;
        }
        return { ok: true };
      }

      case 'get_stats': {
        const type = String(params.type ?? 'core');
        const typeCode =
          type === 'radio'
            ? K.StatsTypes.Radio
            : type === 'packets'
              ? K.StatsTypes.Packets
              : K.StatsTypes.Core;
        const response = await c.getStats(typeCode);
        return this.statsResponseToBridgeShape(type, response?.data);
      }

      case 'get_device_time': {
        const response = await c.getDeviceTime();
        return { time: response?.epochSecs ?? null };
      }

      case 'device_query': {
        // SupportedCompanionProtocolVersion = 1
        const info = await c.deviceQuery(1);
        const manuf = (info?.manufacturerModel ?? '') as string;
        return {
          'fw ver': info?.firmwareVer,
          fw_build: info?.firmware_build_date,
          model: manuf,
          ver: info?.firmware_build_date,
        };
      }

      case 'request_telemetry': {
        // TODO: wire to meshcore.js fork helper when available — for now do
        // the binary request manually and decode LPP locally.
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Telemetry target not found');
        const reqType = K.BinaryRequestTypes.GetTelemetryData;
        const responseData: Uint8Array = await c.sendBinaryRequest(publicKey, [reqType]);
        const mod = await loadMeshCoreJs();
        const records = mod.CayenneLpp.parse(responseData);
        return { records };
      }

      case 'get_channels': {
        const list: any[] = await c.getChannels();
        return list.map((ch) => ({
          channel_idx: ch.channelIdx,
          name: typeof ch.name === 'string' ? ch.name : String(ch.name ?? ''),
          secret_hex: ch.secret ? bytesToHex(ch.secret) : '',
        }));
      }

      case 'set_channel': {
        const idx = Number(params.idx);
        const name = String(params.name ?? '');
        const secretHex = String(params.secret_hex ?? '');
        if (!Number.isInteger(idx) || idx < 0 || idx > 255) {
          throw new Error(`Invalid channel index: ${idx}`);
        }
        const secret = Uint8Array.from(hexToBytes(secretHex));
        if (secret.length !== 16) {
          throw new Error(`Channel secret must be 16 bytes, got ${secret.length}`);
        }
        await c.setChannel(idx, name, secret);
        return { ok: true };
      }

      case 'delete_channel': {
        const idx = Number(params.idx);
        if (!Number.isInteger(idx) || idx < 0 || idx > 255) {
          throw new Error(`Invalid channel index: ${idx}`);
        }
        await c.deleteChannel(idx);
        return { ok: true };
      }

      case 'shutdown':
        await this.disconnect();
        return { ok: true };

      case 'ping':
        return { pong: true };

      default:
        throw new Error(`Unknown native command: ${cmd}`);
    }
  }

  // ---------------- selfInfo / contact helpers ----------------

  private selfInfoToBridgeShape(): Record<string, unknown> | null {
    const info = this.cachedSelfInfo;
    if (!info) return null;
    return {
      public_key: bytesToHex(info.publicKey),
      name: info.name,
      adv_type: info.type,
      tx_power: info.txPower,
      max_tx_power: info.maxTxPower,
      radio_freq: info.radioFreq,
      radio_bw: info.radioBw,
      radio_sf: info.radioSf,
      radio_cr: info.radioCr,
      latitude: fixedToDegrees(info.advLat),
      longitude: fixedToDegrees(info.advLon),
      adv_loc_policy: info.advLocPolicy,
      telemetry_mode_base: (info as any).telemetryModeBase,
      telemetry_mode_loc: (info as any).telemetryModeLoc,
      telemetry_mode_env: (info as any).telemetryModeEnv,
    };
  }

  private statsResponseToBridgeShape(type: string, data: any): Record<string, unknown> {
    if (!data) return {};
    if (type === 'core') {
      return {
        battery_mv: data.batteryMilliVolts,
        uptime_secs: data.uptimeSecs,
        queue_len: data.queueLen,
      };
    }
    if (type === 'radio') {
      return {
        noise_floor: data.noiseFloor,
        last_rssi: data.lastRssi,
        last_snr: data.lastSnr,
        tx_air_secs: data.txAirSecs,
        rx_air_secs: data.rxAirSecs,
      };
    }
    if (type === 'packets') {
      return {
        recv: data.recv,
        sent: data.sent,
        flood_tx: data.nSentFlood,
        direct_tx: data.nSentDirect,
        flood_rx: data.nRecvFlood,
        direct_rx: data.nRecvDirect,
        recv_errors: data.nRecvErrors,
      };
    }
    return {};
  }

  /**
   * Resolve a hex public key (full 64-char or 12-char prefix) to the full
   * Uint8Array required by meshcore.js DM-shaped APIs. The manager passes
   * around hex strings, but meshcore.js wants raw bytes.
   */
  private async resolvePublicKey(hexKey: string): Promise<Uint8Array | null> {
    if (!hexKey || !this.connection) return null;
    const normalized = hexKey.toLowerCase();
    // Already full key in hex?
    if (normalized.length === 64) {
      return Uint8Array.from(hexToBytes(normalized));
    }
    // Look up by prefix from the contact list.
    const contacts: any[] = await this.connection.getContacts();
    for (const ct of contacts) {
      const fullHex = bytesToHex(ct.publicKey);
      if (fullHex.startsWith(normalized)) {
        return ct.publicKey instanceof Uint8Array ? ct.publicKey : Uint8Array.from(ct.publicKey);
      }
    }
    return null;
  }
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return out;
}
