## Maintainer decisions (2026-11-10, binding)
All recommended answers: activity-only ranking (no airport table); mount only at the MeshCore MQTT ingest Region field (not the Observer IATA field); active = online and status timestamp within 15 min (or arrived live), a missing or unparseable timestamp counts as stale; honour the form's TLS-verify checkbox for meshcore_mqtt only; on SUBSCRIBE_DENIED show the coarse error plus a MeshCore-specific hint. Reuse every #6287 cap; no new numbers.

# Spec: MeshCore IATA region finder (MeshMonitor #6335)

I did not write `/tmp/claude-1000/-home-yeraze-Development-meshmonitor/95d1a848-1ce0-4732-8d0a-72e3b4f29f64/scratchpad/specs/6335.md`. This agent runs read-only and may not create any file, scratchpad included. The full spec is below; save it from here.

## 1. Findings (file:line)

**Shared finder from #6287**
- **Adapter seam.** `src/server/services/mqttRootFinder/rootAdapter.ts:11-32` defines `RootAdapter {filters, cappedFilter, classify}`. `RootObservation.stream` is typed `'e' | 'map'` (line 15), which only fits Meshtastic.
- **The service hardcodes Meshtastic.** `rootFinderService.ts:160-164` always passes `meshtasticRootAdapter`. `get()` (lines 186-211) always runs `buildLadder`, `buildCommunity` and `rankHeard` against the Meshtastic directory.
- **The ladder would emit a junk row.** `ladder.ts:208-218` always pushes the region row. For MeshCore that would be a bogus `meshcore` row.
- **Ranking assumes Meshtastic structure.** `rankHeard` (`ladder.ts:308-370`) sorts by tier, depth and distance. Those are Meshtastic concepts.
- **Sampler is protocol-neutral.** `rootSampler.ts`:
  - Caps at lines 17-23: 60 s, 4 KB payload, 1000 roots, 500 nodes per root, 50k messages.
  - Client options at 75-89: fresh `mm-roots` ID, no will, no reconnect.
  - The flood cut at 263-273 fires only for `stream === 'e'` on `regionRoot`, and only when `cappedFilter` is non-null.
  - Retained messages are tracked through `live` (255) and `retainedOnly` (143).
- **Caps.** `rootFinderService.ts:37-41`: 1 per user, 1 per endpoint, 2 instance-wide, 2 min cooldown, 5 min retention. The HTTP limiter is `rateLimiters.ts:350-354` (5 starts per 10 min).
- **Target resolver.** `src/server/utils/mqttRootFinderTarget.ts`:
  - Contexts at 33-34 are `bridge | device | remote_device | preset`.
  - `parseRegionRoot` (62-72) requires 2-3 segments, so `meshcore` (depth 1) is rejected.
  - `mayStart` is at 115-132.
  - The stored bridge login is reused only for the same endpoint through `mergeSourceConfigOnSave` (248-271).
- **Route** (`mqttRootFinderRoutes.ts:47-53`) passes no protocol.
- **Hook.** `src/hooks/useMqttRootFinder.ts`: the context union is at 17, `StartParams.regionRoot` is required at 76-82, and the body is built at 141-150.
- **UI.** `src/components/MQTT/MqttRootFinder.tsx`: props at 26-38, the "Search under" input at 158-172 (also requires 2-3 segments, line 78), Ladder and Community at 217-251, and the Heard list with the retained badge at 253-278. i18n keys are flat `mqtt_root_finder.*` in `public/locales/en.json:8260-8291`.
- **Isolation test.** `isolation.test.ts:212-225`. `FORBIDDEN` has `/meshcoreManager/`, which does not match `meshcoreMqttManager`.

**MeshCore**
- **Topic shape** is `meshcore/{REGION}/{PUBKEY}/packets|status`. The subscriptions are built at `meshcoreMqttIngestPacket.ts:288-299`, and they **uppercase** the region.
- **Pure helpers already exist.** All in `meshcoreMqttIngestPacket.ts`:
  - `decodeObserverStatusMessage` (245-279) checks the status value and `origin_id`.
  - `observerKeyFromTopic` (310-317) checks for 4 segments, `meshcore`, and `packets|status`.
  - `ORIGIN_ID_RE` is at 112.
