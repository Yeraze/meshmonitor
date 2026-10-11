/**
 * MeshCore mention notifications.
 *
 * When a MeshCore channel message or room post names a source's own node as
 * `@[Name]`, users who turned on "Mentions" for that source get a notification.
 * MeshCore messages raise no other message notification, so this is opt-in
 * (`notifyOnMention`, default off).
 *
 * Mesh impact: this sends nothing over the air. The only cost is notifications,
 * and a sender can repeat a mention at will, so:
 * - one alert per source and sender every {@link MENTION_COOLDOWN_MS};
 * - the last-alert times are persisted per source (`meshcoreMentionNotifyState`),
 *   so a restart or a settings save does not reopen the window;
 * - our own messages, ignored senders and DMs never alert.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { notificationService, type NotificationPayload } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import { isOwnPublicKey } from '../utils/ownNodes.js';
import { meshcoreChannelIndexOf } from '../utils/meshcoreMessageMerge.js';
import { textMentionsMeshCoreName } from '../../utils/meshcoreMentions.js';
import type { MeshCoreMessage } from '../meshcoreManager.js';

/** Quiet period per source and sender after an alert. */
export const MENTION_COOLDOWN_MS = 5 * 60_000;
/** Per-source setting holding `{ [senderKey]: lastAlertMs }`. */
export const SETTING_MENTION_STATE = 'meshcoreMentionNotifyState';
/** Longest notification body; a MeshCore message is far shorter. */
const BODY_MAX = 240;

export type MentionState = Record<string, number>;

