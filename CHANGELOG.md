# Changelog

All notable changes to MeshMonitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **MeshCore: `{ROUTE_NAMES}` and `{HASH_SIZE}` automation reply tokens** — `{ROUTE_NAMES}` expands the relay-hash chain like `{ROUTE}` but resolves each hop to the matching repeater/room-server name from the contact list (unknown hashes stay raw hex; when several repeaters share a hash prefix, the one closest to the neighbouring hops' positions is picked as a best guess). `{HASH_SIZE}` reports the per-hop path-hash width in bytes (1–3) that the original sender stamped into the packet. Available in Auto-Acknowledge and Auto-Responder templates.
- **MeshCore: clickable message route with repeater names** — the relay-hash chain on a received channel/DM message is now clickable and opens a route-detail popup showing the message's reception details and the route expanded per hop into repeater/room-server names, using the same resolution (and collision best-guess) as the `{ROUTE_NAMES}` token.
- **MeshCore: packet-flow mini map in the route popup** — when every relay hop resolves to a positioned contact, the route-detail popup adds a small map tracing the packet's geospatial flow across the relays with numbered, labeled hop markers; the sender and local node are included as endpoints when their positions are known. (#4276 follow-up)
- **Map Analysis: Terrain Link Profile tool** — pick two points (nodes or arbitrary map locations) to get a terrain elevation profile, line-of-sight, and Fresnel-zone chart, plus a full RF link budget (FSPL, antenna gains/heights, cable loss, RX sensitivity) with a clear/marginal/obstructed verdict, comparable to site.meshtastic.org's link-planning view. Frequency and RX sensitivity auto-fill per source (Meshtastic region/modem-preset, MeshCore radio config) with a "from &lt;source&gt;" provenance hint, always overridable by hand; the picked link on the map recolors to match the verdict once computed. (#4111, #4143, #4147)
- **Elevation source settings** — a new admin-only **Elevation / Terrain** settings section enables/disables the Link Profile tool's terrain data and lets you point it at a custom DEM source (tile-template or Open-Topo-Data-compatible JSON API), with a Test button reporting the detected source type, sample elevation, and latency. Defaults to the public AWS Terrarium (SRTM-derived) tile set; all fetches happen server-side through the existing SSRF-guarded outbound path. (#4111)

### Changed
- **Packet/route detail modals are now accessible dialogs** — the MeshCore packet-decode, MQTT packet-detail, and MeshCore route-detail modals gained `role="dialog"`/`aria-modal` semantics, Escape-to-close, a Tab focus trap, and focus restore to the triggering element (shared `useDialogA11y` hook, mirroring `common/Modal`). (#4276 follow-up)
- **Protobufs: submodule pinned to a 2.8-preview commit (develop@ba16bfc)** — unlocks implementing Meshtastic 2.8 features (MeshBeacon, XEdDSA signing display, warm-tier NodeDB) ahead of the stable protobufs tag. Fully backward compatible for 2.7 users: the one breaking upstream change in the range (removal of the v2.7.x `TrafficManagementConfig` bool-toggle fields) is neutralized by a load-time schema patch that restores those fields, keeping Traffic Management encode/decode byte-for-byte identical to v2.7.26 against shipping 2.7-alpha firmware (regression-tested at the wire level). The pin will be retargeted to the official 2.8 tag when it lands. (#3548, #3854, #3923)
- **Maps: obscured-GPS marker offset now scales with cell crowding and is distance-capped** — refines the within-cell declutter offset for low-precision (`precision_bits`) markers. The jitter magnitude now grows *logarithmically* with how many nodes share a precision cell (a busier cell spreads wider; a barely-shared one nudges only slightly), and is capped at the size of a 15-bit cell (~1,456 m). Previously the offset scaled to the node's own cell, so a very coarse-precision node (bits 1–14) could be flung kilometers — or, at the extreme, continent-scale — from the point it reported. Markers at 15+ bits are unchanged, and the drawn accuracy rectangle stays honest (only the marker offset is bounded, so it still lands inside the square). Because a node is only offset when it shares a cell with others of the *same* precision, two overlapping but differently-sized accuracy regions are never pushed closer together than their true centers. (#4155)

### Added
- **Packet Monitor: XEdDSA signature shield (firmware 2.8)** — packets whose XEdDSA signature the device verified (`MeshPacket.xeddsa_signed`, firmware 2.8+) now show a 🛡️ shield in the packet list and a `xeddsa_signed` field in the packet detail view, mirroring the official mobile apps' signed-broadcast indicator. Persisted per packet (migration 125); packets from pre-2.8 firmware carry no flag and show no indicator. (#3923)
- **MeshBeacon packets (firmware 2.8) decode in the Packet Monitor** — MESH_BEACON_APP payloads now decode into the beacon text and any channel/preset "offer", shown in the packet list preview with the full decoded payload in the packet detail view. Beacons are not yet stored as messages or given a dedicated view — that design question stays open on #3854 until real-world 2.8 beacon traffic exists. (#3854)

### Fixed
- **Dashboard: MeshCore ghost markers no longer appear on every source's map** — every MeshCore node reaches the dashboard map with `nodeNum` 0, so the marker-key scheme (`sourceId:nodeNum`) collapsed all of a source's MeshCore nodes onto a single React key; React's duplicate-key reconciliation then duplicated markers and failed to unmount them when the selected source changed, leaving stale MeshCore markers on the Unified map and every other source's map. MeshCore markers are now keyed by their public-key identity (matching the Map Analysis marker layer), so each source's map shows exactly its own nodes. (#4234)
- **LONG_MODERATE default-channel name corrected to firmware's "LongMod"** — MeshMonitor's preset→channel-name tables carried "LongModerate", but the firmware (`DisplayFormatters.cpp`) derives "LongMod" for unnamed channels on that preset. Since this string feeds the DJB2 frequency-slot hash and MQTT channelId derivation, LONG_MODERATE nodes previously showed a wrong computed frequency slot. The three drifting copies of this table are now consolidated into one firmware-verified canonical map (also extending it through LongTurbo/LiteFast/LiteSlow/NarrowFast/NarrowSlow/TinyFast/TinySlow/MediumTurbo). (#3854 follow-up)
- **Map Analysis: heatmap/coverage overlay no longer shows density for deleted nodes** — position telemetry is not cascade-deleted when a node is removed, so bulk deletes that skip telemetry ("Clean up inactive nodes", "Prune Outside ROI") left orphaned lat/lon rows behind. The #4163 fix gated hidden-but-live nodes; it could not gate *deleted* nodes because their node record is gone. The heatmap and position-trail queries now drop any position whose owning node no longer exists (for every user, admins included) — a markerless position contributes no density — covering both existing orphaned rows and any future ones. (#4163)
- **Map Analysis: implausible DEM elevation values no longer distort the Link Profile chart** — open-water/void artifacts in some elevation tile sources (observed as extreme negative spikes, e.g. −12000 m over Lake Pontchartrain) are now discarded server-side instead of blowing out the chart's vertical scale. (#4111)

## [4.13.0] - 2026-07-15

### Added
- **Map Analysis: node selection, emphasis, and Follow mode** — Clicking a node on Map Analysis now selects and emphasizes it (its links highlighted, unrelated clutter de-emphasized), and a new **Follow** control keeps a chosen node in view as new positions arrive, with optional auto-zoom. (#3788, #4010, #4012)
- **Map: node-to-node distance measurement tool** — All maps gain a measure tool that reports the line-of-sight distance between any two nodes. (#3636, #4013)
- **Map: polar grid overlay** — Map Analysis and the Unified map (and, post-consolidation, the MeshCore map) gain an optional polar range-ring/bearing grid overlay. (#3971, #3983, #4071)
- **MeshCore: delete and purge messages** — Messages can now be deleted individually, per conversation, or purged entirely. (#3981, #3984)
- **MeshCore: automatic send retries** — Direct messages that miss their ack are automatically retried, first on the same path and then via flood (#3980); automated channel sends (Auto-Responder, automations, Timed Events) gain an opt-in auto-retry with an exact decrypt-and-match echo check so 'repeaters relayed' echoes are never misread as delivery (#3979, #3987, #3988).
- **MeshCore Virtual Node: status requests and neighbour queries** — Extends the app-facing command surface from 4.12.5: `SendStatusReq` status requests and binary `GetNeighbours` queries from a companion app are now relayed to the physical node instead of being rejected. (#3904, #3991, #3993)
- **MeshCore: configurable CLI reply timeout** — How long MeshMonitor waits for a repeater CLI reply is now a per-source setting instead of a fixed 15 seconds, honored by both the remote-admin console and the Virtual Node CLI relay. (#4027, #4033, #4107)
- **MeshCore: collapsible node list** — The Node Details contact list can be collapsed, so the map is reachable on mobile without first selecting a node. (#4079)
- **Automation: multi-channel message triggers** — A message trigger can now match an OR-list of channels instead of exactly one. (#3974, #3982)
- **Automation: scheduled device-reboot action** — Automations can schedule a device reboot (e.g. a nightly cron-driven reboot of a flaky node). (#3995, #4002)
- **Automation: "Send via sources" selector on the tapback action** — Tapback reactions can be routed through an explicit set of sources, matching the send-message action. (#3997)
- **Config: UDP broadcast network setting exposed** — The device's UDP-over-LAN mesh option (`enabled_protocols`) can now be toggled from the Network configuration page. (#4113)
- **MeshCore Auto-Pathfinding: restrict path discovery / neighbor queries to a subset of contacts** — Auto-Pathfinding previously ran `discover_path`/`get_neighbours` against *every* Companion and Repeater contact each cycle, spending mesh airtime and cycle time on nodes the operator has no interest in. A new opt-in **Filter target contacts** control (modeled on Meshtastic's Auto-Traceroute filter) narrows the targets by any combination of: a searchable specific-contact allowlist, a name regex, a last-heard window, a cached-route hop range (contacts with an unknown/flood route are excluded), and a minimum RSSI/SNR signal threshold. Last-heard/hop/signal narrow the pool, then the allowlist and name-regex include contacts matching either; a live preview shows the resulting target count. Fully backward compatible — with the filter off, all contacts are targeted as before. Settings are per-source (allowlist in a dedicated table, the rest as per-source settings). (#4024)

### Fixed
- **Low-battery and inactive-node alerts no longer silently vanish when notification preferences are split across sources** — Notification preferences are stored per (user, source), and the low-battery pipeline's three stages (eligibility, node matching, delivery) each read a *different* row: a user whose "Notify on Low Battery" flag, monitored-node list, and Apprise configuration were saved from different source pages passed every check in the UI yet never received an alert — with no log output (reported five times: #3417, #3462, #3671, #3884, #4020). Eligibility now triggers when *any* of the user's rows has the flag, monitored nodes are the union across all rows, thresholds resolve exact-source → default → first row, and delivery no longer re-checks the flag against a single row — the check and delivery stages can no longer disagree. Source-scoped broadcasts (new node, traceroute, server events) additionally fall back to the default-source preferences row when a source has no row of its own, and diagnostics now log a per-user preferences-row summary (hourly, counts only) whenever a check cycle skips someone, so a single log excerpt shows exactly why. (#4020)
- **Notification preferences: leftover one-row-per-user constraint from old databases** — SQLite databases created before per-source preferences kept an inline `UNIQUE(user_id)` autoindex that migration 079 missed, so saving preferences for a second source could fail; the constraint is now removed. (#4045)
- **Map: popups no longer collapse spiderfied clusters, and fully-obscured markers are reachable** — Opening a node popup no longer auto-collapses a spiderfied marker cluster, and a marker hidden exactly beneath another is offset so it can be clicked — applied across all maps. (#4015, #4016, #4022, #4028)
- **Map: clicking a node no longer snaps the view back or freezes interaction** — A user gesture (pan/zoom) during the fly-to-node animation now cancels the centering instead of being overridden moments later, the pan targets the actual (possibly offset) marker, and post-consolidation regressions in wheel zoom, zoom-to-node, and stale-chunk reload self-healing were fixed. (#4071, #4080, #4082, #4098)
- **Map: invalid node positions are filtered out** — Nodes at Null Island (0,0) or with out-of-range coordinates are excluded from markers *and* from route/neighbor line endpoints (lines no longer run off to 0,0), guarded at both repository write and read, including the MeshCore live-contact overlay. (#4077, #4078, #4099, #4101, #4103)
- **Map: `ROUTER_LATE` nodes render with the repeater tower icon** on the Nodes tab and Dashboard maps. (#4075, #4076)
- **Map: switching tilesets no longer remounts the raster tile layer**, which aborted in-flight tiles and flickered the whole map. (#4097)
- **Dashboard map: neighbor lines honor the configured map endpoint** instead of a hardcoded one — thanks @temalo. (#4055)
- **MeshCore: automation DM triggers now populate `fromName`**, so name-based conditions and `{NAME}`-style tokens work for direct messages. (#3978)
- **MeshCore: replies to unnameable trigger scopes are sent unscoped** — Match-scope replies no longer fail when the triggering scope has no representable name. (#3998, #4003)
- **MeshCore: danger-command guard no longer fires on dotted config-path arguments** (e.g. `set lora.freq …`), and the non-functional Stats quick-action was removed from the remote console. (#4029, #4031)
- **MeshCore: automation DM destinations resolve as public-key strings** — Destinations were being coerced through `Number()`, corrupting pubkey-addressed sends. (#4019)
- **MeshCore Virtual Node: boot race and listen-error zombie state** — The VN server could come up half-initialized or, after a failed listen, stay registered but dead; both paths are fixed. (#4001)
- **MeshCore Virtual Node: login relays the admin flag and firmware version level** — Companion apps now receive the full 14-byte `LoginSuccess` (admin bit + firmware level), so remote-admin UI unlocks correctly through the VN. (#4094, #4095)
- **MeshCore Virtual Node: CLI-type text messages relay via the CLI path** — `SendTxtMsg` frames with `txtType=CliData` were being forwarded as chat DMs; they now go through the CLI relay and honor the configurable CLI timeout. (#4106, #4107)
- **Auth: proxy-auth auto-provisioning failed on long-upgraded SQLite databases** — Installs created before the v3.7 schema baseline still carried a `CHECK (auth_provider IN ('local','oidc'))` constraint on `users`, so `PROXY_AUTH_ENABLED` user auto-provisioning crashed with a CHECK-constraint error. Migration 118 rebuilds the table without the stale constraint. (#4119, #4120)
- **Permissions: virtual-channel read grants honored everywhere** — Channel-database (decoded/virtual) channels use per-entry `canRead` grants, which several read surfaces (including polling) ignored — hiding those channels from non-admin users. All per-source read surfaces now honor them. (#4116)

### Changed
- **Map Consolidation: every map now shares one shell, one layer library, and one popup family** — The app's many map surfaces (Dashboard, Nodes tab, Map Analysis, MeshCore, Unified, embeds, pickers/editors) each hand-rolled their own map container, markers, traceroute drawing, and popups — which is why fixes historically landed on one map and missed the others. They now compose a single `BaseMap` shell, a shared layer library, a unified node-marker factory, and one popup family with per-technology sections. User-visible wins: traceroute rendering is identical on every map (embeds included), popups are consistent, and map fixes now apply everywhere at once. (#4047 epic: #4049, #4051, #4057, #4060, #4064, #4065, #4066, #4067, #4068)
- **Map: pan/zoom/spiderfy interaction polish** — Zoom is clamped to tileset limits, fly animations scale with distance, spiderfy is zoom-gated, and clusters re-spiderfy after a zoom instead of collapsing. (#4046, #4072)
- **BREAKING (HTTP API consumers): source-scoped endpoints now require an explicit `sourceId`** — A hardening pass across the HTTP API made per-source endpoints (telemetry read/delete, position override, neighbor info, security reads/clear, channel export and channel-write routes, packet lookup) require a `sourceId` parameter instead of silently defaulting to one source — several of these previously returned 500s or leaked cross-source data in multi-source deployments. The bundled web UI is fully wired; external scripts calling these endpoints must now pass `sourceId`. (#4053, #4054, #4056, #4058, #4059, #4061, #4062, #4063)
- **Docker tags: pre-releases now publish `:dev`; `:latest` only moves on stable releases** — Users tracking `:latest` no longer receive release candidates; track `:dev` to opt into RCs. Exact version tags (`:4.13.0`, `:4.13.0-rc3`) remain pinnable, and stable releases also move `:4` / `:4.13`. (#4102)
- **Internal: architecture remediation epic** — A large code-health pass with no intended behavior change: MeshCore managers join the one unified source-manager registry; API handlers standardize on a `{ success, error, code }` response envelope; fresh installs bootstrap by replaying the full migration chain (with a CI schema-drift tripwire keeping SQLite/PostgreSQL/MySQL aligned); the legacy synchronous database API and the `misc.ts` grab-bag were deleted; per-source database scoping now fails closed (queries must name a source or explicitly opt into cross-source); shared scheduler classes replace per-manager copies (heartbeat, announce, distance-delete); route tests run against real auth middleware; CI lint is blocking via a count-based ratchet; and the server gains a process-level `unhandledRejection`/`uncaughtException` safety net. (#3962: #3966–#3970, #3972, #3976, #3985, #3986, #3989, #3990, #3992, #4004, #4005, #4009, #4011, #4014, #4017, #4023, #4030, #4032, #4034, #4036, #4040, #4041, #4043, #4048)
- **Documentation refresh for 4.13** — Source-scoped API docs, the release-tracks explainer, the new Updating MeshMonitor guide, and accompanying blog posts. (#4105)
- **Translations updated from Hosted Weblate.** (#4006)
- **Dependencies:** bumped the production-dependencies group (9 updates) plus `helmet`, `protobufjs`, `lucide-react`, `re2`, and the TypeScript/ESLint dev toolchain; the `meshcore.js` fork is now pinned to a commit SHA. (#3969, #4083, #4084, #4085, #4087, #4088, #4089, #4090, #4092)
- **Container logs are far quieter at the default level.** Routine per-packet, per-request, and periodic-scheduler activity — plus the ~60-line environment dump printed on every boot — was logged at `info`, which is the production default, making Docker logs hard to use for support. That activity is now logged at `debug`; `info` is reserved for genuinely important, low-frequency events (startup/shutdown, source connect/disconnect, backups/restores/migrations, and deliberate actions taken), so an idle container is near-silent. A new `trace` level captures the full per-packet firehose. Raise verbosity for troubleshooting with `LOG_LEVEL=debug` (or `trace`) — no `NODE_ENV` change needed. As a side benefit, MeshCore message **bodies** are no longer written to logs (only sender/channel metadata and a length).
- **BREAKING (deployments behind a reverse proxy): `TRUST_PROXY` now defaults to `false`.** Previously, production builds trusted the first proxy hop when `TRUST_PROXY` was unset, which let a direct-connected client spoof `X-Forwarded-For` to bypass the auth brute-force limiter and poison audit attribution. Proxied deployments must now set `TRUST_PROXY` explicitly (`TRUST_PROXY=1` for a single proxy). Direct (non-proxied) deployments need no change.

### Security
- **Client no longer logs CSRF-token material or per-request noise to the browser console** — The API client logged on every mutation, including an 8-character prefix of the CSRF token; all hot-path `console.*` calls were removed and the remaining diagnostics routed through the environment-gated frontend logger with no token content. (#3970)

### Removed
- **BREAKING: In-app Auto-Upgrade has been retired.** The watchdog-sidecar upgrade system (`docker-compose.upgrade.yml`, the upgrader container, the unattended "upgrade immediately" setting, and the Settings → Auto Upgrade test panel) has been removed. It only ever supported one deployment shape, required root-equivalent Docker-socket access, and was structurally unreliable across real-world Docker environments — over half of its commit history was bug fixes. MeshMonitor still **checks** for updates server-side: an "Update available" banner now shows copy-pasteable instructions for your detected deployment (Docker / LXC / Kubernetes / bare metal), and the `upgrade-available` automation system event now fires even with no browser open, so you can wire webhook/ntfy/Apprise notifications. For unattended Docker updates, use Watchtower (see the new [Updating MeshMonitor](https://yeraze.github.io/meshmonitor/configuration/updating) guide, which includes a migration checklist for existing sidecar users — in short: drop the overlay from your compose command, `docker rm -f meshmonitor-upgrader`, and remove `AUTO_UPGRADE_ENABLED`). The old `/api/upgrade/*` endpoints return `410 FEATURE_RETIRED`; migration 117 drops the `upgrade_history` table; stale watchdog files under `/data` are cleaned automatically on first boot.

## [4.12.5] - 2026-07-06

### Added
- **MeshCore Virtual Node: send adverts, log in, trace paths, and request telemetry from a companion app** — Completes the app-facing command surface reported in #3904. A companion app connected to a MeshCore Virtual Node can now: broadcast a self-advert (`SendSelfAdvert`), log in to a remote node (`SendLogin` → `LoginSuccess`), trace a path (`SendTracePath` → `TraceData`), and request LPP telemetry (`SendTelemetryReq` → `TelemetryResponse`). These are relayed to the real node with the correct `Sent`→async-push handshake the app expects (correlated by the remote's public-key prefix, or by the app's own trace tag), instead of being rejected with `Err(UnsupportedCmd)`. Login/trace/telemetry/advert are not gated on **Allow admin commands** — a real node accepts them unconditionally. (#3904, #3959, #3961)
- **MeshCore Virtual Node: bridge the raw RX feed to companion apps** — The node's raw received-packet feed is now forwarded to connected apps as a `LogRxData`(0x88) push, so channel-finder / packet-inspection tools in the app work through the Virtual Node. (#3963, #3964)
- **LoRa: region-legality awareness for modem presets and amateur-radio regions** — The modem-preset picker now filters out presets that would be illegal for the selected region, and selecting a licensed amateur-radio region surfaces a warning. Adds `RegionCode` values 33–37 and corrects the `ITU2_2M` label. (#3924, #3927, #3928, #3930, #3936)
- **Nodes: per-node free-text notes** — Each node gains an editable free-text notes field. (#3921, #3932)
- **Messages: search conversations by content** — Conversations can be searched by message text; the in-tab content filter now also covers MeshCore direct messages. (#3922, #3931, #3935)
- **MeshCore packet-log export: decode unencrypted packet data** — Packet-log exports now decode the data of unencrypted packets instead of leaving them opaque. (#3937, #3939)
- **Automation: MeshCore scope condition + source resolution** — Automations gain a MeshCore scope condition (with a self-origin guard so a rule can't act on the node's own emitted events), and correctly resolve MeshCore sources from the manager registry. (#3914, #3915, #3917, #3920)

### Fixed
- **MeshCore: `clock sync` now sets the repeater to the real current time** — The `clock sync` CLI/quick-action set the repeater's RTC from the incoming command frame's timestamp, which is `0` over a direct serial link (always rejected) and the sending node's own drifted clock over remote admin — so the repeater ended up minutes behind or unchanged. MeshMonitor now issues the firmware's absolute `time <epoch>` command with the server's authoritative clock, and keeps the local Companion node's own RTC synced on connect and periodically. (#3954, #3957)
- **MeshCore: repeater SNR was reported 4× too high** — Repeater `last_snr` values are raw quarter-dB and are now divided by 4 before display, matching the units used everywhere else. (#3955, #3956)
- **MeshCore: static contact position no longer clobbers live GNSS telemetry fixes** — A saved static position for a contact could overwrite a fresher GPS fix from telemetry; live GNSS fixes now win. (#3909)
- **MeshCore: initial auto-connect now retries with backoff** — A missed first connection attempt is retried with backoff instead of leaving the source disconnected. (#3919)
- **Automation: a stored bad `filterNameRegex` can no longer brick automations** — An invalid saved name-filter regex is now handled gracefully instead of throwing and taking the automation engine down with it. (#3934, #3938)
- **Map: direct-heard SNR shown in the node hover tooltip** — The tooltip now surfaces the direct-heard SNR. (#3925, #3929)
- **Dashboard map: collapse toggle for the Features panel** — The map Features panel can now be collapsed. (#3912, #3913)
- **Hardware: rename hwModel 128 to `MESH_TRACKER_X1`** — Corrects the model name for hwModel 128. (#3952, #3958)
- **PirateWeatherADV example script: "read operation timed out" under Timed Events** — The bundled community script's per-request Nominatim/Pirate Weather `urlopen` timeouts (3s/4s/3s) were based on a stale "10-second script timeout" assumption; the actual Auto-Responder/Timed Event script kill timeout is 30 seconds. A slow upstream response could exceed the old socket timeouts long before the real kill signal, surfacing as `The read operation timed out`. Timeouts are bumped to 5s/8s/5s (named constants) and the misleading "10-second" comment/docs are corrected to 30 seconds throughout. (#3941, #3942)

### Changed
- **Translations updated from Hosted Weblate.** (#3601)
- **Dependencies:** bumped the production-dependencies group (8 updates) plus `@types/node`, `globals`, `@typescript-eslint/parser`, `puppeteer`, and `tsx`. (#3945, #3946, #3948, #3949, #3950, #3951)

## [4.12.4] - 2026-07-03

### Added
- **MeshCore Virtual Node: configure the physical node from a companion app** — Config/admin commands sent from a companion app connected to a MeshCore Virtual Node are now forwarded to the real node (gated on the source's **Allow admin commands** setting), instead of being silently dropped with an `unhandled frame: code=142`. Covers node rename, radio params, TX power, advertised position, channel setup, and the "other params" bundle (telemetry-visibility modes, advert location policy, manual-add-contacts). When the flag is off, the app now receives an explicit rejection rather than a hang. Also adds the previously-missing **Allow admin commands** checkbox to the MeshCore Edit Source dialog (it was absent and hardcoded off, so the setting could never be enabled from the web UI). (#3904, #3905, #3906, #3907, #3910)
- **Map: fade node markers by age instead of a hard cutoff** — On both the Dashboard map and Map Analysis, node markers now fade smoothly toward transparent as they age instead of popping in/out at the max-age threshold (Dashboard) or ignoring the time slider entirely (Map Analysis). Favorites stay fully opaque. (#3886, #3903)
- **MeshCore: node-type filter on the Node Details contact list** — A compact "Filter by node type" dropdown next to the search/sort controls lets users with many repeaters/sensors narrow the list to just their companions (or any node type). (#3890, #3897)
- **MeshCore: explicit "Unscoped" button when composing a channel message** — The channel "Send scope" control gains a discoverable one-click **Unscoped** option to send a channel message with no region scope. (#3888, #3898)
- **MeshCore: unread red-dot indicators on Channels + Node Details** — The MeshCore sub-toolbar now shows the unread red-dot on its Channels and Node Details icons (matching Meshtastic), and gains unread tracking for direct messages, which it previously lacked entirely. (#3891, #3895)
- **Automation: consolidated token reference block + MeshCore Auto-Responder token parity** — Each source's expansion tokens are consolidated into a single grouped reference block near the top of the Automation page (instead of drifting per-field legends), and MeshCore Auto-Responder can now expand reply-context tokens like `{HOPS}`/`{ROUTE}` that it previously couldn't. (#3892, #3894)

### Fixed
- **MeshCore: local companion node showed blank battery** — `getAllNodes()` pushed the live in-memory `get_self_info` node (which has no battery field) over the DB-persisted row instead of merging onto it, so the Node Info panel and dashboard saw the companion's own `batteryMv`/`uptimeSecs` as blank even though the telemetry poller was persisting them. The persisted row is now merged as a base, and the poller stamps `isLocalNode: true` so the flag reflects reality. Adds low-battery diagnostics. (#3884, #3896)
- **MeshCore: "Notify on Low Battery" never fired for Apprise-only / companion setups** — Closes two concrete gaps found by tracing the low-battery scan-and-deliver pipeline end-to-end, including making companion battery persistence observable and covering the Apprise-only delivery path. (#3884, #3899)
- **Auto-delete-by-distance was not truly per-source** — Only meshtastic_tcp sources ran a per-source scheduler; mqtt_broker, mqtt_bridge, and meshcore fell through to a global singleton that scanned nodes across all sources with the global threshold/home coordinate. Auto-delete-by-distance is now genuinely per-source for every source type. (#3901, #3902)
- **MeshCore Auto-Acknowledge: unresolvable trigger scope replied with the channel default instead of unscoped** — When a triggering message's scope couldn't be recovered at all (raw OTA bytes not correlated), "trigger" Reply Scope mode fell back to the channel default, so a genuinely-unscoped message from a peer repeater got a scoped reply back that the peer wouldn't forward. An unresolvable scope is now treated the same as a confirmed-unscoped trigger (reply unscoped); the same fix is mirrored in the Automation Engine's "match the triggering message's scope" mode. (#3887, #3889)

## [4.12.3] - 2026-07-01

### Added
- **Automation Engine "Pause" action + configurable Auto-Ack pre-send delay** — A new bounded (≤300s) in-process `action.delay` block lets any automation rule/branch pause between sequential actions (e.g. `message trigger → Pause → Send message`), composing with the existing multi-action-per-branch executor. The built-in Auto-Acknowledge (Meshtastic **and** MeshCore) also gains a dedicated configurable pre-send delay (default 0/immediate, capped at 120s) for the common "let the repeater settle before replying" case. (#3876)
- **MeshCore node position-history movement trails on the map** — MeshCore nodes now get the same per-node movement trail (polyline) the Meshtastic map has: a "Show Position History" toggle, a 1h–7d history-length slider, and a configurable retention window (default 7 days). Fed entirely by existing MeshCore GPS adverts and telemetry polls — no firmware changes required. (#3852)
- **MeshCore auto-acknowledge `{SCOPE}` token** — Auto-acknowledge message templates can now include `{SCOPE}` to surface the region/scope the triggering message arrived on (e.g. `EU`, `Berlin`). Resolves to `(unscoped)` for explicitly unscoped messages and `—` when no scope information is available. (#3865)

### Fixed
- **MeshCore: deleted contact resurrected on the next sync** — A removed contact that still lingered on the companion's saved-contact list (e.g. a room server that's gone from the network) was re-added on the very next `refreshContacts` sync/advert, so "Remove" appeared to do nothing. Deletion is now honestly reported (rows-affected, not unconditional success) and a removed key is tombstoned for 1h so re-syncs can't resurrect it — a genuine live advert from that key still clears the tombstone immediately. (#3878)
- **MeshCore: intermittent "Failed to load saved regions" banner** — The saved-regions and default-scope effects in the Channels view depended on the entire (non-memoized) `actions` object from `useMeshCore`, which is a fresh literal on every render — and the MeshCore page re-renders constantly from live mesh traffic. That re-fired the region/scope fetches on nearly every render, so any transient network hiccup on one of the redundant calls left a sticky red error banner. The effects now depend only on the specific stable callback each one calls. (#3881)
- **MeshCore Virtual Node: DM marked Failed despite delivery (no ACK returned)** — A direct message sent through a MeshCore companion connected via the Virtual Node was delivered, but its delivery ACK was never forwarded to the companion, so the companion retransmitted three times and finally marked it **Failed**. The Virtual Node bridge now puts the firmware's real ack CRC in the `Sent` response and forwards the matching `SendConfirmed` push to the originating companion, so the message is correctly marked delivered. (#3869)
- **MeshCore Virtual Node: incoming messages always shown as "direct"** — Received channel and direct messages were forwarded to a Virtual Node companion with a hardcoded "direct" path length, hiding the real hop count. The actual `path_len` is now forwarded so the companion shows the correct number of hops. *(The related "heard by N repeaters" count for **outgoing** channel messages remains MeshMonitor-UI-only — a channel send is an unacked flood and the companion protocol has no frame to carry a post-send relay tally; see #3871.)* (#3871)
- **MeshCore: "Direct Messages" tab/permission understated its scope** — The tab and the `messages` permission also gate the Node Details view, not just DMs, so both are relabeled "Node Details" / "Node Details & DM" to match the existing Meshtastic naming precedent. Display strings only — permission IDs and DB rows are unchanged. (#3867)
- **Duplicate WARN log spam from security/telemetry checks** — Low-entropy/duplicate-key detection logged its own WARN line in addition to each caller's contextual warning (2–3 duplicate lines per event on large meshes), and telemetry timestamp auto-correction logged at WARN for every affected field on every packet from a broken-clock node. The internal duplicate log was removed and the auto-correction log downgraded to DEBUG; behavior is unchanged. (#3864)
- **MeshCore: GPS position from a telemetry poll didn't update Contact Details** — A remote telemetry poll's GNSS fix (Cayenne-LPP type 136) was stored only as telemetry history rows, not to `meshcore_nodes.latitude`/`longitude`, so Contact Details kept showing the position from the last advert regardless of how recent the telemetry-reported fix was. Position is now persisted from the telemetry path too (mirroring the existing `batteryMv` persistence), with the same Null Island (0,0) guard. (#3862)
- **Traceroute "last traced" could show a negative age** — A node with its RTC set ahead of real time reports a future device `rxTime`, which the direct/TCP traceroute path stamped straight into the row's timestamp, producing ages like "-1676m ago". Ingest now clamps device time to server time, migration 109 repairs existing future-dated rows (idempotent, all three backends), and the displayed age is floored at 0. (#2768)
- **Sticky section-nav scrolled behind the fixed header** — `.section-nav` used `position: sticky; top: 0`, anchoring it at the very top of the viewport behind the 60px fixed app header on every configuration page. Now sticks at `top: var(--header-height)`, just below the header. (#3872)

## [4.12.2] - 2026-06-29

### Added
- **Scope/region control for MeshCore automations** — Both the legacy Automations tab and the Automation Engine can now target a specific MeshCore scope/region when sending, or **respond on the trigger message's scope**, so an automated reply stays on the region it arrived on. (#3833, #3834)
- **"Request from a node" Automation Engine action** — A single action can request telemetry, position, traceroute, node info, neighbor info, or an advert from a node, on both Meshtastic and MeshCore sources. (#3835, #3838)
- **Automation Engine live trace** — Each rule now has a live "view logs" trace that streams its evaluation and firing in real time, making it far easier to see why a rule did (or didn't) run. (#3836)
- **MeshCore Reply button on channel messages** — Received channel messages now have a Reply button that prefills the `@[Sender]:` mention and sends the reply on the originating message's scope. (#3851, #3855)
- **MeshCore scope/region shown on sent messages** — Outgoing MeshCore messages now display the scope/region badge they were sent on, matching the existing badge on received messages. (#3814, #3818)
- **Hardware models 132–140** — Bundled Meshtastic protobufs updated to v2.7.26, adding names for hardware models 132–140 so newer devices display correctly. (#3849)

### Fixed
- **MeshCore: re-discovered node showed "Unknown" until reload** — After deleting a contact and running Discover Repeaters, the node reappeared nameless until a manual page refresh (the discovery response carries no name, while the persisted node row still held it). The name is now backfilled from the persisted node row before the live update, the channel view reliably opens at the bottom (newest) on entry, and unscoped messages no longer render an empty scope badge. (#3810, #3817, #3858)
- **MeshCore: discovering an existing repeater wiped its name** — An active discovery re-added contacts already on the device with an empty name, erasing it; existing contacts are now left untouched. (#3858)
- **MeshCore: received-message scope/region (and `{ROUTE}`/`{SNR}`) blank on busy meshes** — The raw OTA bytes that carry a received message's relay path, SNR, and scope are handed from the `LogRxData` push to the message-receive event through an in-memory buffer that was a **single slot**. When two text packets were in flight, the second packet's `LogRxData` clobbered the first's buffer before its receive consumed it, so the first message lost its route/SNR and showed **no scope badge** — even though MeshMonitor had captured the bytes. The buffer is now a small **FIFO** matched to each receive by hop count, so concurrent packets no longer evict each other.
- **MeshCore: discovered repeater names populate without admin login** — Discovered repeaters are named via an ANON_REQ OWNER request, so names appear without logging into the repeater. (#3820, #3825)
- **MeshCore: remote status response cross-talk** — Remote status requests are now serialized, so overlapping requests no longer attach the wrong node's response. (#3815, #3821)
- **MeshCore: virtual-node DeviceInfo handshake** — The virtual node's DeviceInfo is pinned to companion protocol v1, fixing the companion app's "works once after restart" handshake abort. (#3705, #3828)
- **MeshCore: saved regions missing from scope resolution** — The saved-regions catalog is now included when resolving a scope name. (#3829, #3830)
- **Messages: request actions restored for unmessageable nodes** — Traceroute / telemetry / node-info actions stay available for nodes you can't DM. (#3831, #3832)
- **Messages: softened the "not in device DB" warning** when the key is actually known. (#3853, #3856)
- **Remote Node Status: "Errors" relabeled to "Error Events"** for clarity. (#3824)
- **Settings: auto-acknowledge save no longer sticks** when the stored regex is RE2-incompatible. (#3806, #3819)
- **MeshCore: message metadata readability on bright screens** improved. (#3811, #3812)
- **MeshCore: heardBy relay info persists** in the memory pool after a channel echo. (#3813, #3816)

### Dependencies
- Routine dependency updates: recharts 3.9.0, lucide-react 1.22.0, aedes 1.1.0, vite 8.1.0, puppeteer 25.2.1, @types/node 26.0.1, `actions/cache` v6, plus grouped production and development dependency bumps. (#3632, #3839–#3848)

## [4.12.1] - 2026-06-27

### Fixed
- **Startup crash upgrading to 4.12.0 (migration 103)** — On installs with MQTT channel permissions, migration 103 could fail with `UNIQUE constraint failed: channel_database_permissions.user_id, channel_database_permissions.channel_database_id` and crash the app on every start. When consolidating duplicate MQTT channels, the migration now deletes conflicting permission rows before reassigning them to the keeper channel (all three backends; MySQL uses a derived-table subselect). (#3804, #3805)

## [4.12.0] - 2026-06-26

### Added
- **MeshCore source heartbeat / auto-reconnect** — MeshCore sources now expose a user-configurable **Heartbeat** interval (seconds, 0 = off) in the source form, mirroring Meshtastic. When set, the Companion node is probed periodically and the source reconnects automatically with exponential backoff on repeated failure. (#3705)

### Fixed
- **MeshCore: source unusable after a manual disconnect** — Disconnecting a MeshCore source from the UI removed its manager from the registry, so every `/meshcore/*` route returned "No MeshCore manager for source" and the source could not be reconnected without a container restart. Disconnect now keeps the manager registered (tearing down only the device link), so reconnect works cleanly. (#3705)
- **MeshCore: undetected socket drops** — A socket/serial-level link drop left the manager stuck "connected", so the Virtual Node server served a stale identity and real sends silently failed with no recovery. The manager now detects backend disconnects and either auto-reconnects or cleanly marks the source disconnected. (#3705)
- **Position speed inflated ~3.6× (ground_speed unit)** — Meshtastic's `ground_speed` is **km/h** on the wire (the firmware writes it from TinyGPS++ `.kmph()`), not m/s as the protobuf comment claims. MeshMonitor was multiplying it by 3.6 as if m/s, so a node reporting `90` showed as 324 km/h in position-history popups, node popups, and telemetry. Speed is now displayed and stored as km/h. (#3797)
- **Analysis Map dropped cross-source neighbor links** — With multiple sources selected, `NeighborLinksLayer` resolved both endpoints of each edge using only the edge's own `sourceId`, so a link whose neighbor was positioned under a different selected source was silently dropped — showing an intersection instead of the union. Endpoint positions now fall back to the node's position on any selected source. (#3792)

## [4.11.3] - 2026-06-21

### Features

- **Dead Drop / Mailbox auto-responder — async "mesh voicemail" (#3538)**: A new fifth auto-responder `responseType: 'mailbox'` turns the connected radio into an asynchronous message store. A node DMs `msg <name> <text>` to leave a message for another node (by short name, long name, or `!nodeid`); the recipient retrieves it later with `inbox` (count + waiting senders), `inbox play` (release up to 5 oldest), `inbox play <name>`, `inbox delete <id>`, or `inbox clear` — the recipient need not be online when the message is sent. It reuses the existing auto-responder machinery (DM gating, per-source scoping) and is configured entirely through the Auto Responder UI, no scripts required. Messages are per-source, marked played only on delivery-success (so a dropped body DM resurfaces), and expired/played rows are purged by the periodic maintenance sweep (migration 095). See `docs/features/automation.md`.

- **MeshCore node favoriting — pin nodes to the top of the list (#3588)**: Any MeshCore node (Companion, Repeater, Room Server, …) can now be marked a favorite, pinning it to the top of the node list consistent with Meshtastic favorites. Because MeshCore firmware has no native favorite concept, the flag is stored server-side only and never pushed to the device (migration 094). Toggle it from the per-row star in the MeshCore Nodes view.

- **FEM LNA Mode configuration for LoRa (#3599)**: MeshMonitor now surfaces the `Config.LoRaConfig.fem_lna_mode` setting (`FEM_LNA_Mode`: Disabled / Enabled / Not Present, firmware ≥ v2.7.20) for hardware with an external Front-End Module LNA (e.g. certain RAK / amplified boards). The control appears on **both** the Device Configuration LoRa panel and the Remote Admin LoRa panel — each reads, displays, and writes the field. No protobuf bump was needed (already vendored at v2.7.25); proto3 elision is handled so the Disabled (0) default is never inflated.

- **MeshCore CLI bundled in the Docker image (#3587)**: The Docker image now ships the MeshCore CLI Python application (`meshcore-cli` / `meshcli`) alongside the existing Meshtastic Python CLI, so operators managing both Meshtastic and MeshCore devices have a complete toolkit in-container without separate installs.

### Bug Fixes

- **MeshCore neighbor query crashed on PostgreSQL/MySQL (int32 timestamp overflow) (#3602)**: `meshcore_neighbor_info.timestamp` / `.createdAt` were declared as 32-bit `INTEGER`/`INT`, but store millisecond-epoch values (`Date.now()`, e.g. `1781969045993`) that overflow the signed 32-bit max — so `getNeighbors` threw `value … is out of range for type integer (22003)` and the MeshCore neighbors API returned 500. Both columns are promoted to `BIGINT` on PostgreSQL and MySQL (SQLite's INTEGER is already 64-bit), matching the convention used by sibling meshcore tables (migration 096). A schema audit confirmed this was the lone offender.

- **`downlinkEnabled: false` (and `uplinkEnabled: false`) reverted to true after a container restart (#3594)**: proto3 elides boolean `false` on the wire, so on device reconnect `processChannelProtobuf()` decoded a user-disabled channel flag as `undefined`, and a `?? true` fallback inflated it back to `true` — silently overwriting the saved setting on restart. Both flags now default to `false` to match proto3 semantics (the user-save and UPDATE-preserve paths were already correct).

- **Position history dropped SNR for directly-heard (0-hop) nodes (#3590)**: A node heard directly showed its position fix with no SNR even though the packet carried it. The read path wasn't forwarding the per-fix `rxSnr`/hops columns, and the write path used a truthiness guard that discarded a legitimate **0 dB** SNR. SNR is now captured and shown in the position-history tooltip for direct hears, and the same 0 dB drop was fixed on the central `snr_local` telemetry path so any directly-heard packet updates the node's last-known SNR.

- **MeshCore auto-ack `{SNR}` / `{ROUTE}` tokens intermittently blank (#3589)**: The SNR and relay-path data for a MeshCore message arrives on a separate `LogRxData` push correlated to the text-message receive via a single-slot buffer. A room-post path leaked that buffer forward and a stale/mismatched buffer could attach the wrong packet's data, so the tokens rendered empty (or wrong) with no pattern. Buffer consumption is now guarded by freshness + `pathLen` correlation and consumed exactly once, so the tokens populate reliably when the data is present and degrade cleanly when it isn't.

- **macOS x64 (Intel) desktop app crashed on launch — `re2.node` bundled as arm64 (#3603)**: `re2` fetches prebuilt binaries via `install-artifact-from-github`, which reads `process.arch` (always `arm64` on the `macos-14` CI runner) and ignored the `npm_config_arch=x64` vars that steer the other native deps — so the x64 DMG shipped an arm64 `re2.node` and failed with `ERR_DLOPEN_FAILED` on Intel Macs. The desktop build now deletes the wrong binary and rebuilds `re2` from source with `clang -arch x86_64`, producing a genuine x86_64 Mach-O (verified in CI), and backfills the missing arch flags into the CI workflow.

- **Mesh request endpoints return 503 (not a generic 500) when the node is disconnected (#3596)**: `/api/traceroute`, `/api/position/request`, `/api/nodeinfo/request`, `/api/neighborinfo/request`, and `/api/telemetry/request` previously re-emitted a `"Not connected to Meshtastic node"` failure as an opaque `500 { error: 'Failed to send …' }`, so the UI couldn't tell the user what was wrong. They now return **503** with the v1-API error shape (`{ success: false, error: 'Service Unavailable', message: 'Not connected to Meshtastic node' }`), and the `api.ts` callers surface the specific `message`.

## [4.11.2] - 2026-06-20

### Bug Fixes

- **Startup crash loop after upgrading to 4.11.1 with an existing Auto-Acknowledge config (PostgreSQL/MySQL)**: Migration 093 (the Auto-Acknowledge 2×2 matrix backfill, new in 4.11.1) inserted `settings` rows without the table's NOT NULL `createdAt`/`updatedAt` columns. On PostgreSQL/MySQL this aborted the migration with a `null value in column "createdAt" … violates not-null constraint` error, failing database initialization on boot — a restart loop. On SQLite the `INSERT OR IGNORE` silently swallowed the violation, so the matrix settings were never actually written. The migration now supplies both timestamps (and a regression test runs it against a real settings table). Affected instances recover automatically on upgrade: the migration had not been marked complete, so it re-runs and succeeds, correctly migrating the auto-ack settings.

## [4.11.1] - 2026-06-20

### Features

- **Device notifications surfaced as toasts + firmware 2.8 favorite/ignore cap handling (#3548)**: MeshMonitor now shows `ClientNotification` messages the connected node emits about its own operation — duplicate-key security warnings, invalid-config errors, duty-cycle limits, and more — as top-right toasts. These were always sent by the node but previously decoded and dropped. A server-side policy (`clientNotificationPolicy.ts`) suppresses the routine recurring ones (e.g. the power-saving "sleeping for N interval" message) and dedupes identical messages to at most once per minute per source, so the feed stays useful rather than noisy. On firmware **2.8**, when a Set Favorite / Ignore is refused because the device's protected-node list is full, MeshMonitor reverts its optimistic star/ignore toggle to match the device and surfaces the refusal (this warning is only emitted for the locally-connected node, not remote-admin targets). No protobuf changes were needed — the 2.8 NodeDB warm-tier restructure and the `snr_q4` on-disk field do not affect the over-the-air wire MeshMonitor reads (SNR stays a `float` in dB; a regression test guards this). See `docs/internal/dev-notes/MT28_NODEDB_SUPPORT_PLAN.md`.

- **Auto-Acknowledge 2×2 matrix — message type × hop distance (discussion #3564)**: Auto-Acknowledge previously tangled two concepts — its "Direct" toggles actually meant *0 hops* (not direct messages), tapback/reply were keyed only on hop distance (shared across channel & DM), and a single global "Respond via DM" applied everywhere. It's now a clean **{Channel, Direct} × {0-hop, Multi-hop}** matrix: each of the four cells independently configures **Message** (reply), **Tapback** (emoji reaction), and **Respond via DM**. "Respond via DM" applies to the reply only (tapback-via-DM is unreliable) and is disabled until Message is enabled; for Direct cells, replies are inherently DMs. Existing configurations are migrated automatically (migration 093) so behavior is preserved on upgrade. MeshCore auto-ack is unchanged.

- **MeshCore node-type icons & filter on the source map (#3546, #3576)**: The per-source MeshCore map now renders role-based marker glyphs by advert type — Repeater (tower), Room Server (server rack), Sensor (broadcast), Companion (person) — instead of the generic "MC" badge (kept as the fallback for standard/unknown nodes). The Map Features panel gains a **Node Types** filter (per-category checkboxes, persisted) to show/hide markers by role, and the legend gains a matching **Node Types** section when shown. This brings the MeshCore source map to parity with the Map Analysis workspace. The shared map legend opts into the new section via a `showNodeTypes` prop, so the Meshtastic maps are unchanged.

## [4.11.0] - 2026-06-19

### Features

- **MeshCore virtual node — connect the MeshCore app over WiFi (#3535, #3540)**: A MeshCore device that MeshMonitor already manages can now be exposed as a **virtual node** that the MeshCore mobile app connects to over local WiFi/TCP, without a direct BLE or serial pairing. MeshMonitor holds the single physical connection and synthesizes the companion wire protocol for each app client — reads (contacts, channels, battery, incoming messages) are served from MeshMonitor's mirrored state and sends (`SendTxtMsg` / `SendChannelTxtMsg`) are forwarded to the real node. This is the MeshCore counterpart to the existing Meshtastic Virtual Node Server and is configured the same way: per source in the Dashboard (**Edit Source → Virtual Node → Enable**, default TCP port **5000**, must be unique per source). Config-mutating admin commands are blocked by default (opt in via **Allow admin commands**); private-key export is always blocked. Disabled by default. See [Virtual Node Server → MeshCore Virtual Node](configuration/virtual-node.md). Design notes: `docs/internal/dev-notes/MESHCORE_VIRTUAL_NODE_DESIGN.md`.

- **MeshCore: define a contact's forwarding path by repeater name (#3550)**: Manually defining a MeshCore contact's forwarding path is now a first-class, on-by-default feature with a name-aware editor. The **Define Path…** modal on a contact builds the route by picking repeaters / room servers **by name** (an ordered list with ↑/↓/✕), pre-fills from the existing path resolving each hop back to a name, and keeps a raw-hex byte fallback for repeaters not yet known. This replaces the old raw comma-separated-hex editor that was hidden behind the off-by-default `meshcoreAdvancedPathEdit` toggle (the toggle and its setting key are removed); path editing is now gated only by `nodes:write` on a Companion device.

- **MeshCore node-type icons + map filtering (#3546, #3563)**: Map markers now carry role-based glyphs so operators can tell infrastructure from end-user nodes at a glance — repeater (tower), room server (server-rack), sensor (broadcast), and companion/standard (person). MeshCore nodes are classified by advert type; Meshtastic `ROUTER` folds into repeater. A new **Node Types** filter (toolbar popover of per-type checkboxes, persisted) hides toggled-off categories, and the map legend gains a Node Types section. The MeshCore `advType` is now exposed on `/api/sources/:id/nodes` so it flows through the unified-node merge.

- **Per-node "Hide from Map" toggle (#3549, #3565)**: A new per-node `hideFromMap` flag suppresses a node's marker on every map surface (source map, dashboard map, Map Analysis, and embed maps) while leaving the node fully visible in node lists, the packet monitor, DMs, and everywhere else. Distinct from the ignore flag (hides nearly everywhere) and the position override (relocates the marker) — intended for nodes with spoofed or unreliable GPS heard RF-only from a distant mesh. Toggle it from the node actions menu (**Hide from Map** / **Show on Map**); it's a display-only flag (no device sync) and survives incoming packets (migration 092).

- **Telemetry time-range selector in Node Details (#3530)**: The Node Details telemetry graphs were locked to the global `telemetryVisualizationHours` window (24h by default), so older history couldn't be viewed there. They now expose the same 15m–7d range buttons as the Device Info page, seeded from the global default and persisted (shared with Device Info), so you can widen to 7d to see longer history on any selected node.

- **Node list export — CSV / HTML (#3499)**: The Nodes tab sidebar gains a compact **⬇ export** button (in the filter/sort row) with a **CSV** / **HTML** dropdown. Export respects the current view — the same filters (search, security, channel, incomplete, remote-admin) and favorites-first sort order shown in the list — and runs entirely client-side. Columns: Long Name, Short Name, Node ID, Hardware, Role, Firmware, Hops Away, SNR (dB), RSSI (dBm), Battery (%), Voltage (V), Channel, Latitude, Longitude, Last Heard. Values are the node's current state (not historical averages), so the columns are labelled accordingly. CSV is RFC 4180 with a UTF-8 BOM for Excel; HTML is a standalone, printable table. Useful for mesh upgrade planning.

- **Position history: a marker at every fix, points-only mode, and a hover tooltip (#3492, #3494)**: The position-history map layer now renders a circle at **every** heard position — previously a fix only showed a marker when its packet carried heading data (otherwise the line connected invisible vertices). The heading triangle is still drawn on top when heading is present. A new **Points only (no line)** toggle in Map Features hides the connecting line (persisted per user). Each fix now has a **hover tooltip** showing the timestamp, hop count, and — only when the fix was heard directly (0 hops) — the SNR. SNR and hop metadata are captured per position fix going forward (telemetry migration 089); fixes received before upgrading show the timestamp only.

- **Native OIDC group → role mapping (#3485)**: When using OIDC directly (no reverse proxy), MeshMonitor can now map identity-provider groups to roles via three new env vars: `OIDC_GROUPS_CLAIM` (default `groups`, supports dot notation like `realm_access.roles` for Keycloak), `OIDC_ADMIN_GROUPS` (comma-separated groups granted admin), and `OIDC_ALLOWED_GROUPS` (groups allowed to log in; empty = all). When `OIDC_ADMIN_GROUPS` is set, admin status tracks group membership on every login (promote and demote) and the IdP becomes authoritative; when unset, the existing first-login bootstrap + manual-promotion behaviour is preserved. `OIDC_ALLOWED_GROUPS` gates login (admins always pass). Group changes apply on next login. The dot-notation claim traversal and group normalization are shared with proxy auth (`src/server/auth/claims.ts`). No schema changes.

- **Newer AirQualityMetrics telemetry fields wired up (#3507, #3517)**: Several newer air-quality fields were decoded by firmware but never graphed or labelled in MeshMonitor — `particles_40um`, `pm40_standard`, `particles_tps`, the formaldehyde sensor trio, and the PM-sensor extras (`pm_temperature` / `pm_humidity` / `voc_idx` / `nox_idx`). These now have canonical units and frontend labels/colors, so both serial and MQTT ingest store and graph them (including the underscore-before-digit `particles_40um`). No DB migration needed.

- **UI tweaks + map unification pass (#3557, #3561)**: A batch of usability refinements — the sidebar "Messages" nav item is renamed **Node Details**; unified-map node-popup source rows are now clickable (Meshtastic rows jump to that source's Node Details focused on the node, MeshCore rows switch source); a pinned sidebar now loads expanded instead of collapsed; the News/Changelog popup drops the "Don't show again" checkbox (closing dismisses the shown items, the News icon re-opens the feed); and tile-selector + legend toggles plus GeoJSON layer toggles are unified across the Global/Dashboard and MeshCore maps with shared persistence. Also clarifies the Auto Time Sync description (the server pushes its time to the node).

### Bug Fixes

- **Offline nodes kept appearing "recently heard" from replayed packets (#3569)**: A node powered off for weeks could keep showing recent activity and a fresh Last Heard time. The cause was a replayed frame — typically a retained MQTT telemetry message, or an MQTT→LoRa bridge re-injecting an offline node's cached reading onto the mesh with a new packet id (identical payload, so packet-id dedup never caught it). Every attributed packet otherwise stamped `lastHeard = now`, resurrecting the dead node on each replay. A new replay guard (`src/server/utils/replayGuard.ts`) detects a stale frame by its own origin timestamp (`rx_time` ≥ 2020 but more than 6h in the past) and omits the `lastHeard` refresh, so the node-upsert merge preserves the node's existing value instead of advancing it. Applied across the device packet/NodeInfo paths and the MQTT NODEINFO/POSITION/TELEMETRY/traceroute/neighbor/paxcounter/store-forward refreshes. Conservative by design: absent or boot-relative clocks (`rx_time` < 2020) and ordinary skew/jitter fall through to normal "stamp now" behavior.

- **Traceroute History mixed in rows from every source (#3566)**: The Traceroute History modal called the history endpoint without a `sourceId`, so the backend ran unscoped and merged rows from every source — viewing a radio/TCP source mixed in MQTT broker/bridge sources, which record many flood-relayed copies of the same reply. History is now scoped to the active source.

- **Map "Show Neighbor Info" disagreed with the Map Analysis Neighbors view (#3560)**: The live source map and the Map Analysis page drew different neighbor links from the same `neighbor_info` table because they applied different freshness filters. The two views are now aligned.

- **Per-node position override ignored on the multi-source dashboard map (#3551, #3559)**: The dashboard map fetches nodes via `GET /api/sources/:id/nodes`, whose raw DB rows never passed through `enhanceNodeForClient`, so the per-node position override was never applied — the map kept rendering the raw (potentially spoofed) GPS position. The override is now applied on that endpoint.

- **SaveBar only saved the active section (#3552, #3558)**: Editing multiple sections of a config group before clicking Save persisted just one; the others appeared to silently revert. Sections can now share a "group" that is saved and dismissed together by a single **Save All** action.

- **MeshCore DM contact list nearly empty while node/map view was full (#3554)**: The DM contact list was sourced only from the live in-memory `get_contacts` map, which a flaky or slow companion could leave nearly empty (and which is deliberately not wiped on an empty read). The in-memory contacts are now seeded from the durable per-source DB rows on connect, so the DM page matches the node/map view.

- **MeshCore node list intermittently collapsed to a single node**: With multiple MeshCore sources, one source's node list could show just the local node even though the device had (and the DB persisted) dozens of contacts. Two causes: `refreshContacts()` cleared the in-memory contact map on *any* successful `get_contacts` response — including a transient empty read on a busy companion — and `getAllNodes()` served only that volatile in-memory map. The node list (`GET /api/sources/:id/meshcore/nodes`, dashboard map, source summaries) now merges the durable per-source `meshcore_nodes` rows with the live in-memory contacts, and an empty `get_contacts` response no longer wipes the known list. New per-source repo read `getNodesBySource(sourceId)`.

- **Link previews failed to load on MeshCore (and on the first messages page visited)**: `fetchLinkPreview()` used a dynamic `import('../services/api')`, whose Vite preload computed the lazy chunk's URL without the runtime `BASE_URL` prefix (`/assets/…` instead of `/meshmonitor/assets/…`). That 404'd and threw "Unable to preload CSS" on any page where the chunk wasn't already loaded, silently returning `null` so no preview card rendered — most visibly on the MeshCore channel/room/DM views. The api service is now imported statically (it was already in the main bundle and has no circular dependency), removing the fragile dynamic import.

- **User-supplied regexes hardened against ReDoS (#3543, #3544)**: All user/admin-supplied regular expressions are now compiled with RE2, a linear-time engine immune to catastrophic backtracking, replacing the previous heuristic length/nesting guards. Resolves four CodeQL `js/regex-injection` alerts.

- **NodeInfo could overwrite high-precision positions with lower-precision ones (#3513, #3516)**: Meshtastic firmware grid-snaps positions embedded in NodeInfo broadcasts to the channel's `positionPrecision`. MeshMonitor was unconditionally overwriting the stored lat/lon from every NodeInfo arrival, silently degrading accurate stored positions over time. A precision-downgrade guard now only updates the position when the incoming fix is at least as precise.

- **Auto-ping ACKs misattributed / duplicate sends (#3522)**: Auto-ping responses could arrive out of order or fail even when the target was reachable. A `want_ack` DM produces two Routing packets with the same `request_id` (an implicit transmit-ACK from our own node, then the real delivery ACK); ACKs are now matched by destination node, and a duplicate-send race is closed.

- **Node upsert could clobber learned name/MAC/hwModel with blanks (#3505, #3512)**: The upsert merge guard treated `''` and `0` as "provided", so a caller passing a blank name or `hwModel 0` could overwrite a stored value — the durable, per-column form of the MQTT-nameless-nodes fix (#3456).

- **MeshCore `upsertNode` overwrote stored data with nulls (#3504, #3510)**: The update branch spread the incoming node over the row, so fields a caller didn't observe this time (passed as `null`) silently wiped persisted values. It now merges against the existing row.

- **Serial telemetry ingest unified onto the shared digit-aware normalizer (#3506, #3514)**: The serial path read each metric by a hand-maintained camelCase name with per-field fallbacks bolted on to survive the protobuf.js underscore-before-digit quirk. It now uses the same canonical normalizer as the other transports, so new underscore-before-digit fields are picked up automatically.

- **Traffic Management / Status Message firmware gating corrected (#3491, #3493)**: Traffic Management saves appeared to succeed but never persisted, because the firmware set-config handler is develop-only and absent from all releases through 2.7.25. Support is now gated on the firmware versions that actually implement these modules.

- **Battery-alert monitored-node selection stuck with stale IDs (#3486, #3487)**: The source-scoped picker could retain invisible selections saved under a different source or for nodes that no longer exist, so "Deselect all" could never clear them. Stale IDs are now reconciled and select/deselect operate per source.

- **Docker entrypoint integrity check for a 0-byte server bundle (#3542)**: A corrupt or incomplete image pull could leave `dist/server/server.js` empty, causing a silent crash-loop with no actionable message. The entrypoint now fails loudly before handing off to supervisord.

- **System-backup download hardened (#3524, #3529)**: The handler now uses an async existence check instead of the event-loop-blocking `fs.existsSync`, and guards the archiver error/catch paths with `res.headersSent`.

- **Mobile map Features panel blocked the sidebar Connect button (#3536)**: On mobile portrait the map Features panel painted above the slide-in Sources drawer, covering the Connect button. Its z-index now yields to the drawer when the sidebar is open.

### Documentation

- **MeshCore virtual node guide**: The [Virtual Node Server](configuration/virtual-node.md) page now documents both variants — the existing Meshtastic Virtual Node Server and the new MeshCore virtual node (default port 5000, per-source enablement, admin-command safety, and MeshCore app setup).

- **Security pages restored to the public site (#3534)**: The Duplicate-Keys and Low-Entropy-Keys security advisory pages were restored to the documentation site.

- **SSO docs corrected and expanded (#3485)**: Documented `DISABLE_LOCAL_AUTH` in the SSO guide (it was missing) and corrected the inaccurate claim that local auth "remains available via API" when disabled — the login endpoint returns `403` unconditionally with no bypass. Added a Group → Role Mapping section with Keycloak/Authentik examples and noted the proxy-auth group vars.

## [4.10.4] - 2026-06-15

### Bug Fixes

- **MQTT bridge DNS thrashing**: Sites with an MQTT bridge configured saw dozens of DNS requests per minute resolving the broker hostname. In the default `per_gateway` forwarding mode the publisher pool opens one upstream connection *per relayed gateway*, and Node.js does no in-process DNS caching — so every (re)connect across all those connections re-resolved the broker name. Two fixes: (1) a shared in-process DNS cache (`cachingDnsLookup.ts`) is now passed to every upstream MQTT socket, collapsing resolutions to ~one per host per 30s regardless of connection churn (the hostname stays on the socket, so TLS SNI/cert validation is unaffected); (2) the reconnect backoff now only resets after a connection has stayed up for 30s, instead of on every `connect` — previously a flapping connection (e.g. a clientId collision with a gateway that also runs its own MQTT uplink) kept the shared backoff pinned at the 1s minimum, driving a relentless reconnect/DNS storm. The backoff now climbs 1s→60s while flapping and the storm throttles itself.
- **Air-quality particle counts never collected or graphed**: Telemetry from an air-quality sensor reported particle counts (`particles_03um` … `particles_100um`) but they never appeared in the telemetry graphs. protobuf.js only camelCases an underscore followed by a *letter*, so these underscore-before-digit fields stayed snake_case on the decoded message; the serial/direct ingestion path read them as `particles03um` (camelCase) → `undefined` → the values were silently dropped before they reached the database. The PM (`pm10Standard`) and CO₂ (`co2Temperature`) fields were unaffected because their underscores precede letters. Ingestion now reads the snake_case form the decoder actually produces (with the camelCase as a fallback), so all six particle bins are stored under their canonical types and graphed. The same quirk affected `EnvironmentMetrics` `rainfall_1h` / `rainfall_24h`, which are fixed alongside.
- **Timed Events fired across all sources (#3479)**: A Timer Trigger configured for one source was being scheduled and fired on every source. The per-fire result write saved that source's trigger list to the un-namespaced global settings key, which then bled into other sources via the settings GET-merge. Timer-trigger result writes are now source-scoped, so a timed event only runs on the source it was configured for.
- **Saving Traffic Management / Status Message config failed (#3464)**: After these modules became editable in 4.10.3, saving either returned HTTP 400 `Invalid module type: trafficmanagement` / `statusmessage`. The generic module-config save route validated against a hardcoded allow-list that was never updated to include the two new module types (the protobuf encoder already supported them). Both are now accepted.
- **Auto Favorites wrongly reported firmware as unsupported (#3482)**: Auto Favorites could warn "Firmware 2.7.24 does not support favorites (requires >= 2.7.0)" on firmware that clearly qualifies. A support check that ran before the firmware version was known cached `false` and stuck across reconnects. The cache is now keyed by the firmware version it was computed from and never caches the unknown-firmware case.
- **MeshCore Share Contact failed silently (#3481)**: Share Contact on a MeshCore TCP Companion source could do nothing with no actionable error (or hang ~30s). The real failure reason now reaches the user (e.g. firmware that doesn't support the share command) via a structured result, with a faster 10s timeout instead of a silent 30s hang.
- **Delivered icon missing on own replies in Firefox on Android (#3477)**: On narrow screens the sent/delivered status icon next to your own messages could disappear in Firefox for Android, because the message content claimed the full row width and collapsed the status column. A CSS flex-sizing fix keeps the icon visible; desktop was unaffected.

## [4.10.3] - 2026-06-14

### Features

- **Bridged-node detection disables OTA firmware update**: MeshMonitor now detects when a Meshtastic source is a *bridged* node — a serial/BLE-only radio (e.g. an nRF52-class board with no native IP transport) fronted by a TCP proxy such as `meshtasticd` or `mesh-bridge`. The connected node's `DeviceMetadata` capability flags (`hasWifi` / `hasEthernet`) are now captured for the local node and exposed via the poll API as `deviceMetadata.isBridged`. When both are absent, the node physically cannot serve an OTA HTTP endpoint, so the **Firmware Update** UI is disabled with an explanatory notice ("update it directly via USB instead") and the `POST /api/firmware/update` route rejects the attempt server-side as a defence-in-depth guard. Detection is inert until DeviceMetadata arrives (unknown capabilities are never treated as bridged), so native WiFi/Ethernet nodes are unaffected.
- **Bridged-node advisories on MQTT and Network configuration**: Building on bridged-node detection, the Device Configuration UI now guides operators on the two other feature areas that depend on a node's own IP stack. The **MQTT** section shows a recommendation to enable **MQTT Client Proxy** and link the source to an MQTT broker — a bridged node has no direct internet connection, so direct MQTT won't connect, but MeshMonitor can relay it on the node's behalf via the client proxy. The **Network** section (WiFi, Ethernet, NTP, syslog, static IP) shows a notice that those settings are inert on a bridged node since it has no native WiFi/Ethernet hardware (time sync still works over the mesh/connection). `/api/config/current` now includes an `isBridged` flag for the queried source. Mesh/radio features (channels, telemetry, position, traceroute, neighbor info, remote admin, PKI, reboot/shutdown, remote hardware, store-and-forward) are unaffected and keep working over the bridge.

### Bug Fixes

- **MeshCore auto-ack `{SNR}` always blank**: The `{SNR}` macro in MeshCore auto-acknowledge / auto-responder reply templates always rendered as `—`. The RX SNR only arrives on the firmware's `LogRxData` event (not on the contact/channel message-recv event), and while the relay-hash path was buffered across the two events for `{ROUTE}`, the SNR was dropped — the message events hard-coded `snr: undefined`. The SNR is now buffered alongside the path and carried onto `contact_message` / `channel_message` events, so `{SNR}` resolves whenever `{ROUTE}` does.
- **MeshCore device name stripped parentheses and emoji on save (#3450)**: Editing a MeshCore companion's **Device Name** (Source → Configuration) silently deleted parentheses, emoji, and other Unicode the moment you pressed Save, because the name sanitizer used an `[a-zA-Z0-9\s\-_]` allow-list. It now drops only control characters (which would break the line-based repeater serial CLI) and preserves printable Unicode, capping the result to the device's 32-byte name field on a character boundary (so a multi-byte emoji is never split).
- **MQTT nodes appeared nameless (#3456)**: NodeInfo received over MQTT was decoded and saved correctly, then immediately clobbered — the routine "last heard" refresh that runs on every MQTT position, text, and telemetry packet was upserting the node with empty long/short names and a zero hardware model, overwriting the saved values. Since nodes broadcast NodeInfo only every few hours but send position/telemetry constantly, MQTT-sourced nodes appeared nameless almost all the time. The refresh upserts now leave the name and hardware-model fields untouched, so NodeInfo persists.
- **Traffic Management / Status Message shown "Unsupported" on capable firmware (#3457)**: Device Configuration reported the Traffic Management and Status Message modules as "Unsupported by this device" even on firmware that fully supports them (e.g. v2.7.24). Support was inferred from the presence of a decoded module-config sub-message, but Proto3 omits a sub-message whose every field is default — so a node that had never configured the module (the common case) looked unsupported regardless of firmware. Support is now gated on the node's firmware version instead (Status Message requires ≥ 2.7.19, Traffic Management ≥ 2.7.22), matching the requirement the UI already advertises.
- **Local-node module config refreshes were discarded (#3460)**: Explicit local module-config refreshes (`requestModuleConfig` / `requestAllModuleConfigs` / "Refresh") were logged and then dropped because the response handler was wrapped entirely in a remote-node-only branch — only the initial config-download stream ever populated the local node's module config. Local responses (including the all-default Proto3-empty case) are now stored. Discovered while fixing the Traffic Management detection above.
- **Phantom channel swaps when two channels share a PSK and name (#3453)**: When two channels had the same PSK and the same name, channel-move detection produced a bogus bidirectional "swap" on every config sync, which repeatedly re-migrated messages and progressively scrambled which channel each message was attributed to. Ambiguous `(psk, name)` pairs are now skipped during matching, leaving messages in place (genuine single moves and genuine swaps with unique identities still migrate correctly).
- **LoRa Transmit Power help text clarified (#3459)**: The Transmit Power field's help text now explains that a value of `0` uses the hardware's default maximum safe power and that negative values are permitted (the field is signed) but only meaningful on radios that support reduced output power, e.g. SX126x — firmware does not clamp the lower bound, so behavior for negatives is radio-dependent. No input constraints were added; MeshMonitor continues to accept negative values.

## [4.10.2] - 2026-06-14

### Features

- **User-script dependencies (Python/Node packages)**: Auto Responder / trigger scripts can now use third-party packages. Drop a `requirements.txt` (Python) and/or `package.json` (Node) into the scripts directory (`$DATA_DIR/scripts`) and click **Install / Update dependencies** in the script-management panel (admin / `settings:write`). Packages install into `python_packages/` (pip `--target`) and `node_modules/` next to the scripts on the persisted volume — so they survive restarts — and are exposed to running scripts via `PYTHONPATH` / `NODE_PATH` across every script path (Auto Responder, geofence/timer triggers, the script test endpoint, and MeshCore). Python installs are wheel-only by default so the slim Alpine/musl image needs no compiler; set `SCRIPT_DEPS_ALLOW_SOURCE_BUILD=true` to permit source builds. The installer reuses the same interpreters that run the scripts (ABI-matched) and is isolated from the bundled Apprise venv. Installing third-party packages runs external code and needs network access, so it's admin-gated.

- **Traffic Management telemetry surfaced in graphs**: The Meshtastic Traffic Management module (firmware v2.7.22+) emits a `TrafficManagementStats` telemetry packet, which MeshMonitor already ingests and stores (packets inspected, position-dedup drops, NodeInfo cache hits, rate-limit drops, unknown-packet drops, hop-exhausted packets, router hops preserved). Those seven counters now render as labelled, integer-valued series in a node's telemetry graphs under a shared **"Traffic Mgmt:"** label group (previously they were stored but shown with raw field names). The Traffic Management config section's "unsupported firmware" notice was also refreshed now that the module ships in stable firmware.

- **PKI direct-message decryption across sources (#3441)**: MeshMonitor can now decrypt PKI-encrypted Meshtastic direct messages server-side so they surface in the unified Messages view — the cross-source DM aggregation case. Opt in per source under **Configuration → PKI Direct Message Decryption** (gated by the per-source `configuration` permission); when enabled, MeshMonitor extracts that source's local-node X25519 private key from the device and stores it **encrypted at rest** (AES-256-GCM via a `SESSION_SECRET`-derived key, same envelope/threat-model as MeshCore admin credentials). An incoming PKI DM is decrypted using the **destination** node's stored key regardless of which source received it — so a DM relayed still-encrypted through an MQTT bridge/broker, addressed to one of your connected nodes, gets decoded and shown. The decryption is byte-exact to the firmware scheme (X25519 → SHA-256 → AES-256-CCM). Disabling a source forgets its stored key immediately. Decrypted DMs carry the receiving source's `sourceId`, so the unified feed's existing per-source `messages:read` gate applies. A **global master switch** under **Settings → Security** (off by default) gates the whole feature instance-wide — turning it off forgets every stored key and disables the per-source toggles. Requires `SESSION_SECRET` to be configured (the UI warns and refuses to persist keys otherwise; the desktop builds set a stable one automatically). Documented at [meshmonitor.org → PKI Direct Message Decryption](https://meshmonitor.org/features/pki-dm-decryption). Re-delivery to mobile clients (virtual node) is intentionally out of scope.

- **Map Features: "Maximum age" slider (#3322)**: The Map Features panel on both the per-source map and the global/unified map gains a **Maximum age** slider. It ranges from 1 hour up to the configured node maximum age (Settings) and defaults to that maximum, so existing behavior is unchanged until you move it. Dragging it down hides stale **node markers, traceroutes, and route segments** in real time (favorites remain pinned). The value is saved per user alongside the other map preferences (migration 087) and shared between both maps.
- **Helm chart: Gateway API HTTPRoute (#3432)**: The Helm chart can now provision a Gateway API `HTTPRoute` as a modern alternative to ingress, gated behind `httpRoute.enabled` (default `false`). Set `parentRefs` (and optionally `hostnames`); the chart routes the matched traffic to the MeshMonitor service automatically, with `matches`, `filters`, and `additionalRules` available for advanced setups and `apiVersion` overridable for older Gateway API CRDs.
- **Helm chart repository (#3431)**: MeshMonitor now publishes a proper Helm repository at `https://meshmonitor.org/charts`, so you can install without cloning the repo — `helm repo add meshmonitor https://meshmonitor.org/charts && helm install meshmonitor meshmonitor/meshmonitor`. The chart is packaged and indexed by `scripts/build-helm-repo.sh` during the docs deploy and served from the existing docs site (no separate `gh-pages` branch). The repository tracks the latest released chart; older versions remain installable from a checkout at the matching tag.
- **MeshCore messages in the Unified Messages feed (#3442)**: MeshCore channel and direct messages now appear in the cross-source **Unified Messages** view alongside Meshtastic traffic, with a small **MeshCore** badge on the source tag so the protocol is obvious at a glance. MeshCore channels already showed in the unified channel picker (they share the channels table); selecting one now actually returns its messages. Identity maps onto the unified shape via the sender's parsed name / public key (MeshCore has no nodeNum or mesh packet id), and access honours the same per-source `messages` / `channel_N` read permissions.

### Bug Fixes

- **Couldn't remove a MeshCore contact with a malformed/short public key (#3443)**: When a MeshCore node landed in the database with a truncated or malformed public key (e.g. a room server that showed up as two entries), clicking **Remove** failed with "Invalid public key — must be 64-char hex" and the row was stuck forever. The `DELETE …/meshcore/contacts/:publicKey` route no longer applies the 64-char-hex format guard (that check still protects the routes that *transmit* a key to the device), and when the device-side `remove_contact` can't match the key (a ghost/truncated row, or the source is disconnected) the route now falls back to forgetting the row locally — so stale/malformed contacts can always be cleaned up from MeshMonitor.
- **MeshCore channels were capped at ~50 messages total across all channels (#3442)**: The MeshCore message API only ever served a single global recent-tail (the snapshot hard-capped at 50, shared across every channel **and** direct messages), so a busy channel — or a burst of DMs — pushed other channels' history out of the visible window and quiet channels looked empty. Each MeshCore channel now fetches its **own** backlog from a dedicated per-channel endpoint (`GET …/meshcore/messages/channel/:idx`), independent of the shared pool, and merges live socket updates on top. The per-channel message count badge reflects the real backlog for the open channel.
- **Auto Welcome DMs failed on first contact after a nodeDB reset (#3439)**: When many nodes came online at once (e.g. after a nodeDB reset), Auto Welcome DMs failed with a red ✗ — the welcome was transmitted while the target's radio was still finishing its own startup TX burst and not yet receive-ready, and with no retry (`maxAttempts=1`) that was a permanent failure. Auto Welcome now waits a configurable **pre-send delay** (new per-source setting `autoWelcomeDelay`, default 30s, range 0–120, in the Auto Welcome settings) after first hearing a node before sending its welcome, letting the node settle into receive mode. The send is scheduled non-blocking (it no longer stalls packet processing), the de-dup lock is held across the wait, and the welcome is skipped if the node is welcomed during the delay.
- **Telemetry graphs reshuffled on every update (#3436)**: The Local Node Telemetry graphs on a node's Info screen rendered in the telemetry-grouping order, which changed on almost every update — so a graph you were watching kept jumping around. They now use a stable, deterministic order: favorited metrics first, then alphabetical by label. New metrics (once data becomes available) slot into their alphabetical position instead of appearing at random.

## [4.10.1] - 2026-06-11

### Features

- **Automated Remote Favorites Management (#2608)**: A new **Automatic Favorites Management** section on a node's Remote Admin page keeps the favorites list up to date on remote infrastructure nodes — preserving Meshtastic's zero-hop cost between favorited routers as the mesh changes, without site visits or blind CLI spamming. Per target, MeshMonitor discovers the node's direct neighbors from its **NeighborInfo** broadcasts and/or from **traceroutes that pass through it**, filters them to a configurable set of eligible roles (default Router / Router Late / Client Base), and sends `set-favorite` admin commands on a schedule (default every 24h), capped per cycle for newly-discovered (default 1) and re-asserted (default 1) favorites. Favorite commands are **confirmed**: MeshMonitor captures the firmware's routing ACK and surfaces the result per favorite (confirmed / no-ack / rejected) on both the automatic ledger and the manual **Set/Remove Favorite** buttons — and the re-favorite pass prioritizes un-confirmed assignments to recover any whose command was dropped. A **Maximum neighbor age** setting (default 24h) reuses an on-file NeighborInfo record instead of re-requesting one when it's recent enough, saving airtime. (Migrations 084–086.)
- **Guided firmware half-flash recovery (#3413)**: A guided recovery flow for a device left in a half-flashed state, with an online connectivity check before recovery is attempted.
- **Disable link previews (privacy)** (#3416): A global **Settings → Link Previews** toggle ("Show link previews") controls whether MeshMonitor fetches and renders OpenGraph preview cards for URLs in messages. When off, no outbound request is ever made to a link target — URLs still render as clickable text. The toggle is enforced at three layers: the `/api/link-preview` endpoint refuses to fetch (403), the `LinkPreview` component renders nothing and skips the request, and operators can hard-disable instance-wide via the `LINK_PREVIEWS_ENABLED=false` environment variable (which overrides the UI). Previews (and the toggle) now apply consistently across **all** message surfaces — Meshtastic and MQTT channels & DMs, the Unified messaging view, and MeshCore channels & DMs. Defaults to enabled, preserving existing behavior.
- **Per-channel notification sounds**: The in-app "new message" audio notification is now selectable per channel. A new picker under **Settings → Notifications & Security** (shown when "Enable Audio Notifications" is on) lists each channel with a dropdown of bundled sounds — five standard tones (Classic Ding, Soft Chime, Classic Beep, Ping, Marimba Blip) and four fun ones (8-bit Coin, Ascending Arpeggio, Boop, Radio Squelch) — plus a **Silent** option and a **Preview** button. Every sound is synthesized at runtime from Web Audio oscillators (no audio files and no third-party samples, so the whole set is original/public-domain). Selections persist per channel in `localStorage`, the direct-message pseudo-channel has its own row (Meshtastic sources only), selections are scoped per source so the same channel number on two sources stays independent, and the default (Classic Ding) reproduces the previous hard-coded 800 Hz ding so existing behavior is unchanged for anyone who doesn't customize.

### Bug Fixes

- **Per-channel notification sounds: DM row + per-source scoping (#3414)**: Wired up the direct-message sound row and scoped channel-sound selections per source so the same channel number on two sources stays independent.
- **MeshCore hop-count decode**: The packed `out_path_len` is now decoded correctly, fixing the hop count for 2-byte path hashes on MeshCore contacts.
- **Auto-favorite checkbox layout (#3423)**: The Automatic Favorites Management checkboxes now sit beside their labels instead of above them.

## [4.10.0] - 2026-06-10

### Features

- **Auto Remote LocalStats — periodic `local_stats` requests to remote nodes (#3398)**: A new per-source automation (modeled on Auto Traceroute) periodically requests `local_stats` telemetry — noise floor, channel/air utilization, uptime, and packet counts — from remote nodes, so you can graph the health of nodes you don't physically own. Targets are chosen by a union of enabled filters: an explicit node list, role, the favorite flag, and a name regex. Requests go out as a unicast on the node's channel (shared PSK) rather than a PKI DM, which both bypasses the firmware's multi-hop-broadcast role gate (so `REPEATER`/`CLIENT` nodes answer too) and avoids stale-key fragility; `hop_limit` is sized to the target's observed distance. A round-robin scheduler polls one least-recently-polled target per tick with jitter, a schedule window, an airtime gate, and a minimum-interval rate limit, and is passive-mode aware. Responses flow through the existing telemetry pipeline — no new storage. Configure it under **Automation → Auto Remote LocalStats**.

- **Map Analysis: node search, marker spiderfy, and traceroute direction/weak-link filtering (#3399)**: Four enhancements to the Map Analysis view. (1) A toolbar **search box** hides non-matching markers and constrains traceroute link endpoints, matching long/short name, node id, and hex/decimal `nodeNum`. (2) **Overlapping markers** at the same coordinates now fan out ("spiderfy") so each node is individually selectable. (3) **Inbound/outbound traceroute separation**: hops are decomposed into directed RX/TX legs (each hop's SNR is measured at its receiver, so a hop arriving at the selected node is inbound and one leaving it is outbound), rendered with direction colours, opposite curvature, and SNR-tooltip arrows. (4) **Weak-link filtering + per-node summary**: persisted min-occurrences and min-SNR filters declutter links, and the inspector shows distinct links, in/out counts, observation counts, and average SNR. Frontend-only over the existing `/api/analysis/traceroutes` data — no migration or API change.

- **GeoJSON overlays on public, anonymous, embed, and dashboard maps (#3407)**: Custom GeoJSON overlay layers previously reached only authenticated users. Each layer now has an opt-in **Public** toggle (default off); flagged layers render on the public/anonymous map, the embed map, and the unified dashboard map, while private layers stay private — closing the prior gap where every layer was anonymously readable. The `/layers` and `/layers/:id/data` endpoints use optional auth (operators see all; anonymous callers get only public layers, with private data returning 404), and the embed surface gets its own public GeoJSON endpoints. Opt-in and secure by default.

- **Desktop: Apprise notifications bundled as a frozen sidecar (#3405)**: Desktop (Tauri) builds previously shipped the Node backend but no Python, so the Apprise notification engine the Docker image runs as a Python sidecar was unavailable — desktop users could only point at a remote Apprise API. Apprise is now frozen (via PyInstaller, with every notification plugin collected) into a single self-contained executable bundled alongside the Node binary, giving desktop full local Apprise support with no system Python. The Rust shell starts it on a free loopback port bound to `127.0.0.1` only, injects `APPRISE_URL` into the backend, and keeps it alive across backend restarts. (Known gap: macOS x86_64 builds are cross-compiled on an arm64 runner where PyInstaller can't cross-compile, so Intel macOS falls back to a remote Apprise API.)

- **Noise Floor in LocalStats telemetry (#3396)**: The `noiseFloor` (dBm) field that Meshtastic firmware 2.7.25 added to `LocalStats` is now captured and graphed alongside the other device LocalStats metrics (uptime, channel utilization, packet counts, heap, etc.) — it appears on the Device Info page and anywhere local-stats telemetry is charted, with integer (dBm) formatting. The protobufs submodule was bumped from v2.7.23 to v2.7.25; that bump is otherwise additive (new sensor enums and LoRa regions), with no field removals affecting MeshMonitor.

### Bug Fixes

- **MeshCore low-battery notifications never fired (#3417)**: The `meshcore_nodes.batteryMv` column was never populated — `persistContact()` omits it and the remote-telemetry scheduler wrote battery voltage only to the telemetry table (`mc_status_battery_volts`), not back to `meshcore_nodes`. Since `getLowVoltageNodes()` queries that column, it always returned zero rows and no Apprise/push alerts were sent regardless of the configured threshold. Fixed by persisting `batteryMv` to `meshcore_nodes` immediately after a successful `requestNodeStatus()` response in the scheduler.

- **Security tab leaked dead nodes and key-mismatch events across sources (#3406)**: `GET /api/security/dead-nodes` called `getAllNodes()` with no `sourceId`, so it returned dead nodes from *every* source (surfacing as 2000+ dead nodes for a single Meshtastic source); the `/api/security/key-mismatches` handler similarly ignored `sourceId` and showed repair-log events from every source. Both are now scoped to the requested source. The same fix wires the **Auto Remote LocalStats** section into the Automation sub-nav, which had been rendered and fully wired but was unreachable from the navbar because its nav item was missing.

- **Radio Statistics legend clipped counts; Packet Distribution lacked a total (#3400, #3401)**: The Radio Statistics legend clipped the raw count in parentheses mid-value (e.g. `Bad: 24.5% (2 ...`) because nowrap + ellipsis truncation was applied even to the horizontal RX/TX legends; truncation is now applied only in stacked mode, so the legends wrap and always show the full count. The Packet Distribution panel now shows a prominent grand total (`Total: N packets`) in its header.

- **Custom analytics "CSP Allowed Domains" were silently dropped (#3409)**: `getAnalyticsCspFromSettings()` short-circuited for *both* the `none` and `custom` analytics providers, so a "CSP Allowed Domains" value configured for a Custom Script never reached the `Content-Security-Policy` header — the configured origins were dropped from `script-src` and `connect-src`. The `custom` provider is no longer caught by that early-return guard, so the configured domains flow through.

## [4.9.4] - 2026-06-09

### Features

- **Local-node impersonation detection (#2584)**: Meshtastic channel messages carry no cryptographic sender authentication, so anyone on a channel can transmit a packet with a forged `from` field. Previously, a packet that spoofed our own locally-connected node's number was shown as one of our *outgoing* messages. MeshMonitor now detects this: a packet claiming `from == our local node` that arrived over RF (carries rx SNR/RSSI, travelled hops, or a radio transport) and was *not* one we recently sent is flagged `spoofSuspected`. Such messages are no longer rendered as our own — they show a red "⚠️ Possible impersonation of your node" badge in the channel view, and matching packets are highlighted in the Packet Monitor. False positives from our own packets being overheard/rebroadcast, echoed by MQTT, or replayed by store-and-forward are suppressed by matching the packet `id` against a short-TTL ring buffer of ids we originated. Detection is per-source. (Phase 1: self-node spoofing; PKI-DM verification and the Security-page/notification surface are tracked as follow-ups.)

- **Channels tab: full-height chat layout (#3385)**: The Channels tab now uses the full available viewport height and a single compact controls bar. The "Channels (N)" heading, the channel selector, the per-channel actions (info, mute, Mark-all-read), and the "Show MQTT/Bridge Messages" toggle all sit inline on one row — the redundant per-channel title bar (which duplicated the channel name the selector already shows) was removed. The message pane stretches from beneath that bar down to the message input, filling the remaining height dynamically on any screen size instead of being capped at a fixed height that left a large empty area below on tall monitors. Desktop changes are scoped to the Channels tab via `:has()`, so other tabs are unaffected. On mobile the bar collapses to just the channel selector plus a "⋯" overflow menu (info, mark-all-read, Show MQTT/Bridge, and the mute options) so the header stays on a single line; the iOS-PWA height handling is preserved.

- **Airtime cutoff: show contributing infrastructure nodes (#3392)**: The "Cutoff Airtime Utilization Threshold" section (Meshtastic Automation config) now trims the displayed Channel Utilization to at most 2 decimal places and, in neighbours mode, lists the 3 infrastructure nodes whose ChUtil was averaged into the reading (strongest RSSI first) — so it's clear which nodes are driving the cutoff decision.

- **`{DATE}` and `{TIME}` tokens for Auto Announce (#3382)**: Auto Announce messages can now include `{DATE}` and `{TIME}` tokens, rendered with the user's configured date/time format. Resolves #3382.

- **Export MeshCore packet monitor log as JSONL (#3391)**: The MeshCore Packet Monitor can now export its captured log as newline-delimited JSON for offline analysis. Resolves #3391.

- **System appearance theme selection (#3344)**: A new theme option that follows the operating system's light/dark appearance. (Thanks @wilhel1812.)

### Bug Fixes

- **`{NODECOUNT}`/`{DIRECTCOUNT}` tokens disagreed with the Sources "active" badge (#3389)**: The count tokens used the configurable `maxNodeAgeHours` window (default 24h) while the Sources panel "active" badge counts nodes heard in the last 2h, so an Auto-Acknowledge message could report e.g. "99/91" while the UI showed "62 active" for the same gateway. The tokens now use the same 2h active-node window the badge uses (across auto-ack / announce / geofence / timer / welcome and the auto-responder script env). Telemetry graphs keep the `maxNodeAgeHours` window to avoid a discontinuity.

- **Auto-Acknowledge `{LONG_NAME}`/`{SHORT_NAME}` resolved as `Unknown`/`????` (#3384)**: The auto-ack template resolver looked up the sender node without a `sourceId`. Under the multi-source composite `(nodeNum, sourceId)` primary key, an unscoped lookup returns the first matching row across *any* source — frequently a different source's row (or none), so the name tokens intermittently fell back to `Unknown`/`????` even when the originating source had the node's name on record (the channel-window title, which reads per-source, always showed it correctly). The lookup is now scoped to the manager's own `sourceId`, matching the already-correct auto-welcome path.

- **Telemetry charts distorted by nodes with bad hardware clocks (#3362)**: A node that reboots without GPS/NTP can broadcast telemetry stamped months or years into the future; those points passed the "last N hours" cutoff and stretched the auto-scaled chart X-axis so every telemetry graph collapsed into a sliver. Telemetry ingest now sanitizes future-dated timestamps at the repository chokepoint — a timestamp more than 1h ahead of server-receipt time (or non-finite) is replaced with the receipt time, and the node's claimed value is preserved in `packetTimestamp` for forensics. The averaged chart query also excludes future-dated rows, so estimates stored before this fix no longer distort the axis. Absurdly-old embedded times are left untouched (indistinguishable from buffered/store-forward telemetry at ingest, and already excluded by the chart's time-window cutoff).

- **Dashboard map ignored the Map Pin Style setting (#3364)**: The unified dashboard map always drew pins regardless of the configured Map Pin Style; it now respects the setting. Resolves #3364.

- **MeshCore showed "Disconnected" while status was still loading (#3380)**: A MeshCore source now displays "Connecting…" during the initial status load instead of momentarily reading as Disconnected. Relates to #3379.

### Security

- **Map Analysis positions endpoint now enforces `viewOnMap` and private-position gates (#3366)**: The analysis positions endpoint (used by Map Analysis "Trails") did not apply the same channel `viewOnMap` and private-position permission checks as the rest of the map, which could expose GPS history to users lacking the required permissions. The gates are now enforced on that endpoint. Resolves #3365.

### Dependencies

- Bumped: `react-router-dom` 7.16.0 → 7.17.0 (#3378), `@tanstack/react-query` 5.100.14 → 5.101.0 (#3377), `protobufjs` 8.4.2 → 8.6.1 (#3376), `@tanstack/react-query-devtools` (#3375), `morgan` 1.10.1 → 1.11.0 (#3374), `i18next` 26.2.0 → 26.3.1 (#3373), `lucide-react` 1.16.0 → 1.17.0 (#3372), `@tanstack/react-virtual` 3.13.26 → 3.14.2 (#3371), the production-dependencies group (9 updates, #3370), `@types/node` (#3368), and `codecov/codecov-action` 6 → 7 (#3367).

## [4.9.3] - 2026-06-07

### Features

- **Position Estimation moved to Global Settings**: Position estimation is a single global, cross-source batch job (one set of `position_estimation_*` keys, one scheduler pooling traceroute + NeighborInfo observations across all Meshtastic sources). It previously rendered in the per-source Automation tab, which implied per-source configuration, was hidden for `mqtt_bridge` sources, and mismatched the backend (its status/run-now/save endpoints are gated by `settings:read`/`settings:write`, not `automation`). It now lives in **Global Settings → Position Estimation**, gated on `settings:write`. Resolves #3360.
- **Maximum acceptable accuracy cutoff for position estimates**: New global setting `position_estimation_max_uncertainty_km` (0 = no limit). When set, any solved estimate whose uncertainty radius exceeds the ceiling is discarded instead of stored, and that node's now-too-uncertain estimate is cleared — so low-confidence guesses (dominated by the ~5 km single-anchor default) stop drawing huge circles on the map. The last-run summary reports how many estimates were discarded.
- **"Show Accuracy" governs estimated-position circles**: The estimated-position uncertainty circles on the map are now controlled by the existing **Show Accuracy** map toggle (previously tied to "Show Estimated Positions"), so one control governs every accuracy overlay. The estimated markers stay under "Show Estimated Positions"; a circle is drawn only when both are on.
- **Sources sidebar — Edit mode for reordering**: Drag-to-reorder handles are now hidden by default and revealed via an **Edit** toggle next to **+ Add** (gated on `sources:write`), keeping the sidebar uncluttered when reordering isn't needed. Resolves #3355.
- **Sources sidebar — resizable width**: The dashboard Sources sidebar can be resized by dragging its right edge; the chosen width persists per browser (200–480px) and is keyboard-accessible. Resolves #3356.

### Bug Fixes

- **MQTT broker source node count flickered on selection (#3354)**: The MQTT broker card's node count alternated (e.g. 11 ↔ 12) depending on which source was selected. The `/:id/nodes` endpoint injects the broker's synthetic gateway node when it isn't persisted, but `/:id/status`'s `getNodeCount` (a plain `COUNT(*)`) did not, so the badge disagreed with the node list and with the selected-source live count. `/status` now mirrors the injection, so the count matches the list and stays stable regardless of selection.
- **Settings section-nav buttons did not scroll**: On the standalone Global Settings page, none of the section-nav ("jump to section") buttons scrolled. `<body>` computes to `overflow-y: auto` but isn't the actual scroller (the window is), and `SectionNav` picked it and called `body.scrollBy()` — a no-op. The nearest-scrollable-ancestor search now requires the element to be genuinely scrollable (`scrollHeight > clientHeight`) and skips `<body>`/`<html>`, falling through to window scrolling.

## [4.9.2] - 2026-06-06

### Features

- **Reorderable Sources list on the Unified View**: Admins can now drag-and-drop the source cards in the Dashboard / Unified View sidebar to control their order, mirroring the existing channel-reorder UX. The order is stored server-side (new `sources.displayOrder` column, migration 081) so it is shared across all viewers, and a grab handle only appears for users with `sources:write`. The Unified aggregate card stays pinned at the top and is not draggable; new sources append to the end of the list. Resolves #3338.
- **Notifications space for MeshCore sources**: MeshCore sources now have a dedicated **Notifications** tab (previously the notifications UI only existed for Meshtastic sources, so the voltage low-battery threshold added in 4.9.1 was unreachable from a MeshCore source). The shared notifications settings are now source-type aware: for MeshCore they show only the controls that actually work — voltage (mV) low-battery threshold, inactive-node, new-node, server events, monitored-node picker, and Web Push / Apprise delivery — and hide Meshtastic-only options (percentage threshold, direct messages, emoji reactions, MQTT, traceroute, channel selection, and keyword filtering). The Meshtastic notifications page no longer shows the irrelevant mV field. Resolves #3331.
- **MeshCore inactive-node notifications**: Inactive-node alerts now fire for MeshCore sources. The service previously iterated every source but only queried the Meshtastic node table, so MeshCore monitored nodes never alerted. It now has a MeshCore branch that reads `meshcore_nodes.lastHeard` (stored in milliseconds, unlike Meshtastic's seconds) and reconstructs the `mc:<sourceId>:<pubkey>` monitored-node ids.
- **MeshCore new-node notifications**: "New node discovered" notifications now fire for MeshCore. They trigger on the first real-time contact advert (not bulk contact-list sync, so reconnecting to a device with many saved contacts won't storm notifications), carry the advertised display name and device-type label (Companion / Repeater / Room Server), and de-duplicate per public key for the session.

### Bug Fixes

- **migrate-db TABLE_ORDER out of sync with the schema (#3337)**: The SQLite → PostgreSQL/MySQL migration CLI's explicit table ordering had drifted: nine 4.x tables (`waypoints`, `embed_profiles`, `geofence_cooldowns`, the four `meshcore_*` tables, `news_cache`, `user_news_status`) were missing and a stale `key_repair_state` entry referenced a table that never existed. Unlisted tables were still migrated via the catch-all fallback (no data was lost), but they now have explicit FK-safe positions, the new source-scoped tables participate in the `sourceId` backfill, and a regression test enumerates the Drizzle schema to fail CI if a future table is added without being registered. The migration docs now also recommend running the tool from the Docker image tag matching the *source* database's version rather than `latest`, to avoid mid-migration schema mismatches.
- **Channels tab layout broken on installed iOS PWAs (infinite scroll + dead space below the input)**: On the Channels tab in an installed iOS PWA the message list grew without bound — the page scrolled forever and the send bar was pushed off-screen — and even once bounded, a large dead-space gap remained below the input. The causes were iOS-WebKit-specific (all invisible on Chrome/desktop, which masked them): (1) `.app-main`'s default flex `min-height: auto` refused to shrink below its content, so the message list expanded it past the viewport — fixed with `min-height: 0` and an `overflow: hidden` backstop; (2) iOS does not reliably propagate a definite height down the nested conversation flex chain, so `flex-grow`/grid-`1fr`/auto-margin all left the message list short and the send bar floating — the message list is now given a deterministic, measured pixel height (`ResizeObserver` in `ChannelsTab`) so the in-flow send bar lands at the bottom; (3) `position: sticky; bottom: 0` on the send bar resolved `bottom: 0` against the safe-area-inset viewport on iOS, pinning the bar ~34px (the home-indicator inset) above the real bottom — removed, since the deterministic height already places the bar correctly; and the doubled bottom padding (`.app-main`, conversation, section) was trimmed on mobile. Regression from the #3307 PWA dead-space fix.
- **Channel reorder could replace a Meshtastic channel with a MeshCore one**: The `POST /api/channels/reorder` handler read the current channels with an unscoped `getAllChannels()` and keyed them into a slot-indexed map. Because MeshCore and Meshtastic channels share the `channels` table and both use slot ids 0-7, a MeshCore channel occupying the same slot could win the lookup and be written back to the Meshtastic device. The reorder read and database writes are now scoped to the source being edited (`reorderManager.sourceId`), keeping each source's channels isolated.

## [4.9.1] - 2026-06-05

### Features

- **MeshCore low-battery alerts (voltage-based)**: Low-battery notifications now work for MeshCore sources. MeshCore devices report battery as a voltage (mV) rather than a 0-100 percentage, so a new per-user voltage threshold (default 3300 mV) is compared against each monitored node's `batteryMv`. The Notifications settings expose both thresholds — percentage for Meshtastic, mV for MeshCore — and the monitored-node picker now lists all MeshCore nodes (not just those with a GPS fix) so battery-powered companions can be selected. Resolves #3331.
- **Airtime cutoff — neighbour-averaged source**: The airtime-utilization cutoff (Automation page) can now measure Channel Utilization from *nearby infrastructure* instead of the local node. In "Nearby infrastructure" mode it averages the Channel Utilization of the 3 strongest-RSSI directly-heard (0-hop) router/repeater nodes — useful when a well-placed node under-reports the wider mesh. Default remains the local node's own Channel Utilization; the live banner shows which source is in use and how many neighbours were sampled.

### Fixes

- **MQTT broker source dashboard/map showed no nodes**: `MqttBrokerManager` was missing the `getAllNodesAsync` / `getConnectionStatus` / `getDeviceConfig` methods that the consolidated `/api/poll` (and `/api/device/tx-status`, `/api/messages/unread-counts`) endpoints call, so those endpoints threw `TypeError: ... is not a function` and returned HTTP 500 for `mqtt_broker` sources. The dashboard and map therefore received no node data and showed no positions/pins, even though node positions were being ingested and stored correctly. The broker manager now implements the same DB-backed read methods as `MqttBridgeManager`.

## [4.9.0] - 2026-06-05

# MeshMonitor v4.9.0

Feature release adding **low-battery alerts** for monitored nodes, an **airtime-utilization cutoff** that automatically pauses bot automations when the mesh is busy with real traffic, a **time-range selector** for the Device Info telemetry graphs, and a **`{LAST_HOP}`** automation template variable — plus authoritative **ignored-node re-application** and fixes to MQTT telemetry ingestion, MeshCore, and the API rate limiter.

### Features

- **Low-battery alerts (#3305)**: New per-user notification that fires when a monitored Meshtastic node's battery drops below a configurable threshold, delivered through the existing notification fan-out (Apprise / Web Push / Desktop). Reuses the inactive-node monitored-nodes list; threshold, check interval, and cooldown are configurable, with per-user/source rate limiting and `nodes:read` permission gating.
- **Airtime utilization cutoff (#3311)**: A new "Cutoff Airtime Utilization Threshold" (default 30%) on the Automation page. When the connected node's self-reported Channel Utilization exceeds the threshold, all transmitting automations (auto-traceroute, auto-announce, auto-ack, auto-ping, auto-responder, auto-welcome, timers, geofence, time-sync, remote-admin-scan, key-repair) pause so bots stop adding traffic while real activity is heavy, then resume automatically once utilization drops. A live banner shows current utilization and whether automations are paused. Manual sends are never blocked.
- **Telemetry time-range selector (#3312)**: A time-range selector (15m–7d) on the Device Info telemetry graphs for the locally connected node; the selected window is remembered per browser.
- **`{LAST_HOP}` automation variable (#3318)**: New template variable for autoresponder and auto-ack messages that resolves the last relay node — short name when known, hex byte when the relay isn't in the node database, or `unknown` when there's no relay info — matching the Packet Monitor display logic.
- **Ignored nodes auto-reapply (#2601)**: The per-source ignore list is now authoritative. When a device's on-board node database fills up it silently drops ignores and reports the node as un-ignored; MeshMonitor now re-applies the ignore flag for any listed node that reappears without it — for both newly discovered and existing nodes, across SQLite/PostgreSQL/MySQL. The ignore is also re-pushed to the locally-connected node (a local admin command, no mesh traffic) so the radio resumes blackholing the node's packets at the firmware level, with a per-node cooldown to avoid command storms.
- **MeshCore message date separators (#3316)**: MeshCore chat now shows date separators between messages from different days.

### Fixes

- **MQTT telemetry key normalization (#3314)**: Environment/device/air-quality/power metrics ingested via MQTT were stored under group-prefixed protobuf keys (e.g. `environment.barometricPressure`) instead of the canonical short keys used by serial ingestion (`pressure`), leaving MQTT-sourced environment data invisible in the UI graphs. MQTT now writes the canonical keys and units, and a migration rewrites existing dotted rows so historical data becomes visible.
- **Averaged telemetry graph query on PostgreSQL (#3312)**: The averaged query passed the time-bucket interval as a bound parameter, so PostgreSQL's `GROUP BY` functional-dependency check treated the SELECT and GROUP BY buckets as different expressions and rejected it (`column telemetry.timestamp must appear in the GROUP BY clause`) — returning HTTP 500 from `GET /api/telemetry/:nodeId` on Postgres-backed deployments. The interval is now inlined as a literal and the query orders by the grouped bucket expression. A PostgreSQL regression test (run against the CI `postgres:16` service) now covers the averaged query.
- **Telemetry graph averaging (#3312)**: Graph averaging now scales to a manageable point count for any window on all database backends. Previously PostgreSQL/MySQL returned only the newest ~5000 rows with no averaging, so long windows (e.g. "Last 168 hours") were silently truncated to roughly the most recent 12 hours on chatty nodes. Short windows keep near-full resolution while long windows return the full history downsampled.
- **MeshCore packet log timestamps (#3317)**: Widened `meshcore_packet_log` timestamp/createdAt columns to BIGINT to avoid overflow.
- **MeshCore sidebar icons (#3306)**: Use lucide sidebar icons matching the MQTT/Meshtastic styling.
- **PWA chat input (#3307)**: Removed dead space below the chat input in the installed PWA.
- **API rate limiter (#3309)**: Exempt RFC 1918 / loopback IPs from the API rate limiter so local/reverse-proxy traffic isn't throttled.
- **Apprise configuration (#3321)**: Fixed a UNIQUE constraint error when configuring Apprise for a source.
- **Unified node count (#3321)**: Include MeshCore nodes in the unified source node count.

## [4.8.3] - 2026-06-02

# MeshMonitor v4.8.3

Patch release adding **active MeshCore node discovery** (and reciprocal discoverability), a dedicated **MQTT bridge Configuration page** with per-bridge publish filtering, plus correctness fixes to MeshCore private-key validation, hashtag-channel creation, and reconnect stability.

## Features

### MeshCore

- #3302 feat(meshcore): active node discovery (Discover Nearby Nodes / Repeaters) — proactively discover nearby MeshCore nodes and repeaters on demand.
- #3303 feat(meshcore): respond to discovery requests (be discoverable) — answer inbound discovery requests so this node is itself discoverable by peers.

### MQTT

- #3294 feat(mqtt): dedicated bridge Configuration page with per-bridge publish filter — manage MQTT bridges from a dedicated Configuration page, including a per-bridge publish filter.
- #3299 feat(mqtt): slim bridge source-edit modal to basics, deep-link to Configuration page — the per-source bridge edit modal is trimmed to the essentials and deep-links to the full Configuration page.

## Fixes

- #3301 fix: correct MeshCore private key validation to 128 hex chars (64 bytes) — MeshCore private keys are now validated as 128 hex characters (64 bytes).
- #3298 fix(meshcore): allow adding new hashtag channels (fixes #3297) — adding a brand-new MeshCore hashtag channel now works.
- #3270 fix(stability): close transport-level orphan-reconnect flap — a transport-level reconnect flap from orphaned connections is now closed out.
- #3283 fix(build): pin legacy-peer-deps in .npmrc so npm ci stays in sync — pins `legacy-peer-deps=true` in `.npmrc` so `npm ci` and `npm install` resolve dependencies identically.

## Documentation

- #3292 docs: document OIDC first-user auto-admin behavior — documents that the first user to log in via OIDC is automatically granted admin.

## Maintenance

- Dependency bumps via Dependabot: production dependencies group (7 updates), development dependencies group, `react-router-dom` 7.15.1→7.16.0, `puppeteer` 25.0.4→25.1.0, `concurrently` 9.2.1→10.0.1, `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`, and Rollup linux ARM binaries.

## [4.8.2] - 2026-05-31

# MeshMonitor v4.8.2

Patch release centered on packet observability: a new **Unified Packet Monitor** spanning every source and a dedicated **MeshCore Packet Monitor** with click-to-open packet decoding and hashtag-channel support. Also adds telemetry unit auto-scaling, richer dashboard map popups, and a round of stability and rendering fixes.

## Features

### Packet Monitoring

- #3252 feat(packets): add Unified Packet Monitor across all sources — a cross-source packet monitor that aggregates packet activity from every connected source into one view.
- #3268 feat(meshcore): MeshCore Packet Monitor via LogRxData — opt-in capture of MeshCore OTA packets through the `LogRxData` stream, persisted to `meshcore_packet_log`, with its own monitor view.
- #3273 feat(meshcore): decode packet contents in a click-to-open modal — click any captured MeshCore packet to open a modal that decodes its contents.

### MeshCore

- #3277 feat(meshcore): support hashtag channels — recognize and handle MeshCore hashtag (`#`) channels.
- #3259 feat(meshcore): dashboard neighbor links, saved-password neighbor queries, on-demand remote console — render MeshCore neighbor links on the dashboard, allow neighbor queries using saved passwords, and open the remote console on demand.

### Telemetry

- #3261 feat(telemetry): auto-scale current/power units and humanize uptime — current/power telemetry values auto-scale to appropriate units and uptime is rendered in human-readable form.
- #3262 feat(telemetry): clickable source jump buttons on Unified Telemetry — the source labels at the top of the Unified Telemetry page are now clickable pills that smooth-scroll to their section's card grid. The header bar is sticky so the pills stay reachable while scrolling, and the pill for the section nearest the top is highlighted as the active jump target.
- #3258 Make traceroute history limit configurable — the traceroute history retention limit is now operator-configurable.

### Map

- #3256 feat(dashboard-map): rich node popup with per-source/protocol breakdown — the dashboard map node popup now shows a per-source and per-protocol breakdown.
- #3253 feat(map): add persisted Show Waypoints visibility toggle — the Map Features panel on the dashboard and Nodes maps now has a **Show Waypoints** checkbox that controls waypoint marker visibility. Defaults to on and is persisted per-user via map preferences, alongside the existing Show RF / UDP / MQTT / Traceroute toggles.

## Fixes

- #3270 fix(stability): tear down orphaned transport on reconnect — on reconnect, an orphaned transport left over from a prior session is now torn down rather than leaking.
- #3274 fix(packets): include MeshCore OTA packets in Unified Packet Monitor — MeshCore OTA packets now appear alongside Meshtastic packets in the Unified Packet Monitor.
- #3263 fix(mqtt): stop rxTime=0 from rendering messages at Unix epoch (Dec 1969) — messages with `rxTime=0` no longer render with a December 1969 timestamp.
- #3260 fix(telemetry): convert temperature values, not just unit labels — temperature conversion now converts the underlying value, not only the displayed unit label.
- #3257 fix(map): make RF/UDP/MQTT visibility toggles additive per node — the RF/UDP/MQTT map visibility toggles now combine additively per node instead of overriding one another.
- #3254 fix(meshcore): make all mobile bottom-bar tabs reachable — every MeshCore mobile bottom-bar tab is now reachable.

## Documentation

- #3267 docs(meshtasticd): add physical LoRa hardware compose example — adds a Docker Compose example for physical LoRa hardware with meshtasticd.

## [4.8.1] - 2026-05-28

# MeshMonitor v4.8.1

Patch release combining a **MeshCore automation suite**, an auto-acknowledge automation tier, a connection-stability fix for TCP Meshtastic sources, and a round of security and input-validation hardening from CodeQL.

## Features

### MeshCore Automations

- #3249 feat(meshcore): auto-announce, auto-responder, and timer triggers — three new per-source automations in the MeshCore Automation view:
  - **Auto-Announce** — periodically broadcast a templated status message to selected channels on an interval or cron schedule, with an optional advert burst, live preview, and Send Now.
  - **Auto-Responder** — reply to incoming messages matching an operator-defined regex with a text response or a script, with per-channel/DM filtering and per-sender cooldown.
  - **Timer Triggers** — schedule recurring text/advert/script actions, each on its own cron or interval.
  - Shared token expansion (`{VERSION}`, `{DURATION}`, `{CONTACTCOUNT}`, `{COMPANIONCOUNT}`, `{REPEATERCOUNT}`, `{ROOMCOUNT}`, `{NODE_NAME}`, `{NODE_ID}`) across all three, surfaced in the UI via an inline token legend.
- #3245 feat(meshcore): auto-acknowledge automation with channels, DM, and macros — operator-configurable auto-ACK rules per source with per-channel/DM scope and templated macro responses.

## Fixes

- #3248 fix(stability): guard handleConnected against transport-swap race (#3247) — on TCP Meshtastic sources, `handleConnected` could observe `this.transport` get nulled during its own async setup chain (notifyNodeConnected, channel snapshot), causing `sendWantConfigId` to throw `Transport not initialized`. The catch block then treated that as a transient post-connect reset and tore down the (still-healthy) session, reproducing the same race on the next reconnect — producing a deterministic 3×/min reconnect loop on otherwise-fine TCP sockets. The handler now captures the transport reference at entry and the catch block distinguishes "transport went away mid-handshake" (silent bail) from a genuine transport-layer send failure (existing teardown path).
- #3240 fix: add input validation for MeshCore neighbor publicKey parameters — validate-and-extract pubkey for neighbor endpoints to address CodeQL `js/user-controlled-bypass`.

## Security

- #3246 fix(security): remediate polynomial-ReDoS, log-injection, and regex-DoS CodeQL findings — hardens several user-input code paths against denial-of-service via crafted regular expressions and log-injection patterns surfaced by CodeQL static analysis.

## Other

- #3208 chore(i18n): translations update from Hosted Weblate.

## [4.8.0] - 2026-05-27

# MeshMonitor v4.8.0

Minor release focused on **MeshCore path intelligence and UX refinements**. Adds route visualization on the map, automatic path discovery and neighbor collection from repeaters, @mention highlighting with delivery status indicators, and a fully mobile-responsive MeshCore layout. Also improves MQTT reconnection behavior and fixes room server auto-sync persistence.

## Features

### MeshCore Path Intelligence

- #3231 feat(meshcore): Show Paths map feature with hop-count colored lines — visualize MeshCore contact routes on the map. Lines are colored by hop count (green for direct, orange for 2-3 hops, red for 4+ hops). Toggle paths on/off from the map toolbar.
- #3232 feat(meshcore): add Discover Path button using firmware CMD 52 — manually trigger path discovery to any companion contact. The button appears in the contact-detail panel and sends the MeshCore binary request for route establishment.
- #3234 feat(meshcore): handle path discovery response push (0x8D) — process firmware push responses that return discovered paths. Routes are stored and used for map rendering and the contact-detail panel.
- #3238 feat(meshcore): neighbors support for repeaters with CLI parsing, name resolution, and map rendering — query repeater neighbor tables via the binary protocol, parse structured responses (pubkey prefix, SNR, last-heard), resolve prefixes to full contact names, persist to `meshcore_neighbor_info`, and render neighbor links on the map and in the Map Analysis inspector panel.

### MeshCore Auto-Pathfinding

- #3237 feat(meshcore): add Auto-Pathfinding automation tab — new Automation view for MeshCore sources with configurable periodic path discovery and neighbor collection. Discovers paths to all companion contacts and queries neighbor lists from all repeaters on a configurable schedule (default: every 5 minutes between requests, repeat every 24 hours). Supports independent toggles for path discovery and neighbor collection, with configurable inter-request delay to avoid RF flooding.

### MeshCore UX Improvements

- #3236 feat(meshcore): @mention highlighting and delivery status indicators — messages containing `@YourName` are visually highlighted. Sent DMs now show delivery status (pending / confirmed / failed) with timestamp tooltips.
- #3235 feat(meshcore): add node navigation, clickable names, and search filtering — contact names in messages are clickable and navigate to that contact's DM thread. Added search/filter bar to the Nodes view for quick lookup by name or public key.
- #3230 feat(meshcore): add mobile-responsive layout and collapsible sections — the MeshCore page adapts to mobile viewports with a list/detail toggle pattern, collapsible sections, and touch-friendly controls.

### General

- #3233 feat: add Delete/Purge buttons to map node popup — quickly remove stale nodes directly from the map without navigating to the nodes list.
- #3224 feat: pre-populate radio NodeDB via add_contact before PKI DMs — when sending a PKI-encrypted DM to a node not yet in the radio's NodeDB, MeshMonitor first inserts it via `add_contact` so the radio can encrypt and route correctly.

## Fixes

- #3239 fix(meshcore): load saved room Auto-Sync config and retry room login — room auto-sync checkbox and interval were never loaded from the database. Added GET endpoint and frontend loading. Also added 3-attempt retry with 2s delay to room login for reliability over lossy RF links.
- #3241 fix(mqtt): shared reconnect coordinator to prevent aggregate retry storms — multiple MQTT clients per bridge (subscriber + publisher pool entries) each ran independent backoff timers, producing once-per-second aggregate retries. Added `MqttReconnectCoordinator` that manages a single shared exponential backoff timer (1s to 60s) for all clients targeting the same broker.
- #3223 fix: prevent false circuit-breaker trips when watchdog upgrade succeeds — watchdog upgrade success was incorrectly counted as a failure, triggering the circuit breaker.
- fix: classify neighbor links by transport type and filter by RF/UDP/unknown — neighbor link lines on the map analysis layer now distinguish transport types with appropriate styling.

## [4.7.4] - 2026-05-26

# MeshMonitor v4.7.4

Patch release focused on MeshCore protocol completeness and multi-source improvements. Adds Tier 1 and Tier 2 MeshCore protocol features (contact management, time sync, reboot, key management), room server integration, trace path diagnostics with per-hop SNR, TX power configuration, and cross-source NodeInfo copying. Also fixes MQTT bridge creation without an existing broker and clipboard handling in non-HTTPS contexts.

## Features

- #3218 feat(meshcore): add Tier 1 protocol gap features — contact remove/export/import, repeater neighbour list, device time sync, enhanced stats endpoints, and send-confirmed RTT event. Export produces `meshcore://` URLs; import accepts both raw hex and `meshcore://` URLs via a paste dialog in the Nodes view. Neighbour query uses the binary request protocol for structured data (pubkey prefix, SNR, last-heard). Sync Time button appears next to the RTC drift display in the Info view.
- #3219 feat(meshcore): add Tier 2 protocol features — device reboot (danger-gated), Ed25519 private key backup/restore in the Configuration view's new Device Management section. All operations require confirmation and are audit-logged.
- #3214 feat(meshcore): add room server integration — room server protocol support for MeshCore sources.
- #3212 feat(meshcore): add trace path diagnostic for per-hop SNR measurement — trace path command with structured per-hop signal quality data for MeshCore routes.
- #3210 feat(meshcore): add TX power configuration — TX power level setting for MeshCore devices.
- #3213 #3215 feat(nodes): add Copy NodeInfo from another source — cross-source node information copying with button visibility and API routing fixes.

## Fixes

- #3221 fix(meshcore): add pretty labels for local-node poller telemetry types — display friendly names for MeshCore telemetry types instead of raw identifiers.
- #3220 fix(meshcore): clipboard fallback for non-HTTPS contexts — clipboard operations work correctly when the app is not served over HTTPS.
- #3217 fix(sources): allow MQTT Bridge creation without an existing Broker — removes the requirement for a pre-existing broker when creating an MQTT bridge source.
- #3216 fix(nodes): Copy NodeInfo button visibility and API routing — fixes UI visibility and API endpoint routing for the cross-source NodeInfo copy feature.

## [4.7.1] - 2026-05-25

# MeshMonitor v4.7.1

Patch release. Fixes a per-source dashboard regression where the Channels tab inflated its visible channel list with the global Channel Database (server-side MQTT decryption PSK storage). A meshtastic_tcp source like "Sandbox" — with three real channels configured on the device — was showing ~25 entries because every MQTT-bridge-observed channel name across every other source got merged in.

## Fixes

- #3175 fix(channels): hide global Channel Database entries in per-source view — `ChannelsTab` gains a `sourceId` prop; when set (per-source view via `/source/:id/*`), the global `channel_database` entries are NOT merged into `getAvailableChannels`. The unified / cross-source view keeps merging them as before. The `messages` and `channels` arrays were already source-scoped by the poll endpoint on the server, so no client-side filter is needed for those.


## [4.7.0] - 2026-05-24

# MeshMonitor v4.7.0

Minor release. Headline features are **MeshCore Remote Administration** — a full CLI-over-encrypted-DM admin surface for distant MeshCore nodes plus an in-app console for the locally connected device — and **MQTT bridge topic rewriting**, restored from the (briefly merged + reverted) #3170 with the configuration UI moved to the **broker** edit modal so a single dialog covers every bridge attached to that broker. Also reverts the #3169 / #3170 per-source MQTT dashboard shell that replaced the full v4.6.6 dashboard for broker and bridge sources; those source types fall through to the full Meshtastic dashboard again with all the Channels / Telemetry / DMs / Map surfaces intact.

## Features

### MeshCore Remote Administration

- #3160 feat(meshcore): add remote-administration console with encrypted credentials — new `MeshCoreRemoteConsole` mounted in the contact-detail panel for Repeater / Room Server contacts. Sends CLI commands as encrypted DMs (txt_type=CliData) via meshcore.js, routes replies through a new `cli_reply` bridge event so admin output never lands in the chat log. `loginToNode` populates the remote's ACL; saved passwords are AES-256-GCM-encrypted with an HKDF-derived key from `SESSION_SECRET` and persisted in `meshcore_nodes.adminCredential` (migration 070). A 4-byte `kid` fingerprint on each envelope makes `SESSION_SECRET` rotation detectable and surfaced as a banner instead of a silent auth-tag failure. New `remote_admin` per-source permission resource gates the entire surface.
- #3161 feat(meshcore): stats panel, quick-action buttons, danger-command guard — `MeshCoreRemoteStatsPanel` renders `getStatus` output (uptime, battery, queue, RSSI/SNR, packets RX/TX, air time, errors) with 30 s auto-refresh. Quick-action buttons pre-fill the input for `ver` / `stats` / `neighbors` / `clock` / `clock sync` / `advert` / `reboot`. Destructive commands matching `/(reboot|erase|clkreboot|factory)/i` route through a typed-name confirmation modal client-side AND a `DANGER_CONFIRM_REQUIRED` 400 server-side, enforced on every CLI route.
- #3162 feat(meshcore): local-device CLI console in Configuration view — `MeshCoreLocalConsole` for the physically-connected node. Dispatch is device-type-aware: Repeater / Room Server → forwarded to `sendRepeaterCommand` (native serial CLI); Companion → `runSyntheticLocalCli` interprets `ver` / `stats [core|radio|packets]` / `clock` / `advert` / `help` against existing companion-protocol bridge commands. `CliConsoleBody` extracted as a shared primitive consumed by both consoles.
- #3165 feat(meshcore): ACL setperm form, command history, internal docs — `MeshCoreAclManager` provides a structured `setperm <pubkey> <level>` form (pubkey input + Remove / Guest / ReadWrite / Admin dropdown) mounted alongside the body for Repeater / Room Server targets. `CliConsoleBody` gains ↑/↓ command history (50 entries, de-duped, draft preserved) and a `runCommand` imperative handle so the ACL form shares one transcript with free-typed commands. New `docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md` documents the protocol, credential store design, danger guard, and the local / remote dispatch table.
- #3167 feat(meshcore): persistent transcript + per-command audit log — transcript restored from `sessionStorage` on mount and persisted on every change, keyed by `targetId` (cap 200 entries). Every CLI command + login outcome + credential mutation writes a distinct audit row via a new `auditMeshcoreEvent` helper. Canary test asserts the plaintext password never appears in any audit details across every emission path.

### MQTT topic rewriting (broker-managed)

- #3173 feat(mqtt): bridge topic rewrites managed from broker settings — re-introduces the topic-rewriting feature originally from #3170 (which was reverted in #3172 alongside the #3169 dashboard shell), with the configuration UI moved into the broker's legacy edit modal. Operators see one collapsible panel per bridge attached to that broker; each panel exposes Downlink and Uplink columns with literal `from` → `to` prefix rules. Broker save fires first; per-bridge PUTs follow for any changed bridge config. Backend (`applyTopicRewrite`, publish-path integration, validator) is unchanged from #3170 — see [`docs/features/mqtt-broker.md`](docs/features/mqtt-broker.md#topic-rewriting).

## Fixes

- #3172 revert(mqtt): restore v4.6.6 per-source dashboard for broker and bridge — reverts PR #3169 (per-source detail dashboard shell) and #3170 (bridge topic rewriting, which depended on #3169's UI files). The #3169 shell replaced the full v4.6.6 MQTT dashboard (Channels / Telemetry / DMs / Map) with a thin Map + Settings tab pair, regressing significant functionality. MQTT broker and bridge sources fall through to `App` again as they did in v4.6.6. The topic-rewriting feature is re-introduced in #3173 with the config UI hosted on the broker side.

## Docs

- #3165 docs: new `docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md` covering the protocol surface, credential store / HKDF / kid design, danger guard (client + server enforcement), local-vs-remote dispatch table, `CliConsoleBody` primitive, and an explicit "tempting but not worth doing" section. CLAUDE.md read-order updated to point new agents at it before they touch MeshCore admin code.
- This release: `docs/features/meshcore.md` adds a Remote Administration section covering the remote and local consoles, credential store, and audit log. `docs/features/mqtt-broker.md` updates the topic-rewriting section to reflect the broker-side configuration UI.


## [4.6.5] - 2026-05-22

# MeshMonitor v4.6.5

Patch release adding a **read-only MQTT Bridge dashboard**, a MeshCore telemetry tab in the source-agnostic dashboard, and a handful of cross-source / unified-view fixes. MQTT Bridge sources now have their own "Open" button on the source list and render the full Meshtastic dashboard with every transmit surface suppressed — bridges ingest but never send, so send composers, DM action buttons, Device Configuration, Remote Administration, and Automation tabs are all hidden. Server-side, `MqttBridgeManager` now implements the Meshtastic-shaped methods the consolidated `/api/poll` and `/api/connection` endpoints call through `resolveSourceManager` — without those, the bridge dashboard 500'd before any data could render. Standalone `mqtt_bridge` sources are also now valid targets for the meshtastic_tcp client-proxy `mqttLink`.

## Features
- #3143 feat(mqtt-bridge): mirror dashboard for MQTT Bridge sources — adds an Open button to `mqtt_bridge` cards and routes to a read-only mirror of the Meshtastic dashboard. Suppresses every TX surface: send composers (Channels + DM), the four top DM action buttons (Traceroute / Exchange Node Info / Exchange Position / Request Neighbor Info), the matching DM Actions dropdown entries (Traceroute / Exchange / Request Telemetry / Scan for Admin), and the Device Config / Remote Admin / Automation sidebar tabs. The Channels picker also relaxes the per-channel permission filter for bridge mode since bridges routinely see channel slots outside `0-7` from upstream nodes with custom configs, and the "Show MQTT messages" toggle is hidden because every bridge packet has `viaMqtt=true` and the filter would always blank the list.
- #3142 feat(meshcore): add Telemetry dashboard tab via source-agnostic Dashboard (#3139)
- #3136 feat(mqtt): allow standalone mqtt_bridge as client-proxy target (#3134) — a `meshtastic_tcp` source's `mqttLink` configuration now accepts either an `mqtt_broker` or a standalone `mqtt_bridge` source as its parent.

## Fixes
- #3143 fix(mqtt-bridge): wire `MqttBridgeManager` into the consolidated poll path — adds `getConnectionStatus`, `getAllNodesAsync`, `getDeviceConfig`, `getDeviceNodeNums`, and `getSecurityKeys` so `/api/poll?sourceId=<bridge>` and `/api/connection?sourceId=<bridge>` stop throwing `TypeError: ... is not a function`. `mapDbNodeToDeviceInfo` and `loadAllNodesAsDeviceInfo` extracted to `src/server/utils/dbNodeMapper.ts` so both managers share the projection.
- #3143 fix(mqtt-bridge): suppress env-default Meshtastic IP leaking into the AppHeader node-info slot when the bridge has no local device.
- #3141 fix(meshcore): preserve LPP channel byte in remote telemetry rows (#3139)
- #3140 fix(dm): skip PKI flag when `keyMismatchDetected` — firmware may lack the key after a purge, so flagging would mark legitimate sessions as compromised.
- #3137 fix(unified): merge nodes across sources so labels show in the unified Nodes view (#3135) — since the composite-keyed `nodes` table holds one row per `(nodeNum, sourceId)`, a node heard on both an RF source (with NodeInfo) and an MQTT-bridged source (with only a transit packet, so `longName/shortName = null`) appeared in the unified view twice — once labeled, once as `Node <nodeNum>`. `getAllNodesAsync` now collapses per-source rows into one entry per `nodeNum` when no `sourceId` is supplied: the newest row by `lastHeard` wins, empty fields are back-filled from older rows, and `isFavorite`/`isIgnored`/`favoriteLocked` are OR'd across sources.

## Docs
- #3138 docs: reorganize site for easier discovery; remove dead links


## [4.6.3] - 2026-05-20

# MeshMonitor v4.6.3

Patch release focused on **MQTT-source permissions and map visibility**. The MQTT ingest path now stamps `node.channel` with the channel-database-encoded virtual channel id so the map filter can honor Virtual Channel Permissions, MeshCore contacts are persisted to the DB so the remote-telemetry scheduler can correctly classify repeater targets, unified messages keep tapback metadata across multi-source merges, the Users tab admin UI for MQTT sources is readable in both themes, and traceroute / neighbor-info endpoints are now channel-gated so non-admins can no longer see line segments rendered between coordinates of nodes they have no permission to view.

## Features
- #3108 feat(mqtt): route MQTT channel permissions through `channel_database` — bootstraps a passive `channel_database` row for every observed MQTT channel name, encodes `message.channel` and `traceroute.channel` as `CHANNEL_DB_OFFSET + dbId`, and routes the Users-tab admin UI to manage MQTT-source access via Virtual Channel Permissions instead of the slot-indexed `channel_0..7` grants (which collide across senders on a shared broker).

## Fixes
- #3105 fix(unified): preserve tapback metadata across MQTT ingest + cross-source merge — captures `emoji` and `replyId` on MQTT TEXT_MESSAGE_APP ingest, surfaces them from `channelDecryptionService`, and upgrades the unified-merge to prefer non-null values from any source so reactions stop flickering between rendering as emoji pills and as inline messages.
- #3107 fix(meshcore): persist contact advType to `meshcore_nodes` — the in-memory contact map was correct but never mirrored to SQL, so the remote-telemetry scheduler always read `advType=NULL` and routed every target through the legacy LPP-only path. Fixes #3092 for users with repeaters that don't anonymously answer LPP requests.
- #3109 fix(users): use Catppuccin variables for the MQTT permissions hint banner so it's readable in both light and dark themes.
- #3110 fix(mqtt): stamp `node.channel` on ingest, and channel-gate the traceroute and neighbor-info endpoints. Without the first half, the map filter fell back to `permissions[channel_0]` — a slot the #3108 UI hides for MQTT scopes — so non-admins couldn't see MQTT nodes regardless of what was granted. Without the second half, traceroute `routePositions` and neighbor-info enriched positions leaked enough coordinates for the frontend to render "floating lines" between hidden nodes.

## Docs
- #3106 docs(claude): drop the worktree restriction from CLAUDE.md.


## [4.6.2-1] - 2026-05-19

# MeshMonitor v4.6.2-1

Hotfix re-publishing the v4.6.2 multi-arch Docker manifest. The v4.6.2 build pipeline succeeded for `linux/amd64` and `linux/arm64` but failed on `linux/arm/v7` because `puppeteer@25.0.2` (bumped in #3071) attempts to download a Chrome browser binary during npm postinstall and Chrome has no armv7 build. No application-code changes.

## Fixes
- **Dockerfile.armv7**: set `PUPPETEER_SKIP_DOWNLOAD=true` before `npm install` so the postinstall doesn't try to fetch a non-existent armv7 Chrome binary. Puppeteer is a devDep used only in CI tests; runtime armv7 images don't need it.


## [4.6.2] - 2026-05-19

# MeshMonitor v4.6.2

Patch release focused on **MQTT ingest completeness** and channel-name UX. MQTT bridges and brokers now ingest the full set of Meshtastic portnums (text, telemetry, position, nodeinfo, traceroute, neighbor info, paxcounter, store-and-forward) with proper per-source attribution and server-side channel decryption — receptions of the same mesh packet on TCP and MQTT now dedup into a single Unified Messages entry with all sources listed. Empty-named slot 0 on a source now displays as the modem preset's firmware label (`MediumFast`, `LongFast`, etc.) instead of the synthetic `"Primary"`, matching what MQTT gateways publish under and collapsing the TCP and MQTT views of the same channel into one picker entry. The Channel Database is now genuinely global (PSKs apply to decryption across all sources), with the dead `sourceId` column dropped and the management UI moved from the per-source Channels tab to Global Settings. A Meshcore repeater-telemetry regression was fixed via `SendStatusReq` + guest-login fallback. The Desktop first-run flow no longer requires a Meshtastic IP.

## Features
- #3089 feat(mqtt): full source-scoped ingest with channel decryption and unified-view fixes — auto-bootstraps the LongFast PSK into `channel_database`, decrypts encrypted packets server-side, adds TRACEROUTE_APP / NEIGHBORINFO_APP / PAXCOUNTER_APP / STORE_FORWARD_APP handlers, pre-seeds the geo-membership cache with trusted local-mesh nodes and in-bbox positions, fixes telemetry source attribution in `/api/unified/telemetry`, and aligns MQTT message row IDs with the TCP convention so cross-source dedup collapses TCP + MQTT receptions of the same packet into one Unified Messages entry.
- #3093 feat(channels): apply modem-preset display name to per-source channels view — `transformChannel` now emits a `displayName` field that uses the source's persisted `lora.preset` for empty-name slot 0 (firmware-spec label `MediumFast` / `LongFast` / etc.), falling back to `"Primary"` only when no preset is known. Channels tab + Source Channels view now show the same label MQTT gateways publish under.
- #3088 feat(desktop): remove Meshtastic IP requirement from first-run setup

## Fixes
- #3086 fix: clear recovery message on SQLITE_CORRUPT migration failure
- #3094 fix(meshcore): repeater telemetry via SendStatusReq + guest-login fallback

## Refactors
- #3091 refactor(channel-db): drop dead sourceId column (migration 063) and move UI to Global Settings — channel_database PSKs were already global (decryption tries every enabled row regardless of source), so the per-row sourceId was misleading dead weight. Drops the column, removes the Channels-tab UI entry point, and surfaces management under Global Settings.

## Dependencies
- #3069 chore(deps): bump lucide-react from 1.14.0 to 1.16.0
- #3070 chore(deps): bump protobufjs from 8.2.0 to 8.3.0
- #3072 chore(deps): bump better-sqlite3 from 12.9.0 to 12.10.0
- #3071 chore(deps-dev): bump puppeteer from 24.43.0 to 25.0.2

## Docs
- #3090 docs: refresh CLAUDE.md, README, CHANGELOG for 4.6.1 accuracy


## [4.6.1] - 2026-05-18

# MeshMonitor v4.6.1

Patch release focused on Meshcore protocol stability, MQTT source resilience, and test infrastructure. The Meshcore integration gained telemetry graphs in the DM contact-detail pane, correct DeviceInfo decoding for nodes that pack a NUL-separated remainder, and a layout fix so MeshCorePage fills the dashboard shell. On the MQTT side, the source editor now preserves saved passwords when the field is left blank, broker ACL restrictions are detected and surfaced to the user, and mqtt_bridge sources gained a Prune Outside ROI maintenance action. The hardware system-test suite was stabilized and moved to a manually-triggered (`system-test` label or `workflow_dispatch`) workflow after the Test 14 HTTP 500 flake was root-caused to TCP-1-client firmware session takeover, not a code regression. Dependency groups were bumped in lockstep.

## Features
- #3077 feat(meshcore): render telemetry graphs in DM contact-detail pane
- #3078 feat(mqtt): detect broker ACL restrictions and surface to user
- #3079 feat(sources): add Prune Outside ROI action for mqtt_bridge sources

## Bug Fixes
- #3076 fix(mqtt-source): preserve saved password on edit when field is blank
- #3080 fix(meshcore): make MeshCorePage fill the dashboard shell height
- #3081 fix(meshcore): split NUL-separated DeviceInfo remainder for Info panel

## Testing & CI
- #3082 test(system): stabilize hardware test suite and make it manually-triggered

## Dependencies
- #3068 chore(deps): bump the production-dependencies group with 13 updates
- #3067 chore(deps-dev): bump the development-dependencies group with 3 updates
- #3073 chore(deps-dev): bump tsx from 4.21.0 to 4.22.1
- #3075 chore(deps-dev): bump the development-dependencies group across 1 directory with 2 updates

## Release
- #3083 chore(release): bump version to 4.6.1

## Issues Resolved
- #3046 [SUPPORT] meshmonitor.org: creating an Embed Profile not consistent with the latest version
- #3003 Feature: Built-in MQTT broker/proxy with topic and geographic filtering
- #2804 [BUG] 4.0.0-beta1 — node seen on traceroute but not in list
- #2582 [FEAT] Support for multiple MQTT Upstream Brokers

## Upgrade Notes
No breaking changes. Standard patch upgrade — pull the new image / chart and restart.

**Full Changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.6.0...v4.6.1

## [4.6.0] - 2026-05-18

# MeshMonitor v4.6.0

## Summary

MeshMonitor 4.6 introduces the **embedded MQTT broker** — a built-in MQTT server that bridges packets bidirectionally between Meshtastic sources, with optional geographic bounding-box filtering for incoming MQTT traffic. The bridge gains an interactive map editor for drawing the bbox visually and a smart initial-bbox heuristic that seeds the filter from your already-detected node positions. The MeshCore stack closes several gaps: channel and DM messages now persist to the database (so history survives restarts), the TCP-transport default port is fixed, and the channels view picks up a CRUD UI for create/edit/delete. The Meshtastic neighbor-info display is fixed for multi-source deployments — the frontend now correctly scopes the fetch to the active source, and the backend defensively refreshes `lastHeard` on `MyNodeInfo` and `configComplete` so the freshness filter doesn't drop entries from the local node mid-session. MeshCore radio parameters are no longer corrupted on save: the native backend now correctly scales between UI MHz/kHz and the wire-format kHz/Hz integers the meshcore.js library expects. Desktop bundle improvements: fresh installs no longer auto-create a phantom Meshtastic source against the old `192.168.1.100` placeholder when only MeshCore companions are configured, and MeshCore connect errors now surface a real diagnostic instead of `undefined`. The auto-upgrade watchdog health-check timeout grows from 120s to 600s (configurable via env var) so larger DBs on ARM-class hardware don't flap during boot. The API gains a server-side fix for duplicate packets reported by multi-source consumers. CI now fails fast on the first failing system test, and a `MESHTASTIC_NODE_PORT` synonym is now honoured on fresh installs alongside `MESHTASTIC_TCP_PORT`.

## Features

- **Embedded MQTT broker + bidirectional bridges** — #3053
- **MQTT bridge: `mqttClientProxyMessage` to the embedded broker** — #3054 (follow-up to #3003)
- **MQTT bridge: interactive map editor for the filter geographic bounding box** — #3064
- **MQTT bridge: seed bbox from detected node positions on first enable** — #3066

## Bug Fixes

- **Neighbor info missing in UI:** scope the frontend fetch to the current source + defensively refresh local-node `lastHeard` on `MyNodeInfo` / `configComplete` — #3049 (fixes #3025)
- **MeshCore radio parameters can't be saved:** scale between UI MHz/kHz and wire-format kHz/Hz integers in the native backend — #3050 (fixes #3048)
- **API: duplicate packets** in `/api/packet-logs` for multi-source deployments — #3052 (fixes #3051)
- **MeshCore:** persist channel + DM messages to the DB; fix TCP-transport default port — #3058 (fixes #3057)
- **Auto-upgrade watchdog:** raise health-check timeout to 600s and make it configurable via env var — #3056 (fixes #3055)
- **MESHTASTIC_NODE_PORT env var** not respected on fresh installs — #3062 (fixes #3061)
- **Desktop:** stop creating a phantom Meshtastic source on MeshCore-only installs; surface a real MeshCore connect error instead of `undefined` — #3065
- **UI:** drop the "(USB)" suffix from the MeshCore source-type label — #3043

## CI / DevOps

- **System tests:** fail-fast on first failing test, drop retry attempt — #3060

## Docs

- **Embedded MQTT broker** — configurator option, feature documentation, blog post — #3063

## Issues Resolved

- #2600 — [FEAT] More Meshcore support
- #3025 — [BUG] Meshtastic NeighborInfo: response received but not shown in UI
- #3048 — [BUG] Meshcore shows wrong radio parameters and can't be updated
- #3051 — [BUG] API: duplicate packets
- #3055 — Auto-upgrade watchdog 120s health-check timeout too short for large-DB instances on slow ARM hardware
- #3057 — [MeshCore] MeshCore, channels and persistence
- #3061 — [BUG] `MESHTASTIC_NODE_PORT` not respected

## Upgrade Notes

**Desktop bundle behaviour change (#3065).** Fresh installs that don't set `MESHTASTIC_NODE_IP` in the environment now create the auto-default Meshtastic source as **`enabled=0`** instead of `enabled=1`. Users upgrading from 4.5.x desktop builds keep their existing sources as-is, but a fresh install / fresh DB will require explicitly enabling the Meshtastic source via the **Sources** page. Docker users who set `MESHTASTIC_NODE_IP` themselves are unaffected.

**Embedded MQTT broker (#3053)** is opt-in. Existing installs without an MQTT broker source configured see no behaviour change.

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.5.2...v4.6.0


## [4.5.2] - 2026-05-16

# MeshMonitor v4.5.2 — MeshCore Channel Support

A focused follow-up to **v4.5.1 — MeshCore TCP Support** that closes the last big gap in the MeshCore subsystem: **end-to-end channel management** from the MeshMonitor UI. Connect a MeshCore Companion and MeshMonitor now reads the device's channel list on connect, displays each channel as its own tab in the MeshCore page with the sent/received messages segregated correctly, and exposes a per-source Configuration UI to add, rename, regenerate the AES-128 secret of, or delete channels — every write goes to the device first and the local mirror is reconciled afterwards. The new send path is channel-idx aware so a message typed in any tab actually reaches that channel instead of falling back to slot 0. Several rough edges from initial real-hardware testing are also smoothed over: the firmware's MAX_CHANNELS placeholders (typically 40 on Companion builds) are filtered out so you only see configured slots, stale empty rows from earlier syncs are auto-cleaned, the DM-view sidebar excludes the channel pseudo-pubkeys and the local node, and the route layer now talks to the correct MeshCore manager registry instead of silently falling back to the Meshtastic singleton. On the Meshtastic side, a long-standing map issue is fixed: per-node position-accuracy boxes now reflect each sending node's own `precision_bits` instead of the local node's channel setting. The release also flips the changelog links to open in a new tab so a context-switch doesn't blow away the page.

## ✨ Features

- [#3034](https://github.com/Yeraze/meshmonitor/pull/3034) — **MeshCore channel CRUD + connect-time sync (phase 1/3)**. `MeshCoreManager` exposes `listChannels` / `setChannel` / `deleteChannel` and mirrors the device's channel list into the shared `channels` table on every connect. AES-128 secrets are stored base64-encoded in the existing `psk` column; `cleanupInvalidChannels` is source-type-aware so MeshCore's higher channel indices survive cleanup.
- [#3038](https://github.com/Yeraze/meshmonitor/pull/3038) — **Display device channels in MeshCoreChannelsView (phase 2/3)**. The hardcoded single "Public" entry is replaced by one tab per device-reported channel. Per-channel filter handles both received and locally-sent messages; the manager's `sendMessage` and the `/api/meshcore/messages/send` route both grew an optional `channelIdx` so non-channel-0 sends actually go to the right channel.
- [#3039](https://github.com/Yeraze/meshmonitor/pull/3039) — **Channel create / edit / delete UI (phase 3/3)**. New `MeshCoreChannelsConfigSection` mounted inside `MeshCoreConfigurationView`. Add channel (auto-assigns the lowest free idx, seeds a 16-byte random secret via `crypto.getRandomValues`), edit, regenerate-secret, and delete. Secret displayed as hex with masked-by-default show/copy toggles. Backend `PUT/DELETE /api/channels/:id` routes are source-type-aware — MeshCore drops the 0-7 cap, widens name to 31 bytes, and routes the write through the manager.

## 🐛 Bug Fixes

- [#3033](https://github.com/Yeraze/meshmonitor/pull/3033) — **Per-node position precision boxes**. Map accuracy boxes now use each sending node's own `precision_bits` instead of the local MeshMonitor node's channel setting. Removed the local-channel fallback in both the Position and NodeInfo handlers, plus the "smart upgrade/downgrade" logic that was holding onto a stored higher precision for up to 12 hours and refusing legitimate downgrades. Closes [#3030](https://github.com/Yeraze/meshmonitor/issues/3030).
- [#3040](https://github.com/Yeraze/meshmonitor/pull/3040) — **MeshCore channels post-deploy polish**. Filters out empty slots so the firmware's MAX_CHANNELS (typically 40 on Companion builds) doesn't leak placeholder rows into the UI; the next sync after upgrade auto-cleans existing leaked rows from the DB. Fixes the route layer to pull the MeshCore manager from the correct `meshcoreManagerRegistry` instead of the Meshtastic fallback (was producing `mcManager.setChannel is not a function`). DM-view sidebar now filters out the `channel-N` synthetic pubkeys and the locally-connected node.

## 🪟 UX

- [#3037](https://github.com/Yeraze/meshmonitor/pull/3037) — **Changelog links open in a new tab** so clicking through doesn't unload the page. Closes [#3035](https://github.com/Yeraze/meshmonitor/issues/3035).

## ⬆️ Upgrade Notes

- **No migrations.** The MeshCore channels feature reuses the existing `channels` table — Meshtastic-only columns (`role`, `uplinkEnabled`, `downlinkEnabled`, `positionPrecision`) stay null for MeshCore rows.
- **Existing MeshCore installs:** after upgrade, the next connect-time sync will run the new reconcile pass and automatically remove the 38-or-so empty placeholder rows that older builds wrote to the `channels` table. No manual cleanup needed.
- **Position accuracy boxes** will start reflecting each remote node's actual `precision_bits`. If you had previously seen all boxes mirror your local node's setting, that was the old smart upgrade/downgrade behavior holding stale precision; the new packets will repopulate within minutes.
- **API change (additive):** `PUT/DELETE /api/channels/:id` accept higher channel IDs (>7) when the target source is MeshCore. The Meshtastic 0-7 cap is unchanged.

## Issues Resolved

- [#3030](https://github.com/Yeraze/meshmonitor/issues/3030) — Position accuracy boxes wrong size
- [#3035](https://github.com/Yeraze/meshmonitor/issues/3035) — Open changelog links in new tab

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.5.1...v4.5.2

## [4.5.1] - 2026-05-15

# MeshMonitor v4.5.1 — MeshCore TCP Support

A focused follow-up to **v4.5.0 — MeshCore Levels Up**, closing the last two big gaps called out in the 4.5 announcement: **TCP transport for MeshCore Companions from the UI**, and a **native JavaScript MeshCore backend** that replaces the Python bridge entirely. TCP-attached Companions (esp-link, ser2net, or native TCP firmware) are now added through the same Sources sidebar flow as everything else — no env-var bootstrap, no container restart. The new in-process [`meshcore.js`](https://github.com/Yeraze/meshcore.js) integration removes the Python sidecar from the container, cutting startup time, memory footprint, and a whole class of cross-process serialization bugs. Two small bugs from 4.5 are also fixed: a MeshCore TCP source that wouldn't appear in the source list and a Meshtastic NeighborInfo link that disappeared when the neighbor row had a NULL `lastHeard` despite a fresh NI report.

## ✨ Features

- [#3027](https://github.com/Yeraze/meshmonitor/pull/3027) — **MeshCore TCP transport from the UI**. The Sources sidebar now offers USB **and** TCP for MeshCore Companions (default port `4403`); works with esp-link, ser2net, or any native TCP-capable MeshCore firmware. Closes [#3028](https://github.com/Yeraze/meshmonitor/issues/3028).
- [#3029](https://github.com/Yeraze/meshmonitor/pull/3029) — **Native JavaScript MeshCore backend**. Initial port of the MeshCore protocol layer onto [`meshcore.js`](https://github.com/Yeraze/meshcore.js), running in-process inside the Node server.
- [#3031](https://github.com/Yeraze/meshmonitor/pull/3031) — **Python bridge and 3.x addon removed**. The native JS backend is now the only path; the Python sidecar process, its requirements, and the legacy 3.x firmware addon are gone.

## 🐛 Bug Fixes

- [#3026](https://github.com/Yeraze/meshmonitor/pull/3026) — **NeighborInfo links survive NULL `lastHeard`**. When a neighbor row has no `lastHeard` but the NeighborInfo report itself is fresh, the link is now kept in the topology view instead of being filtered out. Closes [#3025](https://github.com/Yeraze/meshmonitor/issues/3025).

## 📝 Documentation

- [#3032](https://github.com/Yeraze/meshmonitor/pull/3032) — **MeshCore TCP transport documentation** added to the [MeshCore feature page](https://meshmonitor.org/features/meshcore#tcp-transport), covering host/port form fields, common deployment patterns (native TCP firmware / `ser2net` / `esp-link`), container-networking guidance, and updated USB-vs-TCP troubleshooting.

## 🧹 Architecture

The MeshCore subsystem is now considerably simpler:

- **One process** — the entire MeshCore stack (companion protocol, channel/contact state, telemetry collection) runs inside the Node server. No more Python sidecar to coordinate with, no more cross-process JSON shuttling.
- **Two transports for Companions** — USB serial and TCP, both wired through the same per-source manager registry that handles Meshtastic sources. Hot connect/disconnect, source create/update/delete, no container restart for any of it.
- **Repeater path unchanged** — Repeater is still USB-only and still uses the direct-serial text CLI path.

## ⬆️ Upgrade Notes

- **No migrations.** Database schema is unchanged from 4.5.0.
- **Python is no longer required.** If you maintain a custom image or compose override that mounted Python deps for the MeshCore bridge, you can drop them.
- **MeshCore env-var bootstrap stays removed.** The `MESHCORE_*` env vars that 3.x used were already gone in 4.5.0; configure MeshCore sources from the Sources sidebar.

## Issues Resolved

- [#3028](https://github.com/Yeraze/meshmonitor/issues/3028) — TCP/WiFi MeshCore source not showing in source list
- [#3025](https://github.com/Yeraze/meshmonitor/issues/3025) — Meshtastic NeighborInfo response received but not shown in UI

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.5.0...v4.5.1

## [4.5.0] - 2026-05-15

MeshCore graduates from "experimental tab" to **first-class source** in MeshMonitor. It sits in the dashboard sidebar next to your Meshtastic nodes, has its own per-source permissions, its own multi-pane page, its own telemetry pipeline, and contributes contacts to the unified dashboard map. The 4.5 UI source-add flow is **USB-only** for MeshCore (Companion or Repeater); TCP-connected companions still work via the legacy env-var bootstrap path.

## Source model

- **Per-source MeshCore managers** — each MeshCore device is its own source row, manageable from the Sources sidebar with no container restart (#3005, #3014)
- **Permissions, expanded** — the legacy global ` + "`meshcore`" + ` permission is gone; migration 058 expanded every grant into the per-source **sourcey** set (connection, configuration, nodes, messages)
- **Composite primary key** on ` + "`meshcore_nodes`" + ` (sourceId, publicKey) — same device under two sources is tracked independently (#3023)

## Dashboard + map

- **Styled source cards** matching the Meshtastic visual vocabulary (#3016)
- **Unified dashboard map** enumerates every MeshCore source and renders contacts with valid coordinates (#3015)

## MeshCore page

- **Multi-pane redesign** — Nodes / Channels / Direct Messages / Configuration / Node Info (#3005)
- **Contact-detail panel** below each DM thread — hops, RSSI/SNR, last heard, position, full public key (#3017)
- **UI permission gating** — write controls dim and explain themselves for read-only users (#3019)
- **Visual alignment** with Meshtastic Info / Channels / Nodes rows (#3021)

## Telemetry

- **Local-node telemetry** — background poller samples ` + "`GetStats core/radio/packets`" + `, ` + "`GetDeviceTime`" + `, ` + "`DeviceQuery`" + ` every 5 minutes (configurable, on-device, no RF) writing batched ` + "`mc_*`" + ` rows into the shared telemetry table (#3020)
- **Node Info page** graphing across 1h / 6h / 24h / 3d / 7d ranges
- **Telemetry-mode toggles** — device-side base / loc / env classes from the Configuration view (#3018)
- **Per-node remote telemetry retrieval** — scheduled ` + "`req_telemetry_sync`" + ` pulls with a per-node interval, gated by a shared 60-second cross-mesh throttle, with decoded LPP values written into the telemetry store (#3022)

## Configuration

- **Radio preset selector** from the official MeshCore preset list, with a Custom fallback (#3015)
- **Persistent radio params** — bridge propagates device-side errors instead of silently returning success
- **Staged edits no longer revert** during live push updates
- **Location configuration** + advert-location policy
- **Channel-message senders** extracted from the ` + "`\"Name: body\"`" + ` prefix and shown separately

## Still Early

MeshCore in MeshMonitor remains **new and basic**. Known gaps:

- **Repeater / Room Server parity** trails Companion — local-telemetry poller, remote-telemetry scheduler, and telemetry-mode toggles all need a Companion on the source side
- **TCP MeshCore via the UI** isn't shipped — TCP companions are env-var bootstrap only in 4.5
- **No MeshCore remote-admin** equivalent
- **No scheduler integrations** for auto-responder / auto-announce / auto-traceroute (primitives wired, user-facing features next)
- **Minimal MeshCore notifications** — apprise and push aren't first-class
- **No MeshCore-specific map affordances** yet
- **MQTT source type** still planned

The plan is incremental — one or two MeshCore features per release, keep aligning the UI vocabulary with Meshtastic, gradually close the parity gap.

---

📖 [Updated MeshCore docs](https://meshmonitor.org/features/meshcore) · 📝 [Full 4.5 blog post](https://meshmonitor.org/blog/2026-05-14-meshcore-4-5)

## [4.3.2] - 2026-05-12

Patch release rolling up fixes landed since 4.3.1.

## Fixes
- #3001 fix(firmware): keep uploadPhase on error so half-flash detection works (no more false-positive half-flash markers from commit-OK ECONNRESET)
- #2998 chore: remove legacy /api/nodes/security-issues endpoint
- #2997 fix(sourcey): scope purgeAllNodes / purgeAllTelemetry by sourceId
- #2992 feat(embed): add showTraceroutes toggle to embed profiles
- #2981 fix(firmware): scope OTA gateway IP to the active source
- #2989 fix(sourcey): scope telemetry types and localNodeNum by sourceId
- #2986 fix(auth): mount optionalAuth() in front of permission-gated router
- #2983 fix(security): allowlist tables and validate column names in SQLite
- #2982 fix: replace hasPermission non-null assertions with null-safe guards
- #2980 fix(security): gate legacy /api/nodes/security-issues with security:read
- #2978 fix(security): block message search when user has zero channel permissions
- #2977 fix(security): gate /api/traceroutes/history with traceroute:read
- #2976 fix(lxc): align LXC template Node version with runtime
- #2975 refactor(audit): gate cleanup with requireAdmin instead of redundant checks

## Refactors / Internals
- refactor(sourcey): extract resolveSourceManager helper, retire 65 inline lookups
- refactor(backup): unify SQLite path with Drizzle misc repository
- chore(eslint): close `const db = …; db.prepare()` escape hatch in no-raw-sql

## Docs / i18n
- #2979 docs: add MeshMonitor Chat for iOS to Third-Party Clients
- #2874 Translations update from Hosted Weblate
- i18n: add `source.status_disconnected` key across locales

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v4.3.1...v4.3.2


## [4.3.1] - 2026-05-11

Patch release rolling up fixes and small features landed since 4.3.0.

## Features
- #2974 feat(waypoints): scheduled rebroadcast with global airtime floor
- #2960 feat(dashboard): "More..." entry in Add Widget menu with telemetry help

## Fixes
- fix(firmware): harden OTA update — timeouts, cancel guard, async orchestration, retry widening, half-flash detection (073oa8b2)
- #2956 fix: don't record 0-hop telemetry when hop_start is unset
- #2953 fix(channels): expose PSK to authorized writers so config UI works

## Dependencies
- protobufjs 8.0.3 → 8.2.0 (#2968)
- archiver 7.0.1 → 8.0.0 (#2964)
- react-router-dom 7.14.2 → 7.15.0 (#2967)
- i18next-http-backend 3.0.6 → 4.0.0 (#2970)
- vite-plugin-pwa 1.2.0 → 1.3.0 (#2969)
- puppeteer 24.42.0 → 24.43.0 (#2965)
- @eslint/compat 2.0.5 → 2.1.0 (#2966)
- production-dependencies group, 7 updates (#2963)
- @types/node (#2961)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v4.3.0...v4.3.1

## [4.3.0] - 2026-05-10

# MeshMonitor v4.3.0 — Waypoints

This minor release introduces **Waypoints** as a first-class data type alongside nodes, messages, and telemetry. MeshMonitor now stores every WAYPOINT_APP packet per source, renders them on both the per-source dashboard map and Map Analysis using each waypoint's emoji as its icon, and lets users with the new `waypoints:write` permission create, edit, and delete waypoints in place from the Map Features panel — broadcasting the result back to the mesh. A daily maintenance sweep handles expiry (with `expire_at = 0` correctly treated as "no expiration"), and the existing source-scoped WebSocket fan-out delivers `waypoint:upserted` / `:deleted` / `:expired` events in real time. Migrations 053–055 add the per-source `waypoints` table and seed the new `waypoints:read|write` permissions for every user that already had matching `messages` grants. Beyond Waypoints, the release adds Tile Selection / Legend visibility toggles to the Map Features panel, fixes a dashboard bug where the active tileset wasn't applied on load, corrects the channel encryption label for unencrypted and shorthand PSKs, irons out several mobile-browser interface issues, and bootstraps the very first OIDC user as an admin so SSO-only deployments can complete onboarding.

## ✨ Features

- **Waypoints — basic support** ([#2936](https://github.com/Yeraze/meshmonitor/issues/2936) / [#2938](https://github.com/Yeraze/meshmonitor/pull/2938)) — per-source `waypoints` table (migration 053), `WAYPOINT_APP` dispatch + broadcast/delete-tombstone helpers, `/api/sources/:id/waypoints` (GET/POST/PATCH/DELETE) gated by new `waypoints:read|write` permission, `useWaypoints` hook with WS-cache invalidation, `WaypointsLayer` for Map Analysis, daily expire sweep with grace window. Permission seeding via migrations 054/055 clones each user's per-source `messages` grants.
- **Waypoints — authoring UI** ([#2942](https://github.com/Yeraze/meshmonitor/pull/2942)) — in-place create/edit/delete on the per-source dashboard map. Map-click and right-click placement modes (crosshair cursor, ESC to cancel), emoji icon picker with VS-16 forcing, optional expiry, lock-to-self checkbox; popup actions (Edit / Delete) gated by `canEdit` / `canDelete` and suppressed for waypoints locked to other nodes. Create button lives inside the Map Features dropdown.
- **Map Features: Tile Selection + Legend visibility toggles** ([#2945](https://github.com/Yeraze/meshmonitor/pull/2945)) — adds two toggles to the Map Features panel that hide the bottom-center tileset picker and the SNR legend, persisted per-user.

## 🐛 Bug Fixes

- **fix:** map tileset selection not applying on dashboard ([#2948](https://github.com/Yeraze/meshmonitor/pull/2948))
- **fix(mobile):** mobile browser interface fixes ([#2946](https://github.com/Yeraze/meshmonitor/pull/2946) / [#2940](https://github.com/Yeraze/meshmonitor/issues/2940))
- **fix:** correct channel encryption label for unencrypted and shorthand PSKs ([#2944](https://github.com/Yeraze/meshmonitor/pull/2944) / [#2939](https://github.com/Yeraze/meshmonitor/issues/2939))
- **fix(auth):** bootstrap first OIDC user as admin ([#2937](https://github.com/Yeraze/meshmonitor/pull/2937) / [#2749](https://github.com/Yeraze/meshmonitor/issues/2749))

## 📚 Documentation

- New **Waypoints** feature page in the docs site, plus a Waypoints sub-section in the Maps overview. Version-Highlights nav sections were retired and their pages folded into the regular Features sidebar.
- **docs:** add Canadaverse Mesh to the Site Gallery ([#2943](https://github.com/Yeraze/meshmonitor/pull/2943))

## ⚙️ Release

- **chore(release):** bump version to 4.3.0 ([#2949](https://github.com/Yeraze/meshmonitor/pull/2949))

## ⚠️ Known follow-ups

- Waypoint **rebroadcast scheduler** is not yet wired. The `rebroadcast_interval_s` column is persisted and accepted by the API, but no timer fires it — owned waypoints are broadcast once on save. Tracked under [#2936](https://github.com/Yeraze/meshmonitor/issues/2936).
- **Automation hooks** for the waypoint message type are not yet available — Auto-Responders and Geofence Triggers do not currently match on waypoint events.

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.2.3...v4.3.0


## [4.2.3] - 2026-05-08

# MeshMonitor v4.2.3

A maintenance release focused on the messages experience and the multi-source traceroute view.

## Summary

This release fixes three message-system bugs that surfaced together on multi-source SQLite deployments: infinite scrollback on a freshly-loaded channel didn't fire on the first scroll, unread counts leaked across sources so badges stayed lit for messages the active source couldn't display, and SQLite's mark-as-read silently no-op'd when a stale read row from an earlier session blocked the insert. A traceroute coloring bug (#2931) where a single UDP/MQTT bridge node forced the entire route to render as dashed IP is fixed; only the actual IP hops are now styled that way. The auto-responder no longer triple-sends when the target's ACK arrives late, and the notification chime no longer fires on incoming traceroute responses cached in the WebSocket buffer. Desktop builds now resolve the script interpreter from PATH so Tauri-launched bash scripts work on machines without `/bin/bash`. Internally, the Claude-agent documentation under `.claude/` and `docs/` was consolidated for the 4.x architecture: completed planning docs were removed and `CLAUDE.md` rewritten with the multi-source registry, source-scoped query convention, and the current 52-migration registry up front.

## Bug Fixes

- **fix(messages):** infinite scroll-up firing with stale offset on first scroll (#2930)
- **fix(messages):** unread-count scoping + stuck mark-as-read on SQLite (#2932)
- **fix(traceroute):** stop cascading IP-style across radio segments (#2935) — closes #2931
- **fix(notifications):** skip traceroute messages in WS cache to stop spurious chime (#2929)
- **fix(auto-responder):** prevent triple-send when target ACK arrives late (#2928)
- **fix(scripts):** resolve interpreter from PATH in desktop builds (#2926)

## Documentation

- **chore(docs):** consolidate Claude-agent guidance for 4.x; drop shipped plans (#2933)

## Release

- **chore(release):** bump version to 4.2.3 (#2934)

## Issues Resolved

- #2931 — [BUG] drawing a route trace

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.2.2...v4.2.3

## [4.2.2] - 2026-05-06

# MeshMonitor v4.2.2

**Security update + multi-source bug fixes.** This release patches the **MM-SEC-5/6/7/8 follow-on advisory** (four authorization issues uncovered in a follow-up audit to the v4.2.1 disclosure), introduces an **admin-configurable Default Landing Page**, and fixes several multi-source routing bugs from the 4.0/4.2 line. The most severe finding (MM-SEC-5) leaked the local node's PKI **private key** to any logged-in user, and MM-SEC-6/7 exposed channel **PSKs** through endpoints missed by the v4.2.1 patches. **All MeshMonitor 4.x deployments should upgrade.** Operators of multi-tenant or untrusted-user installations should also rotate their local node's PKI key, any exposed channel PSKs, and any source credentials that non-admin users may have read.

> **Action Required**
> - Rotate your local node's PKI private key if untrusted users had login access on 4.2.1 or earlier.
> - Rotate any channel PSKs that were exposed.
> - Rotate any source credentials (`password` / `apiKey`) that may have been read by non-admin users.
> - Full advisory: [`docs/security/SECURITY_ADVISORY.md`](https://github.com/Yeraze/meshmonitor/blob/main/docs/security/SECURITY_ADVISORY.md)

## Security

- **MM-SEC-5/6/7/8 follow-on advisory** — Four authorization fixes, including a high-severity PKI private-key disclosure, two PSK leak channels missed by the MM-SEC-2 patch, and a source credential leak. ([#2915](https://github.com/Yeraze/meshmonitor/pull/2915))

## Features

- **Admin-configurable Default Landing Page** — Choose what users see at the root URL: the unified multi-source dashboard (default) or any single configured source. Lives under **Settings → Appearance**, admin-only. ([#2921](https://github.com/Yeraze/meshmonitor/pull/2921), closes [#2917](https://github.com/Yeraze/meshmonitor/issues/2917))

## Bug Fixes

- **Multi-source: Exchange Node Info / Position / Neighbor Info** — These actions now route through the source the user selected instead of always going through the default. ([#2916](https://github.com/Yeraze/meshmonitor/pull/2916), closes [#2911](https://github.com/Yeraze/meshmonitor/issues/2911))
- **Auto Traceroute checkbox** — Now hydrates from the per-source value instead of a stale global, so the toggle reflects what's actually configured on each source. ([#2918](https://github.com/Yeraze/meshmonitor/pull/2918), closes [#2914](https://github.com/Yeraze/meshmonitor/issues/2914))
- **Node position override** — Writes to the live source row instead of the legacy `default` row, so manual coordinate overrides actually render. ([#2913](https://github.com/Yeraze/meshmonitor/pull/2913), closes [#2902](https://github.com/Yeraze/meshmonitor/issues/2902))
- **Auto-upgrade sidecar** — Clears the stale `.upgrade-status` file before triggering a new upgrade, preventing the watchdog from looping on stale state. ([#2920](https://github.com/Yeraze/meshmonitor/pull/2920))
- **Desktop x64 macOS DMG** — Now ships with x86_64 native binaries instead of accidentally bundling the arm64 `better_sqlite3.node`. ([#2912](https://github.com/Yeraze/meshmonitor/pull/2912), closes [#2901](https://github.com/Yeraze/meshmonitor/issues/2901))
- **Desktop script storage** — Honors `DATA_DIR` so desktop builds can persist user scripts in the configured data directory. ([#2919](https://github.com/Yeraze/meshmonitor/pull/2919))
- **`/api/scan-remote-admin`** — Handles empty request bodies cleanly instead of 500-ing. ([#2910](https://github.com/Yeraze/meshmonitor/pull/2910))

## Documentation

- New **Default Landing Page** section in [`docs/features/settings.md`](https://meshmonitor.org/features/settings#default-landing-page), linked from the Appearance section of [`docs/features/global-settings.md`](https://meshmonitor.org/features/global-settings). ([#2922](https://github.com/Yeraze/meshmonitor/pull/2922))

## Dependencies

- `lucide-react` 1.11.0 → 1.14.0 ([#2895](https://github.com/Yeraze/meshmonitor/pull/2895))
- `npm audit fix` cleared the `serialize-javascript` (high) and `ip-address` (moderate) advisory chains. The remaining 6 advisories are all dev-only `esbuild` via `drizzle-kit` / `vitepress` and have no production runtime exposure.

## Issues Resolved

- [#2901](https://github.com/Yeraze/meshmonitor/issues/2901) — [BUG] MeshMonitor-Desktop-4.2.0-x64.dmg bundles `better_sqlite3.node` as arm64 instead of x86_64
- [#2902](https://github.com/Yeraze/meshmonitor/issues/2902) — [BUG] Node position override saved to non-rendered source row
- [#2911](https://github.com/Yeraze/meshmonitor/issues/2911) — [BUG] 4.2.0 — Exchange Node Info / Position emitted from wrong node
- [#2914](https://github.com/Yeraze/meshmonitor/issues/2914) — [BUG] Auto Traceroute
- [#2917](https://github.com/Yeraze/meshmonitor/issues/2917) — [FEAT] Load Default Node

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.2.1...v4.2.2

## [4.2.1] - 2026-05-06

# MeshMonitor v4.2.1 — Security release

> **All 4.x deployments should upgrade.** This release fixes three high-severity authorization issues reachable by unauthenticated visitors under the standard public-viewer configuration, plus one medium-severity authenticated-user privilege escalation. See [SECURITY_ADVISORY.md](https://github.com/Yeraze/meshmonitor/blob/main/docs/security/SECURITY_ADVISORY.md) for full per-finding details.

## Summary

v4.2.1 is a focused security and stability release. It closes the **MM-SEC-1/2/3/4** advisory series reported by an external researcher: anonymous disclosure of the auto-generated VAPID private key via `GET /api/settings` (MM-SEC-1), anonymous disclosure of every channel's PSK via `GET /api/channels` and `/api/poll` (MM-SEC-2), anonymous disclosure of hidden-channel message content via `/api/poll` (MM-SEC-3), and authenticated-user privilege escalation across the channel-mutation endpoints (MM-SEC-4). Two adjacent fixes also land: a long-standing decode bug where empty channel names were silently dropped during channel-URL import (#2900), and admin-packet pacing during config import to work around a firmware-side timing race that started causing system-test flakiness on Meshtastic firmware v2.7.22 (#2903). A new regression test locks in the system-backup tarball's exclusion of `push_subscriptions`, `sessions`, and `backup_history` (#2908). All v4.x deployments should upgrade — operators who ran a public-viewer dashboard with `channel_0:read` granted to anonymous should rotate exposed PSKs after upgrading, since PSK disclosure cannot be undone retroactively.

## Security

- **MM-SEC-1 (High):** Strip secret keys (`vapid_private_key`, `securityDigestAppriseUrl`, `analyticsConfig`, plus a `*_private_key` / `*_secret` / `*_token` tail-pattern denylist) from `GET /api/settings` for non-admin callers ([#2904](https://github.com/Yeraze/meshmonitor/pull/2904))
- **MM-SEC-2 (High):** Stop returning `channel.psk` from `/api/channels`, `/api/channels/all`, and `/api/poll`. Hoist `transformChannel` to a shared module + per-row read permission check + new derived `pskSet: boolean` so callers can answer "is a PSK configured?" without seeing the key ([#2905](https://github.com/Yeraze/meshmonitor/pull/2905))
- **MM-SEC-3 (High):** Filter messages by per-channel read in `/api/poll`, `/api/messages`, and `/api/messages/unread-counts` so a caller with `channel_0:read` can no longer see hidden-channel message content ([#2906](https://github.com/Yeraze/meshmonitor/pull/2906))
- **MM-SEC-4 (Medium):** Per-channel write gate on `PUT/DELETE /api/channels/:id`, `/api/channels/:id/export`, `/api/channels/:slotId/import`, and `/api/channels/reorder` so a user with `channel_0:write` can no longer mutate any channel ([#2907](https://github.com/Yeraze/meshmonitor/pull/2907))
- **Coverage lock-in:** `BACKUP_TABLES` regression test asserts `push_subscriptions`, `sessions`, `backup_history` are never re-added to the system-backup tarball + operator-facing `SECURITY_ADVISORY.md` ([#2908](https://github.com/Yeraze/meshmonitor/pull/2908))

## Bug Fixes

- **Channel URL decode:** Preserve empty channel names instead of silently dropping them — fixes round-trip imports of channel-set URLs whose primary channel is unnamed ([#2900](https://github.com/Yeraze/meshmonitor/pull/2900))
- **Config import pacing:** Bump admin-packet inter-message delays from 500/300/500 ms to 2000/1000/1500 ms across `/channels/import-config`, `/channels/reorder`, and the local + remote `/admin/import-config` paths. Works around a firmware-side timing race in Meshtastic v2.7.22 where the first SetChannel admin packet after a tight BeginEditSettings was being silently dropped, causing intermittent CI failures ([#2903](https://github.com/Yeraze/meshmonitor/pull/2903))

## Upgrade notes

After upgrading, **rotate any channel PSKs** that were exposed while a public-viewer dashboard with `channel_0:read` was reachable. The PSK disclosure under MM-SEC-2 is the highest-impact finding because anyone who saved the keys before the patch can still decrypt mesh traffic captured at the time. The leak is irreversible — only key rotation closes it.

If you never set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` via environment variables, also **rotate the auto-generated VAPID key**: delete the three `vapid_*` rows from the `settings` table and restart. Existing browser push subscriptions are invalidated — clients re-subscribe transparently on next visit.

The MM-SEC-4 fix tightens the per-channel write check from a static `channel_0:write` gate to a per-row check using the URL's actual `:id`. Users who previously relied on having only `channel_0:write` to manage every channel will now need explicit per-channel grants. Audit accounts and grant per-channel permissions as needed.

## Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v4.2.0...v4.2.1

## [4.2.0] - 2026-05-04

# MeshMonitor v4.2.0 — Analysis & Reports

This minor release introduces a brand-new global **Analysis & Reports** workspace with the first cross-source analytical report — **Solar Monitoring Analysis**. The report ports the proven detection algorithm from MeshManager to identify solar-powered nodes by scanning battery / voltage / INA-channel telemetry for the morning-low → afternoon-peak charging pattern, overlays the forecast.solar production curve on each candidate's chart, draws healthy-level reference lines, and projects multi-day battery state into the future to surface nodes predicted to drop below safe thresholds. Map Analysis gets several quality-of-life upgrades: a close button and live telemetry inside the marker detail pane, fixes to the SNR overlay (dedupe, clickability, scoping, coloring), and draggable Forward/Return path popups on traceroute results. Source status badges now reflect actual mesh activity for anonymous viewers via the unified status endpoint, alongside a new mesh-liveness badge that complements the link-state dot. The TrafficManagement module is realigned with the v2.7.23 protobuf schema, with firmware-side fixes folded in. Dependencies are bumped across the production and development trees.

## ✨ Features

- **Analysis & Reports workspace** ([#2898](https://github.com/Yeraze/meshmonitor/pull/2898)) — new `/reports` page linked from the dashboard sidebar; first report is the cross-source **Solar Monitoring Analysis** with auto-detection of solar-powered nodes, hourly solar production overlay, healthy-level reference lines (100/50/20% for batteries; 4.2/3.7/3.3 V for voltage), and an optional forecast simulation that projects battery state across the next several days using the forecast.solar production cache. New endpoints: `GET /api/analysis/solar-nodes` and `GET /api/analysis/solar-forecast`, both gated by per-source `nodes:read`.
- **Map Analysis: telemetry in detail pane + close button** ([#2890](https://github.com/Yeraze/meshmonitor/pull/2890), closes [#2885](https://github.com/Yeraze/meshmonitor/issues/2885))
- **Traceroute: draggable Forward/Return path popups** ([#2891](https://github.com/Yeraze/meshmonitor/pull/2891), closes [#2887](https://github.com/Yeraze/meshmonitor/issues/2887))
- **Protobufs v2.7.23 + TrafficManagement realign** ([#2897](https://github.com/Yeraze/meshmonitor/pull/2897), closes [#2729](https://github.com/Yeraze/meshmonitor/issues/2729)) — refreshes the bundled protobuf module to v2.7.23, realigns the TrafficManagement module config to match the new schema, and folds in firmware-side fixes.

## 🐛 Bug Fixes

- **Source status: real status badge for anonymous + mesh-activity badge** ([#2888](https://github.com/Yeraze/meshmonitor/pull/2888), closes [#2882](https://github.com/Yeraze/meshmonitor/issues/2882), [#2883](https://github.com/Yeraze/meshmonitor/issues/2883)) — anonymous viewers now see real source connectivity via the unified status endpoint; a complementary mesh-activity badge (live / partial / idle) reflects how recently nodes have been heard so a "Connected" gateway with stale nodes is no longer misleading.
- **Map Analysis: SNR overlay dedupe / click / scoping / coloring** ([#2889](https://github.com/Yeraze/meshmonitor/pull/2889), closes [#2884](https://github.com/Yeraze/meshmonitor/issues/2884))

## 📚 Documentation

- New `docs/features/analysis-reports.md` and "🆕 4.2 Highlights" Vitepress nav section
- Solar Monitoring page cross-links the new analysis report
- REST API reference now documents the two new `/api/analysis/*` endpoints
- README and homepage feature card updated to lead with the 4.2 highlight ([#2899](https://github.com/Yeraze/meshmonitor/pull/2899))

## 📦 Dependencies

- **Production deps** — 7-update group bump ([#2893](https://github.com/Yeraze/meshmonitor/pull/2893))
- **`globals`** 17.5.0 → 17.6.0 ([#2894](https://github.com/Yeraze/meshmonitor/pull/2894))
- **`@typescript-eslint/eslint-plugin`** 8.58.2 → 8.59.1 ([#2896](https://github.com/Yeraze/meshmonitor/pull/2896))
- **`eslint`** 10.2.1 → 10.3.0 ([#2892](https://github.com/Yeraze/meshmonitor/pull/2892))

## 📋 Issues Resolved

- [#2729](https://github.com/Yeraze/meshmonitor/issues/2729) — Realign TrafficManagement module config with v2.7.22 protobuf schema
- [#2864](https://github.com/Yeraze/meshmonitor/issues/2864) — Missing new map
- [#2882](https://github.com/Yeraze/meshmonitor/issues/2882) — Anonymous user cannot access Unified source telemetry
- [#2883](https://github.com/Yeraze/meshmonitor/issues/2883) — Source status badges do not reflect actual node connection state
- [#2884](https://github.com/Yeraze/meshmonitor/issues/2884) — Map Analysis: SNR Overlay shows duplicate markers, non-clickable dots
- [#2885](https://github.com/Yeraze/meshmonitor/issues/2885) — Map Analysis: show telemetry data in marker details pane
- [#2886](https://github.com/Yeraze/meshmonitor/issues/2886) — Monitor current draw of the device that is connected
- [#2887](https://github.com/Yeraze/meshmonitor/issues/2887) — Free positioning of forward and return path info box

## ⬆️ Upgrade Notes

No breaking changes. The new `/api/analysis/solar-nodes` and `/api/analysis/solar-forecast` endpoints inherit the existing per-source `nodes:read` permission filter; admins see all enabled sources. The Reports page route is publicly addressable but data is always permission-scoped.

**Full changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.1.2...v4.2.0

## [4.1.2] - 2026-05-01

# MeshMonitor v4.1.2

This patch release hardens the auto-upgrade flow with a failure circuit breaker, fixes timezone handling in the Alpine runtime image by including `tzdata`, and resolves a PostgreSQL/MySQL coherency bug in the in-memory nodes cache. Two map-analysis improvements ship as well: a tileset selector overlay on the analysis canvas and a per-source filter for embed profiles. Tooling now uses exit-code-driven CI and release watchers to keep model context out of the polling loop. Translations refreshed from Hosted Weblate.

## Features
- **Embed profiles** — per-source filter on embed profiles (#2878)
- **Map analysis** — tileset selector overlay (#2877)

## Bug Fixes
- **Auto-upgrade** — circuit breaker halts repeated failure loops on docker-compose pinned images (#2879, closes #2871)
- **Docker** — install `tzdata` in Alpine runtime so timezone settings work (#2876, closes #2875)
- **Multi-DB** — keep PG/MySQL `nodesCache` coherent via NodesRepository hook (#2873)

## CI/DevOps
- Exit-code-driven CI/Release watchers + `/release-monitor` skill (#2870)

## Translations
- Translations update from Hosted Weblate (#2851)

## Issues Resolved
- #2871 — Auto-upgrade silently loops forever on docker-compose pinned images
- #2875 — Timezone not honored in Alpine runtime

## Upgrade Notes
No breaking changes. Standard upgrade path.

**Full changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.1.1...v4.1.2

## [4.1.1] - 2026-04-30

# MeshMonitor v4.1.1

Hotfix release for v4.1.0 addressing several user-reported regressions: an MQTT/IP hop labelling bug in traceroute, a virtual-node MQTT uplink that lost its primary-channel name, custom map-pin locations being overwritten by node telemetry, packet-log retention failing on PostgreSQL/MySQL, channel-database UI rejecting empty channel names, and notification-preference legacy-fallback ignoring saved `notify*` values. Map Analysis gains link/trail detail in the inspector and consistent pin styling. The tooling side adds exit-code-driven CI/release watcher scripts plus a `/release-monitor` skill, and the security docs now document the kernel CVE policy and Helm seccomp default.

## Bug Fixes

- Notifications: legacy preference fallback now honors saved `notify*` values — #2868 (closes #2867)
- Virtual node: synthesize a primary channel name from the modem preset for MQTT uplink — #2866
- Traceroute: stop labelling RF hops as MQTT/IP — #2862 (closes #2859)
- Map: preserve manual position override across WebSocket node updates — #2858 (closes #2847)
- Database: portable two-step delete for packet log retention — #2857 (closes #2846)
- Channels: allow empty channel names; render slot 0 as "Primary" when blank — #2856 (closes #2855)

## Features

- Map Analysis: shared pin style for node markers — #2865
- Map Analysis: show neighbor link and trail details in inspector — #2863

## Documentation

- Security: kernel CVE policy + Helm seccomp default — #2860

## CI / Tooling

- Exit-code-driven `watch-ci.sh` + `watch-release.sh` + `/release-monitor` skill — #2870
- Bump to 4.1.1 + News.json blurb — #2869

## Issues Resolved

- #2867 — Toggle audio notification for successful traceroute
- #2859 — 4.1.0 using MQTT even when disabled
- #2855 — Empty channel names rejected by Channel Database UI
- #2847 — Custom Location overwritten by node telemetry (`fixedPosition`)
- #2846 — Packet log retention delete portable across backends

## Upgrade Notes

No breaking changes or migrations. Standard upgrade.

**Full Changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.1.0...v4.1.1


## [4.1.0] - 2026-04-29

# MeshMonitor v4.1.0

## Summary

The headline feature of 4.1 is **Map Analysis** — a new cross-source visualization workspace for diagnosing mesh coverage, topology, and signal quality. Open it from the **Analysis** section of the dashboard sidebar (or `/analysis`) and you'll get a single Leaflet canvas with eight independent layers: node markers, traceroute paths colored by SNR, neighbor links, coverage heatmap, position trails, range rings, hop shading, and an SNR overlay. Lookback windows are configurable per layer (1h, 6h, 24h, 3d, 7d, 30d, all), a time slider scrubs sub-windows of the loaded data without refetching, and a right-side inspector mirrors the current selection. The workspace pulls from every source the viewer can read — silent per-source permission filtering, no new permission resource. Configuration is persisted per-browser to `localStorage` (versioned for future server-persisted promotion).

The release also adds an emoji picker to the message composer, a hardware-model pie chart on the Info tab, humanized clock-offset display on the Security panel, and an upgrade for the bundled PirateWeather auto-responder script to the v2 API. Position overrides set in the UI are now honored across every read-side surface (no more drift back to device-reported coordinates). Translations are refreshed from Weblate.

## Highlights

- **Map Analysis workspace** — eight cross-source visualization layers, time slider, inspector, and per-browser persistence ([#2849](https://github.com/Yeraze/meshmonitor/pull/2849))
- **Emoji picker** in compose inputs (closes [#2575](https://github.com/Yeraze/meshmonitor/issues/2575)) — [#2853](https://github.com/Yeraze/meshmonitor/pull/2853)
- **Hardware model pie chart** panel on the Info tab (closes [#2663](https://github.com/Yeraze/meshmonitor/issues/2663)) — [#2852](https://github.com/Yeraze/meshmonitor/pull/2852)

## Features

- feat(analysis): cross-source Map Analysis workspace ([#2849](https://github.com/Yeraze/meshmonitor/pull/2849))
- feat(messages): emoji picker button for compose inputs ([#2853](https://github.com/Yeraze/meshmonitor/pull/2853), closes [#2575](https://github.com/Yeraze/meshmonitor/issues/2575))
- feat(info): add hwModel pie chart panel ([#2852](https://github.com/Yeraze/meshmonitor/pull/2852), closes [#2663](https://github.com/Yeraze/meshmonitor/issues/2663))
- feat(scripts): update PirateWeatherADV to v2 ([#2850](https://github.com/Yeraze/meshmonitor/pull/2850), closes [#2728](https://github.com/Yeraze/meshmonitor/issues/2728))
- feat(security): humanize clock offset display ([#2845](https://github.com/Yeraze/meshmonitor/pull/2845))

## Bug Fixes

- Honor user-set position overrides across all read-side surfaces ([#2848](https://github.com/Yeraze/meshmonitor/pull/2848))

## Translations

- Translations update from Hosted Weblate ([#2802](https://github.com/Yeraze/meshmonitor/pull/2802))

## Documentation

- chore(release): bump to 4.1.0 + Map Analysis docs ([#2854](https://github.com/Yeraze/meshmonitor/pull/2854))

## Closed Issues

- [#2575](https://github.com/Yeraze/meshmonitor/issues/2575) — Add emoji picker to message compose
- [#2663](https://github.com/Yeraze/meshmonitor/issues/2663) — Add hardware model pie chart to Info tab
- [#2728](https://github.com/Yeraze/meshmonitor/issues/2728) — PirateWeather auto-responder script needs v2 API

## Upgrade Notes

- No database migrations required for v1 of Map Analysis. Configuration is stored per-browser in `localStorage` under the versioned key `mapAnalysis.config.v1`.
- Map Analysis uses your existing per-source read permissions — sources a user can't read silently contribute zero data.
- See the new [Map Analysis docs](https://meshmonitor.org/features/map-analysis) for layer-by-layer details, lookback semantics, and performance guardrails.

**Full Changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.0.2...v4.1.0


## [4.0.2] - 2026-04-28

# MeshMonitor v4.0.2

## Summary

This release is a follow-up to the v4.0.1 hotfix and continues hardening the new multi-source architecture introduced in 4.0. It fixes a Postgres upgrade failure where migration 028 left a legacy single-column UNIQUE constraint on `user_notification_preferences.userId` that blocked saving notification preferences on any non-default source. It scopes several remaining tabs and queries to the active source — Notifications, Settings, the Virtual Node info panel, and the latest-telemetry-value rollup — fixing cases where users on Source 2+ saw default-source data. It resolves an upgrade-time crash on MySQL where migration 037 attempted to recreate a foreign key with a duplicate name, plus a startup crash in the packet-log retention timer. The unified channel/messages experience now correctly saves channel names, routes cross-source actions to the right node, and stops the source picker from drifting. The Messages composer now supports multi-line input (Enter sends, Shift+Enter inserts a newline). On the database side, composite indexes back the hot per-source query patterns and the default Postgres/MySQL pool size has been raised to keep up with per-source polling fan-out.

## Bug Fixes

- fix(notifications): scope channels per-source + drop legacy unique constraint (#2843)
- fix(settings): scope per-source reads to per-source namespace only (#2842)
- fix(upgrade): MySQL migration 037 FK + packet-log timer crash (#2838)
- fix(unified): channel-name save, cross-source routing, picker drift (#2837)
- fix(info): show per-source admin commands status in Virtual Node panel (#2835)
- fix(telemetry): scope getLatestTelemetryValueForAllNodes by sourceId (#2834)
- fix(sources): remove FE virtualNode port == source port block (#2832)

## Features

- feat(messages): multi-line compose — Enter sends, Shift+Enter inserts a newline (#2841)

## Performance

- perf(db): composite indexes for hot query patterns + raise default PG/MySQL pool size (#2833)

## Release

- chore(release): bump version to 4.0.2 (#2844)

## Issues Resolved

- #2836 — v4.0.1 hotfix: migration 32/33 hang on MySQL upgrade
- #2768 — Incorrect value on last-traced time
- #2723 — v4.0.0-beta5: all connected nodes use the same script settings

## Upgrade Notes

- **PostgreSQL** users who saw `duplicate key value violates unique constraint "user_notification_preferences_userId_key"` when saving notification preferences on a secondary source: this is fixed by new migration **051**, which runs automatically at startup and drops the legacy single-column UNIQUE.
- **MySQL** users upgrading from 3.12 → 4.0 who hit the migration 037 foreign-key error or a server crash from the packet-log timer: this is fixed by #2838 and the upgrade should now complete cleanly.
- No manual action required for either fix — both are covered by the automatic migration runner on startup.

**Full Changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.0.1...v4.0.2

## [4.0.1] - 2026-04-27

# MeshMonitor v4.0.1

Hotfix release for v4.0.0. Addresses critical migration and stability issues encountered during 3.12 → 4.0 upgrades, plus several multi-source bugs reported by early upgraders. The server now survives SIGTERM and DB-not-ready conditions during long migrations, preserves legacy telemetry and neighbor data when migrating from 3.12, and correctly maps existing 3.x data structures into the new multi-source schema. Multi-source operation is more forgiving: virtual node ports may now equal a source TCP port, and the auto-favorite warning is correctly scoped to the active source. Also includes Node base image security upgrades and a settings hydration fix.

## Bug Fixes

- Migrations: preserve legacy telemetry & neighbor data on 3.12 → 4.0 upgrade (#2827)
- Migrations: support 4.0 multi-source data structures in migrate-db tool (#2829)
- Server: survive SIGTERM and DB-not-ready during long migrations (#2825)
- Auto-favorite: scope status fetch to active source (#2828, fixes #2826)
- Sources: allow virtualNode.port to equal source TCP port (#2823, fixes [#2823](https://github.com/Yeraze/meshmonitor/issues/2823))
- Settings: stop re-POSTing tracerouteIntervalMinutes on hydration (#2822)

## Security

- Node base image: 24.14.0 → 24.14.1 → 24.15.0 (Alpine 3.22) (#2820, #2821)

## Issues Resolved

- #2826 — Autofavorite displays warning even when node is client_base
- #2823 — Virtual Node port cannot equal the source TCP port

## Upgrade Notes

If you are upgrading from 3.12 directly to 4.0, this release is strongly recommended — it preserves legacy telemetry and neighbor data that earlier 4.0.0 builds could lose during the migration. Long migrations are now resilient to SIGTERM and database-not-ready races, so container restarts during the upgrade no longer corrupt state.

**Full Changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.0.0...v4.0.1


## [4.0.0] - 2026-04-27

# MeshMonitor v4.0.0 — Multi-Source

This is the **general availability** release of MeshMonitor 4.0. The 4.0 line introduces **Multi-Source** support — a single MeshMonitor instance can now connect to **multiple Meshtastic nodes simultaneously**, each with its own Virtual Node, auto-responder, scheduler, and per-source permission matrix. 4.0 ships extensive schema migrations, a reorganized permission model, and removes several environment variables (including the Virtual Node env vars) in favor of per-source UI configuration. Since `v4.0.0-beta14`, this release rolls up two stabilization bug fixes, dev compose cleanup, dependency bumps, and the version bump to GA.

## Action Required After Upgrade

- **Permissions** — The permission matrix is now per-source. Open **Settings → Users** and verify each user's access on every source transferred over correctly. See [Per-Source Permissions](https://meshmonitor.org/features/per-source-permissions).
- **Automation** — Auto-responder, AutoTraceroute, Auto Favorite, Auto-Ping, Auto-Acknowledge, geofences, and other automation settings are now per-source. Open the **Automation** tab on each source and confirm everything migrated as expected.
- **Configuration** — Several environment variables (including Virtual Node env vars) are removed; per-source settings now live in the UI. See [Multi-Source](https://meshmonitor.org/features/multi-source).
- **Back up your `/data` volume before upgrading.**

## Bug Fixes

- Stabilize Unified source node count when selected source changes (#2806, closes #2805)
- Clear `packet_log` when purging all nodes (#2807, closes #2637)

## CI / Dev

- Drop stale `RATE_LIMIT_*` compose overrides (#2808)
- Cut 4.0.0 release commit (#2819)

## Dependencies

### Production
- Production dependencies group — 7 updates (#2810)
- `express-rate-limit` 8.3.2 → 8.4.1 (#2813)
- `maplibre-gl` 5.23.0 → 5.24.0 (#2814)
- `lucide-react` 1.8.0 → 1.11.0 (#2816)

### Development
- `vitest` 4.1.4 → 4.1.5 (#2809)
- `jsdom` 29.0.2 → 29.1.0 (#2811)
- `puppeteer` 24.41.0 → 24.42.0 (#2812)
- `@tanstack/react-query-devtools` 5.99.2 → 5.100.5 (#2815)
- `@typescript-eslint/parser` 8.58.2 → 8.59.0 (#2818)

## Issues Resolved

- #2805 — [BUG] Unified source node count changes incorrectly based on selected source
- #2787 — [FEAT] separate node database for different frequency/modulation
- #2637 — [BUG] nodes not fully deleted

## Need Help?

- Visit [meshmonitor.org](https://meshmonitor.org) for the full 4.0 documentation and migration guide
- Submit bugs at [github.com/Yeraze/meshmonitor/issues](https://github.com/Yeraze/meshmonitor/issues)
- Join our [Discord](https://discord.gg/JVR3VBETQE) to discuss any issues you find

**Full Changelog:** https://github.com/Yeraze/meshmonitor/compare/v4.0.0-beta14...v4.0.0

## [3.12.0] - 2026-04-03

## What's New in v3.12.0

### Features

- **Reverse proxy authentication** — Support for Cloudflare Access, oauth2-proxy, and other reverse proxy auth providers (#2539)
- **Telemetry widget display modes** — Gauge and numeric display modes for telemetry widgets with per-widget persistence (MM-67, MM-80, #2537, #2550, #2554)
- **Per-channel/DM notification muting** — Mute notifications per channel or DM with time-based options (MM-77, #2549)
- **Auto heap management** — Prevents node OOM crashes with automatic memory management (#2555, MM-100, #2563)
- **Delete channel** — Delete channel button with message and DB record cleanup (#2531, #2533)
- **V1 API status endpoint** — `/api/v1/status` endpoint and WebSocket Bearer token auth (#2527)
- **Custom tileserver style** — Generate default `style.json` from custom tileserver (#2551)
- **System tests CI** — Self-hosted runner workflow for hardware-integrated system tests (#2569)
- **Homepage refresh** — Updated MeshMonitor.org homepage content and structure (#2542)

### Bug Fixes

- **WebSocket connection with BASE_URL** — Fixed Socket.io silently failing when `<base>` tag is present; explicit URL + polling-first transport (#2567)
- **CSP WebSocket support** — Added `ws:`/`wss:` to Content-Security-Policy `connect-src` (#2567)
- **Widget mode/range BASE_URL** — `useWidgetMode`/`useWidgetRange` now respect BASE_URL for API calls (#2567)
- **Notification muting** — Unread count badges and notification sounds now properly respect mute settings (#2570)
- **Device config cache** — Config changes (LoRa, network, position, MQTT, etc.) immediately update the in-memory cache (#2568)
- **Telemetry gauge/numeric display bugs** — Fixed mode display issues (MM-99, #2564)
- **Private channel data masking** — Extended masking to telemetry and traceroute fields; prevent location data leaking through nodes API (MM-47, #2544, #2546)
- **Mark-as-read PostgreSQL** — Fixed mark-as-read failing on PostgreSQL (#2535)
- **Map preferences migration** — Migrated from raw SQL to Drizzle ORM (#2524, #2526)
- **Packet monitor resize** — Invalidate map size when packet monitor is resized (#2553)
- **PSK preservation** — Preserve `AQ==` PSK shorthand verbatim in channel database on save (#2559)
- **MeshCore auto-connect** — Auto-connect MeshCore on startup (MM-31, #2543)
- **Packet monitor encryption check** — Use `decryptedBy` flag for `isEncrypted` check (#2541)
- **Zoom-based label visibility** — Apply to MeshCore map markers (#2525, #2529)
- **Database migration test** — Fixed pipefail, empty count guards, auto build:server (#2568)
- **System test reliability** — Favorites ±1 variance, missing `.env` for CI (#2572)

### Other

- **Translations update** from Hosted Weblate (#2516)
- **Test coverage** — Phase 1 and Phase 2 coverage tests toward 50% target (MM-49, #2547, #2552)
- **PirateWeatherADV** — Added community script to User Scripts Gallery (#2561)
- **Tulsa/Broken Arrow Mesh** — Added to site gallery (#2523)
- **Documentation** — Telemetry widgets, homepage refresh, notification muting docs (MM-77, MM-78, MM-79, #2556)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.11.1...v3.12.0

## [3.11.1] - 2026-03-30

## What's Changed

### New Features
- **Custom MapLibre style JSON upload & switcher** — Upload or fetch MapLibre GL style JSON files and switch between them via a dropdown on the map when using vector tilesets. Styles are persisted as server default with per-browser override. (#2492)
- **Native desktop notifications for Tauri app** — Replaces web push (which requires SSL) with native OS notifications via node-notifier. Same user preference filtering, triggered server-side. (#2518)

### Bug Fixes
- **Tile server CORS fix** — Test Connection now routes through the backend proxy, eliminating the add-bogus-URL-reload-edit workaround when adding custom tileservers (#2493)
- **Node list timestamp accuracy** — `lastHeard` now uses server time instead of device `rxTime`, fixing incorrect "last seen" times when the local node's clock drifts (#2494)
- **Neighbor timestamp normalization** — Handles mixed seconds/milliseconds in old `neighbor_info` data so "Last Seen" in neighbor popups no longer shows 1970 dates (#2514, closes #2458)
- **SNR 0 dB MQTT misclassification** — Pure RF links with SNR exactly 0 dB are no longer incorrectly classified as MQTT/IP (#2515, closes #2512)
- **TypeScript 6 compatibility** — Added CSS type declarations required by TS 6's stricter import checking (#2517)
- **Desktop build path length** — Fixed NSIS installer failure on Windows by using production-only node_modules (#2519)

### Maintenance
- **Protobufs v2.7.20** — New hardware models (TBEAM_BPF, MINI_EPAPER_S3, TDISPLAY_S3_PRO), LORAWAN_BRIDGE port, SCD30 sensor, TAKConfig module (#2495)
- **MySQL service in release pipeline** — Fixes release test failures (#2491)
- **Dependency updates** — TypeScript 6, i18next 26, react-i18next 17, lucide-react 1.x, xmldom 0.9, rollup patch, CI action bumps
- **Translations** — Updated from Hosted Weblate (#2482)
- **Docs** — Emacs client added to README (#2513)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.11.0...v3.11.1

## [3.11.0] - 2026-03-29

## What's Changed

### New Features
- **GeoJSON/KML/KMZ overlay layer support** — Upload geospatial files as map overlays with per-layer styling, visibility toggles, and simplestyle-spec support. KML/KMZ files are automatically converted to GeoJSON on upload. Files placed in `/data/geojson/` are auto-discovered. (#2488, closes #2487)

### Bug Fixes
- **Duplicate cron jobs after reconnects** — Timer triggers (auto-welcome, scheduled scripts) fired multiple times after device reconnects due to callback accumulation in the configComplete handler (#2489)
- **Audit log FK constraint on channel migration** — Channel migration at startup used userId 0 which doesn't exist, causing SQLITE_CONSTRAINT_FOREIGNKEY error (#2486, reported in #2425)

### New Dependencies
- `@tmcw/togeojson` — KML to GeoJSON conversion
- `@xmldom/xmldom` — XML parsing for KML
- `jszip` — KMZ (ZIP archive) extraction

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.10.4...v3.11.0


## [3.10.4] - 2026-03-28

## What's Changed

### Bug Fixes
- **Fix reconnect flood on WiFi-connected devices** — Schedulers now wait for `configComplete` before starting, with staggered initialization and TCP backpressure handling to prevent overwhelming WiFi-connected Meshtastic devices (#2479, closes #2474)
- **Detect and recover from phantom TCP connections** — Adds buffer staleness detection and forced reconnect when data arrives but no messages are parsed, fixing a long-standing issue with USB serial bridges losing inbound data after hours (#2480)
- **Polygon geofence trigger button never enables** — Fixed Leaflet's double-click zoom consuming the polygon finalization event; polygon shape now updates progressively as vertices are added (#2481)
- **Permissions swap fails on SQLite CHECK constraint** (#2476)

### Improvements
- **Expanded repository test coverage** — 363 new tests across all database backends (SQLite, PostgreSQL, MySQL) covering nodes, channels, notifications, neighbors, traceroutes, ignored nodes, channel database, and settings repositories (#2477)
- **Flaky system test fix** — Added retry logic to config import CSRF/login step (#2479)
- **Translation updates** from Hosted Weblate (#2459)

### Issues Closed
- #2474 — [BUG] Disconnects on 3.10.2
- #2475 — [SUPPORT] Telegram proxy
- #2425 — [FEAT] Channel Migration on container start

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.10.3...v3.10.4


## [3.10.3] - 2026-03-27

## What's New

### Features
- **Daily Security Digest via Apprise** — Schedule daily security reports (summary or detailed) delivered via Apprise to Discord, Slack, email, or 80+ other services. Configurable from the Security tab with enable toggle, Apprise URL, time picker, report type, format (plain text or markdown), and "Send Now" button. (#2471, closes #2468)
- **Chronological SNR Chart** — Route segment popups now have a "Time of Day" / "Over Time" toggle, showing SNR trends over actual dates to track signal quality improvement or degradation. (#2467, closes #2464)
- **Reversed Neighbor Arrows** — Neighbor connection arrows now point from the heard neighbor toward the receiving node, correctly representing communication direction. Arrows placed at 25%, 50%, and 75% along the line for visibility at any zoom level. (#2463, closes #2456)

### Bug Fixes
- **Comprehensive packet_log timestamp migration** — Fixed multiple functions still using seconds-based calculations for packet_log queries after the millisecond migration. Affected Top Broadcasters counts (inflated ~1000x), packet cleanup, and direct neighbor RSSI stats. Also fixed table header alignment in Top Broadcasters. (#2470, closes #2469)
- **Neighbor info timestamp units** — Fixed "last seen" in Neighbor Connection popups showing wildly incorrect times due to seconds/milliseconds mismatch. (#2461, closes #2458)
- **Channel swap detection** — Fixed channel migration only detecting one direction of a swap, causing message history loss and permissions UNIQUE constraint errors when channels swap positions. (#2460, closes #2425)
- **Relay node filter by hop distance** — "Last Hops" filter dropdown now only shows plausible relay candidates (direct neighbors or 1-hop nodes), matching the column display logic. (#2462, closes #2457)
- **Meshtastic connection timing defaults** — Increased default timeouts (connect: 10s→60s, reconnect initial delay: 1s→60s, module config delay: 100ms→1s) based on community feedback to reduce Node ID change issues during config sync. (#2472, relates to #2316)

### Other
- **Site Gallery** — Added NWI Mesh Net (Northwest Indiana) (#2466, closes #2465)
- **Translations** — Updated translations from Hosted Weblate (#2416)

## [3.10.2] - 2026-03-26

## MeshMonitor v3.10.2

### Bug Fixes
- **#2438** fix: rename legacy system_backup_history columns ([#2419](https://github.com/Yeraze/meshmonitor/issues/2419))
- **#2442** fix: add missing api_tokens name column ([#2435](https://github.com/Yeraze/meshmonitor/issues/2435))
- **#2444** fix: correct frequency display when channelNum is 0 — implements DJB2 hash matching firmware ([#2436](https://github.com/Yeraze/meshmonitor/issues/2436))
- **#2449** fix: change traceroute "MQTT" label to "IP" for non-LoRa hops ([#2443](https://github.com/Yeraze/meshmonitor/issues/2443))
- **#2450** fix: replace node-cron with croner for missed execution recovery ([#2409](https://github.com/Yeraze/meshmonitor/issues/2409))
- **#2451** fix: auto-mark incoming messages as read when viewing channel/DM ([#2316](https://github.com/Yeraze/meshmonitor/issues/2316))
- **#2434** fix: packet monitor renders on mobile devices

### Features
- **#2433** feat: detect channel moves on startup, migrate messages and permissions
- **#2439** feat: migrate automation channel references on channel move ([#2425](https://github.com/Yeraze/meshmonitor/issues/2425))
- **#2448** feat: add `extraEnv` support to Helm chart for arbitrary environment variables

### Security
- **#2446** fix: upgrade ARMv7 base image to node:22.22.1-bookworm-slim (fixes critical zlib vulnerability)
- **#2447** security upgrade node to 22.22.2-bookworm-slim

### Testing
- 3110 unit tests pass
- 11/11 system tests pass (config import, security, reverse proxy, OIDC, backup/restore, DB migration, API exercise across SQLite/Postgres/MySQL)
- 3/3 backend soak tests pass (300s each, no errors)

## [3.10.1] - 2026-03-25

## Changes since v3.10.0

### Features
- Dead nodes report with bulk delete on Security tab (#2414)
- Icon style toggle — switch between Lucide and emoji sidebar icons (#2420)
- API exercise test validates response structure on all 3 backends (#2422)

### Bug Fixes
- Channel database no longer shadows device channels with same PSK (#2415)
- System backup history queries use wrong column names (#2421)
- Left-align all packet monitor table columns, fix missing Date colgroup (#2428)
- Add UNIQUE constraint to notification preferences userId — fixes 500 on save (#2429)
- Auto-mark messages as read when viewing channel or DM — fixes persistent unread indicator (#2430)

## [3.10.0] - 2026-03-24

## MeshMonitor v3.10.0

Major release featuring comprehensive database architecture refactoring — **5,672 lines of code removed** across 278 files — plus new features and dozens of bug fixes.

### New Features
- **Channel drag-and-drop reorder** with automatic message history migration (#2411)
- **Dead nodes report** with bulk delete on Security tab (#2414)
- **Rsyslog server setting** in network configuration (#2410)
- **Polar grid map overlay** for directional analysis (#2359)
- **Configurable default map center** (#2350)
- **Auto responder environment variables** for external scripts (#2356)
- **Millisecond packet timestamps** with dedicated date column (#2403)
- **OIDC retry on failure** — auth no longer permanently disables (#2402)

### Database Architecture (5,672 lines removed)
- Full async migration — all sync database calls replaced (Phase 1-4: #2323, #2324, #2325, #2330, #2332, #2335)
- Repository pattern — monolithic DatabaseService decomposed into domain-specific repositories (#2309, #2310)
- Centralized migration registry with clean v3.7 baseline (#2315)
- N+1 query elimination in security scanner, neighbor info, and node queries (#2336, #2339, #2404)
- Cross-database helpers: `col()`, `upsert()`, `insertIgnore()`, `getAffectedRows()` (#2372, #2374, #2376, #2389)

### Bug Fixes
- Channel database no longer shadows device channels with same PSK (#2415, #2413)
- PostgreSQL connection pool exhaustion with 200+ nodes (#2404)
- Local node no longer self-flags security warnings or bounces link quality (#2407)
- Key mismatch warnings now properly clear after resolution (#2406)
- Admin keys no longer show as [object Object] (#2408)
- Traceroute race conditions and duplication (#2366, #2380, #2387)
- MQTT detection and visual distinction in traceroutes (#2302)
- PKI_UNKNOWN_PUBKEY key mismatch flagging (#2382)
- PG packet monitor showing hex IDs instead of node names (#2406)
- Time offset flags not persisted on SQLite (#2379)
- Maintenance service scheduling drift and timezone bugs (#2338)
- Packet monitor ordering with same-second timestamps (#2369, #2403)

## [3.9.5] - 2026-03-16

## What's Changed in v3.9.5

### Bug Fixes
- **fix: SQLite migrations 083/084 skipped due to early return in 082** — Users upgrading from pre-3.9 on SQLite were missing the `lastMeshReceivedKey` column, crashing node queries and auto-delete-by-distance. ([#2301](https://github.com/Yeraze/meshmonitor/pull/2301), fixes [#2296](https://github.com/Yeraze/meshmonitor/issues/2296))
- **fix: allow 0 for traceroute expiration hours setting** — Backend rejected 0 for "Re-traceroute after" even though the frontend and server route allowed it. ([#2300](https://github.com/Yeraze/meshmonitor/pull/2300))
- **fix: polish Auto Delete by Distance UI** — Aligned header checkbox pattern, Run Now button, disabled states, and fixed "Invalid Date" on PostgreSQL. ([#2297](https://github.com/Yeraze/meshmonitor/pull/2297))
- **fix: use correct column names for inactive node queries on PostgreSQL/MySQL** — Fixed nullable `lastHeard` causing TypeScript null check failures. ([#2282](https://github.com/Yeraze/meshmonitor/pull/2282), fixes [#2281](https://github.com/Yeraze/meshmonitor/issues/2281))
- **fix: guard against local node echo processing and reboot-merge races** — Prevents local node echoed NodeInfo from overwriting data or triggering false key mismatch flags. ([#2278](https://github.com/Yeraze/meshmonitor/pull/2278), fixes [#2277](https://github.com/Yeraze/meshmonitor/issues/2277))
- **fix: stop broadcasting stale public key in NodeInfo exchanges** — Fixed MeshMonitor broadcasting cached stale keys, causing firmware 2.7.19 to reject the node. ([#2276](https://github.com/Yeraze/meshmonitor/pull/2276), fixes [#2275](https://github.com/Yeraze/meshmonitor/issues/2275))
- **fix: adjust auto-traceroute interval and expiration limits** — ([#2272](https://github.com/Yeraze/meshmonitor/pull/2272))
- **fix: preserve traceroute request node order from virtual node** — ([#2279](https://github.com/Yeraze/meshmonitor/pull/2279))
- **fix: rename Exchange User Info to Exchange Node Info** — ([#2280](https://github.com/Yeraze/meshmonitor/pull/2280))

### Features
- **feat: auto delete nodes by distance** — Automatically remove nodes outside a configured radius. ([#2270](https://github.com/Yeraze/meshmonitor/pull/2270))
- **feat: direct radio links visualization with simplified map overlays** — ([#2268](https://github.com/Yeraze/meshmonitor/pull/2268))

### Dependency Updates
- better-sqlite3 12.6.2 → 12.8.0 ([#2295](https://github.com/Yeraze/meshmonitor/pull/2295))
- mysql2 3.19.0 → 3.20.0 ([#2288](https://github.com/Yeraze/meshmonitor/pull/2288))
- jsdom 28.1.0 → 29.0.0 ([#2292](https://github.com/Yeraze/meshmonitor/pull/2292))
- docker/build-push-action 6 → 7 ([#2285](https://github.com/Yeraze/meshmonitor/pull/2285))
- dorny/paths-filter 3 → 4 ([#2284](https://github.com/Yeraze/meshmonitor/pull/2284))
- @typescript-eslint/eslint-plugin 8.56.1 → 8.57.0 ([#2294](https://github.com/Yeraze/meshmonitor/pull/2294))
- @typescript-eslint/parser 8.56.1 → 8.57.0 ([#2289](https://github.com/Yeraze/meshmonitor/pull/2289))
- @vitest/coverage-v8 4.0.18 → 4.1.0 ([#2290](https://github.com/Yeraze/meshmonitor/pull/2290))
- puppeteer 24.38.0 → 24.39.1 ([#2291](https://github.com/Yeraze/meshmonitor/pull/2291))
- Production dependencies group update ([#2287](https://github.com/Yeraze/meshmonitor/pull/2287))
- Development dependencies group update ([#2286](https://github.com/Yeraze/meshmonitor/pull/2286))

### Other
- chore: add /create-pr slash command for PR workflow ([#2298](https://github.com/Yeraze/meshmonitor/pull/2298))
- Translations update from Hosted Weblate ([#2271](https://github.com/Yeraze/meshmonitor/pull/2271))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.9.4...v3.9.5

## [3.9.4] - 2026-03-15

## What's New

### Auto Delete by Distance
A new automation feature that automatically removes nodes beyond a configurable distance threshold from your home coordinate. Keep your node database focused on your local mesh.

- **Home coordinate** — Set your location manually or use your connected node's position
- **Distance threshold** — Configure the maximum distance (in km or miles) to keep nodes
- **Configurable interval** — Run cleanup every 6, 12, 24, or 48 hours
- **Protected nodes** — Favorited nodes and your local node are never deleted
- **Activity log** — Track what was deleted and when
- **Run Now** — Trigger an immediate cleanup from the Automation tab

### Auto Traceroute Improvements
- **Retraceroute After** now accepts **0 hours**, meaning nodes are always eligible for retraceroute on every cycle ([#2269](https://github.com/Yeraze/meshmonitor/issues/2269))
- **Minimum interval** raised to **3 minutes** to prevent excessive mesh traffic

## Bug Fixes
- **Multi-database parity** — Implemented missing PostgreSQL/MySQL methods for full feature parity across all backends ([#2267](https://github.com/Yeraze/meshmonitor/pull/2267))
- **Auto-key repair** — Fixed state tracking on PostgreSQL/MySQL and improved device DB awareness ([#2264](https://github.com/Yeraze/meshmonitor/pull/2264))
- **System tests** — Dev containers are now shut down before system tests to prevent port conflicts

## Translations
- Updated Spanish translations ([#2271](https://github.com/Yeraze/meshmonitor/pull/2271))

## PRs Included
- [#2270](https://github.com/Yeraze/meshmonitor/pull/2270) — feat: auto delete nodes by distance ([#2266](https://github.com/Yeraze/meshmonitor/issues/2266))
- [#2272](https://github.com/Yeraze/meshmonitor/pull/2272) — fix: auto-traceroute interval and expiration limits ([#2269](https://github.com/Yeraze/meshmonitor/issues/2269))
- [#2267](https://github.com/Yeraze/meshmonitor/pull/2267) — fix: multi-database parity
- [#2264](https://github.com/Yeraze/meshmonitor/pull/2264) — fix: auto-key repair on PostgreSQL/MySQL
- [#2271](https://github.com/Yeraze/meshmonitor/pull/2271) — Translations update from Hosted Weblate
- [#2274](https://github.com/Yeraze/meshmonitor/pull/2274) — chore: bump version to 3.9.4

## Issues Resolved
- [#2266](https://github.com/Yeraze/meshmonitor/issues/2266) — Delete Nodes from Database by Distance Threshold
- [#2269](https://github.com/Yeraze/meshmonitor/issues/2269) — Auto Traceroute time interval

## [3.9.3] - 2026-03-14

## What's Changed

### Bug Fixes

- **fix: packet monitor infinite scroll and duplicate rows** (#2259)
  - Added viewport height constraint so the virtualizer properly constrains rendering
  - Replaced broken IntersectionObserver with virtualizer-based scroll detection
  - Deduplicated packets by ID to prevent overlap from polling refetch offset shifts
  - Closes #2254

- **fix: security page crashes when Drizzle schema has columns missing from DB** (#2257)
  - Added try/catch fallback to raw SQL when Drizzle query fails due to missing columns
  - Prevents crash when migration 084 hasn't run yet

- **fix: OSM tiles blocked by missing Referer header** (#2261)
  - Changed Helmet's Referrer-Policy from `no-referrer` to `strict-origin-when-cross-origin`
  - OSM tile servers require a Referer header per their usage policy
  - Closes #2260

- **fix: auto-responder Cyrillic params mangled by homoglyph normalization** (#2262)
  - Homoglyph normalization was replacing some Cyrillic chars with Latin equivalents in extracted parameters, breaking geocoding APIs
  - Now extracts parameters from original message text, preserving full Unicode
  - Closes #2258

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.9.2...v3.9.3

## [3.9.2] - 2026-03-14

## v3.9.2 - Hotfix

### Bug Fixes
- **fix: wrong property names for Postgres/MySQL pools in getKeyRepairLogAsync** (#2251) — The key mismatch history query used incorrect property names (`pgPool` instead of `postgresPool`) causing `Cannot read properties of undefined (reading 'connect')` errors on PostgreSQL and MySQL backends when viewing the Security page.

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.9.1...v3.9.2

## [3.9.1] - 2026-03-14

## v3.9.1 - Hotfix

### Bug Fixes
- **fix: migration 084 fails when `auto_key_repair_log` table doesn't exist** (#2249, closes #2247) — Users upgrading to 3.9.0 who never enabled auto-key management would hit SQLite errors on the Security page. Migration now checks table existence before altering on all three backends (SQLite, PostgreSQL, MySQL), and query methods gracefully handle missing table/columns.

### Features
- **feat: configurable zoom level for neighbor info lines** (#2246, closes #2245) — Added a setting in the Map section to control the zoom level at which Neighbor Info lines are hidden. Defaults to 12 (previous hardcoded value).

### Documentation
- **docs: update architecture lessons and CLAUDE.md** (#2248) — Added Key Management & PKI section, settings allowlist guidance, and version bump file list.

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.9.0...v3.9.1

## [3.9.0] - 2026-03-13

## What's New in 3.9.0

### Key Mismatch Detection & Immediate Purge ([#2243](https://github.com/Yeraze/meshmonitor/pull/2243), closes [#2227](https://github.com/Yeraze/meshmonitor/issues/2227))

Proactively detects when a mesh node broadcasts a different public key than what's stored locally. When a mismatch is found, MeshMonitor can automatically purge the stale entry from your connected device to trigger re-discovery with the correct key.

- **Mismatch detection**: Compares mesh-received NodeInfo keys against stored keys in real-time
- **Immediate Purge toggle**: Optionally purge mismatched nodes on detection instead of going through the exchange retry cycle
- **Activity log enhancements**: Old/new key fragments and retry counts displayed in the Automation page activity log
- **Security Tab**: New Key Mismatch Events section showing mismatch history with status indicators
- **Channel-based exchanges**: NodeInfo exchanges for key repair are sent on the node's channel (not DM), since PKI-encrypted DMs fail when keys are mismatched
- Supports all three database backends (SQLite, PostgreSQL, MySQL)

### Map Visualization UI Overhaul ([#2237](https://github.com/Yeraze/meshmonitor/pull/2237))

Major refresh of the map interface with improved usability and visual consistency. Thanks to **@NearlCrews** for his work on this!

- **Consolidated map legend**: Merged position history legend into a single collapsible panel showing hop colors, link types, SNR quality, and position history gradient
- **Node hover isolation**: Hovering a node marker dims unrelated route/neighbor lines to trace paths per node
- **Zoom-adaptive filtering**: Poor/unknown SNR route segments and neighbor lines auto-hide at low zoom levels
- **Standardized overlay panel styling**: All panels now share consistent Catppuccin-themed styling
- **Tileset selector redesign**: Responsive 3-column grid layout replacing the old horizontal row
- **Improved touch detection**: Uses CSS media queries for accurate laptop+touchscreen handling

### Bug Fixes

- **Node uptime not showing on PostgreSQL/MySQL backends** ([#2242](https://github.com/Yeraze/meshmonitor/pull/2242))
- **Draggable overlay gets stuck off-screen on window resize** ([#2241](https://github.com/Yeraze/meshmonitor/pull/2241))
- **Map preferences not saving on PostgreSQL/MySQL backends** ([#2239](https://github.com/Yeraze/meshmonitor/pull/2239))

---

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.8.8...v3.9.0

## [3.8.8] - 2026-03-12

## What's Changed

### Features
- **Remote Admin: expanded device configuration** — Added 8 missing fields (rebroadcast mode, timezone, double-tap as button press, disable triple click, LED heartbeat, buzzer mode, button/buzzer GPIO) with full load/save support for remote nodes ([#2235](https://github.com/Yeraze/meshmonitor/pull/2235))
- **Packet Monitor: date display** — Time column now shows short date prefix for entries from prior days ([#2232](https://github.com/Yeraze/meshmonitor/pull/2232))
- **Startup environment logging** — All environment variables logged at startup with source tracking ([#2221](https://github.com/Yeraze/meshmonitor/pull/2221))

### Bug Fixes
- **Device metadata display** — Human-readable names for hardware model, role, and position flags on Remote Admin page ([#2236](https://github.com/Yeraze/meshmonitor/pull/2236))
- **Auto key management: non-message requests** — Key mismatch errors now detected for NodeInfo, telemetry, and position requests, not just DMs ([#2233](https://github.com/Yeraze/meshmonitor/pull/2233))
- **MQTT transport detection** — Now checks newer firmware `transportMechanism` enum in addition to legacy `viaMqtt` bool ([#2231](https://github.com/Yeraze/meshmonitor/pull/2231))
- **Database purge on PostgreSQL/MySQL** — Fixed purge of telemetry, messages, and traceroutes failing on non-SQLite backends ([#2230](https://github.com/Yeraze/meshmonitor/pull/2230), closes [#2228](https://github.com/Yeraze/meshmonitor/issues/2228))
- **Public key sync** — Prevent device sync from overwriting mesh-received public keys ([#2229](https://github.com/Yeraze/meshmonitor/pull/2229), closes [#2210](https://github.com/Yeraze/meshmonitor/issues/2210))
- **macOS x64 build** — Fixed build producing ARM64 binary instead of x86_64 ([#2226](https://github.com/Yeraze/meshmonitor/pull/2226), closes [#2224](https://github.com/Yeraze/meshmonitor/issues/2224))
- **Channel Database default key** — Support default key `AQ==` and fix permission check ([#2223](https://github.com/Yeraze/meshmonitor/pull/2223), closes [#2218](https://github.com/Yeraze/meshmonitor/issues/2218))
- **Noisy logs** — Reduced INFO-level log spam from poll endpoint and getDeviceConfig ([#2222](https://github.com/Yeraze/meshmonitor/pull/2222), closes [#2219](https://github.com/Yeraze/meshmonitor/issues/2219))

### Closed Issues
- [#2225](https://github.com/Yeraze/meshmonitor/issues/2225) — NEIGHBORINFO_APP not received (user config: CORE_PORTNUMS_ONLY rebroadcast mode)
- [#2220](https://github.com/Yeraze/meshmonitor/issues/2220) — Startup log for effective timing values

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.8.7...v3.8.8

## [3.8.7] - 2026-03-11

## Changes since v3.8.6

### Features
- **Configurable TCP timing and module config delay** ([#2216](https://github.com/Yeraze/meshmonitor/pull/2216)) — Closes [#2213](https://github.com/Yeraze/meshmonitor/issues/2213), [#2214](https://github.com/Yeraze/meshmonitor/issues/2214)
  - `MESHTASTIC_CONNECT_TIMEOUT_MS` — initial TCP connect timeout (default: 10s)
  - `MESHTASTIC_RECONNECT_INITIAL_DELAY_MS` — reconnect backoff base delay (default: 1s)
  - `MESHTASTIC_RECONNECT_MAX_DELAY_MS` — reconnect backoff cap (default: 60s)
  - `MESHTASTIC_MODULE_CONFIG_DELAY_MS` — delay between module config requests (default: 100ms)
- **Node ignore list for auto-acknowledge** ([#2212](https://github.com/Yeraze/meshmonitor/pull/2212)) — Suppress auto-ack for specific noisy/abusive nodes (thanks @ascendr)
- **Enhanced Node Status Widget** ([#2205](https://github.com/Yeraze/meshmonitor/pull/2205)) — Clickable node names, voltage column, uptime column (thanks @ascendr)

### Bug Fixes
- **Fix channel assignment for node communication** ([#2208](https://github.com/Yeraze/meshmonitor/pull/2208)) — Update node channel from all firmware-decoded packets instead of only NodeInfo, preventing nodes from getting stuck on wrong channel
- **Fix MQTT-sourced neighbor info creating bogus map connections** ([#2206](https://github.com/Yeraze/meshmonitor/pull/2206))
- **Fix iOS channel display ordering** ([#2204](https://github.com/Yeraze/meshmonitor/pull/2204)) — Match firmware config state machine order (thanks @NearlCrews)
- **Fix NodeStatusWidget excessive voltage re-fetching** ([#2207](https://github.com/Yeraze/meshmonitor/pull/2207)) — Replace raw fetch with React Query hook for caching/dedup

### Improvements
- **CSS design token consolidation** ([#2215](https://github.com/Yeraze/meshmonitor/pull/2215)) — Unified design tokens, fixed 42+ orphan variable references, fully themed LoginPage and TilesetSelector (thanks @ascendr)
- **Clarify Node Hops Calculation docs** ([#2211](https://github.com/Yeraze/meshmonitor/pull/2211)) — Document that "All messages" uses all packet types
- **Enhanced bug report template** ([#2209](https://github.com/Yeraze/meshmonitor/pull/2209))
- **Translation updates** ([#2196](https://github.com/Yeraze/meshmonitor/pull/2196))

## [3.8.6] - 2026-03-10

## What's New

### Features
- **Configurable Analytics Provider Settings** — Add optional web analytics to your MeshMonitor instance. Supports Google Analytics (GA4), Cloudflare Web Analytics, PostHog, Plausible, Umami, Matomo, and custom scripts. Configured via the Settings tab with automatic CSP integration. [#2200](https://github.com/Yeraze/meshmonitor/pull/2200) — closes [#2198](https://github.com/Yeraze/meshmonitor/issues/2198)
- **Last Hop Filter for Packet Monitor** — Filter packets by the last relay node that forwarded them. [#2199](https://github.com/Yeraze/meshmonitor/pull/2199)
- **Analytics Documentation** — New docs page covering all supported analytics providers, configuration, CSP handling, and privacy considerations. [#2203](https://github.com/Yeraze/meshmonitor/pull/2203)

### Bug Fixes
- **Upgrade Watchdog** — Accept both `.yml` and `.yaml` extensions for Docker Compose files, fixing auto-upgrade failures for some users. [#2201](https://github.com/Yeraze/meshmonitor/pull/2201) — closes [#2197](https://github.com/Yeraze/meshmonitor/issues/2197)
- **Packet Monitor UI** — Improve button contrast and detail popup readability. [#2195](https://github.com/Yeraze/meshmonitor/pull/2195)
- **Virtual Node** — Match physical radio's channel protobuf encoding exactly. [#2193](https://github.com/Yeraze/meshmonitor/pull/2193)
- **Virtual Node Config** — Only suppress duplicate `wantConfigId` requests, not new ones. [#2192](https://github.com/Yeraze/meshmonitor/pull/2192) — closes [#2191](https://github.com/Yeraze/meshmonitor/issues/2191)
- **Dashboard Widgets** — Filter empty distance buckets from dashboard widgets. [#2190](https://github.com/Yeraze/meshmonitor/pull/2190)
- **Message Queue** — Fix message queue service bugs and unskip all tests. [#2189](https://github.com/Yeraze/meshmonitor/pull/2189)

### Performance
- **Batch SQL Operations** — Convert N+1 delete loops to batch DELETE operations and optimize COUNT queries. [#2187](https://github.com/Yeraze/meshmonitor/pull/2187), [#2188](https://github.com/Yeraze/meshmonitor/pull/2188)
- **SQL COUNT Optimization** — Use SQL `COUNT(*)` instead of loading entire tables for count queries. [#2185](https://github.com/Yeraze/meshmonitor/pull/2185)

### Other
- Translations update from Hosted Weblate. [#2168](https://github.com/Yeraze/meshmonitor/pull/2168)
- Remove unused legacy functions from meshtasticManager.ts. [#2186](https://github.com/Yeraze/meshmonitor/pull/2186)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.8.5...v3.8.6

## [3.8.5] - 2026-03-09

## What's New

### Features
- **Packet Monitor as Sidebar Tab** — The Packet Monitor is now available as a dedicated sidebar tab in addition to the map panel ([#2180](https://github.com/Yeraze/meshmonitor/pull/2180), closes [#2179](https://github.com/Yeraze/meshmonitor/issues/2179))
- **Dedicated Packet Monitor Permission** — New `packetmonitor:read` permission controls access to the Packet Monitor. Packets are filtered server-side based on channel and DM permissions ([#2181](https://github.com/Yeraze/meshmonitor/pull/2181))
- **Dashboard Widgets** — Added hop distribution, distance distribution, and heatmap dashboard widgets ([#2164](https://github.com/Yeraze/meshmonitor/pull/2164), closes [#2162](https://github.com/Yeraze/meshmonitor/issues/2162))

### Bug Fixes
- **Virtual Node config loop** — Fixed config request loop caused by cached rebooted messages ([#2182](https://github.com/Yeraze/meshmonitor/pull/2182))
- **MeshCore contacts** — Fixed contacts not auto-updating on map and monitor page ([#2165](https://github.com/Yeraze/meshmonitor/pull/2165))
- **Backup modal UI** — Wider modal, styled buttons, improved spacing ([#2163](https://github.com/Yeraze/meshmonitor/pull/2163))
- **Mobile message input** — Full-width text input with buttons below ([#2161](https://github.com/Yeraze/meshmonitor/pull/2161))

### Performance
- **SQL COUNT optimization** — Use `COUNT(*)` instead of loading entire tables for count queries ([#2185](https://github.com/Yeraze/meshmonitor/pull/2185))
- **Batch DELETE operations** — Convert N+1 delete loops to batch DELETE statements ([#2187](https://github.com/Yeraze/meshmonitor/pull/2187))

### Maintenance
- Removed 1,182 lines of unused legacy functions from meshtasticManager.ts ([#2186](https://github.com/Yeraze/meshmonitor/pull/2186))
- Removed debug leftovers and fixed desktop version ([#2183](https://github.com/Yeraze/meshmonitor/pull/2183))
- Added tested hardware configurations documentation ([#2166](https://github.com/Yeraze/meshmonitor/pull/2166), [#2167](https://github.com/Yeraze/meshmonitor/pull/2167))
- Translation updates from Weblate ([#2128](https://github.com/Yeraze/meshmonitor/pull/2128))

### Dependency Updates
- mysql2 3.18.2 → 3.19.0 ([#2178](https://github.com/Yeraze/meshmonitor/pull/2178))
- express-rate-limit 8.2.1 → 8.3.0 ([#2177](https://github.com/Yeraze/meshmonitor/pull/2177))
- pg 8.19.0 → 8.20.0 ([#2176](https://github.com/Yeraze/meshmonitor/pull/2176))
- recharts 3.7.0 → 3.8.0 ([#2175](https://github.com/Yeraze/meshmonitor/pull/2175))
- puppeteer 24.37.5 → 24.38.0 ([#2174](https://github.com/Yeraze/meshmonitor/pull/2174))
- Production dependencies group update ([#2173](https://github.com/Yeraze/meshmonitor/pull/2173))
- Development dependencies group update ([#2172](https://github.com/Yeraze/meshmonitor/pull/2172))
- docker/login-action 3 → 4 ([#2171](https://github.com/Yeraze/meshmonitor/pull/2171))
- docker/setup-buildx-action 3 → 4 ([#2170](https://github.com/Yeraze/meshmonitor/pull/2170))
- docker/setup-qemu-action 3 → 4 ([#2169](https://github.com/Yeraze/meshmonitor/pull/2169))
- actions/upload-artifact 4 → 7 ([#2094](https://github.com/Yeraze/meshmonitor/pull/2094))
- actions/download-artifact 7 → 8 ([#2095](https://github.com/Yeraze/meshmonitor/pull/2095))

### Action Required for Admins
The new `packetmonitor:read` permission is granted to all users (including Anonymous) by default. If you need to restrict Packet Monitor access, review user permissions in **Settings → Users**.

---

## System Test Results

**Test Run:** 2026-03-09

| Test Suite | Result |
|------------|--------|
| Configuration Import | ✅ PASSED |
| Quick Start Test | ✅ PASSED |
| Security Test | ✅ PASSED |
| V1 API Test | ✅ PASSED |
| Reverse Proxy Test | ✅ PASSED |
| Reverse Proxy + OIDC | ✅ PASSED |
| Virtual Node CLI Test | ✅ PASSED |
| Backup & Restore Test | ✅ PASSED |
| Database Migration Test | ✅ PASSED |
| DB Backing Consistency | ✅ PASSED |

**Unit Tests:** 139 test files, 2,938 tests passed

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.8.4...v3.8.5

## [3.8.4] - 2026-03-08

# MeshMonitor v3.8.4

MeshCore hotfix release.

## What's Changed

### Bug Fixes
- fix: add defensive guards to MeshCore node rendering (#2158) — Closes #2157
- fix: MeshCore repeater serial protocol — three bugs (#2159)

### Details

**MeshCore Nodes crash (#2158):**
Enabling "Show MeshCore" on the Nodes page crashed when contacts had `null` SNR/RSSI values. Added type validation in `mapContactsToNodes()` and defensive guards in the render path.

**MeshCore Repeater protocol (#2159)** — contributed by @NearlCrews:
Three bugs prevented `MESHCORE_FIRMWARE_TYPE=repeater` from working:
- `firmwareType` env var was ignored when connecting via API
- Wrong line terminator (`\n` instead of `\r`) caused repeater to ignore all commands
- Missing wake-up sequence and wrong response parsing for repeater CLI format

### Issues Resolved
- #2157 — [BUG] Connecting Meshcore device results to "Nodes failed to Load" error

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.8.3...v3.8.4

## [3.8.3] - 2026-03-08

# MeshMonitor v3.8.3

## What's Changed

### Bug Fixes
- fix: resolve MeshCore display issues on Nodes page (#2151) — Closes #2154
- fix: enable receiving incoming messages on MeshCore companion devices (#2150) — Closes #2149

### Refactoring
- refactor: reorganize Settings page into focused sections (#2148)
- refactor: frontend review batch 1 — shared modal, toast theming, accessibility (#2152)
- refactor: frontend review batch 2 — design tokens, CSS split, lucide icons (#2153)
- refactor: frontend review batch 3 — error boundaries, context splitting (#2155)

### Features
- feat: add favorite lock toggle and filter (#2147)

### Documentation
- docs: add better-sqlite3 rebuild troubleshooting to LXC guide (#2146)

### Issues Resolved
- #2149 — [BUG] Meshcore Messaging only sends but cannot receive
- #2154 — [BUG] Telemetry Dashboard Search Broken

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.8.2...v3.8.3

## [3.8.2] - 2026-03-07

## What's Changed

### New Features
- **Chat auto-scroll to new messages** — When near the bottom of a chat, new incoming messages automatically scroll the view. Works for both channel messages and DMs. Also adds a "Jump to Bottom" button to the DM tab. ([#2143](https://github.com/Yeraze/meshmonitor/pull/2143), [#2142](https://github.com/Yeraze/meshmonitor/issues/2142))

### Bug Fixes
- **Fix lock icon on auto-favorites** — Auto-favorited nodes no longer show a lock icon; only manually-locked favorites display 🔒 ([#2144](https://github.com/Yeraze/meshmonitor/pull/2144))
- **Enable save for Dim Inactive Nodes settings** — Fix save button not enabling when changing dim inactive node settings ([#2140](https://github.com/Yeraze/meshmonitor/pull/2140), [#2138](https://github.com/Yeraze/meshmonitor/issues/2138))
- **Normalize homoglyphs in autoresponder matching** — Autoresponder now matches messages with homoglyph characters ([#2137](https://github.com/Yeraze/meshmonitor/pull/2137), [#2136](https://github.com/Yeraze/meshmonitor/issues/2136))

### Other
- docs: fix outdated paths and values in ARCHITECTURE_LESSONS.md ([#2139](https://github.com/Yeraze/meshmonitor/pull/2139))
- chore: bump version to 3.8.2 ([#2145](https://github.com/Yeraze/meshmonitor/pull/2145))


## [3.8.1] - 2026-03-05

## What's Changed

### New Features
- **Time Offset Security Detection** — Detect and flag mesh nodes whose clock is significantly out of sync (default threshold: 30 minutes, configurable via `TIME_OFFSET_THRESHOLD_MINUTES` env var). Displays in a new "Time Offset" section on the Security tab with human-readable offset and the node's reported time. ([#2130](https://github.com/Yeraze/meshmonitor/pull/2130))
- **LOG_LEVEL environment variable** — Configure server log verbosity via environment variable ([#2124](https://github.com/Yeraze/meshmonitor/pull/2124))

### Bug Fixes
- **Suppress ghost node resurrection after reboot** — Prevents nodes from reappearing after server restart ([#2129](https://github.com/Yeraze/meshmonitor/pull/2129), [#2123](https://github.com/Yeraze/meshmonitor/issues/2123))
- **Resolve test upgrade staying pending with Invalid Date** — Fix firmware upgrade test getting stuck ([#2127](https://github.com/Yeraze/meshmonitor/pull/2127), [#2125](https://github.com/Yeraze/meshmonitor/issues/2125))

### Other
- Translated using Weblate (Russian) ([#2069](https://github.com/Yeraze/meshmonitor/pull/2069))
- Bump version to 3.8.1 ([#2131](https://github.com/Yeraze/meshmonitor/pull/2131))

## [3.8.0] - 2026-03-04

## MeshMonitor v3.8.0

### Highlights

**Gateway OTA Firmware Updates (Experimental)** — Administrators can now check for, download, and flash Meshtastic firmware updates directly from the MeshMonitor UI via a step-by-step wizard in System Settings. Supports Stable, Alpha, and custom firmware URLs with automatic config backup, live progress streaming, and hardware-matched binary selection. Docker deployments only.

### New Features

- **Gateway OTA firmware updates** ([#2110](https://github.com/Yeraze/meshmonitor/pull/2110)) — Closes [#2108](https://github.com/Yeraze/meshmonitor/issues/2108)
- **Bell and position broadcast buttons** ([#2117](https://github.com/Yeraze/meshmonitor/pull/2117)) — Closes [#2113](https://github.com/Yeraze/meshmonitor/issues/2113), [#2114](https://github.com/Yeraze/meshmonitor/issues/2114)

### Bug Fixes

- **Disable OTA firmware updates on Tauri desktop builds** ([#2120](https://github.com/Yeraze/meshmonitor/pull/2120))
- **Prevent auto-favorites from overriding manual favorites** ([#2115](https://github.com/Yeraze/meshmonitor/pull/2115)) — Closes [#2111](https://github.com/Yeraze/meshmonitor/issues/2111)

### Documentation

- **Message delivery status icon documentation and confirmed CSS fix** ([#2121](https://github.com/Yeraze/meshmonitor/pull/2121)) — Closes [#2118](https://github.com/Yeraze/meshmonitor/issues/2118)
- **Add Utilization Alert to user scripts gallery** ([#2112](https://github.com/Yeraze/meshmonitor/pull/2112)) — Closes [#2109](https://github.com/Yeraze/meshmonitor/issues/2109)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.7.6...v3.8.0

## [3.7.6] - 2026-03-02

## What's Changed

### Bug Fixes
- **Accept new nodeNum on same-device reboot** — when firmware reboots with a different nodeNum, MeshMonitor now accepts it and merges the old node's metadata instead of rejecting it. The old approach caused identity mismatches where MeshMonitor used the old nodeNum while the firmware broadcast on the new one ([#2106](https://github.com/Yeraze/meshmonitor/pull/2106))
- **Fix isLocked desync for node names changed outside MeshMonitor** — node names changed via the Meshtastic app (or after factory reset) are now properly picked up. The `isLocked` flag was incorrectly blocking NodeInfo updates, the authoritative source for node identity ([#2106](https://github.com/Yeraze/meshmonitor/pull/2106))
- **Prevent duplicate outgoing messages in chat** ([#2104](https://github.com/Yeraze/meshmonitor/pull/2104)) — closes [#2027](https://github.com/Yeraze/meshmonitor/issues/2027)

### New Features
- **Per-node cooldown for geofence triggers** — prevent repeated geofence alerts for the same node within a configurable time window ([#2105](https://github.com/Yeraze/meshmonitor/pull/2105)) — closes [#2103](https://github.com/Yeraze/meshmonitor/issues/2103)

### Dependencies
- Bump mysql2 from 3.17.4 to 3.18.2 ([#2102](https://github.com/Yeraze/meshmonitor/pull/2102))
- Bump maplibre-gl from 5.18.0 to 5.19.0 ([#2101](https://github.com/Yeraze/meshmonitor/pull/2101))
- Bump @types/supertest from 6.0.3 to 7.2.0 ([#2100](https://github.com/Yeraze/meshmonitor/pull/2100))
- Bump pg and @types/pg ([#2099](https://github.com/Yeraze/meshmonitor/pull/2099))
- Bump globals from 17.3.0 to 17.4.0 ([#2098](https://github.com/Yeraze/meshmonitor/pull/2098))
- Bump production-dependencies group with 4 updates ([#2097](https://github.com/Yeraze/meshmonitor/pull/2097))
- Bump development-dependencies group with 3 updates ([#2096](https://github.com/Yeraze/meshmonitor/pull/2096))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.7.5...v3.7.6


## [3.7.5] - 2026-03-02

## What's Changed

### New Features
- **Resizable node list sidebar** — drag to resize the sidebar to your preference ([#2079](https://github.com/Yeraze/meshmonitor/pull/2079))
- **Multi-channel AutoAnnounce and AutoResponder** — configure automation on any channel, not just primary ([#2078](https://github.com/Yeraze/meshmonitor/pull/2078))
- **Search filtered by user permissions** — search results now respect channel/resource permissions ([#2090](https://github.com/Yeraze/meshmonitor/pull/2090))
- **Purge position history** — new action to clear position history for a node, plus taller actions dropdown ([#2086](https://github.com/Yeraze/meshmonitor/pull/2086)) — closes [#2082](https://github.com/Yeraze/meshmonitor/issues/2082)
- **Dedicated chat bubble theme variables** — improved text contrast and theming support for chat bubbles ([#2088](https://github.com/Yeraze/meshmonitor/pull/2088)) — closes [#2084](https://github.com/Yeraze/meshmonitor/issues/2084)

### Bug Fixes
- **Prevent ghost duplicate node on reboot** — fix for devices that reboot with a different nodeNum creating phantom entries ([#2091](https://github.com/Yeraze/meshmonitor/pull/2091))
- **Exclude MQTT-bridged nodes from auto-favourite** — nodes with 0 hops via MQTT are no longer auto-favourited ([#2087](https://github.com/Yeraze/meshmonitor/pull/2087)) — closes [#2085](https://github.com/Yeraze/meshmonitor/issues/2085)
- **Sort dropdown overflow with long translations** — fix sidebar overflow with long i18n strings ([#2083](https://github.com/Yeraze/meshmonitor/pull/2083)) — closes [#2081](https://github.com/Yeraze/meshmonitor/issues/2081)
- **Allow commas in embed allowed origins** — input field now correctly accepts comma-separated origins ([#2077](https://github.com/Yeraze/meshmonitor/pull/2077))

### Maintenance
- **Extract channel checkbox inline styles to CSS classes** ([#2089](https://github.com/Yeraze/meshmonitor/pull/2089))
- **Replace trivy-action with direct Trivy install** for security scan CI ([#2080](https://github.com/Yeraze/meshmonitor/pull/2080))
- **Stop system tests from rebuilding Docker image redundantly** — eliminates redundant builds and potential BuildKit cache corruption ([#2092](https://github.com/Yeraze/meshmonitor/pull/2092))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.7.4...v3.7.5

## [3.7.4] - 2026-02-28

## What's Changed

### Bug Fixes
- fix: allow any origin when embed allowedOrigins is blank (#2075) — Closes #2070
- fix: prevent stale position broadcasts from overwriting fixed position (#2071)
- fix: add embed.html to armv7 Dockerfile (#2067)
- fix: use --entrypoint in Docker smoke tests (#2068)

### Documentation
- docs: exclude design plans from published docs (#2074)
- docs: fix embed maps URL examples to match actual route (#2072)

### Issues Resolved
- #2070 [SUPPORT] Embed Maps
- #2065 v3.7.3 isn't tagged with latest

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.7.3...v3.7.4

## [3.7.3] - 2026-02-28

## MeshMonitor v3.7.3

### New Features

- **Embeddable Map Widgets** — Share a live view of your mesh network on any website via `<iframe>`. Create embed profiles with channel filters, map defaults, and allowed origins. Includes hop-colored markers, rich popups, neighbor info lines, traceroute paths, and CSP-secured origins. [#2055](https://github.com/Yeraze/meshmonitor/pull/2055)
- **Unified Message Search** — Search across all channels, DMs, and MeshCore messages with Ctrl+K / Cmd+K. Filter by sender, channel, date range, and scope. Click any result to jump to the message with highlight animation. REST API available at `GET /api/v1/messages/search`. [#2061](https://github.com/Yeraze/meshmonitor/pull/2061)

### Bug Fixes

- fix: persist Node Hops Calculation and Dim Inactive Nodes settings [#2049](https://github.com/Yeraze/meshmonitor/pull/2049) — closes [#2048](https://github.com/Yeraze/meshmonitor/issues/2048)
- fix: payload_size calculation to include encrypted payload [#2052](https://github.com/Yeraze/meshmonitor/pull/2052)
- fix: auto-welcome DMs send once and mark node immediately [#2057](https://github.com/Yeraze/meshmonitor/pull/2057) — closes [#2054](https://github.com/Yeraze/meshmonitor/issues/2054)
- fix: don't render false direct-line segment for unknown return path [#2058](https://github.com/Yeraze/meshmonitor/pull/2058) — closes [#2051](https://github.com/Yeraze/meshmonitor/issues/2051)
- fix: auto-assign IDs to geofence/timer triggers missing them [#2062](https://github.com/Yeraze/meshmonitor/pull/2062) — closes [#2059](https://github.com/Yeraze/meshmonitor/issues/2059)
- fix: add embed.html to armv7 Dockerfile [#2067](https://github.com/Yeraze/meshmonitor/pull/2067)
- fix: use --entrypoint in Docker smoke tests [#2068](https://github.com/Yeraze/meshmonitor/pull/2068)

### Improvements

- refactor: convert NodesTab sidebar from floating overlay to anchored sidebar [#2060](https://github.com/Yeraze/meshmonitor/pull/2060)
- Remove unused node-specific packet distribution endpoint [#2053](https://github.com/Yeraze/meshmonitor/pull/2053)

### Documentation & CI

- docs: update README for accuracy with current feature set [#2043](https://github.com/Yeraze/meshmonitor/pull/2043)
- docs: add screenshots to feature documentation pages [#2044](https://github.com/Yeraze/meshmonitor/pull/2044)
- docs: add animated hero carousel to landing page [#2045](https://github.com/Yeraze/meshmonitor/pull/2045)
- docs: add Embed Maps feature documentation [#2056](https://github.com/Yeraze/meshmonitor/pull/2056)
- ci: add post-build smoke test for Docker images [#2047](https://github.com/Yeraze/meshmonitor/pull/2047) — closes [#2046](https://github.com/Yeraze/meshmonitor/issues/2046)
- test: add settings persistence round-trip coverage [#2050](https://github.com/Yeraze/meshmonitor/pull/2050)

### Issues Resolved

- [#1976](https://github.com/Yeraze/meshmonitor/issues/1976) — Linux Raspbian baremetal; Node = v25.6.0
- [#2046](https://github.com/Yeraze/meshmonitor/issues/2046) — arm64 Docker image for 3.7.0 contains 0-byte files
- [#2048](https://github.com/Yeraze/meshmonitor/issues/2048) — UI Settings not persistent
- [#2051](https://github.com/Yeraze/meshmonitor/issues/2051) — Received traceroute request generates false return segment
- [#2054](https://github.com/Yeraze/meshmonitor/issues/2054) — Auto-welcome DMs send 3x and never mark node as welcomed
- [#2059](https://github.com/Yeraze/meshmonitor/issues/2059) — Geofence exit events never fire when entry+exit triggers lack IDs


## [3.7.2] - 2026-02-26

## What's Changed

### Security
- **Enforce channel-based permission checks on telemetry and position endpoints** — Anonymous and limited users can no longer fetch telemetry or position data for nodes on channels they don't have `viewOnMap` permission for. Closes AUTHZ-VULN-02 from the Shannon pentest. ([#2038](https://github.com/Yeraze/meshmonitor/pull/2038))
- **Regenerate session after authentication to prevent session fixation** ([#2034](https://github.com/Yeraze/meshmonitor/pull/2034))

### Features
- **Exchange Position with selectable channel** — Users can now choose which channel to send position exchange requests on. ([#2026](https://github.com/Yeraze/meshmonitor/pull/2026), closes [#2021](https://github.com/Yeraze/meshmonitor/issues/2021))
- **Light/dark overlay color schemes for map elements** — Map overlays now respect the current theme. ([#2028](https://github.com/Yeraze/meshmonitor/pull/2028), closes [#2020](https://github.com/Yeraze/meshmonitor/issues/2020))
- **Add Watch and Reboot + Home Assistant Bridge to user scripts gallery** — Two new community scripts from @maxhayim. ([#2039](https://github.com/Yeraze/meshmonitor/pull/2039), closes [#2035](https://github.com/Yeraze/meshmonitor/issues/2035), [#2036](https://github.com/Yeraze/meshmonitor/issues/2036))

### Bug Fixes
- **AutoAnnounce channel selection ignores disabled channels** ([#2025](https://github.com/Yeraze/meshmonitor/pull/2025), closes [#2024](https://github.com/Yeraze/meshmonitor/issues/2024))
- **Duplicate outgoing messages in chat** ([#2029](https://github.com/Yeraze/meshmonitor/pull/2029), closes [#2027](https://github.com/Yeraze/meshmonitor/issues/2027))
- **Deploy upgrade watchdog to legacy path for backward compat** ([#2030](https://github.com/Yeraze/meshmonitor/pull/2030), closes [#1888](https://github.com/Yeraze/meshmonitor/issues/1888))
- **Reduce node load to prevent firmware heap exhaustion** ([#2031](https://github.com/Yeraze/meshmonitor/pull/2031), closes [#2013](https://github.com/Yeraze/meshmonitor/issues/2013))
- **Poll interval now respects WebSocket connection state internally** ([#2032](https://github.com/Yeraze/meshmonitor/pull/2032))
- **Position precision accuracy was 2x off from Meshtastic documentation** — The accuracy estimate displayed for precision bits (both in the info panel and on the map rectangle) was double the correct value. Now matches Meshtastic docs exactly. ([#2040](https://github.com/Yeraze/meshmonitor/pull/2040), closes [#2037](https://github.com/Yeraze/meshmonitor/issues/2037))
- **Fix CSRF token invalidation in system tests** — After the session fixation fix, system tests needed to re-fetch the CSRF token post-login. ([#2042](https://github.com/Yeraze/meshmonitor/pull/2042))

### Translations
- Russian translation updates via Weblate ([#2033](https://github.com/Yeraze/meshmonitor/pull/2033), [#2041](https://github.com/Yeraze/meshmonitor/pull/2041))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.7.1...v3.7.2

## [3.7.1] - 2026-02-25

## MeshMonitor v3.7.1

Hotfix release for Auto Favorite settings persistence.

### Bug Fixes

- **Auto Favorite settings not persisting after save** — The Auto Favorite toggle would revert to disabled immediately after saving. The `autoFavoriteEnabled` and `autoFavoriteStaleHours` settings keys were missing from the `validKeys` allowlist in the POST `/api/settings` endpoint, causing them to be silently dropped. ([#2023](https://github.com/Yeraze/meshmonitor/pull/2023))

### Issues Resolved

- [#2022](https://github.com/Yeraze/meshmonitor/issues/2022) — Auto Favorite toggle does not persist (reverts to disabled after saving)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.7.0...v3.7.1

## [3.7.0] - 2026-02-25

## What's New

### Auto Favorite Automation ([#2018](https://github.com/Yeraze/meshmonitor/pull/2018))

Automatically favorite eligible nearby nodes for [zero-cost hop routing](https://meshtastic.org/blog/zero-cost-hops-favorite-routers/) on Meshtastic firmware 2.7+. When enabled on a **Router**, **Router Late**, or **Client Base** node, MeshMonitor detects 0-hop nodes and favorites them on your device — preserving hop counts across your mesh infrastructure without manual configuration.

- **Event-driven**: Nodes are favorited as soon as they are detected
- **Periodic cleanup**: Stale, out-of-range, or ineligible nodes are automatically unfavorited (configurable threshold, default 72h)
- **Manual favorites are never touched** — only auto-managed nodes are swept
- New **Auto Favorite** section in the Automation tab with enable toggle, staleness threshold, and status banners

### Other Features

- **Position precision accuracy estimates** — Channel UI now shows estimated accuracy for position precision settings ([#2008](https://github.com/Yeraze/meshmonitor/pull/2008))
- **Location indicators on all channels** — All location-enabled channels now show location sharing indicators ([#2007](https://github.com/Yeraze/meshmonitor/pull/2007))

## Bug Fixes

- **Packet routes** — Use async DB methods for PostgreSQL/MySQL compatibility ([#2016](https://github.com/Yeraze/meshmonitor/pull/2016))
- **Duplicate chat messages** — Prevented duplicate outgoing messages in chat ([#2012](https://github.com/Yeraze/meshmonitor/issues/2012), [#2015](https://github.com/Yeraze/meshmonitor/pull/2015))
- **Map position updates** — Fixed position updates for mobile/tracker nodes and a WebSocket position bug ([#2014](https://github.com/Yeraze/meshmonitor/pull/2014))
- **Homoglyph byte count** — Corrected optimized byte count display when homoglyph setting is enabled ([#2009](https://github.com/Yeraze/meshmonitor/pull/2009))

## Maintenance

- Clean up root markdown files ([#2011](https://github.com/Yeraze/meshmonitor/pull/2011))
- Bump production dependencies ([#1992](https://github.com/Yeraze/meshmonitor/pull/1992))
- Bump rollup dependencies ([#1993](https://github.com/Yeraze/meshmonitor/pull/1993), [#1996](https://github.com/Yeraze/meshmonitor/pull/1996))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.6.6...v3.7.0

## [3.6.6] - 2026-02-23

## What's Changed

### Features
- **Add homoglyph message optimization setting** — New setting to enable homoglyph character normalization for message display. Fixes [#1997](https://github.com/Yeraze/meshmonitor/issues/1997) ([#2000](https://github.com/Yeraze/meshmonitor/pull/2000))
- **Add HAM Licensed checkbox to Node Identity settings** — Restores the missing HAM license checkbox in node identity configuration. Fixes [#1998](https://github.com/Yeraze/meshmonitor/issues/1998) ([#1999](https://github.com/Yeraze/meshmonitor/pull/1999))
- **Add location sharing status to channel overview** — Channel overview now shows whether location sharing is enabled per channel. Fixes [#1985](https://github.com/Yeraze/meshmonitor/issues/1985) ([#1986](https://github.com/Yeraze/meshmonitor/pull/1986))

### Bug Fixes
- **Fix rate limiter IPv4-mapped IPv6 subnet masking** — All IPv4 clients were sharing a single rate limit bucket because the default `ipKeyGenerator` applied a `/56` subnet mask to `::ffff:x.x.x.x` addresses, zeroing out the IPv4 data. Each IPv4 client now gets its own bucket. Fixes [#1980](https://github.com/Yeraze/meshmonitor/issues/1980) ([#2001](https://github.com/Yeraze/meshmonitor/pull/2001))
- **Fix NodeInfo broadcasting settings not saving** — Added NodeInfo broadcast settings to the validKeys whitelist so they persist correctly. Fixes [#1989](https://github.com/Yeraze/meshmonitor/issues/1989) ([#1990](https://github.com/Yeraze/meshmonitor/pull/1990))

### Documentation
- **Add Community Add-ons section** — New documentation for community add-ons including the AI Responder ([#1987](https://github.com/Yeraze/meshmonitor/pull/1987))

### Dependencies
- Bump @typescript-eslint/eslint-plugin from 8.55.0 to 8.56.0 ([#1994](https://github.com/Yeraze/meshmonitor/pull/1994))
- Bump development dependencies group with 2 updates ([#1991](https://github.com/Yeraze/meshmonitor/pull/1991))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.6.5...v3.6.6


## [3.6.5] - 2026-02-21

## What's Changed

### Features
- **Allow disabling rate limits via environment variables** — Set `RATE_LIMIT_API`, `RATE_LIMIT_AUTH`, or `RATE_LIMIT_MESSAGES` to `unlimited`, `0`, or `-1` to disable rate limiting for users behind authenticating reverse proxies or on private networks ([#1981](https://github.com/Yeraze/meshmonitor/pull/1981))

### Bug Fixes
- **Fix ignored_nodes.nodeNum BIGINT overflow** — Upgraded `ignored_nodes.nodeNum` from INTEGER to BIGINT for PostgreSQL/MySQL to support full unsigned 32-bit Meshtastic node numbers. Fixes [#1973](https://github.com/Yeraze/meshmonitor/issues/1973) ([#1975](https://github.com/Yeraze/meshmonitor/pull/1975))
- **Fix telemetry icons flickering on map load** — Prevent telemetry cache invalidation from clearing cached data, preserving stale data over empty data during cache transitions ([#1974](https://github.com/Yeraze/meshmonitor/pull/1974))
- **Fix auto-upgrade sidecar port mapping loss** — Simplified the auto-upgrade sidecar script to prevent Docker port mappings from being lost during upgrades ([#1977](https://github.com/Yeraze/meshmonitor/pull/1977))
- **Fix nodes with default shortName falsely classified as incomplete** — Nodes using the default Meshtastic short name are no longer hidden by the "hide incomplete nodes" filter ([#1972](https://github.com/Yeraze/meshmonitor/pull/1972))
- **Fix filter popup Reset All button** — The Reset All button in the filter popup now correctly resets all filters ([#1971](https://github.com/Yeraze/meshmonitor/pull/1971))
- **Fix premature new node notifications** — New node notifications are now deferred until node info is fully populated, preventing notifications with missing data ([#1970](https://github.com/Yeraze/meshmonitor/pull/1970))
- **Fix map preference persistence** — `showAccuracyRegions` and `showEstimatedPositions` map settings now persist across page reloads ([#1969](https://github.com/Yeraze/meshmonitor/pull/1969))
- **Remove incorrect "Desktop Only" label from packet monitor** — The packet monitor works on all platforms, not just desktop ([#1983](https://github.com/Yeraze/meshmonitor/pull/1983))
- **Fix MySQL migration idempotency** — Fixed MySQL migrations 061 and 077 to correctly detect existing columns and avoid duplicate column/primary key errors ([#1982](https://github.com/Yeraze/meshmonitor/pull/1982))

### CI/Infrastructure
- **Add Node.js 25.x to CI test matrix** ([#1979](https://github.com/Yeraze/meshmonitor/pull/1979))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.6.4...v3.6.5

## [3.6.4] - 2026-02-20

## What's Changed

### Bug Fixes
- Upgrade telemetry packetId to BIGINT for PostgreSQL/MySQL ([#1967](https://github.com/Yeraze/meshmonitor/pull/1967)) - Fixes [#1964](https://github.com/Yeraze/meshmonitor/issues/1964)
- Resolve MySQL/PostgreSQL node loss during init config sync ([#1965](https://github.com/Yeraze/meshmonitor/pull/1965))
- Pre-populate MeshCore connection form from env vars ([#1963](https://github.com/Yeraze/meshmonitor/pull/1963)) - Fixes [#1960](https://github.com/Yeraze/meshmonitor/issues/1960)
- Replace GPL session store and add MySQL URL detection ([#1961](https://github.com/Yeraze/meshmonitor/pull/1961))
- Add processing delays to config import for reliable LoRa preset application ([#1958](https://github.com/Yeraze/meshmonitor/pull/1958))
- Add DHCP client and networking service enablement to LXC template ([#1956](https://github.com/Yeraze/meshmonitor/pull/1956))

### Tests
- Add database backing consistency test across SQLite/PostgreSQL/MySQL ([#1966](https://github.com/Yeraze/meshmonitor/pull/1966))
- Fix flaky DB backing consistency test node count check ([#1968](https://github.com/Yeraze/meshmonitor/pull/1968))

### Other
- Fix inaccuracies in Proxmox LXC deployment guide ([#1957](https://github.com/Yeraze/meshmonitor/pull/1957))
- Translations update from Hosted Weblate - Russian ([#1959](https://github.com/Yeraze/meshmonitor/pull/1959))

### Issues Resolved
- [#1964](https://github.com/Yeraze/meshmonitor/issues/1964) - Telemetry insert failures on PostgreSQL due to packetId overflow
- [#1960](https://github.com/Yeraze/meshmonitor/issues/1960) - MeshCore connection settings not pre-populated from env vars

## [3.6.3] - 2026-02-19

## What's Changed

### Features
- Differentiate own vs others' tapback reactions by color ([#1950](https://github.com/Yeraze/meshmonitor/pull/1950))

### Bug Fixes
- Add networking support to LXC template ([#1954](https://github.com/Yeraze/meshmonitor/pull/1954)) - Fixes [#1672](https://github.com/Yeraze/meshmonitor/issues/1672)
- Consistent map pin click centering and popup positioning ([#1953](https://github.com/Yeraze/meshmonitor/pull/1953))
- Use actual data tables for node packet type distribution ([#1952](https://github.com/Yeraze/meshmonitor/pull/1952))
- Increase auto-responder script timeout from 10s to 30s ([#1942](https://github.com/Yeraze/meshmonitor/pull/1942))

### Performance
- Add server-side in-memory cache for link previews ([#1944](https://github.com/Yeraze/meshmonitor/pull/1944))

### Other
- Update deployment guide for accuracy ([#1946](https://github.com/Yeraze/meshmonitor/pull/1946))
- Clean up LXC template build workflow release notes ([#1945](https://github.com/Yeraze/meshmonitor/pull/1945))
- Translations update from Hosted Weblate - Russian ([#1943](https://github.com/Yeraze/meshmonitor/pull/1943))

### Issues Resolved
- [#1672](https://github.com/Yeraze/meshmonitor/issues/1672) - LXC deployment image/scenario on PM 9.1
- [#1929](https://github.com/Yeraze/meshmonitor/issues/1929) - Short name incorrect
- [#1934](https://github.com/Yeraze/meshmonitor/issues/1934) - Stations with icons as short name don't update on map
- [#1936](https://github.com/Yeraze/meshmonitor/issues/1936) - Rounding to integers in graphs is still not fully fixed
- [#1949](https://github.com/Yeraze/meshmonitor/issues/1949) - Window off screen again
- [#1951](https://github.com/Yeraze/meshmonitor/issues/1951) - Traceroute results

## [3.6.2] - 2026-02-18

## What's Changed in v3.6.2

### Bug Fixes

- **fix: hide Show MeshCore toggle when disabled and persist its state** - The "Show MeshCore" checkbox in the map Features panel was always visible regardless of `MESHCORE_ENABLED` setting, and its state was never saved. Now properly hidden when MeshCore is disabled and persists across page loads. ([#1940](https://github.com/Yeraze/meshmonitor/pull/1940))
- **fix: prevent fractional values in integer telemetry graphs** ([#1939](https://github.com/Yeraze/meshmonitor/pull/1939), [#1936](https://github.com/Yeraze/meshmonitor/issues/1936))
- **fix: memoize map marker icons to prevent position update interference** ([#1938](https://github.com/Yeraze/meshmonitor/pull/1938))
- **fix: render emoji short names as HTML overlay on map markers** ([#1937](https://github.com/Yeraze/meshmonitor/pull/1937), [#1934](https://github.com/Yeraze/meshmonitor/issues/1934))
- **fix: add BASE_URL support to MeshCore API endpoints** ([#1935](https://github.com/Yeraze/meshmonitor/pull/1935))
- **fix: derive short name from last 4 hex chars of node ID to match Meshtastic convention** ([#1932](https://github.com/Yeraze/meshmonitor/pull/1932), [#1929](https://github.com/Yeraze/meshmonitor/issues/1929))
- **fix: position history endpoint nodeId parsing and pagination** ([#1931](https://github.com/Yeraze/meshmonitor/pull/1931))
- **fix: increase auto-responder and script test timeout from 10s to 30s** - All automation script execution paths (auto-responder, timer, geofence, and the UI "Test" popup) now use a consistent 30-second timeout. ([#1942](https://github.com/Yeraze/meshmonitor/pull/1942))

### New Features

- **feat: add V1 API position history endpoint** ([#1930](https://github.com/Yeraze/meshmonitor/pull/1930))

### Database Migration

This release includes **migration 074** which adds the `show_meshcore_nodes` column to `user_map_preferences`. This migration runs automatically on startup for SQLite, PostgreSQL, and MySQL.

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.6.1...v3.6.2

---

## [3.6.1] - 2026-02-17

## What's Changed

### Features
- Add feature emojis to `{FEATURES}` token and rename popup button ([#1923](https://github.com/Yeraze/meshmonitor/pull/1923))
- Add StatusMessage and TrafficManagement module config ([#1925](https://github.com/Yeraze/meshmonitor/pull/1925))
- Add Source filter to audit log page to separate UI vs API token events ([#1926](https://github.com/Yeraze/meshmonitor/pull/1926))

### Fixes
- Prevent MeshCore Companion corruption from repeater auto-detection ([#1924](https://github.com/Yeraze/meshmonitor/pull/1924))
- Live backend preview for auto-announce and complete feature emoji legend ([#1927](https://github.com/Yeraze/meshmonitor/pull/1927))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.6.0...v3.6.1

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.6.0] - 2026-02-16

## What's Changed

### New Features
- **Auto-Ping automation** — A new DM-command driven ping feature lets mesh users test connectivity and measure latency. Users DM `ping N` to start pings with ACK/NAK/timeout tracking and receive a summary with min/avg/max latency. Admins configure interval, max pings, and timeout in the Automation tab. ([#1917](https://github.com/Yeraze/meshmonitor/pull/1917), closes [#1894](https://github.com/Yeraze/meshmonitor/issues/1894))
- **Telemetry packet ID tracking** — Telemetry records now include `packetId` from the originating mesh packet, enabling API consumers to de-duplicate data received via multiple mesh paths. ([#1921](https://github.com/Yeraze/meshmonitor/pull/1921))

### Improvements
- **Virtual Node firmware branding** — VN connections now report firmware as `2.6.6-MM3.6.0`, identifying the connection as a Virtual Node running on MeshMonitor. ([#1920](https://github.com/Yeraze/meshmonitor/pull/1920))
- **Virtual Node channel stability** — Fixed `configComplete` broadcasts during physical radio reconnection causing VN clients to lose their channel list. Disabled channel slots (role=0) are now sent to match real device behavior. ([#1920](https://github.com/Yeraze/meshmonitor/pull/1920))
- **Poll/unread optimization** — Batch queries for `/api/poll` and `/api/unread-counts` reduce database load with MySQL support. ([#1909](https://github.com/Yeraze/meshmonitor/pull/1909))
- **Automation documentation** — Added missing docs for Auto-Ping, Auto Key Management, and Ignored Nodes. ([#1918](https://github.com/Yeraze/meshmonitor/pull/1918))

### Bug Fixes
- **Packet distribution portnum total** — Portnum filter now correctly applies to total count in the packet distribution API. ([#1919](https://github.com/Yeraze/meshmonitor/pull/1919))
- **Mobile infinite scroll** — Fixed infinite scroll and always-visible virtual channels on mobile. ([#1907](https://github.com/Yeraze/meshmonitor/pull/1907), closes [#1908](https://github.com/Yeraze/meshmonitor/issues/1908))
- **Hide accuracy region for overridden positions** — Position accuracy indicators no longer show for manually overridden node positions. ([#1910](https://github.com/Yeraze/meshmonitor/pull/1910))

### Dependencies
- Bump serialport from 12.0.0 to 13.0.0 ([#1915](https://github.com/Yeraze/meshmonitor/pull/1915))
- Bump @serialport/parser-readline from 12.0.0 to 13.0.0 ([#1913](https://github.com/Yeraze/meshmonitor/pull/1913))
- Bump production dependencies (jose, jiti, sass, sharp) ([#1911](https://github.com/Yeraze/meshmonitor/pull/1911))
- Bump @typescript-eslint/eslint-plugin ([#1916](https://github.com/Yeraze/meshmonitor/pull/1916))
- Bump @typescript-eslint/parser from 8.54.0 to 8.55.0 ([#1912](https://github.com/Yeraze/meshmonitor/pull/1912))
- Bump jsdom from 28.0.0 to 28.1.0 ([#1914](https://github.com/Yeraze/meshmonitor/pull/1914))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.5.1...v3.6.0

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.5.1] - 2026-02-15

## What's Changed

### Bug Fixes
- **Fix remote admin for ignore/favorite node toggle** — The dedicated ignore/favorite methods now support remote nodes by obtaining session passkeys and routing via `sendAdminCommand`, matching the existing AdminCommandsTab pattern. ([#1904](https://github.com/Yeraze/meshmonitor/pull/1904), closes [#1901](https://github.com/Yeraze/meshmonitor/issues/1901))
- **Hide private key on Info page** — Private key is now hidden by default with a toggle visibility button. ([#1900](https://github.com/Yeraze/meshmonitor/pull/1900))
- **Use apprise venv python for MeshCore bridge and scripts** — Fixes script execution in environments where the system Python differs from the venv. ([#1899](https://github.com/Yeraze/meshmonitor/pull/1899))
- **Hide MeshCore sidebar when MESHCORE_ENABLED is not set** — The MeshCore sidebar entry no longer appears when the feature is disabled. ([#1893](https://github.com/Yeraze/meshmonitor/pull/1893))

### New Features
- **Per-portnum node distribution chart on Info page** — Adds more detailed statistics to the packet distribution diagrams. ([#1902](https://github.com/Yeraze/meshmonitor/pull/1902), closes [#1891](https://github.com/Yeraze/meshmonitor/issues/1891))
- **RayHunter monitor script in script gallery** — New community script for RayHunter monitoring. ([#1895](https://github.com/Yeraze/meshmonitor/pull/1895))
- **Server-node clock offset telemetry** — Tracks clock drift between the server and the connected node. ([#1889](https://github.com/Yeraze/meshmonitor/pull/1889))

### Maintenance
- **Update protobufs to v2.7.19** — Adds `TRAFFICMANAGEMENT_CONFIG` support. ([#1903](https://github.com/Yeraze/meshmonitor/pull/1903))
- **Translation updates** — Russian translations updated via Weblate. ([#1892](https://github.com/Yeraze/meshmonitor/pull/1892))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.5.0...v3.5.1

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.5.0] - 2026-02-13

## What's New

MeshMonitor v3.5.0 is a milestone release introducing **experimental MeshCore protocol support**, along with AutoTraceroute scheduling improvements, Remote Admin UI enhancements, and several bug fixes.

### Experimental MeshCore Protocol Support

MeshMonitor can now connect to **MeshCore** repeaters and clients via serial port, enabling monitoring and messaging with MeshCore-based mesh networks alongside standard Meshtastic nodes.

- **Serial port connectivity** to MeshCore repeaters and clients
- **Node discovery and tracking** for MeshCore devices on the map
- **Two-way messaging** between MeshMonitor and MeshCore nodes
- **Contact management** with automatic discovery

MeshCore support is experimental and requires a compatible MeshCore device connected via serial port. For more information, visit [meshcore.co](https://meshcore.co).

([#1777](https://github.com/Yeraze/meshmonitor/pull/1777), [#1880](https://github.com/Yeraze/meshmonitor/pull/1880))

### Features
- **AutoTraceroute & Remote Admin time window scheduling** — Restrict scans to specific hours (e.g., off-peak 22:00–06:00) with overnight wrapping support ([#1871](https://github.com/Yeraze/meshmonitor/pull/1871), [#1872](https://github.com/Yeraze/meshmonitor/pull/1872))
- **Remote Admin icon and filter on map node list** — Quickly identify and filter nodes with remote admin access ([#1868](https://github.com/Yeraze/meshmonitor/pull/1868))
- **Show successful nodes first in Remote Admin Scanner log** — Improved scan log readability ([#1870](https://github.com/Yeraze/meshmonitor/pull/1870))
- **Expand system tokens in Auto Responder HTTP URLs** — Use tokens like `{NODE_ID}`, `{SNR}`, etc. in HTTP action URLs ([#1867](https://github.com/Yeraze/meshmonitor/pull/1867), [#1865](https://github.com/Yeraze/meshmonitor/issues/1865))
- **LLM Bridge user script** — New community script for connecting LLMs to your mesh ([#1878](https://github.com/Yeraze/meshmonitor/pull/1878), [#1876](https://github.com/Yeraze/meshmonitor/issues/1876))
- **Highlight selected node during traceroute** — Pulsing glow on the selected node on the map ([#1847](https://github.com/Yeraze/meshmonitor/pull/1847))
- **Compact packet charts on Info tab** — Combined charts into compact sections ([#1846](https://github.com/Yeraze/meshmonitor/pull/1846), [#1833](https://github.com/Yeraze/meshmonitor/issues/1833))
- **Gist support for User Scripts Gallery** — Plus Earthquake Alerts script ([#1845](https://github.com/Yeraze/meshmonitor/pull/1845), [#1804](https://github.com/Yeraze/meshmonitor/issues/1804))
- **Combined BLE & WiFi paxcounter graph** — Dual-line graph ([#1843](https://github.com/Yeraze/meshmonitor/pull/1843))
- **Compact node list cards and tighter popups** ([#1842](https://github.com/Yeraze/meshmonitor/pull/1842), [#1834](https://github.com/Yeraze/meshmonitor/issues/1834))
- **Document relayNode in V1 API and serve OpenAPI spec publicly** ([#1855](https://github.com/Yeraze/meshmonitor/pull/1855))
- **Local node hint banner on Remote Admin page** ([#1854](https://github.com/Yeraze/meshmonitor/pull/1854))

### Bug Fixes
- **Tapback DM routing fix** — Tapback emoji reactions now correctly stay on the original channel instead of being sent as DMs ([#1885](https://github.com/Yeraze/meshmonitor/pull/1885))
- **Outgoing message timestamp fix** — Timestamps update to node time on ACK receipt ([#1884](https://github.com/Yeraze/meshmonitor/pull/1884), [#1877](https://github.com/Yeraze/meshmonitor/issues/1877))
- **Default auto-traceroute interval changed from 3 to 15 minutes** ([#1883](https://github.com/Yeraze/meshmonitor/pull/1883), [#1875](https://github.com/Yeraze/meshmonitor/issues/1875))
- **Persist Auto Acknowledge pattern testing text** ([#1881](https://github.com/Yeraze/meshmonitor/pull/1881), [#1879](https://github.com/Yeraze/meshmonitor/issues/1879))
- **Remove duplicate emoji from Sky and Sea Alert script name** ([#1882](https://github.com/Yeraze/meshmonitor/pull/1882))
- **AutoTraceroute schedule settings race condition** ([#1872](https://github.com/Yeraze/meshmonitor/pull/1872))
- **MFA verification broken on SQLite** — Missing columns in SELECT queries ([#1831](https://github.com/Yeraze/meshmonitor/pull/1831), [#1828](https://github.com/Yeraze/meshmonitor/issues/1828))
- **Double-issuer in MFA otpauth URI** ([#1831](https://github.com/Yeraze/meshmonitor/pull/1831))
- **Snapshot node positions at traceroute time** — Fix moving node rendering on traceroute maps ([#1864](https://github.com/Yeraze/meshmonitor/pull/1864), [#1862](https://github.com/Yeraze/meshmonitor/issues/1862))
- **Broadcast outgoing text messages to virtual node clients** ([#1863](https://github.com/Yeraze/meshmonitor/pull/1863), [#1859](https://github.com/Yeraze/meshmonitor/issues/1859))
- **Always verify auto_traceroute_nodes enabled column on startup** ([#1861](https://github.com/Yeraze/meshmonitor/pull/1861), [#1860](https://github.com/Yeraze/meshmonitor/issues/1860))
- **Improve map node popup grid layout** for consistent positioning ([#1851](https://github.com/Yeraze/meshmonitor/pull/1851), [#1841](https://github.com/Yeraze/meshmonitor/issues/1841))
- **Include network and telemetry configs in Load All button** ([#1854](https://github.com/Yeraze/meshmonitor/pull/1854), [#1852](https://github.com/Yeraze/meshmonitor/issues/1852))
- **Always show local node in Auto Time Sync node list** ([#1848](https://github.com/Yeraze/meshmonitor/pull/1848))

### Documentation
- Add MeshCore feature documentation ([#1880](https://github.com/Yeraze/meshmonitor/pull/1880))
- Add Auto Time Sync section to automation documentation ([#1874](https://github.com/Yeraze/meshmonitor/pull/1874))
- Update API docs and schema for traceroute position snapshots ([#1866](https://github.com/Yeraze/meshmonitor/pull/1866))

### Translations
- Russian translation updates via Weblate ([#1856](https://github.com/Yeraze/meshmonitor/pull/1856), [#1869](https://github.com/Yeraze/meshmonitor/pull/1869))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.9...v3.5.0

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)

---

## Installation

**Docker (recommended):**
```bash
docker run -d \
  --name meshmonitor \
  -p 8080:3001 \
  -v meshmonitor-data:/data \
  ghcr.io/yeraze/meshmonitor:3.5.0
```

**Helm:**
```bash
helm repo add meshmonitor https://yeraze.github.io/meshmonitor
helm install meshmonitor meshmonitor/meshmonitor --version 3.5.0
```

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.13] - 2026-02-12

## What's New

### Features
- **Time window schedule for Auto Traceroute & Remote Admin Scanner** — Restrict these features to specific time windows (e.g., only scan during off-peak hours 22:00-06:00). Supports overnight wrapping. ([#1871](https://github.com/Yeraze/meshmonitor/pull/1871), [#1872](https://github.com/Yeraze/meshmonitor/pull/1872))
- **Remote Admin icon and filter on map node list** — Quickly identify and filter nodes with remote admin access on the map ([#1868](https://github.com/Yeraze/meshmonitor/pull/1868))
- **Show successful nodes first in Remote Admin Scanner log** — Improved scan log readability by sorting successful results to the top ([#1870](https://github.com/Yeraze/meshmonitor/pull/1870))
- **Expand system tokens in Auto Responder HTTP URLs** — Use tokens like `{NODE_ID}`, `{SNR}`, etc. in HTTP action URLs ([#1867](https://github.com/Yeraze/meshmonitor/pull/1867), [#1865](https://github.com/Yeraze/meshmonitor/issues/1865))

### Bug Fixes
- **Snapshot node positions at traceroute time** — Fix moving node rendering on traceroute maps by capturing positions when traceroutes are recorded ([#1864](https://github.com/Yeraze/meshmonitor/pull/1864), [#1862](https://github.com/Yeraze/meshmonitor/issues/1862))
- **Broadcast outgoing text messages to virtual node clients** — Virtual node clients now receive outgoing messages ([#1863](https://github.com/Yeraze/meshmonitor/pull/1863), [#1859](https://github.com/Yeraze/meshmonitor/issues/1859))
- **Always verify auto_traceroute_nodes enabled column on startup** — Fix inability to enable auto traceroute on some installations ([#1861](https://github.com/Yeraze/meshmonitor/pull/1861), [#1860](https://github.com/Yeraze/meshmonitor/issues/1860))

### Documentation
- Update API docs and schema for traceroute position snapshots ([#1866](https://github.com/Yeraze/meshmonitor/pull/1866))

### Translations
- Russian translation updates via Weblate ([#1869](https://github.com/Yeraze/meshmonitor/pull/1869))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.12...v3.4.13

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.12] - 2026-02-11

## What's Changed

### Bug Fixes
- fix: improve map node popup grid layout for consistent positioning ([#1851](https://github.com/Yeraze/meshmonitor/pull/1851)) — closes [#1841](https://github.com/Yeraze/meshmonitor/issues/1841)
- fix: Load All button missing network and telemetry configs ([#1854](https://github.com/Yeraze/meshmonitor/pull/1854)) — closes [#1852](https://github.com/Yeraze/meshmonitor/issues/1852)
  - Include network and telemetry configs in Remote Admin "Load All" button
  - Add telemetry to local node load-config type map
  - Add local node hint banner on Remote Admin page directing to Device Configuration

### Features
- feat: document relayNode in V1 API and serve OpenAPI spec publicly ([#1855](https://github.com/Yeraze/meshmonitor/pull/1855))
  - Document `relayNode` and other undocumented fields in OpenAPI spec
  - Make `openapi.json` and `openapi.yaml` accessible without authentication

### Translations
- Translations update from Hosted Weblate — Russian ([#1856](https://github.com/Yeraze/meshmonitor/pull/1856))

### Maintenance
- chore: bump version to 3.4.12 ([#1858](https://github.com/Yeraze/meshmonitor/pull/1858))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.11...v3.4.12

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.11] - 2026-02-09

## What's Changed

### Features
- **Highlight selected node during traceroute** - Adds a pulsing glow to the selected node on the map during traceroute ([#1847](https://github.com/Yeraze/meshmonitor/pull/1847), closes [#1841](https://github.com/Yeraze/meshmonitor/issues/1841))
- **Compact packet charts on Info tab** - Combines packet charts into compact sections ([#1846](https://github.com/Yeraze/meshmonitor/pull/1846), closes [#1833](https://github.com/Yeraze/meshmonitor/issues/1833))
- **Gist support for User Scripts Gallery** - Add gist support to the gallery and include an Earthquake Alerts script ([#1845](https://github.com/Yeraze/meshmonitor/pull/1845), closes [#1804](https://github.com/Yeraze/meshmonitor/issues/1804))
- **Combined BLE & WiFi paxcounter graph** - Merge BLE and WiFi paxcounter data into a single dual-line graph ([#1843](https://github.com/Yeraze/meshmonitor/pull/1843))
- **Compact node list cards and tighter popups** - More compact node list layout and tighter map popups ([#1842](https://github.com/Yeraze/meshmonitor/pull/1842), closes [#1834](https://github.com/Yeraze/meshmonitor/issues/1834))

### Bug Fixes
- **Always show local node in Auto Time Sync node list** ([#1848](https://github.com/Yeraze/meshmonitor/pull/1848))

### Maintenance
- Fix reverse proxy and OIDC system test port mismatch (8081 → 8080) ([#1849](https://github.com/Yeraze/meshmonitor/pull/1849))

### Dependency Updates
- Bump @eslint/js from 9.39.2 to 10.0.1 ([#1840](https://github.com/Yeraze/meshmonitor/pull/1840))
- Bump jsdom from 27.4.0 to 28.0.0 ([#1839](https://github.com/Yeraze/meshmonitor/pull/1839))
- Bump puppeteer from 24.36.1 to 24.37.2 ([#1838](https://github.com/Yeraze/meshmonitor/pull/1838))
- Bump eslint from 9.39.2 to 10.0.0 ([#1837](https://github.com/Yeraze/meshmonitor/pull/1837))
- Bump production dependencies group with 5 updates ([#1836](https://github.com/Yeraze/meshmonitor/pull/1836))
- Bump development dependencies group with 2 updates ([#1835](https://github.com/Yeraze/meshmonitor/pull/1835))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.10...v3.4.11

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.10] - 2026-02-08

## MeshMonitor v3.4.10 - Hotfix: MFA verification on SQLite

### Bug Fixes

- **MFA verification broken on SQLite** (#1831) - The SQLite fallback UserModel SELECT queries were missing `mfa_enabled`, `mfa_secret`, and `mfa_backup_codes` columns, causing MFA setup verification and login to fail with a 400 error. All five query methods (`findById`, `findByUsername`, `findByOIDCSubject`, `findAll`, `findByEmail`) are now fixed.
- **Double-issuer in otpauth URI** (#1831) - The QR code for authenticator apps showed `MeshMonitor:MeshMonitor:username` instead of `MeshMonitor:username`.

### Full Changelog
- #1831 - fix: MFA verification broken on SQLite - missing columns in SELECT queries

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.9] - 2026-02-08

## v3.4.9 — Hotfix Release

This is a hotfix release addressing two bugs discovered after v3.4.8.

### Bug Fixes

- **MFA operations fail on SQLite** — Two-factor authentication setup, enable, disable, and backup code operations failed on SQLite (the default database) with "Auth repository not initialized". MFA now works correctly on all database backends. — #1829 (closes #1828)
- **News popup dismiss checkbox not persisting** — The dismiss checkbox in the news popup was not saving correctly. — #1827

### Full Changelog

https://github.com/Yeraze/meshmonitor/compare/v3.4.8...v3.4.9

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.8] - 2026-02-08

## What's New in v3.4.8

### Two-Factor Authentication (MFA)
TOTP-based two-factor authentication for user accounts. Set up with any authenticator app (Google Authenticator, Authy, etc.), with 10 single-use backup codes for recovery. Admins can disable MFA for other users if needed.

### Auto-Acknowledge Enhancements
- **Per-channel control** — enable/disable auto-ack on individual channels and direct messages
- **Tapback & text reply modes** — independent toggles for emoji reactions and text responses, each with separate direct/multi-hop settings
- **Always use DM** — send responses as direct messages even when triggered by channel messages
- **Sample message preview** — live preview of templates with example token values

### Position History Line Style
Choose between linear (straight) and spline (curved) line styles for position history tracks on the map.

### News Popup UX Improvements
Bulk dismiss, version-gated news items, and improved popup layout.

### Bug Fixes
- Fixed traceroute history always showing empty on PostgreSQL/MySQL deployments

---

## Pull Requests

- [#1815](https://github.com/Yeraze/meshmonitor/pull/1815) feat: separate Direct and Multi-hop settings for Auto Acknowledge
- [#1817](https://github.com/Yeraze/meshmonitor/pull/1817) fix: traceroute history always empty on PostgreSQL/MySQL
- [#1818](https://github.com/Yeraze/meshmonitor/pull/1818) feat: add TOTP-based two-factor authentication (MFA)
- [#1822](https://github.com/Yeraze/meshmonitor/pull/1822) feat: add position history line style setting
- [#1824](https://github.com/Yeraze/meshmonitor/pull/1824) feat: improve news popup UX with bulk dismiss and version gating
- [#1825](https://github.com/Yeraze/meshmonitor/pull/1825) docs: add auto-ack features, MFA section, and security sidebar link
- [#1826](https://github.com/Yeraze/meshmonitor/pull/1826) chore: bump version to v3.4.8 with news update

## Issues Resolved

- [#1814](https://github.com/Yeraze/meshmonitor/issues/1814) [FEAT] Allow more granular fine-tuning of tapback/auto-acknowledge
- [#1816](https://github.com/Yeraze/meshmonitor/issues/1816) [FEAT] 2 Factor Auth for admin user (TOTP)
- [#1820](https://github.com/Yeraze/meshmonitor/issues/1820) [FEAT] semicircles in position history must die!
- [#1823](https://github.com/Yeraze/meshmonitor/issues/1823) [BUG] Auto Acknowledge - Tapback and Reply too fast and getting rate limited

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.7] - 2026-02-06

## What's Changed

### New Features

- **Auto Time Sync** — Automatically sync server time to nodes without NTP/GPS capability. Supports configurable intervals, expiration hours, and node filtering. Available in the Automation tab. (#1807)

- **Persistent Ignored Nodes** — Ignored nodes are now stored in a dedicated database table and survive database pruning. Fixes #1796. (#1801)

### Bug Fixes

- **Fix traceroute scheduler timer leaks** — Prevent timer leaks when auto-traceroute scheduler is restarted, and enforce 30-second minimum interval between traceroute sends to respect Meshtastic firmware rate limits. Fixes #1805. (#1806)

- **Fix verifyResponse checkbox** — The "Verify Response" checkbox for geofence triggers and auto-responders was being ignored. DMs now correctly use 1 attempt when disabled or 3 attempts when enabled. (#1808)

- **Fix map popup positioning** — Improved map popup positioning and traceroute behavior. Fixes #1798. (#1803)

- **Rename "Most Active Node" to "Most Recently Heard"** — The dashboard label now accurately reflects what the metric shows. Fixes #1800. (#1802)

### Translations

- Translation updates from Hosted Weblate (#1799)

## Issues Resolved

- #1805 - [BUG] Auto-Traceroute sends traceroute requests too frequently
- #1800 - [BUG] node diagrams and most active node mismatch  
- #1798 - [BUG] position of node popup on map not fully fixed
- #1796 - [BUG] Logic Deadlock: Ignored nodes are permanently lost after Database Pruning

## Pull Requests

- #1801 - feat: persistent ignored nodes list
- #1802 - fix: rename 'Most Active Node' to 'Most Recently Heard'
- #1803 - fix: improve map popup positioning and traceroute behavior
- #1806 - Fix traceroute scheduler timer leaks and enforce minimum send interval
- #1807 - feat: add Auto Time Sync feature for nodes without NTP/GPS
- #1808 - fix: respect verifyResponse setting for geofence and auto-responder
- #1799 - Translations update from Hosted Weblate

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.6...v3.4.7

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.6] - 2026-02-05

## What's Changed

### Bug Fixes

- **fix: Remote Admin fixed position sends 0,0 coordinates** — The Remote Admin handler was passing lat/lon in the position config message, but `Config.PositionConfig` has no coordinate fields in the protobuf. Coordinates are now correctly sent via a separate `set_fixed_position` admin message. Also removed an unnecessary 1-second delay between the two messages. ([#1793](https://github.com/Yeraze/meshmonitor/pull/1793))
- **fix: traceroute history missing bidirectional search on PostgreSQL/MySQL** — `getTraceroutesByNodes()` only searched one direction on non-SQLite backends, missing traceroutes stored in the reverse direction (e.g., via Virtual Node). ([#1795](https://github.com/Yeraze/meshmonitor/pull/1795))
- **fix: route scripts through Virtual Node to prevent connection conflicts** — Resolves [#1766](https://github.com/Yeraze/meshmonitor/issues/1766). ([#1792](https://github.com/Yeraze/meshmonitor/pull/1792))
- **fix: handle StatusMessageConfig module type gracefully** — Resolves [#1764](https://github.com/Yeraze/meshmonitor/issues/1764). ([#1787](https://github.com/Yeraze/meshmonitor/pull/1787))
- **fix: implement route segment queries for PostgreSQL/MySQL backends** ([#1785](https://github.com/Yeraze/meshmonitor/pull/1785))
- **fix: quote PostgreSQL column aliases in packet distribution query** ([#1784](https://github.com/Yeraze/meshmonitor/pull/1784))

### UI Improvements

- **ui: move packet distribution time range into chart box** ([#1786](https://github.com/Yeraze/meshmonitor/pull/1786))

### Translations

- Russian, German, French, Spanish, Norwegian Bokmål, Chinese (Simplified) translations updated via Weblate ([#1780](https://github.com/Yeraze/meshmonitor/pull/1780))

### Dependencies

- Bump `@rollup/rollup-linux-arm-gnueabihf` to 4.57.1 ([#1746](https://github.com/Yeraze/meshmonitor/pull/1746))
- Bump `@rollup/rollup-linux-arm64-musl` to 4.57.1 ([#1743](https://github.com/Yeraze/meshmonitor/pull/1743))
- Bump `pg` to 8.18.0 ([#1744](https://github.com/Yeraze/meshmonitor/pull/1744))
- Bump `maplibre-gl` to 5.17.0 ([#1741](https://github.com/Yeraze/meshmonitor/pull/1741))

### Issues Resolved

- [#1766](https://github.com/Yeraze/meshmonitor/issues/1766) — Testing geotrigger scripts
- [#1764](https://github.com/Yeraze/meshmonitor/issues/1764) — 3.4.4 failing to connect to node
- [#1790](https://github.com/Yeraze/meshmonitor/issues/1790) — Packet distribution charts not showing TRACEROUTE_APP packets

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.5...v3.4.6

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.5] - 2026-02-04

## What's Changed

### Features
- Add packet distribution charts to Info page (#1774)
- Make favorite nodes always visible regardless of age (#1775)
- Add tile server autodetect for Custom Tileset Manager (#1771)
- Update meshtastic protobufs to latest version (#1782)
  - New hardware models: WISMESH_TAP_V2, RAK3401, RAK6421, THINKNODE_M4, THINKNODE_M6, MESHSTICK_1262, TBEAM_1_WATT, T5_S3_EPAPER_PRO
  - New modem preset: LONG_TURBO
  - New PortNums: ALERT_APP, KEY_VERIFICATION_APP, STORE_FORWARD_PLUSPLUS_APP, NODE_STATUS_APP, RETICULUM_TUNNEL_APP, CAYENNE_APP

### Bug Fixes
- Preserve all config fields when saving in desktop setup (#1781) - fixes #1770
- Reduce CPU usage on mobile by optimizing status timer (#1778) - fixes #1769
- Fix node popup positioning when sidebar is expanded (#1776) - fixes #1768
- Handle single quotes and env vars in script test arguments (#1772)
- Use raw values for sats_in_view telemetry instead of averaging (#1767)
- Show info modal for Channel Database virtual channels (#1765)

### Documentation
- Add FAQ entry for emoji fonts in offline deployments (#1779)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.4...v3.4.5

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.4] - 2026-02-03

## What's Changed

### New Features

* **Channel Database Sort Order** - Drag-and-drop reordering to control decryption priority in [#1757](https://github.com/Yeraze/meshmonitor/pull/1757)
* **Channel Name Validation** - New "Enforce Name Validation" option for channel hash matching in [#1749](https://github.com/Yeraze/meshmonitor/pull/1749)
* **Clear Filter Buttons** - Quick filter clearing on Nodes and Messages tabs in [#1755](https://github.com/Yeraze/meshmonitor/pull/1755)
* **Script Test Feature** - Test automation trigger scripts directly from the UI in [#1754](https://github.com/Yeraze/meshmonitor/pull/1754)
* **{ONLINENODES} Token** - New token and node count chart for automations in [#1751](https://github.com/Yeraze/meshmonitor/pull/1751)

### Bug Fixes

* Fix GPS Satellites chart showing decimals on Y-axis in [#1760](https://github.com/Yeraze/meshmonitor/pull/1760)
* Support running as non-root user in Kubernetes in [#1759](https://github.com/Yeraze/meshmonitor/pull/1759)
* Only send position in exchange when node has valid position source in [#1756](https://github.com/Yeraze/meshmonitor/pull/1756)
* Add allowed_origins support to desktop app config in [#1737](https://github.com/Yeraze/meshmonitor/pull/1737)

### Improvements

* Use standard telemetry charts for system node metrics in [#1752](https://github.com/Yeraze/meshmonitor/pull/1752)

### Documentation

* Added Channel Database documentation for sort order and drag-and-drop reordering
* Added documentation for Enforce Name Validation option
* Added news entry for Channel Database improvements

### Dependencies

* Bump production dependencies in [#1739](https://github.com/Yeraze/meshmonitor/pull/1739)
* Bump development dependencies in [#1738](https://github.com/Yeraze/meshmonitor/pull/1738), [#1740](https://github.com/Yeraze/meshmonitor/pull/1740), [#1742](https://github.com/Yeraze/meshmonitor/pull/1742)

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.3...v3.4.4

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.3] - 2026-02-02

## Release v3.4.3

### Features
- feat: add `{TOTALNODES}` token for automation messages ([#1734](https://github.com/Yeraze/meshmonitor/pull/1734))
- feat: enhance position history with color gradient and clickable segments ([#1731](https://github.com/Yeraze/meshmonitor/pull/1731))
- feat: add position history duration slider ([#1727](https://github.com/Yeraze/meshmonitor/pull/1727))

### Bug Fixes
- fix: respect distance unit setting for position history speed display ([#1733](https://github.com/Yeraze/meshmonitor/pull/1733))
- fix: improve mobile landscape layout for sidebar and header ([#1732](https://github.com/Yeraze/meshmonitor/pull/1732))

### Issues Resolved
- [#1730](https://github.com/Yeraze/meshmonitor/issues/1730) - [BUG] incorrect value at {NODECOUNT}
- [#1245](https://github.com/Yeraze/meshmonitor/issues/1245) - [BUG] sidebar in landscape mode out of position on mobile devices

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.2...v3.4.3

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.2] - 2026-01-31

## What's Changed

### Features
- Add missing telemetry config options (deviceTelemetryEnabled, health metrics) ([#1715](https://github.com/Yeraze/meshmonitor/pull/1715)) - Closes [#1714](https://github.com/Yeraze/meshmonitor/issues/1714)
- Improve script execution logging for automations ([#1712](https://github.com/Yeraze/meshmonitor/pull/1712))
- Add tabs to map and node popups for better iOS scrolling ([#1709](https://github.com/Yeraze/meshmonitor/pull/1709))
- Add node filter to packet monitor ([#1704](https://github.com/Yeraze/meshmonitor/pull/1704))
- Add traceroute button to node popup on map ([#1702](https://github.com/Yeraze/meshmonitor/pull/1702))

### Bug Fixes
- Restore URL hash navigation for bookmarks and direct links ([#1716](https://github.com/Yeraze/meshmonitor/pull/1716))
- Always save position history regardless of precision changes ([#1710](https://github.com/Yeraze/meshmonitor/pull/1710))
- Preserve lastHeard during config sync to prevent incorrect timestamps ([#1707](https://github.com/Yeraze/meshmonitor/pull/1707))
- Preserve channel names when device sends empty names ([#1703](https://github.com/Yeraze/meshmonitor/pull/1703))

### Documentation
- Update Sky and Sea Alert script metadata ([#1713](https://github.com/Yeraze/meshmonitor/pull/1713))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.1...v3.4.2

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.1] - 2026-01-29

## What's Changed

### New Features
- **Spam Detection**: Added detection for nodes with excessive packet rates in the Security tab (#1696, closes #1690)
- **Script Arguments**: Added script arguments support for AutoResponder, Timer, and Geofence triggers with token expansion (#1691, closes #1685)
- **Geofence Enhancements**: 
  - Added "None" channel option and `{IP}` token for geofence triggers (#1686)
  - Added "Verify Response" option for geofence triggers (#1693)
- **Accuracy Regions**: Changed accuracy circles to rectangles for better GPS precision visualization (#1694, closes #1688)
- **Long Message Support**: Added automatic message breakup for long API messages (#1695, closes #1689)

### Bug Fixes
- **Phantom Telemetry**: Filter out phantom telemetry packets from packet log - these were internal device state updates incorrectly logged as TX packets (#1697)
- **Position History**: Fixed position history not working on PostgreSQL/MySQL backends (#1692)

### Other
- Translation updates from Weblate (#1674)

## Pull Requests
- #1698 - chore: bump version to 3.4.1
- #1697 - fix: filter phantom telemetry packets from packet log
- #1696 - feat: add spam detection for nodes with excessive packets
- #1695 - feat: add multi-message breakup for long API messages
- #1694 - feat: change accuracy circles to accuracy regions (rectangles)
- #1693 - feat: add Verify Response option to Geofence Triggers
- #1692 - fix: position history not working on PostgreSQL/MySQL backends
- #1691 - feat: add script arguments for AutoResponder, Timer, and Geofence triggers
- #1686 - feat: add "None" channel option and {IP} token for geofence triggers
- #1674 - Translations update from Hosted Weblate

## Issues Closed
- #1690 - [FEAT] AutoBan for Spam
- #1689 - [BUG] Long messages sent via the API get stuck pending
- #1688 - [FEAT] Show Accuracy as Rectangle on Map
- #1685 - [FEAT] Geofence / Script / Remote Admin

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.4.0...v3.4.1

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.4.0] - 2026-01-28

## What's New in v3.4.0

This release introduces **Geofence Triggers** - a powerful automation feature for location-based actions, along with **in-app node connection configuration** and several quality-of-life improvements.

### ✨ New Features

#### Geofence Triggers
Create automated responses when nodes enter, exit, or remain inside geographic areas. Define circular or polygon zones on an interactive map and trigger text messages or scripts when conditions are met.

- **Flexible Zone Shapes**: Draw circles or polygons directly on the map
- **Three Event Types**: Trigger on entry, exit, or periodically while inside
- **Node Filtering**: Monitor all nodes or select specific ones
- **Dynamic Responses**: Use tokens like `{LONG_NAME}`, `{GEOFENCE_NAME}`, `{DISTANCE_TO_CENTER}`
- **Routing Options**: Send to channels or as direct messages

#### Node Connection Configuration
Change your Meshtastic node's IP address directly from the UI - no container restart required.

- Click the **node name in the header** to open the Node Info modal
- Administrators can modify the connection IP address and port
- Changes persist until container restart
- Supports IP:port format (e.g., `192.168.1.100:4045`)

#### Other Improvements
- **Rebroadcast mode warnings** for Channel Database feature (#1679)
- **Edit functionality** for geofence triggers (#1677)
- **News feed improvements** - Only show new items, scroll to top on navigation (#1681, #1683)

### 🐛 Bug Fixes

- **Emoji tapback validation** - Improved emoji detection and input validation (#1678)
- **Packet log decryption** - Save decrypted_by and decrypted_channel_id properly (#1675)
- **Auto-traceroute jitter** - Add random jitter to prevent network bursts (#1673)
- **GPS coordinates links** - Updated helper links to latlong.net (#1680)

### 🌍 Translations
- Translation updates from Hosted Weblate (#1650)

---

## Pull Requests

- [#1683](https://github.com/Yeraze/meshmonitor/pull/1683): chore: bump version to 3.4.0 and add feature documentation
- [#1682](https://github.com/Yeraze/meshmonitor/pull/1682): feat: add Node Info modal with IP/port configuration
- [#1681](https://github.com/Yeraze/meshmonitor/pull/1681): fix: only show new news items instead of all unread items
- [#1680](https://github.com/Yeraze/meshmonitor/pull/1680): chore: update GPS coordinates helper links to latlong.net
- [#1679](https://github.com/Yeraze/meshmonitor/pull/1679): feat: add rebroadcast mode warnings for Channel Database feature
- [#1678](https://github.com/Yeraze/meshmonitor/pull/1678): fix: improve emoji detection and validate tapback emoji input
- [#1677](https://github.com/Yeraze/meshmonitor/pull/1677): feat: add edit functionality to geofence triggers
- [#1675](https://github.com/Yeraze/meshmonitor/pull/1675): fix: save decrypted_by and decrypted_channel_id in packet log
- [#1673](https://github.com/Yeraze/meshmonitor/pull/1673): fix: add random jitter to auto-traceroute scheduler
- [#1669](https://github.com/Yeraze/meshmonitor/pull/1669): feat: add geofence triggers to automation tab
- [#1650](https://github.com/Yeraze/meshmonitor/pull/1650): Translations update from Hosted Weblate

## Issues Closed

- [#1671](https://github.com/Yeraze/meshmonitor/issues/1671): [BUG] traceroute network bursts!
- [#1670](https://github.com/Yeraze/meshmonitor/issues/1670): [SUPPORT] Channel DB channels
- [#1555](https://github.com/Yeraze/meshmonitor/issues/1555): [FEAT] Allow for Radio Connection to change in the UI rather than Environment Variable

---

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.3.1...v3.4.0

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.3.1] - 2026-01-27

## Hotfix Release

### Bug Fixes
- **fix: add missing `enabled` column to `auto_traceroute_nodes` table** — Users whose SQLite supported `ALTER TABLE RENAME COLUMN` (most users) never got the `enabled` column from migration 048. This caused errors when setting up auto-traceroute. (#1665)
- **fix: correct `reset-admin.mjs` database path and account state** — Fixed wrong database path (`./data/` → `/data/`) and ensured the script also clears `is_active` and `password_locked` flags so reset accounts actually work. (#1667, #1658)
- **fix: extend `reset-admin.mjs` to support PostgreSQL and MySQL** — The script now auto-detects the database backend from `DATABASE_URL` and uses the correct driver and column names for each backend. (#1667)

### Documentation
- **docs: add Link Quality & Smart Hops documentation page** — New documentation explaining the Link Quality score (0–10) and Smart Hops rolling 24-hour min/avg/max graphs. (#1664)
- **docs: update FAQ for multi-database `reset-admin.mjs`** — Updated the password reset FAQ with PostgreSQL/MySQL examples and account unlock behavior. (#1667)

### Full Changelog
https://github.com/Yeraze/meshmonitor/compare/v3.3.0...v3.3.1

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.3.0] - 2026-01-27

## What's New in v3.3.0

### Features
- **User-specific permissions for virtual channels** - Virtual channels now support per-user View Map and Read permissions ([#1655](https://github.com/Yeraze/meshmonitor/pull/1655))
- **Emoji tapback reactions** - Single-emoji replies render as tapback pills instead of full message bubbles ([#1660](https://github.com/Yeraze/meshmonitor/pull/1660))
- **Sticky/pinned nodes in Messages tab** ([#1651](https://github.com/Yeraze/meshmonitor/pull/1651))

### Bug Fixes
- **Fix virtual node channel reset on restart** - Rebuild channel config from database instead of cache, preventing Android clients from losing channel names ([#1661](https://github.com/Yeraze/meshmonitor/pull/1661), [#1659](https://github.com/Yeraze/meshmonitor/pull/1659), [#1567](https://github.com/Yeraze/meshmonitor/issues/1567))
- **Fix map zoom with Show Traceroute** - Clicking a node with no traceroute now zooms to the node instead of doing nothing ([#1662](https://github.com/Yeraze/meshmonitor/pull/1662))
- **Fix node deselection on map** - Allow deselecting nodes by clicking again in map node list ([#1657](https://github.com/Yeraze/meshmonitor/pull/1657), [#1656](https://github.com/Yeraze/meshmonitor/issues/1656))
- **Improve Link Quality charts** for sparse data ([#1652](https://github.com/Yeraze/meshmonitor/pull/1652), [#1648](https://github.com/Yeraze/meshmonitor/pull/1648))
- **Hide accuracy circles/segments when traceroute is active** ([#1649](https://github.com/Yeraze/meshmonitor/pull/1649))
- **Support shorthand PSKs in Channel Database** ([#1644](https://github.com/Yeraze/meshmonitor/pull/1644), [#1642](https://github.com/Yeraze/meshmonitor/issues/1642))
- **Preserve disabled channels in database** ([#1643](https://github.com/Yeraze/meshmonitor/pull/1643), [#1640](https://github.com/Yeraze/meshmonitor/issues/1640))
- **Show correct encryption status in Device Channels view** ([#1646](https://github.com/Yeraze/meshmonitor/pull/1646), [#1641](https://github.com/Yeraze/meshmonitor/issues/1641))

### Other
- **Translations** - Russian translation update ([#1625](https://github.com/Yeraze/meshmonitor/pull/1625))
- **Docs** - Added Sky and Sea Alert to user scripts gallery ([#1645](https://github.com/Yeraze/meshmonitor/pull/1645))
- **Dependencies** - Updated recharts, express-session, react-router-dom, i18next, and others

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.2.5] - 2026-01-26

## What's Changed

### Features
- **Unified SaveBar Component** - Replaced individual Save buttons across 30+ settings components with a unified SaveBar that appears as a fixed bar at the bottom when changes are detected. Includes smooth slide-in animation, Save/Dismiss buttons, and support for multiple sections with unsaved changes. (#1628)
- **Remote Telemetry Configuration** - Added Telemetry Configuration section to Remote Admin's Module Configuration area, allowing remote configuration of Device, Environment, Air Quality, and Power telemetry settings. (#1612)
- **Transport Mechanism Tracking** - Enhanced packet logging to track full transport mechanism (Radio, MQTT Uplink, MQTT Downlink) instead of just via_mqtt boolean. (#1622, #1623)

### Bug Fixes
- **Virtual Node Message History** - Removed 10-message history replay on client connect to fix duplicate messages and incorrect hop counts on iOS clients. (#1610, #1621)
- **Message Action Icons** - Moved message action icons above the bubble to prevent overlap with hop count links. (#1616)
- **PostgreSQL/MySQL Packet Clear** - Fixed async support for clearing packet logs on PostgreSQL and MySQL databases. (#1620)
- **Docker Healthchecks** - Added curl to Docker container for proper healthcheck support. (#1614)
- **Dashboard Favorites** - Fixed rendering of Smart Hops and Link Quality on favorites dashboard. (#1607)

### Translations
- Updated translations from Hosted Weblate (#1611)

### Maintenance
- Version bump to 3.2.5 with Virtual Node CLI test fixes (#1618)

## Issues Closed
- #1619 - 'TransportMechanism' field is missing from packet_log table
- #1617 - Failed to clear packet logs
- #1615 - Quick action icons overlap with the hop count link
- #1608 - Channel messages error on virtual node
- #1589 - Remote Admin Telemetry Missing
- #1557 - Auto Responder scripts save successfully but disappear afterward

## Pull Requests
- #1628 - feat(ui): add unified SaveBar component for settings changes
- #1623 - refactor(packets): replace via_mqtt with full transport_mechanism enum
- #1622 - feat(packets): add via_mqtt column to packet_log table
- #1621 - fix(virtual-node): remove 10-message history replay on client connect
- #1620 - fix(api): add async support for clearing packet logs on PostgreSQL/MySQL
- #1618 - chore: bump version to 3.2.5 and fix Virtual Node CLI test
- #1616 - fix(ui): move message actions above bubble to prevent hop count overlap
- #1614 - fix(docker): add curl for container healthchecks
- #1612 - feat(admin): add telemetry configuration to remote admin
- #1611 - Translations update from Hosted Weblate
- #1610 - fix(virtual-node): improve message history replay for iOS clients
- #1607 - fix(dashboard): render Smart Hops and Link Quality favorites correctly

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.2.4...v3.2.5

---


## [3.2.4] - 2026-01-24

## What's Changed

### Features
- **Sidebar Pin Button** - Added a pin button to the sidebar that prevents it from auto-collapsing when clicking navigation items. Pin state persists across sessions. (#1604)
- **Virtual Node Message History** - Virtual node now sends the last 10 messages to connecting mobile apps, so you can see recent chat history immediately. (#1603)
- **Desktop Virtual Node Config** - Windows/macOS desktop app now supports `enable_virtual_node` and `virtual_node_allow_admin` config options in `config.json`. (#1605)
- **Purge Neighbors Button** - Added button to clear stale neighbor info from the Messages page. (#1595)

### Bug Fixes
- **Update Banner Auto-Dismiss** - Fixed the upgrade notification banner not auto-dismissing after 5 seconds due to a React callback reference issue. (#1604)
- **Security Config Save Disabled** - Temporarily disabled the security config save button in Remote Admin to prevent key loss. (#1602)

### Documentation
- **BLE Bridge Windows Docs** - Added documentation for Windows native EXE Bluetooth pairing. (#1594)

### Translations
- Updated translations from Hosted Weblate (#1596)

## Issues Closed
- #1600 - Virtual node does not return a list of messages to client
- #1599 - Update banner obscures interface elements
- #1598 - Sidebar collapses upon clicking an item
- #1597 - How to enable virtual node on Windows desktop client
- #1601 - Direct node sends all packets but not appear on map/list
- #1591 - Stuck neighbor info from days ago

## Pull Requests
- #1605 - feat(desktop): add virtual node config options to Tauri app
- #1604 - feat(ui): add sidebar pin button and verify upgrade banner auto-dismiss
- #1603 - fix(virtual-node): send message history to connecting clients
- #1602 - fix(admin): disable security config save button
- #1596 - Translations update from Hosted Weblate
- #1595 - feat(ui): add purge neighbors button to Messages page
- #1594 - docs(ble-bridge): add Windows native EXE documentation

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.2.3...v3.2.4

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.2.3] - 2026-01-23

## 🔧 Hotfix Release

This hotfix resolves a startup failure on PostgreSQL/MySQL backends introduced in v3.2.1.

### Bug Fixes

- **Fixed PostgreSQL/MySQL startup failure** - Migration 056 (backup_history column fix) now properly supports PostgreSQL and MySQL databases. The migration runs before schema initialization to fix tables with incorrect schemas before index creation is attempted. ([#1586](https://github.com/Yeraze/meshmonitor/pull/1586))

### Technical Details

The previous fix (v3.2.2) only addressed SQLite databases. PostgreSQL/MySQL databases with existing `backup_history` tables that had incorrect schemas would fail at startup with:
```
error: column "timestamp" does not exist
  routine: 'ComputeIndexAttrs'
```

This release adds `runMigration056Postgres()` and `runMigration056Mysql()` functions that:
- Run BEFORE the schema SQL is executed
- Check if the `backup_history` table has the correct columns
- Recreate the table with the correct schema if needed

### Pull Requests

- [#1586](https://github.com/Yeraze/meshmonitor/pull/1586) - fix(migration): add PostgreSQL/MySQL support to migration 056

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.2.2...v3.2.3

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.2.2] - 2026-01-23

## 🔧 Hotfix Release

This hotfix resolves a migration issue that prevented v3.2.1 from starting on some installations.

# NOTE: Do not install if using MySQL or PostGres. There is a breaking bug that will prevent your installation from starting.

### Bug Fixes

- **Fixed migration 056 failing on startup** - The backup_history column migration now handles unexpected table schemas gracefully. Previously, if the table had an unexpected structure (missing `timestamp` column), the migration would fail and prevent the server from starting. ([#1585](https://github.com/Yeraze/meshmonitor/pull/1585))

### Technical Details

Migration 056 now:
- Checks if the table exists before proceeding
- Creates the table with the correct schema if it doesn't exist
- Detects and handles tables with unexpected schemas by recreating them
- Validates required columns exist before attempting data migration
- Logs column names for easier debugging

**Note:** If you had device backup history records in an incompatible schema, they will be lost during migration. The actual backup files on disk remain intact.

### Pull Requests

- [#1585](https://github.com/Yeraze/meshmonitor/pull/1585) - fix(migration): make backup_history migration more robust

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.2.1...v3.2.2

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.2.1] - 2026-01-23

## 🔧 Hotfix Release

This hotfix release addresses database compatibility issues with device backups on PostgreSQL/MySQL backends.

# NOTE: Do not install if using MySQL or PostGres. There is a breaking bug that will prevent your installation from starting.

### Bug Fixes

- **Fixed device backups failing on PostgreSQL/MySQL** - Added missing `backup_history` and `system_backup_history` tables to PostgreSQL and MySQL schemas, and created migration to fix SQLite column names ([#1580](https://github.com/Yeraze/meshmonitor/pull/1580), [#1581](https://github.com/Yeraze/meshmonitor/pull/1581)) - Fixes [#1575](https://github.com/Yeraze/meshmonitor/issues/1575)

### Features

- **Remote Admin improvements** - Successfully completing any remote admin operation now sets the `hasRemoteAdmin` flag for that node. Retrieving device metadata now saves the data to the database, populating the same fields as the Remote Admin Scanner ([#1582](https://github.com/Yeraze/meshmonitor/pull/1582))

### Pull Requests

- [#1580](https://github.com/Yeraze/meshmonitor/pull/1580) - fix(backup): support PostgreSQL/MySQL for device backups
- [#1581](https://github.com/Yeraze/meshmonitor/pull/1581) - fix(backup): add missing backup tables to PostgreSQL/MySQL schemas
- [#1582](https://github.com/Yeraze/meshmonitor/pull/1582) - feat(admin): set hasRemoteAdmin flag on successful remote operations
- [#1583](https://github.com/Yeraze/meshmonitor/pull/1583) - chore: bump version to 3.2.1

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.2.0...v3.2.1

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.2.0] - 2026-01-23

## What's Changed

### ✨ New Features
- **Remote Admin Discovery Scanner** - Scan your mesh network to discover nodes that support remote administration ([#1577](https://github.com/Yeraze/meshmonitor/pull/1577))
- **News Popup Feature** - Add announcements and news notifications for users ([#1571](https://github.com/Yeraze/meshmonitor/pull/1571))
- **Tri-state Channel Permissions** - More granular control over channel-based permissions ([#1569](https://github.com/Yeraze/meshmonitor/pull/1569))
- **Retrieve Device Metadata Button** - Added to Remote Admin page for easier device management ([#1564](https://github.com/Yeraze/meshmonitor/pull/1564))

### 🐛 Bug Fixes
- **PostgreSQL/MySQL Device Backups** - Fixed device backup functionality on PostgreSQL and MySQL backends ([#1580](https://github.com/Yeraze/meshmonitor/pull/1580)) - Closes [#1575](https://github.com/Yeraze/meshmonitor/issues/1575)
- **Security Config Keys** - Preserve public/private keys when updating security configuration ([#1573](https://github.com/Yeraze/meshmonitor/pull/1573))
- **PostgreSQL Position Overrides** - Added PostgreSQL/MySQL support for position override methods ([#1566](https://github.com/Yeraze/meshmonitor/pull/1566))
- **Neighbor Info Display** - Fixed neighbor info display and stale data cleanup in Messages tab ([#1562](https://github.com/Yeraze/meshmonitor/pull/1562))

### 🌐 Translations
- Updated Russian translations ([#1578](https://github.com/Yeraze/meshmonitor/pull/1578), [#1572](https://github.com/Yeraze/meshmonitor/pull/1572))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.1.1...v3.2.0

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.1.1] - 2026-01-21

## What's New in v3.1.1

# Note: My anonymous map is blank.
https://meshmonitor.org/faq.html#the-map-is-blank-for-anonymous-not-logged-in-users

3.1.1 extends the user channel permissions to also cover Node Visibility on the map. This means that if don't have "Read" permissions to a particular channel, you will not be able to see nodes only communicating on that channel.  This is useful for networks with separate sub-networks on non-public channels that you may want to keep hidden from public view (due to precise positioning or other reasons).  A side effect of this is that if you have not granted the Anonymous user read access to any channels, then the map will be blank.

In the upcoming version (3.1.2 or 3.2), there will be additional permissions to allow you to control visibility of a node on the map separate from the Channels Messages interface.


### Features

- **Request Telemetry from Remote Nodes** ([#1558](https://github.com/Yeraze/meshmonitor/pull/1558)) - Closes [#1400](https://github.com/Yeraze/meshmonitor/issues/1400)
  - New "Request Telemetry" button in Messages tab actions menu
  - Select from Device, Environment, Air Quality, or Power metrics
  - Sends empty telemetry packet with `wantResponse:true` to trigger remote node response

- **Extended Environment Telemetry Support** ([#1560](https://github.com/Yeraze/meshmonitor/pull/1560))
  - Added support for all 22 EnvironmentMetrics fields from Meshtastic protobuf
  - New telemetry types: wind (speed, direction, gust, lull), rainfall (1h, 24h), light sensors (lux, UV, IR), soil (moisture, temperature), radiation, distance, weight, IAQ
  - Graph rendering with proper labels and colors for all new metrics

- **Neighbor Info Display in Messages Tab** ([#1556](https://github.com/Yeraze/meshmonitor/pull/1556)) - Closes [#1550](https://github.com/Yeraze/meshmonitor/issues/1550)
  - View neighbor information directly in Messages tab for DM conversations

- **Channel-Based Node Visibility Filtering** ([#1553](https://github.com/Yeraze/meshmonitor/pull/1553))
  - Filter nodes based on channel membership

### Bug Fixes

- **Neighbor Info Lines Respect Position Overrides** ([#1554](https://github.com/Yeraze/meshmonitor/pull/1554)) - Closes [#1552](https://github.com/Yeraze/meshmonitor/issues/1552), [#1526](https://github.com/Yeraze/meshmonitor/issues/1526)
  - Fixed SQLite-specific issue where neighbor info lines ignored position overrides on the map

- **BLE Bridge Healthcheck Fix** ([#1551](https://github.com/Yeraze/meshmonitor/pull/1551))
  - Use Python for BLE bridge healthcheck for better reliability

- **Channel Database Help Link** ([#1548](https://github.com/Yeraze/meshmonitor/pull/1548))
  - Updated help link to point to MeshMonitor documentation

### Other Changes

- Translations update from Hosted Weblate ([#1549](https://github.com/Yeraze/meshmonitor/pull/1549))

---

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.1.0...v3.1.1

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.1.0] - 2026-01-21

## What's New in 3.1.0

### New Features

#### Channel Database for Server-Side Packet Decryption
Store unlimited channel configurations beyond your device's 8 slots and decrypt packets server-side. This allows monitoring encrypted traffic from channels you're not actively participating in.

- Store channel name and PSK combinations in MeshMonitor's database
- Automatic server-side decryption of incoming encrypted packets
- Retroactive processing of historical encrypted packets when adding new channels
- Read-only access (view decrypted content without transmit capability)
- Permission-based access control for non-admin users

See the [Channel Database documentation](https://yeraze.github.io/meshmonitor/features/channel-database) for details.

#### Enhanced Traceroute Visualization
- Focused view mode for traceroute paths
- Distinct path colors for better visualization

#### Python Requests Library
User scripts can now use `import requests` for HTTP calls without manual installation.

### Bug Fixes

- **PostgreSQL/MySQL schema fixes** - Fixed upgrade_history table schema mismatch and boolean type handling for auto_traceroute_log
- **Direct neighbors API** - Fixed hardcoded URL that caused 404 errors when BASE_URL differs from default
- **Bind mount conflicts** - Internal scripts now deploy to `/data/.meshmonitor-internal/` to avoid conflicts with user script directories during upgrades

### Changes Since v3.0.3

- [#1547](https://github.com/Yeraze/meshmonitor/pull/1547) - feat: add Python requests library to Docker image
- [#1544](https://github.com/Yeraze/meshmonitor/pull/1544) - fix: move internal scripts to separate directory to avoid bind mount conflicts
- [#1543](https://github.com/Yeraze/meshmonitor/pull/1543) - fix: use ApiService for direct-neighbors endpoint instead of hardcoded URL
- [#1542](https://github.com/Yeraze/meshmonitor/pull/1542) - fix: PostgreSQL/MySQL schema bugs for upgrade_history and traceroute
- [#1541](https://github.com/Yeraze/meshmonitor/pull/1541) - Translations update from Hosted Weblate
- [#1540](https://github.com/Yeraze/meshmonitor/pull/1540) - feat: add Channel Database for server-side packet decryption
- [#1536](https://github.com/Yeraze/meshmonitor/pull/1536) - feat: enhance traceroute visualization with focused view and distinct path colors

### Issues Resolved

- [#1545](https://github.com/Yeraze/meshmonitor/issues/1545) - Add py3-requests to Docker image
- [#1539](https://github.com/Yeraze/meshmonitor/issues/1539) - PostgreSQL upgrade_history column does not exist
- [#1538](https://github.com/Yeraze/meshmonitor/issues/1538) - Request Neighbor Info button not working
- [#1537](https://github.com/Yeraze/meshmonitor/issues/1537) - PostgreSQL auto_traceroute_log boolean type error
- [#1518](https://github.com/Yeraze/meshmonitor/issues/1518) - Scripts disappearing during upgrade with bind mounts
- [#1495](https://github.com/Yeraze/meshmonitor/issues/1495) - Channel Database feature request

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.0.3...v3.1.0

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.0.3] - 2026-01-20

## What's Changed

This patch release includes several bug fixes for multi-database deployments (PostgreSQL/MySQL) and improves the reliability of device configuration handling.

### Bug Fixes

- **fix: map overlays now respect position overrides** - Traceroute paths and node markers now correctly use overridden positions on the map ([#1527](https://github.com/Yeraze/meshmonitor/pull/1527)) - Fixes [#1526](https://github.com/Yeraze/meshmonitor/issues/1526)
- **fix: upgrade service now works with PostgreSQL and MySQL** - Self-upgrade functionality no longer fails with "SQLite method 'prepare' called" error on non-SQLite databases ([#1528](https://github.com/Yeraze/meshmonitor/pull/1528))
- **fix: favorite telemetry retention now works on PostgreSQL/MySQL** - Favorited telemetry is now properly retained for the configured period instead of being deleted with regular telemetry ([#1529](https://github.com/Yeraze/meshmonitor/pull/1529))
- **fix: relay node matching now filters to plausible candidates only** - Relay suggestions now only show direct neighbors or 1-hop nodes instead of distant nodes with matching bytes ([#1531](https://github.com/Yeraze/meshmonitor/pull/1531))
- **fix: add missing notification preference columns for PostgreSQL/MySQL** - Resolves "column enabledChannels does not exist" error on PostgreSQL deployments ([#1532](https://github.com/Yeraze/meshmonitor/pull/1532))
- **fix: redirect unauthorized users from protected tabs** - Users can no longer access protected tabs (settings, automation, configuration) via direct URL navigation without proper permissions ([#1534](https://github.com/Yeraze/meshmonitor/pull/1534))
- **fix: clear stale device config after disconnect/reconnect** - Device configuration is now properly cleared on disconnect, preventing stale LoRa config data after device reboot ([#1535](https://github.com/Yeraze/meshmonitor/pull/1535))

### Performance Improvements

- **refactor: optimize DELETE queries to use direct WHERE clauses** - Replaced inefficient SELECT-then-DELETE-in-loop patterns with direct DELETE WHERE statements, reducing database round trips from thousands to 1-2 per operation ([#1530](https://github.com/Yeraze/meshmonitor/pull/1530))

---

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.0.2...v3.0.3

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.0.2] - 2026-01-20

## What's Changed

### Bug Fixes
- **fix(desktop): add JIT entitlements for macOS Node.js binary** - Fixes crash on macOS ARM64 with "Failed to reserve virtual memory for CodeRange" error ([#1524](https://github.com/Yeraze/meshmonitor/pull/1524)) - Fixes [#1478](https://github.com/Yeraze/meshmonitor/issues/1478)
- **fix: notification channel settings not persisting** - Channel selections, monitored nodes, whitelist, and blacklist now properly save and load ([#1523](https://github.com/Yeraze/meshmonitor/pull/1523)) - Fixes [#1519](https://github.com/Yeraze/meshmonitor/issues/1519)
- **fix(api): enforce user permissions on v1 API read endpoints** ([#1517](https://github.com/Yeraze/meshmonitor/pull/1517))

### Documentation
- Update Discord invite link ([#1522](https://github.com/Yeraze/meshmonitor/pull/1522))
- Update bug_report.md with database options ([#1520](https://github.com/Yeraze/meshmonitor/pull/1520))

### Translations
- Translations update from Hosted Weblate ([#1514](https://github.com/Yeraze/meshmonitor/pull/1514))

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v3.0.1...v3.0.2

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.0.1] - 2026-01-19

# Release Notes - v3.0.1 Hotfix

## Overview

MeshMonitor 3.0.1 is a hotfix release addressing several bugs reported after the v3.0.0 "MultiDatabase" release.

---

## Bug Fixes

### Desktop Application
- [#1509](https://github.com/Yeraze/meshmonitor/pull/1509) - **Fix Windows desktop app startup crash** - Include missing `db` directory in Tauri bundle, fixing "Cannot find module 'dist/db/drivers/sqlite.js'" error (Fixes [#1508](https://github.com/Yeraze/meshmonitor/issues/1508))

### User Interface
- [#1507](https://github.com/Yeraze/meshmonitor/pull/1507) - **Fix Audit Logs "Invalid Date" display** - Correctly handle timestamp format in audit log entries (Fixes [#1505](https://github.com/Yeraze/meshmonitor/issues/1505))
- [#1507](https://github.com/Yeraze/meshmonitor/pull/1507) - **Hide Database Maintenance section for PostgreSQL/MySQL** - The maintenance feature is SQLite-specific; now correctly hidden for other database backends
- [#1507](https://github.com/Yeraze/meshmonitor/pull/1507) - **Fix SQLite notification preferences save error** - Correct Drizzle schema column names to match actual SQLite table structure
- [#1512](https://github.com/Yeraze/meshmonitor/pull/1512) - **Fix accuracy circles showing for hidden nodes** - Apply same filters (hide incomplete nodes, hide MQTT nodes) to accuracy and uncertainty circles (Fixes [#1411](https://github.com/Yeraze/meshmonitor/issues/1411))

### Enhancements
- [#1511](https://github.com/Yeraze/meshmonitor/pull/1511) - **Increase font size for hop count and message time** - Improved readability in Channels panel (Fixes [#1433](https://github.com/Yeraze/meshmonitor/issues/1433))

---

## Upgrade Instructions

### Docker
```bash
docker pull ghcr.io/yeraze/meshmonitor:3.0.1
docker compose down && docker compose up -d
```

### Helm
```bash
helm repo update
helm upgrade meshmonitor meshmonitor/meshmonitor --version 3.0.1
```

### Desktop
Download the latest installer from the [Releases page](https://github.com/Yeraze/meshmonitor/releases/tag/v3.0.1).

---

## Previous Release

For the full v3.0.0 "MultiDatabase" release notes including multi-database support, see the [v3.0.0 Release](https://github.com/Yeraze/meshmonitor/releases/tag/v3.0.0).

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [3.0.0] - 2026-01-19

# MeshMonitor v3.0.0 "MultiDatabase"

MeshMonitor 3.0.0 is a major release introducing **multi-database support**, allowing you to choose between SQLite (default), PostgreSQL, or MySQL/MariaDB as your database backend.

## 📚 Documentation

- **[Database Migration Guide](https://meshmonitor.org/database-migration)** - How to migrate from SQLite to PostgreSQL/MySQL
- **[Database Configuration](https://meshmonitor.org/development/database)** - Detailed setup instructions for all database backends
- **[Full Documentation](https://meshmonitor.org/)** - Complete MeshMonitor documentation

---

## ✨ Highlights

- **PostgreSQL and MySQL/MariaDB Support** - Enterprise-ready database options with full feature parity
- **Database Migration Tool** - Seamlessly migrate your existing SQLite database to PostgreSQL or MySQL
- **Customizable Tapback Reactions** - Configure your own set of emoji reactions
- **Script Metadata Support** - Enhanced UI display for user scripts with descriptions and icons
- **Auto-Traceroute for All Databases** - PostgreSQL and MySQL now support automatic traceroute functionality
- **PKI Key Management** - Automatic detection and repair of PKI key mismatches

---

## ⚠️ Breaking Changes

### Database Architecture
- All database methods are now async to support multiple database backends
- If you have custom integrations using the database API, update to use the new async methods

### Node.js Requirements
- Node 18 is no longer officially supported
- Minimum recommended version: Node 20.x
- Officially tested on: Node 20.x and 22.x

---

## 🚀 Major Features

### Multi-Database Support
- [#1460](https://github.com/Yeraze/meshmonitor/pull/1460) - PostgreSQL and MySQL Database Support
- [#1404](https://github.com/Yeraze/meshmonitor/pull/1404) - PostgreSQL support as optional database backend
- [#1405](https://github.com/Yeraze/meshmonitor/pull/1405) - MySQL/MariaDB support as database backend

Configure via `DATABASE_URL` environment variable:
```bash
# PostgreSQL
DATABASE_URL=postgres://user:password@host:5432/meshmonitor

# MySQL/MariaDB
DATABASE_URL=mysql://user:password@host:3306/meshmonitor

# SQLite (default - no configuration needed)
```

### Database Migration & Compatibility
- [#1489](https://github.com/Yeraze/meshmonitor/pull/1489) - PostgreSQL/MySQL support for auto-traceroute
- [#1485](https://github.com/Yeraze/meshmonitor/pull/1485) - PostgreSQL column type migration fixes
- [#1473](https://github.com/Yeraze/meshmonitor/pull/1473) - PostgreSQL/MySQL support for API token management
- [#1440](https://github.com/Yeraze/meshmonitor/pull/1440) - PostgreSQL/MySQL support for sync database methods
- [#1438](https://github.com/Yeraze/meshmonitor/pull/1438) - Async methods for traceroute log and audit
- [#1436](https://github.com/Yeraze/meshmonitor/pull/1436) - Updated tests for async database methods
- [#1412](https://github.com/Yeraze/meshmonitor/pull/1412) - PostgreSQL/MySQL cache sync for node modifications

### New Features
- [#1482](https://github.com/Yeraze/meshmonitor/pull/1482) - Customizable tapback emoji reactions
- [#1492](https://github.com/Yeraze/meshmonitor/pull/1492) - Script metadata support for enhanced UI display
- [#1435](https://github.com/Yeraze/meshmonitor/pull/1435) - Show channel ID for encrypted packets
- [#1439](https://github.com/Yeraze/meshmonitor/pull/1439) - Show session passkey status for remote nodes
- [#1444](https://github.com/Yeraze/meshmonitor/pull/1444) - Add uptimeSeconds to v1 nodes API
- [#1403](https://github.com/Yeraze/meshmonitor/pull/1403) - Battery status monitor auto-responder script
- [#1396](https://github.com/Yeraze/meshmonitor/pull/1396) - Security configuration section on Device page
- [#1394](https://github.com/Yeraze/meshmonitor/pull/1394) - Request neighbor info from remote nodes
- [#1389](https://github.com/Yeraze/meshmonitor/pull/1389) - Node Hops Calculation setting
- [#1387](https://github.com/Yeraze/meshmonitor/pull/1387) - Node opacity dimming based on last heard time
- [#1379](https://github.com/Yeraze/meshmonitor/pull/1379) - Display last traceroute in node popup on map
- [#1377](https://github.com/Yeraze/meshmonitor/pull/1377) - GPS accuracy circles on map
- [#1376](https://github.com/Yeraze/meshmonitor/pull/1376) - Filter CLIENT_MUTE from relay modal
- [#1367](https://github.com/Yeraze/meshmonitor/pull/1367) - GPS satellites in view as telemetry graph
- [#1357](https://github.com/Yeraze/meshmonitor/pull/1357) - PUID/PGID environment variable support for Docker
- [#1352](https://github.com/Yeraze/meshmonitor/pull/1352) - Navigate to channel/DM from push notifications
- [#1349](https://github.com/Yeraze/meshmonitor/pull/1349) - Auto key management for PKI key mismatch repair
- [#1348](https://github.com/Yeraze/meshmonitor/pull/1348) - Detect and display PKI key mismatch errors
- [#1329](https://github.com/Yeraze/meshmonitor/pull/1329) - Log outgoing mesh commands to Packet Monitor
- [#1325](https://github.com/Yeraze/meshmonitor/pull/1325) - Automated database maintenance feature
- [#1398](https://github.com/Yeraze/meshmonitor/pull/1398) - Display MQTT indicator for unknown SNR in traceroutes

---

## 🐛 Bug Fixes

### Database & Backend
- [#1491](https://github.com/Yeraze/meshmonitor/pull/1491) - Prevent PKI key corruption from addContact messages
- [#1483](https://github.com/Yeraze/meshmonitor/pull/1483) - Wait for database initialization before accepting requests
- [#1479](https://github.com/Yeraze/meshmonitor/pull/1479) - Fix DM routing, SQLite schema, and purge validation
- [#1477](https://github.com/Yeraze/meshmonitor/pull/1477) - Add logging for mark-as-read operations
- [#1476](https://github.com/Yeraze/meshmonitor/pull/1476) - Convert booleans to integers for SQLite binding
- [#1461](https://github.com/Yeraze/meshmonitor/pull/1461) - Address type safety issues from v3.0 PR review
- [#1445](https://github.com/Yeraze/meshmonitor/pull/1445) - Don't send config while radio is restarting
- [#1441](https://github.com/Yeraze/meshmonitor/pull/1441) - Include reset-admin.mjs script in Docker image
- [#1395](https://github.com/Yeraze/meshmonitor/pull/1395) - Improve Remote Admin config load reliability
- [#1393](https://github.com/Yeraze/meshmonitor/pull/1393) - Add detection and logging for virtual node ID mismatches
- [#1385](https://github.com/Yeraze/meshmonitor/pull/1385) - Correct RX/TX direction for packets from local node
- [#1381](https://github.com/Yeraze/meshmonitor/pull/1381) - Use precision_bits for accuracy circles
- [#1359](https://github.com/Yeraze/meshmonitor/pull/1359) - Filter out internal ADMIN_APP and ROUTING_APP packets
- [#1353](https://github.com/Yeraze/meshmonitor/pull/1353) - Auto Responder replies now work on channels
- [#1347](https://github.com/Yeraze/meshmonitor/pull/1347) - Cache telemetry types to reduce poll latency
- [#1346](https://github.com/Yeraze/meshmonitor/pull/1346) - Use WebSocket message data directly
- [#1343](https://github.com/Yeraze/meshmonitor/pull/1343) - Delete broadcast messages when purging node
- [#1334](https://github.com/Yeraze/meshmonitor/pull/1334) - Consistent nullish coalescing for txEnabled
- [#1333](https://github.com/Yeraze/meshmonitor/pull/1333) - Add missing txEnabled fields to Remote Admin LoRa config

### Frontend & UI
- [#1494](https://github.com/Yeraze/meshmonitor/pull/1494) - Clarify device-reported node counts in graph labels
- [#1486](https://github.com/Yeraze/meshmonitor/pull/1486) - Show most recent message timestamp in Recent Activity
- [#1480](https://github.com/Yeraze/meshmonitor/pull/1480) - Fix orphaned security issue details display
- [#1451](https://github.com/Yeraze/meshmonitor/pull/1451) - Remove duplicate tray icon on Windows
- [#1448](https://github.com/Yeraze/meshmonitor/pull/1448) - Set default height for messages container
- [#1417](https://github.com/Yeraze/meshmonitor/pull/1417) - Improve push notification scroll to message
- [#1419](https://github.com/Yeraze/meshmonitor/pull/1419) - Handle empty/corrupted desktop config files

### Networking & CORS
- [#1466](https://github.com/Yeraze/meshmonitor/pull/1466) - Correct IP address byte order for static WiFi config
- [#1465](https://github.com/Yeraze/meshmonitor/pull/1465) - Allow X-CSRF-Token header in CORS configuration

### Internationalization
- [#1467](https://github.com/Yeraze/meshmonitor/pull/1467) - Update purge warning to include local database
- [#1450](https://github.com/Yeraze/meshmonitor/pull/1450) - Add missing channel edit translations
- [#1421](https://github.com/Yeraze/meshmonitor/pull/1421) - Add missing channel config translations
- [#1402](https://github.com/Yeraze/meshmonitor/pull/1402) - Correct incomplete githubPath URLs in scripts gallery

---

## 📖 Documentation

- [#1481](https://github.com/Yeraze/meshmonitor/pull/1481) - Add WX Weather Alerts and Carrier Outage scripts to gallery
- [#1418](https://github.com/Yeraze/meshmonitor/pull/1418) - Add Indiana Mesh to site gallery
- [#1392](https://github.com/Yeraze/meshmonitor/pull/1392) - Add Radio Identity + QTH script to gallery
- [#1363](https://github.com/Yeraze/meshmonitor/pull/1363) - Fix MESHTASTIC_STALE_CONNECTION_TIMEOUT default value
- [#1361](https://github.com/Yeraze/meshmonitor/pull/1361) - Update documentation for protocol constants
- [#1320](https://github.com/Yeraze/meshmonitor/pull/1320) - Fix meshtasticd documentation with correct CLI options

---

## 🌐 Translations

Thanks to our translation community on Hosted Weblate:
- [#1468](https://github.com/Yeraze/meshmonitor/pull/1468), [#1446](https://github.com/Yeraze/meshmonitor/pull/1446), [#1422](https://github.com/Yeraze/meshmonitor/pull/1422), [#1407](https://github.com/Yeraze/meshmonitor/pull/1407)
- [#1388](https://github.com/Yeraze/meshmonitor/pull/1388), [#1380](https://github.com/Yeraze/meshmonitor/pull/1380), [#1369](https://github.com/Yeraze/meshmonitor/pull/1369), [#1365](https://github.com/Yeraze/meshmonitor/pull/1365)
- [#1345](https://github.com/Yeraze/meshmonitor/pull/1345), [#1342](https://github.com/Yeraze/meshmonitor/pull/1342), [#1332](https://github.com/Yeraze/meshmonitor/pull/1332), [#1327](https://github.com/Yeraze/meshmonitor/pull/1327)
- [#1319](https://github.com/Yeraze/meshmonitor/pull/1319)

---

## 🔧 Infrastructure

- [#1360](https://github.com/Yeraze/meshmonitor/pull/1360) - Extract Meshtastic protocol constants to shared file
- [#1457](https://github.com/Yeraze/meshmonitor/pull/1457) - Use npm install instead of npm ci in CI
- [#1456](https://github.com/Yeraze/meshmonitor/pull/1456) - Add --legacy-peer-deps to npm ci commands

---

## 📦 Migration Guide

### Upgrading from v2.x

1. **Backup your database** before upgrading
2. The existing SQLite database will continue to work without changes
3. To migrate to PostgreSQL or MySQL, use the migration tool:
   ```bash
   # Set up target database
   export DATABASE_URL=postgres://user:password@host:5432/meshmonitor

   # Run migration
   npm run migrate-db -- --from sqlite:/data/meshmonitor.db --to $DATABASE_URL
   ```

See the [Database Migration Guide](https://meshmonitor.app/database-migration) for detailed instructions.

---

## 🙏 Contributors

Thanks to all contributors who made this release possible, including:
- The MeshMonitor core team
- Translation contributors via Hosted Weblate
- Community bug reporters and testers

---

**Full Changelog**: https://github.com/Yeraze/meshmonitor/compare/v2.22.0...v3.0.0

---

## Proxmox LXC Template

This release includes a Proxmox-compatible LXC container template for MeshMonitor.

### Installation

1. Download the `.tar.gz` template file
2. Verify the SHA256 checksum (optional but recommended)
3. Upload to your Proxmox server: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
4. Create a new LXC container from the template via Proxmox web UI
5. Configure `/etc/meshmonitor/meshmonitor.env` with your Meshtastic node IP
6. Start the container and access the web UI on port 8080

### Documentation

See the [Proxmox LXC Deployment Guide](https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed instructions.

### Limitations

- Auto-upgrade feature is not supported in LXC deployments
- Manual updates required (download new template for each version)
- Community-supported (Docker remains the primary deployment method)


## [2.18.1] - 2025-11-15

### Added
- **Clickable URL Rendering in Messages** ([#614](https://github.com/Yeraze/meshmonitor/pull/614)): Automatic URL detection with rich link previews
  - **Automatic URL Detection**: Detects HTTP/HTTPS URLs in all message text using regex pattern
  - **Clickable Links**: URLs converted to clickable links that open in new tabs with security (`rel="noopener noreferrer"`)
  - **Rich Link Previews**: Display preview cards with metadata (title, description, image, site name)
    - Fetches Open Graph, Twitter Card, and standard meta tags from target URLs
    - Beautiful card-based layout with responsive design (max-width 400px)
    - Displays website favicons, titles, descriptions, and preview images
    - Styled with Catppuccin theme variables for consistency
  - **Lazy Loading with Intersection Observer**: Performance-optimized preview fetching
    - Only fetches previews for messages in or near the viewport (100px margin)
    - Prevents excessive API calls on initial page load
    - One-time fetch per message with URL
    - Smooth UX with loading states and animations
  - **Backend Link Preview Endpoint**: New `/api/link-preview` endpoint
    - Fetches and parses HTML metadata from URLs
    - 5-second timeout to prevent hanging requests
    - Protocol validation (only HTTP/HTTPS allowed)
    - HTML entity decoding for safe text display
    - Resolves relative URLs to absolute
  - **BASE_URL Support**: Properly respects BASE_URL configuration via ApiService
  - **Security Features**:
    - Links open in new tabs with security attributes
    - URL protocol validation
    - Request timeouts
    - Safe HTML entity handling
  - **Works in All Message Types**: Channel messages, direct messages, and traceroute messages


## [2.12.2] - 2025-10-31

### Added
- **Auto Welcome Functionality** ([#412](https://github.com/Yeraze/meshmonitor/pull/412)): Automatically send personalized welcome messages to new nodes joining the mesh network
  - **Dynamic Token System**: 7 customizable tokens for personalized messages
    - `{LONG_NAME}`, `{SHORT_NAME}` - Node identification
    - `{VERSION}` - MeshMonitor version
    - `{DURATION}` - Time since node first seen
    - `{FEATURES}` - Enabled automation features with emojis
    - `{NODECOUNT}`, `{DIRECTCOUNT}` - Network statistics
  - **Smart Welcome Logic**: 24-hour cooldown to prevent spam
  - **Wait for Name Feature**: Skip nodes with default names until personalized
  - **Routing Options**: Send as DM or to specific channel
  - **Database Migration**: Automatic migration prevents "thundering herd" of welcome messages on first boot
  - **Comprehensive Testing**: 27 new tests covering integration and migration scenarios

- **Auto Announce Scheduled Sends** ([#413](https://github.com/Yeraze/meshmonitor/pull/413)): Precise time-based scheduling using cron expressions as alternative to fixed intervals
  - **Cron Expression Scheduling**: Schedule announcements at specific times (e.g., daily at 9 AM)
  - **Live Validation**: Real-time validation with visual feedback (green checkmark/red error)
  - **Integrated Help**: Direct link to [crontab.guru](https://crontab.guru/) for cron expression assistance
  - **Smart UI**: Conditional display of interval OR cron input based on selected mode
  - **Immediate Apply**: Schedule changes restart scheduler instantly - no container restart needed
  - **Default Expression**: `0 */6 * * *` (every 6 hours at top of hour)
  - **Dual-Mode Scheduler**: Supports both interval-based and cron-based execution
  - **New Dependencies**: `node-cron` for backend scheduling, `cron-validator` for frontend validation

- **Security Monitoring Page** ([#414](https://github.com/Yeraze/meshmonitor/pull/414)): Comprehensive mesh network security monitoring
  - **New Security Tab**: Dedicated interface for monitoring encryption key security
  - **Low-Entropy Key Detection**: Identifies nodes using weak encryption keys vulnerable to brute-force attacks
    - Displays key entropy scores with severity indicators (High Risk, Medium Risk, Low Risk)
    - Shows hardware model information for affected nodes
    - Direct links to detailed remediation documentation
  - **Duplicate Key Detection**: Identifies nodes sharing the same encryption key
    - Groups nodes by duplicate encryption keys
    - Highlights privacy violations between devices
    - Shows impacted node count per duplicate key
    - Links to comprehensive fix instructions
  - **Security Permission**: New granular permission for accessing security monitoring
    - Read permission for viewing security scan results
    - Write permission for initiating security scans
    - Integrated into user management UI with proper Read/Write checkboxes
  - **Comprehensive Documentation**: User-facing guides for fixing security issues
    - `docs/security-low-entropy-keys.md` (257 lines) - Complete guide to fixing weak keys
    - `docs/security-duplicate-keys.md` (355 lines) - Complete guide to resolving duplicate keys
    - Platform-specific instructions for iOS, Android, and CLI
    - Real-world security scenarios and attack explanations
    - Step-by-step remediation instructions
    - FAQ sections addressing common concerns

### Fixed
- **Permission UI**: Fixed Security permission displaying incorrect text in Users panel
  - Changed from "Can initiate traceroutes" to proper Read/Write checkboxes
  - Security permission now displays consistently with other resources

### Changed
- **User Management**: Enhanced permission model to include security resource
  - Added 'security' to default admin permissions
  - Security resource excluded from default user permissions
- **Auto Announce Architecture**: Enhanced scheduler to support both interval and cron-based execution modes


## [2.11.3] - 2025-10-28

### Added
- **Enhanced Node Details Block** (#366, #384): Added comprehensive node information display on Messages page
  - New "Node Details" block displays between message conversation and telemetry graphs
  - **Node ID display in hex and decimal formats** (e.g., 0x43588558 and 1129874776)
  - Shows battery level with voltage (color-coded: green >75%, yellow 25-75%, red <25%)
  - Displays signal quality metrics (SNR and RSSI with quality indicators)
  - Shows network utilization (channel utilization and air utilization TX)
  - Displays device information (hardware model with image, role, firmware version)
  - Hardware images fetched from Meshtastic web-flasher repository (70+ device images)
  - Friendly hardware names (e.g., "STATION G2" instead of "STATION_G2")
  - Shows network position (hops away, MQTT connection status)
  - Displays last heard timestamp with relative time formatting
  - Responsive grid layout (2 columns on desktop, 1 column on mobile)
  - Graceful handling of missing metrics (shows "N/A" for unavailable data)
  - Color-coded indicators for battery, signal quality, and utilization levels
  - Comprehensive hardware model decoder (116 device types from Meshtastic protobufs)
  - Device role decoder (Client, Router, Tracker, Sensor, etc.)

- **Device Configuration Backup Improvements** (#381): Enhanced backup functionality and user experience
  - Improved backup filename format with timestamp (NodeID-YYYY-MM-DD-HH-MM-SS.yaml)
  - Enhanced backup modal UI with clearer instructions
  - Better error handling and user feedback

### Fixed
- **Map Popup Visibility** (#383, #386): Improved popup centering when clicking node markers
  - Dynamic viewport-relative offset (1/4 of map height) adapts to different screen sizes
  - Single smooth animation instead of competing pan operations
  - Popup consistently centers in viewport without being cut off
  - Eliminated "fighting" animations between map controller and popup opening

- **Connection Status Detection** (#378, #387): Added timeout to detect backend unavailability
  - 10-second timeout on fetch requests prevents indefinite hanging
  - Connection status updates to "Disconnected" within 10-15 seconds when backend unavailable
  - Improved browser compatibility with DOMException and Error handling
  - Memory leak prevention with proper timeout cleanup in finally block

- **Apprise URL Validation** (#385): Loosened URL validation to support special characters
  - Improved compatibility with Apprise notification services
  - Supports special characters in Apprise URLs
  - Better error messages for invalid URLs


## [2.10.4] - 2025-10-25

### Added
- **Traceroute History**: View complete traceroute history for any node pair
  - New "View History" button in Messages tab for nodes with traceroute data
  - Displays all traceroute attempts including successful and failed attempts
  - Shows both forward and return routes with SNR values
  - Includes calculated total distance for each route
  - Tracks auto-traceroute and manual user-initiated traceroutes
  - Persistent storage with configurable history limit (50 records per node pair)

### Fixed
- Improved database performance with dedicated index for traceroute queries
- Fixed potential race condition in traceroute recording with database transactions
- Enhanced API input validation for better security

### Changed
- Replaced magic numbers with configuration constants for improved maintainability
- Optimized traceroute display performance with memoized route formatting


## [2.10.3] - 2025-10-25

### Added
- **Telemetry Dashboard Enhancements**: Enhanced telemetry dashboard with advanced data management
  - Filter telemetry by node name or ID with instant search
  - Sort nodes by name, ID, battery level, voltage, or last update time
  - Drag-and-drop to reorder telemetry cards for personalized layout
  - Persistent card order saved to local storage
  - Clear visual indicators for search and sort states

### Fixed
- **Session Management**: Added SESSION_ROLLING option for improved user experience
  - When enabled, active users stay logged in indefinitely by resetting session expiry on each request
  - Defaults to `true` for better UX - users won't be logged out while actively using the app
  - Configurable via `SESSION_ROLLING` environment variable
  - Works in conjunction with `SESSION_MAX_AGE` for flexible session control

### Changed
- Enhanced telemetry card layout with better visual hierarchy
- Improved UX for managing large numbers of nodes
- Updated README with SESSION_ROLLING documentation


## [2.4.6] - 2025-01-13

### Fixed
- **OIDC Callback Parameter Preservation**: Fixed OIDC authentication failure with RFC 9207-compliant providers (PocketID, etc.) that include the `iss` (issuer) parameter in authorization callbacks
  - Modified callback handler to preserve all query parameters from authorization callback instead of reconstructing URL with only code/state
  - Now passes complete callback URL to openid-client's authorizationCodeGrant function
  - Maintains full backward compatibility with existing OIDC providers (Authentik, Keycloak, Auth0, Okta, Azure AD)
  - Resolves "response parameter iss (issuer) missing" error
  - Fixes #197


## [2.1.0] - 2025-10-10

### Added
- **Connection Control**: Manual disconnect/reconnect from Meshtastic node with permission control
  - Disconnect button in header to manually stop connection to node
  - Reconnect button appears when user has manually disconnected
  - New `connection` permission resource to control access to disconnect/reconnect functionality
  - Cached data remains accessible while disconnected (read-only mode)
  - Prevents automatic reconnection when user has manually disconnected
  - Connection state preserved through page refreshes

- **Traceroute Permission**: Fine-grained control over traceroute initiation
  - New `traceroute` permission resource to control who can initiate traceroute requests
  - Separate permission from viewing traceroute results (which uses `info:read`)
  - Traceroute button in Messages tab now requires `traceroute:write` permission
  - Default permissions: admins can initiate, regular users can view only

- **Permission UI Enhancements**:
  - Single-checkbox UI for binary permissions (connection, traceroute)
  - Intuitive "Can Control Connection" and "Can Initiate Traceroutes" labels
  - Simplified permission management for action-based resources

- **Header Improvements**:
  - Display connected node name in header: "LongName (ShortName) - !ID"
  - IP address shown in tooltip on hover
  - Better visibility of which node you're connected to

### Changed
- Traceroute endpoint now requires `traceroute:write` permission instead of `info:write`
- Connection status now includes `user-disconnected` state
- Frontend polling respects user-disconnected state
- Route segments and neighbor info remain accessible when disconnected

### Technical Improvements
- Database migrations 003 and 004 for new permission resources
- User disconnected state management in MeshtasticManager
- Comprehensive test coverage for new connection control endpoints
- Permission model tests updated for connection and traceroute resources
- All test suites (515 tests) passing successfully

### Fixed
- Data display when manually disconnected from node
- Route segments functionality while disconnected
- Page refresh behavior when in disconnected state


## [2.0.1] - 2025-10-09

### Fixed
- Cookie security configuration with `COOKIE_SECURE` and `COOKIE_SAMESITE` environment variables


## [2.0.0] - 2025-10-08

### Added
- Authentication and user management system
- Role-based access control with granular permissions
- Update notification system with GitHub release checking


## [1.15.0] - 2025-10-06

### Added
- **Two-Way Favorites Sync**: Synchronize favorite nodes to Meshtastic device
  - Send `set_favorite_node` and `remove_favorite_node` admin messages to device
  - Session passkey management with automatic refresh (300 second expiry)
  - Graceful degradation: database updates succeed even if device sync fails
  - Device sync status reporting in API responses
  - Frontend displays sync success/failure status in console

### Changed
- **Favorites API Enhancement**: `/api/nodes/:nodeId/favorite` endpoint now supports device sync
  - Added `syncToDevice` parameter (default: true) to toggle device synchronization
  - Response includes `deviceSync` object with status ('success', 'failed', 'skipped') and optional error message
  - Database update and device sync are independent operations

### Technical Improvements
- Admin message creation methods in protobufService:
  - `createGetOwnerRequest()` - Request session passkey from device
  - `createSetFavoriteNodeMessage()` - Send favorite node to device
  - `createRemoveFavoriteNodeMessage()` - Remove favorite from device
  - `decodeAdminMessage()` - Parse admin message responses
  - `createAdminPacket()` - Wrap admin messages in ToRadio packets
- Session passkey lifecycle management in meshtasticManager
- Admin message processing for extracting session passkey from responses
- Automatic passkey refresh with 290-second buffer before expiry


## [1.4.0] - 2025-09-29

### Added
- **Telemetry Favorites Dashboard**: Pin your favorite telemetry metrics for quick access
  - Star/unstar nodes to mark as favorites
  - Dedicated favorites dashboard showing only starred nodes
  - Persistent favorites storage in database
  - Quick toggle between all nodes and favorites view

### Changed
- **Major Dependency Updates**:
  - Upgraded to React 19 with improved performance and features
  - Upgraded to react-leaflet v5 for better map functionality
  - Upgraded to Express 5 for enhanced server capabilities
  - Upgraded to Node.js 22 (deprecated Node 18 support)
  - Upgraded to ESLint 9 and TypeScript ESLint 8
  - Upgraded to Vite 6 for faster builds

### Fixed
- Express 5 wildcard route compatibility issue preventing server startup
- Docker build issues with missing @meshtastic/protobufs dependency
- Server test failures after jsdom v27 upgrade
- Various dependency vulnerabilities through updates

### Technical Improvements
- Modernized entire dependency stack for better security and performance
- Improved build times with updated tooling
- Enhanced type safety with latest TypeScript ESLint
- Better development experience with latest Vite and React


## [1.1.0] - 2025-09-28

### Added
- **GitHub Container Registry Publishing**: Pre-built Docker images now available
  - Automated Docker image building and publishing to `ghcr.io/yeraze/meshmonitor`
  - GitHub Actions workflow for continuous image publishing
  - Multi-tag strategy: `latest`, version tags (`1.1.0`, `1.1`, `1`), and branch names
  - Docker buildx with layer caching for optimal build performance
  - No local build step required for deployment

- **Enhanced Deployment Options**:
  - Pre-built images available at GitHub Container Registry
  - Updated docker-compose.yml to use GHCR images by default
  - Documented local build option for developers
  - Version pinning support for production stability

- **Improved Documentation**:
  - Docker image version and size badges in README
  - Comprehensive deployment instructions for both pre-built and local builds
  - Available image tags documentation
  - Quick start guide updated with GHCR instructions

### Changed
- docker-compose.yml now uses `ghcr.io/yeraze/meshmonitor:latest` by default
- Enhanced .dockerignore for optimized build context
- Updated Docker support feature list

### Technical Improvements
- GitHub Actions workflow with PR build validation
- Automated multi-architecture image builds
- Layer caching for faster subsequent builds
- Public GHCR package for easy access


## [1.0.0] - 2025-09-28

This is the initial stable release of MeshMonitor, a comprehensive web application for monitoring Meshtastic mesh networks over IP.

### Features Included in 1.0.0

### Added
- **Automatic Traceroute Scheduler**: Intelligent network topology discovery
  - Runs every 3 minutes to discover mesh network routes
  - Selects nodes needing traceroutes (no data or oldest traceroute)
  - Stores complete route paths with SNR data for each hop
  - Traceroute messages filtered from Primary channel display

- **Network Mapping & Route Visualization**:
  - Interactive map with \"Show Routes\" toggle checkbox
  - Weighted route lines (2-8px thickness based on segment usage)
  - Routes appearing in multiple traceroutes shown with thicker lines
  - Purple polylines matching Catppuccin theme
  - Real-time route data refresh every 10 seconds

- **Node Role Display**:
  - Role information displayed in node list (Client, Router, Repeater, etc.)
  - Role badges shown next to node names
  - Database schema updated with `role` column

- **Hops Away Tracking**:
  - Network distance display for each node
  - Shows how many hops away each node is from local node
  - Database schema updated with `hopsAway` column

- **Traceroute API Endpoints**:
  - `GET /api/traceroutes/recent` - Retrieve recent traceroutes with filtering
  - `POST /api/traceroutes/send` - Manually trigger traceroute to specific node

- **Database Enhancements**:
  - New `traceroutes` table with route path and SNR storage
  - `role` and `hopsAway` columns added to `nodes` table
  - Foreign key relationships for data integrity
  - Automatic schema migration on startup

### Changed
- Map controls repositioned to right side of interface
- Route visualization made toggleable for cleaner map view
- Traceroute data persistence for historical network analysis

### Technical Improvements
- Protobuf parsing enhanced for traceroute response handling
- Intelligent node selection algorithm for traceroute scheduling
- Optimized database queries for traceroute data retrieval

- **iPhone Messages-Style UI**: Complete redesign of channel messaging interface
  - Message bubbles with proper left/right alignment based on sender
  - Sender identification dots showing shortName with longName tooltips
  - Real-time delivery status indicators (⏳ pending → ✓ delivered)
  - Optimistic UI updates for instant message feedback

- **Enhanced Channel Management**:
  - Whitelist-based channel filtering to prevent invalid channels
  - Automatic cleanup of inappropriate channel names (WiFi SSIDs, random strings)
  - Support for known Meshtastic channels: Primary, admin, gauntlet, telemetry, Secondary, LongFast, VeryLong
  - Channel cleanup API endpoint (`POST /api/cleanup/channels`)

- **Message Acknowledgment System**:
  - Content-based message matching for accurate delivery confirmation
  - Temporary message ID handling for optimistic updates
  - Automatic replacement of temporary messages with server-confirmed ones
  - Message persistence across sessions

- **Full Docker Support**:
  - Multi-stage Docker builds for optimized production images
  - Docker Compose configuration for easy deployment
  - Persistent data volumes for database storage
  - Environment-based configuration

- **Enhanced Database Operations**:
  - Export/import functionality for data backup
  - Message and node cleanup utilities
  - Better SQLite performance with WAL mode
  - Comprehensive indexing for faster queries

- **API Improvements**:
  - RESTful endpoint structure
  - Health check and connection status endpoints
  - Comprehensive error handling and logging
  - CORS support for cross-origin requests

- **Core Functionality**:
  - Real-time Meshtastic node monitoring via HTTP API
  - Node discovery and telemetry data collection
  - Text message sending and receiving
  - Channel-based message organization

- **User Interface**:
  - React-based single-page application
  - Catppuccin Mocha dark theme
  - Responsive design for mobile and desktop
  - Real-time connection status indicator
  - Interactive telemetry graphs and node indicators
  - Node list sorting and filtering

- **Data Persistence**:
  - SQLite database for messages, nodes, and traceroutes
  - Automatic data deduplication
  - Cross-restart persistence
  - Node relationship tracking
  - Foreign key relationships for data integrity

- **Meshtastic Integration**:
  - HTTP API client for node communication
  - Enhanced protobuf message parsing
  - Automatic node discovery
  - Configuration and device data retrieval

### Fixed
- Message persistence issues (sent messages no longer disappear)
- Channel detection and invalid channel creation
- ShortName display logic improvements
- Database connection stability
- Memory leaks in protobuf parsing
- Graceful error handling for network issues
- Telemetry parsing and direct message handling
- Environment telemetry storage

### Changed
- Migrated to TypeScript for better type safety
- Enhanced message UI with iPhone Messages aesthetic
- More restrictive channel detection algorithm
- Improved project structure and organization
- Enhanced development workflow with hot reloading

### Technical Foundation
- React 18 with modern hooks and TypeScript
- Express.js backend with comprehensive API
- Better-sqlite3 for high-performance database operations
- Vite for fast development and optimized builds
- Docker with multi-stage builds for production deployment
- Comprehensive TypeScript type safety
- Enhanced error handling and logging throughout

---

## Future Enhancements

### Planned Features
- **Real-time WebSocket Updates**: Replace polling with WebSocket connections
- **Message Search**: Full-text search across message history
- **Advanced Analytics**: Network statistics and visualization dashboards
- **Mobile Application**: React Native companion app
- **Multi-node Support**: Connect to multiple Meshtastic nodes simultaneously
- **Advanced Channel Management**: Custom channel creation and PSK management
- **Plugin System**: Extensible architecture for custom functionality
- **Enhanced Authentication**: Built-in user authentication and access control