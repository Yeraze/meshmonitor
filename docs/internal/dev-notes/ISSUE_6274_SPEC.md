# Spec: MeshCore clock-out-of-sync alert (#6273) and confirmed new-neighbour alert (#6274)

## Maintainer decisions (2026-11-10, binding)
Build ONLY the #6274 part (PR B) of this combined spec; #6273 is a separate PR being built in parallel (both add event-trigger plumbing in the same automation files — keep your changes additive and expect a merge). Decisions: confirmHours default 72 (range 6-336) per automation; stale 24 h and 7-day no-sighting discard as constants; 30-day prune; template rate limit 5/hour; alert lives in the Device Health template; Companion-polled repeaters documented as top-10-strongest only. Migration: next free number at implementation time.


This is a read-only design. Base is `main` at f0b325a63. Paths are relative to `/home/yeraze/Development/meshmonitor/src/`.

**Recommendation: ship two PRs, #6273 first.** The two issues read different data and share no code, apart from the pattern for adding an event-style automation trigger.
- #6273 needs **no migration**.
- #6274 needs **one migration**: next free is 229, but recheck at implementation time.
- Neither adds any RF. The optional "Sync clock" action in #6273 would, so it is held back as Q4.

---

## Findings (file:line)

### Clock data (#6273)

**P15's stored clock flags (#6281) can't drive this alert as they are.**
- `duplicateKeySchedulerService.ts:297-386` (`runMeshcoreScan`) is the only writer of `meshcore_nodes.isTimeOffsetIssue/timeOffsetSeconds/timeOffsetSource/timeOffsetCheckedAt` (migration 227, `db/schema/meshcoreNodes.ts:56-63`).
- It runs every 24 h, plus once 5 min after boot (`:50-72`).
- Its advert offsets need the opt-in packet log. Its DM offsets need DMs, and repeaters never send DMs. With the log off (the default), a repeater is never measured.
- It flags at a single global 30 min threshold (`server/constants/securityThresholds.ts:15-23`, env `TIME_OFFSET_THRESHOLD_MINUTES`).
- It fires no event. The P15 spec also makes the scanner the only writer of those columns.

**Parts of P15 we should reuse:**
- `meshcoreSecurityScan.ts:97-149`: `advertSenderSeconds`, the sign rule (offset = receipt − sender, so positive means the node is behind), and the "newest observation wins" rule.
- `utils/securityClock.ts:14` (`isClockNotSet`, `formatCompactSpan`), already used by the Contact panel (`MeshCoreContactDetailPanel.tsx:1389`).

**Live advert sender times are already decoded on every device source, at no airtime cost:**
- **Companion:** `meshcoreManager.ts:3416` → `recordRecentAdvertHash` (`:4172-4196`) decodes every raw LogRxData advert. The result is claimed at `:3042` (`takeRecentAdvert`, `:4202`) when the firmware pushes the advert. The firmware has already checked the signature and replay rule (timestamp must be newer than `last_advert`) by then. The sender time is decoded but thrown away.
- **Repeater:** `ingestRepeaterAdvert` (`:5113-5126`) → `ingestAdvertFrame` (`services/meshcoreFrameIngest.ts:490-548`) with `verifySignature: 'always'`. The decoded `advert.timestamp` is available.
- **meshcore_mqtt:** `meshcoreMqttManager.ts:577`. Its receipt time is the observer's, possibly delayed or retained, and there is one row per observer.

**Local drift already exists.** `meshcoreTelemetryPoller.ts:401-409` writes `mc_rtc_drift_secs` (server − device, the same sign) for the attached Companion or Repeater. A Repeater's `clock` reply has only HH:MM resolution. The chart label and category already exist (`TelemetryChart.tsx:269`, `utils/telemetryCategory.ts:256`, `MeshCoreInfoView.tsx:59`).

