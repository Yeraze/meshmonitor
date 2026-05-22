# Resolution Plan — MQTT & Channel Database Security Review

**Source:** `docs/security-review-mqtt-channeldb.md`
**Strategy:** ship three independent PRs in dependency order. Each PR is self-contained, passes the full Vitest suite, and is independently reviewable.

---

## Sequencing rationale

```
PR-A (foundation)      PR-B (server enforcement)      PR-C (UI gating)
  ├ Define resource ─────┐                              │
  ├ Migration 064        ├─► Enforce in routes  ───────►├─► UI uses new
  └ ADMIN/DEFAULT perms  │   Source-scope decrypt       │   resource + flags
                         │   Deprecate legacy           │   UI banners
                                                        └─► UsersTab updates
```

- PR-A introduces the `channel_database` resource and writes the migration so the resource exists in the DB before any handler reads it.
- PR-B switches handlers to consult permissions (P0 security fixes for retroactive decrypt + dead permission table) and deprecates the duplicate legacy route.
- PR-C closes the UI gaps now that the underlying model is correct (MQTTConfigSection gate, DashboardSidebar fix, UsersTab grid additions).

PR-A and PR-C **must not** ship without PR-B in between — otherwise the schema/UI advertise a permission that the handlers don't honor.

---

## PR-A — Foundation: register `channel_database` as a permission resource

### Goal
Add `channel_database` as a **global** (not sourcey) resource with actions `read`, `write`, `manage_permissions`. Backfill admin grants. No behavior change yet.

### Changes

1. **`src/types/permission.ts`**
   - Add `'channel_database'` to `ResourceType` union (after `'waypoints'`).
   - Add to `RESOURCES` array: `{ id: 'channel_database', name: 'Channel Database', description: 'Manage global channel/PSK library used for MQTT decryption' }`.
   - Add to `ADMIN_PERMISSIONS`: `channel_database: { read: true, write: true }`.
   - Add to `DEFAULT_USER_PERMISSIONS`: `channel_database: { read: false, write: false }`.
   - **Do NOT** add to `SOURCEY_RESOURCES` — it's global.

2. **`src/server/constants/permissions.ts`**
   - No change to `SOURCEY_RESOURCES` (channel_database is global).
   - Optionally add a `GLOBAL_RESOURCES` set for symmetry/docs.

3. **`src/server/migrations/064_add_channel_database_permission.ts`** (new)
   - SQLite, PostgreSQL, MySQL variants.
   - Backfill: for every user where `isAdmin = 1`, insert `(userId, 'channel_database', canRead=true, canWrite=true, canViewOnMap=false, sourceId=NULL)` if not exists.
   - Idempotent (try/catch on UNIQUE, `IF NOT EXISTS`, info_schema check).
   - Register in `src/db/migrations.ts`; bump migration count test in `src/db/migrations.test.ts` to 64.

4. **Tests**
   - `064_add_channel_database_permission.test.ts` — backfill is idempotent, grants admins only.
   - Update `src/types/permission.test.ts` (if exists) to cover the new resource.

### Acceptance
- `npm run lint` + `npm test` green.
- New migration runs on fresh DB and on a DB upgraded from 063 with existing admins.
- No route or UI behavior change yet.

### Files touched
```
src/types/permission.ts
src/server/migrations/064_add_channel_database_permission.ts        [new]
src/server/migrations/064_add_channel_database_permission.test.ts   [new]
src/db/migrations.ts
src/db/migrations.test.ts
```

---

## PR-B — Server enforcement: fix decrypt ACL, wire up the permission table, deprecate legacy routes

### Goal
P0 security fixes:
- Retroactive decryption respects per-source `messages:read`.
- `channel_database_permissions` table is actually consulted (or removed if we decide not to support non-admin access).
- All channel-database handlers use `requirePermission('channel_database', ...)` middleware instead of inline `isAdmin` checks.
- Legacy `/api/channel-database` route removed; UI migrated to `/api/v1/channel-database`.

### Decision needed before starting
**Q:** Do we keep the per-entry `channel_database_permissions` table?
- **Option 1 (recommended):** Keep it. Non-admins with `channel_database:read` + per-entry `canRead=true` can see channel metadata (PSK masked via `transformChannelForResponse`). Admin-only operations remain admin-only.
- **Option 2:** Delete the table and the per-entry routes entirely. Channel database becomes purely an admin-managed global config. Simpler, but discards work already on disk.

The plan below assumes **Option 1**. If the team picks Option 2, skip changes 3/4/5 and drop the schema + repository methods + UI section.

### Changes

