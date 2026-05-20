# Security & Permissions Review — MQTT and Channel Database

**Date:** 2026-05-20
**Scope:** MQTT broker/bridge subsystem + global Channel Database feature
**Reviewer:** Claude (deep-dive audit)

---

## 1. Executive Summary

| Area | API enforcement | UI gating | Permission model |
|---|---|---|---|
| MQTT broker/bridge (sources) | ✅ Strong (`sources:read/write`) | 🔴 Missing in `MQTTConfigSection`, wrong in `DashboardSidebar` (uses `isAdmin` not `sources:write`) | ✅ Reuses `sources` + per-source resources cleanly |
| Channel Database (global) | ⚠️ Auth+isAdmin only; per-entry permission table exists but is **never enforced** | ✅ Admin-only gate works, but no non-admin path | 🔴 No `channel_database` resource defined; `canWrite` UI checkbox missing |
| Retroactive decrypt | 🔴 Bypasses per-source ACLs entirely | n/a | 🔴 No source-scoped check before decrypting cross-source packets |
| Permissions admin UI (`UsersTab`) | n/a | 🔴 `channel_database` per-entry section lacks `canWrite` + delete buttons; `themes`/`sources`/`waypoints` missing from grid | ⚠️ Hardcoded `PERMISSION_KEYS` list drifts from backend `SOURCEY_RESOURCES` |

**Overall risk level: MEDIUM** — the system is currently safe because most sensitive paths fall back to admin-only, but the `channel_database_permissions` table is dead code waiting to silently leak data the moment someone wires it up.

---

## 2. MQTT subsystem

### What's right
- Every HTTP route under `src/server/routes/sourceRoutes.ts` that touches `mqtt_broker`/`mqtt_bridge` sources uses `requirePermission('sources', 'read'|'write')`.
- Per-source data endpoints (`/api/sources/:id/nodes|messages|traceroutes`) correctly use `{sourceIdFrom: 'params.id'}` so MQTT sources are scoped exactly like TCP sources.
- `stripSourceSecrets()` redacts credentials/PSK from `GET /api/sources/:id` for non-admins (MM-SEC-8).
- Bridge cascade-check (`DELETE /api/sources/:id`) prevents orphaning bridges when the parent broker is deleted.
- `mqttIngestion`/`mqttPacketFilter` enforce access at retrieval time via the standard per-source query path — no separate auth domain needed.
- Embedded broker auth (Aedes username/password) is correctly treated as a **separate** auth domain from MeshMonitor permissions. Devices auth to the broker; users auth to MeshMonitor. This is the right design.

### Issues

**🔴 P0 — `src/components/configuration/MQTTConfigSection.tsx` has no permission gate**
Component imports no `usePermissions`/`useAuth`/`isAdmin` and renders every field editable. Server rejects the PUT, but UX is broken: user fills in a form, hits save, gets opaque 403.
Fix: gate with `sources:write` permission, disable the `<fieldset>` and show an inline permission-denied banner.

**⚠️ P1 — `src/components/Dashboard/DashboardSidebar.tsx:357` gates "Prune Outside ROI" by `isAdmin` instead of `sources:write`**
The API endpoint (`POST /api/sources/:id/prune-outside-roi`) correctly checks `sources:write`. A non-admin with `sources:write` is locked out of the button despite having permission; an admin who had `sources:write` revoked still sees it. Replace `isAdmin` with `permissions.sources?.write`.

**ℹ️ Design note — `GET /api/sources/:id/status` uses `optionalAuth()` (public)**
Intentional for the dashboard sidebar badge, and nodeCount is gated downstream by `nodes:read`. Reasonable as-is, but consider gating `clientCount`/`clientIds` behind `sources:read` if exposing connected MQTT client identifiers becomes sensitive in multi-tenant deployments.

### MQTT permissions that **don't** need to exist
- A dedicated `mqtt_broker` / `mqtt_bridge` permission resource is unnecessary. MQTT sources reuse `sources` (lifecycle), `connection` (start/stop), `messages`/`nodes`/`traceroute` (per-source data) cleanly.
- The embedded broker's MQTT username/password is correctly outside the MeshMonitor permission system.

