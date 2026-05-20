# Security Review — Investigation Notes for PR-B

**Audience:** the agent implementing PR-B of `docs/security-review-resolution-plan.md`.
**Source docs:** `docs/security-review-mqtt-channeldb.md`, `docs/security-review-resolution-plan.md`.

This file answers the four open questions at the bottom of the resolution plan plus one bonus research item (source enumeration for the retroactive-decrypt scope check). All claims cite `file:line` from the worktree at `/home/yeraze/Development/meshmonitor-security-mqtt-channeldb` (branch `feature/security-mqtt-channeldb`).

---

## Decisions

### Q1 — Does `requireAPIToken()` on `/api/v1` accept session auth?

**Answer: No. It is strictly Bearer-token-only.**

Evidence:

- `src/server/auth/authMiddleware.ts:449-510` is the implementation. The first thing the middleware does:
  - `src/server/auth/authMiddleware.ts:453-459` — if `req.headers.authorization` is missing or doesn't start with `Bearer `, return `401 "API token required. Use Authorization: Bearer <token>"`.
  - Lines 461-464 then strip the prefix and call `databaseService.validateApiTokenAsync(token)`. There is no `req.session.userId` fallback anywhere in the function.
- `src/server/routes/v1/index.ts:46-50` — `requireAPIToken()` is installed as a top-level `router.use(...)` on the `/api/v1` router *before* any v1 sub-router is mounted (sub-routers begin at line 80). This means **every** `/api/v1/*` endpoint other than `/docs` (mounted on line 47) is unreachable from a browser session cookie.
- `src/server/routes/v1/index.ts:82` mounts `channelDatabaseRouter` at `/channel-database` — under this gate.

**Implication for the UI:** `src/services/api.ts:1367,1377,1395,1415,1425,1435,1446,1457` currently call `/api/channel-database*` (the legacy session-authed mount at `src/server/server.ts:937`). If PR-B simply deletes the legacy route, every existing UI page that touches channel-db will start returning 401 because the browser doesn't send a Bearer token.

**Recommendation for PR-B:**

