# MeshCore Parity Epic (#6226 follow-ups)

## Goal

Close the feasible Meshtastic ↔ MeshCore gaps found by the #6226 audit. Each
issue ships as its own PR (or several, for large ones), merged after CI is
green and review feedback is handled. MeshCore features cover Companion and
Repeater sources where both ingest paths allow it.

Audit summary: https://github.com/Yeraze/meshmonitor/issues/6226#issuecomment-6711718051

## Decisions (maintainer, 2026-11-07)

- **Run mode:** one phase per issue, one PR each, merge when green. RF-free
  phases first.
- **#6253 notifications:** reuse the Meshtastic rules as-is (per-channel
  enable/mute, keyword lists, templates, existing dedup). No MeshCore-only cap.
- **#6255 repeater advert intervals:** `advert.interval` 60–240 min,
  `flood.advert.interval` 6–168 h. Enforced on the server and in the input,
  with a warning next to each input.
- **#6263 v1 API TX for MeshCore:** same limits as Meshtastic (`messageLimiter`,
  v1 rate limits) plus existing MeshCore send caps.
- **Firmware verification:** confirm CLI verbs / companion commands against
  supported firmware before building #6255 and #6257 controls.
- **One implementation for all sources (maintainer, 2026-11-07):** every
  parity feature uses a single configurable component/hook/service shared by
  the Meshtastic tab and the MeshCore view (props/config for protocol
  differences), not a MeshCore copy. Each phase spec must name the shared
  piece first; a MeshCore-only component needs a stated reason (no protocol
  equivalent). Precedents: `NodeDimmingSettings`, `SignFlipCorrectionSettings`,
  `NotificationsTab`.
- **Dev deploys:** check SQLite integrity and apply the RF lockdown
  (autoConnect off on radios, MQTT broker/bridge rows `enabled=0`) first, or
  use a throwaway volume for screenshots.

## Phases

Each phase's scope is the checklist in its issue.

- [x] **P1 #6258 Settings:** telemetry retention editors, purge telemetry and
  clean outliers, node dimming and hide-incomplete, global restart/shutdown
  and Solar Monitoring reachable without a Meshtastic source.
- [x] **P2 #6261 Messaging:** Room unread, DM/Room mute, mark-all-read,
  translation, composer emoji picker.
- [x] **P3 #6259 Nodes and DM lists:** sort, columns, filters, group by role,
  export, DM list filters and richer rows.
- [x] **P4 #6262 Packet Monitor + contact graphs:** paging, search and filters,
  distribution charts, Unified filters, Smart Hops / Link Quality / Signal Trend.
- [x] **P5 #6260 Map parity:** shared MeshCoreMap layers, trace on map, Map
  Analysis positions/traces/solar, estimated positions. May split.
- [ ] **P6 #6263 Dashboard / API / reports:** dashboard widgets, Mesh Issues,
  Prometheus, v1 API read + TX, embed maps.
- [ ] **P7 #6254 Security view:** dead contacts, hash collisions, advert
  signatures, own-key change, rates/clock/digest. May split.
- [ ] **P8 #6257 Companion extras:** BLE PIN, factory reset, multi-ACKs,
  device-config backups, channel QR share.
- [ ] **P9 #6255 Repeater settings + danger zone.**
- [ ] **P10 #6256 Remote structured config.**
- [ ] **P11 #6253 Notifications.**

## Phase log

(Decisions and deviations recorded as each phase ships.)

