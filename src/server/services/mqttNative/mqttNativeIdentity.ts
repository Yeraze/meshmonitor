/**
 * The generated Meshtastic identity an MQTT source sends as (#4305).
 *
 * Created once, the first time MQTT-native send is enabled on the source, and
 * kept after that (disable does not delete it: the mesh already knows us by
 * it). Deleting the source deletes it. The private key is sealed with the
 * same SESSION_SECRET envelope as SourcePkiKeyStore, so the feature needs a
 * configured SESSION_SECRET, exactly like PKI DM decryption.
 */
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { getSourcePkiKeyStore } from '../sourcePkiKeyStore.js';
import { generateMqttNativeIdentity } from './mqttNativeCrypto.js';
import { nodeIdFromNum } from './mqttNativePacket.js';
import { rememberMqttNativeIdentity } from './mqttNativeState.js';

export interface MqttNativeIdentityInfo {
  sourceId: string;
  nodeNum: number;
  nodeId: string;
  publicKey: string;
  lastNodeInfoAt: number | null;
}

export type LoadedMqttNativeIdentity =
  | { kind: 'ok'; info: MqttNativeIdentityInfo; privateKey: Buffer; publicKeyBytes: Buffer }
  | { kind: 'none' }
  | { kind: 'key_unavailable' };

/** Why an identity cannot be created on this install, or null when it can. */
export function mqttNativeIdentityBlocker(): string | null {
  const cap = getSourcePkiKeyStore().capability;
  return cap.canStore ? null : (cap.reason ?? 'SESSION_SECRET is not configured');
}

/** Public part of a source's identity, or null when it has none. */
export async function getMqttNativeIdentityInfo(sourceId: string): Promise<MqttNativeIdentityInfo | null> {
  const row = await databaseService.mqttNativeIdentities.getBySourceId(sourceId);
  if (!row) return null;
  rememberMqttNativeIdentity(sourceId, row.nodeNum);
  return {
    sourceId,
    nodeNum: row.nodeNum,
    nodeId: nodeIdFromNum(row.nodeNum),
    publicKey: row.publicKey,
    lastNodeInfoAt: row.lastNodeInfoAt,
  };
}

/**
 * Return the source's identity, generating and storing one if it has none.
 * Throws when SESSION_SECRET is auto-generated (the key could not survive a
 * restart).
 */
export async function ensureMqttNativeIdentity(sourceId: string): Promise<MqttNativeIdentityInfo> {
  const existing = await getMqttNativeIdentityInfo(sourceId);
  if (existing) return existing;

  const blocker = mqttNativeIdentityBlocker();
  if (blocker) throw new Error(blocker);

  const generated = generateMqttNativeIdentity();
  const sealed = getSourcePkiKeyStore().seal(generated.privateKey);
  try {
    await databaseService.mqttNativeIdentities.create({
      sourceId,
      nodeNum: generated.nodeNum,
      publicKey: generated.publicKey.toString('base64'),
      encryptedPrivateKey: sealed,
    });
    logger.info(`[MqttNative] Generated identity ${nodeIdFromNum(generated.nodeNum)} for source ${sourceId}`);
  } catch (err) {
    // A concurrent call may have created it first: keep whichever row won.
    const raced = await getMqttNativeIdentityInfo(sourceId);
    if (raced) return raced;
    throw err;
  }
  const created = await getMqttNativeIdentityInfo(sourceId);
  if (!created) throw new Error('MQTT-native identity was not stored');
  return created;
}

/** Load the identity with its private key opened. */
export async function loadMqttNativeIdentity(sourceId: string): Promise<LoadedMqttNativeIdentity> {
  const row = await databaseService.mqttNativeIdentities.getBySourceId(sourceId);
  if (!row) return { kind: 'none' };
  rememberMqttNativeIdentity(sourceId, row.nodeNum);
  const opened = getSourcePkiKeyStore().open(row.encryptedPrivateKey);
  if (opened.kind !== 'ok' || opened.privateKey.length !== 32) return { kind: 'key_unavailable' };
  return {
    kind: 'ok',
    info: {
      sourceId,
      nodeNum: row.nodeNum,
      nodeId: nodeIdFromNum(row.nodeNum),
      publicKey: row.publicKey,
      lastNodeInfoAt: row.lastNodeInfoAt,
    },
    privateKey: opened.privateKey,
    publicKeyBytes: Buffer.from(row.publicKey, 'base64'),
  };
}

/**
 * Fill the in-memory identity cache from the database at startup, so the
 * self-origin guard knows our MQTT-native nodes before the first packet.
 */
export async function primeMqttNativeIdentityCache(): Promise<void> {
  try {
    for (const row of await databaseService.mqttNativeIdentities.listAll()) {
      rememberMqttNativeIdentity(row.sourceId, row.nodeNum);
    }
  } catch (err) {
    logger.warn('[MqttNative] Could not load identities at startup:', err);
  }
}
