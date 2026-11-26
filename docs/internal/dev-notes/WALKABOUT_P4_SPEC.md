# Walkabout P4 — "Repeaters only" map chip (#5891)

Last phase of `WALKABOUT_COVERAGE_EPIC.md`. Issue #5891 part 3: a one-click map
filter that shows only repeater-class nodes, for both protocols.

**Mesh impact: none.** Display only. No packets, no timers, no notifications, no
server calls, no schema change.

## 1. Reuse inventory

| Need | Reuse | Where |
|------|-------|-------|
| Node classification | `getNodeTypeCategory`, `isMeshCoreNode`, `CategorizableNode` | `src/utils/nodeTypeCategory.ts` |
| Meshtastic infra roles | `isInfrastructureRole` / `INFRASTRUCTURE_ROLES` (ROUTER 2, ROUTER_CLIENT 3, REPEATER 4, ROUTER_LATE 11, CLIENT_BASE 12) | `src/utils/nodeRoleMarker.ts` |
| Pattern for a role predicate shared by all maps | `markerRoleProps()` (same file, #6008) | `nodeTypeCategory.ts` |
| Toggle state + persistence | `showLocalMarkers` / `showDucting` in MapContext: `useState` seeded from localStorage in try/catch, setter writes back in try/catch, no server field | `src/contexts/MapContext.tsx` |
| MeshCoreMap fallback when no provider | `mapContext?.x ?? localX` block | `src/components/MeshCore/MeshCoreMap.tsx` ~L296 |
| Hide-a-class-of-nodes stage | Aircraft "Hide" (#5364/#5365) | NodesTab `passesMapFilters` (~L1728); DashboardMap `nodesWithTruePos` (~L462) |
| MeshCore marker filter stage | `visibleContacts` (node-type filter + #5578 positionless) | MeshCoreMap ~L439 |
| One-tap header button look | `.map-controls-fit-btn` (header, reachable while panel collapsed) | NodesTab ~L2742, DashboardMap ~L1271 |
| Icon | `UiIcon name="repeater"` (lucide `Radio`) | `src/components/icons/UiIcon.tsx` |
| Wiring guard template | `mapAircraftMode.wiring.test.ts` (source scan of every panel) | `src/components/map/` |
| Behaviour test template | DashboardMap aircraft Hide tests (`mocks.mapContext.aircraftDisplayMode = 'hide'`) | `DashboardMap.test.tsx` ~L1014 |

There are **three** Map Features panels, not two: NodesTab (per-source
Meshtastic), DashboardMap (unified + per-source, both protocols) and
MeshCoreMapControls (per-source MeshCore, already hosts `DuctingControl`,
`PacketFlightsControl`, local markers). The chip goes in all three; one shared
component, one shared state, one predicate (parity rule).

Map Analysis has its own `NodeTypeFilterControl` and EmbedMap is read-only for
embeds; both are out of scope.

## 2. Decisions

**Which nodes count.** `isRepeaterClassNode(node)`:
- MeshCore: category `repeater` (advType 2) or `roomServer` (advType 3). The epic
  already fixed this; it matches `isMeshCoreInfrastructureAdvType` and the P1
  relay-candidate set.
- Meshtastic: `isInfrastructureRole(node.user?.role ?? node.role)`, which is
  ROUTER, ROUTER_LATE, deprecated ROUTER_CLIENT and REPEATER, and CLIENT_BASE.
  Reusing the existing set means the chip, the tower/base glyph and the server
  airtime cutoff all agree. CLIENT_BASE is the one judgement call (Q1).
- Missing / garbage role: not a repeater (Meshtastic default is CLIENT).

**Exemptions.** The local node always stays (you need to see yourself against
the repeaters; MeshCoreMap already exempts `isLocal` from its #5578 filter).
Favourites are **not** exempt: "repeaters only" must mean that, and a favourite
client left on the map reads as a bug. (Aircraft Hide exempts favourites; this
chip differs on purpose.)

**State and persistence.** `showRepeatersOnly: boolean` + `setShowRepeatersOnly`
in MapContext, default `false`, localStorage key `showRepeatersOnly`, read and
write inside try/catch — the `showLocalMarkers` pattern exactly. No
`user_map_preferences` column, no migration, no `VALID_SETTINGS_KEYS` entry
(this is not a setting). One key for all three panels, like `showLocalMarkers`.
A filter that hides most nodes survives reload, so the chip must show its
active state in the panel **header**, which stays visible when the panel is
collapsed.

**What else it filters.** Nothing new. Insert the predicate at the stage each
map already uses to hide a node class, and let links, traceroutes, trails,
packet flights, clusters, precision offsets and 3D follow that surface's
existing rules:
- NodesTab: in `passesMapFilters`, next to aircraft Hide. Feeds
  `visibleMapNodes` → markers, 3D (`visible3DNodeNums`), packet flights,
  aircraft trails; 2D neighbour lines are already gated on visible nodes.
- DashboardMap: in the `nodesWithTruePos` filter, next to aircraft Hide, so
  precision-cell spreading runs over repeaters only. Add `showRepeatersOnly` to
  that memo's dependency array (L487). Traceroute segments drop with their
  markers (#4162); neighbour lines fall back to embedded coordinates (#4042),
  the same as aircraft Hide today.
- MeshCoreMap: in `visibleContacts`, ANDed with the node-type filter. Paths and
  neighbour lines keep using `positioned`, matching that map's type filter.
  Clusters build from the visible set, so they follow.
- Fit-all keeps its current input (pre-filter `nodesWithPosition` in NodesTab).
  No count line; the node list is untouched.

**UI.** A pill button in each panel header, beside the fit button: `UiIcon
repeater` + short label, `aria-pressed`, `title`/`aria-label` "Show only
repeaters and routers", `onMouseDown` stopPropagation like the fit button.
Active state uses `var(--color-*)` role tokens with no fallback, in a CSS module.
Not disabled in 3D (the 3D surface follows `visibleMapNodes`).

## 3. File-by-file changes

1. `src/utils/nodeTypeCategory.ts` — add `isRepeaterClassNode(node:
   CategorizableNode): boolean` beside `markerRoleProps`; doc comment names both
   protocols' sets. No new imports (`isInfrastructureRole` is already imported).
2. `src/contexts/MapContext.tsx` — add `showRepeatersOnly` / `setShowRepeatersOnly`
   to the interface, state (try/catch read, `=== 'true'`), setter (try/catch
   write), and both value objects (~L792 and ~L851, where `showLocalMarkers` is
   listed).
3. `src/components/map/MapRepeatersOnlyToggle.tsx` + `.module.css` (new) — props
   `{ active: boolean; onChange: (v: boolean) => void }`. Component file exports
   only the component (react-refresh ratchet).
4. `src/components/NodesTab.tsx` — pull the pair from `useMapContext()`; render the
   toggle in `.map-controls-header` after the fit button; in `passesMapFilters`
   add `if (showRepeatersOnly && node.user?.id !== currentNodeId &&
   !isRepeaterClassNode(node)) return false;`.
5. `src/components/Dashboard/DashboardMap.tsx` — same pull and header placement;
   in `nodesWithTruePos` drop `!e.node.isLocal && !isRepeaterClassNode(e.node)`
   when on (aged-out aircraft branch: apply the chip there too); add the dep.
6. `src/components/MeshCore/MeshCoreMap.tsx` — `mapContext?.showRepeatersOnly ??
   local` fallback pair; add to `visibleContacts` predicate as
   `(c.isLocal === true || !showRepeatersOnly || isRepeaterClassNode({ advType:
   c.advType, isMeshCore: true }))`; add dep; pass the pair to the controls.
7. `src/components/MeshCore/MeshCoreMapControls.tsx` — two new props; wrap the
   "Features" title in a `.map-controls-header` div with the toggle.
8. `public/locales/en.json` — flat keys `map.repeatersOnly` ("Repeaters") and
   `map.repeatersOnlyTitle` ("Show only repeaters and routers").
9. Docs: add the chip to the user docs for the map (the walkabout/coverage
   feature page from P1–P3 is the natural home; `docs/faq.md` mentions Map
   Features), and tick P4 in the epic doc.

## 4. Test plan (standard Vitest; small runs, `--maxWorkers=2`)

- `src/utils/nodeTypeCategory.test.ts` — table for `isRepeaterClassNode`:
  Meshtastic roles 2, 3, 4, 11, 12 true; 0, 1, 5–10 false; string `'2'` true;
  missing role false; top-level `role` honoured. MeshCore advType 2, 3 true;
  1, 4, null false; a MeshCore node with `user.role: 2` and advType 1 is false.
- `src/contexts/MapContext.test.tsx` — default false; setter persists; seeds from
  `'true'`; a throwing localStorage does not break read or write.
- `src/components/map/MapRepeatersOnlyToggle.test.tsx` — `aria-pressed` follows
  `active`; click calls `onChange(!active)`; renders an svg icon, no emoji.
- `src/components/map/mapRepeatersOnly.wiring.test.ts` (new, modeled on
  `mapAircraftMode.wiring.test.ts`) — each of NodesTab, DashboardMap and
  MeshCoreMapControls renders `<MapRepeatersOnlyToggle`; each of NodesTab,
  DashboardMap and MeshCoreMap references `isRepeaterClassNode`. This is the
  #5177 guard for the panel that has no DOM harness (NodesTab).
- `src/components/Dashboard/DashboardMap.test.tsx` — add `showRepeatersOnly` to the
  mocked context; with it on and nodes {ROUTER, CLIENT, CLIENT favourite, local
  CLIENT, MeshCore advType 2, MeshCore advType 1}, only ROUTER, MeshCore 2 and
  the local node get markers; clicking the header toggle calls the setter.
- `src/components/MeshCore/MeshCoreMap.sharedShell.test.tsx` — toggle on: a
  companion contact loses its marker, a repeater and the local contact keep
  theirs.
- `npm run lint:ci` (filter `.claude/worktrees`) and the semantic-token test
  (`src/styles/semanticTokens.test.ts` — new CSS must use defined `--color-*` tokens).
- Browser check on the dev container: chip on each of the three maps, with both
  a Meshtastic and a MeshCore source; reload keeps the state; collapsed panel
  still shows the active chip. Screenshot for the PR.

## 5. Work packages

One WP for Sonnet; it is small and every file touches the same state.

- **WP1** — items 1–9 above plus all tests in §4. Order: predicate + its test →
  MapContext + test → toggle component + test → three panels → wiring guard →
  DashboardMap / MeshCoreMap behaviour tests → en.json → docs.

## 6. Open questions

- **Q1. Does CLIENT_BASE count?** It rebroadcasts like ROUTER_LATE, but only for
  its owner's favourited nodes, so a walker cannot rely on it. *Recommend: yes,
  include it* by reusing `isInfrastructureRole` as is; the project already
  calls it infrastructure (#4822), draws it with an infrastructure glyph, and
  the server airtime cutoff uses the same set. Splitting it out here would make
  the chip disagree with the marker the user sees. If the maintainer wants it
  out, exclude role 12 inside `isRepeaterClassNode` only; do not edit
  `INFRASTRUCTURE_ROLES`.

### Resolutions (orchestrator, 2026-11-25) — binding

- **Q1:** CLIENT_BASE (role 12) counts — reuse `isInfrastructureRole` unchanged, so the chip, the tower glyph and the airtime cutoff agree. Noted in the PR as easy to revert.
