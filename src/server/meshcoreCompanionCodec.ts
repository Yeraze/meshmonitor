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

/** Command codes the app sends (mirrors meshcore.js Constants.CommandCodes). */
export const CommandCodes = {
  AppStart: 1,
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  GetDeviceTime: 5,
  SetDeviceTime: 6,
  SendSelfAdvert: 7,
  SetAdvertName: 8,
  AddUpdateContact: 9,
  SyncNextMessage: 10,
  SetRadioParams: 11,
  SetTxPower: 12,
  ResetPath: 13,
  SetAdvertLatLon: 14,
  RemoveContact: 15,
  ShareContact: 16,
  ExportContact: 17,
  ImportContact: 18,
  Reboot: 19,
  GetBatteryVoltage: 20,
  DeviceQuery: 22,
  ExportPrivateKey: 23,
  ImportPrivateKey: 24,
  SendRawData: 25,
  SendLogin: 26,
  SendStatusReq: 27,
  GetChannel: 31,
  SetChannel: 32,
  SendTracePath: 36,
  SetOtherParams: 38,
  SendTelemetryReq: 39,
  SendBinaryReq: 50,
  SetFloodScope: 54,
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
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  CurrTime: 9,
  NoMoreMessages: 10,
  BatteryVoltage: 12,
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
  // Parsed fields for the commands we act on; undefined otherwise.
  appVer?: number;
  appName?: string;
  appTargetVer?: number;
  channelIdx?: number;
  // Send-message fields (SendTxtMsg / SendChannelTxtMsg).
  txtType?: number;
  senderTimestamp?: number;
  pubKeyPrefix?: Buffer;
  text?: string;
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
    case CommandCodes.GetChannel: {
      // [code][channelIdx:u8]
      if (payload.length >= 2) cmd.channelIdx = payload[1];
      break;
    }
    case CommandCodes.SendTxtMsg: {
      // [code][txtType:u8][attempt:u8][senderTimestamp:u32 LE][pubKeyPrefix:6][text…]
      if (payload.length >= 13) {
        cmd.txtType = payload[1];
        cmd.senderTimestamp = payload.readUInt32LE(3);
        cmd.pubKeyPrefix = Buffer.from(payload.subarray(7, 13));
        cmd.text = payload.subarray(13).toString('utf8');
      }
      break;
    }
    case CommandCodes.SendChannelTxtMsg: {
      // [code][txtType:u8][channelIdx:u8][senderTimestamp:u32 LE][text…]
      if (payload.length >= 7) {
        cmd.txtType = payload[1];
        cmd.channelIdx = payload[2];
        cmd.senderTimestamp = payload.readUInt32LE(3);
        cmd.text = payload.subarray(7).toString('utf8');
      }
      break;
    }
    default:
      break;
  }

  return cmd;
}

// ─────────────────────── config-command parsers ───────────────────────
// Parse the app→node config frames the meshcore-flutter app sends so the
// Virtual Node can forward them to the physical node (issue #3904). Each takes
// the raw command payload (leading code byte at offset 0, fields little-endian,
// mirroring meshcore.js's `sendCommandSet*` builders) and throws on a short
// buffer so the dispatcher can reply Err(IllegalArg). Radio/position fields are
// returned in the SAME units MeshCoreManager expects (MHz, kHz, decimal
// degrees), not raw wire units.
//
// Parsers only DECODE + length-check. Range/semantic validation (e.g. LoRa freq
// 100–1000 MHz, tx power 1–22 dBm) lives in the MeshCoreManager setters
// (validateRadioParams, setTxPower, …); a corrupt in-range-typed value that the
// node rejects surfaces to the app as Err(BadState), not a crash here.

export interface SetAdvertNameCmd { name: string; }
export interface SetRadioParamsCmd { freq: number; bw: number; sf: number; cr: number; }
export interface SetTxPowerCmd { power: number; }
export interface SetAdvertLatLonCmd { lat: number; lon: number; }
export interface SetChannelCmd { idx: number; name: string; secretHex: string; }
export interface SetOtherParamsCmd {
  /** Add contacts only on explicit request (1) vs automatically (0). */
  manualAddContacts: number;
  /** Per-section telemetry visibility (2-bit each): 0=off, 1=always, 2=on-request. */
  telemetryModeBase: number;
  telemetryModeLoc: number;
  telemetryModeEnv: number;
  /** Include location in adverts (0/1). */
  advLocPolicy: number;
}

