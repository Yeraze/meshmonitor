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

### Phase 1 — Multi-broker observer backend ✅ status: [ ] not started

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

### Phase 2 — UI: broker list, presets, status ✅ status: [ ] not started

- Observer fieldset on `DashboardPage.tsx` → broker-list editor with one-click
  presets: MeshMapper, LetsMesh US, LetsMesh EU, custom. Form↔config mapping
  in `DashboardPage.observerConfig.ts` extended (unit-tested).
- Status: indicator on Dashboard source card + per-broker panel (connected,
  publishes, dropped, last publish, last error) on `MeshCoreSourcePage.tsx`.
- User docs: "contribute to MeshMapper" guide.
- Exit criteria: browser-validated (configure MeshMapper + LetsMesh on a live
  source, watch status update); screenshots on the PR; suite green.

## Deviations / notes

(record per phase)
