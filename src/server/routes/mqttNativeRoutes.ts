/**
 * MQTT-native ("nodeless") send routes (#4305), mounted at
 * `/api/sources/:id/mqtt/native`.
 *
 *   GET  /       status + config + the source's generated node id
 *                (`messages:read` on the source)
 *   PUT  /       turn the feature on/off and set its limits
 *                (`sources:write`, the grant that edits the MQTT source itself)
 *   POST /send   send one user-typed text message, channel or PKI DM
 *                (`messages:write` on the source; signed in)
 *
 * The send route is the ONLY caller of `sendMqttNativeUserText`; it carries
 * the signed-in user's id, which no automation path has.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { messageLimiter } from '../middleware/rateLimiters.js';
import { ok, fail } from '../utils/apiResponse.js';
import { parseDestinationNum } from '../utils/parseDestination.js';
import { isMqttSourceType } from '../../db/repositories/sources.js';
import { CHANNEL_DB_OFFSET, MAX_HOP_LIMIT } from '../constants/meshtastic.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMqttConnectionStatusManager } from '../sourceManagerTypes.js';
import {
  MQTT_NATIVE_HARD_MAX_PER_HOUR,
  MQTT_NATIVE_HARD_MAX_PER_MINUTE,
  MQTT_NATIVE_LONG_NAME_MAX_BYTES,
  MQTT_NATIVE_NODEINFO_INTERVAL_MS,
  MQTT_NATIVE_SETTING_KEYS,
  MQTT_NATIVE_SHORT_NAME_MAX_BYTES,
  defaultMqttNativeNames,
  readMqttNativeConfig,
} from '../services/mqttNative/mqttNativeConfig.js';
import { normalizeRootTopic } from '../services/mqttNative/mqttNativePacket.js';
import {
  ensureMqttNativeIdentity,
  getMqttNativeIdentityInfo,
  mqttNativeIdentityBlocker,
} from '../services/mqttNative/mqttNativeIdentity.js';
import {
  MqttNativeSendError,
  sendMqttNativeUserText,
  type MqttNativePublisher,
} from '../services/mqttNative/mqttNativeSendService.js';
import { checkMqttNativeNodeInfoNow } from '../services/mqttNative/mqttNativeNodeInfoScheduler.js';

const router = Router({ mergeParams: true });

function sourceIdOf(req: Request): string {
  return (req.params as { id?: string }).id ?? '';
}

/** The running MQTT manager for a source, or null. */
function mqttPublisherFor(sourceId: string): MqttNativePublisher | null {
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (!manager || !isMqttConnectionStatusManager(manager)) return null;
  return manager as unknown as MqttNativePublisher;
}

/** True when the source exists and is an MQTT broker/bridge (running or not). */
async function isMqttSource(sourceId: string): Promise<boolean> {
  if (mqttPublisherFor(sourceId)) return true;
  const source = await databaseService.sources.getSource(sourceId);
  return !!source && isMqttSourceType(source.type);
}

async function buildStatus(sourceId: string) {
  const config = await readMqttNativeConfig(sourceId);
  const identity = await getMqttNativeIdentityInfo(sourceId);
  const publisher = mqttPublisherFor(sourceId);
  const rootTopicHint = publisher?.getNativeRootTopicHint() ?? null;
  const readiness = publisher
    ? publisher.getNativePublishReadiness()
    : { ok: false as const, code: 'NOT_CONNECTED' as const, reason: 'The source is not running.' };
  const names = identity ? defaultMqttNativeNames(identity.nodeNum) : null;
  return {
    sourceId,
    enabled: config.enabled,
    readiness,
    identity: identity
      ? {
          nodeNum: identity.nodeNum,
          nodeId: identity.nodeId,
          publicKey: identity.publicKey,
          longName: config.longName || names!.longName,
          shortName: config.shortName || names!.shortName,
          lastNodeInfoAt: identity.lastNodeInfoAt,
        }
      : null,
    identityBlocker: identity ? null : mqttNativeIdentityBlocker(),
    config: {
      hopLimit: config.hopLimit,
      maxPerMinute: config.maxPerMinute,
      maxPerHour: config.maxPerHour,
      longName: config.longName,
      shortName: config.shortName,
      rootTopic: config.rootTopic,
      announceChannelId: config.announceChannelId,
    },
    rootTopicHint,
    effectiveRootTopic: config.rootTopic ?? rootTopicHint,
    limits: {
      hardMaxPerMinute: MQTT_NATIVE_HARD_MAX_PER_MINUTE,
      hardMaxPerHour: MQTT_NATIVE_HARD_MAX_PER_HOUR,
      maxHopLimit: MAX_HOP_LIMIT,
      nodeInfoIntervalMs: MQTT_NATIVE_NODEINFO_INTERVAL_MS,
      longNameMaxBytes: MQTT_NATIVE_LONG_NAME_MAX_BYTES,
      shortNameMaxBytes: MQTT_NATIVE_SHORT_NAME_MAX_BYTES,
    },
  };
}

