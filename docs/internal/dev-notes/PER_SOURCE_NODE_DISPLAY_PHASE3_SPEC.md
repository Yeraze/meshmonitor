# Phase 3 — Frontend per-source state & UI (epic #4412)

**Status:** spec, not started
**Branch:** `feature/per-source-node-display-ui` (worktree `/home/yeraze/Development/meshmonitor-per-source-ui`)
**Base:** `origin/main` @ `0fb935de` (Phase 2 merged)
**Scope:** the ten Node Display keys in `src/constants/nodeDisplayDefaults.ts` — nothing else.

Read `PER_SOURCE_NODE_DISPLAY_EPIC.md` first. This document assumes Phases 1 and 2
are in place: migration 131 seeded `source:{id}:{key}` for every source, the POST
route filters/audits/validates/reschedules per source, and **every backend read is
already per-source**. Phase 3 closes the loop on the client.

---

## 0. Executive summary of the design decisions

Six decisions drive the whole phase. Each is justified in §1 or §3.

| # | Decision | Why |
|---|---|---|
| D1 | **No `Record<sourceId, value>` state in `SettingsContext`.** The provider becomes source-*aware* (reads `useSource()`, fetches with `?sourceId=`, refetches on `sourceId` change) exactly like `AutomationContext`. | Every `SettingsProvider` mount site sits under zero or one `SourceProvider`. A Record would be dead weight at 7 of 8 mount sites and would force every consumer to thread a `sourceId` it already has implicitly. |
| D2 | **`activeWindowConfig.ts` is deleted, not source-keyed.** Its single consumer (`useAnalysisNodes`) switches to a TanStack query hook. | The module has exactly one reader and one writer. Source-keying it produces a registry that is stale for any source whose provider hasn't mounted this page-load — and Map Analysis is frequently the *first* page visited. The hook has no such failure mode. The original objection in its header comment was to depending on a **UI provider**, not to a query hook; `useAnalysisNodes` already calls two TanStack hooks. |
| D3 | **Cross-source surfaces use the most-permissive rule:** `max(maxNodeAgeHours)` across the sources in view. | Map Analysis and the Dashboard map merge nodes from N sources onto one surface. Any single-value answer is wrong for someone; "never hide a node that a source-scoped view would show" is the only rule that cannot lose data. One rule covers both surfaces. |
| D4 | **`App.tsx`'s legacy loader stops touching these keys entirely.** `SettingsContext` becomes their sole owner. | Both loaders exist today and both write the same four `SettingsContext` states + `UIContext.showIncompleteNodes`. See §3 — this is the "settings appear to revert" trap, and it becomes *observable* the moment the two fetches diverge. |
| D5 | **`GET /api/settings?sourceId=` stops merging the global row under the ten keys.** | Post-131 sources have no seeded rows, so today's merge would *display* the legacy global value while the backend *behaves* as the hardcoded default. A ~6-line backend change is the difference between "the UI tells the truth" and shipping the same class of bug this epic keeps finding. **Ruled IN SCOPE by the coordinator 2026-07-29** — "frontend-only" meant "not another read-conversion sweep", not a prohibition on the one server line that makes the frontend truthful. |
| D6 | **`NODE_DISPLAY_RANGES` is left untouched — permanently, not deferred.** | The epic notes "Phase 3 adds theirs from the SettingsTab inputs" for the two dimming numerics. Adding entries buys nothing — no backend reads them and no server-side writer validates them — while `parseNodeDisplayNumber` would start clamping **already-stored** out-of-range values to the default, silently changing behaviour on existing installs. The JSX `min`/`max` already constrain input. **This is a decision, not an unfinished task. Do not "finish the job" in a later phase without first adding the server-side validation that would back it.** Ratified by the coordinator 2026-07-29, superseding the guidance given to the Phase 2 reviewer. Recorded in §10. |

---

## 1. Reuse inventory — MANDATORY

Everything below already exists. Implementers **must** use or extend these rather
than introducing a parallel mechanism. Anything not on this list that you feel the
need to invent, stop and raise it.

### 1.1 Values and parsing — never re-declare

| Symbol | File | Use it for |
|---|---|---|
| `NODE_DISPLAY_SETTING_KEYS` | `src/constants/nodeDisplayDefaults.ts` | The canonical list. Partition `handleSave`'s POST body with it. Never hand-write a list of ten strings. |
| `NODE_DISPLAY_NUMERIC_DEFAULTS` / `_BOOLEAN_DEFAULTS` / `_STRING_DEFAULTS` | same | Every client-side default. **Delete every hardcoded `24`, `15`, `60`, `'nodeinfo'`, `0.3` you find in the files you own.** |
| `parseNodeDisplayNumber(key, raw)` | same | Parsing a stored string into a number. Replaces `parseInt(x) || 24` and `parseFloat(x) \|\| contextValue`. |
| `parseNodeDisplayBoolean(key, raw)` | same | Replaces `x === '1' \|\| x === 'true'`. |
| `NODE_DISPLAY_DEFAULT_STRINGS` | same | Only if you need the stored form. |

This module is isomorphic with zero imports and was placed in `src/constants/`
**specifically so Phase 3 could import it**. Importing it from client code is the
intended use, not a layering violation.

### 1.2 Per-source frontend patterns — the state-keying question, answered

| Symbol | File | Why it settles the question |
|---|---|---|
| `useSource()` → `{ sourceId, sourceName, sourceType }` | `src/contexts/SourceContext.tsx` | Non-throwing; returns `{null,null,null}` outside a provider. Safe to call from `SettingsProvider` at every mount site. |
| `useSourceQuery()` → `'?sourceId=…' \| ''` | `src/hooks/useSourceQuery.ts` | **The** helper for scoping a `/api/settings` call. `SettingsTab` must use this for both its GET and its scoped POST — do not re-derive the query string. |
| `AutomationProvider`'s load effect | `src/contexts/AutomationContext.tsx:154-252` | The precedent for D1: single-valued state, `const sourceQuery = sourceId ? … : ''`, deps `[sourceId, baseUrl]`. It does **not** key state by source. Copy this shape into `SettingsProvider`. |
| `useElevationEnabled()` | `src/hooks/useElevationEnabled.ts` | The precedent for a TanStack query against `/api/settings`: `queryKey: ['settings', …]`, `staleTime`, bare (non-enveloped) response shape. WP1's new hook copies this. |
| `useResolvedSourceId()` / `pickPrimarySource()` | `src/hooks/useResolvedSourceId.ts` | Pattern for "resolve a concrete source when context gives you null", plus the exported-pure-function-for-testing convention. |
| `useDashboardSources()` | `src/hooks/useDashboardData.ts:104` | The source list the cross-source hook fans out over. Already cached under `['dashboard','sources']`. |

**Why these do not fully solve it, and what WP1 adds.** `AutomationContext` gives us
the single-source case (D1) but has no answer for a surface that needs N sources'
values at once — the Dashboard map and Map Analysis. `useElevationEnabled` reads one
global key and cannot take a `sourceId`. So WP1 adds exactly one small module,
`src/hooks/useNodeDisplaySettings.ts`, built on `useElevationEnabled`'s pattern, and
the Record-of-sources lives **only there** — confined to the two surfaces that
genuinely need it, never in `SettingsContext`.

### 1.3 Existing SettingsTab machinery — extend, do not replace

