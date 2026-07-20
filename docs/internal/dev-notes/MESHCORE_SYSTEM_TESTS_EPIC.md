# Epic — MeshCore System Tests

**Status:** Phase 1 COMPLETE (validated against live hardware) — Phase 2 next
**Branch prefix:** `feature/meshcore-system-tests` (Phase 1), `feature/meshcore-system-tests-phase2`, `-phase3`
**Orchestrator:** `/epic` run started 2026-07-20

## Goal

Add hardware system-tests for MeshCore that mirror the existing Meshtastic
system-test pattern (`tests/system-tests.sh` → sub-scripts), wired in as a
**hard-required** CI phase on the self-hosted `meshmonitor-hw` runner (gated by
the `system-test` label). Coverage:

1. Two USB-connected MeshCore **companion** nodes each connect as a source and
   reach a stable connection (handshake / device-query succeeds).
2. Message **between the two local companions**: a DM (A→B, verify receipt +
   `meshcore:send-confirmed` firmware ACK) AND a channel/group message on a
   **dedicated test channel** created on both companions (verify B receives it;
   no ACK expected on channel sends). The dedicated channel avoids spamming any
   shared/public channel. The Repeater does NOT need this channel — the Repeater
   interactions are a DM + remote-admin login only.
3. **DM the "Yeraze Repeater"** (nearby RF production node) and verify a firmware
   auto-ack (`meshcore:send-confirmed`).
4. **Remote-admin login** into the Yeraze Repeater via `loginToNode()` using an
   env-secret password.
5. **Remote telemetry poll** companion→other companion, assert data returns.

## Interview decisions (locked)

- **Topology:** 2 USB companions directly connected. Device mapping is **copied
  verbatim from `docker-compose.dev.local.yml`** (maps `/dev/ttyUSB0-3` rw +
  `group_add: dialout`). The **Yeraze Repeater** is a separate nearby RF node
  running a production MeshMonitor instance; it is **already a contact** of the
  companions, so the test resolves its public key by name/prefix at runtime.
- **CI:** hard-required phase in `system-tests.sh` on the self-hosted hw runner
  under the `system-test` label. The **remote-admin login assertion** is the one
  exception — it SKIPs (not fails) when `MESHCORE_REPEATER_ADMIN_PASSWORD` is
  unset, so local/unconfigured runs don't hard-fail on a missing secret.
- **Messaging:** both DM and channel between the two companions. The channel test
  uses a **dedicated MeshCore test channel** created on both companions at test
  time (NOT `gauntlet`, NOT a public channel — avoids spam). Proposed hashtag
  channel name `#mm-systest` (public hashtag channel: shared secret is derived
  deterministically from the name `SHA256("#mm-systest")[:16]`, so both nodes just
  need the same name — see the "MeshCore hashtag channel derivation" reference and
  `docs/internal/dev-notes` / `meshcore-channels-plan.md`). The Phase 2 architect
  must confirm the exact API/route for adding a channel to a companion and the
  slot used. The Repeater does not need this channel.
- **Login:** remote-admin `loginToNode(repeaterPubKey, password)` with the
  password from `MESHCORE_REPEATER_ADMIN_PASSWORD` (GitHub Actions secret on the
  runner).
- **Telemetry:** remote poll one companion's telemetry from the other companion
  (RF), assert records return within the timeout.