/**
 * SetAdvertName(8): `[code][name: UTF-8, rest of frame]`.
 *
 * No minimum-length guard: a bare `[code]` frame (no name bytes) is intentionally
 * accepted and yields `{ name: '' }` — "clear the advertised name" — rather than
 * throwing. The MeshCoreManager.setName setter sanitizes the value downstream.
 */
export function parseSetAdvertName(payload: Buffer): SetAdvertNameCmd {
  return { name: payload.subarray(1).toString('utf8') };
}

/**
 * SetRadioParams(11): `[code][freq:u32LE][bw:u32LE][sf:u8][cr:u8]`.
 * Wire freq is kHz and bw is Hz; returned in MHz / kHz for MeshCoreManager.setRadio.
 */
export function parseSetRadioParams(payload: Buffer): SetRadioParamsCmd {
  if (payload.length < 11) throw new Error('SetRadioParams: short payload');
  return {
    freq: wireFreqToMhz(payload.readUInt32LE(1)),
    bw: wireBwToKhz(payload.readUInt32LE(5)),
    sf: payload[9],
    cr: payload[10],
  };
}

/** SetTxPower(12): `[code][power:u8]` (dBm). */
export function parseSetTxPower(payload: Buffer): SetTxPowerCmd {
  if (payload.length < 2) throw new Error('SetTxPower: short payload');
  return { power: payload[1] };
}

/** SetAdvertLatLon(14): `[code][lat:i32LE][lon:i32LE]` fixed-point → decimal degrees. */
export function parseSetAdvertLatLon(payload: Buffer): SetAdvertLatLonCmd {
  if (payload.length < 9) throw new Error('SetAdvertLatLon: short payload');
  return {
    lat: fixedToDegrees(payload.readInt32LE(1)),
    lon: fixedToDegrees(payload.readInt32LE(5)),
  };
}

/** SetChannel(32): `[code][idx:u8][name:cstring(32)][secret:16]`; secret returned as hex. */
export function parseSetChannel(payload: Buffer): SetChannelCmd {
  if (payload.length < 1 + 1 + 32 + 16) throw new Error('SetChannel: short payload');
  const idx = payload[1];
  const nameBuf = payload.subarray(2, 34);
  const nul = nameBuf.indexOf(0);
  const name = nameBuf.subarray(0, nul === -1 ? 32 : nul).toString('utf8');
  const secretHex = payload.subarray(34, 50).toString('hex');
  return { idx, name, secretHex };
}

/**
 * Unpack the SetOtherParams/SelfInfo telemetry byte — inverse of
 * {@link packTelemetryMode}. Only bits 0–5 are defined (three 2-bit sections);
 * bits 6–7 are reserved and ignored.
 */
export function unpackTelemetryMode(byte: number): { base: number; loc: number; env: number } {
  return { base: byte & 0b11, loc: (byte >> 2) & 0b11, env: (byte >> 4) & 0b11 };
}

/**
 * SetOtherParams(38): `[code][manualAddContacts:u8][telemetryMode:u8 packed][advLocPolicy:u8]`.
 * The telemetry byte packs three 2-bit sections (base|loc<<2|env<<4).
 */
