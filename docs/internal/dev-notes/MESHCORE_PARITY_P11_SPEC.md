# MeshCore Parity P11: message, server-event and trace notifications (#6253)

This is part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base is `main` at `858b065d1`, which includes P10. Paths are relative to `src/`.

## Maintainer decisions (binding)
1. Reuse the Meshtastic notification rules unchanged: per-channel enable and mute, DM toggle, keyword allow/block lists, emoji toggle, templates, and the cross-source dedup from #5729. There is no MeshCore-only rate cap. The existing 5-minute mention cooldown stays as it is.
2. One implementation for all sources. MeshCore events go into the existing shared pipeline (`notificationService.broadcast` → `shouldFilterNotificationAsync`). Code that only MeshCore uses must say why there is no protocol equivalent.

3. **Answers to the open questions (maintainer, 2026-11-09):**
   - Q1: room posts follow the DM toggle and `mutedDMs` (label "Direct messages and room posts"). No migration.
   - Q2: accept that existing MeshCore rows with `enableDirectMessages=true` start receiving DM pushes. Add a release note.
   - Q3: a mute wins over a mention. A muted channel or room is fully silent; mentions still ignore the channel-enable list.
   - Q4: the Disconnect route raises "Node disconnected"; shutdown and source edits stay silent.
   - Q5: the per-DM mute fix (`muteKey`) also applies to Meshtastic.
   - Q6: hide "New nodes" on Repeater sources with an explaining hint; Repeater advert alerts become a follow-up issue.
   - Q7: click-through is in P11 (WP6).
   - The key-access gate (S2) applies to every MeshCore notification, mentions included.

## Findings
Several line references in the issue are stale. The real locations are given below.

1. **Shared pipeline.**
   - `server/services/messagePushNotifier.ts:100-218` (`sendMessagePushNotification`) is the shared new-message notifier. Meshtastic TCP calls it at `meshtasticManager.ts:12387-12409` and MQTT at `mqttIngestion.ts:253`.
   - It contains Meshtastic-only logic: the portnum gate (`:113`), the `localNodeNum`/`isOwnNodeNum` self check (`:121-128`), the `nodes.getNode(fromNodeNum)` sender lookup (`:131`), and the packet dedup key (`:182`).
   - `notificationService.broadcast` (`notificationService.ts:81`) fans out to push, Apprise and desktop. Each one calls the shared `utils/notificationFiltering.ts:348` (`shouldFilterNotificationAsync`). Order: `messages:read` on the source, then whitelist, mute, blacklist, emoji, MQTT, then channel/DM enable.
   - Reticulum already uses `broadcast` directly (`reticulumManager.ts:1145-1190`). That is the precedent for a non-Meshtastic source.
2. **Preferences are per (user, sourceId).** `resolveNotificationPreferencesAsync` (`notificationFiltering.ts:246`) never borrows another source's row. Legacy `''`-row mutes are kept away from `meshcore`/`meshcore_mqtt` (`NON_MESHTASTIC_SOURCE_TYPES`, `:92`, `:213-214`).
   - **So a MeshCore channel index cannot collide with a Meshtastic channel number in prefs.** `enabledChannels` and `mutedChannels` on a MeshCore row already hold MeshCore indices.
   - The save route has no channel range cap (`server/routes/notificationRoutes.ts:303`, `:469`).
3. **Defaults** (`utils/notificationDefaults.ts`): `enableWebPush=true`, `enableDirectMessages=true`, `enabledChannels=[]`, every `notifyOn*` except DM off.
   - Saved MeshCore rows almost certainly hold `enableDirectMessages=true`, because the control was hidden and the default was saved with it.
   - Once this ships, users who already subscribed to push on a MeshCore source start getting DM pushes (Open question 2).
