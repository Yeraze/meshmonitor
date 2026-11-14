/**
 * MQTT-native ("nodeless") send (#4305): build, encrypt and publish
 * Meshtastic packets straight to an MQTT source's broker, with no radio.
 *
 * Only two entry points transmit:
 *   - {@link sendMqttNativeUserText}: an interactive user send (channel text
 *     or PKI DM). Called ONLY by the authenticated route in
 *     `routes/mqttNativeRoutes.ts`. It demands a real user id; the automation
 *     engine, auto-responders, auto-ack, auto-announce, auto-welcome, timers
 *     and the v1 API never reach it (they act on MeshtasticManager instances,
 *     which MQTT sources are not, and `mqttNativeSendService.guard.test.ts`
 *     pins that nothing else imports this module).
 *   - {@link sendMqttNativeNodeInfo}: the NodeInfo announce, driven by
 *     `mqttNativeNodeInfoScheduler.ts` on its own 3-hour cadence.
 *
 * Mesh impact (see the PR body): a publish is downlinked by every gateway
 * that downlinks the channel and then floods up to the hop limit. User sends
 * are capped at 6/min and 60/h per source (persisted, admin may lower), hop
 * limit defaults to 3 and is clamped 0-7, NodeInfo goes out every 3 h.
 */
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { applyHomoglyphOptimization } from '../../../utils/homoglyph.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { isMqttConnectionStatusManager } from '../../sourceManagerTypes.js';
import { dataEventEmitter } from '../dataEventEmitter.js';
import { computeChannelHash } from '../channelDecryptionService.js';
import {
  BROADCAST_NODE_NUM,
  CHANNEL_DB_OFFSET,
  DEVICE_ROLE_CLIENT_MUTE,
  HW_MODEL_PRIVATE_HW,
  MAX_MESSAGE_BYTES,
  MQTT_PKI_CHANNEL_ID,
  PortNum,
  TransportMechanism,
  expandShorthandPsk,
} from '../../constants/meshtastic.js';
import type { DbChannelDatabase, DbMessage } from '../../../db/types.js';
import {
  MQTT_NATIVE_NODEINFO_INTERVAL_MS,
  defaultMqttNativeNames,
  readMqttNativeConfig,
  type MqttNativeConfig,
} from './mqttNativeConfig.js';
import { decideRateLimit, parseSendTimes } from './mqttNativeRateLimit.js';
import { encryptChannelPayload, encryptPkiPayload, randomPacketId } from './mqttNativeCrypto.js';
import {
  buildMqttNativeTopic,
  encodeDataMessage,
  encodeMqttNativeEnvelope,
  encodeUserMessage,
  nodeIdFromNum,
} from './mqttNativePacket.js';
import { loadMqttNativeIdentity, type LoadedMqttNativeIdentity } from './mqttNativeIdentity.js';
import { trackMqttNativePublish, untrackMqttNativePublish } from './mqttNativeState.js';

export type MqttNativeReadiness =
  | { ok: true }
  | { ok: false; code: 'READ_ONLY' | 'NOT_CONNECTED'; reason: string };

/** What an MQTT manager must offer for MQTT-native send. */
export interface MqttNativePublisher {
  readonly sourceId: string;
  publish(topic: string, payload: Buffer, retained?: boolean): Promise<void>;
  getNativePublishReadiness(): MqttNativeReadiness;
  getNativeRootTopicHint(): string | null;
}

export type MqttNativeErrorCode =
  | 'INVALID_ORIGIN'
  | 'SOURCE_NOT_FOUND'
  | 'NOT_MQTT_SOURCE'
  | 'MQTT_NATIVE_DISABLED'
  | 'READ_ONLY'
  | 'NOT_CONNECTED'
  | 'NO_ROOT_TOPIC'
  | 'NO_IDENTITY'
  | 'KEY_UNAVAILABLE'
  | 'INVALID_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'CHANNEL_NOT_FOUND'
  | 'NO_PUBLIC_KEY'
  | 'RATE_LIMITED'
  | 'PUBLISH_FAILED';

