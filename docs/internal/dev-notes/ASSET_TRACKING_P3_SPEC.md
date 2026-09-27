# Asset Tracking Phase 3: timeline playback (#5354)

See `ASSET_TRACKING_EPIC.md`. Phases 1 (#5411) and 2 (#5419) added the asset flag, retention, and the full-history thinned trail with gap segments (`segmentStart` markers, see `flattenAssetTrack` / `segmentBreaks` in `src/utils/positionHistoryDownsample.ts`).

## Decisions (user, 2026-09-27)

- **D1 Placement:** a playback bar along the bottom of the **Nodes map** (`NodesTab.tsx`). It shows only when the selected node is an asset (`selectedNode.asset`), Show Position History is on, and more than one fix is loaded.
- **D2 Speeds:** **60×, 600× and 3600×** (1 min, 10 min, or 1 h of track per second). The last speed used is remembered in localStorage, wrapped in try/catch.
- **D3 Map during playback:**
  - A **moving marker** slides along the track, interpolated between fixes, with a time label.
  - **Trail up to cursor:** a toggle, **on** by default. While the cursor isn't at the end, only fixes at or before the cursor are drawn.
  - **Follow:** a toggle, **off** by default. It pans the map to keep the marker in view.

## Mesh impact

None. This is frontend only; it adds no requests.

## Behaviour

- **Timeline:** runs from the first to the last fix of the history currently shown, after the existing hours-slider filter.
  - **Notches:** one per fix, drawn as a single SVG path or canvas. Up to 2,000 fixes, so not 2,000 DOM nodes.
  - **Gaps:** shaded regions on the timeline.
- **Cursor:**
  - It starts at the end, which is today's full trail, so nothing changes until the user interacts.
  - Dragging or clicking the timeline seeks.
  - Pressing Play at the end restarts from the beginning.
  - Playback stops at the end.
- **Readout:** the fix time and calendar date at the cursor, using the user's time and date format settings (`useDisplaySettings` / `formatDateTime` helpers). Also the nearest fix's speed, when known.
- **Interpolation:**
  - Between two fixes in the **same segment**, interpolate lat/lon linearly by time.
  - Inside a **gap**, don't interpolate across it: hold the marker at the last fix of the previous segment and dim it.
  - Put this in a pure `src/utils/trackPlayback.ts`:
    - `positionAt(fixes, t)` returns `{lat, lon, index, inGap}`;
    - `indexAtOrBefore(fixes, t)`;
    - `timelineGaps(fixes)`.
  - Binary search on timestamps.
- **Animation:**
  - `requestAnimationFrame` advances the cursor by `elapsed × speed`.
  - Move the marker **imperatively** through a Leaflet marker ref (`setLatLng`), not by re-rendering React each frame.
  - Throttle the React state that drives "trail up to cursor" and the readout to about 5 Hz, so the up to 2,000 polylines aren't rebuilt every frame.
- **Follow:** when on, pan (`map.panTo`, animate) only when the marker leaves the middle 70 % of the view, throttled to at most one pan every 500 ms.
- **Controls, in a new `src/components/map/AssetPlaybackBar.tsx` with a CSS module:**
  - Play/Pause and step back/forward one fix (use `UiIcon`, no emoji).
  - The speed select.
  - The "Trail up to cursor" and "Follow" checkboxes.
  - The readout and the timeline.
  - The bar collapses to one row at phone width, with no horizontal scroll.
- **Keyboard,** while the timeline has focus: Space plays or pauses, ←/→ step one fix, Home/End jump. The timeline is a `role="slider"` with `aria-valuetext` set to the readout.
- **Lifecycle:** stop and reset when the selected node changes, the history reloads, Show Position History turns off, or the component unmounts. Cancel the RAF.
- **Wiring:**
  - NodesTab passes the flattened asset history (the `positionHistory` already in MapContext, after the hours filter) and the Leaflet map instance.
  - The trail-rendering code (NodesTab ~868–994) takes an optional `cursorTime`. When it is set and trail-up-to-cursor is on, drop fixes after it before downsampling and segmenting.
  - The existing arrows and popups keep working.
- **i18n:** `en.json` keys under `map.playback.*`.
- **Docs:** a "Playback" paragraph in the Asset Tracking section of `docs/features/maps.md`.

## Tests

- **Unit tests for `trackPlayback`:**
  - interpolation mid-segment;
  - exactly at a fix;
  - before the first and after the last fix;
  - inside a gap (held and flagged);
  - `indexAtOrBefore` edge cases;
  - `timelineGaps`.
- **Component tests** with fake timers and a mocked RAF:
  - Play advances the cursor at the chosen speed.
  - Pause stops it.
  - It stops at the end.
  - Play at the end restarts.
  - Step buttons.
  - Speed is persisted.
  - The keyboard keys work.
  - Trail-up-to-cursor calls back with the cursor time.
  - Follow pans only when the marker is off-centre.
  - It resets when the node changes.
- **Wiring test:** the bar renders only for an asset with history showing.

## Exit criteria

- The tests above pass. The full suite passes; this change has no DB work, so PG/MySQL skips are acceptable here. `tsc` and `lint:ci` are clean.
- Browser check on the dev container with a seeded asset track:
  - playing moves the marker and grows the trail;
  - the gap holds the marker;
  - follow pans;
  - the bar works at phone width.
