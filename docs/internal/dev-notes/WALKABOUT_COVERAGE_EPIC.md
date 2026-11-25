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
- **Permission:** starting/stopping/deleting a session needs the per-source write
  grant that gates saving Coverage surveys; viewing needs read on that source.
- **Binning:** H3 via `h3-js`, lazy-loaded with the view. Server aggregates by
  cell (res 9, dropping to 8/7 zoomed out); best signal per cell; categorical
  buckets strong/medium/weak/no-signal (SNR defaults strong ≥ 0, medium −5…0,
  weak −10…−5, none < −10).
- **Sources:** Meshtastic and MeshCore sources that feed the Packet Monitor.
- **No events:** receptions are not emitted on `dataEventEmitter`.

## Phases

- [ ] **P1 — Capture + storage.** Migration (3 backends) + repository + backup
  classification; session start/stop/sample/delete/list API; server-side
  reception capture for Meshtastic + MeshCore with last-hop credit; 2 h cap,
  accuracy and spacing filters; Walkabout panel (start/stop, consent,
  secure-context notice, accuracy warning, live sample + reception counts).
  *Exit:* a live session records samples and receptions; per-source isolation
  test; permission tests; full suite green on SQLite/PG/MySQL.
- [ ] **P2 — H3 hex view.** Server cell aggregation endpoint; hex layer on
  `BaseMap`; bucket colours + legend; cell popup "N nodes heard here" with
  per-node best SNR + count; 24h/7d/14d/30d chips; Coverage Report gains a
  "Walkabout sessions" filter.
  *Exit:* hexes render from real sessions; popup matches data.
- [ ] **P3 — Coverage import.** Accept our exported GeoJSON/CSV; schema + row
  validation with clear errors; rows tagged `imported_from` + filename and
  filterable; round-trip test.
  *Exit:* export → import on a clean DB renders the same points.
- [ ] **P4 — Repeater-only map chip.** One-click map filter for repeater/router
  roles (Meshtastic ROUTER family, MeshCore repeater/room server).
  *Exit:* chip filters the main map for both protocols.

## Phase log
