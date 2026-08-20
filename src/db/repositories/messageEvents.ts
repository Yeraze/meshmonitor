/**
 * Repository for `message_events` — the per-message delivery event timeline
 * (Delivery Diagnostics epic #4816, Phase 3 WP1).
 *
 * Protocol-agnostic: one table serves both Meshtastic (`messages.id`) and
 * MeshCore (`meshcore_messages.id`), keyed by `(sourceId, messageId)`.
 * Append-only, but at-most-once for the "terminal" event types — a second
 * broadcast ack or a duplicate callback must not append a second row for the
 * same (sourceId, messageId, eventType). `retry` is exempt (it may legitimately
 * repeat, bounded by the caller's own retry cadence).
 *
 * This repository is a pure data layer: it is deliberately defensive
 * (validates sourceId/messageId, never throws on a benign duplicate) because
 * it is called from async send/ack paths where a diagnostics write must never
 * break message delivery. Callers (WP2) are expected to additionally wrap
 * calls in a try/catch and log-and-swallow — this method does not swallow its
 * own input-validation errors, since those indicate a caller bug.
 */
import { and, asc, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type MessageEventType =
  | 'submitted'
  | 'sent_to_radio'
  | 'delivered'
  | 'confirmed'
  | 'routing_error'
  | 'timeout'
  | 'retry';

export type MessageEventProvenance = 'reported' | 'observed' | 'inferred';

export interface MessageEventRow {
  id: number;
  sourceId: string;
  messageId: string;
  eventType: string;
  provenance: string;
  detail: string | null;
  timestamp: number;
  createdAt: number;
}

export interface RecordMessageEventParams {
  sourceId: string;
  messageId: string;
  eventType: MessageEventType;
  provenance: MessageEventProvenance;
  timestamp: number;
  detail?: string | null;
}

/**
 * Event types that may only be recorded once per (sourceId, messageId).
 * `submitted` and `sent_to_radio` are at-most-once by construction (each
 * fires from a single send-path call site); listed explicitly for clarity
 * and defense against a future duplicate call site.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<MessageEventType> = new Set([
  'submitted',
  'sent_to_radio',
  'delivered',
  'confirmed',
  'routing_error',
  'timeout',
]);

export class MessageEventsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Record one delivery event. For terminal event types, this is a no-op if
   * an event of that same type already exists for (sourceId, messageId) —
   * the check-then-insert keeps the timeline honest (one row per real
   * transition) without requiring a unique constraint per dialect.
   */
  async recordEvent(params: RecordMessageEventParams): Promise<void> {
    const { sourceId, messageId, eventType, provenance, timestamp } = params;
    if (!sourceId) {
      throw new Error('MessageEventsRepository.recordEvent requires a sourceId');
    }
    if (!messageId) {
      throw new Error('MessageEventsRepository.recordEvent requires a messageId');
    }
    const detail = params.detail ?? null;
    const { messageEvents } = this.tables;

    if (TERMINAL_EVENT_TYPES.has(eventType)) {
      const existing = await this.db
        .select({ id: messageEvents.id })
        .from(messageEvents)
        .where(
          and(
            eq(messageEvents.sourceId, sourceId),
            eq(messageEvents.messageId, messageId),
            eq(messageEvents.eventType, eventType),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return;
      }
    }

    await this.db.insert(messageEvents).values({
      sourceId,
      messageId,
      eventType,
      provenance,
      detail,
      timestamp,
      createdAt: this.now(),
    });
  }

  /**
   * Fetch the full event timeline for one message, scoped by BOTH sourceId
   * and messageId, ordered chronologically ascending (oldest first).
   */
  async getEventsForMessage(sourceId: string, messageId: string): Promise<MessageEventRow[]> {
    if (!sourceId) {
      throw new Error('MessageEventsRepository.getEventsForMessage requires a sourceId');
    }
    if (!messageId) {
      throw new Error('MessageEventsRepository.getEventsForMessage requires a messageId');
    }
    const { messageEvents } = this.tables;
    const rows = await this.db
      .select()
      .from(messageEvents)
      .where(
        and(
          eq(messageEvents.sourceId, sourceId),
          eq(messageEvents.messageId, messageId),
        ),
      )
      .orderBy(asc(messageEvents.timestamp));
    return this.normalizeBigInts(rows) as unknown as MessageEventRow[];
  }
}