1. **`src/server/routes/v1/channelDatabase.ts`**
   - Replace each inline `if (!isAdmin) return 403` with `requirePermission('channel_database', 'read'|'write')` middleware on the route declaration.
   - `GET /` and `GET /:id`: when caller lacks `channel_database:write` (i.e. is not an admin equivalent), call `getPermissionsForUserAsync(user.id)` and filter by `canRead`. PSK is masked via the existing `transformChannelForResponse(_, includeFullPsk=false)` path.
   - `POST /`, `PUT /:id`, `PUT /reorder`, `DELETE /:id`: `requirePermission('channel_database', 'write')`.
   - `GET/PUT/DELETE /:id/permissions`: `requirePermission('channel_database', 'write')` (or `'manage_permissions'` if we add that action — see step 6).
   - `POST /:id/retroactive-decrypt`: see step 2.
   - `GET /retroactive-decrypt/progress`: `requirePermission('channel_database', 'read')`.

2. **`src/server/routes/v1/channelDatabase.ts:589` — retroactive decrypt source-scope check (P0)**
   - Before calling `retroactiveDecryptionService.processForChannel(id)`, query the encrypted-packet log for the distinct `sourceId`s that would be touched by this channel's decrypt pass.
   - For each `sourceId`, call `databaseService.checkPermissionAsync(user.id, 'messages', 'read', sourceId)`.
   - If any source is denied, either:
     - Return `403` listing the denied source IDs (strict), **or**
     - Pass an allowed-sources allowlist into `processForChannel` so denied sources are skipped (graceful).
   - Recommended: **strict 403** with a clear error message. Decrypt is destructive (writes decrypted payloads back into the packet log), so partial decrypts are a surprising mode.
   - Add a new method on `retroactiveDecryptionService` (or new repository method) that lists distinct `sourceId`s in the encrypted-packet log for a given channel — needed to support either approach.

3. **`src/db/repositories/channelDatabase.ts`** (no schema change; usage change)
   - No new methods strictly required — existing `getPermissionsForUserAsync(userId)` is sufficient. Add JSDoc clarifying that the result is filtered to `canRead = true` when used for read gating.

4. **`src/server/routes/channelDatabaseRoutes.ts`** (legacy)
   - **Delete** the file. Update `src/server/server.ts` to remove the `apiRouter.use('/channel-database', ...)` mount at ~line 937.
   - Confirm with grep that no other code references the legacy mount.

5. **`src/services/api.ts:1367,1377,1395,1415,1425`**
   - Migrate the five `'/api/channel-database*'` calls to `'/api/v1/channel-database*'`.
   - Add `Bearer` token handling if the v1 router gates on `requireAPIToken()` rather than session auth — see step 7.

6. **(Optional) Add `'manage_permissions'` action**
   - `PermissionAction` is currently `'viewOnMap' | 'read' | 'write'`. Adding a fourth action is invasive (touches schema, repository, middleware, UI).
   - **Simpler:** treat `channel_database:write` as the manage-permissions gate. This is the recommended path for v1.

7. **v1 router auth context**
   - Check whether `requireAPIToken()` on the v1 router also accepts session auth (the UI is browser-based, not token-based). If it doesn't, either:
     - Allow session auth on v1 channel-database routes specifically, **or**
     - Have the UI continue to use a session-friendly mount path (e.g. mount the new `channelDatabase` router twice — once under `/api/v1` with token auth, once under `/api/admin/channel-database` with session auth — sharing the same handlers).
   - Verify this before deleting the legacy route in step 4. If `requireAPIToken()` is strict, defer the legacy-route deletion to a follow-up PR and instead patch the legacy handlers to call the same `requirePermission` middleware.

8. **Tests**
   - `src/server/routes/v1/channelDatabase.permissions.test.ts` (new):
     - Non-admin with `channel_database:read` + per-entry `canRead` sees entry without `psk` field.
     - Non-admin without `channel_database:read` gets 403.
     - Admin (or `channel_database:write`) sees `psk`.
   - `src/server/routes/v1/channelDatabase.retroactiveDecrypt.test.ts` (new):
     - Caller missing `messages:read` on a touched source gets 403 with denied-source list.
     - Caller with full access proceeds; service is invoked.
     - Service is **not** invoked when validation fails.
   - Update existing channel-database route tests for the new middleware.

### Acceptance
- All existing tests pass with the new middleware (mock `checkPermissionAsync` for `channel_database` resource).
- New tests cover the retroactive-decrypt cross-source isolation case.
- Legacy `/api/channel-database` path returns 404 (or, if deferred, both paths produce identical behavior).
- `transformChannelForResponse(_, false)` is now reachable in production code.

### Files touched
```
src/server/routes/v1/channelDatabase.ts                                [edit]
src/server/routes/v1/channelDatabase.permissions.test.ts               [new]
src/server/routes/v1/channelDatabase.retroactiveDecrypt.test.ts        [new]
src/server/routes/channelDatabaseRoutes.ts                             [delete]
src/server/server.ts                                                    [edit — remove legacy mount]
src/server/services/retroactiveDecryptionService.ts                    [edit — add source enumeration helper]
src/db/repositories/channelDatabase.ts                                  [doc-only]
src/services/api.ts                                                     [edit — path migration]
```

---

## PR-C — UI gating: MQTTConfigSection, DashboardSidebar, UsersTab