4. **The MeshCore mutes are already real preferences. Only the notifier ignores them.**
   - The channel mute writes `mutedChannels` keyed by channel index (`MeshCore/MeshCoreChannelsView.tsx:142-148`; the issue says 140-142). The comment there says "indicator-only".
   - DM and room mutes write `mutedDMs` keyed by the canonical full public key (`SettingsContext.tsx:2578-2593`, `MeshCoreDirectMessagesView.tsx:741,818`, `MeshCoreRoomsView.tsx:676,818`).
   - **Existing bug in the shared path:** no caller ever sets `filterContext.nodeUuid` (grep: only `notificationFiltering.ts:18,390`). Per-DM mute therefore never silences a push or Apprise notification for Meshtastic either. The Meshtastic DM mute key is `node.user.id` = `fromNodeId` (`MessagesTab.tsx:1609-1611`, `hooks/useMessagingView.ts:686`).
5. **MeshCore message events.** Everything flows through `dataEventEmitter.emitMeshCoreMessage` (`dataEventEmitter.ts:700`). Call sites:
   - room post: `meshcoreManager.ts:2907`, gated on a real insert (#6246)
   - frame-decoded channel message (Repeater/Companion RAW): `:5258`, carries `selfOrigin`, `packetHash`, `keyFingerprint`
   - ignored message, flagged `filtered`: `:5317`
   - received DM/channel: `:5457` (`deliverReceivedMessage`)
   - reaction with `reactionEmoji` set: `:5515`
   - **our own sends**: `:6441`, `:6449`, `:10249`, with `fromPublicKey = localNode.publicKey || 'local'`
   - `meshcore_mqtt` channel ingest: `meshcoreMqttManager.ts:768`, no `selfOrigin`

   The issue's `:2871,5220,5419` are stale. Channel index comes from `utils/meshcoreChannelIdx.ts:10`. Repeater-decoded channels use keyed indices `MESHCORE_KEYED_CHANNEL_BASE + fp16` (`meshcoreFrameIngest.ts:83`).
6. **Mentions** (`meshcoreMentionNotificationService.ts`).
   - It subscribes to `meshcore:message` (`:201-210`, registered at `server.ts:452`) and sends through `broadcastToPreferenceUsers('notifyOnMention')`.
   - It has no dedup key, so a mention plus a new message notification would alert twice.
   - **Security gap:** it never checks `keyFingerprint`. A user with `messages:read` on a logging Repeater gets the text of a channel decrypted with another source's key that they cannot read (the read rule is `server/utils/meshcoreKeyAccess.ts:46,102`, and the socket gate enforces it at `socketEventGates.ts:231-242`).
7. **Permissions in the pipeline.**
   - Every path checks only `messages:read` on the source. Examples: `pushNotificationService.ts:615,693`, `desktopNotificationService.ts:132,195`, `notificationFiltering.ts:360`. That is stricter than the MeshCore REST rule (`messages:read` OR `channel_N:read`), which matches Meshtastic.
   - Anonymous push subscriptions skip every filter (`pushNotificationService.ts:608`).
   - Nothing on any path knows about keyed messages.
8. **`notificationService.getServiceStatus().anyAvailable` ignores desktop** (`notificationService.ts:180-186`). Both message notifiers return early on it (`messagePushNotifier.ts:105`, `reticulumManager.ts:1147`), so a desktop-only install gets no message notifications on any protocol.
9. **Server events.** Only `meshtasticManager` calls connect/disconnect (`:2327`, `:2755`, user disconnect `:16734`). MeshCore calls only `notifyOwnKeyChanged` (`meshcoreManager.ts:8695`). MeshCore hook points:
   - connect success: `:2194-2214`
   - `handleUnexpectedDisconnect`: `:12576` (the issue says 12166)
   - heartbeat-threshold `beginReconnect`: `:12549`
   - user disconnect: `meshcoreDeviceRoutes.ts:147` → `disconnect()` `:2470`. Source edits also call `disconnect()` (`sourceRoutes.ts:2534`).
   - The "Meshtastic node" wording is at `en.json:2833` (not 2698) and in the payload bodies at `serverEventNotificationService.ts:97,136`.
10. **Traces.**
    - Meshtastic calls `notificationService.notifyTraceroute` (`meshtasticManager.ts:9958`).
    - MeshCore trace success has one exit, `traceContactPathDetailed` (`meshcoreManager.ts:8042`). It covers the UI route (`meshcoreContactsRoutes.ts:629`), the v1 action (`routes/v1/actions.ts:150`) and the automation `tracePathSchedule` (`automation/meshActionDeps.ts:82`).
    - Auto-Pathfinding sends `discover_path` (`:12828`). The result arrives as `path_discovery_response` (`:3131-3174`).
    - Neither notifies today. The "no MeshCore equivalent" comment is at `NotificationsTab.tsx:883`.
11. **"New nodes" never fires in two cases.**
    - Repeater: `ingestRepeaterAdvert` (`:4971`) never calls `notifyNewNodeDiscovered` (`:3984`); #5553 is closed.
    - `meshcore_mqtt`: no call anywhere, and its page `pages/MeshCoreIngestSourcePage.tsx` has no Notifications tab at all.
12. **`NotificationsTab.tsx` hides these behind `isMeshCore = sourceType === 'meshcore'` (`:122`):**
    - DM `:789`
    - emoji `:813`
    - MQTT `:837`
    - traceroute `:884`
    - waypoint `:938`
    - template section `:1363`
    - channel list `:1375`
    - keywords `:1415`
    - filter-priority info `:1488`

    The channel list loads from `/api/channels` (`:318`). That route drops MeshCore slots above 7 and keyed/virtual channels (`channelRoutes.ts:276-297`). MeshCore views use `/api/channels/all` instead (`MeshCoreChannelsView.tsx:353-363`).
13. **Audio.**
    - Settings → Notifications (master toggle plus `ChannelSoundPicker`) lives only in `SettingsTab.tsx:2980-3005`. MeshCore never mounts `SettingsTab`; `MeshCoreSettingsView.tsx` has no audio section.
    - `ChannelSoundPicker.tsx:55-59` hides the DM row for MeshCore and also uses `/api/channels` (`:71`).
    - Playback (`hooks/useMessagingView.ts:165-179,672-695`) is tied to the Meshtastic poll.
    - The MeshCore live feed is `socket.on('meshcore:message')` in `MeshCore/hooks/useMeshCore.ts:1001,1225`.
    - `SettingsProvider` already wraps the MeshCore page (`pages/MeshCoreSourcePage.tsx:129`).
14. **Push click-through.** `utils/notificationUrl.ts` opens `/source/:id/{messages|channels}`, but `MeshCorePage` never reads `notificationNav`. Clicking a MeshCore notification (mentions too, today) lands on the Nodes view.
15. `serviceLabelFromSourceType` (`messagePushNotifier.ts:67`) has no `meshcore_mqtt` case, so those sources render as "Mesh".

## Design: shared pieces first
**S1 – protocol-neutral message dispatcher** (`server/services/messagePushNotifier.ts`):
- New `dispatchMessageNotification(input: MessageNotificationInput): Promise<void>`. Fields: `{sourceId, messageId, isDirectMessage, channelId, channelName?, senderName, senderShortName, senderNavId?, text, isTapback, viaMqtt, dedupKey: string|null, muteKey?: string, keyFingerprint?: string|null, template?: Partial<MessageTemplateContext>}`.
- It owns: the `anyAvailable` bail, the source lookup and `serviceLabel`, the template context, navigation data, and `broadcast`.
- `sendMessagePushNotification` keeps its signature and becomes the Meshtastic adapter (portnum, nodeNum self check, node lookup, `packetDedupKey`), and now passes `muteKey: message.fromNodeId`. That fixes Finding 4 for Meshtastic.
- Reticulum may switch to the dispatcher in the same WP (optional, mechanical).
- Add `meshcore_mqtt` → 'MeshCore' to the label switch.

**S2 – filter context and read gate** (`utils/notificationFiltering.ts`):
- `NotificationFilterContext` and `NotificationPayload` (`notificationService.ts`), plus the inline push type, gain `keyFingerprint?: string|null`. `nodeUuid` already exists; it now gets filled.
- New `messageReadableByUserAsync(userId: number|null, sourceId, keyFingerprint?): Promise<boolean>`:
  - `messages:read` on the source (as today);
  - if `keyFingerprint` is set, `canSeeKeyedMessage(await resolveMeshcoreKeyAccess({id, isAdmin}), {keyFingerprint})`;
  - anonymous with a fingerprint → false.
- Called from `shouldFilterNotificationAsync`, the anonymous branch of push `shouldFilterNotificationAsync`, desktop, and all three `broadcastToPreferenceUsers` when `payload.keyFingerprint` is set (this is what fixes mentions).
- `getServiceStatus().anyAvailable` adds desktop.

**S3 – MeshCore adapter** (new `server/services/meshcoreMessageNotifier.ts`).
- Why it is MeshCore-only: MeshCore identity is public keys and sender names, channels are `channel-N` keys, and rooms do not exist in Meshtastic.
- `sendMeshCoreMessageNotification(msg: MeshCoreMessage, sourceId): Promise<'sent'|'skipped:<reason>'>`. Skips when:
  - `msg.filtered` is set;
  - it is self-origin: `selfOrigin`, `fromPublicKey` equals the own key or `'local'`, `isOwnPublicKey`, or for channels `isOwnMeshCoreName(fromName)`;
  - the text is empty.
- Venue mapping:

| Venue | `isDirectMessage` | `channelId` | `muteKey` | Template |
|---|---|---|---|---|
| Channel | false | idx | none | `channelName` from `channels.getChannelById(idx, sourceId)` or `Channel N` |
| DM | true | -1 | sender's canonical full key (unique-prefix resolve through the manager's contacts) | DM template |
| Room post (`messageType === 'room_post'`) | true | -1 | room key (`toPublicKey`) | `isDM: false`, `channelName` = room name, so it renders "{Room} · {Source}" / "{Sender}: text" |

