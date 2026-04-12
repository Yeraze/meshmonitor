# Per-Source Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce strict per-source permissions for channel/node/message/telemetry resources so a grant on Source 1 cannot leak to Source 2.

**Architecture:** Migration 033 expands existing global grants into per-source rows and adds a new unique index. Runtime enforcement denies sourcey-resource checks that lack a sourceId. Filter helpers in nodeEnhancer.ts gain a sourceId parameter, and routes thread source.id into them.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, React, better-sqlite3, pg, mysql2

**Spec:** `docs/superpowers/specs/2026-04-12-per-source-permissions-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/server/constants/permissions.ts` | CREATE | SOURCEY_RESOURCES set + isResourceSourcey helper |
| `src/server/migrations/033_per_source_permissions.ts` | CREATE | Drop old unique, expand data, add new unique (3 dialects) |
| `src/db/migrations.ts` | MODIFY | Register migration 033 |
| `src/db/migrations.test.ts` | MODIFY | Increment count + last-name assertion |
| `src/services/database.ts` | MODIFY | checkPermissionAsync + getUserPermissionSetAsync per-source logic |
| `src/server/utils/nodeEnhancer.ts` | MODIFY | Add sourceId param to filter/mask helpers |
| `src/server/routes/sourceRoutes.ts` | MODIFY | Thread source.id into nodeEnhancer calls |
| `src/server/routes/userRoutes.ts` | MODIFY | 400 validation on scope/resource mismatch |
| `src/components/UsersTab.tsx` | MODIFY | Scope-aware resource grid |
| `src/server/utils/nodeEnhancer.test.ts` | MODIFY | Two-source regression tests |
| `src/server/routes/sourceRoutes.permissions.test.ts` | MODIFY | Cross-source leak regression |

---

### Task 1: Permission Constants

**Files:**
- Create: `src/server/constants/permissions.ts`

- [ ] **Step 1: Create the constants file**

```typescript
// src/server/constants/permissions.ts
/**
 * Resource classification for per-source permissions.
 *
 * Sourcey resources require a sourceId for every permission check.
 * Global resources ignore sourceId entirely.
 */
export const SOURCEY_RESOURCES = new Set<string>([
  'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7',
  'messages', 'nodes', 'nodes_private', 'traceroute',
  'packetmonitor', 'configuration', 'connection', 'automation',
]);

export const isResourceSourcey = (resource: string): boolean =>
  SOURCEY_RESOURCES.has(resource);
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/server/constants/permissions.ts
git commit -m "feat(permissions): add SOURCEY_RESOURCES constant and isResourceSourcey helper"
```

---

### Task 2: Migration 033 — SQLite

**Files:**
- Create: `src/server/migrations/033_per_source_permissions.ts`

- [ ] **Step 1: Create the migration file with SQLite implementation**

