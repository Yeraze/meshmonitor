# Traceroute Strip Interactivity & Picker — Epic Plan

**Status:** Phase 1 in progress
**Requested:** 2026-07-29
**Builds on:** the traceroute visual node strip (#4381 / PRs #4392, #4397) mounted in the
Node Details area of `MessagesTab`.

## Goal

1. Make the strip interactive: the node hover popup gains a "Node Details" button that loads
   that node into the details panel, and the forward/return links gain tooltips with
   direction, endpoints, distance, and SNR.
2. Make the strip usable on MQTT sources (which have no origin node) — and richer everywhere —
   via a dropdown of every traceroute the selected node participated in.

## Interview decisions (2026-07-29)

| Question | Decision |
|---|---|
| "Participated in" definition | Endpoints **plus** intermediate hops in `route`/`routeBack` |
| Data window for the picker | New API endpoint, ~7-day window, capped (~100 entries) |
| Popup interactivity model | Hover-interactive: popup gets pointer-events with a short linger delay so the mouse can travel into it; keyboard focus keeps working |
| Picker surface | **All sources** (not MQTT-only), defaulting to the newest traceroute |
| Distance in link tooltips | Only when both endpoints have geoposition; formatted km/mi per the `distanceUnit` setting |

## Phase 1 — Strip interactivity (branch `feature/traceroute-strip-interactivity`)

Scope:
- Node popup becomes hover-interactive (linger delay; `pointer-events: auto`) and renders a
  `NodeActions`-family "Node Details" button (`more-details` kind). Clicking it loads the node
  into the details panel via the existing `setSelectedDMNode(nodeUserId)` mechanism
  (already on the Messages tab — no tab switch needed). Disabled/omitted for unknown hops.
- Edge tooltips on the strip polylines: direction (Forward/Return), endpoint display names,
  distance via `calculateDistance`/`formatDistance` (`src/utils/distance.ts`) respecting the
  `distanceUnit` setting when both endpoints have positions, and the segment SNR.
- `TracerouteStrip` stays a pure component: new optional callback prop for the details action;
  positions come from the existing per-node `meta.pos`.

Exit criteria:
- [ ] Popup button loads the node in the details panel; unknown hops don't offer it
- [ ] Link tooltips show direction, endpoints, distance (unit-correct, only with positions), SNR
- [ ] Tests extended (`TracerouteStrip.test.tsx` + utils tests); full suite green
- [ ] Browser-validated in the dev container
- [ ] PR merged

- [ ] **Phase 1 complete**

## Phase 2 — Traceroute picker on all sources

Scope:
- Repository method + route (sourceId-scoped, `requirePermission('traceroute','read')`,
  response envelope helpers) returning traceroutes a node participated in — endpoints or
  intermediate hop — over ~7 days, capped ~100, newest first. Participation matching in JS
  over Drizzle-fetched rows (no raw SQL).
- `ApiService` method + hook; dropdown in the Node Details traceroute section of
  `MessagesTab` for all Meshtastic-family sources (TCP and MQTT), default = newest.
  Selecting an entry renders it in the strip. MQTT sources thereby gain the strip.
- Meshtastic request-flow badges (pending/failed) keep working for the newest/own-request case.

Exit criteria:
- [ ] Endpoint returns participation-matched traceroutes, per-source scoped (+ `*.perSource.test.ts`)
- [ ] Dropdown on all sources; MQTT source shows and renders picks; default newest
- [ ] Tests extended; full suite green; browser-validated on an MQTT source
- [ ] PR merged

- [ ] **Phase 2 complete**

## Log

- 2026-07-29: Epic created; interview complete; Phase 1 worktree `../meshmonitor-trs-phase1`.
