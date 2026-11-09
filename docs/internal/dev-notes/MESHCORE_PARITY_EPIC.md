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
- [x] **P6 #6263 Dashboard / API / reports:** dashboard widgets, Mesh Issues,
  Prometheus, v1 API read + TX, embed maps.
- [x] **P7 #6254 Security view:** dead contacts, hash collisions, advert
  signatures, own-key change (P7a shipped). P7b (rates, clock flag, scanner,
  digest, export, DM) is follow-up in #6281.
- [ ] **P8 #6257 Companion extras:** BLE PIN, factory reset, multi-ACKs,
  device-config backups, channel QR share.
- [x] **P9 #6255 Repeater settings + danger zone.**
- [x] **P10 #6256 Remote structured config.**
- [x] **P11 #6253 Notifications.**
- [x] **P12 #6279 Mesh Issues node-health rules (A6-A9).**

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

### P6 #6263 (spec: `MESHCORE_PARITY_P6_SPEC.md`)
Maintainer answers, 2026-11-08: v1 TX limits = Meshtastic's (no new caps; docs warn on POST /messages airtime); v1 MeshCore
rows `nodeId mc:<pk>` + additive `protocol` on every row; v1 MeshCore trace fire-and-forget; new `request-telemetry` action
for both protocols gated on `messages:write`; Mesh Issues A4 + A3-resets + C2 (flood advert < 6 h / zero-hop < 60 min) on
MeshCore, four protocol-neutral rules → follow-up; separate payload-type Prometheus metric; per-node MeshCore metrics on
`nodes:read`; embeds reuse existing toggles.
Shipped (WP1–WP8): v1 reads for MeshCore (`nodes`, `channels`, `packets`, `traceroutes`, `network`, `messages`)
with an additive `protocol` field and `mc:<pk>` node ids; v1 TX on MeshCore (`POST /messages` under Meshtastic's
limits, fire-and-forget `actions/traceroute`, new `actions/request-telemetry` for both protocols with the 60 s
gate as 429 + Retry-After); per-source metrics collectors, MeshCore gauges, `meshmonitor_packets_by_payload_type_last_hour`
and per-node `mc:` series on `nodes:read`; Dashboard widgets and Live Mesh Activity on MeshCore; Mesh Issues A4/A3/C2
on MeshCore; embed neighbour links and trace segments under the existing toggles (both ends must be visible, so a
private-override node is never a line end); user docs in `REST_API.md`, `embed-maps.md`, `packet-monitor.md`, `meshcore.md`.

### P7 #6254 (spec: `MESHCORE_PARITY_P7_SPEC.md`)
Maintainer answers, 2026-11-08: split into P7a (dead contacts + bulk delete, collisions, advert signatures, name under
new key, own-key change alert; no migration, no RF) and P7b (rates, clock-offset flag, MeshCore in scanner / digest /
export / DM). Per-source `securityDeadNodeDays` (Meshtastic 7, MeshCore 14). Bulk delete needs security:write AND
per-source nodes:write; Companion deletes radio + DB. Own-key alert once per change via `notifyOnServerEvents`. Name
reuse display-only. Repeater adverts always signature-checked; unchecked = null.

Shipped (P7a): the Security tab is protocol-aware. MeshCore sources show dead contacts (per-source `securityDeadNodeDays`,
default 14 days; Meshtastic 7) with bulk delete (needs security:write and per-source nodes:write; a connected Companion
deletes from the radio and DB, others from the DB only), path-hash collisions at the source's hash width, advert
signature status (Verified / Failed / Not checked; only Repeater and MQTT check), name reused under a new key (display
only), and an own-key change card with one alert per change and an Acknowledge action. Dead-nodes and findings routes now
need `nodes:read` on the source for both protocols. No migration, no RF. P7b (rates, clock-offset flag, scanner, digest,
export, DM) follows in #6281. User docs: `docs/features/security.md`, `meshcore.md`.

### P8 #6257 (spec: `MESHCORE_PARITY_P8_SPEC.md`)
Maintainer answers, 2026-11-08: leak fix (device backups exported every source's channel secrets) shipped first as
PR #6284; P8a = BLE PIN, multi-ACKs (0/1 only, airtime warning), factory reset (admin + typed name, fw ≥ 7, TCP allowed
with warning, expected identity change audited not alerted), channel share/import URL (`configuration:write`,
`region_scope` included); P8b = per-source protocol-aware device-config backups (migration 226).
Shipped (P8a): BLE PIN (raw cmd 37), multi-ACKs 0/1 with SelfInfo readback (fw ≥ 7; v1.7.3 ignores byte 5),
factory reset (cmd 51, fw ≥ 7, admin + typed name, expected identity change audited not alerted), channel share/import
via `meshcore://channel/add` with shared Export/Import modals and the config-capable device gate. Fixed: the raw
other-params writer preserves the auto-add bits. Leak fix shipped separately (#6284). P8b (per-source config backups,
migration 226) follows.

