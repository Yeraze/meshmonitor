/**
 * PasskeysRepository + the AuthRepository passkey-only helpers (#5841), on
 * SQLite, PostgreSQL and MySQL.
 *
 * SQLite runs the full migration registry (`createTestDb`). PG/MySQL build a
 * minimal `users` table and then run the real migration 207, so the suite
 * tests the shipped DDL rather than a hand-written copy. Each container
 * backend gets its own isolated database (CLAUDE.md "PG/MySQL fixture races").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { PasskeysRepository, PASSKEY_NICKNAME_MAX, type CreatePasskeyInput } from './passkeys.js';
import { AuthRepository } from './auth.js';
import { runMigration207Postgres, runMigration207Mysql } from '../../server/migrations/207_create_user_passkeys.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

interface Ctx {
  repo: PasskeysRepository;
  auth: AuthRepository;
  alice: number;
  bob: number;
  /** Delete a user row directly (to exercise ON DELETE CASCADE). */
  deleteUser: (id: number) => Promise<void>;
}

let seq = 0;
function makePasskey(userId: number, overrides: Partial<CreatePasskeyInput> = {}): CreatePasskeyInput {
  seq += 1;
  return {
    userId,
    credentialId: `cred-${seq}`,
    publicKey: `pk-${seq}`,
    counter: 0,
    transports: ['internal', 'hybrid'],
    deviceType: 'multiDevice',
    backedUp: true,
    rpId: 'mesh.example.com',
    nickname: `Key ${seq}`,
    createdAt: 1_760_000_000_000 + seq,
    ...overrides,
  };
}

function runSharedTests(getCtx: () => Ctx) {
  it('create + getByCredentialId round-trips every field', async () => {
    const { repo, alice } = getCtx();
    const input = makePasskey(alice, { counter: 5 });
    const id = await repo.create(input);
    expect(id).toBeGreaterThan(0);

    const row = await repo.getByCredentialId(input.credentialId);
    expect(row).toEqual({
      id,
      userId: alice,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: 5,
      transports: ['internal', 'hybrid'],
      deviceType: 'multiDevice',
      backedUp: true,
      rpId: 'mesh.example.com',
      nickname: input.nickname,
      createdAt: input.createdAt,
      lastUsedAt: null,
    });
    expect(await repo.getByCredentialId('nope')).toBeNull();
  });

  it('a duplicate credential id is rejected', async () => {
    const { repo, alice, bob } = getCtx();
    const input = makePasskey(alice);
    await repo.create(input);
    await expect(repo.create({ ...input, userId: bob })).rejects.toThrow();
  });

  it('listByUser and countByUser see only that user', async () => {
    const { repo, alice, bob } = getCtx();
    await repo.create(makePasskey(alice));
    await repo.create(makePasskey(alice));
    await repo.create(makePasskey(bob));

    expect(await repo.countByUser(alice)).toBe(2);
    expect(await repo.countByUser(bob)).toBe(1);
    const list = await repo.listByUser(alice);
    expect(list).toHaveLength(2);
    expect(list.every((p) => p.userId === alice)).toBe(true);
  });

  it('listSummariesByUser carries no key material', async () => {
    const { repo, alice } = getCtx();
    await repo.create(makePasskey(alice, { transports: null, backedUp: false, deviceType: null, nickname: null }));
    const [summary] = await repo.listSummariesByUser(alice);
    expect(summary).not.toHaveProperty('publicKey');
    expect(summary).not.toHaveProperty('credentialId');
    expect(summary).not.toHaveProperty('counter');
    expect(summary).toMatchObject({
      userId: alice,
      transports: [],
      backedUp: false,
      deviceType: null,
      nickname: null,
      rpId: 'mesh.example.com',
      lastUsedAt: null,
    });
  });

  it('rename is scoped to the owner and caps the nickname length', async () => {
    const { repo, alice, bob } = getCtx();
    const id = await repo.create(makePasskey(alice));

    expect(await repo.rename(bob, id, 'stolen')).toBe(false);
    expect((await repo.listSummariesByUser(alice))[0].nickname).not.toBe('stolen');

    expect(await repo.rename(alice, id, 'Phone')).toBe(true);
    expect((await repo.listSummariesByUser(alice))[0].nickname).toBe('Phone');

    await expect(repo.rename(alice, id, 'x'.repeat(PASSKEY_NICKNAME_MAX + 1))).rejects.toThrow(RangeError);
    await expect(repo.create(makePasskey(alice, { nickname: 'x'.repeat(PASSKEY_NICKNAME_MAX + 1) }))).rejects.toThrow(RangeError);
  });

  it("delete cannot remove another user's passkey", async () => {
    const { repo, alice, bob } = getCtx();
    const id = await repo.create(makePasskey(alice));

    expect(await repo.delete(bob, id)).toBe(false);
    expect(await repo.countByUser(alice)).toBe(1);

    expect(await repo.delete(alice, id)).toBe(true);
    expect(await repo.countByUser(alice)).toBe(0);
    expect(await repo.delete(alice, id)).toBe(false);
  });

  it('deleteAllForUser removes only that user', async () => {
    const { repo, alice, bob } = getCtx();
    await repo.create(makePasskey(alice));
    await repo.create(makePasskey(alice));
    await repo.create(makePasskey(bob));

    expect(await repo.deleteAllForUser(alice)).toBe(2);
    expect(await repo.countByUser(alice)).toBe(0);
    expect(await repo.countByUser(bob)).toBe(1);
    expect(await repo.deleteAllForUser(alice)).toBe(0);
  });

  it('updateCounterAndLastUsed stores a large counter and the time', async () => {
    const { repo, alice } = getCtx();
    const input = makePasskey(alice);
    const id = await repo.create(input);

    // Above signed 32-bit: the column must be a bigint.
    await repo.updateCounterAndLastUsed(id, 3_000_000_000, 1_760_000_123_456);
    const row = await repo.getByCredentialId(input.credentialId);
    expect(row?.counter).toBe(3_000_000_000);
    expect(row?.lastUsedAt).toBe(1_760_000_123_456);
  });

  it("deleting a user cascades to that user's passkeys", async () => {
    const { repo, alice, bob, deleteUser } = getCtx();
    await repo.create(makePasskey(alice));
    await repo.create(makePasskey(bob));

    await deleteUser(alice);
    expect(await repo.countByUser(alice)).toBe(0);
    expect(await repo.countByUser(bob)).toBe(1);
  });

  it('passkey-only state: defaults, set, clear', async () => {
    const { auth, alice } = getCtx();
    expect(await auth.getPasskeyLoginState(alice)).toEqual({ passwordLoginDisabled: false, passkeyRecoveryCodes: null });
    expect(await auth.getPasskeyLoginState(999_999)).toBeNull();

    await auth.setPasswordLoginDisabled(alice, true);
    await auth.setPasskeyRecoveryCodes(alice, '["$2b$hash"]');
    expect(await auth.getPasskeyLoginState(alice)).toEqual({ passwordLoginDisabled: true, passkeyRecoveryCodes: '["$2b$hash"]' });

    await auth.setPasswordLoginDisabled(alice, false);
    await auth.setPasskeyRecoveryCodes(alice, null);
    expect(await auth.getPasskeyLoginState(alice)).toEqual({ passwordLoginDisabled: false, passkeyRecoveryCodes: null });
  });
}