- `isTapback`: `!!reactionEmoji` or `isReactionText(text)`.
- `viaMqtt`: `sourceType === 'meshcore_mqtt'`.
- `keyFingerprint` is passed through.
- Navigation data: channel `{type: 'channel', channelId: idx}`; DM and room `{type: 'dm', senderNodeId: fullKey}`.

**S4 – MeshCore notification key** (same file; also used by mentions):
- channel: `meshcore-ch:<senderTimestamp>:<sha256(lower(fromName)+'\n'+text)[:16]>`. Content-based on purpose: `packetHash` is missing on some paths, and channel index differs between sources.
- room: `meshcore-room:<roomKey>:<fromKey>:<sec>:<hash(text)>`.
- DM: `meshcore-dm:<fromKey>:<senderTimestamp>:<hash(text)>`.
- When the timestamp is missing: `meshcore-id:<msg.id>`. This is per source, so it still merges a mention with its message.

**S5 – one subscriber, in order.**
- `startMeshCoreMessageNotifications()` replaces `startMeshCoreMentionNotifications()` at `server.ts:452`.
- For each `meshcore:message` it runs `await mention.handleMessage(msg)`, then `await sendMeshCoreMessageNotification(msg)`.
- The mention payload gains `dedup: {key: S4}` and `keyFingerprint`. A recipient who got the mention then gets `duplicate` for the message copy (`notificationDedup.ts:99-101`), so there is one alert per message per recipient.
- Runs are serialised per source (the same chain pattern as `claim`).