/** Parse the persisted state, dropping entries whose quiet period has ended. */
export function parseMentionState(raw: string | null | undefined, now: number): MentionState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: MentionState = {};
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>)) {
      // A stamp slightly ahead of `now` (the clock stepped back) still counts:
      // dropping it would reopen the window. One a full period ahead is junk.
      if (typeof at === 'number' && Number.isFinite(at) && Math.abs(now - at) < MENTION_COOLDOWN_MS) out[key] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Where a message was posted, or null when it is out of scope (a DM). */
export function mentionVenue(msg: Pick<MeshCoreMessage, 'fromPublicKey' | 'toPublicKey' | 'messageType'>):
  | { kind: 'channel'; channelIdx: number }
  | { kind: 'room' }
  | null {
  const channelIdx = meshcoreChannelIndexOf(msg);
  if (channelIdx !== null) return { kind: 'channel', channelIdx };
  if (msg.messageType === 'room_post') return { kind: 'room' };
  return null;
}

/**
 * Stable key for "who sent this". A channel packet carries no sender key, only
 * the name its device put in the body, so the name is the identity there.
 */
export function mentionSenderKey(msg: Pick<MeshCoreMessage, 'fromPublicKey' | 'fromName'>): string {
  const name = (msg.fromName ?? '').trim().toLowerCase();
  if (name) return `n:${name}`;
  return `k:${(msg.fromPublicKey ?? '').toLowerCase()}`;
}

export interface MentionNotificationDeps {
  now(): number;
  /** Own node of the source, or null when the source has none (not connected, MQTT ingest). */
  getOwnNode(sourceId: string): { name: string | null; publicKey: string | null } | null;
  isOwnPublicKey(publicKey: string): boolean;
  getSourceName(sourceId: string): Promise<string>;
  getChannelName(sourceId: string, channelIdx: number): Promise<string | null>;
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  setSourceSetting(sourceId: string, key: string, value: string): Promise<void>;
  notify(payload: NotificationPayload): Promise<unknown>;
}

function realDeps(): MentionNotificationDeps {
  return {
    now: () => Date.now(),
    getOwnNode: (sourceId) => {
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (!manager || !isMeshCoreManager(manager)) return null;
      const local = manager.getLocalNode();
      return local ? { name: local.name ?? null, publicKey: local.publicKey ?? null } : null;
    },
    isOwnPublicKey: (publicKey) => isOwnPublicKey(publicKey),
    getSourceName: async (sourceId) => (await databaseService.sources.getSource(sourceId))?.name || sourceId,
    getChannelName: async (sourceId, channelIdx) =>
      (await databaseService.channels.getChannelById(channelIdx, sourceId))?.name || null,
    getSourceSetting: (sourceId, key) => databaseService.settings.getSettingForSource(sourceId, key),
    setSourceSetting: (sourceId, key, value) => databaseService.settings.setSourceSetting(sourceId, key, value),
    notify: (payload) => notificationService.broadcastToPreferenceUsers('notifyOnMention', payload),
  };
}

export type MentionOutcome = 'sent' | 'out_of_scope' | 'no_own_name' | 'own_message' | 'not_mentioned' | 'cooldown';

export class MeshCoreMentionNotificationService {
  /** Serialises the read-check-write of one source's state. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private deps: MentionNotificationDeps = realDeps()) {}

  async handleMessage(msg: MeshCoreMessage, sourceId: string): Promise<MentionOutcome> {
    // An ignored or blocked sender is stored but must not alert (#5408).
    if (msg.filtered) return 'out_of_scope';
    const venue = mentionVenue(msg);
    if (!venue) return 'out_of_scope';

    const own = this.deps.getOwnNode(sourceId);
    const ownName = (own?.name ?? '').trim();
    if (!ownName) return 'no_own_name';

    const fromKey = (msg.fromPublicKey ?? '').toLowerCase();
    const senderName = (msg.fromName ?? '').trim();
    if (
      msg.selfOrigin === true ||
      (own?.publicKey && fromKey === own.publicKey.toLowerCase()) ||
      (fromKey && this.deps.isOwnPublicKey(fromKey)) ||
      // A channel echo of our own post has no sender key, only our name.
      (senderName && senderName.toLowerCase() === ownName.toLowerCase())
    ) {
      return 'own_message';
    }

    if (!textMentionsMeshCoreName(msg.text, ownName)) return 'not_mentioned';

    const claimed = await this.claim(sourceId, mentionSenderKey(msg));
    if (!claimed) return 'cooldown';

    const sourceName = await this.deps.getSourceName(sourceId);
    let place = 'a room';
    if (venue.kind === 'channel') {
      const channelName = await this.deps.getChannelName(sourceId, venue.channelIdx).catch(() => null);
      place = `#${channelName || `Channel ${venue.channelIdx}`}`;
    }
    const text = (msg.text ?? '').trim();
    const line = senderName ? `${senderName}: ${text}` : text;
    await this.deps.notify({
      title: `${ownName} mentioned in ${place} · ${sourceName}`,
      body: line.length > BODY_MAX ? `${line.slice(0, BODY_MAX - 1)}…` : line,
      type: 'info',
      sourceId,
      sourceName,
      ...(venue.kind === 'channel'
        ? { data: { type: 'channel' as const, channelId: venue.channelIdx, messageId: msg.id } }
        : {}),
    });
    return 'sent';
  }

  /**
   * Take the alert slot for one sender on one source. False while that
   * sender's quiet period runs. The write happens BEFORE the notification, so
   * a failed delivery does not turn into a retry on the next mention.
   */
  private claim(sourceId: string, senderKey: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const now = this.deps.now();
      const state = parseMentionState(await this.deps.getSourceSetting(sourceId, SETTING_MENTION_STATE), now);
      if (state[senderKey] !== undefined) return false;
      state[senderKey] = now;
      await this.deps.setSourceSetting(sourceId, SETTING_MENTION_STATE, JSON.stringify(state));
      return true;
    };
    const prev = this.chains.get(sourceId) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.chains.set(sourceId, next.catch(() => undefined));
    return next;
  }
}

export const meshcoreMentionNotificationService = new MeshCoreMentionNotificationService();

let subscribed = false;

/** Subscribe to received MeshCore messages. Sends nothing until a user opts in. */
export function startMeshCoreMentionNotifications(): void {
  if (subscribed) return;
  subscribed = true;
  dataEventEmitter.on('data', (event: DataEvent) => {
    if (event.type !== 'meshcore:message' || !event.sourceId) return;
    meshcoreMentionNotificationService
      .handleMessage(event.data as MeshCoreMessage, event.sourceId)
      .catch((e) => logger.error(`[MeshCoreMention] handler error: ${e?.message}`));
  });
}
