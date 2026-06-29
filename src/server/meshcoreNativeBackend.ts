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
import { createHash } from 'node:crypto';
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
    PAYLOAD_TYPE_GRP_TXT: number;
    fromBytes(bytes: Uint8Array | number[]): {
      payload_type: number;
      payload_type_string?: string;
      route_type?: number;
      route_type_string?: string;
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
 * Note: Both MeshCore OTA packets and companion contact records use the same
 * packed `path_len` byte format: top 2 bits = hash_size−1, bottom 6 bits =
 * hop_count. Callers that read this packed byte (e.g. `get_contacts`) must
 * decode it into a byte count + hash size before calling this function; the
 * function itself treats `outPathLen` as a plain byte count.
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
   * Recent LogRxData-derived TXT_MSG/GRP_TXT packet metadata, oldest-first. The
   * firmware emits LogRxData immediately before dispatching the txt-msg-specific
   * recv event (ContactMsgRecv / ChannelMsgRecv) for the same packet, so we
   * buffer the parsed path here and consume it on the next message recv to give
   * the bridge event the real relay-hash chain (and the raw OTA bytes for scope
   * resolution) rather than just the packed pathLen byte. The RX SNR is carried
   * alongside the path (it only appears on LogRxData, not on the txt-msg recv
   * event) so the message event — and {SNR}/{ROUTE} in auto-ack/auto-responder
   * templates, plus the MeshCore scope/region badge — has it.
   *
   * This is a small FIFO, NOT a single slot. On a busy mesh several text packets
   * can be in flight; with a single slot a second packet's LogRxData clobbered
   * the first's buffer before its recv consumed it, so the first message lost
   * its route/SNR and — most visibly — its scope badge (received-message scope
   * intermittently blank on busy meshes, even though the raw bytes were
   * captured). {@link consumePendingPath} matches by hop count and takes the
   * oldest unconsumed entry, so concurrent packets no longer evict each other.
   */
  private pendingTxtMsgPaths: Array<{ hops: string[]; rawPathLen: number; snr?: number; rawHex?: string; bufferedAt: number }> = [];

  /**
   * Maximum age (ms) of a buffered LogRxData path before we treat it as stale
   * and refuse to attach it to a message-recv event. LogRxData is emitted by
   * the firmware immediately before the matching txt-msg recv for the SAME
   * packet, so the correlated recv lands within the same I/O tick (sub-ms). A
   * buffer older than this window almost certainly belongs to a *different*
   * packet whose recv event never arrived (e.g. a non-TXT packet, or a
   * LogRxData with no following recv), so consuming it would attach the wrong
   * SNR/route to {SNR}/{ROUTE}. 500ms is generous enough to absorb event-loop
   * scheduling jitter while still rejecting genuinely stale buffers — this is
   * a core guard against the intermittent mis-correlation in issue #3589.
   */
  private static readonly PENDING_PATH_MAX_AGE_MS = 500;
  /**
   * Cap on buffered LogRxData entries. The FIFO only holds text-packet metadata
   * for the sub-millisecond gap until the matching recv consumes it (pruned by
   * age on every push/consume), so this is just a backstop against unbounded
   * growth if a burst of LogRxData arrives with no following recv events.
   */
  private static readonly PENDING_PATH_MAX_ENTRIES = 8;
  /** Constructor reference for the meshcore.js Packet parser, populated when the module loads. */
  private PacketCtor: MeshCoreJsModule['Packet'] | null = null;
  /**
   * Correlation tag of the most recent node-discovery request (CMD 55,
   * CTL_TYPE_NODE_DISCOVER_REQ). NODE_DISCOVER_RESP pushes (0x8E) echo the
   * tag; we only surface responses whose tag matches, so stale replies from
   * a prior discovery don't leak into the current one. Each new discovery
   * overwrites this; late matching replies still auto-add (desirable).
   */
  private pendingDiscoverTag: number | null = null;
  /**
   * When true, reply to incoming NODE_DISCOVER_REQ control packets with a
   * zero-hop NODE_DISCOVER_RESP carrying our public key — i.e. make this
   * companion discoverable by others (MeshCore firmware doesn't do this for
   * companions; see issue #1027). Opt-in: it transmits our presence. Set by
   * the manager from the per-source `meshcoreRespondToDiscovery` setting.
   */
  private respondToDiscovery: boolean = false;
  /**
   * Timestamps (ms) of recent discovery responses we've sent, for rate
   * limiting. Mirrors the firmware repeater's "max 4 per 120s" guard so an
   * abusive/looping requester can't make us beacon continuously.
   */
  private discoverRespTimes: number[] = [];

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

  /**
   * Consume the LogRxData path/SNR buffered by the preceding push event,
   * correlating it to the current message-recv event so {SNR}/{ROUTE} only
   * populate from the *matching* packet (issue #3589).
   *
   * The buffer is ALWAYS cleared (single-slot, consume-once) so a later recv
   * that got no LogRxData of its own can't reuse a stale buffer. Two guards
   * decide whether the buffered data is actually attached:
   *
   *  1. Freshness — the buffer must be younger than `PENDING_PATH_MAX_AGE_MS`.
   *     LogRxData fires immediately before its txt-msg recv on the same tick;
   *     an older buffer belongs to a packet whose recv never arrived.
   *  2. hop-count correlation — when the recv event carries its own
   *     `pathLen`, the *hop count* it implies must equal the hop count
   *     decoded from the buffered packet's packed `rawPathLen`. A mismatch
   *     proves the buffer is from a *different* packet and must not be
   *     attached.
   *
   *     NOTE: the two values are NOT the same wire byte. ContactMsgRecv /
   *     ChannelMsgRecv report a PLAIN hop count (0xFF == "sent direct"),
   *     whereas LogRxData's `rawPathLen` is the PACKED OTA byte (top 2 bits
   *     = hash-size-1, bottom 6 bits = hop count). Comparing them raw made
   *     every flood packet using a 2- or 3-byte relay-hash width fail to
   *     correlate, so {ROUTE} resolved to "—" for any routed message
   *     (issue #3710). We decode the packed byte to a hop count first.
   *
   * Returns `{ hops, snr }` to attach, or `undefined` when the buffer is
   * absent, stale, or for a different packet.
   */
  private consumePendingPath(msgPathLen: unknown): { hops: string[]; snr?: number; rawHex?: string } | undefined {
    const now = Date.now();
    // Drop stale entries first — a buffer whose matching recv never arrived
    // would mis-correlate route/SNR/scope if attached to a later message
    // (issue #3589 guard).
    this.pendingTxtMsgPaths = this.pendingTxtMsgPaths.filter(
      (e) => now - e.bufferedAt <= MeshCoreNativeBackend.PENDING_PATH_MAX_AGE_MS,
    );
    if (this.pendingTxtMsgPaths.length === 0) return undefined;

    // Normalize the recv event's pathLen to a plain hop count (0xFF == sent
    // direct == 0 hops). The buffered rawPathLen is the packed OTA byte.
    const msgHopCount =
      typeof msgPathLen === 'number' ? (msgPathLen === 0xff ? 0 : msgPathLen & 0x3f) : null;
    const bufferedHopCount = (rawPathLen: number): number =>
      rawPathLen === 0xff
        ? 0
        : (this.PacketCtor?.extractPathHashCount(rawPathLen) ?? (rawPathLen & 0x3f));

    // Take the OLDEST unconsumed entry whose hop count matches. LogRxData is
    // emitted just before its own recv, so across concurrent packets the oldest
    // hop-matching buffer is this recv's packet. When the recv carries no usable
    // pathLen, fall back to the oldest entry outright (prior single-slot
    // behavior generalized to the FIFO).
    const idx = this.pendingTxtMsgPaths.findIndex(
      (e) =>
        msgHopCount === null ||
        typeof e.rawPathLen !== 'number' ||
        bufferedHopCount(e.rawPathLen) === msgHopCount,
    );
    if (idx === -1) return undefined;

    const [buffered] = this.pendingTxtMsgPaths.splice(idx, 1); // consume-once
    return { hops: buffered.hops, snr: buffered.snr, rawHex: buffered.rawHex };
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
    //
    // We also surface EVERY parsed packet as an `ota_packet` bridge event
    // so the MeshCore Packet Monitor can show full OTA metadata (route
    // type, payload type, relay path, SNR/RSSI, raw bytes). The monitor is
    // opt-in and gated downstream in the manager, so emitting here is cheap.
    if (typeof PushCodes?.LogRxData === 'number' && this.PacketCtor) {
      const PacketCtor = this.PacketCtor;
      const TXT_MSG = PacketCtor.PAYLOAD_TYPE_TXT_MSG;
      // Channel/group messages ride GRP_TXT (0x05), not TXT_MSG (0x02). They
      // surface as ChannelMsgRecv, which also carries a path that {ROUTE}/{SNR}
      // need — so buffer the path for both payload types (issue #3710).
      const GRP_TXT = PacketCtor.PAYLOAD_TYPE_GRP_TXT;
      this.connection.on(PushCodes.LogRxData, (rx: any) => {
        try {
          const raw: Uint8Array | undefined = rx?.raw;
          if (!raw || raw.length === 0) return;
          const pkt = PacketCtor.fromBytes(raw);
          const hops = this.decodePathHops(pkt.path, pkt.pathLen);

          // `lastSnr`/`lastRssi` come from the LogRxData metadata (connection.js).
          // The SNR only appears here, NOT on the subsequent txt-msg recv event,
          // so it must be buffered with the path for the message event to carry
          // it (auto-ack/auto-responder {SNR}).
          const snr = typeof rx?.lastSnr === 'number' ? rx.lastSnr : undefined;
          const rssi = typeof rx?.lastRssi === 'number' ? rx.lastRssi : undefined;

          // Buffer the relay-hash chain + SNR for the next message recv event:
          // TXT_MSG → ContactMsgRecv (DM), GRP_TXT → ChannelMsgRecv (channel).
          // Buffering DMs only was why {ROUTE}/{SNR} worked on DMs but resolved
          // to "—" on hashtag/private channel messages (issue #3710). `bufferedAt`
          // lets the recv handler reject a stale buffer whose matching recv never
          // arrived (issue #3589 mis-correlation guard).
          if (pkt.payload_type === TXT_MSG || pkt.payload_type === GRP_TXT) {
            // Buffer raw_hex too so the message handler can resolve the scope/
            // region the packet was sent under (#3742 Phase 2). Push onto the
            // FIFO (consumed by the matching recv) rather than overwriting a
            // single slot, so concurrent text packets on a busy mesh don't evict
            // each other's route/SNR/scope. Remaining limitation: if LogRxData
            // arrives AFTER its own recv (rare ordering), that packet's buffer is
            // still missed — inherent to the adjacency-buffer design.
            this.pendingTxtMsgPaths.push({ hops, rawPathLen: pkt.pathLen, snr, rawHex: bytesToHex(raw), bufferedAt: Date.now() });
            // Backstop against unbounded growth (recv-less LogRxData bursts).
            if (this.pendingTxtMsgPaths.length > MeshCoreNativeBackend.PENDING_PATH_MAX_ENTRIES) {
              this.pendingTxtMsgPaths.shift();
            }
          }
          this.emitBridgeEvent('ota_packet', {
            payload_type: pkt.payload_type,
            payload_type_string: pkt.payload_type_string,
            route_type: pkt.route_type,
            route_type_string: pkt.route_type_string,
            path_len_raw: pkt.pathLen,
            hop_count: hops.length,
            path_hops: hops,
            snr,
            rssi,
            payload_size: raw.length,
            raw_hex: bytesToHex(raw),
          });
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
        //
        // A room post is still a TXT_MSG on the wire, so the preceding
        // LogRxData buffered a path for it. Consume (and discard) it here so
        // the room post's own buffer can't leak onto the NEXT contact/channel
        // message — that leak attached a stale SNR/route to an unrelated
        // message (part of issue #3589). We don't surface SNR on room posts.
        this.consumePendingPath(msg.pathLen);
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

      // Consume the path buffered by the preceding LogRxData event, correlated
      // to THIS packet (freshness + pathLen match). Returns undefined when the
      // buffer is absent, stale, or for a different packet (issue #3589).
      const consumedPath = this.consumePendingPath(msg.pathLen);
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
        snr: consumedPath?.snr,
        // Raw OTA bytes (from the same preceding LogRxData) so the manager can
        // resolve the scope/region the message was sent under (#3742 Phase 2).
        raw_hex: consumedPath?.rawHex,
      };
      this.emitBridgeEvent(isCliReply ? 'cli_reply' : 'contact_message', payload);
    });

    // ChannelMsgRecv → channel_message
    this.connection.on(ResponseCodes.ChannelMsgRecv, (msg: any) => {
      const consumedPath = this.consumePendingPath(msg.pathLen);
      this.emitBridgeEvent('channel_message', {
        channel_idx: msg.channelIdx,
        text: msg.text,
        sender_timestamp: msg.senderTimestamp,
        // Same packed-byte semantics as contact_message above.
        path_len: typeof msg.pathLen === 'number' ? msg.pathLen : undefined,
        path_hops: consumedPath?.hops,
        snr: consumedPath?.snr,
        // Raw OTA bytes for scope/region resolution (#3742 Phase 2).
        raw_hex: consumedPath?.rawHex,
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

    // ControlData (0x8E, firmware v8+) — not in meshcore.js PushCodes, so we
    // intercept raw frames. Carries the responses to CMD_SEND_CONTROL_DATA
    // (55). We only handle NODE_DISCOVER_RESP here (the active discovery
    // feature: "Discover Nearby Nodes / Repeaters"). Frame format:
    //   [0x8E] [snr×4 int8] [rssi int8] [path_len] [control_payload...]
    // control_payload for a discovery response (from src/Mesh.cpp +
    // examples/simple_repeater/MyMesh.cpp):
    //   [0] CTL_TYPE_NODE_DISCOVER_RESP(0x90) | nodeType(low 4 bits)
    //   [1] responder's inbound SNR (×4)
    //   [2..5] tag (uint32 LE, echoed from our request)
    //   [6..] public key — full 32 bytes when we requested prefix_only=false
    // We request prefix_only=false so we always get a full key (needed to
    // register a real, message-able contact). SNR shown to the user is the
    // companion's inbound SNR (frame[1]) — how well WE hear the responder.
    const PUSH_CONTROL_DATA = 0x8E;
    const CTL_TYPE_NODE_DISCOVER_REQ = 0x80;
    const CTL_TYPE_NODE_DISCOVER_RESP = 0x90;
    this.connection.on('rx', (frame: Uint8Array) => {
      if (!frame || frame.length < 5 || frame[0] !== PUSH_CONTROL_DATA) return;
      const ctlByte = frame[4];
      if (typeof ctlByte !== 'number') return;
      const ctlType = ctlByte & 0xf0;

      // Inbound discovery REQUEST — another node is asking who's nearby. The
      // firmware forwards it to us but does NOT auto-answer for companions, so
      // we reply ourselves (opt-in) to become discoverable. See #1027.
      if (ctlType === CTL_TYPE_NODE_DISCOVER_REQ) {
        this.handleDiscoverRequest(frame);
        return;
      }

      if (ctlType !== CTL_TYPE_NODE_DISCOVER_RESP) return;
      try {
        const snr = (frame[1] << 24 >> 24) / 4; // int8 → signed, ×4 scaled
        const nodeType = ctlByte & 0x0f;
        // tag is uint32 LE at control_payload offset 2 → frame offset 6
        const tag =
          (frame[6] | (frame[7] << 8) | (frame[8] << 16) | (frame[9] << 24)) >>> 0;
        if (this.pendingDiscoverTag === null || tag !== this.pendingDiscoverTag) return;

        // public key follows the tag (control_payload offset 6 → frame offset 10)
        const keyBytes = frame.slice(10);
        if (keyBytes.length < 32) {
          logger.warn(
            `[MeshCore:native] DISCOVER_RESP pubkey too short (${keyBytes.length}B); ` +
            `prefix_only response cannot be auto-added`,
          );
          return;
        }
        const publicKeyBytes = keyBytes.slice(0, 32);
        const publicKey = bytesToHex(publicKeyBytes);

        // Auto-add a GENUINELY NEW node to the DEVICE contact store so it's
        // actually message-able and survives the next refreshContacts() (a
        // MeshMonitor-only mirror would be clobbered by the device's list). A
        // discovery response carries no name/position/path, so a new contact is
        // added with an empty name + flood path (outPathLen 0xFF) and the device
        // learns the route later.
        //
        // CRITICAL: we must NOT re-add an EXISTING contact. addOrUpdateContact
        // overwrites ALL of a contact's fields, so re-adding a known node with an
        // empty name wipes its stored name on the device — and a later
        // refreshContacts() mirrors the nameless entry into MeshMonitor (bug:
        // "Discover Repeaters erased the node name"). An existing contact is
        // already message-able and survives a refresh, so we simply skip it.
        // Best-effort + async so rx parsing isn't blocked.
        const c = this.connection;
        if (c) {
          void (async () => {
            try {
              const existing: any[] = await c.getContacts();
              if (existing.some((ct) => bytesToHex(ct.publicKey) === publicKey)) return;
              await c.addOrUpdateContact(publicKeyBytes, nodeType, 0, 0xff, new Uint8Array(64), '', 0, 0, 0);
            } catch (err) {
              logger.warn(`[MeshCore:native] discover auto-add failed for ${publicKey.substring(0, 16)}…: ${(err as Error).message}`);
            }
          })();
        }

        this.emitBridgeEvent('node_discovered', {
          public_key: publicKey,
          adv_type: nodeType,
          snr,
        });
      } catch (err) {
        logger.warn(`[MeshCore:native] Failed to parse 0x8E discover frame: ${(err as Error).message}`);
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

  /**
   * Enable/disable replying to inbound discovery requests (being discoverable).
   * Driven by the manager from the per-source `meshcoreRespondToDiscovery`
   * setting.
   */
  setRespondToDiscovery(enabled: boolean): void {
    this.respondToDiscovery = enabled;
  }

  /**
   * Reply to an inbound NODE_DISCOVER_REQ (0x8E control push) with a zero-hop
   * NODE_DISCOVER_RESP carrying our public key, so the requester discovers us.
   * Mirrors the firmware repeater's responder, but for our companion node.
   *
   * REQ frame: [0x8E][our inbound SNR×4][rssi][path_len]
   *            [ctl=0x80|prefix_only][filter][tag(4 LE)][since(4 LE, optional)]
   * RESP we send via CMD_SEND_CONTROL_DATA (55):
   *   [55][0x90|selfType][our inbound SNR×4][tag(4 LE)][pubkey (32B, or 8B if prefix_only)]
   *
   * Gated on the opt-in flag, a type-filter match, and a 4-per-120s rate limit.
   */
  private handleDiscoverRequest(frame: Uint8Array): void {
    if (!this.respondToDiscovery) return;
    const c = this.connection;
    const selfKey: Uint8Array | undefined = this.cachedSelfInfo?.publicKey;
    if (!c || !selfKey || selfKey.length < 32) return;

    try {
      const prefixOnly = (frame[4] & 0x01) !== 0;
      const filter = frame[5];
      const selfType = (typeof this.cachedSelfInfo?.type === 'number'
        ? this.cachedSelfInfo.type
        : (this.constants?.AdvType.Chat ?? 1)) & 0x0f;
      // Only respond if the requester asked for our node type.
      if ((filter & (1 << selfType)) === 0) return;

      // Rate limit: max 4 responses per 120s (matches firmware).
      const now = Date.now();
      this.discoverRespTimes = this.discoverRespTimes.filter((t) => now - t < 120_000);
      if (this.discoverRespTimes.length >= 4) {
        logger.debug('[MeshCore:native] discovery response rate-limited');
        return;
      }
      this.discoverRespTimes.push(now);

      const inboundSnrByte = frame[1]; // echo the SNR we heard the request at
      const keyLen = prefixOnly ? 8 : 32;
      // [55, ctl, snr, tag(4), pubkey(keyLen)]
      const out = new Uint8Array(3 + 4 + keyLen);
      out[0] = 55; // CMD_SEND_CONTROL_DATA
      out[1] = (0x90 | selfType) & 0xff; // CTL_TYPE_NODE_DISCOVER_RESP | type
      out[2] = inboundSnrByte & 0xff;
      out[3] = frame[6]; out[4] = frame[7]; out[5] = frame[8]; out[6] = frame[9]; // tag
      out.set(selfKey.slice(0, keyLen), 7);
      c.sendToRadioFrame(out);
      logger.debug(
        `[MeshCore:native] Responded to discovery (type=${selfType}, prefix_only=${prefixOnly})`,
      );
    } catch (err) {
      logger.warn(`[MeshCore:native] Failed to answer discovery request: ${(err as Error).message}`);
    }
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

  /**
   * Serializes "radio operations" that listen on UNCORRELATED device channels
   * on THIS connection — i.e. raw-frame commands whose only completion signal is
   * the shared, tag-less `Ok` / `Sent` / `Err` ack (discover_path, discover_nodes,
   * request_regions, set_device_time), and/or the shared `PUSH_CODE_BINARY_RESPONSE`
   * (0x8C) push (request_regions, request_telemetry). None of these carry a
   * correlation tag we can match on (CMD_SEND_ANON_REQ (57) via sendToRadioFrame
   * emits a Sent with a real expectedAckCrc, but the repeater's BinaryResponse
   * tag doesn't echo it — different tagging scheme from SendBinaryReq (50)), so
   * each handler grabs the *first* event it sees on its channel. If two such ops
   * overlap, one consumes the other's ack/reply — a stray `Err` false-rejects a
   * discovery, or a telemetry CayenneLPP body gets parsed as a region list.
   * Chaining them on a single per-instance promise guarantees exactly one is
   * listening at a time (#3722, #3725).
   *
   * This is a unified lock (issue #3725, option 2): one chain covers both the
   * command-ack window and the 0x8C reply window so there is a single mental
   * model. The tradeoff is that these admin/discovery/telemetry ops serialize
   * against each other on a connection; that is acceptable since they are
   * infrequent and short (the only long holder is request_regions' BinaryResponse
   * wait, which it must hold anyway to keep request_telemetry from stealing its
   * reply).
   *
   * The chain is an instance field, so it is inherently per-source: each source
   * owns its own MeshCoreNativeBackend (and physical connection), so this never
   * serializes across sources — only same-connection ops wait on each other. The
   * lock is held until the operation's own listeners tear down (bounded by each
   * op's internal timeout, or sendCommand's outer withTimeout), so it always
   * releases.
   *
   * NOTE: this does not lock *library* commands (e.g. send_message via
   * sendTextMessage), which can still emit an `Err` on the shared channel. The
   * fragile handlers above guard against that where they can — request_regions
   * ignores `Err` once `Sent` has arrived, so its multi-second reply wait is not
   * exposed to a foreign `Err`; the discover_nodes, discover_path and
   * set_device_time ack windows are sub-millisecond.
   */
  private radioOpChain: Promise<unknown> = Promise.resolve();

  private runExclusiveRadioOp<T>(fn: () => Promise<T>): Promise<T> {
    // Run after whatever is already queued, regardless of how it settled
    // (using `fn` for both handlers means a prior rejection still releases us).
    const run = this.radioOpChain.then(fn, fn);
    // Advance the chain to this op's completion. Swallow settlement here so the
    // chain never carries an unhandled rejection — the caller still receives
    // `run` (and its rejection) directly.
    this.radioOpChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Serializes remote status requests (library `getStatus`) on THIS connection
   * and dedupes concurrent requests for the same contact.
   *
   * The vendored meshcore.js `getStatus()` registers a `.once` listener on the
   * SHARED, tag-less `StatusResponse` push event and only keeps the response
   * whose `pubKeyPrefix` matches the request. When multiple `getStatus` calls
   * are in flight on one connection, a single arriving `StatusResponse` fires
   * EVERY pending once-listener: the matching one resolves, while all the others
   * log `"onStatusResponsePush is not for this status request, ignoring..."`,
   * get consumed by `.once`, and then hang until their own timeout. That is the
   * self-amplifying log burst + spurious timeouts in #3815 — cannibalized
   * requests pile up while new ones keep arriving from the repeater stats panel.
   *
   * Fix: only one status request may listen at a time. Distinct contacts chain
   * through a per-instance promise (so the second waits for the first to settle),
   * and concurrent requests for the SAME contact share the single in-flight
   * promise instead of issuing a second request.
   *
   * Per-instance (per-source/per-connection) by construction — each source owns
   * its own backend + physical connection, so this never serializes across
   * sources. The lock always releases (the in-flight entry is cleared in a
   * `finally`, and the chain advances regardless of how the op settled), so a
   * reject/timeout in one request never wedges the queue.
   */
  private statusOpChain: Promise<unknown> = Promise.resolve();
  private inFlightStatus = new Map<string, Promise<any>>();

  private getStatusSerialized(connection: AnyConnection, publicKey: Uint8Array): Promise<any> {
    const keyHex = bytesToHex(publicKey);

    // In-flight dedupe: a concurrent request for the same contact shares the
    // single outstanding StatusResponse request instead of issuing a second.
    const existing = this.inFlightStatus.get(keyHex);
    if (existing) return existing;

    // Serialize distinct requests so only one StatusResponse listener is active
    // at a time. Chain after whatever is queued, regardless of how it settled
    // (using the same fn for both handlers means a prior rejection still
    // releases the queue).
    const issue = () => connection.getStatus(publicKey);
    const tracked = this.statusOpChain.then(issue, issue).finally(() => {
      this.inFlightStatus.delete(keyHex);
    });
    // Advance the chain to this op's completion. Swallow settlement here so the
    // chain never carries an unhandled rejection — callers still receive
    // `tracked` (and its rejection) directly.
    this.statusOpChain = tracked.then(() => {}, () => {});
    this.inFlightStatus.set(keyHex, tracked);
    return tracked;
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
          // ct.outPathLen is the packed wire byte (same format as OTA path_len):
          // top 2 bits = hash_size−1, bottom 6 bits = hop_count. Decode it so
          // formatOutPath receives a plain byte count + the correct hop width.
          // Negative values and 0 fall through to formatOutPath unchanged
          // (it handles 0 as "direct" and negatives as OUT_PATH_UNKNOWN).
          const rawLen = ct.outPathLen as number;
          let hopHashBytes: 1 | 2 | 3 = 1;
          let outPathByteCount: number | null | undefined = rawLen;
          if (rawLen != null && rawLen > 0) {
            hopHashBytes = (((rawLen >> 6) & 0x03) + 1) as 1 | 2 | 3;
            outPathByteCount = (rawLen & 0x3F) * hopHashBytes;
          }
          const { outPathHex, pathLen } = formatOutPath(ct.outPath, outPathByteCount, hopHashBytes);
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
        // Serialize the Sent/Err command-ack window against other radio ops on
        // this connection — see runExclusiveRadioOp.
        await this.runExclusiveRadioOp(() => new Promise<void>((resolve, reject) => {
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
        }));
        return { ok: true };
      }

      case 'discover_nodes': {
        // CMD_SEND_CONTROL_DATA (firmware opcode 55, v8+) with a
        // CTL_TYPE_NODE_DISCOVER_REQ control payload. Not in meshcore.js, so
        // we build the raw frame. The firmware sends this zero-hop, so only
        // nodes in DIRECT radio range hear it and respond (also zero-hop).
        // Frame: [55, control_type, filter, tag(4B LE)]
        //   control_type = 0x80 (NODE_DISCOVER_REQ); bit 0 = prefix_only.
        //   We leave bit 0 clear so responders return their FULL public key.
        //   filter = bitmask of (1 << ADV_TYPE) selecting which node types reply.
        // Responses arrive asynchronously as 0x8E pushes (see wirePushEvents).
        const filter = Number(params.filter) & 0xff;
        const tag = (Number(params.tag) >>> 0) || 0;
        const frame = new Uint8Array(2 + 1 + 4);
        frame[0] = 55; // CMD_SEND_CONTROL_DATA
        frame[1] = 0x80; // CTL_TYPE_NODE_DISCOVER_REQ, prefix_only = false
        frame[2] = filter;
        frame[3] = tag & 0xff;
        frame[4] = (tag >>> 8) & 0xff;
        frame[5] = (tag >>> 16) & 0xff;
        frame[6] = (tag >>> 24) & 0xff;
        // The firmware acks CMD_SEND_CONTROL_DATA with an OK frame (not Sent).
        // Serialize the Ok/Err command-ack window against other radio ops on
        // this connection — see runExclusiveRadioOp.
        await this.runExclusiveRadioOp(() => new Promise<void>((resolve, reject) => {
          // Set the pending tag inside the lock, right before sending, so a
          // discovery queued behind a running one can't clobber its tag while
          // the running one's 0x8E responses are still arriving.
          this.pendingDiscoverTag = tag;
          const onOk = () => {
            c.off(this.constants!.ResponseCodes.Ok, onOk);
            c.off(this.constants!.ResponseCodes.Err, onErr);
            resolve();
          };
          const onErr = () => {
            c.off(this.constants!.ResponseCodes.Ok, onOk);
            c.off(this.constants!.ResponseCodes.Err, onErr);
            reject(new Error('Device rejected node discovery request'));
          };
          c.once(this.constants!.ResponseCodes.Ok, onOk);
          c.once(this.constants!.ResponseCodes.Err, onErr);
          c.sendToRadioFrame(frame);
        }));
        return { ok: true };
      }

      case 'request_regions': {
        // Ask a repeater/room-server for its allowed region/scope list (#3667
        // phase 3). Sends CMD_SEND_ANON_REQ (57) with the "regions" sub-type
        // (0x01); the node replies with PUSH_CODE_BINARY_RESPONSE (0x8C)
        // carrying clock(4 LE) + a NUL-terminated, comma-separated ASCII list
        // of region names (the wildcard '*' is the legacy null region). This
        // command isn't in meshcore.js, so we build the raw frame and match the
        // reply by tag, mirroring the library's sendBinaryRequest().
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey || publicKey.length !== 32) {
          throw new Error('request_regions: repeater public key not found');
        }
        const timeoutMs = Number(params.timeout_ms) || 15_000;
        const K = this.constants!;
        // Frame: [57][pubkey:32][0x01 regions][0x00 reply_path_len → flood reply]
        const frame = new Uint8Array(1 + 32 + 2);
        frame[0] = 57; // CMD_SEND_ANON_REQ
        frame.set(publicKey, 1);
        frame[33] = 0x01; // ANON_REQ_TYPE_REGIONS
        frame[34] = 0x00; // reply_path_len = 0

        // Serialize the Sent/Err ack AND the 0x8C reply window against other
        // radio ops on this connection — see runExclusiveRadioOp.
        const responseData: Uint8Array = await this.runExclusiveRadioOp(() => new Promise<Uint8Array>((resolve, reject) => {
          let sentReceived = false;
          let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            cleanup();
            reject(new Error('request_regions timed out'));
          }, timeoutMs);
          const onSent = (_r: any) => {
            sentReceived = true;
          };
          const onResp = (r: any) => {
            // Wait for the Sent ack before accepting any BinaryResponse.
            if (!sentReceived) return;
            // No tag check: CMD_SEND_ANON_REQ (57) uses sendToRadioFrame, and
            // the Sent ack's expectedAckCrc does NOT match the BinaryResponse's
            // tag (ANON_REQ uses a different tagging scheme than SendBinaryReq
            // (50)). The runExclusiveRadioOp lock serializes all radio ops so
            // the first BinaryResponse after Sent is guaranteed to be ours
            // (#3734).
            cleanup();
            resolve((r?.responseData ?? new Uint8Array()) as Uint8Array);
          };
          const onErr = () => {
            // An Err pertains to OUR send only until the device acks it with
            // Sent. Once Sent has arrived, any Err on this shared, tag-less
            // channel belongs to a different command (incl. unlocked library
            // commands like send_message) — ignore it so a foreign failure can't
            // false-reject our multi-second BinaryResponse wait (#3725).
            if (sentReceived) return;
            cleanup();
            reject(new Error('Device rejected regions request'));
          };
          function cleanup() {
            if (timer) { clearTimeout(timer); timer = null; }
            c.off(K.ResponseCodes.Sent, onSent);
            c.off(K.PushCodes.BinaryResponse, onResp);
            c.off(K.ResponseCodes.Err, onErr);
          }
          // Sent: `once` — exactly one Sent ack per frame send.
          // BinaryResponse: `on` (not `once`) so the listener isn't consumed
          // before our actual reply arrives; cleanup removes it on resolve/fail.
          c.once(K.ResponseCodes.Sent, onSent);
          c.on(K.PushCodes.BinaryResponse, onResp);
          c.once(K.ResponseCodes.Err, onErr);
          void c.sendToRadioFrame(frame);
        }));

        // Parse: clock(4 LE) + NUL-terminated, comma-separated ASCII names.
        const buf = Buffer.from(responseData);
        const clock = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
        let end = buf.indexOf(0, 4);
        if (end < 0) end = buf.length;
        const namesStr = buf.length > 4 ? buf.toString('ascii', 4, end) : '';
        // Defense-in-depth on top of the 0x8C serialization: a genuine regions
        // reply is printable ASCII. If a stray non-regions binary payload ever
        // reached us, its control/high bytes would survive the split — drop any
        // such token rather than render garbage region chips.
        const regions = namesStr
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && /^[\x20-\x7e]+$/.test(s));
        return { ok: true, clock, regions };
      }

      case 'request_owner': {
        // Ask a repeater/room-server for its node name via an UNAUTHENTICATED
        // ANON_REQ OWNER (sub-type 0x02) — firmware simple_repeater
        // `handleAnonOwnerReq` replies with PUSH_CODE_BINARY_RESPONSE (0x8C)
        // carrying clock(4 LE) + "node_name\nowner_info" (NUL-terminated ASCII).
        // Same tag-less transport as request_regions (above); the OWNER branch is
        // likewise gated on `packet->isRouteDirect()`, so callers must install a
        // direct out_path first (see meshcoreManager.fetchOwnerName). This is the
        // no-admin path to a discovered repeater's name (#3820).
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey || publicKey.length !== 32) {
          throw new Error('request_owner: repeater public key not found');
        }
        const timeoutMs = Number(params.timeout_ms) || 15_000;
        const K = this.constants!;
        // Frame: [57][pubkey:32][0x02 owner][0x00 reply_path_len → flood reply]
        const frame = new Uint8Array(1 + 32 + 2);
        frame[0] = 57; // CMD_SEND_ANON_REQ
        frame.set(publicKey, 1);
        frame[33] = 0x02; // ANON_REQ_TYPE_OWNER
        frame[34] = 0x00; // reply_path_len = 0

        // Serialize the Sent/Err ack AND the 0x8C reply window against other
        // radio ops on this connection (mirrors request_regions; #3725/#3734).
        const responseData: Uint8Array = await this.runExclusiveRadioOp(() => new Promise<Uint8Array>((resolve, reject) => {
          let sentReceived = false;
          let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            cleanup();
            reject(new Error('request_owner timed out'));
          }, timeoutMs);
          const onSent = (_r: any) => {
            sentReceived = true;
          };
          const onResp = (r: any) => {
            if (!sentReceived) return;
            cleanup();
            resolve((r?.responseData ?? new Uint8Array()) as Uint8Array);
          };
          const onErr = () => {
            if (sentReceived) return;
            cleanup();
            reject(new Error('Device rejected owner request'));
          };
          function cleanup() {
            if (timer) { clearTimeout(timer); timer = null; }
            c.off(K.ResponseCodes.Sent, onSent);
            c.off(K.PushCodes.BinaryResponse, onResp);
            c.off(K.ResponseCodes.Err, onErr);
          }
          c.once(K.ResponseCodes.Sent, onSent);
          c.on(K.PushCodes.BinaryResponse, onResp);
          c.once(K.ResponseCodes.Err, onErr);
          void c.sendToRadioFrame(frame);
        }));

        // Parse: clock(4 LE) + NUL-terminated "node_name\nowner_info" (ASCII).
        // The companion strips the firmware's leading 4-byte sender_timestamp
        // tag (same as regions), so the host payload begins at the clock.
        const buf = Buffer.from(responseData);
        const clock = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
        let end = buf.indexOf(0, 4);
        if (end < 0) end = buf.length;
        const ownerStr = buf.length > 4 ? buf.toString('utf8', 4, end) : '';
        // First line is the node name; the rest is free-form owner_info. Keep
        // only printable chars so a stray binary payload can't render garbage.
        const name = ownerStr.split('\n')[0].trim();
        const cleanName = /^[\x20-\x7e]+$/.test(name) ? name : '';
        return { ok: true, clock, name: cleanName };
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
        try {
          await c.shareContact(publicKey);
        } catch (err) {
          // meshcore.js rejects this promise with NO argument when the firmware
          // returns an Err response (connection.js shareContact onErr → reject()),
          // so `err` is typically undefined. Surface an actionable message
          // instead of letting `String(undefined)` propagate up the chain.
          const detail = err instanceof Error ? err.message : err == null ? '' : String(err);
          throw new Error(
            detail
              ? `Device rejected share-contact: ${detail}`
              : 'Device rejected share-contact — the firmware may not support CMD_SHARE_CONTACT (opcode 16)',
            { cause: err },
          );
        }
        return { ok: true };
      }

      case 'set_out_path': {
        // Manually push a forwarding route into the device's contact
        // record via CMD_ADD_UPDATE_CONTACT (opcode 9). Stale hops silently
        // drop direct sends, so this is gated behind the advanced toggle at
        // the route layer.
        //
        // `out_path` is the parsed Uint8Array of hop hashes
        // (hop_count * hash_bytes, 0..64 bytes). `hash_bytes` (1/2/3) is the
        // per-hop hash width; the firmware stores it packed in the top 2
        // bits of out_path_len (= ((hash_bytes-1)<<6) | hop_count) — the
        // same encoding it uses for OTA packets. meshcore.js's
        // setContactPath() only ever writes a PLAIN byte count (correct only
        // for 1-byte hops), so for 2/3-byte widths we bypass it and call
        // addOrUpdateContact() directly with a hand-packed length. Caller is
        // responsible for validating lengths; we just forward.
        const publicKey = await this.resolvePublicKey(params.public_key as string);
        if (!publicKey) throw new Error('Set-out-path target not found');
        const pathBytes = params.out_path as Uint8Array | number[] | undefined;
        if (!pathBytes) throw new Error('set_out_path requires out_path bytes');
        const path = pathBytes instanceof Uint8Array ? pathBytes : Uint8Array.from(pathBytes);
        if (path.length > 64) {
          throw new Error(`out_path too long: ${path.length} > 64`);
        }
        const hashBytesRaw = params.hash_bytes;
        const hashBytes = hashBytesRaw === 2 || hashBytesRaw === 3 ? hashBytesRaw : 1;
        if (path.length % hashBytes !== 0) {
          throw new Error(`out_path length ${path.length} not a multiple of hash_bytes ${hashBytes}`);
        }
        const contacts: any[] = await c.getContacts();
        const contact = contacts.find((ct) => {
          const hex = bytesToHex(ct.publicKey);
          return hex === bytesToHex(publicKey);
        });
        if (!contact) throw new Error('Set-out-path target not in device contact list');
        if (hashBytes === 1) {
          // Default width: keep the proven library path (its plain byte
          // count == packed length when the hash-size bits are 0).
          await c.setContactPath(contact, path);
        } else {
          // Multi-byte width: pack out_path_len ourselves.
          const hopCount = path.length / hashBytes;
          const packedLen = path.length === 0 ? 0 : (((hashBytes - 1) << 6) | (hopCount & 0x3f));
          const outPath = new Uint8Array(64);
          outPath.set(path.subarray(0, Math.min(path.length, 64)));
          await c.addOrUpdateContact(
            contact.publicKey,
            contact.type,
            contact.flags,
            packedLen,
            outPath,
            contact.advName,
            contact.lastAdvert,
            contact.advLat,
            contact.advLon,
          );
        }
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

      case 'set_flood_scope': {
        // MeshCore region/scope (#3667). The device holds a single global flood
        // scope (CMD_SET_FLOOD_SCOPE=54); the manager asserts it before each
        // send. The transport key is the first 16 bytes of sha256("#region").
        // An empty/null region clears the scope (back to legacy null '*').
        const regionRaw = params.region;
        const region = typeof regionRaw === 'string' ? regionRaw.trim() : '';
        if (!region) {
          await c.clearFloodScope();
          return { ok: true, scope: null };
        }
        const name = region.startsWith('#') ? region : `#${region}`;
        const transportKey = createHash('sha256').update(name, 'utf8').digest().subarray(0, 16);
        await c.setFloodScope(Uint8Array.from(transportKey));
        return { ok: true, scope: region };
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
        // Serialize + dedupe on this connection: the library's getStatus listens
        // on the shared, tag-less StatusResponse event with a `.once` handler, so
        // overlapping requests cannibalize each other's response and spam the
        // "ignoring..." log until they time out (#3815).
        const stats = await this.getStatusSerialized(c, publicKey);
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

      case 'set_coords': {
        const latFixed = Math.round(Number(params.lat) * 1e6);
        const lonFixed = Math.round(Number(params.lon) * 1e6);
        await c.setAdvertLatLong(latFixed, lonFixed);
        if (this.cachedSelfInfo) {
          this.cachedSelfInfo.advLat = latFixed;
          this.cachedSelfInfo.advLon = lonFixed;
        }
        return { ok: true };
      }

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
        // Serialize the 0x8C reply window against other radio ops on this
        // connection — see runExclusiveRadioOp. The library's own
        // sendBinaryRequest tag-matches its reply, but our raw-frame regions
        // request can't, so the two must not overlap.
        const responseData: Uint8Array = await this.runExclusiveRadioOp(
          () => c.sendBinaryRequest(publicKey, [reqType]),
        );
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
        // meshcore.js's setDeviceTime()/syncDeviceTime() reject with NO argument
        // on an `Err` response, which surfaces upstream as the literal string
        // "undefined" (issue #3570). Drive the command ourselves with the same
        // descriptive Ok/Err idiom used by discover_nodes so a device rejection
        // produces an actionable error instead of `undefined`.
        const epoch = (params.epoch as number | undefined) ?? Math.floor(Date.now() / 1000);
        logger.debug(`[MeshCoreNative:${this.sourceId}] set_device_time → epoch=${epoch}`);
        // Resolution depends on the radio emitting Ok or Err. A synchronous
        // send failure propagates via `.catch(reject)`; if the firmware never
        // answers at all, the outer `withTimeout` wrapper in sendCommand() is
        // the only safety net (surfacing a generic timeout). Same structure as
        // discover_nodes / discover_path — serialize the Ok/Err command-ack
        // window against other radio ops on this connection (see
        // runExclusiveRadioOp) so a concurrent command's Err can't false-reject.
        await this.runExclusiveRadioOp(() => new Promise<void>((resolve, reject) => {
          const onOk = () => {
            c.off(this.constants!.ResponseCodes.Ok, onOk);
            c.off(this.constants!.ResponseCodes.Err, onErr);
            resolve();
          };
          const onErr = () => {
            c.off(this.constants!.ResponseCodes.Ok, onOk);
            c.off(this.constants!.ResponseCodes.Err, onErr);
            reject(new Error('device returned Err to set_device_time (firmware may not support setting the RTC over this transport)'));
          };
          c.once(this.constants!.ResponseCodes.Ok, onOk);
          c.once(this.constants!.ResponseCodes.Err, onErr);
          c.sendCommandSetDeviceTime(epoch).catch(reject);
        }));
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
        if (!hexKey || hexKey.length !== 128) throw new Error('import_private_key requires a 128-char hex private key');
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
