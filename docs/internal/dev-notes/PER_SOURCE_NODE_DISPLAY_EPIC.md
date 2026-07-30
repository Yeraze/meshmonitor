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

### [x] Phase 1 — Per-source settings foundation & guardrails — **MERGED** (PR #4417, `356002e0`)

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

### [x] Phase 2 — Backend reads go per-source — **COMPLETE** (PR pending)

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

### [x] Phase 3 — Frontend per-source state & UI — **COMPLETE** (PR pending)

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

### [x] Phase 4 — MeshCore node-age filtering (closes #4412) — **WP1/WP2/WP4 COMPLETE** (WP3 in progress; browser validation and PR pending)

> **Scope expanded 2026-07-29, found during Phase 3 architecture.**
> **MeshCore sources have no Node Display settings UI at all.** `SettingsTab`
> mounts in exactly two places — `GlobalSettingsPage.tsx:89` (`mode="global"`)
> and `App.tsx:3640` (`mode="source"`, the *Meshtastic* source route). A MeshCore
> source renders `MeshCorePage`, which never renders `SettingsTab`.
>
> This is literally what #4412 asks for: *"set up Node Display menu for the
> map/list based on last advert time, same as for Meshtastic."* So Phase 4 must
> **add the settings surface**, not merely apply a filter behind one. Phase 3
> implements and unit-tests a `SettingsTab` hide-branch for `localStatsIntervalMinutes`
> and `nodeHopsCalculation`, gated on the assumption that Phase 4 would route
> MeshCore sources into `SettingsTab` to give that branch somewhere to run.
>
> **That assumption was wrong, and Phase 4 retired the branch instead of
> mounting it (WP4/D1/D2).** The Phase 4 settings surface is a purpose-built
> `MeshCoreNodeDisplaySection` composed into `MeshCorePage`, not a `SettingsTab`
> mount — `SettingsTab` still never renders under a MeshCore route, so
> `sourceType === 'meshcore'` stayed permanently unreachable inside it and the
> hide-branch's two tests were passing vacuously (they rendered `SettingsTab`
> inside a `<SourceProvider sourceType="meshcore">` that no real route ever
> constructs). Phase 4 deleted the branch and those two tests rather than
> leaving them as dead code implying coverage that did not exist. **Do not
> restore this branch on the theory that coverage was lost** — the replacement
> is `MeshCoreNodeDisplaySection.test.tsx`, which asserts the actual
> requirement directly: the four Node Display keys with a MeshCore consumer
> render on a MeshCore source, and the six without one do not.

**Work:**
- **Add the Node Display settings surface to MeshCore sources** (the mount point
  above). Decide whether to reuse `SettingsTab` in `mode="source"` or to compose
  the section into `MeshCorePage`, and justify against the existing MeshCore
  section components.
- Apply the per-source `maxNodeAgeHours` to `MeshCoreNodesView.tsx` and
  `MeshCoreMap.tsx` using a shared ms/s normalization helper.
- Favorites bypass at parity with Meshtastic (`useProcessedNodes` semantics).
- Decide and document the interaction with the separate, independently-stored
  `MeshCorePathfindingFilterSection` `lastHeardEnabled`/`lastHeardHours` filter
  (default `false` / 168h).

**Exit criteria:** full suite green; browser validation on a MeshCore source
showing the age filter taking effect on both the node list and the map; #4412
closable.

### [ ] Phase 5 — Close the follow-up defects this epic uncovered

Added 2026-07-29 at the user's direction: the issues filed along the way get
addressed, not left orphaned. All four are pre-existing and independent of
Phases 1-4 — verified that none of them becomes reachable *through* this epic's
changes, which is why they were not folded into earlier phases.

**Work:**
- **#4419 (a)** — `settingsRoutes.ts:312-313` compares a per-source save against
  the *global* current value (`currentSettings` holds bare, un-prefixed keys).
  Affects `autoAckEnabled` / `autoAckRegex` — both already per-source — so
  change-detection is wrong in both directions when a source overrides the
  global. Copy the prefixed-lookup pattern from `auditSettingsWrite`, which
  already does this correctly. Audit for any other `currentSettings.<key>` read
  reachable from the per-source branch.
