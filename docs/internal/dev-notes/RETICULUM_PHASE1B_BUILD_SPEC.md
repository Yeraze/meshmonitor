# Reticulum Phase 1b Build Spec (Frontend + Deployment)

Epic #3960 · branch `feature/reticulum-phase-1b` · worktree `/home/yeraze/Development/meshmonitor-reticulum-1b`
Scope: UI + deployment on top of merged Phase 1a. No messaging/map/radio (Phases 2-3).

## 0. Orchestrator rulings (resolve the architect's open risks)

- **R1, interface gauges: DESCOPE confirmed.** Phase 1b renders ONLY the fields 1a persists on
  `reticulum_interfaces` (`status`/`online`, `bitrate`, `txBytes`/`rxBytes`, `interfaceType`, `mode`) plus
  tx/rx-rate history from the shared telemetry table. Do NOT pull Phase-3 LoRa columns (airtime, channel
  load, noise floor, battery) forward, they don't exist yet and belong to Phase 3 (`own` mode).
- **R2 + log-tail: DESCOPE the live log tail; INCLUDE WP-B.** No `CliConsoleBody` bridge-log console (no
  bridge log protocol/route; `CliConsoleBody` is a command console, not a tailer). Info view is a
  status/health panel. **WP-B is IN scope:** cache the bridge's last `welcome`/`status` (`bridgeVersion`,
  `rnsVersion`) in `ReticulumManager` and expose them on `GET /reticulum/status`, so Info shows versions +
  attach state + counts. Transport ID stays out (Phase 3).
- **R3, `nodeTypeCategory`:** no-op/comment this phase (real work lands with the Phase-3 map).
- **R4, no realtime:** `useReticulum` is poll-based (1a wired no `reticulum:*` Socket.io events). Acceptable
  for 1b; do not pull push events forward.
- **R5, CI license separation (INVARIANT):** publish the bridge image from the **existing bridge-scoped
  `reticulum-bridge.yml`** (add a `publish` job), NEVER from `docker-publish.yml`/`ci.yml`. RNS's non-OSI
  license must not touch the main `node:24` image (`bridge/NOTICE`).
- **R6, deploy coordination:** Stage-5 browser validation redeploys the shared dev container. A release
  (`chore/release-4.14.2-rc1`) is in progress on this machine, the orchestrator will gate the WP8 deploy on
  that release finishing (do not deploy blind).

## 1. Reuse inventory (build on these, do not reinvent)

| Concern | Reuse (current path) | Notes |
|---|---|---|
| Page chrome (topbar, login, connection chip) | `src/pages/MeshCoreSourcePage.tsx` | Template for `ReticulumSourcePage.tsx`. Wraps `SettingsProvider`→`ToastProvider`→`MapProvider`. |
| Multi-pane page + sub-toolbar | `src/components/MeshCore/MeshCorePage.tsx`, `MeshCoreSubToolbar.tsx` | Template for `ReticulumPage.tsx` + `ReticulumSubToolbar.tsx`. |
| Sub-toolbar nav primitive | `src/components/nav/SourceNav` | `ReticulumSubToolbar` delegates rendering here. |
| Table sort/filter/virtualization | `src/components/MeshCore/MeshCoreNodesView.tsx` | Template for `ReticulumDestinationsView`. |
| Dashboard mount for history | `src/components/MeshCore/MeshCoreTelemetryView.tsx` | Template for the Interfaces-view Dashboard mount. |
| Dashboard adapter contract | `src/components/Dashboard/dataSources.ts` (`DashboardDataSource`, `meshcoreDashboardSource`) | Add `reticulumDashboardSource`; widen `kind` union. |
| Info/identity page | `src/components/MeshCore/MeshCoreInfoView.tsx` | Template for `ReticulumInfoView`. |
| Icons | `src/components/icons` (`UiIcon`, `BrandIcon`) | No hardcoded emoji (CLAUDE.md). |
| API access | `src/services/api.ts` (`api.get`/`api.post`/`api.request`) | Raw `fetch()` banned in `components/**`,`pages/**`. |
| Hook pattern | `src/components/MeshCore/hooks/useMeshCore.ts` | Template for `useReticulum` (poll-based, R4). |
| Save bar | `SaveBarProvider`/`SaveBar` | Settings view. |
| Form styling | `styles/settings.css`, `.dashboard-form-*` | DashboardPage fieldset. |
| Source config (server, authoritative) | `src/server/reticulumConfig.ts` (`ReticulumSourceConfig`) | Fieldset must produce exactly this shape; mirror validation client-side. |
| Deployment precedent | attach spec §8; `helm/meshmonitor/*`; `bridge/Dockerfile`+`bridge/NOTICE`; `.github/workflows/reticulum-bridge.yml` | See §4. |

New CSS as CSS Modules (`Component.module.css`), never the frozen global sheets.

## 2. Exact API contract (mounts at `/api/sources/:id/reticulum`)