**S6 – server events.** Reuse `serverEventNotificationService` as it is; its per-source state already skips the first connect and repeated disconnects.
- `meshcoreManager`: `notifyNodeConnected` after `:2214`; `notifyNodeDisconnected` in `handleUnexpectedDisconnect` (after the guards, both branches) and in `beginReconnect`.
- Manual disconnect: `disconnect({userInitiated?: boolean})`, set only by `meshcoreDeviceRoutes.ts:147` (Open question 4). Shutdown and source edits stay silent.
- Neutral wording, in both `en.json:2833` and the payload bodies: "Lost connection to the source's radio" / "Connection to the radio restored".
- `meshcore_mqtt` broker connect/disconnect is out of scope (Meshtastic MQTT does not notify either).

**S7 – traces.** Reuse `notificationService.notifyTraceroute(from, to, routeText, sourceId, sourceName)`.
- Trace path: fire-and-forget at `traceContactPathDetailed` success (`:8042`). `from` = local name, `to` = contact name. `routeText` from a new pure `formatMeshCoreTraceRoute(hops, path, lastSnr, contacts)` in `utils/meshcoreTrace.ts` (MeshCore-only: hop hashes and per-hop SNR).
- Path discovery: also fires in `path_discovery_response` (`:3131-3174`): "Path discovered: out N hops [a3,7f], in M hops".
- Zero-hop ping (`pingContactZeroHop`) does not notify. Failures and timeouts do not notify (Meshtastic parity).