| Symbol | Line (approx — locate by symbol) | Obligation |
|---|---|---|
| `SettingsDraft` / `settingsDraftReducer` / `updateField` / `baseline` / `settingsDraftEqual` | `SettingsTab.tsx:60-160`, `:344-401`, `:685+` | The dimming trio joins this machinery. Do **not** add a fourth dirty-tracking mechanism. |
| `applyDraft` | `~:795` | Add the three `setNodeDimming*` calls here. It exists to keep `handleSave`'s dep array at `[draft, applyDraft]`. |
| `const settings = { … }` literal in `handleSave` | `~:861-910` | **Hand-maintained and source-extracted by a test.** See §2.R6 and §4.4 — the literal must survive verbatim in shape. |
| `SOURCE_SECTIONS` / `GLOBAL_SECTIONS` / `show()` | `~:226-232`, `~:285` | `settings-node-display` is already registered. No change. |
| `useSaveBar({ id:'settings', hasChanges, onSave, onDismiss })` | `~:945` | Unchanged. `hasChanges` simplifies (loses its `|| nodeDimmingChanged` term). |

### 1.4 Shared helpers already correct — leave alone

- `effectiveMapMaxAgeHours(mapMaxAgeHours, settingsMaxAgeHours)` — `src/utils/mapAge.ts`.
  Pure, already parameterised. **Only its doc comment is wrong** (says "global").
- `calculateNodeOpacity(...)` — `NodesTab.tsx:110`. Already takes all four values as
  parameters. No change.
- `transportCutoffSec(hours)` — `src/utils/nodeTransport.ts:169`. Already parameterised.
  **No change** — the fix is at its *caller*, `useAnalysisNodes`.
- `useProcessedNodes`'s `options.maxNodeAgeHours` override — already exists.

### 1.5 Test utilities

- `createRouteTestApp()` / `RouteTestHarness` — `src/server/test-helpers/routeTestApp.ts`.
  **Required** for the one backend route change (D5). See `settingsRoutes.perSource.test.ts`
  as the template — it is already harness-based.
- `renderHook` + `createWrapper()` patterns in `src/hooks/useProcessedNodes.test.ts`.
- Vitest excludes `**/.claude/worktrees/**` (`vitest.config.ts`); ESLint does not —
  filter `lint:ci` output with `grep -v '.claude/worktrees'`.

---

## 2. Existing tests: keep, rewrite, or delete

39 test files reference the ten keys or `activeWindowConfig`. Classification below.
**Read this section before writing a line of production code.** Both prior phases
shipped with a green suite hiding a real bug because a test re-implemented the thing
it was meant to check.

**Counts: 30 keep · 6 rewrite · 1 file gutted (3 tests deleted) + 1 test block deleted.**

### 2.1 KEEP (30) — assert behaviour that stays true

Backend, unaffected by a client-side change:

`src/constants/nodeDisplayDefaults.test.ts` ·
`src/server/constants/settings.allowlist.test.ts` ·
`src/server/migrations/131_seed_per_source_node_display.test.ts` ·
`src/server/migrations/131_seed_per_source_node_display.pgmysql.test.ts` ·
`src/server/services/nodeDisplaySettings.test.ts` ·
`src/server/services/inactiveNodeNotificationService.test.ts` ·
`src/server/services/inactiveNodeNotificationService.perSource.test.ts` ·
`src/server/services/sourceDashboardData.perSource.test.ts` ·
`src/server/routes/unifiedRoutes.test.ts` ·
`src/server/routes/unifiedRoutes.perSource.test.ts` ·
`src/server/routes/tracerouteRoutes.test.ts` ·
`src/server/routes/pollRoutes.test.ts` ·
`src/server/routes/neighborInfoRoutes.test.ts` ·
`src/server/routes/sourceRoutes.dashboard.test.ts` ·
`src/server/routes/sourceRoutes.neighbor-info.test.ts` ·
`src/server/routes/sourceRoutes.settingsCleanup.test.ts` ·
`src/server/routes/settingsRoutes.test.ts` ·
`src/server/virtualNodeServer.zombieFix.test.ts` ·
`src/server/meshtasticManager.autowelcome.test.ts` ·
`src/server/applyManagerSettings.test.ts` ·
`src/db/repositories/settings.test.ts` ·
`src/services/database.maxNodeAge.perSource.test.ts`

Frontend, genuinely unaffected (the value arrives as an explicit parameter, so the
test never depended on where it came from):

`src/utils/nodeExport.test.ts` (`nodeHopsCalculation` passed in the ctx object) ·
`src/hooks/useTraceroutePaths.test.tsx` (`maxNodeAgeHours: 24` is a hook param) ·
`src/components/NodeDetailsBlock.contactShare.test.tsx` ·
`src/components/NodeDetailsBlock.signalTrend.test.tsx` ·
`src/components/NodeDetailsBlock.position.test.tsx` ·
`src/components/NodeDetailsBlock.noiseFloor.test.tsx` ·
`src/components/MessagesTab.composeFocus.test.tsx` ·
`src/components/MessagesTab.tracerouteStrip.test.tsx`

**One keep with a required addition:**

`src/server/routes/settingsRoutes.perSource.test.ts` — every existing case stays
(including the deliberately-pinned `KNOWN GAP` case, which must keep its header
comment). **Add** cases for D5: a `GET /api/settings?sourceId=X` for a source with
*no* seeded Node Display rows must return those keys **absent**, not back-filled from
the global row; and the same GET must still back-fill non-Node-Display global keys.

`src/components/SettingsTab.elevation.test.tsx` — keep. It renders `SettingsTab`
outside any `SourceProvider`, so `useSourceQuery()` returns `''`, the save collapses
to a single unscoped POST, and its `'/api/settings'` assertion at `~:353` still holds.
**Add one guard**: assert the save issues exactly **one** `fetch` to `/api/settings`
in that configuration — otherwise a bug that always fires two POSTs (the second a
no-op duplicate against the global row) would ship silently.

### 2.2 REWRITE (6) — assert the global assumption

Each of these **currently passes, and would still pass if per-source were completely
broken.** That is what makes them dangerous.

---

**R1 · `src/contexts/SettingsContext.test.tsx`** (1547 lines)

*Asserts today:* the provider fetches bare `/api/settings`; the ten keys mirror to
bare localStorage keys (`localStorage key naming`, `~:277-295`); fixture
`maxNodeAgeHours: '48'` at `~:114`.

*Must assert instead:*
1. Rendered inside `<SourceProvider sourceId="A">`, the provider requests
   `/api/settings?sourceId=A`.
2. Changing `sourceId` A→B **refetches** and re-seeds the ten states (this is the
   whole point of D1; nothing tests it today).
3. The ten keys seed from `nodeDisplay:A:maxNodeAgeHours`, **not** the bare
   `maxNodeAgeHours` key, and a value written under source A is not visible under
   source B.
4. Rendered **outside** a `SourceProvider`, the ten keys equal
   `NODE_DISPLAY_*_DEFAULTS` and no bare-key localStorage write occurs.
5. `hideIncompleteNodes` / `showIncompleteNodes` are present on the context value.

*Delete outright:* the `localStorage key naming` test (`~:277-295`). It asserts the
exact bare key names Phase 3 replaces and would pass unchanged if the namespacing
were dropped. Replacement coverage is (3) above.

> **Dangerous-test note:** (3) is the only assertion in the entire suite that fails
> if the localStorage mirror stays unkeyed. Without it, source B renders source A's
> last-saved max-age on first paint and every test stays green.

---

**R2 · `src/hooks/useProcessedNodes.test.ts`** (567 lines)

*Asserts today:* `vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => mockUseSettingsReturn() }))`
with a fixed `maxNodeAgeHours: 72`. The hook is never exercised against a real
provider, so it passes identically whether the provider is source-scoped or not.

*Must assert instead:* keep the existing mocked suites (they test filtering logic,
which is fine), but **add** one integration-shaped test that mounts the hook twice
under two different `SourceProvider`s with the fetch mock returning different
`maxNodeAgeHours` per `?sourceId=`, and asserts the two results differ. That single
test is what turns this file from "passes regardless" into real coverage.

---

**R3 · `src/hooks/useSourceView.test.ts`**

*Asserts today:* `mockUseSettings.mockReturnValue({ maxNodeAgeHours: 24, distanceUnit: 'metric' })`
(`~:124`) **and** `showIncompleteNodes: true` inside the `useUI` mock (`~:131`).

