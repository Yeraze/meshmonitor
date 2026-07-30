# Phase 6 — Reconcile the two `SOURCEY_RESOURCES` lists (#4416)

**Epic:** #4412 (Per-Source Node Display Settings) — final phase
**Issue:** #4416
**Worktree:** `/home/yeraze/Development/meshmonitor-permissions`
**Branch:** `feature/settings-per-source-permissions` (from `origin/main`, Phase 5 = `a33d66c2`)
**Status:** spec — nothing implemented

> **This is the only phase of the epic that changes permission semantics.** Every other
> phase was additive. This one takes a resource that is authorized globally today and
> makes it authorized per-source. Done wrong, every non-admin user with a settings grant
> loses access on upgrade, silently, with no error message anywhere. The upgrade-proof
> test in WP2 is the deliverable that makes this safe; everything else is mechanics.

---

## 0. Decisions already made (do not re-litigate)

1. **Scope is `settings` only.** `dashboard`, `info`, `audit`, and `security` keep behaving
   exactly as they do today (global, `sourceId = NULL`). See §1.3 for why this is a
   deliberate choice and not an oversight.
2. **Migration strategy is fan-out to every source.** For each existing settings grant,
   write an equivalent row for every source that exists at migration time. This preserves
   today's *effective* access exactly. Admins narrow individual sources afterwards.
   - The `sourceId = NULL` row is **not** kept as a template. That would reintroduce the
     global-fallback concept removed in #2839.
   - Granting on the primary source only is **not** acceptable — it revokes access users
     have today.

One extension to decision 2 is required by the risk requirement and is **not** a
re-litigation — see §3.2 "Why the fan-out reads *all* settings rows, not just the NULL
ones". It is a strict superset of the stated rule.

---

## 1. Reuse inventory

Everything below already exists. Read this section before writing a line of new code.
The single largest finding: **`UsersTab.tsx` and `AuthContext.tsx` were already written to
derive their behavior from `SOURCEY_RESOURCES`, so most of item (d) requires no production
change at all** — only proof.

### 1.1 Existing code that this phase reuses as-is

| What | Where | How Phase 6 uses it |
|---|---|---|
| `SOURCEY_RESOURCES` / `isSourceyResource()` | `src/types/permission.ts:64-80` | The surviving list. One entry added. |
| `checkPermissionAsync` sourcey branch | `src/services/database.ts:4373-4392` | Already correct. **No change.** Exact-match when `sourceId` given; union across per-source rows when omitted. |
| `getUserPermissionSetsBySourceAsync` | `src/services/database.ts` (splits on `sourceId` truthiness, not on `isSourceyResource`) | Already correct. Post-migration the settings rows carry a `sourceId`, so they land in `bySource` automatically. **No change.** |
| `requirePermission(resource, action, { sourceIdFrom })` | `src/server/auth/` | Already resolves and forwards `scopedSourceId`. **No change.** |
| `UsersTab` global section | `src/components/UsersTab.tsx:70-72` — `RESOURCES.filter(r => !SOURCEY_RESOURCES.includes(r.id))` | Derived. `settings` leaves this section automatically. |
| `UsersTab` per-source grid | `src/components/UsersTab.tsx:950` — `PERMISSION_KEYS.filter(r => SOURCEY_RESOURCES.includes(r))` | Derived. `settings` enters this grid automatically (`PERMISSION_KEYS` already lists it, line 58-63). |
| `UsersTab.handleUpdatePermissions` | `src/components/UsersTab.tsx:~260-290` | Sends `PERMISSION_KEYS ∪ GLOBAL_PERMISSION_RESOURCES` and lets the server split. **No change.** |
| `AuthContext.hasPermission` sourcey branch | `src/contexts/AuthContext.tsx:267-279` | Already supports `{ sourceId }` and `{ anySource: true }`. **No change to the function** — only to its call sites (§5.5). |
| Route test harness | `src/server/test-helpers/routeTestApp.ts` — `createRouteTestApp()`, `harness.grant(userId, resource, action, sourceId?)`, `sourceA`/`sourceB`, `loginAs`, `revokeAll` | Every new route test. |
| Migration 131 | `src/server/migrations/131_seed_per_source_node_display.ts` | **The structural template for migration 132.** Copy its shape verbatim: frozen local constant, `SELECT id FROM sources` table-driven enumeration, missing-table guard, zero-source guard, `chunk()` + `SEED_BATCH_SIZE`, exported pure function for unit testing, per-backend transaction. |
| Migration 033 | `src/server/migrations/033_per_source_permissions.ts` | **The behavioral precedent** for exactly this operation on the `permissions` table (it fanned out the *other* 16 sourcey resources in the same way). Reuse its per-backend column naming and its "expand, then delete the globals" ordering. Do **not** reuse its unbatched per-row insert loop — see §3.5. |
| `chunk<T>()` + `SEED_BATCH_SIZE` | `src/server/migrations/131_...ts:~90` | Copy into 132 (migrations deliberately do not import from each other). |
| Migration registry | `src/db/migrations.ts` (`registry.register({...})`, last entry = 131 at line ~2084) | One new entry, number 132. |

### 1.2 Column naming (already established — do not re-derive)

The `permissions` table, per `src/db/schema/auth.ts:52-80,171-183` and migration 033's
header comment:

| Backend | Columns |
|---|---|
| SQLite | `user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by, sourceId` — **no `can_delete` column** |
| PostgreSQL | `"userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId"` (double-quoted) |
| MySQL | `userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId` |

Unique index from migration 033: `permissions_user_resource_source_uniq` on
`(userId, resource, sourceId)`, created `IF NOT EXISTS` on all three backends.

### 1.3 Why `dashboard`, `info`, `audit`, `security` stay global — deliberate, not overlooked

Recorded here so a future reader does not "finish the job" by mistake.

- **`dashboard`, `info`** — read-only navigation gates. Their consumers (`App.tsx` tab
  gating, `Sidebar.tsx`, `DashboardPage`) are explicitly *cross-source* surfaces. Making
  them sourcey would force every nav gate to name a source, and would make the
  cross-source Dashboard un-gateable without an `anySource` union that is
  indistinguishable from today's global behavior. Zero benefit, real regression risk.
- **`audit`, `security`** — install-wide administrative surfaces. Their underlying data
  (`audit_log`, security-scan results, key management) carries **no `sourceId` column**;
  it is global by design. A per-source `audit:read` grant would be authorizing access to
  data that has no source, which is a meaningless permission.
- **`settings` is different** because the epic made a real subset of settings keys
  per-source (`PER_SOURCE_SETTINGS_KEYS`, `source:{id}:{key}` rows, Phase 1 migration 131)
  and added a genuinely source-scoped write endpoint
  (`POST /api/settings?sourceId=`, `requirePermission('settings','write',{ sourceIdFrom:'query' })`).
  There is a real thing to scope. For the other four there is not.

The consequence is that `src/types/permission.ts`'s list is **deliberately narrower** than
the list in the file this phase deletes. WP1's guard test pins the exact contents with a
comment saying so, so the divergence reads as a decision.

---

## 2. Item (a) — The list reconciliation

### 2.1 Which list survives: `src/types/permission.ts`

**Delete `src/server/constants/permissions.ts` entirely.** Keep and amend
`src/types/permission.ts`.

Justification (the issue notes the server file is "more complete", so this needs a real
argument, not a coin flip):

1. **The survivor must be importable from both halves of the app.** `src/types/permission.ts`
   already is: `src/services/database.ts:19`, `src/server/routes/userRoutes.ts:12`,
   `src/contexts/AuthContext.tsx:11`, `src/components/UsersTab.tsx:15`. Making the
   *frontend* import from `src/server/**` inverts the established directory boundary and
   invites Vite to pull server modules into the client bundle. `src/types/` exists
   precisely to be the shared vocabulary.