```typescript
// src/server/migrations/033_per_source_permissions.ts
/**
 * Migration 033: Per-source permissions enforcement.
 *
 * Context:
 *   Permissions were partially per-source (migration 022 added sourceId column)
 *   but enforcement was global. This migration:
 *   1. Expands existing global grants for sourcey resources into per-source rows
 *   2. Drops the old UNIQUE(user_id, resource) constraint
 *   3. Creates UNIQUE(user_id, resource, sourceId) to support multiple per-source rows
 *   4. Migrates orphaned virtual channel rows to the default source
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { SOURCEY_RESOURCES } from '../constants/permissions.js';

const OLD_INDEX = 'permissions_user_id_resource_unique';
const NEW_INDEX = 'permissions_user_resource_source_uniq';
const SOURCEY_LIST = [...SOURCEY_RESOURCES].map(r => `'${r}'`).join(',');

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 033 (SQLite): per-source permissions...');

    // 1. Get all source IDs
    const sources = db.prepare('SELECT id FROM sources').all() as { id: string }[];
    const sourceIds = sources.map(s => s.id);

    // 2. Expand global grants for sourcey resources into per-source rows
    const globalSourceyRows = db.prepare(`
      SELECT id, user_id, resource, can_view_on_map, can_read, can_write, can_delete,
             granted_at, granted_by
      FROM permissions
      WHERE sourceId IS NULL
        AND resource IN (${SOURCEY_LIST})
    `).all() as any[];

    let expanded = 0;
    if (globalSourceyRows.length > 0 && sourceIds.length > 0) {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO permissions
          (user_id, resource, can_view_on_map, can_read, can_write, can_delete,
           granted_at, granted_by, sourceId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of globalSourceyRows) {
        for (const sid of sourceIds) {
          const result = insertStmt.run(
            row.user_id, row.resource, row.can_view_on_map, row.can_read,
            row.can_write, row.can_delete ?? 0, row.granted_at, row.granted_by, sid
          );
          if (result.changes > 0) expanded++;
        }
      }
    }

    // 3. Delete the original global rows for sourcey resources
    const deleteResult = db.prepare(`
      DELETE FROM permissions
      WHERE sourceId IS NULL
        AND resource IN (${SOURCEY_LIST})
    `).run();

    if (expanded > 0 || deleteResult.changes > 0) {
      logger.info(
        `Migration 033 (SQLite): expanded ${expanded} per-source rows, ` +
        `deleted ${deleteResult.changes} global sourcey rows`
      );
    }

    // 4. Drop old unique index (may not exist if instance was created after migration 022)
    try {
      db.exec(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
    } catch {
      // Index may not exist — safe to ignore
    }
    // Also try the raw SQLite auto-generated name pattern
    try {
      db.exec('DROP INDEX IF EXISTS sqlite_autoindex_permissions_1');
    } catch {
      // safe to ignore
    }

    // 5. Create new unique index
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_INDEX}
        ON permissions(user_id, resource, sourceId)
    `);

    // 6. Migrate orphaned virtual channel rows to default source
    if (sourceIds.length > 0) {
      const defaultSourceId = sourceIds[0];
      const vcResult = db.prepare(`
        UPDATE channel_database SET sourceId = ? WHERE sourceId IS NULL
      `).run(defaultSourceId);
      if (vcResult.changes > 0) {
        logger.info(`Migration 033 (SQLite): migrated ${vcResult.changes} virtual channels to source '${defaultSourceId}'`);
      }
    }

    logger.info('Migration 033 complete (SQLite)');
  },

  down: (db: Database): void => {
    db.exec(`DROP INDEX IF EXISTS ${NEW_INDEX}`);
  },
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/server/migrations/033_per_source_permissions.ts
git commit -m "feat(migration-033): SQLite per-source permissions expansion + unique index"
```

---

### Task 3: Migration 033 — PostgreSQL and MySQL

**Files:**
- Modify: `src/server/migrations/033_per_source_permissions.ts`

- [ ] **Step 1: Add PostgreSQL implementation**

Append to the migration file after the SQLite section:

```typescript
// ============ PostgreSQL ============