*Must assert instead:* `showIncompleteNodes` moves to the `useSettings` mock and is
**removed from the `useUI` mock**. Add an explicit assertion that the incomplete-node
filter still applies with the UI mock silent on the key.

> **Dangerous-test note:** as written, if WP3 misses a read site the UI mock still
> satisfies it and this file stays green. Removing the key from the UI mock is what
> makes a missed site fail.

---

**R4 · `src/components/MessagesTab.txDisabled.test.tsx`**

*Asserts today:* supplies `showIncompleteNodes: false` in its `useUI` mock (`~:153`).

*Must assert instead:* drop the key from the `useUI` mock. Add it to the settings
mock only if the component under test actually reads it; if TypeScript is satisfied
without it, delete the line rather than relocating it.

---

**R5 · `src/components/Dashboard/DashboardMap.test.tsx`** (701 lines)

*Asserts today:* `maxNodeAgeHours: 24` as a literal default prop (`~:302`), a
`maxNodeAgeHours={72}` override (`~:389`), and two stale-node cases at `~:550`/`~:561`.

*Must assert instead:* the value arrives from the new cross-source hook, mocked per
source. Rewrite the two stale-node cases to drive it that way, and **add** a
most-permissive case (D3): sources A=6h and B=72h in view, a node last heard 48h ago
still renders. Also add the inverse: with every source at 6h, that node does not.

---

**R6 · `src/server/server.settings-persistence.test.ts`**

*Asserts today:* `extractSettingsTabSends()` regex-extracts the
`const settings = { … }` literal from `handleSave` and cross-checks it against
`VALID_SETTINGS_KEYS` and `SettingsContext`'s loads. This still works after the split
— which is the problem. If an implementer quietly drops a Node Display key from the
**scoped** POST body, the key is still in the literal and every assertion here passes.

*Must assert instead:* keep everything, and **add a new partition test.** Extract the
split (see §4.4 — the partition must be a named, statically-analysable expression)
and assert, in this order of importance:

1. **Every one of the ten `NODE_DISPLAY_SETTING_KEYS` entries lands in the *scoped*
   POST body.** Not "the keys that happen to be there are valid" — **all ten, by
   count and by name**, asserted against `NODE_DISPLAY_SETTING_KEYS` itself so
   the test cannot drift from the constant. This is the single highest-value new
   assertion in the phase.
2. **None** of the ten lands in the unscoped body.
3. Every other key in the literal lands in the unscoped body.

This is the only static guard against silently reverting the split, and — more
importantly — against a Node Display key quietly dropping out of the scoped path.
Today that failure is invisible: the key is still in the `const settings = {…}`
literal, so every existing assertion in this file passes while the setting has
**stopped saving entirely**. That is precisely the bug class Phase 1's deny-list
(default-allow) decision was built to prevent, arriving through a different door.
Coordinator called this out explicitly on 2026-07-29 — treat assertion (1) as
non-negotiable and do not let it degrade into a subset check.

### 2.3 DELETE (1 file's worth)

**`src/services/database.extended.test.ts` — the `maxNodeAgeHours` tests only
(`~:1504`, `~:1555`, `~:1597`) and the `maxNodeAgeHours` branch of the fake at
`~:425-431`.**

The test file defines a mock DB class that **re-implements** the production query,
including `parseInt(this.getSetting('maxNodeAgeHours') || '24')` — the *pre-Phase-2
global read*. The three tests then assert against that re-implementation. Production
now calls `getMaxNodeAgeHours(this.settings, sourceId)`. These tests would pass
identically if the code reverted to a global read tomorrow.

This is the same failure mode as `server.neighbor-info-position.test.ts` (deleted in
Phase 2 for re-implementing the route body including the dead `'maxNodeAge'` key).

*Replacement coverage:* `src/services/database.maxNodeAge.perSource.test.ts`
(Phase 2). **Before deleting, verify it covers all three call sites**
(`getNodeNeedingTracerouteAsync`, `getNodesNeedingRemoteLocalStatsAsync`,
`getNodeNeedingRemoteAdminCheckAsync`). If any is uncovered, add it there first, then
delete. Do not delete into a coverage hole.

Everything else in `database.extended.test.ts` stays — only the max-age tests and the
one fake branch go.

### 2.4 Summary of dangerous tests

Ranked by how quietly they would let per-source break:

1. **`database.extended.test.ts` max-age tests** — a fake re-implementing the logic
   under test. Green with the bug present, by construction. → delete.
2. **`server.settings-persistence.test.ts` alignment tests** — satisfied by the
   literal, blind to the split. → add the partition test.
3. **`SettingsContext.test.tsx` localStorage suite** — pins the un-namespaced mirror.
   → delete + replace.
4. **`useProcessedNodes.test.ts`** — mocked `useSettings` makes the source-scoping
   question unaskable. → add the two-source test.
5. **`useSourceView.test.ts`** — the `useUI` mock keeps a moved key alive. → remove it
   from the mock.
6. **`DashboardMap.test.tsx`** — literal prop hides the cross-source rule entirely.
   → drive from the hook.

---

## 3. The `App.tsx` dual-loader trap — findings and reconciliation

Phase 2's review flagged a second settings loader. Here is exactly what it is.

**Loader 1 — `SettingsContext.tsx` `loadServerSettings`** (effect at `~:1340`, deps
`[baseUrl]`). Fetches **unscoped** `${baseUrl}/api/settings`. Writes, among the ten:
`maxNodeAgeHours` (+ `localStorage` + `setActiveWindowHours`), the inactive trio,
`nodeHopsCalculation`, and the dimming trio — each with its own `localStorage.setItem`.

**Loader 2 — `App.tsx` `initializeApp`** (effect at `~:938`, deps `[]` — mount-once).
Already builds `const settingsQuery = sourceId ? '?sourceId=…' : ''` and fetches
`${appBasename}/api/settings${settingsQuery}` at `~:967`. Writes `maxNodeAgeHours`
(`~:972-976`, plus `localStorage`), the inactive trio (`~:978-1000`), and
`hideIncompleteNodes → setShowIncompleteNodes` (`~:1228-1233`).

**Why it is quiet today and loud after Phase 3.** Both fetches currently return the
same global row, so whichever promise resolves last writes the same value. After
Phase 3 the scoped fetch returns the *per-source* value while the unscoped one
returns the *legacy global* row. The two disagree, both write the same
`SettingsContext` state, and the winner depends on network ordering. Symptom:
"I set 72 on this source, it shows 72, I reload and it's 24 again — sometimes."
`App.tsx`'s `[]` dep array makes it worse: it never refetches on source switch, so
after a switch a stale mount-time value can be the last writer.

**Reconciliation — `SettingsContext` becomes the sole owner.** Delete from
`App.tsx`'s `initializeApp` (WP3):

- the `settings.maxNodeAgeHours` block (`~:972-976`);
- the `settings.inactiveNodeThresholdHours` / `…CheckIntervalMinutes` / `…CooldownHours`
  blocks (`~:978-1000`);
- the `settings.hideIncompleteNodes` block (`~:1227-1233`) — including its two
  `logger.debug` lines.

Keep everything else in that effect untouched (`temperatureUnit`, `distanceUnit`,
`telemetryVisualizationHours`, `homoglyphEnabled`, the whole `autoAck*` family,
`autoAnnounce*`, `geofenceTriggers`, …) — out of scope, and its `settingsQuery` is
already correct for them.

Keep the `setMaxNodeAgeHours` / `setInactiveNode*` destructures at `~:284` — they are
still needed as the `onMaxNodeAgeChange`-family props passed down to `SettingsTab`.
Remove `setShowIncompleteNodes` (`~:550`) only once WP3 has removed it from `UIContext`.

**Acceptance:** after WP3, `grep -n 'settings.maxNodeAgeHours\|settings.inactiveNode\|settings.hideIncompleteNodes' src/App.tsx` returns nothing.

