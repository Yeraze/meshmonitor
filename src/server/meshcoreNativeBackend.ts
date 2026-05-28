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
    TxtTypes: { Plain: number; CliData: number; SignedPlain: number };
  };
  CayenneLpp: { parse: (bytes: Uint8Array | number[]) => Array<{ channel: number; type: number; value: any }> };
  /** OTA packet parser used to recover relay-hash chains from LogRxData. */
  Packet: {
    PAYLOAD_TYPE_TXT_MSG: number;
    fromBytes(bytes: Uint8Array | number[]): {
      payload_type: number;
      pathLen: number;
      path: Uint8Array;
    };
    extractPathHashSize(pathLen: number): number;
    extractPathHashCount(pathLen: number): number;
  };
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

/**
 * Render a MeshCore contact's `out_path` blob into a comma-separated hex
 * chain like "a3,7f,02" (1-byte hashes) or "a37f,02b0" (2-byte hashes).
 * Returns null when the firmware's OUT_PATH_UNKNOWN sentinel (0xFF — or -1
 * if meshcore.js read it as Int8) is set.
 *
 * The wire-format `out_path` field is always a 64-byte buffer; only the
 * first `outPathLen` bytes are meaningful. Each hop occupies `hopHashBytes`
 * bytes (default 1, MeshCore protocol supports 1/2/3). Some firmwares report
 * an inflated `outPathLen` (e.g. the full 64) with trailing 0x00 padding;
 * all-zero hop chunks are skipped and `pathLen` reflects only real hops.
 *
 * Note: MeshCore OTA packets pack hop hash width into the top 2 bits of the
 * single `path_len` byte (`@liamcottle/meshcore.js/src/packet.js`), but
 * contact records read `outPathLen` as a plain Int8 byte count, so we accept
 * the width as an explicit parameter rather than decoding it from outPathLen.
 */
