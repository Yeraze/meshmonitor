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
  passwordHash: text('password_hash'),
  email: text('email'),
  displayName: text('display_name'),
  authMethod: text('auth_provider').notNull().default('local'), // 'local' or 'oidc'
  oidcSubject: text('oidc_subject'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  passwordLocked: integer('password_locked', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at').notNull(),
  // Note: SQLite doesn't have updated_at column
  lastLoginAt: integer('last_login_at'),
});

export const usersPostgres = pgTable('users', {
  id: pgSerial('id').primaryKey(),
  username: pgText('username').notNull().unique(),
  passwordHash: pgText('passwordHash'),
  email: pgText('email'),
  displayName: pgText('displayName'),
  authMethod: pgText('authMethod').notNull().default('local'),
  oidcSubject: pgText('oidcSubject').unique(),
  isAdmin: pgBoolean('isAdmin').notNull().default(false),
  isActive: pgBoolean('isActive').notNull().default(true),
  passwordLocked: pgBoolean('passwordLocked').default(false),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  lastLoginAt: pgBigint('lastLoginAt', { mode: 'number' }),
});

// ============ PERMISSIONS ============

export const permissionsSqlite = sqliteTable('permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  resource: text('resource').notNull(),
  canRead: integer('can_read', { mode: 'boolean' }).notNull().default(false),
  canWrite: integer('can_write', { mode: 'boolean' }).notNull().default(false),
  // Note: SQLite doesn't have can_delete column
  grantedAt: integer('granted_at').notNull(),
  grantedBy: integer('granted_by'),
});

export const permissionsPostgres = pgTable('permissions', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  resource: pgText('resource').notNull(),
  canRead: pgBoolean('canRead').notNull().default(false),
  canWrite: pgBoolean('canWrite').notNull().default(false),
  canDelete: pgBoolean('canDelete').notNull().default(false),
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
  userId: integer('user_id').references(() => usersSqlite.id, { onDelete: 'set null' }),
  username: text('username'),
  action: text('action').notNull(),
  resource: text('resource'),
  details: text('details'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  timestamp: integer('timestamp').notNull(),
});

export const auditLogPostgres = pgTable('audit_log', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').references(() => usersPostgres.id, { onDelete: 'set null' }),
  username: pgText('username'),
  action: pgText('action').notNull(),
  resource: pgText('resource'),
  details: pgText('details'),
  ipAddress: pgText('ipAddress'),
  userAgent: pgText('userAgent'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
});

// ============ API TOKENS ============

export const apiTokensSqlite = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  expiresAt: integer('expires_at'),
  createdBy: integer('created_by'),
  revokedAt: integer('revoked_at'),
  revokedBy: integer('revoked_by'),
});

export const apiTokensPostgres = pgTable('api_tokens', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  name: pgText('name').notNull(),
  tokenHash: pgText('tokenHash').notNull().unique(),
  prefix: pgText('prefix').notNull(),
  isActive: pgBoolean('isActive').notNull().default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  lastUsedAt: pgBigint('lastUsedAt', { mode: 'number' }),
  expiresAt: pgBigint('expiresAt', { mode: 'number' }),
  createdBy: pgInteger('createdBy'),
  revokedAt: pgBigint('revokedAt', { mode: 'number' }),
  revokedBy: pgInteger('revokedBy'),
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
