/**
 * One store path for a decrypted MeshCore GRP_TXT body (#6341 P6), shared by
 * the device managers (Repeater RAW, Companion OTA) and the MQTT feed.
 *
 * Callers own what differs: the id (`buildId`), radio metrics, the in-memory
 * pool and any counters (hooks). Everything else runs here, in one order:
 * filing, id, message, classify, block, reaction parse, MC1 hash, insert,
 * hit count, virtual-key counter, `onStored`, pending reaction note,
 * `selfOrigin`, emit, `afterStored`.
 *
 * Pure RX: nothing here sends a packet or arms a timer. Errors propagate; the
 * caller decides what a failed ingest means.
 */
import databaseService from '../../services/database.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import {
  keyedFilingFor,
  noteVirtualChannelDecrypt,
  type DecryptedGroupText,
  type KeyedFiling,
} from './meshcoreFrameIngest.js';
import { meshcoreMessageFilter, type MeshCoreClassifyResult } from './meshcoreMessageFilter.js';
import {
  emitReactionResolutions,
  isReactionsInboundEnabled,
  notePendingReaction,
  resolveInboundReaction,
  resolvePendingReactionsFor,
  type MeshCoreReactionFields,
} from './meshcoreReactionIngest.js';
import { isLocalMeshCoreSenderName } from './meshcoreLocalSenderNames.js';
import { meshCorePacketHashOrUndefined } from './meshcoreObserverPacket.js';
import { isReactionText, mc1ChannelBody } from '../../utils/meshcoreReactions.js';
import {
  meshcoreWireSecond,
  meshcoreWireChannelText,
  mc1HashForChannelWire,
} from '../../utils/meshcoreReactionTarget.js';
import { logger } from '../../utils/logger.js';
import type { MeshCoreMessage } from '../meshcoreManager.js';

export interface StoreChannelTextOptions {
  sourceId: string;
  /** Raw frame hex; the event's `packetHash` (Packet Monitor link). */
  rawHex: string;
  /** Row id. Gets the filing so a device path can key on `keyFingerprint`. */
  buildId: (filing: KeyedFiling) => string;
  snr?: number | null;
  rssi?: number | null;
  /**
   * Device only. Present: `receivedAt`, `sourceId`, `hopCount` and `routePath`
   * ride the row, and the insert sets `toPublicKey: null`. Absent (MQTT): the
   * row carries `createdAt` instead and none of those fields.
   */
  radio?: { hopCount?: number | null; hops?: string[] | null };
  /** The local node for reaction self-detection; null on a feed. */
  self: { name: string | null; key: string | null } | null;
  /** Called when the filter blocks the message; nothing is stored. */
  onBlocked?: (id: string, verdict: MeshCoreClassifyResult) => void;
  /** After a successful insert (pool push, stats). Gets the message sans packetHash/selfOrigin/filtered. */
  onStored?: (poolMessage: MeshCoreMessage) => void;
  /** After the event is emitted, for an ordinary (non-reaction) row. Default: resolve waiting reactions and emit. */
  afterStored?: (message: MeshCoreMessage, mc1Hash: string | null) => Promise<void>;
}

export type StoreChannelTextResult =
  | { kind: 'blocked' | 'duplicate-reaction' | 'not-inserted' }
  | { kind: 'stored'; id: string; event: MeshCoreMessage };

/** Resolve reactions that were waiting for `message` and tell the sockets. */
async function defaultAfterStored(
  sourceId: string,
  self: StoreChannelTextOptions['self'],
  message: MeshCoreMessage,
  mc1Hash: string | null,
): Promise<void> {
  try {
    emitReactionResolutions(
      sourceId,
      await resolvePendingReactionsFor(
        sourceId,
        {
          id: message.id,
          fromPublicKey: message.fromPublicKey,
          toPublicKey: message.toPublicKey ?? null,
          fromName: message.fromName ?? null,
          text: message.text,
          timestamp: message.timestamp,
          senderTimestamp: message.senderTimestamp ?? null,
          mc1Hash,
          messageType: message.messageType ?? null,
        },
        { selfName: self?.name ?? null, selfKey: self?.key ?? null },
      ),
    );
  } catch (err) {
    logger.warn(`[MeshCore:${sourceId}] late reaction resolution failed: ${(err as Error).message}`);
  }
}

