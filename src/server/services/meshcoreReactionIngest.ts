/**
 * MeshCore reaction ingest (#5759, Phase 2).
 *
 * One resolver for the companion, repeater and MQTT receive paths: detect a
 * reaction, find the message it names on the SAME source, drop a repeat, and
 * attach a reaction that arrived before its target once the target lands.
 *
 * Mesh impact: none. This service sends nothing on the mesh and arms no timer.
 * All work is database reads at receive time, bounded by the constants below.
 * The pending index is an in-memory cache of database rows; a restart rebuilds
 * it and triggers no send.
 */

import databaseService from '../../services/database.js';
import type { DbMeshCoreMessage } from '../../db/repositories/meshcore.js';
import {
  isReactionText,
  parseMeshCoreReaction,
  type MeshCoreReaction,
} from '../../utils/meshcoreReactions.js';
import {
  candidateMatchesReaction,
  foldReactionEmoji,
  pendingKeyOfReaction,
  pendingKeysOfMessage,
  type ReactionCandidate,
  type ReactionMatchContext,
} from '../../utils/meshcoreReactionTarget.js';
import { meshcoreChannelIndexOf } from '../utils/meshcoreMessageMerge.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';

export const REACTION_CANDIDATE_LIMIT = 200;
export const REACTION_LOOKUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REACTION_PENDING_LIMIT = 500;
/** Rows read per MC1 hash lookup. */
const MC1_HASH_LOOKUP_LIMIT = 10;

/** Reaction fields carried on a row, an event and an API message. */
export interface MeshCoreReactionFields {
  reactionEmoji?: string | null;
  reactionFormat?: string | null;
  reactionTargetHash?: string | null;
  reactionTargetSender?: string | null;
  reactionTargetId?: string | null;
  reactionRawText?: string | null;
}

export interface InboundReactionInput {
  sourceId: string;
  scope: 'channel' | 'dm';
  /** Text to parse. */
  body: string;
  /** Channel index for a channel reaction. */
  channelIdx?: number;
  /** DM: the other party's key or 12-hex prefix. */
  peerKey?: string;
  /** Channel: the name prefix. DM: the contact name, if known. */
  reactorName: string | null;
  /** DM: sender key or prefix. Channel: null. */
  reactorKey: string | null;
  selfName?: string | null;
  selfKey?: string | null;
  now: number;
}

export type InboundReactionResult =
  | { kind: 'not_reaction' }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'reaction'; fields: Required<MeshCoreReactionFields> };

