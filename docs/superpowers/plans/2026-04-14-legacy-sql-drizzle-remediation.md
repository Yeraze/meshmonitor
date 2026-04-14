# Legacy SQLite Raw SQL → Drizzle Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all legacy SQLite-only raw SQL (238 sites in `src/services/database.ts`, 45 sites across 4 auth model/adapter files). Route every callsite through the existing Drizzle repositories in `src/db/repositories/`. End state: `db.prepare()` / `db.exec()` only appears inside `src/server/migrations/**` and is linted elsewhere.

**Architecture:** All target domains already have Drizzle repositories (`auth.ts`, `nodes.ts`, `messages.ts`, `channels.ts`, `telemetry.ts`, `traceroutes.ts`, `neighbors.ts`, `settings.ts`, `misc.ts`, `ignoredNodes.ts`, `sources.ts`, `embedProfiles.ts`, `channelDatabase.ts`, `meshcore.ts`, `notifications.ts`). The `DatabaseService` facade in `src/services/database.ts` already owns repo instances. Remediation is mechanical: replace each legacy prepare/exec block with a call to the matching `this.<repo>.<method>Async()` — adding new repo methods only when coverage is missing. Do not change public `databaseService.*Async()` API signatures — callers across the app depend on them.

**Tech Stack:** Drizzle ORM, TypeScript, Vitest. SQLite (default), PostgreSQL, MySQL backends. All repo methods must be async. Column naming: Drizzle schema uses camelCase keys with backend-specific column() names.

**Verification matrix for every PR:**
- `npx tsc --noEmit` — clean
- Domain vitest run — all green
- Full test suite — `npm test` — all green (baseline 4754 tests)
- CI green (triggers PG + MySQL tests)
- System Tests green (hardware-in-the-loop across all 3 backends)

**Guardrails:**
- One domain per PR (small, reviewable, bisectable)
- Preserve behavior exactly — no drive-by fixes
- Never commit a partially-converted domain (leaves raw SQL + repo calls mixed)
- Run `npm test` before commit; don't push blind
- Keep facade method names stable (`getNodeByIdAsync`, etc.) — only their bodies change
- Integration tests exist for every domain — they'll catch behavioral drift

---

## Phase 0: Pre-work

### Task 0.1: Instrumentation — count legacy sites per domain

Produces a ground-truth baseline we can measure progress against.

**Files:** none

- [ ] **Step 1: Record baseline counts**

```bash
rg -c "db\.prepare|db\.exec" src/services/database.ts src/server/models/ src/server/auth/sqliteSessionStore.ts
```

Expected output:
```
src/services/database.ts:238
src/server/models/User.ts:20
src/server/models/APIToken.ts:9
src/server/models/Permission.ts:8
src/server/auth/sqliteSessionStore.ts:8
```

Record these numbers in the PR description of each subsequent PR as "before / after" to track shrinkage.

- [ ] **Step 2: Identify all callers of each legacy model's static methods**

```bash
rg "User\.|Permission\.|APIToken\." --type ts src/server src/services src/cli | grep -v "test\|\.d\.ts"
```

Save output as a shell artifact for Phase 1 task planning. Callers become redirection targets.

- [ ] **Step 3: No commit** — this is research.

---

## Phase 1: Delete duplicate auth models

The four auth files in `src/server/models/` and `src/server/auth/` are fully covered by `src/db/repositories/auth.ts`. Each one is delete-and-redirect: move callers to `databaseService.<method>Async()`, then delete the model file.

### Task 1.1: Delete `src/server/models/Permission.ts`

**Files:**
- Delete: `src/server/models/Permission.ts`
- Modify: every caller of `Permission.*` (grep from Task 0.2)

**Current surface** (8 SQL sites, ~6 static methods):
`Permission.getForUser()`, `Permission.create()`, `Permission.deleteForUser()`, `Permission.deleteForUserByScope()`, `Permission.checkForUser()`, `Permission.getUserPermissionSet()`.

**Repo coverage** (`src/db/repositories/auth.ts`):
- `getPermissionsForUser(userId)` — line ~320
- `createPermission(input)` — line ~334
- `deletePermissionsForUser(userId)` — line ~360
- `deletePermissionsForUserByScope(userId, sourceId)` — line ~377
- `checkPermissionAsync` — exposed via `databaseService`
- `getUserPermissionSetAsync` — exposed via `databaseService`

- [ ] **Step 1: Enumerate callers**