---

## 4. File-by-file changes

### 4.1 `src/hooks/useNodeDisplaySettings.ts` — NEW (WP1)

Built on `useElevationEnabled`'s pattern. Bare (non-enveloped) `/api/settings` response.

```ts
import { useQueries, useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import {
  NODE_DISPLAY_NUMERIC_DEFAULTS,
  parseNodeDisplayNumber,
  parseNodeDisplayBoolean,
  NODE_DISPLAY_STRING_DEFAULTS,
} from '../constants/nodeDisplayDefaults';
import type { NodeHopsCalculation } from '../contexts/SettingsContext';

export interface NodeDisplaySettings {
  maxNodeAgeHours: number;
  inactiveNodeThresholdHours: number;
  inactiveNodeCheckIntervalMinutes: number;
  inactiveNodeCooldownHours: number;
  localStatsIntervalMinutes: number;
  nodeHopsCalculation: NodeHopsCalculation;
  hideIncompleteNodes: boolean;
  nodeDimmingEnabled: boolean;
  nodeDimmingStartHours: number;
  nodeDimmingMinOpacity: number;
}

/** Parse a raw `/api/settings` map into the ten values. Exported for testing. */
export function parseNodeDisplaySettings(
  raw: Record<string, string> | undefined,
): NodeDisplaySettings;

/**
 * The ten Node Display values for ONE source.
 * `sourceId === null` → hardcoded defaults, and **no request is issued**
 * (`enabled: sourceId != null`) — the interview's "no runtime global fallback".
 */
export function useNodeDisplaySettings(sourceId: string | null): NodeDisplaySettings;

/**
 * Most-permissive `maxNodeAgeHours` across N sources, for cross-source surfaces
 * (D3). Empty list or all-loading → `NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours`.
 * Exported pure helper `maxAcross(values)` for testing, per `pickPrimarySource`'s
 * convention.
 */
export function useMaxNodeAgeHoursAcross(sourceIds: string[]): number;
```

- `queryKey: ['settings', 'node-display', sourceId]`, `staleTime: 60_000`.
- `useMaxNodeAgeHoursAcross` uses `useQueries` over a **sorted, de-duplicated** id
  list so the query set is stable across re-renders (same discipline as
  `useDashboardData.ts:518`'s `sourcesKey`).
- Never re-declare a default. Every literal comes from `nodeDisplayDefaults`.

### 4.2 `src/utils/nodeDisplayStorage.ts` — NEW (WP1)

Namespaced localStorage mirrors. Today's bare keys (`maxNodeAgeHours`,
`nodeDimmingEnabled`, …) are a cross-source leak on first paint: navigate to source B
and it briefly renders source A's last-saved value.

```ts
/** `nodeDisplay:{sourceId}:{key}`. Returns null when sourceId is null. */
export function readNodeDisplayLocal(sourceId: string | null, key: NodeDisplaySettingKey): string | null;
export function writeNodeDisplayLocal(sourceId: string | null, key: NodeDisplaySettingKey, value: string): void;
/** One-time removal of the ten legacy bare keys so stale globals can't resurface. */
export function purgeLegacyNodeDisplayLocal(): void;
```

- `sourceId === null` → read returns `null`, write is a no-op. No global slot.
- `purgeLegacyNodeDisplayLocal()` is called once from `SettingsProvider`'s module
  scope or a mount-once effect; it is idempotent.
- Guard every `localStorage` access in a try/catch (Safari private mode throws).

### 4.3 `src/contexts/SettingsContext.tsx` (WP2)

**Provider becomes source-aware.**

1. `const { sourceId } = useSource();` at the top of `SettingsProvider`.
2. The ten `useState` initializers stop reading bare localStorage keys and read
   `readNodeDisplayLocal(sourceId, key)` through `parseNodeDisplayNumber` /
   `parseNodeDisplayBoolean`, falling back to `NODE_DISPLAY_*_DEFAULTS`.
3. The ten setters (`setMaxNodeAgeHours` `~:580`, `setInactiveNode*` `~:586-600`,
   `setNodeHopsCalculation`, `setNodeDimming*`) write
   `writeNodeDisplayLocal(sourceId, …)` instead of `localStorage.setItem(bareKey, …)`.
   Their `useCallback` deps gain `sourceId`.
4. `loadServerSettings` (`~:1340`):
   - URL becomes `${baseUrl}/api/settings${sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : ''}`.
     (`SettingsProvider` is not always inside a Router, so build the query inline
     rather than calling `useSourceQuery()` here — `useSourceQuery` is for components.)
   - deps become `[baseUrl, sourceId]`.
   - **Before** the `await`, synchronously re-seed the ten states from
     `readNodeDisplayLocal(sourceId, …) ?? default`. Without this, a `sourceId` change
     that does not remount the provider leaves the previous source's values on screen
     until the fetch lands.
   - When `sourceId == null`, reset the ten to `NODE_DISPLAY_*_DEFAULTS` and **skip
     applying** the ten from the response (the other ~40 keys still apply as today).
   - Replace `parseInt(...)`/`parseFloat(...)`/`=== '1' || === 'true'` for these ten
     with `parseNodeDisplayNumber` / `parseNodeDisplayBoolean`.
5. **Add to the context value and type:**
   - `hideIncompleteNodes: boolean` + `setHideIncompleteNodes: (v: boolean) => void`
     (stored name — this is what the POST body uses).
   - `showIncompleteNodes: boolean` — derived `!hideIncompleteNodes`, read-only, so
     the eight existing read sites need only swap `useUI()` → `useSettings()`.
6. **Delete** `import { setActiveWindowHours } from '../utils/activeWindowConfig'` and
   both call sites (`~:583`, `~:1658`).
7. **Delete** `src/utils/activeWindowConfig.ts`.

**Do not** add a TanStack dependency to `SettingsProvider`. It is rendered without a
`QueryClientProvider` in a large number of component tests; adding one breaks them
all. The query hook is for the two cross-source surfaces only.

### 4.4 `src/components/SettingsTab.tsx` (WP4)

This file is ~2,700 lines and carries four of the phase's work items. All of them are
in one work package, as Phase 1 did with `settingsRoutes.ts`.

**(a) Scoped GET.** In `fetchServerSettings` (`~:478`):

```ts
const sourceQuery = useSourceQuery();          // '' in mode="global"
…
const settings = await apiService.get<Record<string, string>>(`/api/settings${sourceQuery}`);
```

`useSourceQuery()` returns `''` for `GlobalSettingsPage` (outside `SourceProvider`)
and `?sourceId=X` for the App route (inside). The two align with `mode` exactly — do
not branch on `mode` as well. Add `sourceQuery` to the effect's dep array; the file
already carries a targeted `eslint-disable-next-line react-hooks/exhaustive-deps` on
this effect with a documented reason — **preserve that comment and extend it**, do
not delete it and do not auto-fix.

**(b) Split save.** In `handleSave` (`~:853`), *after* the existing literal:

```ts
const settings = { …unchanged, all keys, including all ten… };

// Node Display keys are per-source (#4412 Phase 3); everything else keeps
// today's unscoped global behaviour. Partition — never a second literal, the
// single `const settings = {…}` block is source-extracted by
// server.settings-persistence.test.ts.
const nodeDisplayBody: Record<string, unknown> = {};
const globalBody: Record<string, unknown> = {};
for (const [k, v] of Object.entries(settings)) {
  (NODE_DISPLAY_SETTING_KEYS as readonly string[]).includes(k)
    ? (nodeDisplayBody[k] = v)
    : (globalBody[k] = v);
}

if (sourceQuery) {
  await csrfFetch(`${baseUrl}/api/settings`, { …, body: JSON.stringify(globalBody) });
  await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, { …, body: JSON.stringify(nodeDisplayBody) });
} else {
  await csrfFetch(`${baseUrl}/api/settings`, { …, body: JSON.stringify(settings) });
}
```