export async function runMigration033Postgres(client: any): Promise<void> {
  logger.info('Running migration 033 (PostgreSQL): per-source permissions...');

  // 1. Get all source IDs
  const sourcesResult = await client.query('SELECT id FROM sources');
  const sourceIds: string[] = sourcesResult.rows.map((r: any) => r.id);

  // 2. Expand global grants for sourcey resources into per-source rows
  if (sourceIds.length > 0) {
    for (const sid of sourceIds) {
      const expandResult = await client.query(`
        INSERT INTO permissions
          ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete",
           "grantedAt", "grantedBy", "sourceId")
        SELECT "userId", resource, "canViewOnMap", "canRead", "canWrite",
               COALESCE("canDelete", false), "grantedAt", "grantedBy", $1
        FROM permissions
        WHERE "sourceId" IS NULL
          AND resource = ANY($2::text[])
        ON CONFLICT DO NOTHING
      `, [sid, [...SOURCEY_RESOURCES]]);
      if (expandResult.rowCount && expandResult.rowCount > 0) {
        logger.info(`Migration 033 (PostgreSQL): expanded ${expandResult.rowCount} rows for source '${sid}'`);
      }
    }
  }

  // 3. Delete global sourcey rows
  const deleteResult = await client.query(`
    DELETE FROM permissions
    WHERE "sourceId" IS NULL
      AND resource = ANY($1::text[])
  `, [[...SOURCEY_RESOURCES]]);
  if (deleteResult.rowCount && deleteResult.rowCount > 0) {
    logger.info(`Migration 033 (PostgreSQL): deleted ${deleteResult.rowCount} global sourcey rows`);
  }

  // 4. Drop old unique index
  await client.query(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
  // Also try common auto-generated names
  await client.query('DROP INDEX IF EXISTS permissions_user_id_resource_key');
  await client.query('DROP INDEX IF EXISTS permissions_userId_resource_key');

  // 5. Create new unique index
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_INDEX}
      ON permissions("userId", resource, "sourceId")
  `);

  // 6. Migrate orphaned virtual channels
  if (sourceIds.length > 0) {
    const vcResult = await client.query(
      'UPDATE channel_database SET "sourceId" = $1 WHERE "sourceId" IS NULL',
      [sourceIds[0]]
    );
    if (vcResult.rowCount && vcResult.rowCount > 0) {
      logger.info(`Migration 033 (PostgreSQL): migrated ${vcResult.rowCount} virtual channels`);
    }
  }

  logger.info('Migration 033 complete (PostgreSQL)');
}
```

- [ ] **Step 2: Add MySQL implementation**

Append to the migration file:

```typescript
// ============ MySQL ============

export async function runMigration033Mysql(pool: any): Promise<void> {
  logger.info('Running migration 033 (MySQL): per-source permissions...');

  const conn = await pool.getConnection();
  try {
    // 1. Get all source IDs
    const [sourceRows] = await conn.query('SELECT id FROM sources');
    const sourceIds: string[] = (sourceRows as any[]).map(r => r.id);

    // 2. Expand global grants for sourcey resources
    const sourceyArray = [...SOURCEY_RESOURCES];
    if (sourceIds.length > 0) {
      for (const sid of sourceIds) {
        const placeholders = sourceyArray.map(() => '?').join(',');
        const [expandResult] = await conn.query(`
          INSERT IGNORE INTO permissions
            (userId, resource, canViewOnMap, canRead, canWrite, canDelete,
             grantedAt, grantedBy, sourceId)
          SELECT userId, resource, canViewOnMap, canRead, canWrite,
                 COALESCE(canDelete, 0), grantedAt, grantedBy, ?
          FROM permissions
          WHERE sourceId IS NULL
            AND resource IN (${placeholders})
        `, [sid, ...sourceyArray]);
        const affected = (expandResult as any)?.affectedRows ?? 0;
        if (affected > 0) {
          logger.info(`Migration 033 (MySQL): expanded ${affected} rows for source '${sid}'`);
        }
      }
    }

    // 3. Delete global sourcey rows
    const placeholders = sourceyArray.map(() => '?').join(',');
    const [deleteResult] = await conn.query(`
      DELETE FROM permissions
      WHERE sourceId IS NULL
        AND resource IN (${placeholders})
    `, sourceyArray);
    const deleted = (deleteResult as any)?.affectedRows ?? 0;
    if (deleted > 0) {
      logger.info(`Migration 033 (MySQL): deleted ${deleted} global sourcey rows`);
    }

    // 4. Drop old unique index (MySQL requires exact name — check information_schema)
    const [existingIdx] = await conn.query(`
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'permissions'
        AND NON_UNIQUE = 0
        AND INDEX_NAME != 'PRIMARY'
        AND COLUMN_NAME IN ('userId', 'user_id')
      GROUP BY INDEX_NAME
    `);
    for (const idx of existingIdx as any[]) {
      if (idx.INDEX_NAME !== NEW_INDEX) {
        await conn.query(`DROP INDEX \`${idx.INDEX_NAME}\` ON permissions`);
        logger.info(`Migration 033 (MySQL): dropped old index '${idx.INDEX_NAME}'`);
      }
    }

    // 5. Create new unique index (idempotent via information_schema check)
    const [newIdxRows] = await conn.query(`
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'permissions'
        AND INDEX_NAME = ?
    `, [NEW_INDEX]);
    if ((newIdxRows as any[]).length === 0) {
      await conn.query(`
        CREATE UNIQUE INDEX \`${NEW_INDEX}\`
          ON permissions(userId, resource, sourceId)
      `);
    }

    // 6. Migrate orphaned virtual channels
    if (sourceIds.length > 0) {
      const [vcResult] = await conn.query(
        'UPDATE channel_database SET sourceId = ? WHERE sourceId IS NULL',
        [sourceIds[0]]
      );
      const vcAffected = (vcResult as any)?.affectedRows ?? 0;
      if (vcAffected > 0) {
        logger.info(`Migration 033 (MySQL): migrated ${vcAffected} virtual channels`);
      }
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 033 complete (MySQL)');
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/server/migrations/033_per_source_permissions.ts
git commit -m "feat(migration-033): add PostgreSQL and MySQL implementations"
```

---

### Task 4: Register Migration 033

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/db/migrations.test.ts`

- [ ] **Step 1: Add import to migrations.ts**

At the top of `src/db/migrations.ts`, after the migration 032 import, add:

```typescript
import {
  migration as perSourcePermsMigration,
  runMigration033Postgres,
  runMigration033Mysql,
} from '../server/migrations/033_per_source_permissions.js';
```

- [ ] **Step 2: Register migration 033**

After the migration 032 `registry.register(...)` block (~line 465), add:

```typescript
registry.register({
  number: 33,
  name: 'per_source_permissions',
  settingsKey: 'migration_033_per_source_permissions',
  sqlite: (db) => perSourcePermsMigration.up(db),
  postgres: (client) => runMigration033Postgres(client),
  mysql: (pool) => runMigration033Mysql(pool),
});
```

- [ ] **Step 3: Update header comment**

Change "Registers all 32 migrations" to "Registers all 33 migrations" in the file header.

- [ ] **Step 4: Update migrations.test.ts**

In `src/db/migrations.test.ts`, update:
- `has all 32 migrations registered` → `has all 33 migrations registered` (`.toBe(32)` → `.toBe(33)`)
- `last migration is telemetry_packet_dedupe` → `last migration is per_source_permissions` (`.toBe(32)` → `.toBe(33)`, `.toContain('telemetry_packet_dedupe')` → `.toContain('per_source_permissions')`)
- `migrations are sequentially numbered from 1 to 32` → `from 1 to 33`

- [ ] **Step 5: Run targeted tests**

Run: `./node_modules/.bin/vitest run src/db/migrations.test.ts`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(migration-033): register per_source_permissions migration"
```

---

### Task 5: Runtime Enforcement — checkPermissionAsync

**Files:**
- Modify: `src/services/database.ts`

- [ ] **Step 1: Add import**

At the top of `src/services/database.ts`, add:

```typescript
import { isResourceSourcey } from '../server/constants/permissions.js';
```

- [ ] **Step 2: Rewrite checkPermissionAsync**

Replace the body of `checkPermissionAsync` (at ~line 10065) with:

```typescript
  async checkPermissionAsync(userId: number, resource: string, action: string, sourceId?: string): Promise<boolean> {
    const permissions = await this.auth.getPermissionsForUser(userId);

    const check = (perm: (typeof permissions)[0]): boolean => {
      if (action === 'viewOnMap') return !!(perm as any).canViewOnMap;
      if (action === 'read') return !!(perm as any).canRead;
      if (action === 'write') return !!(perm as any).canWrite;
      return false;
    };

    if (isResourceSourcey(resource)) {
      // Sourcey resources REQUIRE a sourceId — deny without one
      if (!sourceId) {
        logger.warn(`checkPermissionAsync: sourcey resource '${resource}' checked without sourceId — denying`);
        return false;
      }
      // Look for exact (user, resource, sourceId) match — no global fallback
      for (const perm of permissions) {
        if (perm.resource === resource && (perm as any).sourceId === sourceId) {
          return check(perm);
        }
      }
      return false;
    }

    // Global resources — ignore sourceId, look for NULL-sourceId row
    for (const perm of permissions) {
      if (perm.resource === resource && !(perm as any).sourceId) {
        return check(perm);
      }
    }

    return false;
  }
```

- [ ] **Step 3: Rewrite getUserPermissionSetAsync**

Replace the body of `getUserPermissionSetAsync` (at ~line 10098) with:

```typescript
  async getUserPermissionSetAsync(userId: number, sourceId?: string): Promise<Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }>> {
    const permissions = await this.auth.getPermissionsForUser(userId);
    const permissionSet: Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }> = {};

    // Always include global resources (NULL sourceId rows for non-sourcey resources)
    for (const perm of permissions) {
      if (!isResourceSourcey(perm.resource) && !(perm as any).sourceId) {
        permissionSet[perm.resource] = {
          viewOnMap: (perm as any).canViewOnMap ?? false,
          read: perm.canRead,
          write: perm.canWrite,
        };
      }
    }

    // Include sourcey resources ONLY when sourceId is provided
    if (sourceId) {
      for (const perm of permissions) {
        if (isResourceSourcey(perm.resource) && (perm as any).sourceId === sourceId) {
          permissionSet[perm.resource] = {
            viewOnMap: (perm as any).canViewOnMap ?? false,
            read: perm.canRead,
            write: perm.canWrite,
          };
        }
      }
    }
    // When sourceId is NOT provided, sourcey resources are absent from the set

    return permissionSet;
  }
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 5: Run full test suite to find breakage**