// --- SQLite (full migration registry) ---
describe('PasskeysRepository — SQLite', () => {
  let t: TestDb;
  let ctx: Ctx;

  beforeEach(async () => {
    t = createTestDb();
    t.sqlite.pragma('foreign_keys = ON');
    const auth = new AuthRepository(t.db as any, 'sqlite');
    const alice = await auth.createUser({ username: 'alice', authMethod: 'local', createdAt: 1 });
    const bob = await auth.createUser({ username: 'bob', authMethod: 'local', createdAt: 1 });
    ctx = {
      repo: new PasskeysRepository(t.db as any, 'sqlite'),
      auth,
      alice,
      bob,
      deleteUser: async (id) => {
        t.sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
      },
    };
    return () => t.close();
  });

  runSharedTests(() => ctx);
});

// --- PostgreSQL ---
describe.skipIf(!postgresAvailable)('PasskeysRepository — PostgreSQL', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let ctx: Ctx;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('r_passkeys'));
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        "updatedAt" BIGINT NOT NULL DEFAULT 0
      )
    `);
    const client = await pool.connect();
    try {
      await runMigration207Postgres(client);
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE user_passkeys, users RESTART IDENTITY CASCADE');
    const { rows } = await pool.query(`INSERT INTO users (username) VALUES ('alice'), ('bob') RETURNING id`);
    const db = drizzlePostgres(pool, { schema });
    ctx = {
      repo: new PasskeysRepository(db as any, 'postgres'),
      auth: new AuthRepository(db as any, 'postgres'),
      alice: rows[0].id,
      bob: rows[1].id,
      deleteUser: async (id) => {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
      },
    };
  });

  runSharedTests(() => ctx);
});

// --- MySQL ---
describe.skipIf(!mysqlAvailable)('PasskeysRepository — MySQL', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let ctx: Ctx;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('r_passkeys'));
    await pool.query(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        updatedAt BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await runMigration207Mysql(pool);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM user_passkeys');
    await pool.query('DELETE FROM users');
    await pool.query(`INSERT INTO users (username) VALUES ('alice'), ('bob')`);
    const [rows] = await pool.query(`SELECT id, username FROM users ORDER BY id`);
    const ids = rows as Array<{ id: number; username: string }>;
    const db = drizzleMysql(pool, { schema, mode: 'default' });
    ctx = {
      repo: new PasskeysRepository(db as any, 'mysql'),
      auth: new AuthRepository(db as any, 'mysql'),
      alice: ids.find((r) => r.username === 'alice')!.id,
      bob: ids.find((r) => r.username === 'bob')!.id,
      deleteUser: async (id) => {
        await pool.query('DELETE FROM users WHERE id = ?', [id]);
      },
    };
  });

  runSharedTests(() => ctx);
});
