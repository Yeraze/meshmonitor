# #6341 Phase 2: gated new-node alerts for MQTT feeds

Decisions are final (maintainer). Same gate and constants as P13 (`NEW_NODE_LEARN_HOURS`=48, `NEW_NODE_CAP_PER_HOUR`=10). No new numbers.

## 1. Reuse inventory

| What | Where |
|---|---|
| Gate: `admit`, `isLearning`, `rearm`, persisted per-source state | `src/server/services/newNodeAlertGate.ts:149,132,186`; `realDeps` `:65-72` |
| Window start reads `meshcore_nodes` only | `newNodeAlertGate.ts:70` -> `src/db/repositories/meshcore.ts:1002` |
| Constants (shared front/back) | `src/utils/newNodeAlertLimits.ts:8` |
| Companion alert body (dedup, nameless defer, notify) | `src/server/meshcoreManager.ts:4304-4348` (`alertNewNode`) |
| Bounded sets | `meshcoreManager.ts:1651,1668` (fields), `:4351-4369` (cap 4096, remember*) |
| Other set users | `:2793` clear, `:3269` contact path, `:4509-4516` refreshContacts |
| Repeater gated flow | `meshcoreManager.ts:5374-5402` (`maybeAlertRepeaterNewNode`), caller `:5360` |
| Device-type labels | `meshcoreManager.ts:367` (private const) |
| Advert ingest result | `src/server/services/meshcoreFrameIngest.ts:482-549` (`IngestedAdvert`, `ingestAdvertFrame`) |
| Standalone verify (never throws) | `meshcoreFrameIngest.ts:444` (`verifyAdvertSignature`); toggle logic `:467-479` |
| Feed advert ingest | `src/server/meshcoreMqttManager.ts:599-614` (`verifySignature:'toggle'`); `meshcoreMqttBrokerManager.ts:150` extends it, so `meshcore_mqtt_broker` is in scope with no extra code |
| Meshtastic notify path | `src/services/database.ts:1755-1828` (`maybeNotifyNewNode`, already fetches the source row at `:1798`), only caller `:1864` |
| Meshtastic notifier | `src/server/services/notificationService.ts:221-269` (`notifyNewNode`); MeshCore suffix text `:292-294` |
| Purge routes | `src/server/routes/purgeRoutes.ts:20-30` (`POST /api/purge/nodes`, Meshtastic `nodes` only); `meshcoreContactsRoutes.ts:424` (MeshCore rearm, device-guarded) |
| Capabilities / tab | `src/utils/notificationCapabilities.ts:33-35,51-110`; `src/components/NotificationsTab.tsx:915-928` |
| Copy | `public/locales/en.json:2982` (`ingest_unsupported_hint`), `:2984` (`new_nodes_repeater_note`) |

## 2. File-by-file changes

**`src/server/services/newNodeAlertTracker.ts` (new, protocol-neutral)**
```ts
export const NEW_NODE_SET_MAX = 4096;
export class BoundedKeySet { constructor(max = NEW_NODE_SET_MAX); has(k); add(k); delete(k); clear(); keys(): string[]; get size() }
export class NewNodeAlertTracker {
  readonly notified = new BoundedKeySet(); readonly pending = new BoundedKeySet();
  constructor(gate: NewNodeAlertGate = newNodeAlertGate);
  /** isNew || pending, and not yet notified. Sync prefilter, no DB. */
  shouldConsider(key: string, isNew: boolean): boolean;
  /** Body of meshcoreManager.ts:5386-5397: nameless -> park in pending unless learning; else gate.admit; drop -> pending.delete. */
  admitGated(sourceId: string, key: string, named: boolean): Promise<{ alert: false } | { alert: true; suppressedCount?: number }>;
}
```
`add` evicts the oldest past the cap (same rule as `:4354-4369`).

