# Reticulum Phase 3 Build Spec, Position, Telemetry & Radio (own mode)

Epic #3960. Worktree /home/yeraze/Development/meshmonitor-reticulum-3 (branch feature/reticulum-phase-3). Builds on Phases 1a+1b+2 (merged). Identifiers below are PLAIN TEXT (no backticks) to avoid the markdown-corruption bug that hit the Phase 2 spec.

## 0. Orchestrator rulings

- R1 (own mode is NET-NEW, correction to the brief): the merged bridge config.py VALID_MODES = ("attach","tcp_peer") and both ReticulumMode declarations exclude 'own'. Phase 3 INTRODUCES own mode end-to-end (bridge _start_own + RNodeInterface, KISS command encoders, new protocol types, TS ReticulumMode+='own', config-UI fields, deploy shape /dev/ttyUSB* + dialout group). ACCEPTED as Phase 3 scope. own-mode radio config is validated by CONTRACT/UNIT tests ONLY (hardware-free: KISS encoders vs byte vectors, config parse, handlers vs a mocked RNodeInterface, wire-contract fixtures). No physical RNode, no live-radio assertions in CI.
- R2 (device-info storage): ONE deviceInfoJson text column on reticulum_interfaces (loose convention, read-only). Approved (avoids a churny per-field migration). Editable radio params stay typed columns (UI binds/validates each).
- R3: a DEDICATED bridge event TYPE_TELEMETRY (not folded into lxmf_message) so telemetry-only Sideband packets never create chat rows. Approved.
- R4: declare msgpack explicitly in bridge/requirements (Apache-2.0, sidecar-only, never the main image). Approved.
- R5 (Sideband format is a convention in one file): keep WP0 to de-risk msgpack decode against a real-or-synthetic FIELD_TELEMETRY payload before WP2 builds on it. TIMEBOX WP0 (Phase 2's WP0 hung ~2h on a network loop, this WP0 is a fixture-build + SID-map confirmation, no rnsd networking, so keep it bounded and do NOT let any integration attempt run unbounded).
- Migration numbers: 144 (position on destinations) + 145 (radio-config/device-info on interfaces). Verified current max is 143. migration count test updated per the /migration recipe.
- Invariants: per-source scoping on all new columns/rows + routes (sourceIdFrom params.id); shared-telemetry-table pattern (synthetic nodeNum + text nodeId, rns:dest: namespace); BaseMap COMPOSE not fork;.js imports; VALID_SETTINGS_KEYS; CSS modules; NO Meshtastic global estimated_positions batch (Reticulum position is peer-shared per-source, latest-only).

## 1. Reuse inventory (compose, do not reinvent)

- Map shell: src/components/map/BaseMap.tsx (MeshCoreMap is the working precedent).
- Node markers: src/components/map/layers/NodeMarkersLayer.tsx (NodeMarkerDescriptor).
- Popup: src/components/map/popups/NodeCard.tsx + nodeCardModel.ts (toNodeCardModel); detail sections in src/components/map/popups/sections.tsx (add ReticulumDetails sibling to MeshCoreDetails).
- Map template: src/components/MeshCore/MeshCoreMap.tsx (positioned filter + shouldDiscardPosition/null-island, MapLoadingOverlay, MapLegend, fit-bounds via keyed remount).
- Config-view template: src/components/MeshCore/MeshCoreConfigurationView.tsx (hasPermission('configuration','write') gating, per-field disabled, radio-param + TX-power form).
- Sub-toolbar: src/components/Reticulum/ReticulumSubToolbar.tsx ITEMS + src/components/nav/SourceNav.tsx.
- View host: src/components/Reticulum/ReticulumPage.tsx.
- Shared telemetry: src/db/schema/telemetry.ts + src/db/repositories/telemetry.ts (insertTelemetryBatch). Sideband sensors ride this (MeshCore + reticulum interface history already prove the synthetic-nodeNum/no-nodes-row pattern is safe on all backends).
- Synthetic-identity helper: src/server/services/reticulumTelemetry.ts (crc32; add rns:dest per-destination helpers).
- Ingest host: src/server/reticulumManager.ts (handleLxmfMessage/handleInterfaceStats pattern).
- Bridge: bridge/meshmonitor_rns_bridge/{rns_manager.py, protocol.py, ws_server.py, config.py}.
- TS protocol mirror: src/server/reticulumProtocol.ts (MESSAGE_TYPE, ReticulumMode).
- Dashboard: src/hooks/useDashboardData.ts + Dashboard/dataSources.ts + src/server/services/sourceDashboardData* (extend to surface rns_* telemetry types).

## 2. Bridge additions

### 2.A Sideband FIELD_TELEMETRY decode (ALL modes)
Sideband telemetry rides inside a normal LXMF message as LXMF.FIELD_TELEMETRY (id 0x02), msgpack-packed by Sideband sense.py (Sensor SIDs; SID_LOCATION packs lat/lon/altitude/speed/bearing/accuracy/timestamp via Location.pack). It arrives through the existing LXMF delivery callback.
- New module bridge/meshmonitor_rns_bridge/sideband_telemetry.py: SID_* -> stable wire sensor name map (pinned subset below); decode_field_telemetry(raw) -> { sensors:{name:{value,unit?}}, location?:{lat,lon,altitude,speed,bearing,accuracy}, ts }. Unknown SIDs are opaque (skip, never crash). Uses msgpack (declare explicitly).
- In rns_manager.py LXMF path (near _sanitize_lxmf_fields), detect FIELD_TELEMETRY -> emit TYPE_TELEMETRY event { sourceHash, destinationHash, sensors, location?, ts }. Do NOT create a reticulum_messages row for telemetry-only packets. A message carrying both text and telemetry emits BOTH lxmf_message and telemetry.
- Pinned SID subset -> telemetryType: SID_BATTERY->rns_battery, SID_TEMPERATURE->rns_temperature, SID_HUMIDITY->rns_humidity, SID_PRESSURE->rns_pressure, SID_POWER_CONSUMPTION/PRODUCTION->rns_power_in/rns_power_out, SID_PROCESSOR->rns_cpu, SID_RAM->rns_ram, SID_NVM->rns_nvm, SID_PHYSICAL_LINK->rns_link_rssi/rns_link_snr/rns_link_q. SID_LOCATION -> position (see §3/§4), not telemetry.
- Fixtures: bridge/tests/fixtures/sideband_telemetry_*.bin (real or spec-faithful synthetic) + expected decoded JSON.

### 2.B own mode + RNode radio config + device info (own mode ONLY, net-new)
- config.py: VALID_MODES += 'own'; parse RNS_OWN_DEVICE (e.g. /dev/ttyUSB0) + initial RNode params (frequency,bandwidth,sf,cr,txpower,st_alock,lt_alock). own requires a device path.
- rns_manager.py: _start_own(configdir) builds RNS.Interfaces.RNodeInterface on the device with initial params, alongside _start_attach/_start_tcp_peer.
- New bridge/meshmonitor_rns_bridge/rnode_kiss.py: pure byte-string builders for CMD_FREQUENCY/BANDWIDTH/TXPOWER/SF/CR/ST_ALOCK/LT_ALOCK/RADIO_STATE and readers for CMD_FW_VERSION/CMD_BOARD(MCU/platform)/CMD_STAT_BAT/CMD_STAT_TEMP(chip temp)/CMD_STAT_CSMA/CMD_STAT_PHYPRM. These are the only radio pieces validated in CI (pure encode/decode).
- Handlers for get_radio_config / set_radio_config / get_device_info: read/apply params off the RNodeInterface; in attach/tcp_peer return a typed own-mode-required error (never crash).
- Validation is contract/unit ONLY (mocked interface; byte-vector encoders; config parse; wire fixtures). Live LoRa PHY is out of CI scope.

### 2.C Wire-protocol additions (protocol.py + reticulumProtocol.ts mirror)
- TYPE_TELEMETRY = "telemetry" (event): { sourceHash, destinationHash, sensors, location?, ts }.
- TYPE_GET_RADIO_CONFIG/"get_radio_config" + TYPE_RADIO_CONFIG/"radio_config": frequency,bandwidth,spreadingFactor,codingRate,txPower,stAlock,ltAlock,radioState.
- TYPE_SET_RADIO_CONFIG/"set_radio_config" (command, partial allowed).
- TYPE_GET_DEVICE_INFO/"get_device_info" + TYPE_DEVICE_INFO/"device_info": firmwareVersion,mcu,platform,chipTemp,csma{},phy{}.
- Add 'own' to reticulumProtocol.ts ReticulumMode + ConfigureMessage payload (device path + initial params). Each new response type gets a JSON fixture (bridge) + decode test (TS).

## 3. Data model

### Migration 144 add_reticulum_destination_position
Nullable position columns on reticulum_destinations (deferred from Phase 1a; design §5): latitude, longitude, altitude, speed, bearing, accuracy (SQLite real / PG doublePrecision / MySQL double, nullable); positionUpdatedAt (integer/bigint epoch ms, nullable). Repository: accept an optional position patch on upsert keyed (sourceId, destinationHash) + a getDestinationsWithPosition read. LATEST-ONLY overwrite (peer-shared per-source; no history table; no estimated_positions).

### Migration 145 add_reticulum_interface_radio_config
Nullable columns on reticulum_interfaces (own-mode; deferred LoRa params): frequency, bandwidth, spreadingFactor, codingRate, txPower, stAlock, ltAlock, radioState (integer boolean); deviceInfoJson (text, R2). Only written in own mode; attach/tcp_peer leave null.

### Shared telemetry table (no migration)
Sideband sensors -> insertTelemetryBatch under nodeId = rns:dest:<destinationHash> (new helper, namespaced so it can't collide with rns:iface: / Meshtastic!hexid / MeshCore 64-hex), nodeNum = crc32("dest:<hash>") & 0x7fffffff, telemetryType = rns_* per §2.A. Add the new telemetryType constants next to RETICULUM_IFACE_TX_RATE/RX_RATE. Register any new settings key in VALID_SETTINGS_KEYS.

## 4. Backend

Ingest (reticulumManager.ts): client.on('telemetry') -> handleTelemetry: sensors -> DbTelemetry rows via rns:dest helpers -> insertTelemetryBatch(rows, sourceId) (mirror handleInterfaceStats); location -> write the six position columns + positionUpdatedAt onto the reticulum_destinations row (guard null-island server-side). Estimated-position: latest-only on the destination row; do NOT touch estimated_positions/anchors/distance schedulers (they stay no-ops). Position history is out of Phase 3 scope.

Routes (reticulumRoutes.ts, configuration resource, sourceIdFrom params.id): GET /:id/radio-config (configuration:read -> bridge get_radio_config; typed 409 own-mode-required otherwise); PUT /:id/radio-config (configuration:write -> set_radio_config, validate ranges first); GET /:id/device-info (configuration:read). Position/telemetry served by the existing destinations (now position-bearing) + telemetry reads; expose position columns in the destinations response.

Config plumbing: reticulumConfig.ts + sourceRoutes.ts accept mode 'own' (device path + initial radio params) forwarded in CONFIGURE. types/reticulum.ts: ReticulumMode = 'attach'|'tcp_peer'|'own'; extend ReticulumSourceConfig with own-mode fields.

## 5. Frontend

Views/nav: ReticulumView = 'destinations'|'interfaces'|'dms'|'info'|'settings'|'map'|'configuration'. ReticulumSubToolbar ITEMS: add map (icon 'map', always shown) + configuration (own-mode gated, hide otherwise, mirroring MeshCore hiding Meshtastic-only panels). ReticulumPage: add both branches.

ReticulumMap (new, src/components/Reticulum/ReticulumMap.tsx): clone MeshCoreMap, positioned = finite lat/lon + shouldDiscardPosition; compose BaseMap (keyed remount fit-bounds) + NodeMarkersLayer + MapLoadingOverlay + MapLegend; each marker Popup = NodeCard(toNodeCardModel) + ReticulumDetails. Empty-state: "No peers are sharing position/telemetry" (design risk #3). Skip neighbor-links/hop-star/polar-grid (no neighbor/hop concept in Reticulum).

ReticulumDetails (new, in map/popups/sections.tsx): sibling to MeshCoreDetails, destination/identity hash, app name/aspects, last announce, latest Sideband sensor summary (battery/temp/link) when present.

ReticulumConfigurationView (new): template MeshCoreConfigurationView. own-mode only; write controls disabled unless connected && hasPermission('configuration','write') (permission-denied banner). Radio form (frequency/bandwidth/SF/CR/TX power/airtime locks/radio on-off) bound to GET/PUT /:id/radio-config. Device-info panel (read-only) from GET /:id/device-info.

Telemetry graphs: extend the per-source Dashboard adapter (useDashboardData + dataSources + sourceDashboardData*) to recognize rns_* telemetryTypes so Sideband history renders through the existing Dashboard, no new chart component. CSS modules per file; i18n reticulum.* with fallbacks.

## 6. Test plan

Vitest: migration 144/145 (columns + idempotency all 3 backends; count test); repository (position latest-only overwrite; radio-config/device-info round-trip); manager handleTelemetry (rns_* rows via rns:dest helpers + position columns; null-island rejected; telemetry-only creates no message row); routes (radio-config GET/PUT + device-info, configuration:read/write scoping, own-mode-required rejection in attach/tcp_peer); frontend (ReticulumMap markers + empty state; ReticulumDetails; configuration view hidden/disabled outside own mode + without configuration:write; sub-toolbar gating); Dashboard adapter (rns_* series). pytest (hardware-free): sideband decode vs fixture (map, SID_LOCATION unpack, unknown-SID opacity); rnode_kiss encoders vs byte vectors + device-info decoders; config.py own-mode parse; new protocol builders round-trip; get/set/device-info handlers vs a mocked RNodeInterface + own-mode-required error. Contract fixtures shared bridge<->TS.

## 7. Work packages

- WP0 Spike: verify Sideband msgpack decode. Deps: none. TIMEBOXED (fixture-build, no networking). Accept: a captured/synthetic FIELD_TELEMETRY msgpack fixture + documented SID->field map + Location.pack layout confirmed vs sense.py. Locks the decode approach.
- WP1 Bridge own mode + RNode KISS + device info. Deps: none. Accept: VALID_MODES+='own' w/ device+param parse; _start_own; rnode_kiss encoders/decoders vs byte vectors; get/set_radio_config + get_device_info handlers own-mode-gated (mocked interface); new protocol types+builders; pytest green. Hardware-free.
- WP2 Bridge Sideband telemetry decode -> telemetry event. Deps: WP0. Accept: sideband_telemetry.py + FIELD_TELEMETRY hook + TYPE_TELEMETRY builder; pytest decodes fixture, drops unknown SIDs, telemetry-only emits telemetry not message.
- WP3 Data model. Deps: none. Accept: migrations 144+145 (3 backends, idempotent, count test); schema + repository; rns_* telemetryType constants + rns:dest helpers; VALID_SETTINGS_KEYS; Vitest green (PG/MySQL up).
- WP4 Backend ingest + routes + config plumbing. Deps: WP1, WP2, WP3. Accept: reticulumProtocol new types + ReticulumMode+='own'; handleTelemetry (sensors->telemetry, location->position); radio-config/device-info routes w/ configuration scoping; reticulumConfig own mode; Vitest green.
- WP5 Frontend map + ReticulumDetails. Deps: WP3, WP4. Accept: ReticulumView+='map'; sub-toolbar; ReticulumMap (null-island filtered, empty state); ReticulumDetails; component tests green.
- WP6 Frontend RNode Configuration view. Deps: WP4. Accept: ReticulumView+='configuration' (own-mode gated); radio form wired; device-info panel; permission/own-mode gating tests green.
- WP7 Dashboard telemetry graphs. Deps: WP3, WP4. Accept: per-source Dashboard adapter surfaces rns_* series; adapter test green.

Graph: WP0->WP2; {WP1,WP2,WP3}->WP4; WP4->{WP5,WP6,WP7}; WP5/WP7 also need WP3. Wave 1 (parallel): WP0, WP1, WP3. Wave 2: WP2 (after WP0). Wave 3: WP4. Wave 4 (parallel): WP5, WP6, WP7.
