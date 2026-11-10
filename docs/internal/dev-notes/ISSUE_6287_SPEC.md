# Spec: MQTT root topic finder (MeshMonitor #6287)

## Maintainer decisions (2026-11-10, binding)
All recommended: fixed 60 s sample with Stop (partial results kept); caps: at most 1 active sample per user, 1 per broker endpoint, 2 instance-wide, 2-minute per-user cooldown after a sample, HTTP limiter 5 starts per 10 min per user/IP (not skipped for private IPs). Permission = whoever can save that root (configuration:write on the source for device/remote, sources:write for bridges, admin for presets). Phase 1 without a geocoder; bundle a pinned copy of meshtastic/api data/mqttRoots.json with its SHA; no live directory refresh yet; random mm-roots client id (never reuse a configured client id); UI-only root validation; MeshCore IATA finder is a follow-up issue.


## 0. Upstream rules (from meshtastic/design#167, fetched 2026-11-09)

The design was updated on 2026-11-08 to drop the ASCII rule. These are the client rules:
- **R1.** The finder is offered from the root field. It only subscribes and never publishes. Picking a row fills the field and does not save.
- **R2.** Sample for about 60 s with a fresh client ID and the broker settings in the form. Subscribe to `<region>/2/map/` and `<region>/2/e/+/+`, and the same pair at 1, 2 and 3 `+` levels below the region (8 filters). Never subscribe to `#`. After 300 packets, unsubscribe the region's own `2/e` stream and mark its count as a floor.
- **R3.** Location comes from the connected radio's position first. Never prompt for it. The location never reaches the broker and is never logged.
- **R4.** The ladder is region, then country, then subdivision, then city (city in lowercase).
  - Offer `<region>/<CC>` (ISO 3166-1 code) only when heard roots under the region use that code as their next segment AND the country root stays under the 300-packet cap.
  - A flooded country root is still used as the prefix for the subdivision row, but is not offered itself.
  - `<CC> == region name` (`msh/US/US`) is a republisher's doubled root and is never offered.
  - Keep letters and digits in any script, NFC-composed. Drop everything else. Trim each row to 31 bytes.
- **R5.** The directory's `subdivisionSegments` maps a subdivision name to its segment (`Washington` → `WA`).
- **R6.** Every directory entry that serves the user's subdivision, or whose center and radius contain the user, appears as a community row even if it was not heard.
- **R7.** Rank heard roots in three tiers:
  1. under the user's subdivision or city;
  2. under a community entry or a neighboring subdivision;
  3. everything else.
  
  Within a tier, order by depth, then distance to the nearest map-reported node, then node count, then message count, then name.
- **R8.** Validation rejects:
  - whitespace, control or invisible characters;
  - `+` or `#`;
  - a leading, trailing or doubled `/`;
  - a root ending in `/2`;
  - more than 31 UTF-8 bytes.
  
  Non-ASCII letters are allowed.