Run: `./node_modules/.bin/vitest run 2>&1 | tail -20`

Some tests may fail because they rely on the old global-fallback behavior. Fix any that break — they should be updated to pass a sourceId for sourcey resource checks, or the test fixture should grant the appropriate per-source permission.

- [ ] **Step 6: Commit**

```bash
git add src/services/database.ts
git commit -m "feat(permissions): enforce per-source checks for sourcey resources in checkPermissionAsync and getUserPermissionSetAsync"
```

---

### Task 6: nodeEnhancer — Thread sourceId

**Files:**
- Modify: `src/server/utils/nodeEnhancer.ts`
- Modify: `src/server/utils/nodeEnhancer.test.ts`

- [ ] **Step 1: Write failing test — filterNodesByChannelPermission with sourceId**

Add to `src/server/utils/nodeEnhancer.test.ts` in the `filterNodesByChannelPermission` describe block:

```typescript
it('filters using per-source permissions when sourceId is provided', async () => {
  // Mock getUserPermissionSetAsync to verify sourceId is passed through
  const spy = vi.spyOn(databaseService, 'getUserPermissionSetAsync');
  spy.mockResolvedValue({
    channel_0: { viewOnMap: true, read: true, write: false },
  });

  const nodes = [{ channel: 0, nodeNum: 1 }];
  const result = await filterNodesByChannelPermission(nodes, regularUser, 'src-1');

  expect(spy).toHaveBeenCalledWith(regularUser.id, 'src-1');
  expect(result).toHaveLength(1);
  spy.mockRestore();
});

it('returns empty when no sourceId provided (sourcey perms absent)', async () => {
  const spy = vi.spyOn(databaseService, 'getUserPermissionSetAsync');
  spy.mockResolvedValue({}); // no sourcey resources returned without sourceId

  const nodes = [{ channel: 0, nodeNum: 1 }];
  const result = await filterNodesByChannelPermission(nodes, regularUser);

  expect(spy).toHaveBeenCalledWith(regularUser.id, undefined);
  expect(result).toHaveLength(0);
  spy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run src/server/utils/nodeEnhancer.test.ts`
