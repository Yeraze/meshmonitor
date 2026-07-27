# TX-Disabled Support — Epic Plan

**Epic issue:** #4294 (original bug report, reopened as tracker; #4308 closed as duplicate)
**Status:**
- [x] Phase 1 — Backend: honor the flag + central guard (PR #4309, merged)
- [x] Phase 2 — Frontend: gating UX (PR #4313, merged)
- [x] Phase 3 — Polish + docs (branch `feature/tx-disabled-docs`)

**Phase 3 deviations & findings (2026-07-24):**
- Automations badge: `useTxStatus` is single-source and can't be looped, and the builder has
  no design-time single sourceId (automations fan out at runtime). Instead of inventing
  per-source machinery, exposed a fail-open `txEnabled` on the existing public `GET /api/sources`
  radio summary (`computeSourceRadioSummary`, reusing the same choke point as the frequency
  feature) and rendered an advisory `UiIcon` badge per selected source row in `sendSourceMulti`.
  Advisory only — the checkbox stays enabled; runtime skip-and-record (Phase 1) is the real guard.
- Receive-only-mode user doc added at `docs/features/receive-only-mode.md` + VitePress sidebar +
  cross-link from device.md; `409 TX_DISABLED` + the config/lora-honors-txEnabled note documented
  in REST_API.md and API_REFERENCE.md. `docs/api/API.md` left alone (marked outdated).
- **Follow-up filed separately:** the Phase 1 remote-import-preserve TODO (an
  `requestRemoteConfig(LORA_CONFIG)` round-trip for fully-accurate remote-node txEnabled preserve)
  is out of docs/polish scope; current fail-open behavior is safe. Filed as its own issue.

**Phase 2 deviations & findings (2026-07-23):**
- No shared ConfirmDialog exists — reused the app's `window.confirm(t(...))` danger idiom
  (as DeviceConfigSection does). Tooltips use native `disabled` + `title` (app-wide idiom).
- One gated surface the spec's inventory missed: `NodesTab.tsx` renders `TracerouteBody`
  directly for the MAIN map popup (a separate path from App's single `<NodePopup>`). Gated
  via an exported pure `isTracerouteRunDisabled()` helper (WP3 follow-up commit 0e451008).
  Audit confirmed no other TracerouteBody/NodeActions consumers were missed (MeshCoreMap =
  NodeActions only + never gated; DashboardNodePopup = read-only).
- `useAdminCommandsState.ts` (referenced in the original scope) does not exist — the only
  frontend force-true sites were two `?? true` in AdminCommandsTab, changed to `!== false`.
- AdminCommandsTab residual: Device/Module config-section "Set" buttons live in separate
  files and are protected by the `executeCommand` choke-point guard + the inline
  remote-admin notice, not each visually disabled. Functionally correct (no remote write
  succeeds); proven by a test clicking a stubbed section save and asserting no network call.
  Per-button disabling of those sections is a possible Phase 3 nicety, not a gap.
- Browser-validated live (TX-disabled Sandbox source): channels/DM gating + tooltips, LoRa
  confirm (accept/cancel), banner-appears-without-reload after save (invalidation), map-popup
  traceroute gating, clean console. Note: the live sandbox HARDWARE node reverts
  `tx_enabled` to true on its own config re-read — a device quirk, not app behavior.

**Phase 1 deviations & findings (2026-07-23):**
- **"Preserve" ≠ strip.** `setLoRaConfig` sends the ENTIRE LoRaConfig struct (whole-message
  replace) and proto3 decodes an omitted bool as `false` — stripping `txEnabled` on import
  would have silently disabled TX (the #1328 mechanism). Implemented as an explicit
  backfill from the device's current value (`manager.isTxEnabled()`) instead. POST /lora
  likewise backfills when the caller omits the field.
- **Remote import preserve is best-effort:** cached remote config → decoded URL value →
  fail-open `true`. A fully-accurate remote preserve needs an extra
  `requestRemoteConfig(LORA_CONFIG)` round-trip — `TODO(#4294 follow-up)` at the call
  site in `adminRoutes.ts`; consider in Phase 3.
- `adminRoutes.ts` has its **own duplicated** import-config logic (spec assumed it shared
  channelRoutes'); both its force-true sites were fixed independently.
- Pre-existing bug found & fixed: `POST /config/module/request` was registered after the
  `/module/:moduleType` wildcard and was unreachable (always 400). Reordered.
- Waypoint rebroadcast gates in `waypointService.rebroadcastTick` (via `broadcastWaypoint`,
  not one of the six guarded primitives), with a `typeof manager.isTxEnabled === 'function'`
  check so MeshCore managers are never touched.
- Position-estimation needed no change — it consumes observed traceroutes, never sends.

**Interview decisions (2026-07-23):**
- 3 phases as scoped, one PR each.
- Imports/restores (channel-URL import, remote config import, backup restore) **preserve
  the device's current txEnabled** — they never write the field. Only the LoRa config UI
  (with danger-confirm dialog) changes it.
- Global "Transmit Disabled" banner is the single paused indicator — no per-feature
  paused badges in settings sections.
- Epic tracked in #4294 (the original NullVoid bug report — a ROUTER_LATE listen-only
  MQTT relay whose TX-off config MeshMonitor silently reverts); each phase PR references it.

**Goal:** Stop force-overriding `lora.txEnabled` to `true`, let users legitimately run a
Meshtastic source in receive-only mode, and degrade the UI/backend gracefully so every
surface that cannot function with TX disabled is visibly disabled (not broken or silently
failing).

**Firmware semantics (verified against meshtastic/firmware master):** `tx_enabled=false`
is a hard kill switch in `RadioLibInterface.cpp` — every outbound LoRa packet is dropped
at the radio with `ERRNO_DISABLED`. RX, decode, TCP API (config reads/writes, **local**
node admin, channel reads) all keep working. Remote-node anything (messages, traceroute,
requests, remote admin) silently dies. The node also stops announcing itself (own
NodeInfo/Position/Telemetry broadcasts are dropped), so it goes invisible to the mesh.

## Current state

- **The hardcode:** `src/server/routes/configRoutes.ts:129-137` — `POST /api/config/lora`
  spreads the request body then forces `txEnabled: true` before `setLoRaConfig`.
- **Other force-true sites:**
  - `channelRoutes.ts:1180-1189` — channel-URL **import** forces `true`.
  - `channelRoutes.ts:1064-1066` — channel-URL **export** emits `true` regardless of actual value.
  - `adminRoutes.ts:1052-1090` (`:1066`, `:1086`) — **remote-node** config export/import forces `true`,
    even when the remote node legitimately has TX off.
  - Frontend defensive defaults: `useAdminCommandsState.ts:223`, `AdminCommandsTab.tsx:503,1059`.
- **Existing detection infra (keep, extend):**
  - `GET /api/device/tx-status?sourceId=…` (`deviceStatusRoutes.ts:9`) — per-source, reads
    `deviceConfig.lora.txEnabled`, defaults true.
  - `useTxStatus` hook (`src/hooks/useTxStatus.ts`) — TanStack Query, per-source key,
    30s poll. Consumed **only** in `App.tsx:245` → `AppBanners` warning banner.
  - Nothing else in the app knows TX state; no send button checks it; every scheduler fires anyway.
- **Not affected (must NOT be gated):** local-node admin over TCP (config read/write,
  reboot, set-time — the time-sync scheduler is local admin), MQTT bridge downlink
  (`mqttBridgeManager.ts` publishes to a broker, bypasses the radio), MeshCore sources
  (own manager/protocol, no such flag), all read-only pages (Dashboard, PacketMonitor,
  UnifiedTelemetry, MapAnalysis, UnifiedMessages — which has no send box).

## Inventory of TX-dependent surfaces

### Frontend (user-initiated OTA)

| Surface | Location | Endpoint |
|---|---|---|
| Channel send box + Enter | `ChannelsTab.tsx` / `App.tsx:2591` | `POST /api/messages/send` |
| DM send box | `MessagesTab.tsx` / `App.tsx:2166` | `POST /api/messages/send` |
| Tapback/emoji | `App.tsx:2258` | same |
| Send Bell (channel + DM) | `App.tsx:2719,2744` | same |
| Resend | `App.tsx:2790` (wired `ChannelsTab.tsx:1076`, `MessagesTab.tsx:1674`) | same |
| Send Position (broadcast) | `App.tsx:2768` | `POST /api/position/request` |
| Traceroute (node list + map popup) | `useSourceView` / `NodePopup.tsx:180` / `App.tsx:3546,3792` | `POST /api/traceroute` |
| Exchange Position | `MessagesTab.tsx:2217,2274` → `App.tsx:1982` | `POST /api/position/request` |
| Exchange NodeInfo / key repair | `MessagesTab.tsx:2131,2188` → `App.tsx:2028` | `POST /api/nodeinfo/request` |
| Request Neighbor Info | `App.tsx:2068` | `POST /api/neighborinfo/request` |
| Request Telemetry (4 kinds) | `MessagesTab.tsx:2466` → `App.tsx:2118` | `POST /api/telemetry/request` |
| **Remote**-node admin | `AdminCommandsTab.tsx` (remote target: `:659,:933,:1194,:1404`; passkey polling `:321-359`) | `POST /api/admin/commands` |
| Module config request (remote) | `api.ts:1265` | `POST /api/config/module/request` |
| Automations builder (sendMessage action) | `automations/catalog.ts:317`, `AutomationTester.tsx:263` | engine (below) |
| REST v1 (external consumers) | `v1/actions.ts:79,111,168,224`, `v1/messages.ts:536` | send/traceroute/requests |

### Backend autonomous senders (must skip + log when TX disabled)

All per-source (per manager instance), in `src/server/meshtasticManager.ts` unless noted:

| Scheduler / service | Location |
|---|---|
| Traceroute scheduler | `:2197` → `sendTraceroute :2267` |
| Key-repair scheduler (auto NodeInfo exchange) | `:2852` → `:2944` |
| Remote LocalStats scheduler | `:2358` |
| Remote-admin scanner | `:1790` (`RemoteAdminService`) |
| Auto-announce | `:1125,:3210` → `sendTextMessage` |
| Waypoint rebroadcast | `waypointRebroadcastSchedulerService.ts:58` |
| Auto-ack | `~:9694-9963` |
| Auto-responder | (`autoResponderCooldowns :823`) |
| Auto-ping sessions | `:10058-10360` |
| Cron-scheduled messages | `:62,:3274` |
| Automation engine sends | `automation/actionExecutor.ts:172`, `meshActionDeps.ts:82,146,147` |
| Position-estimation traceroutes | `:1175,:7831` |

**Not gated:** time-sync scheduler (`:2702` — local admin), autoFavorite/distance-delete/DB
maintenance/backup (local only).

## Design decisions (recommended)

1. **Disable, don't hide.** Gated controls render disabled with a tooltip ("Transmit is
   disabled on this node's radio") so users understand *why*, and reads remain available
   (messages still arrive; RX works). Hiding would make the app look broken.
2. **Backend is the source of truth and the enforcement point.** A single guard at the
   transmit primitives (`sendTextMessage`, `sendTraceroute`, `sendPositionRequest`,
   `sendNodeInfoRequest`, remote-path `sendAdminCommand*`) throws a typed
   `TxDisabledError`; routes map it to `fail(res, 409, 'TX_DISABLED', …)`. UI gating is
   UX polish; the choke point is what guarantees correctness (incl. v1 API and any
   surface we miss).
3. **Local-node admin stays fully functional.** `sendAdminCommand` gates only when the
   target ≠ local node. This is what lets the user re-enable TX from MeshMonitor.
4. **Setting the checkbox requires explicit confirmation.** Unchecking TX in the LoRa
   config UI shows a danger-confirm dialog spelling out consequences (node goes invisible
   to the mesh, no sending/traceroute/remote admin until re-enabled).
5. **Import/export paths preserve instead of force.** Channel-URL import, backup restore,
   and remote config import should leave `txEnabled` at the device's current value
   (strip it from the applied config) rather than force `true` — importing channels
   should not covertly flip a radio setting. Export emits the actual value.
6. **Schedulers check the flag at tick time and skip with a debug log** (once per state
   change at info level, not per tick — avoid log spam). They keep running so TX
   re-enable needs no restart.
7. **Automation runs record a skip.** A send action against a TX-disabled source writes
   an `automation_runs` entry marked skipped/TX_DISABLED rather than failing the run.
8. **Per-source throughout.** Gating keys off the active source's tx-status
   (`useTxStatus` already per-source). MeshCore and MQTT-bridge sources are never gated.

## Phases (≈3 PRs)

### Phase 1 — Backend: honor the flag + central guard
- Remove force-true from `configRoutes.ts` POST `/lora`; validate + pass through.
- Add `TxDisabledError` + guard in the transmit primitives (remote-target-only for admin).
- Map to `fail(res, 409, 'TX_DISABLED', …)` in messageRoutes, meshRequestRoutes,
  adminRoutes (remote), v1 routes. `ApiService` already surfaces `error`/`code`.
- Scheduler tick-time skips (all 12 rows above) + state-change logging.
- Automation engine: skip-and-record behavior.
- Import/export preservation changes (`channelRoutes.ts`, `adminRoutes.ts`,
  `deviceBackupService` already records actual value).
- Tests: route-harness 409 tests, scheduler skip tests, guard unit tests, import
  preservation tests.

### Phase 2 — Frontend: gating UX
- Distribute TX state: reuse `useTxStatus` (shared TanStack cache — no new context
  needed) in ChannelsTab, MessagesTab, NodePopup/node lists, AdminCommandsTab;
  invalidate `['txStatus']` after LoRa config save and on config push from device.
- Disabled states + tooltips on every row of the frontend inventory table.
- AdminCommandsTab: gate only when a remote node is targeted; banner inside the tab
  ("remote admin unavailable — TX disabled").
- LoRa config: enable the checkbox for real; danger-confirm dialog on disable; remove
  frontend force-true defaults (`useAdminCommandsState.ts:223` etc. become
  preserve-current).
- Keep/extend the AppBanners warning (link it to the LoRa config section).
- Handle 409 TX_DISABLED gracefully anywhere a race slips through (toast, not crash).
- Tests: component disabled-state tests, hook invalidation test.

### Phase 3 — Polish + docs
- Automations builder: inline warning badge when a selected source has TX disabled.
- v1 API docs: document 409 TX_DISABLED.
- User docs page: receive-only mode — what works, what doesn't.
- Verify banner/i18n strings across locales.

## Open questions

- Should the **traceroute scheduler / position estimation** state be surfaced in the UI
  ("paused — TX disabled") or is the global banner enough? (Plan assumes banner is enough.)
- Backup **restore**: preserve-current (recommended) vs restore the recorded value —
  restoring `false` from an old backup could surprise a user; preserve-current is safer.

## Effort

Medium epic. Phase 1 is the bulk (touches ~15 backend files + tests), Phase 2 is wide but
mechanical (one hook + disabled props through ~10 components), Phase 3 is small.