---

## 3. Channel Database (global)

### Architecture
- Table: `channel_database` (global, sourceId column was dropped — commit `0a28b8e2`).
- Companion table: `channel_database_permissions` with columns `userId`, `channelDatabaseId`, `canViewOnMap`, `canRead`, `grantedBy`, `grantedAt`.
- Routes mounted **twice**: `/api/v1/channel-database` (token auth, `src/server/routes/v1/channelDatabase.ts`) and `/api/channel-database` (session auth, `src/server/routes/channelDatabaseRoutes.ts`). Both perform the same `if (!isAdmin) return 403` inline.
- UI: `ChannelDatabaseSection.tsx` is rendered only when `isAdmin === true` in `SettingsTab.tsx`.

### Issues

**🔴 P0 — Retroactive decrypt bypasses per-source ACLs**
File: `src/server/routes/v1/channelDatabase.ts:589` (and legacy `:590`).
`retroactiveDecryptionService.processForChannel(channelDatabaseId)` walks `getEncryptedPackets()` with **no source filter**. An admin scoped to Source A can trigger decryption that exposes Source B's historical packets. In multi-source deployments this defeats the entire per-source isolation model.
Fix: before processing, enumerate distinct `sourceId`s in the encrypted-packet log for this channel and either (a) reject if the caller lacks `messages:read` on any, or (b) restrict the decrypt pass to sources the caller can access.

