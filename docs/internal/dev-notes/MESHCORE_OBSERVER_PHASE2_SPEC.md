# MeshCore Analyzer Observer — Phase 2 Implementation Spec

**Epic:** #4457 (`MESHCORE_ANALYZER_OBSERVER_EPIC.md`)
**Phase:** 2 — Observer publisher service (backend only, no UI)
**Depends on:** Phase 1 (merged: config block, `meshcore_observer_keys` + migration 133, key store, token minter, key routes)
**Branch:** `feature/meshcore-observer-mqtt-phase2`

Phase 1 shipped every input the publisher needs and deliberately left
`mintObserverTokenForSource()` unrouted as its seam. Phase 2 builds the consumer:
one publisher per MeshCore Companion source that relays every OTA packet the
radio hears to a MeshCore-Analyzer-compatible MQTT broker, publishes online/offline
status, and never subscribes to anything.

---

## 0. Decisions made in this spec (read first)

| # | Decision | Rationale |
|---|---|---|
| **D-1** | Two new modules: a **pure encoder** (`meshcoreObserverPacket.ts`) and a **stateful publisher** (`meshcoreObserverPublisher.ts`). | The encoder is 100% deterministic → golden-testable with fixed hex, no mocks. Keeping MQTT out of it is what makes §7.2 possible. |
| **D-2** | **Do not** use `MeshCorePacketDecoder.calculateMessageHash()` from `@michaelhart/meshcore-decoder` for the `hash` field. | Verified in `node_modules/@michaelhart/meshcore-decoder/src/decoder/packet-decoder.ts`: `calculateMessageHash` is a 32-bit djb2-style rolling hash rendered as **8** hex chars. It is **not** `Packet::calculatePacketHash`. The analyzer contract's `hash` is SHA-256-derived, 16 upper-hex chars. We implement it (§2.3). |
| **D-3** | Path/payload boundary uses the **packed** `path_len` decode (`hashSize=(b>>6)+1`, `hopCount=b&0x3f`), **not** the reference's plain-byte-count read. | For 1-byte hash mode (`b ≤ 0x3f` — effectively all real traffic) the two are **byte-identical**, so hashes still match every other observer. In multi-byte hash mode the reference is simply wrong against firmware `Packet.h`, and would emit a hash nobody can reproduce. A named test pins the divergence. |
| **D-4** | The published packet payload carries **no decoded advert fields**. | Verified against `packet_capture.py`: `format_packet_data()` copies only `route_type`/`payload_type`/`path` out of the decode result. The advert fields parsed by `parse_advert()` are **never** merged into `packet_data`. The "advert opt-in privacy filter" (`name.endswith('^')`) therefore has **zero** observable effect on the wire. We replicate the wire, so we publish no advert fields at all and implement no filter. This is both byte-faithful and the privacy-safest option. |
| **D-5** | `MqttBrokerClient` gains two optional constructor options: `will` and `keepalive`. | It has no LWT support today and the contract requires one. ~6 lines, additive, default-preserving. Justified in §1. |
| **D-6** | Reconnect uses the client's **own** backoff (1 s → 60 s, stability-gated). **No** `MqttReconnectCoordinator`. | The coordinator exists to collapse N sockets to the *same* broker into one shared timer (`mqttBridgePublisherPool`). The observer opens exactly one socket per source; a coordinator would be an empty abstraction. |
| **D-7** | `reconfigureObserver()` hot-swap **is in scope** for Phase 2 (WP6). | Phase 1 §4.2 deferred it only because there was nothing to swap into. There is now. Without it, toggling the observer runs `removeManager` → `ensureMeshCoreManagerStarted`, bouncing the companion serial/TCP link for seconds. `sourceRoutes.ts` already carries the Phase-1 TODO comment marking the exact insertion point (~L983). |
| **D-8** | `timestamp` is emitted as **UTC ISO-8601 with `Z`** (`new Date().toISOString()`), not the reference's naive local `datetime.now().isoformat()`. | A naive local timestamp is un-disambiguatable by any consumer; the broker itself parses it with `new Date(...)` in its stale-status filter. `Z` is strictly more correct and universally parsed. Recorded as a deliberate deviation. |
| **D-9** | Token is minted at connect + on a renewal timer; a renewal **tears down and rebuilds** the `MqttBrokerClient`. | mqtt.js bakes `username`/`password` into the CONNECT packet at `connect()` time; there is no supported credential-refresh API. Mutating the options object does not re-read. Recreating the client is the only correct path (this is also what the reference does — `reconnect_mqtt_broker_with_new_token`). |
| **D-10** | The observer status sub-object is **stripped for anonymous / non-`nodes:read` callers** in `GET /api/sources/:id/status`. | That route is `optionalAuth()` and returns the bare status early when `!canReadNodes` (`sourceRoutes.ts` L1118-1120). `lastError` can contain the broker hostname. Stripping is one branch and keeps the leak surface at zero. |
| **D-11** | The observer is **not** gated on `meshcore_packet_log_enabled`. | It consumes `manager.emit('ota_packet')` (`meshcoreManager.ts` L1793), which is emitted unconditionally, *before* the packet-log gate in `handleOtaPacket()`. Same second-consumer posture as the Virtual Node bridge (#3963). |
| **D-12** | No new global settings, no `VALID_SETTINGS_KEYS` entry, no migration, no schema change. | Everything the publisher needs is already per-source: the `observer` config block (Phase 1) and the `meshcore_observer_keys` row (Phase 1). |

---

## 1. Reuse inventory (MANDATORY — read before writing any code)

Nothing below is to be re-implemented. Anything new is justified in §1.13.

### 1.1 The event source — `manager.on('ota_packet')`

| What | Where | Notes |
|---|---|---|
| Emit site | `src/server/meshcoreManager.ts` L1782-1795 | `else if (event_type === 'ota_packet')` → `this.emit('ota_packet', data)`. **Deliberately not gated** on the packet-monitor setting (comment at L1786-1791 says so explicitly). |
| Producer | `src/server/meshcoreNativeBackend.ts` L492-503 | Emits `{ payload_type, payload_type_string, route_type, route_type_string, path_len_raw, hop_count, path_hops, snr, rssi, payload_size, raw_hex }`. **Native (Companion) backend only** — the serial/CLI repeater backend never emits it. This is the mechanical reason the observer is companion-only, matching Phase 1's `OBSERVER_REQUIRES_COMPANION` validation. |
| Declared event shape | `src/server/meshcoreVirtualNodeServer.ts` L180-188 (`OtaPacketEvent`) | `{ snr?, rssi?, raw_hex? }`. **Import this type; do not redeclare it.** |
| Second-consumer precedent | `meshcoreVirtualNodeServer.ts` L336 (`on`), L353 (`off`), L1312-1330 (`handleOtaPacket`) | The exact pattern to copy: bound arrow-property listener registered in `start()`, removed in `stop()`, handler is sync, returns early on empty `raw_hex`, never throws. |

> **Trap (verified):** `payload_size` on the event is `raw.length` — the **whole frame**, not the payload. Do **not** wire it to the contract's `payload_len`. Likewise `path_len_raw` is the raw packed byte and `hop_count` is already decoded. The encoder derives everything from `raw_hex` itself (§3.1) so it has one source of truth and one thing to golden-test.

### 1.2 MQTT client — `MqttBrokerClient`

`src/server/transports/mqttBrokerClient.ts` (476 lines).

| What | Where | Notes |
|---|---|---|
| `connect(url, opts)` passthrough | L180 | Uses mqtt.js `connect()`, which supports `ws:`, `wss:`, `mqtt:`, `mqtts:` natively. **No change needed for wss.** |
| `publish(topic, payload, retained)` | L277-286 | QoS 0, promise-wrapped. Exactly our need. |
| Self-managed backoff | L128-137, L287-333 | `reconnectPeriod: 0` on mqtt.js; own 1 s→60 s exponential with a 30 s stability gate before reset. Reuse; do **not** add a second retry layer. |
| Auth-rejection classification | L219-235 | CONNACK code 4/5 → `authFailed = true` + `emit('permission-denied', { kind: 'auth', message })`. This is the hook for §6's auth-cooldown. |
| `isConnected()` / `getLastError()` | L355-361 | Status plumbing. |
| `normalizeBrokerUrl()` | L465-476 | Already applied by `observerConfigFromSource` (Phase 1). Do not call it twice. |

**Verified gaps that WP2 fills (D-5):**
- `MqttBrokerClientOptions` has **no `will`** field, and `connect()` never sets one. The contract requires an LWT.
- `keepalive` is hardcoded to `15` (L171). The LetsMesh preset is 60. 15 is safe (more frequent pings; the broker also runs WS ping/pong) but make it overridable so the observer can match the preset.

**Verified non-issues, do not "fix":**
- `lookup: sharedDnsLookup` (L177) is a net/tls socket option. For `ws`/`wss` mqtt.js builds the socket via the `ws` package and passes only `opts.wsOptions`, so `lookup` is silently ignored on websocket transports. Harmless — no DNS caching on wss, that is all.
- `rejectUnauthorized` is likewise not forwarded on `wss` for the same reason. Public analyzer brokers use valid certs (`ws`'s own default already verifies), so this does not matter. Do not add a `wsOptions` plumbing layer for it.

**Trap:** `publish()` only guards on `!this.client`, not on `connected`. mqtt.js queues QoS-0 publishes while offline (`queueQoSZero` defaults true), so a disconnected observer on a busy mesh would grow an unbounded in-memory queue. The publisher **must** gate on `isConnected()` itself (§3.2).

### 1.3 Status shape precedent

| What | Where |
|---|---|
| `MqttBridgeStatus extends SourceStatus` | `src/server/mqttBridgeManager.ts` L186-228 — the "extend the base status with a feature sub-object" precedent. |
| `PublisherStatus` | `src/server/mqttBridgePublisherPool.ts` L45-52 — `{ clientId, connected, publishes, lastPublishAt, lastError }`. Our observer status is this shape plus `configured` / `keyStored` / `dropped` / `tokenExpiresAt`. |
| `getStatus()` builder | `mqttBridgePublisherPool.ts` L94-106 — read counters off the entry, `connected` off the live client. |
| `SourceStatus` base | `src/server/sourceManagerRegistry.ts` L8-15 |
| MeshCore `getStatus()` | `src/server/meshcoreManager.ts` L5604-5611 — the four-field return we extend. |

### 1.4 Lifecycle mirror sites

The observer binds to exactly the four places the Virtual Node server already binds:

| Site | `meshcoreManager.ts` | Action |
|---|---|---|
| `connect()` success | L1173 `await this.startVirtualNodeServer()` | add `await this.startObserver()` immediately after |
| `disconnect()` | L1314 `await this.stopVirtualNodeServer()` | add `await this.stopObserver()` immediately before |
| unexpected socket drop | L6037 | same |
| `teardownTransportOnly()` | L6069 | same |

`startVirtualNodeServer()` (L1236-1255) / `stopVirtualNodeServer()` (L1257-1265) are the exact shape to copy: idempotent (`if (!cfg?.enabled || this.x) return`), try/catch, non-fatal, null the field on failure.

### 1.5 Hot-swap precedent (WP6)

| What | Where |
|---|---|
| Registry passthrough | `src/server/sourceManagerRegistry.ts` L114-127 (`reconfigureVirtualNode`) — duck-typed `typeof manager.reconfigureX === 'function'` guard, returns `false` when unsupported. |
| Route branch | `src/server/routes/sourceRoutes.ts` L895-900 (`vnChanged` branch) |
| Insertion point | `sourceRoutes.ts` ~L978-998 — the MeshCore config-change branch, which already carries the Phase-1 TODO comment naming `manager.reconfigureObserver(...)`. |

### 1.6 Phase 1 seams

| What | Where | Contract |
|---|---|---|
| `observerConfigFromSource(cfg)` | `src/server/meshcoreConfig.ts` | Returns `undefined` unless enabled **and** all of `brokerUrl`/`iataCode`/`tokenAudience` present; normalizes URL, uppercases IATA, trims audience. |
| `MeshCoreConfig.observer` | `src/server/meshcoreManager.ts` L352 | Already plumbed through both `meshcoreConfigFromSource` branches. Read it as `this.config?.observer`. |
| `mintObserverTokenForSource(sourceId)` | `src/server/services/meshcoreObserverToken.ts` L118 | `Promise<ObserverToken \| null>`; `{ token, publicKey, issuedAt, expiresAt }`. **Refined in WP3** — see §3.3. |
| `OBSERVER_TOKEN_TTL_SECONDS` | same, L33 | `86_400`. |
| Key store | `src/server/services/meshcoreObserverKeyStore.ts` | `getMeshCoreObserverKeyStore()` → `.status(sourceId): Promise<ObserverKeyStatus>` (`{ stored, publicKey, origin, updatedAt, keyRotated, canStore, reason }`), `.load(sourceId)` → `{kind:'none'\|'ok'\|'key_rotated'}`. Use `.status()` for the `keyStored` flag; never call `.load()` from status code. |

### 1.7 Packet decode reference

`src/utils/meshcorePacketDecode.ts` — `decodeMeshCorePacket(rawHex)` (L140) already does the packed `path_len` decode (L179-181) that D-3 requires, plus payload-boundary math.

**Do not call it from the encoder.** It returns a UI-shaped object (`hops` as hex strings, `payloadTypeName`, `errors[]`) and is a browser-targeted module; the encoder needs raw byte offsets to feed SHA-256 and must be dependency-free for the golden tests. **Do** cross-check the encoder's parse against it: WP1 adds a test asserting the encoder's `(payloadType, routeType, hopCount, payloadStart)` agrees with `decodeMeshCorePacket()` on every fixture. If they ever disagree, one of them is wrong.

### 1.8 Existing packet field vocabulary

`src/server/services/meshcorePacketLogService.ts` + `meshcoreManager.handleOtaPacket()` (L1810-1835) already extract `payload_type`, `route_type`, `path_len_raw`, `hop_count`, `path_hops`, `snr`, `rssi`, `payload_size`, `raw_hex`. Use the same *names* when logging; the analyzer contract's names differ and are fixed by §2.

### 1.9 Test fixtures

`src/server/meshcoreNativeBackend.otaPacket.test.ts` (L108-140) has real `rawHex` fixtures for a TXT_MSG flood packet and an ADVERT direct packet. `src/utils/meshcorePacketDecode.test.ts` has more. **Source WP1's golden fixtures from these files** rather than hand-rolling frames.

### 1.10 Test mocking approach

`src/server/transports/mqttBrokerClient.test.ts` L1-26 is the canonical mqtt.js mock: `vi.mock('mqtt', () => ({ connect: vi.fn(() => makeFakeClient()) }))` where `makeFakeClient()` is an `EventEmitter` with `subscribe`/`publish`/`end`/`reconnect` stubs, plus `lastFakeClient()` / `lastConnectOptions()` accessors. **Copy this for WP2 and WP4.**

`src/server/mqttBridgeManager.permission.test.ts` L1-70 runs a **real Aedes** broker on an ephemeral port for auth/ACL behaviour. Use that style only if a mock cannot express the case; it is slower.

### 1.11 Response envelope / route conventions

`src/server/utils/apiResponse.ts` (`ok` / `fail`). **Not applicable to WP5's status change** — `GET /:id/status` returns a bare `res.json(status)` object today and `ApiService.request()` does not unwrap `data`. Converting it would break every consumer. Leave the wire shape alone; only add/strip the `observer` key.

### 1.12 App version

`require('../../../package.json')` — pattern at `src/server/services/newsService.ts` L14, `routes/healthRoutes.ts` L8.

### 1.13 What is genuinely new, and why

| New file/change | Why nothing existing covers it |
|---|---|
| `meshcoreObserverPacket.ts` | The analyzer wire format is a third-party contract (string-typed numerics, `SNR`/`RSSI` capitalisation, `route` single letters, `hash` = SHA-256[:16] upper). Nothing in-repo emits it. Pure + golden-tested. |
| `meshcoreObserverPublisher.ts` | No existing service owns "one authenticated publish-only MQTT socket per MeshCore source with token renewal". `mqttBridgePublisherPool` is Meshtastic-gateway-keyed and bridge-scoped. |
| `will` / `keepalive` on `MqttBrokerClientOptions` | Verified absent (§1.2). Additive and default-preserving. |
| `mintObserverTokenForSourceDetailed()` | Phase 1's null-for-all-failures contract cannot distinguish "no key" from "envelope rotated" from "config incomplete" — the publisher needs those for `lastError` (§6). Added **alongside** the existing function, which becomes a wrapper so Phase 1's tests keep passing unchanged. |

---

## 2. The wire contract, verified against source

Recovered by reading `michaelhart/meshcore-packet-capture@main/packet_capture.py` (2286 lines) and `michaelhart/meshcore-mqtt-broker@main/src/server.ts` (1004 lines) on 2026-07-31.

### 2.1 Connection

| Item | Value | Source |
|---|---|---|
| Transport | Broker listens **plain WebSocket** on `MQTT_WS_PORT` (default 8883); TLS is terminated externally (Cloudflare tunnel). Public deployments are therefore `wss://host:443`; a local broker is `ws://localhost:8883`. | `server.ts` L817-830, L972 |
| Username | `v1_{PUBLIC_KEY}` — `PUBLIC_KEY` is 64 hex chars, uppercased by the broker before matching | `server.ts` L184-198 |
| Password | The Phase-1 JWT-style token. Broker calls `verifyAuthToken(password, publicKey)` from the **same** `@michaelhart/meshcore-decoder` we mint with | `server.ts` L207` |
| Audience | Rejected unless `tokenPayload.aud === AUTH_EXPECTED_AUDIENCE` (broker's env). Empty audience env ⇒ check skipped | `server.ts` L220-225 |
| MQTT version | 3.1.1 (aedes) — `MqttBrokerClient` already pins `protocolVersion: 4` | — |
| QoS | 0 everywhere. The reference explicitly downgrades QoS 1 → 0 "to prevent retry storms" | `packet_capture.py` L1470-1472 |

### 2.2 Topics

```
meshcore/{REGION}/{PUBLIC_KEY}/packets
meshcore/{REGION}/{PUBLIC_KEY}/status
```

Broker rules (`server.ts` `authorizePublish`, L252-410) — **violating any of these closes the connection**, not just rejects the publish:

1. Topic must start with `meshcore/` and split into **≥ 4** parts.
2. `parts[1]` (region): literal `XXX` → **disconnect**. Case-insensitive `test` → allowed, normalized to lowercase `test`. Otherwise must match `/^[A-Z]{3}$/` **and** resolve via `airport-utils.getAirportInfo()` → else **disconnect**.
3. `parts[2]` must be 64 hex chars **and** equal the authenticated public key → else **disconnect**.
4. Broker rewrites the topic to `meshcore/{normalizedRegion}/{UPPER_PUBKEY}/{rest}`.
5. Any payload published to a `meshcore/...` topic must parse as JSON containing `origin_id` that uppercases to the authenticated key → else publish rejected (`server.ts` L435-455).
6. `packet.retain` is **stripped** from any topic ending in `/status` (L261-266). Publish it retained anyway — the reference does, and the flag is simply cleared.

**Publisher-side region normalization:** Phase 1's `observerConfigFromSource` uppercases `iataCode`, yielding `TEST` for the test region. Publish `test` lowercase yourself so the topic needs no broker rewrite:

```ts
const region = cfg.iataCode.toLowerCase() === 'test' ? 'test' : cfg.iataCode.toUpperCase();
```

**Subscribe: never.** `authorizeSubscribe` (L559-590) closes any publisher client that subscribes to anything other than its own `/serial/commands`. Remote serial is explicitly out of scope (§10), so the observer's subscription set is empty — this is an invariant, not a default.

### 2.3 Packet payload — exact field set

Source: `packet_capture.py` `format_packet_data()` L1717-1833. This dict **is** the published JSON (`output_packet()` L1938-1975 does `json.dumps(packet_data)` straight to the `packets` topic). Key order is irrelevant; presence, name, and **type** are not.

| Key | JSON type | Value | Reference line |
|---|---|---|---|
| `origin` | string | Device name | L1810 |
| `origin_id` | string | 64-hex **UPPERCASE** public key | L1811 |
| `timestamp` | string | ISO-8601 — see **D-8** | L1812 |
| `type` | string | Literal `"PACKET"` | L1813 |
| `direction` | string | Literal `"rx"` | L1814 |
| `time` | string | `HH:MM:SS`, **local** | L1815 |
| `date` | string | `DD/MM/YYYY`, **local** | L1816 |
| `len` | **string** | Total frame bytes, decimal | L1817 |
| `packet_type` | **string** | Payload type as a decimal string `"0"`…`"15"` | L1818 |
| `route` | string | `"F"` / `"D"` / `"T"` / `"U"` | L1819 |
| `payload_len` | **string** | Payload bytes, decimal | L1820 |
| `raw` | string | Whole OTA frame, **UPPERCASE** hex | L1821 |
| `SNR` | **string** | `String(snr)` or `"Unknown"` — note capitalisation | L1822 |
| `RSSI` | **string** | `String(rssi)` or `"Unknown"` | L1823 |
| `hash` | string | 16 **UPPERCASE** hex chars (§2.3.2) | L1824 |
| `path` | string | **Present only when `route === "D"`**; comma-joined 2-hex-char hop tokens, e.g. `"a1,b2,c3"` | L1828-1829 |

Every numeric is a **string**. Emitting `len: 42` instead of `len: "42"` is a contract violation.

#### 2.3.1 `route` mapping

Reference `route_map` (L1741-1746) keyed on the route-type **name**:

| `route_type` | name | `route` |
|---|---|---|
| `0x00` | `TRANSPORT_FLOOD` | `"F"` |
| `0x01` | `FLOOD` | `"F"` |
| `0x02` | `DIRECT` | `"D"` |
| `0x03` | `TRANSPORT_DIRECT` | `"T"` |
| decode failed | — | `"U"` (and `packet_type` falls back to `"0"`, `payload_len` to `"0"`) |

Note `TRANSPORT_DIRECT` maps to `"T"`, **not** `"D"` — so a `TRANSPORT_DIRECT` packet gets **no** `path` key.

#### 2.3.2 `hash` — `Packet::calculatePacketHash`

Reference `calculate_packet_hash()` L1668-1716:

```
payload_type = (header >> 2) & 0x0F
route_type   = header & 0x03
offset       = 1 + (route_type in {0x00, 0x03} ? 4 : 0)   # skip transport codes
path_len_raw = bytes[offset]; offset += 1
offset      += pathByteLength(path_len_raw)                # ← D-3: packed decode
payload      = bytes[offset..]

sha = SHA256()
sha.update([payload_type])                                  # 1 byte
if payload_type == 9:  sha.update(uint16le(path_len_raw))   # TRACE only, 2 bytes
sha.update(payload)
hash = sha.hexdigest()[0:16].upper()                        # 16 upper-hex chars
```

On any exception the reference returns the literal `"0000000000000000"`. **Replicate that sentinel** — never throw out of the encoder.

`pathByteLength(b)` per **D-3**:
```ts
if (b === 0xff) return 0;                    // direct, no relay hashes
return (b & 0x3f) * (((b >> 6) & 0x03) + 1); // hopCount × hashSize
```
For `b ≤ 0x3f` this equals `b` — identical to the reference's plain read.

#### 2.3.3 `payload_len`

Reference prefers the firmware-supplied `payload_length` from the RF-log event, else computes `total − 1 − transportBytes − 1 − pathBytes` (L1774-1786). Our event has no equivalent field (`payload_size` is the whole frame — §1.1 trap), so **always compute**, using the same offsets as §2.3.2. Clamp at `0`.

#### 2.3.4 Advert fields — **not published** (D-4)

`decode_and_publish_message()` (L1579-1667) parses adverts and applies the opt-in rule (merge only when `name` ends with `"^"`, otherwise record the key prefix in `opted_in_ids` and merge nothing). `format_packet_data()` then reads only `route_type`, `payload_type`, `payload_type_value`, and `path` from that result — the advert fields are dead-ended. **Publish no advert fields and implement no filter.**

Also note the reference's advert branch does `payload_value["name"]` unguarded, so a nameless advert raises `KeyError`, is swallowed by the outer `except`, and returns `None` — degrading that packet to `route="U", packet_type="0", payload_len="0"`. **Do not replicate that bug**; our decode is total and never degrades a well-formed advert. Record as a deviation.

### 2.4 Status payload

Source: `publish_status()` L1369-1387 (online) and the LWT literal at L1355-1366 (offline).

| Key | Type | Online | Offline (LWT) |
|---|---|---|---|
| `status` | string | `"online"` | `"offline"` |
| `timestamp` | string | ISO-8601 | ISO-8601 |
| `origin` | string | device name | device name |
| `origin_id` | string | 64-hex UPPER | 64-hex UPPER |
| `model` | string | from DeviceQuery, else `"unknown"` | *(absent in the reference LWT)* |
| `firmware_version` | string | e.g. `"v1.16.1 (Build: …)"`, else `"unknown"` | *(absent)* |
| `radio` | string | radio params, else `"unknown"` | *(absent)* |
| `client_version` | string | `"{name}/{version}"` | *(absent)* |

Emit the online form with `retain: true` immediately after CONNACK, and register the offline form as the LWT.

**Verified upstream quirk — the LWT is (usually) never delivered.** `authorizeForward` (L637-660) blocks any `/status` message whose `timestamp` is older than the last one seen for that `origin_id`. The LWT payload is fixed at CONNECT time, so its timestamp is always *older* than the online status published milliseconds later, and the broker drops it as stale. This affects the reference identically. Do not work around it. Instead: on **graceful** stop, publish an explicit `offline` status (fresh timestamp) before disconnecting — that one is delivered.

### 2.5 Field sources on our side

| Contract field | Source | Fallback |
|---|---|---|
| `origin` | `manager.getLocalNode()?.name` | `manager.getStatus().sourceName` → `"MeshMonitor"` |
| `origin_id` | `token.publicKey` (already UPPER from Phase 1) | — |
| `model` | `localNode.model` | `"unknown"` |
| `firmware_version` | `localNode.ver` → `"v{ver}"`, plus `" (Build: {firmwareBuild})"` when present | `"unknown"` |
| `radio` | `` `${radioFreq},${radioBw},${radioSf},${radioCr}` `` when all four present on `localNode` | `"unknown"` |
| `client_version` | `` `meshmonitor/${pkg.version}` `` | — |

`MeshCoreNode` fields are at `meshcoreManager.ts` L372-406. `model`/`ver`/`firmwareBuild` are populated in-memory by the telemetry poller and may be undefined — the fallbacks are load-bearing, not decorative.

---

## 3. New modules

### 3.1 `src/server/services/meshcoreObserverPacket.ts` (NEW, pure)

No imports from the manager, the DB, mqtt, or the logger. `node:crypto` only.

```ts
/** Contract payload published to meshcore/{REGION}/{PUBKEY}/packets. Every numeric is a string. */
export interface ObserverPacketPayload {
  origin: string;
  origin_id: string;
  timestamp: string;
  type: 'PACKET';
  direction: 'rx';
  time: string;
  date: string;
  len: string;
  packet_type: string;
  route: 'F' | 'D' | 'T' | 'U';
  payload_len: string;
  raw: string;
  SNR: string;
  RSSI: string;
  hash: string;
  /** Present ONLY when route === 'D'. Comma-joined 2-hex-char hop tokens. */
  path?: string;
}

export interface ObserverStatusPayload {
  status: 'online' | 'offline';
  timestamp: string;
  origin: string;
  origin_id: string;
  model?: string;
  firmware_version?: string;
  radio?: string;
  client_version?: string;
}

export interface ObserverPacketIdentity {
  origin: string;
  originId: string;   // UPPER 64-hex
}

/** Structural parse of an OTA frame. Never throws; `ok:false` on any problem. */
export interface ObserverFrameParse {
  ok: boolean;
  payloadType: number;      // 0..15
  routeType: number;        // 0..3
  pathLenRaw: number | null;
  hopCount: number;
  hashSize: number;
  /** Per-hop relay hashes, lowercase hex, `hashSize` bytes each. */
  hops: string[];
  payloadStart: number;     // byte offset of the payload
  payloadLen: number;
  totalBytes: number;
}

/** Decode a packed path_len byte → total path bytes on the wire. 0xff ⇒ 0. */
export function pathByteLength(pathLenRaw: number): number;

/** Structural parse from raw hex. Total; never throws. */
export function parseObserverFrame(rawHex: string): ObserverFrameParse;

/**
 * MeshCore `Packet::calculatePacketHash` — SHA-256 over
 * [payload_type] (+ uint16le(path_len_raw) for TRACE) + payload,
 * first 8 bytes as 16 UPPERCASE hex chars.
 * Returns '0000000000000000' on any parse failure (reference parity).
 */
export function calculateMeshCorePacketHash(rawHex: string): string;

/** Build the analyzer-contract packet payload. Never throws. */
export function buildObserverPacketPayload(
  event: OtaPacketEvent,
  identity: ObserverPacketIdentity,
  now?: Date,
): ObserverPacketPayload | null;   // null iff raw_hex is missing/blank

export function buildObserverStatusPayload(
  status: 'online' | 'offline',
  identity: ObserverPacketIdentity,
  device?: { model?: string; firmwareVersion?: string; radio?: string; clientVersion?: string },
  now?: Date,
): ObserverStatusPayload;

/** meshcore/{region}/{PUBKEY}/{packets|status}. Applies the `test`-lowercase rule. */
export function observerTopics(iataCode: string, publicKey: string): {
  region: string; packets: string; status: string;
};
```

Implementation notes:
- `now` is an injectable `Date` — every golden test passes a fixed one. Default `new Date()`.
- `time` = `HH:MM:SS` zero-padded from `now.getHours/Minutes/Seconds` (**local**, reference parity).
  `date` = `DD/MM/YYYY` zero-padded from `now.getDate/getMonth()+1/getFullYear` (**local**).
  `timestamp` = `now.toISOString()` (**UTC**, D-8).
  The local/UTC split is deliberate and mixed — read §7.1's timezone-discipline callout
  before writing a single golden assertion for these three fields.
- `SNR`/`RSSI`: `typeof event.snr === 'number' ? String(event.snr) : 'Unknown'`. `String(6.25)` → `"6.25"`, matching Python's `str(6.25)`. `String(-9)` → `"-9"`. Do **not** `.toFixed()`.
- `raw`: `rawHex.replace(/[^0-9a-fA-F]/g, '').toUpperCase()`.
- `path`: emitted only when `route === 'D'`, as `hops.join(',')`, hops lowercase (reference derives them from a Python `.hex()`). When `hopCount === 0`, the key is present with value `""` — matching `",".join([])`.
- `parseObserverFrame` must set `ok:false` (→ `route:'U'`, `packet_type:'0'`, `payload_len:'0'`, no `path`) when: fewer than 2 bytes; truncated before/inside transport codes; truncated before `path_len`; `payloadStart > totalBytes`; or `payloadVersion !== 0`. That last one mirrors the reference's `VER_1`-only gate (L1622-1626). `len`, `raw`, `hash`, and the identity/timestamp fields are still emitted.
- `hashSize === 4` (bits 7:6 = `11`) is reserved — treat as `ok:false`.

### 3.2 `src/server/services/meshcoreObserverPublisher.ts` (NEW)

```ts
export interface MeshCoreObserverStatus {
  /** observer.enabled AND all three config fields present. */
  configured: boolean;
  /** A signing key row exists AND is decryptable under the current SESSION_SECRET. */
  keyStored: boolean;
  connected: boolean;
  publishes: number;
  /** Packets dropped because the socket was down (see §1.2 trap). */
  dropped: number;
  lastPublishAt: number | null;
  lastError: string | null;
  /** Unix SECONDS (matches ObserverToken.expiresAt). */
  tokenExpiresAt: number | null;
}

export interface MeshCoreObserverPublisherOptions {
  sourceId: string;
  config: NonNullable<MeshCoreConfig['observer']>;
  /** Live device facts, read lazily at publish/status time. */
  device: () => {
    origin: string; model?: string; firmwareVersion?: string; radio?: string;
  };
  /** Injection seams for tests. */
  mintToken?: (sourceId: string) => Promise<ObserverTokenResult>;
  createClient?: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
}

export class MeshCoreObserverPublisher {
  constructor(options: MeshCoreObserverPublisherOptions);

  /** Mint → connect → publish online status. Resolves even on failure (state is in getStatus()). */
  start(): Promise<void>;

  /** Publish an explicit offline status (§2.4), then disconnect. Idempotent. */
  stop(): Promise<void>;

  /** Sync, never throws. Call from the manager's `ota_packet` listener. */
  handleOtaPacket(event: OtaPacketEvent): void;

  getStatus(): MeshCoreObserverStatus;
  isRunning(): boolean;
}
```

Behaviour:

**`start()`**
1. `mintToken(sourceId)` (default `mintObserverTokenForSourceDetailed`). Non-`ok` → set `lastError` from §6's table, `keyStored` from the result kind, **return without connecting**. No retry loop, no crash.
2. `keyStored = true`, `tokenExpiresAt = token.expiresAt`.
3. Compute topics via `observerTopics(config.iataCode, token.publicKey)`.
4. Build the LWT payload now (`buildObserverStatusPayload('offline', identity)`).
5. `createClient({ url: config.brokerUrl, username: 'v1_' + token.publicKey, password: token.token, clientIdPrefix: 'meshmonitor-observer', keepalive: 60, will: { topic: topics.status, payload: Buffer.from(JSON.stringify(lwt)), qos: 0, retain: true } })`.
6. Wire listeners **before** `connect()`:
   - `connect` → `connected = true`, `lastError = null`, reset `authFailures`, publish the retained `online` status.
   - `close` / `offline` → `connected = false`.
   - `error` → `lastError = redactToken(err.message)`.
   - `permission-denied` `{kind:'auth'}` → `authFailures++`; at `MAX_AUTH_FAILURES` (5) call the internal hard-stop (§6).
7. `await client.connect()` (resolves on CONNACK **or** first error — L246-258).
8. Arm the renewal timer (`setInterval`, `RENEWAL_CHECK_MS = 3_600_000`, `.unref()`).

**`handleOtaPacket(event)`** — the hot path, called once per received radio packet:
```
if (!client || !client.isConnected()) { dropped++; return; }
const payload = buildObserverPacketPayload(event, identity);
if (!payload) return;                                   // blank raw_hex
void client.publish(topics.packets, Buffer.from(JSON.stringify(payload)), false)
  .then(() => { publishes++; lastPublishAt = Date.now(); })
  .catch(err => { lastError = redactToken(err.message); });
```
No `await`, no throw, **no token minting** (Phase 1 §2.5: minting is a WASM Ed25519 signature — per-packet is unaffordable).

**Renewal** (D-9) — on each timer tick, renew when

```ts
nowSeconds >= tokenExpiresAt - (RENEWAL_CHECK_MS / 1000 + RENEWAL_THRESHOLD_S)
//            i.e. expiresAt - (3600 + 300) = expiresAt - 3900s
```

> **The check interval must be inside the threshold (deliberate deviation from the
> reference constants).** The reference tests `now >= expires_at - JWT_RENEWAL_THRESHOLD`
> (300 s) on a 3600 s interval (`packet_capture.py` L594-606, L2212-2240), which leaves
> an expiry hole: a tick landing at `exp − 301 s` does not renew, and the next tick fires
> ~55 min **after** expiry. An already-established connection survives that window —
> aedes verifies the token only at CONNECT (`server.ts` L207) — but any reconnect inside
> it auth-fails, and the resulting `lastError` ("Broker rejected the observer auth
> token…") sends the operator hunting through `tokenAudience` and the stored key instead
> of at a stale password. Folding the check interval into the threshold guarantees at
> least one tick fires before expiry. Renewing early is free (one Ed25519 signature) and
> strictly safe, so widen the window rather than shorten the interval. Against the 24 h
> `OBSERVER_TOKEN_TTL_SECONDS` this renews at ~22 h 55 m.

On a tick that meets the condition:
1. `mintToken(sourceId)`; non-`ok` → `lastError`, leave the existing connection alone, retry next tick.
2. Tear down the current client (`await client.disconnect()`), build a **new** one with the fresh password + a fresh LWT, connect, republish `online`.
3. A renewal that fails to connect leaves `connected = false`; the new client's own backoff drives recovery.

**`stop()`** — clear the timer; if connected, publish `offline` (best-effort, swallow errors); `await client.disconnect()`; null the client; `connected = false`.

**`redactToken(msg)`** — a private helper that strips anything matching the token shape (`/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[0-9A-Fa-f]{128}/`) from a message before it lands in `lastError`, which is user-visible. Phase 1 §5.5 logging discipline: **never** log the token, the private key, or the password field.

### 3.3 `meshcoreObserverToken.ts` — refinement (WP3)

Add, without changing any existing export's behaviour:

```ts
export type ObserverTokenResult =
  | { kind: 'ok'; token: ObserverToken }
  | { kind: 'not_configured' }      // source missing, not meshcore, or observer block absent/incomplete
  | { kind: 'no_key' }              // no row in meshcore_observer_keys
  | { kind: 'key_rotated' }         // envelope encrypted under a different SESSION_SECRET
  | { kind: 'mint_failed'; message: string };  // derive/sign threw

export async function mintObserverTokenForSourceDetailed(
  sourceId: string,
): Promise<ObserverTokenResult>;
```

`mintObserverTokenForSource()` becomes a two-line wrapper:
```ts
const r = await mintObserverTokenForSourceDetailed(sourceId);
return r.kind === 'ok' ? r.token : null;
```
Phase 1's tests for it must pass **unmodified** — that is WP3's acceptance gate.

`mint_failed.message` must be the WASM/library error text, which Phase 1 §5.5 says must not escape to a user surface; the publisher maps it to a fixed string (§6) and logs the detail at `debug`.

### 3.4 `MqttBrokerClientOptions` — additive (WP2)

```ts
export interface MqttBrokerClientOptions {
  // …existing…
  /** MQTT Last Will and Testament. Forwarded verbatim to mqtt.js. */
  will?: IClientOptions['will'];
  /** Keepalive seconds. Defaults to 15 (Meshtastic-firmware parity). */
  keepalive?: number;
}
```
In `connect()` (L163-179): `keepalive: this.options.keepalive ?? 15,` and `...(this.options.will ? { will: this.options.will } : {}),`. Omitting `will` when unset keeps the connect-options object byte-identical for every existing caller.

---

## 4. Manager integration (WP5)

`src/server/meshcoreManager.ts`:

```ts
private observerPublisher: MeshCoreObserverPublisher | null = null;
private readonly onObserverOtaPacket = (data: OtaPacketEvent): void => {
  this.observerPublisher?.handleOtaPacket(data);
};

/**
 * Start the Analyzer Observer publisher (opt-in, Companion only). Idempotent
 * and non-fatal — a broker that is down must never block the device link.
 */
private async startObserver(): Promise<void> {
  const obs = this.config?.observer;
  if (!obs?.enabled || this.observerPublisher) return;
  if (!this.nativeBackend) return;            // repeater/serial never emits ota_packet
  try {
    this.observerPublisher = new MeshCoreObserverPublisher({
      sourceId: this.sourceId,
      config: obs,
      device: () => ({
        origin: this.localNode?.name || this.sourceName || 'MeshMonitor',
        model: this.localNode?.model,
        firmwareVersion: this.localNode?.ver
          ? `v${this.localNode.ver}${this.localNode.firmwareBuild ? ` (Build: ${this.localNode.firmwareBuild})` : ''}`
          : undefined,
        radio: formatRadioInfo(this.localNode),
      }),
    });
    this.on('ota_packet', this.onObserverOtaPacket);
    await this.observerPublisher.start();
  } catch (err) {
    logger.error(`[MeshCore:${this.sourceId}] Failed to start Analyzer Observer: ${(err as Error).message}`);
    this.off('ota_packet', this.onObserverOtaPacket);
    this.observerPublisher = null;
  }
}

private async stopObserver(): Promise<void> {
  if (!this.observerPublisher) return;
  this.off('ota_packet', this.onObserverOtaPacket);
  try { await this.observerPublisher.stop(); }
  catch (err) { logger.debug(`[MeshCore:${this.sourceId}] Observer stop threw: ${(err as Error).message}`); }
  this.observerPublisher = null;
}

getObserverStatus(): MeshCoreObserverStatus | undefined {
  return this.observerPublisher?.getStatus();
}
```

Call sites: exactly the four in §1.4.

**`formatRadioInfo(node)`** — module-local helper: returns `` `${radioFreq},${radioBw},${radioSf},${radioCr}` `` when all four are numbers, else `undefined`.

**Listener-leak guard:** `off()` runs in `stopObserver()` **and** in `startObserver()`'s catch. `EventEmitter` default `maxListeners` is 10; a manager that starts/stops the observer repeatedly without removing would warn. WP5's test asserts `manager.listenerCount('ota_packet')` returns to its baseline after a start/stop cycle.

### 4.1 Status surface (D-10)

`meshcoreManager.getStatus()` (L5604):
```ts
getStatus(sourceName?: string): MeshCoreSourceStatus {
  const observer = this.observerPublisher?.getStatus();
  return {
    sourceId: this.sourceId,
    sourceName: sourceName ?? this.sourceName,
    sourceType: 'meshcore',
    connected: this.connected,
    ...(observer ? { observer } : {}),
  };
}
```
with `export interface MeshCoreSourceStatus extends SourceStatus { observer?: MeshCoreObserverStatus }`.

Spreading conditionally keeps the JSON byte-identical for every source without an observer — no existing consumer sees a new key.

`src/server/routes/sourceRoutes.ts` `GET /:id/status`, at the `!canReadNodes` early return (L1118-1120):
```ts
if (!canReadNodes) {
  const { observer: _observer, ...publicStatus } = status as Record<string, unknown>;
  return res.json(publicStatus);
}
```
This is the **only** change to that route. The authorized path already spreads `...status`, so `observer` flows through untouched.

---

## 5. Hot-swap (WP6)

**`meshcoreManager.reconfigureObserver(newObserverConfig)`** — mirrors `reconfigureVirtualNode`:
```ts
async reconfigureObserver(observer: MeshCoreObserverConfig | undefined): Promise<void> {
  await this.stopObserver();
  if (this.config) this.config.observer = observerConfigFromSource({ observer } as MeshCoreSourceConfig);
  if (this.connected) await this.startObserver();
}
```
Note it re-runs `observerConfigFromSource` so the hot-swap path normalizes identically to the boot path (URL normalization, IATA uppercase, audience trim, and the incomplete-block → `undefined` rule). Passing the raw block through would let an incomplete config start a publisher that the boot path would have refused.

**`sourceManagerRegistry.reconfigureObserver(sourceId, cfg)`** — copy L114-127 verbatim, swapping the method name.

**`sourceRoutes.ts` PUT branch** (~L978-998) — replace the unconditional restart with:
```ts
const oldObs = JSON.stringify((existing.config as any)?.observer ?? null);
const newObs = JSON.stringify((source.config as any)?.observer ?? null);
const observerChanged = oldObs !== newObs;
const restOfConfigChanged = !deepEqualIgnoring(existing.config, source.config, ['observer']);

if (observerChanged && !restOfConfigChanged) {
  await sourceManagerRegistry.reconfigureObserver(source.id, (source.config as any)?.observer);
} else {
  /* existing removeManager → ensureMeshCoreManagerStarted restart */
}
```
`deepEqualIgnoring` is a small local helper (compare `JSON.stringify` of both configs with the named keys deleted from shallow clones). **Fail safe:** if it cannot decide, take the restart branch. The restart branch is the status quo and always correct; the hot-swap branch is the optimization.

Delete the Phase-1 TODO comment above that block in the same commit.

---

## 6. Failure modes, error table, backoff

| Condition | Detected where | `lastError` | Behaviour |
|---|---|---|---|
| `observer.enabled` false / block incomplete | `startObserver()` | — | Publisher never constructed; `getStatus()` returns `undefined`; no `observer` key on the source status. |
| Repeater / serial source | `startObserver()` (`!this.nativeBackend`) | — | Never starts. Belt-and-braces behind Phase 1's `OBSERVER_REQUIRES_COMPANION` validation. |
| No signing key stored | `mintToken` → `no_key` | `"No observer signing key stored for this source."` | `keyStored:false`, `connected:false`. **No connect attempt, no retry loop.** Recovery = import a key (Phase 1 route) + config change / reconnect. |
| `SESSION_SECRET` rotated | `mintToken` → `key_rotated` | `"Stored observer signing key cannot be decrypted (SESSION_SECRET changed). Re-import the key."` | Same as above. |
| Mint threw (WASM/derive) | `mintToken` → `mint_failed` | `"Failed to mint observer auth token."` (library text at `debug` only) | Same as above. |
| Broker unreachable / DNS / TCP refused | `client` `error` + `close` | redacted `err.message` | `MqttBrokerClient`'s own 1 s→60 s backoff (§1.2). Nothing new. |
| Auth rejected (CONNACK 4/5) | `permission-denied` `{kind:'auth'}` | `"Broker rejected the observer auth token (check tokenAudience and the stored key)."` | `authFailures++`. **Below 5:** let the client's backoff retry with the *same* token — do not re-mint (a fresh token with the same key/audience would be rejected identically; re-minting per attempt is the hot-loop we must avoid). **At 5:** hard-stop — clear the renewal timer, `await client.disconnect()`, null the client, `connected:false`, keep `lastError`. Recovery = config change (WP6 hot-swap) or source reconnect. |
| Broker closes on a topic-policy violation | `close` (no CONNACK error) | last `err.message`, else `null` | Should be unreachable: the region is validated by Phase 1's `validateObserverConfig`, and the pubkey in the topic is *by construction* the authenticated key. If it happens the client just reconnects. |
| Publish rejected (`origin_id` mismatch) | — | — | Unreachable by construction: `origin_id` and the topic pubkey come from the same `token.publicKey`. A regression test asserts they are the same string. |
| Socket down when a packet arrives | `handleOtaPacket` | — | `dropped++`, return. **Never** hand it to mqtt.js's offline queue (§1.2 trap). |
| Malformed / truncated `raw_hex` | `parseObserverFrame` | — | Publishes with `route:'U'`, `packet_type:'0'`, `payload_len:'0'`, `hash:'0000000000000000'`. Never throws, never drops the packet. |
| Blank / missing `raw_hex` | `buildObserverPacketPayload` → `null` | — | Silently skipped (mirrors VN `handleOtaPacket` L1325). |

Constants: `MAX_AUTH_FAILURES = 5`, `RENEWAL_CHECK_MS = 3_600_000`, `RENEWAL_THRESHOLD_S = 300` — the same three values as the reference (`packet_capture.py` L184-186, L200-203).

**The renewal *predicate* deliberately differs.** The reference compares against
`expires_at − RENEWAL_THRESHOLD_S` alone; we compare against
`expires_at − (RENEWAL_CHECK_MS / 1000 + RENEWAL_THRESHOLD_S)`. Testing only the
threshold on a coarser interval leaves an expiry hole — see the callout in §3.2 for
the full reasoning. Any change to `RENEWAL_CHECK_MS` must keep it inside the effective
window, i.e. the predicate must always subtract the interval as well as the threshold;
never hardcode `3900`.

---

## 7. Test plan

Standard Vitest. No new test infrastructure. Every new test file lives beside its module.

### 7.1 `meshcoreObserverPacket.test.ts` — golden tests (the core of this phase)

Fixtures: reuse the real `rawHex` strings from `src/server/meshcoreNativeBackend.otaPacket.test.ts` (L112-140) and `src/utils/meshcorePacketDecode.test.ts`. Minimum coverage:

> **Timezone discipline — read before writing the goldens.** `time` and `date` come from
> **local** getters (`getHours`/`getDate`/…), per the reference (§3.1). Hardcoding
> `"14:30:05"` against a `new Date('2026-07-31T14:30:05Z')` passes on a UTC CI runner and
> fails on any developer machine in another zone. Three rules:
> 1. **Whole-object goldens** build the expected `time`/`date` from the *same* fixed
>    `Date` via its own local getters, with a comment saying this mirrors the
>    implementation's TZ handling. Everything else in the object — including
>    `timestamp` — stays a hardcoded literal.
> 2. `timestamp` is `toISOString()` (UTC, `Z`) and is **always** hardcoded. It is
>    TZ-independent by construction and is the field that would silently regress if D-8
>    were undone, so it must be pinned by a literal, not recomputed.
> 3. Do **not** set `process.env.TZ` or reach for a TZ-mocking helper. Pinning the zone
>    would hide a real bug: an implementation that switched to UTC getters must fail
>    these tests for every non-UTC operator.

- **Full-payload golden**, fixed `now`, for each of: FLOOD TXT_MSG, DIRECT (with hops), TRANSPORT_FLOOD, TRANSPORT_DIRECT, ADVERT. Assert the **entire object** with `toEqual` — this is what pins the contract. `timestamp` is a literal; `time`/`date` are derived from the same fixed `Date`'s local getters per rule 1 above.
- **`time`/`date` format (named test, TZ-independent):** construct the `Date` from **local components** — `new Date(2026, 6, 5, 9, 4, 3)` (5 Jul 2026, 09:04:03 local, deliberately single-digit in every position) — so the local getters return exactly those values in every zone. Assert the hardcoded strings `time === '09:04:03'` and `date === '05/07/2026'`. This is the zero-padding and `DD/MM` (not `MM/DD`) regression guard.
- **`time`/`date` shape:** across all goldens, `time` matches `/^\d{2}:\d{2}:\d{2}$/` and `date` matches `/^\d{2}\/\d{2}\/\d{4}$/`.
- **Type discipline:** every one of `len`, `packet_type`, `payload_len`, `SNR`, `RSSI` is `typeof === 'string'`. A named test, because this is the easiest thing to regress.
- **`path` presence:** present iff `route === 'D'`; absent for `F`, `T`, `U`; `""` when `route === 'D'` with zero hops.
- **`route` map:** all four route types plus the decode-failure `'U'`.
- **`hash`:**
  - matches a hand-computed SHA-256 for a fixed frame (compute the expected in the test from `node:crypto`, spelling out the `[payload_type] + payload` input — do not just re-call the function);
  - TRACE (`payload_type === 9`) includes `uint16le(path_len_raw)` — assert it differs from the same frame hashed without it;
  - returns `'0000000000000000'` for `''`, `'zz'`, and a 1-byte frame;
  - is 16 chars, `/^[0-9A-F]{16}$/`.
- **D-3 divergence (named test):** a synthetic frame with `path_len_raw = 0x81` (2-byte hashes × 1 hop). Assert our `payloadStart`/`hash` follow the packed decode, and document in the test body that the Python reference would read 129 path bytes here and produce a different hash. Also assert that for every `path_len_raw ≤ 0x3f` fixture, packed and plain agree.
- **`ok:false` paths:** empty, 1-byte, truncated-before-transport-codes, truncated-before-path-len, truncated path, `payloadVersion !== 0`, reserved `hashSize === 4`.
- **`SNR`/`RSSI`:** `6.25 → "6.25"`, `-9 → "-9"`, `0 → "0"` (not `"Unknown"` — a `0` SNR is real data), `undefined/null → "Unknown"`.
- **Cross-check vs. `decodeMeshCorePacket`:** for every fixture, `parseObserverFrame` agrees with `decodeMeshCorePacket` on payload type, route type, hop count, and payload size.
- **`observerTopics`:** `'TEST'`/`'test'` → `meshcore/test/...`; `'MCO'` → `meshcore/MCO/...`; pubkey uppercased.
- **`buildObserverStatusPayload`:** online includes all 8 keys; offline omits the optional four; `origin_id` is uppercase.

### 7.2 `meshcoreObserverPublisher.test.ts`

Mock mqtt.js per §1.10 and inject `mintToken`.

- **Connect wiring:** `lastConnectOptions()` has `username === 'v1_' + PUBKEY`, `password === token`, `keepalive === 60`, `will.topic === 'meshcore/test/PUBKEY/status'`, `will.retain === true`, and the will payload parses to `{status:'offline', origin_id: PUBKEY}`.
- **Online status on connect:** emit `connect` on the fake client → exactly one publish to `.../status`, `retain === true`, payload `status:'online'`.
- **Never subscribes:** after start + connect + 10 `handleOtaPacket` calls, `fakeClient.subscribe` was never called. **Assert this explicitly — it is the phase's headline invariant.**
- **Packet publish:** `handleOtaPacket` → one publish to `.../packets`, `retain === false`, payload deep-equals `buildObserverPacketPayload(...)`.
- **`origin_id` === topic pubkey** for both packet and status publishes.
- **Backpressure:** with the client not connected, 5 `handleOtaPacket` calls → `publish` never called, `getStatus().dropped === 5`.
- **Counters:** `publishes`, `lastPublishAt`, and `lastError` (on a rejected publish) all move correctly.
- **`no_key` / `key_rotated` / `mint_failed`:** `start()` resolves, `createClient` never called, `getStatus()` has the right `keyStored` + `lastError`, and no timer is left armed (`vi.getTimerCount()`).
- **Auth cooldown:** emit `permission-denied {kind:'auth'}` ×5 → client disconnected, `isRunning() === false`, `lastError` set, `mintToken` called **exactly once** total (proves no per-attempt minting).
- **Renewal (fake timers):** `expiresAt` inside the effective window (`expiresAt − 3900s`) → on tick, `mintToken` called a second time, the old client's `end` called, a **new** `connect` with the new password, and a fresh `online` status published.
- **Renewal window boundary (named test — the §3.2/§6 defect):** a token whose `expiresAt` sits at `now + 3600 + 300 + 60` (i.e. **outside** the 300 s threshold but **inside** one check interval of expiry) **must** renew on the first tick. Under the reference's threshold-only predicate this test fails, and the next tick would land after expiry. Assert `mintToken` was called a second time on tick 1. Also assert the negative: `expiresAt` at `now + 7200` does **not** renew on tick 1.
- **Renewal mint failure:** old client untouched, `lastError` set, retried on the next tick.
- **`stop()`:** publishes `offline` **before** `end`, is idempotent, clears the timer.
- **Token redaction:** force an `error` whose message embeds a token-shaped string; assert `getStatus().lastError` does not contain it.

### 7.3 `meshcoreManager.observer.test.ts`

- Observer not constructed when `observer` is absent / `enabled:false` / incomplete; `getStatus()` has **no** `observer` key.
- Observer not constructed on a source with no native backend (repeater), even with a complete config.
- `ota_packet` emitted on the manager reaches `publisher.handleOtaPacket` (spy).
- **Ungated (D-11):** with `meshcorePacketLogService.isEnabled()` mocked `false`, the observer still receives the packet. Named test.
- Start → stop → start leaves `manager.listenerCount('ota_packet')` at its baseline.
- `disconnect()` calls `publisher.stop()`.
- `getStatus()` embeds the observer sub-object when running.

### 7.4 Per-source isolation (**required**)

`meshcoreObserverPublisher.perSource.test.ts`: two publishers with different `sourceId`, key, and IATA.
- Distinct topics; neither publishes to the other's.
- A packet handed to A never appears on B's client.
- Counters are independent.
- `mintToken` is called with the correct `sourceId` by each.

### 7.5 Route status test

`sourceRoutes.observerStatus.test.ts` using `createRouteTestApp()` (**required** for new route tests — CLAUDE.md):
- Anonymous `GET /:id/status` → **no** `observer` key.
- A user without `nodes:read` on that source → no `observer` key.
- A user with `nodes:read` → `observer` present with the full shape.
- Admin → present.
- A source with no observer configured → no `observer` key for anyone (no `undefined` leak).

### 7.6 `mqttBrokerClient.test.ts` additions

- `will` forwarded verbatim to `mqtt.connect`.
- `will` **absent** from connect options when not supplied (no `undefined` key) — protects existing callers.
- `keepalive` defaults to 15; honours an override.

### 7.7 Token module

Extend `meshcoreObserverToken.test.ts`:
- `mintObserverTokenForSourceDetailed` returns each of the five kinds under the right conditions.
- `mintObserverTokenForSource` still returns `ObserverToken | null` identically — **Phase 1's existing assertions must pass unmodified.**

### 7.8 Suite hygiene

- Full Vitest run, 0 failures, before the PR. PostgreSQL/MySQL containers are **not** required — Phase 2 touches no schema, no migration, and no repository.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty. Do **not** run `npm run lint:baseline`.
- New code must not add `any`. `OtaPacketEvent`'s fields are optional — narrow with `typeof x === 'number'`, never cast.

---

## 8. Appendix — E2E validation recipe (run manually; **not** in CI)

The broker repo ships **no** Dockerfile and no compose file (verified against the repo tree), so this runs it from source inside a `node:24` container. It requires network access to clone and to `npm install`.

### 8.1 Bring up the broker

```bash
mkdir -p /tmp/mc-broker && cd /tmp/mc-broker
git clone --depth 1 https://github.com/michaelhart/meshcore-mqtt-broker.git broker
```

`/tmp/mc-broker/broker/.env` — **every** variable below is mandatory: `loadMqttConfig` / `loadAbuseConfig` / `loadSubscriberConfig` call `validateRequiredEnvVars()` and `process.exit(1)` on any missing key (`src/config.ts`).

```dotenv
MQTT_WS_PORT=8883
MQTT_HOST=0.0.0.0
AUTH_EXPECTED_AUDIENCE=mqtt.local.test

SUBSCRIBER_MAX_CONNECTIONS_DEFAULT=5
SUBSCRIBER_1=viewer1:viewerpass:2

ABUSE_ENFORCEMENT_ENABLED=false
ABUSE_DUPLICATE_WINDOW_SIZE=100
ABUSE_DUPLICATE_WINDOW_MS=300000
ABUSE_DUPLICATE_THRESHOLD=10
ABUSE_MAX_DUPLICATES_PER_PACKET=5
ABUSE_DUPLICATE_RATE_THRESHOLD=0.3
ABUSE_DUPLICATE_RATE_WINDOW_MS=300000
ABUSE_BUCKET_CAPACITY=20
ABUSE_BUCKET_REFILL_RATE=3
ABUSE_MAX_PACKET_SIZE=255
ABUSE_MAX_TOPICS_PER_DAY=3
ABUSE_ANOMALY_THRESHOLD=10
ABUSE_MAX_IATA_CHANGES_24H=3
ABUSE_TOPIC_HISTORY_SIZE=50
ABUSE_TOPIC_HISTORY_WINDOW_MS=86400000
ABUSE_PERSISTENCE_PATH=/tmp/abuse-detection.db
ABUSE_PERSISTENCE_INTERVAL_MS=300000
ABUSE_STATE_RETENTION_MS=604800000
```

`/tmp/mc-broker/docker-compose.yml`:
```yaml
services:
  meshcore-broker:
    image: node:24
    working_dir: /app
    volumes:
      - ./broker:/app
    command: sh -c "npm install --no-audit --no-fund && npm start"
    ports:
      - "8883:8883"
    environment:
      PUPPETEER_SKIP_DOWNLOAD: "true"
```

```bash
cd /tmp/mc-broker && docker compose up   # keep this terminal open
```

Ready when the banner prints `WebSocket MQTT listening on: ws://0.0.0.0:8883`.

> The broker is **plain WebSocket** — the URL is `ws://`, not `wss://`. TLS is terminated upstream in production. Port 8883 here is a *WebSocket* port, not the MQTTS port, so **do not** let `normalizeBrokerUrl` see a bare `host:8883` (it would prefix `mqtts://`, L473). Always type the full `ws://localhost:8883` into the source config.

### 8.2 Configure the MeshMonitor source

Against the dev container (`./scripts/api-test.sh login`, admin/`changeme`):

1. Ensure a MeshCore **Companion** source is connected.
2. Import its signing key — Phase 1 route:
   `./scripts/api-test.sh post /api/sources/<id>/observer/key/import '{}'`
   Confirm the response has `stored: true` and a 64-hex `publicKey`; **record it** as `$PUBKEY`.
3. `PUT /api/sources/<id>` with `config.observer`:
```json
{ "observer": { "enabled": true,
                "brokerUrl": "ws://localhost:8883",
                "iataCode": "test",
                "tokenAudience": "mqtt.local.test" } }
```
`tokenAudience` **must** string-equal `AUTH_EXPECTED_AUDIENCE` or CONNACK is rejected.

### 8.3 Subscribe and assert

```bash
npx --yes mqtt-cli >/dev/null 2>&1 || true   # or use the snippet below
node -e '
const mqtt = require("mqtt");
const c = mqtt.connect("ws://localhost:8883", {
  username: "viewer1", password: "viewerpass", protocolVersion: 4, clean: true,
});
c.on("connect", () => { console.log("SUB connected"); c.subscribe("meshcore/#"); });
c.on("message", (t, p) => console.log(t, p.toString()));
'
```

**Pass criteria (all must hold):**

1. **Broker log** shows `[AUTH] ✓ Publisher authenticated [aud: mqtt.local.test]` for `[O:<first 8 of $PUBKEY>]`.
2. **Status:** within seconds of the source connecting, one message on `meshcore/test/$PUBKEY/status` with `status:"online"`, `origin_id` equal to `$PUBKEY` (uppercase), plus `model` / `firmware_version` / `radio` / `client_version`. Broker logs `Stripping retain flag from STATUS message`.
3. **Packets:** as the radio hears traffic, messages on `meshcore/test/$PUBKEY/packets`, each carrying every §2.3 key, with `type:"PACKET"`, `direction:"rx"`, and `len`/`packet_type`/`payload_len`/`SNR`/`RSSI` all **JSON strings**.
4. **`hash`** is 16 uppercase hex chars and is stable across two receptions of the same frame (compare against a `meshcore_packet_log` row's `raw_hex` run through `calculateMeshCorePacketHash`).
5. **`path`** appears only on messages with `route:"D"`.
6. **No topic normalization:** the broker never logs `Normalized topic:` for our publishes — proof the publisher already emits the canonical form.
7. **No subscribe:** the broker never logs `Subscribe denied (publisher)` and never closes our client. `authorizeSubscribe` closes any publisher that subscribes, so a clean run **is** the observation-only proof.
8. **Graceful offline:** `PUT` the source with `observer.enabled:false` → an `offline` status arrives on `.../status` before the client disconnects. (The **LWT** offline, by contrast, is expected *not* to arrive on an ungraceful kill — see §2.4's stale-status quirk. Verify by `docker kill`ing the MeshMonitor container and confirming the broker logs `[FILTER] Blocking stale status message`.)
9. **Hot-swap (WP6):** toggling `observer.enabled` does **not** log a MeshCore reconnect for the source; the device link stays up. Confirm in the MeshMonitor log.
10. **Bad audience:** set `tokenAudience` to `wrong.test` → broker logs `[AUTH] ✗ Invalid audience`, and `GET /api/sources/<id>/status` shows `observer.lastError` mentioning the rejected token, with `observer.connected:false` and **no** reconnect storm (≤ 1 attempt/minute after backoff settles).

Teardown: `docker compose down && rm -rf /tmp/mc-broker`.

---

## 9. Work packages

One Sonnet agent each. **Exclusive file ownership within a package.** Never commit a dangling import: a package that adds a *consumer* of a symbol must land after (or with) the package that adds the symbol.

### WP1 — Packet/status encoder (parallel with WP2, WP3)
**Owns:** `src/server/services/meshcoreObserverPacket.ts` (NEW), `src/server/services/meshcoreObserverPacket.test.ts` (NEW)
**Depends on:** nothing.
**Do:** §3.1 in full. Source fixtures per §1.9. Cross-check against `decodeMeshCorePacket` per §1.7.
**Acceptance:** §7.1 green, including the named D-3 divergence test, the string-typing test, and the TZ-independent `time`/`date` format test. Module imports nothing but `node:crypto` and the `OtaPacketEvent` type. `npx tsc --noEmit` clean. Self-contained — nothing imports it yet, so the tree stays green.
**Also verify:** the suite passes under a non-UTC zone — `TZ=Asia/Kolkata npx vitest run src/server/services/meshcoreObserverPacket.test.ts` (a half-hour offset catches errors a whole-hour zone would mask). CI runs UTC, so this is the only place the TZ bug can be caught.

### WP2 — `MqttBrokerClient` LWT + keepalive (parallel with WP1, WP3)
**Owns:** `src/server/transports/mqttBrokerClient.ts`, `src/server/transports/mqttBrokerClient.test.ts`
**Depends on:** nothing.
**Do:** §3.4 only. Two optional options, two lines in `connect()`. **No other change to this file** — it is on the hot path for every MQTT bridge.
**Acceptance:** §7.6 green; the full existing `mqttBrokerClient.test.ts` and `mqttBridgeManager*.test.ts` suites still pass; connect options are byte-identical when `will`/`keepalive` are omitted.

### WP3 — Token result refinement (parallel with WP1, WP2)
**Owns:** `src/server/services/meshcoreObserverToken.ts`, `src/server/services/meshcoreObserverToken.test.ts`
**Depends on:** nothing.
**Do:** §3.3. Add `ObserverTokenResult` + `mintObserverTokenForSourceDetailed`; reduce `mintObserverTokenForSource` to a wrapper.
**Acceptance:** §7.7 green; **every pre-existing assertion in that test file passes unmodified**; `mintObserverToken` and `deriveObserverPublicKey` are untouched.

### WP4 — Publisher service
**Owns:** `src/server/services/meshcoreObserverPublisher.ts` (NEW), `…test.ts` (NEW), `…perSource.test.ts` (NEW)
**Depends on:** WP1, WP2, WP3 (all three merged).
**Do:** §3.2 in full, plus the §6 failure matrix.
**Acceptance:** §7.2 + §7.4 green. The **never-subscribes**, **no-per-packet-minting**, and **renewal-window-boundary** tests are non-negotiable — the last one is what pins the §3.2 predicate against a regression back to the reference's threshold-only form. Nothing imports the publisher yet — the tree stays green.

### WP5 — Manager lifecycle + status surface
**Owns:** `src/server/meshcoreManager.ts`, `src/server/routes/sourceRoutes.ts` (**status route only**), `src/server/meshcoreManager.observer.test.ts` (NEW), `src/server/routes/sourceRoutes.observerStatus.test.ts` (NEW)
**Depends on:** WP4.
**Do:** §4 + §4.1. Four lifecycle call sites, `startObserver`/`stopObserver`/`getObserverStatus`, `formatRadioInfo`, the `getStatus()` spread, `MeshCoreSourceStatus`, and the one `!canReadNodes` strip.
**Do not** touch the `PUT /:id` handler — that is WP6.
**Acceptance:** §7.3 + §7.5 green. The listener-leak test and the D-11 ungated test are required. `GET /:id/status` JSON is byte-identical for non-MeshCore sources and for MeshCore sources without an observer.

### WP6 — `reconfigureObserver` hot-swap
**Owns:** `src/server/meshcoreManager.ts`, `src/server/sourceManagerRegistry.ts`, `src/server/routes/sourceRoutes.ts` (**PUT handler only**), `src/server/routes/sourceRoutes.observerReconfigure.test.ts` (NEW)
**Depends on:** WP5 — **strictly sequential**, it edits two of the same files.
**Do:** §5. Delete the Phase-1 TODO comment.
**Acceptance:** an observer-only config change calls `reconfigureObserver` and **not** `removeManager`; a change touching any other config key still takes the full-restart branch; a change touching both takes the restart branch; an unsupported manager type returns `false` without throwing.

### WP7 — E2E validation, epic doc, PR
**Owns:** `docs/internal/dev-notes/MESHCORE_ANALYZER_OBSERVER_EPIC.md`
**Depends on:** WP6.
**Do:**
- Run §8 end-to-end against a real companion and a locally-run broker. Capture the broker log lines proving criteria 1-10.
- Full Vitest suite (0 failures) + `lint:ci` gate per §7.8.
- Tick the Phase 2 boxes; record under "Deviations / notes → Phase 2": **(a)** D-2 — the decoder library's `messageHash` is *not* `calculatePacketHash`; **(b)** D-3 — packed vs. plain `path_len`, identical for 1-byte hash mode; **(c)** D-4 — the reference publishes no advert fields, so the opt-in filter is a no-op on the wire and is not implemented; **(d)** D-8 — UTC `Z` timestamps; **(e)** §2.4 — the broker's stale-status filter suppresses the LWT, so graceful stop publishes an explicit offline; **(f)** D-7 — the Phase-1 hot-swap follow-up is now done; **(g)** the reference's nameless-advert `KeyError` bug, not replicated; **(h)** §3.2/§6 — the renewal predicate subtracts the check interval as well as the threshold, closing the reference's ~55-minute post-expiry hole (same three constants, different comparison); **(i)** §7.1 — `time`/`date` are local-zone by contract, so the goldens derive them from the fixed `Date` rather than hardcoding, and WP1 runs the suite once under a non-UTC `TZ` because CI is UTC-only.
- PR via `/create-pr`, CI via `/ci-monitor`.

### Dependency graph
```
WP1 ─┐
WP2 ─┼─► WP4 ─► WP5 ─► WP6 ─► WP7
WP3 ─┘
```

---

## 10. Explicitly OUT OF SCOPE for Phase 2

A PR containing any of these will be sent back.

- **Any frontend change.** No `DashboardPage` fieldset, no `MeshCoreConfigurationView` panel, no locale strings, no `UiIcon`, no `useSourceStatuses` change. Phase 3.
- **User-facing documentation.** Phase 3. (The epic-doc deviations note in WP7 is internal and required.)
- **Any subscribe path.** No `client.subscribe()`, no message handler, no `/serial/commands`, no remote-serial or remote-command feature. This is the phase's headline invariant.
- **The `raw` topic** (`meshcore/{IATA}/{PUBKEY}/raw`). The reference publishes it only when explicitly configured; it is not part of the analyzer contract.
- **The `decoded` / `debug` topics** from the reference's default topic map.
- **Advert privacy-filter machinery** or any decoded-payload field in the packet JSON (D-4).
- **Multi-broker fan-out.** The reference supports MQTT1–MQTT4; our config block has exactly one `brokerUrl`.
- **Periodic advert transmission** (`send_advert` / `advert_scheduler` in the reference) — that transmits on the radio; we are observation-only.
- **New global settings** or `VALID_SETTINGS_KEYS` entries.
- **Migrations, schema changes, repositories, raw SQL.** Phase 2 touches none.
- **Changing the `GET /:id/status` wire shape** beyond adding/stripping the `observer` key.
- **Converting existing handlers to the `ok()`/`fail()` envelope.**
- **Cascade cleanup of `meshcore_observer_keys` on source delete** — still a separate change (Phase 1 known gap).
- **`MqttReconnectCoordinator` adoption** (D-6), and any second retry/backoff layer on top of `MqttBrokerClient`'s.
