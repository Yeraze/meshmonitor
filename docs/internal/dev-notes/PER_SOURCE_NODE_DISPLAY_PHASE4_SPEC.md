# Per-source Node Display — Phase 4 implementation spec

**Epic:** `PER_SOURCE_NODE_DISPLAY_EPIC.md`
**Closes:** #4412 — *"Can you set up Node Display menu for the map/list based on last advert time, same as for Meshtastic?"* (kokoshell)
**Branch / worktree:** `feature/meshcore-node-age-filter` in `/home/yeraze/Development/meshmonitor-meshcore-age`, based on `origin/main` @ `17264405` (Phase 3 merged).
**Status:** spec only — nothing implemented.

Phase 4 has two deliverables:

1. **The settings surface.** MeshCore sources have *no* Node Display UI at all today.
2. **The filter.** `MeshCoreNodesView` and `MeshCoreMap` apply no age filter whatsoever.

Both were verified in this worktree, not taken on faith:

- `SettingsTab` is referenced from exactly two mount sites — `src/pages/GlobalSettingsPage.tsx:89`
  (`mode="global"`) and `src/App.tsx` `/source/:id/settings` (`mode="source"`).
- `src/main.tsx:86` routes `source?.type === 'meshcore'` to `MeshCoreSourcePage` → `MeshCorePage`,
  which never renders `SettingsTab`. `App.tsx`'s settings route is therefore unreachable for a
  MeshCore source, and `SettingsTab`'s `isMeshCoreSource` branch (`SettingsTab.tsx:366`, used once
  at `:2015`) is dead code.
- `grep -rn 'maxNodeAge' src/components/MeshCore/` returns nothing.

---

## 1. Reuse inventory (read this before writing a single line)

Everything below **already exists** and MUST be used or extended. Phase 4 adds exactly **two new
source files** (`src/utils/meshcoreAge.ts` and `src/components/MeshCore/MeshCoreNodeDisplaySection.tsx`)
plus their tests. Anything else you feel like creating is a design error — re-read this section.

### 1.1 Settings plumbing (Phases 1–3 — do not rebuild any of it)

| Thing | Path | How Phase 4 uses it |
|---|---|---|
| Defaults / ranges / parsers | `src/constants/nodeDisplayDefaults.ts` | `NODE_DISPLAY_NUMERIC_DEFAULTS`, `NODE_DISPLAY_RANGES`, `parseNodeDisplayNumber`, type `NodeDisplaySettingKey`. **Never re-declare a default or a range literal.** The `min`/`max` on every new `<input type="number">` comes from `NODE_DISPLAY_RANGES`, not from a hand-typed number. |
| Per-source read hook | `src/hooks/useNodeDisplaySettings.ts` | `useNodeDisplaySettings(sourceId)` is the **only** read path for `maxNodeAgeHours` in MeshCore surfaces. Extended (WP2) to also export `nodeDisplaySettingsQueryKey`. |
| Namespaced localStorage | `src/utils/nodeDisplayStorage.ts` | `writeNodeDisplayLocal(sourceId, key, value)` after a successful save, so `SettingsContext`'s cached copy can't go stale between page loads. |
| Source query fragment | `src/hooks/useSourceQuery.ts` | Not used directly by the new section (it already has an explicit `sourceId` prop) — but the URL shape it produces (`?sourceId=<encoded>`) is the contract to match. |
| Settings API | `src/server/routes/settingsRoutes.ts` — `GET /` (`:236`) and `POST /` (`:278`, `requirePermission('settings','write',{ sourceIdFrom:'query' })`) | **No new route.** The MeshCore section reads and writes the same per-source `/api/settings?sourceId=` endpoints Phase 1 built. |
| Migration 131 seed | `src/server/migrations/131_seed_per_source_node_display.ts` | Nothing to do — MeshCore sources already have seeded rows. |

### 1.2 MeshCore section idiom (copy this shape exactly)

| Thing | Path | Notes |
|---|---|---|
| Reference section | `src/components/MeshCore/MeshCoreAutoAckSection.tsx` | Canonical `settings + initial + hasChanges + isSaving` + `useSaveBar` + `useCsrfFetch` + `useToast` + `useAuth().hasPermission` shape. `MeshCoreNodeDisplaySection` is this component's structure with a different body and a different endpoint. |
| Second reference | `src/components/MeshCore/MeshCorePathfindingFilterSection.tsx` | Same shape, plus the ambient-`SaveBarGroup` comment worth mirroring. |
| Save bar | `src/hooks/useSaveBar.ts`, `src/contexts/SaveBarContext.tsx` (`SaveBarProvider`, `SaveBarGroup`, `useSaveBarGroup`), `src/components/SaveBar.tsx` | The settings view gets its own group (`id="meshcore-settings"`), mounted the same way `MeshCorePage.tsx:186-195` mounts `id="meshcore-automation"`. |
| Settings CSS | `src/styles/settings.css` — `.settings-section`, `.setting-item`, `.setting-input`, `.setting-description` | **Already imported by `MeshCorePage.tsx`.** No new stylesheet, no additions to `src/styles/nodes.css` (frozen; cascade trap). No CSS module needed — the section reuses existing shared classes plus `MeshCoreSettingsView`'s `.form-section` / `<h3>` wrapper. |
| Settings view host | `src/components/MeshCore/MeshCoreSettingsView.tsx` | Already a stack of `<div className="form-section"><h3>…</h3>…</div>` blocks (Connection, Device actions, Discover nodes, Default region/scope, Saved regions, Local node, Message data). The new section becomes one more block. |
| Icons | `src/components/icons` `UiIcon` | Only if a section needs an icon. **No hardcoded emoji.** |

### 1.3 Filter primitives

| Thing | Path | Notes |
|---|---|---|
| Parity reference | `src/hooks/useProcessedNodes.ts:181-197` | The Meshtastic semantics Phase 4 must match: cutoff = `now − maxNodeAgeHours`, **favorites bypass the cutoff**, nodes with no `lastHeard` are excluded. Read it; do not re-derive it. |
| Row reconciliation | `mergeNodesAndContacts()` in `src/components/MeshCore/MeshCoreNodesView.tsx` | Already merges `MeshCoreNode` (has `lastHeard` ms + `isFavorite`) with `MeshCoreContact` (has `lastSeen` ms + `lastAdvert` s) keyed by `publicKey`. Extended, not replaced. |
| Authoritative ms/s rule | `src/server/meshcoreManager.ts:456-465` (`filterPathfindingContacts`) | "prefer `lastSeen` (ms); fall back to `lastAdvert` (s → ms)". WP1 lifts this into the shared helper and points the manager at it. |
| Second copy of the same rule | `src/components/MeshCore/MeshCorePathfindingFilterSection.tsx:296-313` | Third copy: `MeshCoreContactDetailPanel.tsx:904-905` (`lastAdvert < 1e12 ? *1000 : v`). All three collapse onto the shared helper in WP1. |
| DB unit contract | `src/db/repositories/meshcore.ts:727-737` | The authoritative comment: `meshcore_nodes.lastHeard` is **milliseconds**; Meshtastic `nodes.lastHeard` is **seconds**. |
| Map shell | `src/components/map/BaseMap.tsx`, `src/components/map/layers/NodeMarkersLayer.tsx` | **Already composed by `MeshCoreMap`.** Nothing to change here — see §3.4 for why the filter does not live in the map. |
| Considered and rejected | `src/utils/mapAge.ts` `effectiveMapMaxAgeHours` | Reconciles a *Map Features age slider* against the settings max. `MeshCoreMap` has no such slider, so there is nothing to reconcile. Do **not** import it; do **not** add a slider in this phase. |

### 1.4 i18n — all four labels already exist, reuse verbatim

From `public/locales/en.json` (flat keys):