**🔴 P0 — `channel_database_permissions` table is dead code**
`GET /` and `GET /:id` short-circuit with `if (!isAdmin) return 403` before ever consulting the permissions table. The `// TODO: Add per-channel permissions for non-admin users` comment confirms this. Anyone reading the schema will assume permissions are enforced; they are not.
Fix: when `!isAdmin`, fetch via `getPermissionsForUserAsync(user.id)`, filter by `canRead`, and never include `psk` in the response (the existing `transformChannelForResponse(_, includeFullPsk=false)` already handles this — it's just unreachable today).

**🔴 P0 — No `channel_database` resource in `src/server/constants/permissions.ts`**
The framework's `requirePermission()` middleware can't be applied because the resource isn't registered. This is why every endpoint hand-rolls `isAdmin` checks instead of using middleware.
Fix: add `channel_database` as a **global** (not sourcey) resource. Suggested actions: `read`, `write`, `manage_permissions`. If PSK exposure must be separable from metadata access, add `read_psk` as a distinct action.

**⚠️ P1 — Dual routes (v1 + legacy)**
Same logic in two files, double the surface area for bugs. Confirm whether the in-tree UI calls v1 or legacy, then deprecate the other. Both currently mount, so a fix landed on one route is invisible on the other.

**⚠️ P1 — `canWrite` missing in UI permissions section**
`UsersTab.tsx:842-875` renders only `canViewOnMap` + `canRead` for each channel-db entry. There's no way to grant `canWrite` (and no delete-permission button to revoke a grant). Once per-entry enforcement is real, the UI needs all three actions plus a revoke control.

**⚠️ P2 — `canViewOnMap` semantics undocumented for a global resource**
The flag makes sense per-channel (show/hide nodes on map by channel index 0–7). For a global PSK library, it's ambiguous. Either remove it, or document precisely what it controls (presumably: "include nodes heard with this PSK in map view"). Add a code comment in the schema.

---

## 4. Permissions management UI (`UsersTab.tsx`)

### Current resource list (lines 48–53)
```
dashboard, nodes, channel_0..channel_7, messages, settings,
configuration, info, automation, connection, traceroute, audit,
security, nodes_private, packetmonitor
```
**21 entries.** Matches the per-source/sourcey set but **drifts from `SOURCEY_RESOURCES`**:

| Resource | In `SOURCEY_RESOURCES` | In `PERMISSION_KEYS` UI |
|---|---|---|
| `waypoints` | ✅ | 🔴 missing |
| `themes` | ❌ (global, defined in `ResourceType`) | 🔴 missing |
| `sources` | ❌ (global, defined in `ResourceType`) | 🔴 missing |
| `channel_database` | ❌ (not registered) | partial — per-entry section only, no global resource row |

### Recommended UI changes
1. Add `waypoints` to `PERMISSION_KEYS` (per-source row, `read`/`write` columns).
2. Add a separate "Global resources" section above the per-source grid containing `themes`, `sources`, and (once added) `channel_database`. These should not appear under the per-source scope selector.
3. In the Channel Database per-entry section, add `canWrite` and a revoke (✕) action per row.
4. Group/label sources in the scope dropdown by type (`TCP`, `Serial`, `MQTT broker`, `MQTT bridge`, `MeshCore`) so admins know what they're scoping permissions to.

---

## 5. Prioritized fix list

### P0 (security-critical, ship next)
1. **Add source-scope check before retroactive decrypt** (`channelDatabase.ts:589` + legacy `:590`). Reject or restrict decrypt scope when caller lacks `messages:read` on a source whose packets would be processed.
2. **Register `channel_database` as a global permission resource** in `src/server/constants/permissions.ts` (or extend the resource registry). Actions: `read`, `write`, `manage_permissions`, optionally `read_psk`.
3. **Either enforce the per-entry permission table or delete it**. Current state (table populated, never read) is a foot-gun.
4. **Add `usePermissions()` gate to `MQTTConfigSection.tsx`** — disable fields when caller lacks `sources:write`.

### P1 (correctness / UX)
5. **Fix `DashboardSidebar.tsx:357`** — replace `isAdmin &&` with `permissions.sources?.write &&` for the "Prune Outside ROI" button.
6. **Deprecate one of the two channel-database route files** after confirming which the UI uses. Long-term, prefer the v1 token-authed route and drop the legacy session route.
7. **Extend `PERMISSION_KEYS`** in `UsersTab.tsx` to add `waypoints` and (when added) `channel_database`. Add a Global Resources sub-grid for `themes`, `sources`, `channel_database`.
8. **Add `canWrite` + revoke control** to the channel-database section of `UsersTab.tsx`.

### P2 (polish)
9. Document `canViewOnMap` semantics for `channel_database_permissions` rows (or remove the column).
10. Consider gating `clientCount`/`clientIds` in `GET /api/sources/:id/status` behind `sources:read`.
11. Group sources by type in the permissions scope dropdown so MQTT vs TCP vs MeshCore is obvious to the admin granting permissions.

---

## 6. What's explicitly **out of scope** (and why)

- A dedicated `mqtt` / `mqtt_broker` / `mqtt_bridge` resource. Reusing `sources` + per-source resources is cleaner — MQTT sources are sources.
- Mapping MQTT broker user/password into MeshMonitor permissions. The broker is an external trust domain; devices connect to it directly with their own creds.
- Per-source channel_database scoping. The database is explicitly global by design (commit `0a28b8e2` removed the column). Per-entry permissions stay flat.

---

## 7. Code references

| Concern | File | Lines |
|---|---|---|
| Sourcey resource set | `src/server/constants/permissions.ts` | 7–14 |
| Permissions UI grid | `src/components/UsersTab.tsx` | 48–53, 728–831 |
| Channel-db UI section | `src/components/UsersTab.tsx` | 837–885 |
| MQTT config UI (no gate) | `src/components/configuration/MQTTConfigSection.tsx` | entire file |
| Sidebar prune-button gate | `src/components/Dashboard/DashboardSidebar.tsx` | 357 |
| MQTT source CRUD | `src/server/routes/sourceRoutes.ts` | 163, 213, 266, 420, 551, 950 |
| Channel-db v1 routes | `src/server/routes/v1/channelDatabase.ts` | 50, 88, 123, 174, 294, 372, 531, 589, 666, 728, 825 |
| Channel-db legacy routes | `src/server/routes/channelDatabaseRoutes.ts` | 23, 53–590+ |
| Per-entry perm schema | `src/db/schema/channelDatabase.ts` | (channel_database_permissions table) |
| Per-entry perm repo | `src/db/repositories/channelDatabase.ts` | get/set/deletePermissionAsync |
