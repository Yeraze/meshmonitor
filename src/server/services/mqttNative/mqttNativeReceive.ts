/**
 * Receive side of MQTT-native send (#4305): open a PKI direct message that
 * arrives over MQTT addressed to this source's own generated node, so a reply
 * to a DM we sent shows up instead of sitting encrypted.
 *
 * Reuses `pkiDecryptionService` with our private key and the sender's public
 * key as this source knows it. Costs a database read only for packets whose
 * `to` is our own node number on this source.
 */
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { pkiDecryptionService } from '../pkiDecryptionService.js';
import { loadMqttNativeIdentity } from './mqttNativeIdentity.js';
import { getMqttNativeNodeNum } from './mqttNativeState.js';

export interface MqttNativeDecryptedDm {
  portnum: number;
  payload: Uint8Array;
  emoji?: number;
  replyId?: number;
  bitfield?: number;
}

/** Cheap synchronous pre-check: is this encrypted packet a DM to our node on this source? */
export function isPkiDmToMqttNativeIdentity(
  sourceId: string,
  packet: { to?: number | null; channel?: number | null; encrypted?: Uint8Array | null },
): boolean {
  const own = getMqttNativeNodeNum(sourceId);
  if (own === null || typeof packet.to !== 'number') return false;
  if ((packet.to >>> 0) !== own) return false;
  if (!packet.encrypted || packet.encrypted.length === 0) return false;
  return (packet.channel ?? 0) === 0;
}

export async function decryptPkiDmToMqttNativeIdentity(
  sourceId: string,
  packet: { from?: number | null; id?: number | null; encrypted?: Uint8Array | null },
): Promise<MqttNativeDecryptedDm | null> {
  if (typeof packet.from !== 'number' || typeof packet.id !== 'number' || !packet.encrypted) return null;
  try {
    const identity = await loadMqttNativeIdentity(sourceId);
    if (identity.kind !== 'ok') return null;
    const sender = await databaseService.nodes.getNode(packet.from >>> 0, sourceId);
    const senderKey = sender?.publicKey ? Buffer.from(sender.publicKey, 'base64') : null;
    if (!senderKey || senderKey.length !== 32) return null;
    const r = pkiDecryptionService.tryDecryptDirectMessage(
      identity.privateKey,
      senderKey,
      packet.id >>> 0,
      packet.from >>> 0,
      packet.encrypted,
    );
    if (!r.success || r.portnum === undefined) return null;
    return {
      portnum: r.portnum,
      payload: r.payload ?? new Uint8Array(),
      emoji: r.emoji,
      replyId: r.replyId,
      bitfield: r.bitfield,
    };
  } catch (err) {
    logger.debug(`[MqttNative] PKI DM decrypt failed on ${sourceId}:`, err);
    return null;
  }
}