```
settings.node_display                             "Node Display"
settings.max_node_age_label                       "Maximum Age of Active Nodes (hours)"
settings.max_node_age_description                 "Nodes older than this will not appear in the Node List"
settings.inactive_node_threshold_label            …
settings.inactive_node_threshold_description      …
settings.inactive_node_check_interval_label       …
settings.inactive_node_check_interval_description …
settings.inactive_node_cooldown_label             …
settings.inactive_node_cooldown_description       …
```

Only **two** new keys are added (§4.3), both with inline English fallbacks per the MeshCore
component convention (`t(key, 'fallback')`).

### 1.5 Test utilities

| Thing | Path | Notes |
|---|---|---|
| Route harness | `src/server/test-helpers/routeTestApp.ts` `createRouteTestApp` | Phase 4 adds **no routes**, so no new route test is required. If a WP ends up touching a route (it should not), the harness is mandatory. |
| Existing route coverage | `src/server/routes/settingsRoutes*.test.ts`, `src/server/server.settings-persistence.test.ts` | Already pin the per-source GET/POST contract the new section uses. Must stay green untouched — they are the proof that WP2 needs no server change. |
| Pathfinding behavioural pin | `src/server/meshcoreManager.pathfindingFilter.test.ts`, `src/server/routes/meshcoreRoutes.pathfindingFilter.test.ts` | The before/after pin for WP1's refactor. Green before *and* after ⇒ refactor is a no-op. |

---

## 2. Decisions

### D1 — Settings surface: compose a dedicated section into `MeshCorePage`. Do **not** mount `SettingsTab`.

**Decision:** add `src/components/MeshCore/MeshCoreNodeDisplaySection.tsx`, rendered inside
`MeshCoreSettingsView` (the existing MeshCore **Settings** sub-view), persisting through the
existing per-source `/api/settings?sourceId=` endpoints.

**Why not `SettingsTab mode="source"`:**

1. **Prop surface.** `SettingsTab` takes ~50 required props (23 values + 24 `onXxxChange`
   callbacks) that `App.tsx` supplies from its own state. `MeshCorePage` owns none of it. Mounting
   it means either lifting ~50 pieces of Meshtastic app state into the MeshCore page or passing
   ~24 no-op callbacks — a fake seam that type-checks and lies.
2. **Section surface.** `SOURCE_SECTIONS` (`SettingsTab.tsx:240-244`) is
   `settings-sorting`, `settings-node-display`, `settings-telemetry`, `settings-notifications`,
   `settings-packet-monitor`, `settings-solar`, `settings-firmware`, `settings-reset-ui`,
   `settings-management`, `settings-danger`. On a MeshCore source, *firmware update* (Meshtastic
   device firmware), *packet monitor* (the Meshtastic `packet_log` settings — MeshCore has its own
   `meshcore_packet_log` UI at `MeshCorePacketMonitorView`), *telemetry*, *solar*, and *sorting*
   are all wrong or duplicated. Making this safe needs a third `mode` and a much larger hide
   surface than Phase 3's two fields — strictly more invasive than a purpose-built section.
3. **Navigation.** MeshCore already has a *Settings* destination in `MeshCoreSubToolbar`
   (`view === 'settings'`). Mounting `SettingsTab` there gives a MeshCore user two visually
   different settings screens in one product. Composing a section gives them one.
4. **Precedent.** Every per-source MeshCore setting today is a section component inside a MeshCore
   view (`MeshCoreAutoAckSection`, `MeshCorePathfindingFilterSection`, `MeshCoreChannelsConfigSection`, …).
   Phase 4 follows the pattern the codebase already established rather than importing a foreign one.

**What the section does reuse from the Meshtastic path:** the constants module, the read hook, the
localStorage helper, the i18n keys, the settings CSS classes, and — critically — **the same
`/api/settings?sourceId=` endpoints**. Those MeshCore sections that use dedicated
`/api/sources/:id/meshcore/*` routes do so because their payloads are MeshCore-specific
(`autoack`, `pathfinding`). The Node Display keys are **not** MeshCore-specific; they are the same
ten rows in the same `settings` table that Phases 1–3 made per-source. Inventing a
`/api/sources/:id/meshcore/node-display` route would fork the storage of one setting across two
endpoints — the exact drift Phase 6 (#4416) exists to clean up. So: MeshCore-shaped **UI**,
shared **storage**.

**Consequence — see D2.**

### D2 — Retire `SettingsTab`'s `isMeshCoreSource` hide-branch — **RULED: delete** (coordinator, see R1)

The epic's Phase 4 note says the mount point "makes [the Phase 3 hide-branch] live". D1 means it
does not: with `SettingsTab` never mounting under a MeshCore route, `sourceType === 'meshcore'` is
unreachable inside it, `isMeshCoreSource` is permanently `false`, and the `{!isMeshCoreSource && …}`
wrapper at `SettingsTab.tsx:2015` is dead.

**Decision: delete the branch and its two tests** (WP4), replacing coverage with a test on the
surface MeshCore users actually reach. **Ruled and approved by the phase coordinator**, who
confirmed the contradicting epic-doc note was written under the assumption that Phase 4 would mount
`SettingsTab`, and is itself wrong. WP4 therefore **corrects that note** rather than working around
it — see §3.13.

Rationale — this is the epic's recurring failure mode, not a style preference. The existing tests
render `SettingsTab` inside a `<SourceProvider sourceType="meshcore">` that no route ever
constructs, and assert an internal conditional. They pass today, they will pass forever, and they
would **still pass if the MeshCore Node Display surface displayed every Meshtastic-only knob** —
because they do not touch that surface. That is test-asserts-implementation, finding #5 for this
epic. Replacement coverage (`MeshCoreNodeDisplaySection.test.tsx`) asserts the *requirement*:
"the MeshCore Node Display section shows exactly the four keys that mean something on MeshCore and
none of the six that do not."

Dead code plus a test that passes vacuously is strictly worse than no code: it implies coverage that
does not exist. The "leave it as harmless dead code" fallback in the spec's first draft was
**withdrawn by the coordinator** — do not take it. Equally, do **not** manufacture a MeshCore
`SettingsTab` mount purely to keep the branch alive.

### D3 — Which of the ten keys the MeshCore section exposes

Determined by *which keys have a MeshCore consumer*, checked in the tree:

| Key | MeshCore consumer? | In section? |
|---|---|---|
| `maxNodeAgeHours` | **Yes** — this phase's filter (list + map) | ✅ |
| `inactiveNodeThresholdHours` | **Yes** — `inactiveNodeNotificationService.ts:266` branches `manager.sourceType === 'meshcore'` → `databaseService.meshcore.getInactiveMeshcoreNodes(sourceId, cutoffMs)` (`:386`) | ✅ |
| `inactiveNodeCheckIntervalMinutes` | **Yes** — same scheduler | ✅ |
| `inactiveNodeCooldownHours` | **Yes** — same scheduler | ✅ |
| `localStatsIntervalMinutes` | No — Meshtastic local-stats poller | ❌ |
| `nodeHopsCalculation` | No — Meshtastic hop derivation | ❌ |
| `hideIncompleteNodes` | No — only `NodesTab.tsx` / `SettingsContext` | ❌ |
| `nodeDimmingEnabled` | No — only `NodesTab.tsx:485,1590` | ❌ |
| `nodeDimmingStartHours` | No | ❌ |
| `nodeDimmingMinOpacity` | No | ❌ |

**Note this is a bug fix on top of a feature.** The three inactive-node keys already drive MeshCore
alerts server-side and have had **no UI on a MeshCore source since that service learned about
MeshCore.** A MeshCore-only operator could not configure them at all. Mention this in the PR body.

### D4 — Filter on the reconciled `lastHeard`; one shared ms/s helper

Per the interview decision recorded in the epic. `meshcore_nodes.lastHeard` is written by
`meshcoreManager` under the rule "prefer `contact.lastSeen`, fall back to `lastAdvert * 1000`"
(`meshcoreManager.ts:459-462`), so it is the already-reconciled value. **No `lastAdvert` column is
added.**

The frontend still sees raw `MeshCoreContact` rows carrying `lastSeen`/`lastAdvert`, so the
normalization exists client-side too — today in **three** hand-rolled copies. WP1 collapses all
three onto `src/utils/meshcoreAge.ts`. No `* 1000` at any call site after Phase 4.

### D5 — The two age filters are **independent**, and say so in the UI

`MeshCorePathfindingFilterSection`'s `lastHeardEnabled` / `lastHeardHours` (default `false` /
`168`, range 1–8760, stored via `POST /api/sources/:id/meshcore/automation/pathfinding`) is a
**server-side automation target selector**: which contacts the auto-pathfinding scheduler will
probe. `maxNodeAgeHours` (default `24`, range 1–168, stored in `settings` per-source) is a
**client-side view filter**: which nodes the operator sees on the Nodes list and map.

