# MeshCore Strict Receive-Only Mode — Epic Plan

**Epic issue:** #4547
**Status:**
- [x] Phase 1 — Backend: setting + central command-aware TX guard (branch `feature/meshcore-receive-only-backend`)
- [ ] Phase 2 — Frontend: gating UX
- [ ] Phase 3 — Virtual Node gating + docs

## Phase 1 deviations & findings (2026-08-04)

Spec: `docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md`. Five work packages,
8 commits, ~350 lines of production code and ~1,900 lines of tests.

- **`requestNeighbors` gets NO guard.** It branches on `validateMeshCorePubKey`: the remote
  branch (`ensureSavedLogin` + `sendCliCommand`) transmits and throws via its already-guarded
  downstream primitives; the local branch (`sendLocalCliCommand('neighbors')`) is serial-only
  and must keep working. Its route `POST /neighbors/request` therefore gets **no**
  `requireMeshcoreTx()` middleware — only the `failIfTxDisabled` catch mapping. Gating the
  method wholesale would have broken a legitimate local read.
- **This doc was wrong about `settings.allowlist.test.ts`.** That test is fully structural;
  adding the key to **both** `VALID_SETTINGS_KEYS` and `PER_SOURCE_SETTINGS_KEYS` keeps it
  green **unmodified**. A required edit there means the key went in the wrong array.
  `PerSourceSettingKey` is derived (`typeof PER_SOURCE_SETTINGS_KEYS[number]`), so it needs
  no edit either.
- **`actionExecutor.ts` lives at `src/server/services/automation/`**, not `src/server/automation/`.
  Confirmed: MeshCore automations degrade to `{ skipped: true, reason: 'TX_DISABLED' }` with
  zero automation-engine changes, purely by reusing the branded `TxDisabledError`.
- **`resolveSourceManager()` is Meshtastic-only by design** — a MeshCore `sourceId` falls back
  to the primary/fallback Meshtastic manager. `GET /api/device/tx-status` therefore narrows via
  `sourceManagerRegistry.getManager()` + `isMeshCoreManager` directly, before the existing
  Meshtastic path.
- **`ping` and `shutdown` verified serial-only** (`meshcoreNativeBackend.ts:1815-1820`):
  `shutdown` calls `this.disconnect()` (transport teardown), `ping` returns `{ pong: true }`
  in-process. Neither touches the radio. The radio probe is `pingContactZeroHop`, which goes
  out as `trace_path` and is on the RF list.
- **Pre-existing gap fixed:** the client `SourceRadioSummary` mirror (`src/types/elevation.ts`)
  was missing `txEnabled` / `udpRelayEnabled` / `canTransmit` entirely — the server had them,
  the client type did not. Added alongside `receiveOnly`.
- **Known limitation, deferred to Phase 2 as a product question:** flipping receive-only ON
  mid-retry-chain parks that specific DM/channel message rather than auto-resuming when the
  flag goes off again. Recurring schedulers (pathfinding, announce, timer triggers) all resume
  correctly because the check lives inside the callback, not around the timer install. Adding a
  re-arm mechanism was deliberately not invented inside the highest-risk work package.
- **Reviewer note:** `tsconfig.json` excludes `src/**/*.test.ts`, so `npm run typecheck` never
  checks test files, and Vitest strips types via esbuild without checking. A separate tsc run
  with tests included was done for this phase and reported no errors — worth repeating on any
  phase that adds significant test-only typing.
- **Verification:** full Vitest suite 14,006 tests / 0 failures (`success: true` via JSON
  reporter); `npm run lint:ci` clean of in-repo failures; `tsc` clean including test files.

**Goal:** Give MeshCore sources a strict receive-only mode that guarantees the physical
Companion never transmits over LoRa, while RX, the Analyzer Observer, the packet log,
contact/telemetry/route updates, and read-only Virtual Node access all keep working.

## Hard constraint (verified)

`@liamcottle/meshcore.js` v1.13.0 and the Companion firmware protocol expose **no**
radio-level TX kill switch. The full `CommandCodes` set has no `txEnabled` / `disableTx` /
`radioOff` equivalent; `SetOtherParams(38)` carries only manual-add-contacts, telemetry
modes and advert-location policy; `SetTxPower(12)` lowers power but never stops TX.

