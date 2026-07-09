# Epic — MeshCore Auto-Pathfinding Target Filtering (#4024)

**Goal:** Let users restrict MeshCore Auto-Pathfinding to a chosen subset of
companions/repeaters instead of running `discover_path`/`get_neighbours`
against every contact each cycle. Model the filtering UX/architecture on the
existing Meshtastic **Auto-Traceroute** filter panel.

Fully backward compatible: filtering is opt-in; with the master toggle off the
scheduler behaves exactly as it does today (all companions + all repeaters).

## Reporter / maintainer decisions (interview)

- **Filter richness:** Full Auto-Traceroute parity — a specific-contact
  allowlist **plus** independently-toggleable attribute filters, with a live
  "matching targets" preview.
- **Storage:** Dedicated per-source table for the allowlist (mirrors
  `auto_traceroute_nodes`); attribute filters + their enable flags live in the
  settings KV store (mirrors the Auto-Traceroute hybrid).
- **Attribute filters (all four):**
  - **Name regex** — match `advName`/`name` (RE2-safe via `compileUserRegex`). OR-union.
  - **Last heard** — contacts seen within N hours (`lastSeen`/`lastAdvert`). AND pre-filter.
  - **Hop range (pathLen)** — cached-route hop-count within min–max (`pathLen`; null = unknown/flood). AND pre-filter.
  - **Signal (RSSI/SNR)** — MeshCore-specific extra: contacts above an RSSI/SNR threshold. AND pre-filter.
- **Single shared allowlist** across both companions and repeaters (reporter
  confirmed on the issue: path-discovery targets companions, neighbours targets
  repeaters, so one shared list unambiguously covers both).
- **Delivery:** Single phase / one PR.

### Filter semantics (mirror Auto-Traceroute `getNodeNeedingTracerouteAsync`)

Within each device-type set already selected by the existing
`pathDiscoveryEnabled` (companions) / `neighborsEnabled` (repeaters) toggles:

1. **AND pre-filters** narrow the pool first: last-heard, hop-range, signal.
2. **OR-union** identity filters: a contact passes if it matches ANY enabled
   OR sub-filter — specific-contact allowlist, name-regex. If the master
   filter is enabled but no OR sub-filter is configured, all survivors of the
   AND pre-filters pass (same `hasAnyFilter === false` behavior as
   Auto-Traceroute).
3. Master `filterEnabled` off → no filtering (current behavior).

(The architect finalizes the exact AND/OR classification in the spec; the
above is the recommended mapping and must be justified if changed.)

## Phase 1 (only phase) — Target filtering, end to end

**Exit criteria:**
- New per-source table + repository for the specific-contact allowlist.
- Settings keys for the master toggle, each attribute filter's value, and each
  attribute filter's independent enable flag — all registered in
  `VALID_SETTINGS_KEYS`.
- Aggregation getter/setter (one call returns the full filter config for a
  source; one call persists it) mirroring
  `get/setTracerouteFilterSettingsAsync`.
- `meshcoreManager.executeRun()` applies the AND/OR filter logic before
  building `targets`.
- GET/POST API routes to read/write the full filter config (shared envelope,
  `requirePermission('automation', …)`, strict validation incl. RE2 regex).
- Filter-panel UI in `MeshCoreAutomationsView.tsx`: master toggle, searchable
  contact checklist (Select-all/Deselect-all + count badge), attribute-filter
  sections each with its own enable checkbox, and a debounced live "matching
  targets" preview mirroring the backend logic. Wired to `useSaveBar`.
- Full backend test coverage: manager filter-logic test (incl. "selected
  contact no longer exists"), a `*.perSource.test.ts` for source isolation of
  the allowlist table, and route tests via `createRouteTestApp()`.
- Migration count test updated; all three backends covered by the migration.
- `npm run typecheck` clean; full Vitest suite green; `npm run lint:ci` exit 0.
- Browser-validated against the dev container.

**Status:** [x] COMPLETE — implemented across 4 work packages (WP1 DB/migration/repo/aggregation, WP2 manager filter logic, WP3 API routes, WP4 frontend panel) on branch `feature/meshcore-pathfinding-target-filter`.

### Deviations / decisions during the phase
- **Route shape:** a **new sibling** `GET/POST /automation/pathfinding/filter` (not an extension of the existing `/automation/pathfinding` payload). The filter is re-read fresh inside `executeRun()` every cycle, so saving it needs no scheduler restart — keeping the `startAutoPathfinding()` side-effect off the filter save path.
- **Timestamp units (spec correction):** `MeshCoreContact.lastSeen` is epoch **milliseconds** but `lastAdvert` is epoch **seconds** (verified against the manager's contact-write sites — the spec draft's "both seconds" assumption was wrong). The last-heard cutoff normalizes both to ms. This was reproduced identically in the frontend live-preview memo. Browser-validated: last-heard=2h yielded 17/155, matching the source's "17/155 active" count.
- **AND/OR classification:** last-heard, hop-range, signal = AND pre-filters; specific-contact allowlist + name-regex = OR-union. Browser-validated: allowlist ∩ (last-heard 2h) correctly narrowed 17→6 (allowlist cannot rescue an AND-failure).
- **migrate-db:** `meshcore_pathfinding_targets` added to `SKIP_TABLES` in `src/cli/migrationTables.ts`, mirroring the analogous `auto_traceroute_nodes` treatment (re-selectable allowlist; the attribute filters live in the migrated `settings` table).
- **Migration number:** 113 (`create_meshcore_pathfinding_targets`).
- **Docs:** `docs/features/meshcore.md` Auto-Pathfinding section extended; `CHANGELOG.md` [Unreleased] entry added.
- **Gates:** full Vitest suite green, `npm run typecheck` clean, `npm run lint:ci` exit 0, browser-validated against the dev container (screenshot captured).

## Key references

- MeshCore scheduler: `src/server/meshcoreManager.ts` `startAutoPathfinding()`/`executeRun()` (~L5848–5952); filter insertion point at the `companions`/`repeaters`/`targets` build (~L5884–5905).
- `MeshCoreContact` fields: `src/server/meshcoreManager.ts:356` (`publicKey`, `advName`/`name`, `lastSeen`, `lastAdvert`, `rssi`, `snr`, `advType`, `pathLen`).
- Auto-Traceroute model to mirror: `src/services/database.ts` `getNodeNeedingTracerouteAsync` (~L4759), `get/setTracerouteFilterSettingsAsync` (~L5587); allowlist table `auto_traceroute_nodes` + repo `src/db/repositories/autoTraceroute.ts`; UI `src/components/AutoTracerouteSection.tsx`.
- MeshCore routes: `src/server/routes/meshcoreRoutes.ts` `/automation/pathfinding` (~L2982) and `/contacts` (~L469).
- MeshCore UI: `src/components/MeshCore/MeshCoreAutomationsView.tsx`; contact-picker precedent `src/components/MeshCore/MeshCoreTimerTriggersSection.tsx`.
- Settings registration: `src/server/constants/settings.ts` (both arrays: ~L220 and ~L363).