**Independent** — chosen over the two alternatives:

- *Unified* (one value drives both) would make lowering the display filter to 6h silently stop the
  pathfinder from probing anything older, and raising the pathfinder window to its 8760h maximum
  flood the map with a year of stale nodes. Different jobs, incompatible useful ranges (168 vs
  8760), different storage, different permission resources (`settings:write` vs
  `automation:write`), different screens.
- *Subordinate* (pathfinding pool ⊆ visible nodes) has the same failure — a view preference on the
  Settings screen would silently narrow a scheduler on the Automations screen, across a boundary no
  user would guess.

Independence is only defensible if it is legible, so both descriptions gain a one-line
cross-reference (§4.3). The two are also visibly separated: Node Display lives in **Settings**, the
target filter in **Automations → Target Filter**.

### D6 — Favorites (and the local node) bypass the cutoff

Parity with `useProcessedNodes.ts:194`. `MeshCoreNode.isFavorite` already exists (#3588) and
`mergeNodesAndContacts` already carries it onto `MergedRow`. Additionally the local node
(`advName` containing `'(local)'`, the same marker `MeshCoreMap.tsx:322` and
`meshcoreHelpers.mapContactsToNodes` use) is exempt — it is the operator's own device and its
disappearance would break the map's centering and the polar-grid origin. Nodes with **no**
resolvable timestamp are excluded, matching `if (!node.lastHeard) return false`.

---

## 3. File-by-file changes

### 3.1 NEW `src/utils/meshcoreAge.ts`

Isomorphic (imported by both `src/server/**` and `src/components/**`), zero non-type imports —
same discipline as `src/utils/meshcorePath.ts`, which `meshcoreManager.ts:43` already imports.

```ts
/**
 * MeshCore timestamp normalization (#4412 Phase 4).
 *
 * Three different MeshCore time fields, two different units:
 *   meshcore_nodes.lastHeard   epoch MILLISECONDS  (reconciled server-side by
 *                              meshcoreManager: prefer contact.lastSeen, else
 *                              lastAdvert * 1000 — see meshcoreManager.ts:459)
 *   MeshCoreContact.lastSeen   epoch MILLISECONDS
 *   MeshCoreContact.lastAdvert epoch SECONDS       (firmware `last_advert`)
 *
 * Meshtastic `nodes.lastHeard` is SECONDS. Do not mix the two — see
 * src/db/repositories/meshcore.ts:727-737.
 *
 * This module is the ONLY place MeshCore seconds become milliseconds. No
 * `* 1000` at any call site.
 */

/** Any row that can answer "when was this last heard?". All fields optional. */
export interface MeshCoreAgeSource {
  /** epoch ms — meshcore_nodes.lastHeard / MergedRow.lastHeard */
  lastHeard?: number | null;
  /** epoch ms — MeshCoreContact.lastSeen */
  lastSeen?: number | null;
  /** epoch s — MeshCoreContact.lastAdvert */
  lastAdvert?: number | null;
}

/**
 * A `lastAdvert` at or above this magnitude is already milliseconds, not
 * seconds (1e12 s ≈ year 33658 — unreachable as a real seconds value), so the
 * guard can only ever rescue a mislabelled ms value and never corrupts a
 * legitimate seconds one. Precedent: MeshCoreContactDetailPanel.tsx:904-905.
 */
const LAST_ADVERT_MS_THRESHOLD = 1e12;

/**
 * Resolve a row's last-heard instant in epoch MILLISECONDS, or null when the
 * row has never been heard.
 *
 * Precedence — lastHeard, then lastSeen, then lastAdvert — deliberately
 * matches meshcoreManager.ts:459-462 with `lastHeard` (the already-reconciled
 * DB value) prepended, so a MergedRow and a raw contact resolve identically.
 */
export function meshcoreLastHeardMs(row: MeshCoreAgeSource): number | null;

/** `nowMs - maxAgeHours * 3600_000`. `nowMs` injectable for fake-timer tests. */
export function meshcoreAgeCutoffMs(maxAgeHours: number, nowMs?: number): number;

/**
 * True when the row was heard at or after `cutoffMs`. A row with no
 * resolvable timestamp is FALSE — parity with useProcessedNodes.ts:195
 * (`if (!node.lastHeard) return false`). Callers apply their own favorite /
 * local-node exemptions BEFORE calling this, not inside it.
 */
export function isWithinMeshcoreAge(row: MeshCoreAgeSource, cutoffMs: number): boolean;
```

Implementation notes:
- `meshcoreLastHeardMs` treats `0` as "unknown" (falsy), matching `useProcessedNodes`' `!node.lastHeard`.
- No clamping of `maxAgeHours` — callers get it from `useNodeDisplaySettings`, which already
  clamped through `parseNodeDisplayNumber` + `NODE_DISPLAY_RANGES.maxNodeAgeHours` (1–168).

### 3.2 NEW `src/components/MeshCore/MeshCoreNodeDisplaySection.tsx`

Structural clone of `MeshCoreAutoAckSection.tsx` (state/initial/hasChanges/isSaving + `useSaveBar` +
`useCsrfFetch` + `useToast` + `useAuth`), with the four D3 fields.

```ts
interface MeshCoreNodeDisplaySectionProps {
  /** App base URL (appBasename), as every other MeshCore section takes it. */
  baseUrl: string;
  /** Source UUID — scopes GET/POST to /api/settings?sourceId=<id>. */
  sourceId: string;
}

export const MeshCoreNodeDisplaySection: React.FC<MeshCoreNodeDisplaySectionProps>;
export default MeshCoreNodeDisplaySection;
```

```ts
/**
 * The four Node Display keys that have a MeshCore consumer (spec §2 D3).
 * `satisfies` binds this list to the epic's key union, so deleting a key from
 * nodeDisplayDefaults.ts breaks the build here instead of drifting silently.
 */
const MESHCORE_NODE_DISPLAY_KEYS = [
  'maxNodeAgeHours',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
] as const satisfies readonly NodeDisplaySettingKey[];

type MeshCoreNodeDisplayDraft = Record<typeof MESHCORE_NODE_DISPLAY_KEYS[number], number>;
```

Behaviour:

- **Read** — `const settings = useNodeDisplaySettings(sourceId)`. No bespoke fetch: this shares the
  TanStack cache entry with the list and map, so the section and the filter can never show
  different values. Seed `draft`/`initial` from it in an effect keyed on the four values
  (the hook returns hardcoded defaults until the query resolves; the effect re-seeds once it does —
  same re-seed discipline as `SettingsTab`'s `buildBaseline`).
- **Dirty tracking** — `hasChanges = MESHCORE_NODE_DISPLAY_KEYS.some(k => draft[k] !== initial[k])`.
  Registered with `useSaveBar({ id: 'meshcore-node-display', sectionName: t('settings.node_display'), hasChanges, isSaving, onSave, onDismiss })`.
  No explicit `group` — it inherits the ambient `<SaveBarGroup id="meshcore-settings">` added in §3.5.
- **Write** —

  ```ts
  await csrfFetch(`${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(
      MESHCORE_NODE_DISPLAY_KEYS.map(k => [k, String(draft[k])]),
    )),
  });
  ```

  Values are **strings** — the `settings` table stores strings, and `parseNodeDisplayNumber` reads
  them back. 403 → `t('automation.insufficient_permissions', 'Insufficient permissions')` toast
  (same handling as `MeshCoreAutoAckSection.tsx`); other non-`ok` → `throw` into the generic
  save-failed toast.
- **After a successful save**, in this order:
  1. `for (const k of MESHCORE_NODE_DISPLAY_KEYS) writeNodeDisplayLocal(sourceId, k, String(draft[k]))`
     — keeps `SettingsContext`'s namespaced cache from serving a stale value on the next mount.
  2. `queryClient.invalidateQueries({ queryKey: nodeDisplaySettingsQueryKey(sourceId) })` — this is
     what makes the Nodes list and map re-filter **without a page reload**. Missing this is the most
     likely functional bug in WP2; the test plan pins it.
  3. `setInitial(draft)`, success toast.
- **Permissions** — `const canWrite = hasPermission('settings', 'write', { sourceId })`. All four
  inputs get `disabled={!canWrite}`, matching `MeshCorePathfindingFilterSection`. (Caveat: per epic
  bug #4 / #4416, `settings` is absent from the live `SOURCEY_RESOURCES`, so the server currently
  evaluates this grant globally. Phase 6's problem — pass `sourceId` anyway so this site is already
  correct when Phase 6 lands.)
- **Markup** — one `<div className="form-section">` with `<h3>{t('settings.node_display')}</h3>`
  (matching `MeshCoreSettingsView`'s existing blocks), then four `.setting-item` blocks whose
  `<input id="…">` values are **the same element ids `SettingsTab` uses** (`maxNodeAge`,
  `inactiveNodeThresholdHours`, `inactiveNodeCheckIntervalMinutes`, `inactiveNodeCooldownHours`).
  Same ids ⇒ the browser-validation and test selectors are identical across both surfaces. `min` /
  `max` from `NODE_DISPLAY_RANGES[key]`, never literals. Labels/descriptions from §1.4.
- **No raw `fetch()`** (`src/components/**` ban), **no emoji**, **no `any`**.

### 3.3 NEW `src/utils/meshcoreAge.test.ts` and `src/components/MeshCore/MeshCoreNodeDisplaySection.test.tsx`

See §5.

### 3.4 `src/components/MeshCore/MeshCoreNodesView.tsx` — the filter

This is where the age filter lives, for **both** the list and the map. Justification for not
putting it inside `MeshCoreMap`:

- `MeshCoreMap` receives only `contacts: MeshCoreContact[]` (`MeshCoreMap.tsx:68`). `MeshCoreContact`
  has **no `isFavorite`** — filtering there would need a new `favoriteKeys: Set<string>` prop
  derived from `nodes`, which only `MeshCoreNodesView` holds. That is a worse seam than filtering
  once upstream.
- `MeshCoreNodesView` is `MeshCoreMap`'s **only** caller (`grep -rn 'MeshCoreMap' src --include=*.tsx`
  confirms; the other hits are comments and the unrelated `MapContext.MeshCoreMapNode` type).
- Filtering once guarantees list and map can never disagree — the failure mode a reviewer would
  most likely hunt for.
- `MeshCoreMap` keeps zero new props and zero new tests-at-risk.

**(a) `MergedRow` gains `lastAdvert`-awareness via the helper.** In `mergeNodesAndContacts`, replace
the two raw `c.lastSeen` reads with `meshcoreLastHeardMs(c)`:

```ts
// existing row
existing.lastHeard = existing.lastHeard ?? meshcoreLastHeardMs(c) ?? undefined;
// new row
lastHeard: meshcoreLastHeardMs(c) ?? undefined,
```

Intentional behaviour change, call it out in the PR: a contact carrying only `lastAdvert` (no
`lastSeen`) previously showed *no* last-heard and sorted to the bottom; it now resolves correctly.
Without this, such a contact would be silently filtered out by any age cutoff.

**(b) Read the setting.**

```ts
const { sourceId } = useSource();
const { maxNodeAgeHours } = useNodeDisplaySettings(sourceId);
```

`useSource()` resolves because `main.tsx:88` wraps `MeshCoreSourcePage` in a `SourceProvider`.
Outside a provider `sourceId` is `null`, the hook issues no request and returns the hardcoded
`24` — a safe, documented degradation (and what the existing standalone tests will see unless they
mock it; see §6).

**(c) Age-exemption predicate and the filtered row set**, inserted between `merged` and `sorted`:

```ts
/** Favorites and the operator's own node are never hidden by the age cutoff
 *  (parity with useProcessedNodes.ts:194 + spec §2 D6). */
