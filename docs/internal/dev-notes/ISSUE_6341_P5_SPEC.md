# Spec: #6341 Phase 5, clock-out-of-sync samples for Meshtastic and `meshcore_mqtt`

Adds two new feeds into the #6273 clock rule. No new packets, tables, migrations or settings.

## 1. Reuse inventory

| What | Where |
|---|---|
| Sample core: replay drop, hourly throttle, insert, emit | `src/server/services/meshcoreDeviceHealth.ts:230` `detectClockOffset`; throttle map `:201`; type `CLOCK_OFFSET_TELEMETRY_TYPE = 'mc_rtc_drift_secs'` `:168` |
| Event shape / emit | `src/server/services/dataEventEmitter.ts:208` `NodeClockOffsetData`, `:472` `emitNodeClockOffset` |
| Event → engine | `src/server/services/automation/automationEngineSingleton.ts:227-232` |
| Edge rule (two bad samples, once per episode) | `src/utils/clockOutOfSync.ts:31` `isClockOutOfSyncEdge`; engine `automationEngineService.ts:1552` `onClockOffset` |
| Context | `triggerContext.ts:738` `buildClockOutOfSyncContext` (hard-codes `subjectNodeNum: null`); nodeNum-or-key pattern to copy: `buildNodeRebootedContext` `:661-676` |
| Live gates | `src/server/utils/replayGuard.ts`: `LIVE_RECEPTION_WINDOW_SEC` `:101`, `isFirmwareReplayPacket` `:134`, `MIN_PLAUSIBLE_UNIX_SEC` `:36`. **Not** `isLiveReception` `:165`: it passes an absent or future `rxTime`, and a replay with no `rxTime` cannot be caught by id. |
| Transport | `src/server/constants/meshtastic.ts:286` `resolveRadioPacketTransport`, `TransportMechanism` `:109` (LORA 1, LORA_ALT1-3 2-4) |
| Meshtastic dispatch | `meshtasticManager.ts:7788-7807` (POSITION_APP gets `context`, TELEMETRY_APP does not); sender times `:8911` `position.time`, `:9430` `telemetry.time`; context flags `:373-380` (`virtualNodeRequestId`, `viaStoreForward`, `fromMqttProxy`) |
| Local-radio clock already measured | `meshtasticManager.ts:7712-7724` (`timeOffsetSamples`), flushed as `timeOffset` telemetry `:4467` |
| MQTT ingest | `meshcoreMqttManager.ts:481` `ingestDecodedPacket` (broker subclass `meshcoreMqttBrokerManager.ts:484` uses it, so it inherits), `:603` `ingestAdvert`; envelope `decoded.timestamp` (`meshcoreMqttIngestPacket.ts:98/:235`), parsed as at `:520` |
| Verify once | `meshcoreNewNodeAlert.ts:105-106` (`signatureVerified \|\| (!signatureChecked && verifyAdvertSignature(...))`); `meshcoreFrameIngest.ts:444` `verifyAdvertSignature`, `:482` `IngestedAdvert` |
| Security scan reads samples | MeshCore and MQTT-fed sources: `duplicateKeySchedulerService.ts:126` (`isAnyMeshCoreSourceType`) → `runMeshcoreScan` `:298`, reads `mc_rtc_drift_secs` `:318`. Meshtastic: `runTimeOffsetDetection` `:481` (already flags from `telemetry.packetTimestamp`, 30 min) |
| UI copy | `catalog.ts:411-412`, `templates/deviceHealth.ts:165` + `:433`, `SubstitutionsHelp.tsx:99`, `docs/features/automation-engine.md:96-99` |

## 2. Design decisions

**D1. One telemetry type.** Meshtastic samples also use `mc_rtc_drift_secs`. The chart label is already neutral ("RTC Drift", `TelemetryChart.tsx:276`), and the engine never reads the type. A new name would make every reader accept two. Meshtastic rows: `nodeId = '!hex'`, `nodeNum = fromNum`.

**D2. Meshtastic receive clock = server time.** offset = `floor(Date.now()/1000) − senderSec`. A packet is sampled only when all hold:
- `rxTime` present, `≥ MIN_PLAUSIBLE_UNIX_SEC`, and `|nowSec − rxTime| ≤ LIVE_RECEPTION_WINDOW_SEC` (both ways);
- `!isFirmwareReplayPacket(fromNum, id, rxTime)`;
- `context.viaStoreForward`, `context.fromMqttProxy` and `context.virtualNodeRequestId` all unset; `meshPacket.viaMqtt !== true`;
- `resolveRadioPacketTransport(meshPacket)` is 1-4 (LoRa);
- `fromNum !== localNodeNum`;
- `senderSec ≥ MIN_PLAUSIBLE_UNIX_SEC` (see Q1).