- **Ingest source config.** `MeshCoreMqttSourceConfig {brokerUrl, region, username?, password?, rejectUnauthorized?}` is at `meshcoreMqttManager.ts:98-118`. Status is split off before packet parsing at 418-425.
- **The Observer's `iataCode`** (`meshcoreConfig.ts:93-98`) is the *publish-side* field. Its UI is `MeshCoreObserverBrokerEditor.tsx:51-55`, and validation (3 letters or `test`) is `observerConfig.ts:489-493`.
- **Status payloads carry no position.** `ObserverStatusPayload` (`meshcoreObserverPacket.ts:85-96`) holds status, timestamp, origin, origin_id, model, firmware, radio, client_version and stats.
- **Status is retained** (`meshcoreObserverPublisher.ts:483`) and republished every 5 min (`STATUS_REFRESH_MS`, line 116).
- **Stored password** for `meshcore_mqtt` is bound to the `brokerUrl` endpoint (`sourceConfigRedaction.ts:487-491, 575`).
- **Mount target.** The ingest source form's Region (IATA) field is `src/pages/DashboardPage.tsx:1856-1868`:
  - state at 164, load at 488;
  - save uppercases it at 758-769;
  - the bridge finder mount to copy is at 1587-1600.
- **No IATA-to-location table exists.** `src/server/data/` holds only `mqttRoots.json` and `userScriptsGallery.json`. No airport dependency is in `package.json`. IATA appears elsewhere only in locale strings.

## 2. Design

### 2.1 Adapter: new `src/server/services/mqttRootFinder/meshcoreRegionAdapter.ts`
- **Imports.** Only `decodeObserverStatusMessage` and `observerKeyFromTopic` from `../meshcoreMqttIngestPacket.js`, which is pure. Never `meshcoreMqttManager`.
- **`filters()`** returns `['meshcore/+/+/status']`. One filter, no `#`, no packets stream.
- **`cappedFilter()`** returns `null`. There is no flood stream, so the sampler's cut never fires.
- **`classify(topic, payload)`**:
  1. Split the topic. It must be 4 parts: `meshcore`, region, key, `status`. Otherwise return `null`.
  2. The region segment must equal its uppercase form and match `/^[A-Z0-9_-]{1,16}$/`. Otherwise return `null`. The ingest uppercases the region on subscribe, so a lowercase region on the wire cannot be used.
  3. `JSON.parse` the payload. The sampler already drops anything over 4 KB. Then call `decodeObserverStatusMessage`. Return `null` if it fails, or if `observerKeyFromTopic(topic)` does not equal `originId` (the same spoof check the ingest uses).
  4. Count an observer as **active** when it is `online` and its `timestamp` is within 15 min of now (3× the 5-min refresh). Active returns `{root: REGION, stream: 'status', nodeKey: originId}`.
  5. Offline or stale returns `{root: REGION, stream: 'status'}` with no `nodeKey`. It still counts as a message.
- **Result.** `nodes` = active observers and `messages` = all status messages for that region. The sampler needs no change.
- **`rootAdapter.ts` change:** widen `stream` to `'e' | 'map' | 'status'` and update the header comment.

### 2.2 Ranking
- **By activity only.** Add a pure `rankRegions(heard)` (new `regionRanking.ts`, or inside the adapter module). Sort by active observers descending, then messages descending, then code ascending.
- **Output fields.** Fill the existing `RankedHeard` shape: `depth: 1`, `tier: 3`, no `nearestKm`, and `floor` when `messages >= FLOOD_CAP`.
- **No distance ranking.** There is no code-to-location table in the repo (§1), and status payloads have no coordinates. Distance would need a bundled airport table (Q2) or advert positions from the packets stream. The packets stream is the broker-wide firehose, so that is out.

### 2.3 Service, resolver and route (one shared implementation)
**`rootFinderService.ts`**
- Add `protocol: 'meshtastic' | 'meshcore'` to `StartSampleParams` and `Job`, defaulting to `meshtastic`.
- Select the adapter from a map `{meshtastic: meshtasticRootAdapter, meshcore: meshcoreRegionAdapter}`.
- For `meshcore`, `regionRoot` is forced to `'meshcore'`.
- In `get()`, for `meshcore`: `ladder: []`, `community: []`, `heard: rankRegions(...)`, `hasLocation: false`. Add `protocol` to `SampleView` so the UI can switch its copy.