Hard constraints:
- **The literal keeps its exact shape** — named `settings`, a single
  `const settings = { … };` inside `handleSave`, containing **all ten** keys.
  `extractSettingsTabSends()` matches
  `/const handleSave[\s\S]*?const settings\s*=\s*\{([\s\S]*?)\};/`. Moving keys into
  a second literal breaks that test *and* the server allowlist reasoning that keys
  off it.
- **The `sourceQuery === ''` branch issues exactly one POST**, byte-identical to
  today's. No behavioural change for `mode="global"`.
- **Sequential `await`s, not `Promise.all`.** If the first fails the second must not
  fire; the `catch` shows `settings.save_failed` and `applyDraft` is not called —
  matching today's all-or-nothing-on-throw behaviour. Note in a comment that a
  failure of the *second* POST leaves the global half applied; that is accepted and
  surfaced by the error toast.
- `handleSave`'s dep array gains `sourceQuery` and loses `nodeDimmingEnabled`,
  `nodeDimmingStartHours`, `nodeDimmingMinOpacity` (they become `draft` fields).

**(c) Dimming trio onto the draft.**
- Add `nodeDimmingEnabled: boolean`, `nodeDimmingStartHours: number`,
  `nodeDimmingMinOpacity: number` to `SettingsDraft` (`~:60`) and to the
  `useReducer` initializer (`~:344`).
- Add all three to `baseline` (`~:685`) reading from `useSettings()` — which now
  holds the per-source values.
- **Delete** `initialNodeDimmingSettings` state (`~:428`), the `nodeDimmingChanged`
  memo (`~:751`), and the `|| nodeDimmingChanged` term in `hasChanges` (`~:759`).
- **Delete** the `setInitialNodeDimmingSettings({…})` calls in `fetchServerSettings`
  (`~:533`), `handleSave` (`~:928`), and `resetChanges` (`~:764`).
- In `fetchServerSettings`, replace
  `parseFloat(settings.nodeDimmingStartHours) || nodeDimmingStartHours` with
  `parseNodeDisplayNumber('nodeDimmingStartHours', settings.nodeDimmingStartHours)`
  and the same for `nodeDimmingMinOpacity` / `parseNodeDisplayBoolean` for
  `nodeDimmingEnabled`, then `updateField(...)` each. This removes the context-value
  read that forced the `eslint-disable` comment at `~:586` — **if that comment's
  stated reason no longer applies after your change, update the comment; if it still
  applies to another value, leave it.**
- JSX (`~:1980-2030`): `checked={draft.nodeDimmingEnabled}` /
  `value={draft.nodeDimmingStartHours}` / `value={draft.nodeDimmingMinOpacity}` with
  `updateField(...)`. **Keep the existing `Math.min/Math.max` clamps and the
  `min`/`max`/`step` attributes verbatim** (`0.5–24 step 0.5` and `0.1–0.9 step 0.1`)
  — per D6 these remain the only bounds on those two keys.
- Add all three to `applyDraft` (`~:795`): `cb`-free direct context setters
  `setNodeDimmingEnabled(d.nodeDimmingEnabled)` etc.

**(d) `hideIncompleteNodes` rebind.** The draft field already exists (`~:96`). Change
its sources:
- `fetchServerSettings` `~:494-495`: keep `updateField('hideIncompleteNodes', …)`
  (parse with `parseNodeDisplayBoolean`), **delete** `setShowIncompleteNodes(!hideIncomplete)`.
- `baseline` `~:721` and the props-sync effect `~:640`: read
  `hideIncompleteNodes` from `useSettings()` instead of `!showIncompleteNodes` from
  `useUI()`.
- `applyDraft` `~:834`: `setHideIncompleteNodes(d.hideIncompleteNodes)` instead of
  `setShowIncompleteNodes(!d.hideIncompleteNodes)`.
- Drop `setShowIncompleteNodes` from the `useUI()` destructure and from the
  `fetchServerSettings` dep array.

**(e) Hide two settings on MeshCore sources.**

```ts
const { sourceType } = useSource();
const isMeshCoreSource = sourceType === 'meshcore';
```

Wrap the `localStatsIntervalMinutes` block (`~:1936-1950`) and the
`nodeHopsCalculation` block (`~:1951-1965`) in `{!isMeshCoreSource && ( … )}`.

> **Reachability finding — confirmed by the coordinator, and escalated.** `SettingsTab`
> mounts at exactly two places: `GlobalSettingsPage.tsx:89` and `App.tsx:3640`.
> MeshCore sources route to `MeshCoreSourcePage` (`main.tsx:86-94`), which renders
> `MeshCorePage` and **never renders `SettingsTab`**. So MeshCore sources have **no
> Node Display settings UI at all** — which is itself a large part of what #4412 is
> asking for.
>
> **The coordinator has moved "add the MeshCore settings surface" into Phase 4's
> scope** (2026-07-29). Phase 3's obligation is unchanged and narrow: implement the
> hide-branch and **cover it with a unit test** that renders `SettingsTab mode="source"`
> inside `<SourceProvider sourceType="meshcore">` and asserts both inputs are absent
> (and present for `meshtastic_tcp`). That unit test is the branch's **only** exercise
> — §6 cannot browser-validate it, because there is no page to open. Do not attempt
> to add the mount point here; it is Phase 4's, and adding it would drag MeshCore
> node-age filtering forward with it.

**(f) Reset-to-defaults** (`~:1089`, `~:1105`): replace the literals `24` and
`'nodeinfo'` with `NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours` and
`NODE_DISPLAY_STRING_DEFAULTS.nodeHopsCalculation`. Note the `DELETE /api/settings`
call is unscoped and clears the global row only — **do not** try to make it
per-source in this phase; log it as a follow-up (§9).

### 4.5 `src/contexts/UIContext.tsx` (WP3)

Remove `showIncompleteNodes` and `setShowIncompleteNodes` from: `UIContextType`, the
`useState` (`~:101`), the `useMemo` value object, and the memo dep array. The
`// Default to showing incomplete nodes (true) …` comment goes with them.

### 4.6 `src/App.tsx` (WP3)

Only the three deletions in §3, plus removing the now-unused
`setShowIncompleteNodes` from the `useUI()` destructure (`~:550`). Nothing else.

### 4.7 `src/hooks/useSourceView.ts` (WP3)

- `~:151`: `const { maxNodeAgeHours, distanceUnit, showIncompleteNodes } = useSettings();`
- `~:158`: drop `showIncompleteNodes` from the `useUI()` destructure.
- `~:634-636` and `~:352`: **no change** — `maxNodeAgeHours` is now the active
  source's value automatically. Update the `// follow the global setting` comment to
  say "the source's setting".
- Dep arrays already list `showIncompleteNodes`; leave them alone.

### 4.8 `src/components/NodesTab.tsx` (WP5)

- `~:463`: drop `showIncompleteNodes` from the `useUI()` destructure; add it to the
  `useSettings()` destructure at `~:501`.
- Everything else — the age clamp (`~:506`), marker cutoff (`~:1567`), opacity
  (`~:108-134`, `~:1585-1591`), slider range (`~:2434-2436`) — **requires no change**.
  They read `maxNodeAgeHours` / `nodeDimming*` from `useSettings()`, which is now the
  active source's value. Verify by reading, do not edit for its own sake.
- Fix the stale comment at `~:2434` (`Ranges 1h–maxNodeAgeHours (settings)`) if it
  says "global" anywhere nearby.

### 4.9 `src/components/MapAnalysis/useAnalysisNodes.ts` (WP2)

Cross-source surface (it fans out over every source via `useDashboardSources()`).

- Delete `import { getActiveWindowHours } from '../../utils/activeWindowConfig'`.
- `const activeWindowHours = useMaxNodeAgeHoursAcross(sourceIds);`
  `const transportCutoff = transportCutoffSec(activeWindowHours);`