Expected: FAIL — `filterNodesByChannelPermission` doesn't accept sourceId param yet

- [ ] **Step 3: Add sourceId parameter to filterNodesByChannelPermission**

In `src/server/utils/nodeEnhancer.ts`, update the signature at line ~81:

```typescript
export async function filterNodesByChannelPermission<T>(
  nodes: T[],
  user: User | null | undefined,
  sourceId?: string
): Promise<T[]> {
```

And update the `getUserPermissionSetAsync` call at line ~92:

```typescript
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};
```

- [ ] **Step 4: Add sourceId parameter to maskNodeLocationByChannel**

Same pattern — update signature at line ~133:

```typescript
export async function maskNodeLocationByChannel<T>(
  nodes: T[],
  user: User | null | undefined,
  sourceId?: string
): Promise<T[]> {
```

And update the `getUserPermissionSetAsync` call at line ~141:

```typescript
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id, sourceId)
    : {};
```

- [ ] **Step 5: Add sourceId parameter to maskTelemetryByChannel and maskTraceroutesByChannel**

Find these functions and apply the same pattern: add `sourceId?: string` param, pass it to `getUserPermissionSetAsync`.

- [ ] **Step 6: Add sourceId parameter to checkNodeChannelAccess**

Same pattern at line ~280.