const isAgeExempt = (r: MergedRow): boolean =>
  r.isFavorite || r.name.includes('(local)');

const aged = useMemo(() => {
  // Date.now() is read inside the memo, so the cutoff refreshes on every
  // nodes/contacts poll (`merged` changes) rather than freezing at mount —
  // the same property useProcessedNodes relies on.
  const cutoffMs = meshcoreAgeCutoffMs(maxNodeAgeHours);
  return merged.filter(r => isAgeExempt(r) || isWithinMeshcoreAge(r, cutoffMs));
}, [merged, maxNodeAgeHours]);

const sorted = useMemo(() => sortRows(aged, sortField, sortDirection), [aged, sortField, sortDirection]);
```

Order matches Meshtastic: **age → sort → search**. The existing `rows` search memo is unchanged
(it consumes `sorted`).

**(d) The map gets the same set.**

```ts
const visibleKeys = useMemo(() => new Set(aged.map(r => r.publicKey)), [aged]);
const visibleContacts = useMemo(
  () => contacts.filter(c => visibleKeys.has(c.publicKey) || c.advName?.includes('(local)')),
  [contacts, visibleKeys],
);
```

and at `MeshCoreNodesView.tsx:499-505` change `contacts={contacts}` → `contacts={visibleContacts}`.
The `(local)` clause covers a local contact with no matching `MeshCoreNode` row, which would
otherwise vanish and break the map's centering / polar-grid origin.

### 3.5 `src/components/MeshCore/MeshCorePage.tsx`

Two edits, both at the `view === 'settings'` block (`:201-208`):

```tsx
{view === 'settings' && (
  <SaveBarProvider>
    <SaveBarGroup id="meshcore-settings">
      <MeshCoreSettingsView
        status={status}
        loading={loading}
        actions={actions}
        baseUrl={baseUrl}
        sourceId={sourceId}
      />
    </SaveBarGroup>
    <SaveBar />
  </SaveBarProvider>
)}
```

Nesting is copied verbatim from the `view === 'automations'` block (`:185-195`) — `<SaveBar />`
inside the provider, outside the group. `SaveBarProvider`, `SaveBarGroup`, `SaveBar` are already
imported. No other change.

### 3.6 `src/components/MeshCore/MeshCoreSettingsView.tsx`

- `MeshCoreSettingsViewProps` gains `baseUrl: string; sourceId: string;`.
- Render `<MeshCoreNodeDisplaySection baseUrl={baseUrl} sourceId={sourceId} />` as a new
  `.form-section` block. **Placement: immediately after the "Device actions" block** (`:239-255`),
  i.e. above the companion-gated Discover / scope / regions blocks — so it is visible on every
  MeshCore device type (repeater sources hide the companion-only blocks below it) and does not
  push connection controls down.

### 3.7 `src/hooks/useNodeDisplaySettings.ts`

Single change: `export` the existing private `nodeDisplaySettingsQueryKey(sourceId)` so
`MeshCoreNodeDisplaySection` can invalidate the exact cache entry it shares with the list/map.
Do **not** duplicate the key literal at the call site.

### 3.8 `src/components/MeshCore/MeshCorePathfindingFilterSection.tsx` (WP1)

- Replace the inline normalization at `:305-313` with `meshcoreLastHeardMs(c)` +
  `isWithinMeshcoreAge`. Behaviour-identical; the long CRITICAL-unit-note comment collapses to a
  pointer at `src/utils/meshcoreAge.ts`.
- Append the D5 cross-reference to the `last_heard_enable` block's description text (new key, §4.3).

### 3.9 `src/server/meshcoreManager.ts` (WP1)

In `filterPathfindingContacts` (`:447+`), replace the inline `lastSeen ?? lastAdvert * 1000` block
with `meshcoreLastHeardMs` / `isWithinMeshcoreAge` from `'../utils/meshcoreAge.js'`. The file
already imports six sibling modules this way (`:12,13,16,41,42,43`), so no build-config concern.
Behaviour-identical; `meshcoreManager.pathfindingFilter.test.ts` is the pin.

### 3.10 `src/components/MeshCore/MeshCoreContactDetailPanel.tsx` (WP1)

Replace the `lastAdvert < 1e12 ? lastAdvert * 1000 : lastAdvert` expression (`:904-905`) with the
helper, so the magnitude guard has one home.

### 3.11 `src/components/MeshCore/MeshCoreMap.tsx` (WP3)

**Doc-only.** Add to the `contacts` prop's JSDoc:

```
 * Contacts to render. Already age-filtered by the caller
 * (MeshCoreNodesView applies the per-source `maxNodeAgeHours` with the
 * favorite / local-node exemptions before passing them down — #4412 Phase 4
 * §3.4). This component does NOT filter by age; a future second caller must
 * filter upstream too.
