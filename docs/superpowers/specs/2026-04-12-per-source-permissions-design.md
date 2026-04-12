# Per-Source Permissions Design

**Date:** 2026-04-12
**Status:** Draft — pending implementation plan
**Related:** Bug report — granting `channel_0:viewOnMap` on Source 1 leaks to Source 2

## Context

MeshMonitor has supported multiple Meshtastic sources since the multi-source architecture work. Permission scaffolding was partially extended to be per-source in migration 022 (`add_source_id_to_permissions`), which added a nullable `sourceId` column to the `permissions` table. Frontend (`UsersTab.tsx`) and service layer (`checkPermissionAsync`, `getUserPermissionSetAsync`) gained `sourceId` parameters, and `requirePermission()` middleware grew an opt-in `{ sourceIdFrom }` option.

**The work was never finished.** The `permissions` table still enforces `UNIQUE(user_id, resource)` — incompatible with multiple per-source rows. More importantly, the **filter helpers** in `src/server/utils/nodeEnhancer.ts` (`filterNodesByChannelPermission`, `maskNodeLocationByChannel`, `checkNodeChannelAccess`) fetch the caller's **global** permission set regardless of which source's data is being filtered. The `/api/sources/:id/nodes` route gates entry correctly but passes no `source.id` into the downstream channel filter — so a user with a global (or accidentally-expanded) `channel_0:viewOnMap` grant sees channel-0 nodes on every source.

This design fixes the leak by committing to **strict per-source permissions** for the resources where it makes sense (channels, messages, nodes, telemetry, device config, etc.), while keeping global permissions for instance-wide features (users, settings, themes, audit). The existing DB column stays; the existing `requirePermission()` opt-in stays; but the enforcement contract becomes **deny-by-default for sourcey resources without a sourceId**, turning any un-plumbed caller from a silent leak into an explicit 403.

## Key Decisions

| Decision | Choice | Alternative rejected |
|---|---|---|
| Semantic model | **(A) Strict per-source only** for sourcey resources; global disallowed for those resources | (B) Per-source overrides global; (C) Union — both reject because they keep the leak class alive |
| Migration strategy | **(i) Expand** existing global rows into one row per existing source, then delete the originals | (ii) Drop and force re-grant — too disruptive; (iii) Grandfather — keeps tech debt forever |
| Admin scope | `isAdmin` stays **global** — admins still bypass all per-source checks | Per-source admin role — much bigger rework, explicitly out of scope |
| Device channel model | Keep `channel_0`..`channel_7` as string resources per source | Collapse into a `device_channels` table with FK scoping — too big a surgery |
| Virtual channels | Already per-source via FK on `channel_database.sourceId`. Only needs a minimal "migrate NULL → default source" pass | First-class per-source grant tables — defer as follow-up |

## Resource Classification

The 24 resources split **13 sourcey / 11 global**.

**Sourcey (per-source only, no global grants allowed):**
- `channel_0`, `channel_1`, `channel_2`, `channel_3`, `channel_4`, `channel_5`, `channel_6`, `channel_7`
- `messages`
- `nodes`
- `nodes_private`
- `traceroute`
- `packetmonitor`
- `configuration` (device config per source)
- `connection` (connect/disconnect a source)
- `automation` (permissions are per-source; rule definitions remain global — see out of scope)

**Global (never per-source):**
- `users`
- `settings`
- `security`
- `audit`
- `themes`
- `sources`
- `info`
- `dashboard`
- `meshcore` (meshcoreManager is a global singleton with no source awareness)

The list lives in a new constants file `src/server/constants/permissions.ts` so backend, migration, frontend, and tests all import the same source of truth.

## Section 1 — Schema & Migration 033

**Current state:**
- `permissions.sourceId` is nullable TEXT (added by migration 022)
- `UNIQUE(user_id, resource)` is incompatible with multiple per-source rows

**Changes (migration 033, applied in this order inside a transaction):**