```bash
rg "Permission\." --type ts src/server src/services src/cli | grep -v "test\|\.d\.ts\|models/Permission" > /tmp/perm-callers.txt
wc -l /tmp/perm-callers.txt
```

- [ ] **Step 2: Replace each caller with databaseService call**

Pattern:
```typescript
// Before:
import { Permission } from '../models/Permission.js';
const perms = Permission.getForUser(userId);

// After:
import { databaseService } from '../services/database.js';
const perms = await databaseService.getPermissionsForUserAsync(userId);
```

If a facade method doesn't exist in `DatabaseService`, add a thin async wrapper:
```typescript
async getPermissionsForUserAsync(userId: number) {
  return this.authRepo!.getPermissionsForUser(userId);
}
```

- [ ] **Step 3: Delete `src/server/models/Permission.ts`**

```bash
git rm src/server/models/Permission.ts
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. If unresolved imports remain, grep again — you missed a caller.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/db/repositories/auth src/server 2>&1 | tail -5
npm test 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete Permission model, route callers to authRepo

8 legacy prepare() sites removed. Permission.static() methods were
duplicated by src/db/repositories/auth.ts — redirected callers to
databaseService.*PermissionAsync() facades."
```

### Task 1.2: Delete `src/server/models/APIToken.ts`

Same pattern as Task 1.1. 9 SQL sites. Repo coverage in `auth.ts`:
- `getApiTokenByHash`, `getApiTokensForUser`, `createApiToken`, `updateApiTokenLastUsed`, `deleteApiToken`, `getUserActiveApiToken`.

**Files:**
- Delete: `src/server/models/APIToken.ts`
- Modify: every caller of `APIToken.*`

- [ ] **Step 1: Enumerate callers**
```bash
rg "APIToken\." --type ts src/server src/services | grep -v "test\|models/APIToken" > /tmp/tok-callers.txt
```

- [ ] **Step 2: Replace callers** using the same pattern as Task 1.1.

- [ ] **Step 3: Delete the model file, typecheck, run tests.**

- [ ] **Step 4: Commit**
```bash
git commit -m "refactor: delete APIToken model, route callers to authRepo"
```

### Task 1.3: Delete `src/server/models/User.ts`

Largest of the auth models (20 SQL sites, ~12 static methods). Repo coverage in `auth.ts`:
- `getUserById`, `getUserByUsername`, `getUserByOidcSubject`, `getUserByEmail`, `getAllUsers`, `createUser`, `updateUser`, `deleteUser`, `getUserCount`.