```

No behavioural change, no new props, no test change.

### 3.12 `src/components/SettingsTab.tsx` (WP4, per D2)

- Delete `const { sourceType } = useSource();` / `const isMeshCoreSource = …` (`:365-366`) and the
  `{!isMeshCoreSource && ( … )}` wrapper at `:2015`, unwrapping its two `.setting-item` children
  back into the section. Drop the now-unused `useSource` import **only if** nothing else in the file
  uses it (it is used by `useSourceQuery` indirectly — check before deleting the import line).
- Replace the Phase 3 comment block above `:2015` with a one-liner pointing at this spec's D1/D2 and
  stating that MeshCore sources use `MeshCoreNodeDisplaySection`, not `SettingsTab`.

### 3.13 `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` (WP4)

Two separate edits — do both.

**(a) Correct the Phase 4 note itself, do not work around it.** The "Scope expanded" callout in the
Phase 4 section currently says the new mount point "makes this branch live", written under the
assumption Phase 4 would mount `SettingsTab`. That assumption is wrong (D1). Rewrite that sentence
so it says Phase 4 **retired** the branch, and why: MeshCore sources render `MeshCorePage`
(`main.tsx:86`), Phase 4 gave them a purpose-built `MeshCoreNodeDisplaySection` instead of mounting
`SettingsTab`, so the branch was unreachable by construction and its two tests passed vacuously.
State it plainly enough that a later reader does **not** "restore" the branch believing coverage
was lost. Coordinator's instruction, verbatim intent: the note is wrong and gets fixed, not
side-stepped.

**(b) Tick Phase 4 and add its deviations-log entry:** D1 (section not `SettingsTab`, with the
prop/section counts), D2 (branch retired + the epic-doc note corrected under (a)), D3 (4-of-10
field set **and** the latent bug it exposed — the three inactive-node keys already drove MeshCore
alerts with no MeshCore UI), D5 (independent filters), and the `mergeNodesAndContacts` `lastAdvert`
behaviour change.

---

## 4. Copy changes

### 4.1 Reused verbatim
The four label/description pairs in §1.4.

### 4.2 Description override for MeshCore's max-age field
`settings.max_node_age_description` reads *"Nodes older than this will not appear in the Node List"* —
incomplete for MeshCore, where it also governs the map. The MeshCore section renders a new key
instead (below); the Meshtastic `SettingsTab` copy is untouched.

### 4.3 Two new keys (add to `public/locales/en.json`; other locales fall back to English)

```json
"meshcore.settings.node_display.max_age_description":
  "Nodes not heard within this window are hidden from the Nodes list and the map. Favorites and your own node are always shown. This does not change which nodes Auto-Pathfinding targets — see Automations → Target Filter.",

"meshcore.automation.pathfinding.filter.last_heard_description":
  "Applies only to Auto-Pathfinding targeting. It is separate from the Nodes list / map age filter in Settings → Node Display."