const STATUS_BY_CODE: Record<MqttNativeErrorCode, number> = {
  INVALID_ORIGIN: 403,
  SOURCE_NOT_FOUND: 404,
  NOT_MQTT_SOURCE: 400,
  MQTT_NATIVE_DISABLED: 409,
  READ_ONLY: 409,
  NOT_CONNECTED: 503,
  NO_ROOT_TOPIC: 409,
  NO_IDENTITY: 409,
  KEY_UNAVAILABLE: 409,
  INVALID_MESSAGE: 400,
  MESSAGE_TOO_LONG: 400,
  CHANNEL_NOT_FOUND: 400,
  NO_PUBLIC_KEY: 409,
  RATE_LIMITED: 429,
  PUBLISH_FAILED: 502,
};

export class MqttNativeSendError extends Error {
  readonly code: MqttNativeErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: MqttNativeErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'MqttNativeSendError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ─── per-source serialisation ─────────────────────────────────────────────
// Rate-limit reads and writes, and the NodeInfo due-check, run one at a time
// per source so two requests can never both pass the same last slot.
const locks = new Map<string, Promise<unknown>>();

async function withSourceLock<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sourceId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(sourceId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(sourceId) === tail) locks.delete(sourceId);
  }
}

// ─── resolution helpers ───────────────────────────────────────────────────

/** The source's MQTT manager, or a typed error. Never widens to other types. */
export function resolveMqttNativePublisher(sourceId: string): MqttNativePublisher {
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (!manager) throw new MqttNativeSendError('SOURCE_NOT_FOUND', `Source "${sourceId}" was not found.`);
  if (!isMqttConnectionStatusManager(manager)) {
    throw new MqttNativeSendError('NOT_MQTT_SOURCE', 'MQTT-native send is only available on MQTT sources.');
  }
  return manager as unknown as MqttNativePublisher;
}

export function resolveRootTopic(config: MqttNativeConfig, publisher: MqttNativePublisher): string | null {
  return config.rootTopic ?? publisher.getNativeRootTopicHint();
}

function requireReady(publisher: MqttNativePublisher): void {
  const readiness = publisher.getNativePublishReadiness();
  if (!readiness.ok) throw new MqttNativeSendError(readiness.code, readiness.reason);
}

async function requireIdentity(sourceId: string): Promise<Extract<LoadedMqttNativeIdentity, { kind: 'ok' }>> {
  const loaded = await loadMqttNativeIdentity(sourceId);
  if (loaded.kind === 'none') {
    throw new MqttNativeSendError('NO_IDENTITY', 'This source has no MQTT-native identity yet. Enable MQTT-native send first.');
  }
  if (loaded.kind === 'key_unavailable') {
    throw new MqttNativeSendError(
      'KEY_UNAVAILABLE',
      'The MQTT-native private key cannot be opened with the current SESSION_SECRET.',
    );
  }
  return loaded;
}

interface UsableChannel {
  row: DbChannelDatabase & { id: number };
  psk: Buffer;
}

function usableChannel(row: DbChannelDatabase | null): UsableChannel | null {
  if (!row || row.id === undefined || !row.isEnabled) return null;
  if ((row.protocol ?? 'meshtastic') !== 'meshtastic') return null;
  let psk: Buffer | null;
  try {
    psk = expandShorthandPsk(Buffer.from(row.psk ?? '', 'base64'));
  } catch {
    return null;
  }
  if (!psk || (psk.length !== 16 && psk.length !== 32)) return null;
  return { row: row as DbChannelDatabase & { id: number }, psk };
}

/** Channel a NodeInfo announce goes on: the configured one, else LongFast, else the first usable. */
export async function resolveAnnounceChannel(config: MqttNativeConfig): Promise<UsableChannel | null> {
  if (config.announceChannelId !== null) {
    return usableChannel(await databaseService.channelDatabase.getByIdAsync(config.announceChannelId));
  }
  const rows = (await databaseService.channelDatabase.getEnabledAsync('meshtastic'))
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const usable = rows.map(usableChannel).filter((c): c is UsableChannel => c !== null);
  return usable.find((c) => c.row.name === 'LongFast') ?? usable[0] ?? null;
}

// ─── user send ────────────────────────────────────────────────────────────