**S8 – UI capability map** (new pure `utils/notificationCapabilities.ts`).
- `notificationCapabilities(sourceType, meshcoreDeviceType?)` returns `{dm, rooms, channels, emoji, mqtt, traceroute, newNode: 'on'|'unsupported', waypoint, mention, batteryUnit}`. It replaces the 9 scattered `isMeshCore` checks in `NotificationsTab`.

| Source | Shown | Hidden / changed |
|---|---|---|
| MeshCore Companion | DM (labelled "Direct messages and room posts"), emoji, channels, keywords, templates, filter info, traceroute (labelled "Successful traces and path discoveries"), new node, mention | MQTT, waypoint |
| MeshCore Repeater | Channels, emoji, keywords, templates | DM, traceroute, new node (hidden with an explaining hint), mention |

- Channel list: shared `loadNotificationChannels(sourceId, sourceType)`. MeshCore uses `/api/channels/all`, so slots above 7 and keyed/virtual rows are included. Used by `NotificationsTab` and `ChannelSoundPicker`.
- `MeshCorePage` passes `meshcoreDeviceType={status?.deviceType}` to `NotificationsTab`.
- The `using_defaults_notice_meshcore` copy becomes "direct messages only", like Meshtastic.

**S9 – audio** (shared):
- Extract `components/AudioNotificationSettings.tsx` (master toggle plus `ChannelSoundPicker`) from `SettingsTab.tsx:2982-3005`. Mount it in `SettingsTab` and in `MeshCoreSettingsView` (Companion and Repeater).
- Extract `hooks/useMessageSound.ts` → `playForMessage({channelId, isDM, muteKey, isOwn})`. It checks the master toggle and the mutes (`useOptionalMuteSettings`) and calls `playChannelSound` (DM = -1). `useMessagingView` uses it.
- MeshCore: `useMeshCore` `onMessage` calls it for live, non-own, non-`filtered` messages. Rooms use the DM row (-1).
- `ChannelSoundPicker` shows the DM row for MeshCore Companion.

**S10 – click-through.** `MeshCorePage` uses the existing `usePushNotificationNavigation()`:
- `channel` → the `channels` view on `channelId`;
- `dm` → if `senderNodeId` is a room contact (advType 3), the `rooms` view; otherwise the `messages` view through `pendingDmContact`;
- then `clearPendingNavigation`.

## Mesh impact
- **No RF.** Nothing sends or retries, and no timer is armed. The trace and path-discovery hooks only observe sends that already happened, and they run after the reply. The subscriber is passive.
- **Notification volume:**
  - one alert per received MeshCore message, per subscribed user who has that DM or channel enabled;
  - channels stay off until the user picks them (`enabledChannels=[]`); mutes and keyword lists apply;
  - cross-source copies collapse through S4 + `notificationDedup` (60 s window, two-source rule kept).
