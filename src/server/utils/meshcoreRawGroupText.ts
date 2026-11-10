/**
 * Build a complete `CMD_SEND_RAW_PACKET` frame carrying a channel text (GRP_TXT)
 * under an arbitrary sender name (#6282).
 *
 * `CMD_SEND_RAW_PACKET` hands the bytes straight to the radio's send queue: it
 * does not set route bits, add transport codes or mark the packet seen. So the
 * bytes here must already be a finished flood packet, mirroring what
 * `BaseChatMesh::sendGroupMessage` + `sendFloodScoped` would produce:
 *
 *   [0x41][priority=1][header][transport codes 4B if scoped][path_len][payload]
 *
 * header = (PAYLOAD_TYPE_GRP_TXT 0x05 << 2) | route, route 0x00 = transport
 * flood, 0x01 = plain flood. Transport codes are two LE uint16: the HMAC code
 * for the scope key, then 0. `path_len` carries only the hash-size bits (no hops).
 */
import { encodeGroupTextPayload } from './meshcoreGroupEcho.js';
import { computeTransportCodeWithKey } from '../meshcoreScopeResolve.js';
import { MESHCORE_RAW_MAX_BODY_BYTES } from '../../utils/meshcoreMessageLimits.js';

export const CMD_SEND_RAW_PACKET = 65;
export const PAYLOAD_TYPE_GRP_TXT = 0x05;
const ROUTE_TRANSPORT_FLOOD = 0x00;
const ROUTE_FLOOD = 0x01;
/** Firmware priority for GRP_TXT sends (`Mesh.cpp`). */
const GRP_TXT_PRIORITY = 1;
/** `MAX_FRAME_SIZE` in `BaseSerialInterface.h`. Longer frames corrupt silently. */
export const MESHCORE_MAX_FRAME_BYTES = 176;

export interface RawGroupTextInput {
  /** 16-byte channel secret. */
  secret: Uint8Array;
  senderName: string;
  text: string;
  /** Firmware send timestamp (unix seconds). */
  ts: number;
  /** Device path hash mode (0..2). Out of range is clamped to 0..2. */
  pathHashMode: number;
  /** 16-byte scope transport key, or null for an unscoped flood. */
  transportKey: Uint8Array | null;
}

export interface RawGroupTextFrame {
  frame: Buffer;
  payloadHex: string;
  /** `"<name>: <text>"`, the body as the radio will hear it. */
  wireText: string;
}

export class RawFrameTooLargeError extends Error {
  constructor(public readonly bodyBytes: number) {
    super(`raw group text body is ${bodyBytes} bytes; limit is ${MESHCORE_RAW_MAX_BODY_BYTES}`);
    this.name = 'RawFrameTooLargeError';
  }
}

export function buildRawGroupTextFrame(input: RawGroupTextInput): RawGroupTextFrame {
  const { secret, senderName, text, ts, transportKey } = input;
  const wireText = `${senderName}: ${text}`;
  const bodyBytes = Buffer.byteLength(wireText, 'utf8');
  if (bodyBytes > MESHCORE_RAW_MAX_BODY_BYTES) throw new RawFrameTooLargeError(bodyBytes);

  const payloadHex = encodeGroupTextPayload(secret, senderName, text, ts);
  const payload = Buffer.from(payloadHex, 'hex');
  const mode = Math.min(Math.max(Math.trunc(input.pathHashMode) || 0, 0), 2);
  const pathLen = (mode & 3) << 6;

  const parts: Buffer[] = [Buffer.from([CMD_SEND_RAW_PACKET, GRP_TXT_PRIORITY])];
  if (transportKey) {
    parts.push(Buffer.from([(PAYLOAD_TYPE_GRP_TXT << 2) | ROUTE_TRANSPORT_FLOOD]));
    const codes = Buffer.alloc(4);
    codes.writeUInt16LE(computeTransportCodeWithKey(transportKey, PAYLOAD_TYPE_GRP_TXT, payloadHex), 0);
    codes.writeUInt16LE(0, 2);
    parts.push(codes);
  } else {
    parts.push(Buffer.from([(PAYLOAD_TYPE_GRP_TXT << 2) | ROUTE_FLOOD]));
  }
  parts.push(Buffer.from([pathLen]), payload);

  const frame = Buffer.concat(parts);
  if (frame.length > MESHCORE_MAX_FRAME_BYTES) throw new RawFrameTooLargeError(bodyBytes);
  return { frame, payloadHex, wireText };
}