export interface ResolvedReaction {
  reactionId: string;
  targetId: string;
  droppedDuplicate: boolean;
  row: DbMeshCoreMessage;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const stats = new Map<string, Record<string, number>>();

function bump(sourceId: string, key: 'resolved' | 'unmatched' | 'duplicate' | 'lateResolved'): void {
  let s = stats.get(sourceId);
  if (!s) {
    s = { resolved: 0, unmatched: 0, duplicate: 0, lateResolved: 0 };
    stats.set(sourceId, s);
  }
  s[key] += 1;
}

/** Counters for logs: resolved, unmatched, duplicate, lateResolved. */
export function getReactionIngestStats(sourceId: string): Readonly<Record<string, number>> {
  return { resolved: 0, unmatched: 0, duplicate: 0, lateResolved: 0, ...stats.get(sourceId) };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Unset or anything but 'false' = on. Read each time; never cached. */
export async function isReactionsInboundEnabled(sourceId: string): Promise<boolean> {
  try {
    const v = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreReactionsInboundEnabled');
    return v !== 'false';
  } catch (err) {
    logger.warn('[MeshCore] reaction inbound setting read failed; treating as on:', err);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

function isSelfKey(key: string, selfKey?: string | null): boolean {
  return key === 'local' || (!!selfKey && key.toLowerCase() === selfKey.toLowerCase());
}

/** The other party of a DM row: `fromPublicKey` unless that is us, then `toPublicKey`. */
function otherParty(
  row: { fromPublicKey: string; toPublicKey?: string | null },
  selfKey?: string | null,
): string {
  if (isSelfKey(row.fromPublicKey, selfKey)) return row.toPublicKey ?? '';
  return row.fromPublicKey;
}

function prefixMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

function isInConversation(
  row: { fromPublicKey: string; toPublicKey?: string | null; messageType?: string | null },
  input: Pick<InboundReactionInput, 'scope' | 'channelIdx' | 'peerKey' | 'selfKey'>,
): boolean {
  const idx = meshcoreChannelIndexOf(row);
  if (input.scope === 'channel') return idx !== null && idx === input.channelIdx;
  if (idx !== null || row.messageType === 'room_post' || !input.peerKey) return false;
  return prefixMatch(otherParty(row, input.selfKey), input.peerKey);
}

function toCandidate(row: DbMeshCoreMessage): ReactionCandidate {
  return {
    id: row.id,
    fromPublicKey: row.fromPublicKey,
    toPublicKey: row.toPublicKey ?? null,
    fromName: row.fromName ?? null,
    text: row.text,
    timestamp: Number(row.timestamp),
    senderTimestamp: row.senderTimestamp ?? null,
    mc1Hash: row.mc1Hash ?? null,
  };
}

function firstMatch(
  rows: DbMeshCoreMessage[],
  r: MeshCoreReaction,
  input: InboundReactionInput,
): DbMeshCoreMessage | null {
  const ctx: ReactionMatchContext = { scope: input.scope, selfName: input.selfName, selfKey: input.selfKey };
  for (const row of rows) {
    if (row.reactionEmoji) continue;
    if (!isInConversation(row, input)) continue;
    if (candidateMatchesReaction(r, toCandidate(row), ctx)) return row;
  }
  return null;
}

async function findTarget(r: MeshCoreReaction, input: InboundReactionInput): Promise<DbMeshCoreMessage | null> {
  const repo = databaseService.meshcore;
  const conv = input.scope === 'channel' ? { channelIdx: input.channelIdx } : { dm: true };
  const sinceCreatedAt = input.now - REACTION_LOOKUP_WINDOW_MS;
  if (r.format === 'mc1-channel' || r.format === 'mc1-channel-legacy' || r.format === 'mc1-dm') {
    const hit = firstMatch(await repo.findMessagesByMc1Hash(input.sourceId, r.hash, MC1_HASH_LOOKUP_LIMIT), r, input);
    if (hit) return hit;
    const old = await repo.getReactionCandidates(input.sourceId, {
      ...conv, sinceCreatedAt, limit: REACTION_CANDIDATE_LIMIT, onlyUnhashed: true,
    });
    return firstMatch(old, r, input);
  }
  const rows = await repo.getReactionCandidates(input.sourceId, {
    ...conv, sinceCreatedAt, limit: REACTION_CANDIDATE_LIMIT,
  });
  return firstMatch(rows, r, input);
}

/** True when `row` is a reaction by the same reactor with the same (folded) emoji. */
function sameReaction(
  row: DbMeshCoreMessage,
  emoji: string,
  scope: 'channel' | 'dm',
  reactorName: string | null,
  reactorKey: string | null,
): boolean {
  if (foldReactionEmoji(row.reactionEmoji ?? '') !== foldReactionEmoji(emoji)) return false;
  if (scope === 'channel') return (row.fromName ?? null) === reactorName;
  return !!reactorKey && prefixMatch(row.fromPublicKey, reactorKey);
}

function hashOf(r: MeshCoreReaction): string {
  return r.format === 'mco-v1' ? String(r.timestampMs) : r.hash;
}

function fieldsOf(r: MeshCoreReaction, body: string, targetId: string | null): Required<MeshCoreReactionFields> {
  return {
    reactionEmoji: r.emoji,
    reactionFormat: r.format,
    reactionTargetHash: hashOf(r),
    reactionTargetSender:
      r.format === 'mc1-channel' || r.format === 'mc1-channel-legacy' ? r.targetSender : null,
    reactionTargetId: targetId,
    reactionRawText: body,
  };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * Parse, find the target, dedupe. Never throws: on a database error it logs
 * and returns the reaction unmatched.
 */
export async function resolveInboundReaction(input: InboundReactionInput): Promise<InboundReactionResult> {
  if (!isReactionText(input.body)) return { kind: 'not_reaction' };
  const r = parseMeshCoreReaction(input.body, input.scope);
  if (!r) return { kind: 'not_reaction' };

  let target: DbMeshCoreMessage | null = null;
  try {
    target = await findTarget(r, input);
  } catch (err) {
    logger.warn(`[MeshCore] reaction target lookup failed (source ${input.sourceId}):`, err);
  }

  try {
    const repo = databaseService.meshcore;
    const existing = target
      ? await repo.findReactionRows(input.sourceId, { targetId: target.id })
      : (await repo.findReactionRows(input.sourceId, { targetHash: hashOf(r) })).filter(row =>
          isInConversation(row, input),
        );
    const dup = existing.find(row => sameReaction(row, r.emoji, input.scope, input.reactorName, input.reactorKey));
    if (dup) {
      bump(input.sourceId, 'duplicate');
      return { kind: 'duplicate', existingId: dup.id };
    }
  } catch (err) {
    logger.warn(`[MeshCore] reaction duplicate check failed (source ${input.sourceId}):`, err);
  }

  bump(input.sourceId, target ? 'resolved' : 'unmatched');
  return { kind: 'reaction', fields: fieldsOf(r, input.body, target ? target.id : null) };
}

// ---------------------------------------------------------------------------
// Pending (unmatched) reactions
// ---------------------------------------------------------------------------

interface PendingIndex {
  hydrated: boolean;
  hydrating: Promise<void> | null;
  /** pending key -> reaction ids */
  byKey: Map<string, string[]>;
  /** reaction id -> pending key, in insertion order (oldest first) */
  keyOf: Map<string, string>;
}

const pending = new Map<string, PendingIndex>();

function indexFor(sourceId: string): PendingIndex {
  let idx = pending.get(sourceId);
  if (!idx) {
    idx = { hydrated: false, hydrating: null, byKey: new Map(), keyOf: new Map() };
    pending.set(sourceId, idx);
  }
  return idx;
}

function addPending(idx: PendingIndex, id: string, key: string): void {
  if (idx.keyOf.has(id)) return;
  idx.keyOf.set(id, key);
  const list = idx.byKey.get(key);
  if (list) list.push(id);
  else idx.byKey.set(key, [id]);
  while (idx.keyOf.size > REACTION_PENDING_LIMIT) {
    const oldest = idx.keyOf.keys().next().value as string;
    removePending(idx, oldest);
  }
}

function removePending(idx: PendingIndex, id: string): void {
  const key = idx.keyOf.get(id);
  if (key === undefined) return;
  idx.keyOf.delete(id);
  const list = idx.byKey.get(key);
  if (!list) return;
  const next = list.filter(x => x !== id);
  if (next.length === 0) idx.byKey.delete(key);
  else idx.byKey.set(key, next);
}

async function hydrate(sourceId: string, idx: PendingIndex): Promise<void> {
  if (idx.hydrated) return;
  if (!idx.hydrating) {
    idx.hydrating = (async () => {
      try {
        const rows = await databaseService.meshcore.getUnresolvedReactions(
          sourceId,
          Date.now() - REACTION_LOOKUP_WINDOW_MS,
          REACTION_PENDING_LIMIT,
        );
        // Newest first from the repo; add oldest first so eviction drops the oldest.
        for (const row of [...rows].reverse()) {
          if (row.reactionFormat && row.reactionTargetHash) {
            addPending(idx, row.id, pendingKeyOfReaction({
              reactionFormat: row.reactionFormat,
              reactionTargetHash: row.reactionTargetHash,
            }));
          }
        }
        idx.hydrated = true;
      } catch (err) {
        logger.warn(`[MeshCore] reaction pending index load failed (source ${sourceId}):`, err);
      } finally {
        idx.hydrating = null;
      }
    })();
  }
  await idx.hydrating;
}

/** Call after a reaction row is stored unmatched. */
export function notePendingReaction(
  sourceId: string,
  row: { id: string; reactionFormat: string; reactionTargetHash: string },
): void {
  addPending(indexFor(sourceId), row.id, pendingKeyOfReaction(row));
}

/** Drop the pending index of a source (purge, delete, tests). With no argument, every source. */
export function invalidatePendingReactions(sourceId?: string): void {
  if (sourceId === undefined) pending.clear();
  else pending.delete(sourceId);
}

/**
 * Call after an ORDINARY (non-reaction) row is stored. Returns what was
 * resolved, for the caller to emit. Never throws.
 */
export async function resolvePendingReactionsFor(
  sourceId: string,
  stored: ReactionCandidate & { messageType?: string | null },
  ctx: { selfName?: string | null; selfKey?: string | null },
): Promise<ResolvedReaction[]> {
  const out: ResolvedReaction[] = [];
  try {
    if (stored.messageType === 'room_post') return out;
    const idx = indexFor(sourceId);
    if (!idx.hydrated) await hydrate(sourceId, idx);

    const channelIdx = meshcoreChannelIndexOf(stored);
    const matchCtx: ReactionMatchContext = {
      scope: channelIdx !== null ? 'channel' : 'dm',
      selfName: ctx.selfName,
      selfKey: ctx.selfKey,
    };
    const ids = new Set<string>();
    for (const key of pendingKeysOfMessage(stored, matchCtx)) {
      for (const id of idx.byKey.get(key) ?? []) ids.add(id);
    }
    if (ids.size === 0) return out;

    const repo = databaseService.meshcore;
    for (const id of ids) {
      const row = await repo.getMessageForSource(id, sourceId);
      if (!row || !row.reactionEmoji || row.reactionTargetId) {
        removePending(idx, id);
        continue;
      }
      const rowIdx = meshcoreChannelIndexOf(row);
      const scope = rowIdx !== null ? 'channel' : 'dm';
      if (scope !== matchCtx.scope) continue;
      const r = row.reactionRawText ? parseMeshCoreReaction(row.reactionRawText, scope) : null;
      if (!r) {
        removePending(idx, id);
        continue;
      }
      const sameConv =
        scope === 'channel'
          ? rowIdx === channelIdx
          : prefixMatch(otherParty(row, ctx.selfKey), otherParty(stored, ctx.selfKey));
      if (!sameConv || !candidateMatchesReaction(r, stored, matchCtx)) continue;

      const siblings = await repo.findReactionRows(sourceId, { targetId: stored.id });
      const dup = siblings.find(
        s => s.id !== row.id && sameReaction(s, r.emoji, scope, row.fromName ?? null, row.fromPublicKey),
      );
      removePending(idx, id);
      if (dup) {
        await repo.deleteMessagesByIds([row.id], sourceId);
        bump(sourceId, 'duplicate');
        out.push({ reactionId: row.id, targetId: stored.id, droppedDuplicate: true, row });
        continue;
      }
      if (await repo.setReactionTarget(row.id, sourceId, stored.id)) {
        bump(sourceId, 'lateResolved');
        out.push({
          reactionId: row.id,
          targetId: stored.id,
          droppedDuplicate: false,
          row: { ...row, reactionTargetId: stored.id },
        });
      }
    }
  } catch (err) {
    logger.warn(`[MeshCore] late reaction resolution failed (source ${sourceId}):`, err);
  }
  return out;
}

/** Emit the socket events for late resolutions (shared by the managers). */
export function emitReactionResolutions(sourceId: string, results: ResolvedReaction[]): void {
  for (const res of results) {
    if (res.droppedDuplicate) {
      dataEventEmitter.emitMeshCoreMessagesDeleted({ ids: [res.reactionId] }, sourceId);
    } else {
      dataEventEmitter.emitMeshCoreReactionResolved({
        id: res.reactionId,
        reactionTargetId: res.targetId,
        fromPublicKey: res.row.fromPublicKey,
        toPublicKey: res.row.toPublicKey ?? null,
        keyFingerprint: res.row.keyFingerprint ?? null,
      }, sourceId);
    }
  }
}