2. **The survivor is type-checked.** `src/types/permission.ts` declares
   `readonly ResourceType[]`, so a typo (`'setings'`) is a compile error and a removed
   `ResourceType` member is a compile error. The server file is `Set<string>` — completely
   untyped, which is a contributing cause of the drift being invisible for this long.
3. **Cost of deletion.** Deleting the server file touches **zero live imports** — grep
   confirms its only references anywhere in `src/` are four *comment* lines inside
   `settingsRoutes.perSource.test.ts` (rewritten in WP6). Deleting `src/types/permission.ts`'s
   list would mean rewriting four live import sites plus the type surface.
4. **`isResourceSourcey` is dead code.** It has never been imported. Keeping a
   never-executed authorization classifier in the tree is strictly worse than deleting it.

The three entries the surviving list gains relative to today: exactly one — `'settings'`.
The other four the deleted file carried (`dashboard`, `info`, `audit`, `security`) are
intentionally dropped on the floor per §1.3.

### 2.2 Preventing recurrence

A second definition appearing later is the failure mode that caused this whole phase.
WP1 adds a guard test that **scans the repository source tree** for any `SOURCEY_RESOURCES`
declaration outside the two permitted locations. Precedent for a source-scanning test
already exists in this repo (`src/server/server.settings-persistence.test.ts` extracts and
asserts against source text).

Permitted locations:
- `src/types/permission.ts` — the canonical definition.
- `src/server/migrations/**` — migrations legitimately freeze their own point-in-time copy
  (033 does; 132 will). These are frozen snapshots, not a competing source of truth.

Anything else fails the test with a message naming this spec.

---

## 3. Item (b) — Migration 132

**File:** `src/server/migrations/132_fan_out_settings_permissions.ts`
**Registry:** `src/db/migrations.ts`, `number: 132`,
`name: 'fan_out_settings_permissions'`,
`settingsKey: 'migration_132_fan_out_settings_permissions'`.

### 3.1 What it does

For every user, compute their **effective** settings grant under the *old* (pre-flip)
rules, then write that grant as a per-source row for every source that exists, then remove
the now-inert `sourceId = NULL` settings rows.

### 3.2 Why the fan-out reads *all* settings rows, not just the NULL ones

> **Approved by the orchestrator.** This is a strict superset of the stated decision, not a
> contradiction of it — it follows from the completeness requirement rather than working
> against it. WP2 negative control 2 ("read only NULL rows → u6 fails") is what proves the
> superset is load-bearing, and its observed output is **required** in the WP2 report.

The decision says "for each existing `sourceId = NULL` settings grant, write an equivalent
row for every source". That is right for the common case and this design does exactly that.
It must additionally handle one real-world shape the naive reading misses, or the
"identical effective access" requirement cannot hold:

`checkPermissionAsync`'s pre-flip non-sourcey branch is (`src/services/database.ts:4392+`,
paraphrased):

```
for (perm of rows) if (perm.resource === r && !perm.sourceId && check(perm)) return true;
for (perm of rows) if (perm.resource === r &&  perm.sourceId && check(perm)) return true;
return false;
```

