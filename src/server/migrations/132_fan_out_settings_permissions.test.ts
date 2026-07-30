/**
 * Migration 132 — fan out settings permission grants (#4416).
 *
 * This is WP2's deliverable per PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §3/§7:
 * proof that the migration preserves every user's EFFECTIVE settings access
 * exactly across the classification flip (WP1 added 'settings' to
 * SOURCEY_RESOURCES). "Exactly" means equal, not "after is a superset of
 * before" — a widening is as much a defect as a narrowing.
 *
 * Runs the real migration function (`migration.up`) directly against the
 * live `databaseService` singleton's `:memory:` SQLite connection (the same
 * pattern `routeTestApp.ts` documents: the singleton is the one true DB the
 * real `checkPermissionAsync` reads from), then asserts the AFTER state via
 * the REAL `databaseService.checkPermissionAsync`, not a re-implementation.
 * The only re-implementation in this file is the frozen BEFORE oracle below,
 * and it is deliberate — see its own comment for why.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import databaseService from '../../services/database.js';
import { migration } from './132_fan_out_settings_permissions.js';
import { logger } from '../../utils/logger.js';

let uidCounter = 0;
function uniqueUsername(prefix: string): string {
  return `mig132_${prefix}_${Date.now()}_${uidCounter++}`;
}

async function seedUser(prefix: string, isAdmin = false): Promise<number> {
  return databaseService.auth.createUser({
    username: uniqueUsername(prefix),
    authMethod: 'local',
    isAdmin,
    isActive: true,
    createdAt: Date.now(),
  });
}

interface RawRow {
  userId: number;
  resource: string;
  sourceId: string | null;
  canViewOnMap: boolean;
  canRead: boolean;
  canWrite: boolean;
}

async function seedPermission(row: {
  userId: number; resource: string; sourceId: string | null;
  canRead?: boolean; canWrite?: boolean; canViewOnMap?: boolean;
  grantedAt?: number; grantedBy?: number | null;
}): Promise<void> {
  await databaseService.auth.createPermission({
    userId: row.userId,
    resource: row.resource,
    sourceId: row.sourceId,
    canViewOnMap: row.canViewOnMap ?? false,
    canRead: row.canRead ?? false,
    canWrite: row.canWrite ?? false,
    grantedAt: row.grantedAt ?? 1000,
    grantedBy: row.grantedBy ?? null,
  });
}

function allPermissionRows(): any[] {
  return databaseService.db.prepare(`SELECT * FROM permissions ORDER BY id`).all();
}

function settingsRows(): any[] {
  return databaseService.db.prepare(`SELECT * FROM permissions WHERE resource = 'settings' ORDER BY id`).all();
}

function nonSettingsRows(): any[] {
  return databaseService.db.prepare(`SELECT * FROM permissions WHERE resource != 'settings' ORDER BY id`).all();
}

/**
 * FROZEN pre-#4416 oracle — do NOT sync this with checkPermissionAsync.
 *
 * This is a deliberate re-implementation of the NON-sourcey branch as it behaved
 * BEFORE 'settings' became a sourcey resource (services/database.ts:4392+, pre-#4416):
 * the OR across every settings row the user has, regardless of that row's scope.
 *
 * It exists because one binary cannot run both classifications — the "before" behavior
 * is gone from the source tree by the time this test executes, so the only way to prove
 * the migration preserved effective access is to model the old rule here and compare.
 *
 * If you find yourself updating this to match current checkPermissionAsync: STOP. That
 * makes the test compare the new behavior against itself and it will measure nothing.
 * If checkPermissionAsync's sourcey branch changes, this block still must not move.
 * See PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §3.2 and WP2 assertion 1.
 */
function frozenPreFlipCheck(isAdmin: boolean, rows: RawRow[], action: 'read' | 'write'): boolean {
  // Admin bypass predates and is orthogonal to the sourcey/non-sourcey split —
  // it is the very first check in checkPermissionAsync, unaffected by WP1.
  if (isAdmin) return true;
  const check = (r: RawRow) => (action === 'read' ? r.canRead : r.canWrite);
  // Old non-sourcey branch: prefer the NULL-scoped row, but if none of those
  // authorize, fall through to ANY per-source row — sourceId is never
  // consulted as a filter, only as a loop-ordering preference.
  for (const r of rows) if (!r.sourceId && check(r)) return true;
  for (const r of rows) if (r.sourceId && check(r)) return true;
  return false;
}

/**
 * `ensureAnonymousUser()` runs fire-and-forget off `waitForReady()`
 * (database.ts:3761 `this.ensureAnonymousUser().catch(...)`), so the row can
 * still be mid-insert immediately after `waitForReady()` resolves. Poll
 * briefly rather than assuming it already exists.
 */
async function waitForAnonymousUser(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const user = await databaseService.auth.getUserByUsername('anonymous');
    if (user) return user.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('anonymous user was never created by ensureAnonymousUser()');
}

