/**
 * Drizzle schema for the `coverage_surveys` table (Coverage Report epic
 * #5277, Phase 4b WP1).
 *
 * A saved survey is "this sender, this time range": name, canonical sender
 * id, start/end window (`endAt` null = still live), an optional encoded
 * receiver-filter wire string (a VIEW preference only — never part of the
 * retention exemption, which keys on sender + window across every source),
 * an optional configured broadcast interval for gap detection, free-text
 * notes, and the creating user.
 *
 * GLOBAL (no `sourceId`) — see COVERAGE_P4_SPEC.md §2b.1. A survey's sender
 * can be heard by receivers on many sources (radio + gateways + observers);
 * one drive is one survey row, not N. Per-source privacy still holds because
 * the row itself carries no reception data: reads go through the existing
 * `/receptions` route, which scopes by the viewer's permitted sources.
 *
 * `id` is a UUID text primary key (`crypto.randomUUID()` in the repository),
 * **not** serial — see migration 173's header for the PG-sequence /
 * `onConflictDoNothing()` trap this avoids for backup/restore. It also
 * serves as the opaque deep-link id (`?survey=<id>`).
 *
 * `createdBy` is `users.id` with **no FK** — users can be deleted, and an
 * admin still manages the row afterward (same convention as other
 * creator-tracking columns in this codebase).
 *
 * Indexes (declared in migration 173, not here — matches the project
 * convention of DDL-only indexes, see `coverageReceptions.ts`):
 *  - `cov_sv_sender_start_idx (senderId, startAt)` — live-survey lookup +
 *    exemption-window query.
 *  - `cov_sv_created_by_idx (createdBy)` — per-user survey count / listing.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const coverageSurveysSqlite = sqliteTable('coverage_surveys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Canonical form: `!xxxxxxxx` or lowercased 64-hex.
  senderId: text('senderId').notNull(),
  // Unix ms.
  startAt: integer('startAt').notNull(),
  // Unix ms; null = live.
  endAt: integer('endAt'),
  // Encoded receiver-filter wire string; null = every receiver. View preference only.
  receivers: text('receivers'),
  // Configured broadcast interval for gap detection, seconds.
  intervalSec: integer('intervalSec'),
  notes: text('notes'),
  // users.id; no FK (users can be deleted; admins still manage the row).
  createdBy: integer('createdBy'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const coverageSurveysPostgres = pgTable('coverage_surveys', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  senderId: pgText('senderId').notNull(),
  startAt: pgBigint('startAt', { mode: 'number' }).notNull(),
  endAt: pgBigint('endAt', { mode: 'number' }),
  receivers: pgText('receivers'),
  intervalSec: pgInteger('intervalSec'),
  notes: pgText('notes'),
  createdBy: pgInteger('createdBy'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const coverageSurveysMysql = mysqlTable('coverage_surveys', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 120 }).notNull(),
  senderId: myVarchar('senderId', { length: 80 }).notNull(),
  startAt: myBigint('startAt', { mode: 'number' }).notNull(),
  endAt: myBigint('endAt', { mode: 'number' }),
  receivers: myText('receivers'),
  intervalSec: myInt('intervalSec'),
  notes: myText('notes'),
  createdBy: myInt('createdBy'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type CoverageSurveySqlite = typeof coverageSurveysSqlite.$inferSelect;
export type NewCoverageSurveySqlite = typeof coverageSurveysSqlite.$inferInsert;
export type CoverageSurveyPostgres = typeof coverageSurveysPostgres.$inferSelect;
export type NewCoverageSurveyPostgres = typeof coverageSurveysPostgres.$inferInsert;
export type CoverageSurveyMysql = typeof coverageSurveysMysql.$inferSelect;
export type NewCoverageSurveyMysql = typeof coverageSurveysMysql.$inferInsert;