Every handler uses `ok(res, x)` → body `{ success:true, data:x }`. **`api.get()` returns the raw body and does
NOT unwrap `data`**, every UI call reads `.data` (mirror `meshcoreDashboardSource`'s `res?.data ?? res`).

| Method | Path | Auth | `data` payload |
|---|---|---|---|
| GET | `/status` | `optionalAuth()` | `{ connected, mode?, interfaceCount, destinationCount }` (+`rnsVersion?`,`bridgeVersion?` after WP-B); 200 with `connected:false` when manager unregistered. |
| GET | `/destinations?favorite=&appName=&limit=` | `nodes:read` | `ReticulumDestinationRow[]` |
| GET | `/destinations/:hash` | `nodes:read` | `ReticulumDestinationRow` (404 `DESTINATION_NOT_FOUND`) |
| POST | `/destinations/:hash/favorite` `{favorite}` | `nodes:write` | `{ destinationHash, isFavorite }` (400 `INVALID_FAVORITE`) |
| GET | `/interfaces` | `nodes:read` | `ReticulumInterfaceRow[]` |
| GET | `/interfaces/:name/history?since=&limit=` | `nodes:read` | `Array<{ telemetryType, timestamp, value }>`, types `reticulum_iface_tx_rate`/`reticulum_iface_rx_rate` |

- **`ReticulumDestinationRow`**: `destinationHash, identityHash, appName, aspects, displayName, appDataB64, hops,
  nextHopInterface, rssi, snr, quality, announceCount, firstSeen, lastSeen, lastAnnounceAt, isFavorite,...`.
  **"Announce rate" is derived** in UI: `announceCount / (lastSeen − firstSeen)`.
- **`ReticulumInterfaceRow`**: `interfaceName, interfaceType, interfaceHash, mode, status, online, bitrate,
  txBytes, rxBytes, lastSeenAt,...` (R1, no airtime/channel-load/noise/battery in 1b).
- Connect/disconnect: generic `POST /api/sources/:id/{connect,disconnect}` (`connection:write`), no body.

## 3. File-by-file changes

### 3a. Components (under `src/components/Reticulum/`, each with a `*.module.css`)
- **`ReticulumPage.tsx`**, mirror `MeshCorePage`: status bar + `ReticulumSubToolbar` + content switch. Consumes `useReticulum`.
- **`ReticulumSubToolbar.tsx`**, `type ReticulumView = 'destinations' | 'interfaces' | 'info' | 'settings'`; `UiIcon` per item; delegate to `SourceNav`.
- **`ReticulumDestinationsView.tsx`**, table mirroring `MeshCoreNodesView`: hash (truncate + click-to-copy), display name, app name, aspects, hops, RSSI/SNR/quality, last heard, announce rate (derived), favorites-first + favorite toggle POST.
- **`ReticulumInterfacesView.tsx`**, per-interface cards (status/online chip, bitrate, tx/rx bytes, tx/rx-rate gauges) + `<Dashboard baseUrl dataSource={reticulumDashboardSource}/>` for history. R1-limited fields only.
- **`ReticulumInfoView.tsx`**, status/health panel from `/status` (connected, mode, counts, + versions via WP-B). No log tail.
- **`ReticulumSettingsView.tsx`**, retention cap (`reticulum_destinations_max`) via `SaveBarProvider` (thin).
- **`hooks/useReticulum.ts`**, poll `/status` (30s), `/destinations`, `/interfaces` via `api.get`, unwrapping `.data`.

### 3b. Page wrapper
- **`src/pages/ReticulumSourcePage.tsx`** (+ test), copy `MeshCoreSourcePage`; gate on `hasPermission('nodes','read')`; renders `<ReticulumPage…/>`.

### 3c. Per-type conditionals (one-liner each unless noted)
| File | Change |
|---|---|
| `src/main.tsx` | `SourceApp`: add `reticulum` branch → `<ReticulumSourcePage/>` (mirror meshcore). |
| `src/pages/DashboardPage.tsx` | formType union `+ 'reticulum'`; `<option>`; edit-populate + save/validate branch; fieldset (§3d). |
| `src/contexts/SourceContext.tsx` | `sourceType` already `string\|null`, no type change; update doc comment only. |
| `src/components/Dashboard/DashboardSidebar.tsx` | add `reticulum` to raw-type-badge exclusion + watermark logic. |
| `src/components/SearchModal/SearchModal.tsx` | add reticulum to the source-type icon/label map. |
| `src/utils/nodeTypeCategory.ts` | R3, comment/no-op this phase. |
| `src/components/Dashboard/dataSources.ts` | widen `kind` + add `reticulumDashboardSource` (§3e). |

### 3d. DashboardPage fieldset → `ReticulumSourceConfig`
State: `formRnsMode('attach'|'tcp_peer')`, `formRnsConfigDir`, `formRnsBridgeUrl`, `formRnsToken`, `formRnsAutoConnect`, `formRnsPeerHost`, `formRnsPeerPort`. Fieldset mirrors the `meshcore` block (`.dashboard-form-*`, `UiIcon`, `t()`): mode select; attach→config dir; tcp_peer→peer host+port; bridge URL (placeholder `ws://127.0.0.1:8765`); token; auto-connect. Save branch builds `cfg` = `{ mode, bridgeUrl?, token?, autoConnect, ...(attach?{configDir}:{peers:[{host,port}]}) }` with client-side validation mirroring `reticulumConfigFromSource` (attach needs configDir; tcp_peer needs a well-formed peer; bridgeUrl must be ws/wss). POST `{ type:'reticulum', config:cfg }`. Edit branch hydrates `formRns*` from `source.config`.

### 3e. `reticulumDashboardSource` adapter (~40 LOC in `dataSources.ts`)
Map interface rows → `NodeInfo` keyed on the synthetic telemetry nodeId so Dashboard history resolves the `reticulum_iface_tx_rate`/`_rx_rate` samples. `user.id` MUST equal `reticulumInterfaceNodeId(name)` = `rns:iface:<name>` (from `src/server/services/reticulumTelemetry.ts`). `nodeNum:0`, `showRoleFilter:false`, `showCustomWidgets:false`. Defensive `.data` unwrap.

## 4. Deployment
- **`docker-compose.reticulum.yml`** (opt-in overlay), `meshmonitor-rns-bridge` service, `image: ghcr.io/yeraze/meshmonitor-rns-bridge:latest`, attach: `network_mode: host` + `${HOME}/.reticulum:/rns` + `MM_RNS_MODE=attach`,`MM_RNS_CONFIGDIR=/rns`,`MM_RNS_BIND=127.0.0.1:8765`,`MM_RNS_TOKEN=${MM_RNS_TOKEN:?}`; tcp_peer: drop host-net+volume, add `MM_RNS_PEER`.
- **Helm**, `values.yaml`: `reticulum:{enabled:false,image,mode,configDir,token,bind}`; `templates/deployment.yaml`: `{{- if .Values.reticulum.enabled }}` optional container + `hostNetwork:true` (attach). Default installs unchanged.
- **CI image publish (R5)**, add a `publish` job to `reticulum-bridge.yml` (buildx amd64/arm64, ghcr login) that builds `bridge/Dockerfile` → `ghcr.io/yeraze/meshmonitor-rns-bridge` on `release: published` + `workflow_dispatch`. Keep pytest as the PR gate. Surface `bridge/NOTICE`.
- **Docs**, deployment guide (overlay + Helm gate) + `rpc_key` troubleshooting (identical `rpc_key` in both rnsd + bridge config, mount nothing).

## 5. Test plan
Vitest + Testing Library: `ReticulumSourcePage.test.tsx` (chrome, permission gate), `ReticulumPage` view switching, `ReticulumDestinationsView` (sort/filter/copy/favorite/announce-rate), `ReticulumInterfacesView` (cards + Dashboard smoke), `ReticulumInfoView` (status fields), `DashboardPage` reticulum fieldset (mirror `DashboardPage.observerFieldset.test.tsx`, attach vs tcp_peer visibility, config serialization, validation), `main.tsx` dispatch, `dataSources.test.ts` (`reticulumDashboardSource`). WP-B: a `/status` versions route test.
**Browser validation (Stage 5, gated on release, R6):** deploy dev container → create Reticulum source via modal (attach, config dir, bridge URL, token) → confirm sidebar entry + navigation opens `ReticulumSourcePage` → exercise Destinations/Interfaces/Info/Settings. Green gates: full `npm test`, typecheck, `lint:ci`.

## 6. Work packages (Sonnet, dependency-ordered)
| WP | Deliverable | Deps | Accept |
|---|---|---|---|
| **WP-B** | `/reticulum/status` returns `rnsVersion`/`bridgeVersion` (cache last welcome/status in `ReticulumManager`). | 1a | route test green |
| **WP1** | types + `useReticulum` + `api` methods + `reticulumDashboardSource`. | 1a | adapter/hook tests green |
| **WP2** | `ReticulumSubToolbar` + `ReticulumPage` + `ReticulumSourcePage` + `main.tsx` dispatch. | WP1 | source routes to page; permission gate |
| **WP3** | `ReticulumDestinationsView`. | WP2 | sort/filter/copy/favorite tests |
| **WP4** | `ReticulumInterfacesView` + Dashboard mount. | WP1,WP2 | cards + history via adapter |
| **WP5** | `ReticulumInfoView` (+Settings stub). | WP2,WP-B | status/versions render |
| **WP6** | `DashboardPage` fieldset + edit/save; `DashboardSidebar`,`SearchModal`,`nodeTypeCategory`,`SourceContext`. | WP1 | create/edit produces valid config; fieldset test |
| **WP7** | compose overlay, Helm gate, bridge image publish job, docs + `rpc_key` guide. |, (parallel) | overlay/Helm lint clean; workflow builds image |
| **WP8** | test sweep + Stage-5 browser validation (release-gated). | WP2-WP6 | suite/typecheck/lint green; browser checklist |

Graph: `WP-B→WP5`; `WP1→WP2→{WP3,WP4,WP5}`; `WP1→WP6`; `WP7` parallel; `{WP2..WP6}→WP8`. Single PR (frontend + deployment).