The two-sided `rxTime` check proves the packet is live **and** that the local radio's clock agrees with the server. If the local radio's clock is wrong, sampling stops on that source; it never flags every node. Meshtastic MQTT sources go through `mqttIngestion.ts`, not this manager, so they are never sampled.

**D3. Meshtastic packet types: TELEMETRY_APP and POSITION_APP**, one shared hourly throttle per node. Firmware facts (meshtastic-expert, master 2.7 and develop 2.8):
- `Telemetry.time` = `getTime()` at send, no quality check (`DeviceTelemetry.cpp`, `EnvironmentTelemetry.cpp`). With no clock it is seconds since boot, not 0. So the `senderSec ≥ MIN_PLAUSIBLE_UNIX_SEC` gate is required.
- `Position.time` = send time (not fix time) from `allocPositionPacket`. It is 0 unless the clock is NTP/GPS quality, or the board has a hardware RTC. Channel precision does not touch it. So a 0 is skipped, and position mostly measures RTC boards and GPS nodes; it adds coverage where 2.8 makes telemetry opt-in.

**D4. Generalise the core.** Rename the body of `detectClockOffset` into `recordClockSample(telemetry, subject, offsetSeconds, sampleSource, senderSec, sourceId, receivedAtMs)` where `subject = { nodeId: string; nodeNum: number; publicKey: string | null }`. `detectClockOffset` keeps its signature and wraps it with `{ nodeId: key, nodeNum: nodeNumFromPubkey(key), publicKey: key }`. Throttle key becomes `${sourceId}:${nodeId}` (`!hex` never collides with a 64-hex key). `sampleSource` gains `'packet'` (Meshtastic). MQTT samples stay `'advert'`.

**D5. Event and context carry nodeNum.** `NodeClockOffsetData` → `{ nodeNum: number | null; publicKey: string | null; … }` (MeshCore: `nodeNum: null`). `onClockOffset(nodeNum, publicKey, offset, prev, sampleSource, sourceId)`; the context copies `buildNodeRebootedContext`: `subjectNodeNum = nodeNum`, `subjectNodeKey = nodeNum == null ? publicKey : undefined`. Guard the `publicKey.substring` in the emit log.

**D6. `meshcore_mqtt` two-observer agreement, threshold-free.** Each rule has its own threshold, so the sampler cannot know "out of sync". It stores one value that is out of sync for threshold T exactly when two observers both are:
1. Cheap gates first: advert decoded, `senderSec ≥ MIN_PLAUSIBLE_UNIX_SEC`, envelope time parses, `|envelopeMs − now| ≤ LIVE_RECEPTION_WINDOW_SEC×1000` (drops retained/delayed publishes and observers with broken clocks), advert key ≠ `originId` (an observer timing itself), throttle not active for the node.
2. Buffer: `Map<publicKey, { senderSec, firstAt, byObserver: Map<originId, offsetSec> }>` per manager. A newer `senderSec` replaces the entry; an older one is ignored. Caps: 2,000 nodes (evict oldest, as `recentAdvertHashes` does), 8 observers per entry, entries older than 10 min dropped.
3. When a **second distinct** `originId` reports the same `senderSec`: verify the signature once (P2 pattern; mark the entry so later copies never verify again; a failed verify marks it dead). If both offsets share a sign, call `recordClockSample` with the smaller-magnitude offset and `receivedAtMs = min(thatObserver's envelopeMs, now)`. If signs differ, store nothing.
4. Later copies of that advert are dropped by the core's sender-time rule, so one advert gives at most one row, and the hourly throttle still applies.

Since `|stored| > T` ⇔ both observers exceed T, `isClockOutOfSyncEdge` composes unchanged: an alert needs two consecutive stored samples, each confirmed by two observers, once per episode. `receivedAtMs` must be the envelope time so `row.timestamp/1000 − value` rebuilds `senderSec` (`meshcoreDeviceHealth.ts:257`). A node heard by only one observer is never sampled. The broker subclass inherits all of this. Security scan picks the rows up through `runMeshcoreScan`.

**D7. Meshtastic Security scan: no change.** `runTimeOffsetDetection` stays the only flag writer for `nodes.isTimeOffsetIssue`. Device Health and `trigger.clockOutOfSync` work for Meshtastic through D5.

## 3. File-by-file changes