**Implication:** unlike Meshtastic (`lora.txEnabled` is a firmware kill switch), MeshCore
receive-only must be enforced **entirely inside MeshMonitor**. It cannot stop
firmware-autonomous transmissions (link-layer ACKs, on-device advert schedules configured
outside MeshMonitor). This limitation must be documented in Phase 3.

## Interview decisions (2026-08-04)

1. **Storage:** new per-source setting key `meshcoreReceiveOnly` in
   `PER_SOURCE_SETTINGS_KEYS` (`src/server/constants/settings.ts`), stored as
   `source:{id}:meshcoreReceiveOnly`. No DB migration — matches every existing MeshCore
   per-source toggle (`meshcoreRespondToDiscovery`, `meshcoreAutoAck*`, …).
2. **Strictness:** block **all RF**, allow **local serial config**. Blocked: messages, DMs,
   adverts, remote CLI, logins, traceroute/path discovery, telemetry & status requests,
   neighbours (binary req), node discovery, ANON_REQ, share-contact, discovery
   auto-responses, and every scheduler/automation that transmits. Allowed: setName,
   setRadio, setTxPower, setCoords, channel CRUD, RTC sync, stats, device query, reboot,
   contact import/export, local UART CLI (except the synthetic `advert` verb).
3. **Virtual Node:** stays up and serves reads; the 9 TX-causing commands return an `Err`
   frame. (Issue explicitly asks for read-only VN access.)
4. **Scope:** applies to **all MeshCore sources**, not just Companion — repeater sources'
   CLI verbs can transmit too.
5. **Auto-TX toggles:** settings are **preserved untouched**. Schedulers keep ticking but
   skip with a state-change log (mirrors the Meshtastic pattern). UI shows each affected
   section disabled with a "paused — receive-only mode" note, so disabling receive-only
   restores prior behavior exactly. Never clear a user's automation config.
6. **Phases:** 3, one PR each, each independently mergeable.

## Reuse template — the Meshtastic TX-disabled epic (#4294)

Phase 1 must reuse, not re-invent:

| Mechanism | File |
|---|---|
| `TxDisabledError` + `TX_DISABLED_CODE` + `isTxDisabledError()` | `src/server/errors/txDisabledError.ts` |
| `canTransmit()` guard idiom (throw for user actions, silent-skip for schedulers) | `src/server/meshtasticManager.ts:9195` |
| Route mapping `fail(res, 409, 'TX_DISABLED', …)` | `messageRoutes.ts:1324`, `meshRequestRoutes.ts:42`, … |
| Automation skip-and-record — already converts a thrown `TxDisabledError` | `automation/actionExecutor.ts:141-155` (`pushOrSkipTxDisabled`) |
| `GET /api/device/tx-status` shape | `src/server/routes/deviceStatusRoutes.ts:9` |
| `useTxStatus` hook + `utils/txDisabled.ts` + `AppBanners` banner | `src/hooks/useTxStatus.ts`, `src/components/AppBanners/AppBanners.tsx` |
| Per-source settings plumbing | `src/server/constants/settings.ts`, `databaseService.settings.getSettingForSource` |

Because `actionExecutor` already handles `TxDisabledError`, MeshCore automations degrade
correctly with **zero new automation-engine code** as long as the MeshCore TX primitives
throw the same error type.

## TX inventory (survey 2026-08-04)

### Two chokepoints

| # | Chokepoint | Location | Note |
|---|---|---|---|
| A | `MeshCoreManager.sendBridgeCommand()` | `meshcoreManager.ts:1620` | 50+ call sites, carries **both** RF and serial-only commands → the gate must be **command-name aware** (allowlist/denylist of bridge command names). |
| B | `MeshCoreNativeBackend.handleDiscoverRequest()` → `sendToRadioFrame` | `meshcoreNativeBackend.ts:798-838`, TX at `:831` | **Bypasses `sendCommand`/`dispatch` entirely.** Autonomous push-event-driven RF TX. Highest-risk miss. |

### RF-transmitting bridge commands (denylist seed)