Neither loop ever returns `false` early. So today's effective answer for `settings` is
**the OR across every settings row the user has, regardless of that row's scope** — and
`checkPermissionAsync`'s own comment at `:4392-4394` confirms per-source settings rows
exist in the wild ("covers databases where the admin PUT endpoint historically saved
global grants under a sourceId").

Therefore:

- A user whose only settings row is scoped to source A has **write on every source and on
  the global endpoint today**. Fanning out only NULL rows would leave them with write on A
  alone — a silent revocation, and the §7 upgrade test would (correctly) fail.
- Reading all rows and OR-ing them produces the identical result for the plain case (a
  single NULL row ORs to itself), so this is a **strict superset** of the stated rule, not
  a different rule.

### 3.3 Algorithm (identical on all three backends)

```
FROZEN_RESOURCES = ['settings']        // frozen local constant — see §3.4

1. sourceIds = SELECT id FROM sources
   - table missing        → log debug, return (nothing to do)
   - sourceIds.length = 0 → log WARN, return WITHOUT deleting anything   [§3.6]

2. rows = SELECT <all perm columns> FROM permissions WHERE resource IN (FROZEN_RESOURCES)
   - rows.length = 0 → log debug, return

3. effective = computeEffectiveGrants(rows)          // exported pure fn, §3.5
   per userId: { canViewOnMap: OR, canRead: OR, canWrite: OR,
                 canDelete: OR (PG/MySQL only),
                 grantedAt: donor row's value (NULL-scoped row preferred, else first
                            per-source row, else now),
                 grantedBy: donor row's value }
   - drop users whose OR is all-false (they are denied before and after; keeping the row
     would be noise). Record the count in the log line.

4. existingPairs = set of (userId, sourceId) already present in `rows` with a non-null sourceId

5. BEGIN TRANSACTION
     a. INSERT the (userId, 'settings', effective…, sourceId) rows for every
        (user, source) pair NOT in existingPairs — batched, SEED_BATCH_SIZE = 200.
     b. For each distinct effective flag-combination (at most 8), one statement:
          UPDATE permissions SET canViewOnMap=?, canRead=?, canWrite=?, canDelete=?
           WHERE resource='settings' AND sourceId IS NOT NULL AND userId IN (…)
        — widens any pre-existing per-source row to the effective value, so the fan-out
        cannot narrow anyone. (Never narrows: the effective value already ORs that row in.)
     c. DELETE FROM permissions WHERE resource='settings' AND sourceId IS NULL
   COMMIT
```

Order matters: **insert/update first, delete last, one transaction.** A crash between
steps leaves the old NULL rows intact and the migration re-runnable. Never delete first.

### 3.4 Frozen constants — the Phase 5 / migration-050 lesson

The migration file declares its own constants and imports **nothing** mutable:

```ts
/**
 * Frozen at migration-authoring time. Do NOT replace with an import of
 * SOURCEY_RESOURCES from src/types/permission.ts — a migration is a statement
 * about a point in time, and on a fresh install migrations replay from scratch
 * (#3962), so an imported array would run against whatever it contains today,
 * not what it contained when 132 shipped. This is the exact bug Phase 5 fixed
 * in migration 050, and the reason migration 131 froze its ten keys locally.
 */
const FANNED_OUT_RESOURCES = ['settings'] as const;
```

Same treatment for the column lists. Copy `chunk()` and `SEED_BATCH_SIZE` in rather than
importing them from 131.

### 3.5 Batching — the #4233 lesson

- No per-row round trips. Migration 033 (the behavioral precedent) issues one INSERT per
  `(globalRow × source)` pair on SQLite and one INSERT…SELECT per source on PG/MySQL.
  **Do not copy that.** 132 batches at 200 rows per multi-row INSERT, like 131.
  200 rows × 9 bound params = 1,800 placeholders — inside PostgreSQL's 65,535 limit and
  MySQL's default `max_allowed_packet`.
- SQLite: prepared statement inside `db.transaction(...)`.
- The UPDATE in step 5b is grouped by flag-combination (≤8 statements total), not per user.

**Exported pure function** (mirrors 131's `computeSeedInserts`, and is the reuse seam WP7
depends on):

```ts
// src/server/services/settingsGrantFanout.ts   (NEW — owned by WP2)
export interface RawGrantRow {
  userId: number; sourceId: string | null;
  canViewOnMap: boolean; canRead: boolean; canWrite: boolean; canDelete?: boolean;
  grantedAt: number | null; grantedBy: number | null;
}
export interface EffectiveGrant {
  userId: number;
  canViewOnMap: boolean; canRead: boolean; canWrite: boolean; canDelete: boolean;
  grantedAt: number; grantedBy: number | null;
}
/** OR-union every row per user; drops users whose union is all-false. Pure, total. */
export function computeEffectiveGrants(rows: RawGrantRow[], now: number): EffectiveGrant[];
/** Cartesian product minus pairs that already exist. Pure, total. */
export function computeFanOutInserts(
  effective: EffectiveGrant[], sourceIds: string[], existingPairs: ReadonlySet<string>,
): Array<EffectiveGrant & { sourceId: string }>;
```

Why a shared module rather than exporting from the migration file: WP7 (`sourceRoutes`)
needs the same logic at runtime, and runtime code must not import from
`src/server/migrations/**`. The module is *parameterized* — it takes rows and source ids and
knows nothing about which resource it is fanning out — so the frozen-list rule is not
violated: the migration passes its own frozen `'settings'`, WP7 passes its own literal.

### 3.6 Edge cases — required behavior

| Case | Behavior | Why |
|---|---|---|
| `sources` table missing | log debug, return | Same guard as 131. Migration ordering safety. |
| **Zero sources** | log **WARN**, return **without deleting the NULL rows** | Deleting with nothing to replace them destroys access outright. The surviving NULL rows are inert but harmless, and WP7 reconciles them the moment a source is created. |
| Zero settings permission rows | log debug, return | Common on installs where only admins touch settings (admins bypass). |
| User already has a per-source settings row | Step 5b widens it to the effective OR; step 5a skips the insert | Cannot narrow anyone. |
| User has an all-false settings row | Dropped, no rows written | Denied before, denied after. Logged. |
| Admin users | Rows are fanned out like everyone else | Harmless — `checkPermissionAsync` short-circuits on `user.isAdmin` before ever reading rows. Do **not** special-case admins; doing so makes the upgrade test's row-level assertions harder to reason about. |
| `anonymous` user | Treated as any other user | Default seed grants (`dashboard`, `nodes`, `info`) do **not** include `settings` (`src/services/database.ts:3871-3876`), so on a fresh install there is nothing to fan out. An admin who granted `settings:read` to anonymous is covered by the normal path. |
| Re-run (ledger crash-recovery) | Idempotent | NULL rows are already gone; effective is recomputed from the per-source rows and ORs to the same values; step 5b re-writes identical values; step 5a inserts nothing. |
| Non-`settings` rows | Untouched | Asserted explicitly in the upgrade test — a bug that fanned out *every* resource would otherwise pass every settings-specific assertion. |

### 3.7 Migration follow-on: sources created *after* the migration

Two sub-cases, and they get different answers:

**(a) The database had ≥1 source when 132 ran.** A source added afterwards gets no
`settings` grants for anyone. **This is correct and deliberate** — it is exactly how every
other sourcey resource already behaves (`nodes`, `messages`, `channel_*`, …). Adding a
source grants nobody anything until an admin grants it. Documented, no code.

*(Note the epic's existing open question "sources created AFTER migration 131 runs" is the
same shape of problem for settings **values**. This phase does not resolve that one; it is
about grants, not values.)*

**(b) The database had zero sources when 132 ran.** The NULL rows survived (§3.6) and are
now inert: a non-admin holding `settings:write` is silently denied everywhere. This is
precisely the "user whose grant the migration missed" failure the risk section demands an
answer for. **WP7 closes it** by running the same fan-out at source-creation time. It is a
no-op in case (a) (no NULL rows survive there).

---

## 4. Item (c) — `userRoutes.ts` PUT/GET validation

`src/server/routes/userRoutes.ts`. Three sites were named; all three were checked.

### 4.1 `:374` — GET `/:id/permissions` merge loop

```ts
for (const [resource, perms] of Object.entries(global)) {
  if (!isSourceyResource(resource as ResourceType)) { (permissions as any)[resource] = perms; }
}
```

**No code change.** Post-flip this correctly stops merging any surviving global `settings`
row into the form, and `settings` arrives via `bySource[sourceId]` instead. Behavior is
right by construction.

**One required change: the comment block at `:367-369` and `:413-418`.** The `:416-417`
comment explicitly enumerates `settings` as a non-sourcey resource stored globally. Leaving
a comment that states the opposite of the code is how this defect survived. Rewrite both
comments and reference #4416.

### 4.2 `:419-425` — PUT split + 400

```ts
const sourceyEntries = Object.entries(permissions).filter(([r]) => isSourceyResource(r as ResourceType));
const globalEntries  = Object.entries(permissions).filter(([r]) => !isSourceyResource(r as ResourceType));
if (sourceyEntries.length > 0 && !sourceId) {
  return res.status(400).json({ error: 'sourceId is required when updating per-source permissions' });
}
```

**No logic change.** `settings` moves from `globalEntries` to `sourceyEntries` on its own,
and the existing 400 is the correct response for a settings grant that arrives unscoped.

**Verified not to break the admin UI**: `UsersTab.handleUpdatePermissions` only includes a
resource in the payload when `permissions[resource]` is truthy, and that state is seeded
from the GET, which post-flip omits `settings` in the unscoped view. So an unscoped save
does not start 400-ing. WP3 must prove this with a test rather than trusting the reasoning
(§7, WP3 acceptance).

**Required change: the error message.** `'sourceId is required when updating per-source
permissions'` is fine, but the response has no machine code. Per CLAUDE.md's envelope rule
for touched handlers, convert both 400s in this handler to
`fail(res, 400, 'MISSING_SOURCE_ID', …)` / `fail(res, 400, 'INVALID_PERMISSIONS', …)`.
`fail()` is always safe (`ApiService` reads only `error`/`code`). Reuse the existing
`MISSING_SOURCE_ID` code already used by `requirePermission`. Do **not** convert the
success path — `res.json({ permissions })` on the GET is a bare payload and converting it
would break `UsersTab`'s consumer (CLAUDE.md's explicit gotcha).

### 4.3 `:428-460` — the destructive replace

```ts
if (sourceId) { await deletePermissionsForUserByScope(userId, sourceId); …recreate sourceyEntries… }
if (globalEntries.length > 0) { await deletePermissionsForUserByScope(userId, null); …recreate… }
```

**No change, but it is a live hazard worth stating.** The scoped branch deletes *all* rows
for `(user, sourceId)` and recreates only what the payload contained. Post-flip, a PUT that
carries a `sourceId` but omits `settings` silently revokes that user's settings grant on
that source. That is already true today for `nodes`/`messages`/channels, and `UsersTab`
always sends the full key set, so it is pre-existing behavior — but any *other* client of
this endpoint (API token scripts) now has a new way to lose a grant. WP3 adds a regression
test pinning the behavior so it is at least documented rather than discovered.

### 4.4 The 30+ unscoped `settings` route gates

`grep requirePermission('settings'` returns 36 sites. Exactly **two** pass a source
(`settingsRoutes.ts:291` → `sourceIdFrom:'query'`, `notificationRoutes.ts:392` →
`sourceIdFrom:'body'`). The other 34 (map styles, geojson layers, scripts, system restart,
traceroute-nodes, auto-ping, …) pass none.

**This is fine and requires no change.** With no `sourceId`, `checkPermissionAsync` takes
the sourcey *union* branch: any per-source settings row with the action set authorizes.
After the fan-out every user who had access keeps it. Those endpoints are genuinely
install-wide (there is one map-style list, one script directory, one server to restart), so
"has settings:write on at least one source" is the right gate for them.

**Do not add `sourceIdFrom` to any of the 34.** That would be a second breaking change
riding along inside this one.

---

## 5. Items (d) + (e) — Frontend

