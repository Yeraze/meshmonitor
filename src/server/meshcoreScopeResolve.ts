/**
 * MeshCore scope (region) resolution for RECEIVED messages — issue #3742 Phase 2.
 *
 * A MeshCore message can be sent with a "scope" (a.k.a. region): a named
 * forwarding tag that controls which repeaters relay the flood packet. The
 * scope is NOT carried as plaintext on the wire — a TRANSPORT-route packet
 * carries a 16-bit "transport code" that is an HMAC keyed by the scope's
 * transport key over the packet's own payload. So a code cannot be reversed to
 * a name; instead we recompute the code for each scope name we know about and
 * look for the one that matches (exactly what the firmware authors' own
 * Home-Assistant integration does — `match_flood_scope` in meshcore-ha).
 *
 * Derivation (authoritative: firmware `TransportKey::calcTransportCode`):
 *   key  = SHA-256("#" + name).slice(0, 16)
 *   code = HMAC-SHA256(key, [payloadTypeByte, ...payload]).readUInt16LE(0)
 *   then clamp the two reserved values: 0x0000 -> 0x0001, 0xFFFF -> 0xFFFE.
 * Only transport_code_1 is meaningful; transport_code_2 is reserved and the
 * firmware never matches on it.
 */
import { createHash, createHmac } from 'node:crypto';
import { decodeMeshCorePacket, hexToBytes } from '../utils/meshcorePacketDecode.js';

// Route-type nibble values that carry transport codes (i.e. are scoped). These
// mirror the firmware's TransportRoute enum / meshcore.js Packet.ROUTE_TYPE_*:
// FLOOD(0x01) and DIRECT(0x02) carry no transport codes (unscoped); the
// TRANSPORT_* variants prepend the two 16-bit codes. We treat both transport
// variants as scoped — a scoped DM rides TRANSPORT_DIRECT, a scoped flood/
// channel message rides TRANSPORT_FLOOD.
const ROUTE_TYPE_TRANSPORT_FLOOD = 0x00;
const ROUTE_TYPE_TRANSPORT_DIRECT = 0x03;

/**
 * The resolved scope of a received message.
 * - `scopeCode === null`  → no scope information available (room post, serial
 *   backend, uncorrelated packet, or a truncated header).
 * - `scopeCode === 0`     → the packet used a non-transport route, i.e. it was
 *   sent UNSCOPED (the "no scope at all" case). 0 is a safe sentinel because a
 *   real transport code is always clamped into [1, 0xFFFE].
 * - `scopeCode > 0`       → the message was scoped; `scopeName` is the resolved
 *   region name, or `null` when the code matched none of the known scopes.
 */
export interface ResolvedScope {
  scopeCode: number | null;
  scopeName: string | null;
}

/** SHA-256("#" + name) truncated to the first 16 bytes (the scope transport key). */
export function scopeTransportKey(name: string): Buffer {
  return createHash('sha256').update('#' + name, 'utf8').digest().subarray(0, 16);
}

/**
 * Compute the 16-bit transport code a packet with `payloadType` + `payloadHex`
 * would carry if sent under scope `name`. Mirrors the firmware exactly,
 * including the reserved-value clamping.
 */
export function computeTransportCode(name: string, payloadType: number, payloadHex: string): number {
  const key = scopeTransportKey(name);
  const payload = hexToBytes(payloadHex);
  const data = Buffer.concat([Buffer.from([payloadType & 0xff]), Buffer.from(payload)]);
  const digest = createHmac('sha256', key).update(data).digest();
  let code = digest.readUInt16LE(0);
  if (code === 0) code = 1;
  else if (code === 0xffff) code = 0xfffe;
  return code;
}

/**
 * Resolve the scope of a received message from its raw OTA packet hex.
 *
 * `candidateNames` is the set of scope/region names this source knows about
 * (per-channel scopes + the source default scope). Resolution is best-effort:
 * any decode problem yields `{ scopeCode: null, scopeName: null }` rather than
 * throwing, so the message stream is never broken by a malformed packet.
 */
export function resolveMessageScope(
  rawHex: string | null | undefined,
  candidateNames: Iterable<string>,
): ResolvedScope {
  const decoded = decodeMeshCorePacket(rawHex);
  if (!decoded) return { scopeCode: null, scopeName: null };

  const routeType = decoded.header.routeType;
  const isTransport =
    routeType === ROUTE_TYPE_TRANSPORT_FLOOD || routeType === ROUTE_TYPE_TRANSPORT_DIRECT;

  // Non-transport route → the message was sent unscoped (known "no scope").
  if (!isTransport) return { scopeCode: 0, scopeName: null };

  const code1 = decoded.transportCodes?.code1;
  // Transport route but the codes were truncated/unavailable — no usable info.
  if (typeof code1 !== 'number') return { scopeCode: null, scopeName: null };

  const payloadType = decoded.header.payloadType;
  const payloadHex = decoded.payload.hex;
  if (payloadHex) {
    // Linear scan: one HMAC per candidate. The candidate set is a source's known
    // scopes (per-channel scopes + the default scope) — realistically 1–5, a
    // handful at most — so this is trivially cheap on the inbound-message path.
    for (const name of candidateNames) {
      const trimmed = (name || '').trim();
      if (!trimmed) continue;
      if (computeTransportCode(trimmed, payloadType, payloadHex) === code1) {
        return { scopeCode: code1, scopeName: trimmed };
      }
    }
  }

  // Scoped, but none of the known scopes matched — surface the raw code so the
  // UI can show it as `#<hex>` (an unknown scope the user hasn't configured).
  return { scopeCode: code1, scopeName: null };
}
