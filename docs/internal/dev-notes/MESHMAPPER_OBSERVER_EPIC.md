# MeshMapper Observer Epic — issue #5014

**Goal:** let any MeshCore source contribute coverage data to MeshMapper and
LetsMesh with no extra observer hardware, by extending the existing per-source
Analyzer Observer from one broker to many.

Plan comment on the issue:
https://github.com/Yeraze/meshmonitor/issues/5014#issuecomment-5513926532

## Research facts (verified 2026-09-02)

- MeshMapper is **MeshCore-only**. Its observer ingestion path is MQTT, in the
  exact wire contract our Analyzer Observer already speaks
  (`src/server/services/meshcoreObserverPacket.ts`): topics
  `meshcore/{IATA}/{PUBLIC_KEY}/packets` + `/status`, packet JSON per
  `ObserverPacketPayload`, Ed25519 JWT auth (`v1_{PUBLIC_KEY}` username,
  `aud` claim) minted by `meshcoreObserverToken.ts`.
- Brokers: `wss://mqtt.meshmapper.net:443` (audience `mqtt.meshmapper.net`),
  LetsMesh `mqtt-us-v1.letsmesh.net` / `mqtt-eu-v1.letsmesh.net` (port 443,
  WebSockets + TLS). MeshMapper recommends dual-publish; it dedupes.
- Reference implementation: `agessaman/meshcore-packet-capture` (N sequential
  brokers, same topics/payload/JWT).
- The issue's "Third-Party API" link is the reverse direction (MeshMapper app
  → third-party endpoint); its CSV upload is admin-only legacy import. Neither
  is our path.

## Interview decisions (project owner, 2026-09-02)

1. **Approach:** extend the Analyzer Observer to multi-broker (config
   `brokers[]`, per-broker status); MeshMapper/LetsMesh become UI presets.
   NOT a separate parallel bridge.
2. **Filtering (packet type / node allow-block / bbox) and rate limiting:
   deferred.** v1 forwards everything, matching `meshcore-packet-capture`.
   Relay is passive — zero airtime cost.
3. **Status UI: both** — compact indicator on the Dashboard source card AND
   per-broker detail on `MeshCoreSourcePage.tsx`.
4. Corrected plan posted to #5014 before building.

Out of scope: Meshtastic data (MeshMapper has no ingestion for it), inbound
wardrive ingestion via MeshMapper's third-party endpoint API.

## Phases

### Phase 1 — Multi-broker observer backend ✅ status: [x] implemented (PR pending)

- `MeshCoreObserverConfig` gains `brokers[]` (url, authMode, tokenAudience,
  label); legacy single `brokerUrl` block normalized transparently at read
  time (config is a JSON blob in `sources.config` — no DB migration).
- `meshcoreObserverPublisher` becomes a per-broker client pool: shared packet
  stream + device identity; per-broker connect state, counters,
  drop-when-disconnected, `lastError` redaction. Credential store keyed
  per broker for password-mode brokers.
- New `GET /api/sources/:id/observer/status` route (closes the existing
  "getObserverStatus has no consumer" gap), envelope + `requirePermission`.
- Exit criteria: full Vitest suite green; tests prove one source publishing to
  2+ mock brokers concurrently, legacy config back-compat, per-broker
  credential isolation.

### Phase 2 — UI: broker list, presets, status ✅ status: [x] implemented (WP1-WP4)

- Observer fieldset on `DashboardPage.tsx` → broker-list editor with one-click
  presets: MeshMapper, LetsMesh US, LetsMesh EU, custom. Form↔config mapping
  in `DashboardPage.observerConfig.ts` extended (unit-tested).
- Status: indicator on Dashboard source card + per-broker panel (connected,
  publishes, dropped, last publish, last error) on `MeshCoreSourcePage.tsx`.
- User docs: "contribute to MeshMapper" guide.
- Exit criteria: browser-validated (configure MeshMapper + LetsMesh on a live
  source, watch status update); screenshots on the PR; suite green.

## Deviations / notes

### Phase 1 (implemented 2026-09-02)

- Spec: `MESHMAPPER_OBSERVER_PHASE1_SPEC.md`. Work packages WP1–WP4 as planned.
- No whole-config size guard — a universal 4096-byte cap would have made
  existing >4KB SQLite/PG configs uneditable. Instead: observer-block-only cap
  (`MAX_OBSERVER_CONFIG_BYTES` = 1536, `OBSERVER_CONFIG_TOO_LARGE`) plus a
  non-rejecting MySQL `logger.warn` when a whole blob exceeds 4096.
- `MISSING_BROKER` fires only when `brokers` was explicitly provided but
  yields no usable entry AND no legacy `brokerUrl` exists; a fully-absent
  `brokers` runs the exact pre-#5014 path (`INVALID_PARAMETER`), preserving
  every pre-existing assertion.
- Review fix: token renewal now excludes hard-stopped connections
  (`hardStoppedKeys`) — without it, the hourly renewal resurrected a
  connection that hard-stopped on auth failure and disabled its latch forever.
- `MAX_OBSERVER_BROKERS = 8` — above the three named brokers, keeps the blob
  small. Flag to project owner at PR review.
- Behaviour change (deliberate, in PR body): `MAX_AUTH_FAILURES` hard-stops
  only the offending connection, not the whole observer.

### Phase 2 (implemented 2026-09-02)

- Spec: `MESHMAPPER_OBSERVER_PHASE2_SPEC.md`. Work packages WP1-WP4 landed as
  four commits on `feature/observer-multibroker-ui`: WP1 (mapping module +
  `ApiService` methods), WP2 (fieldset editor + credential save path, plus its
  own test/i18n commit), WP3 (per-broker status panel + Dashboard badge), WP4
  (this doc pass).
- Presets verified against the upstream reference implementation
  (`agessaman/meshcore-packet-capture`), not assumed: MeshMapper
  `wss://mqtt.meshmapper.net:443` / audience `mqtt.meshmapper.net`; LetsMesh US
  `wss://mqtt-us-v1.letsmesh.net:443` / `mqtt-us-v1.letsmesh.net`; LetsMesh EU
  `wss://mqtt-eu-v1.letsmesh.net:443` / `mqtt-eu-v1.letsmesh.net`. All three are
  signed-token mode.
- No deviations from the spec's WP1-WP3 file-by-file plan found while writing
  docs (WP4). User docs at `docs/features/meshcore-analyzer-observer.md` now
  cover: multi-broker editor + presets, the legacy-config migration-on-save,
  per-broker credentials and save-order requirement, a new "Contribute to
  MeshMapper" walkthrough, a "Multiple brokers" behaviour section, the
  per-broker status panel, and the Dashboard `OBS c/N` badge.