- [ ] **Step 7: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/server/utils/nodeEnhancer.test.ts`
Expected: PASS

- [ ] **Step 8: Fix any callers that break due to new parameter**

Run: `npx tsc --noEmit`
If any callers fail to compile because of the new optional param, update them. The param is optional so most should be fine, but verify.

- [ ] **Step 9: Commit**

```bash
git add src/server/utils/nodeEnhancer.ts src/server/utils/nodeEnhancer.test.ts
git commit -m "feat(nodeEnhancer): thread sourceId into filter/mask permission helpers"
```

---

### Task 7: Route Wiring — sourceRoutes

**Files:**
- Modify: `src/server/routes/sourceRoutes.ts`

- [ ] **Step 1: Thread source.id into nodeEnhancer calls in GET /:id/nodes**

At `sourceRoutes.ts:330-331`, change:

```typescript
    const filtered = await filterNodesByChannelPermission(nodes, user);
    const masked = await maskNodeLocationByChannel(filtered, user);
```

To:

```typescript
    const filtered = await filterNodesByChannelPermission(nodes, user, source.id);
    const masked = await maskNodeLocationByChannel(filtered, user, source.id);
```

- [ ] **Step 2: Find and update any other nodeEnhancer calls in sourceRoutes.ts**

Search for `maskTelemetryByChannel`, `maskTraceroutesByChannel`, `checkNodeChannelAccess` in sourceRoutes.ts. For each, add `source.id` as the sourceId argument. The source variable is available in each handler because `const source = await databaseService.sources.getSource(req.params.id)` is called at the top of each route handler.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Run sourceRoutes tests**

Run: `./node_modules/.bin/vitest run src/server/routes/sourceRoutes`
Expected: PASS (existing tests should still pass since the added param is backward-compatible)

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/sourceRoutes.ts
git commit -m "fix(sourceRoutes): thread source.id into nodeEnhancer permission helpers"
```

---

### Task 8: PUT Permissions Scope Validation

**Files:**
- Modify: `src/server/routes/userRoutes.ts`

- [ ] **Step 1: Add import**

At the top of `src/server/routes/userRoutes.ts`:

```typescript
import { isResourceSourcey } from '../constants/permissions.js';
```