### 5.1 `UsersTab.tsx` grouping — no production change expected

Both sections are already derived from `SOURCEY_RESOURCES`:

- Global section: `GLOBAL_PERMISSION_RESOURCES = RESOURCES.filter(r => !SOURCEY_RESOURCES.includes(r.id))` (`:70-72`) → `settings` leaves automatically.
- Per-source grid: `PERMISSION_KEYS.filter(r => SOURCEY_RESOURCES.includes(r as ResourceType))` (`:950`) → `settings` enters automatically; `PERMISSION_KEYS` already contains `'settings'` (`:58-63`).
- Save: `allKeys = [...PERMISSION_KEYS, ...GLOBAL_PERMISSION_RESOURCES]` (`:269`) → unchanged union; the server splits.

**WP4's job is to prove this, not to change it.** If the render test shows `settings`
appearing in neither section under some scope state, fix it minimally there and record the
deviation. Also confirm `labelMap` / `tooltipMap` carry a `settings` entry so the row in
the per-source grid is not labelled with the raw key.

### 5.2 `AuthContext.tsx:267` — the highest-risk item in this phase

`hasPermission`'s sourcey branch:

```ts
if (isSourceyResource(resource)) {
  if (opts?.anySource) { …union over bySource…; }
  const targetSourceId = opts?.sourceId ?? null;
  if (!targetSourceId) return false;          // ← hard false
  …
}
```

There are **12** `hasPermission('settings', …)` call sites and **11 of them pass no
`opts`**. The moment `settings` becomes sourcey, all 11 return `false` for every
non-admin: the Settings tab vanishes from the sidebar, `App.tsx`'s tab gate rejects the
route, and every settings-write control renders read-only — **even though the backend
would have authorized the request**. This is a worse user-visible regression than the bug
being fixed, and neither the epic doc nor #4416 enumerates it.

**Do not "fix" this by changing `hasPermission`'s default.** Making the no-`sourceId` case
fall back to a union would change behavior for `nodes`, `messages`, `channel_*` and every
other sourcey resource, and would reintroduce exactly the cross-source leak that the
`if (!targetSourceId) return false` line was added to close (pinned by
`AuthContext.test.tsx:212`, "returns false for sourcey resource without sourceId (no
cross-source leak)").

**Fix the call sites instead, with one rule:**

> **The frontend gate must be scoped exactly the way the endpoint it guards is scoped.**
> If the control calls an unscoped route (34 of the 36 gates) → `{ anySource: true }`,
> which is the literal frontend mirror of the backend's union branch.
> If the control calls `POST /api/settings?sourceId=…` or another scoped route →
> `{ sourceId }` from `useSource()`.

### 5.3 Call-site table (verify each against the endpoint it guards)

| File:line | Current | Required | Notes |
|---|---|---|---|
| `src/App.tsx:659` | `hasPermission('settings','read')` | `{ anySource: true }` | Top-level tab gate. Must not vanish. |
| `src/components/Sidebar.tsx:237` | `hasPermission('settings','read')` | `{ anySource: true }` | Nav link. |
| `src/components/Sidebar.tsx:284` | `canReadSettings={…}` | `{ anySource: true }` | Prop passthrough. |
| `src/components/Dashboard/DashboardSidebar.tsx:847` | `canReadSettings={…}` | `{ anySource: true }` | Cross-source dashboard — no single source in context. |
| `src/components/SettingsTab.tsx:308` | `canWriteSettings` | `{ anySource: true }` | The tab hosts both global and per-source panels; per-panel scoping is out of Phase 6 scope — record as a follow-up candidate. |
| `src/components/MeshCore/MeshCoreNodeDisplaySection.tsx:64` | `{ sourceId }` | **unchanged** | Already correct — Phase 3 wrote it this way. The reference implementation. |
| `src/components/MeshCore/MeshCorePacketMonitorView.tsx:64` | none | `{ sourceId }` if `useSource()` is non-null, else `{ anySource: true }` | Writes a per-source packet-log setting. Verify the endpoint. |
| `src/components/MQTT/MqttPacketMonitorView.tsx:85` | none | same as above | Verify the endpoint. |
| `src/components/PacketMonitorSettings.tsx:24` | none | same as above | Verify the endpoint. |
| `src/components/TelemetryGraphs.tsx:453` | none | `{ anySource: true }` | Unless it posts scoped — verify. |
| `src/components/MessagesTab.tsx:1432` | none | `{ anySource: true }` | Guards an unscoped action. |
| `src/components/auto-responder/ScriptDependenciesPanel.tsx:48` | none | `{ anySource: true }` | `scriptRoutes` gates are unscoped. |

For each row the implementer **must** open the endpoint the control calls and confirm
whether it declares `sourceIdFrom`. The table above is the expected answer, not a
substitute for checking. Any deviation gets recorded.

### 5.4 The `anySource` union is not a leak

Worth stating because it looks like one: `{ anySource: true }` grants the UI affordance
when the user holds the grant on *any* source. That is not a widening — it is an exact
mirror of what `checkPermissionAsync` does server-side for the same unscoped endpoint. The
server remains the authority; the frontend is only deciding whether to render a control the
server would accept. Rendering a control the server would reject (today's would-be
behavior after a naive flip) is the actual bug.

---

## 6. Item (f) + the mandatory test audit

### 6.1 The Phase 5 rule, carried forward and restated

> **Every new or changed test must be observed to fail against unfixed code before it
> counts.** Write the test, run it against the tree *without* the corresponding production
> change (or with that change reverted), capture the actual failure output, and paste it
> into the work-package report. A test whose failure mode was never observed is not
> evidence; the epic has already produced six tests that could not catch what they were
> named for, and this rule caught two more at design time in Phase 5.

Per-test negative controls are specified inline in §7.

### 6.2 The KNOWN GAP flip — `settingsRoutes.perSource.test.ts`

The test at `:83-108` asserts `200` for a cross-source write and carries
`TODO(#4416)`. It flips to:

```ts
it('a sourceA-scoped settings:write grant is rejected on sourceB and on the unscoped global write', async () => {
  await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
  const agent = await harness.loginAs(harness.limited);

  const resA = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ maxNodeAgeHours: '48' });
  expect(resA.status).toBe(200);

  const resB = await agent.post(`/api/settings?sourceId=${harness.sourceB}`).send({ maxNodeAgeHours: '48' });
  expect(resB.status).toBe(403);

  const resGlobal = await agent.post('/api/settings').send({ maxNodeAgeHours: '48' });
  expect(resGlobal.status).toBe(403);   // ← see §6.3 before implementing
});
```

**Honor the test's own warning.** The grant setup stays exactly as it is — one
`grant(limited, 'settings', 'write', sourceA)`. Do not add a second grant, do not switch to
an admin agent, do not relax the assertion to `not.toBe(200)`. A 403 on `resB` from an
unweakened fixture is the entire point.

Also required: delete the `TODO(#4416)`, rewrite the 22-line file header (it describes the
defect in the present tense) and the 33-line root-cause comment into a short "why settings
is source-scoped, see PHASE6 spec §2" note. Rename the test off "KNOWN GAP".

### 6.3 The `resGlobal` assertion — SETTLED: 200

WP6 writes `expect(resB.status).toBe(403)` and `expect(resGlobal.status).toBe(200)`.

`settingsRoutes.ts:291` declares `sourceIdFrom: 'query'`, so on an unscoped call
`scopedSourceId` is `undefined` and `checkPermissionAsync` takes the sourcey **union**
branch. 200 is therefore the behavior the route was written to have, and it is *not* a
leak. The full ruling and its reasoning — including the decisive point that 403 would
create a state no admin can grant their way out of, since migration 132 deletes the global
grant rows — is in **§11**. Cite §11 in the test comment; a bare `toBe(200)` in a
tightening phase will otherwise read as a mistake to the next person who opens the file.