`send_message`, `send_advert`, `discover_path`, `discover_nodes`, `request_owner`,
`request_regions`, `trace_path`, `share_contact`, `get_neighbours`, `login`, `get_status`,
`send_cli`, `request_telemetry`, `reset_path` (forces next send to flood).

Serial-only (must stay allowed): `get_channels`, `set_channel`, `delete_channel`,
`get_self_info`, `get_contacts`, `remove_contact`, `export_contact`, `import_contact`,
`reboot`, `export_private_key`, `import_private_key`, `set_name`, `set_radio`,
`set_tx_power`, `set_coords`, `set_advert_loc_policy`, `set_telemetry_mode_*`,
`set_other_params`, `get_stats`, `get_device_time`, `set_device_time`, `device_query`,
`set_flood_scope`, `set_out_path`.

### Manager methods that must throw when receive-only (`meshcoreManager.ts`)

`sendMessage` :3072 · `sendMessageWithResult` :3083 · `performScopedSend` :3253 (core
primitive) · `sendAdvert` :3669 · `resetContactPath` :3710 · `discoverContactPath` :3753 ·
`discoverNodes` :3789 · `fetchOwnerName` :3888 · `discoverRegions` :4021 ·
`traceContactPath` :4106 · `tracePathRaw` :4171 · `pingContactZeroHop` :4223 ·
`shareContact` :4310 · `getNeighbours` :4667 · `loginToNode` :4787 · `requestNodeStatus`
:4825 · `ensureGuestLogin` :4893 · `ensureSavedLogin` :4924 · `loginToRoom` :4957 ·
`sendRoomPost` :4990 · `requestNeighbors` :5051 (remote branch) · `sendCliCommand` :5185 ·
`runCliCommandLocked` :5228 · `requestRemoteTelemetry` :5678 · `requestRemoteTelemetryRaw`
:5725 · `runSyntheticLocalCli` :5344 (only the `advert` verb).

### Timer/scheduler paths that must silently skip

DM ACK retry :3417/:3459 → :3499 · channel retry :3576/:3616 → :3655 · auto-pathfinding
:6429 (:6503, :6506) · auto-announce :6597/:6660 (:6702, :6722) · timer triggers
:6754/:6824 (:6842, :6846) · auto-responder :7050 (:7113, :7117) · auto-acknowledge :7313
(:7442, :7446) · `services/meshcoreRemoteTelemetryScheduler.ts` (:428, :475, :484) ·
`services/meshcoreRoomSyncScheduler.ts` (:145) · discovery responder
`meshcoreNativeBackend.ts:831`.

Not gated (no RF): `startDeviceTimeSync` :4639, `schedulePathRefresh` :2908,
`services/meshcoreTelemetryPoller.ts`, `services/meshcoreObserverPublisher.ts`.

`connect()` (:1131-1345) re-arms four autonomous TX schedulers on every reconnect — the
guard must hold across reconnects, not just at arm time.

### Routes to map to `409 TX_DISABLED`

`meshcoreMessagingRoutes.ts` :255 /messages/send · :365 /rooms/login · :419
/rooms/login-with-saved · :474 /rooms/post
`meshcoreContactsRoutes.ts` :167 reset-path · :205 discover-path · :247 /discover · :290
/regions/discover · :313 trace-path · :358 ping · :486 share · **:652 `GET`
/contacts/:pk/neighbours** · :757 telemetry/poll · :1011 /neighbors/request
`meshcoreAdminRoutes.ts` :44 /admin/login · :127 /admin/cli · :360 /admin/login-with-saved ·
**:433 `GET` /admin/status/:pk** · :230 /cli (only the `advert` verb)
`meshcoreDeviceRoutes.ts` :262 /advert
`meshcoreAutomationRoutes.ts` :580 /automation/announce/send · :646
/automation/timers/:triggerId/run

Two **GET** routes transmit — easy to miss with a POST-only sweep.
`meshcoreRouteGuard` (`meshcoreRouteShared.ts:43`) is the natural place for a shared helper.

### Virtual Node commands to reject (Phase 3) — `meshcoreVirtualNodeServer.ts`

