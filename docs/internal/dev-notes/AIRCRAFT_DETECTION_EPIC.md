# Likely-Aircraft Detection Epic (#5364, #5365)

## Goal

Recognise Meshtastic nodes that are probably airborne (aircraft, balloons,
drones) and handle them sensibly:
- keep them out of Auto-Favorite (#5364);
- show them distinctly on the map, and let the user filter them (#5365);
- age out stale ones;
- draw their flight paths.

A mountaintop repeater must **not** be treated as an aircraft.

## Decisions (user, 2026-09-26)

- **Classifier:** height above ground (AGL) = `nodes.altitude` (m MSL) − DEM ground
  elevation at the node's position (`ElevationProvider.sample`).
  - A node is **likely aircraft** when AGL > threshold. The default threshold is **500 m**, configurable.
  - If elevation is unavailable (disabled, offline, or the fetch fails), fall back to
    MSL altitude > **5000 m** (configurable).
  - Movement confirms the flag and drives reclassification; a node that is still heard but stationary becomes a fixed station (P2).
- **Map default: mark.** Likely-aircraft nodes get an aircraft badge on their normal
  marker, so the marker can still be clicked through to the node.
  - A Show / Mark / Hide control goes in **both** Map Features panels
    (NodesTab and DashboardMap), following the `MapAgeFilterControl` shared-component precedent.
- **Auto-Favorite:** the exclusion is **on by default** whenever Auto-Favorite is on.
  - Likely aircraft are never auto-added.
  - Auto-added ones are removed after two consecutive sweeps (see Phase 1 refinements).
  - User favourites and locked favourites are never touched.
- **Automation event:** a "became likely aircraft" trigger, modelled on
  `becameMobile`. It fires once per transition into the likely-aircraft state.
- **Age-out (P2):** off by default, per source. When enabled, the action is
  **Ignore** (reversible, and reviewable via "show aged-out"). Delete is an
  explicit opt-in.
- **Phase 1 refinements (user, 2026-09-26):** the detection settings live in Settings → Node Display (per-source), and Auto-Favorite has its own "Exclude likely aircraft" switch, on by default, that only applies while detection is on.
  - An auto-added node is removed only after being flagged at **two consecutive sweeps** at least 45 min apart. Strikes are persisted per source, so a restart or settings save can't reset them.
  - Hide mode keeps favourites visible, MQTT sources are classified, the startup backfill runs, and the hysteresis is fixed at max(50 m, 10%).
- **Out of scope:** ADS-B / OpenSky cross-referencing, split into #5374.
- **Mesh impact:** the feature itself sends nothing. The automation event only
  feeds automations, which carry their own existing rate limits and cooldowns.
  - Elevation lookups are outbound HTTP tile fetches (AWS Terrarium by default,
    cached). They are not mesh traffic, and they respect `elevationEnabled`.

## Phases

### Phase 1: classifier, Auto-Favorite exclusion, map badge and filter
- [x] Server-computed per-node classification, persisted per source:
  - AGL, the ground elevation used, and the classification basis (`agl` / `msl` / `unknown`).
  - Recomputed on position updates; the tile cache is reused.
- [x] Per-source settings: enable, AGL threshold (default 500 m), MSL fallback (default 5000 m).
- [x] Auto-Favorite: an add gate, plus a sweep removal reason that uses the `autoFavoriteNodes` provenance list.
- [x] Map: an aircraft badge via `createNodeIcon` (following the isUnmessagable pattern, and included in `iconSig`), and a Show / Mark / Hide control in both Map Features panels.
- [x] Automation trigger "became likely aircraft".

**Exit:** the classifier is unit-tested (AGL, MSL fallback, elevation unavailable, mountaintop case), per-source isolation is tested, and the badge and filter are verified in both panels in the browser.

### Phase 2: age-out and reclassify as fixed
- [ ] A per-source age-out service modelled on `autoDeleteByDistance`: likely aircraft + position older than 24 h + not heard recently → Ignore (or Delete).
- [ ] Reclassify as fixed: a likely-aircraft node that is still heard and has been stationary for 24 h / N fixes stops being flagged.
- [ ] A "Show aged-out" review toggle.

**Exit:** the timer persists across restarts, and saving settings does not re-arm it (see the CLAUDE.md mesh checklist). Favourites and the local node are protected.

### Phase 3: flight trails
- [ ] Trails for likely-aircraft nodes, reusing `PositionTrailsLayer` and the position history, in both map panels.

**Exit:** trails render for moving suspects and expire with the retention window.

## Status log

- 2026-09-26: epic planned; ADS-B split to #5374; Phase 1 started on `feature/aircraft-p1-classifier`.
- 2026-09-26: Phase 1 spec approved (AIRCRAFT_P1_SPEC.md; migrations 175–176). Follow-up found: every reconnect schedules an extra hourly Auto-Favorite sweep timer (pre-existing; the strike rule's 45 min gap makes it harmless for this feature).
- 2026-09-26: Phase 1 validated in the browser on the dev container. Badge, popup line and Show / Mark / Hide work in both map panels; settings and the Auto-Favorite switch render. Two fixes from validation: the Dashboard hint counted flagged nodes outside the age window ("19 on the map" with none drawn), and the Node Display help text ran two sentences together. PR opened.