### P1 #6258 (spec: `MESHCORE_PARITY_P1_SPEC.md`)
Maintainer answers, 2026-11-07:
- Meshtastic per-source "Purge telemetry" and "Erase nodes" sent no source id and wiped every source. Scope both to the page's source in this phase (like traceroutes, #5089).
- MeshCore "incomplete" = no advertised name OR unknown device type; favourites and local node exempt.
- MeshCore dimming applies to map markers only (Meshtastic parity), not list rows.
- Age window 0 (show all) = no dimming (Meshtastic parity).
- MeshCore telemetry editors write per-source overrides; Meshtastic keeps the global default.
- `meshcore_packet_log_*` per source is out of scope (Meshtastic's packet log is global too).

Shipped: 3 work packages (global moves + purge scoping; dimming + hide-incomplete; MeshCore telemetry settings + danger actions). Deviations: confirm copy for Meshtastic source-page purges now names the source (review finding). Noted, not fixed: on MeshCore Settings the label and its help text render on one line (pre-existing `.setting-description` inline style on that page; every existing field does it).

### P2 #6261 (spec: `MESHCORE_PARITY_P2_SPEC.md`)
Orchestrator decisions (recommended options, aligned with the one-implementation rule):
room unread uses receipt time; room mute lives in `mutedDMs`; MeshCore channels/DMs/rooms
get list-header mark-all; MeshCore composer stays single-line; MeshCore adopts the shared
composer look. Read models stay separate (Meshtastic per-message rows vs MeshCore
watermarks; the schema forbids merging) — the controls and mute state are shared.
Found: translation orphan sweep would delete every MeshCore link — fixed first in WP3.
Shipped: 4 work packages. Shared now: `MuteMenu`/`MutedIndicator` (replaced 3 copies), `MarkAllReadButton` (Meshtastic sidebar, ChannelsTab, DashboardSidebar, MeshCore channels/DMs/rooms), `MessageComposeInput` (MeshCore uses it via `draftStore`/`maxBytes`/`blockSendOverLimit`/`allowNewlines` props), translation pipeline (server dispatch in `translatableMessages.ts`). Deviations: MessagesTab DM mute menu now shows the full option list when muted (shared order). Browser check limited to offline views (MeshCore channel/DM/room views need a live manager); composer, counter and mute bell verified rendered.

### P3 #6259 (spec: `MESHCORE_PARITY_P3_SPEC.md`)
Maintainer answers, 2026-11-07: toolbar sort is persisted for BOTH protocols (Settings
preferred sort is the default until a toolbar pick); MeshCore battery shows voltage only;
DM preview only for live-window threads (no server change). Orchestrator (one-implementation
rule): one shared Group-by-role preference; favorites filter added to both protocols.
#6185 (public-key sort) already implemented — this phase closes it.
Shipped: 4 work packages. Shared now: `nodeSort.sortByKey`/`orderFavoritesFirst`, `nodeExport` generic columns + `exportNodeList`, `nodeAdvancedFilter.passesNodeFilters` + configurable `AdvancedNodeFilterPopup`, `usePersistedListSort`, `usePersistedNodeFilters`, `useNodeRoleGrouping`, `components/nodes/{NodeSortControls,ExportMenuButton,NodeStatChips,RoleDistributionSummary,RoleGroupHeader}`, `BatteryItem`, `dmListFilter`, `DmFilterSelect`, `formatMessagePreview`. MeshCore adapter: `utils/meshcoreNodeRows.ts`. Deviations: UIContext owns the persisted Meshtastic sort (one source of truth); MeshCore DM sort labels keep `meshcore.sort_*` wording.

### P4 #6262 (spec: `MESHCORE_PARITY_P4_SPEC.md`)
Maintainer answers, 2026-11-08: Signal Trend for MeshCore uses our DM reception (snr/rssi of DMs from
the contact) plus polled noise floor; free-text search excludes channel plaintext (per-viewer
decryption stays gated). Orchestrator: no backfill of the new derived columns (retention ≤30 d);
meshcore_mqtt distribution counts receptions. Contact graphs are a read-side adapter (no new
telemetry writers). Migration 224 adds derived packet-log columns + indexes.
Shipped: migration 224 + derived sender fields; cursor paging, search, payload/route filters and a
distribution endpoint for the MeshCore packet log; shared `usePagedPackets` / `useInfiniteVirtualRows`
hooks drive both protocols' monitors; unified monitor merges distribution protocol-tagged; MeshCore
contact panel gets "Link history" via the shared Meshtastic graph components. Browser-checked on a
throwaway volume (popout monitor renders, routes return paged envelopes, no console errors).

### P5 #6260 (spec: `MESHCORE_PARITY_P5_SPEC.md`)
Maintainer answers, 2026-11-08: estimated positions computed on read (no table/scheduler); hop shading
from `path_len`; Traceroute Explorer split to a follow-up issue; stationary nodes get one current fix
in heatmap/coverage; playback for any selected contact with ≥2 fixes; solar overrides keyed on the
synthetic nodeNum; local markers reuse `waypoints`. Read-only phase, no migration.
Shipped (WP1–WP5): Map Analysis positions/coverage/hop shading/solar for MeshCore (two-phase cursor,
`nodeKey` identity); shared MapInstanceBridge / useMap3DToggle / useLocalMarkerAuthoring /
RouteFlowMap / EstimatedPositionRadiiLayer; MeshCoreMap local markers, cross-source links,
clustering, 3D, playback, estimated positions; Trace Path map card; MeshCore trace links on the
Map Analysis traceroute layer (2D+3D). Browser check on a seeded throwaway volume: all new routes
return correct data; Map Analysis draws MeshCore nodes + heatmap. The MeshCore Nodes map draws the
live device contact list, so its markers need a connected companion (pre-existing behaviour).
Follow-up: #6276 (Traceroute Explorer).