- **#4419 (b)** — `getSourceSettings` is an O(total settings) full-table scan
  (`getAllSettings()` + JS filter). Migration 131 made the table grow as
  keys × sources. Replace with a prefix-scoped query. **Reuse the dialect
  branching from `deleteSourceSettings`** — MySQL's default backslash-escape mode
  needs two literal backslashes in the `ESCAPE` literal where SQLite and
  PostgreSQL need exactly one.
- **Migration 050 replay bug** — it imports `PER_SOURCE_SETTINGS_KEYS`, so fresh
  installs (which replay every migration) run it against whatever that array
  holds *today*, not what it held when 050 was written. Phase 1's migration 131
  froze its own list to avoid this; 050 needs the same treatment. Note the
  array has already grown by 9 keys this epic, so the drift is live.
- **`externalUrl` orphan** — read by `securityDigestService.ts:332`, written
  nowhere. Decide: wire up a writer, or delete the read. **Do not** "fix" it by
  adding the key to `VALID_SETTINGS_KEYS` — that silently creates a new
  user-writable setting, which is a product decision, not a cleanup.

**Exit criteria:** full suite green across all three backends; a `*.perSource.test.ts`
proving the change-detection fix; a test proving `getSourceSettings` issues one
scoped query rather than reading the whole table; #4419 closable.

### [ ] Phase 6 — Reconcile the two `SOURCEY_RESOURCES` lists (#4416)

**Breaking change — needs a user decision before implementation starts.**

See "Blocked: bug #4" below for the full analysis. Summary: `src/types/permission.ts`
(the live list) omits `settings`, `dashboard`, `info`, `audit`, and `security`;
`src/server/constants/permissions.ts` includes them but its helper is dead code.
So `checkPermissionAsync` discards the `sourceId` for all five, and a
source-A-scoped grant authorizes source-B writes.

**Decisions required from the user first:**
1. Which of the five resources should genuinely be per-source? (`settings` is the
   one this epic cares about; the other four are collateral.)
2. Existing grants are stored `sourceId = NULL`. For any resource that becomes
   sourcey, the migration must re-grant per source or **every non-admin user
   loses access to it**. Confirm that migration strategy is acceptable.

**Work (after those decisions):** delete one of the two lists so they cannot drift
again; migration re-granting existing `sourceId = NULL` rows; `userRoutes.ts`
PUT validation; `UsersTab.tsx` grouping (sourcey and global grants render in
different sections).

**Exit criteria:** full suite green; a test proving a source-A-scoped
`settings:write` grant is rejected on source B; an upgrade test proving existing
grants survive the migration; #4416 closable.

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

### Phase 4
- **D1 — settings surface composed as a section, not a `SettingsTab` mount.**
  `MeshCoreNodeDisplaySection` renders inside `MeshCoreSettingsView`, reusing
  the same per-source `/api/settings?sourceId=` endpoints Phases 1–3 built.
  Rejected mounting `SettingsTab` in `mode="source"` under a MeshCore route:
  it takes ~50 required props (23 values + 24 `onXxxChange` callbacks) that
  `MeshCorePage` doesn't own, and `SOURCE_SECTIONS` includes five
  Meshtastic-only groups (firmware update, packet monitor, telemetry, solar,
  sorting) that would need a third `mode` and a materially larger hide
  surface than Phase 3's two-field branch.
- **D2 — the Phase 3 `isMeshCoreSource` hide-branch in `SettingsTab.tsx` was
  deleted, not kept as dead code (WP4).** Because D1 never routes a MeshCore
  source through `SettingsTab`, the branch was unreachable by construction
  and its two tests in `SettingsTab.nodeDisplay.perSource.test.tsx`
  ("MeshCore hide-branch") were passing vacuously — they rendered
  `SettingsTab` inside a `<SourceProvider sourceType="meshcore">` no real
  route ever constructs, and would still pass if the MeshCore surface showed
  every Meshtastic-only knob. Replacement coverage is
  `MeshCoreNodeDisplaySection.test.tsx` (WP2, 10 tests — confirmed green
  before the branch was deleted), which asserts the requirement directly:
  the four MeshCore-relevant keys render, the six others don't. The "Scope
  expanded" callout in the Phase 4 heading above was corrected in the same
  commit — it previously said this mount point "makes the hide-branch live,"
  written on the assumption (wrong per D1) that Phase 4 would mount
  `SettingsTab`.
