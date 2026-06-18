/**
 * MeshCore companion-protocol codec — the *device end*.
 *
 * `@liamcottle/meshcore.js` implements the *app/companion* end: it ENCODES the
 * `0x3c` command frames an app sends to a node, and DECODES the `0x3e` response
 * /push frames a node sends back. To act as a virtual MeshCore node (issue
 * #3535) MeshMonitor needs the inverse — DECODE the app's commands and ENCODE
 * the node's responses/pushes.
 *
 * This module is pure protocol: it takes/produces wire-native values (no unit
 * conversion, no DB access) so it can be round-trip tested directly against
 * meshcore.js's own decoders. Byte layouts here are derived by inverting the
 * decoders in `@liamcottle/meshcore.js/src/connection/connection.js` and the
 * command encoders in the same file (meshcore.js v1.13.0).
 *
 * Framing (TCP companion link):
 *   frame = [ frameType:u8 ] [ frameLength:u16 LE ] [ payload:frameLength ]
 *     frameType 0x3c '<'  app  -> node  (commands we READ)
 *     frameType 0x3e '>'  node -> app   (responses/pushes we WRITE)
 *   payload[0] = command / response / push code.
 *
 * Scope: Phase 0 (handshake) implements the encoders/decoders needed to bring
 * a MeshCore app to a "connected, identity shown, empty mailbox" state. Later
 * phases extend the encoders (contacts, message recv, channels) in place.
 */

export const FRAME_APP_TO_NODE = 0x3c; // "<" — frames the app sends us
export const FRAME_NODE_TO_APP = 0x3e; // ">" — frames we send the app

/** Companion protocol version this virtual node speaks (meshcore.js v1.13.0). */
export const SUPPORTED_COMPANION_PROTOCOL_VERSION = 1;

/** Command codes the app sends (subset; full list in meshcore.js Constants). */
export const CommandCodes = {
  AppStart: 1,
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  GetDeviceTime: 5,
  SetDeviceTime: 6,
  SyncNextMessage: 10,
  GetChannel: 31,
  DeviceQuery: 22,
  GetBatteryVoltage: 20,
  GetStats: 56,
} as const;

/** Response codes the node sends back (subset). */
export const ResponseCodes = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  CurrTime: 9,
  NoMoreMessages: 10,
  DeviceInfo: 13,
  ChannelInfo: 18,
} as const;

/** Push codes the node emits on live events (subset). */
export const PushCodes = {
  Advert: 0x80,
  SendConfirmed: 0x82,
  MsgWaiting: 0x83,
} as const;

/** Error codes carried by an Err(1) response. */
export const ErrorCodes = {
  UnsupportedCmd: 1,
  NotFound: 2,
  TableFull: 3,
  BadState: 4,
  FileIoError: 5,
  IllegalArg: 6,
} as const;

// ───────────────────────── framing ─────────────────────────

/**
 * Wrap a response/push payload in a node→app (`0x3e`) frame:
 *   [0x3e][len:u16 LE][payload].
 */