- **Bursts are bounded by firmware:**
  - the Companion offline queue drains on reconnect, with no replay on MeshMonitor restart;
  - Room Server login sync (#6246 insert gate drops re-pushes);
  - trace notifications are bounded by `TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR` and by the Auto-Pathfinding interval (one target per interval).
- No MeshCore-only cap (binding decision 1).
- Self-origin guard: own sends at `:6441/6449/10249` and room echoes (own key) never alert. Sibling-companion channel echoes are caught by the name check.

## Security / permissions
- **Source access:** a recipient must hold `messages:read` on the source, as today. Users with only `channel_N:read` get no message notifications (stricter than REST; same as Meshtastic).
- **Keyed messages (new, S2):** a channel message a Repeater decrypted with another source's key notifies only users whose key access includes it. Admins see all. Anonymous push subscriptions never receive keyed messages. This also closes the mention leak (Finding 6).
- **Dedup** stays per recipient: a merged notification names only sources that passed that recipient's checks.
- **Templates and prefs** come only from the exact (user, source) row. Legacy mutes never reach MeshCore.
- **Payload contents:** sender name, channel or room name, and text only. No keys. Path text uses hop hashes and contact names the recipient can already see on that source (they need `messages:read` there).
- Tests use `createRouteTestApp` where routes are involved; the notifier tests mock `checkPermissionAsync` per source as `CLAUDE.md` describes.

## Work packages
Order: WP1 → WP2. WP3, WP4 and WP5 run in parallel with WP1. WP6 goes last.

Every WP must pass: typecheck, lint ratchet, `.js` server imports, no raw SQL, flat en.json keys, CSS modules with defined tokens only (`styles/semanticTokens.test.ts`), and `UiIcon`.

**WP1 – shared core (server).**
- Files: `server/services/messagePushNotifier.ts`, `server/utils/notificationFiltering.ts`, `server/services/notificationService.ts`, `pushNotificationService.ts`, `appriseNotificationService.ts`, `desktopNotificationService.ts`, optionally `reticulumManager.ts`.
- Tests (extend `messageNotification.sendCount.test.ts`, `notificationDedup.crossSource.test.ts`, fixture `test-helpers/messageNotificationFixture.ts`):
  - Meshtastic output identical, snapshot of the existing rendering tests;
  - a muted Meshtastic DM (`fromNodeId`) is filtered and an expired mute is not;
  - keyed payload: admin yes, user without the key no, anonymous no, unkeyed unchanged;
  - `broadcastToPreferenceUsers` honours `keyFingerprint`;
  - `anyAvailable` is true for desktop only.

**WP2 – MeshCore message notifier (server).**
- Files: new `server/services/meshcoreMessageNotifier.ts` (+ test), `meshcoreMentionNotificationService.ts` (dedup + keyFingerprint), `server/server.ts` (registration).
- Tests, as a matrix over the S3 mapping:
  - channel enabled vs disabled; channel mute by index;
  - DM toggle; DM mute by full key when the message carries a 12-hex prefix;
  - room by `enableDirectMessages`; room mute by room key;
  - whitelist beats mute; blacklist; emoji off filters `reactionEmoji` and raw reaction text;
  - each self-origin form is skipped (`selfOrigin`, own key, `'local'`, own name on a channel, own room echo); `filtered: 'ignore'` is skipped;
  - mention plus message gives exactly one alert per recipient, and users without mentions still get the message;
  - the same channel message from a Companion and a Repeater source gives one alert listing both;
  - `meshcore_mqtt` uses `viaMqtt`;
  - template "{Room} · {Source}".

**WP3 – server events and traces (server).**
- Files: `server/meshcoreManager.ts` (connect `:2214`, `:12549`, `:12576`, `disconnect(opts)` `:2470`, `:3131-3174`, `:8042`), `server/routes/meshcoreDeviceRoutes.ts:147`, `serverEventNotificationService.ts` (wording), `utils/meshcoreTrace.ts` (`formatMeshCoreTraceRoute`), `public/locales/en.json` (`notifications.server_events_disconnect`).
- Tests:
  - first connect is silent; a drop then reconnect gives one disconnect and one reconnect;
  - heartbeat threshold plus a native drop gives one disconnect;
  - source-edit `disconnect()` is silent; route disconnect notifies (per Open question 4);
  - trace success calls `notifyTraceroute` once; timeout and failure call it zero times; ping calls it zero times;
  - a path-discovery response notifies once;
  - formatter cases: 1-byte and 2-byte hops, unknown hop, `autoReturn`.

**WP4 – Notifications tab (UI).**
- Files: new `utils/notificationCapabilities.ts` (+ test), `components/NotificationsTab.tsx`, `MeshCore/MeshCorePage.tsx` (device type prop), `MeshCore/MeshCoreChannelsView.tsx` (fix the comment at `:142-144`), en.json (MeshCore labels, Repeater new-node hint, defaults notice).
- Tests (extend `NotificationsTab.test.tsx`):
  - Companion shows DM, emoji, channels (including an index above 7 and a virtual channel), keywords, format, traceroute; MQTT and waypoint stay hidden;
  - Repeater hides DM, traceroute and new node, and shows the hint;
  - Meshtastic is unchanged;
  - a saved `enabledChannels` with index 12 round-trips.

**WP5 – audio (UI).**
- Files: new `components/AudioNotificationSettings.tsx`, new `hooks/useMessageSound.ts`, `SettingsTab.tsx`, `MeshCore/MeshCoreSettingsView.tsx`, `ChannelSoundPicker.tsx`, `hooks/useMessagingView.ts`, `MeshCore/hooks/useMeshCore.ts`.
- Tests:
  - the hook plays the channel sound; it does not play when muted, for own messages, for `filtered`, or with the master toggle off;
  - a room plays the -1 sound;
  - the picker shows the DM row on a MeshCore Companion and lists slots above 7;
  - the `SettingsTab` audio tests are unchanged.

**WP6 – click-through, docs, epic.**
- Files: `MeshCore/MeshCorePage.tsx` + test (channel, DM and room navigation), `docs/features/notifications.md` / `docs/features/meshcore.md` (what fires per device type, the room = DM toggle rule, keyed-message rule, volume note), epic phase log.
- Browser check: throwaway volume with RF lockdown; MeshCore Companion and Repeater sources disconnected; the Notifications tab in light and dark; MeshCore Settings shows audio; no console errors.

## Open questions for the maintainer
1. **Room posts:** controlled by the DM toggle and `mutedDMs`, the same place the P2 room mute lives? Recommended: yes. The label becomes "Direct messages and room posts". Alternatives are a new `enableRoomPosts` column (needs a migration) or treating rooms as channels.
2. **Upgrade effect:** existing saved MeshCore rows hold `enableDirectMessages=true`, so subscribed users start getting MeshCore DM pushes. Recommended: accept it (Meshtastic default parity) and add a release note. The alternative is a migration that sets it to false on MeshCore rows.
3. **Mentions vs mute:** should a mention still alert in a muted channel or room? Recommended: no. A mute should silence the venue completely; mentions still ignore the channel-enable list.
4. **Manual disconnect:** should the Disconnect button raise a "Node Disconnected" event, as Meshtastic's `userDisconnect` does? Recommended: yes, only from the route. Shutdown and source edits stay silent.
5. **Meshtastic DM-mute fix (Finding 4):** it rides along in WP1 and changes Meshtastic behaviour (muted DMs stop pushing). Recommended: yes, since it is the same shared code.
6. **Repeater "new nodes":** hide with an explanation now, or wire `ingestRepeaterAdvert` to notify? Recommended: hide with a hint now and open a follow-up. A logging Repeater hears every advert, which means high volume.
7. **Click-through (WP6):** include it in P11? Recommended: yes. It is small, uses the shared hook, and also fixes mentions.

## Out of scope
- A Notifications tab and any notifications for `meshcore_mqtt` sources. The notifier handles their events, but they have no UI to subscribe or configure, the same as now. Follow-up.
- `meshcore_mqtt` broker connection events.
- New-node alerts from Repeater adverts (Open question 6).
- Per-channel RBAC (`channel_N:read`-only users) for notifications.
- Notifying on trace or path-discovery failures.
- Notifications for the neighbours step of Auto-Pathfinding (`get_neighbours`).
- A MeshCore rate cap.
- Waypoint and MQTT toggles for MeshCore (no equivalent).
- Changing the mention cooldown.

### Critical files for implementation
- /home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6253/src/server/services/messagePushNotifier.ts
- /home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6253/src/server/utils/notificationFiltering.ts
- /home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6253/src/server/services/meshcoreMentionNotificationService.ts (plus new meshcoreMessageNotifier.ts)
- /home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6253/src/server/meshcoreManager.ts
- /home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6253/src/components/NotificationsTab.tsx