- **R9.** Bundle the directory so the finder works offline.
- **Directory source:** `meshtastic/api` `/resource/mqttRoots` (api#154, merged 2026-10-22, `data/mqttRoots.json`, seed entries such as `msh/US/IL/Chi`, `msh/US/MeshSTL`, `msh/US/CA/socalmesh`, plus US neighbors and segment maps). api#171, which lets the validator accept any script, is still open. The design still lists "where the directory lives" as an open question, with design#168 as the wider registry.

## 1. Findings (file:line)

**Shared MQTT client** (`src/server/transports/mqttBrokerClient.ts`)
- Options are at :21-71. They include `will` (:36), `maxAuthFailures` (:53) and `maxEvictions` (:68).
- The client ID is random `<prefix>-<8 chars>` unless `clientId` is set (:281-285).
- `connectTimeout` is fixed at 30 s and `clean: true` (:293-302).
- It keeps a `subscriptions` Set that is re-subscribed on every reconnect (:213, :346-355).
- `subscribe()` is at :445 and `publish()` at :462. **There is no `unsubscribe()`**, so R2's 300-packet cut needs a new method that also removes the topic from the Set.
- It reconnects with 1–60 s backoff (:222-223). A one-shot sampler must stop that, either by calling `disconnect()` on `close` or with a new `reconnect: false` option.

**Bridge** (`src/server/mqttBridgeManager.ts`)
- `MqttBridgeSourceConfig` (:92-182) has `upstream.{url,username,password,clientId}` (:102-115) and **`subscriptions: string[]`** (:116), which are topic filters (e.g. `msh/US/TX/#`), not a root field. The topic rewrite `from`/`to` fields are literal roots (:121-136).
- Messages flow `client.on('message')` → `handleDownlink` (:601, :1133), then to `ingestServiceEnvelope` and a local republish (:1201, :1233-1253). This is the path the sampler must never touch.
- Bridges in `single` mode may use a strict `!<8-hex>` client ID (:224-239). A sampler that reused it would evict the running bridge (#5893).

**Root fields in the UI**
- Bridge config: subscriptions textarea at `src/components/MQTT/MqttBridgeConfigurationView.tsx:683-693`. Preset selector at :444. "Save as preset" derives a root from a single `<root>/#` line (:340-346).
- Bridge create modal: `src/pages/DashboardPage.tsx:1577`.
- Local `mqtt_broker` `rootTopic`: `DashboardPage.tsx:1392`, :523, :642. This is the embedded broker's own root. There is no upstream to sample, so it is out of scope.
- Device Config root: `src/components/configuration/MQTTConfigSection.tsx:607-620` (placeholder `msh/US`). Preset apply is at :224-245.
- Remote admin root: `src/components/admin-commands/ModuleConfigurationSection.tsx:346-352`. Preset apply is at :281-296.
- Saved preset root: `src/components/MQTT/SavedBrokerPresetDialogs.tsx:148-153` (admin only). A preset root becomes `${root}/#` for bridges and `root` for devices (`src/components/MQTT/brokerPresets.ts:242`, :333).
- `src/components/MQTT/BrokerPresetSelector.tsx:1-15,36` is the precedent for one shared component placed in "the three Meshtastic MQTT forms", with an apply-only, never-save contract. The finder should copy its prop shape.

**Credentials**
- `src/server/utils/sourceConfigRedaction.ts:722-736`: a blank secret on save keeps the stored value. For an editor it is kept **only if the endpoint is unchanged** (`sameEndpoint`); `mergeSourceConfigOnSave` is at :784. Admins keep it regardless (`src/server/routes/sourceRoutes.ts:697`).
- `src/server/services/mqttBrokerPresetFill.ts:1-20,76-102`: non-admins never see a preset's login. The server fills it from `brokerPresetId` only when the form still reaches the preset's endpoint (`deviceFieldsReachEndpoint` / `bridgeUrlReachesEndpoint` in `src/utils/mqttBrokerEndpoint.ts:48,94`). An empty device address means `mqtt.meshtastic.org` (:22).
- Preset routes: read needs `requireAuth`, write needs `requireAdmin` (`src/server/routes/mqttBrokerPresetRoutes.ts:136-210`).
- Device MQTT config, including the password, reaches the form as plain text (`src/server/utils/adminMqttConfig.ts`). Saving it needs `requireDeviceSourcePermission('configuration','write')` (`src/server/routes/configRoutes.ts:247`).

**SSRF and limits**
- `src/server/utils/ssrfGuard.ts:146-158,214`: `assertSafeHost(host,{strict,allowLoopback})` blocks metadata, link-local, multicast and reserved ranges, and optionally loopback and private ranges. It is already used for raw sockets (`src/server/routes/meshcoreDeviceRoutes.ts:21`).
- `src/server/utils/privateBrokerAddress.ts` is only a firmware-parity classifier, not a guard.
- `src/server/middleware/rateLimiters.ts:240-254` is the limiter pattern. Note it **skips private-network IPs**, so an IP limiter alone does not protect the broker.
- `src/server/middleware/requestTimeout.ts`: the default socket timeout is 30 s, so a 60 s sample cannot be one synchronous request.
- The per-key in-flight serialization pattern is in `src/server/services/mqttGeoSweepService.ts:71-88`.

**Decoding helpers**
- `meshtasticProtobufService.decodeServiceEnvelope` (`src/server/meshtasticProtobufService.ts:1803`) and `MapReport` in `protobufs/meshtastic/mqtt.proto`.
- `PortNum.MAP_REPORT_APP=73` (`src/server/constants/meshtastic.ts:59`) and `isOwnMapReport` (`src/server/utils/okToMqtt.ts:121`).
- `REGION_SHORT_NAME` (`src/utils/loraFrequency.ts:346`, e.g. 3→`EU_868`).
- Radio identity and config: `getLocalNodeInfo()` (`src/server/meshtasticManager.ts:6092`) and `getCurrentConfig()` (:6427).

**Missing today**
- No reverse geocoder or ISO 3166 dataset in the repo or `package.json`. Only `mqtt`, `aedes` and `protobufjs` are present.
- No fetch from `api.meshtastic.org`.
- Bundled-JSON precedent: `src/data/userScriptsGallery.json`.

**MeshCore**
- MeshCore MQTT has a fixed root and a variable region segment: `meshcore/{IATA}/+/packets|status` (`src/server/services/meshcoreMqttIngestPacket.ts:288-299`). Config is `iataCode` / `region` (`src/server/meshcoreConfig.ts:94-98`, `src/server/meshcoreMqttManager.ts:101`).
- The analogous feature would be a "find active IATA regions" sampler on `meshcore/+/+/status`. There is no root ladder.
- `docs/internal/dev-notes/MESHCORE_PARITY_EPIC.md:25-30` says one shared implementation must cover all sources, and each spec must name the shared piece.

## 2. Design

### 2.1 Shared code, in order of dependency

1. **`src/utils/mqttRootTopic.ts`** (shared by browser and server, like `mqttBrokerEndpoint.ts`)
   - `validateMqttRoot(s): {ok:true}|{ok:false,code}` implementing R8. Codes: `WHITESPACE|CONTROL|INVISIBLE|WILDCARD|SLASH|ENDS_WITH_2|TOO_LONG`. Use `\s`/`\p{Z}`, `\p{Cc}`, `\p{Cf}` and `TextEncoder` for the byte length. An empty string means "firmware default" and is valid for devices.
   - `sanitizeSegment(s)`: NFC, keep `\p{L}\p{N}`.
   - `trimToBytes(root,31)`: cut on a code-point boundary, never inside a UTF-8 sequence.
   - `rootFromTopic(topic)`: strip `/2/e/<ch>/<gw>` or `/2/map/`. Return `null` for anything else.
2. **`src/server/services/mqttRootFinder/directory.ts`**
   - Loads a bundled `src/data/mqttRoots.json`, a verbatim copy of api `data/mqttRoots.json` with the upstream commit SHA recorded in a header field or README.
   - Exposes entries, neighbors and `subdivisionSegments`.
   - No network fetch in phase 1 (see Q4).
3. **`src/server/services/mqttRootFinder/ladder.ts`** (pure functions; most of the tests go here)
   - `buildLadder({regionRoot, place?: {cc, subdivisionName, subdivisionIso, city}, heard, directory})`
   - `rankHeard({heard, userPos?, place?, directory})` implementing R4–R7.
4. **`src/server/services/mqttRootFinder/rootSampler.ts`**: the `RootSampler` class. One instance per sample.
   - Builds its own `MqttBrokerClient` with:
     - `clientIdPrefix: 'mm-roots'`, which always gives a fresh random ID. Never the bridge's `clientId`.
     - no `will`;
     - `maxAuthFailures: 1`, `maxEvictions: 1`;
     - no coordinator.
   - Subscribes to the 8 R2 filters. On `message`:
     - size-check the payload (drop anything over 4 KB);
     - `rootFromTopic`;
     - count messages per root and distinct gateways per root (last topic segment / `envelope.gatewayId`);
     - for `/2/map/` messages, decode the envelope and then `MapReport`, keeping `{from, lat, lon}` per root (`latitudeI`/`longitudeI`) for R7 distance.
   - Payloads are never stored and never decrypted.
   - The region's own `2/e` counter hits 300 → `client.unsubscribe([region+'/2/e/+/+'])`, set `regionFloor=true`. Track country-root floors the same way so R4 can apply the "under cap" test.
   - Bounds: at most 1000 distinct roots, at most 500 gateways per root, at most 50k messages (stop early), wall-clock duration from Q1.
   - Retained messages count toward "heard" but get `retained: true` so the UI can show them as possibly stale.
   - Lifecycle: `connecting → sampling → done | failed{code} | cancelled`. One `setTimeout`, cleared on cancel. `disconnect()` on every exit path, and on `close` (no reconnect). Nothing is persisted.
   - Error codes are coarse on purpose: `UNREACHABLE | TIMEOUT | AUTH_REJECTED | SUBSCRIBE_DENIED | EVICTED | BLOCKED_TARGET`. Raw broker or socket error text is never passed back (see §4).
5. **`src/server/services/mqttRootFinder/rootFinderService.ts`**: the singleton job registry.
   - `start(userId, target, opts)` → `{sampleId}`, `get(userId, id)`, `cancel(userId, id)`.
   - Enforces the concurrency and cooldown caps from Q2, keyed by user, by broker endpoint identity (`host:port:tls`) and globally.
   - A finished job stays readable for 5 min, then is GC'd.
   - In memory by design: a restart drops in-flight samples. That is fine because nothing touches the mesh (§3).
6. **`MqttBrokerClient` additions** (backward compatible):
   - `unsubscribe(topics)`: removes from the Set and calls `client.unsubscribe`.
   - Optional `connectTimeoutMs` (default stays 30 s; the sampler uses 10 s).
   - Optional `autoReconnect: false`. When `false`, `scheduleReconnect()` is a no-op.
   
   Existing callers keep their current behaviour because every addition is opt-in.

### 2.2 HTTP API (new `src/server/routes/mqttRootFinderRoutes.ts`, mounted at `apiRouter.use('/mqtt/root-finder', …)` next to `server.ts:1087`)

The API uses start-and-poll, not one long request. A 60 s request would hit the 30 s socket timeout and common reverse-proxy 60 s idle timeouts, and polling gives live progress (Apple's sheet fills in as it samples).

- `POST /samples` (body below) → `202 ok(res,{sampleId, durationMs})`.
  ```
  { context: 'bridge'|'device'|'remote_device'|'preset',
    sourceId?, nodeNum?, brokerPresetId?,
    broker: { url } | { address, tlsEnabled },
    username?, password?,   // blank = use the stored or preset login (§4)
    regionRoot }            // e.g. 'msh/US'; validated with validateMqttRoot, 2–3 segments
  ```
- `GET /samples/:id` → `ok(res,{status, elapsedMs, durationMs, regionFloor, ladder[], community[], heard[], error?})`.
  - `heard[]` = `{root, nodes, messages, depth, nearestKm?, tier, retainedOnly}`.
  - Raw coordinates are never returned (R3). Only `nearestKm`, rounded to 1 km.
- `DELETE /samples/:id` → cancel.
- A sample belongs to the user who started it. Anyone else gets a 404.
- All responses go through `ok`/`fail` from `apiResponse.ts`.
- New codes: `ROOT_FINDER_BUSY` (429, with `retryAfterSeconds`), `ROOT_FINDER_TARGET_BLOCKED` (400), `INVALID_ROOT` (400). Reuse `BROKER_PRESET_*` codes from the preset fill.

**Where the location comes from (server side, never from the browser):**
- `device`: the local node of `sourceId`. Use the position override if one is set, otherwise the last DB position.
- `remote_device`: the DB position of `nodeNum` on `sourceId`.
- `bridge`: the centre of `downlinkFilters.geo` if a bbox is configured. Otherwise no location: show the region row plus heard roots ranked by tiers 3/2 and node count.
- `preset`: none.

**Default `regionRoot` (seeded in the UI, editable as "Search under"):**
- Device: `msh/<REGION_SHORT_NAME[lora.region]>`, unless the current root has a non-`msh` prefix, in which case use its first two segments.
- Bridge: the first two segments of the first subscription.

**Geocoding** (country, subdivision and city from the location) is Q3. Phase 1 ranks with directory `center/radiusKm` entries and map-report distances, which need no geocoder.

### 2.3 UI: one shared component

- **`src/components/MQTT/MqttRootFinder.tsx`** plus a CSS module (CLAUDE.md:39): a "Find topics" button that opens a modal (sheet).
- Props, mirroring `BrokerPresetSelector`:
  ```
  { context, sourceId?, nodeNum?,
    getTarget(): {broker, username, password, brokerPresetId?} | null,
    defaultRegionRoot, currentRoot,
    onPickRoot(root: string): void,
    disabled }
  ```
- The modal shows:
  - a progress bar (elapsed / duration) and a Cancel button;
  - sections in this order: Suggested (ladder), Community (directory), Heard (tiers). Columns: root, nodes, messages, "floor" badge, "not heard" badge;
  - an editable custom-root input with inline `validateMqttRoot` errors;
  - fixed copy: "Subscribes only. Nothing is sent to the broker, saved, or sent to your radio."
- Picking a row calls `onPickRoot` and closes the modal. **Nothing is saved.** The form's normal save bar takes over.
- Hook: `src/hooks/useMqttRootFinder.ts` handles start, poll every 1 s, cancel on unmount (`DELETE` in the effect cleanup) and 429 back-off.
- **Mount points** (each maps `onPickRoot`):
  - `MQTTConfigSection.tsx:620` → `setMqttRoot(root)`
  - `ModuleConfigurationSection.tsx:352` → `onMQTTConfigChange('root', root)`
  - `MqttBridgeConfigurationView.tsx:693` → replace the single `<old>/#` line, or append `${root}/#`
  - `DashboardPage.tsx:1577` (bridge create) → same as the bridge config view
  - `SavedBrokerPresetDialogs.tsx:153` → `set('rootTopic', root)` (admin only)
- Shared inline validation: put a `validateMqttRoot` message under every root field (device, remote admin, preset). Bridge subscription lines are wildcard filters, so validate only their root part (the text before `/#`) as a warning.
- i18n keys `mqtt_root_finder.*` go in `public/locales/en.json`.

### 2.4 MeshCore

The parity rule asks for the shared piece first. The shared piece is the job registry, routes, hook and modal shell. `RootSampler` takes a protocol adapter `{filters(regionRoot), classify(topic,payload) → {root, nodeKey, pos?}}`. The Meshtastic adapter ships now. A MeshCore adapter (`meshcore/+/+/status` → active IATA codes plus observer counts, filling the `iataCode` field) is a follow-up issue: it has no ladder or directory, and its broker load differs. Building the adapter seam now costs about 20 lines.

## 3. Mesh impact (CLAUDE.md:59-134): none

1. **Airtime: 0 packets.**
   - The sampler's only I/O is one outbound TCP/TLS MQTT connection to the broker the user typed in.
   - It imports no `sourceManagerRegistry`, `MeshtasticManager`, `MqttBrokerManager`, publisher pool, `mqttIngestion`, `dataEventEmitter`, notification or automation services. The one exception is a read-only position and config lookup before start.
   - No `ToRadio`, no admin packet, no `mqttClientProxyMessage`.
   - Picking a row only changes React state. Any radio write happens later through the existing Device Config / remote-admin Save, exactly as today.
2. **Spam: none.**
   - No DB writes and no node or message rows, so no automation triggers, no Apprise or push, no new-node alerts and no feedback loop.
   - It never publishes. That covers `publish()`, LWT and retained clears; with `clean: true` and no `will` the broker publishes nothing for us either.
   - No retries: auth failure, eviction or close ends the sample.
3. **Timers: one non-persistent `setTimeout` per sample, cleared on cancel or exit.**
   - No scheduler, so no save can re-arm anything.
   - A restart kills in-flight samples. That is harmless because no mesh state depends on them.

**Proof** (WP6 tests):
- (a) a spy on `MqttBrokerClient.prototype.publish` stays at 0 calls across a full sample, including cancel and auth-fail paths;
- (b) the sampler connect options contain no `will` key;
- (c) `ingestServiceEnvelope`, `dataEventEmitter.emit` and `databaseService` write methods are mocked and stay at 0 calls;
- (d) an import-boundary test reads `src/server/services/mqttRootFinder/*.ts` and asserts that none of the forbidden modules are imported. Optionally add a scoped ESLint `no-restricted-imports` rule.

**Side effects on the broker and on running bridges** (the only real-world impact):
- **Broker load.** One connection and 8 subscriptions for about 60 s. On `msh/US` (about 100 msg/s) the region `2/e` stream is cut after 300 packets. Subdivision wildcards remain, so expect roughly 20–40 KB/s, about 1–2 MB per sample. The caps in Q2 bound the total.
- **Bridge eviction risk.** A fresh client ID avoids duplicate-ID eviction of a running bridge. A broker with a per-username connection cap could still kick the bridge. Mitigation: a UI warning when the target matches a running bridge with the same username, plus `maxEvictions: 1` so the sampler gives up first. If the bridge is evicted it reconnects on its existing backoff.

## 4. Security and permissions

**Who may run a sample** (decided per context, in the route):
- `bridge` with `sourceId`: `sources:write` on that source. A new bridge with no `sourceId`: `sources:write`.
- `device` / `remote_device`: `configuration:write` on `sourceId`, using the same resolution as `requireDeviceSourcePermission` at `configRoutes.ts:247`.
- `preset`: `requireAdmin` (matches preset write).
- Anonymous or viewer: never.

This adds no capability beyond what those users already have, since each of them can already save a config that makes MeshMonitor or the radio connect to an arbitrary broker.

**Reusing stored credentials:**
- The browser never receives a stored secret.
- A blank `password` with `sourceId` (bridge) → read the stored `upstream.password` **only if** `sameUrlEndpoint(stored.upstream.url, body.broker.url)`. Apply this to every audience, admins included, so a sample can never aim a stored login at a different host.
  - Implement it by calling `mergeSourceConfigOnSave(type, stored, candidate, 'editor')` on a throwaway candidate config. That reuses the endpoint-binding rule at `sourceConfigRedaction.ts:730-734` instead of forking it.
- A blank login with `brokerPresetId` → reuse `fillBridgeConfigFromPreset` / `fillDeviceMqttFromPreset`, which apply the endpoint-match rule and return the `BROKER_PRESET_*` errors.
- Device: the password is already in the form in plain text and is sent as typed. An empty device address uses the firmware default server.
- Credentials live only in the job's memory until the client is built. They are never logged (use `redactBrokerUrl`) and never returned by GET.

**SSRF to arbitrary brokers:**
- Accept only `mqtt:`, `mqtts:`, `ws:` and `wss:` (as normalised by `normalizeBrokerUrl`), or a device `address` plus `tlsEnabled`.
- Run `assertSafeHost(host, {strict:false, allowLoopback: isAdmin})` before connecting. That blocks metadata, link-local, multicast and reserved ranges for everyone, and loopback for non-admins. RFC1918 is allowed because LAN brokers are normal.
- Return only the coarse error codes from §2.1. No banner, socket errno or broker text, so the endpoint is a weak port-scan oracle.
- The per-user cap and cooldown (Q2) also limit scanning.
- Residual risk: DNS rebinding between the check and mqtt.js's own lookup. This is documented, same stance as `ssrfGuard.ts:17-21`.

**Location:** coordinates never go into logs, responses (only km distances) or the broker (R3). Only the server-side lookup reads them.

**Rate-limit layers:**
- an `express-rate-limit` `mqttRootFinderLimiter` in `rateLimiters.ts`. Do **not** skip private IPs here, unlike the others, because the resource being protected is a third-party broker;
- the in-service caps (Q2), which are the real control.

## 5. Work packages

| WP | Content | Files | Tests |
|---|---|---|---|
| 1 | Root validator and segment utilities | `src/utils/mqttRootTopic.ts` | `mqttRootTopic.test.ts`: every R8 case, including `æøå` byte counts, ZWSP/ZWJ/BOM, `msh//US`, `/msh`, `msh/US/`, `msh/US/2`, 31 vs 32 bytes, `東京都`, NFC; `rootFromTopic` for e/map/junk; `trimToBytes` never splits a code point |
| 2 | `MqttBrokerClient` additions: `unsubscribe`, `connectTimeoutMs`, `autoReconnect:false` | `src/server/transports/mqttBrokerClient.ts` | extend the existing client tests: unsubscribe removes the topic from the resubscribe Set; no reconnect scheduled when disabled; defaults unchanged |
| 3 | Directory, ladder and ranking (pure) | `src/data/mqttRoots.json` (copied from meshtastic/api with SHA), `src/server/services/mqttRootFinder/{directory,ladder}.ts` | `ladder.test.ts`: the design#167 acceptance cases (Texarkana → `msh/US/AR` in tier 2 via neighbors; DE → `msh/EU_868/DE` before subdivision when heard and under cap; never `msh/US/US`; a flooded country is a prefix but not offered; an unheard directory entry still listed; nested republisher roots `msh/US/CA/US/MI` sort by depth); tier ordering keys |
| 4 | `RootSampler` with Meshtastic adapter | `src/server/services/mqttRootFinder/rootSampler.ts`, `meshtasticRootAdapter.ts` | fake `MqttBrokerClient`: 8 filters exact, no `#`; 300-packet cut calls `unsubscribe` and sets the floor; MapReport positions recorded; caps (roots, gateways, messages); auth or evict ends with a coarse code; timer cleared on cancel; **publish spy = 0, no `will`** |
| 5 | Service, routes, limiter | `rootFinderService.ts`, `src/server/routes/mqttRootFinderRoutes.ts`, `src/server/server.ts` (mount), `src/server/middleware/rateLimiters.ts` | route tests: per-context permissions (viewer 403; device needs configuration:write on that source; preset needs admin); stored password used only on same endpoint (different host → no password, sample sent with blank login); preset endpoint mismatch → `BROKER_PRESET_ENDPOINT_MISMATCH`; `assertSafeHost` block → `ROOT_FINDER_TARGET_BLOCKED`; caps → 429 with `retryAfterSeconds`; another user's id → 404; responses contain no coordinates, password or raw error |
| 6 | Mesh-isolation guard | `src/server/services/mqttRootFinder/isolation.test.ts` (+ optional ESLint scoped rule in `eslint.config.mjs`) | import-boundary assertion; `ingestServiceEnvelope`, `dataEventEmitter`, DB writes = 0 calls |
| 7 | UI component and hook | `src/components/MQTT/MqttRootFinder.tsx` + `.module.css`, `src/hooks/useMqttRootFinder.ts`, `public/locales/en.json` | RTL: pick fills via `onPickRoot` and makes no save call; cancel on unmount sends DELETE; validation messages; 429 state; floor and "not heard" badges |
| 8 | Mount at the 5 root fields + inline validation | `MQTTConfigSection.tsx`, `ModuleConfigurationSection.tsx`, `MqttBridgeConfigurationView.tsx`, `DashboardPage.tsx`, `SavedBrokerPresetDialogs.tsx` | extend existing view tests (e.g. `MqttBridgeConfigurationView.test.tsx`): the bridge pick replaces a single `<root>/#` line; device pick sets root; button hidden without permission |
| 9 | Docs | `docs/features/mqtt-setups.md` (Finding a root topic section), `docs/features/mqtt-broker.md` link, PR body with the §3 checklist | — |
| 10 (follow-up issue) | MeshCore IATA adapter | `meshcoreRegionAdapter.ts`, mount at the MeshCore MQTT region field | — |

Sequencing: WP1 and WP2 can run in parallel. WP3 depends on WP1. WP4 depends on WP1–3. WP5 depends on WP4. WP7 can start against a mocked API after WP5's contract is agreed. WP8 follows WP7. WP6 lands with WP4/WP5.

## 6. Open questions (recommended option in bold)

1. **Sample duration.** Options: (a) **60 s fixed, matching design#167 and the other clients, with a Stop button that keeps partial results**; (b) user-selectable 30/60/120 s, server-clamped to 120 s. Recommend (a) for cross-client parity. Note in the sheet that quiet roots can be missed.
2. **Concurrency and rate limit.** This is policy, so the maintainer must choose (CLAUDE.md:128-134). Proposed:
   - **at most 1 active sample per user;**
   - **at most 1 per broker endpoint across the instance** (a second requester gets the running job's id if the target and region match, otherwise 429);
   - **at most 2 globally;**
   - **a 2-minute per-user cooldown after a sample ends;**
   - an HTTP limiter of 5 per 10 min per user/IP, not skipped for private IPs.
   
   A conservative alternative is a global limit of 1.
3. **Geocoding** (needed for R4–R6 subdivision and city rows). Options:
   - (a) **Phase 1 without a geocoder:** region row, plus country row when heard, plus directory `center/radius` community rows, plus heard roots ranked by map-report distance. Then a phase 2 that bundles a simplified offline ISO 3166-1/-2 polygon set (subdivision boundaries) for country and subdivision, and decides the city rung separately (a GeoNames cities set of about 1 MB, or skip it).
   - (b) Nominatim or another online geocoder: rejected. It sends the location to a third party, breaks offline use and conflicts with R3's intent.
   - Note that (a) does not yet meet "same coordinate gives the same ladder on every client" for subdivision and city rows. Say so in the PR and track phase 2.
4. **Ship before design#167 settles the directory?** **Yes.**
   - The client rules are settled and two clients have shipped. Only the directory's home is open, and it already exists at `api /resource/mqttRoots` (api#154 merged).
   - Bundle a pinned copy (R9) and record its SHA.
   - Defer a live refresh (24 h cached `safeFetch` of `https://api.meshtastic.org/resource/mqttRoots`, opt-out setting) to a follow-up once the design names the canonical source.
   - Until api#171 merges, the bundled file contains ASCII-only roots. That is harmless because our validator already accepts any script.
5. **Client ID on strict brokers that accept only `!<8-hex>`.** **Default `mm-roots-<rand>`.** If the bridge has `upstream.clientId` set, generate a random `!<8-hex>` with bit 31 set (outside real node numbers, as `DashboardPage.tsx:633-636` does for the gateway). Never reuse the configured ID. Ask the maintainer before adding this.
6. **Server-side rejection of invalid roots on Device Config save?** **UI-only validation in this feature.** Open a separate issue for server enforcement on `/config/mqtt` and remote-admin `setMQTTConfig`, because rejecting existing configs on save could surprise users.
7. **Device-context vantage point.** The server samples from MeshMonitor's network, not the radio's. **Accept this and note it in the copy.** A broker reachable only from the radio's LAN shows `UNREACHABLE`.

## 7. Out of scope

- The local `mqtt_broker` `rootTopic` (`DashboardPage.tsx:1392`). There is no upstream to sample.
- Bridge topic-rewrite `from`/`to` fields. Can be added later as a mount point with zero backend change.
- MeshCore IATA finder (WP10, follow-up issue).
- Live directory refresh.
- Contributing entries to `meshtastic/api`.
- The republisher-root filter (open in the design).
- Server-side root enforcement on save.
- Browser geolocation, which R3 forbids prompting for.
- Storing or ingesting sampled traffic, packet-log entries for samples, and any notifications.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/transports/mqttBrokerClient.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/sourceConfigRedaction.ts
- /home/yeraze/Development/meshmonitor/src/server/services/mqttBrokerPresetFill.ts
- /home/yeraze/Development/meshmonitor/src/components/MQTT/BrokerPresetSelector.tsx
- /home/yeraze/Development/meshmonitor/src/components/configuration/MQTTConfigSection.tsx
- /home/yeraze/Development/meshmonitor/src/components/MQTT/MqttBridgeConfigurationView.tsx
- /home/yeraze/Development/meshmonitor/src/server/utils/ssrfGuard.ts
