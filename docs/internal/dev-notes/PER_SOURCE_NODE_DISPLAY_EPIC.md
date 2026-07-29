# Epic — Per-Source Node Display Settings (issue #4412)

**Status:** Phase 1 in progress
**Driving issue:** [#4412](https://github.com/Yeraze/meshmonitor/issues/4412) — "MeshCore — last advert time filtering"
**Started:** 2026-07-29

---

## Goal

Make the whole **Node Display** settings group genuinely per-source, position it
correctly in the per-source Settings UI, plumb it through every consumer, and —
as the payoff — give MeshCore sources the node-age filtering that issue #4412
asks for.

## Why

The Node Display section is *presented* as per-source: it is registered in
`SOURCE_SECTIONS` (`src/components/SettingsTab.tsx:226-232`) and therefore renders
only on the `/source/:sourceId/settings` route. But `SettingsTab` loads from
`apiService.get('/api/settings')` (`:481`) and saves via
`csrfFetch('/api/settings', { method: 'POST' })` (`:920`) with **no `?sourceId`**.
So 9 of its 10 settings are stored in one global row shared by every Meshtastic
and MeshCore source, and the 10th (`localStatsIntervalMinutes`) is written
globally by the UI while `applyManagerSettings.ts:42` reads it per-source — so it
never takes effect at all.

MeshCore adverts are far less frequent than Meshtastic node heartbeats, so a
single shared "Maximum Age of Active Nodes" window cannot serve both. And today
MeshCore node views apply **no** age filter whatsoever
(`MeshCoreNodesView.tsx`, `MeshCoreMap.tsx` — zero `maxNodeAge` hits), which is
exactly the gap #4412 reports.

## Interview decisions (2026-07-29)

| Question | Decision |
|---|---|
| Which Node Display settings become per-source? | **All of them.** `maxNodeAgeHours`; the inactive-node trio (`inactiveNodeThresholdHours`, `inactiveNodeCheckIntervalMinutes`, `inactiveNodeCooldownHours`); `nodeHopsCalculation` + `hideIncompleteNodes`; the dimming trio (`nodeDimmingEnabled`, `nodeDimmingStartHours`, `nodeDimmingMinOpacity`). Plus `localStatsIntervalMinutes`, already per-source on the backend, whose UI save is being fixed. **10 keys total.** |
| Fallback when a source has no stored value? | **Migration seeds every source.** A 093-style prefix-aware migration copies the current global value (or the documented default) into `source:{id}:{key}` for every existing source. New sources fall through to the hardcoded default. **No runtime global fallback** — `getSettingForSource` deliberately lost its fallback in #2839/#2840 and must not regain it. |
| What does MeshCore age filtering measure? | **The reconciled `meshcore_nodes.lastHeard`** (milliseconds), which already follows the manager rule "prefer `contact.lastSeen`, fall back to `lastAdvert * 1000`" (`meshcoreManager.ts:459-462`). No new column, no migration, works for rows already in the DB. |
| How wide does the UI plumbing fix go? | **Node Display section only.** Other `SOURCE_SECTIONS` entries (sorting, telemetry, notifications, packet-monitor, solar, firmware) keep saving globally exactly as today. Converting them is explicitly out of scope. |
| Meshtastic-only settings on a MeshCore source? | **Hide them.** `localStatsIntervalMinutes` and `nodeHopsCalculation` render conditionally on source type. |
| Inactive-node notification service shape? | **One timer, per-source config.** Keep the single scheduler tick; resolve threshold/cooldown per source inside each pass and honor each source's check interval via a per-source next-run timestamp. No timer-per-source lifecycle coupling. |

## Explicitly out of scope

- Converting any other `SOURCE_SECTIONS` group to per-source.
- Adding a `meshcore_nodes.lastAdvert` column.
- Reintroducing a global fallback in `getSettingForSource`.
- Age-based node *purging* — `maxNodeAgeHours` is display/query filtering only and stays that way.

---

## Critical facts for implementers

- **Per-source settings need no schema change.** Scoping is key namespacing:
  `source:{sourceId}:{key}` in the flat `settings` KV table
  (`src/db/repositories/settings.ts:159`).
- **`PER_SOURCE_SETTINGS_KEYS` is advisory today** (`src/server/constants/settings.ts:340-529`).
  Its only production consumer is migration 050. Nothing validates that a
  `POST /api/settings?sourceId=` carries per-source-legal keys, and nothing
  asserts it is a subset of `VALID_SETTINGS_KEYS`. Phase 1 makes it enforced.
- **Unit hazard.** `nodes.lastHeard` is **seconds**; `meshcore_nodes.lastHeard`
  is **milliseconds** (`src/db/repositories/meshcore.ts:728-737`); the transient
  firmware `lastAdvert` is **seconds**. Existing conversion sites:
  `sourceDashboardData.ts:62-64`, `inactiveNodeNotificationService.ts:290` vs
  `:334-335`, `meshcore.ts:731-737`.
- **`GET /api/settings?sourceId=` merges globals *under* per-source overrides**
  (`settingsRoutes.ts:185-187`) while the server read path has no fallback. A
  newly-per-source key therefore *displays* the global value but *behaves* as
  unset until the migration promotes it. This is why Phase 1 must land before
  Phase 2.
- **The per-source POST branch returns early at `settingsRoutes.ts:704`**,
  skipping the global side-effects block, the audit log (`:936-963`), and the
  security-digest reschedule.
- `settings-node-display` renders at `SettingsTab.tsx:1874-2031`. Settings 1-7
  bind through the `SettingsDraft` reducer; settings 8-10 (dimming) bind
  **directly to `SettingsContext`** state with their own `initialNodeDimmingSettings`
  dirty-tracking (`SettingsTab.tsx:427-431`) — they need restructuring, not just rebinding.
- `hideIncompleteNodes` lives in `UIContext.showIncompleteNodes` (inverted,
  `UIContext.tsx:101`), hydrated from the server in `App.tsx:1228-1233`.
- `src/utils/activeWindowConfig.ts` is a **non-React module singleton** mirroring
  `maxNodeAgeHours`, consumed by `src/utils/nodeTransport.ts:169`. It must become
  source-keyed.

## Known bugs this epic fixes en route

1. `src/server/routes/neighborInfoRoutes.ts:15-16` reads the key `'maxNodeAge'`,
   which is not in `VALID_SETTINGS_KEYS` — always null, always falls back to 24. (Phase 2)
2. `localStatsIntervalMinutes` UI writes global, manager reads per-source ⇒ the
   setting has no effect. (Phases 1 + 3)
3. `deleteSourceSettings` is defined but never called; deleting a source
   (`sourceRoutes.ts:861-913`) orphans every `source:{id}:*` row. (Phase 1)
4. `POST /api/settings` uses unscoped `requirePermission('settings','write')` —
   a per-source write is not checked against that source's permission.
   **⚠ NOT fixed by Phase 1 — see "Blocked: bug #4" below.** Phase 1 lands the
   route-level half (the handler now passes a `scopedSourceId`), but that value is
   currently ignored downstream, so the behavior is unchanged.
5. No server-side range validation for `maxNodeAgeHours`; only the client input's
   `min`/`max` constrains it. (Phase 1)
6. Per-source setting changes are never audit-logged. (Phase 1)

---

## Phases

### [ ] Phase 1 — Per-source settings foundation & guardrails

No user-visible change. Makes the per-source settings mechanism trustworthy and
seeds the data.

**Work:**
- Add the 10 Node Display keys to `PER_SOURCE_SETTINGS_KEYS`.
- Add a test asserting `PER_SOURCE_SETTINGS_KEYS ⊆ VALID_SETTINGS_KEYS`.
- Reject global-only keys on `POST /api/settings?sourceId=`.
- `requirePermission('settings','write', { sourceIdFrom: 'query' })`.
- Audit-log the per-source POST branch.
- Call `deleteSourceSettings` on source deletion.
- Server-side range validation for `maxNodeAgeHours` (1-168).
- Migration 131: prefix-aware seed of all 10 keys into `source:{id}:{key}` for
  every existing source, all three backends, idempotent.

**Exit criteria:** full Vitest suite green (PG + MySQL containers up); migration
131 registered and tested on all three backends; `*.perSource.test.ts` covering
the allowlist enforcement and the permission scoping; no behavior change visible
in the app.

### [ ] Phase 2 — Backend reads go per-source

**Work:**
- Convert every backend read of the 10 keys to `getSettingForSource(sourceId, key)`:
  `sourceDashboardData.ts:41-45`/`:233-238`/`:357`, `unifiedRoutes.ts:1296-1299`,
  `tracerouteRoutes.ts:19-21`, `pollRoutes.ts:438-440`, `meshtasticManager.ts:3226-3230`,
  `virtualNodeServer.ts:806-808`, `database.ts:2030`/`:2147`/`:2209`.
- Fix the `neighborInfoRoutes.ts:15` `'maxNodeAge'` dead key.
- Restructure `inactiveNodeNotificationService` to one timer + per-source config
  + per-source next-run timestamps.
- Per-source save side-effects reschedule only the affected source.

**Exit criteria:** full suite green; a `*.perSource.test.ts` proving two sources
with different `maxNodeAgeHours` get different node sets; inactive-node service
tests covering per-source thresholds and intervals.

### [ ] Phase 3 — Frontend per-source state & UI

**Work:**
- `SettingsTab` `mode="source"`: load with `?sourceId`; split the save so Node
  Display keys POST to the scoped endpoint and everything else keeps its current
  unscoped behavior.
- Replace the single-value `SettingsContext` state + localStorage mirrors for
  these keys with per-source-keyed state; make `activeWindowConfig.ts` source-keyed.
- Move `hideIncompleteNodes` out of global `UIContext`.
- Restructure the dimming trio off direct-context binding onto the draft.
- Hide `localStatsIntervalMinutes` and `nodeHopsCalculation` on MeshCore sources.
- Update consumers: `useProcessedNodes.ts:170-196`, `useSourceView.ts:151`/`:351-359`/`:634-636`,
  `utils/mapAge.ts`, `NodesTab.tsx` (age clamp, marker cutoff, opacity, slider range),
  `Dashboard/DashboardMap.tsx`, `useTraceroutePaths.tsx`.

**Exit criteria:** full suite green; browser validation showing two sources with
different max-age values producing different node lists and map markers; no new
console errors.

### [ ] Phase 4 — MeshCore node-age filtering (closes #4412)

**Work:**
- Apply the per-source `maxNodeAgeHours` to `MeshCoreNodesView.tsx` and
  `MeshCoreMap.tsx` using a shared ms/s normalization helper.
- Favorites bypass at parity with Meshtastic (`useProcessedNodes` semantics).
- Decide and document the interaction with the separate, independently-stored
  `MeshCorePathfindingFilterSection` `lastHeardEnabled`/`lastHeardHours` filter
  (default `false` / 168h).

**Exit criteria:** full suite green; browser validation on a MeshCore source
showing the age filter taking effect on both the node list and the map; #4412
closable.

---

## Blocked: bug #4 — two divergent `SOURCEY_RESOURCES` lists

Found during Phase 1 WP2. **Phase 1 does not fix bug #4**, and no later phase of this
epic can fix it either — it needs its own issue with a data migration.

**Tracked as [#4416](https://github.com/Yeraze/meshmonitor/issues/4416).**

There are two `SOURCEY_RESOURCES` definitions and they disagree:

| File | Contains `settings`? | Live? |
|---|---|---|
| `src/types/permission.ts:68-80` | **No** (also omits `dashboard`, `info`, `audit`, `security`) | **Yes** — imported by `services/database.ts:19`, `routes/userRoutes.ts:12`, `contexts/AuthContext.tsx:11`, `components/UsersTab.tsx:15` |
| `src/server/constants/permissions.ts:7-17` | Yes | **No** — its `isResourceSourcey` export is dead code, imported nowhere |

So `checkPermissionAsync` (`services/database.ts:4372`) classifies `settings` as
non-sourcey and takes the branch at `:4392+`, which ignores `sourceId` entirely.
WP2's `requirePermission('settings','write',{ sourceIdFrom: 'query' })` therefore passes a
`scopedSourceId` that is correctly computed and then discarded. Verified empirically with
the route harness: a `settings:write` grant scoped to sourceA today also authorizes writes
to sourceB **and** the unscoped global endpoint.

**Why the one-line fix is wrong.** Adding `'settings'` to `src/types/permission.ts` is a
breaking change, not a typo fix:
- The sourcey branch (`database.ts:4374-4390`) requires `perm.sourceId` to be set. Every
  existing settings grant is stored with `sourceId = NULL` — `userRoutes.ts:415-425` says
  so in an explicit comment naming `settings` as global. Flipping the flag makes **every
  non-admin user with `settings:write` instantly lose settings access.** Needs a migration
  that re-grants existing global rows per source.
- `userRoutes.ts:419-425` would start rejecting settings grants that arrive without a
  `sourceId` (400).
- `UsersTab.tsx` renders the two groups differently; settings would have to move into the
  per-source section.
- `dashboard`, `info`, `audit`, and `security` sit in exactly the same divergence and would
  need the same treatment or an explicit decision to leave them global.

**Phase 1 keeps WP2's route change** — it is correct, inert today, and the precondition for
the real fix. `settingsRoutes.perSource.test.ts` deliberately pins the *actual* current
behavior (200 on all paths) with a header comment explaining why, so the test does not
silently start passing for the wrong reason once the model is reconciled.

## Open question — sources created AFTER migration 131 runs

Surfaced during Phase 1 review; not covered by the interview. **Decide before Phase 2.**

Migration 131 seeds `source:{id}:*` for every source that exists *when it runs*. A source
added later through the UI gets no per-source rows at all. Because Phase 2 removes any
global fallback on the read path, that new source falls through to the **hardcoded
default** (`maxNodeAgeHours=24`, etc.).

That is faithful to the interview decision, but the sub-case was never put to the user.
The surprising outcome: an admin who set `maxNodeAgeHours=72` globally, then adds a second
source, silently gets 24 on the new source — not the 72 they see everywhere else.

Three options:
1. **Hardcoded default** (current spec). Predictable, but ignores the admin's expressed preference.
2. **Seed new sources from the current global value at creation time** in the `sourceRoutes`
   POST handler. Least surprising; the legacy global row survives as a template. Needs a
   decision on what happens once that row drifts or is deleted.
3. **Seed new sources by copying the primary source's values.** Treats the first source as
   the template; no reliance on the legacy global row.

Option 2 is the smallest change and matches what an admin would predict. Raise at the
Phase 2 boundary.

## Deviations log

### Phase 1
- `deleteSourceSettings` needed a **dialect-dependent `ESCAPE` literal**: MySQL's default
  backslash-escape mode requires two literal backslashes to mean one escape character,
  while SQLite and PostgreSQL require exactly one (a two-backslash literal errors with
  "ESCAPE expression must be a single character"). Branched on `isMySQL()`. Verified
  empirically against live containers, not by inspection.
- `settings.test.ts`'s `getAllSettings` assertion was relaxed from exact-equality to a
  subset check. The SQLite fixture builds from the real migration registry, so migration
  131 now legitimately seeds rows into a "fresh" test DB. The test's contract is
  "returns what was set", not "the table starts empty".
- Boolean settings are seeded as `'0'`/`'1'`, **not** `'false'`/`'true'` — matching what the
  UI actually persists (`server.settings-persistence.test.ts:460-464`) and what
  `getSettingAsBoolean` accepts (`value === 'true' || value === '1'`).
- The per-source POST key filter is a **deny-list (default-allow)**, not an allow-list.
  An allow-list would have silently stopped persisting 10 legitimately source-scoped keys
  (`telemetryFavorites`, `dashboardWidgets`, `dashboardSolarVisibility`, the
  `autoKeyManagement*` group, `remoteAdminScannerExpirationHours`, `autoAckTestMessages`)
  at HTTP 200 with no error. Tests pin the polarity so re-inverting it fails CI.
- Two adjacent defects documented but deliberately **not** fixed; each deserves its own issue:
  - `externalUrl` is read by `securityDigestService.ts:332` and written nowhere. Adding it
    to `VALID_SETTINGS_KEYS` would create a new user-writable setting — not this epic's call.
  - Migration 050 imports `PER_SOURCE_SETTINGS_KEYS`, so on fresh installs (which replay all
    migrations) it runs against whatever that array contains *today*, not what it contained
    when 050 was written. Migration 131 deliberately freezes its own key list to avoid this.
