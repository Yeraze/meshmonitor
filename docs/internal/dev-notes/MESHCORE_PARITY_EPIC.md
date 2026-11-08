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
- [ ] **P2 #6261 Messaging:** Room unread, DM/Room mute, mark-all-read,
  translation, composer emoji picker.
- [ ] **P3 #6259 Nodes and DM lists:** sort, columns, filters, group by role,
  export, DM list filters and richer rows.
- [ ] **P4 #6262 Packet Monitor + contact graphs:** paging, search and filters,
  distribution charts, Unified filters, Smart Hops / Link Quality / Signal Trend.
- [ ] **P5 #6260 Map parity:** shared MeshCoreMap layers, trace on map, Map
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