```

Both rendered as `<span className="setting-description">` via `t(key, '<the English text>')` so they
work before translation lands.

---

## 5. Test plan

Standard Vitest suite only — **no standalone scripts.** No new routes ⇒ no new
`createRouteTestApp()` suite (if that changes, the harness is mandatory).

### 5.1 `src/utils/meshcoreAge.test.ts` (new, WP1)

1. `lastHeard` (ms) wins over `lastSeen` and `lastAdvert`.
2. `lastSeen` (ms) used when `lastHeard` absent.
3. `lastAdvert` (s) → ms: `{ lastAdvert: 1_700_000_000 }` ⇒ `1_700_000_000_000`.
4. Magnitude guard: `{ lastAdvert: 1_700_000_000_000 }` returns the value unchanged (already ms).
5. All absent / all `null` / all `0` ⇒ `null`.
6. `meshcoreAgeCutoffMs(24, 1_000_000_000_000)` ⇒ `1_000_000_000_000 - 86_400_000`.
7. `isWithinMeshcoreAge` boundary: exactly at the cutoff ⇒ `true`; one ms before ⇒ `false`.
8. **Unit-confusion guard:** a row whose `lastSeen` is `now - 2h` **in ms** passes a 24h cutoff;
   the same numeric value interpreted as seconds would not. This is the test that fails if anyone
   reintroduces a `/1000` or `*1000`.

### 5.2 `src/components/MeshCore/MeshCoreNodeDisplaySection.test.tsx` (new, WP2)

`@vitest-environment jsdom`. Mock `useCsrfFetch`, `useToast`, `useAuth`, `react-i18next`; render
inside a real `QueryClientProvider` with `apiService.get` mocked (so `useNodeDisplaySettings` is
exercised for real, not stubbed). Capture `useSaveBar` options the way
`SettingsTab.nodeDisplay.perSource.test.tsx` does.

1. Renders exactly four number inputs, with ids `maxNodeAge`, `inactiveNodeThresholdHours`,
   `inactiveNodeCheckIntervalMinutes`, `inactiveNodeCooldownHours`.
2. **Renders none of the six Meshtastic-only keys** — asserts `localStatsIntervalMinutes`,
   `nodeHopsCalculation`, `hideIncompleteNodes`, `nodeDimmingEnabled`, `nodeDimmingStartHours`,
   `nodeDimmingMinOpacity` are absent from the DOM. *(This is the replacement for the two deleted
   `SettingsTab` hide-branch tests — see §6.)*
3. `min`/`max` on each input equal `NODE_DISPLAY_RANGES[key]` read from the constant, not literals.
4. Hydrates from `GET /api/settings?sourceId=<id>` — asserts the request URL carries the encoded
   sourceId and the inputs show the served values.
5. Editing an input flips `hasChanges`; `onSave()` clears it.
6. `onSave()` POSTs to `/api/settings?sourceId=<id>` with a body containing **exactly** the four
   keys (assert by count *and* by name against `MESHCORE_NODE_DISPLAY_KEYS`) and **string** values.
7. **Cache invalidation — MANDATORY, this test is the deliverable.** After a successful save, the
   `['settings','node-display',sourceId]` query entry is invalidated (spy on
   `queryClient.invalidateQueries`, or assert a refetch fires). Without it the list and map keep the
   old cutoff until a page reload — a "works when you check it manually, broken in normal use"
   defect that a fully green suite would otherwise not catch (R3). Coordinator ruling: this case is
   not optional and browser validation step 5 is the backstop, **not** the primary coverage. A WP2
   submission without it is incomplete regardless of the other nine cases passing.
8. `writeNodeDisplayLocal` wrote the four namespaced `nodeDisplay:{sourceId}:{key}` entries.
9. `hasPermission('settings','write')` false ⇒ all four inputs `disabled`.
10. A 403 response shows the insufficient-permissions toast and leaves `hasChanges` true.

### 5.3 `src/components/MeshCore/MeshCoreNodesView.test.tsx` (extended, WP3)

New describe: `MeshCoreNodesView — per-source age filter (#4412 Phase 4)`. Fixtures use
`Date.now()`-relative **millisecond** timestamps.

1. With `maxNodeAgeHours = 24`, a node at `now - 2h` is listed and one at `now - 72h` is not.
2. **Favorites bypass:** the `now - 72h` node with `isFavorite: true` is listed, and still pinned to
   the top.
3. **Local node bypass:** a contact whose `advName` contains `(local)` and whose `lastSeen` is
   `now - 72h` is listed.
4. **Unknown timestamp excluded:** a node with no `lastHeard` and a contact with no
   `lastSeen`/`lastAdvert` are not listed.
5. **`lastAdvert`-only contact:** `lastAdvert = (now - 2h)/1000` (seconds) is listed under a 24h
   cutoff — proves §3.4(a)'s merge change and that seconds are converted.
6. **Unit regression guard:** a node at `lastHeard = now - 2h` **in ms** survives a 24h cutoff.
   Fails loudly if the value is ever treated as seconds (which would place it in 1970 and hide it).
7. **The map receives the same filtered set.** The suite already mocks `./MeshCoreMap`; upgrade the
   mock to record its `contacts` prop, and assert the aged-out node's `publicKey` is absent while
   the favorite's is present. *This is the test that fails if a future change filters only the list.*
8. Changing the mocked `maxNodeAgeHours` from `24` to `168` re-lists the `now - 72h` node —
   proves the setting drives the filter rather than a fixed constant.
9. Search still narrows within the age-filtered set (age → sort → search order).

Existing describes in this file (sort controls, role icon, node-details, Discover, collapse toggle)
keep their assertions but need their fixtures rebased — see §6.

### 5.4 Untouched suites that must stay green

`src/server/meshcoreManager.pathfindingFilter.test.ts`,
`src/server/routes/meshcoreRoutes.pathfindingFilter.test.ts` (WP1 pin);
`src/components/MeshCore/MeshCoreContactDetailPanel.test.tsx` (WP1);
`src/components/MeshCore/MeshCoreMap.test.tsx` (WP3 — doc-only edit);
`src/server/server.settings-persistence.test.ts`, `src/server/routes/settingsRoutes*.test.ts`
(proof WP2 needed no server change); `src/hooks/useProcessedNodes.test.ts`,
`src/hooks/useNodeDisplaySettings.test.tsx`, `src/utils/nodeDisplayStorage.test.ts`.

### 5.5 Full-suite discipline

Run the whole Vitest suite (not targeted files) before the PR, with the PostgreSQL (`5433`) and
MySQL (`3307`) containers up — they are already running. Phase 4 makes **no schema, migration, or
repository change**, so the multi-backend suites should be untouched; confirm via `numPendingTests`
in the JSON reporter that they actually ran rather than silently skipped, and confirm
`success: true` (an `rtk` `FAIL (0)` line alone is not proof). Then:

```bash
npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'
```

Empty output = gate passes. Note WP4 *removes* violations (a deleted `any`-free branch), so if the
ratchet baseline shrinks, regenerate with `npm run lint:baseline` and say so in the PR — never to
paper over a new violation.

---

## 6. MANDATORY test audit

Every existing test touching MeshCore node lists/maps or the settings surface.

| Test file / block | Verdict | Reasoning |
|---|---|---|
| `MeshCoreNodesView.test.tsx` — *sort controls* (3), *role icon* (2), *node-details quick access* (4), *Discover menu* (3), *list collapse toggle* (5) | **Rewrite fixtures, keep assertions** | Fixtures are `lastHeard: 1000 / 2000 / 3000` — epoch **1970**. They are not neutral to this change: under any real cutoff every row disappears and 17 tests fail. WP3 rebases them to `Date.now() - {1,2,3}h` in ms (preserving relative order, so every sort assertion is unchanged) **or** mocks `useNodeDisplaySettings` to `168`. Prefer the rebase — real timestamps also make the suite honest about units. |
| `MeshCoreMap.test.tsx` — *polar grid toggle* (2), *loading overlay* (3) | **Keep unchanged** | Cover unrelated behaviour. ⚠️ **All five would still pass if the age filter were completely broken** — accepted by design: `MeshCoreMap` does not filter (§3.4), so filter coverage lives in `MeshCoreNodesView.test.tsx` §5.3(7), which asserts the props the map *receives*. The §3.11 doc comment records this so nobody later assumes the map self-filters. |
| `SettingsTab.nodeDisplay.perSource.test.tsx` — `describe('SettingsTab — MeshCore hide-branch (#4412 Phase 3 WP4e)')`, both tests | **DELETE** | ⚠️ Asserts an implementation branch inside a component MeshCore users never reach: it constructs `<SourceProvider sourceType="meshcore">` around `SettingsTab`, a combination no route produces (`main.tsx:86` sends MeshCore sources to `MeshCorePage`). **It would still pass if the MeshCore Node Display surface exposed every Meshtastic-only knob**, because it never renders that surface. Replacement coverage: `MeshCoreNodeDisplaySection.test.tsx` §5.2(2), which asserts the real surface omits all six Meshtastic-only keys. Deleted in WP4 alongside the branch (D2). |
| `SettingsTab.nodeDisplay.perSource.test.tsx` — scoped GET, split POST, `mode="global"` single POST, dimming dirty-tracking, partial-write failure | **Keep unchanged** | Cover the Meshtastic path, which Phase 4 does not touch. They also guard against WP4's deletion accidentally disturbing the section. |
| `SettingsTab.elevation.test.tsx` | **Keep unchanged** | Unrelated; renders `SettingsTab`, so it is a canary for WP4's edit. |
| `MeshCoreSourcePage.test.tsx` | **Keep unchanged** | Route/permission smoke test; unaffected by a section added deeper in the tree. |
| `MeshCoreSubToolbar.test.tsx` | **Keep unchanged** | No new view id — the section lands inside the existing `settings` view. |
| `MeshCoreContactDetailPanel.test.tsx` | **Keep unchanged** | Behavioural pin for WP1's `lastAdvert` normalization refactor. |
| `src/server/meshcoreManager.pathfindingFilter.test.ts` | **Keep unchanged** | Behavioural pin for WP1's `filterPathfindingContacts` refactor. Green before *and* after ⇒ no-op. Editing it during the refactor would destroy that guarantee — **explicitly forbidden in WP1's acceptance criteria.** |
| `src/server/routes/meshcoreRoutes.pathfindingFilter.test.ts` | **Keep unchanged** | Same. |
| `src/hooks/useProcessedNodes.test.ts` | **Keep unchanged** | The Meshtastic parity reference Phase 4 mirrors. |
| `src/hooks/useNodeDisplaySettings.test.tsx` | **Keep**, extend by one | Add a case pinning `nodeDisplaySettingsQueryKey(sourceId)`'s exported shape, since WP2 now depends on it externally. |
| `src/utils/nodeDisplayStorage.test.ts`, `src/constants/nodeDisplayDefaults.test.ts` | **Keep unchanged** | Unaffected. |
| `src/server/services/inactiveNodeNotificationService.test.ts` | **Keep unchanged** | D3 adds UI for keys this service already consumes; no service change. |

**Tests deleted: 2.** Replacement coverage: `MeshCoreNodeDisplaySection.test.tsx` §5.2(2).
**Tests that would still pass with the filter broken:** all five in `MeshCoreMap.test.tsx`
(by design, mitigated by §5.3(7)); all of `SettingsTab.*` (they do not touch MeshCore surfaces).

---

## 7. Browser validation plan

App: `http://localhost:8081/meshmonitor` (**8081**, not 8080). Login `admin` / `changeme` —
**rate-limited, do not brute-force**; if it rejects, stop and report rather than retrying.
Sources: `MC-Sandbox` and `MC-BLESandbox`. Any test message goes on the `gauntlet` channel, never
Primary. Drive with the `chrome-devtools` MCP; **real mouse events** (`page.mouse` / element
hit-testing), not synthetic `dispatchEvent`.

Do these in order; each step names what it proves.

1. **The surface exists.** Open `MC-Sandbox` → **Settings** in the MeshCore sub-toolbar. A
   **Node Display** `form-section` is present with exactly four inputs
   (`#maxNodeAge`, `#inactiveNodeThresholdHours`, `#inactiveNodeCheckIntervalMinutes`,
   `#inactiveNodeCooldownHours`). Assert via `document.querySelectorAll` that
   `#localStatsIntervalMinutes`, `#nodeHopsCalculation`, `#hideIncompleteNodes`,
   `#nodeDimmingEnabled` are **absent**. *Proves deliverable 1 and D3.*
2. **Baseline.** Go to **Nodes**. Record `document.querySelectorAll('.mc-node-row').length` and
   `document.querySelectorAll('.leaflet-marker-icon').length`. Note at least one node whose
   last-heard column is older than one hour, and its name.
3. **Favorite an old node.** Star the node from step 2 (row star toggle). *Sets up step 6.*
4. **Apply the filter.** Settings → set **Maximum Age of Active Nodes** to `1` → **Save** in the
   save bar. Expect a success toast.
5. **It takes effect without a reload.** Return to **Nodes** *without* reloading the page. Assert
   both counts from step 2 have **decreased**, and that every remaining row's last-heard is inside
   one hour (or the row is starred). *Proves the filter, its application to the list, and the query
   invalidation in §3.2.*
6. **Favorites bypass.** The starred node from step 3 is still listed and still pinned to the top,
   despite being older than one hour. *Proves D6.*
7. **The map followed.** With the filter still at `1`, assert the map marker count dropped in step 5
   and that a popup opened on a surviving marker names a node still in the list. Cross-check: the
   set of `.leaflet-marker-icon` markers is a subset of the listed rows. *Proves deliverable 2 on
   the map — the half most likely to be missed.*
8. **Reversible.** Set Maximum Age back to `168`, save, return to Nodes: both counts return to the
   step-2 baseline. *Proves the change is the setting, not a coincidental data change.*
9. **Per-source isolation.** With `MC-Sandbox` set to `1`, open `MC-BLESandbox` → Settings: its
   Maximum Age still reads `24` and its Nodes list is unfiltered. Confirm at the API:
   `GET /api/settings?sourceId=<MC-Sandbox id>` → `maxNodeAgeHours: "1"`;
   `GET /api/settings?sourceId=<MC-BLESandbox id>` → `"24"` (use `scripts/api-test.sh`).
   *Proves the whole point of the epic.*
10. **The two filters are independent (D5).** With `MC-Sandbox` at `1` hour, open
    **Automations → Target Filter**: *Heard within (hours)* is unchanged (`168`, disabled). Then
    set the target filter to `2` and confirm the Node Display value is unchanged. *Proves neither
    silently moves the other, and that the cross-reference copy renders.*

**Screenshot** steps 1, 5 and 7 for the PR.

---

## 8. Work packages

Four packages, each one Sonnet agent. No file is written by two packages.

### WP1 — Shared MeshCore age helper + collapse the three existing copies
**Depends on:** nothing. Start immediately.

Create `src/utils/meshcoreAge.ts` (§3.1) and `src/utils/meshcoreAge.test.ts` (§5.1). Point the
three existing normalization sites at it: `src/server/meshcoreManager.ts` (§3.9),
`src/components/MeshCore/MeshCorePathfindingFilterSection.tsx` (§3.8, including the D5
cross-reference copy), `src/components/MeshCore/MeshCoreContactDetailPanel.tsx` (§3.10).

**Acceptance:**
- `meshcoreAge.test.ts` covers all 8 cases in §5.1, including the unit-confusion guard.
- Zero `* 1000` / `/ 1000` on a MeshCore timestamp remains anywhere outside `meshcoreAge.ts`
  (`grep -rn 'lastAdvert' src --include=*.ts --include=*.tsx | grep -v meshcoreAge` shows no
  arithmetic).
- `meshcoreManager.pathfindingFilter.test.ts` and `meshcoreRoutes.pathfindingFilter.test.ts` pass
  **without being edited**. Editing either is a WP1 failure — they are the no-op proof.
- `MeshCoreContactDetailPanel.test.tsx` passes unedited.
- `npx tsc --noEmit` clean.

### WP2 — MeshCore Node Display settings surface
**Depends on:** nothing (parallel with WP1).

Create `MeshCoreNodeDisplaySection.tsx` (§3.2) + its test (§5.2). Wire it through
`MeshCoreSettingsView.tsx` (§3.6) and `MeshCorePage.tsx` (§3.5). Export
`nodeDisplaySettingsQueryKey` from `useNodeDisplaySettings.ts` (§3.7) and add the one pinning case
to `useNodeDisplaySettings.test.tsx`. Add the two i18n keys (§4.3) to `public/locales/en.json`.

**Acceptance:**
- All ten cases in §5.2 pass. **§5.2(7) — the cache-invalidation test — is a hard gate**, not a
  nice-to-have: it is the only automated check for the one defect a green suite would otherwise
  miss (R3). Also load-bearing: (2) the six absent keys, (6) exactly-four-keys POST body.
- No new endpoint; the section hits `/api/settings?sourceId=` only.
- No new stylesheet; no additions to `src/styles/nodes.css`.
- No raw `fetch()`, no emoji, no `any`.
- `MeshCoreSourcePage.test.tsx` and `MeshCoreSubToolbar.test.tsx` still pass unedited.

### WP3 — Apply the filter to the list and the map
**Depends on:** WP1 (imports `meshcoreAge`).

Edit `MeshCoreNodesView.tsx` (§3.4 a–d), extend `MeshCoreNodesView.test.tsx` (§5.3) including the
fixture rebase from §6, and add the doc comment to `MeshCoreMap.tsx` (§3.11).

**Acceptance:**
- All nine cases in §5.3 pass, especially (7) *the map receives the filtered set* and (6) the ms
  unit guard.
- Every pre-existing describe in `MeshCoreNodesView.test.tsx` still passes with its **assertions
  unchanged** — only fixture timestamps move.
- `MeshCoreMap.test.tsx` passes unedited.
- Grep proves the filter is expressed once: `isWithinMeshcoreAge` appears in `MeshCoreNodesView.tsx`
  exactly once.

### WP4 — Retire the unreachable `SettingsTab` MeshCore branch + docs
**Depends on:** WP2 (replacement coverage must exist and be green first).

Per D2 (**ruled: delete** — the coordinator withdrew the keep-it-as-dead-code fallback): delete the
branch in `SettingsTab.tsx` (§3.12) and the two hide-branch tests in
`SettingsTab.nodeDisplay.perSource.test.tsx`. Then do **both** epic-doc edits in §3.13 — correcting
the wrong Phase 4 note is part of this package, not optional polish.

**Acceptance:**
- `SettingsTab.nodeDisplay.perSource.test.tsx`'s remaining describes and
  `SettingsTab.elevation.test.tsx` pass unedited.
- `grep -n 'isMeshCoreSource' src/components/SettingsTab.tsx` returns nothing.
- The epic doc's Phase 4 "Scope expanded" callout no longer claims the mount point makes the branch
  live, and instead records that Phase 4 retired it and why — worded so a later reader will not
  restore it (§3.13a).
- Epic deviations log records D1, D2, D3 (incl. the latent inactive-node-keys bug), D5 and the
  `mergeNodesAndContacts` behaviour change (§3.13b).
- Full suite green; `lint:ci` clean (in-repo failures only).

### 8.1 File ownership

| File | Owner |
|---|---|
| `src/utils/meshcoreAge.ts` *(new)* | WP1 |
| `src/utils/meshcoreAge.test.ts` *(new)* | WP1 |
| `src/server/meshcoreManager.ts` | WP1 |
| `src/components/MeshCore/MeshCorePathfindingFilterSection.tsx` | WP1 |
| `src/components/MeshCore/MeshCoreContactDetailPanel.tsx` | WP1 |
| `src/components/MeshCore/MeshCoreNodeDisplaySection.tsx` *(new)* | WP2 |
| `src/components/MeshCore/MeshCoreNodeDisplaySection.test.tsx` *(new)* | WP2 |
| `src/components/MeshCore/MeshCoreSettingsView.tsx` | WP2 |
| `src/components/MeshCore/MeshCorePage.tsx` | WP2 |
| `src/hooks/useNodeDisplaySettings.ts` | WP2 |
| `src/hooks/useNodeDisplaySettings.test.tsx` | WP2 |
| `public/locales/en.json` | WP2 |
| `src/components/MeshCore/MeshCoreNodesView.tsx` | WP3 |
| `src/components/MeshCore/MeshCoreNodesView.test.tsx` | WP3 |
| `src/components/MeshCore/MeshCoreMap.tsx` | WP3 |
| `src/components/SettingsTab.tsx` | WP4 |
| `src/components/SettingsTab.nodeDisplay.perSource.test.tsx` | WP4 |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` | WP4 |

`MeshCoreMap.test.tsx`, `MeshCorePathfindingFilter*.test.ts(x)`, `MeshCoreContactDetailPanel.test.tsx`,
`meshcoreManager.pathfindingFilter.test.ts`, `meshcoreRoutes.pathfindingFilter.test.ts` and
`SettingsTab.elevation.test.tsx` are owned by **nobody** — they must pass unedited. A WP that needs
to change one of them has broken behaviour it was supposed to preserve; stop and escalate.

Ordering: **WP1 ∥ WP2 → WP3 (after WP1) → WP4 (after WP2)**. Browser validation (§7) runs after all
four land.

---

## 9. Risks — coordinator rulings applied

**R1 — RESOLVED: delete.** D2 contradicted the epic doc's own Phase 4 note ("the mount point makes
the hide-branch live"). The coordinator ruled that the note was written assuming Phase 4 would mount
`SettingsTab`, that D1 supersedes that assumption, and that the branch is therefore unreachable by
construction — dead code plus a vacuously-passing test being strictly worse than no code, since it
implies coverage that does not exist. Same failure mode as this epic's four earlier bug-pinning
tests; the audit's finding #5 stands. **Delete the branch and both tests, and correct the epic-doc
note (§3.13a) rather than working around it.** No fallback.

**R2 — `MeshCoreNodesView.test.tsx` fixtures are epoch-1970.** `lastHeard: 1000/2000/3000` means the
17 existing tests in that file are *not* neutral to this change; they will fail the moment any real
cutoff applies. Expect WP3's diff to touch every describe in the file. This is a fixture rebase, not
a behaviour change, and the acceptance criteria forbid altering assertions — but a reviewer skimming
the diff will see a large test churn and should be told why.

**R3 — RESOLVED: §5.2(7) is mandatory.** The list, the map and the settings section all read the
same TanStack entry. If WP2 omits `invalidateQueries(nodeDisplaySettingsQueryKey(sourceId))`,
everything still *works* — saves persist, a reload shows the new value — but the filter does not
move until reload, and every unit test still passes unless §5.2(7) is written. Coordinator ruling:
**that test is the deliverable; browser step 5 is the backstop, not the coverage.** A stale cache
that self-corrects only on reload is precisely the "works when you check it manually, broken in
normal use" class. Hard gate on WP2.

**R4 — `settings:write` is not source-scoped yet (epic bug #4 / #4416, deferred to Phase 6).**
`settings` is missing from the live `SOURCEY_RESOURCES`, so `checkPermissionAsync` discards the
`sourceId` and a source-A-scoped grant authorizes the MeshCore section's writes on source B. Phase 4
does not make this worse (`SettingsTab` already writes through the same endpoint) and it passes
`sourceId` at the call site so the surface is correct the day Phase 6 lands. **RESOLVED — name
#4416 explicitly in the PR body (§10).** Coordinator ruling: do not let a reviewer read Phase 4 as
having made per-source settings secure.

**R5 — RESOLVED: degrade, never skip.** §7 step 9 needs both `MC-Sandbox` and `MC-BLESandbox`
reachable. Per prior sessions, MeshCore serial enumeration drifts across reboots; if one source is
disconnected its Nodes list may be empty and the visible half of the isolation check is
unavailable. Coordinator ruling: **fall back to the API-only half** (`GET /api/settings?sourceId=`
returns `"1"` for one source and `"24"` for the other) and **state in the report that step 9 ran in
its API-only form, and why** — do not quietly drop it.

---

## 10. PR body requirements

Three things the PR body must say plainly. All three are coordinator instructions, not suggestions.

1. **The latent bug this fixes is user-visible — lead with it.** `inactiveNodeThresholdHours`,
   `inactiveNodeCheckIntervalMinutes` and `inactiveNodeCooldownHours` already drive inactive-node
   alerts for MeshCore sources (`inactiveNodeNotificationService.ts:266` →
   `getInactiveMeshcoreNodes` at `:386`) and have had **no UI on a MeshCore source at all**. A
   MeshCore-only operator could not configure them. Phase 4 exposes them. Write this as a fix
   users care about, not as an implementation detail buried in a bullet list.
2. **Name #4416.** `settings` is absent from the live `SOURCEY_RESOURCES`, so a source-scoped
   `settings:write` grant is still evaluated globally. Phase 4 neither introduces nor fixes this,
   and passes `sourceId` so the call site is already correct for Phase 6. Say so — a reviewer must
   not read this PR as having made per-source settings secure.
3. **Explain the test churn (R2) and the two deletions (D2).** `MeshCoreNodesView.test.tsx`'s
   fixtures were epoch-1970 (`lastHeard: 1000/2000/3000`) and had to be rebased onto
   `Date.now()`-relative milliseconds; assertions are unchanged. The two `SettingsTab` MeshCore
   hide-branch tests were deleted because they asserted an unreachable branch and would have passed
   even if the MeshCore surface exposed every Meshtastic-only knob; replacement coverage is
   `MeshCoreNodeDisplaySection.test.tsx` §5.2(2).