export function parseSetOtherParams(payload: Buffer): SetOtherParamsCmd {
  if (payload.length < 4) throw new Error('SetOtherParams: short payload');
  const { base, loc, env } = unpackTelemetryMode(payload[2]);
  return {
    manualAddContacts: payload[1],
    telemetryModeBase: base,
    telemetryModeLoc: loc,
    telemetryModeEnv: env,
    advLocPolicy: payload[3],
  };
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

export interface ContactWire {
  /** 32-byte public key. */
  publicKey: Uint8Array;
  type: number;
  flags: number;
  /** Cached out-path hop count; -1 (OUT_PATH_UNKNOWN) when the route is unknown. */
  outPathLen: number;
  /** Out-path hop-hash bytes (≤64); zero-padded to 64 on the wire. */
  outPath: Uint8Array;
  advName: string;
  /** Last advert time, epoch seconds. */
  lastAdvert: number;
  advLat: number;
  advLon: number;
  /** Last-modified time, epoch seconds. */
  lastMod: number;
}

/** Encode a Contact(3) response — one per known contact between ContactsStart/EndOfContacts. */
export function encodeContact(c: ContactWire): Buffer {
  const pubKey = Buffer.alloc(32);
  Buffer.from(c.publicKey).copy(pubKey, 0, 0, 32);
  const outPath = Buffer.alloc(64);
  Buffer.from(c.outPath ?? []).copy(outPath, 0, 0, 64);

  const head = Buffer.alloc(1 + 32 + 1 + 1 + 1 + 64); // code + pubkey + type + flags + outPathLen + outPath
  let o = 0;
  head[o++] = ResponseCodes.Contact;
  pubKey.copy(head, o); o += 32;
  head[o++] = c.type & 0xff;
  head[o++] = c.flags & 0xff;
  head.writeInt8(clampInt8(c.outPathLen), o); o += 1;
  outPath.copy(head, o); o += 64;

  const tail = Buffer.alloc(4 + 4 + 4 + 4); // lastAdvert + advLat + advLon + lastMod
  let t = 0;
  // advName is a fixed 32-byte C string between outPath and lastAdvert.
  const advName = Buffer.alloc(32);
  writeCString(advName, 0, c.advName ?? '', 32);
  tail.writeUInt32LE(c.lastAdvert >>> 0, t); t += 4;
  tail.writeInt32LE(c.advLat | 0, t); t += 4;
  tail.writeInt32LE(c.advLon | 0, t); t += 4;
  tail.writeUInt32LE(c.lastMod >>> 0, t); t += 4;

  return Buffer.concat([head, advName, tail]);
}

/** Encode a ChannelInfo(18) response: index + 32-byte C-string name + 16-byte secret. */
export function encodeChannelInfo(channelIdx: number, name: string, secret: Uint8Array): Buffer {
  const head = Buffer.alloc(1 + 1 + 32);
  head[0] = ResponseCodes.ChannelInfo;
  head[1] = channelIdx & 0xff;
  writeCString(head, 2, name ?? '', 32);
  const key = Buffer.alloc(16);
  Buffer.from(secret ?? []).copy(key, 0, 0, 16);
  return Buffer.concat([head, key]);
}

/** Encode a BatteryVoltage(12) response. */
export function encodeBatteryVoltage(milliVolts: number): Buffer {
  const b = Buffer.alloc(3);
  b[0] = ResponseCodes.BatteryVoltage;
  b.writeUInt16LE(Math.max(0, Math.min(0xffff, Math.round(milliVolts || 0))), 1);
  return b;
}

export interface ContactMsgRecvWire {
  /** First 6 bytes of the sender's public key. */
  pubKeyPrefix: Uint8Array;
  /** Hop count, or 0xFF if delivered direct. */
  pathLen: number;
  /** TxtType (0 = plain, 1 = CLI data, 2 = signed plain). */
  txtType: number;
  senderTimestamp: number;
  text: string;
}

/** Encode a ContactMsgRecv(7) response — an incoming direct message. */
export function encodeContactMsgRecv(m: ContactMsgRecvWire): Buffer {
  const prefix = Buffer.alloc(6);
  Buffer.from(m.pubKeyPrefix ?? []).copy(prefix, 0, 0, 6);
  const head = Buffer.alloc(1 + 6 + 1 + 1 + 4);
  let o = 0;
  head[o++] = ResponseCodes.ContactMsgRecv;
  prefix.copy(head, o); o += 6;
  head[o++] = m.pathLen & 0xff;
  head[o++] = m.txtType & 0xff;
  head.writeUInt32LE(m.senderTimestamp >>> 0, o); o += 4;
  return Buffer.concat([head, Buffer.from(m.text ?? '', 'utf8')]);
}

export interface ChannelMsgRecvWire {
  channelIdx: number;
  pathLen: number;
  txtType: number;
  senderTimestamp: number;
  text: string;
}

/** Encode a ChannelMsgRecv(8) response — an incoming channel message. */
export function encodeChannelMsgRecv(m: ChannelMsgRecvWire): Buffer {
  const head = Buffer.alloc(1 + 1 + 1 + 1 + 4);
  let o = 0;
  head[o++] = ResponseCodes.ChannelMsgRecv;
  head.writeInt8(clampInt8(m.channelIdx), o); o += 1;
  head[o++] = m.pathLen & 0xff;
  head[o++] = m.txtType & 0xff;
  head.writeUInt32LE(m.senderTimestamp >>> 0, o); o += 4;
  return Buffer.concat([head, Buffer.from(m.text ?? '', 'utf8')]);
}

/** Encode a MsgWaiting(0x83) push — tells the app to drain via SyncNextMessage. */
export function encodeMsgWaitingPush(): Buffer {
  return Buffer.from([PushCodes.MsgWaiting]);
}

/**
 * Encode a Sent(6) response — the node's acknowledgement that an outbound
 * message was accepted for transmission. `result` 0 = queued/sent;
 * `expectedAckCrc` (DMs) correlates a later SendConfirmed push; `estTimeout`
 * is the app's hint for how long to wait for delivery.
 */
export function encodeSent(result: number, expectedAckCrc = 0, estTimeout = 0): Buffer {
  const b = Buffer.alloc(1 + 1 + 4 + 4);
  b[0] = ResponseCodes.Sent;
  b.writeInt8(clampInt8(result), 1);
  b.writeUInt32LE(expectedAckCrc >>> 0, 2);
  b.writeUInt32LE(estTimeout >>> 0, 6);
  return b;
}

/**
 * Encode a SendConfirmed(0x82) push — the node telling the app that a DM it
 * sent was delivered (the mesh ACK matched). `ackCode` is the same CRC the app
 * received in the preceding `Sent(6)` response (`expectedAckCrc`), which is how
 * the app correlates this push to its pending message; `roundTripMs` is the
 * measured delivery time. Layout mirrors meshcore.js's decode of this push
 * (`connection.js onSendConfirmedPush`): `[0x82][ackCode:u32LE][roundTrip:u32LE]`.
 */
export function encodeSendConfirmed(ackCode: number, roundTripMs = 0): Buffer {
  const b = Buffer.alloc(1 + 4 + 4);
  b[0] = PushCodes.SendConfirmed;
  b.writeUInt32LE(ackCode >>> 0, 1);
  b.writeUInt32LE(roundTripMs >>> 0, 5);
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

/** Clamp a number to the signed-8-bit range (for int8 wire fields). */
function clampInt8(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-128, Math.min(127, Math.trunc(v)));
}

/** Convert a hex public-key string to a 32-byte buffer (tolerant of `0x`/odd input). */
export function pubKeyHexToBytes(hex: string | undefined | null): Buffer {
  const out = Buffer.alloc(32);
  if (!hex) return out;
  const clean = hex.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  Buffer.from(clean.length % 2 === 0 ? clean : clean.slice(0, -1), 'hex').copy(out, 0, 0, 32);
  return out;
}

/** Decode a loose hex string (any non-hex separators ignored) to bytes. */
export function hexToBytes(hex: string | undefined | null): Buffer {
  if (!hex) return Buffer.alloc(0);
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  return Buffer.from(clean.length % 2 === 0 ? clean : clean.slice(0, -1), 'hex');
}

/** Normalize a timestamp (seconds or milliseconds) to epoch seconds. */
export function toEpochSeconds(v: number | undefined | null): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v > 1e12 ? v / 1000 : v);
}

/** Convert decimal degrees to MeshCore fixed-point (degrees×1e6, int32). */
export function degreesToFixed(deg: number | undefined | null): number {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 0;
  return Math.round(deg * 1e6) | 0;
}

/** Convert MeshCore fixed-point (degrees×1e6, int32) back to decimal degrees. */
export function fixedToDegrees(fixed: number): number {
  return fixed / 1e6;
}

/** Convert MHz to wire frequency units (kHz). */
export function mhzToWireFreq(mhz: number | undefined | null): number {
  return typeof mhz === 'number' && Number.isFinite(mhz) ? Math.round(mhz * 1000) : 0;
}

/** Convert kHz to wire bandwidth units (Hz). */
export function khzToWireBw(khz: number | undefined | null): number {
  return typeof khz === 'number' && Number.isFinite(khz) ? Math.round(khz * 1000) : 0;
}

/** Convert wire frequency units (kHz) to MHz — inverse of {@link mhzToWireFreq}. */
export function wireFreqToMhz(khz: number): number {
  return khz / 1000;
}

/** Convert wire bandwidth units (Hz) to kHz — inverse of {@link khzToWireBw}. */
export function wireBwToKhz(hz: number): number {
  return hz / 1000;
}
