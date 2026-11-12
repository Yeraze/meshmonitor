# 4.17.3 pre-release review — fix tracker

Review of `v4.17.2..cedca6326` (106 commits), run 2026-11-11: five read-only code reviews,
a live UI pass on the dev container (desktop, 390x844, 844x390; mocha and latte), and local
build / bundle / lint / token checks. CI on `main` was green on all three databases.

This file tracks every finding to closure. Update the **Status** column as PRs merge.

Status: `todo` · `in progress` · `PR #NNNN` · `merged` · `decision needed` · `deferred`

## Release gate

The tag waits on **B1** and the **fix-before-tag** rows (H1, H2, H3, M1, M2).

## Work batches

Batches touch separate files so they can run in parallel.

| Batch | Scope | Main files |
|---|---|---|
| P1 Security | B1, M1, M2, L7, L15 | `routes/v1/channels.ts`, `routes/sourceRoutes.ts`, `services/sourceDashboardData.ts`, `routes/v1/actions.ts`, `routes/securityRoutes.ts` |
| P2 Poll | H3, M6, L9 | `routes/pollRoutes.ts`, `hooks/usePoll.ts`, `hooks/useServerData.ts`, `App.tsx` |
| P3 MeshCore senders | H1, H2, L2, L4, L8, L11 | `meshcoreManager.ts`, `services/meshcoreAutoWelcome.ts`, `services/meshwarsForwarder.ts`, `MeshCore/hooks/useMeshCore.ts` |
| P4 Layout | H4, M8, M9, M11–M17, L13, L17, L22, L25, L33, L34 | MeshCore views, `ConfirmDialog.module.css`, `App.css`, SectionNav, Security tab |
| P6 Decided policies | M3, M4, M5, M10, L3, L5, L14 | `meshcoreManager.ts` (trace notify, timers, gate retry), `utils/automatedTextSplit.ts`, `MeshCoreRoomsView.tsx`, `db/repositories/traceroutes.ts`, `securityDigestService.ts` |
| P5 Copy and polish | L1, L16, L18, L20, L21, L23, L24, L26–L32, L35 | `public/locales/en.json`, assorted components |

## Decisions (maintainer, 2026-11-11)

| ID | Decision |
|---|---|
| M3 | New toggle "notify on automatic traces", default **off**. User-started traces keep notifying under `notifyOnTraceroute`. |
| M4 | Drop a new split sequence when one for the same trigger + target is already waiting; drop any sequence waiting longer than 2 minutes. |
| M5 | Multi-channel MeshCore timers: 10 s gap between channels, at most 4 channels per timer. |
| M7 | Keep the CLI console at `configuration:write` (side door accepted). Won't fix. |
| M10 | No auto-login on room select. Show saved posts read-only plus an explicit Login button. Scheduled auto-sync unchanged. |
| L3 | After an unmet Required Repeaters retry, skip further gate retries on that channel for 1 hour; log a warning. |
| L5 | A direct traceroute counts for NeighborInfo eligibility only if it is at most 7 days old. |
| L6 | Leave as is. Won't fix. |
| L14 | When per-source digest URLs fall back to the global URL, send one combined daily digest instead of one per source. |

## Findings

### Blocker