- [ ] **Step 2: Add validation in the PUT /:id/permissions handler**

In the PUT handler at ~line 386, after the existing `write implies read` validation block and before the `deletePermissionsForUserByScope` call, add:

```typescript
    // Validate resource/scope consistency
    for (const resource of Object.keys(permissions)) {
      if (sourceId && !isResourceSourcey(resource)) {
        return res.status(400).json({
          error: `Resource '${resource}' is global and cannot be granted per-source`,
        });
      }
      if (!sourceId && isResourceSourcey(resource)) {
        return res.status(400).json({
          error: `Resource '${resource}' requires a sourceId and cannot be granted globally`,
        });
      }
    }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Write test for scope/resource mismatch**

Add to `src/server/routes/userRoutes.test.ts` in the `PUT /:id/permissions` describe:

```typescript
it('should reject sourcey resource in global scope', async () => {
  const res = await request(app)
    .put('/api/users/1/permissions')
    .set('Cookie', adminCookie)
    .send({
      permissions: { channel_0: { viewOnMap: true, read: true, write: false } },
      // no sourceId → global scope
    });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('requires a sourceId');
});

it('should reject global resource in per-source scope', async () => {
  const res = await request(app)
    .put('/api/users/1/permissions')
    .set('Cookie', adminCookie)
    .send({
      permissions: { users: { read: true, write: false } },
      sourceId: 'src-1',
    });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('global and cannot be granted per-source');
});
```

- [ ] **Step 5: Run tests**

Run: `./node_modules/.bin/vitest run src/server/routes/userRoutes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/userRoutes.ts src/server/routes/userRoutes.test.ts
git commit -m "feat(userRoutes): validate resource/scope consistency on permission save"
```

---

### Task 9: Frontend — Scope-Aware UsersTab

**Files:**
- Modify: `src/components/UsersTab.tsx`

- [ ] **Step 1: Import the resource classification**

Add near the top of `UsersTab.tsx`:

```typescript
const SOURCEY_RESOURCES = new Set([
  'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7',
  'messages', 'nodes', 'nodes_private', 'traceroute',
  'packetmonitor', 'configuration', 'connection', 'automation',
]);
const isResourceSourcey = (r: string) => SOURCEY_RESOURCES.has(r);
```

Note: This duplicates the server constant because the frontend bundle doesn't import server code. Keep both in sync. If the project later adds a shared constants package, consolidate then.

- [ ] **Step 2: Filter resources by scope in the permission grid**

Find where the resource list is rendered (look for where `Object.entries(permissions)` or a resource array is mapped into UI rows). Wrap with a filter:

```typescript
const visibleResources = Object.entries(permissions).filter(([resource]) => {
  if (permissionScope === null) {
    // Global scope: show only global resources
    return !isResourceSourcey(resource);
  } else {
    // Per-source scope: show only sourcey resources
    return isResourceSourcey(resource);
  }
});
```

Use `visibleResources` instead of the full list when rendering.

- [ ] **Step 3: Add help text near the scope dropdown**

Below the scope selector dropdown, add a small note:

```tsx
<p className="text-xs text-gray-500 mt-1">
  {permissionScope === null
    ? t('users.global_permissions_hint', 'Global permissions control instance-wide features.')
    : t('users.source_permissions_hint', 'Channel, message, and node permissions are granted per-source.')}
