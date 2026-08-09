/**
 * ConversationReadStateRepository (issue #4607)
 *
 * Durable, per-user last-read watermarks for MeshCore conversations. See
 * `src/db/schema/conversationReadState.ts` for why this exists alongside
 * Meshtastic's per-message `read_messages` table rather than replacing it.
 *
 * Two invariants the callers rely on:
 *  - Watermarks are MONOTONIC. `setLastReadAsync` never moves a marker
 *    backwards, so a stale client (an old tab, a queued write that lands late)
 *    cannot resurrect messages the operator already dismissed.
 *  - Reads are scoped to one (user, source) pair and returned grouped by kind,
 *    because that is exactly the shape the MeshCore views hydrate into.
 */
import { and, eq } from 'drizzle-orm';
import { BaseRepository } from './base.js';
import {
  CONVERSATION_KINDS,
  ANONYMOUS_USER_ID,
  type ConversationKind,
} from '../schema/conversationReadState.js';
import { logger } from '../../utils/logger.js';

/** Watermarks for one (user, source), grouped by conversation kind. */
export type ConversationReadStateMap = Record<ConversationKind, Record<string, number>>;

/** An empty, fully-populated map — every kind present with no entries. */
export function emptyReadStateMap(): ConversationReadStateMap {
  const out = {} as ConversationReadStateMap;
  for (const kind of CONVERSATION_KINDS) out[kind] = {};
  return out;
}

/** True when `kind` is a conversation family this table tracks. */
export function isConversationKind(kind: unknown): kind is ConversationKind {
  return typeof kind === 'string' && (CONVERSATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Resolve a request's user to the column value. `null` (anonymous / no-auth
 * install) maps to the `0` sentinel so the UNIQUE index stays total — see the
 * schema header for why a nullable column cannot work here.
 */
export function readStateUserId(userId: number | null | undefined): number {
  return userId == null ? ANONYMOUS_USER_ID : userId;
}

export class ConversationReadStateRepository extends BaseRepository {
  /**
   * All watermarks this user holds on one source, grouped by kind.
   * Missing conversations are simply absent (callers treat absent as 0).
   */
  async getForSourceAsync(
    userId: number | null,
    sourceId: string
  ): Promise<ConversationReadStateMap> {
    const out = emptyReadStateMap();
    if (!sourceId) return out;

    const table = this.tables.conversationReadState;
    try {
      const rows: Array<{ conversationKind: string; conversationKey: string; lastReadAt: number }> = await this.db
        .select({
          conversationKind: table.conversationKind,
          conversationKey: table.conversationKey,
          lastReadAt: table.lastReadAt,
        })
        .from(table)
        .where(
          and(
            eq(table.userId, readStateUserId(userId)),
            eq(table.sourceId, sourceId)
          )
        );

      for (const row of rows) {
        const kind = row.conversationKind as ConversationKind;
        // Defensive: a row written by a newer version with an unknown kind
        // must not blow away the whole response.
        if (!isConversationKind(kind)) continue;
        out[kind][String(row.conversationKey)] = Number(row.lastReadAt);
      }
      return out;
    } catch (error) {
      logger.error('Error reading conversation read state:', error);
      return out;
    }
  }

  /**
   * Move one conversation's watermark forward to `lastReadAt`.
   * Returns the effective (post-write) watermark, which is the max of the
   * stored value and the requested one — a backwards request is a no-op that
   * still reports the value the client should use.
   */
  async setLastReadAsync(
    userId: number | null,
    sourceId: string,
    kind: ConversationKind,
    conversationKey: string,
    lastReadAt: number
  ): Promise<number> {
    if (!sourceId || !conversationKey || !Number.isFinite(lastReadAt)) return 0;

    const table = this.tables.conversationReadState;
    const uid = readStateUserId(userId);
    const ts = Math.floor(lastReadAt);

    try {
      const existing: Array<{ id: number; lastReadAt: number }> = await this.db
        .select({ id: table.id, lastReadAt: table.lastReadAt })
        .from(table)
        .where(
          and(
            eq(table.userId, uid),
            eq(table.sourceId, sourceId),
            eq(table.conversationKind, kind),
            eq(table.conversationKey, conversationKey)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const current = Number(existing[0].lastReadAt);
        if (current >= ts) return current; // monotonic: never rewind
        await this.db
          .update(table)
          .set({ lastReadAt: ts })
          .where(eq(table.id, existing[0].id));
        return ts;
      }

      // No row yet. A concurrent request may have inserted one between the
      // SELECT and here, so treat a UNIQUE violation as "someone else won"
      // and re-resolve rather than failing the request.
      try {
        await this.db.insert(table).values({
          userId: uid,
          sourceId,
          conversationKind: kind,
          conversationKey,
          lastReadAt: ts,
        });
        return ts;
      } catch {
        return this.setLastReadAsync(userId, sourceId, kind, conversationKey, ts);
      }
    } catch (error) {
      logger.error('Error writing conversation read state:', error);
      return 0;
    }
  }

  /** Drop every watermark for a source (used when a source is deleted). */
  async deleteForSourceAsync(sourceId: string): Promise<number> {
    if (!sourceId) return 0;
    const table = this.tables.conversationReadState;
    try {
      const result = await this.db.delete(table).where(eq(table.sourceId, sourceId));
      return this.getAffectedRows(result);
    } catch (error) {
      logger.error('Error deleting conversation read state for source:', error);
      return 0;
    }
  }
}