export function formatOutPath(
  outPath: Uint8Array | number[] | null | undefined,
  outPathLen: number | null | undefined,
  hopHashBytes: 1 | 2 | 3 = 1,
): { outPathHex: string | null; pathLen: number | null } {
  if (outPathLen === undefined || outPathLen === null) {
    return { outPathHex: null, pathLen: null };
  }
  // meshcore.js reads out_path_len as Int8, so 0xFF arrives as -1.
  // Treat both representations as the OUT_PATH_UNKNOWN sentinel.
  if (outPathLen < 0 || outPathLen === 0xff) {
    return { outPathHex: null, pathLen: null };
  }
  if (outPathLen === 0) {
    return { outPathHex: '', pathLen: 0 };
  }
  if (!outPath) {
    return { outPathHex: null, pathLen: null };
  }
  const arr = outPath instanceof Uint8Array ? outPath : Uint8Array.from(outPath);
  const take = Math.min(outPathLen, arr.length);
  const hops: string[] = [];
  for (let i = 0; i + hopHashBytes <= take; i += hopHashBytes) {
    let allZero = true;
    let hex = '';
    for (let j = 0; j < hopHashBytes; j++) {
      const b = arr[i + j];
      if (b !== 0) allZero = false;
      hex += b.toString(16).padStart(2, '0');
    }
    if (allZero) continue;
    hops.push(hex);
  }
  return { outPathHex: hops.join(','), pathLen: hops.length };
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

// MeshCore wire protocol uses integer-scaled radio units, but the rest of
// MeshMonitor (UI presets, validation, API contract) speaks MHz / kHz floats.
// Centralize the conversion here so cachedSelfInfo and outbound set_radio
// frames each side of the boundary use their own native units.
//
//   radioFreq : library uses kHz uint32 (e.g. 917375 == 917.375 MHz)
//   radioBw   : library uses Hz  uint32 (e.g. 250000 == 250 kHz, 62500 == 62.5 kHz)
//   radioSf, radioCr : raw integers in both worlds.
function libFreqToMhz(v: number | undefined): number | undefined {
  return typeof v === 'number' ? v / 1000 : v;
}
function libBwToKhz(v: number | undefined): number | undefined {
  return typeof v === 'number' ? v / 1000 : v;
}
function mhzToLibFreq(v: number): number {
  return Math.round(v * 1000);
}
function khzToLibBw(v: number): number {
  return Math.round(v * 1000);
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
  /**
   * Most recent LogRxData-derived TXT_MSG packet metadata. The firmware
   * emits LogRxData immediately before dispatching the txt-msg-specific
   * recv event (ContactMsgRecv / ChannelMsgRecv) for the same packet, so
   * we buffer the parsed path here and consume it on the next message
   * recv to give the bridge event the real relay-hash chain rather than
   * just the packed pathLen byte.
   */
  private pendingTxtMsgPath: { hops: string[]; rawPathLen: number } | null = null;
  /** Constructor reference for the meshcore.js Packet parser, populated when the module loads. */
  private PacketCtor: MeshCoreJsModule['Packet'] | null = null;

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
    this.PacketCtor = mod.Packet ?? null;

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
    this.cachedSelfInfo = {
      ...selfInfo,
      // Normalize wire kHz/Hz to MeshMonitor MHz/kHz so every downstream
      // consumer (selfInfoToBridgeShape → manager → UI) sees consistent units.
      radioFreq: libFreqToMhz(selfInfo?.radioFreq),
      radioBw: libBwToKhz(selfInfo?.radioBw),
    };

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

  /**
   * Pretty-print the relay-hash chain extracted from an OTA `path` field.
   * `pathLen` is the packed wire byte (top 2 bits = hash size index, bottom
   * 6 bits = hop count). Returns an array of lowercase hex strings per
   * hop, or [] if no path is present.
   */
  private decodePathHops(path: Uint8Array, pathLen: number): string[] {
    if (!this.PacketCtor) return [];
    if (pathLen === 0xff) return []; // direct route — no relay hashes
    const hashSize = this.PacketCtor.extractPathHashSize(pathLen);
    const hopCount = this.PacketCtor.extractPathHashCount(pathLen);
    if (hopCount <= 0 || hashSize <= 0) return [];
    const hops: string[] = [];
    for (let i = 0; i < hopCount; i++) {
      const offset = i * hashSize;
      const slice = path.subarray(offset, offset + hashSize);
      if (slice.length === 0) break;
      const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join('');
      hops.push(hex);
    }
    return hops;
  }

  private wirePushEvents(): void {
    if (!this.connection || !this.constants) return;
    const { PushCodes, ResponseCodes } = this.constants;

    // LogRxData: emitted for every received OTA packet (when a serial
    // client is attached). The companion-level txt-msg recv events
    // (ContactMsgRecv / ChannelMsgRecv) strip the relay-hash chain, so
    // we parse the raw bytes here, buffer the path for TXT_MSG packets
    // only, and let the next message-recv handler consume it. The
    // single-buffer design is intentional — under the wire-level
    // serialization the firmware uses, LogRxData is emitted right
    // before the corresponding txt-msg event for the same packet.
    if (typeof PushCodes?.LogRxData === 'number' && this.PacketCtor) {
      const PacketCtor = this.PacketCtor;
      const TXT_MSG = PacketCtor.PAYLOAD_TYPE_TXT_MSG;
      this.connection.on(PushCodes.LogRxData, (rx: any) => {
        try {
          const raw: Uint8Array | undefined = rx?.raw;
          if (!raw || raw.length === 0) return;
          const pkt = PacketCtor.fromBytes(raw);
          if (pkt.payload_type !== TXT_MSG) return;
          const hops = this.decodePathHops(pkt.path, pkt.pathLen);
          this.pendingTxtMsgPath = { hops, rawPathLen: pkt.pathLen };
        } catch {
          // Best-effort: a malformed log line shouldn't break the message stream.
        }
      });
    }

    // ContactMsgRecv → contact_message (plain DM), cli_reply (txtType=CliData),
    // or room_message (txtType=SignedPlain, pushed by a room server).
    // MeshCore overlays its remote-admin CLI on the same TXT_MSG packet type;
    // the only distinguisher is the 1-byte txtType field. Routing the three to
    // separate bridge events keeps CLI output out of the chat log, room posts
    // out of the DM stream, and lets sendCliCommand correlate replies by
    // source pubkey prefix.
    const txtTypes = this.constants.TxtTypes;
    this.connection.on(ResponseCodes.ContactMsgRecv, (msg: any) => {
      const isCliReply =
        txtTypes && typeof msg.txtType === 'number' && msg.txtType === txtTypes.CliData;
      const isRoomPost =
        txtTypes && typeof msg.txtType === 'number' && msg.txtType === txtTypes.SignedPlain;

      if (isRoomPost) {
        // SignedPlain: room server post. The first 4 bytes of the text body
        // are the original author's public-key prefix (raw binary); the
        // remainder is the post text.
        const rawText: string = msg.text ?? '';
        const authorPrefixHex = Array.from(rawText.substring(0, 4))
          .map((ch: string) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('');
        const postBody = rawText.substring(4);

        this.emitBridgeEvent('room_message', {
          room_pubkey_prefix: bytesToHex(msg.pubKeyPrefix),
          author_pubkey_prefix: authorPrefixHex,
          text: postBody,
          sender_timestamp: msg.senderTimestamp,
          snr: undefined,
        });
        return;
      }

      // Consume the path buffered by the preceding LogRxData event (if any).
      // Same-tick consumption: clear the buffer so a subsequent recv that
      // didn't get a matching LogRxData (rare) doesn't reuse stale hops.
      const consumedPath = this.pendingTxtMsgPath;
      this.pendingTxtMsgPath = null;
      const payload = {
        pubkey_prefix: bytesToHex(msg.pubKeyPrefix),
        text: msg.text,
        sender_timestamp: msg.senderTimestamp,
        txt_type: typeof msg.txtType === 'number' ? msg.txtType : undefined,
        // ContactMsgRecv pathLen is the packed wire byte (top 2 bits =
        // hash size - 1, bottom 6 bits = hop count). 0xFF marks "sent
        // direct"; otherwise the hop count is `pathLen & 0x3F`.
        path_len: typeof msg.pathLen === 'number' ? msg.pathLen : undefined,
        // Per-packet relay-hash chain recovered from the preceding
        // LogRxData event (raw OTA bytes). undefined when LogRxData is
        // not available (e.g. backend started without raw logging).
        path_hops: consumedPath?.hops,
        snr: undefined,
      };
      this.emitBridgeEvent(isCliReply ? 'cli_reply' : 'contact_message', payload);
    });

    // ChannelMsgRecv → channel_message
    this.connection.on(ResponseCodes.ChannelMsgRecv, (msg: any) => {
      const consumedPath = this.pendingTxtMsgPath;
      this.pendingTxtMsgPath = null;
      this.emitBridgeEvent('channel_message', {
        channel_idx: msg.channelIdx,
        text: msg.text,
        sender_timestamp: msg.senderTimestamp,
        // Same packed-byte semantics as contact_message above.
        path_len: typeof msg.pathLen === 'number' ? msg.pathLen : undefined,
        path_hops: consumedPath?.hops,
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

    // PathDiscoveryResponse (0x8D) — not in meshcore.js PushCodes, so we
    // intercept raw frames. Contains the bidirectional paths discovered by
    // CMD_SEND_PATH_DISCOVERY_REQ (52). Frame format:
    //   [0x8D] [reserved] [pubkey_prefix 6B] [out_path_len] [out_path...] [in_path_len] [in_path...]
    // path_len is packed: top 2 bits = hash_size-1, bottom 6 = hop_count.
    const PUSH_PATH_DISCOVERY_RESPONSE = 0x8D;
    this.connection.on('rx', (frame: Uint8Array) => {
      if (!frame || frame.length < 2 || frame[0] !== PUSH_PATH_DISCOVERY_RESPONSE) return;
      try {
        let offset = 2; // skip code + reserved
        const pubkeyPrefix = bytesToHex(frame.slice(offset, offset + 6));
        offset += 6;

        const outPathLenRaw = frame[offset++];
        const outHashSize = ((outPathLenRaw >> 6) & 0x03) + 1;
        const outHopCount = outPathLenRaw & 0x3F;
        const outPathBytes = outHopCount * outHashSize;
        const outPath = bytesToHex(frame.slice(offset, offset + outPathBytes));
        offset += outPathBytes;

        const inPathLenRaw = frame[offset++];
        const inHashSize = ((inPathLenRaw >> 6) & 0x03) + 1;
        const inHopCount = inPathLenRaw & 0x3F;
        const inPathBytes = inHopCount * inHashSize;
        const inPath = bytesToHex(frame.slice(offset, offset + inPathBytes));

        this.emitBridgeEvent('path_discovery_response', {
          pubkey_prefix: pubkeyPrefix,
          out_path_len: outHopCount,
          out_path_hex: outPath,
          out_hash_size: outHashSize,
          in_path_len: inHopCount,
          in_path_hex: inPath,
          in_hash_size: inHashSize,
        });
      } catch (err) {
        logger.warn(`[MeshCore:native] Failed to parse 0x8D frame: ${(err as Error).message}`);
      }
    });

    // SendConfirmed → send_confirmed (message ACK with round-trip time)
    this.connection.on(PushCodes.SendConfirmed, (push: any) => {
      this.emitBridgeEvent('send_confirmed', {
        ack_code: push.ackCode,
        round_trip_ms: push.roundTrip,
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
        return contacts.map((ct) => {
          const { outPathHex, pathLen } = formatOutPath(ct.outPath, ct.outPathLen);
          return {
            public_key: bytesToHex(ct.publicKey),
            adv_name: ct.advName,
            name: ct.advName,
            adv_type: ct.type,
            latitude: fixedToDegrees(ct.advLat),
            longitude: fixedToDegrees(ct.advLon),
            last_advert: ct.lastAdvert,
            out_path: outPathHex,
            path_len: pathLen,
          };
        });
      }

      case 'reset_path': {
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Reset-path target not found');
        await c.resetPath(publicKey);
        return { ok: true };
      }

      case 'discover_path': {
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Discover-path target not found');
        if (publicKey.length !== 32) {
          throw new Error(`Expected 32-byte public key, got ${publicKey.length}`);
        }
        // CMD_SEND_PATH_DISCOVERY_REQ (firmware opcode 52) is not in
        // meshcore.js, so we build and send the raw frame directly.
        // Frame format: [52, 0x00, ...pubkey(32 bytes)]
        const frame = new Uint8Array(2 + publicKey.length);
        frame[0] = 52;
        frame[1] = 0x00;
        frame.set(publicKey, 2);
        await new Promise<void>((resolve, reject) => {
          const onSent = () => {
            c.off(this.constants!.ResponseCodes.Sent, onSent);
            c.off(this.constants!.ResponseCodes.Err, onErr);
            resolve();
          };
          const onErr = () => {
            c.off(this.constants!.ResponseCodes.Sent, onSent);
            c.off(this.constants!.ResponseCodes.Err, onErr);
            reject(new Error('Device rejected path discovery request'));
          };
          c.once(this.constants!.ResponseCodes.Sent, onSent);
          c.once(this.constants!.ResponseCodes.Err, onErr);
          c.sendToRadioFrame(frame);
        });
        return { ok: true };
      }

      case 'trace_path': {
        const pathBytes = params.path as Uint8Array | number[] | undefined;
        if (!pathBytes || (Array.isArray(pathBytes) ? pathBytes.length : pathBytes.byteLength) === 0) {
          throw new Error('trace_path requires a non-empty path');
        }
        const path = pathBytes instanceof Uint8Array ? pathBytes : Uint8Array.from(pathBytes);
        const result = await c.tracePath(path, params.extra_timeout as number | undefined);
        return {
          ok: true,
          pathLen: result.pathLen,
          flags: result.flags,
          pathSnrs: Array.from(result.pathSnrs as Uint8Array),
          lastSnr: result.lastSnr,
        };
      }

      case 'share_contact': {
        // Broadcasts the contact's saved advert as a zero-hop frame so
        // nearby nodes can pick it up. Wraps the firmware's
        // CMD_SHARE_CONTACT (companion protocol opcode 16); device does
        // not mutate the contact, it just retransmits the advert.
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Share-contact target not found');
        await c.shareContact(publicKey);
        return { ok: true };
      }

      case 'set_out_path': {
        // Manually push a forwarding route into the device's contact
        // record. Wraps meshcore.js's setContactPath(contact, path),
        // which reads the contact's existing type/flags/name/advert
        // timestamp/lat/lon and only mutates outPath + outPathLen via
        // CMD_ADD_UPDATE_CONTACT (opcode 9). Stale hops silently drop
        // direct sends, so this is gated behind the advanced toggle at
        // the route layer.
        //
        // `out_path` is the parsed Uint8Array of hop hashes (0..64 bytes).
        // Caller is responsible for validating the byte length; we just
        // forward.
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Set-out-path target not found');
        const pathBytes = params.out_path as Uint8Array | number[] | undefined;
        if (!pathBytes) throw new Error('set_out_path requires out_path bytes');
        const path = pathBytes instanceof Uint8Array ? pathBytes : Uint8Array.from(pathBytes);
        if (path.length > 64) {
          throw new Error(`out_path too long: ${path.length} > 64`);
        }
        const contacts: any[] = await c.getContacts();
        const contact = contacts.find((ct) => {
          const hex = bytesToHex(ct.publicKey);
          return hex === bytesToHex(publicKey);
        });
        if (!contact) throw new Error('Set-out-path target not in device contact list');
        await c.setContactPath(contact, path);
        return { ok: true };
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
          const sentResp = await c.sendTextMessage(fullKey, text);
          return {
            sent: true,
            expectedAckCrc: sentResp?.expectedAckCrc ?? null,
            estTimeout: sentResp?.estTimeout ?? null,
          };
        }
        // No recipient → broadcast on a channel. `channel_idx` is optional;
        // historical callers omit it and get channel 0, which the firmware's
        // primary "Public" slot is conventionally bound to. Multi-channel
        // callers (Phase 2 of the channels feature) pass a specific idx.
        const channelIdxRaw = params.channel_idx;
        const channelIdx =
          channelIdxRaw === undefined || channelIdxRaw === null
            ? 0
            : Number(channelIdxRaw);
        if (!Number.isInteger(channelIdx) || channelIdx < 0 || channelIdx > 255) {
          throw new Error(`Invalid channel index: ${channelIdxRaw}`);
        }
        await c.sendChannelTextMessage(channelIdx, text);
        return { sent: true };
      }

      case 'send_advert':
        await c.sendAdvert(K.SelfAdvertTypes.Flood);
        return { sent: true };

      case 'send_cli': {
        // Remote-admin: send a CLI command to a distant node as an encrypted
        // DM with txtType=CliData. The remote runs it through its
        // CommonCLI::handleCommand() handler and replies as a normal contact
        // message — also tagged with txtType=CliData — which we route to
        // 'cli_reply' in the ContactMsgRecv handler above. The send path
        // itself only resolves on the firmware's 'Sent' push; the reply is
        // delivered asynchronously and correlated by the manager.
        const to = params.public_key as string | null | undefined;
        const text = String(params.text ?? '');
        if (!to) {
          throw new Error('send_cli requires public_key');
        }
        if (text.length === 0) {
          throw new Error('send_cli requires non-empty text');
        }
        const fullKey = await this.resolvePublicKey(to);
        if (!fullKey) {
          throw new Error(`Contact not found for public key ${to.substring(0, 12)}…`);
        }
        await c.sendTextMessage(fullKey, text, K.TxtTypes.CliData);
        return { sent: true };
      }

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
          queue_len: stats?.curr_tx_queue_len,
          noise_floor: stats?.noise_floor,
          last_rssi: stats?.last_rssi,
          last_snr: stats?.last_snr,
          packets_recv: stats?.n_packets_recv,
          packets_sent: stats?.n_packets_sent,
          air_time_secs: stats?.total_air_time_secs,
          sent_flood: stats?.n_sent_flood,
          sent_direct: stats?.n_sent_direct,
          recv_flood: stats?.n_recv_flood,
          recv_direct: stats?.n_recv_direct,
          errors: stats?.err_events,
          direct_dups: stats?.n_direct_dups,
          flood_dups: stats?.n_flood_dups,
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

      case 'set_tx_power': {
        const power = Number(params.power);
        await c.setTxPower(power);
        if (this.cachedSelfInfo) {
          this.cachedSelfInfo.txPower = power;
        }
        return { ok: true };
      }

      case 'set_radio': {
        const freqMhz = Number(params.freq);
        const bwKhz = Number(params.bw);
        const sf = Number(params.sf);
        const cr = Number(params.cr);
        // Wire protocol expects integer-scaled units (kHz freq, Hz bw); the
        // library's BufferWriter.writeUInt32LE truncates floats and would
        // otherwise ship a wildly wrong frequency that the device rejects.
        await c.setRadioParams(mhzToLibFreq(freqMhz), khzToLibBw(bwKhz), sf, cr);
        if (this.cachedSelfInfo) {
          this.cachedSelfInfo.radioFreq = freqMhz;
          this.cachedSelfInfo.radioBw = bwKhz;
          this.cachedSelfInfo.radioSf = sf;
          this.cachedSelfInfo.radioCr = cr;
        }
        return { ok: true };
      }

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
        // The upstream meshcore.js library reads the entire remainder of the
        // DeviceInfo frame as `manufacturerModel`. Newer firmware packs the
        // hardware model name and a firmware-version string (e.g. "v1.7.0") as
        // separate NUL-terminated segments into that remainder, so without
        // splitting we'd show both fields concatenated with stray NUL bytes
        // (rendered as unprintable squares) in the Info panel's Model row.
        const rawManuf = (info?.manufacturerModel ?? '') as string;
        const manufParts = rawManuf.split('\u0000').filter((s) => s.length > 0);
        const model = manufParts[0] ?? '';
        const verString = manufParts[1];
        return {
          'fw ver': info?.firmwareVer,
          fw_build: info?.firmware_build_date,
          model,
          ver: verString,
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

      case 'remove_contact': {
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Remove-contact target not found');
        await c.removeContact(publicKey);
        return { ok: true };
      }

      case 'export_contact': {
        const publicKey = params.public_key
          ? await this.resolvePublicKey(params.public_key as string)
          : null;
        const response = await c.exportContact(publicKey ?? undefined);
        return {
          advert_bytes: response?.advertPacketBytes
            ? Array.from(response.advertPacketBytes as Uint8Array)
            : null,
        };
      }

      case 'import_contact': {
        const bytes = params.advert_bytes as number[] | Uint8Array;
        if (!bytes) throw new Error('import_contact requires advert_bytes');
        const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        await c.importContact(arr);
        return { ok: true };
      }

      case 'set_device_time': {
        const epoch = params.epoch as number | undefined;
        if (epoch !== undefined) {
          await c.setDeviceTime(epoch);
        } else {
          await c.syncDeviceTime();
        }
        return { ok: true };
      }

      case 'get_neighbours': {
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Neighbours target not found');
        const count = typeof params.count === 'number' ? params.count : 10;
        const offset = typeof params.offset === 'number' ? params.offset : 0;
        const orderBy = typeof params.order_by === 'number' ? params.order_by : 0;
        const result = await c.getNeighbours(publicKey, count, offset, orderBy, 8);
        return {
          total: result.totalNeighboursCount,
          neighbours: (result.neighbours ?? []).map((n: any) => ({
            public_key_prefix: bytesToHex(n.publicKeyPrefix),
            heard_seconds_ago: n.heardSecondsAgo,
            snr: n.snr,
          })),
        };
      }

      case 'reboot':
        await c.sendCommandReboot();
        return { ok: true };

      case 'export_private_key': {
        const response = await c.exportPrivateKey();
        return {
          private_key: response?.privateKey
            ? bytesToHex(response.privateKey as Uint8Array)
            : null,
        };
      }

      case 'import_private_key': {
        const hexKey = params.private_key as string;
        if (!hexKey || hexKey.length !== 64) throw new Error('import_private_key requires a 64-char hex private key');
        const keyBytes = Uint8Array.from(hexToBytes(hexKey));
        await c.importPrivateKey(keyBytes);
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
