# MeshCore Parity follow-up: Notifications tab for `meshcore_mqtt` sources (#6307)

## Maintainer decisions (2026-11-09, binding)
Q1: A — one shared debounced broker-link notifier for meshcore_mqtt AND Meshtastic mqtt_bridge (WP5 in scope). Q2: 120 s grace before a "broker lost" alert; auth/eviction stops alert at once; no broker URL in payloads. Q3: picker = channels this source has messages on + keyed channels the viewer can read. Q4: accept slot-index ambiguity; follow-up filed as #6308. Q5: include inactive-node and low-battery alerts for ingest nodes (WP4). Also fix the P11 keyed-channel name bug (WP3). No MeshCore-only cap; the tab warns next to the picker. NOTE: P13 (#6306) has merged since this spec was written: it changed notificationCapabilities (Repeater newNode on + newNodeNote) and NotificationsTab (Repeater note, repeater_unsupported_hint wording). Build on main as it is now.


This is part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base is `main` at `4402509fe` (P11 merged). Paths are relative to `src/` unless they start with `docs/`.

## Binding decisions carried in
1. Reuse the Meshtastic notification rules unchanged: channel enable and mute, keyword lists, emoji, templates, and the #5729 dedup. There is no MeshCore-only rate cap (P11 decision 1).
2. One implementation for all sources. This phase only adds a capability row, a channel loader branch and a mount for the existing `NotificationsTab`. Anything MeshCore-only must state why.
3. The P11 key-access gate applies to every MeshCore notification. It applies here unchanged.

## Findings

**The server side already works. Only the UI and a few edges are missing.**

1. **The page has no tab.**
   - `pages/MeshCoreIngestSourcePage.tsx:75` renders `MeshCoreIngestView`, gated on `connection:read` (`:39`). `main.tsx:131-138` routes `meshcore_mqtt` there inside a `SourceProvider` with `sourceType='meshcore_mqtt'`.
   - The view's tabs are local state: `components/MeshCore/MeshCoreIngestView.tsx:30` (`'overview'|'nodes'|'channels'|'packets'`) and `:173-178`. The URL has no route per tab.
   - `MeshCorePage.tsx:357-360` mounts `<NotificationsTab isAdmin meshcoreDeviceType>` behind `meshCoreViewAccess.ts:67` (`notifications: isAuthenticated`).
   - The ingest page already has `SettingsProvider` and `ToastProvider`, which `NotificationsTab` needs (`useToast`, `useSource`, `NumberInputScope`).
   - The pane CSS `.meshcore-notifications-view` lives in `MeshCore/MeshCorePage.css:896-912`. The ingest page does not import that file.
2. **The capability map treats `meshcore_mqtt` as Meshtastic.**
   - `utils/notificationCapabilities.ts:37` checks `if (sourceType !== 'meshcore')` and returns the full Meshtastic set: DM, MQTT, traceroute, waypoint, new node, percent battery.
   - `loadNotificationChannels` (`:78`) uses `/api/channels` for anything that is not `'meshcore'`.
   - In `NotificationsTab.tsx`:
     - `:123` `isMeshCore = sourceType === 'meshcore'` picks the defaults notice (`:700`) and two labels.
     - The new-node fallback hint is hard-wired to `notifications.repeater_unsupported_hint` (`:883-885`).
     - The server-events list always says "Radio disconnection" (`:1321-1323`, `en.json:2836`).
   - Both defaults notices (`en.json:981-982`) say "direct messages only". That is wrong for any source with no DMs, and the Repeater has the same problem today.
3. **Which events reach the notifier.**
   - `meshcoreMqttManager.ts:768` emits `meshcore:message` only for channel messages.
   - It fires only after a real insert (`:732-733`), so N observer copies give one event, and a broker reconnect or restart replays nothing.
   - Blocked messages are dropped (`:699-701`). Ignored ones carry `filtered:'ignore'` and the notifier skips them (`services/meshcoreMessageNotifier.ts:61`).
   - Reactions carry `reactionEmoji` (`:723-726`).
   - There are no DMs, rooms or traces (no radio). There is no mention either: `meshcoreMentionNotificationService.ts:92` needs `isMeshCoreManager`, and the ingest manager's `getLocalNode()` is null (`meshcoreMqttManager.ts:1077`).
   - The notifier sets `viaMqtt = source.type === 'meshcore_mqtt'` (`meshcoreMessageNotifier.ts:86-87`). Self-echoes are still caught by `isOwnMeshCoreName` (`:76`).
