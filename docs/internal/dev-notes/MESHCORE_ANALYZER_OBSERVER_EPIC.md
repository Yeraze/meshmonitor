# MeshCore Analyzer Observer MQTT Output — Epic Plan (#4457)

**Status:** Phase 1 complete (PR pending) — Phase 2 next
**Issue:** #4457 — publish packets heard by a MeshCore Companion source to a MeshCore Analyzer-compatible MQTT broker, so the node counts as an observer without a second app fighting over the serial port.
**Scope guard:** observation-only. MeshMonitor publishes; it never subscribes to or injects broker traffic into the mesh. The broker's admin-only `serial/commands` remote-serial feature is out of scope.

## Wire contract (recovered from source, 2026-07-31)

Upstream issue michaelhart/meshcore-mqtt-broker#9 has no reply. We built the contract from the broker and reference-client source instead (user confirmed this path):

- **Broker:** `michaelhart/meshcore-mqtt-broker` (aedes over WebSocket). FL Mesh confirmed it runs this backbone. LetsMesh preset: `mqtt-us-v1.letsmesh.net:443`, transport websockets, TLS on, QoS 0, keepalive 60.
- **Username:** `v1_{PUBLIC_KEY}` — full 64-hex uppercase companion public key.
- **Password:** JWT-style token. Header `{"alg":"Ed25519","typ":"JWT"}`; payload `{publicKey, iat, exp, aud}` (`aud` must match the broker's `AUTH_EXPECTED_AUDIENCE`); signature = Ed25519 over `base64url(header).base64url(payload)`, **hex-encoded uppercase** (not base64url). Signed with the node's 64-byte MeshCore (orlp) private key. Renew before `exp`; reference renews proactively on publish.
- **Topics:** `meshcore/{IATA}/{PUBLIC_KEY}/packets` and `/status`. `{IATA}` = 3-letter code or `test` (test region works for local validation). Broker uppercases IATA + pubkey in topics; strips retain from `/status`.
- **Every payload:** JSON with `origin_id` = the authenticated pubkey (uppercase), or the broker rejects it.
- **Packet payload** (match `michaelhart/meshcore-packet-capture`, the companion reference): origin (device name), origin_id, timestamp (ISO), type PACKET, direction rx, len, packet_type, route (F/D), payload_len, SNR, RSSI, MeshCore packet hash (per `Packet::calculatePacketHash`), path (hex byte list), raw hex, decoded payload fields (advert: public_key, advert_time, lat/lon, name, mode) with the reference's advert opt-in privacy filter.
- **Status payload:** `{status: online|offline, timestamp, origin, origin_id, model, firmware_version, radio, client_version}`, retained publish + LWT offline.
- **Dependency:** `@michaelhart/meshcore-decoder` 0.3.0, MIT, on npm. Provides `createAuthToken` (the broker verifies with this same library) and packet decode. Use it; do not hand-roll.

## Interview decisions (2026-07-31)

1. **Proceed now** against the open-source contract; validate against a local `meshcore-mqtt-broker` in Docker with the `test` region. Post findings back to #4457.
2. **Signing key:** fetch from the companion via `MeshCoreManager.exportPrivateKey()` (64B/128-hex, existing since #3933), with a manual-paste fallback. Store encrypted (credential-store AES-GCM pattern).
3. **Use `@michaelhart/meshcore-decoder`** (license verified MIT).
4. **Match the reference contract exactly** — no custom lat/lon fields; analyzers get observer location from the node's own ADVERT.

## Reuse inventory (verified in-repo)

- `src/server/transports/mqttBrokerClient.ts` — outbound client; `normalizeBrokerUrl` handles ws/wss/mqtts; self-managed backoff; `MqttReconnectCoordinator` for shared backoff.
- `src/server/mqttBridgePublisherPool.ts` — template for publisher lifecycle + `PublisherStatus` (connected, publishes, lastPublishAt, lastError).
- `ota_packet` event stream: `meshcoreNativeBackend.ts` L451-508 (LogRxData 0x88) → `meshcoreManager.ts` `this.emit('ota_packet', data)` (~L1785, **ungated** — built for feed consumers). Second-consumer precedent: `meshcoreVirtualNodeServer.ts` L334/L353 (`manager.on/off('ota_packet')`), `OtaPacketEvent` type at L181. Fields: payload_type(+string), route_type(+string), path_len_raw, hop_count, path_hops, snr, rssi, payload_size, raw_hex.
- `src/server/services/meshcoreCredentialStore.ts` — HKDF-SHA256 + AES-256-GCM envelope `{v,kid,iv,ct,tag}`; new purpose = new column + method pair (+ new KDF info string for key separation); `capability.canRemember` false when SESSION_SECRET is auto-generated.
- `MeshCoreManager.exportPrivateKey()` (`meshcoreManager.ts` ~L4442) — returns 128-hex or null; companion-only, must be connected.
- Config: `src/server/meshcoreConfig.ts` `MeshCoreSourceConfig`; validation pattern `validateVirtualNodeConfig()` in `sourceRoutes.ts` L40-64; restart-on-config-change hooks ~L515-L836; **`stripSourceSecrets()` L231-254 must learn any new secret field**.
- Status: `MqttBridgeStatus extends SourceStatus` (`mqttBridgeManager.ts` L186-240) is the shape to mirror; MeshCore `getStatus()` (`meshcoreManager.ts` ~L5596) is minimal today. Frontend polls via `useSourceStatuses` (`useDashboardData.ts` L122-138).
- Frontend form: MeshCore branch of the source modal in `DashboardPage.tsx` (state L133-152, config build L442-470/L545-610, JSX L1428-1577; virtualNode fieldset L1552-1572 is the model).
- No Ed25519 code exists in `src/` today; the decoder dep brings `@noble/ed25519`.

## Phases

### Phase 1 — Backend foundation: config + signing key + auth token
- [x] `observer` block in `MeshCoreSourceConfig`: `enabled`, `brokerUrl`, `iataCode`, `tokenAudience` (+ sane defaults); validation in `sourceRoutes`; secret fields added to `stripSourceSecrets`.
- [x] Encrypted signing-key storage (credential-store pattern; new column + migration on all 3 backends, idempotent).
- [x] Routes: import key from device (`exportPrivateKey()`), manual paste, clear, key-status; `requirePermission` source-scoped; response envelope helpers.
- [x] Token generation via `@michaelhart/meshcore-decoder` `createAuthToken`; add dep.
- [x] Tests incl. per-source isolation; token round-trips against the decoder's own `verifyAuthToken`.
- **Exit:** config + key round-trip through the API with secrets redacted; full suite green; merged PR.

### Phase 2 — Observer publisher service
- [ ] `meshcoreObserverPublisher` per source: `manager.on('ota_packet')`, analyzer-contract packet JSON (decoder lib for hash/decode/advert privacy), publish via `MqttBrokerClient` (wss), retained `/status` + LWT, token renewal, reconnect via coordinator.
- [ ] Lifecycle: start/stop with manager + restart on config change; observer status in `getStatus()` (connected, publishes, lastPublishAt, lastError).
- [ ] Tests with mocked broker; per-source isolation.
- **Exit:** live end-to-end against local `meshcore-mqtt-broker` (Docker, `test` region): token auth accepted, packets + status seen by a subscriber; merged PR.

### Phase 3 — Frontend UI + docs
- [ ] Observer fieldset in the MeshCore source modal: enable, broker URL, IATA, audience, fetch-key-from-device button + paste fallback, key-stored indicator.
- [ ] Observer status in the MeshCore config view via `useSourceStatuses` (connected / last publish / counters / last error).
- [ ] Browser validation on the dev container; user docs; report back to #4457.
- **Exit:** validated in the real UI; docs shipped; merged PR.

## Deviations / notes

### Phase 1

- **Public-key derivation.** The orlp public key is DERIVED via `Utils.derivePublicKey`, never read from bytes 32..64 of the private key — the epic's original assumption was wrong. A named regression test guards this (spec §2.2).
- **Signing key storage.** Keys live in a new `meshcore_observer_keys` table (migration 133), not a `sources` column, not `meshcore_nodes`, not a reused `source_pki_keys` row — see spec §3.1 for the reasoning. New KDF info strings `meshcore-observer-key-aead-v1` / `-fingerprint-v1` key-separate this store from the credential store.
- **Restart hook.** Phase 1 reuses the existing blanket MeshCore config-change restart. Phase 2 follow-up: a targeted `observerChanged` branch plus `manager.reconfigureObserver()` so toggling the observer stops bouncing the radio link.
- **Broker URL validation** rejects explicit foreign schemes (`http`, `https`, `tcp`, `tls`) before `normalizeBrokerUrl` runs, because `normalizeBrokerUrl` silently `mqtt://`-prefixes unknown schemes. A bare `host[:port]` still normalizes as intended.
- **Decoder library quirk.** The orlp validity check in `@michaelhart/meshcore-decoder` only requires private-key byte 31's top bit clear (weaker than full clamping), so a random 64-byte "invalid key" test fixture is ~50% flaky. Use the deterministic invalid fixture `'00'.repeat(31) + 'ff' + '00'.repeat(32)` instead. Also note `verifyAuthToken` checks `exp` against the real wall clock.
- **Spec gap found by the full suite.** New schema tables must be registered in `src/cli/migrationTables.ts` `TABLE_ORDER` (the `migrate-db` CLI census). Done, placed after `source_pki_keys`.
- **Route-test harness gap.** `harness.grant()` collides with the `permissions` table's `UNIQUE(user_id, resource, sourceId)` index when granting read then write separately. Tests needing both use a local `grantReadWrite()` helper that writes one row with both flags set.
- **Known gap (accepted).** A `meshcore_observer_keys` row orphans on source delete, same as `source_pki_keys` today. Cascade cleanup is deferred to its own change.
- **Phase 2 seam.** `mintObserverTokenForSource()` is intentionally unrouted — Phase 2's publisher is its first consumer.