**`mqttRootFinderTarget.ts`**
- Add context `'meshcore_mqtt'`. It returns `protocol: 'meshcore'` and ignores `body.regionRoot` (skips `parseRegionRoot`).
- **Permission:** `hasPermission(user,'sources','write',sourceId)`. That is the same gate as saving a source (`sourceRoutes.ts:951`), so it adds no new power.
- **Broker:** URL form only, through the existing `parseBroker`, `assertSafeHost` and endpoint key.
- **Stored login when the password is blank and a `sourceId` is given:**
  - Load the row and require `type === 'meshcore_mqtt'`; otherwise return 404 `SOURCE_NOT_FOUND`.
  - Run `mergeSourceConfigOnSave('meshcore_mqtt', stored, {brokerUrl: url, password: ''}, 'editor')`, so the stored password is used only on the same endpoint.
  - Take the stored `username` only when the password survives that merge.
- **No `userPos`.**

**Route:** pass `t.protocol` into `service.start`. Nothing else changes, and the ok/fail envelope and codes stay as they are.

### 2.4 UI
**Shared `MqttRootFinder.tsx`**
- Add an optional prop `protocol?: 'meshtastic' | 'meshcore'`. It drives copy and sections only, not a separate component.
- When `meshcore`:
  - hide "Search under" and send no `regionRoot`;
  - hide Suggested and Community;
  - title the list "Active regions", with row meta "N observers online · M status messages";
  - hide the retained badge, because status is retained by design;
  - the custom input validates `/^[A-Za-z0-9_-]{1,16}$/` and uppercases on pick.
- **Hook:** `regionRoot` becomes optional, add `'meshcore_mqtt'` to the context union, and omit `regionRoot` from the body when it is absent.

**Mount** under the Region field in `DashboardPage.tsx` (after 1868):
```tsx
<MqttRootFinder protocol="meshcore" context="meshcore_mqtt"
  sourceId={editingSource?.id ?? null} currentRoot={formMcMqttRegion} defaultRegionRoot=""
  getTarget={() => formMcMqttBrokerUrl.trim()
    ? { broker: { url: formMcMqttBrokerUrl }, username: formMcMqttUsername, password: formMcMqttPassword } : null}
  onPickRoot={(code) => setFormMcMqttRegion(code.toUpperCase())} />
```
- **"Use this"** fills only the Region (IATA) input. Nothing is saved; the form's Save takes over and reconnects the source through the existing path. Broker, username and TLS are untouched.
- **i18n.** New flat keys in `en.json`:
  - `mqtt_root_finder.meshcore_button` ("Find regions")
  - `.meshcore_title`
  - `.meshcore_vantage`
  - `.regions_heading`
  - `.observers_one` / `.observers_other`
  - `.status_messages_one` / `.status_messages_other`
  - `.meshcore_quiet_note`
  - `.meshcore_custom`
  - `.meshcore_custom_invalid`
- **Styling:** reuse `MqttRootFinder.module.css`.
- **Docs:** add a "Finding your region" section to `docs/features/meshcore-mqtt-ingest.md`.

### 2.5 Caps (all reused from #6287, no new numbers)
- 60 s sample with Stop.
- 1 active sample per user, 1 per broker endpoint (shared across protocols), 2 instance-wide.
- 2 min per-user cooldown and 5 min result retention.
- HTTP limiter: 5 starts per 10 min.
- Sampler bounds: 4 KB payload, 1000 regions, 500 observers per region, 50k messages.

## 3. Mesh impact: none (broker-side only)
- **Airtime: 0 packets.** A `meshcore_mqtt` source has no radio. The sampler opens one outbound subscribe-only MQTT connection.
  - It touches no source manager, the MeshCore or ingest manager, the Observer publisher, or a companion.
  - Picking a region only changes React state.
- **Spam: none.**
  - No DB writes, node rows, events, notifications or automations.
  - Never publishes; no will, so the broker publishes nothing for it.
  - No retries.
- **Timers:** the sampler's single `setTimeout`, cleared on every exit. Nothing persists.
- **Broker load.** One connection and one filter for at most 60 s.
  - The retained burst on subscribe is about one status per observer on that broker, roughly 400-600 B each: about 0.5 MB for 1,000 observers.
  - After that, roughly N/300 messages per second (5-min republish), about 2 KB/s for 1,000 observers.
  - That is well under Meshtastic's 1-2 MB per sample. `MAX_MESSAGES` and `MAX_ROOTS` bound the worst case.
