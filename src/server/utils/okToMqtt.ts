/**
 * `ok_to_mqtt` tri-state evaluator (#4114).
 *
 * Extracted from the formerly-private `MqttBridgeManager.evaluateOkToMqtt`
 * (`src/server/mqttBridgeManager.ts:482-499` prior to this change) so the
 * same bit-0 logic can serve two callers with opposite failure semantics:
 *
 * - **Uplink gate** (`MqttBridgeManager.evaluateOkToMqtt`, via
 *   {@link allowsUplink}): fail-closed. An `'unknown'` result must NOT be
 *   republished upstream — this preserves the original evaluator's
 *   behavior byte-for-byte.
 * - **Violation detection** ({@link detectOkToMqttViolation}): NOT
 *   fail-closed. `'unknown'` means "suspected", never a confirmed
 *   violation — a gateway that couldn't be proven to have violated the bit
 *   must not be flagged as if it had.
 *
 * Mirrors firmware `MQTT::onSend` (MQTT.cpp:767-788), which checks bit 0 of
 * `Data.bitfield` before relaying a packet to the configured broker.
 */

import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import { channelDecryptionService } from '../services/channelDecryptionService.js';

/**
 * Tri-state result of resolving a packet's `ok_to_mqtt` preference.
 *
 * - `'yes'` — bit 0 of `Data.bitfield` is set: originator opted in to MQTT relay.
 * - `'no'` — bit 0 is explicitly clear: originator opted out.
 * - `'unknown'` — the bit could not be read (field absent, or the packet is
 *   encrypted and could not be decrypted).
 */
export type OkToMqttState = 'yes' | 'no' | 'unknown';

/**
 * Read the `ok_to_mqtt` bit (bit 0) out of a raw `Data.bitfield` value.
 * Pure. Mirrors firmware `MQTT::onSend` (MQTT.cpp:767-788), which treats a
 * clear or absent bit as "do not uplink" (#4114).
 *
 * @param bitfield Raw `Data.bitfield` (protobuf field 9), or
 *   `undefined`/`null` when the field wasn't present on the wire.
 * @returns `'unknown'` when `bitfield` is not a finite number; otherwise
 *   `'yes'` when bit 0 is set, `'no'` when it is clear.
 */
export function readBitfieldOkToMqtt(bitfield: number | null | undefined): OkToMqttState {
  if (typeof bitfield !== 'number' || !Number.isFinite(bitfield)) return 'unknown';
  return ((bitfield >>> 0) & 0x1) === 1 ? 'yes' : 'no';
}

/**
 * Resolve the `ok_to_mqtt` tri-state for one ServiceEnvelope reception.
 *
 * Reproduces the control flow of the original
 * `MqttBridgeManager.evaluateOkToMqtt` exactly (#4114):
 *
 *  1. `packet.decoded.bitfield` is a number → {@link readBitfieldOkToMqtt}.
 *  2. Else, when `packet.encrypted` plus a numeric `packet.id` and
 *     `packet.from` are all present → attempt
 *     `channelDecryptionService.tryDecrypt(enc, id, from, channelHash)`;
 *     success with a numeric `bitfield` → {@link readBitfieldOkToMqtt} on
 *     it, otherwise → `'unknown'`.
 *  3. Else → `'unknown'`.
 *
 * Deliberately does **not** gate on `channelDecryptionService.isEnabled()`
 * — the original evaluator never checked it, and adding that gate now
 * would change uplink behavior for installs running with decryption
 * disabled. `tryDecrypt` already returns early/cheaply when disabled.
 *
 * @param envelope The decoded ServiceEnvelope reception.
 * @returns The resolved tri-state. Mirrors firmware `MQTT::onSend`
 *   (MQTT.cpp:767-788).
 */
export async function resolveOkToMqttForEnvelope(
  envelope: ServiceEnvelopeShape,
): Promise<OkToMqttState> {
  const decoded = envelope.packet?.decoded;
  if (decoded && typeof decoded.bitfield === 'number') {
    return readBitfieldOkToMqtt(decoded.bitfield);
  }

  // Encrypted path — try decryption against the channel DB so we can read
  // the originator's bitfield. If we can't decrypt, the bit is unknown.
  const enc = envelope.packet?.encrypted;
  const id = envelope.packet?.id;
  const from = envelope.packet?.from;
  if (!enc || typeof id !== 'number' || typeof from !== 'number') return 'unknown';

  const channelHash = typeof envelope.packet?.channel === 'number'
    ? envelope.packet.channel
    : undefined;
  const result = await channelDecryptionService.tryDecrypt(enc, id, from, channelHash);
  if (!result.success || typeof result.bitfield !== 'number') return 'unknown';
  return readBitfieldOkToMqtt(result.bitfield);
}

/**
 * Fail-closed adapter for the uplink gate (#4114): only an explicit
 * `'yes'` permits republishing a packet upstream. `'unknown'` (bit
 * unreadable, decrypt failed, or no matching channel key) drops the
 * packet, matching firmware's fail-closed behavior on public brokers.
 *
 * Do not use this for violation detection — see {@link detectOkToMqttViolation},
 * which treats `'unknown'` as merely "suspected", not confirmed.
 */