- `meshcoreDeviceHealth.ts`: add `ClockSubject`, `recordClockSample` (D4); `detectClockOffset` wraps it; add `isClockSampleThrottled(sourceId, nodeId, nowMs)` for D6 step 1.
- `dataEventEmitter.ts`: D5 shape; `sampleSource: 'advert' | 'device' | 'packet'`.
- `automationEngineSingleton.ts:231`, `automationEngineService.ts:1552`, `triggerContext.ts:738`: D5. Context `fields` gain `nodeNum`.
- `meshtasticManager.ts`: new private `sampleMeshtasticClock(meshPacket, senderSec: number | null | undefined, context?: ProcessingContext): Promise<void>` applying D2, called from the switch at `:7792`/`:7806` after each handler (pass `context` there; `processTelemetryMessageProtobuf` itself is unchanged). Pure gate in `src/server/utils/clockSampleGate.ts`: `isClockSampleEligible({ rxTimeSec, nowMs, fromNum, localNodeNum, packetId, transport, viaMqtt, viaStoreForward, fromMqttProxy, virtualNodeRequestId, senderSec }): boolean`.
- New `src/server/services/meshcoreMqttClockSamples.ts`: `class MqttClockAgreement { observe(input: { publicKey, senderSec, originId, envelopeMs, nowMs }): { publicKey, senderSec, offsetSec, receivedAtMs } | 'verify' | null; markVerified(key, senderSec, ok) }` (pure; buffer + caps of D6).
- `meshcoreMqttManager.ts`: field `clockAgreement`; in `ingestAdvert` after `ingestAdvertFrame`, feed it; on `'verify'` reuse `ingested.signatureVerified || (!ingested.signatureChecked && await verifyAdvertSignature(ingested.advert))`; on a result call `recordClockSample` via `detectClockOffset`. Never throws.
- UI copy: catalog label "A node's clock is out of sync", description drops "MQTT sources are not sampled. Meshtastic is not wired yet." and states the Meshtastic (live LoRa telemetry/position) and MQTT (two observers) sources; Device Health label drops "(MeshCore)", help/description say "adverts or packets"; `SubstitutionsHelp` `publicKey` "(MeshCore only)", add `nodeNum`, `sampleSource` lists `packet`; docs `automation-engine.md:96-99`.

## 4. Test plan (Vitest)

- `clockSampleGate.test.ts`: every D2 rule, each failing alone; future `rxTime` > 120 s; `rxTime` absent; replay id; `senderSec` 0 and uptime-like.
- `meshcoreDeviceHealth.clockOffset.test.ts`: Meshtastic subject stores `!hex`/fromNum and emits `nodeNum`; MeshCore unchanged; throttle keys don't collide.
- `meshtasticManager.clockSample.test.ts` (copy `meshtasticManager.transportTraffic.test.ts` harness): live LoRa telemetry stores; firmware replay, MQTT downlink, S&F, MQTT proxy, wrong local clock and local node all store nothing.
- `meshcoreMqttClockSamples.test.ts`: one observer → nothing; two agreeing → smaller magnitude; opposite signs → nothing; same observer twice → nothing; stale envelope → nothing; caps and TTL; newer `senderSec` replaces.
- `meshcoreMqttManager.clockSample.test.ts` (copy `meshcoreMqttManager.advert.test.ts` `FakeClient`): unverified advert stores nothing; verify runs once for three observers; two adverts an hour apart each confirmed by two observers fire `trigger.clockOutOfSync` once; broker subclass stores too.
- `meshcoreMqttManager.clockSample.perSource.test.ts`: the same node on two MQTT sources keeps separate buffers and rows.
- Engine `clockOutOfSync.test.ts`: Meshtastic event resolves `node.longName` via `subjectNodeNum`. `deviceHealth.test.ts`: label text.

## 5. Work packages

- **WP1 (core + engine).** D4, D5, emitter, singleton, engine, context, copy, docs, tests. Accept: existing #6273 suites pass unchanged in behaviour; new nodeNum tests pass; `npx tsc` and `lint:ci` clean.
- **WP2 (Meshtastic), after WP1.** D2, D3, gate module, manager hook, tests. Accept: manager tests above; no new DB reads for packets that fail the gate.
- **WP3 (meshcore_mqtt), after WP1, parallel with WP2.** D6, agreement module, manager hook, tests incl. perSource. Accept: verify runs at most once per advert; buffer bounded by test.

## 6. Open questions for the maintainer

- **Q1. Unset Meshtastic clocks.** A node with no GPS, phone or NTP has no wall clock, which is normal on Meshtastic. Sample it as "Clock not set" (one alert per such node) or skip? **Recommend skip** (`senderSec < MIN_PLAUSIBLE_UNIX_SEC`); MeshCore keeps today's behaviour.
- **Q2. Observer identity.** The topic/`origin_id` check does not authenticate an observer, so one publisher could pose as two. Accept for now? **Recommend accept**: alerts are capped at 10/hour and send nothing; a broker source can already restrict who connects.