router.get(
  '/',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = sourceIdOf(req);
    try {
      if (!(await isMqttSource(sourceId))) {
        return fail(res, 404, 'NOT_MQTT_SOURCE', 'MQTT-native send is only available on MQTT sources.');
      }
      return ok(res, await buildStatus(sourceId));
    } catch (err) {
      logger.error(`[MqttNative] status failed for ${sourceId}:`, err);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read MQTT-native send status');
    }
  },
);

function isIntIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

router.put(
  '/',
  requireAuth(),
  requirePermission('sources', 'write'),
  async (req: Request, res: Response) => {
    const sourceId = sourceIdOf(req);
    try {
      if (!(await isMqttSource(sourceId))) {
        return fail(res, 404, 'NOT_MQTT_SOURCE', 'MQTT-native send is only available on MQTT sources.');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const k = MQTT_NATIVE_SETTING_KEYS;
      const updates: Record<string, string> = {};

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') return fail(res, 400, 'INVALID_REQUEST', '`enabled` must be a boolean');
        updates[k.enabled] = body.enabled ? 'true' : 'false';
      }
      if (body.hopLimit !== undefined) {
        if (!isIntIn(body.hopLimit, 0, MAX_HOP_LIMIT)) {
          return fail(res, 400, 'INVALID_HOP_LIMIT', `Hop limit must be a whole number from 0 to ${MAX_HOP_LIMIT}`);
        }
        updates[k.hopLimit] = String(body.hopLimit);
      }
      // The caps can be lowered, never raised past the server limits.
      if (body.maxPerMinute !== undefined) {
        if (!isIntIn(body.maxPerMinute, 1, MQTT_NATIVE_HARD_MAX_PER_MINUTE)) {
          return fail(res, 400, 'INVALID_RATE_LIMIT', `Per-minute limit must be 1 to ${MQTT_NATIVE_HARD_MAX_PER_MINUTE}`);
        }
        updates[k.maxPerMinute] = String(body.maxPerMinute);
      }
      if (body.maxPerHour !== undefined) {
        if (!isIntIn(body.maxPerHour, 1, MQTT_NATIVE_HARD_MAX_PER_HOUR)) {
          return fail(res, 400, 'INVALID_RATE_LIMIT', `Per-hour limit must be 1 to ${MQTT_NATIVE_HARD_MAX_PER_HOUR}`);
        }
        updates[k.maxPerHour] = String(body.maxPerHour);
      }
      for (const [field, key, maxBytes] of [
        ['longName', k.longName, MQTT_NATIVE_LONG_NAME_MAX_BYTES],
        ['shortName', k.shortName, MQTT_NATIVE_SHORT_NAME_MAX_BYTES],
      ] as const) {
        const v = body[field];
        if (v === undefined) continue;
        if (typeof v !== 'string' || Buffer.byteLength(v.trim(), 'utf8') > maxBytes) {
          return fail(res, 400, 'INVALID_NAME', `${field} must be text of at most ${maxBytes} bytes`);
        }
        updates[key] = v.trim();
      }
      if (body.rootTopic !== undefined) {
        if (body.rootTopic === null || body.rootTopic === '') {
          updates[k.rootTopic] = '';
        } else {
          const root = normalizeRootTopic(body.rootTopic);
          if (!root) return fail(res, 400, 'INVALID_ROOT_TOPIC', 'Root topic must be a plain topic such as msh/US/FL (no + or #)');
          updates[k.rootTopic] = root;
        }
      }
      if (body.announceChannelId !== undefined) {
        if (body.announceChannelId === null) {
          updates[k.announceChannelId] = '';
        } else {
          if (!isIntIn(body.announceChannelId, 1, Number.MAX_SAFE_INTEGER)) {
            return fail(res, 400, 'INVALID_CHANNEL', '`announceChannelId` must be a Channel Database id');
          }
          const row = await databaseService.channelDatabase.getByIdAsync(body.announceChannelId);
          if (!row || !row.isEnabled || (row.protocol ?? 'meshtastic') !== 'meshtastic') {
            return fail(res, 400, 'INVALID_CHANNEL', 'That channel is missing or disabled');
          }
          updates[k.announceChannelId] = String(body.announceChannelId);
        }
      }

      const turningOn = updates[k.enabled] === 'true';
      if (turningOn) {
        const publisher = mqttPublisherFor(sourceId);
        const readiness = publisher?.getNativePublishReadiness();
        if (readiness && !readiness.ok && readiness.code === 'READ_ONLY') {
          return fail(res, 409, 'READ_ONLY', readiness.reason);
        }
        const current = await readMqttNativeConfig(sourceId);
        const nextRoot = updates[k.rootTopic] !== undefined ? (updates[k.rootTopic] || null) : current.rootTopic;
        if (!nextRoot && !publisher?.getNativeRootTopicHint()) {
          return fail(res, 400, 'NO_ROOT_TOPIC', 'Set the MQTT root topic (for example msh/US/FL) before turning this on');
        }
        const blocker = mqttNativeIdentityBlocker();
        if (blocker && !(await getMqttNativeIdentityInfo(sourceId))) {
          return fail(res, 409, 'KEY_STORE_UNAVAILABLE', blocker);
        }
        await ensureMqttNativeIdentity(sourceId);
      }

      if (Object.keys(updates).length > 0) {
        await databaseService.settings.setSourceSettings(sourceId, updates);
        databaseService
          .auditLogAsync(
            req.user?.id ?? null,
            'mqtt_native_send_update',
            'sources',
            JSON.stringify({ sourceId, ...updates }),
            req.ip || null,
          )
          .catch((err) => logger.error('[MqttNative] audit write failed:', err));
      }

      // Same due check the scheduler runs: sends a NodeInfo only when none was
      // ever sent or the last one is 3 h old. A save never resets that time.
      const nowEnabled = (await readMqttNativeConfig(sourceId)).enabled;
      if (nowEnabled) void checkMqttNativeNodeInfoNow(sourceId);

      return ok(res, await buildStatus(sourceId));
    } catch (err) {
      logger.error(`[MqttNative] update failed for ${sourceId}:`, err);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to update MQTT-native send');
    }
  },
);

