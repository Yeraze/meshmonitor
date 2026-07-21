# Epic — MeshCore System Tests

**Status:** Phases 1 & 2 COMPLETE + MERGED; Phase 3 validated on hardware, shipping (ALL PHASES DONE)
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

### Phase 2 — Messaging (companion↔companion + repeater DM auto-ack)  🔻 IN PROGRESS
Extend the script with three messaging assertions. **Live-hardware validation
(2026-07-20) forced a design change** — see the finding below.

**Live-hardware finding: companion↔companion DM does NOT work on this rig — RF
near-field, not a software/test bug.** Extensively diagnosed on the two live
companions (Sandbox on ttyUSB2, BLE Sandbox on ttyUSB3):
- **Works:** companion↔companion **channel** messaging on `#mm-systest` (both
  directions, ~3s); **Yeraze Repeater DM auto-ack** (`meshcore:send-confirmed`,
  ~492ms). Both kept as hard assertions.
- **Fails:** direct **DM between the two companions**, every configuration —
  A→B was HTTP 400 (A had no contact for B); B→A was 200 but never
  delivered/ACKed. `reset-path`+`discover-path` left the path null. After **both
  nodes flood-advert (`POST /advert`) + `contacts/refresh`**, contacts+paths WERE
  established (A→B `pathLen=1` via the repeater `66…`; B→A `pathLen=0` direct) —
  but the DM **still failed both directions**, even over the direct path.
- **Root cause:** broadcasts get through both ways (so both radios TX+RX to each
  other), yet the DM+ACK round-trip fails — the signature of **near-field
  receiver overload** (nodes ~3 inches apart). `autoRetryOnMiss` (#3979) only
  arms a *channel* echo-retry, not a DM flood-retry. Not fixable from the harness.
- **Decision (user, 2026-07-20):** ship channel + repeater DM as hard assertions;
  gate companion↔companion **DM behind `MESHCORE_COMPANION_DM`** (default SKIP —
  documents the limitation). The opt-in path first does advert-exchange +
  contact-refresh (proven to establish contacts/paths) then tries both directions
  via inbox OR `meshcore:send-confirmed`, for when the nodes are separated.

Assertions: (1) **companion↔companion channel** — create `#mm-systest` (hashtag
PSK = `SHA-256("#mm-systest")[:16]`, base64) on both companions, channel-message
A→B, verify B receives (hard). (2) **Yeraze Repeater DM auto-ack** — resolve the
repeater by name/`advType==2`, DM it, catch `meshcore:send-confirmed` via a Node
Socket.IO listener helper (hard). (3) **companion↔companion DM** — env-gated
opt-in, default SKIP (per finding above). Uses `tests/helpers/meshcore-await-ack.mjs`.
No `system-tests.sh` change (the Phase-1 phase already runs this script).
**Exit:** channel + repeater-DM assertions pass on hardware; companion↔companion
DM gated/skipped by default; typecheck + full vitest suite green.
See [[reference_meshcore_hw_rig_ports]] and the near-field-DM finding in memory.

### Phase 3 — Remote-admin login + remote telemetry  ✅ COMPLETE (2026-07-20)
Two assertions appended to `tests/test-meshcore.sh` (Tests 13-14) + a CI secret edit.

**Outcome / deviations (Phase 3):**
- **Test 13 — Repeater remote-admin login:** `POST /api/sources/$SRC_A_ID/meshcore/admin/login`
  body `{publicKey: REPEATER_PK, password}` (cookie + CSRF; password `jq -R`-escaped;
  no `rememberPassword` — that needs SESSION_SECRET). Success = HTTP 200 +
  `.success==true`. **SKIPs (exit 0) when `MESHCORE_REPEATER_ADMIN_PASSWORD` is
  unset**; hard-fails on 401 when set. Reuses Test 12's resolved `REPEATER_PK`.
- **Test 14 — Remote telemetry poll:** `POST /nodes/$REPEATER_PK/telemetry/poll`
  body `{"type":"status"}` on `SRC_A_ID`; success = `data.written >= 1`. 429-aware
  retry honoring `retryAfterSecs` (the per-source 60s mesh-TX gate can fire after
  Tests 12/13). Env: `MESHCORE_TELEMETRY_ATTEMPTS`(5)/`MESHCORE_TELEMETRY_INTERVAL`(20s).
- **DEVIATION — telemetry target is the REPEATER, not "the other companion":** the
  interview answer ("companion→other companion") predates the Phase 2 near-field
  finding. Companion→companion telemetry is a DM-style round-trip and fails the same
  way (near-field). Remote telemetry is a `type:"status"`/`"lpp"` round-trip to the
  target; a repeater answers `type:"status"` (16-field stats blob, no login needed)
  and is reachable. User chose **"Repeater only"** — so Test 14 polls the repeater
  status only (no companion-telemetry gate). Validated live: **16 records
  (`["status:16"]`)**.
- **CI:** step-level `env: MESHCORE_REPEATER_ADMIN_PASSWORD: ${{ secrets.* }}` on the
  "Run system tests" step of `system-tests.yml`. Absent secret → login SKIPs → green.
  The repo secret must be added by a human for CI to actually exercise login.
- `tests/api-exercise-test.sh:597-605` left as smoke checks (different container, 404
  is legitimately correct there — upgrading would false-fail).
- **No TS change.** Validated live 2026-07-20: connect + channel + repeater DM +
  telemetry (16 records) pass; login SKIPs locally (no password), exercised in CI.
**Exit:** telemetry assertion passes on hardware; login SKIPs by default (CI-validated
with secret); CI secret plumbed; suite green. ✅

## Epic complete
All three phases merged. `tests/test-meshcore.sh` is a hard-required phase in
`tests/system-tests.sh`, run on the self-hosted hw runner under the `system-test`
label. Env opt-ins: `MESHCORE_COMPANION_DM` (companion↔companion DM, near-field),
`MESHCORE_REPEATER_ADMIN_PASSWORD` (login), plus `MESHCORE_*_ATTEMPTS/INTERVAL`
tuning and `MESHCORE_CANDIDATE_PORTS`/`MESHCORE_REPEATER_PUBKEY`/
`MESHCORE_TEST_CHANNEL_SLOT` overrides. See memory: near-field DM limitation, rig
ttyUSB ports, Bash-framework decision.

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