**Non-auth holdovers** — `User.getMapPreferences()` and `User.saveMapPreferences()` already have Drizzle backing via `misc.ts` (PR #2681). Any callers of those static methods must switch to `databaseService.getMapPreferencesAsync()`.

**Files:**
- Delete: `src/server/models/User.ts`
- Modify: every caller of `User.*`

- [ ] **Step 1: Enumerate callers**
```bash
rg "User\.(getBy|findBy|create|update|delete|getAll|getCount|getMap|saveMap)" --type ts src/server src/services | grep -v "test\|models/User" > /tmp/user-callers.txt
```

Note: the `User` symbol may collide with imports of a TypeScript `User` *type*. Grep only for `User.<methodName>` patterns.

- [ ] **Step 2: Verify MFA methods have repo coverage.** If `User.setMfaSecret()` / `User.getMfaSecret()` exist as static methods and no async facade exists, add them to `authRepo` + `DatabaseService` before deleting.

- [ ] **Step 3: Replace callers, delete file, typecheck, test, commit.**

```bash
git commit -m "refactor: delete User model, route callers to authRepo

Final duplicate auth model removed. All user CRUD now goes through
src/db/repositories/auth.ts via databaseService facades. MFA methods
added to repo as part of this change."
```

### Task 1.4: Convert `src/server/auth/sqliteSessionStore.ts` to use authRepo

Express-session adapter. Currently wraps raw SQLite `prepare()` calls. `auth.ts` already has `getSession`, `setSession`, `deleteSession` async methods — this becomes a thin adapter.

**Files:**
- Modify: `src/server/auth/sqliteSessionStore.ts` (rename to `sessionStore.ts` since it's no longer SQLite-only)

**Current shape:**
```typescript
class SqliteSessionStore extends Store {
  constructor(db: Database) { this.db = db; /* prepare 8 statements */ }
  get(sid, cb) { this.getStmt.get(sid); ... }
  set(sid, sess, cb) { this.setStmt.run(...); ... }
  destroy(sid, cb) { this.destroyStmt.run(sid); ... }
  // ...
}
```

**Target shape:**
```typescript
import type { Store, SessionData } from 'express-session';
import databaseService from '../../services/database.js';

export class DrizzleSessionStore extends Store {
  async get(sid: string, cb: (err: any, sess?: SessionData | null) => void) {
    try {
      const row = await databaseService.getSessionAsync(sid);
      if (!row) return cb(null, null);
      if (row.expire < Date.now()) {
        await databaseService.deleteSessionAsync(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess) as SessionData);
    } catch (err) { cb(err); }
  }
  // set / destroy / touch / all / length / clear analogous
}
```

- [ ] **Step 1: Confirm facade methods exist** in `DatabaseService`:
  - `getSessionAsync`, `setSessionAsync`, `deleteSessionAsync`
  - If missing: add thin wrappers around `authRepo.getSession/setSession/deleteSession`
  - If `all/length/clear/touch` aren't covered: add them to `authRepo` (simple Drizzle `select/delete` + `count`).

- [ ] **Step 2: Rewrite `sqliteSessionStore.ts` as `sessionStore.ts`** using the target shape. Every method is async under the hood but implements the express-session callback-style interface.

- [ ] **Step 3: Update the single import site** in `src/server/server.ts` (or wherever the store is instantiated) to use the new class name.

- [ ] **Step 4: Typecheck, run tests.**

Session tests live at `src/server/auth/sqliteSessionStore.test.ts` (if it exists) — rename file too. Run with all 3 backends manually if possible (SQLite is the default path but PG/MySQL now also work).

- [ ] **Step 5: Commit**
```bash
git commit -m "refactor: session store now backend-agnostic via Drizzle

SqliteSessionStore was SQLite-only and didn't work on PG/MySQL
deployments. Rewritten as DrizzleSessionStore wrapping
databaseService.{get,set,delete}SessionAsync — works across all three
backends out of the box."
```

---

## Phase 2: Extract domain raw SQL from `database.ts`

147 raw SQL sites grouped by domain. Each task: find `db.prepare(...)` and `db.exec(...)` lines in `database.ts` that touch a specific table / concept, replace the body with a call to the corresponding repo method (add to repo if missing), keep the public facade method name unchanged.

### Task 2.1: audit domain (3 sites)

Audit log is covered by `authRepo.createAuditLogEntry` and `authRepo.getAuditLogEntries`. Small. Good first task to establish the extraction pattern.

**Files:**
- Modify: `src/services/database.ts` (find `audit_log` prepare sites)

- [ ] **Step 1: Locate sites**
```bash
rg -n "audit_log" src/services/database.ts
```

- [ ] **Step 2: For each site, replace body with `this.authRepo!.<method>()`**. Example:

```typescript
// Before:
async createAuditLogEntryAsync(entry: AuditLogEntry) {
  const stmt = this.db.prepare(
    'INSERT INTO audit_log (userId, action, resource, createdAt) VALUES (?, ?, ?, ?)'
  );
  return stmt.run(entry.userId, entry.action, entry.resource, Date.now());
}

// After:
async createAuditLogEntryAsync(entry: AuditLogEntry) {
  return this.authRepo!.createAuditLogEntry({ ...entry, createdAt: Date.now() });
}
```

- [ ] **Step 3: Typecheck + `npx vitest run src/db/repositories/auth src/server/auth` + commit.**

### Task 2.2: neighbors domain (3 sites)

Repo: `src/db/repositories/neighbors.ts`. 3 sites — likely `getNeighbors`, `insertNeighbor`, `deleteOldNeighbors`.

**Files:**
- Modify: `src/services/database.ts` (find `neighborInfo` / `neighbor_info` sites)

- [ ] **Step 1: Locate, extract, replace.** Same pattern as Task 2.1.
- [ ] **Step 2: Test with `npx vitest run src/db/repositories/neighbors`.**
- [ ] **Step 3: Commit.**

### Task 2.3: settings domain (5 sites)

Repo: `src/db/repositories/settings.ts`. 5 sites — covers `settings` table CRUD + per-source scoping.

**Files:**
- Modify: `src/services/database.ts` (find `FROM settings` / `INTO settings` sites)

- [ ] Locate, extract, replace, test, commit. Same pattern.

### Task 2.4: channels domain (7 sites)

Repo: `src/db/repositories/channels.ts`. Note there's ALSO `channelDatabase.ts` (the user-facing channel database store) — verify which raw SQL belongs where before extracting. If ambiguous: read the SQL and match it to the table name.

- [ ] Locate, extract, replace, test, commit.

### Task 2.5: keyrepair domain (7 sites)

**Scope check required:** the scope report labeled these as `misc.ts` but keyrepair may actually belong in `nodes.ts` or a new repo. Read the SQL before deciding.

- [ ] **Step 1: Find the sites**
```bash
rg -n "keyrepair|key_repair|pkiKey|publicKey.*UPDATE" src/services/database.ts
```

- [ ] **Step 2: Identify target table** — likely `nodes.publicKey` updates. If so, target repo is `nodes.ts`.
- [ ] **Step 3: Extract methods into the correct repo** (add new ones if absent — e.g., `nodesRepo.updatePublicKey(nodeNum, key)`).
- [ ] **Step 4: Typecheck, run tests (`src/db/repositories/nodes`), commit.**

### Task 2.6: packetlog domain (8 sites)

Repo: `src/db/repositories/misc.ts` (packet log already has extensive coverage there — see `misc.packetlog.test.ts`).

- [ ] Locate, extract, replace, test, commit.

### Task 2.7: telemetry domain (8 sites)

Repo: `src/db/repositories/telemetry.ts`. Be careful: telemetry has a hot cache (`invalidateTelemetryTypesCache()`) — verify the cache invalidation path still fires after extraction.

- [ ] **Step 1: Locate sites.** Include lookups for `telemetry`, `device_metrics`, `environment_metrics`, `power_metrics`.
- [ ] **Step 2: Map each site to an existing repo method.** Add new ones if absent.
- [ ] **Step 3: Verify cache invalidation.** The invalidate call should happen in the facade (not the repo) unless the repo already owns it.
- [ ] **Step 4: Test `src/db/repositories/telemetry`** — three test files live here (`telemetry.test.ts`, `telemetry.extra.test.ts`, `telemetry.multidb.test.ts`). All must pass.
- [ ] **Step 5: Commit.**

### Task 2.8: traceroutes domain (12 sites)

Repo: `src/db/repositories/traceroutes.ts`.

- [ ] Locate, extract, replace. Traceroute has retention-based purging — verify the purge facade still fires.
- [ ] Test `src/db/repositories/traceroutes` — 1 test file.
- [ ] Commit.

### Task 2.9: init / import domain (16 sites)

Bootstrap and import code in `database.ts` — schema initialization, data import from legacy DB files, backup/restore hooks.

**Scope decision point:** not all of this is worth converting. Database bootstrap (`initializeDatabase`, `ensureTables`) is legitimately backend-specific and overlaps with migrations. The backup/restore sites are out of scope (audit Section #2/#3, deferred).

- [ ] **Step 1: Triage each site** — classify as:
  - (a) Converts to repo: data import reading legacy tables → moves to repo.
  - (b) Keep as-is: bootstrap code that exists BEFORE migrations run. Raw SQL legit here.
  - (c) Defer: backup/restore (already flagged as separate remediation).
- [ ] **Step 2: For (a) sites: extract to repos. For (b): add a `// eslint-disable-next-line` comment with a link to this plan to unblock the Phase 3 lint rule. For (c): no action.**
- [ ] **Step 3: Commit.**

### Task 2.10: messages domain (25 sites)

Repo: `src/db/repositories/messages.ts` — extensive, 6 test files.

Bigger than previous tasks. Consider splitting into 2 PRs:
- 2.10a: CRUD (insert, select, delete) — ~15 sites
- 2.10b: purging/retention/search — ~10 sites

- [ ] **2.10a: CRUD**
  - Locate sites via `rg -n "FROM messages|INTO messages" src/services/database.ts`
  - Extract, replace
  - Test `src/db/repositories/messages.insert src/db/repositories/messages.timestamp src/db/repositories/messages.bigint`
  - Commit

- [ ] **2.10b: purge/search**
  - Locate sites touching `DELETE FROM messages` or message search
  - Extract, replace
  - Test `src/db/repositories/messages.purge src/db/repositories/messages.search`
  - Commit

### Task 2.11: nodes domain (53 sites — split into 4 sub-PRs)

**Largest cluster.** Split to keep reviews digestible. Target repo: `src/db/repositories/nodes.ts` (and `src/db/repositories/ignoredNodes.ts` where applicable).

- [ ] **2.11a: Basic CRUD (~15 sites)** — `getNodeById`, `getAllNodes`, `upsertNode`, `deleteNode`. Test `src/db/repositories/nodes`. Commit.
- [ ] **2.11b: Flags (~15 sites)** — `isFavorite`, `isIgnored`, `hasRemoteAdmin`, etc. Test. Commit.
- [ ] **2.11c: Mobility / position / telemetry-adjacent (~15 sites)** — position updates, hops tracking, lastHeard. Test. Commit.
- [ ] **2.11d: Legacy ignored_nodes table cleanup (~8 sites)** — route through `ignoredNodes.ts` repo. Verify no behavior drift with `ignoredNodes.test.ts`. Commit.

---

## Phase 3: Lint rule + final cleanup

### Task 3.1: Verify baseline count is 0

- [ ] **Step 1: Recount**
```bash
rg -c "db\.prepare|db\.exec" src/services/database.ts src/server/models/ src/server/auth/ 2>/dev/null
```

Expected:
```
src/services/database.ts:N   # where N = only the Task 2.9 (b)-tier bootstrap sites with eslint-disable
src/server/models/    → empty (all files deleted)
src/server/auth/sessionStore.ts:0
```

If `database.ts` still has uncommented `db.prepare` lines: those are bugs — go back and fix before Phase 3 lint rule ships.

### Task 3.2: Add ESLint rule banning raw SQL outside migrations

**Files:**
- Modify: `.eslintrc.cjs` or `eslint.config.js` (whichever the project uses)

- [ ] **Step 1: Add a rule using `no-restricted-syntax`:**

```javascript
{
  selector: "CallExpression[callee.property.name=/^(prepare|exec)$/]",
  message: "Raw SQL (db.prepare/db.exec) is forbidden outside migrations. Use a Drizzle repository in src/db/repositories/ instead.",
}
```

- [ ] **Step 2: Add `overrides` block** granting exceptions to:
  - `src/server/migrations/**/*.ts`
  - any Task 2.9 (b) bootstrap sites (inline `// eslint-disable-next-line no-restricted-syntax` per site, pointing at this plan)

- [ ] **Step 3: Run `npm run lint`. Expected: green.**

- [ ] **Step 4: Commit**
```bash
git commit -m "chore: lint rule — ban raw SQL outside migrations

Prevents regression of legacy SQLite raw SQL patterns now that all
domains are on Drizzle. Migrations remain exempt (raw DDL required).
Bootstrap sites carry eslint-disable comments pointing at the
remediation plan."
```

### Task 3.3: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the Database section's "legacy SQLite only" warnings with current state:**
  - All three backends now use Drizzle uniformly
  - Raw SQL banned outside migrations (via lint rule)
  - Authentication / session / permission / api token / user / audit all via `authRepo`

- [ ] **Step 2: Commit**
```bash
git commit -m "docs: update CLAUDE.md for unified Drizzle architecture"
```

### Task 3.4: Close-out PR

Single umbrella PR summarizing the remediation. References every sub-PR from phases 1 and 2. Title: `refactor: eliminate legacy raw SQL — 283 sites → Drizzle`.

- [ ] Create PR.
- [ ] Monitor CI via `/ci-monitor`.
- [ ] Merge on green.

---

## Estimated scope

- **Phase 1:** 4 PRs, ~2-3 days of work. High confidence — pure redirection.
- **Phase 2:** 11 PRs, ~1-2 weeks. Medium confidence — size varies; nodes+messages are the long tail.
- **Phase 3:** 1 PR, ~1 day. Low risk.

**Total:** ~16 PRs, ~3 weeks engineering time if sequential. Several phase-2 tasks are independent and can parallelize.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Behavioral drift between raw SQL and Drizzle query builders | Run full test suite (4754 tests) + System Tests on every PR; compare row shapes for edge cases (NULL handling, BIGINT coercion) |
| Facade signature change breaks callers | Never change public `*Async()` method signatures in this refactor — only their bodies |
| Missing repo coverage forces over-scoping | Each task explicitly allows "add method to repo if absent"; keep the added method minimal |
| Session store migration breaks auth | Task 1.4 is isolated — ship it on a branch and verify manual login/logout before merge |
| PG/MySQL-only edge cases | CI runs PG + MySQL migrations + System Tests on all 3 backends on every PR |
| Phase 2.9 bootstrap code genuinely needs raw SQL | Explicit triage step classifies as "keep" with eslint-disable + plan reference |