1. **Drop old unique index** `UNIQUE(user_id, resource)` on `permissions`
2. **Add new unique index** `UNIQUE(user_id, resource, sourceId)`. SQLite/Postgres allow multiple NULLs in unique indexes natively; MySQL allows multiple NULLs per SQL standard. Sourcey rows will never be NULL after migration, so NULL behavior only affects global rows (which are keyed on `(userId, resource, NULL)` — one row max per user per global resource).
3. **Data migration — expand:**
   - For every `(userId, resource, sourceId=NULL)` row where `resource ∈ SOURCEY_RESOURCES`:
     - For each row in `sources` that doesn't already have `(userId, resource, sourceId=<that-source>)`: insert a copy with the same permission bits
     - Then delete the original NULL-scoped row
   - If the instance has zero sources: skip expansion and just delete the legacy rows (user gets no access, which is correct — there's nothing to grant on)
4. **Virtual channel minimal fix:** `UPDATE channel_database SET sourceId = (SELECT id FROM sources ORDER BY createdAt LIMIT 1) WHERE sourceId IS NULL`. Skip if no sources exist.
5. All of the above is idempotent via the `settingsKey` gate — re-running migration 033 is a no-op.

**Edge cases handled:**
- Multiple sources: each gets its own expanded copy
- Zero sources: legacy rows are dropped (correctly)
- User already has a per-source row for `(user, resource, sourceId)`: expansion skips that cell (explicit per-source grant wins, deterministic behavior)
- Re-running: settingsKey gate + `ON CONFLICT DO NOTHING` on the inserts
- Migration logs the number of rows expanded and deleted for audit

## Section 2 — Runtime Enforcement

**New constant file** `src/server/constants/permissions.ts`:
```typescript
export const SOURCEY_RESOURCES = new Set<string>([
  'channel_0','channel_1','channel_2','channel_3',
  'channel_4','channel_5','channel_6','channel_7',
  'messages','nodes','nodes_private','traceroute',
  'packetmonitor','configuration','connection','meshcore','automation',
]);
export const isResourceSourcey = (r: string): boolean => SOURCEY_RESOURCES.has(r);
```

**`checkPermissionAsync(userId, resource, action, sourceId?)` — new semantics:**

| Resource type | `sourceId` | Behavior |
|---|---|---|
| sourcey | provided | Look up `(user, resource, sourceId)`. **No global fallback.** Miss = deny. |
| sourcey | missing | **Return `false`** (deny). In development mode, log a warning to surface unwired callers. |
| global | provided | Ignore the `sourceId` argument. Look up `(user, resource, NULL)`. |
| global | missing | Look up `(user, resource, NULL)`. |

`user.isAdmin === true` continues to short-circuit all of the above and return `true` unconditionally.

**`getUserPermissionSetAsync(userId, sourceId?)` — new semantics:**

- Always include **global** rows (rows where `isResourceSourcey(resource) === false`) — unconditional
- If `sourceId` is provided: also include sourcey rows where `sourceId === <that>`
- If `sourceId` is missing: sourcey resources are **absent from the returned set** (not `{read: false, write: false}` — genuinely absent). Callers must treat absent as "no access"

**Why this shape:** it kills the leak by construction. A caller that asks for permissions without a source simply **cannot** get map-filter data for sourcey resources — the returned set contains only global stuff. The only way to get channel permissions is to pass the correct `sourceId`, which forces every filter site to confront the question.

## Section 3 — Admin UI (UsersTab)

The existing `permissionScope` dropdown stays, but the resource grid becomes **scope-aware**.

**Layout:**

- When **Global** is selected: show only the 10 global resources. Sourcey resources are hidden (not greyed).
- When a **specific source** is selected: show only the 14 sourcey resources. Global resources are hidden.
- A **Copy from…** button appears when a specific source is selected. It opens a picker of other sources and clones their permission bits into the current form state. Does not save until the user clicks Save.
- Inline help text near the dropdown: *"Channel, message, node, and telemetry permissions are granted per-source. Global permissions control instance-wide features like user management, settings, and themes."*

**Save semantics (backend already correct):**
- `PUT /api/users/:id/permissions` with `sourceId=null` saves only global rows — `deletePermissionsForUserByScope(userId, null)` then re-create
- `PUT /api/users/:id/permissions` with `sourceId='src-X'` saves only that source's sourcey rows
- Frontend enforces that the request body contains only resources valid for the selected scope, so stale UI state can't accidentally write an illegal combo

**Backend validation (new):**
- `PUT /api/users/:id/permissions` rejects with **400** if any resource in the body doesn't match the scope (global resource with a `sourceId`, or sourcey resource without one). Defensive — shouldn't happen via the UI, but API tokens and stale clients could try.

## Section 4 — Route & Service Audit

Every permission check must pass a `sourceId` for sourcey resources. The audit has two passes.

**Pass 1: `requirePermission(...)` middleware sites.** Walk every call of `requirePermission(` and classify:

| Case | Action |
|---|---|
| Check is on a global resource | No change |
| Sourcey resource, route path has `:id` or `:sourceId` | Add `{ sourceIdFrom: 'params.id' }` (or appropriate param) |
| Sourcey resource, sourceId in body/query | Add `{ sourceIdFrom: 'body' }` or `'query'` |
| Sourcey resource, no sourceId reachable from request | **Bug in the route.** Must be fixed — the route can't enforce per-source without knowing the source. |

**Known-problem routes to fix first:**
- `/api/sources/:id/nodes` — gate is correct, but `filterNodesByChannelPermission` / `maskNodeLocationByChannel` calls at `sourceRoutes.ts:330-331` need `source.id` threaded in
- `/api/sources/:id/messages`, `/channels`, `/traceroutes`, `/telemetry` — verify all use `{ sourceIdFrom: 'params.id' }`
- `unifiedRoutes.ts` — new, recently modified; close audit required

**Pass 1.5: Filter/mask helpers in `src/server/utils/`.**
- `nodeEnhancer.filterNodesByChannelPermission(nodes, user, sourceId)` — add `sourceId` param; pass through to `getUserPermissionSetAsync`
- `nodeEnhancer.maskNodeLocationByChannel(nodes, user, sourceId)` — same
- `nodeEnhancer.checkNodeChannelAccess(..., sourceId)` — same
- Any `maskTelemetryByChannel`, `maskTraceroutesByChannel` discovered in the audit
- `notificationFiltering.ts`, `appriseNotificationService.ts`, `pushNotificationService.ts`, `webSocketService.ts`, `inactiveNodeNotificationService.ts` — already pass `sourceId` to `checkPermissionAsync` (verified via grep); these remain unchanged

**Pass 2: Direct `databaseService.checkPermissionAsync(...)` callers.** Already audited (most are ✓):
- `notificationFiltering.ts:192` ✓
- `appriseNotificationService.ts:362, 432` ✓
- `pushNotificationService.ts:468, 546` ✓
- `webSocketService.ts:249` — verify
- `inactiveNodeNotificationService.ts:143` ✓
- `authMiddleware.ts:350, 438` — middleware internals; pass the extracted `scopedSourceId`

**Contract:** After this audit, **no sourcey-resource check fires without a `sourceId`**. The deny-by-default behavior in Section 2 is the safety net that turns any un-plumbed caller into a **403** instead of a leak.

## Section 5 — Rollout, Testing & Scope

**Rollout:**
This ships as one PR. Migration 033 is schema + data and runs on container start. Users are not disrupted — existing permissions are preserved via expansion — but admins will notice grants moving from the "Global" scope into each source. This is intentional and matches the new model. No feature flag: the old behavior is the bug, we don't want it reachable.

**Testing strategy (layered):**
1. **Unit — repository layer.** `permissions.test.ts` — per-source insert, UPSERT with new unique key, cross-source read isolation, bulk-expand migration logic against a canned fixture
2. **Unit — service layer.** `database.ts` — `checkPermissionAsync` 4-case table, `getUserPermissionSetAsync` sourcey-absent behavior
3. **Unit — filter helpers.** `nodeEnhancer.test.ts` extended with a two-source fixture; regression test named after this bug report
4. **Integration — routes.** `sourceRoutes.permissions.test.ts` — cross-source leak scenario: grant `channel_0:viewOnMap` on src-1, GET `/api/sources/src-2/nodes`, assert channel-0 nodes are filtered out. Mirror tests for `/messages`, `/traceroutes`, `/telemetry`
5. **Contract — audit spy.** A test that walks every permission check emitted by the backend during a suite of HTTP requests (spy on `checkPermissionAsync`) and asserts no sourcey resource was checked without a `sourceId`
6. **Migration — all three dialects.** Insert global rows for sourcey and global resources, run migration 033, assert row shapes. SQLite via `better-sqlite3`; Postgres/MySQL via existing dialect runners
7. **Frontend — UsersTab.** Component tests for scope-aware rendering, save-body validation, copy-from-source

**Out of scope (explicit):**
- **Per-source admin role.** `isAdmin` stays global.
- **Virtual channel first-class per-source grants.** Only the NULL→default-source one-liner is included.
- **Source-scoped audit log querying.** Audit continues to record `sourceId` where applicable, but no per-source audit view.
- **API token source scopes.** Tokens inherit per-source permissions via the user path, but no token-level source restrictions.
- **Automation rule definitions per source.** `automation` *permissions* are per-source; rule definitions themselves remain instance-global.
- **Legacy `NULL`-sourceId data in non-permission tables.** Separate cleanup.

**Known risks:**
1. **Row count growth.** Permissions table grows by (users × sourcey-resources × sources). Bounded in practice (<3000 rows even for a large instance). Migration log reports expansion count.
2. **"Why did my grant move?"** Admins may be surprised to see grants now under each source. Mitigated by inline help text and changelog entry.
3. **Route audit completeness.** The contract spy test (#5 above) guards this at runtime; any future filter helper that forgets to plumb `sourceId` will fail that test.

## Critical Files

| File | Change |
|---|---|
| `src/server/migrations/033_per_source_permissions.ts` | **NEW** — drop old unique, add new unique, expand data, fix virtual channel NULLs |
| `src/db/migrations.ts` | Register migration 033 |
| `src/db/migrations.test.ts` | Increment count, update last-name assertion |
| `src/server/constants/permissions.ts` | **NEW** — `SOURCEY_RESOURCES` + `isResourceSourcey` |
| `src/services/database.ts` | Update `checkPermissionAsync` + `getUserPermissionSetAsync` per Section 2 |
| `src/server/utils/nodeEnhancer.ts` | Add `sourceId` param to filter/mask helpers |
| `src/server/routes/sourceRoutes.ts` | Thread `source.id` into filter helpers |
| `src/server/routes/userRoutes.ts` | 400 validation on scope/resource mismatch |
| `src/server/routes/unifiedRoutes.ts` | Audit + fix per Pass 1 |
| `src/components/UsersTab.tsx` | Scope-aware resource grid; Copy from source button |
| `src/db/repositories/permissions.test.ts` | Cross-source isolation tests |
| `src/services/database.test.ts` | 4-case table coverage |
| `src/server/utils/nodeEnhancer.test.ts` | Two-source regression tests |
| `src/server/routes/sourceRoutes.permissions.test.ts` | Integration leak-regression tests |
| `src/server/test-contract-permissions.test.ts` | **NEW** — audit spy contract test |

## Verification

1. `npx tsc --noEmit` — clean
2. `./node_modules/.bin/vitest run` — all green
3. SQLite dev container: migration 033 runs cleanly; a user granted only on src-1 cannot see src-2 map data
4. Postgres dev container (`COMPOSE_PROFILES=postgres`): same
5. MySQL dev container (`COMPOSE_PROFILES=mysql`): same
6. Manual reproduction of the original bug: create two sources, grant `channel_0:viewOnMap` to Anonymous on src-1, confirm src-2 map excludes channel-0 nodes