- **Sources are created via the Sources API at runtime** against a **fresh named
  volume** (MeshCore sources are NOT env-configured — they're serial/USB DB rows).
  The generated test compose maps the ttyUSB devices + `group_add` (copied from
  the dev.local override).

## Key architectural facts (from Stage 0 survey)

- **Template:** `tests/test-quick-start.sh` is the richest pattern — inline
  compose generation, `/api/poll` readiness, CSRF+login (admin/changeme), a
  connection-stability gate (Test 12b: `connected:true`+`nodeResponsive:true`
  stable for 20s), and a message round-trip (`POST /api/messages/send` w/
  `sourceId` → poll `GET /api/messages`). `tests/system-tests.sh` orchestrates
  fail-fast sub-scripts; add a phase mirroring L182-214 (result var +
  `abort_remaining` + summary/report rows). Gauntlet-channel resolver lives in
  `tests/test-v1-api.sh:265-281`.
- **MeshCore REST surface** (all per-source under `/api/sources/:id/meshcore/*`;
  `:id` = "default" targets primary):
  - `GET /status` — connection status (connected, deviceType, config).
  - `POST /messages/send` — body `{ text, toPublicKey?, channelIdx?, scope? }`.
    DM when `toPublicKey` set; channel broadcast when `channelIdx` set.
  - `GET /messages`, `GET /messages/channel/:idx` — stored messages.
  - `GET /nodes`, `GET /contacts`, `POST /contacts/refresh`.
  - `POST /admin/login-with-saved` (`remote_admin:write`) + plaintext-password
    login route → `loginToNode(pk, password)`. `GET /admin/status/:pk`.
  - `POST /nodes/:publicKey/telemetry/poll` → `requestRemoteTelemetry` (companion
    only, 45s timeout, Cayenne-LPP records).
  - `GET /packets` — packet log.
  - Source creation/connect via `sourceRoutes.ts` (auto-connects via
    `ensureMeshCoreManagerStarted`). Config shape `MeshCoreSourceConfig`
    (`src/server/meshcoreConfig.ts`): `transport: 'usb'|'serial'|'tcp'`,
    `serialPort`/`port`, `baudRate`, `deviceType: 'companion'|'repeater'`.
- **DM ACK:** DMs get a firmware ACK keyed on `expectedAckCrc` → surfaced as
  `meshcore:send-confirmed`. Channel sends carry no ACK by protocol.
- **Hardware:** 4 `ttyUSB` present; only ttyUSB1 & ttyUSB3 are dialout (the two
  the dev.local override's `group_add: dialout` grants). ttyUSB3 = CP2102 w/
  stable by-id path. No container currently running; MeshCore source rows persist
  only in the runtime SQLite volume (NOT reused by the test — fresh volume).
- **CI workflow:** `.github/workflows/system-tests.yml` runs the whole
  `system-tests.sh`; a new phase is picked up automatically. The repeater secret
  must be added to the workflow env (Phase 3).

## Phases

### Phase 1 — Harness + connect/handshake  ✅ COMPLETE (2026-07-20)
`tests/test-meshcore.sh`: generate `docker-compose.meshcore-test.yml` inline
(image `meshmonitor:test`, distinct port, fresh named volume, device mappings +
`group_add` copied from `docker-compose.dev.local.yml`); boot; `/api/poll`
readiness; CSRF+login; create **two MeshCore companion sources** via the Sources
API pointing at the serial ports; connection-stability gate (both sources reach
`connected` + `deviceType:companion`, stable N sec, mirroring Test 12b); assert
device-query/handshake succeeded (device info + contacts/nodes populated). Wire a
new hard-required phase into `tests/system-tests.sh` (result var +
`abort_remaining` + summary/report rows). Commit the epic plan doc.
**Exit:** `bash tests/test-meshcore.sh` passes locally against the two connected
companions; both sources reach a stable companion connection; phase integrated
into `system-tests.sh` and reports PASS; typecheck + full vitest suite green.

**Outcome / deviations (Phase 1):**
- Delivered `tests/test-meshcore.sh` + a hard-required "MeshCore Hardware Test"
  phase in `tests/system-tests.sh`. Commits `06824fd3`, `b87f9647`, `af379963`.
- **Readiness:** polls `GET /api/health` for HTTP 200 (NOT `/api/poll` — this
  container boots with zero sources, so `/api/poll`'s `"connection"` field never
  appears).
- **Device access:** `group_add: ["20","46"]` (dialout + plugdev, numeric GIDs).
  Numeric because the production `meshmonitor:test` image's `/etc/group` may lack
  the names. **plugdev (46) is required** — one companion (ttyUSB2) is plugdev,
  not dialout. `docker-compose.dev.local.yml` was ALSO updated (main checkout,
  gitignored) to add plugdev so the normal dev container reaches both companions.
- **DEVIATION — auto-detect ports:** the interview assumed the two companions
  were on fixed dialout ports; live probing found they're on **ttyUSB2
  (`Yeraze MC Sandbox`, plugdev) + ttyUSB3 (`Yeraze MC BLE Sandbox`, dialout)**,
  and enumeration can drift. So the harness maps all four ttyUSB, creates a
  candidate source per port, and **auto-selects the two that report
  `deviceTypeName:"COMPANION"`** (env override: `MESHCORE_CANDIDATE_PORTS`),
  deleting the non-companion sources for a clean two-source state. `SRC_A_ID`/
  `SRC_B_ID` + node names/pubkeys are echoed for Phase 2/3 reuse.
- **Validated on live hardware** 2026-07-20: both companions connected + handshook
  (167/168 contacts), full vitest suite green (3157 suites, 0 failures),
  typecheck clean.
- See [[reference_meshcore_hw_rig_ports]] (auto-memory) for the rig port facts.

### Phase 2 — Messaging (companion↔companion + repeater DM auto-ack)  ⬜
Extend the script: resolve node A's source id and node B's public key (from B's
source local node / A's contacts; discover if B isn't a contact of A). DM A→B
(`POST /messages/send` toPublicKey=B → verify B's `/messages` shows inbound + A
observes `meshcore:send-confirmed`). Create a **dedicated test channel**
(`#mm-systest`, hashtag-derived) on both companions, then channel message A→B on
it (resolve its channelIdx → verify B receives). Resolve the Yeraze
Repeater public key by name/prefix from contacts → DM it → verify firmware
auto-ack (`meshcore:send-confirmed`).
**Exit:** all three messaging assertions pass; integrated + reported; suite green.

### Phase 3 — Remote-admin login + remote telemetry  ⬜
Extend the script: remote-admin login into the Yeraze Repeater via
`MESHCORE_REPEATER_ADMIN_PASSWORD` (SKIP the assertion if unset, assert success
otherwise) and wire the secret into `system-tests.yml` env. Remote telemetry poll
companion→other companion (`POST /nodes/:pk/telemetry/poll`, assert records
within timeout). Optionally upgrade the tolerate-404 MeshCore block in
`tests/api-exercise-test.sh:597-605` to real assertions. Update docs + this plan.
**Exit:** login (when secret present) + telemetry assertions pass; CI secret
plumbed; final phase reports PASS; docs updated; suite green.

## Risks / open items for architects to resolve at runtime

- **B must be a contact of A** for a companion→companion DM. Verify at runtime;
  run contact discovery/refresh if not present (Phase 2).
- **Serial port → node mapping is not deterministic** across reboots. The test
  should map all four devices (per the override) and let the app connect; resolve
  which source is "A" vs "B" by source order / node identity, not by assuming a
  port.
- **Device contention:** only one process can open a ttyUSB at a time. The
  MeshCore phase's container holds the ports for its duration; ensure teardown
  (`down -v`) releases them. Meshtastic phases use TCP, so no device conflict.
- **Source-creation payload** (exact `transport`/`baudRate`/`deviceType` fields
  the Sources API expects for a serial companion) must be confirmed against
  `sourceRoutes.ts` + `meshcoreConfig.ts` by the Phase 1 architect.
- If a needed status field (connected/deviceType) or source-create capability is
  missing from the API, a small backend addition may be required — flag it.