**The pattern to copy for detection is `meshcoreDeviceHealth.ts`** (`detectMeshCoreReboot`). It reads the prior stored telemetry row from the DB, so a restart is never mistaken for a change, then emits `node:rebooted` with `nodeNum: null` and the public key. The engine entry point is `automationEngineService.ts:1364` (`onNodeRebooted`).

**Why `trigger.telemetry` is a poor fit:**
- The condition evaluator has no absolute-value operator (`conditionEvaluator.ts:22`).
- Telemetry triggers have a forced 1 h per-node floor (`automationEngineService.ts:398`), so they would re-alert on every advert.
- The local poller never calls `emitTelemetry`. Only the remote scheduler does (`meshcoreRemoteTelemetryScheduler.ts:769`).

**Device Health template:** `components/automations/templates/deviceHealth.ts`. It has 10 alerts in `ALERTS` and builds each through `compile()`. Event-style alerts carry no cooldown. Its node filter is `node.nodeId in !hex`, which does not match MeshCore keys; that is related to #6271 and out of scope here.

**`MeshCoreTimeSyncScheduler`** (`services/meshcoreTimeSyncScheduler.ts:1-80, 258-290`):
- One sync costs 2–5 packets, and floods when the path is unknown.
- 12 h default cadence, 1 h floor, 60 s per-source TX gate. `lastTimeSyncAt` is stored in the DB.
- It needs a saved admin password.
- The firmware refuses to move a clock backwards, so a sync can only fix a clock that is behind.

### Neighbour data (#6274)

**Repeater source:**
- `startRepeaterNeighborsPoll` (`meshcoreManager.ts:10593-10640`) sends the serial-local `neighbors` command every 5 min (`server/utils/meshcoreRepeaterSerial.ts:21`), at zero airtime.
- The reply is capped at about 134 characters (`isNeighborsReplyPossiblyTruncated`, `:171`), so the stored set is merged rather than replaced (`:10734-10745`).
- `ingestRepeaterNeighborsReply` (`:10659-10750`) resolves only unique 8-hex prefixes, skips the repeater's own key, and stamps `repeaterNeighborAt`.
- The firmware lists only zero-hop **repeater** adverts in this table (`:10692`).

**Companion source:**
- `MeshCoreNeighboursScheduler` (`services/meshcoreNeighboursScheduler.ts`) handles opt-in `neighborsEnabled` nodes (default interval 60 min, schema `:126-127`).
- It calls `pollNeighborsAndStore` (`meshcoreManager.ts:9637`), which fetches **one page of 10, strongest first** (`meshcoreNeighboursPaging.ts:34-44`). Weak new neighbours may never show up.
- `storeNeighbours` (`:9522-9548`) replaces the set only on a complete read, and otherwise merges.

**The stored set has no first-seen time.**
- `insertNeighborsBatch` (`db/repositories/meshcore.ts:3262-3287`) deletes and reinserts the rows, resetting `createdAt` and `timestamp` every time.
- `mergeNeighbourRows` (`meshcoreNeighboursPaging.ts:241-260`) carries rows the read didn't return, with **extrapolated** ages. Those rows are not observations.

**Per-row `heardSecondsAgo` is relative to the repeater's own clock** (`:9497`), so drift doesn't skew it. A forward clock step only makes ages grow, which can cause a false discard (an under-alert), never a false alert.

**`newNodeAlertGate.ts` (P13)** is a per-source learning window plus a 10/hour cap, stored in settings. It serves notification-service alerts and its setting keys are hard-coded. Automations already have a stored per-automation `rateLimit`, `cooldown` and `restoreFireState` (`automationEngineService.ts:380-420`).

**`trigger.nodeDiscovered`** (`catalog.ts:213`) fires on the first live advert. Its payload, built by `meshCoreNodeTriggerPayload` (`meshcoreManager.ts:377-407`), carries `hops`.

**Neighbour data appears in several other places, which the new table must join:**
- Delete paths: `deleteNeighborsForNode` `:3371`, `deleteAllNeighbors` `:3378`.
- The purge route that re-arms the gate: `routes/meshcoreContactsRoutes.ts:420`.
- `server/services/systemBackupTables.ts:123`.