export interface MqttNativeUserSend {
  sourceId: string;
  /** The signed-in user who pressed send. Required: no automation path has one. */
  userId: number;
  text: string;
  /** Virtual channel key (`CHANNEL_DB_OFFSET + channel_database.id`) for a channel send. */
  channel?: number;
  /** Destination node number for a PKI DM. */
  destinationNum?: number;
  replyId?: number;
  emoji?: number;
  sourceIp?: string | null;
}

export interface MqttNativeSendResult {
  messageId: string;
  packetId: number;
  topic: string;
}

/**
 * Send one user-typed text message over MQTT. Validates everything, takes a
 * rate-limit slot (persisted before the publish), publishes, then stores the
 * message like any other sent message on this source.
 */
export async function sendMqttNativeUserText(input: MqttNativeUserSend): Promise<MqttNativeSendResult> {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new MqttNativeSendError('INVALID_ORIGIN', 'MQTT-native send is limited to signed-in users.');
  }
  const { sourceId } = input;
  const publisher = resolveMqttNativePublisher(sourceId);
  const config = await readMqttNativeConfig(sourceId);
  if (!config.enabled) {
    throw new MqttNativeSendError('MQTT_NATIVE_DISABLED', 'MQTT-native send is turned off for this source.');
  }
  requireReady(publisher);
  const root = resolveRootTopic(config, publisher);
  if (!root) throw new MqttNativeSendError('NO_ROOT_TOPIC', 'Set the MQTT root topic for MQTT-native send first.');
  const identity = await requireIdentity(sourceId);

  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new MqttNativeSendError('INVALID_MESSAGE', 'Message text is required.');
  }
  let text = input.text;
  if ((await databaseService.settings.getSetting('homoglyphEnabled')) === 'true') {
    text = applyHomoglyphOptimization(text);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new MqttNativeSendError('MESSAGE_TOO_LONG', `Message is longer than ${MAX_MESSAGE_BYTES} bytes.`);
  }

  const ourNum = identity.info.nodeNum;
  const isDm = input.destinationNum !== undefined;
  let channel: UsableChannel | null = null;
  let remoteKey: Buffer | null = null;
  if (isDm) {
    const dest = input.destinationNum! >>> 0;
    if (dest === ourNum || dest === BROADCAST_NODE_NUM) {
      throw new MqttNativeSendError('INVALID_MESSAGE', 'Invalid DM destination.');
    }
    const node = await databaseService.nodes.getNode(dest, sourceId);
    const key = node?.publicKey ? Buffer.from(node.publicKey, 'base64') : null;
    if (!key || key.length !== 32 || node?.keyMismatchDetected) {
      throw new MqttNativeSendError(
        'NO_PUBLIC_KEY',
        'No trusted public key is known for that node on this source, so a PKI DM cannot be sent.',
      );
    }
    remoteKey = key;
  } else {
    const key = input.channel;
    if (typeof key !== 'number' || !Number.isInteger(key) || key < CHANNEL_DB_OFFSET) {
      throw new MqttNativeSendError('CHANNEL_NOT_FOUND', 'Pick a Channel Database channel to send on.');
    }
    channel = usableChannel(await databaseService.channelDatabase.getByIdAsync(key - CHANNEL_DB_OFFSET));
    if (!channel) {
      throw new MqttNativeSendError('CHANNEL_NOT_FOUND', 'That channel is missing, disabled, or has no key.');
    }
  }

  const packetId = randomPacketId();
  const to = isDm ? input.destinationNum! >>> 0 : BROADCAST_NODE_NUM;
  const data = encodeDataMessage({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from(text, 'utf8'),
    replyId: input.replyId,
    emoji: input.emoji,
  });

  const topicAndPayload = (): { topic: string; payload: Buffer } => {
    if (isDm) {
      const encrypted = encryptPkiPayload(data, {
        localPrivateKey: identity.privateKey,
        remotePublicKey: remoteKey!,
        packetId,
        fromNode: ourNum,
      });
      return {
        topic: buildMqttNativeTopic(root, MQTT_PKI_CHANNEL_ID, identity.info.nodeId),
        payload: encodeMqttNativeEnvelope({
          from: ourNum, to, id: packetId, channel: 0, hopLimit: config.hopLimit,
          encrypted, pkiEncrypted: true, channelId: MQTT_PKI_CHANNEL_ID, gatewayId: identity.info.nodeId,
        }),
      };
    }
    const ch = channel!;
    const useAead = ch.row.useAead ?? false;
    const encrypted = encryptChannelPayload(data, { psk: ch.psk, useAead, packetId, fromNode: ourNum, toNode: to });
    return {
      topic: buildMqttNativeTopic(root, ch.row.name, identity.info.nodeId),
      payload: encodeMqttNativeEnvelope({
        from: ourNum, to, id: packetId, channel: computeChannelHash(ch.row.name, ch.psk, useAead),
        hopLimit: config.hopLimit, encrypted, pkiEncrypted: false, channelId: ch.row.name, gatewayId: identity.info.nodeId,
      }),
    };
  };
  const { topic, payload } = topicAndPayload();

  // Take the slot and persist it BEFORE publishing: a crash between the two
  // must err on the side of counting the send.
  await withSourceLock(sourceId, async () => {
    const row = await databaseService.mqttNativeIdentities.getBySourceId(sourceId);
    const decision = decideRateLimit(parseSendTimes(row?.sendTimes), Date.now(), config);
    if (!decision.allowed) {
      throw new MqttNativeSendError(
        'RATE_LIMITED',
        `MQTT-native send limit reached (${decision.window === 'minute' ? config.maxPerMinute + ' per minute' : config.maxPerHour + ' per hour'}).`,
        decision.retryAfterSeconds,
      );
    }
    await databaseService.mqttNativeIdentities.setSendTimes(sourceId, decision.times);
  });

  trackMqttNativePublish(sourceId, ourNum, packetId);
  try {
    await publisher.publish(topic, payload, false);
  } catch (err) {
    untrackMqttNativePublish(sourceId, ourNum, packetId);
    logger.warn(`[MqttNative] Publish failed on ${sourceId}: ${(err as Error).message}`);
    throw new MqttNativeSendError('PUBLISH_FAILED', 'The broker did not accept the message.');
  }
  logger.info(`[MqttNative] ${sourceId}: sent ${isDm ? 'PKI DM' : 'channel text'} ${packetId} on ${topic}`);

  const now = Date.now();
  const messageId = `${sourceId}_${ourNum}_${packetId}`;
  const message: DbMessage = {
    id: messageId,
    fromNodeNum: ourNum,
    toNodeNum: to,
    fromNodeId: identity.info.nodeId,
    toNodeId: isDm ? nodeIdFromNum(to) : 'broadcast',
    text,
    channel: isDm ? -1 : (input.channel as number),
    portnum: PortNum.TEXT_MESSAGE_APP,
    timestamp: now,
    rxTime: now,
    hopStart: config.hopLimit,
    hopLimit: config.hopLimit,
    replyId: input.replyId || undefined,
    emoji: input.emoji || undefined,
    requestId: packetId,
    // No radio to wait for an ACK from: handed to the broker means delivered.
    wantAck: false,
    deliveryState: 'delivered',
    createdAt: now,
    sourceIp: input.sourceIp ?? null,
    sourcePath: 'http_api',
    transportMechanism: TransportMechanism.INTERNAL,
  };
  try {
    const inserted = await databaseService.messages.insertMessage(message, sourceId);
    if (inserted) {
      // Our node is in getOwnNodeNums(), so the #3914 self-origin guard keeps
      // this event from waking any automation.
      dataEventEmitter.emitNewMessage(message as unknown as Parameters<typeof dataEventEmitter.emitNewMessage>[0], sourceId);
      databaseService.markMessageAsReadAsync(messageId, input.userId).catch(() => undefined);
    }
  } catch (err) {
    logger.error(`[MqttNative] Sent ${packetId} but could not store it:`, err);
  }
  return { messageId, packetId, topic };
}