export async function storeDecryptedChannelText(
  plain: DecryptedGroupText,
  opts: StoreChannelTextOptions,
): Promise<StoreChannelTextResult> {
  const { sourceId, radio, self } = opts;
  const filing = keyedFilingFor(plain.key);
  const { channelIdx, keyFingerprint, keySourceId, keyChannelIdx } = filing;
  const id = opts.buildId(filing);
  const now = Date.now();
  // Raw wire second (#5759): the MC1 reaction hash input.
  const sec = meshcoreWireSecond(plain.timestampSec);
  const snr = typeof opts.snr === 'number' ? opts.snr : undefined;
  const rssi = typeof opts.rssi === 'number' ? opts.rssi : undefined;

  const message: MeshCoreMessage & { createdAt?: number } = {
    id,
    fromPublicKey: `channel-${channelIdx}`,
    fromName: plain.senderName ?? undefined,
    text: plain.text,
    // Sender's clock when it has one, else when we heard it.
    timestamp: plain.timestampSec > 0 ? plain.timestampSec * 1000 : now,
    rssi,
    snr,
    messageType: 'channel',
    ...(radio
      ? {
          senderTimestamp: sec ?? undefined,
          receivedAt: now,
          sourceId,
          hopCount: typeof radio.hopCount === 'number' ? radio.hopCount : null,
          routePath: radio.hops && radio.hops.length > 0 ? radio.hops.join(',') : null,
        }
      : {
          createdAt: now,
          ...(sec !== null ? { senderTimestamp: sec } : {}),
        }),
    // Both null when a virtual channel's key (#5552) opened it.
    keySourceId,
    keyChannelIdx,
    keyFingerprint,
  };

  // Ignore / Block (#5408), as on every other ingest path.
  const verdict = meshcoreMessageFilter.classify(sourceId, {
    fromPublicKey: null,
    fromName: plain.senderName,
    text: plain.text,
    kind: 'channel',
  }, { countHit: false });
  if (verdict.action === 'block') {
    opts.onBlocked?.(id, verdict);
    return { kind: 'blocked' };
  }

  // Reaction? (#5759) The id above stays derived from the RAW text.
  let fields: Required<MeshCoreReactionFields> | null = null;
  const parseBody = plain.senderName ? plain.text : mc1ChannelBody(plain.text);
  if (isReactionText(parseBody) && (await isReactionsInboundEnabled(sourceId))) {
    const res = await resolveInboundReaction({
      sourceId,
      scope: 'channel',
      channelIdx,
      body: parseBody,
      reactorName: plain.senderName ?? null,
      reactorKey: null,
      selfName: self?.name ?? null,
      selfKey: self?.key ?? null,
      now,
    });
    if (res.kind === 'duplicate') return { kind: 'duplicate-reaction' };
    if (res.kind === 'reaction') fields = res.fields;
  }
  // Internal: goes to the DB row only, never the emitted event.
  const mc1Hash = fields ? null : mc1HashForChannelWire(meshcoreWireChannelText(plain.senderName, plain.text), sec);

  const poolMessage: MeshCoreMessage & { createdAt?: number } = fields
    ? { ...message, text: fields.reactionEmoji ?? message.text, ...fields }
    : message;

  const inserted = await databaseService.meshcore.insertMessage(
    radio
      ? {
          id,
          fromPublicKey: message.fromPublicKey,
          fromName: message.fromName ?? null,
          toPublicKey: null,
          text: poolMessage.text,
          senderTimestamp: sec,
          mc1Hash,
          ...(fields ?? {}),
          timestamp: message.timestamp,
          rssi: message.rssi ?? null,
          snr: message.snr ?? null,
          messageType: 'channel',
          hopCount: message.hopCount ?? null,
          routePath: message.routePath ?? null,
          keySourceId: message.keySourceId ?? null,
          keyChannelIdx: message.keyChannelIdx ?? null,
          keyFingerprint,
          createdAt: now,
        }
      : { ...poolMessage, createdAt: now, mc1Hash },
    sourceId,
  );
  // A relay of a message already stored: no second event.
  if (!inserted) return { kind: 'not-inserted' };
  meshcoreMessageFilter.countHit(sourceId, verdict);
  noteVirtualChannelDecrypt(plain.key);
  opts.onStored?.(poolMessage);

  if (fields && !fields.reactionTargetId && fields.reactionFormat && fields.reactionTargetHash) {
    notePendingReaction(sourceId, {
      id,
      reactionFormat: fields.reactionFormat,
      reactionTargetHash: fields.reactionTargetHash,
    });
  }

  // Event-only fields, added AFTER the insert so the row keeps its shape.
  const selfOrigin = await isLocalMeshCoreSenderName(plain.senderName);
  const event: MeshCoreMessage = {
    ...poolMessage,
    packetHash: meshCorePacketHashOrUndefined(opts.rawHex),
    ...(selfOrigin ? { selfOrigin: true } : {}),
    ...(verdict.action === 'ignore' ? { filtered: 'ignore' as const } : {}),
  };
  dataEventEmitter.emitMeshCoreMessage(event, sourceId);
  if (!fields) {
    if (opts.afterStored) await opts.afterStored(message, mc1Hash);
    else await defaultAfterStored(sourceId, self, message, mc1Hash);
  }
  return { kind: 'stored', id, event };
}