---

## Design

### Shared pieces (named first, per the one-implementation rule)

| ID | Piece | Used by |
|---|---|---|
| X1 | **Event-trigger plumbing.** Each trigger gets a `dataEventEmitter` event, an engine `on*` method, a `triggerContext` builder, entries in `types/automation.ts` / `catalog.ts` / `substitutionNodeTokens.ts` / `SubstitutionsHelp.tsx`, and a `socketEventGates.ts` entry. This is the `nodeRebooted` pattern. The subject is `nodeNum | publicKey`. | both |
| X2 | `utils/securityClock.ts` (`isClockNotSet`, `formatCompactSpan`) for token text. | #6273 |
| X3 | Stored engine fire-state (`rateLimit`, `cooldown`). Do **not** add a new gate; the trigger fires inside automations, which already have caps. | both |

### #6273: `trigger.clockOutOfSync` (protocol-neutral; MeshCore wired in this PR)

**C1. Sample capture: one helper, `detectClockOffset()`, added to `meshcoreDeviceHealth.ts` next to `detectMeshCoreReboot`.**
- Input: `(telemetry, publicKey, offsetSeconds, sampleSource: 'advert'|'device', senderSec, sourceId)`.
- It reads the last 3 `mc_rtc_drift_secs` rows for the key and source with the existing `getTelemetryByNode(nodeId, 3, …, 'mc_rtc_drift_secs', sourceId)`.
- It **drops** a sample whose sender time is not newer than the newest stored sample's sender time (row.timestamp/1000 − value). That rejects replays and the duplicate copies a flood produces.
- Otherwise it inserts the row and emits `node:clockOffset {publicKey, offsetSeconds, previousOffsets[≤2], sampleSource}`.
- It sends no packets and makes DB writes only.
- Throttle: at most one stored sample per key per 60 min, using an in-memory map. That limit only controls storage, not safety, so it doesn't need to survive a restart.

**C2. Call sites** (nothing on MQTT; see Q3):
- **Companion:** store `senderSec` in the `recentAdvertHashes` entry (`:4192`). In the `contact_advertised` handler after `takeRecentAdvert` (`:3042`), call C1 with offset = `entry.at − senderSec×1000`. Only adverts the firmware accepted are measured, so the signature and replay checks have already passed.
- **Repeater:** in `ingestRepeaterAdvert` after `ingestAdvertFrame`, and only when `ingested.signatureVerified` is true, call C1 with `now − advert.timestamp×1000`. `ingestAdvertFrame` already returns `advert`.
- **Local device:** route the existing poller write at `meshcoreTelemetryPoller.ts:406-408` through C1 with `'device'`, so a local Companion or Repeater alerts too. One implementation, one telemetry type, and the remote samples show up in the existing RTC Drift chart.
- Always skip the local node's own key for advert samples (`localKeys`).

**C3. Trigger semantics: an edge, with nothing new to persist.**
- `trigger.clockOutOfSync {thresholdSeconds}` fires when `|cur| > T && |prev1| > T && !(|prev2| > T)`, where a missing prev2 counts as in sync.
- That means it needs **two consecutive** out-of-sync samples, which filters one-off replays or delayed copies. It then fires **once per episode** and re-arms after an in-sync sample.
- Because the history lives in telemetry, a restart or settings save can't re-fire it or reset it. This satisfies checklist item 3.
- Tokens:
  - `trigger.offsetSeconds` (signed)
  - `trigger.offsetText`, e.g. "2h 14m behind" or "Clock not set" via X2
  - `trigger.direction` (`behind`/`ahead`/`notSet`)
  - `trigger.sampleSource`
  - `trigger.thresholdSeconds`
- Validation: `thresholdSeconds` is an integer from 120 to 86400. The floor covers flood relay delay plus the Repeater clock's 60 s resolution.