4. **The channel index on an MQTT source is ambiguous, and the channel list misses it.**
   - Ingest decrypts with every stored key on every source (`services/meshcoreFrameIngest.ts:146-182`).
   - A device-slot key files the row as `channel-<that row's slot id>` with no `keyFingerprint` (`meshcoreMqttManager.ts:822-829`, `:673`, `:686`). So "channel 1" on an MQTT source merges slot 1 of every source.
   - Virtual keys (#5552) file under `keyedChannelIndex` (≥ 1000) with a fingerprint (`:812-821`).
   - `/api/channels/all?sourceId=<mqtt>` (`routes/channelRoutes.ts:142-211`) returns:
     - no slot rows, because channel writes are refused on ingest sources (`:485`, `:542`);
     - only keyed entries, because `getKeyedChannelSummaries` filters on `keyFingerprint IS NOT NULL` (`db/repositories/meshcore.ts:1891`).
   - **So with today's loader the picker would never offer the slot channels that carry most ingest traffic.** `/api/channels/all` also feeds `UsersTab.tsx:239` (the channel_N grant editor), so it must not be widened.
5. **Bug inherited from P11 (affects Repeaters too): keyed channel names.**
   - The adapter never passes `channelName` (`meshcoreMessageNotifier.ts:91-103`), so `dispatchMessageNotification` calls `resolveChannelName` (`messagePushNotifier.ts:79-95`).
   - For a keyed index (≥ `MESHCORE_KEYED_CHANNEL_BASE` = 1000, `meshcoreFrameIngest.ts:72`), that function takes the Meshtastic `CHANNEL_DB_OFFSET` (100, `constants/meshtastic.ts:445`) branch and looks up `channelDatabase.getByIdAsync(idx-100)`, which is the wrong table.
   - The title then shows "Channel 1234" or, rarely, an unrelated channel_database name.
   - Slot indices on an MQTT source always show "Channel N", which matches the ingest Channels tab (`#N`).
6. **Per-source prefs and routes already accept the source.**
   - `NON_MESHTASTIC_SOURCE_TYPES` (`server/utils/notificationFiltering.ts:197`) keeps legacy `''`-row mutes away from it.
   - Subscribe, unsubscribe, status and preferences need `messages:read` on the body/query source, with no type check (`server/routes/notificationRoutes.ts:67,119,152,310-311`).
   - The filter's MQTT step (`notificationFiltering.ts:517`) would silence every message on this source if `notifyOnMqtt=false`. The default is `true` (`utils/notificationDefaults.ts:65`), and the tab saves the loaded value back.
7. **Monitored-node alerts work on the server, but the picker is empty.**
   - Inactive-node and low-battery already use the MeshCore path for `meshcore_mqtt` (`inactiveNodeNotificationService.ts:267,375-394`; `lowBatteryNotificationService.ts:216,338`, voltage from observer `/status`).
   - The picker (`/api/nodes?sourceId=&includeAllMeshcore=true`, `NotificationsTab.tsx:196-209`) builds its list from `getAllManagers().filter(isMeshCoreManager)` (`server/routes/nodesRoutes.ts:164-167`). That predicate is device-only (`sourceManagerTypes.ts:50-52`), so ingest nodes never appear.
8. **Broker events.**
   - Nothing calls `serverEventNotificationService` for `meshcore_mqtt` (only `meshtasticManager.ts:2327,2755,16734` and `meshcoreManager.ts:2602-2612`).
   - The ingest `close` handler only logs (`meshcoreMqttManager.ts:319-321`).
   - The Meshtastic MQTT bridge does not notify either (`mqttBridgeManager.ts:575-598`). `mqtt_broker` is embedded and has no upstream link.
   - `MqttBrokerClient` emits `connect`/`close`/`offline`/`auth-stopped`/`eviction-stopped` (`transports/mqttBrokerClient.ts:104-118,318-382`). Backoff runs 1 s → 60 s (`:222-223`). Flapping is a known pattern (#5079).
   - "MeshMonitor started" **already fires for every enabled source, including `meshcore_mqtt`** (`server.ts:1438-1448`).
   - The connection payloads say "radio" (`serverEventNotificationService.ts:97,136`).
9. **Meshtastic MQTT sources do have a Notifications tab.** `mqtt_bridge`/`mqtt_broker` render in `App`, which mounts `NotificationsTab` (`App.tsx:3616`) with the Meshtastic capabilities, so their MQTT toggle can silence everything. Reticulum has no tab (no mount anywhere). That is a separate follow-up.

## Design (shared pieces first)

**S1. Capability row (shared `utils/notificationCapabilities.ts`).**
- Add a `meshcore_mqtt` branch: `dm:false, rooms:false, channels:true, emoji:true, mqtt:false, traceroute:false, newNode:'unsupported', waypoint:false, mention:false, batteryUnit:'voltage', messageFilters:true`.
- Add two fields for every source:
  - `unsupportedHint: 'repeater'|'ingest'|null` (Repeater → `'repeater'`, ingest → `'ingest'`, others null);
  - `connectionEvents: 'radio'|'broker'|'none'` (meshtastic_tcp and meshcore → `'radio'`; meshcore_mqtt and mqtt_bridge → `'broker'` if Q1=A, else `'none'`; mqtt_broker → `'none'`).
- Why the MQTT toggle stays hidden: every message on this source arrives over MQTT, so the toggle could only mean "off". `viaMqtt` stays true (the P11 contract), and the tab keeps saving the loaded `true`.

**S2. Channel loader (shared `loadNotificationChannels`).**
- For `meshcore_mqtt`, call the new `GET /api/sources/:id/meshcore/ingest/channels` and unwrap the `ok()` envelope to `Channel[]`.
- Server, in `server/routes/meshcoreIngestReadRoutes.ts`, behind `requirePermission('messages','read',{sourceIdFrom:'params.id'})` and `refuseDeviceSource`:
  - slot indices that have messages on this source, from a new Drizzle repo method `getChannelIndicesWithMessages(sourceId)` (distinct `fromPublicKey` `channel-N`, `messageType='channel'`, scoped by `sourceId`). These are listed with `name:''`, so the UI shows "Channel N".
  - plus `listKeyedChannelsForViewer(user, sourceId)` (names and `virtual`, already key-gated).
  - Keyed indices the viewer cannot access are left out.
- The tab also keeps any saved `enabledChannels` id that is not in the list, so a save never drops it silently.
- `/api/channels/all` is unchanged (Finding 4).

**S3. MeshCore channel name for notifications (shared server helper, fixes Finding 5 for every MeshCore source).**
- New `resolveMeshCoreChannelName(idx, sourceId)` in `server/utils/meshcoreKeyedChannels.ts`:
  - keyed index → `keyedChannelNames(sourceId).get(idx)`;
  - otherwise the source's own slot row (`channels.getChannelById`);
  - otherwise `Channel N`.
  - It never takes the `CHANNEL_DB_OFFSET` path.
- `sendMeshCoreMessageNotification` passes `channelName` from it. A keyed name only reaches recipients who already passed the key gate for that message.

**S4. Mount (the shared component, no copy).**
- `MeshCoreIngestView` gets a `'notifications'` tab, shown when `visibleMeshCoreViews({...}).includes('notifications')`, so it uses the same rule as the device page: signed in.
- It renders lazy `NotificationsTab` (`isAdmin` from `useAuth`) inside a CSS-module pane class with tokens only, ported from `MeshCorePage.css:896-912`.
- Click-through uses the shared `usePushNotificationNavigation()`. A `channel` nav for this `sourceId` switches to the `channels` tab, then `clearPendingNavigation`. A nav for another source is ignored.

**S5. Tab copy driven by capabilities (`NotificationsTab.tsx`).**
- Hint key from `caps.unsupportedHint`. New `notifications.ingest_unsupported_hint`: "A region feed has no radio, so direct messages, traces, mentions and new-node alerts are not available. Channel messages, inactive-node and low-battery alerts work. A whole region's channels can be busy: pick channels with care."
- Defaults notice: `caps.dm ? using_defaults_notice : using_defaults_notice_no_dm` (also fixes the Repeater).
- Server-events list items follow `caps.connectionEvents`:
  - `'radio'`: unchanged;
  - `'broker'`: "MQTT broker connection lost / restored";
  - `'none'`: only the startup item.

**S6. Monitored-node picker.** In `nodesRoutes.ts`, a request scoped to one source (`nodesSourceId` set) also includes that source's `isMeshCoreMqttManager` manager. The aggregate (unscoped) dashboard path stays device-only, so region nodes do not flood the dashboard map. The `nodes:read`/`viewOnMap` gates are unchanged.

**S7 (only if Q1 = A). Shared broker-link notifier.**
- New `server/services/brokerLinkNotifier.ts`: `attachBrokerLinkNotifier(client, {sourceId, sourceName, graceMs}) → {dispose()}`.
  - `connect` → `notifyNodeConnected(…, 'broker')`. The service already skips the first connect and gives one "restored" only after a notified loss.
  - `close`/`offline` → start one grace timer (`unref`).
  - `connect` before the timer fires → cancel, silent.
  - Timer fires → `notifyNodeDisconnected(…, 'broker')`.
  - `auth-stopped`/`eviction-stopped` → notify the disconnect immediately (no retry is coming).
  - `dispose()` cancels silently and is called from `stop()`/`restart()`/the auth-stop teardown.
- `serverEventNotificationService.notifyNodeConnected/Disconnected` gain `link: 'radio'|'broker' = 'radio'` for wording only. Payloads never include the broker URL, which is redacted per viewer (`MeshCoreIngestView.tsx:45`).
- Wire it into `meshcoreMqttManager.openBroker` and the `mqttBridgeManager` subscriber client (one implementation; `mqtt_broker` has no upstream link).

## Mesh impact
- **No RF.** Nothing sends or retries. The source has no radio, and the broker link is subscribe-only. The S7 grace timer only decides whether to notify. It never touches the broker, and its state is the existing in-memory per-source state (a restart's first connect is silent, as for every source).
- **Notification volume:**
  - One alert per newly inserted channel message, per subscribed user who enabled that channel. The insert gate collapses N observer copies to one, and reconnects replay nothing.
  - `enabledChannels=[]` by default, so nothing fires until the user picks channels.
  - **A region feed can be far busier than one radio** (for example Public across a region). There is no cap (binding decision 1), so the risk is surfaced by the S5 hint next to the picker.
  - A Companion and an MQTT source that hear the same message give one alert through the P11 content dedup key.
  - Inactive-node and low-battery alerts keep their existing cooldowns.
  - Broker events (S7): at most one lost/restored pair per outage longer than the grace window. Flaps shorter than the grace are silent. An auth or eviction stop gives one alert.
  - N MQTT sources means N independent streams.
- A settings save builds a new manager. `dispose()` is silent and the service state survives, so a save never fires an alert or re-arms anything.

## Security / permissions
- The tab is shown to signed-in users (same rule as `meshCoreViewAccess`). Every prefs and subscribe route already requires `messages:read` on the MQTT source.
- Recipients get exactly what REST shows:
  - `messages:read` on the MQTT source (`/ingest/messages` rule);
  - plus the P11 key gate for fingerprinted (virtual-key) rows: admins yes, a user without the key no, anonymous no.
  - Slot-decrypted MQTT rows have no fingerprint and need only `messages:read`. This is the documented rule (`server/utils/meshcoreKeyAccess.ts:24-25`); this phase does not widen it.
- New `/ingest/channels` route: `messages:read`. Keyed names come only through `listKeyedChannelsForViewer`. Slot entries carry no name, so other sources' slot names cannot leak.
- Picker widening (S6): only for a scoped request and only inside the existing `nodes:read` gate.
- Payloads: sender name, channel name and text. No keys, no broker URL.
- Route tests use `createRouteTestApp` and mock `checkPermissionAsync` per source.

## Work packages
Order: WP1 → WP2. WP3 and WP4 run in parallel with WP1. WP5 only if Q1 = A. WP6 goes last.

Every WP must pass: typecheck, lint ratchet, `.js` server imports, no raw SQL, flat en.json keys, CSS-module tokens (`styles/semanticTokens.test.ts`), and `UiIcon`.

**WP1 – shared capability row and channel source.**
- Files: `utils/notificationCapabilities.ts` (+ `.test.ts`), `server/routes/meshcoreIngestReadRoutes.ts` (+ `.test.ts`, `.permissions.test.ts`), `db/repositories/meshcore.ts` (`getChannelIndicesWithMessages`, with a multi-backend test in the `messages.export.multiBackend.test.ts` pattern).
- Tests:
  - the `meshcore_mqtt` row; the Repeater and Meshtastic rows are unchanged except the new fields;
  - the route: 403 without `messages:read`, 404 for a device source;
  - slot indices are listed without a name; a keyed index is hidden without the key and named with it; no cross-source leak.

**WP2 – tab and mount (UI).**
- Files: `components/NotificationsTab.tsx`, `components/MeshCore/MeshCoreIngestView.tsx` (+ `.module.css`, `.test.tsx`), `public/locales/en.json`:
  - `meshcore.ingest.tab_notifications`
  - `notifications.ingest_unsupported_hint`
  - `notifications.using_defaults_notice_no_dm`
  - `notifications.server_events_disconnect_broker`
  - `notifications.server_events_reconnect_broker`
- Tests (extend `NotificationsTab.test.tsx`):
  - an MQTT source shows channels, emoji, keywords, format, inactive-node and low-battery in volts, with the ingest hint;
  - it hides DM, MQTT, traceroute, mention, waypoint and new-node;
  - a saved `enabledChannels: [3, 1234]` round-trips, including an id missing from the list;
  - `notifyOnMqtt` is saved as `true`;
  - the Repeater shows the no-DM defaults notice;
  - Meshtastic is unchanged.
- Ingest view tests: the tab appears only when signed in; channel click-through switches tab; another source's nav is ignored.

**WP3 – notifier naming (server).**
- Files: `server/utils/meshcoreKeyedChannels.ts` (`resolveMeshCoreChannelName`), `server/services/meshcoreMessageNotifier.ts` (+ test).
- Tests:
  - an MQTT slot message → `channelName` "Channel N", `viaMqtt: true`;
  - a virtual-key MQTT message → the virtual name plus `keyFingerprint`;
  - a Repeater keyed message is named (regression for Finding 5), and `channelDatabase.getByIdAsync` is never called;
  - an own-name echo is skipped; `filtered:'ignore'` is skipped; a reaction respects `notifyOnEmoji`;
  - Companion plus MQTT copies of one message give one alert.

**WP4 – monitored nodes (server).**
- Files: `server/routes/nodesRoutes.ts` (+ `nodesRoutes.meshcore.test.ts`), optionally one MQTT case each in `inactiveNodeNotificationService.perSource.test.ts` / `lowBatteryNotificationService.test.ts`.
- Tests: a scoped request lists ingest nodes with `includeAllMeshcore` and `nodes:read`; the unscoped aggregate excludes them; no grant gives nothing.

**WP5 – broker-link events (server, only if Q1 = A).**
- Files: new `server/services/brokerLinkNotifier.ts` (+ test), `serverEventNotificationService.ts` (+ `.connection.test.ts`), `server/meshcoreMqttManager.ts` (`openBroker`/`stop`/`onAuthStopped`), `server/mqttBridgeManager.ts` (subscriber client).
- Tests use fake timers:
  - first connect is silent;
  - a close and reconnect inside the grace is silent; ten flaps inside the grace give zero alerts;
  - an outage longer than the grace gives one "lost", then one "restored";
  - `auth-stopped` gives one immediate "lost";
  - `stop()`/restart are silent and clear the timer;
  - the payload has broker wording and no URL;
  - Meshtastic TCP wording is unchanged.

**WP6 – docs, epic, browser check.**
- Docs: `docs/features/notifications.md` (what fires for an MQTT source, the region-volume note, the slot-index rule), `docs/features/meshcore-mqtt-ingest.md`, the epic phase log.
- Browser check: throwaway volume with RF lockdown (MQTT rows `enabled=0`); the ingest Notifications tab in light and dark; no console errors.

## Open questions for the maintainer
1. **Broker connect/disconnect alerts.**
   - A (recommended): the shared debounced notifier (S7/WP5) for `meshcore_mqtt` **and** `mqtt_bridge`. A region feed is the alert source, so a silent loss means silently missed alerts.
   - B: no broker alerts (today's Meshtastic MQTT behaviour). The tab lists only the startup event.
   - C: `meshcore_mqtt` only. This breaks the one-implementation rule.
2. **Grace before a "broker lost" alert (if A).**
   - Recommended: 120 s. That is longer than the 60 s maximum reconnect backoff, so one full retry cycle stays silent.
   - Alternatives: 60 s (more alerts on blips) or 5 min (slower to report).
   - `auth-stopped`/`eviction-stopped` alert immediately either way.
3. **Picker contents.**
   - Recommended: channels this source has messages on, plus keyed channels the viewer can read. This is cheap and truthful, and leaks no cross-source names.
   - Alternative: every key the feed could decrypt (all sources' slots plus virtual). Channels would be selectable before their first message, but slot names from other sources would need a per-row read gate.
4. **Slot-index ambiguity (Finding 4).**
   - Recommended: accept for now. "Channel N" on an MQTT source covers slot N of every source, the same thing the Channels tab shows as `#N`. Open a follow-up to file slot-decrypted ingest rows under `keyedChannelIndex` with a fingerprint; that follow-up must migrate saved `enabledChannels`.
   - Alternative: do that re-filing first, before shipping the picker.
5. **Inactive-node and low-battery alerts on MQTT sources.**
   - Recommended: include them (WP4, a small route change). "My repeater hasn't been heard in the region for 24 h" is a strong use for a region feed.
   - Alternative: hide those controls for `meshcore_mqtt`.

## Out of scope
- New-node alerts from region adverts (very high volume; already hidden, like the Repeater follow-up).
- Mentions on MQTT sources (no own name).
- A per-channel mute UI on the ingest Channels tab.
- Fingerprinting or re-filing MQTT slot channels (Q4 follow-up).
- Cleaning up Meshtastic MQTT capability rows (traceroute and waypoint shown on `mqtt_bridge`/`mqtt_broker`), apart from `connectionEvents`.
- A Notifications tab for Reticulum.
- `mqtt_broker` (embedded broker) client connect events.
- A rate cap for MeshCore or region feeds.
- A route per ingest tab or command-palette entries.

### Critical files for implementation
- /home/yeraze/Development/meshmonitor/src/utils/notificationCapabilities.ts
- /home/yeraze/Development/meshmonitor/src/components/NotificationsTab.tsx
- /home/yeraze/Development/meshmonitor/src/components/MeshCore/MeshCoreIngestView.tsx
- /home/yeraze/Development/meshmonitor/src/server/routes/meshcoreIngestReadRoutes.ts (plus `db/repositories/meshcore.ts`, `server/routes/nodesRoutes.ts`)
- /home/yeraze/Development/meshmonitor/src/server/services/meshcoreMessageNotifier.ts (plus `server/utils/meshcoreKeyedChannels.ts`; if Q1 = A: new `server/services/brokerLinkNotifier.ts`, `serverEventNotificationService.ts`, `meshcoreMqttManager.ts`, `mqttBridgeManager.ts`)