### P9 #6255 (spec: `MESHCORE_PARITY_P9_SPEC.md`)
Maintainer answers, 2026-11-08: Off (0) allowed for both advert intervals with a reachability warning (clamps otherwise
60–240 min / 6–168 h); power-off and key restore admin + typed name on both protocols, restore auto-reboots with a pinned
expected key; forwarding knobs use firmware ranges with inline warnings (af < 1, flood.max ≤ 2, repeat off); guest
password never sent to the browser; `set prv.key` added to the danger guard; existing repeater secret debug-log leak fixed;
Companion gets power-off too.
Shipped (P9): shared repeater settings schema + CLI reply parser (`utils/meshcoreRepeaterSettings.ts`), LoRa airtime
estimate (`utils/loraAirtime.ts`), transport-agnostic settings service (local serial now; P10 adds the remote transport),
GET/PATCH repeater-settings (diff + readback), Repeater coords / reboot / clock sync / key export+restore, power-off for
Repeater (fw 1.15+) and Companion (protocol 14+), admin + typed name for power-off and restore on both protocols, pinned
expected identity change, `set prv.key` in the danger guard, extra CLI reply terminators, and the repeater secret
debug-log leak fixed.


### P10 #6256 (spec: `MESHCORE_PARITY_P10_SPEC.md`)
Maintainer answers, 2026-11-09: the same `RepeaterSettingsForm` + settings service over a remote CLI transport; reads per
group (identity / adverts / access) with a cost line, nothing on mount, flood warning when the path is unknown; caps one
operation per (source, target), 40 remote commands / 10 min per source, ≥ 1 s gap, `recordMeshTx` per command, stop at the
first timeout (rest `NOT_SENT`), no retries or auto re-login; admin password console-only, radio read-only remotely, TX
power writable with a warning; `remote_admin:write` for read and save; Room Server hides forwarding knobs; readback only
the sent keys; export/import from read values without secrets (also on the local form); one redacted CLI-history row per
set; requires a remembered admin session.
Shipped (P10): remote CLI transport + read/PATCH routes with the limits above, schema groups / device types / remote
access, `name` / `txPower` / `radio` keys, `readback:'sent'`, stop-at-first-timeout with `NOT_SENT`, the same form in
remote mode inside the remote console, and settings export/import on both forms. Deviations: TX power is a hard 1–30 dBm
range (plus the warning); an empty reply also stops a remote run; no "Discover path" link next to the flood warning
(the warning says to learn the path first).

### P11 #6253 (spec: `MESHCORE_PARITY_P11_SPEC.md`)
Maintainer answers, 2026-11-09: room posts follow the DM toggle and DM mute; accept DM pushes starting for existing
MeshCore subscribers (release note); a mute beats a mention; the Disconnect button notifies, shutdown/edits stay silent;
the per-DM mute fix applies to Meshtastic too; Repeater "New nodes" hidden with a hint (follow-up); click-through in P11;
key-access gate on every MeshCore notification (closes the mention leak of keyed channel text).
Shipped (P11): protocol-neutral `dispatchMessageNotification` (Meshtastic adapter unchanged except the DM-mute fix),
key-access gate on every notification path (closes the mention leak), desktop counts as an available service, MeshCore
message notifier (channel / DM / room post, content dedup keys, one ordered mention→message chain per source), MeshCore
server connect/disconnect and trace/path-discovery notifications, a notification capability map for the tab
(Companion vs Repeater, channel list from `/api/channels/all`), shared audio settings + `useMessageSound`, and
click-through on the MeshCore page. Follow-ups: Repeater advert new-node alerts; a Notifications tab for `meshcore_mqtt`.

### P12 #6279 (spec: `MESHCORE_PARITY_P12_SPEC.md`)
Maintainer decisions, 2026-11-09: all recommended options. Infra nodes only; stale 24 h Meshtastic / 96 h MeshCore
(tunable) and no flag after 30 days; low battery 20 % / 3300 mV (tunable); a position override suppresses A7; A8 skips
nodes whose A3 battery clause fires; A9 accepted as mostly quiet with discard on; A6-A9 in Tier A. No RF, no notifications.
Shipped (P12): one shared implementation of A6 stale, A7 no position, A8 low battery and A9 bad position on `PooledNode`
for both protocols (`rulesNodeHealth.ts`, pure helpers in `nodeHealth.ts`), new `PooledNode` fields (reported position
class, override, advert-had-position, local), an always-mV `batteryMv` series (MeshCore `mc_battery_mv` and
`mc_status_battery_volts` x1000), four threshold settings, `tierASkips` (silent-source A6 and no-battery A8) and one
`buildTierAContext` for both run paths. Deviations: A6 `aliveSources` joins the route's source-id redaction (it would
have leaked hidden ids); the Meshtastic telemetry query keeps its four DB types. Verified: a Repeater-source's local
battery rows are filed under the real public key, but that source has no own node row, so they only count when an advert
creates one.