**C4. Device Health additions.**
- A checkbox labelled "Alert when a node's clock is out of sync (MeshCore)".
- A number field `clockDriftThresholdSeconds` (default 300). Help text: "Measured passively from adverts. A repeater whose clock was never set reads 'Clock not set'."
- Body: `{{ node.longName }} clock is {{ trigger.offsetText }} (threshold {{ trigger.thresholdSeconds }}s).`
- Adds a `rateLimit` (the cap is Q1).
- Append it at the end of `ALERTS`; index 0 stays the floor.

**C5 (optional, cheap).** The P15 scanner also reads the latest `mc_rtc_drift_secs` per node in its window as a third offset source (`'advert'`). The Security tab's clock flag then works with the packet log off. Only the scanner writes the flag columns, so the P15 rule holds.

### #6274: `trigger.neighborAdded` (from the repeater's neighbour table; the maintainer's refinement)

**N1. Tracker, `services/neighborWatch.ts`** (pure core plus a thin repo adapter).
- Signature: `observeNeighbours(sourceId, reporterKey, freshRows[{neighborKey, heardSecondsAgo, snr}], {complete, pollAtMs})`.
- Pass **only rows actually returned** by this poll, never the carried rows from `mergeNeighbourRows`.

Rules:
1. **First evaluation for a reporter** (`meshcore_nodes.neighborWatchBaselinedAt` is null): store every fresh key as `baseline`, set the marker, emit nothing. No burst at deploy or when a node is first enabled.
2. **Unknown key:** a `pending` row with `firstSeenAt = pollAt − heardSecondsAgo×1000` and `lastHeardAt` set to the same value.
3. **Known pending key:** store `prevLastHeardAt`, then set `lastHeardAt = max(lastHeardAt, pollAt − age)`. Emit `neighbor:sighting {reporter, neighbor, firstSeenAt, prevLastHeardAt, lastHeardAt, snr, sightings}`.
4. **Discard as transient** (delete the row) when any of these holds:
   - (a) the key is absent from a **complete, non-truncated** read;
   - (b) a returned row has `heardSecondsAgo` greater than `STALE_MS` (default 24 h);
   - (c) no sighting for 7 days.

   Absence from a partial read (a Companion's one page, a truncated Repeater reply) is **not** evidence.
5. **Pending → `confirmed`** when `lastHeardAt − firstSeenAt` reaches `MAX_CONFIRM` (14 d). After that it emits nothing more.
6. **Prune** `baseline` and `confirmed` rows not seen for 30 days. A neighbour that comes back after that counts as new again (Q7).
7. **Writes happen only on change.** For baseline and confirmed rows, `lastHeardAt` is refreshed at most hourly.

**N2. Call sites.**
- `ingestRepeaterNeighborsReply` (`:10728` area, using the `resolved` rows, `complete = !isNeighborsReplyPossiblyTruncated(reply)`).
- `storeNeighbours` (`:9522`, using the `fresh` rows, `complete` as passed in).

Both are wrapped in try/catch so the tracker can never break neighbour storage. No poll cadence changes.

**N3. Trigger semantics.**
- `trigger.neighborAdded {confirmHours}` (default 72, range 6–336) fires on a sighting when `prevLastHeardAt − firstSeenAt < H×3600e3 ≤ lastHeardAt − firstSeenAt`.
- That is exactly once per automation per pending episode. It needs no state per automation and survives restarts, because both timestamps are stored.
- `minSnr` is a normal `condition.numeric` on `trigger.snr`; the template can offer it.
- The subject node is the **neighbour**, so the `node.*` tokens describe it.
- Tokens:
  - `trigger.reporterName`, `trigger.reporterPublicKey`
  - `trigger.neighborPublicKey`
  - `trigger.snr`
  - `trigger.firstSeenAt`, `trigger.lastHeardAt`
  - `trigger.confirmedAfterHours`
  - `trigger.sightings`
- Self-origin guard: drop only if the *neighbour* is our own key. A reporter that is our own repeater is the whole point of this trigger.
- Catalog description: "Zero-hop repeaters only (firmware table). Needs neighbour polling: always on for Repeater sources; opt-in per node for Companion sources (top 10 strongest per poll)."

**N4. Template.** Add a "Repeater gained a confirmed new neighbour (MeshCore)" alert with a `confirmHours` field. Recommendation: put it in Device Health; the alternative is a separate template (Q6).

---

## Mesh impact

| | Airtime | Notification volume | Timers / state |
|---|---|---|---|
| #6273 sampling | **0**: decodes adverts already received; the local poller is unchanged | One alert per node per out-of-sync episode per automation. On deploy, every node with a bad or unset clock alerts once, about one advert cycle (≤12 h) after its second sample. On a large mesh with many unset repeaters, that is a burst spread across a day. | Edge history lives in `telemetry` (retention applies). No timers. Restarts and saves can't re-fire it. |
| #6273 Sync-clock action (Q4) | 2–5 packets per sync, flood when no path, Companion→remote only; firmware can't move a clock back | n/a | Would have to share `lastTimeSyncAt` (DB) and the 60 s source TX gate |
| #6274 tracker | **0**: reuses existing polls (Repeater serial every 5 min; Companion opt-in, already counted) | Baseline-on-first-evaluation stops the deploy burst. Alerts arrive ≥`confirmHours` after first sighting. At most 50 table entries per reporter. | All tracker state is in DB. No new timers. A purge or source delete re-baselines. |

**Caps to propose to the maintainer** (CLAUDE.md: ask, don't pick). Both are per-automation `rateLimit` in the template, using the existing mechanism:
- #6273: `{maxActions: 10, windowSeconds: 3600}`.
- #6274: `{maxActions: 5, windowSeconds: 3600}`.

Also flag that Repeater-source automation events have been kept off since #5553. `neighbor:sighting` is a deliberate, low-volume exception: at most one event per pending key per 5-min poll.

## Security

- **Spoofed adverts (#6273):** sample only verified adverts. On a Repeater, `signatureVerified === true`. On a Companion, only frames the firmware accepted (claimed at push). A forged advert can't put an offset on someone else's key.
- **Replays:** the "newer sender time than last sample" rule, plus two consecutive samples, blocks Share-Contact or recorded-advert replays from creating an episode.
- **Neighbour entries:** these come from the repeater's own signature-checked advert handling. Prefix resolution stays unique-only (the existing `resolveNeighbourPrefix` and `resolveContactByPrefix`); never guess.
- **Token text:** names come from stored, sanitised rows (`sanitizeMeshCoreName`), never raw advert bytes. Notification bodies go out through Apprise as they do today.
- **Source scoping:** every new repo method requires `sourceId` (throw if missing, like `getNeighborsForReporter`). Any future read route needs `nodes:read` on the source.
- **Cleanup:** add the new table to `deleteAllNeighbors`, `deleteNeighborsForNode`, source deletion, the node-purge path (which also clears `neighborWatchBaselinedAt`), and `systemBackupTables.ts`.
- **Sync-clock action (if approved):** it runs as the automation, so require that the source has a saved admin password, a per-node 1 h floor shared with the scheduler, and existing `requestData` TX-disabled handling (`pushOrSkipTxDisabled`).

---

## Work packages

### PR A: #6273 (no migration)

**A1. Capture**
- Files: `server/services/meshcoreDeviceHealth.ts` (`detectClockOffset`), `server/meshcoreManager.ts` (`recentAdvertHashes` gains `senderSec`; calls at `:3042` and `:5126`), `server/services/meshcoreTelemetryPoller.ts:406` (route through the helper).
- Tests, in `meshcoreDeviceHealth.test.ts`:
  - replay and duplicate drop;
  - hourly storage throttle;
  - local key skipped;
  - an unverified Repeater advert is ignored;
  - the Companion claim path uses the stashed sender time.

**A2. Trigger (X1)**
- Files: `types/automation.ts` (trigger type plus validation of 120–86400), `server/services/dataEventEmitter.ts`, `automationEngineSingleton.ts`, `automationEngineService.ts` (`onClockOffset`), `triggerContext.ts`, `components/automations/catalog.ts` (entry, `SUBJECT_NODE_TRIGGERS`, numeric and string fields), `substitutionNodeTokens.ts`, `SubstitutionsHelp.tsx`, `socketEventGates.ts`.
- Tests:
  - the edge truth table (in→out→out fires once; out→out→out does not; out→in→out→out fires again; a missing prev2 counts as in sync);
  - the ahead direction;
  - "Clock not set" text;
  - validation;
  - catalog integrity.

**A3. Template**
- Files: `components/automations/templates/deviceHealth.ts` (param, `DEFAULTS.clockDriftSeconds = 300`, alert, `rateLimit`), plus the template test and the `catalog.integrity` row.

**A4 (optional, C5).** `duplicateKeySchedulerService.runMeshcoreScan` plus `meshcoreSecurityScan.computeMeshcoreClockOffsets` (add a `driftSamples` input). Extend the existing scan tests.

**A5. Docs.** The Device Health docs page, the epic log entry, and the catalog description.

### PR B: #6274 (migration 229 or the next free number; use the `migration` skill)

**B1. Migration** `229_add_meshcore_neighbor_watch`, on SQLite, PostgreSQL and MySQL. It is idempotent through the `helpers.ts` helpers and has no backfill. Register it in `db/migrations.ts` and bump the count test.

New table `meshcore_neighbor_watch`:

| Column | Type | Notes |
|---|---|---|
| `id` | PK autoincrement / serial | |
| `sourceId` | text / varchar(64) | |
| `reporterPublicKey` | varchar(64) | |
| `neighborPublicKey` | varchar(64) | |
| `state` | varchar(16) | `baseline` \| `pending` \| `confirmed` |
| `firstSeenAt` | bigint ms | |
| `lastHeardAt` | bigint ms | |
| `lastSnr` | real / double | |
| `sightings` | int | |
| `updatedAt` | bigint ms | |

Plus: a unique index on (sourceId, reporterPublicKey, neighborPublicKey) and an index on sourceId.

Add column `meshcore_nodes.neighborWatchBaselinedAt` (bigint, nullable). `upsertNode` must never write it; add a test for that, like the P15 flags.

Tests: SQLite migration test, `.pgmysql.test.ts`, and the count test.

**B2. Schema and repository**
- Files: `db/schema/meshcoreNeighborWatch.ts`, `db/schema/index.ts`, `db/activeSchema.ts`, `db/schema/meshcoreNodes.ts`, and new methods in `db/repositories/meshcore.ts`:
  - `getNeighborWatch(sourceId, reporter)`
  - `applyNeighborWatchChanges(sourceId, reporter, upserts, deletes)`
  - `pruneNeighborWatch(sourceId, olderThan)`
  - `setNeighborWatchBaselined`
  - deletes added to the existing neighbour delete paths and source and purge cleanup
- Also update `systemBackupTables.ts`.
- Tests: repo tests on SQLite and PG/MySQL.

**B3. Tracker**
- Files: `server/services/neighborWatch.ts` (pure `planNeighborWatch(prevRows, fresh, opts) → {upserts, deletes, events}` plus the adapter).
- Tests:
  - baseline on first evaluation (including an empty first table);
  - a pending crossing at 72 h fires once;
  - absence from a partial read keeps the row;
  - absence from a complete read discards it;
  - an age over the stale limit discards it;
  - 14 d → confirmed;
  - prune;
  - carried rows are never passed in;
  - a forward clock step only discards.

**B4. Call sites.** `meshcoreManager.ingestRepeaterNeighborsReply` and `storeNeighbours`. Tests: tracker invoked with `complete` correct for truncated and non-truncated replies and for scheduler pages; a tracker failure doesn't break storage.

**B5. Trigger (X1)** for `trigger.neighborAdded {confirmHours 6–336}`. Same files as A2. Tests: the edge formula, the neighbour-is-self drop, a reporter that is self is *not* dropped, tokens.

**B6. Template plus docs.** The Device Health alert (or a new template, per Q6) with `confirmHours` and an optional `minSnr` condition; the epic log.

---

## Open questions (recommended option first)

**Q1. Notification caps (both).** Recommend a per-automation `rateLimit`: 10/h for clock and 5/h for neighbour. The alternative is no cap, relying on the edge semantics alone.

**Q2. Clock threshold.**
- Recommend a default of 300 s, a UI floor of 120 s and a ceiling of 1 day, with two consecutive samples required.
- Alternatives: one sample (faster, but open to replays), or reuse the global 30 min Security threshold.

**Q3. Measure from `meshcore_mqtt` adverts?** Recommend no. Observer receipt times can be delayed or retained, and there is one row per observer. Device sources only; MQTT could be a follow-up using the broker envelope time.

**Q4. A "Sync clock" action?** Recommend **not in this PR.**
- Instead, the notification names the node and the existing per-node Sync / time-sync scheduler fixes it.
- If wanted later: `action.requestData` op `timeSync`, Companion→remote and local Repeater only. It would share the scheduler's DB `lastTimeSyncAt` with a 1 h per-node floor and the 60 s source gate, and it would skip clocks that are *ahead*, since the firmware refuses to move backwards.
- Cost: 2–5 packets per sync, flooding when the path is unknown.

**Q5. Wire Meshtastic into `trigger.clockOutOfSync` now?** The one-implementation rule makes the trigger protocol-neutral either way. Recommend shipping MeshCore now and wiring Meshtastic as a follow-up, feeding samples from packet `rxTime` versus the sender's position/telemetry `time`. Alternative: both in PR A.

**Q6. Where the neighbour alert lives.** Recommend Device Health (operators already go there for per-node alerts). Alternative: a new "Network changes" template.

**Q7. Neighbour windows.**
- Recommend `confirmHours` default 72 (range 6–336), set per automation, as the maintainer asked.
- Stale limit 24 h and the 7 d no-sighting discard as constants.
- 30 d prune, after which a returning neighbour counts as "new" again.

**Q8. Companion-polled repeaters.** Recommend documenting the limit: one strongest-first page means weak neighbours may never confirm. The alternative, changing the automated poll to page further, adds RF and is not recommended.

## Out of scope

- The advert-count variant from the issue body (N zero-hop adverts on `trigger.nodeDiscovered`) and new-neighbour alerts for a Companion's own zero-hop contacts. Possible follow-up; the maintainer comment says the neighbour table replaces it for repeaters.
- Device Health node picker / MeshCore `nodeId` filter (#6271) and name prefill (#6272).
- Any change to neighbour, telemetry or time-sync poll cadence.
- Security-tab UI changes beyond optional C5.
- A `meshcore_mqtt` neighbour source.

### Critical Files for Implementation
- `/home/yeraze/Development/meshmonitor/src/server/meshcoreManager.ts` (`:3042`, `:4172-4210`, `:5113-5126`, `:9522-9548`, `:10659-10750`)
- `/home/yeraze/Development/meshmonitor/src/server/services/meshcoreDeviceHealth.ts`
- `/home/yeraze/Development/meshmonitor/src/server/services/automation/automationEngineService.ts` (plus `triggerContext.ts`, `automationEngineSingleton.ts`, `src/types/automation.ts`, `src/components/automations/catalog.ts`)
- `/home/yeraze/Development/meshmonitor/src/components/automations/templates/deviceHealth.ts`
- `/home/yeraze/Development/meshmonitor/src/db/repositories/meshcore.ts` (plus the new `server/services/neighborWatch.ts` and migration 229)