- Rewrite the `#4240` comment block (`~:78-83`): the objection was to depending on a
  **UI provider**; a TanStack hook alongside the two already in this file is fine.
  Say so, and reference D2/D3.

### 4.10 `src/pages/DashboardPage.tsx` + `src/components/Dashboard/DashboardMap.tsx` (WP5)

`DashboardPage` sits **outside** any `SourceProvider`, so `useSettings().maxNodeAgeHours`
(`~:56`) would now be the hardcoded default — a silent regression for anyone who set
a non-default value.

- `DashboardPage:56`: drop `maxNodeAgeHours` from the `useSettings()` destructure;
  add `const maxNodeAgeHours = useMaxNodeAgeHoursAcross(sourceIds);` using the ids
  already available from `useDashboardSources()`.
- `~:257` (`lookbackHours: maxNodeAgeHours`) and `~:1006`
  (`maxNodeAgeHours={maxNodeAgeHours}`) then pick up the cross-source value with no
  further change.
- `DashboardMap.tsx`: **no change** — it already takes `maxNodeAgeHours` as a prop
  (`~:84`, `~:160`). Only its test changes (R5).

### 4.11 `src/utils/mapAge.ts` (WP5)

Comment only: `the global \`maxNodeAgeHours\` setting` → `the source's
\`maxNodeAgeHours\` setting (per-source since #4412 Phase 3)`. No code change.

### 4.12 `src/hooks/useProcessedNodes.ts` and `src/hooks/useTraceroutePaths.tsx` (WP5)

**No code change.** `useProcessedNodes:170` reads `useSettings()`, which is now
source-scoped; `useTraceroutePaths` takes `maxNodeAgeHours` as a parameter. Both were
on the survey's consumer list; the survey predates D1. Read them, confirm, correct
any comment that says "global", and move on. Their test changes are R2 and KEEP
respectively.

### 4.13 `src/server/routes/settingsRoutes.ts` (WP1) — D5

In the `GET /api/settings?sourceId=` handler (`~:185-187`), where per-source values
are merged over globals: exclude `NODE_DISPLAY_SETTING_KEYS` from the global
back-fill, so a source with no seeded row returns those keys **absent** rather than
carrying the legacy global value.

```ts
// #4412 Phase 3 (D5): the ten Node Display keys have no runtime global
// fallback on the read path (getSettingForSource lost it in #2839/#2840), so
// back-filling them here would show a value the backend will never use.
```

~6 lines. This is the only backend change in Phase 3. Import the key list from
`src/constants/nodeDisplayDefaults.ts` (isomorphic — server import is fine).

---

## 5. Test plan

Standard Vitest suite only. **No standalone scripts.** New/changed route tests use
`createRouteTestApp()`.

### 5.1 New test files

| File | WP | Covers |
|---|---|---|
| `src/hooks/useNodeDisplaySettings.test.ts` | WP1 | `sourceId === null` returns defaults **and issues no request**; per-source parse via the shared parsers; `maxAcross([])` → 24; `useMaxNodeAgeHoursAcross` returns the max, not the first/last; a still-loading source does not drag the max down. |
| `src/utils/nodeDisplayStorage.test.ts` | WP1 | key namespacing; null-source read/write is inert; `purgeLegacyNodeDisplayLocal` removes exactly the ten bare keys and is idempotent; a throwing `localStorage` does not propagate. |
| `src/components/SettingsTab.nodeDisplay.perSource.test.tsx` | WP4 | **the phase's centrepiece.** (1) `mode="source"` inside `SourceProvider` GETs `/api/settings?sourceId=X`; (2) save issues **two** POSTs, the scoped one carrying exactly the ten keys and the unscoped one carrying none of them; (3) `mode="global"` issues **one** POST with all keys; (4) editing a dimming input marks the SaveBar dirty and saving clears it; (5) `sourceType="meshcore"` hides `localStatsIntervalMinutes` and `nodeHopsCalculation`, and shows them for `meshtastic_tcp`. |
| `src/contexts/SettingsContext.perSource.test.tsx` | WP2 | may be folded into R1's rewrite instead of a new file — implementer's choice, but the five assertions in §2.R1 must exist somewhere. |

### 5.2 Changed test files

R1–R6 in §2.2, plus the two KEEP-with-addition files in §2.1, plus the deletion in §2.3.

### 5.3 Backend

Extend `src/server/routes/settingsRoutes.perSource.test.ts` (harness-based already)
for D5 — see §2.1. No other backend test changes.

### 5.4 Gates

- Full Vitest suite green, `success: true` via the JSON reporter (not just
  `PASS (n) FAIL (0)` — see the rtk-summary gotcha).
- PostgreSQL + MySQL containers **not required** — Phase 3 adds no migration and no
  schema change. Confirm `numPendingTests` is unchanged from base if you run without
  them.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
- **Do not run `npm run lint:baseline`.** Two rules are live hazards here:
  `react-hooks/exhaustive-deps` (110 baselined sites; several of the effects you are
  editing carry targeted disables with reasons — preserve and update them, never
  auto-fix) and the raw-`fetch()` ban in `src/components/**` / `src/pages/**` (WP4
  and WP5 touch both trees — use `apiService` / `csrfFetch` / a TanStack hook).
- `npx tsc --noEmit` clean.

---

## 6. Browser validation plan

Phase 3 is the first phase with user-visible behaviour, so this is a gate, not a
nicety. App at `http://localhost:8080/meshmonitor`, login `admin` / `changeme`.
**The login endpoint is rate-limited — one attempt.** If it fails, query the SQLite
DB rather than retrying (note: the dev container has no `sqlite3` CLI).

**Setup.** Deploy from the worktree with the USB override:
`docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml up -d --build`
(copy `docker-compose.dev.local.yml` and `.env` from the main checkout; `--no-cache`
if the frontend looks stale). Verify the deployed bundle actually contains your
change via the DOM, not the build log.

**Preconditions.** Two sources must exist, and **both should have nodes** — a source
with an empty node table proves nothing about list filtering. If only one has nodes,
steps 5–8 validate on that one and steps 3–4/9 still prove isolation across the pair.

| # | Action | What it proves |
|---|---|---|
| 1 | Source A → Settings → Node Display → Max Age = **168**, Save. | — |
| 2 | Source B → Settings → Node Display → Max Age = **1**, Save. | — |
| 3 | **Reload twice.** A/Settings reads 168; B/Settings reads 1. | Scoped GET + **the dual loader is gone**. Reload twice — the old race only lost sometimes. |
| 4 | DevTools → Network on a save: exactly **two** POSTs — `POST /api/settings` and `POST /api/settings?sourceId=<id>`. Inspect both bodies. | The split. Scoped body has exactly the ten keys; unscoped body has none of them. |
| 5 | A → Nodes: record list count and marker count. B → Nodes: count must be **strictly smaller**. | Per-source age filtering on both the list and the map. |
| 6 | Switch back to A **without reloading**. Count returns to A's larger number. | Refetch on `sourceId` change — not mount-once. This is the assertion the old `[]` dep array would fail. |
| 7 | Map Features age slider: max reads **168h/7d** on A and **1h** on B. | `NodesTab` slider range follows the per-source value. |
| 8 | With B selected, open Map Analysis (cross-source). Nodes A can see are still classified as active. | D3 most-permissive rule — B's 1h window must not starve the cross-source view. |
| 9 | Toggle **Hide Incomplete Nodes** ON for A only, Save, reload. A hides them; B still shows them. | `hideIncompleteNodes` left `UIContext` cleanly. |
| 10 | Enable node dimming on A, startHours 0.5. SaveBar goes dirty on edit, clean after Save. Reload → still on. B's dimming stays off. | Dimming trio moved onto the draft with dirty-tracking intact. |
| 11 | Dashboard (cross-source landing page) with A=168, B=1: A's older nodes still render. | D3 on the Dashboard; guards the `DashboardPage` regression in §4.10. |
| 12 | Console throughout: zero new errors/warnings; specifically no "Maximum update depth exceeded". | Render-loop guard for the new `[baseUrl, sourceId]` effect and the re-seed. |