### 6.4 Test audit — classification

**Tests that would still pass with the defect present (the audit's key question):**

| File | Verdict | Why it is blind |
|---|---|---|
| `src/server/routes/settingsRoutes.test.ts` | **KEEP + annotate** | `vi.mock('../../services/database.js')` with `checkPermissionAsync.mockResolvedValue(true/false)` (`:18-33, :84, :225, :444, :863, :1096`). The mock *is* the thing under test, so this suite cannot detect any classification defect — before or after. It legitimately tests handler logic. Add a header note saying so and pointing at `settingsRoutes.perSource.test.ts` for authz coverage. **Do not convert it** — CLAUDE.md says legacy tests convert opportunistically, and converting a 1,100-line suite is not this phase's job. |
| `src/components/UsersTab.permission-save.test.ts` | **KEEP + annotate** | Never imports `UsersTab`. It re-implements the filter logic over a hardcoded literal array (`:23-35`) and asserts against it. It will pass identically before and after the flip and cannot see the grouping change at all. This is a textbook "test that re-implements the thing it tests". Annotate; real coverage comes from WP4's new render test. |
| `src/server/routes/userRoutes.test.ts` | **AUDIT then classify** | Uses the legacy `vi.mock` DB pattern. WP3 must check whether its permission tests assert against a fake `checkPermissionAsync`; if so, annotate as blind and add the real coverage in the new harness-based file rather than editing this one. |

**Tests that must be rewritten (they pass today *because* of the defect):**

| File:line | Change | Guard |
|---|---|---|
| `src/server/routes/settingsRoutes.perSource.test.ts:83` | The KNOWN GAP flip, §6.2 | Fixture unchanged. |
| `src/server/routes/geojsonRoutes.disablePopup.test.ts:120` | `grant(limited.id,'settings','write')` → `grant(limited.id,'settings','write', harness.sourceA)` | Grant on **exactly one** source. Granting on all sources would make the test pass without exercising the union branch. |
| `src/server/routes/elevationRoutes.test.ts:187` | same | same |
| `src/server/routes/autoAckConverterRoutes.test.ts:224` | same | same |

These three are **not** weakenings. A global grant is currently the only way to express
"can write settings"; post-flip the equivalent expression is a single per-source grant, and
the route is unscoped so one source suffices. Each edit carries a one-line comment saying
so and referencing #4416. These three tests failing (403) against the unfixed fixture is
also WP6's negative control — the first proof that the classification actually flipped.

**Tests that stay untouched (verified still meaningful):**

- `src/server/routes/sourceRoutes.permissions.test.ts` — the canonical harness template; exercises genuinely sourcey resources. Unaffected.
- `src/server/migrations/033_per_source_permissions.test.ts` — asserts a frozen historical list. Must **not** be updated to include `settings`; 033 did not fan out settings and rewriting history would be a lie.
- `src/contexts/AuthContext.test.tsx:205,212` — the sourcey/no-leak cases. Keep exactly; WP5 **adds** settings + `anySource` cases beside them.
- `src/server/migrations/131_seed_per_source_node_display*.test.ts` — unrelated (settings *values*, not grants).

**Nothing is deleted.** The only deletion in this phase is the production file
`src/server/constants/permissions.ts`, which has no test.

---

## 7. Work packages

**All packages land in a single PR.** The flip is atomic: WP1 alone leaves the tree broken
(11 frontend gates return false, three route tests fail). The packages exist to let several
implementers work in parallel on disjoint files, not to be merged separately.

### Dependency ordering

```
WP1 (list + guard)          ← must complete first; everything else needs 'settings' sourcey
   ├── WP2 (migration 132 + upgrade proof + shared fanout module)
   │      └── WP7 (source-creation reconciliation) — needs WP2's shared module
   ├── WP3 (userRoutes)
   ├── WP4 (UsersTab proof)
   ├── WP5 (hasPermission call sites)
   └── WP6 (existing-test reconciliation)
WP2..WP6 run in parallel. WP7 starts when WP2's shared module exists.
Orchestrator runs the single authoritative full suite after all packages report.
```

### File ownership (no file is written by two packages)

| File | Owner |
|---|---|
| `src/types/permission.ts` | WP1 |
| `src/types/permission.sourcey.test.ts` *(new)* | WP1 |
| `src/server/constants/permissions.ts` *(deleted)* | WP1 |
| `src/server/services/settingsGrantFanout.ts` *(new)* | WP2 |
| `src/server/services/settingsGrantFanout.test.ts` *(new)* | WP2 |
| `src/server/migrations/132_fan_out_settings_permissions.ts` *(new)* | WP2 |
| `src/server/migrations/132_fan_out_settings_permissions.test.ts` *(new)* | WP2 |
| `src/server/migrations/132_fan_out_settings_permissions.pgmysql.test.ts` *(new)* | WP2 |
| `src/db/migrations.ts` | WP2 |
| `src/server/routes/userRoutes.ts` | WP3 |
| `src/server/routes/userRoutes.permissions.perSource.test.ts` *(new)* | WP3 |
| `src/server/routes/userRoutes.test.ts` | WP3 (audit/annotate only) |
| `src/components/UsersTab.tsx` | WP4 (expected: no change) |
| `src/components/UsersTab.sourceyGrouping.test.tsx` *(new)* | WP4 |
| `src/components/UsersTab.permission-save.test.ts` | WP4 (annotate only) |
| `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/SettingsTab.tsx`, `src/components/Dashboard/DashboardSidebar.tsx`, `src/components/TelemetryGraphs.tsx`, `src/components/PacketMonitorSettings.tsx`, `src/components/MeshCore/MeshCorePacketMonitorView.tsx`, `src/components/MQTT/MqttPacketMonitorView.tsx`, `src/components/MessagesTab.tsx`, `src/components/auto-responder/ScriptDependenciesPanel.tsx` | WP5 |
| `src/contexts/AuthContext.test.tsx` | WP5 |
| `src/server/routes/settingsRoutes.perSource.test.ts` | WP6 |
| `src/server/routes/geojsonRoutes.disablePopup.test.ts` | WP6 |
| `src/server/routes/elevationRoutes.test.ts` | WP6 |
| `src/server/routes/autoAckConverterRoutes.test.ts` | WP6 |
| `src/server/routes/settingsRoutes.test.ts` | WP6 (annotate only) |
| `src/db/repositories/auth.ts` | WP7 |
| `src/server/routes/sourceRoutes.ts` | WP7 |
| `src/server/routes/sourceRoutes.settingsGrantFanout.test.ts` *(new)* | WP7 |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` | Orchestrator (deviations log) |

`src/services/database.ts` is owned by **nobody** — it needs no change, and a diff to it in
this PR is a red flag.

### ⚠ Parallel-run discipline

> **No work package runs the full Vitest suite.** Concurrent full runs corrupt the shared
> MySQL test schema on `localhost:3307` (all suites share one database). Each package runs
> **only the targeted files listed in its acceptance criteria**. The orchestrator runs the
> single authoritative full suite once, after every package reports, with no other package
> executing.

Also: `npm run lint:ci` must be judged by in-repo failures only —
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` must be empty.

---

### WP1 — List reconciliation and drift guard

**Changes**
1. `src/types/permission.ts:68-74` — add `'settings'` to `SOURCEY_RESOURCES`. Rewrite the
   `:64-67` doc comment: it currently claims the list "matches the SOURCEY_RESOURCES set
   used by migration 033", which becomes false. Replace with a statement that this is the
   single canonical definition, that adding an entry is a **breaking change requiring a
   fan-out migration** (point at this spec §3), and that `dashboard`/`info`/`audit`/
   `security` are deliberately excluded (point at §1.3).
2. Delete `src/server/constants/permissions.ts`.
3. New `src/types/permission.sourcey.test.ts`:
   - Pins the exact contents of `SOURCEY_RESOURCES` against a literal expected array
     (sorted comparison), with a failure message naming this spec.
   - Asserts `isSourceyResource('settings') === true`.
   - Asserts `isSourceyResource('dashboard' | 'info' | 'audit' | 'security') === false`,
     each with a comment citing §1.3 so a reader sees these are decisions.
   - **Drift guard:** walks `src/**` (excluding `node_modules`, `.claude/worktrees`,
     `dist`) for `SOURCEY_RESOURCES` declarations; fails if any is found outside
     `src/types/permission.ts` and `src/server/migrations/**`.

**Acceptance**
- `npx vitest run src/types/permission.sourcey.test.ts` green.
- `npx tsc --noEmit` clean.
- `grep -rn "constants/permissions" src/` returns only comment lines in WP6-owned test files (which WP6 removes).
- **Negative controls, all three observed and pasted into the report:**
  1. Remove `'settings'` from the list → the pin test fails.
  2. Re-create `src/server/constants/permissions.ts` with a `SOURCEY_RESOURCES` export → the drift guard fails.
  3. Add `'dashboard'` to the list → the pin test fails (proves the pin is exact, not a subset check).

---

### WP2 — Migration 132 and the upgrade proof

**This package contains the phase's deliverable.**

**Changes**
1. `src/server/services/settingsGrantFanout.ts` — the two pure functions in §3.5.
2. `src/server/services/settingsGrantFanout.test.ts` — unit tests for the pure functions:
   OR-union across mixed-scope rows; all-false rows dropped; donor `grantedAt`/`grantedBy`
   selection (NULL-scoped row preferred); `existingPairs` exclusion; empty inputs.
3. `src/server/migrations/132_fan_out_settings_permissions.ts` — §3.3 on all three
   backends, structured exactly like 131.
4. `src/db/migrations.ts` — register 132. (`src/db/migrations.test.ts` needs no edit; its
   assertions are registry-derived.)
5. The upgrade proof tests, below.

**The upgrade proof — `132_fan_out_settings_permissions.test.ts` (SQLite) and
`.pgmysql.test.ts` (PG/MySQL)**

Same fixture and same assertions in both files; only the driver differs.

*Fixture (seeded as raw permission rows, pre-migration, with 3 sources A/B/C):*

| User | Settings rows before |
|---|---|
| u1 | global (NULL) read+write — the common case |
| u2 | global read only |
| u3 | global, all flags false |
| u4 | *no settings row at all* |
| u5 | global read **+** per-source-A write — mixed |
| u6 | **only** per-source-A write, no global row — the historic-PUT shape (§3.2) |
| u7 | `isAdmin: true`, global read+write |
| u8 | `anonymous`, no settings row |

Also seed non-settings rows (`nodes` per-source, `themes` global) for the untouched
assertion.

*Assertions:*

1. **Effective-access identity (the deliverable).** Build a matrix over
   `users × {read, write} × {A, B, C, undefined}`.
   - **BEFORE** is computed by a frozen local oracle in the test file — a deliberate
     byte-for-byte re-implementation of the pre-#4416 non-sourcey branch
     (`OR across every settings row regardless of scope`). ~12 lines. **See the mandatory
     comment below — it is not optional boilerplate.**
   - **AFTER** is the **real** `databaseService.checkPermissionAsync(userId, 'settings',
     action, scope)` run against the post-migration database.
   - Assert the two matrices are deep-equal. Not "after ⊇ before" — **equal**. A widening
     is as much a defect as a narrowing.

   **Mandatory comment on the oracle.** This epic has already found six tests that
   re-implemented the logic they were supposed to be testing and therefore could not catch
   anything — a re-implementation is normally an automatic reject. This one is the
   exception, and the *only* thing that makes it legitimate is that a single binary cannot
   run both classifications at once: the "before" behavior no longer exists in the code by
   the time the test runs. Without an explicit note saying so, a future maintainer will see
   a copy of production logic drifting from `checkPermissionAsync` and helpfully "fix" it,
   which silently converts the deliverable into a test that compares the new behavior to
   itself. Write it in these terms, at the oracle:

   ```ts
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
   ```
2. **Admin unaffected**: u7 answers `true` everywhere both before and after (bypass), and
   this must not be what makes assertion 1 pass — assert u1/u2/u5/u6 individually too.
3. **NULL rows removed**: zero rows with `resource='settings' AND sourceId IS NULL`.
4. **Row count**: `settings` rows = (users with a non-all-false effective grant) × 3.
   u3 and u4 contribute zero rows.
5. **Nothing else touched**: snapshot every row with `resource != 'settings'` before and
   after; assert byte-identical. *(A migration that fanned out every resource passes 1–4.)*
6. **Idempotency**: run the migration a second time; the full permissions table is
   byte-identical to after the first run.
7. **Zero sources**: fresh DB with the same users and **no** sources → migration is a
   no-op, the NULL rows survive, a WARN is logged.
8. **Missing `sources` table**: no throw.
9. **Zero settings rows**: no throw, no writes.
10. **Batching**: seed 150 users × 3 sources (450 rows) and assert completion plus, on
    PG/MySQL, that the insert issued ≤ `ceil(450/200)` statements (spy on `client.query`).
    Proves §3.5 rather than trusting it.

**Acceptance**
- `npx vitest run src/server/services/settingsGrantFanout.test.ts src/server/migrations/132_fan_out_settings_permissions.test.ts` green.
- PG/MySQL: pre-check `nc -z localhost 5433 && nc -z localhost 3307`, then
  `npx vitest run src/server/migrations/132_fan_out_settings_permissions.pgmysql.test.ts --reporter=json --outputFile=<scratch>/wp2.json`
  and **paste `numTotalTests`, `numPassedTests`, `numPendingTests` into the report.**
  `numPendingTests` must be `0` and `numPassedTests > 0`. A green run with
  `numPendingTests > 0` means the suites skipped and the package is **not** done —
  this is CLAUDE.md's explicit silent-skip trap.
- **Negative controls, observed and pasted:**
  1. Stub the migration body to a no-op → assertion 1 fails for u1/u2/u5/u6.
     *(Proves the result comes from the migration, not the fixture.)*
  2. Change the fan-out to read only `sourceId IS NULL` rows → assertion 1 fails for **u6**
     specifically. *(Proves §3.2 is load-bearing, not defensive over-engineering.)*
  3. Move the `DELETE` before the `INSERT` and abort mid-transaction → the rollback leaves
     the NULL rows intact. *(Proves the ordering in §3.3.)*
  4. Fan out all resources instead of `'settings'` → assertion 5 fails.

---

### WP3 — `userRoutes.ts`

**Changes**
1. Rewrite the stale comments at `:367-369` and `:413-418` (§4.1). The `:416-417` comment
   naming `settings` as global must go — it is the artifact that let this survive.
2. Convert this handler's two 400s to `fail(res, 400, 'MISSING_SOURCE_ID', …)` and
   `fail(res, 400, 'INVALID_PERMISSIONS', …)` (§4.2). Leave the success paths as bare
   payloads.
3. New `src/server/routes/userRoutes.permissions.perSource.test.ts` using
   `createRouteTestApp()`:
   - PUT with `{ permissions: { settings: {read,write} } }` and **no** `sourceId` → 400
     `MISSING_SOURCE_ID`.
   - PUT with the same payload **and** `sourceId: sourceA` → 200, and a row lands with
     `sourceId = sourceA` (assert via `getUserPermissionSetsBySourceAsync`, not raw SQL).
   - PUT of a purely global payload (`themes`) with no `sourceId` → still 200, unchanged.
   - GET `?sourceId=A` returns `settings` from `bySource[A]`; GET with no `sourceId`
     **omits** `settings` (§4.1) — this is the assertion that proves the UsersTab
     no-400 reasoning in §4.2.
   - Regression pin for §4.3: PUT with `sourceId=A` and a payload omitting `settings`
     removes the sourceA settings row. Named and commented as a known destructive-replace
     behavior, not a bug being introduced.
4. Audit `userRoutes.test.ts` (§6.4). Annotate if blind; do not convert.

**Acceptance**
- `npx vitest run src/server/routes/userRoutes.permissions.perSource.test.ts src/server/routes/userRoutes.test.ts` green.
- **Negative control:** revert WP1's one-line change → the "PUT without sourceId → 400"
  test fails (it would 200), and the "GET unscoped omits settings" test fails. Observed and pasted.

---

### WP4 — `UsersTab` grouping proof

**Changes**
1. `src/components/UsersTab.tsx` — **expected: no change.** If the render test proves
   otherwise, make the minimal fix and record the deviation prominently.
2. New `src/components/UsersTab.sourceyGrouping.test.tsx` — renders the component:
   - With a source scope selected: a `settings` row appears in the per-source grid and
     **not** in the Global Resources section.
   - Its label comes from `labelMap`, not the raw key `settings`.
   - The Global Resources section still contains `themes` / `sources` / `channel_database`
     (proves the test can see that section at all, so the settings absence is meaningful).
3. Annotate `UsersTab.permission-save.test.ts` per §6.4 — a header note that it is a
   literal-list test that cannot see grouping or component behavior.

**Acceptance**
- `npx vitest run src/components/UsersTab.sourceyGrouping.test.tsx src/components/UsersTab.test.tsx src/components/UsersTab.permission-save.test.ts` green.
- **Negative control:** revert WP1's change → the new test fails on **both** assertions
  (settings absent from the grid, present in the global section). Observed and pasted.
  If it fails on only one, the test is half-blind — fix it.

---

### WP5 — `hasPermission` call-site scoping

**Changes**
1. Apply §5.3 to all 11 unscoped call sites. For each, **open the endpoint the control
   calls** and confirm the scoping before choosing `{ anySource: true }` vs `{ sourceId }`.
   Record any deviation from the table.
2. `src/contexts/AuthContext.tsx` — **no change to `hasPermission` itself.** If a change
   feels necessary, stop and escalate: §5.2 explains why the default must not move.
3. `src/contexts/AuthContext.test.tsx` — add beside the existing cases:
   - `hasPermission('settings','read')` with no opts and only a `bySource[A]` grant → `false`
     (pins the trap, so nobody re-introduces an unscoped call site).
   - Same with `{ anySource: true }` → `true`.
   - Same with `{ sourceId: A }` → `true`, `{ sourceId: B }` → `false`.
   - Admin → `true` regardless of opts.

**Acceptance**
- **WP5 is not optional and must not be descoped, deferred, or partially applied.**
  Orchestrator ruling, independently verified: there are exactly 12
  `hasPermission('settings', …)` call sites and exactly **one** passes `opts`
  (`MeshCoreNodeDisplaySection.tsx:64`, from Phase 4). `AuthContext.tsx:274` is
  `if (!targetSourceId) return false;`. Ship WP1 without WP5 and a change whose whole
  purpose is tightening one permission check instead **removes the entire Settings UI from
  every non-admin user** — while the backend still authorizes their requests. A partial
  application is worse than none: it leaves the failure on whichever surfaces were missed,
  where it looks like an unrelated bug. **All 11 sites, or the PR does not ship.**
- `npx vitest run src/contexts/AuthContext.test.tsx` plus the co-located tests of every
  touched component, green.
- Every one of the 11 sites reported individually: file:line, the endpoint it guards,
  whether that endpoint declares `sourceIdFrom`, and the option chosen. A site listed
  without its endpoint checked does not count as done.
- **Negative control:** revert the `{ anySource: true }` at `src/App.tsx:659` and
  `src/components/Sidebar.tsx:237` → a test asserting a non-admin with a per-source
  `settings:read` grant can still see the Settings nav entry fails. If no such test exists,
  **write one** — this is the regression that would ship silently otherwise, and it is the
  single most likely user-visible failure of this phase.
- Manual step §9.2 (real browser, real non-admin user, Settings nav entry visible) is part
  of WP5's acceptance, not just the orchestrator's closing checklist. Mocked component
  tests cannot prove a call site was not missed somewhere they do not render.

---

### WP6 — Existing-test reconciliation

**Changes**
1. `settingsRoutes.perSource.test.ts` — the flip (§6.2), the header/comment rewrite, the
   `TODO(#4416)` removal, the rename. `resB → 403`, `resGlobal → 200` (§11 ruling, settled
   — cite §11 in the test comment). Fixture untouched.
2. The three global→per-source grant fixups (§6.4). One source each, one comment each.
3. Annotate `settingsRoutes.test.ts` per §6.4.

**Acceptance**
- `npx vitest run src/server/routes/settingsRoutes.perSource.test.ts src/server/routes/settingsRoutes.test.ts src/server/routes/geojsonRoutes.disablePopup.test.ts src/server/routes/elevationRoutes.test.ts src/server/routes/autoAckConverterRoutes.test.ts` green.
- `grep -rn "KNOWN GAP\|TODO(#4416)\|constants/permissions" src/` returns nothing.
- **Negative controls, observed and pasted:**
  1. Revert WP1's change → `resB` returns 200 and the flipped test fails. *(The single
     clearest proof the fix works.)*
  2. Revert WP1's change → the three fixed-up tests fail 403 with per-source grants.
     *(Proves the fixup edits were necessary, not cosmetic.)*