</p>
```

- [ ] **Step 4: Ensure save only includes valid resources for the scope**

In the `handleSavePermissions` function, before sending the PUT request, filter the permission object to only include resources valid for the current scope:

```typescript
const validPermissions: PermissionSet = {};
for (const [resource, perms] of Object.entries(editablePermissions)) {
  if (permissionScope === null && !isResourceSourcey(resource)) {
    validPermissions[resource] = perms;
  } else if (permissionScope !== null && isResourceSourcey(resource)) {
    validPermissions[resource] = perms;
  }
}
```

Then send `validPermissions` instead of the full object.

- [ ] **Step 5: Test manually in browser**

Start dev container, navigate to Settings > Users. Select a user:
- With "Global" scope: verify only global resources (users, settings, security, etc.) appear
- Switch to a source: verify only sourcey resources (channels, messages, nodes, etc.) appear
- Save in each scope: verify no 400 error
- Toggle a channel permission on Source 1, check Source 2: verify it didn't leak

- [ ] **Step 6: Commit**

```bash
git add src/components/UsersTab.tsx
git commit -m "feat(UsersTab): scope-aware resource grid — sourcey resources per-source only"
```

---

### Task 10: Integration Regression Tests

**Files:**
- Modify: `src/server/routes/sourceRoutes.permissions.test.ts` (or create if it doesn't exist)

- [ ] **Step 1: Write the cross-source leak regression test**

This test recreates the exact bug report: grant `channel_0:viewOnMap` on Source 1, then verify Source 2 nodes are filtered.

```typescript
describe('per-source permission isolation', () => {
  it('channel_0:viewOnMap on src-1 does NOT leak to src-2 (regression)', async () => {
    // Setup: create two sources
    // Grant anonymous user channel_0:viewOnMap on src-1 only
    // Insert a node on channel 0 for both sources
    // GET /api/sources/src-1/nodes → expect node visible
    // GET /api/sources/src-2/nodes → expect node FILTERED OUT
  });

  it('grant on src-1 and src-2 independently allows both', async () => {
    // Grant channel_0:viewOnMap on BOTH sources
    // Both /api/sources/src-1/nodes and /api/sources/src-2/nodes return the node
  });

  it('admin sees nodes on all sources regardless of grants', async () => {
    // Admin user, no per-source grants
    // Both sources return all nodes
  });
});
```

Fill in the test bodies using the existing test setup patterns from `sourceRoutes.permissions.test.ts` (mock `databaseService`, create sources and nodes fixtures, call the route handlers).

- [ ] **Step 2: Run the regression tests**

Run: `./node_modules/.bin/vitest run src/server/routes/sourceRoutes.permissions.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/sourceRoutes.permissions.test.ts
git commit -m "test(permissions): cross-source leak regression tests"
```

---

### Task 11: Final Verification

- [ ] **Step 1: TypeScript check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 2: Full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all pass, 0 failures

- [ ] **Step 3: Deploy to SQLite dev container**

Build and deploy via docker compose. Verify:
- Container starts without migration errors
- Migration 033 log lines appear: "Running migration 033 (SQLite): per-source permissions..."
- Health endpoint returns 200

- [ ] **Step 4: Manual smoke test**

In the browser at port 8081:
1. Go to Settings > Users
2. Select the Anonymous user
3. Switch scope dropdown to Source 1
4. Grant channel_0 viewOnMap
5. Switch to Source 2 — verify channel_0 viewOnMap is NOT granted
6. Go to the map for Source 1 — verify channel-0 nodes appear
7. Go to the map for Source 2 — verify channel-0 nodes do NOT appear (unless separately granted)

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: address any remaining issues from final verification"
```

- [ ] **Step 6: Create PR**

Use `/create-pr` skill with args: "fixes cross-source permission leak — strict per-source enforcement for channel/node/message resources"

---

## Dependency Graph

```
Task 1 (constants)
  ↓
Task 2 (migration SQLite) → Task 3 (migration PG/MySQL) → Task 4 (register + test)
  ↓
Task 5 (runtime enforcement)
  ↓
Task 6 (nodeEnhancer) → Task 7 (route wiring)
  ↓
Task 8 (scope validation)
  ↓
Task 9 (frontend)
  ↓
Task 10 (regression tests) → Task 11 (final verification)
```

Tasks 1–4 are foundational and must run in order. Tasks 5–8 depend on Task 1. Task 9 depends on Task 1 only (frontend). Task 10 depends on everything except Task 9.