- **D3 — the MeshCore section exposes 4 of the 10 Node Display keys**,
  determined by which keys have a MeshCore consumer in the tree:
  `maxNodeAgeHours` (this phase's filter) plus the inactive-node trio
  `inactiveNodeThresholdHours` / `inactiveNodeCheckIntervalMinutes` /
  `inactiveNodeCooldownHours` (`inactiveNodeNotificationService.ts` already
  branches on `manager.sourceType === 'meshcore'`). **Latent bug exposed:**
  those three inactive-node keys have driven MeshCore alerts server-side with
  **no UI** to configure them on a MeshCore source since the notification
  service learned about MeshCore — a MeshCore-only operator could not set
  them at all before this phase. The other six keys
  (`localStatsIntervalMinutes`, `nodeHopsCalculation`, `hideIncompleteNodes`,
  the dimming trio) have no MeshCore consumer and are excluded.
- **D5 — the two MeshCore age filters are independent, not unified or
  subordinate.** `maxNodeAgeHours` (Settings → Node Display, client-side view
  filter) and `MeshCorePathfindingFilterSection`'s `lastHeardEnabled` /
  `lastHeardHours` (Automations → Target Filter, server-side scheduler target
  selector) stay separately stored with separately-ranged inputs (1–168h vs.
  1–8760h) and separate permission resources (`settings:write` vs.
  `automation:write`). Unifying or nesting them would let a change on one
  screen silently move behavior on the other. Both surfaces gained a
  one-line cross-reference to the other so the independence is legible.
- **`mergeNodesAndContacts` behaviour change (D4, WP1/WP3).** The two raw
  `c.lastSeen` reads in `MeshCoreNodesView.tsx` are replaced with the shared
  `meshcoreLastHeardMs(c)` helper from `src/utils/meshcoreAge.ts` (WP1), so a
  `MergedRow.lastHeard` now also falls back to `lastAdvert * 1000` when
  `lastSeen` is absent — previously a contact with only `lastAdvert` resolved
  to no usable timestamp. This is a real fix, not a no-op: without it, a
  contact that has only ever advertised (never produced a live `lastSeen`)
  would be invisible to the new age filter regardless of how recent its
  advert was.
- **State at WP4 time:** WP1 (`71aa9053`) and WP2 (`51d601b9`) were committed
  and green on this branch; WP3 (the `MeshCoreNodesView`/`MeshCoreMap` filter
  application, §3.4) was still in progress with uncommitted work in this
  shared worktree when WP4 ran. WP4 was scoped to `SettingsTab.tsx`,
  `SettingsTab.nodeDisplay.perSource.test.tsx`, and this doc only, per the
  file-ownership table, and did not touch or wait on WP3's files. The Phase 4
  checkbox above is ticked per this package's explicit instruction; full
  Phase 4 exit criteria (browser validation on a live MeshCore source, PR)
  remain pending WP3 and are not implied by this entry.

### Phase 3
- **Browser-validated** against two live Meshtastic sources (Sandbox / BLESandbox) on the
  deployed worktree build. Evidence:
  - `POST /api/settings?sourceId=A {maxNodeAgeHours:72}` and `…?sourceId=B {…:2}` →
    reads back A=72, B=2, **global still 24**. No leak to sibling or global.
  - Narrowing A to 1h took its rendered node list from **262 rows → 99**; B, untouched at
    its own value, was unaffected.
  - localStorage is namespaced `nodeDisplay:{sourceId}:{key}` (9 keys per source), and the
    legacy bare `maxNodeAgeHours` key reads **null** — the live confirmation of the
    assertion WP2 rewrote its two `SettingsContext` tests to make.
  - All 10 settings render on the per-source Settings page with that source's own values.
  - Only console error is a pre-existing 404 for `locales/en-US.json` (i18n probing a
    region locale before falling back to `en.json`). Unrelated.
- **`activeWindowConfig.ts` was deleted, not source-keyed** (D2). One reader, one writer; a
  keyed registry would be stale for any source whose provider had not mounted this
  page-load, and Map Analysis is often the first page loaded.
- **`App.tsx` had a second settings loader** duplicating `SettingsContext.loadServerSettings`
  — both wrote the same four states, last-writer-wins, and App's `[]` deps meant a stale
  mount-time value could win *after* a source switch. Deleted; `SettingsContext` is sole owner.
- **Removing `showIncompleteNodes` from `UIContext` was not self-contained.** Three
  consumers (`NodeFilterPopup`, `NodesTab`, `SettingsTab`) still read it and the build
  broke. Two belong to later work packages — the file-ownership table prevents *concurrent*
  edits but does not make a context-field removal atomic. Worth remembering when planning a
  phase around shared state.
- **Canonical setter only.** `hideIncompleteNodes` is the stored key, `showIncompleteNodes`
  a derived read, `setHideIncompleteNodes` the only setter. No inverted alias was added —
  one piece of state with two opposite-polarity setters is a bug waiting to happen.
- **A fourth bug-pinning test found and removed.** `database.extended.test.ts` re-implemented
  the *pre-Phase-2 global read* (`parseInt(getSetting('maxNodeAgeHours') || '24')`) and
  asserted against its own copy. Replacement: `database.maxNodeAge.perSource.test.ts`.
- **`server.settings-persistence.test.ts` now executes the real partition source.** The
  `const settings = {…}` literal survives the save split intact, so dropping a key from the
  *scoped* POST would have passed silently. Rather than re-implement the partition in the
  test (the exact mistake behind the other four), it extracts and runs the production source
  against `NODE_DISPLAY_SETTING_KEYS`, asserting by count **and** name; a regex miss throws a
  named diagnostic. Mutation-tested: dropping one key fails all three assertions.
- **`SettingsTab.elevation.test.tsx`'s `useSettings` mock had to become stable** — the same
  constraint its `useUI` mock already documents, inherited because the setter changed
  contexts. A fresh `vi.fn()` per render re-runs the settings-load effect and clobbers
  in-test edits.
- **Parallel full-suite runs corrupt the shared MySQL test schema.** An agent's concurrent
  vitest invocations produced spurious failures in files it never touched. Run one at a time.

### Phase 2
- **Defaults live in two modules, not one.** `src/constants/nodeDisplayDefaults.ts` holds
  the values (isomorphic, zero imports) so Phase 3 can consume the same runtime values on
  the frontend — `src/server/constants/settings.ts` was rejected because the frontend
  imports only `type` from `src/server/**`. The accessor
  (`src/server/services/nodeDisplaySettings.ts`) uses reader injection copying the
  `ManagerSettingsDb` pattern; it must **not** import `databaseService`, which would cycle.
- **`getSettingForSources(ids, key)` added** — one indexed `IN()` lookup. Converting the
  `unifiedRoutes` dashboard fan-out (one read broadcast to every source) would otherwise
  have become an N+1 on a hot path. Deliberately not built on `getSourceSettings`, which is
  a full-table scan (#4419).
- **Two tests were pinning bugs rather than catching them**, both deleted/rewritten:
  - `server.neighbor-info-position.test.ts` re-implemented the neighbor-info route body
    inside the test, *including* the dead `'maxNodeAge'` key. It passed while the route was
    broken. Deleted; real-router coverage now lives in `neighborInfoRoutes.test.ts`
    (harness-based) and `nodeEnhancer.position-override.test.ts`.
  - `inactiveNodeNotificationService.test.ts` asserted "no eligible users does not advance
    nextRunAt — the source is retried on the very next tick", which pinned the regression
    below as intended behavior.
- **Regression found in review and fixed** (`707a6d87`): the restructured scheduler's
  zero-users branch left every due source permanently due, turning an hourly query into a
  per-60s poll — and zero-users is the DEFAULT state on a fresh install. Same failure class
  as #4399/#4413. The whole suite passed with the bug present; nothing tested cadence. Fixed
  by advancing `nextRunAt` per source in that branch, plus a fake-timer test asserting one
  query across five ticks.
- **Three `database.ts` methods were reading the global value despite already having
  `sourceId` threaded through from every caller** (`getNodeNeedingTracerouteAsync`,
  `getNodesNeedingRemoteLocalStatsAsync`, `getNodeNeedingRemoteAdminCheckAsync`). The
  plumbing existed and was unused.
- **Open question resolved by the user:** sources created after migration 131 get the
  hardcoded defaults. No seeding in the source-creation path. This is why centralizing the
  defaults mattered — otherwise `24` would have scattered across a dozen read sites.

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