**`src/server/services/meshcoreNewNodeAlert.ts` (new)**
- Move `MESHCORE_DEVICE_TYPE_LABELS` here (export); `meshcoreManager.ts:367` imports it.
- `alertMeshCoreNewNode(tracker, sourceId, contact: { publicKey; name?; advName?; advType? }, opts: { suppressedCount?; onClaimed? })`: verbatim body of `alertNewNode` using `tracker.notified/pending`.
- `maybeAlertGatedMeshCoreNewNode(tracker, sourceId, ingested: IngestedAdvert)`: body of `maybeAlertRepeaterNewNode` minus the device-type check:
  1. `if (!tracker.shouldConsider(key, ingested.inserted)) return;`
  2. `verified = ingested.signatureVerified || (!ingested.signatureChecked && await verifyAdvertSignature(ingested.advert))`; return if false. This runs before any parking or row read.
  3. Read the row with `databaseService.meshcore.getNodeByPublicKeyAndSource`. Take the name and type from `row.name`/`row.advType` (sanitised). Do not import `contactFromNodeRow`, which would make an import cycle with meshcoreManager.
  4. `admitGated`. On alert, call `alertMeshCoreNewNode` with no `onClaimed`, so Auto Welcome never runs.
- Uses `import type` only from `meshcoreManager.ts`.

**`meshcoreFrameIngest.ts`**: add `signatureChecked: boolean` to `IngestedAdvert` (true when the marker is `true|false`, i.e. checked). It is always true on the Repeater (`'always'`), so the Repeater never verifies twice. Keep `'toggle'` on the feed and **do not write** the marker from the alert verify: #5909 semantics stay untouched. Cost: one Ed25519 verify per *new or pending, not yet notified* key, which the new-key rate bounds. Duplicate observer copies arrive with `inserted:false` and skip it.

**`meshcoreManager.ts`**: replace both fields and `remember*` with `private readonly newNodeAlerts = new NewNodeAlertTracker()`, updating `:2793,:3269,:4509-4516`. `alertNewNode` delegates to `alertMeshCoreNewNode(this.newNodeAlerts, this.sourceId, …)`. Companion keeps `onClaimed` -> Auto Welcome. `maybeAlertRepeaterNewNode(ingested)` = device-type check + `maybeAlertGatedMeshCoreNewNode`.

**`meshcoreMqttManager.ts`**: `private readonly newNodeAlerts = new NewNodeAlertTracker()`. In `ingestAdvert`, after the stat bump: `if (ingested) await maybeAlertGatedMeshCoreNewNode(this.newNodeAlerts, this.sourceId, ingested)` (it never throws). No `dataEventEmitter` node event: automation stays off, following the #5553 precedent. A region feed is a bigger flood than one Repeater.

**`newNodeAlertGate.ts`**: `realDeps().getEarliestNodeCreatedAt` returns the min non-null of `databaseService.meshcore.getEarliestNodeCreatedAt` and new `databaseService.nodes.getEarliestNodeCreatedAt`. Without this, a months-old Meshtastic MQTT source would read null and go silent for 48 h on upgrade.

**`src/db/repositories/nodes.ts`**: `getEarliestNodeCreatedAt(sourceId: string): Promise<number|null>`. Copy `meshcore.ts:1002`: Drizzle, `withSourceScope`, `Number()` coercion (BIGINT; `nodes.createdAt` is ms).

**`src/utils/newNodeAlertLimits.ts`**: `export function isGatedMeshtasticNewNodeSourceType(t): boolean` returns true for `'mqtt_bridge' | 'mqtt_broker'`.

**`database.ts` `maybeNotifyNewNode`**: keep the sync `newNodeAnnouncements` push before any await. Inside the background task, after the source fetch at `:1798`, check `isGatedMeshtasticNewNodeSourceType(src?.type)`. If true, dynamically import `newNodeAlertGate` (it imports `databaseService`, the same reason `notificationService` is dynamic) and call `admit(newNodeSourceId)`. On `!allow` return. That node stays announced and never alerts later (the Repeater rule). Pass `suppressedCount` through. Gating by source type keeps TCP ungated whoever the caller is. Accepted: a dropped MQTT node still counts as "known" under #5729 (`:1810`) for users who read both sources. That matches how a pre-existing complete row already counts.

**`notificationService.ts`**: add `export function newNodeOverflowSuffix(n?: number): string` (text from `:292-294`). Use it in `notifyNewMeshCoreNode` and in `notifyNewNode`, adding `opts.suppressedCount` to the body and to the `merged` body.