describe('Migration 132 (SQLite) — upgrade proof', () => {
  let anonymousId: number;

  beforeAll(async () => {
    await databaseService.waitForReady();
    anonymousId = await waitForAnonymousUser();
  });

  // Every test gets a clean permissions + sources table: migration 132 scans
  // ALL sources and ALL settings rows in the database, so state left over
  // from a previous test in this file would silently pollute the fan-out.
  beforeEach(() => {
    databaseService.db.prepare(`DELETE FROM permissions`).run();
    databaseService.db.prepare(`DELETE FROM sources`).run();
  });

  async function makeSources(): Promise<[string, string, string]> {
    const a = `mig132-src-a-${Date.now()}-${uidCounter++}`;
    const b = `mig132-src-b-${Date.now()}-${uidCounter++}`;
    const c = `mig132-src-c-${Date.now()}-${uidCounter++}`;
    for (const id of [a, b, c]) {
      await databaseService.sources.createSource({ id, name: id, type: 'meshtastic_tcp', config: {} });
    }
    return [a, b, c];
  }

  it('preserves effective settings access exactly across the fan-out (the deliverable)', async () => {
    const [sA, sB, sC] = await makeSources();

    const u1 = await seedUser('u1');
    const u2 = await seedUser('u2');
    const u3 = await seedUser('u3');
    const u4 = await seedUser('u4'); // no settings row at all
    const u5 = await seedUser('u5');
    const u6 = await seedUser('u6');
    const u7 = await seedUser('u7', /* isAdmin */ true);
    const u8 = anonymousId; // no settings row (default seed grants exclude settings)

    const isAdminByUser = new Map<number, boolean>([
      [u1, false], [u2, false], [u3, false], [u4, false],
      [u5, false], [u6, false], [u7, true], [u8, false],
    ]);

    const rawRows: RawRow[] = [];
    const push = (r: RawRow) => { rawRows.push(r); };

    // u1: global read+write — the common case.
    await seedPermission({ userId: u1, resource: 'settings', sourceId: null, canRead: true, canWrite: true });
    push({ userId: u1, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: true });

    // u2: global read only.
    await seedPermission({ userId: u2, resource: 'settings', sourceId: null, canRead: true, canWrite: false });
    push({ userId: u2, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: false });

    // u3: global, all flags false.
    await seedPermission({ userId: u3, resource: 'settings', sourceId: null, canRead: false, canWrite: false });
    push({ userId: u3, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: false, canWrite: false });

    // u4: no settings row at all — nothing pushed, nothing seeded.

    // u5: global read + per-source-A write — mixed.
    await seedPermission({ userId: u5, resource: 'settings', sourceId: null, canRead: true, canWrite: false });
    push({ userId: u5, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: false });
    await seedPermission({ userId: u5, resource: 'settings', sourceId: sA, canRead: false, canWrite: true });
    push({ userId: u5, resource: 'settings', sourceId: sA, canViewOnMap: false, canRead: false, canWrite: true });

    // u6: ONLY per-source-A write, no global row — the historic-PUT shape (§3.2).
    await seedPermission({ userId: u6, resource: 'settings', sourceId: sA, canRead: false, canWrite: true });
    push({ userId: u6, resource: 'settings', sourceId: sA, canViewOnMap: false, canRead: false, canWrite: true });

    // u7: admin, global read+write. Rows are fanned out like anyone else's —
    // the bypass makes the row's content irrelevant to the *answer*, not to
    // whether the migration writes it.
    await seedPermission({ userId: u7, resource: 'settings', sourceId: null, canRead: true, canWrite: true });
    push({ userId: u7, resource: 'settings', sourceId: null, canViewOnMap: false, canRead: true, canWrite: true });

    // u8 (anonymous): no settings row.

    // Non-settings rows, for the "nothing else touched" assertion.
    await seedPermission({ userId: u1, resource: 'nodes', sourceId: sA, canRead: true, canWrite: false });
    await seedPermission({ userId: u2, resource: 'themes', sourceId: null, canRead: true, canWrite: true });
    const nonSettingsBefore = nonSettingsRows();

    // ---- BEFORE: frozen oracle over the raw fixture rows ----
    const users = { u1, u2, u3, u4, u5, u6, u7, u8 };
    const scopes: Array<string | undefined> = [sA, sB, sC, undefined];
    const actions: Array<'read' | 'write'> = ['read', 'write'];

    const before: Record<string, boolean> = {};
    for (const [label, userId] of Object.entries(users)) {
      const userRows = rawRows.filter((r) => r.userId === userId);
      for (const action of actions) {
        for (const scope of scopes) {
          const key = `${label}:${action}:${scope ?? 'undefined'}`;
          before[key] = frozenPreFlipCheck(isAdminByUser.get(userId)!, userRows, action);
        }
      }
    }

    // ---- Run the migration ----
    migration.up(databaseService.db);

    // ---- AFTER: the REAL checkPermissionAsync ----
    const after: Record<string, boolean> = {};
    for (const [label, userId] of Object.entries(users)) {
      for (const action of actions) {
        for (const scope of scopes) {
          const key = `${label}:${action}:${scope ?? 'undefined'}`;
          after[key] = await databaseService.checkPermissionAsync(userId, 'settings', action, scope);
        }
      }
    }

    // The deliverable: equal, not "after is a superset of before".
    expect(after).toEqual(before);

    // Assertion 2 (admin unaffected must not be the reason assertion 1 passes):
    // check u1/u2/u5/u6 individually, not just u7.
    expect(after['u1:read:undefined']).toBe(true);
    expect(after['u1:write:undefined']).toBe(true);
    expect(after['u2:read:undefined']).toBe(true);
    expect(after['u2:write:undefined']).toBe(false);
    expect(after['u5:read:undefined']).toBe(true);
    expect(after['u5:write:undefined']).toBe(true);
    expect(after['u6:read:undefined']).toBe(false);
    expect(after['u6:write:undefined']).toBe(true);
    // u7 (admin) — true everywhere, before and after.
    for (const scope of scopes) {
      for (const action of actions) {
        expect(before[`u7:${action}:${scope ?? 'undefined'}`]).toBe(true);
        expect(after[`u7:${action}:${scope ?? 'undefined'}`]).toBe(true);
      }
    }

    // Assertion 3: NULL-scoped settings rows are gone.
    const nullRows = databaseService.db.prepare(
      `SELECT COUNT(*) AS c FROM permissions WHERE resource = 'settings' AND sourceId IS NULL`
    ).get() as { c: number };
    expect(nullRows.c).toBe(0);

    // Assertion 4: row count = (users with non-all-false effective grant) x 3.
    // u1, u2, u5, u6, u7 have real access; u3 (all-false) and u4/u8 (no row) do not.
    const rows = settingsRows();
    expect(rows.length).toBe(5 * 3);

    // Assertion 5: nothing else touched.
    expect(nonSettingsRows()).toEqual(nonSettingsBefore);
  });

  it('is idempotent: a second run leaves the permissions table byte-identical', async () => {
    const [sA] = await makeSources();
    const u1 = await seedUser('idem-u1');
    const u5 = await seedUser('idem-u5');

    await seedPermission({ userId: u1, resource: 'settings', sourceId: null, canRead: true, canWrite: true });
    await seedPermission({ userId: u5, resource: 'settings', sourceId: null, canRead: true, canWrite: false });
    await seedPermission({ userId: u5, resource: 'settings', sourceId: sA, canRead: false, canWrite: true });

    migration.up(databaseService.db);
    const afterFirst = allPermissionRows();

    migration.up(databaseService.db);
    const afterSecond = allPermissionRows();

    expect(afterSecond).toEqual(afterFirst);
  });

  it('zero sources: is a no-op, the NULL rows survive, and a WARN is logged', async () => {
    // Deliberately do NOT call makeSources() — zero sources present.
    const u1 = await seedUser('zero-src-u1');
    await seedPermission({ userId: u1, resource: 'settings', sourceId: null, canRead: true, canWrite: true });

    const warnSpy = vi.spyOn(logger, 'warn');
    expect(() => migration.up(databaseService.db)).not.toThrow();

    const nullRows = databaseService.db.prepare(
      `SELECT COUNT(*) AS c FROM permissions WHERE resource = 'settings' AND sourceId IS NULL`
    ).get() as { c: number };
    expect(nullRows.c).toBe(1); // survives — NOT deleted with nothing to replace it.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not throw when the sources table is missing entirely', () => {
    const bare = new Database(':memory:');
    bare.exec(`
      CREATE TABLE permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        can_view_on_map INTEGER NOT NULL DEFAULT 0,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        granted_at INTEGER,
        granted_by INTEGER,
        sourceId TEXT
      );
    `);
    expect(() => migration.up(bare)).not.toThrow();
    bare.close();
  });

  it('zero settings permission rows: no throw, no writes', async () => {
    await makeSources();
    const u1 = await seedUser('no-settings-u1');
    // Seed a non-settings row only.
    await seedPermission({ userId: u1, resource: 'nodes', sourceId: null, canRead: true, canWrite: false });
    const before = allPermissionRows();

    expect(() => migration.up(databaseService.db)).not.toThrow();

    expect(allPermissionRows()).toEqual(before);
  });

  it('does not throw when the permissions table is missing entirely', () => {
    const bare = new Database(':memory:');
    bare.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT);`);
    bare.prepare(`INSERT INTO sources (id, name) VALUES ('s1', 'Source 1')`).run();
    expect(() => migration.up(bare)).not.toThrow();
    bare.close();
  });

  it('completes for 150 users x 3 sources without throwing (batching sanity)', async () => {
    const [, , ] = await makeSources();
    const ids: number[] = [];
    for (let i = 0; i < 150; i++) {
      const uid = await seedUser(`batch-${i}`);
      ids.push(uid);
      await seedPermission({ userId: uid, resource: 'settings', sourceId: null, canRead: true, canWrite: true });
    }

    expect(() => migration.up(databaseService.db)).not.toThrow();

    const rows = settingsRows();
    expect(rows.length).toBe(150 * 3);
  });
});
