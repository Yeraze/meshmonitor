/**
 * Drizzle schema definition for authentication tables
 * Includes: users, permissions, sessions, audit_log, api_tokens
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';

// ============ USERS ============

export const usersSqlite = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  password_hash: text('password_hash'),
  email: text('email'),
  display_name: text('display_name'),
  auth_provider: text('auth_provider').notNull().default('local'), // 'local' or 'oidc'
  oidc_subject: text('oidc_subject'),
  is_admin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  password_locked: integer('password_locked', { mode: 'boolean' }).default(false),
  created_at: integer('created_at').notNull(),
  last_login_at: integer('last_login_at'),
  created_by: integer('created_by'),
});

export const usersPostgres = pgTable('users', {
  id: pgSerial('id').primaryKey(),
  username: pgText('username').notNull().unique(),
  password_hash: pgText('password_hash'),
  email: pgText('email'),
  display_name: pgText('display_name'),
  auth_provider: pgText('auth_provider').notNull().default('local'),
  oidc_subject: pgText('oidc_subject'),
  is_admin: pgBoolean('is_admin').notNull().default(false),
  is_active: pgBoolean('is_active').notNull().default(true),
  password_locked: pgBoolean('password_locked').default(false),
  created_at: pgBigint('created_at', { mode: 'number' }).notNull(),
  last_login_at: pgBigint('last_login_at', { mode: 'number' }),
  created_by: pgInteger('created_by'),
});

// ============ PERMISSIONS ============

export const permissionsSqlite = sqliteTable('permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  resource: text('resource').notNull(),
  can_read: integer('can_read', { mode: 'boolean' }).notNull().default(false),
  can_write: integer('can_write', { mode: 'boolean' }).notNull().default(false),
  granted_at: integer('granted_at').notNull(),
  granted_by: integer('granted_by').references(() => usersSqlite.id, { onDelete: 'set null' }),
});

export const permissionsPostgres = pgTable('permissions', {
  id: pgSerial('id').primaryKey(),
  user_id: pgInteger('user_id').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  resource: pgText('resource').notNull(),
  can_read: pgBoolean('can_read').notNull().default(false),
  can_write: pgBoolean('can_write').notNull().default(false),
  granted_at: pgBigint('granted_at', { mode: 'number' }).notNull(),
  granted_by: pgInteger('granted_by').references(() => usersPostgres.id, { onDelete: 'set null' }),
});

// ============ SESSIONS ============

export const sessionsSqlite = sqliteTable('sessions', {
  sid: text('sid').primaryKey(),
  sess: text('sess').notNull(),
  expire: integer('expire').notNull(),
});

export const sessionsPostgres = pgTable('sessions', {
  sid: pgText('sid').primaryKey(),
  sess: pgText('sess').notNull(),
  expire: pgBigint('expire', { mode: 'number' }).notNull(),
});

// ============ AUDIT LOG ============

export const auditLogSqlite = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').references(() => usersSqlite.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  resource: text('resource'),
  resource_id: text('resource_id'),
  details: text('details'),
  ip_address: text('ip_address'),
  user_agent: text('user_agent'),
  timestamp: integer('timestamp').notNull(),
});

export const auditLogPostgres = pgTable('audit_log', {
  id: pgSerial('id').primaryKey(),
  user_id: pgInteger('user_id').references(() => usersPostgres.id, { onDelete: 'set null' }),
  action: pgText('action').notNull(),
  resource: pgText('resource'),
  resource_id: pgText('resource_id'),
  details: pgText('details'),
  ip_address: pgText('ip_address'),
  user_agent: pgText('user_agent'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
});

// ============ API TOKENS ============

export const apiTokensSqlite = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at').notNull(),
  last_used_at: integer('last_used_at'),
  expires_at: integer('expires_at'),
});

export const apiTokensPostgres = pgTable('api_tokens', {
  id: pgSerial('id').primaryKey(),
  user_id: pgInteger('user_id').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  name: pgText('name').notNull(),
  token_hash: pgText('token_hash').notNull().unique(),
  prefix: pgText('prefix').notNull(),
  is_active: pgBoolean('is_active').notNull().default(true),
  created_at: pgBigint('created_at', { mode: 'number' }).notNull(),
  last_used_at: pgBigint('last_used_at', { mode: 'number' }),
  expires_at: pgBigint('expires_at', { mode: 'number' }),
});

// Type inference
export type UserSqlite = typeof usersSqlite.$inferSelect;
export type NewUserSqlite = typeof usersSqlite.$inferInsert;
export type UserPostgres = typeof usersPostgres.$inferSelect;
export type NewUserPostgres = typeof usersPostgres.$inferInsert;

export type PermissionSqlite = typeof permissionsSqlite.$inferSelect;
export type NewPermissionSqlite = typeof permissionsSqlite.$inferInsert;
export type PermissionPostgres = typeof permissionsPostgres.$inferSelect;
export type NewPermissionPostgres = typeof permissionsPostgres.$inferInsert;

export type SessionSqlite = typeof sessionsSqlite.$inferSelect;
export type NewSessionSqlite = typeof sessionsSqlite.$inferInsert;
export type SessionPostgres = typeof sessionsPostgres.$inferSelect;
export type NewSessionPostgres = typeof sessionsPostgres.$inferInsert;

export type AuditLogSqlite = typeof auditLogSqlite.$inferSelect;
export type NewAuditLogSqlite = typeof auditLogSqlite.$inferInsert;
export type AuditLogPostgres = typeof auditLogPostgres.$inferSelect;
export type NewAuditLogPostgres = typeof auditLogPostgres.$inferInsert;

export type ApiTokenSqlite = typeof apiTokensSqlite.$inferSelect;
export type NewApiTokenSqlite = typeof apiTokensSqlite.$inferInsert;
export type ApiTokenPostgres = typeof apiTokensPostgres.$inferSelect;
export type NewApiTokenPostgres = typeof apiTokensPostgres.$inferInsert;