// ─── NodeInfo announce ────────────────────────────────────────────────────

/** True when a NodeInfo announce is due: never sent, or the last one is 3 h old. */
export function isNodeInfoDue(lastNodeInfoAt: number | null, now: number): boolean {
  if (lastNodeInfoAt === null) return true;
  // A last-sent time in the future (clock stepped back) is not "due".
  return now - lastNodeInfoAt >= MQTT_NATIVE_NODEINFO_INTERVAL_MS;
}

export type NodeInfoOutcome = 'sent' | 'not-due' | 'disabled' | 'not-ready' | 'no-identity' | 'no-channel' | 'no-root' | 'failed';

/**
 * Publish our NodeInfo on the source when it is due. The due check reads the
 * persisted timestamp, so calling this from startup or after a settings save
 * never sends unless the 3-hour cadence (or "never sent yet") says so.
 */
export async function sendMqttNativeNodeInfoIfDue(sourceId: string, now: () => number = Date.now): Promise<NodeInfoOutcome> {
  let publisher: MqttNativePublisher;
  try {
    publisher = resolveMqttNativePublisher(sourceId);
  } catch {
    return 'not-ready';
  }
  const config = await readMqttNativeConfig(sourceId);
  if (!config.enabled) return 'disabled';

  return withSourceLock(sourceId, async () => {
    const loaded = await loadMqttNativeIdentity(sourceId);
    if (loaded.kind !== 'ok') return 'no-identity';
    if (!isNodeInfoDue(loaded.info.lastNodeInfoAt, now())) return 'not-due';
    if (!publisher.getNativePublishReadiness().ok) return 'not-ready';
    const root = resolveRootTopic(config, publisher);
    if (!root) return 'no-root';
    const channel = await resolveAnnounceChannel(config);
    if (!channel) return 'no-channel';
    return sendMqttNativeNodeInfo(sourceId, publisher, config, loaded, channel, root, now);
  });
}