---

### WP7 — Source-creation reconciliation (case 3.7(b))

Small, self-contained, and closes the "grant the migration missed" hole.

**If WP7 is deferred (orchestrator's call), all four of these are required — the
consequence must be written where an operator hits it, not only in this spec:**

1. **File the follow-up issue in the same session.** Title it for the symptom an operator
   would search for, not the mechanism: *"Sources created after migration 132 have no
   settings grants — non-admins silently denied"*.
2. **Epic deviations log** (`PER_SOURCE_NODE_DISPLAY_EPIC.md`, Phase 6 entry) — record the
   deferral and the exact consequence, with the issue number.
3. **PR body** — one line under the breaking-change paragraph: a source created after this
   upgrade grants nobody `settings` access until an admin grants it per source, same as
   `nodes`/`messages`/channels have always behaved.
4. **The migration's zero-source WARN log line** (§3.6) — make it name the consequence
   directly, since that log is the one place an affected operator actually looks:
   `"Migration 132: no sources present — settings grants left global and INERT. Users with
   settings grants will be denied until an admin re-grants per source after adding a
   source. See #<issue>."`

The affected population is narrow (a database that had **zero** sources when 132 ran, and a
non-admin holding a settings grant) but the failure is silent and has no error message
anywhere in the product, which is exactly the class of bug this phase exists to prevent.

**Changes**
1. `src/db/repositories/auth.ts` — new async method
   `fanOutGlobalGrantsToSource(resource: string, sourceId: string): Promise<number>`.
   Drizzle query builders only — `sourceRoutes.ts` is **not** exempt from the raw-SQL ban.
   Reads `permissions` rows for `resource` with `sourceId IS NULL`, runs them through
   `computeEffectiveGrants` / `computeFanOutInserts` from WP2's shared module, inserts the
   new rows, deletes the NULL ones, returns the row count.
2. `src/server/routes/sourceRoutes.ts` — after a source is created successfully, call
   `fanOutGlobalGrantsToSource('settings', newSourceId)`. Failure is logged, never fatal to
   the create (a source that fails to create because of a permission-bookkeeping error is a
   worse outcome than the grant gap).
3. New `src/server/routes/sourceRoutes.settingsGrantFanout.test.ts` using the harness:
   - DB with a surviving NULL settings grant and zero sources → create a source → the user
     can write settings on it; the NULL row is gone.
   - DB with no NULL settings rows → create a source → **no** permission rows are created
     (proves it is a no-op in case 3.7(a), the overwhelmingly common path).
   - The fan-out throwing does not fail source creation.

**Acceptance**
- `npx vitest run src/server/routes/sourceRoutes.settingsGrantFanout.test.ts src/db/repositories/auth.test.ts` green.
- `npm run lint:ci` shows no new raw-SQL violation for `sourceRoutes.ts`.
- **Negative control:** stub the fan-out call out of the create handler → the first test
  fails (the user is denied on the new source). Observed and pasted.

---

## 8. Orchestrator-only steps (after every package reports)

1. **The single authoritative full suite**, with PG and MySQL up and **no** package running:
   ```bash
   nc -z localhost 5433 && nc -z localhost 3307 || echo "START THE CONTAINERS FIRST"
   npm run test -- --reporter=json --outputFile=<scratch>/full.json
   ```
   Confirm `success === true` **and** compare `numPendingTests` against a pre-change
   baseline run. A jump in pending tests means the multi-backend suites skipped
   (CLAUDE.md's silent-skip trap) and the run proves nothing.
   `rtk`'s `PASS (N) FAIL (0)` summary is not sufficient — read the JSON.
2. `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
3. `npx tsc --noEmit` clean.
4. Update `PER_SOURCE_NODE_DISPLAY_EPIC.md`: tick Phase 6, rewrite the
   "Blocked: bug #4" section into a resolved note pointing at this spec, add the Phase 6
   deviations log.
5. PR body must state the breaking change in the first paragraph, name the migration, and
   spell out the upgrade behavior for admins ("your existing settings grants now exist on
   every source; narrow them per source in the Users tab").
6. Close #4416.

---

## 9. Manual verification (do not skip — this epic has twice caught bugs only the live app showed)

Deploy the dev container (`docker-compose.dev.yml` **plus** `docker-compose.dev.local.yml`)
and drive the real app in an anonymous browser context:

1. Create a non-admin user. Grant `settings: read + write` on **source A only**.
2. Log in as that user. **The Settings nav entry must be visible.** (This is the §5.2
   regression — a mocked test suite will not catch it if a call site was missed.)
3. Change a Node Display value on source A → saves.
4. Switch to source B → the same control must be read-only / rejected.
5. Log in as admin → Users tab → the `settings` row appears in the **per-source** grid, not
   the Global Resources section, and the checkbox state follows the scope dropdown.

---

## 10. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | A user's grant is missed by the fan-out → silent loss of settings access | **High** | WP2's before/after effective-access matrix, asserted **equal**, over 8 grant shapes × 3 sources × 2 actions, on all three backends. Negative control 2 proves the u6 (historic per-source-only) case is actually covered. |
| R2 | **The 11 unscoped `hasPermission('settings')` call sites** — every non-admin loses the Settings UI even though the backend authorizes them | **High** | §5.3 call-site table + WP5's negative control + manual step 9.2. Independently verified by the orchestrator (12 sites, 1 with opts; `AuthContext.tsx:274` returns false). Neither the epic doc nor #4416 lists this; it is the most likely way this phase ships broken. **WP5 is therefore non-negotiable and cannot be partially applied** — a partial fix leaves the failure on the missed surfaces, where it reads as an unrelated bug. |
| R3 | Zero sources at migration time → NULL rows survive and are inert | Medium | §3.6 (never delete without inserting) + WP7. If WP7 is deferred, WP7's four-item deferral checklist is mandatory — issue, epic deviations log, PR body, and a WARN log line that names the consequence where an operator will actually see it. |
| R4 | Migration crashes between insert and delete | Medium | Single transaction per backend, delete last, idempotent re-run. WP2 negative control 3. |
| R5 | The fan-out accidentally touches other resources | Medium | WP2 assertion 5 (byte-identical snapshot of all non-settings rows) + negative control 4. |
| R6 | The lists drift apart again in six months | Medium | WP1's repo-scanning drift guard, which fails on any new `SOURCEY_RESOURCES` declaration outside the two permitted paths. |
| R7 | A blind test gives false confidence | Medium | §6.4 names the three blind suites explicitly and annotates them in-tree, so the next reader does not mistake them for coverage. |
| R8 | Concurrent package runs corrupt the shared MySQL schema | Low-Medium | §7 parallel-run discipline: targeted files only per package; one authoritative full run by the orchestrator. |
| R9 | PG/MySQL suites skip silently and the phase ships schema-unverified | Medium | Every acceptance criterion that touches the DB requires pasting `numPendingTests` from the JSON reporter, not just `success`. |

---

## 11. RULING — unscoped `POST /api/settings` returns **200**

**Question:** what should the unscoped `POST /api/settings` return for a user holding
`settings:write` on exactly one source?

**Ruling (orchestrator, 2026-07-29): 200.** Settled — WP6 writes
`expect(resGlobal.status).toBe(200)`. This is not an open question and does not need
revisiting mid-implementation.

Recorded in full, because the next reader will ask why an unscoped write *succeeds* in a
phase whose entire purpose was tightening this exact check:

1. **It follows from the route's own declaration.** `settingsRoutes.ts:291` declares
   `sourceIdFrom: 'query'`. On an unscoped call `scopedSourceId` is `undefined`, so
   `checkPermissionAsync` takes the sourcey **union** branch by design, not by accident.
   That is consistent with the 34 other unscoped `settings` gates (map styles, geojson
   layers, scripts, system restart), which have no source to name and for which "holds
   `settings:write` somewhere" is the only coherent reading of the gate.
2. **403 would create a state no admin can grant their way out of.** This is the decisive
   point. Migration 132 **deletes the global (`sourceId = NULL`) settings rows** (§3.3
   step 5c). After this phase a global settings grant no longer exists as a concept, and
   no control in the product can create one — `userRoutes.ts` PUT routes every sourcey
   resource to a `sourceId`. So a 403 here would mean a user holding `settings:write` on a
   source simply **cannot save global settings, with no remedy anywhere in the UI.** That
   is a functional regression, not a tightening.
3. **Making 403 workable would be a second breaking change.** It requires inventing a new
   concept — an admin-only global-settings gate, or a resurrected global grant — with its
   own migration story and its own upgrade risk. Not in this PR.

**Scope of the ruling:** only the `resGlobal` assertion turned on it. The `resB === 403`
half — a source-A grant rejected on source B — is the actual fix and was never in
question. §4.4 stands unchanged: do **not** add `sourceIdFrom` to any of the 34 unscoped
routes as a consequence of this ruling.

---

## 12. What this phase explicitly does NOT do

- Does not touch `dashboard`, `info`, `audit`, or `security` (§1.3).
- Does not add `sourceIdFrom` to the 34 unscoped `settings` route gates (§4.4).
- Does not change `checkPermissionAsync`, `getUserPermissionSetsBySourceAsync`,
  `requirePermission`, or `hasPermission`'s own logic — all four are already correct.
- Does not convert `settingsRoutes.test.ts` or `userRoutes.test.ts` off the legacy mock
  pattern (annotate only; CLAUDE.md says opportunistic).
- Does not resolve the epic's open question about *setting values* for sources created
  after migration 131. Different problem, same shape.