Do **not** send test messages for this validation — none of it needs one. If you do,
`gauntlet` channel only, never Primary.

**Not browser-validatable in this phase:** the MeshCore hide-branch from §4.4(e).
MeshCore sources render `MeshCorePage`, which never mounts `SettingsTab`, so there is
no page on which to observe the two hidden inputs. Its unit test is the whole of its
coverage. Phase 4 owns the surface and therefore owns validating it. Do not mark WP6
incomplete for the absence of this step, and do not improvise a mount point to
create one.

---

## 7. Work packages

Six packages. Each is sized for one Sonnet agent. Ordering is a hard dependency chain
where stated — WP3→WP4→WP5 will not typecheck out of order.

### WP1 — Shared hooks, storage helpers, and the GET-merge fix
**Depends on:** nothing. **Blocks:** WP2, WP4, WP5.
**Files owned:**
`src/hooks/useNodeDisplaySettings.ts` (new) ·
`src/hooks/useNodeDisplaySettings.test.ts` (new) ·
`src/utils/nodeDisplayStorage.ts` (new) ·
`src/utils/nodeDisplayStorage.test.ts` (new) ·
`src/server/routes/settingsRoutes.ts` ·
`src/server/routes/settingsRoutes.perSource.test.ts`

**Acceptance:**
- `useNodeDisplaySettings(null)` returns the ten defaults and **issues zero network
  requests** (assert on the query's `enabled`, not just the result).
- `useMaxNodeAgeHoursAcross` returns the maximum; empty/loading → default.
- Zero hardcoded defaults — every value traces to `nodeDisplayDefaults.ts`.
- `GET /api/settings?sourceId=X` for a source with no seeded Node Display rows omits
  those ten keys while still back-filling other global keys (harness test).
- Full suite green; `lint:ci` clean.

### WP2 — SettingsContext goes per-source; `activeWindowConfig` deleted
**Depends on:** WP1. **Blocks:** WP3, WP4, WP5.
**Files owned:**
`src/contexts/SettingsContext.tsx` ·
`src/contexts/SettingsContext.test.tsx` (R1 rewrite + the localStorage-suite deletion) ·
`src/utils/activeWindowConfig.ts` (**deleted**) ·
`src/components/MapAnalysis/useAnalysisNodes.ts` (+ its test if present)

**Acceptance:**
- `grep -rn activeWindowConfig src` returns nothing.
- Provider inside `SourceProvider` fetches with `?sourceId=`; deps `[baseUrl, sourceId]`;
  A→B switch refetches **and** synchronously re-seeds before the fetch resolves.
- Outside a `SourceProvider`, the ten equal the hardcoded defaults and no bare-key
  localStorage write happens.
- `hideIncompleteNodes` + `setHideIncompleteNodes` + derived `showIncompleteNodes`
  on the context value and type.
- **No `QueryClientProvider` requirement added to `SettingsProvider`** — verify by
  running the full component-test suite, not just this file.
- All five §2.R1 assertions exist.

### WP3 — `hideIncompleteNodes` leaves `UIContext`; App.tsx dual loader reconciled
**Depends on:** WP2. **Blocks:** WP4, WP5.
**Files owned:**
`src/contexts/UIContext.tsx` ·
`src/App.tsx` ·
`src/hooks/useSourceView.ts` ·
`src/hooks/useSourceView.test.ts` (R3) ·
`src/components/MessagesTab.txDisabled.test.tsx` (R4)

**Acceptance:**
- `grep -n 'showIncompleteNodes' src/contexts/UIContext.tsx` → nothing.
- `grep -n 'settings.maxNodeAgeHours\|settings.inactiveNode\|settings.hideIncompleteNodes' src/App.tsx` → nothing.
- `useSourceView.test.ts`'s `useUI` mock no longer supplies `showIncompleteNodes`, and
  the incomplete-node filter test still passes.
- App.tsx's `initializeApp` is otherwise byte-identical (diff review: only the three
  blocks removed).

### WP4 — SettingsTab (all four SettingsTab work items)
**Depends on:** WP2, WP3. **Blocks:** nothing.
**Files owned:**
`src/components/SettingsTab.tsx` ·
`src/components/SettingsTab.elevation.test.tsx` (KEEP + the single-POST guard) ·
`src/components/SettingsTab.nodeDisplay.perSource.test.tsx` (new) ·
`src/server/server.settings-persistence.test.ts` (R6) ·
`src/pages/GlobalSettingsPage.tsx` (only if a prop signature changes)

**Acceptance:**
- `mode="source"` GETs with `?sourceId=`; `mode="global"` GETs unscoped.
- Save in source mode → exactly two POSTs, correctly partitioned; save in global mode
  → exactly one POST, byte-identical body to today's.
- The `const settings = { … };` literal still matches
  `/const handleSave[\s\S]*?const settings\s*=\s*\{([\s\S]*?)\};/` and still contains
  all ten keys — `server.settings-persistence.test.ts` passes **and** its new
  partition test passes.
- `initialNodeDimmingSettings` and `nodeDimmingChanged` are gone; the dimming trio
  round-trips through the draft with working dirty-tracking.
- `localStatsIntervalMinutes` and `nodeHopsCalculation` are absent for
  `sourceType="meshcore"` and present for `meshtastic_tcp` (unit-tested).
- No new `react-hooks/exhaustive-deps` baseline growth; existing targeted disables
  preserved with their reasons updated where the reason changed.

### WP5 — Cross-source consumers + comment corrections
**Depends on:** WP1, WP2, WP3.
**Files owned:**
`src/pages/DashboardPage.tsx` ·
`src/components/Dashboard/DashboardMap.test.tsx` (R5) ·
`src/components/NodesTab.tsx` ·
`src/hooks/useProcessedNodes.ts` (comment only) ·
`src/hooks/useProcessedNodes.test.ts` (R2) ·
`src/hooks/useTraceroutePaths.tsx` (comment only) ·
`src/utils/mapAge.ts` (comment only) ·
`src/services/database.extended.test.ts` (the §2.3 deletion)

**Acceptance:**
- **The `DashboardPage` regression is closed and named.** `DashboardPage` no longer
  reads `maxNodeAgeHours` from `useSettings()`, and a test asserts that with a
  configured non-default value on at least one source the Dashboard uses it rather
  than the hardcoded 24. This criterion is **not droppable** — the coordinator ruled
  on 2026-07-29 that a configured 72 silently becoming 24, with no error and no
  failing test, is the exact bug class this epic keeps surfacing. If WP5 must be
  trimmed for any reason, trim the comment corrections, never this.
- `NodesTab` reads `showIncompleteNodes` from `useSettings()`; nothing else in that
  file changed (diff review).
- **Read-and-report, do not churn.** For each of `useProcessedNodes.ts`,
  `useTraceroutePaths.tsx`, `mapAge.ts`, and NodesTab's age-clamp / marker-cutoff /
  opacity / slider sites, the PR body states explicitly: *verified by reading —
  needed no change* (or names the change and why). A site that turns out to read a
  hardcoded default instead of the setting is the thing this sweep exists to catch;
  a diff that edits these files to look thorough is a failure of the criterion, not
  a satisfaction of it.
- `useProcessedNodes.test.ts` has the two-source test from R2.
- `DashboardMap.test.tsx` has the most-permissive case and its inverse.
- The three `database.extended.test.ts` max-age tests are gone, and the replacement
  coverage in `database.maxNodeAge.perSource.test.ts` was **verified to cover all
  three call sites before the deletion** (state which, in the PR body).

