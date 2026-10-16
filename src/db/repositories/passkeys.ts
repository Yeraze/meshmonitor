/**
 * Repository for `user_passkeys` (issue #5841, passkey login).
 *
 * One row per WebAuthn credential on a local user. GLOBAL (account data, like
 * api_tokens): no `sourceId`. Every method that acts on one passkey by its row
 * id takes the owning `userId` too, so a caller can never touch another user's
 * passkey by guessing an id. Admin revoke passes the target user's id.
 *
 * The policy (who may register, the counter check, refusing to delete the last
 * passkey of a passkey-only account) lives in the routes; this file only
 * stores rows.
 */
import { and, asc, count, eq } from 'drizzle-orm';
import { userPasskeysPostgres } from '../schema/auth.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/** Longest nickname a passkey may carry (spec §4). */
export const PASSKEY_NICKNAME_MAX = 64;

/** A passkey as listed to its owner or an admin: no key material. */
export interface PasskeySummary {
  id: number;
  userId: number;
  nickname: string | null;
  deviceType: string | null;
  backedUp: boolean;
  transports: string[];
  /** Hostname the passkey was registered on; it does not work on any other. */
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A full passkey row, for WebAuthn verification only. */
export interface DbPasskey extends PasskeySummary {
  /** base64url credential id. */
  credentialId: string;
  /** base64url COSE public key. */
  publicKey: string;
  /** Signature counter. Synced passkeys report 0 forever. */
  counter: number;
}

export interface CreatePasskeyInput {
  userId: number;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[] | null;
  deviceType?: string | null;
  backedUp?: boolean;
  rpId: string;
  nickname?: string | null;
  /** Epoch ms; defaults to now. */
  createdAt?: number;
}

function checkNickname(nickname: string | null | undefined): string | null {
  if (nickname === null || nickname === undefined) return null;
  if (nickname.length > PASSKEY_NICKNAME_MAX) {
    throw new RangeError(`Passkey nickname is longer than ${PASSKEY_NICKNAME_MAX} characters`);
  }
  return nickname;
}

function parseTransports(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export class PasskeysRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private toSummary(raw: Record<string, unknown>): PasskeySummary {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    return {
      id: Number(r.id),
      userId: Number(r.userId),
      nickname: (r.nickname as string | null) ?? null,
      deviceType: (r.deviceType as string | null) ?? null,
      // MySQL can hand back 0/1.
      backedUp: Boolean(r.backedUp),
      transports: parseTransports(r.transports),
      rpId: String(r.rpId),
      createdAt: Number(r.createdAt),
      lastUsedAt: r.lastUsedAt === null || r.lastUsedAt === undefined ? null : Number(r.lastUsedAt),
    };
  }

  private toPasskey(raw: Record<string, unknown>): DbPasskey {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    return {
      ...this.toSummary(raw),
      credentialId: String(r.credentialId),
      publicKey: String(r.publicKey),
      counter: Number(r.counter),
    };
  }

  /** The columns a summary needs: everything but the key material. */
  private summaryColumns() {
    const t = this.tables.userPasskeys;
    return {
      id: t.id,
      userId: t.userId,
      nickname: t.nickname,
      deviceType: t.deviceType,
      backedUp: t.backedUp,
      transports: t.transports,
      rpId: t.rpId,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    };
  }

  /** Insert a passkey. Returns the new row id. Throws on a duplicate credential id. */
  async create(input: CreatePasskeyInput): Promise<number> {
    const t = this.tables.userPasskeys;
    const values = {
      userId: input.userId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports ? JSON.stringify(input.transports) : null,
      deviceType: input.deviceType ?? null,
      backedUp: input.backedUp ?? false,
      rpId: input.rpId,
      nickname: checkNickname(input.nickname),
      createdAt: input.createdAt ?? this.now(),
      lastUsedAt: null,
    };
    if (this.isSQLite()) {
      const result = await this.getSqliteDb().insert(t).values(values);
      return Number(result.lastInsertRowid);
    }
    if (this.isMySQL()) {
      const result = await this.getMysqlDb().insert(t).values(values);
      return Number(result[0].insertId);
    }
    const result = await this.getPostgresDb()
      .insert(t)
      .values(values)
      .returning({ id: userPasskeysPostgres.id });
    return result[0].id;
  }

  /** Full row (with key material) by credential id, for login verification. */
  async getByCredentialId(credentialId: string): Promise<DbPasskey | null> {
    const t = this.tables.userPasskeys;
    const rows = await this.db.select().from(t).where(eq(t.credentialId, credentialId)).limit(1);
    return rows[0] ? this.toPasskey(rows[0]) : null;
  }

  /** Full rows for one user, for `excludeCredentials` / step-up `allowCredentials`. */
  async listByUser(userId: number): Promise<DbPasskey[]> {
    const t = this.tables.userPasskeys;
    const rows = await this.db.select().from(t).where(eq(t.userId, userId)).orderBy(asc(t.id));
    return rows.map((r: Record<string, unknown>) => this.toPasskey(r));
  }

  /** One user's passkeys without key material, for the profile and admin views. */
  async listSummariesByUser(userId: number): Promise<PasskeySummary[]> {
    const t = this.tables.userPasskeys;
    const rows = await this.db
      .select(this.summaryColumns())
      .from(t)
      .where(eq(t.userId, userId))
      .orderBy(asc(t.id));
    return rows.map((r: Record<string, unknown>) => this.toSummary(r));
  }

  /** Rename a passkey the user owns. False when no such passkey belongs to them. */
  async rename(userId: number, id: number, nickname: string | null): Promise<boolean> {
    const t = this.tables.userPasskeys;
    const checked = checkNickname(nickname);
    if (!(await this.ownedBy(userId, id))) return false;
    await this.db
      .update(t)
      .set({ nickname: checked })
      .where(and(eq(t.id, id), eq(t.userId, userId)));
    return true;
  }

  /** Delete a passkey the user owns. False when no such passkey belongs to them. */
  async delete(userId: number, id: number): Promise<boolean> {
    const t = this.tables.userPasskeys;
    if (!(await this.ownedBy(userId, id))) return false;
    await this.db.delete(t).where(and(eq(t.id, id), eq(t.userId, userId)));
    return true;
  }

  /** Delete every passkey of one user. Returns how many went. */
  async deleteAllForUser(userId: number): Promise<number> {
    const t = this.tables.userPasskeys;
    const n = await this.countByUser(userId);
    if (n > 0) await this.db.delete(t).where(eq(t.userId, userId));
    return n;
  }

  /** Store the counter and last-used time after a verified login. */
  async updateCounterAndLastUsed(id: number, counter: number, lastUsedAt: number = this.now()): Promise<void> {
    const t = this.tables.userPasskeys;
    await this.db.update(t).set({ counter, lastUsedAt }).where(eq(t.id, id));
  }

  async countByUser(userId: number): Promise<number> {
    const t = this.tables.userPasskeys;
    const rows = await this.db.select({ n: count() }).from(t).where(eq(t.userId, userId));
    return Number(rows[0]?.n ?? 0);
  }

  /** Passkey count per user id, for the admin Users tab. Users with none are absent. */
  async countAllByUser(): Promise<Map<number, number>> {
    const t = this.tables.userPasskeys;
    const rows = await this.db
      .select({ userId: t.userId, n: count() })
      .from(t)
      .groupBy(t.userId);
    const counts = new Map<number, number>();
    for (const r of rows as Array<{ userId: unknown; n: unknown }>) {
      counts.set(Number(r.userId), Number(r.n));
    }
    return counts;
  }

  private async ownedBy(userId: number, id: number): Promise<boolean> {
    const t = this.tables.userPasskeys;
    const rows = await this.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }
}
