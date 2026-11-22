# #6341 Phase 3: Reticulum notifications

Builds on P2 (#6536). Same gate and constants (48 h, 10/h/source, "(+N more)"). No new numbers. No packets sent.

## 1. Reuse inventory

- DM path: `reticulumManager.ts:1124-1131,1145-1190`. It already honours `messages:read`, the DM toggle and keywords (`notificationFiltering.ts:158,561`). Gaps: no `nodeUuid`, so the per-DM mute never matches (`:599-607`); no `sourceId` in nav data; the sender shows as a raw hash.
- `dispatchMessageNotification` (`messagePushNotifier.ts:104-136`): `muteKey` is a free string; the service label is 'Reticulum' (`:66`).
- `upsertMessage` is a plain upsert (`reticulum.ts:862-911`). Its doc admits bridge re-delivery, which notifies again today.
- The bridge client emits `ready` (`reticulumBridgeClient.ts:656`) and `close` on every socket close (`:733`); backoff 1-60 s (`:64-65,746-774`). The #5955 start retry (`reticulumManager.ts:265-310`) makes a new client per attempt (`:330-361`).
- `attachBrokerLinkNotifier`, grace 120 s (`brokerLinkNotifier.ts:27,45-107`); event names and `'broker'` are hardcoded.
- `notifyNodeConnected/Disconnected` (`serverEventNotificationService.ts:75,122`): first connect silent; "restored" only after a notified loss. MeshCore precedent: `disconnect({ userInitiated })` (`meshcoreManager.ts:2669,2796,2804`).
- Every teardown (Disconnect `sourceRoutes.ts:2747-2756`, edit `:1847-1856`, autoConnect off `:1624`) goes through `removeManager` → `stop()`.
- Announces: RNS calls announce handlers only inside `if local_destination == None and RNS.Identity.validate_announce(packet)` (rns 1.4.2 `Transport.py:1772`, handlers `:2074`, checked against the wheel). So the bridge stores only signature-valid announces from other destinations. The bridge names a destination only when its hash matches a known aspect (`rns_manager.py:73-77,1515-1527`). `displayName` is decoded from announce bytes (`:345-370`) and is not sanitised.
- Repo: `upsertDestination` (`reticulum.ts:356-412`) already computes `inserted` (`:408`, `:432-454`) and throws it away. `pruneDestinations` (`:597-626`) evicts the oldest non-favourites past 2000. No route purges destinations, so there is no re-arm to wire.
- Gate and tracker: `newNodeAlertTracker.ts:65,81`; gate `realDeps` `newNodeAlertGate.ts:65-82`; `newNodeOverflowSuffix` and `notifyNewMeshCoreNode` (`notificationService.ts:11,287-327`).
- UI: `notificationCapabilities.ts:22-47,74-94,121`. `NotificationsTab.tsx`: `loadNodes` `:219`, defaults notice `:734`, new node `:895-929`, inactive/battery/picker `:1113-1350` (**no caps gate**), server events `:1394-1405`. Ingest mount `MeshCoreIngestView.tsx:42,144,441-447`. `MuteMenu` as in `MeshCoreDirectMessagesView.tsx:833-837`; `useOptionalMuteSettings` works here (`SettingsProvider` at `ReticulumSourcePage.tsx:143`; legacy blanking excludes `reticulum`, `SettingsContext.tsx:1290`). Click-through as in `MeshCorePage.tsx:215-232`.

## 2. File-by-file changes

**`src/utils/reticulumName.ts` (new)**: `sanitizeReticulumName(raw): string | null`. Cut at NUL, collapse `\t\r\n` to spaces, drop the name if it holds a control char or U+FFFD, trim, cap at 64 code points, and return null when empty. `shortReticulumHash(h)` returns `<first 8 hex>…`.

**`reticulum.ts`**
- `upsertDestination(...): Promise<{ inserted: boolean }>`.
- `getEarliestDestinationCreatedAt(sourceId): Promise<number|null>`, a mirror of `meshcore.ts:1002` with `Number()`.
- `upsertMessage(...): Promise<{ inserted: boolean }>`, using the same RETURNING / `affectedRows===1` split as `upsertDestinationAtomic`. Return a sentinel column only on insert: return `createdAt` and compare it to `now`.

**`newNodeAlertGate.ts` `realDeps`**: take the min non-null of meshcore, nodes and reticulum. Otherwise existing Reticulum sources stay silent for 48 h after the upgrade.

**`src/server/services/reticulumNewDestinationAlert.ts` (new)**
```ts
export function isAlertableReticulumDestination(d: { appName: string|null; aspects: string|null }): boolean // lxmf + 'delivery'
export async function maybeAlertReticulumNewDestination(
  tracker: NewNodeAlertTracker, sourceId: string,
  dest: { destinationHash: string; appName: string|null; aspects: string|null; displayName: string|null; hops: number|null },
  inserted: boolean): Promise<void> // never throws
```
Steps: skip when not alertable or `isOwnReticulumAddress`. `if (!tracker.claim(hash, inserted)) return`. In `try/finally release`, call `admitGated(sourceId, hash, true)`, always named. A nameless LXMF peer is normal and never gets a name later, so parking it would hide it forever. Add the hash to `tracker.notified` whatever the verdict. Then call `notifyNewReticulumDestination`.

Decisions:
- **LXMF delivery only.** One per person or device. A NomadNet user also announces `nomadnetwork.node`, and propagation nodes are infrastructure, so counting either would double the alerts.
- **Path responses count.** They are validated announces, and only `inserted` matters.
- **Name:** `sanitizeReticulumName(displayName) ?? shortReticulumHash(hash)`.

**`notificationService.ts`**: `notifyNewReticulumDestination(hash, displayName, hops: number|null, sourceId, sourceName, suppressedCount?)`. Title "New Reticulum Destination Detected". Body `${name} detected by ${sourceName}${hopsText}${newNodeOverflowSuffix(n)}`. Dedup `reticulum-new-node:${hash}` with `merged`. Same three `broadcastToPreferenceUsers('notifyOnNewNode', …, sourceId)` calls as `:316-321`.

**`reticulumManager.ts`**
- `private readonly newNodeAlerts = new NewNodeAlertTracker()`. `handleAnnounce` sends the alert with `void` after the upsert, passing `inserted`.
- `handleLxmfMessage`: `persistLxmfMessage` returns `{ row, inserted }`. A re-delivery (`!inserted`) emits nothing and does not notify. This also fixes a double automation fire.
- Replace `sendInboundNotification` with `dispatchMessageNotification({ sourceId, messageId: row.id, isDirectMessage: true, channelId: -1, senderName, senderShortName: shortReticulumHash(from), senderNavId: row.fromHash, text, isTapback: false, viaMqtt: false, dedupKey: null, muteKey: row.fromHash.toLowerCase() })`. `senderName` comes from `getDestination(...).displayName`, sanitised, with the short hash as fallback.
- Link alerts are scoped to the manager, not the client, so a #5955 client swap cannot reset the grace timer. In `wireClientEvents`: `client.on('ready')` → `this.emit('bridge-up')`; `client.on('close')` → `this.emit('bridge-down')`. The constructor attaches the notifier once: `attachBrokerLinkNotifier(this, { sourceId, sourceName: () => this.sourceName, link: 'bridge', events: { up: ['bridge-up'], down: ['bridge-down'], stopped: [] } })`.
- `disconnect(opts: { userInitiated?: boolean } = {})`: read `wasConnected` first. When `userInitiated && wasConnected`, call `notifyNodeDisconnected(id, name, 'bridge')`.
- `stop()` disposes the notifier silently and then disconnects, so edits, autoConnect off and shutdown stay silent.
- 120 s fits: it is longer than the 60 s backoff cap.

**`sourceRoutes.ts:2747`**: when the manager is a connected Reticulum manager, call `await mgr.disconnect({ userInitiated: true })` before `removeManager`.

**`brokerLinkNotifier.ts`**: add `link?: 'broker'|'bridge'` (default `'broker'`), `events?: { up?: string[]; down?: string[]; stopped?: string[] }` (defaults are today's names) and `sourceName: string | (() => string)`. Existing callers do not change.

**`serverEventNotificationService.ts`**: `link: 'radio'|'broker'|'bridge'`. For bridge: title "Reticulum Bridge Disconnected · {name}" / "Reticulum Bridge Reconnected · {name}"; body "Lost connection to the Reticulum bridge" / "Connection to the Reticulum bridge restored (was offline for {d})".

**`notificationCapabilities.ts`**
- New field `nodeMonitoring: boolean` (inactive-node, low-battery, monitored picker). It is true on every existing row.
- Widen the unions: `newNodeNote` adds `'reticulum_learning'`, `unsupportedHint` adds `'reticulum'`, `connectionEvents` adds `'bridge'`.
- New `reticulum` branch, placed before the non-MeshCore branch: `dm:true, newNode:'on', newNodeNote:'reticulum_learning', messageFilters:true, unsupportedHint:'reticulum', connectionEvents:'bridge', nodeMonitoring:false`. Everything else is false; `batteryUnit` stays `'percent'`, unused.
- `loadNotificationChannels` returns `[]` for `reticulum`.

**`NotificationsTab.tsx`**
- Gate `:1113-1350` on `caps.nodeMonitoring`, and skip `loadNodes` when it is false.
- Defaults notice: use `using_defaults_notice_dm_only` when `caps.dm && !caps.channels`.
- New-node note: render `reticulum_learning`. Hint: render `reticulum`.
- Server events: render `bridge` items.

**Reticulum UI**
- `types/reticulum.ts:133`: add `'notifications'` to `ReticulumView`.
- `ReticulumSubToolbar`: add a `showNotifications` prop, and an item `{ id:'notifications', labelKey:'reticulum.nav.notifications', icon:'notifications' }` after `dms`, shown only when the prop is set.
- `ReticulumPage`: `useAuth()`, with `showNotifications = authenticated`. Render a lazy `NotificationsTab` in `Suspense`. Click-through: on `pendingNavigation.type==='dm'` for this source, `setView('dms')` and `loadConversation(senderNodeId)`, then clear it.
- `ReticulumDmsView`: in the header (`:267-270`), add a `MuteMenu` keyed `activePeerHash.toLowerCase()` when signed in. In the list (`:238-247`), add `MutedName`.

**`public/locales/en.json` only** (Weblate owns the rest):
- `notifications.new_nodes_reticulum_note`: "A Reticulum network can be large. Alerts cover LXMF peers only, start {{hours}} h after this source first logs a destination, and at most {{cap}} are sent per hour."
- `notifications.reticulum_unsupported_hint`: "Reticulum has no channels, traces, waypoints or node-health alerts. Direct messages, new-destination and bridge alerts work."
- `notifications.using_defaults_notice_dm_only`: "You have not saved notification settings for this source, so it uses the built-in defaults shown below: direct messages only. Settings you saved for another source do not apply here."
- `notifications.server_events_disconnect_bridge`: "Reticulum bridge connection lost (after the link stays down for two minutes, or at once when you click Disconnect)"
- `notifications.server_events_reconnect_bridge`: "Reticulum bridge connection restored"
- `reticulum.nav.notifications`: "Notifications"

**`docs/features/notifications.md`**: new `### Reticulum Sources` after `:804` (DMs and mute, LXMF-only signed new-destination alerts with 48 h / 10 per hour, bridge alerts with 2-min grace, unsupported rows); one line in the `:928` table.

**Release note**: Reticulum DM pushes now open the conversation and honour per-DM mutes. A user whose mesh-wide default has new-node alerts on starts getting capped Reticulum destination alerts.

## 3. Test plan (Vitest)

- `reticulumNewDestinationAlert.test.ts` (new, fake gate): non-LXMF and own hash skipped; learning drops for good; armed alerts; nameless uses the short hash; 11th/hour dropped and the next says "(+1 more…)"; `inserted:false` ignored; re-insert after prune silent in-process; 5 concurrent copies take one slot.
- `reticulumManager.notifications.test.ts` (new, fake timers): DM passes `muteKey`, sanitised name, `sourceId`; re-delivery neither notifies nor emits; self-origin skipped; `close` then `ready` within 120 s silent; `close` + 120 s notifies once (`'bridge'`); a #5955 retry storm fires once; `disconnect({userInitiated:true})` notifies; `stop()` silent and clears the timer.
- `reticulum.perSource.test.ts` (extend): two sources, separate cap/learn state and dedup.
- `reticulum.test.ts` (repo, three backends): `upsertDestination`/`upsertMessage` `inserted`; `getEarliestDestinationCreatedAt`.
- `newNodeAlertGate.realDeps.test.ts`: the min across three tables; a reticulum-only source arms at once.
- `brokerLinkNotifier.test.ts`: custom events, `link:'bridge'`, getter name; defaults unchanged.
- `serverEventNotificationService.connection.test.ts`: bridge wording.
- `sourceRoutes` disconnect (route harness): a connected Reticulum source notifies, an idle one does not.
- `notificationCapabilities.test.ts`: the reticulum row; `nodeMonitoring` true elsewhere.
- `NotificationsTab.test.tsx`: reticulum shows DM, new-node + note, keywords and bridge events; hides channels, emoji, MQTT, traceroute, waypoint, mention, inactive/battery/picker, and makes no `/api/nodes` call.
- `ReticulumSubToolbar.test.tsx`: item hidden when signed out. `ReticulumDmsView.test.tsx`: the MuteMenu calls `muteDM(lowercased hash)`.

## 4. Work packages

1. **WP1, backend alerts and DMs.** reticulumName, repo changes, gate deps, alert module, notificationService method, manager DM and announce wiring, plus their tests. Done when the alert and DM tests pass on SQLite, PG and MySQL.
2. **WP2, link alerts (parallel with WP1; both edit `reticulumManager.ts`, so merge WP1 first if they collide).** brokerLinkNotifier options, the `'bridge'` wording, manager notifier, `disconnect`/`stop`, the route. Done when the fake-timer tests pass and the existing broker tests are unchanged.
3. **WP3, UI, copy and docs (after WP1's capability shape is agreed; can start at once).** Capabilities, tab gates, Reticulum nav, tab, click-through, mute UI, en.json, docs, release note. Run the semanticTokens test and `lint:ci`. Light and dark screenshots of the Reticulum Notifications tab.

Mesh impact: no packets. Alerts are capped by the persisted gate, so a save, restart or edit never re-arms it or clears it. The bridge grace is in memory, but a restart's first connect is silent by design.

## 5. Open question for the maintainer

Destination churn. Past `reticulum_destinations_max` (2000), each insert evicts the oldest non-favourite row. A busy network (e.g. a testnet TCP interface) re-announces evicted LXMF peers, which then read as new after a restart (the in-process `notified` set covers 4096 keys until then). The cap keeps this to 10/h, but those alerts are false.
- (a) Accept it (default in this spec).
- (b) Also skip the alert when that insert triggered a prune, i.e. the source is at its cap. That silences genuinely new peers on capped sources.

## Maintainer answer (2026-11-22)
Open question: option (a), accept rare false alerts for evicted peers after a restart. No eviction check.