export function frameNodeToApp(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(3);
  header[0] = FRAME_NODE_TO_APP;
  header.writeUInt16LE(payload.length, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

export interface ParsedCommand {
  /** Command code (`payload[0]`). */
  code: number;
  /** The command payload INCLUDING the leading code byte. */
  payload: Buffer;
  // Parsed fields for the handshake commands we act on; undefined otherwise.
  appVer?: number;
  appName?: string;
  appTargetVer?: number;
}

/**
 * Extract complete app→node (`0x3c`) command frames from a rolling buffer.
 * Returns the parsed commands and any trailing partial bytes to retain.
 *
 * Mirrors the resync behaviour of meshcore.js's read loop: a byte that is not
 * a known frame-type marker (or a zero-length frame) is skipped one byte at a
 * time rather than aborting the whole buffer.
 */
export function parseAppFrames(buffer: Buffer): { commands: ParsedCommand[]; rest: Buffer } {
  const commands: ParsedCommand[] = [];
  let buf = buffer;

  const HEADER = 3;
  while (buf.length >= HEADER) {
    const frameType = buf[0];
    // Accept either marker for robustness, but we only ever expect 0x3c here.
    if (frameType !== FRAME_APP_TO_NODE && frameType !== FRAME_NODE_TO_APP) {
      buf = buf.subarray(1);
      continue;
    }

    const frameLength = buf.readUInt16LE(1);
    if (frameLength === 0) {
      buf = buf.subarray(1);
      continue;
    }

    const total = HEADER + frameLength;
    if (buf.length < total) break; // wait for more bytes

    const payload = Buffer.from(buf.subarray(HEADER, total));
    buf = buf.subarray(total);
    commands.push(decodeCommand(payload));
  }

  return { commands, rest: Buffer.from(buf) };
}

/** Decode a command payload (incl. leading code byte) into its known fields. */
export function decodeCommand(payload: Buffer): ParsedCommand {
  const code = payload.length > 0 ? payload[0] : -1;
  const cmd: ParsedCommand = { code, payload };

  switch (code) {
    case CommandCodes.AppStart: {
      // [code][appVer:u8][reserved:6][appName:string]
      if (payload.length >= 2) cmd.appVer = payload[1];
      if (payload.length > 8) cmd.appName = payload.subarray(8).toString('utf8');
      break;
    }
    case CommandCodes.DeviceQuery: {
      // [code][appTargetVer:u8]
      if (payload.length >= 2) cmd.appTargetVer = payload[1];
      break;
    }
    default:
      break;
  }

  return cmd;
}

// ───────────────────────── response encoders ─────────────────────────
// Each returns a payload (response code byte first), NOT yet framed. Wrap with
// frameNodeToApp() before writing to the socket.

export interface SelfInfoWire {
  type: number;
  txPower: number;
  maxTxPower: number;
  /** Node X25519 public key, 32 bytes (padded/truncated to 32 if needed). */
  publicKey: Uint8Array;
  /** Advertised latitude as fixed-point degrees×1e6 (int32). */
  advLat: number;
  /** Advertised longitude as fixed-point degrees×1e6 (int32). */
  advLon: number;
  multiAcks: number;
  advLocPolicy: number;
  /** Packed telemetry-mode byte: base | (loc<<2) | (env<<4). */
  telemetryMode: number;
  manualAddContacts: number;
  /** Radio frequency in wire units (kHz, e.g. 917375 == 917.375 MHz). */
  radioFreq: number;
  /** Radio bandwidth in wire units (Hz, e.g. 250000 == 250 kHz). */
  radioBw: number;
  radioSf: number;
  radioCr: number;
  name: string;
}

/** Encode a SelfInfo(5) response — the reply to AppStart. */
export function encodeSelfInfo(info: SelfInfoWire): Buffer {
  const pubKey = Buffer.alloc(32);
  Buffer.from(info.publicKey).copy(pubKey, 0, 0, 32);

  const nameBytes = Buffer.from(info.name ?? '', 'utf8');
  const fixed = Buffer.alloc(1 + 3 + 32 + 4 + 4 + 4 + 4 + 4 + 2); // up to name
  let o = 0;
  fixed[o++] = ResponseCodes.SelfInfo;
  fixed[o++] = info.type & 0xff;
  fixed[o++] = info.txPower & 0xff;
  fixed[o++] = info.maxTxPower & 0xff;
  pubKey.copy(fixed, o); o += 32;
  fixed.writeInt32LE(info.advLat | 0, o); o += 4;
  fixed.writeInt32LE(info.advLon | 0, o); o += 4;
  fixed[o++] = info.multiAcks & 0xff;
  fixed[o++] = info.advLocPolicy & 0xff;
  fixed[o++] = info.telemetryMode & 0xff;
  fixed[o++] = info.manualAddContacts & 0xff;
  fixed.writeUInt32LE(info.radioFreq >>> 0, o); o += 4;
  fixed.writeUInt32LE(info.radioBw >>> 0, o); o += 4;
  fixed[o++] = info.radioSf & 0xff;
  fixed[o++] = info.radioCr & 0xff;

  return Buffer.concat([fixed.subarray(0, o), nameBytes]);
}

/** Encode a CurrTime(9) response. */
export function encodeCurrTime(epochSecs: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = ResponseCodes.CurrTime;
  b.writeUInt32LE(epochSecs >>> 0, 1);
  return b;
}

export interface DeviceInfoWire {
  firmwareVer: number;
  firmwareBuildDate: string; // e.g. "19 Feb 2025", max 12 incl. null terminator
  manufacturerModel: string; // remainder of frame
}

/** Encode a DeviceInfo(13) response (reply to DeviceQuery). */
export function encodeDeviceInfo(info: DeviceInfoWire): Buffer {
  const head = Buffer.alloc(1 + 1 + 6 + 12); // code + firmwareVer + reserved(6) + cstring(12)
  head[0] = ResponseCodes.DeviceInfo;
  head.writeInt8(info.firmwareVer | 0, 1);
  // reserved[6] left zero
  writeCString(head, 8, info.firmwareBuildDate ?? '', 12);
  const model = Buffer.from(info.manufacturerModel ?? '', 'utf8');
  return Buffer.concat([head, model]);
}

/** Encode a ContactsStart(2) response announcing how many Contact frames follow. */
export function encodeContactsStart(count: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = ResponseCodes.ContactsStart;
  b.writeUInt32LE(count >>> 0, 1);
  return b;
}

/** Encode an EndOfContacts(4) response. */
export function encodeEndOfContacts(mostRecentLastmod: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = ResponseCodes.EndOfContacts;
  b.writeUInt32LE(mostRecentLastmod >>> 0, 1);
  return b;
}

/** Encode a NoMoreMessages(10) response — mailbox drained. */
export function encodeNoMoreMessages(): Buffer {
  return Buffer.from([ResponseCodes.NoMoreMessages]);
}

/** Encode an Ok(0) response. */
export function encodeOk(): Buffer {
  return Buffer.from([ResponseCodes.Ok]);
}

/** Encode an Err(1) response with an optional error code. */
export function encodeErr(errCode?: number): Buffer {
  return errCode === undefined
    ? Buffer.from([ResponseCodes.Err])
    : Buffer.from([ResponseCodes.Err, errCode & 0xff]);
}

/**
 * Pack a per-section telemetry mode triple into the single SelfInfo byte:
 * base (bits 0-1) | loc (bits 2-3) | env (bits 4-5). Mirrors meshcore.js.
 */
export function packTelemetryMode(base = 0, loc = 0, env = 0): number {
  return (base & 0b11) | ((loc & 0b11) << 2) | ((env & 0b11) << 4);
}

// ───────────────────────── helpers ─────────────────────────

/** Write a null-terminated, fixed-width C string (last byte always 0). */
function writeCString(target: Buffer, offset: number, value: string, maxLength: number): void {
  const bytes = Buffer.from(value, 'utf8');
  for (let i = 0; i < maxLength; i++) {
    target[offset + i] = i < maxLength - 1 && i < bytes.length ? bytes[i] : 0;
  }
}

/** Convert a hex public-key string to a 32-byte buffer (tolerant of `0x`/odd input). */
export function pubKeyHexToBytes(hex: string | undefined | null): Buffer {
  const out = Buffer.alloc(32);
  if (!hex) return out;
  const clean = hex.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  Buffer.from(clean.length % 2 === 0 ? clean : clean.slice(0, -1), 'hex').copy(out, 0, 0, 32);
  return out;
}

/** Convert decimal degrees to MeshCore fixed-point (degrees×1e6, int32). */
export function degreesToFixed(deg: number | undefined | null): number {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 0;
  return Math.round(deg * 1e6) | 0;
}

/** Convert MHz to wire frequency units (kHz). */
export function mhzToWireFreq(mhz: number | undefined | null): number {
  return typeof mhz === 'number' && Number.isFinite(mhz) ? Math.round(mhz * 1000) : 0;
}

/** Convert kHz to wire bandwidth units (Hz). */
export function khzToWireBw(khz: number | undefined | null): number {
  return typeof khz === 'number' && Number.isFinite(khz) ? Math.round(khz * 1000) : 0;
}