| ID | Finding | Where | Origin | Batch | Status |
|---|---|---|---|---|---|
| B1 | v1 API returns every MeshCore channel PSK to any token with `messages:write` (UI requires admin or `channel_N:write`) | `src/server/routes/v1/channels.ts:26-30, 47-50, 139-141` | 2b6530cf4 (#6263) | P1 | merged #6359 |

### High

| ID | Finding | Where | Origin | Batch | Status |
|---|---|---|---|---|---|
| H1 | Auto Welcome cap checked at discovery, recorded after the 30–600 s delay: a burst of new contacts gets past 6/hr (one flood DM each). Disabling during the delay doesn't cancel; `recordWelcomeSend` races | `meshcoreManager.ts:14493-14551`, `services/meshcoreAutoWelcome.ts:118, 209-224` | c880b7729 (#6224) | P3 | merged #6360 |
| H2 | MeshWars keeps `hops === 1`, but heard-by hops are 0-based: drops direct repeaters, reports 2nd-hop ones | `services/meshwarsForwarder.ts:112` | ef2ba2e2f | P3 | merged #6360 |
| H3 | One throw blanks the whole `/api/poll` (node load and delta serialiser outside the per-section try blocks) → empty Nodes, Map and Channels. Fits #6342 | `routes/pollRoutes.ts:113-118, 156, 165, 671, 690-706` | 4.17.2 | P2 | merged #6358 |
| H4 | Phone landscape: MeshCore Map, Channels, DMs never show the content pane — CSS hides it on `max-height:500px` landscape, `isMobileViewport()` checks width only | `MeshCoreChannelsView.tsx:51`, `MeshCoreDirectMessagesView.tsx:119`, `MeshCoreRoomsView.tsx:56`, `MeshCoreNodesView.tsx:66` | pre-existing (v4.16.2) | P4 | merged #6361 |

### Medium

| ID | Finding | Where | Origin | Batch | Status |
|---|---|---|---|---|---|
| M1 | Deleting a MeshCore source leaves its encrypted device private key (`meshcore_source_pki_keys`) | `routes/sourceRoutes.ts:1803-1807` | 0ad8489fb (#6195) | P1 | merged #6359 |
| M2 | Gateway colouring returns every MQTT `fromNode` + gateway (48 h) to anyone with `nodes:read`, bypassing channel `viewOnMap` and `packetmonitor:read` | `services/sourceDashboardData.ts:546-560` | 63300af61 (#6175) | P1 | merged #6359 |
| M3 | Every automatic MeshCore path discovery / trace sends a notification; `notifyOnTraceroute` defaults on (~1 alert per contact per day with auto-pathfinding) | `meshcoreManager.ts:2747, 3360, 8562` | 4402509fe (#6253) | P6 | merged #6363 |
| M4 | Split-message lock queue has no depth cap; cooldown-0 responder can backlog stale multi-part replies for hours | `utils/automatedTextSplit.ts:46-54` | 04b6ab10b, d91584be4 | P6 | merged #6363 |
| M5 | Multi-channel MeshCore timers send back to back, no gap, no channel cap (1 min × 4 ch ≈ 11% duty EU narrow) | `meshcoreManager.ts:13979-13994` | 51ac9644b (#6230) | P6 | merged #6363 |
| M6 | Not-connected source never re-polls after a failed first read → page stays blank | `hooks/usePoll.ts:333, 342`; `App.tsx:1710-1725` | a762d21d5 (4.17.2) | P2 | merged #6358 |
| M7 | Local `/cli` console (`configuration:write`) can send `set prv.key` / `poweroff`, bypassing the admin + typed-name gate | `routes/meshcoreAdminRoutes.ts:354` | 102638f3d (#6255) | — | won't fix (decided) |
| M8 | Shared `ConfirmDialog` can't scroll; Backup Restore checkbox and button off-screen on a landscape phone | `shared/automation/ConfirmDialog.module.css:3-22` | 52beaef7c (#6285) | P4 | merged #6361 |
| M9 | MeshCore Time Sync / Remote Telemetry tables: unstyled `data-table`, no scroll wrapper; at 390 the Save/Disable buttons start off-screen | `MeshCoreRemoteTelemetrySection.tsx:110`, `MeshCoreTimeSyncSection.tsx:133` | 9f859225d | P4 | merged #6361 |
| M10 | Selecting a MeshCore room with a saved password logs in with no click (RF send); don't-repeat latch is in memory, a reload re-arms it | `MeshCoreRoomsView.tsx:390-403` | pre-existing (#3214) | P6 | merged #6363 |
| M11 | MeshCore header at 390: title clipped, Disconnect button past the screen edge | MeshCore page header | — | P4 | merged #6361 |
| M12 | Legacy `.modal-overlay` starts 48 px from the left on mobile; a strip stays undimmed and tappable | `src/App.css:2138` | pre-existing | P4 | merged #6361 |
| M13 | MeshCore "Import from URL" has no Close/Cancel before decoding; Escape does nothing | channel import dialog | 9a0ed0c08 (#6257) | P4 | merged #6361 |
| M14 | MeshCore Security tab cut off ~200 px at 390 (`.security-tab` needs `min-width: 0`) | SecurityTab | 672849f61 (#6281) | P4 | merged #6361 |
| M15 | Standalone `/automations` page ignores the user's theme, always dark | Automations page | — | P4 | merged #6361 |
| M16 | Meshtastic Channels at 844x390: message pane ~60 px; MQTT/Bridge toggle clipped | Channels view | — | P4 | merged #6361 |
| M17 | Landscape section-nav rail stretches the search box to ~160 px (`flex: 0 1 14rem` in a column) | SectionNav | 549ac1950 (#6211) | P4 | merged #6361 |

| M18 | Deleting a MeshCore source leaves saved Repeater / Room Server passwords in `meshcore_nodes` (found while fixing M1; channel PSK rows were also left, fixed in PR #6359) | `routes/sourceRoutes.ts` delete; `db/repositories/meshcore.ts` | pre-existing | — | won't fix (decided) |

### Low

| ID | Finding | Where | Origin | Batch | Status |
|---|---|---|---|---|---|
| L1 | 8 new i18n keys missing from `en.json` (Mesh Issues rules); 2 more pre-existing | `MeshIssuesSection.tsx`, `configSections.ts:287, 370` | 1908deb9a, 52beaef7c | P5 | merged #6362 |
| L2 | Split-timer 5-min floor bypassable via generic settings POST / restore; `armTimerTrigger` doesn't clamp | `settingsRoutes.ts:409-424, 987`; `meshcoreManager.ts:13909` | #6316 | P3 | merged #6360 |
| L3 | Unmet Required Repeaters gate makes every automated channel send auto-retry once | `meshcoreManager.ts:7440-7463` | 80b1a719f, 0834a4348 | P6 | merged #6363 |
| L4 | Auto Welcome also greets Repeaters / Room Servers / sensors | `services/meshcoreAutoWelcome.ts` | c880b7729 | P3 | merged #6360 |
| L5 | NeighborInfo eligibility trusts a direct traceroute of any age | `db/repositories/traceroutes.ts:211-235` | ca0a1043c (#6151) | P6 | merged #6363 |
| L6 | Hung Apprise delays a message's auto-ack / auto-responder up to 30 s | `meshtasticManager.ts:8039-8042` | 91cf98fd2 | — | won't fix (decided) |
| L7 | v1 MeshCore traceroute comment claims a 60 s gate the code doesn't apply; no single-flight | `routes/v1/actions.ts:13-17, 135-160` | 2b6530cf4 | P1 | merged #6359 |
| L8 | UI device-command hooks default `confirm: true` | `MeshCore/hooks/useMeshCore.ts:2283, 2302, 2370, 2404` | 9a0ed0c08, 102638f3d | P3 | merged #6360 |
| L9 | Poll errors invisible: `useNodes` / `useChannels` ignore `error` | `hooks/useServerData.ts` | — | P2 | merged #6358 |
| L10 | #6175 added ~70 lines to frozen `src/styles/nodes.css` | `src/styles/nodes.css` | 63300af61 | — | deferred |
| L11 | Room re-sync pushes duplicate posts into the in-memory list (DB is deduped) | `meshcoreManager.ts:5688-5695` | 857e9d9b9 (#6246) | P3 | merged #6360 |
| L12 | #6354 skip buys ~1 h; hourly purge then removes restored rows past retention | `services/telemetryPurgeSchedule.ts` | cedca6326 | — | release note |
| L13 | Heard-by list on sent MeshCore messages opens in the header's 85 px column, not below the message | `MeshCoreMessageStream.tsx:837`, `HeardByBubble.tsx` | 51958e6d1 (#6239) | P4 | merged #6361 |
| L14 | Security digest fans out to every source incl. MeshCore / MQTT ingest via the global Apprise URL fallback | `securityDigestService.ts:391-393` | 672849f61 (#6281) | P6 | merged #6363 |
| L15 | `POST /nodes/:nodeNum/clear` and `POST /digest/send` check `security:write` on any source, act on `body.sourceId` | `securityRoutes.ts:204, 713` | pre-existing / #6281 | P1 | merged #6359 |
| L16 | Missing `en.json` key `meshcore.automation.responder.chip_split` | `MeshCoreAutoResponderSection.tsx:460` | 04b6ab10b | P5 | merged #6362 |
| L17 | MeshCore Packet Monitor pop-out uses undefined `var(--bg-primary)` | `pages/PacketMonitorPage.tsx:41, 83` | #6262 | P4 | merged #6361 |
| L18 | Channel public/private marker is by slot only; a Public-key channel elsewhere shows a lock | `utils/meshcoreChannelKind.ts` | 3b0ae333c (#6228) | P5 | merged #6362 |
| L19 | Additions to global `MeshCorePage.css` instead of CSS modules | `MeshCorePage.css` | 83043d220, 51958e6d1 | — | deferred |
| L20 | Telemetry tooltip shows unrounded values | TelemetryChart | — | P5 | merged #6362 |
| L21 | Connection banner: no address on first poll; says "HTTP API" for a TCP source | `hooks/connectionCheck.ts` | 86524fc67 (#6353) | P5 | merged #6362 |
| L22 | "Jump to Bottom" pill covers the NEW MESSAGES divider | message stream | — | P4 | merged #6361 |
| L23 | MeshCore time tooltip ignores the 12-hour setting | relative-time tooltip | 6324e79fb (#6214) | P5 | merged #6362 |
| L24 | No hint why Send is disabled over the length limit | composer | c38bb192e | P5 | merged #6362 |
| L25 | Time Sync / Remote Telemetry headings unlike other sections; landscape rail scrolls to the wrong section | MeshCore automation sections | 9f859225d | P4 | merged #6361 |
| L26 | MeshCore channel Share dialog says "Meshtastic devices" | share dialog | 9a0ed0c08 | P5 | merged #6362 |
| L27 | Factory Reset wording Meshtastic-flavoured; close button is a literal "×"; danger buttons not red | factory reset dialog | 9a0ed0c08 | P5 | merged #6362 |
| L28 | Template node picker can't tell identically named nodes apart | Template Gallery | b1618d166 | P5 | merged #6362 |
| L29 | Mesh Issues shows "0 -> 0 -> 0 -> 0 sampled"; two diagnostics listed twice | Mesh Issues | 1908deb9a | P5 | merged #6362 |
| L30 | "💡" emoji in Automation page copy (UiIcon rule) | Automation page | — | P5 | merged #6362 |
| L31 | `{{ text }}` token help still says "first 100 characters" | notification templates | 1a16db58e (#6278) | P5 | merged #6362 |
| L32 | Map pin writes 7 decimals into lat/lon fields that allow 6 | fixed-position picker | bd2a59be3 | P5 | merged #6362 |
| L33 | MQTT Root Finder inputs are unstyled browser defaults | Root Finder dialog | a4c436017 (#6287) | P4 | merged #6361 |
| L34 | "Days to View" input is dark in the latte theme | Telemetry Dashboard | — | P4 | merged #6361 |
| L35 | MeshCore Nodes public-key sort labelled "Sort: ID" (DM list says "Public key") | node list tools | ff32c285f (#6185) | P5 | merged #6362 |

## Coverage gaps (re-test before tagging)

- Mobile was tested by window resize only (the emulation tool failed): no touch, mobile UA, DPR or `pointer: coarse`. Check on a real phone.
- No WebGL: vector map layers (#6260) untested.
- No data: MeshCore Packet Monitor table (#6262, #6265, #6190), MeshCore traces in the Explorer (#6276), Time Sync rows, backup restore dialog, estimated positions.

## Release notes to carry

- Existing `trigger.telemetry` automations with no source filter now also fire on MeshCore readings (15bd77e82).
- Restoring an old backup: startup purges skip one boot; the hourly purge then applies retention (L12).