export function allowsUplink(state: OkToMqttState): boolean {
  return state === 'yes';
}

/**
 * Parse a `!aabbccdd`-formatted gateway id back into its numeric nodeNum.
 *
 * Moved verbatim from `src/server/services/mqttPacketLogService.ts:183-187`
 * (#4114) so both the packet-log row builder and the violation detector
 * below share one implementation.
 *
 * @returns `null` for a missing/malformed id.
 */
export function parseGatewayNodeNum(id: string | null | undefined): number | null {
  if (!id || !id.startsWith('!')) return null;
  const n = parseInt(id.slice(1), 16);
  return Number.isNaN(n) ? null : n >>> 0;
}

/** Result of {@link detectOkToMqttViolation} (#4114). */
export interface OkToMqttViolationEval {
  /** Tri-state `ok_to_mqtt` resolution for this reception. */
  state: OkToMqttState;
  /** Raw `Data.bitfield`, `>>> 0`-normalized. `null` when unreadable. */
  bitfield: number | null;
  /** Originator node number (`packet.from`), `>>> 0`-normalized. `null` when not numeric. */
  fromNode: number | null;
  /** Publishing gateway's node number, parsed from `envelope.gatewayId`. `null` when unparseable. */
  gatewayNodeNum: number | null;
  /**
   * `true` when the publishing gateway is THIS source's own local gateway
   * (`localGatewayNodeNum`). See Phase 1 spec §2(f.1): this is a
   * belt-and-braces guard against MeshMonitor flagging its own operator,
   * independent of — and not a replacement for — the bridge's echo
   * suppression, which is not airtight (exact topic-string match + a
   * 60s-TTL, 256-entry ring buffer; missable on topic rewrite, delayed
   * redelivery, or eviction under load).
   */
  selfGateway: boolean;
  /**
   * `true` when a distinct, non-local gateway is confirmed to have relayed
   * someone else's packet — i.e. attribution is provable at all.
   */
  relayed: boolean;
  /** `true` when the bit was explicitly clear on a relayed reception. */
  isViolation: boolean;
  /** `true` when the bit could not be read on a relayed reception. */
  isSuspected: boolean;
}

/**
 * Detect whether one gateway reception is a confirmed or suspected
 * `ok_to_mqtt` violation (#4114). Synchronous, pure, allocation-light.
 *
 * Reads ONLY `envelope.packet.decoded.bitfield`, `envelope.packet.from`,
 * and `envelope.gatewayId` — it never decrypts. By the time ingest calls
 * this, `ingestServiceEnvelopeInner` has already synthesized
 * `packet.decoded` for the server-decrypt path (Phase 1 spec §2(b)), so
 * the bit is available in plaintext form for every reception this function
 * needs to classify.
 *
 * `localGatewayNodeNum` is THIS source's own gateway node number. When the
 * publishing gateway matches it, the reception is neither a violation nor
 * suspected — the self-echo guard of §2(f.1). This deliberately does NOT
 * rely on the bridge's echo suppression (`matchesEcho`,
 * `mqttBridgeManager.ts:817-821`), which is demonstrably missable (topic
 * rewrite/canonicalisation by the upstream broker, redelivery delayed past
 * its 60s TTL, or ring eviction under load — and `mqttBrokerManager`'s
 * local-publish path has no echo suppression at all). Omit/pass `null`
 * only when the caller genuinely has no local identity to compare against
 * — do not remove this guard in favor of the echo suppression alone.
 *
 * @param envelope The decoded ServiceEnvelope reception.
 * @param localGatewayNodeNum This source's own gateway node number, or
 *   `null`/omitted when not yet known.
 */
export function detectOkToMqttViolation(
  envelope: ServiceEnvelopeShape,
  localGatewayNodeNum?: number | null,
): OkToMqttViolationEval {
  const decoded = envelope.packet?.decoded;
  const bitfield = typeof decoded?.bitfield === 'number' ? decoded.bitfield >>> 0 : null;
  const state = readBitfieldOkToMqtt(bitfield);

  const from = envelope.packet?.from;
  const fromNode = typeof from === 'number' ? from >>> 0 : null;

  const gatewayNodeNum = parseGatewayNodeNum(envelope.gatewayId);

  const selfGateway =
    localGatewayNodeNum != null &&
    gatewayNodeNum != null &&
    Number(gatewayNodeNum) === Number(localGatewayNodeNum);

  const relayed =
    fromNode !== null &&
    gatewayNodeNum !== null &&
    Number(fromNode) !== Number(gatewayNodeNum) &&
    !selfGateway;

  const isViolation = state === 'no' && relayed;
  const isSuspected = state === 'unknown' && relayed;

  return {
    state,
    bitfield,
    fromNode,
    gatewayNodeNum,
    selfGateway,
    relayed,
    isViolation,
    isSuspected,
  };
}