async function sendMqttNativeNodeInfo(
  sourceId: string,
  publisher: MqttNativePublisher,
  config: MqttNativeConfig,
  identity: Extract<LoadedMqttNativeIdentity, { kind: 'ok' }>,
  channel: UsableChannel,
  root: string,
  now: () => number,
): Promise<NodeInfoOutcome> {
  const ourNum = identity.info.nodeNum;
  const names = defaultMqttNativeNames(ourNum);
  const longName = config.longName || names.longName;
  const shortName = config.shortName || names.shortName;
  const packetId = randomPacketId();
  const useAead = channel.row.useAead ?? false;
  const user = encodeUserMessage({ nodeNum: ourNum, longName, shortName, publicKey: identity.publicKeyBytes });
  const data = encodeDataMessage({ portnum: PortNum.NODEINFO_APP, payload: user });
  const encrypted = encryptChannelPayload(data, {
    psk: channel.psk, useAead, packetId, fromNode: ourNum, toNode: BROADCAST_NODE_NUM,
  });
  const topic = buildMqttNativeTopic(root, channel.row.name, identity.info.nodeId);
  const payload = encodeMqttNativeEnvelope({
    from: ourNum, to: BROADCAST_NODE_NUM, id: packetId,
    channel: computeChannelHash(channel.row.name, channel.psk, useAead),
    hopLimit: config.hopLimit, encrypted, pkiEncrypted: false,
    channelId: channel.row.name, gatewayId: identity.info.nodeId,
  });

  trackMqttNativePublish(sourceId, ourNum, packetId);
  try {
    await publisher.publish(topic, payload, false);
  } catch (err) {
    untrackMqttNativePublish(sourceId, ourNum, packetId);
    logger.warn(`[MqttNative] NodeInfo publish failed on ${sourceId}: ${(err as Error).message}`);
    return 'failed';
  }
  const sentAt = now();
  await databaseService.mqttNativeIdentities.setLastNodeInfoAt(sourceId, sentAt);
  logger.info(`[MqttNative] ${sourceId}: announced NodeInfo ${identity.info.nodeId} on "${channel.row.name}"`);

  // Our own echo is dropped before ingest, so record our node here: it then
  // shows up named on this source like any node it heard.
  try {
    await databaseService.upsertNodeAsync({
      nodeNum: ourNum,
      nodeId: identity.info.nodeId,
      longName,
      shortName,
      hwModel: HW_MODEL_PRIVATE_HW,
      role: DEVICE_ROLE_CLIENT_MUTE,
      publicKey: identity.info.publicKey,
      lastHeard: Math.floor(sentAt / 1000),
      channel: CHANNEL_DB_OFFSET + channel.row.id,
      viaMqtt: true,
      createdAt: sentAt,
      updatedAt: sentAt,
    }, sourceId);
  } catch (err) {
    logger.debug(`[MqttNative] Could not record own node on ${sourceId}:`, err);
  }
  return 'sent';
}