### WP6 — Browser validation + epic doc
**Depends on:** WP1–WP5 merged into the branch.
**Files owned:**
`docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` (Phase 3 checkbox +
deviations log) · this spec (status update only).

**Acceptance:** all 12 steps in §6 executed with evidence (screenshots / network
captures); every deviation in §10 plus anything new recorded in the epic's deviations
log; Phase 3 checkbox flipped.

### File ownership table — no file written by two packages

| File | WP |
|---|---|
| `src/hooks/useNodeDisplaySettings.ts` (+test) | WP1 |
| `src/utils/nodeDisplayStorage.ts` (+test) | WP1 |
| `src/server/routes/settingsRoutes.ts` | WP1 |
| `src/server/routes/settingsRoutes.perSource.test.ts` | WP1 |
| `src/contexts/SettingsContext.tsx` | WP2 |
| `src/contexts/SettingsContext.test.tsx` | WP2 |
| `src/utils/activeWindowConfig.ts` (delete) | WP2 |
| `src/components/MapAnalysis/useAnalysisNodes.ts` | WP2 |
| `src/contexts/UIContext.tsx` | WP3 |
| `src/App.tsx` | WP3 |
| `src/hooks/useSourceView.ts` (+test) | WP3 |
| `src/components/MessagesTab.txDisabled.test.tsx` | WP3 |
| `src/components/SettingsTab.tsx` | WP4 |
| `src/components/SettingsTab.elevation.test.tsx` | WP4 |
| `src/components/SettingsTab.nodeDisplay.perSource.test.tsx` | WP4 |
| `src/server/server.settings-persistence.test.ts` | WP4 |
| `src/pages/GlobalSettingsPage.tsx` | WP4 |
| `src/pages/DashboardPage.tsx` | WP5 |
| `src/components/Dashboard/DashboardMap.test.tsx` | WP5 |
| `src/components/NodesTab.tsx` | WP5 |
| `src/hooks/useProcessedNodes.ts` (+test) | WP5 |
| `src/hooks/useTraceroutePaths.tsx` | WP5 |
| `src/utils/mapAge.ts` | WP5 |
| `src/services/database.extended.test.ts` | WP5 |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` | WP6 |

---

## 8. Explicitly out of scope

- Converting any other `SOURCE_SECTIONS` group to per-source.
- MeshCore node-age filtering itself (Phase 4) — including adding a Node Display
  surface to `MeshCoreSourcePage`.
- Making `DELETE /api/settings` (reset-to-defaults) per-source. See §9.
- Per-node-per-source age windows on the Dashboard/Map Analysis. D3's
  most-permissive rule is the deliberate simplification. See §9.
- Adding `nodeDimmingStartHours` / `nodeDimmingMinOpacity` to `NODE_DISPLAY_RANGES`
  (D6) or adding server-side validation for them.
- Anything in the epic's Phase 5 or Phase 6 lists.

---

## 9. Risks — coordinator rulings (2026-07-29)

The spec was approved as written. All eight items below were ruled on; none remain
open. They are kept because the *reasoning* is what implementers need, not just the
verdict.

1. **D5 (the ~6-line backend change) — RULED IN SCOPE.** Without it, any source
   created after migration 131 ran displays the legacy global value on the Settings
   page while the backend behaves as the hardcoded default. A phase whose purpose is
   a correct per-source UI cannot ship a UI that shows the wrong number. "Frontend-only"
   was shorthand for "not another read-conversion sweep." **Do it (WP1).**

2. **Deleting `activeWindowConfig.ts` — APPROVED.** One reader, one writer; the
   deletion is smaller and strictly safer than a keyed registry, which would be stale
   for any source whose provider hasn't mounted this page-load (and Map Analysis is
   often the first page loaded). The rejected fallback, recorded so nobody re-proposes
   it: a `Map<sourceId, hours>` plus `getMaxActiveWindowHours()` plus an explicit
   seeding path from `useAnalysisNodes` — more code, more failure modes.

3. **MeshCore hide-branch — CONFIRMED UNREACHABLE, and escalated.** Coordinator
   verified the two `SettingsTab` mount sites independently. **"Add the MeshCore
   settings surface" is now in Phase 4's scope**, and Phase 3 explicitly *cannot*
   browser-validate this branch. Keep the specced approach: implement + unit-test.
   See §4.4(e).

4. **The survey's consumer list mostly resolves to "no change" — HOLD THE LINE.**
   `useProcessedNodes`, `useTraceroutePaths`, `mapAge`, and NodesTab's
   age/opacity/slider logic already read through `useSettings()` or take the value as
   a parameter, so scoping the provider (D1) fixes them for free. WP5 must **verify
   each site by reading and report which needed nothing**, rather than manufacturing
   churn to look thorough. A site that reads a hardcoded `24` instead is exactly what
   the reading catches and what a cosmetic diff would bury. Now an explicit WP5
   acceptance criterion.

5. **`DashboardPage` — DOES NOT GET DESCOPED.** It is the one place where a naive
   Phase 3 (scope the provider, change nothing else) takes an admin's configured 72
   down to 24 with no error and no test failure. Now a named, non-droppable WP5
   acceptance criterion; §4.10 has the change.

6. **`SettingsProvider` must not gain a TanStack dependency — AGREED.** It renders
   without a `QueryClientProvider` across many component tests. WP2's acceptance
   already gates on the full component suite, which the coordinator confirmed is the
   right check.

7. **WP4 stays whole — AGREED.** ~2,700 lines carrying four work items in one package
   is deliberate; Phase 1 proved the shape on `settingsRoutes.ts`. `SettingsTab.tsx`
   cannot be co-owned. If WP4 runs long the seam is **sequential commits inside the
   package** — (a)+(b) scoped GET and split save, then (c)–(f) — never two packages.

8. **The dimming `min`/`max` bounds (`0.5–24`, `0.1–0.9`) exist only in JSX.** Per D6
   nothing else validates them; a direct API write bypasses them entirely. Already
   true before Phase 3 — now written down rather than fixed, because fixing it means
   adding server-side validation, which is a product decision and not this phase's.

---

## 10. Deviations from the epic's Phase 3 description

Record these in the epic's deviations log at WP6.

1. **"Replace single-value state with per-source-keyed state" → source-aware provider,
   not keyed state (D1).** The keying lives in one query hook used by two cross-source
   surfaces. Justified against `AutomationContext`, which is the existing precedent
   and does exactly this.
2. **"make `activeWindowConfig.ts` source-keyed" → delete it (D2).**
3. **"Phase 3 adds theirs from the SettingsTab inputs" (`NODE_DISPLAY_RANGES` for the
   two dimming numerics) → deliberately NOT done, and not deferred either (D6).**
   Adding entries would make `parseNodeDisplayNumber` clamp **already-stored**
   out-of-range values to the default with no compensating server-side validation —
   a silent behaviour change on existing installs. The JSX bounds remain the only
   constraint, as before. The coordinator ratified this on 2026-07-29, superseding
   the guidance previously given to the Phase 2 reviewer. **Record it as settled so a
   future phase does not "finish the job."**
4. **One backend file changed (D5)**, in a phase described as frontend-only — ruled in
   scope by the coordinator, because the alternative is a Settings page that displays
   a value the backend will never use.
5. **`useProcessedNodes.ts`, `useTraceroutePaths.tsx`, `mapAge.ts`, and most of
   `NodesTab.tsx` required no code change** — the survey's consumer list predates the
   D1 design. WP5 reports the verification per site rather than editing them.
6. **Scope moved out: the MeshCore Node Display *surface* is now Phase 4's.**
   Discovered here that `SettingsTab` mounts only at `GlobalSettingsPage.tsx:89` and
   `App.tsx:3640`, so MeshCore sources have no Node Display UI at all — a material
   part of what #4412 asks for. Phase 3 ships the hide-branch plus its unit test;
   Phase 4 adds the mount point and validates both.