**`purgeRoutes.ts` POST `/nodes`**: after the purge, re-arm `sourceId` if its type is gated. For a global purge (no `sourceId`), re-arm every gated-type source from `sources.getAllSources()`. Best-effort, logged. `meshcore_mqtt` has no reachable node purge: contacts routes sit below the device guard (`meshcoreRoutes.ts:64`), and `purgeAllNodesAsync` leaves `meshcore_nodes` alone. So there is nothing to wire; a future ingest purge calls `rearm`. Source delete already removes the settings (`sourceRoutes.ts:1928`).

**`notificationCapabilities.ts`**: `newNodeNote: 'repeater_learning' | 'feed_learning' | null`. Feed row: `newNode:'on'`, `newNodeNote:'feed_learning'`. Split the non-MeshCore branch so `mqtt_bridge`/`mqtt_broker` get `'feed_learning'` and TCP gets `null`.

**`NotificationsTab.tsx:915`**: render `notifications.new_nodes_feed_note` for `'feed_learning'` with the same `hours`/`cap` params.

**`en.json`**: add `notifications.new_nodes_feed_note`: "An MQTT feed hears nodes from a whole region. New-node alerts start {{hours}} h after this source first logs a node, and at most {{cap}} are sent per hour." Edit `ingest_unsupported_hint` to drop "and new-node alerts". Delete that key from es/pl/ru so they fall back to English (`src/config/i18n.ts:51`) instead of showing false copy.

**Mesh impact**: sends no packets. Alerts are capped at 10/h/source after 48 h. Gate state lives in per-source settings: a restart, reconnect, source edit or prefs save neither re-arms nor clears it. Only a purge re-arms, and that can only extend suppression. The in-memory tracker sets only dedup; losing them on restart is safe, because `inserted` is DB-derived.

## 3. Test plan (Vitest)

- `services/newNodeAlertTracker.test.ts` (new): BoundedKeySet eviction at the cap; `admitGated` learning, nameless parking (learning vs armed), drop clears pending, suppressedCount passthrough (fake gate).
- `services/newNodeAlertGate.test.ts`: the earliest-createdAt min across both tables; a nodes-only source arms immediately.
- `meshcoreMqttManager.newNodeAlert.test.ts` (new): learning window, no alert; armed, alert; the 11th in an hour dropped, next hour carries "(+N more)"; unverified advert refused with the toggle off (verify called once, marker not written); a toggle-on verified advert is not re-verified; `inserted:false` duplicate is ignored; nameless then named; no Auto Welcome or automation emit; broker subclass alerts.
- `meshcoreMqttManager.newNodeAlert.perSource.test.ts`: two feed sources, separate cap/learn state and dedup.
- `meshcoreManager.repeaterIngest.test.ts`: still green after the extraction. Update `autoWelcomeCap.test.ts:27,157,162` and `contactPersistence.test.ts:505,509` to `newNodeAlerts.pending`.
- `services/database.service.test.ts` (block at `:701`): `mqtt_bridge`/`mqtt_broker` call `admit`, and a drop sends nothing; the suffix reaches `notifyNewNode`. TCP source: assert `admit` **never called** (spy on the gate) and the alert sent.
- `notificationService.test.ts`: suffix in the body and the merged body.
- `routes/purgeRoutes.rearm.test.ts` (route harness): a gated source re-arms, TCP does not, global re-arms all gated.
- `notificationCapabilities.test.ts`: feed rows on with `feed_learning`, TCP null.
- `nodes.test.ts`: `getEarliestNodeCreatedAt` on SQLite/PG/MySQL.

## 4. Work packages

1. **WP1, shared extraction (backend).** Tracker, `meshcoreNewNodeAlert.ts`, `signatureChecked`, MeshCoreManager refactor, test updates. Done when the Repeater/Companion/Auto Welcome suites pass unchanged in behaviour and no MeshCore set logic remains in the manager.
2. **WP2, wire feeds (after WP1).** meshcoreMqttManager hook, `nodes.getEarliestNodeCreatedAt` + gate deps, `database.ts` gate, `notifyNewNode` suffix, purge re-arm, all new backend tests. Done when the tests above pass, TCP is ungated, and `lint:ci` is clean.
3. **WP3, UI and copy (parallel with WP2).** Capabilities, tab note, en.json, removal of the stale locale keys, user docs (learning note for feeds), release note: Meshtastic MQTT alerts are now gated, and legacy feed prefs with `notifyOnNewNode=true` start alerting after the window. Run the semanticTokens test. Light and dark screenshots of both feed tabs.