router.post(
  '/send',
  messageLimiter,
  requireAuth(),
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = sourceIdOf(req);
    const user = req.user;
    if (!user?.id) return fail(res, 401, 'UNAUTHORIZED', 'Sign in to send messages');
    try {
      const { text, channel, destination, replyId, emoji } = (req.body ?? {}) as Record<string, unknown>;
      if (replyId !== undefined && replyId !== null && !(typeof replyId === 'number' && Number.isInteger(replyId) && replyId >= 0)) {
        return fail(res, 400, 'INVALID_REQUEST', 'Invalid replyId');
      }
      if (emoji !== undefined && emoji !== null && emoji !== 0 && emoji !== 1) {
        return fail(res, 400, 'INVALID_REQUEST', 'Invalid emoji flag');
      }

      let destinationNum: number | undefined;
      if (destination !== undefined && destination !== null && destination !== '') {
        const parsed = await parseDestinationNum(destination, sourceId, databaseService);
        if (parsed === null) return fail(res, 400, 'INVALID_DESTINATION', 'Invalid destination');
        destinationNum = parsed;
      } else {
        // A channel send posts into a Channel Database channel. Beyond
        // messages:write, a non-admin must be able to read that channel: no
        // one posts into a conversation they cannot see.
        if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < CHANNEL_DB_OFFSET) {
          return fail(res, 400, 'CHANNEL_NOT_FOUND', 'Pick a Channel Database channel to send on');
        }
        if (!user.isAdmin) {
          const perm = await databaseService.channelDatabase.getPermissionAsync(user.id, channel - CHANNEL_DB_OFFSET);
          if (!perm?.canRead) {
            return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions', {
              required: { resource: `channel_database:${channel - CHANNEL_DB_OFFSET}`, action: 'read' },
            });
          }
        }
      }

      const result = await sendMqttNativeUserText({
        sourceId,
        userId: user.id,
        text: typeof text === 'string' ? text : '',
        channel: destinationNum === undefined ? (channel as number) : undefined,
        destinationNum,
        replyId: typeof replyId === 'number' && replyId > 0 ? replyId : undefined,
        emoji: emoji === 1 ? 1 : undefined,
        sourceIp: req.ip ?? null,
      });
      return ok(res, result);
    } catch (err) {
      if (err instanceof MqttNativeSendError) {
        if (err.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(err.retryAfterSeconds));
        return fail(res, err.status, err.code, err.message,
          err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : undefined);
      }
      logger.error(`[MqttNative] send failed for ${sourceId}:`, err);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to send message');
    }
  },
);

export default router;
