# ATAK / CoT Integration Epic (issue #3691)

**Status:** Phase 1 merged (PR #4307); Phase 2 implemented (PR pending); Phase 3 implemented (PR pending)
**Orchestrated via:** /epic (2026-07-23)

## Goal

Support ATAK (Team Awareness Kit) Cursor-on-Target data in MeshMonitor:
decode Meshtastic ATAK-plugin packets (TAKPacket V1), show ATAK contacts in the
Packet Monitor and on maps, persist GeoChat into Messages, and expose a
streaming TCP CoT feed that ATAK/WinTAK clients can subscribe to directly.

## Protocol facts (researched 2026-07-23, meshtastic-expert)

- **V1** — `ATAK_PLUGIN = 72`, message `meshtastic.TAKPacket` (protobufs
  `meshtastic/atak.proto`; our pinned submodule v2.7.26-79-gba16bfc has it).
  Byte-stable from v2.7.4 → master. Fields: `is_compressed`, `Contact
  {callsign, device_callsign}`, `Group {role, team}`, `Status {battery}`,
  oneof `payload_variant { PLI pli=5; GeoChat chat=6; bytes detail=7 }`.
  `PLI = {latitude_i, longitude_i (sfixed32, 1e-7 deg), altitude, speed (m/s),
  course (deg)}`. `GeoChat = {message, to?, to_callsign?, receipt_for_uid,
  receipt_type, lang?, room_id?, voice_profile_id?}`.
- **Firmware transcodes V1 for TCP clients:** `AtakPluginModule::alterReceivedProtobuf`
  unishox2-decompresses string fields and sends the decompressed copy to
  phone/EUD clients — MeshMonitor normally receives `is_compressed=false`
  plain UTF-8. Handle `is_compressed=true` defensively (label, don't decode
  strings; unishox2 JS decode is NOT in scope).
- **V2** — `ATAK_PLUGIN_V2 = 78`, `TAKPacketV2`, payload =
  `[1 flags byte][zstd-with-shared-dictionary]`. Firmware does NOT transcode;
  the zstd dictionary blob lives in the plugin/firmware and must be sourced.
  **Out of scope this epic** — packets are labeled (portnum name, payload size,
  "V2 — not yet decoded") but not decoded. Follow-up spike issue to be filed.
- **`ATAK_FORWARDER = 257`** — third-party (paulmandal/atak-forwarder,
  libcotshrink XML). Named only; no decode. Not the official plugin.
- **The "2.8 breaking change"** is NOT a V1 wire break — 2.8 adds V2 for rich
  CoT and the app falls back to V1 for PLI/GeoChat. Building on V1 is safe and
  forward-compatible; V2 adds rich CoT later.
- **MeshCore has no native ATAK format** (ripplebiz/MeshCore: zero CoT/TAK
  sources). MeshCore participates only on the feed-output side (its positioned
  nodes are synthesized into CoT events).
- **CoT feed:** ATAK does not poll REST. Native mechanism = streaming TCP
  socket serving raw CoT `<event>` XML (SA-server style, cf. TCP 8087).
  Minimal event: `uid`, `type` (e.g. `a-f-G-U-C`), `time/start/stale`,
  `<point lat lon hae ce le>`, `<detail><contact callsign/>...</detail>`.
  Sentinels: `hae/le = 9999999.0` for unknown. Speed m/s, course degrees.

## Interview decisions (2026-07-23)

| Question | Decision |
|---|---|
| V2 handling | V1 decode now; V2 labeled-not-decoded; file follow-up spike issue for zstd dictionary research |
| CoT feed (issue Phase 3) | **In scope** |
| Feed content | ATAK contacts + **all positioned mesh nodes** (Meshtastic + MeshCore synthesized) |
| Map surfaces | All map surfaces, toggleable layer (per-source Nodes map + unified/dashboard) |
| GeoChat | **Also persist into messages** (not just packet monitor) |
| Feed security | Plaintext TCP, settings-gated, **off by default**; TLS deferred |

Out of scope: sending TAKPackets from MeshMonitor (RX-only), V2 decode,
unishox2 decompression, ATAK_FORWARDER (257) decode, TLS feed.

## Phases

### Phase 1 — TAKPacket V1 decode + Packet Monitor + GeoChat messages
Spec: `ATAK_COT_PHASE1_SPEC.md`.
- [x] Decode portnum 72 → `meshtastic.TAKPacket` in
      `meshtasticProtobufService.processPayload`.
- [x] Preview branches in `meshtasticManager.processMeshPacket`: PLI /
      GeoChat / receipt / detail / compressed via exported `formatTakPreview`;
      decoded object into `metadata.decoded_payload` (zero frontend changes;
      only `getPortnumColor` gained `case 78`).
- [x] Port 78: `[ATAK V2 (not decoded), N bytes]` preview, `decodedPayload`
      nulled. Port 257: same labeled treatment.
- [x] GeoChat → messages: `processTakPacket` persists non-compressed,
      non-receipt GeoChat with row-ID `${sourceId}_${fromNum}_${packetId}`,
      `portnum=72`, text prefixed `[ATAK <callsign>] …`; DM per envelope
      (`channel=-1`); no auto-responder side effects (RX-only).
- [x] Tests: 7 decode/preview fixtures; 11 persistence tests; per-source
      isolation test; 3 DM read-path tests. Full suite green.
- **Exit criteria:** ATAK V1 packets display decoded in Packet Monitor;
  GeoChat appears in Messages; full suite green; PR merged. ✓ PR #4307 (merged 2026-07-23)

### Phase 2 — ATAK contact persistence + map layer
- [x] New per-source `atak_contacts` table (migration, all three backends,
      idempotent per recipe): keyed by (sourceId, uid/device_callsign),
      callsign, team, role, battery, lat/lon/alt, speed, course, last_seen,
      stale handling/retention.
- [x] Populated from PLI branch in the packet side-effect switch.
- [x] Repository (`src/db/repositories/`) + API route (envelope helpers,
      `requirePermission` scoping) + `*.perSource.test.ts`.
- [x] `AtakContactsLayer.tsx` in `src/components/map/layers/` modeled on
      `NodeMarkersLayer` (descriptor+props shape), mounted on all BaseMap
      surfaces with a layer toggle; distinct marker (team color, callsign),
      popup (type/callsign/role/battery/stale/last-seen).
- **Exit criteria:** ATAK contacts persist per-source, render on all maps
  with toggle, popup correct; browser-validated; PR merged. ← PR pending

### Phase 3 — CoT feed output (TCP streaming server)
- [x] Settings-gated TCP server (enabled + port; **default off**), keys added
      to `VALID_SETTINGS_KEYS`, Settings UI per SettingsDraft recipe.
- [x] Emits CoT `<event>` XML on connect (snapshot) + periodic full resend for:
      (a) ATAK contacts (from Phase 2 table), (b) all positioned nodes from
      every source incl. MeshCore. Stable uid scheme (e.g.
      `MESHMON-<sourceId>-<nodeId>`), proper stale times, team/role/battery
      detail where known.
- [x] Docs: `docs/features/atak.md` (consolidates Phases 1–3) for the feed +
      Docker/helm port-mapping note; CHANGELOG entry; `Dockerfile` `EXPOSE`.
- **Exit criteria:** ATAK client connecting to the socket sees mesh nodes +
  ATAK contacts as map contacts; settings off-by-default; PR merged. ← PR pending

### Post-epic
- [ ] File follow-up issue: V2 (port 78) zstd-dictionary research spike.
- [ ] Close #3691 with summary.

## Decisions / deviations log

- (2026-07-23) Epic created; interview decisions above.
- (2026-07-23, Phase 1 spec gate) `ensureMessageEndpointNodes` extracted from
  the text path and shared with `processTakPacket` (DRY; text-path tests
  guard the extraction). Push notifications enabled for GeoChat. `portnum=72`
  stored on GeoChat message rows (honest metadata; read path is channel-based).
  `detail` bytes left in `metadata.decoded_payload` (opaque JSON, harmless).
- (2026-07-23, Phase 1 review) Two read-path portnum gates found and fixed:
  `sendMessagePushNotification` hard-required portnum 1 (widened to 1|72);
  `getDirectMessages` hard-filtered portnum 1 (widened to
  `DM_CHAT_PORTNUMS = [TEXT_MESSAGE_APP, ATAK_PLUGIN]` — telemetry/traceroute
  DMs stay excluded). Residual (deliberate): `useMessagingView.ts` notification
  *sound* only plays for portnum 1 — ATAK messages render but don't chime.
- (2026-07-23, Phase 1) GeoChat `to`/`to_callsign` are ATAK UID strings, not
  nodeNums — used only for the `[ATAK a→b]` text prefix, never routing.
  Routing follows the Meshtastic envelope. No UID→node map until Phase 2.
- (2026-07-23, Phase 2 spec gate) Contact identity = composite PK `(uid,
  sourceId)`, uid = device_callsign ?? callsign ?? `!<nodeNum>`; compressed
  packets always key on the nodeNum fallback (unishox2 strings untrusted for
  identity). Permission reuses `nodes:read` (no new resource/migration).
  Capture always-on (no settings knob); staleness 15 min (dim + STALE badge),
  retention 24 h (hard delete). Frontend polls (30 s TanStack refetch) — no
  new websocket event. MapAnalysis included (light config-layer entry);
  EmbedMap and MeshCore maps excluded.
- (2026-07-23, Phase 2 review/browser validation) Two fixes out of validation:
  (1) DashboardMap.test.tsx collection failure — new import chain loaded
  `init.ts` (module-scope `api.setBaseUrl`) past a lean api mock; fixed by
  mocking `DashboardAtakContacts` like the existing `DashboardWaypoints` mock.
  (2) ATAK markers were unclickable when co-located with a node marker
  (latitude-derived z-index put node icons on top; co-location is the common
  case since EUDs ride with nodes) — fixed with `zIndexOffset={1000}`,
  verified live (z 2016+, hit-tested popup incl. STALE badge). Deploy gotcha:
  the `atak-contact-marker` string lives in the markerIcons chunk while the
  Marker JSX lives in the main chunk — grep the right bundle when verifying.
- (2026-07-23, Phase 3) MeshCore nodes live in `meshcore_nodes`, not `nodes` —
  the original spec assumed one shared node table, which would have silently
  omitted every MeshCore node from the feed. Fixed in c4672f27 by reading both
  `databaseService.nodes.getAllNodes(ALL_SOURCES)` and
  `databaseService.meshcore.getAllNodes()` and building an event from each.
  Two unit gotchas the MeshCore builder must respect: `lastHeard` on
  `meshcore_nodes` is epoch **milliseconds** (Meshtastic's `nodes.lastHeard`
  is epoch **seconds** — a ×1000 mismatch here would silently mark every
  MeshCore node as stale or not-yet-stale incorrectly), and `batteryMv` is
  battery **voltage in millivolts**, not a 0–100 percentage, so it is
  deliberately omitted from CoT's `<status battery>` rather than mapped
  1:1 like the Meshtastic `batteryLevel` field is.
- (2026-07-23, Phase 3) Distribution model is a **periodic 30s full-snapshot
  resend** (`COT_RESEND_INTERVAL_MS`) rather than push-on-event. ATAK
  de-dupes by `uid` and honors each event's `stale` time, so re-sending an
  unchanged event is a free idempotent refresh — this avoids having to hook
  every node/telemetry/contact mutation path into the feed and keeps the
  service's only I/O surface the listener + timer. See spec §3.4.
- (2026-07-23, Phase 3) Security posture, unchanged from the epic decision
  table: plaintext TCP, bound on `0.0.0.0` (ATAK EUDs are remote, not
  localhost), no auth, no TLS, default off, 16-client cap, default port
  `8088`. Documented as trusted-network-only in `docs/features/atak.md`;
  TLS remains a deferred follow-up.