- **Eviction risk.** Same as #6287: the fresh `mm-roots` ID never collides with the ingest source's client ID, and `maxEvictions: 1` makes the sampler yield first. A broker with a per-username connection cap could still bump a running ingest source on the same login; it reconnects on its existing backoff. Reuse the bridge warning copy.
- **Proof:** extend `isolation.test.ts`. The new file is auto-scanned. Add `/meshcoreMqttManager/` and `/meshcoreObserverPublisher/` to `FORBIDDEN`. Add a publish spy that stays at 0 across a MeshCore sample.

## 4. Test plan
- **`meshcoreRegionAdapter.test.ts`:**
  - filters are exactly `['meshcore/+/+/status']` with no `#`, and `cappedFilter` is null;
  - fresh online gives a `nodeKey`; offline or stale gives no `nodeKey`; a missing or unparseable timestamp follows the Q3 answer;
  - each of these returns null: topic/body key mismatch, `/packets` topic, lowercase region, 3- or 5-part topic, bad JSON, `type:'PACKET'` body.
- **`regionRanking.test.ts`:** sort order is observers, then messages, then code; no `nearestKm`; `floor` at `FLOOD_CAP`.
- **`rootSampler.test.ts`** (fake client): one subscribe call with that filter, never an `unsubscribe`, per-region counts, retained messages counted, `MAX_ROOTS` honoured.
- **`rootFinderService` tests:** a `meshcore` job has empty ladder and community and `hasLocation: false`; the adapter is chosen by protocol; a Meshtastic sample on endpoint X blocks a MeshCore start on X (429).
- **`mqttRootFinderRoutes.test.ts`:**
  - `meshcore_mqtt`: viewer 403; `sources:write` 202;
  - `regionRoot` is ignored or absent;
  - the stored password is reused on the same `brokerUrl` and dropped on a different host;
  - a non-`meshcore_mqtt` `sourceId` gives 404;
  - SSRF block gives `ROOT_FINDER_TARGET_BLOCKED`;
  - the response holds no password or raw error.
- **`isolation.test.ts`:** new forbidden patterns, plus publish spy = 0 with the MeshCore adapter.
- **UI:**
  - `MqttRootFinder.test.tsx` in MeshCore mode: no "Search under", no ladder or community; pick calls `onPickRoot('MCO')`; custom input is uppercased and validated.
  - `DashboardPage.meshcoreMqttFieldset.test.tsx`: the button renders; a pick sets the Region input; no save call is made.

## 5. Open questions (recommended answer first)
1. **Also mount at the Observer's IATA field** (`MeshCoreObserverBrokerEditor.tsx:51`)? **Recommend: no, not in this issue.** Observer brokers are publish-side and mostly token-auth. Sampling would need a minted token, and their ACLs usually deny a wildcard subscribe. Revisit for `password`-mode observer brokers only.
2. **Distance ranking via a bundled IATA airport table** (for example OurAirports, public domain, trimmed to code/lat/lon, about 100 KB)? **Recommend: no, activity only.** MeshCore regions are community labels, not always airports. MeshCore ingest sources have no "user location" to compare against. And the table would be a second data file to maintain.
3. **Freshness rule for retained `online` status.** **Recommend: active = online and timestamp within 15 min, or arrived live; a missing or unparseable timestamp counts as stale.** The alternative is to trust any retained `online`, which overcounts dead observers that left no LWT.
4. **Honour the source's `rejectUnauthorized: false`** for self-signed local brokers? **Recommend: yes, but only from the form's current checkbox value, and only for `meshcore_mqtt`.** The saved source already connects that way. Default stays `true`.
5. **On `SUBSCRIBE_DENIED`** (a broker ACL forbids `meshcore/+/+/status`): **recommend showing the existing coarse error plus a MeshCore-specific hint** ("This broker does not allow listing regions; ask its operator for your code"). No fallback probing of per-region topics.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/rootFinderService.ts
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/rootAdapter.ts (plus new meshcoreRegionAdapter.ts beside it)
- /home/yeraze/Development/meshmonitor/src/server/utils/mqttRootFinderTarget.ts
- /home/yeraze/Development/meshmonitor/src/components/MQTT/MqttRootFinder.tsx (plus /home/yeraze/Development/meshmonitor/src/hooks/useMqttRootFinder.ts)
- /home/yeraze/Development/meshmonitor/src/pages/DashboardPage.tsx (Region field, lines 1856-1868)
