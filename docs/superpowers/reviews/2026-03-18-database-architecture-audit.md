# Database Architecture Audit Report

**Date:** 2026-03-18
**Scope:** Post-remediation audit of all 5 areas after 8 PRs

---

## 1. Baseline vs Drizzle Schema Parity

### CRITICAL: 6 tables missing from PG baseline migration

The PostgreSQL `CREATE TABLE` block in `001_v37_baseline.ts` is missing these tables entirely:

| Missing Table | Drizzle Schema File |
|---|---|
| `embed_profiles` | `src/db/schema/embedProfiles.ts` |
| `ignored_nodes` | `src/db/schema/ignoredNodes.ts` |
| `meshcore_nodes` | `src/db/schema/meshcoreNodes.ts` |
| `meshcore_messages` | `src/db/schema/meshcoreMessages.ts` |
| `news_cache` | `src/db/schema/misc.ts` |
| `user_news_status` | `src/db/schema/misc.ts` |

**Impact:** Fresh PostgreSQL installs from v3.7 baseline will be missing these 6 tables. They exist in the SQLite section but not in the `await client.query()` PG block. MySQL status unknown (may also be missing).

### HIGH: 5 columns missing from PG baseline `nodes` table

The baseline PG `nodes` CREATE TABLE has 43 quoted columns but the Drizzle `nodesPostgres` schema has 58. After accounting for unquoted columns (`latitude`, `longitude`, `altitude`, `role`, `snr`, `rssi`, `macaddr`, `channel`, `mobile`, `voltage`), these 5 are genuinely missing from the baseline:

| Missing Column | Type | Purpose |
|---|---|---|
| `favoriteLocked` | BOOLEAN | Lock favorite status |
| `isExcessivePackets` | BOOLEAN | Spam detection flag |
| `packetRatePerHour` | INTEGER | Spam detection metric |
| `packetRateLastChecked` | BIGINT | Spam detection timestamp |
| `lastMeshReceivedKey` | TEXT | PKI key authority tracking |

### LOW: `permissions` PG baseline missing `grantedAt`/`grantedBy`

The baseline PG `permissions` table has: id, userId, resource, canViewOnMap, canRead, canWrite, canDelete (7 columns). The Drizzle `permissionsPostgres` also has exactly these 7 columns -- so they match. However, the **SQLite** permissions schema in Drizzle has `grantedAt` and `grantedBy` which PG/MySQL lack. This is an intentional difference (noted in code comments).

### LOW: `api_tokens` baseline has `DEFAULT ''` on name, Drizzle does not

Baseline: `name TEXT NOT NULL DEFAULT ''`
Drizzle: `name: pgText('name').notNull()` (no default)

Minor inconsistency -- won't cause issues since callers always provide a name.

---

## 2. Legacy Model Remnants

### MEDIUM: Legacy models still imported and instantiated in database.ts

**Files still exist:** `src/server/models/User.ts`, `Permission.ts`, `APIToken.ts` (plus test files)

**Only consumer:** `src/services/database.ts` (lines 8-10 imports, lines 258-260 declarations, lines 489-491/564-565 instantiation)

No other non-test production code imports these models. They are vestiges used by the remaining sync methods in `database.ts` (see issue #5 below). Once sync methods are migrated to repositories, these model files can be deleted.

---

## 3. Remaining drizzleDbType Branching in database.ts

### LOW: ~15 drizzleDbType checks remain in database.ts

These fall into legitimate categories:
- **Initialization** (lines 468-472, 636, 649, 661): Setting the type during startup -- required
- **Driver access** (lines 330, 336): `getDatabaseVersion()` needs raw pool access -- required
- **Cache loading** (line 685): PG/MySQL need async cache warmup -- required
- **Sync method compatibility** (line 1874): `isNodeSuppressed` cache check -- tech debt from sync methods

**No drizzleDbType branching found in any repository files.** The Active Schema Map is working correctly.

---

## 4. Type Mismatches (`as any` casts in repositories)

### LOW: 4 `as any` casts in production repository code

| File | Line | Reason |
|---|---|---|
| `auth.ts` | 749 | `this.db as any` for session upsert -- Drizzle union type limitation |
| `base.ts` | 131 | `result as any` for MySQL result format -- array vs object |
| `channelDatabase.ts` | 137 | `this.db as any` for `.returning()` -- same union type issue |
| `ignoredNodes.ts` | 57 | `this.db as any` for upsert -- same union type issue |
| `messages.ts` | 61 | `result as any` for `.changes` access -- SQLite-specific property |
| `nodes.ts` | (check) | Similar patterns |

These are all Drizzle ORM type system limitations where the union `Database` type doesn't narrow properly for specific operations. They are safe but annoying. A proper fix would require typed helper methods in `BaseRepository`.

---

## 5. Sync Methods Still Called Externally

### HIGH: ~30+ sync method calls remain in production code

**`database.ts` is still 10,048 lines** with 218 `this.db.prepare`/`this.db.exec` raw SQL calls.

Key sync methods still called from outside `database.ts`:

| Method | Callers | Count |
|---|---|---|
| `getSetting()` | meshtasticManager.ts, notificationFiltering.ts | ~10 |
| `getNode()` | nodeEnhancer.ts, meshtasticManager.ts | 2 |
| `auditLog()` | localAuth.ts, oidcAuth.ts | 6 |
| `getNodeCount()`/`getChannelCount()` | meshtasticManager.ts | 1 |

These are **SQLite-only sync methods** that will fail on PostgreSQL/MySQL (they use `this.db.prepare()` which is a better-sqlite3 API). On PG/MySQL, they either fall through to a cache or silently fail.

---

## Priority Summary

| Priority | Issue | Effort | Risk |
|---|---|---|---|
| **P0** | 6 tables missing from PG baseline | Small | Fresh PG installs broken |
| **P0** | 5 node columns missing from PG baseline | Small | Columns won't exist on fresh PG |
| **P1** | ~30 sync method calls still in production | Large | PG/MySQL compatibility |
| **P2** | Legacy model files still exist | Medium | Tech debt, confusion |
| **P3** | 4 `as any` casts in repos | Small | Type safety |
| **P3** | api_tokens name DEFAULT mismatch | Trivial | Cosmetic |

### Recommended Next Steps

1. **Fix baseline migration** -- Add the 6 missing tables and 5 missing node columns to the PG and MySQL CREATE TABLE blocks
2. **Migrate remaining sync callers** -- Convert `getSetting`, `getNode`, `auditLog` calls to use repository async equivalents
3. **Delete legacy models** -- Remove User.ts, Permission.ts, APIToken.ts once sync methods are gone
4. **Shrink database.ts** -- Target is to get from 10,048 lines to under 2,000 by moving remaining sync methods into repositories
