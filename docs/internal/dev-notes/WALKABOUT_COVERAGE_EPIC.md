# Walkabout Coverage Epic (#5891)

## Goal

Let an operator leave MeshMonitor and its radio at home (e.g. on a Pi) and walk
or drive with only a phone that has the web UI open. The phone's GPS becomes the
receiver position; every packet the home radio hears while the phone is at a spot
counts as "heard here". Shown as an H3 hex map like Corescope's `rx-coverage`.
Also: import of our own exported coverage files, and a repeater-only map chip.

MeshMonitor sends nothing for this feature (passive).

## Decisions (interview, 2026-11-25)

- **Phases:** four PRs, in order below.
- **Receiver position:** `navigator.geolocation.watchPosition()` in the browser.
  Needs a secure context (HTTPS or localhost). The UI must say so when it is
  missing; plain-HTTP LAN phones get no GPS.
- **Capture model:** the phone posts GPS samples to the server; the server tags
  every packet the source hears during a live session with the latest sample.
- **Credit:** the last-hop node, since our SNR measures only the last hop.
  Direct packet: the sender. Relayed: the relayer (Meshtastic `relay_node` byte,
  MeshCore last path hash) when it resolves to exactly one known node on that
  source; otherwise skip the reception.
- **Limits:** session hard cap 2 h; drop fixes with `accuracy > 100 m`, warn above
  30 m; at most one receiver sample per 5 s. Enforced server-side as well.
- **Storage:** new per-source tables (`coverage_walkabout_sessions`,
  `coverage_walkabout_samples`, plus receptions), separate from fixed-receiver
  Coverage data.
- **Retention:** sessions are kept until the operator deletes them (not
  `coverage_retention_days`).
- **Permission:** `nodes:write` on the source to start/stop/sample/delete;
  `nodes:read` to view (no grant gates Coverage surveys, so the original premise
  was corrected). Any reader of the source may see a session and its track.
- **Radio travels with the phone.** A fixed radio hears the same nodes wherever
  the phone is, so the Start dialog tells the operator to carry the radio.
- **Binning:** H3 via `h3-js`, lazy-loaded with the view. Server aggregates by
  cell (res 9, dropping to 8/7 zoomed out); best signal per cell; categorical
  buckets strong/medium/weak/no-signal (SNR defaults strong ≥ 0, medium −5…0,
  weak −10…−5, none < −10).
- **Sources:** Meshtastic and MeshCore sources that feed the Packet Monitor.
- **No events:** receptions are not emitted on `dataEventEmitter`.

## Phases

- [x] **P1 — Capture + storage.** Migration (3 backends) + repository + backup
  classification; session start/stop/sample/delete/list API; server-side
  reception capture for Meshtastic + MeshCore with last-hop credit; 2 h cap,
  accuracy and spacing filters; Walkabout panel (start/stop, consent,
  secure-context notice, accuracy warning, live sample + reception counts).
  *Exit:* a live session records samples and receptions; per-source isolation
  test; permission tests; full suite green on SQLite/PG/MySQL.
- [x] **P2 — H3 hex view.** Server cell aggregation endpoint; hex layer on
  `BaseMap`; bucket colours + legend; cell popup "N nodes heard here" with
  per-node best SNR + count; 24h/7d/14d/30d chips; Coverage Report gains a
  "Walkabout sessions" filter. Track and cell reads clip samples and receptions
  to `[startedAt, endedAt]` (one in-flight sample can land just after a stop).
  *Exit:* hexes render from real sessions; popup matches data.
- [x] **P3 — Coverage import.** Accept our exported GeoJSON/CSV; schema + row
  validation with clear errors; rows tagged `imported_from` + filename and
  filterable; round-trip test.
  *Exit:* export → import on a clean DB renders the same points.
- [ ] **P4 — Repeater-only map chip.** One-click map filter for repeater/router
  roles (Meshtastic ROUTER family, MeshCore repeater/room server).
  *Exit:* chip filters the main map for both protocols.

## Phase log

- **P1 (2026-11-25).** Spec: `WALKABOUT_P1_SPEC.md`. Migration 248; routes under
  `/api/sources/:id/walkabout`; Reports → Walkabout card (not a panel in the
  Coverage report, so the page stays light on a phone).
  - Deviations: no grant gated Coverage surveys, so `nodes:write`/`nodes:read`
    (maintainer). MQTT-fed sources cannot run walkabout (no local radio).
    Relay candidates: Meshtastic nodes heard in 24 h minus CLIENT_MUTE;
    MeshCore advType 2/3. Fix freshness 25 s (server clock); each reception
    stores `sampleAgeMs` so P2 can tighten it for drives.
  - Firmware: MeshCore repeaters strip their hash on direct routes and append
    on floods (`Mesh.cpp`), so an empty direct path is skipped as ambiguous.
    Meshtastic router-class relays may keep hop_limit for favourites
    (`Router.cpp shouldDecrementHopLimit`), so 0 hops with a foreign relay byte
    is treated as relayed.
  - Side PRs: #6568 (`lastHop.ts` CLIENT_MUTE was 4 = REPEATER), #6569 (Direct
    RF Contacts counted 0-hop relayed copies as direct).
  - Browser check: MeshCore session credited the nearby repeater as last hop;
    a quiet Meshtastic window credited nothing (all relayed, no relay byte).
    Real-phone test over HTTPS still to do; rate-limit headroom (Q7) unmeasured.

- **P2 (2026-11-25).** Spec: `WALKABOUT_P2_SPEC.md`. No schema change: H3 cells are
  computed on read (h3-js server-side; ~93 ms per 100k points), always binned at
  res 9 then rolled up with `cellToParent` (direct res-7/8 binning disagrees for
  6-7% of points). Zoom ≥ 14 → res 9, 12-13 → res 8, ≤ 11 → res 7. h3-js lives
  only in the lazy `WalkaboutHexMap` chunk (source-scan test + build check).
  - Decisions: hidden nodes' receptions dropped before binning, one
    `hiddenReceptionCount` banner (maintainer); fixed SNR bands, per-source
    bands in #6571 (maintainer).
  - Review fix: the hidden count is computed over each overlapping session's
    full span, never a narrowed since/until, so a sliding 10 s range cannot
    localise a hidden node. Probing a hidden `node=X` returns the same empty
    result and never its own truncation flag.
  - Also: P1 picker now lists readable sources (Start only where writable);
    Coverage Report View toggle gains Walkabout; custom ranges clamp to 31 days.
  - Known, not fixed: cells on the antimeridian skip the bbox prefilter (slower,
    still correct); a walk across ±180° fits a world-wide box.

- **P3 (2026-11-25).** Coverage import; user guide in `docs/features/coverage-report.md`.
  Table `coverage_imports` plus `coverage_receptions.importId` (migration 249).
  - Decisions: Coverage exports only, walkabout export/import is #6573; a node
    the target source never heard shows only to admins and holders of the
    source's base map permission; target needs `nodes:write`; limits 32 MB,
    10,000 rows per file, 50 imports and 200,000 rows per source.
  - Review fixes: bounded CSV parsing (a 32 MB file of short lines could OOM);
    imported rows never unmask a hidden live receiver position; delete/upload
    race and a crash sweep at startup; restore clears stale batches; backup
    skips orphan rows; bogus positions are skipped, not fatal.
  - Known, not fixed: a non-admin can't start a survey on a sender that exists
    only in imported data.