- Do **not** delete the legacy `/api/channel-database` route in PR-B. Instead, **rewrite both mount points to share handlers** by extracting the route handlers into a single function and exporting two routers — one mounted at `/api/v1/channel-database` (token auth via `requireAPIToken`) and one at `/api/channel-database` (session auth via `optionalAuth()`). Both must apply the same permission checks (see Q3/PR-B guidance below).
- Migrating `src/services/api.ts` to v1 + Bearer tokens is a larger change (UI needs token management for browser sessions, which isn't wired up). Defer to a follow-up PR. PR-B should leave `src/services/api.ts` calls pointing at the legacy mount but ensure the handlers behind both mounts are correct.

---

### Q2 — Retroactive decrypt cross-source: strict 403 vs graceful skip?

**Answer: Strict 403 with denied-source list.**

Evidence on what `processForChannel` actually does:

- `src/server/services/retroactiveDecryptionService.ts:61-138` implements `processForChannel(channelDatabaseId)`. It is **not** per-source.
- Line 86 calls `getEncryptedPackets()`, which (line 143-188) calls `databaseService.getPacketLogsAsync({ encrypted: true, limit: batchSize })` with **no `sourceId` filter** even though the filter exists (`src/services/database.ts:8029` accepts `sourceId?: string`, and `src/db/repositories/misc.ts:897` honors it in `buildPacketLogWhere`).
- For each packet that the channel's PSK decrypts (line 198-210), it calls `updatePacketLog` (line 226-253) which writes `decrypted_by='server'`, `decrypted_channel_id=<id>`, and replaces the stored `metadata` JSON with a decrypted variant (removing `encrypted_payload`, adding `retroactively_decrypted: true`). **This is a destructive write back into `packet_log`** — there is no rollback.
- Updated rows become visible to anyone with `packetmonitor:read` for that source through `src/server/routes/packetRoutes.ts:113-120` (see Q3) — i.e. a decrypted payload exposed cross-source is now permanently leaked to every user with packetmonitor access on the foreign source.

Why strict beats graceful here:

1. **Destructive writes.** Even a "graceful skip" still requires picking which sources to write to. A surprise partial decrypt makes the audit log meaningless — a single button-press can produce two different outcomes depending on the caller's per-source ACL.
2. **Discoverable failure mode.** A strict 403 listing `deniedSourceIds: [...]` is something an operator can act on (either ask for permission, or ask an admin to run it). A silent skip looks like success.
3. **No partial-write atomicity guarantee.** `processForChannel` (line 100-114) processes 100 packets at a time across all sources interleaved. There is no mechanism today to "stop after source X" mid-batch without major refactor.
4. **Consistent with sibling endpoints.** Other v1 routes (`src/server/routes/v1/sourceParam.ts:115-130`) reject the whole request when the user lacks permission rather than silently scoping the result.

**Recommended error shape:**
```json
{
  "success": false,
  "error": "Forbidden",
  "code": "FORBIDDEN_SOURCE_SCOPE",
  "message": "You lack messages:read on some sources containing packets this channel would decrypt",
  "deniedSourceIds": ["abc-...", "def-..."]
}
```

---

### Q3 — Keep or drop the `channel_database_permissions` table?

**Answer: KEEP and wire up. The table is already a live data path; the security review's description of it as "dead code" was incorrect.**

Evidence — `getPermissionsForUserAsync` and siblings are called from production code paths that **already surface user-scoped data**:

1. **`src/server/routes/unifiedRoutes.ts:128`** — `getUserReadableVirtualChannelIds(user, isAdmin)` (defined at lines 121-138) calls `databaseService.channelDatabase.getPermissionsForUserAsync(user.id)`, filters by `canRead`, and uses the result to gate which virtual-channel rows appear in **`GET /api/unified/channels`** (called from `router.get('/channels', ...)` at line 188). This is the unified-channel picker used by the messages UI — a non-admin without a row sees the channel disappear from the dropdown entirely.

2. **`src/server/routes/packetRoutes.ts:113-120`** — `requirePacketPermissions` middleware reads the same table to populate `req.allowedChannelDbIds`, which is then used downstream to filter which virtual-channel packets a non-admin sees in `GET /api/packets`. (Test at `src/server/routes/packetRoutes.test.ts:230` confirms the mock surface.)

3. **`src/services/database.ts:8540-8557`** — `getChannelDatabasePermissionsForUserAsSetAsync` wraps the same call and exposes a `{ [id]: { viewOnMap, read } }` map intended for the frontend permissions context.

4. **`src/server/routes/userRoutes.ts:502, 588, 590`** — `GET/PUT /api/users/:id/channel-database-permissions` admin-only routes that read/write the table. The UI section at `UsersTab.tsx:837-885` (per the security review) edits this same data, so the round-trip already works for `canViewOnMap`/`canRead`.

5. **`src/server/routes/v1/channelDatabase.ts:698, 790, 866`** — admin-only `GET/PUT/DELETE /:id/permissions[/:userId]` for per-entry permission management. Already wired and tested (`src/server/routes/v1/channelDatabase.test.ts:478, 506`).

**What's actually dead:** the per-entry permission check inside `GET /api/v1/channel-database` and `GET /api/v1/channel-database/:id` themselves. The handlers short-circuit at `src/server/routes/v1/channelDatabase.ts:55-62` (and 91-98) with `if (!isAdmin) return 403` before ever consulting the permissions table. This is what the review actually meant by "dead code" — those two read handlers ignore the table even though the rest of the codebase consumes it.

**Recommendation for PR-B:** Option 1 (keep + wire up). Specifically:

- Change `GET /` and `GET /:id` in `src/server/routes/v1/channelDatabase.ts` so that non-admins get filtered results via `getPermissionsForUserAsync(user.id)` rather than 403.
- Mirror the same change in the legacy `src/server/routes/channelDatabaseRoutes.ts`.
- Existing `transformChannelForResponse(_, includeFullPsk=false)` (line 24-41) already masks PSK for non-admins — just call it with `false` for the non-admin path.

Dropping the table (Option 2) would also require ripping out `unifiedRoutes.ts:121-138` and `packetRoutes.ts:111-120`, which would be a regression for current users.

---

### Q4 — Add `'manage_permissions'` as a 4th `PermissionAction`?

**Answer: No. Use `channel_database:write` for manage operations.**

Evidence:

- `src/types/permission.ts:31` — `PermissionAction = 'viewOnMap' | 'read' | 'write'`. Three actions exactly.
- `src/types/permission.ts:53-59` — the `PermissionSet` type is hand-keyed on these three; adding a fourth fans out into:
  - `viewOnMap`/`read`/`write` columns in **every** permission table — see `src/db/schema/channelDatabase.ts:48-138` and the `permissions` table referenced throughout `src/db/repositories/auth.ts`.
  - Default permission maps at `src/types/permission.ts:123-175`.
  - Migration registry (`src/db/migrations.ts`).
  - `requirePermission()` middleware (`src/server/auth/authMiddleware.ts:285-385`).
  - `UsersTab.tsx` grid.
- I grep'd for any TODOs or `manage_permissions`/`delete` action hints — none found. The schema treats this as a closed enum.
- The plan doc itself recommends against it (PR-B step 6 at `docs/security-review-resolution-plan.md:117-119`).

**Practical implication:** `channel_database:write` becomes the manage-permissions gate for `GET/PUT/DELETE /api/v1/channel-database/:id/permissions[/:userId]`. This collapses "edit channel" and "edit access list" into the same write grant — which matches how the `sources` resource also bundles lifecycle + per-source delegation under a single `write` bit. If a future delegation requirement emerges (e.g. "users who can grant access but not edit the channel itself"), revisit then.

---

### Q5 (bonus) — Source enumeration for retroactive-decrypt scope check

**Where the data lives:**

- The packets that `processForChannel` walks are rows in **`packet_log`** (schema: `src/db/schema/packets.ts:11-110` for all three backends). The same table that `GET /api/packets` reads.
- `packet_log.sourceId` is a nullable text column (lines 39, 74, 109). `NULL` means the legacy pre-multi-source default — every multi-source rollout migration backfills these rows, but PR-B's enumeration must treat `NULL` as a real bucket (the legacy default-source pseudo-id).
- The encryption marker is `packet_log.encrypted = 1/true` (line 22/57/92). Decryption state is `decrypted_by` (column at lines 35/70/105) — `'server'` means already decrypted by the retroactive service; `'node'` means decrypted by a device locally; `NULL` means undecoded.
- `getPacketLogsAsync({ encrypted: true })` already supports `sourceId?: string` (`src/services/database.ts:8029-8033` accepting `sourceId`; honored at `src/db/repositories/misc.ts:897` in `buildPacketLogWhere`).

**The query needed for the scope check:**

We need: distinct `sourceId` values from `packet_log` rows where:
- `encrypted = true`
- `decrypted_by IS NULL` (skip already-decrypted; matches `retroactiveDecryptionService.ts:156` filter)
- the packet's metadata-stored `encrypted_payload` would decrypt with channel `<id>`'s PSK.

Determining "would decrypt with this channel's PSK" requires actually running the decryption attempt — we cannot pre-filter at the DB layer. So the pragmatic approach is:

**Enumerate the *candidate* source set** (distinct sourceIds across all undecoded encrypted packets) and require permission on all of them. This is strictly more conservative than the actual-touched set, which is appropriate for a security gate.

**Sketch (Drizzle, dialect-agnostic):**

```ts
// Lives in src/db/repositories/misc.ts (next to getPacketLogs) — packet_log is
// owned by MiscRepository today (`src/db/repositories/misc.ts:888-944`).
// Exposed through DatabaseService as getDistinctEncryptedPacketSourceIdsAsync().

import { sql } from 'drizzle-orm';
import { isNull, and, eq } from 'drizzle-orm';

async getDistinctEncryptedPacketSourceIds(): Promise<Array<string | null>> {
  const { packetLog } = this.tables;
  const encryptedTrue = this.isSQLite() ? sql`encrypted = 1` : sql`encrypted = true`;
  const rows = await this.db
    .selectDistinct({ sourceId: packetLog.sourceId })
    .from(packetLog)
    .where(and(encryptedTrue, isNull(packetLog.decrypted_by)));
  return rows.map(r => r.sourceId ?? null);
}
```

**Where it should live:** `src/db/repositories/misc.ts` (alongside `getPacketLogs` — same domain, same table). Expose through `DatabaseService.getDistinctEncryptedPacketSourceIdsAsync()` near `getPacketLogsAsync` at `src/services/database.ts:8029`.

**Important:** the channel-database repo (`src/db/repositories/channelDatabase.ts`) is the wrong home — it doesn't own `packet_log`, and the query has nothing to do with the channel-db schema. The channel `id` is only used to *invoke* the decrypt pass, not to scope the query.

**How PR-B uses it:**

```ts
// in POST /api/v1/channel-database/:id/retroactive-decrypt handler
// (current location: src/server/routes/v1/channelDatabase.ts:589-620)
const candidateSourceIds = await databaseService.getDistinctEncryptedPacketSourceIdsAsync();
const deniedSourceIds: string[] = [];
for (const sid of candidateSourceIds) {
  // null = legacy default source — needs special handling per migration 050 norm.
  // Simplest: treat null as the user's accessible-default sourceId resolution
  // (see resolveDefaultForUser at src/server/routes/v1/sourceParam.ts:33).
  const ok = await databaseService.checkPermissionAsync(
    user.id, 'messages', 'read', sid ?? undefined
  );
  if (!ok) deniedSourceIds.push(sid ?? '(legacy-default)');
}
if (deniedSourceIds.length > 0) {
  return res.status(403).json({
    success: false,
    error: 'Forbidden',
    code: 'FORBIDDEN_SOURCE_SCOPE',
    message: 'You lack messages:read on some sources containing encrypted packets',
    deniedSourceIds,
  });
}
// proceed to processForChannel(id)
```

**Why this is "strictly more conservative than touched":** the candidate set includes every source with *any* undecoded encrypted packet, not just the ones whose packets would decrypt with this channel's PSK. False-positive denials are possible (e.g. user has access to source A whose packets this channel decrypts, lacks access to source B whose packets this channel will *fail* to decrypt — we deny). Pre-filtering by "actually decryptable" would require running the decrypt attempt, defeating the purpose of the pre-check. The plan's recommended trade is to err on conservative denial. Document this in the route's JSDoc.

**Admins bypass:** `checkPermissionAsync` already returns true for admins (see `src/server/auth/authMiddleware.ts:347-351`), so this loop is no-op for admins. The retroactive-decrypt route still needs `isAdmin || channel_database:write` (Q4 decision) as the *outer* gate; the per-source `messages:read` loop is the inner gate.

---

## PR-B implementation guidance

Concrete instructions distilled from the decisions above. Read these together with PR-B in `docs/security-review-resolution-plan.md`.

### Routing & auth

1. **Do NOT delete `src/server/routes/channelDatabaseRoutes.ts` in PR-B.** Keep both mount points alive for one release.
   - Current legacy mount: `src/server/server.ts:937` — `apiRouter.use('/channel-database', optionalAuth(), channelDatabaseRoutes);`
   - Current v1 mount: `src/server/routes/v1/index.ts:82` — `router.use('/channel-database', channelDatabaseRouter);` (gated upstream by `requireAPIToken()` at line 50).
   - PR-B must apply the same permission logic to **both** handler files. Easiest path: extract handler functions into a shared module (e.g. `src/server/routes/channelDatabaseHandlers.ts`) and have both router files wire them up.
2. **Do NOT switch v1 handlers to `requirePermission()` middleware.**
   - `requirePermission()` (`src/server/auth/authMiddleware.ts:285-385`) reads `req.session.userId` at line 318. Token-authed v1 callers do NOT have a session — only `req.user` is set by `requireAPIToken()` (line 490). The middleware would 401 every v1 caller.
   - Follow the existing v1 pattern from `src/server/routes/v1/messages.ts:36-40` and `src/server/routes/v1/sourceParam.ts:50, 118` — call `databaseService.checkPermissionAsync(req.user.id, resource, action, sourceId)` inline. Admins are auto-pass inside `checkPermissionAsync` already; if not, gate with `if (!user.isAdmin && !(await checkPermissionAsync(...)))`.
3. **Do NOT migrate `src/services/api.ts` to `/api/v1/channel-database` in PR-B.**
   - The five+ calls at `src/services/api.ts:1367, 1377, 1395, 1415, 1425, 1435, 1446, 1457` currently use the legacy session-authed mount. Moving them to v1 requires a Bearer token, which the browser session doesn't have wired up. Out of scope for PR-B.

### Permission checks per handler

Apply these gates to **both** the v1 and legacy channel-database routers (PR-A will have added the `channel_database` resource by the time PR-B lands):

| Handler | Current gate (`channelDatabase.ts` line) | New gate |
|---|---|---|
| `GET /` | `:53-62` admin-only 403 | Admin OR `channel_database:read`; if non-admin, filter list via `getPermissionsForUserAsync(user.id)` filtered by `canRead`. Always call `transformChannelForResponse(ch, isAdmin || hasWrite)` so non-admins get masked PSK. |
| `GET /:id` | `:91-99` admin-only 403 | Admin OR (`channel_database:read` AND row exists in `getPermissionAsync(user.id, id)` with `canRead=true`). PSK mask same as above. |
| `POST /` | `:126-138` admin-only 403 | Admin OR `channel_database:write`. |
| `PUT /:id` | `:174-...` admin-only | Admin OR `channel_database:write`. |
| `PUT /reorder` | `:294-...` admin-only | Admin OR `channel_database:write`. |
| `DELETE /:id` | `:372-...` admin-only | Admin OR `channel_database:write`. |
| `POST /:id/retroactive-decrypt` | `:589-620` admin-only | Admin OR `channel_database:write`, **AND** new per-source `messages:read` enumeration check (see Q5). |
| `GET /retroactive-decrypt/progress` | `:666-...` admin-only | Admin OR `channel_database:read`. |
| `GET /:id/permissions` | `:728-...` admin-only | Admin OR `channel_database:write` (managing the ACL == write per Q4). |
| `PUT /:id/permissions/:userId` (or batched) | `:790-...` admin-only | Admin OR `channel_database:write`. |
| `DELETE /:id/permissions/:userId` | `:866-...` admin-only | Admin OR `channel_database:write`. |

### Retroactive-decrypt source-scope check (P0)

Implementation outline:

1. **Add** `MiscRepository.getDistinctEncryptedPacketSourceIds()` in `src/db/repositories/misc.ts` near `getPacketLogs` (around `:888-944`). Use the Drizzle sketch in Q5 above. Filter `encrypted = true (1 for SQLite)` AND `decrypted_by IS NULL`. Return `Array<string | null>`.
2. **Expose** as `databaseService.getDistinctEncryptedPacketSourceIdsAsync()` near `getPacketLogsAsync` at `src/services/database.ts:8029`.
3. **In the handler at `src/server/routes/v1/channelDatabase.ts:589`** (and the legacy mirror), before calling `retroactiveDecryptionService.processForChannel(id)`:
   - Enumerate candidate sourceIds.
   - For each, call `databaseService.checkPermissionAsync(user.id, 'messages', 'read', sid)`.
   - Collect denied IDs. If any, return `403 FORBIDDEN_SOURCE_SCOPE` with `deniedSourceIds` array (see Q2 for shape).
4. **Document** in JSDoc that the check is "strictly more conservative than touched set" — denials can include sources whose packets this channel wouldn't actually decrypt. This is intentional.

### Channel-database permission table — DO wire up, DO NOT drop

- Keep `channel_database_permissions` schema (`src/db/schema/channelDatabase.ts:48-138`) and repo methods (`src/db/repositories/channelDatabase.ts:200-260+`). They are already live in production code paths:
  - `src/server/routes/unifiedRoutes.ts:128` (unified channels list filter for non-admins).
  - `src/server/routes/packetRoutes.ts:113` (packet log virtual-channel filter for non-admins).
  - `src/server/routes/userRoutes.ts:502, 588, 590` (admin UI round-trip).
- The "dead code" was just the *non-consultation* of the table inside `GET /api/v1/channel-database` and `GET /:id`. PR-B fixes that by reading the table in the non-admin branch of those two handlers.
- Document in `src/db/repositories/channelDatabase.ts` that `getPermissionsForUserAsync(userId)` is consumed by both unified-channel routes and v1 channel-db reads; changes affect both.

### `manage_permissions` action

- Do not add it. Keep `PermissionAction` at `'viewOnMap' | 'read' | 'write'` (`src/types/permission.ts:31`).
- Treat `channel_database:write` as the gate for managing per-entry ACLs (`GET/PUT/DELETE /:id/permissions[/:userId]`). Same model as `sources:write` granting lifecycle + per-source delegation today.

### Tests to add (per plan PR-B item 8)

- `src/server/routes/v1/channelDatabase.permissions.test.ts`:
  - Non-admin with `channel_database:read` + per-entry `canRead=true` sees entry, no `psk` field (PSK masked via `transformChannelForResponse(ch, false)` at `src/server/routes/v1/channelDatabase.ts:24-41`).
  - Non-admin with `channel_database:read` but no per-entry row gets entry omitted from list / 404 on `:id`.
  - Non-admin without `channel_database:read` gets 403.
  - Admin sees `psk`.
- `src/server/routes/v1/channelDatabase.retroactiveDecrypt.test.ts`:
  - Mock `getDistinctEncryptedPacketSourceIdsAsync` to return `['source-A', 'source-B']`.
  - Mock `checkPermissionAsync` to allow `messages:read` on A, deny on B.
  - Assert 403 with `deniedSourceIds: ['source-B']`.
  - Assert `processForChannel` was NOT invoked (use `vi.spyOn(retroactiveDecryptionService, 'processForChannel')`).
  - With full access: service IS invoked exactly once with the channel id.
  - Caller without `channel_database:write` (outer gate): 403, source enumeration NOT invoked.
- Don't forget the mirror tests for the legacy session-authed handlers if you reuse the shared handler module — one set of handler tests + thin router wiring tests for both mounts is cleanest.

### Files touched (revised from plan)

```
src/server/routes/v1/channelDatabase.ts                                [edit — inline checkPermissionAsync, no middleware swap]
src/server/routes/channelDatabaseRoutes.ts                             [edit — mirror v1 handler logic; do NOT delete]
src/server/routes/v1/channelDatabase.permissions.test.ts               [new]
src/server/routes/v1/channelDatabase.retroactiveDecrypt.test.ts        [new]
src/server/services/retroactiveDecryptionService.ts                    [NO change — the source-enumeration helper lives in misc repo]
src/db/repositories/misc.ts                                            [edit — add getDistinctEncryptedPacketSourceIds]
src/services/database.ts                                               [edit — expose getDistinctEncryptedPacketSourceIdsAsync]
src/db/repositories/channelDatabase.ts                                  [doc-only — JSDoc on getPermissionsForUserAsync]
```

**Diff from the plan:**
- Legacy route file is **edited, not deleted**.
- `src/services/api.ts` is **not** touched in PR-B (deferred — UI session→token migration is a separate PR).
- `retroactiveDecryptionService.ts` does **not** grow a source-enumeration helper. The helper lives in `MiscRepository` because the data lives in `packet_log`, not in the decryption service.

---

## Quick reference: file:line citations consolidated

| Topic | File:line |
|---|---|
| `requireAPIToken` definition (Bearer-only) | `src/server/auth/authMiddleware.ts:449-510` |
| v1 router gates `/api/v1/*` (except `/docs`) with `requireAPIToken()` | `src/server/routes/v1/index.ts:46-50` |
| `requirePermission` reads `req.session.userId` (session-only) | `src/server/auth/authMiddleware.ts:285-385` (esp. `:318`) |
| Inline v1 permission pattern (use this, not middleware) | `src/server/routes/v1/messages.ts:36-40`, `src/server/routes/v1/sourceParam.ts:50, 118` |
| `optionalAuth()` populates `req.user` from session | `src/server/auth/authMiddleware.ts:24-...` (and `:160-165` for proxy auth path) |
| Legacy mount of `/api/channel-database` with `optionalAuth()` | `src/server/server.ts:937` |
| UI calls legacy `/api/channel-database*` | `src/services/api.ts:1367, 1377, 1395, 1415, 1425, 1435, 1446, 1457` |
| Retroactive decrypt service (no per-source filter today) | `src/server/services/retroactiveDecryptionService.ts:61-188` |
| Retroactive decrypt writes back into `packet_log` | `src/server/services/retroactiveDecryptionService.ts:226-253` |
| `packet_log` schema (all 3 backends, `sourceId` + `encrypted` + `decrypted_by`) | `src/db/schema/packets.ts:11-110` |
| `getPacketLogsAsync` accepts `sourceId` | `src/services/database.ts:8029-8033` |
| `buildPacketLogWhere` honors `sourceId` | `src/db/repositories/misc.ts:893-917` |
| `getPermissionsForUserAsync` used in unified channels | `src/server/routes/unifiedRoutes.ts:121-138, 198` |
| `getPermissionsForUserAsync` used in packet routes | `src/server/routes/packetRoutes.ts:111-120` |
| Per-entry permission table schema | `src/db/schema/channelDatabase.ts:48-138` |
| Per-entry permission repo methods | `src/db/repositories/channelDatabase.ts:200-260+` |
| Admin-only inline gates currently in v1 handlers | `src/server/routes/v1/channelDatabase.ts:53, 91, 126, 174, 297, 375, 534, 592, 669, 731, 828` |
| `transformChannelForResponse` PSK-masking branch (currently unreachable) | `src/server/routes/v1/channelDatabase.ts:24-41` |
| `PermissionAction` enum (only 3 actions) | `src/types/permission.ts:31` |

---

*End of investigation notes. PR-B agent: start with the routing/auth section above before touching handler logic.*