### Goal
Close the three UI gaps identified in §2 and §4 of the review. No backend changes; depends on PR-A so the new resource exists in `usePermissions()` responses.

### Changes

1. **`src/components/configuration/MQTTConfigSection.tsx`** (P0 UI)
   - Import `usePermissions` (or whichever hook exposes the current `PermissionSet` to components — match the pattern used by other configuration sections).
   - Derive `canEditMqtt = permissions.sources?.write === true` (scoped to the current source via `useSource()`).
   - Wrap form body in `<fieldset disabled={!canEditMqtt}>`.
   - Above the fieldset, render an inline banner when `!canEditMqtt`: "You don't have permission to modify MQTT settings for this source."
   - Disable the Save button when `!canEditMqtt`.

2. **`src/components/Dashboard/DashboardSidebar.tsx:357`** (P1 correctness)
   - Replace `isAdmin &&` with `permissions.sources?.write === true &&` for the "Prune Outside ROI" kebab item.
   - Add a test in `DashboardSidebar.test.tsx` covering: non-admin with `sources:write` sees the item; admin without `sources:write` does not.

3. **`src/components/UsersTab.tsx`**
   - `PERMISSION_KEYS` (lines 48–53): add `'waypoints'` (it's already in `SOURCEY_RESOURCES` but missing from the UI grid).
   - Add a new **Global Resources** section above the per-source grid that renders `themes`, `sources`, `channel_database`. These are global — they ignore the source-scope dropdown.
     - Use `RESOURCES` from `src/types/permission.ts` as the source of truth; filter by `!SOURCEY_RESOURCES.includes(id)`.
   - In the Channel Database per-entry section (lines 837–885):
     - Add a `canWrite` checkbox column.
     - Add a revoke (✕) button per row that calls `DELETE /api/v1/channel-database/:id/permissions/:userId`.
   - Group/label sources in the scope dropdown by `type` field (`TCP`, `Serial`, `MQTT broker`, `MQTT bridge`, `MeshCore`). Use `<optgroup>` elements.

4. **Tests**
   - `UsersTab.channelDatabase.test.tsx` (new or extend existing): grid renders `canWrite` and revoke control; revoke calls the right endpoint.
   - `UsersTab.globalResources.test.tsx` (new): global resources section renders the three globals and doesn't react to source-scope changes.

### Acceptance
- All UI components behave correctly for: admin, non-admin with relevant permission, non-admin without.
- Manual smoke test in the dev container: log in as a non-admin user granted `sources:write`, confirm `MQTTConfigSection` is editable and the "Prune Outside ROI" item is visible.

### Files touched
```
src/components/configuration/MQTTConfigSection.tsx                 [edit]
src/components/Dashboard/DashboardSidebar.tsx                       [edit]
src/components/Dashboard/DashboardSidebar.test.tsx                  [edit/extend]
src/components/UsersTab.tsx                                          [edit]
src/components/UsersTab.channelDatabase.test.tsx                    [edit/extend]
src/components/UsersTab.globalResources.test.tsx                    [new]
```

---

## Cross-cutting

### Documentation
- Update `CLAUDE.md` "What's right" / "Hard rules" if needed once `channel_database` global resource exists.
- Update `docs/ARCHITECTURE_LESSONS.md` with a note: "Global permission resources exist alongside per-source resources; check `SOURCEY_RESOURCES` to decide which model a new resource belongs to."

### Open questions to resolve before starting
1. **`requireAPIToken()` vs session on the v1 channel-database router** — does it block browser session auth? (Determines whether PR-B can drop the legacy route.)
2. **Strict vs graceful retroactive decrypt** — when caller lacks `messages:read` on some sources, 403-block the whole pass, or skip those sources? (Recommendation: strict.)
3. **Keep or drop `channel_database_permissions` table?** — Option 1 (keep + wire up) is the default plan; if the team decides admin-only is enough, Option 2 (delete) is simpler.
4. **Add `manage_permissions` as a 4th action?** — No (recommended). Use `channel_database:write` for now; add later if delegation requirements emerge.

### Out of scope (for this plan)
- Adding `read_psk` as a distinct sub-action. Today, PSK is included iff caller has `channel_database:write`; metadata-only with masked PSK is reachable via `channel_database:read` + per-entry `canRead`. A finer split can come later.
- Renaming `canViewOnMap` semantics on `channel_database_permissions`. Document its meaning in PR-B, refactor later if needed.
- Grouping sources by type in the source picker — included in PR-C but could be split out if the diff grows.

---

## Estimated effort

| PR | Scope | Test additions | Risk |
|---|---|---|---|
| PR-A | Schema + migration + resource constants | ~50 LOC tests | Low — additive, backfill only |
| PR-B | Route middleware + retroactive-decrypt scope check + legacy route removal | ~200 LOC tests | **Medium** — touches the security boundary; needs careful review |
| PR-C | UI gating in 3 components | ~80 LOC tests | Low — UI only |

Total: 3 PRs, ~3–5 working days, depending on PR-B test depth.