`SendChannelTxtMsg` :525/:1143 · `SendTxtMsg` :528/:1172 · CLI relay `handleSendCliTxtMsg`
:1264 · `SendSelfAdvert` :536/:768 · `SendLogin` :544/:803 · `SendTracePath` :551/:846 ·
`SendTelemetryReq` :555/:882 · `SendStatusReq` :559/:927 · `SendBinaryReq` :565/:963.
All other handlers (AppStart, GetContacts, GetChannel, SyncNextMessage, device time,
battery, config setters, ExportPrivateKey) stay functional.

## Phases

### Phase 1 — Backend: setting + central command-aware guard
- Add `meshcoreReceiveOnly` to `PER_SOURCE_SETTINGS_KEYS` (+ `PerSourceSettingKey`, and the
  exact-equality assertion in `settings.allowlist.test.ts`).
- `MeshCoreManager.isReceiveOnly()` / `canTransmit()` reading the per-source setting, with a
  cached value refreshed on settings write and on `connect()`; log state changes at info,
  never per-tick.
- Command-aware gate inside `sendBridgeCommand` (denylist above) throwing `TxDisabledError`
  — the belt-and-braces choke point that catches any future TX path.
- Explicit guards in the listed manager primitives (better error sites than the generic one).
- Explicit guard in `meshcoreNativeBackend.handleDiscoverRequest` (chokepoint B).
- Scheduler/auto-ack/auto-responder silent skips with state-change logging.
- Route mapping to `fail(res, 409, 'TX_DISABLED', 'Transmission blocked: this MeshCore
  source is configured for receive-only operation.')`.
- Extend `GET /api/device/tx-status` (or a MeshCore-aware equivalent) so the frontend can
  read receive-only state per source.
- Tests: guard unit tests, denylist coverage test (asserts every RF bridge command is
  gated), scheduler skip tests, route-harness 409 tests, discovery-responder test,
  `*.perSource.test.ts` isolation test.

**Exit criteria:** with `meshcoreReceiveOnly=true` on a source, no code path reaches the
radio; every listed route returns 409; serial config still works; full Vitest suite green.

### Phase 2 — Frontend: gating UX
- Toggle in `MeshCoreSettingsView.tsx` with an explanatory note (and the firmware-limitation
  caveat).
- Reuse/extend `useTxStatus` so MeshCore sources report receive-only; banner via `AppBanners`.
- Disable + tooltip every MeshCore TX control: messaging send box, advert button, admin
  login/CLI, discover/regions/trace/ping/share/neighbours, telemetry poll, room post,
  automation "send now"/"run now" buttons.
- "Paused — receive-only mode" notes on auto-ack / auto-announce / auto-responder /
  pathfinding / timer-trigger sections (settings stay editable-but-inert or disabled — pick
  one and be consistent).
- Graceful 409 handling (toast, not crash) wherever a race slips through.
- Tests: component disabled-state tests.

**Exit criteria:** every MeshCore TX surface visibly disabled with a reason; browser-validated.

### Phase 3 — Virtual Node gating + docs
- Reject the 9 VN TX commands with an `Err` frame; keep read paths serving.
- Tests for each rejected command + a read-path regression test.
- User doc page (`docs/features/…`) modeled on `docs/features/receive-only-mode.md`,
  documenting what still works, what is blocked, and the firmware limitation.
- REST API docs: 409 `TX_DISABLED` on the MeshCore routes; i18n strings across locales.

**Exit criteria:** a third-party MeshCore client on the VN port cannot transmit; docs shipped.

## Risks / easy misses

1. `meshcoreNativeBackend.ts:831` discovery auto-response — the only TX that never touches
   `sendBridgeCommand`.
2. Raw ANON_REQ / discover frames at `meshcoreNativeBackend.ts:1084, 1129, 1200, 1272` —
   inside `dispatch`, so the command-name gate covers them, but a `sendTextMessage` grep
   would not.
3. Two GET routes that transmit.
4. The Virtual Node port bypasses the whole HTTP API.
5. Timer-driven retries (DM ACK, channel) fire long after the originating request returned.
6. `connect()` re-arms schedulers on every reconnect.
7. `sendLocalCliCommand('advert')` — the local-CLI path becomes RF for this one verb.
